import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFallbackValuationInsights,
  buildValuationReport,
  deterministicDcf
} from '../src/valuationReport.mjs';
import { normalizeValuationPayload } from '../server/services/yahoo.mjs';

const sampleValuation = {
  ticker: 'TEST',
  companyName: 'Test Corp',
  currentPrice: 100,
  currency: 'USD',
  marketCap: 1_000_000_000,
  sharesOutstanding: 10_000_000,
  multiples: { trailingPE: 25, forwardPE: 20, priceToSales: 5, priceToBook: 8, enterpriseToEbitda: 15, enterpriseToRevenue: 4, pegRatio: 1.5 },
  financials: {
    totalRevenue: 500_000_000,
    revenueGrowth: 0.1,
    grossMargins: 0.6,
    ebitdaMargins: 0.3,
    profitMargins: 0.2,
    returnOnEquity: 0.25,
    totalCash: 200_000_000,
    totalDebt: 50_000_000,
    freeCashflow: 100_000_000,
    operatingCashflow: 120_000_000,
    ebitda: 150_000_000
  },
  analyst: { targetMeanPrice: 110, targetLowPrice: 90, targetHighPrice: 130, recommendationKey: 'buy', numberOfAnalystOpinions: 20 },
  fiftyTwoWeek: { low: 70, high: 120 },
  beta: 1.2
};

test('deterministicDcf computes a positive fair value for sane assumptions', () => {
  const fairValue = deterministicDcf(
    { revenueGrowth: 0.1, fcfMargin: 0.2, discountRate: 0.09, terminalGrowth: 0.025 },
    { totalRevenue: 500_000_000, netCash: 150_000_000, sharesOutstanding: 10_000_000 }
  );
  assert.ok(Number.isFinite(fairValue));
  assert.ok(fairValue > 0);
});

test('deterministicDcf returns null when discount rate does not exceed terminal growth', () => {
  const fairValue = deterministicDcf(
    { revenueGrowth: 0.1, fcfMargin: 0.2, discountRate: 0.02, terminalGrowth: 0.025 },
    { totalRevenue: 500_000_000, netCash: 0, sharesOutstanding: 10_000_000 }
  );
  assert.equal(fairValue, null);
});

test('deterministicDcf returns null on missing/invalid inputs', () => {
  assert.equal(deterministicDcf({}, {}), null);
  assert.equal(deterministicDcf(
    { revenueGrowth: 0.1, fcfMargin: 0.2, discountRate: 0.09, terminalGrowth: 0.025 },
    { totalRevenue: 500_000_000, netCash: 0, sharesOutstanding: 0 }
  ), null);
});

test('higher revenue growth assumption yields a higher fair value, all else equal', () => {
  const inputs = { totalRevenue: 500_000_000, netCash: 100_000_000, sharesOutstanding: 10_000_000 };
  const low = deterministicDcf({ revenueGrowth: 0.05, fcfMargin: 0.2, discountRate: 0.09, terminalGrowth: 0.02 }, inputs);
  const high = deterministicDcf({ revenueGrowth: 0.15, fcfMargin: 0.2, discountRate: 0.09, terminalGrowth: 0.02 }, inputs);
  assert.ok(high > low);
});

test('buildFallbackValuationInsights derives heuristic scenarios from hard data without calling AI', () => {
  const insights = buildFallbackValuationInsights(sampleValuation);
  assert.equal(insights.source, 'fallback');
  assert.equal(insights.scenarios.length, 3);
  assert.ok(insights.scenarios.every((s) => Number.isFinite(s.revenueGrowth) && Number.isFinite(s.discountRate)));
  const bear = insights.scenarios.find((s) => s.case === 'bear');
  const bull = insights.scenarios.find((s) => s.case === 'bull');
  assert.ok(bull.revenueGrowth > bear.revenueGrowth);
  assert.ok(bull.discountRate < bear.discountRate);
});

