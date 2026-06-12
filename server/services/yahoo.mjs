import { cacheRead, cacheWrite, dayMs, marketOverviewTtlMs, priceCacheRead, priceCacheWrite, priceTtlMs } from './cache.mjs';

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
