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
  );

  CREATE TABLE IF NOT EXISTS sec_filing_extracts (
    ticker            TEXT NOT NULL,
    accession_number  TEXT NOT NULL,
    form              TEXT,
    filing_date       TEXT,
    report_date       TEXT,
    kind              TEXT NOT NULL,
    label             TEXT NOT NULL,
    period            TEXT,
    value             REAL,
    unit              TEXT,
    detail            TEXT,
    quote             TEXT,
    importance        TEXT,
    generated_at      TEXT NOT NULL,
    PRIMARY KEY (ticker, accession_number, kind, label, period)
  );

  CREATE TABLE IF NOT EXISTS sec_filing_extract_status (
    ticker            TEXT NOT NULL,
    accession_number  TEXT NOT NULL,
    status            TEXT NOT NULL,
    reason            TEXT,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (ticker, accession_number)
  );

  CREATE TABLE IF NOT EXISTS holding_thesis_checks (
    ticker                   TEXT NOT NULL,
    thesis_hash              TEXT NOT NULL,
    latest_accession_number  TEXT NOT NULL,
    thesis_text              TEXT,
    payload                  TEXT NOT NULL,
    generated_at             TEXT NOT NULL,
    PRIMARY KEY (ticker, thesis_hash, latest_accession_number)
  )
`);

try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS sec_filing_chunks USING fts5(
    ticker, accession_number, form, filing_date, section, chunk_text
  )`);
} catch {
  db.exec(`CREATE TABLE IF NOT EXISTS sec_filing_chunks (
    ticker TEXT, accession_number TEXT, form TEXT, filing_date TEXT,
    section TEXT, chunk_text TEXT
  )`);
}
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

db.exec(`CREATE INDEX IF NOT EXISTS idx_extracts_ticker ON sec_filing_extracts(ticker, kind)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_extract_status_ticker ON sec_filing_extract_status(ticker)`);

