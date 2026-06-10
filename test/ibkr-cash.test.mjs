import assert from 'node:assert/strict';
import test from 'node:test';
import { holdingWeightPercent, summarizeIbkrCash } from '../src/ibkrCash.mjs';

test('uses the BASE ledger row without double-counting currency balances', () => {
  const summary = summarizeIbkrCash({
    balances: [
      { currency: 'BASE', cashBalance: 3475.88, netLiquidation: 46712.03 },
      { currency: 'CNH', cashBalance: 10000, netLiquidation: 10000 },
      { currency: 'USD', cashBalance: 1999.51, netLiquidation: 45235.65 }
    ]
  });

  assert.equal(summary.cashBalance, 3475.88);
  assert.equal(summary.netLiquidation, 46712.03);
  assert.deepEqual(summary.currencyBalances.map(({ currency, cashBalance }) => ({ currency, cashBalance })), [
    { currency: 'CNH', cashBalance: 10000 },
    { currency: 'USD', cashBalance: 1999.51 }
  ]);
});

test('does not add balances from different currencies when BASE is missing', () => {
  const summary = summarizeIbkrCash({
    balances: [
      { currency: 'CNH', cashBalance: 10000 },
      { currency: 'USD', cashBalance: 1999.51 }
    ]
  });

  assert.equal(summary.cashBalance, null);
  assert.equal(summary.netLiquidation, null);
});

test('calculates a holding weight against total account value', () => {
  assert.equal(holdingWeightPercent(12199.9658203125, 46712.03).toFixed(2), '26.12');
  assert.equal(holdingWeightPercent(0, 46712.03), 0);
  assert.equal(holdingWeightPercent(1000, 0), null);
});
