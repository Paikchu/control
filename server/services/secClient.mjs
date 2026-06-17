import { cacheRead, cacheWrite, secDocumentTtlMs, secFilingsTtlMs, secTickerTtlMs } from './cache.mjs';
import { cleanTicker, htmlToText } from '../util.mjs';

const secUserAgent = process.env.SEC_USER_AGENT || 'PortfolioBacktest/0.1 max@local.invalid';

const secFormsBusiness = new Set(['10-K', '10-Q', '8-K', '10-K/A', '10-Q/A', '8-K/A']);
const secFormsInsider = new Set(['3', '4', '5', '3/A', '4/A', '5/A']);
export function isBusinessFiling(form) { return secFormsBusiness.has(form); }
export function isInsiderFiling(form) { return secFormsInsider.has(form); }

export async function secFetch(url, accept = 'application/json') {
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

// SEC rate-limits aggressively; serialize bulk fetches with a small gap.
let _secQueueRunning = false;
const _secQueue = [];
export function secQueueFetch(url, accept) {
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

export async function getSecTickerMap(db) {
  const cacheKey = 'sec:ticker-map';
  const cached = await cacheRead(db, cacheKey, secTickerTtlMs);
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

  await cacheWrite(db, cacheKey, map);
  return map;
}

export async function getSecCompany(db, ticker) {
  const map = await getSecTickerMap(db);
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

export async function getSecFilings(db, ticker, limit = 20, force = false) {
  const clean = cleanTicker(ticker);
  const company = await getSecCompany(db, clean);
  const cacheKey = `sec:filings:${clean}`;
  const cached = force ? null : await cacheRead(db, cacheKey, secFilingsTtlMs);
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
      description: recent.primaryDocDescription?.[index] || '',
      items: recent.items?.[index] || ''
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
  await cacheWrite(db, cacheKey, result);
  return {
    ...result,
    filings: result.filings.slice(0, Math.max(1, Math.min(50, limit)))
  };
}

// Unlike getSecFilings (locked to 10-K/10-Q/8-K), this fetches any requested form types —
// used for DEF 14A (proxy roster) and 8-K Item 5.02 scanning by management analysis.
export async function getSecFilingsByForms(db, ticker, forms, { limit = 10, force = false } = {}) {
  const clean = cleanTicker(ticker);
  const company = await getSecCompany(db, clean);
  const formSet = new Set(forms);
  const cacheKey = `sec:filings:byform:${clean}:${forms.slice().sort().join(',')}`;
  const cached = force ? null : await cacheRead(db, cacheKey, secFilingsTtlMs);
  if (cached) return cached.filings.slice(0, limit);

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
      items: recent.items?.[index] || ''
    }))
    .filter((filing) => formSet.has(filing.form) && filing.primaryDocument)
    .map((filing) => ({
      ...filing,
      documentUrl: filingDocumentUrl(filing),
      indexUrl: filingIndexUrl(filing)
    }));

  await cacheWrite(db, cacheKey, { filings });
  return filings.slice(0, limit);
}

export async function getSecCompanyFacts(db, ticker, force = false) {
  const clean = cleanTicker(ticker);
  const company = await getSecCompany(db, clean);
  const cacheKey = `sec:companyfacts:${clean}`;
  const cached = force ? null : await cacheRead(db, cacheKey, secFilingsTtlMs);
  if (cached) return cached;

  const response = await secFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`);
  const payload = await response.json();
  await cacheWrite(db, cacheKey, payload);
  return payload;
}

export async function getFilingRaw(db, filing) {
  const cacheKey = `sec:text:${filing.ticker}:${filing.accessionNumber}`;
  const cached = await cacheRead(db, cacheKey, secDocumentTtlMs);
  if (cached?.raw) return cached.raw;

  const response = await secFetch(filing.documentUrl, 'text/html,application/xhtml+xml,text/plain,*/*');
  const raw = await response.text();
  if (!htmlToText(raw)) {
    throw new Error('SEC filing document did not contain readable text');
  }
  await cacheWrite(db, cacheKey, { raw, sourceUrl: filing.documentUrl });
  return raw;
}

export async function getFilingText(db, filing) {
  const raw = await getFilingRaw(db, filing);
  const text = htmlToText(raw);
  if (!text) {
    throw new Error('SEC filing document did not contain readable text');
  }
  return text;
}