const extractStatusGet = db.prepare(`SELECT status FROM sec_filing_extract_status WHERE ticker = ? AND accession_number = ?`);
const extractStatusPut = db.prepare(`
  INSERT INTO sec_filing_extract_status (ticker, accession_number, status, reason, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(ticker, accession_number) DO UPDATE SET
    status = excluded.status, reason = excluded.reason, updated_at = excluded.updated_at
`);
const extractPut = db.prepare(`
  INSERT INTO sec_filing_extracts
    (ticker, accession_number, form, filing_date, report_date, kind, label, period, value, unit, detail, quote, importance, generated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ticker, accession_number, kind, label, period) DO UPDATE SET
    value = excluded.value, unit = excluded.unit, detail = excluded.detail,
    quote = excluded.quote, importance = excluded.importance, generated_at = excluded.generated_at
`);
const extractsGetByTicker = db.prepare(`
  SELECT * FROM sec_filing_extracts WHERE ticker = ? ORDER BY filing_date DESC, kind
`);
const thesisCheckGet = db.prepare(`
  SELECT payload FROM holding_thesis_checks
  WHERE ticker = ? AND thesis_hash = ? AND latest_accession_number = ?
`);
const thesisCheckPut = db.prepare(`
  INSERT INTO holding_thesis_checks (ticker, thesis_hash, latest_accession_number, thesis_text, payload, generated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(ticker, thesis_hash, latest_accession_number) DO UPDATE SET
    thesis_text = excluded.thesis_text, payload = excluded.payload, generated_at = excluded.generated_at
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
const secFormsBusiness = new Set(['10-K', '10-Q', '8-K', '10-K/A', '10-Q/A', '8-K/A']);
const secFormsInsider  = new Set(['3', '4', '5', '3/A', '4/A', '5/A']);
function isBusinessFiling(form) { return secFormsBusiness.has(form); }
function isInsiderFiling(form)  { return secFormsInsider.has(form); }
function isTrackedFiling(form)  { return isBusinessFiling(form) || isInsiderFiling(form); }

const secAnalysisModel = process.env.DEEPSEEK_SEC_MODEL || 'deepseek-chat';
const strategyModel = process.env.DEEPSEEK_STRATEGY_MODEL || 'deepseek-chat';

let _secQueueRunning = false;
const _secQueue = [];
function secQueueFetch(url, accept) {
  return new Promise((resolve, reject) => {
    _secQueue.push({ url, accept, resolve, reject });
    if (!_secQueueRunning) _drainSecQueue();
  });
}
async function _drainSecQueue() {
  _secQueueRunning = true;
  while (_secQueue.length > 0) {
    const { url, accept, resolve, reject } = _secQueue.shift();
    try {
      resolve(await secFetch(url, accept));
    } catch (err) {
      reject(err);
    }
    if (_secQueue.length > 0) await new Promise((r) => setTimeout(r, 150));
  }
  _secQueueRunning = false;
}

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

const marketIndices = [
  { symbol: '^DJI', name: 'Dow Jones' },
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^IXIC', name: 'Nasdaq' },
  { symbol: '^RUT', name: 'Russell' },
  { symbol: '^VIX', name: 'VIX' }
];
const marketOverviewTtlMs = 60 * 1000;

async function fetchIndexQuote({ symbol, name }) {
  const params = new URLSearchParams({ range: '1d', interval: '5m', includePrePost: 'false' });
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 PortfolioBacktest/0.1'
    }
  });
  if (!response.ok) {
    throw new Error(`Yahoo Finance HTTP ${response.status}`);
  }

  const result = (await response.json())?.chart?.result?.[0];
  const meta = result?.meta || {};
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter((value) => Number.isFinite(value));
  const price = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : closes[closes.length - 1];
  const previousClose = Number.isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose : meta.previousClose;
  if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose === 0) {
    throw new Error(`No quote for ${symbol}`);
  }

  return {
    symbol,
    name,
    price,
    previousClose,
    change: price - previousClose,
    changePercent: ((price - previousClose) / previousClose) * 100,
    marketTime: Number.isFinite(meta.regularMarketTime) ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    sparkline: closes.map((value) => Number(value.toFixed(4)))
  };
}

async function getMarketOverview() {
  const cacheKey = 'market:overview:v1';
  const cached = cacheRead(cacheKey, marketOverviewTtlMs);
  if (cached) return cached;

  const results = await Promise.allSettled(marketIndices.map(fetchIndexQuote));
  const indices = results.map((result) => (result.status === 'fulfilled' ? result.value : null)).filter(Boolean);
  if (indices.length < marketIndices.length) {
    const stale = cacheRead(cacheKey, dayMs);
    if (stale && stale.indices.length > indices.length) return stale;
  }
  if (!indices.length) {
    throw new Error('指数行情获取失败');
  }

  const payload = { indices, fetchedAt: new Date().toISOString() };
  cacheWrite(cacheKey, payload);
  return payload;
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
    .filter((filing) => isBusinessFiling(filing.form) && filing.primaryDocument)
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

function simpleHash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function extractHtmlTables(html) {
  const tables = [];
  const re = /<table[\s>][\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tableHtml = m[0];
    const start = Math.max(0, m.index - 300);
    const ctx = html.slice(start, m.index);
    const titleMatch = ctx.match(/(?:<(?:h[1-6]|p|div|td|th)[^>]*>)([^<]{4,120})<\/(?:h[1-6]|p|div|td|th)>\s*$/i);
    const caption = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const title = (caption ? htmlToText(caption[1]) : titleMatch ? htmlToText(titleMatch[1]) : '').slice(0, 120).trim();
    const text = htmlToText(tableHtml).replace(/[ \t]+/g, ' ').trim();
    if (text.length > 40) tables.push({ title, text: text.slice(0, 4000) });
  }
  return tables;
}

async function getFilingIndexDocuments(filing) {
  try {
    const resp = await secQueueFetch(filing.indexUrl, 'text/html,application/json,*/*');
    const text = await resp.text();
    const docs = [];
    const re = /href="(\/Archives\/edgar\/data\/[^"]+\.(htm|html|txt))"[^>]*>\s*([^<]+)<\/a>[\s\S]*?<td[^>]*>([^<]*EX-99[^<]*|[^<]*exhibit 99[^<]*)<\/td>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      docs.push({ url: `https://www.sec.gov${m[1]}`, description: m[4].trim() });
    }
    return docs;
  } catch {
    return [];
  }
}

