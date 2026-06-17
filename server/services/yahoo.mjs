import { cacheRead, cacheWrite, dayMs, marketOverviewTtlMs, priceCacheRead, priceCacheWrite, priceTtlMs, valuationTtlMs } from './cache.mjs';

// quoteSummary (v10) requires a browser-like UA — Yahoo returns 401 crumbs for generic UAs.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let crumbSession = null; // { cookie, crumb, fetchedAt }
const CRUMB_TTL_MS = 50 * 60 * 1000;

class YahooRateLimitError extends Error {}

async function fetchCrumbSession() {
  const cookieResponse = await fetch('https://fc.yahoo.com', {
    headers: { 'user-agent': BROWSER_UA },
    redirect: 'manual'
  });
  const cookie = (cookieResponse.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Yahoo did not return a session cookie');

  const crumbResponse = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'user-agent': BROWSER_UA, cookie }
  });
  if (crumbResponse.status === 429) throw new YahooRateLimitError('Yahoo Finance HTTP 429');
  if (!crumbResponse.ok) throw new Error(`Yahoo crumb HTTP ${crumbResponse.status}`);
  const crumb = (await crumbResponse.text()).trim();
  if (!crumb || crumb.startsWith('{')) throw new Error('Yahoo did not return a usable crumb');

  crumbSession = { cookie, crumb, fetchedAt: Date.now() };
  return crumbSession;
}

async function getCrumbSession() {
  if (crumbSession && Date.now() - crumbSession.fetchedAt < CRUMB_TTL_MS) return crumbSession;
  return fetchCrumbSession();
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

export async function getPrices(db, ticker) {
  const rangeKey = '1d-full';
  const cached = await priceCacheRead(db, ticker, rangeKey);
  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < priceTtlMs) return { ...JSON.parse(cached.payload), source: 'cache' };
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
  await priceCacheWrite(db, ticker, rangeKey, payload);
  return { ...payload, source: 'yahoo' };
}

const marketIndices = [
  { symbol: '^DJI', name: 'Dow Jones' },
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^IXIC', name: 'Nasdaq' },
  { symbol: '^RUT', name: 'Russell' },
  { symbol: '^VIX', name: 'VIX' }
];

async function fetchIntradayRaw(symbol) {
  const params = new URLSearchParams({ range: '1d', interval: '5m', includePrePost: 'false' });
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 PortfolioBacktest/0.1'
    }
  });
  if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
  return (await response.json())?.chart?.result?.[0];
}

async function fetchIndexQuote({ symbol, name }) {
  const result = await fetchIntradayRaw(symbol);
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

// Intraday sparkline — lightweight in-memory cache per symbol, TTL 5 min.
const sparklineCache = new Map();
const SPARKLINE_TTL = 5 * 60 * 1000;

export async function getSparkline(symbol) {
  const entry = sparklineCache.get(symbol);
  if (entry && Date.now() - entry.ts < SPARKLINE_TTL) return entry.data;

  const result = await fetchIntradayRaw(symbol);
  const meta = result?.meta || {};
  const closes = (result?.indicators?.quote?.[0]?.close || []).map((v, i) => {
    const ts = (result.timestamp?.[i] ?? 0) * 1000;
    return Number.isFinite(v) ? { t: ts, v: Number(v.toFixed(4)) } : null;
  }).filter(Boolean);

  const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
  const data = { symbol, previousClose, points: closes };
  sparklineCache.set(symbol, { ts: Date.now(), data });
  return data;
}

export async function getMarketOverview(db) {
  const cacheKey = 'market:overview:v1';
  const cached = await cacheRead(db, cacheKey, marketOverviewTtlMs);
  if (cached) return cached;

  const results = await Promise.allSettled(marketIndices.map(fetchIndexQuote));
  const indices = results.map((result) => (result.status === 'fulfilled' ? result.value : null)).filter(Boolean);
  if (indices.length < marketIndices.length) {
    const stale = await cacheRead(db, cacheKey, dayMs);
    if (stale && stale.indices.length > indices.length) return stale;
  }
  if (!indices.length) {
    throw new Error('指数行情获取失败');
  }

  const payload = { indices, fetchedAt: new Date().toISOString() };
  await cacheWrite(db, cacheKey, payload);
  return payload;
}

const VALUATION_MODULES = 'price,summaryDetail,defaultKeyStatistics,financialData';
const FINANCIALS_MODULES = 'incomeStatementHistoryQuarterly,incomeStatementHistory';

async function fetchQuoteSummaryRaw(ticker, session, modules) {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`;
  const response = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'application/json', cookie: session.cookie } });
  if (response.status === 429) throw new YahooRateLimitError('Yahoo Finance HTTP 429');
  if (response.status === 401) {
    // Crumb expired/invalid — refetch once and retry.
    const fresh = await fetchCrumbSession();
    const retryUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(fresh.crumb)}`;
    const retry = await fetch(retryUrl, { headers: { 'user-agent': BROWSER_UA, accept: 'application/json', cookie: fresh.cookie } });
    if (retry.status === 429) throw new YahooRateLimitError('Yahoo Finance HTTP 429');
    if (!retry.ok) throw new Error(`Yahoo Finance HTTP ${retry.status}`);
    return retry.json();
  }
  if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
  return response.json();
}

