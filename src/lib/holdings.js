import { normalizeEntryPlan, normalizeHoldingItems } from '../holdingNotes.mjs';
import { defaultPortfolio, ibkrAccountStorageKey, localCompanyName, normalizeTicker, portfolioStorageKey } from './catalog.js';

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
  if (typeof window === 'undefined') return defaultPortfolio.map(normalizeStoredHolding).filter(Boolean);
  try {
    const saved = window.localStorage.getItem(portfolioStorageKey);
    if (saved === null) return defaultPortfolio.map(normalizeStoredHolding).filter(Boolean);
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return defaultPortfolio.map(normalizeStoredHolding).filter(Boolean);
    return parsed.map(normalizeStoredHolding).filter(Boolean);
  } catch (error) {
    return defaultPortfolio.map(normalizeStoredHolding).filter(Boolean);
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
    thesis: local?.thesis || '',
    risk: local?.risk || '',
    thesisItems: normalizeHoldingItems(local?.thesisItems, local?.thesis, 'thesis'),
    riskItems: normalizeHoldingItems(local?.riskItems, local?.risk, 'risk'),
    entryPlan: normalizeEntryPlan(local?.entryPlan)
  };
}

export function mergeIbkrPortfolio(snapshot, localPortfolio) {
  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  return positions.map((position) => ibkrHoldingFromPosition(position, localPortfolio)).filter((holding) => holding.symbol);
}

export function ibkrStatusMessage(message) {
  if (message === 'IBKR login failed or API access denied') return 'IBKR 登录已提交，但 API 会话被拒绝。请在 Gateway 登录页确认显示 Client login succeeds，并检查是否选错 Live/Paper。';
  if (message === 'IBKR login required') return '需要登录 IBKR。';
  return message || '';
}