async function extractForm4Data(filing) {
  try {
    const resp = await secQueueFetch(filing.documentUrl, 'text/xml,application/xml,*/*');
    const xml = await resp.text();
    const getTag = (tag, src) => { const m = src.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')); return m ? m[1].trim() : ''; };
    const getAllTags = (tag, src) => { const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'); const r = []; let m; while ((m = re.exec(src)) !== null) r.push(m[1]); return r; };

    const ownerName = getTag('rptOwnerName', xml) || getTag('issuerName', xml);
    const ownerTitle = getTag('officerTitle', xml);
    const isDirector = /<isDirector>1/.test(xml);
    const is10b51 = /<datesExercisableAndExpiration|<planName>/.test(xml);
    const generatedAt = new Date().toISOString();

    const items = [];
    for (const txn of getAllTags('nonDerivativeTransaction', xml)) {
      const code = getTag('transactionCode', txn);
      const shares = parseFloat(getTag('transactionShares', txn).replace(/[^0-9.-]/g, '')) || 0;
      const price = parseFloat(getTag('transactionPricePerShare', txn).replace(/[^0-9.-]/g, '')) || 0;
      const sharesAfter = parseFloat(getTag('sharesOwnedFollowingTransaction', txn).replace(/[^0-9.-]/g, '')) || 0;
      if (!code || shares === 0) continue;
      const label = `Insider ${code === 'S' ? 'sale' : code === 'P' ? 'purchase' : `transaction (${code})`} - ${ownerName}`;
      const detail = `${ownerName}${ownerTitle ? ` (${ownerTitle})` : ''} — code ${code}, ${shares.toLocaleString()} shares @ $${price.toFixed(2)}, holding after: ${sharesAfter.toLocaleString()}${is10b51 ? ' [10b5-1 plan]' : ''}`;
      items.push({ label, detail, code, shares, price, sharesAfter, is10b51, isDirector });
    }
    return { ownerName, items, generatedAt };
  } catch {
    return null;
  }
}

async function extractFilingWithDeepSeek(filing, tables, sections) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return [];

  const tablesSample = tables.slice(0, 8).map((t, i) => ({ i, title: t.title, text: t.text.slice(0, 1800) }));
  const sectionsSample = sections.slice(0, 5).map((s) => ({ name: s.name, text: s.text.slice(0, 1500) }));

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: secAnalysisModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是美股 SEC 财报数据提取专家。只根据给定内容提取数据，禁止编造。',
            '每个提取结果必须有 quote 字段引用原文（不超过 80 字符）。',
            '数字必须保留原始量级，识别表头中的 "in thousands/millions" 并在 unit 里注明。',
            '括号数字表示负值。分部收入、KPI、指引是最重要的提取目标。',
            '输出 JSON: {"extracts": [{"kind":"financial|segment|kpi|guidance|event","label":"指标名","period":"2025 Q2","value":null,"unit":"USD millions","detail":"中文说明","quote":"原文引用","importance":"high|medium|low"}]}'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            ticker: filing.ticker, form: filing.form, filingDate: filing.filingDate,
            accessionNumber: filing.accessionNumber,
            tables: tablesSample, sections: sectionsSample
          })
        }
      ]
    })
  });

  if (!response.ok) return [];
  try {
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content || '';
    const parsed = parseJsonObject(content);
    return Array.isArray(parsed.extracts) ? parsed.extracts : [];
  } catch {
    return [];
  }
}

async function persistFilingChunks(filing, sections) {
  try {
    db.prepare('DELETE FROM sec_filing_chunks WHERE ticker = ? AND accession_number = ?')
      .run(filing.ticker, filing.accessionNumber);
    const insertChunk = db.prepare(
      'INSERT INTO sec_filing_chunks (ticker, accession_number, form, filing_date, section, chunk_text) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const section of sections) {
      const text = section.text || '';
      for (let offset = 0; offset < text.length; offset += 1400) {
        const chunk = text.slice(offset, offset + 1500);
        if (chunk.trim().length > 30) {
          insertChunk.run(filing.ticker, filing.accessionNumber, filing.form, filing.filingDate, section.name, chunk);
        }
      }
    }
  } catch {
  }
}

