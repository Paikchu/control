import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  putCallRatios,
  netGamma,
  aggregateByStrike,
  putCallWalls,
  gammaFlip,
  computeOptionMetrics,
  compactMetricsForModel
} from '../src/optionsAnalytics.mjs';

// 构造一条小期权链：现价 100。
// call 在 105 OI 大，put 在 95 OI 大 → 墙位明确。
const chain = [
  { strike: 95, right: 'P', openInterest: 8000, volume: 1200, gamma: 0.02 },
  { strike: 95, right: 'C', openInterest: 500, volume: 100, gamma: 0.02 },
  { strike: 100, right: 'C', openInterest: 3000, volume: 900, gamma: 0.05 },
  { strike: 100, right: 'P', openInterest: 3000, volume: 800, gamma: 0.05 },
  { strike: 105, right: 'C', openInterest: 9000, volume: 1500, gamma: 0.018 },
  { strike: 105, right: 'P', openInterest: 400, volume: 90, gamma: 0.018 }
];

test('putCallRatios computes volume and OI ratios', () => {
  const r = putCallRatios(chain);
  // put vol = 1200+800+90 = 2090; call vol = 100+900+1500 = 2500
  assert.equal(r.putVolume, 2090);
  assert.equal(r.callVolume, 2500);
  assert.ok(Math.abs(r.pcrVolume - 2090 / 2500) < 1e-9);
  // put OI = 8000+3000+400 = 11400; call OI = 500+3000+9000 = 12500
  assert.ok(Math.abs(r.pcrOI - 11400 / 12500) < 1e-9);
});

test('putCallRatios returns null ratio when denominator is zero', () => {
  const r = putCallRatios([{ strike: 100, right: 'P', openInterest: 10, volume: 5, gamma: 0.01 }]);
  assert.equal(r.pcrVolume, null);
  assert.equal(r.pcrOI, null);
});

test('aggregateByStrike sums per strike and is sorted', () => {
  const rows = aggregateByStrike(chain, 100);
  assert.deepEqual(rows.map((r) => r.strike), [95, 100, 105]);
  const at95 = rows.find((r) => r.strike === 95);
  assert.equal(at95.putOI, 8000);
  assert.equal(at95.callOI, 500);
});

test('netGamma signs calls positive and puts negative', () => {
  // 单 call 应为正，单 put 应为负，大小相同（gamma/OI 相同）。
  const oneCall = netGamma([{ strike: 100, right: 'C', openInterest: 1000, gamma: 0.05 }], 100);
  const onePut = netGamma([{ strike: 100, right: 'P', openInterest: 1000, gamma: 0.05 }], 100);
  assert.ok(oneCall > 0);
  assert.ok(onePut < 0);
  assert.ok(Math.abs(oneCall + onePut) < 1e-6);
  // 数值：0.05 * 1000 * 100 * 100^2 * 0.01 = 500000
  assert.ok(Math.abs(oneCall - 500000) < 1e-6);
});

test('putCallWalls picks highest-OI call and put strikes', () => {
  const rows = aggregateByStrike(chain, 100);
  const walls = putCallWalls(rows);
  assert.equal(walls.callWall, 105);
  assert.equal(walls.putWall, 95);
  assert.equal(walls.callWallOI, 9000);
  assert.equal(walls.putWallOI, 8000);
});

test('gammaFlip finds the strike where cumulative GEX crosses zero', () => {
  // 低位 put 主导(负 GEX)，高位 call 主导(正 GEX) → 中间翻转。
  const rows = aggregateByStrike(chain, 100);
  const flip = gammaFlip(rows);
  assert.ok(flip !== null);
  assert.ok(flip > 95 && flip < 105);
});

test('gammaFlip returns null when GEX never crosses zero', () => {
  const allCalls = aggregateByStrike(
    [
      { strike: 100, right: 'C', openInterest: 1000, gamma: 0.05 },
      { strike: 105, right: 'C', openInterest: 1000, gamma: 0.04 }
    ],
    100
  );
  assert.equal(gammaFlip(allCalls), null);
});

test('computeOptionMetrics assembles a full bundle with a bias', () => {
  const m = computeOptionMetrics({ symbol: 'SPY', spot: 100, contracts: chain, asOf: '2026-06-13T20:00:00Z' });
  assert.equal(m.symbol, 'SPY');
  assert.equal(m.contractCount, 6);
  assert.equal(m.callWall, 105);
  assert.equal(m.putWall, 95);
  assert.ok(['bullish', 'neutral', 'bearish'].includes(m.bias));
});

test('compactMetricsForModel trims byStrike to a window around spot', () => {
  const many = [];
  for (let strike = 50; strike <= 150; strike += 1) {
    many.push({ strike, right: 'C', openInterest: 100, volume: 10, gamma: 0.01 });
    many.push({ strike, right: 'P', openInterest: 100, volume: 10, gamma: 0.01 });
  }
  const m = computeOptionMetrics({ symbol: 'QQQ', spot: 100, contracts: many, asOf: 'x' });
  const compact = compactMetricsForModel(m, { strikeWindow: 5 });
  assert.ok(compact.nearStrikes.length <= 11);
  // 窗口应围绕现价 100。
  assert.ok(compact.nearStrikes.some((r) => r.strike === 100));
  assert.ok(!compact.nearStrikes.some((r) => r.strike === 50));
});
