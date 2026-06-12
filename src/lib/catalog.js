export const assets = [
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF', type: '股票', color: '#1D4ED8', inception: '1999-03-10' },
  { symbol: 'TQQQ', name: '3x Nasdaq 100', type: '杠杆', color: '#B91C1C', inception: '2010-02-11' },
  { symbol: 'SPY', name: 'S&P 500 ETF', type: '股票', color: '#1D4ED8', inception: '1993-01-29' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', type: '股票', color: '#2457C5', inception: '2010-09-07' },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market', type: '股票', color: '#2457C5', inception: '2001-05-24' },
  { symbol: 'VT', name: 'Vanguard Total World Stock', type: '股票', color: '#2457C5', inception: '2008-06-24' },
  { symbol: 'VUG', name: 'Vanguard Growth ETF', type: '股票', color: '#2457C5', inception: '2004-01-26' },
  { symbol: 'VTV', name: 'Vanguard Value ETF', type: '股票', color: '#2457C5', inception: '2004-01-26' },
  { symbol: 'VGT', name: 'Vanguard Information Technology', type: '股票', color: '#2457C5', inception: '2004-01-26' },
  { symbol: 'VNQ', name: 'Vanguard Real Estate ETF', type: 'REIT', color: '#56667A', inception: '2004-09-23' },
  { symbol: 'VXUS', name: 'Vanguard Total International Stock', type: '股票', color: '#2457C5', inception: '2011-01-26' },
  { symbol: 'TLT', name: '20Y Treasury', type: '债券', color: '#15803D', inception: '2002-07-22' },
  { symbol: 'BND', name: 'Vanguard Total Bond Market', type: '债券', color: '#16724A', inception: '2007-04-03' },
  { symbol: 'AGG', name: 'US Aggregate Bond ETF', type: '债券', color: '#16724A', inception: '2003-09-22' },
  { symbol: 'SHY', name: '1-3Y Treasury ETF', type: '债券', color: '#16724A', inception: '2002-07-22' },
  { symbol: 'IEF', name: '7-10Y Treasury ETF', type: '债券', color: '#16724A', inception: '2002-07-22' },
  { symbol: 'SGOV', name: '0-3M Treasury', type: '债券', color: '#15803D', inception: '2020-05-26' },
  { symbol: 'GLD', name: 'Gold Trust', type: '黄金', color: '#B45309', inception: '2004-11-18' },
  { symbol: 'IAU', name: 'iShares Gold Trust', type: '黄金', color: '#A05E12', inception: '2005-01-21' },
  { symbol: 'CASH', name: 'Cash Yield', type: '现金', color: '#64748B', inception: '1990-01-01' }
];

export const fallbackSymbols = ['SPY', 'TLT', 'SGOV', 'GLD'];
export const strategyColors = ['#2457C5', '#96392F', '#16724A', '#A05E12', '#56667A'];

export const rangePresets = [
  { label: '1Y', years: 1 },
  { label: '3Y', years: 3 },
  { label: '5Y', years: 5 },
  { label: '10Y', years: 10 },
  { label: '全部', start: '2000-01-03', end: '2025-12-31' }
];

export const defaultPortfolio = [
  { id: 'holding-asts', symbol: 'ASTS', name: 'AST SpaceMobile', shares: 120, cost: 24.8, thesis: '直连手机卫星网络进展，盯商业化节点与融资节奏。', risk: '发射延迟、监管、摊薄。' },
  { id: 'holding-sats', symbol: 'SATS', name: 'EchoStar', shares: 80, cost: 28.2, thesis: '频谱资产重估与债务处理。', risk: '现金流压力、监管不确定。' },
  { id: 'holding-qqq', symbol: 'QQQ', name: 'Nasdaq 100 ETF', shares: 35, cost: 455, thesis: '核心科技 Beta。', risk: '估值回撤。' }
];

export const portfolioStorageKey = 'portfolio-backtest:holdings:v1';
export const ibkrAccountStorageKey = 'portfolio-backtest:ibkr-account:v1';
export const thesisChecksStorageKey = 'portfolio-backtest:thesis-checks:v1';

export const sectorByTicker = {
  AAPL: '科技', AMD: '科技', AVGO: '科技', CRWD: '科技', DELL: '科技',
  GOOGL: '通信', GOOG: '通信', META: '通信', NOK: '通信',
  MSFT: '科技', NVDA: '科技', NOW: '科技', SMCI: '科技', TSEM: '科技',
  MSTR: '科技', LITE: '科技',
  AMZN: '消费/零售', COST: '消费/零售', TSLA: '消费/汽车',
  NFLX: '通信', PLTR: '科技', ASTS: '通信', SATS: '通信',
  VRT: '工业',
  QQQ: 'ETF', SPY: 'ETF', VOO: 'ETF', VTI: 'ETF', VT: 'ETF',
  VUG: 'ETF', VTV: 'ETF', VGT: 'ETF', VNQ: 'ETF', VXUS: 'ETF',
  TQQQ: 'ETF',
  TLT: '债券', BND: '债券', AGG: '债券', SHY: '债券', IEF: '债券',
  SGOV: '债券', BOXX: '债券',
  GLD: '黄金', IAU: '黄金',
  CASH: '现金',
};

export const companyNameByTicker = {
  ...Object.fromEntries(assets.map((asset) => [asset.symbol, asset.name])),
  AAPL: 'Apple',
  AMD: 'Advanced Micro Devices',
  AMZN: 'Amazon',
  ASTS: 'AST SpaceMobile',
  AVGO: 'Broadcom',
  COST: 'Costco',
  CRWD: 'CrowdStrike',
  GOOGL: 'Alphabet',
  GOOG: 'Alphabet',
  META: 'Meta Platforms',
  MSFT: 'Microsoft',
  NFLX: 'Netflix',
  NVDA: 'NVIDIA',
  PLTR: 'Palantir',
  SATS: 'EchoStar',
  SMCI: 'Super Micro Computer',
  TSLA: 'Tesla'
};

export function normalizeTicker(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 12);
}

export function localCompanyName(symbol) {
  const ticker = normalizeTicker(symbol);
  return companyNameByTicker[ticker] || ticker;
}

export function tickerMatches(query) {
  const text = query.trim().toUpperCase();
  const matched = assets.filter((asset) => {
    if (!text) return true;
    return asset.symbol.includes(text) || asset.name.toUpperCase().includes(text) || asset.type.includes(query.trim());
  });
  return matched
    .sort((a, b) => {
      const aStarts = a.symbol.startsWith(text) ? 0 : 1;
      const bStarts = b.symbol.startsWith(text) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, 6);
}

export function secFilingsUrl(symbol) {
  const query = encodeURIComponent(symbol.trim().toUpperCase());
  return `https://www.sec.gov/edgar/search/#/q=${query}&category=custom&forms=10-K%252C10-Q%252C8-K`;
}

export function secCompanyUrl(symbol) {
  const query = encodeURIComponent(symbol.trim().toUpperCase());
  return `https://www.sec.gov/edgar/search/#/entityName=${query}`;
}
