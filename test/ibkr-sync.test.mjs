import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  initIbkrTables,
  normalizeIbkrPosition,
  storeIbkrSync
} from '../src/ibkrSync.mjs';

// In-memory Postgres with the same adapter shape as server/db.mjs.
async function memoryDb() {
  const lite = new PGlite();
  const query = (text, params = []) => lite.query(text, params);
  return {
    query,
    exec: (text) => lite.exec(text),
    tx: async (fn) => {
      await query('BEGIN');
      try {
        const result = await fn(query);
        await query('COMMIT');
        return result;
      } catch (error) {
        await query('ROLLBACK');
        throw error;
      }
    }
  };
}

test('normalizes equity and ETF positions into the local holding shape', () => {
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

test('normalizes option positions onto the underlying ticker', () => {
  const option = normalizeIbkrPosition({
    conid: '728283',
    undSym: 'AAPL',
    undComp: 'Apple Inc',
    assetClass: 'OPT',
    putOrCall: 'C',
    strike: 200,
    expiry: '20260116',
    multiplier: '100',
    currency: 'USD',
    position: 2,
    mktPrice: 12.5,
    mktValue: 2500,
    avgCost: 9.1,
    unrealizedPnl: 680,
    contractDesc: "AAPL JAN 16 '26 200 CALL"
  });

  assert.equal(option.secType, 'OPT');
  assert.equal(option.symbol, 'AAPL');
  assert.equal(option.underlying, 'AAPL');
  assert.equal(option.right, 'C');
  assert.equal(option.strike, 200);
  assert.equal(option.expiry, '2026-01-16');
  assert.equal(option.quantity, 2);
  assert.equal(option.marketValue, 2500);
  assert.equal(option.optionLabel, "AAPL 200C JAN'26");
});

test('derives option market value from price × multiplier when missing', () => {
  const option = normalizeIbkrPosition({
    conid: '999',
    ticker: 'TSLA',
    secType: 'OPT',
    right: 'P',
    strike: 250,
    lastTradingDay: '20260320',
    position: -1,
    marketPrice: 4,
    multiplier: 100
  });

  assert.equal(option.symbol, 'TSLA');
  assert.equal(option.right, 'P');
  assert.equal(option.quantity, -1);
  assert.equal(option.marketValue, -400);
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

test('stores IBKR sync snapshots and marks missing old positions closed', async () => {
  const db = await memoryDb();
  await initIbkrTables(db);

  await storeIbkrSync(db, {
    account: { accountId: 'DU123', accountTitle: 'Paper Account' },
    positions: [
      { conid: '265598', symbol: 'AAPL', name: 'Apple Inc', secType: 'STK', currency: 'USD', quantity: 10, avgCost: 180, marketPrice: 205, marketValue: 2050, unrealizedPnl: 250, realizedPnl: 0 },
      { conid: '76792991', symbol: 'QQQ', name: 'Invesco QQQ', secType: 'ETF', currency: 'USD', quantity: 2, avgCost: 480, marketPrice: 500, marketValue: 1000, unrealizedPnl: 40, realizedPnl: 0 }
    ],
    balances: [{ currency: 'USD', cashBalance: 1000, netLiquidation: 4050 }],
    syncedAt: '2026-06-09T01:00:00.000Z'
  });

  await storeIbkrSync(db, {
    account: { accountId: 'DU123', accountTitle: 'Paper Account' },
    positions: [
      { conid: '265598', symbol: 'AAPL', name: 'Apple Inc', secType: 'STK', currency: 'USD', quantity: 12, avgCost: 181, marketPrice: 206, marketValue: 2472, unrealizedPnl: 300, realizedPnl: 0 }
    ],
    balances: [{ currency: 'USD', cashBalance: 1200, netLiquidation: 3672 }],
    syncedAt: '2026-06-09T02:00:00.000Z'
  });

  const active = (await db.query('SELECT symbol, quantity, market_value, closed_at FROM ibkr_positions WHERE account_id = $1 AND closed_at IS NULL ORDER BY symbol', ['DU123'])).rows;
  const closed = (await db.query('SELECT symbol, closed_at FROM ibkr_positions WHERE account_id = $1 AND closed_at IS NOT NULL', ['DU123'])).rows;
  const runs = (await db.query('SELECT COUNT(*)::int AS count FROM ibkr_sync_runs')).rows[0];

  assert.deepEqual(active, [{ symbol: 'AAPL', quantity: 12, market_value: 2472, closed_at: null }]);
  assert.deepEqual(closed, [{ symbol: 'QQQ', closed_at: '2026-06-09T02:00:00.000Z' }]);
  assert.equal(runs.count, 2);
});