async function fetchQuoteV7Raw(ticker) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`;
  const response = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'application/json' } });
  if (response.status === 429) throw new YahooRateLimitError('Yahoo Finance HTTP 429');
  if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
  return response.json();
}

function pickRaw(node) {
  return Number.isFinite(node?.raw) ? node.raw : null;
}

// Pure transform: Yahoo's nested {raw, fmt} module shape -> a flat metrics object.
// Exported for unit testing without network access.
export function normalizeValuationPayload(ticker, quoteSummaryJson, quoteV7Json = null) {
  const result = quoteSummaryJson?.quoteSummary?.result?.[0] || {};
  const price = result.price || {};
  const summaryDetail = result.summaryDetail || {};
  const keyStats = result.defaultKeyStatistics || {};
  const financialData = result.financialData || {};
  const v7 = quoteV7Json?.quoteResponse?.result?.[0] || null;

  const currentPrice = pickRaw(price.regularMarketPrice) ?? pickRaw(financialData.currentPrice) ?? v7?.regularMarketPrice ?? null;
  const sharesOutstanding = pickRaw(keyStats.sharesOutstanding) ?? v7?.sharesOutstanding ?? null;
  const marketCap = pickRaw(price.marketCap) ?? v7?.marketCap ?? (Number.isFinite(currentPrice) && Number.isFinite(sharesOutstanding) ? currentPrice * sharesOutstanding : null);

  if (!Number.isFinite(currentPrice) && !marketCap) {
    throw new Error(`No valuation data for ${ticker}`);
  }

  return {
    ticker,
    companyName: price.longName || price.shortName || v7?.longName || v7?.shortName || ticker,
    currentPrice,
    currency: price.currency || v7?.currency || 'USD',
    marketCap,
    sharesOutstanding,
    multiples: {
      trailingPE: pickRaw(summaryDetail.trailingPE) ?? v7?.trailingPE ?? null,
      forwardPE: pickRaw(summaryDetail.forwardPE) ?? pickRaw(keyStats.forwardPE) ?? v7?.forwardPE ?? null,
      priceToSales: pickRaw(summaryDetail.priceToSalesTrailing12Months) ?? null,
      priceToBook: pickRaw(keyStats.priceToBook) ?? null,
      enterpriseToEbitda: pickRaw(keyStats.enterpriseToEbitda) ?? null,
      enterpriseToRevenue: pickRaw(keyStats.enterpriseToRevenue) ?? null,
      pegRatio: pickRaw(keyStats.pegRatio) ?? null
    },
    financials: {
      totalRevenue: pickRaw(financialData.totalRevenue) ?? null,
      revenueGrowth: pickRaw(financialData.revenueGrowth) ?? null,
      grossMargins: pickRaw(financialData.grossMargins) ?? null,
      ebitdaMargins: pickRaw(financialData.ebitdaMargins) ?? null,
      profitMargins: pickRaw(financialData.profitMargins) ?? null,
      returnOnEquity: pickRaw(financialData.returnOnEquity) ?? null,
      totalCash: pickRaw(financialData.totalCash) ?? null,
      totalDebt: pickRaw(financialData.totalDebt) ?? null,
      freeCashflow: pickRaw(financialData.freeCashflow) ?? null,
      operatingCashflow: pickRaw(financialData.operatingCashflow) ?? null,
      ebitda: pickRaw(financialData.ebitda) ?? null
    },
    analyst: {
      targetMeanPrice: pickRaw(financialData.targetMeanPrice) ?? null,
      targetLowPrice: pickRaw(financialData.targetLowPrice) ?? null,
      targetHighPrice: pickRaw(financialData.targetHighPrice) ?? null,
      recommendationKey: financialData.recommendationKey || null,
      numberOfAnalystOpinions: pickRaw(financialData.numberOfAnalystOpinions) ?? null
    },
    fiftyTwoWeek: {
      low: pickRaw(summaryDetail.fiftyTwoWeekLow) ?? null,
      high: pickRaw(summaryDetail.fiftyTwoWeekHigh) ?? null
    },
    beta: pickRaw(keyStats.beta) ?? pickRaw(summaryDetail.beta) ?? null
  };
}

export async function getValuation(db, ticker, { force = false } = {}) {
  const cacheKey = `valuation:${ticker}`;
  if (!force) {
    const cached = await cacheRead(db, cacheKey, valuationTtlMs);
    if (cached) return { ...cached, source: 'cache' };
  }

  try {
    const session = await getCrumbSession();
    const quoteSummaryJson = await fetchQuoteSummaryRaw(ticker, session, VALUATION_MODULES);
    const payload = normalizeValuationPayload(ticker, quoteSummaryJson);
    await cacheWrite(db, cacheKey, payload);
    return { ...payload, source: 'yahoo' };
  } catch (error) {
    // Yahoo's 429 applies to the whole IP, not just this endpoint — hitting v7
    // right after would almost certainly also 429 and only prolongs the block.
    // Skip straight to the stale-cache fallback instead.
    if (error instanceof YahooRateLimitError) {
      const stale = await cacheRead(db, cacheKey, 7 * dayMs);
      if (stale) return { ...stale, source: 'stale-cache' };
      throw new Error('Yahoo Finance 当前限流，请稍后重试');
    }

    try {
      const quoteV7Json = await fetchQuoteV7Raw(ticker);
      const payload = normalizeValuationPayload(ticker, null, quoteV7Json);
      await cacheWrite(db, cacheKey, payload);
      return { ...payload, source: 'yahoo-v7-fallback' };
    } catch (fallbackError) {
      const stale = await cacheRead(db, cacheKey, 7 * dayMs);
      if (stale) return { ...stale, source: 'stale-cache' };
      if (fallbackError instanceof YahooRateLimitError) throw new Error('Yahoo Finance 当前限流，请稍后重试');
      throw error;
    }
  }
}

function dateFromDateNode(node) {
  if (Number.isFinite(node?.raw)) return new Date(node.raw * 1000).toISOString().slice(0, 10);
  return node?.fmt || null;
}

function mapIncomeStatementNode(node) {
  const end = dateFromDateNode(node?.endDate);
  if (!end) return null;
  return {
    end,
    revenue: pickRaw(node.totalRevenue),
    costOfRevenue: pickRaw(node.costOfRevenue),
    grossProfit: pickRaw(node.grossProfit),
    operatingIncome: pickRaw(node.operatingIncome) ?? pickRaw(node.ebit),
    netIncome: pickRaw(node.netIncome)
  };
}

// Pure transform: Yahoo's quarterly/annual income statement modules -> flat
// {quarterly, annual} row lists. Exported for unit testing without network access.
export function normalizeIncomeStatementPayload(ticker, quoteSummaryJson) {
  const result = quoteSummaryJson?.quoteSummary?.result?.[0] || {};
  const quarterly = (result.incomeStatementHistoryQuarterly?.incomeStatementHistory || [])
    .map(mapIncomeStatementNode)
    .filter((row) => row && Number.isFinite(row.revenue));
  const annual = (result.incomeStatementHistory?.incomeStatementHistory || [])
    .map(mapIncomeStatementNode)
    .filter((row) => row && Number.isFinite(row.revenue));

  if (!quarterly.length && !annual.length) {
    throw new Error(`No income statement data for ${ticker}`);
  }
  return { ticker, quarterly, annual };
}

// Yahoo's free quoteSummary only exposes the trailing ~4 quarters and ~4 fiscal
// years of income statement data (no deep multi-year quarterly history like SEC
// company facts), so this is a shallower but fully Yahoo-sourced replacement.
export async function getYahooIncomeStatements(db, ticker, { force = false } = {}) {
  const cacheKey = `yahoo-financials:${ticker}`;
  if (!force) {
    const cached = await cacheRead(db, cacheKey, valuationTtlMs);
    if (cached) return { ...cached, source: 'cache' };
  }

  try {
    const session = await getCrumbSession();
    const json = await fetchQuoteSummaryRaw(ticker, session, FINANCIALS_MODULES);
    const payload = normalizeIncomeStatementPayload(ticker, json);
    await cacheWrite(db, cacheKey, payload);
    return { ...payload, source: 'yahoo' };
  } catch (error) {
    if (error instanceof YahooRateLimitError) {
      const stale = await cacheRead(db, cacheKey, 7 * dayMs);
      if (stale) return { ...stale, source: 'stale-cache' };
      throw new Error('Yahoo Finance 当前限流，请稍后重试');
    }
    const stale = await cacheRead(db, cacheKey, 7 * dayMs);
    if (stale) return { ...stale, source: 'stale-cache' };
    throw error;
  }
}