test('buildValuationReport recomputes fair value deterministically and ignores AI-provided numbers', () => {
  const aiInsights = {
    source: 'deepseek',
    confidence: 0.7,
    scenarios: [
      { case: 'bear', revenueGrowth: 0.05, fcfMargin: 0.18, discountRate: 0.11, terminalGrowth: 0.02 },
      { case: 'base', revenueGrowth: 0.1, fcfMargin: 0.22, discountRate: 0.09, terminalGrowth: 0.025 },
      { case: 'bull', revenueGrowth: 0.16, fcfMargin: 0.27, discountRate: 0.08, terminalGrowth: 0.03 }
    ],
    verdict: '低估',
    keyDrivers: [{ label: '收入增长', detail: '同比增长 10%，高于历史均值' }],
    risks: [{ severity: 'medium', detail: 'PEG 1.5 略高于行业中位数' }],
    reasoning: '基于给定的营收增速和自由现金流利润率推算。'
  };

  const report = buildValuationReport({ ticker: 'test', companyName: 'Test Corp', valuation: sampleValuation, aiInsights });

  assert.equal(report.ticker, 'TEST');
  assert.equal(report.verdict, '低估');
  assert.equal(report.scenarios.length, 3);
  report.scenarios.forEach((scenario) => {
    assert.ok(Number.isFinite(scenario.fairValuePerShare));
    assert.ok(Number.isFinite(scenario.upsidePercent));
  });
  assert.ok(report.fairValueRange.low < report.fairValueRange.mid);
  assert.ok(report.fairValueRange.mid < report.fairValueRange.high);
  assert.match(report.disclaimer, /未采用 AI 直接给出的数字/);
});

test('buildValuationReport derives a verdict heuristically when AI omits one', () => {
  const aiInsights = {
    source: 'deepseek',
    scenarios: [
      { case: 'bear', revenueGrowth: 0.02, fcfMargin: 0.1, discountRate: 0.12, terminalGrowth: 0.02 },
      { case: 'base', revenueGrowth: 0.03, fcfMargin: 0.12, discountRate: 0.11, terminalGrowth: 0.02 },
      { case: 'bull', revenueGrowth: 0.04, fcfMargin: 0.14, discountRate: 0.1, terminalGrowth: 0.02 }
    ],
    keyDrivers: [],
    risks: []
  };
  const report = buildValuationReport({ ticker: 'TEST', valuation: { ...sampleValuation, currentPrice: 500 }, aiInsights });
  assert.equal(report.verdict, '高估');
});

test('buildValuationReport falls back to heuristic insights when no AI insights are supplied', () => {
  const report = buildValuationReport({ ticker: 'TEST', valuation: sampleValuation, aiInsights: null });
  assert.equal(report.source, 'fallback');
  assert.equal(report.scenarios.length, 3);
});

test('normalizeValuationPayload extracts flat metrics from Yahoo quoteSummary shape', () => {
  const raw = {
    quoteSummary: {
      result: [{
        price: { regularMarketPrice: { raw: 398.89 }, marketCap: { raw: 2_900_000_000_000 }, currency: 'USD', longName: 'Microsoft Corp' },
        summaryDetail: { trailingPE: { raw: 35.2 }, forwardPE: { raw: 30.1 }, priceToSalesTrailing12Months: { raw: 12.5 }, fiftyTwoWeekLow: { raw: 300 }, fiftyTwoWeekHigh: { raw: 420 } },
        defaultKeyStatistics: { priceToBook: { raw: 11.2 }, enterpriseToEbitda: { raw: 22.1 }, pegRatio: { raw: 2.1 }, sharesOutstanding: { raw: 7_400_000_000 }, beta: { raw: 0.9 } },
        financialData: { totalRevenue: { raw: 280_000_000_000 }, revenueGrowth: { raw: 0.18 }, freeCashflow: { raw: 70_000_000_000 }, targetMeanPrice: { raw: 420 }, targetLowPrice: { raw: 350 }, targetHighPrice: { raw: 500 }, recommendationKey: 'buy' }
      }]
    }
  };

  const result = normalizeValuationPayload('MSFT', raw);
  assert.equal(result.ticker, 'MSFT');
  assert.equal(result.companyName, 'Microsoft Corp');
  assert.equal(result.currentPrice, 398.89);
  assert.equal(result.multiples.trailingPE, 35.2);
  assert.equal(result.financials.revenueGrowth, 0.18);
  assert.equal(result.analyst.targetMeanPrice, 420);
  assert.equal(result.sharesOutstanding, 7_400_000_000);
});

test('normalizeValuationPayload throws when no usable price/marketCap data is present', () => {
  assert.throws(() => normalizeValuationPayload('XXXX', { quoteSummary: { result: [{}] } }));
});

test('normalizeValuationPayload falls back to v7 quote fields when quoteSummary is unavailable', () => {
  const v7 = { quoteResponse: { result: [{ regularMarketPrice: 50, marketCap: 5_000_000_000, currency: 'USD', trailingPE: 18, sharesOutstanding: 100_000_000, longName: 'Fallback Co' }] } };
  const result = normalizeValuationPayload('FBCO', null, v7);
  assert.equal(result.currentPrice, 50);
  assert.equal(result.multiples.trailingPE, 18);
  assert.equal(result.companyName, 'Fallback Co');
});
