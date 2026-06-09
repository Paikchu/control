import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  initIbkrTables,
  normalizeIbkrPosition,
  storeIbkrSync
} from '../src/ibkrSync.mjs';

test('normalizes only equity and ETF positions into the local holding shape', () => {
  const stock = normalizeIbkrPosition({
    conid: 265598,
    contractDesc: 'AAPL',
    name: 'Apple Inc',
    assetClass: 'STK',
    currency: 'USD',
    position: 10,
    avgCost: 180.25,
    mktPrice: 205.5,
    mktValue: 2055,
    unrealizedPnl: 252.5,
    realizedPnl: 12
  });
  const option = normalizeIbkrPosition({ conid: 1, contractDesc: 'AAPL 2026C200', assetClass: 'OPT', position: 1 });

  assert.equal(option, null);
  assert.deepEqual(stock, {
    conid: '265598',
    symbol: 'AAPL',
    name: 'Apple Inc',
    secType: 'STK',
    currency: 'USD',
    quantity: 10,
    avgCost: 180.25,
    marketPrice: 205.5,
    marketValue: 2055,
    unrealizedPnl: 252.5,
    realizedPnl: 12
  });
});

test('normalizes portfolio2 position rows', () => {
  const position = normalizeIbkrPosition({
    conid: '9408',
    description: 'MCD',
    secType: 'STK',
    currency: 'USD',
    position: 12,
    marketPrice: 258.83,
    marketValue: 3105.96,
    avgPrice: 266.21,
    unrealizedPnl: 88.55
  });

  assert.deepEqual(position, {
    conid: '9408',
    symbol: 'MCD',
    name: 'MCD',
    secType: 'STK',
    currency: 'USD',
    quantity: 12,
    avgCost: 266.21,
    marketPrice: 258.83,
    marketValue: 3105.96,
    unrealizedPnl: 88.55,
    realizedPnl: null
  });
});

test('stores IBKR sync snapshots and marks missing old positions closed', () => {
  const db = new DatabaseSync(':memory:');
  initIbkrTables(db);

  storeIbkrSync(db, {
    account: { accountId: 'DU123', accountTitle: 'Paper Account' },
    positions: [
      { conid: '265598', symbol: 'AAPL', name: 'Apple Inc', secType: 'STK', currency: 'USD', quantity: 10, avgCost: 180, marketPrice: 205, marketValue: 2050, unrealizedPnl: 250, realizedPnl: 0 },
      { conid: '76792991', symbol: 'QQQ', name: 'Invesco QQQ', secType: 'ETF', currency: 'USD', quantity: 2, avgCost: 480, marketPrice: 500, marketValue: 1000, unrealizedPnl: 40, realizedPnl: 0 }
    ],
    balances: [{ currency: 'USD', cashBalance: 1000, netLiquidation: 4050 }],
    syncedAt: '2026-06-09T01:00:00.000Z'
  });

  storeIbkrSync(db, {
    account: { accountId: 'DU123', accountTitle: 'Paper Account' },
    positions: [
      { conid: '265598', symbol: 'AAPL', name: 'Apple Inc', secType: 'STK', currency: 'USD', quantity: 12, avgCost: 181, marketPrice: 206, marketValue: 2472, unrealizedPnl: 300, realizedPnl: 0 }
    ],
    balances: [{ currency: 'USD', cashBalance: 1200, netLiquidation: 3672 }],
    syncedAt: '2026-06-09T02:00:00.000Z'
  });

  const active = db.prepare('SELECT symbol, quantity, market_value, closed_at FROM ibkr_positions WHERE account_id = ? AND closed_at IS NULL ORDER BY symbol').all('DU123').map((row) => ({ ...row }));
  const closed = db.prepare('SELECT symbol, closed_at FROM ibkr_positions WHERE account_id = ? AND closed_at IS NOT NULL').all('DU123').map((row) => ({ ...row }));
  const runs = db.prepare('SELECT COUNT(*) AS count FROM ibkr_sync_runs').get();

  assert.deepEqual(active, [{ symbol: 'AAPL', quantity: 12, market_value: 2472, closed_at: null }]);
  assert.deepEqual(closed, [{ symbol: 'QQQ', closed_at: '2026-06-09T02:00:00.000Z' }]);
  assert.equal(runs.count, 2);
});