async function ensureFilingExtracted(filing) {
  const existing = extractStatusGet.get(filing.ticker, filing.accessionNumber);
  if (existing?.status === 'done' || existing?.status === 'pending') return;

  extractStatusPut.run(filing.ticker, filing.accessionNumber, 'pending', null, new Date().toISOString());

  try {
    const generatedAt = new Date().toISOString();

    if (isInsiderFiling(filing.form)) {
      const data = await extractForm4Data(filing);
      if (!data || data.items.length === 0) {
        extractStatusPut.run(filing.ticker, filing.accessionNumber, 'skipped', 'no transactions', generatedAt);
        return;
      }
      for (const item of data.items) {
        extractPut.run(
          filing.ticker, filing.accessionNumber, filing.form, filing.filingDate, filing.reportDate,
          'event', item.label, filing.filingDate,
          item.shares, 'shares', item.detail, '', 'high', generatedAt
        );
      }
      extractStatusPut.run(filing.ticker, filing.accessionNumber, 'done', null, generatedAt);
      return;
    }

    const raw = await getFilingRaw(filing);
    const text = htmlToText(raw);
    const tables = extractHtmlTables(raw);
    const sections = splitFilingSections(text);

    let extraAttachments = [];
    if (filing.form === '8-K' || filing.form === '8-K/A') {
      extraAttachments = await getFilingIndexDocuments(filing);
    }

    let allTables = [...tables];
    for (const att of extraAttachments.slice(0, 3)) {
      try {
        const attResp = await secQueueFetch(att.url, 'text/html,*/*');
        const attHtml = await attResp.text();
        const attTables = extractHtmlTables(attHtml);
        allTables = [...allTables, ...attTables];
        const attText = htmlToText(attHtml);
        const attSections = splitFilingSections(attText);
        for (const sec of attSections) {
          const existing2 = sections.find((s) => s.name === sec.name);
          if (existing2) existing2.text += '\n' + sec.text;
          else sections.push(sec);
        }
      } catch {
      }
    }

    const aiExtracts = await extractFilingWithDeepSeek(filing, allTables, sections);
    await persistFilingChunks(filing, sections);

    let savedCount = 0;
    for (const item of aiExtracts) {
      if (!item.kind || !item.label) continue;
      extractPut.run(
        filing.ticker, filing.accessionNumber, filing.form, filing.filingDate, filing.reportDate,
        String(item.kind).slice(0, 30),
        String(item.label).slice(0, 200),
        String(item.period || '').slice(0, 30),
        Number.isFinite(Number(item.value)) ? Number(item.value) : null,
        String(item.unit || '').slice(0, 50),
        String(item.detail || '').slice(0, 500),
        String(item.quote || '').slice(0, 300),
        String(item.importance || 'medium').slice(0, 10),
        generatedAt
      );
      savedCount++;
    }

    const status = savedCount > 0 ? 'done' : 'skipped';
    const reason = savedCount > 0 ? null : 'no extracts returned';
    extractStatusPut.run(filing.ticker, filing.accessionNumber, status, reason, generatedAt);
  } catch (err) {
    extractStatusPut.run(filing.ticker, filing.accessionNumber, 'error', err.message.slice(0, 200), new Date().toISOString());
  }
}

const _prefetchInFlight = new Set();

