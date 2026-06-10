import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import PDFDocument from 'pdfkit';
import {
  initIbkrTables,
  normalizeIbkrAccount,
  normalizeIbkrBalance,
  normalizeIbkrPosition,
  readIbkrSnapshot,
  storeIbkrSync
} from './src/ibkrSync.mjs';
import {
  buildFallbackAiInsights,
  buildSecAnalysisReport,
  extractInlineFinancialMetrics,
  normalizeFilingSummary,
  splitFilingSections
} from './src/secReport.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, 'data');
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, 'market-cache.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS price_cache (
    ticker TEXT NOT NULL,
    range_key TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (ticker, range_key)
  );

  CREATE TABLE IF NOT EXISTS sec_cache (
    cache_key TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sec_report_versions (
    ticker TEXT NOT NULL,
    version_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    latest_accession_number TEXT,
    payload TEXT NOT NULL,
    PRIMARY KEY (ticker, version_id)
  );

  CREATE TABLE IF NOT EXISTS sec_report_facts (
    ticker TEXT NOT NULL,
    period TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL,
    source_tag TEXT,
    accession_number TEXT,
    filed TEXT,
    PRIMARY KEY (ticker, period, metric)
  );

  CREATE TABLE IF NOT EXISTS sec_filing_summaries (
    ticker TEXT NOT NULL,
    accession_number TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (ticker, accession_number)
  )
`);
initIbkrTables(db);

const cacheGet = db.prepare('SELECT fetched_at, payload FROM price_cache WHERE ticker = ? AND range_key = ?');
const cachePut = db.prepare(`
  INSERT INTO price_cache (ticker, range_key, fetched_at, payload)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(ticker, range_key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload
`);
const secCacheGet = db.prepare('SELECT fetched_at, payload FROM sec_cache WHERE cache_key = ?');
const secCachePut = db.prepare(`
  INSERT INTO sec_cache (cache_key, fetched_at, payload)
  VALUES (?, ?, ?)
  ON CONFLICT(cache_key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload
`);
const filingSummaryGet = db.prepare(`
  SELECT payload
  FROM sec_filing_summaries
  WHERE ticker = ? AND accession_number = ?
`);
const filingSummaryPut = db.prepare(`
  INSERT INTO sec_filing_summaries (ticker, accession_number, generated_at, payload)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(ticker, accession_number) DO NOTHING
`);
const latestReportGet = db.prepare('SELECT payload FROM sec_report_versions WHERE ticker = ? ORDER BY generated_at DESC LIMIT 1');
const reportVersionPut = db.prepare(`
  INSERT INTO sec_report_versions (ticker, version_id, generated_at, latest_accession_number, payload)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(ticker, version_id) DO UPDATE SET
    generated_at = excluded.generated_at,
    latest_accession_number = excluded.latest_accession_number,
    payload = excluded.payload
`);
const reportFactPut = db.prepare(`
  INSERT INTO sec_report_facts (ticker, period, metric, value, source_tag, accession_number, filed)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ticker, period, metric) DO UPDATE SET
    value = excluded.value,
    source_tag = excluded.source_tag,
    accession_number = excluded.accession_number,
    filed = excluded.filed
`);

db.exec(`
  INSERT OR IGNORE INTO sec_filing_summaries (ticker, accession_number, generated_at, payload)
  SELECT
    json_extract(payload, '$.ticker'),
    json_extract(payload, '$.accessionNumber'),
    COALESCE(json_extract(payload, '$.generatedAt'), fetched_at),
    payload
  FROM sec_cache
  WHERE cache_key LIKE 'sec:filing-summary:v1:%'
    AND json_extract(payload, '$.ticker') IS NOT NULL
    AND json_extract(payload, '$.accessionNumber') IS NOT NULL;

  DELETE FROM sec_cache
  WHERE cache_key LIKE 'sec:filing-summary:v1:%';
`);

const dayMs = 24 * 60 * 60 * 1000;
const cacheTtlMs = 12 * 60 * 60 * 1000;
const secTickerTtlMs = 7 * dayMs;
const secFilingsTtlMs = 6 * 60 * 60 * 1000;
const secDocumentTtlMs = 7 * dayMs;
const port = Number(process.env.PORT || 8787);
const ibkrBaseUrl = process.env.IBKR_BASE_URL || 'https://127.0.0.1:5001/v1/api';
const secUserAgent = process.env.SEC_USER_AGENT || 'PortfolioBacktest/0.1 max@local.invalid';
const secForms = new Set(['10-K', '10-Q', '8-K']);
const secAnalysisModel = process.env.DEEPSEEK_SEC_MODEL || 'deepseek-v4-pro';
const strategyModel = process.env.DEEPSEEK_STRATEGY_MODEL || 'deepseek-v4-pro';

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(body));
}

function ensureLocalIbkrBase() {
  const base = new URL(ibkrBaseUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(base.hostname)) {
    throw new Error('IBKR_BASE_URL must point to localhost');
  }
  return base;
}

function ibkrErrorMessage(statusCode, payload) {
  const message = payload?.error || payload?.message;
  if (message) return message;
  if (statusCode === 401) return '请重新登录 IBKR Portal';
  if (statusCode === 403) return 'IBKR API 会话被拒绝，请确认 Gateway 登录状态和账户权限';
  return `IBKR HTTP ${statusCode}`;
}

function ibkrRequest(pathname, { method = 'GET', body = null } = {}) {
  const base = ensureLocalIbkrBase();
  const basePath = base.pathname.replace(/\/$/, '');
  const cleanPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${basePath}${cleanPath}`, base);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = transport({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      rejectUnauthorized: url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? false : undefined,
      headers: {
        accept: 'application/json',
        'user-agent': 'PortfolioBacktest/0.1',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      },
      timeout: 1800
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        const text = data.trim();
        let parsed = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { raw: text };
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(ibkrErrorMessage(response.statusCode, parsed));
          error.statusCode = response.statusCode;
          error.payload = parsed;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('IBKR Gateway timeout'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getIbkrStatus() {
  const loginUrl = new URL(ensureLocalIbkrBase());
  loginUrl.pathname = '';
  loginUrl.search = '';
  try {
    const payload = await ibkrRequest('/iserver/auth/status', { method: 'POST', body: {} });
    if (payload?.connected && !payload?.authenticated) {
      try {
        const initPayload = await ibkrRequest('/iserver/auth/ssodh/init', {
          method: 'POST',
          body: { publish: true, compete: true }
        });
        return {
          gateway: 'running',
          authenticated: Boolean(initPayload?.authenticated),
          connected: Boolean(initPayload?.connected || payload?.connected),
          competing: Boolean(initPayload?.competing),
          loginUrl: loginUrl.toString(),
          message: initPayload?.message || payload?.message || ''
        };
      } catch {
        return {
          gateway: 'running',
          authenticated: false,
          connected: true,
          competing: Boolean(payload?.competing),
          loginUrl: loginUrl.toString(),
          message: payload?.message || 'IBKR brokerage session needs reinitialization'
        };
      }
    }
    return {
      gateway: 'running',
      authenticated: Boolean(payload?.authenticated),
      connected: Boolean(payload?.connected),
      competing: Boolean(payload?.competing),
      loginUrl: loginUrl.toString(),
      message: payload?.message || ''
    };
  } catch (error) {
    if ([401, 403].includes(error.statusCode)) {
      return {
        gateway: 'running',
        authenticated: false,
        connected: false,
        loginUrl: loginUrl.toString(),
        message: error.statusCode === 403 ? 'IBKR login failed or API access denied' : 'IBKR login required'
      };
    }
    return {
      gateway: 'offline',
      authenticated: false,
      loginUrl: loginUrl.toString(),
      message: error.message
    };
  }
}

async function getIbkrAccounts() {
  const payload = await ibkrRequest('/portfolio/accounts');
  const rawAccounts = Array.isArray(payload) ? payload : payload?.accounts || [];
  return rawAccounts.map(normalizeIbkrAccount).filter(Boolean);
}

function ibkrRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.positions)) return payload.positions;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function shouldFallbackIbkrPositions(error) {
  return [400, 404, 405].includes(error.statusCode);
}

async function getIbkrPositions(accountId) {
  try {
    const payload = await ibkrRequest(`/portfolio2/${encodeURIComponent(accountId)}/positions?direction=d&sort=mktValue`);
    return ibkrRows(payload).map(normalizeIbkrPosition).filter(Boolean);
  } catch (error) {
    if (!shouldFallbackIbkrPositions(error)) throw error;
  }

  try {
    await ibkrRequest(`/portfolio/${encodeURIComponent(accountId)}/positions/invalidate`, { method: 'POST', body: {} });
  } catch (error) {
    if (!shouldFallbackIbkrPositions(error)) throw error;
  }

  const positions = [];
  for (let page = 0; page < 20; page += 1) {
    const payload = await ibkrRequest(`/portfolio/${encodeURIComponent(accountId)}/positions/${page}`);
    const rows = ibkrRows(payload);
    const normalized = rows.map(normalizeIbkrPosition).filter(Boolean);
    positions.push(...normalized);
    if (rows.length < 100) break;
  }
  return positions;
}

async function getIbkrBalances(accountId) {
  try {
    const payload = await ibkrRequest(`/portfolio/${encodeURIComponent(accountId)}/ledger`);
    const rows = Array.isArray(payload)
      ? payload
      : Object.entries(payload || {}).map(([currency, value]) => ({ currency, ...value }));
    return rows.map(normalizeIbkrBalance).filter(Boolean);
  } catch {
    return [];
  }
}

async function syncIbkrAccount(accountId = '') {
  const accounts = await getIbkrAccounts();
  const account = accounts.find((item) => item.accountId === accountId) || accounts[0];
  if (!account) throw new Error('No IBKR account available');
  const positions = await getIbkrPositions(account.accountId);
  const balances = await getIbkrBalances(account.accountId);
  return storeIbkrSync(db, {
    account,
    positions,
    balances,
    syncedAt: new Date().toISOString()
  });
}

function binary(res, status, buffer, headers = {}) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    ...headers
  });
  res.end(buffer);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20000) {
        req.destroy();
        reject(new Error('Request body is too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function cleanTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
}

function cleanAccession(value) {
  return String(value || '').trim().replace(/[^0-9-]/g, '');
}

function cacheRead(key, ttlMs) {
  const cached = secCacheGet.get(key);
  if (!cached) return null;
  const age = Date.now() - new Date(cached.fetched_at).getTime();
  if (age > ttlMs) return null;
  return JSON.parse(cached.payload);
}

function cacheWrite(key, payload) {
  secCachePut.run(key, new Date().toISOString(), JSON.stringify(payload));
}

async function secFetch(url, accept = 'application/json') {
  const response = await fetch(url, {
    headers: {
      accept,
      'user-agent': secUserAgent
    }
  });

  if (!response.ok) {
    throw new Error(`SEC HTTP ${response.status}`);
  }

  return response;
}

function yahooUrl(ticker) {
  const period1 = Math.floor(Date.UTC(1990, 0, 1) / 1000);
  const period2 = Math.floor((Date.now() + dayMs) / 1000);
  const params = new URLSearchParams({
    period1: String(period1),
    period2: String(period2),
    interval: '1d',
    events: 'history',
    includeAdjustedClose: 'true'
  });
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${params}`;
}

function normalizeYahooPayload(ticker, raw) {
  const result = raw?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const adjclose = result?.indicators?.adjclose?.[0]?.adjclose || [];
  const close = quote.close || [];
  const rows = timestamps.map((time, index) => {
    const price = adjclose[index] ?? close[index];
    if (!Number.isFinite(price)) return null;
    return {
      date: new Date(time * 1000).toISOString().slice(0, 10),
      close: Number(price.toFixed(6))
    };
  }).filter(Boolean);

  if (!rows.length) {
    throw new Error(`No price rows for ${ticker}`);
  }

  return {
    ticker,
    currency: result?.meta?.currency || 'USD',
    exchange: result?.meta?.exchangeName || '',
    firstDate: rows[0].date,
    lastDate: rows[rows.length - 1].date,
    rows
  };
}

async function getPrices(ticker) {
  const rangeKey = '1d-full';
  const cached = cacheGet.get(ticker, rangeKey);
  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < cacheTtlMs) return { ...JSON.parse(cached.payload), source: 'cache' };
  }

  const response = await fetch(yahooUrl(ticker), {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 PortfolioBacktest/0.1'
    }
  });

  if (!response.ok) {
    if (cached) return { ...JSON.parse(cached.payload), source: 'stale-cache' };
    throw new Error(`Yahoo Finance HTTP ${response.status}`);
  }

  const payload = normalizeYahooPayload(ticker, await response.json());
  cachePut.run(ticker, rangeKey, new Date().toISOString(), JSON.stringify(payload));
  return { ...payload, source: 'yahoo' };
}

async function getSecTickerMap() {
  const cacheKey = 'sec:ticker-map';
  const cached = cacheRead(cacheKey, secTickerTtlMs);
  if (cached) return cached;

  const response = await secFetch('https://www.sec.gov/files/company_tickers_exchange.json');
  const payload = await response.json();
  const fields = payload.fields || [];
  const data = payload.data || [];
  const tickerIndex = fields.indexOf('ticker');
  const cikIndex = fields.indexOf('cik');
  const nameIndex = fields.indexOf('name');
  const exchangeIndex = fields.indexOf('exchange');
  const map = {};

  data.forEach((row) => {
    const ticker = cleanTicker(row[tickerIndex]);
    const cik = String(row[cikIndex] || '').padStart(10, '0');
    if (!ticker || !cik) return;
    map[ticker] = {
      ticker,
      cik,
      cikNumber: Number(row[cikIndex]),
      name: row[nameIndex] || '',
      exchange: row[exchangeIndex] || ''
    };
  });

  cacheWrite(cacheKey, map);
  return map;
}

async function getSecCompany(ticker) {
  const map = await getSecTickerMap();
  const company = map[cleanTicker(ticker)];
  if (!company) {
    throw new Error(`No SEC CIK found for ${ticker}`);
  }
  return company;
}

function filingDocumentUrl(filing) {
  const accessionPath = filing.accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${filing.cikNumber}/${accessionPath}/${filing.primaryDocument}`;
}

function filingIndexUrl(filing) {
  const accessionPath = filing.accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${filing.cikNumber}/${accessionPath}/${filing.accessionNumber}-index.html`;
}

async function getSecFilings(ticker, limit = 20, force = false) {
  const clean = cleanTicker(ticker);
  const company = await getSecCompany(clean);
  const cacheKey = `sec:filings:${clean}`;
  const cached = force ? null : cacheRead(cacheKey, secFilingsTtlMs);
  if (cached) {
    return {
      ...cached,
      filings: (cached.filings || []).slice(0, Math.max(1, Math.min(50, limit)))
    };
  }

  const response = await secFetch(`https://data.sec.gov/submissions/CIK${company.cik}.json`);
  const payload = await response.json();
  const recent = payload?.filings?.recent || {};
  const filings = (recent.accessionNumber || [])
    .map((accessionNumber, index) => ({
      ticker: clean,
      cik: company.cik,
      cikNumber: company.cikNumber,
      companyName: payload.name || company.name,
      form: recent.form?.[index] || '',
      filingDate: recent.filingDate?.[index] || '',
      reportDate: recent.reportDate?.[index] || '',
      accessionNumber,
      primaryDocument: recent.primaryDocument?.[index] || '',
      description: recent.primaryDocDescription?.[index] || ''
    }))
    .filter((filing) => secForms.has(filing.form) && filing.primaryDocument)
    .map((filing) => ({
      ...filing,
      documentUrl: filingDocumentUrl(filing),
      indexUrl: filingIndexUrl(filing),
      pdfUrl: `/api/sec/filings/${encodeURIComponent(clean)}/${filing.accessionNumber}.pdf`
    }))
    .slice(0, 50);

  const result = {
    ticker: clean,
    company,
    filings,
    source: 'sec',
    fetchedAt: new Date().toISOString()
  };
  cacheWrite(cacheKey, result);
  return {
    ...result,
    filings: result.filings.slice(0, Math.max(1, Math.min(50, limit)))
  };
}

async function getSecCompanyFacts(ticker, force = false) {
  const clean = cleanTicker(ticker);
  const company = await getSecCompany(clean);
  const cacheKey = `sec:companyfacts:${clean}`;
  const cached = force ? null : cacheRead(cacheKey, secFilingsTtlMs);
  if (cached) return cached;

  const response = await secFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`);
  const payload = await response.json();
  cacheWrite(cacheKey, payload);
  return payload;
}

function readLatestReport(ticker) {
  const row = latestReportGet.get(ticker);
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

function persistReport(report) {
  reportVersionPut.run(
    report.ticker,
    report.versionId,
    report.generatedAt,
    report.latestFiling?.accessionNumber || null,
    JSON.stringify(report)
  );

  for (const quarter of report.financials?.quarters || []) {
    for (const metric of ['revenue', 'costOfRevenue', 'grossProfit', 'operatingIncome', 'netIncome', 'operatingCashFlow', 'capex', 'fcf']) {
      if (!Number.isFinite(quarter[metric])) continue;
      const source = quarter.sources?.[metric] || quarter.source || {};
      reportFactPut.run(
        report.ticker,
        quarter.period,
        metric,
        quarter[metric],
        source.tag || null,
        source.accessionNumber || quarter.accessionNumber || null,
        source.filed || quarter.filed || null
      );
    }
  }
}

async function getSecAnalysisReport(ticker, { force = false } = {}) {
  const clean = cleanTicker(ticker);
  const [filingsPayload, companyFacts] = await Promise.all([
    getSecFilings(clean, 20, force),
    getSecCompanyFacts(clean, force)
  ]);
  const previousReport = readLatestReport(clean);
  const latestFiling = filingsPayload.filings[0];
  const [aiInsights, inlineMetrics] = await Promise.all([
    getAiInsightsForLatestFiling(clean, latestFiling),
    getInlineMetricsForLatestFiling(latestFiling)
  ]);
  const report = buildSecAnalysisReport({
    ticker: clean,
    companyName: filingsPayload.company?.name || companyFacts.entityName || clean,
    filings: filingsPayload.filings,
    companyFacts,
    previousReport,
    aiInsights,
    inlineMetrics
  });
  persistReport(report);
  return {
    ...report,
    source: 'sec',
    persisted: true
  };
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<ix:nonfraction[\s\S]*?>/gi, ' ')
    .replace(/<\/(p|div|tr|table|section|article|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function createPdfBuffer({ title, subtitle, sourceUrl, text }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48, bufferPages: true });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.info.Title = title;
    doc.font('Helvetica-Bold').fontSize(16).text(title, { lineGap: 4 });
    doc.moveDown(0.35);
    doc.font('Helvetica').fontSize(9).fillColor('#4b5563').text(subtitle);
    doc.text(sourceUrl, { link: sourceUrl, underline: true });
    doc.moveDown();
    doc.fillColor('#111827').font('Helvetica').fontSize(8.5);

    const body = text.length > 450000 ? `${text.slice(0, 450000)}\n\n[Truncated locally after 450,000 characters. Open the SEC source link for the full filing.]` : text;
    body.split('\n').forEach((line) => {
      doc.text(line || ' ', {
        width: 500,
        lineGap: 2,
        continued: false
      });
    });

    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i += 1) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(`Page ${i + 1} of ${pageCount}`, 48, 750, {
        width: 500,
        align: 'right'
      });
    }

    doc.end();
  });
}

async function getFilingRaw(filing) {
  const cacheKey = `sec:text:${filing.ticker}:${filing.accessionNumber}`;
  const cached = cacheRead(cacheKey, secDocumentTtlMs);
  if (cached?.raw) return cached.raw;

  const response = await secFetch(filing.documentUrl, 'text/html,application/xhtml+xml,text/plain,*/*');
  const raw = await response.text();
  if (!htmlToText(raw)) {
    throw new Error('SEC filing document did not contain readable text');
  }
  cacheWrite(cacheKey, { raw, sourceUrl: filing.documentUrl });
  return raw;
}

async function getFilingText(filing) {
  const raw = await getFilingRaw(filing);
  const text = htmlToText(raw);
  if (!text) {
    throw new Error('SEC filing document did not contain readable text');
  }
  return text;
}

async function analyzeFilingSectionsWithDeepSeek({ ticker, filing, sections }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return buildFallbackAiInsights({ sections, latestFiling: filing });

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: secAnalysisModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是美股 SEC 财报分析员。',
            '必须优先使用最新 filing 和最新季度数据，不能因为 FY 数据较完整就回退到 2024 年。',
            '必须优先使用最新 filing 和最新季度数据，不能因为 FY 数据较完整就回退到 2024 年。',
            '必须优先使用最新 filing 和最新季度数据，不能因为 FY 数据较完整就回退到 2024 年。',
            '只基于用户给定的 SEC section 输出 JSON。',
            '不要编造数字；数字必须来自文本或留空。',
            '每个结论必须带 section、quote、confidence。',
            '输出 JSON: {"source":"deepseek","confidence":0-1,"guidanceChanges":[],"riskFlags":[],"liquidityNotes":[],"sourceQuotes":[]}'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            ticker,
            accessionNumber: filing.accessionNumber,
            form: filing.form,
            filingDate: filing.filingDate,
            sections: sections.map((section) => ({ name: section.name, text: section.text.slice(0, 5000), hash: section.hash }))
          })
        }
      ]
    })
  });

  if (!response.ok) return buildFallbackAiInsights({ sections, latestFiling: filing });
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '';
  try {
    return {
      ...buildFallbackAiInsights({ sections, latestFiling: filing }),
      ...parseJsonObject(content),
      source: 'deepseek'
    };
  } catch {
    return buildFallbackAiInsights({ sections, latestFiling: filing });
  }
}

async function getAiInsightsForLatestFiling(ticker, filing) {
  if (!filing) return null;
  try {
    const text = await getFilingText(filing);
    const sections = splitFilingSections(text);
    return analyzeFilingSectionsWithDeepSeek({ ticker, filing, sections });
  } catch (error) {
    return {
      source: 'error',
      confidence: 0,
      guidanceChanges: [],
      riskFlags: [{ severity: 'medium', detail: error.message }],
      liquidityNotes: [],
      sourceQuotes: []
    };
  }
}

async function analyzeFilingSummaryWithDeepSeek({ ticker, filing, sections }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for filing summaries');

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: secAnalysisModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是负责美股基本面研究的资深金融分析师。',
            '只根据给定 SEC filing 内容输出中文摘要，不使用外部信息，不编造数字。',
            'headline、label、detail、analystView 所有字段必须使用简体中文；公司名、产品名和 SEC 表格术语可以保留英文。',
            '优先识别：收入与增长驱动、利润率、现金流与流动性、资本开支、管理层指引、重大交易、融资、诉讼、客户集中度和会计风险。',
            '8-K 要说明事件是什么、对盈利或资产负债表的影响；10-Q/10-K 要说明业绩变化、质量和关键风险。',
            '没有证据的维度直接省略。禁止输出“需要复核”“未找到”“建议关注”等空泛措辞。',
            'headline 必须是一句有方向性的结论。',
            'bullets 输出 3 至 5 条，每条包含 label、detail、importance；detail 必须带具体事实或明确影响。',
            'analystView 用一句话说明该 filing 对投资判断的具体含义，不给买卖建议。',
            '输出 JSON: {"headline":"","bullets":[{"label":"","detail":"","importance":"high|medium|low"}],"analystView":""}'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            ticker,
            form: filing.form,
            filingDate: filing.filingDate,
            reportDate: filing.reportDate,
            accessionNumber: filing.accessionNumber,
            sections: sections.slice(0, 7).map((section) => ({
              name: section.name,
              text: section.text.slice(0, 4500)
            }))
          })
        }
      ]
    })
  });

  if (!response.ok) throw new Error(`DeepSeek filing summary HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '';
  return normalizeFilingSummary({
    ...parseJsonObject(content),
    source: 'deepseek',
    generatedAt: new Date().toISOString()
  }, filing);
}

async function getSecFilingSummary(ticker, accessionNumber) {
  const clean = cleanTicker(ticker);
  const accession = cleanAccession(accessionNumber);
  const stored = filingSummaryGet.get(clean, accession);
  if (stored?.payload) return JSON.parse(stored.payload);
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required for filing summaries');
  }

  const filingsPayload = await getSecFilings(clean, 50);
  const filing = filingsPayload.filings.find((item) => item.accessionNumber === accession);
  if (!filing) throw new Error('SEC filing not found');

  const text = await getFilingText(filing);
  const sections = splitFilingSections(text);
  const summary = await analyzeFilingSummaryWithDeepSeek({ ticker: clean, filing, sections });
  if (!summary.headline && !summary.bullets.length && !summary.analystView) {
    throw new Error('AI filing summary did not contain usable analysis');
  }

  filingSummaryPut.run(clean, accession, summary.generatedAt, JSON.stringify(summary));
  return summary;
}

async function getInlineMetricsForLatestFiling(filing) {
  if (!filing) return [];
  try {
    const raw = await getFilingRaw(filing);
    return extractInlineFinancialMetrics(raw, filing);
  } catch {
    return [];
  }
}

async function downloadFilingPdf(ticker, accessionNumber) {
  const clean = cleanTicker(ticker);
  const accession = cleanAccession(accessionNumber);
  const filings = await getSecFilings(clean, 50);
  const filing = filings.filings.find((item) => item.accessionNumber === accession);
  if (!filing) {
    throw new Error(`Filing ${accession} was not found for ${clean}`);
  }

  const cacheKey = `sec:pdf:${clean}:${accession}`;
  const cached = cacheRead(cacheKey, secDocumentTtlMs);
  if (cached?.base64) {
    return { filing, pdf: Buffer.from(cached.base64, 'base64'), source: 'cache' };
  }

  const text = await getFilingText(filing);

  const title = `${clean} ${filing.form} ${filing.filingDate}`;
  const subtitle = `${filing.companyName} | Accession ${filing.accessionNumber}`;
  const pdf = await createPdfBuffer({ title, subtitle, sourceUrl: filing.documentUrl, text });
  cacheWrite(cacheKey, { base64: pdf.toString('base64'), filing, sourceUrl: filing.documentUrl });
  return { filing, pdf, source: 'sec' };
}

function safeFilename(value) {
  return String(value || 'filing')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

function parseJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model did not return a JSON object');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeStrategyText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\bqqq\b/g, 'QQQ')
    .replace(/\btqqq\b/g, 'TQQQ')
    .replace(/\bspy\b/g, 'SPY')
    .replace(/\btlt\b/g, 'TLT')
    .replace(/\bsgov\b/g, 'SGOV')
    .replace(/\bgld\b/g, 'GLD')
    .replace(/(\d+(?:\.\d+)?)\s*％/g, '$1%')
    .replace(/([，。；])\s*/g, '$1')
    .trim();
}

function compactStrategyName(text) {
  if (/杠杆|TQQQ/i.test(text) && /回撤/.test(text)) return '回撤分批策略';
  if (/均线/.test(text)) return '均线调仓策略';
  if (/现金|SGOV|防守/.test(text)) return '防守调仓策略';
  return '自定义策略';
}

function sentenceFromRaw(description) {
  const text = normalizeStrategyText(description);
  const drawdowns = [...text.matchAll(/(?:回撤|下跌|跌)\s*(\d+(?:\.\d+)?)\s*%?/g)].map((match) => `${match[1]}%`);
  const usesTqqq = /TQQQ|杠杆/i.test(text) && !/不(?:用|使用)?杠杆|不要用杠杆|避免杠杆/.test(text);
  const target = usesTqqq ? 'TQQQ' : 'QQQ';
  const exit = /恢复|回到|前高|退出|清仓/.test(text);

  if (drawdowns.length) {
    const steps = drawdowns.map((level, index) => {
      if (usesTqqq) {
        const weight = index === 0 ? '小幅提高' : '继续提高';
        return `QQQ 回撤达到 ${level} 时，${weight} ${target} 仓位`;
      }
      return `QQQ 回撤达到 ${level} 时，增加 ${target} 仓位`;
    });
    if (exit) steps.push('当 QQQ 修复到前高附近时，退出增强仓位并回到基础配置');
    return steps.join('；') + '。';
  }

  return text.endsWith('。') ? text : `${text}。`;
}

function refineStrategyText(existingStrategy, feedback) {
  const existing = normalizeStrategyText(existingStrategy);
  const note = normalizeStrategyText(feedback);
  if (!existing) return sentenceFromRaw(note);

  if (/不(?:用|使用)?杠杆|不要用杠杆|避免杠杆/.test(note)) {
    return '不使用杠杆。以 QQQ 作为主要买入标的；当 QQQ 出现明确回撤时分批加仓，修复到前高附近后降低新增仓位，回到基础配置。';
  }

  if (/更保守|保守一点|降低风险/.test(note)) {
    return `${existing.replace(/TQQQ 仓位/g, '增强仓位')} 控制单次加仓幅度，优先保留现金缓冲。`;
  }

  if (/止损|退出|清仓/.test(note)) {
    return `${existing.replace(/。$/, '')}；若触发止损或趋势失效，降低风险仓位并回到基础配置。`;
  }

  return `${existing.replace(/。$/, '')}；按追加意见调整：${note.replace(/。$/, '')}。`;
}

function normalizeStrategyDescription(raw) {
  const strategy = raw?.strategy && typeof raw.strategy === 'object' ? raw.strategy : raw;
  const displayText = normalizeStrategyText(strategy?.displayText || strategy?.description || strategy?.text || '');
  if (!displayText) {
    throw new Error('Model did not return a strategy description');
  }
  return {
    name: String(strategy?.name || compactStrategyName(displayText)).slice(0, 24),
    displayText: displayText.endsWith('。') ? displayText : `${displayText}。`
  };
}

async function describeStrategyWithDeepSeek(description, existingStrategy = '') {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set on the API server');
  }

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: strategyModel,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你负责把用户的投资策略口语描述整理成页面可展示的自然语言策略。',
            '只整理、纠错、补全用户原意，不新增用户没有表达的交易逻辑。',
            '如果用户给出 existingStrategy，按用户新的反馈改写已有策略。',
            '输出 JSON only，格式：{"name":"不超过12个中文字","displayText":"一段清晰明确的中文策略描述"}。',
            'displayText 不要列结构化字段，不要返回按钮、标签或条件 JSON。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({ description, existingStrategy }, null, 2)
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`DeepSeek HTTP ${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '';
  return normalizeStrategyDescription(parseJsonObject(content));
}

function describeStrategyFallback(description, existingStrategy = '') {
  const displayText = existingStrategy
    ? refineStrategyText(existingStrategy, description)
    : sentenceFromRaw(description);
  return normalizeStrategyDescription({
    name: compactStrategyName(`${existingStrategy} ${description}`),
    displayText
  });
}

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    json(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/ibkr/status' && req.method === 'GET') {
    json(res, 200, {
      status: await getIbkrStatus(),
      snapshot: readIbkrSnapshot(db, url.searchParams.get('accountId'))
    });
    return;
  }

  if (url.pathname === '/api/ibkr/accounts' && req.method === 'GET') {
    try {
      json(res, 200, { accounts: await getIbkrAccounts() });
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/ibkr/snapshot' && req.method === 'GET') {
    json(res, 200, readIbkrSnapshot(db, url.searchParams.get('accountId')));
    return;
  }

  if (url.pathname === '/api/ibkr/sync' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const accountId = String(body.accountId || '').trim();
      const result = await syncIbkrAccount(accountId);
      json(res, 200, {
        ...readIbkrSnapshot(db, result.account.accountId),
        status: await getIbkrStatus()
      });
    } catch (error) {
      json(res, 502, {
        error: error.message,
        snapshot: readIbkrSnapshot(db)
      });
    }
    return;
  }

  if (url.pathname === '/api/parse-strategy' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const description = String(body.description || '').trim();
      if (!description) {
        json(res, 400, { error: 'Description is required' });
        return;
      }
      const existingStrategy = String(body.existingStrategy || '').trim();
      try {
        json(res, 200, { strategy: await describeStrategyWithDeepSeek(description, existingStrategy), source: 'deepseek' });
      } catch (error) {
        json(res, 200, { strategy: describeStrategyFallback(description, existingStrategy), source: 'fallback', warning: error.message });
      }
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  const secCompanyMatch = url.pathname.match(/^\/api\/sec\/company\/([^/]+)$/);
  if (secCompanyMatch && req.method === 'GET') {
    const ticker = cleanTicker(secCompanyMatch[1]);
    if (!ticker) {
      json(res, 400, { error: 'Ticker is required' });
      return;
    }
    try {
      json(res, 200, await getSecCompany(ticker));
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  const secFilingsMatch = url.pathname.match(/^\/api\/sec\/filings\/([^/]+)$/);
  if (secFilingsMatch && req.method === 'GET') {
    const ticker = cleanTicker(secFilingsMatch[1]);
    const limit = Number(url.searchParams.get('limit') || 20);
    const force = url.searchParams.get('force') === '1';
    if (!ticker) {
      json(res, 400, { error: 'Ticker is required' });
      return;
    }
    try {
      json(res, 200, await getSecFilings(ticker, limit, force));
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  const secReportMatch = url.pathname.match(/^\/api\/sec\/report\/([^/]+)$/);
  if (secReportMatch && req.method === 'GET') {
    const ticker = cleanTicker(secReportMatch[1]);
    const force = url.searchParams.get('force') === '1';
    if (!ticker) {
      json(res, 400, { error: 'Ticker is required' });
      return;
    }
    try {
      json(res, 200, await getSecAnalysisReport(ticker, { force }));
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  const secFilingSummaryMatch = url.pathname.match(/^\/api\/sec\/filings\/([^/]+)\/([0-9-]+)\/summary$/);
  if (secFilingSummaryMatch && req.method === 'GET') {
    const ticker = cleanTicker(secFilingSummaryMatch[1]);
    const accession = cleanAccession(secFilingSummaryMatch[2]);
    if (!ticker || !accession) {
      json(res, 400, { error: 'Ticker and accession are required' });
      return;
    }
    try {
      json(res, 200, await getSecFilingSummary(ticker, accession));
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  const secPdfMatch = url.pathname.match(/^\/api\/sec\/filings\/([^/]+)\/([0-9-]+)\.pdf$/);
  if (secPdfMatch && req.method === 'GET') {
    const ticker = cleanTicker(secPdfMatch[1]);
    const accession = cleanAccession(secPdfMatch[2]);
    if (!ticker || !accession) {
      json(res, 400, { error: 'Ticker and accession are required' });
      return;
    }
    try {
      const { filing, pdf } = await downloadFilingPdf(ticker, accession);
      const filename = safeFilename(`${ticker}-${filing.form}-${filing.filingDate}-${filing.accessionNumber}.pdf`);
      binary(res, 200, pdf, {
        'content-type': 'application/pdf',
        'content-length': String(pdf.length),
        'content-disposition': `attachment; filename="${filename}"`
      });
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

  const match = url.pathname.match(/^\/api\/prices\/([^/]+)$/);
  if (!match || req.method !== 'GET') {
    json(res, 404, { error: 'Not found' });
    return;
  }

  const ticker = cleanTicker(match[1]);
  if (!ticker) {
    json(res, 400, { error: 'Ticker is required' });
    return;
  }

  try {
    json(res, 200, await getPrices(ticker));
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`market data API listening on http://127.0.0.1:${port}`);
});
