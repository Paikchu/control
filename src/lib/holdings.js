import { normalizeEntryPlan, normalizeHoldingItems } from '../holdingNotes.mjs';
import { ibkrAccountStorageKey, localCompanyName, normalizeTicker, portfolioStorageKey } from './catalog.js';

export function normalizeStoredHolding(holding, index) {
  const symbol = normalizeTicker(String(holding?.symbol || ''));
  if (!symbol) return null;
  return {
    id: String(holding?.id || `holding-${symbol.toLowerCase()}-${index}`),
    symbol,
    name: String(holding?.name || localCompanyName(symbol)),
    shares: holding?.shares ?? 0,
    cost: holding?.cost ?? 0,
    conid: holding?.conid ? String(holding.conid) : '',
    source: String(holding?.source || 'manual'),
    thesis: String(holding?.thesis || ''),
    risk: String(holding?.risk || ''),
    thesisItems: normalizeHoldingItems(holding?.thesisItems, holding?.thesis, 'thesis'),
    riskItems: normalizeHoldingItems(holding?.riskItems, holding?.risk, 'risk'),
    entryPlan: normalizeEntryPlan(holding?.entryPlan)
  };
}

export function readStoredPortfolio() {
  if (typeof window === 'undefined') return [];
  try {
    const saved = window.localStorage.getItem(portfolioStorageKey);
    if (saved === null) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStoredHolding).filter(Boolean);
  } catch {
    return [];
  }
}

export function readStoredIbkrAccountId() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(ibkrAccountStorageKey) || '';
  } catch {
    return '';
  }
}

export function localNoteForIbkrPosition(position, notes) {
  const byConid = notes.find((holding) => holding.conid && String(holding.conid) === String(position.conid));
  if (byConid) return byConid;
  return notes.find((holding) => normalizeTicker(String(holding.symbol || '')) === normalizeTicker(position.symbol)) || null;
}

export function ibkrHoldingFromPosition(position, notes) {
  const local = localNoteForIbkrPosition(position, notes);
  return {
    id: `ibkr-${position.conid || position.symbol}`,
    source: 'ibkr',
    conid: position.conid,
    symbol: normalizeTicker(position.symbol),
    name: local?.name || position.name || localCompanyName(position.symbol),
    shares: position.quantity ?? 0,
    cost: position.avgCost ?? 0,
    marketPrice: position.marketPrice,
    marketValue: position.marketValue,
    unrealizedPnl: position.unrealizedPnl,
    realizedPnl: position.realizedPnl,
    currency: position.currency || 'USD',
    secType: position.secType || 'STK',
    fetchedAt: position.fetchedAt,
    options: [],
    optionsMarketValue: 0,
    optionsUnrealizedPnl: 0,
    thesis: local?.thesis || '',
    risk: local?.risk || '',
    thesisItems: normalizeHoldingItems(local?.thesisItems, local?.thesis, 'thesis'),
    riskItems: normalizeHoldingItems(local?.riskItems, local?.risk, 'risk'),
    entryPlan: normalizeEntryPlan(local?.entryPlan)
  };
}

// Shape an option position into a compact leg the holdings table can render.
export function ibkrOptionLeg(position) {
  const quantity = Number(position.quantity) || 0;
  return {
    id: `ibkr-opt-${position.conid || position.optionLabel}`,
    conid: position.conid,
    label: position.optionLabel || `${normalizeTicker(position.symbol)} ${position.right || ''}`.trim(),
    right: position.right || '',
    strike: position.strike ?? null,
    expiry: position.expiry || '',
    quantity,
    side: quantity < 0 ? 'short' : 'long',
    multiplier: position.multiplier || 100,
    marketPrice: position.marketPrice,
    marketValue: position.marketValue,
    avgCost: position.avgCost,
    unrealizedPnl: position.unrealizedPnl
  };
}

// A ticker with options but no share position still needs a host row.
function ibkrOptionOnlyHolding(position, notes) {
  const host = ibkrHoldingFromPosition(position, notes);
  return {
    ...host,
    id: `ibkr-${normalizeTicker(position.symbol)}`,
    conid: '',
    shares: 0,
    cost: 0,
    marketPrice: null,
    marketValue: 0,
    unrealizedPnl: null,
    realizedPnl: null,
    secType: 'STK',
    optionsOnly: true
  };
}

// Fold option legs into the matching underlying share row, keyed by ticker.
// Tickers held only as options get a synthesized shell row so they still show.
export function mergeIbkrPortfolio(snapshot, localPortfolio) {
  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  const holdings = [];
  const bySymbol = new Map();

  for (const position of positions) {
    if (position.secType === 'OPT') continue;
    const holding = ibkrHoldingFromPosition(position, localPortfolio);
    if (!holding.symbol) continue;
    holdings.push(holding);
    if (!bySymbol.has(holding.symbol)) bySymbol.set(holding.symbol, holding);
  }

  for (const position of positions) {
    if (position.secType !== 'OPT') continue;
    const symbol = normalizeTicker(position.symbol);
    if (!symbol) continue;
    let host = bySymbol.get(symbol);
    if (!host) {
      host = ibkrOptionOnlyHolding(position, localPortfolio);
      bySymbol.set(symbol, host);
      holdings.push(host);
    }
    const leg = ibkrOptionLeg(position);
    host.options.push(leg);
    host.optionsMarketValue += Number(leg.marketValue) || 0;
    host.optionsUnrealizedPnl += Number(leg.unrealizedPnl) || 0;
  }

  for (const holding of holdings) {
    holding.options.sort((a, b) => {
      if (a.expiry !== b.expiry) return a.expiry < b.expiry ? -1 : 1;
      return (a.strike ?? 0) - (b.strike ?? 0);
    });
  }

  return holdings;
}

export function ibkrStatusMessage(message) {
  if (message === 'IBKR login failed or API access denied') return 'IBKR 登录已提交，但 API 会话被拒绝。请在 Gateway 登录页确认显示 Client login succeeds，并检查是否选错 Live/Paper。';
  if (message === 'IBKR login required') return '需要登录 IBKR。';
  return message || '';
}