async function prefetchTickerFilings(ticker) {
  if (_prefetchInFlight.has(ticker)) return;
  _prefetchInFlight.add(ticker);
  try {
    const [businessFilings, allFilingsPayload] = await Promise.all([
      getSecFilings(ticker, 8),
      getSecFilings(ticker, 50)
    ]);
    const insiderFilings = allFilingsPayload.filings
      .filter((f) => isInsiderFiling(f.form))
      .slice(0, 20);

    const toExtract = [...businessFilings.filings.slice(0, 8), ...insiderFilings];
    for (const filing of toExtract) {
      await ensureFilingExtracted(filing);
    }
  } catch {
  } finally {
    _prefetchInFlight.delete(ticker);
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

function thesisHash(thesisItems, riskItems) {
  const str = JSON.stringify({ t: thesisItems.map((i) => i.text), r: riskItems.map((i) => i.text) });
  return simpleHash32(str);
}

async function runThesisCheck(ticker, thesisItems, riskItems) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for thesis checks');

  const extracts = extractsGetByTicker.all(ticker);

  const kwResponse = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: secAnalysisModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '从用户的中文持仓逻辑中提取用于检索英文 SEC filing 的关键词和指标名。输出 JSON: {"keywords": ["英文词1","英文词2"]}' },
        { role: 'user', content: JSON.stringify({ thesisItems: thesisItems.map((i) => i.text) }) }
      ]
    })
  });
  let keywords = [];
  if (kwResponse.ok) {
    try {
      const kwPayload = await kwResponse.json();
      const kwContent = parseJsonObject(kwPayload?.choices?.[0]?.message?.content || '');
      keywords = Array.isArray(kwContent.keywords) ? kwContent.keywords.slice(0, 8) : [];
    } catch {
    }
  }

  let relevantChunks = [];
  if (keywords.length > 0) {
    try {
      const ftsQuery = keywords.map((k) => `"${k.replace(/"/g, '')}"`).join(' OR ');
      relevantChunks = db.prepare(
        `SELECT ticker, accession_number, section, chunk_text FROM sec_filing_chunks WHERE ticker = ? AND sec_filing_chunks MATCH ? LIMIT 12`
      ).all(ticker, ftsQuery);
    } catch {
      relevantChunks = db.prepare(
        `SELECT ticker, accession_number, section, chunk_text FROM sec_filing_chunks WHERE ticker = ? LIMIT 12`
      ).all(ticker);
    }
  }

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: secAnalysisModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是专业的投资逻辑验证助手。根据给定的 SEC filing 结构化数据和原文段落，对每条持仓逻辑进行自洽性和时效性验证。',
            '自洽性：把每条逻辑拆成前提 → 结论，判断 ① 前提是否属实（有 filing 证据），② 前提能否推出结论。',
            '时效性：用最新 filing 判断逻辑现在是否成立，是否有变化。',
            '输出信号，不给买卖建议。数字和结论必须有 quote 溯源，无证据判 no_evidence 不得编造。',
            '输出 JSON: {"items":[{"thesisId":"","verdict":"supported|weakened|broken|no_evidence","consistency":"consistent|self_contradictory|premise_false","confidence":0.0,"premises":[{"claim":"","holds":true,"note":"","evidenceRef":0}],"analysis":"中文","changes":"中文","retrieval":{"keywords":[],"hitFilings":[]},"evidence":[{"accessionNumber":"","period":"","metric":"","quote":""}]}],"crossItemConflicts":[{"between":[],"detail":""}],"coverage":{"filingsUsed":0,"filingsExpected":8}}'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            ticker,
            thesisItems,
            riskItems,
            extracts: extracts.slice(0, 120),
            relevantChunks: relevantChunks.map((c) => ({ accessionNumber: c.accession_number, section: c.section, text: c.chunk_text.slice(0, 800) })),
            keywords
          })
        }
      ]
    })
  });

  if (!response.ok) throw new Error(`DeepSeek thesis-check HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '';
  const result = parseJsonObject(content);
  result.coverage = result.coverage || { filingsUsed: extracts.length, filingsExpected: 8 };
  return result;
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

  if (url.pathname === '/api/market/overview' && req.method === 'GET') {
    try {
      json(res, 200, await getMarketOverview());
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }

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

  const prefetchMatch = url.pathname.match(/^\/api\/holdings\/([^/]+)\/prefetch$/);
  if (prefetchMatch && req.method === 'POST') {
    const ticker = cleanTicker(prefetchMatch[1]);
    if (!ticker) { json(res, 400, { error: 'Ticker is required' }); return; }
    json(res, 202, { ticker, status: 'queued' });
    prefetchTickerFilings(ticker).catch(() => {});
    return;
  }

  const thesisCheckMatch = url.pathname.match(/^\/api\/holdings\/([^/]+)\/thesis-check$/);
  if (thesisCheckMatch && req.method === 'POST') {
    const ticker = cleanTicker(thesisCheckMatch[1]);
    if (!ticker) { json(res, 400, { error: 'Ticker is required' }); return; }
    try {
      const body = await readJson(req);
      const thesisItems = Array.isArray(body.thesisItems) ? body.thesisItems.filter((i) => i?.text?.trim()) : [];
      const riskItems = Array.isArray(body.riskItems) ? body.riskItems.filter((i) => i?.text?.trim()) : [];
      const force = Boolean(body.force);
      if (thesisItems.length === 0) { json(res, 400, { error: 'thesisItems is required' }); return; }

      const hash = thesisHash(thesisItems, riskItems);
      const latestExtract = db.prepare(
        `SELECT accession_number FROM sec_filing_extract_status WHERE ticker = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1`
      ).get(ticker);
      const latestAccession = latestExtract?.accession_number || 'none';

      if (!force) {
        const cached = thesisCheckGet.get(ticker, hash, latestAccession);
        if (cached?.payload) {
          json(res, 200, { ...JSON.parse(cached.payload), cached: true });
          return;
        }
      }

      prefetchTickerFilings(ticker).catch(() => {});
      const result = await runThesisCheck(ticker, thesisItems, riskItems);
      const generatedAt = new Date().toISOString();
      thesisCheckPut.run(
        ticker, hash, latestAccession,
        JSON.stringify({ thesisItems, riskItems }),
        JSON.stringify(result),
        generatedAt
      );
      json(res, 200, { ...result, generatedAt, cached: false });
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
