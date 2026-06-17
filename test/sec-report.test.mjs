import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSecAnalysisReport,
  buildFallbackAiInsights,
  extractInlineFinancialMetrics,
  extractFinancialMetrics,
  extractFinancialMetricsFromYahoo,
  mergeReportRevision,
  normalizeFilingSummary,
  selectRenderableAiInsights,
  splitFilingSections
} from '../src/secReport.mjs';
import { normalizeIncomeStatementPayload } from '../server/services/yahoo.mjs';

const filings = [
  {
    form: '10-Q',
    filingDate: '2026-05-08',
    reportDate: '2026-03-31',
    accessionNumber: '0000000000-26-000010',
    documentUrl: 'https://www.sec.gov/a.htm'
  },
  {
    form: '8-K',
    filingDate: '2026-05-07',
    reportDate: '2026-05-07',
    accessionNumber: '0000000000-26-000009',
    documentUrl: 'https://www.sec.gov/b.htm'
  }
];

const companyFacts = {
  facts: {
    'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            { fy: 2025, fp: 'Q1', form: '10-Q', end: '2025-03-31', filed: '2025-05-06', val: 100, accn: 'a1' },
            { fy: 2026, fp: 'Q1', form: '10-Q', end: '2026-03-31', filed: '2026-05-08', val: 125, accn: 'a2' }
          ]
        }
      },
      GrossProfit: {
        units: {
          USD: [
            { fy: 2025, fp: 'Q1', form: '10-Q', end: '2025-03-31', filed: '2025-05-06', val: 44, accn: 'a1' },
            { fy: 2026, fp: 'Q1', form: '10-Q', end: '2026-03-31', filed: '2026-05-08', val: 50, accn: 'a2' }
          ]
        }
      },
      OperatingIncomeLoss: {
        units: {
          USD: [
            { fy: 2025, fp: 'Q1', form: '10-Q', end: '2025-03-31', filed: '2025-05-06', val: 8, accn: 'a1' },
            { fy: 2026, fp: 'Q1', form: '10-Q', end: '2026-03-31', filed: '2026-05-08', val: 14, accn: 'a2' }
          ]
        }
      },
      NetIncomeLoss: {
        units: {
          USD: [
            { fy: 2025, fp: 'Q1', form: '10-Q', end: '2025-03-31', filed: '2025-05-06', val: 5, accn: 'a1' },
            { fy: 2026, fp: 'Q1', form: '10-Q', end: '2026-03-31', filed: '2026-05-08', val: 10, accn: 'a2' }
          ]
        }
      }
    }
  }
};

test('extracts SEC financial metrics with margin and year-over-year calculations', () => {
  const metrics = extractFinancialMetrics(companyFacts, 8);

  assert.equal(metrics.length, 2);
  assert.equal(metrics[1].period, '2026 Q1');
  assert.equal(metrics[1].revenue, 125);
  assert.equal(metrics[1].grossMargin, 0.4);
  assert.equal(metrics[1].operatingMargin, 0.112);
  assert.equal(metrics[1].netMargin, 0.08);
  assert.equal(metrics[1].revenueYoY, 0.25);
  assert.equal(metrics[1].source.tag, 'RevenueFromContractWithCustomerExcludingAssessedTax');
});

test('keeps only the current comparative row for each fiscal quarter', () => {
  const comparativeFacts = {
    facts: {
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: {
            USD: [
              { fy: 2026, fp: 'Q1', form: '10-Q', end: '2024-09-30', filed: '2025-10-29', val: 65, accn: 'q126' },
              { fy: 2026, fp: 'Q1', form: '10-Q', end: '2025-09-30', filed: '2025-10-29', val: 78, accn: 'q126' }
            ]
          }
        }
      }
    }
  };

  const metrics = extractFinancialMetrics(comparativeFacts, 8);

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].period, '2026 Q1');
  assert.equal(metrics[0].end, '2025-09-30');
  assert.equal(metrics[0].revenue, 78);
});

test('uses the latest quarterly period instead of stale annual data for headline metrics', () => {
  const staleAnnualPlusCurrentQuarter = {
    facts: {
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: {
            USD: [
              { fy: 2024, fp: 'FY', form: '10-K', end: '2024-12-31', filed: '2025-03-01', val: 400, accn: 'fy24' },
              { fy: 2025, fp: 'Q1', form: '10-Q', end: '2025-03-31', filed: '2025-05-06', val: 100, accn: 'q125' },
              { fy: 2026, fp: 'Q1', form: '10-Q', end: '2026-03-31', filed: '2026-05-08', val: 150, accn: 'q126' }
            ]
          }
        },
        CostOfRevenue: {
          units: {
            USD: [
              { fy: 2025, fp: 'Q1', form: '10-Q', end: '2025-03-31', filed: '2025-05-06', val: 60, accn: 'q125' },
              { fy: 2026, fp: 'Q1', form: '10-Q', end: '2026-03-31', filed: '2026-05-08', val: 90, accn: 'q126' }
            ]
          }
        },
        NetIncomeLoss: {
          units: {
            USD: [
              { fy: 2025, fp: 'Q1', form: '10-Q', end: '2025-03-31', filed: '2025-05-06', val: -20, accn: 'q125' },
              { fy: 2026, fp: 'Q1', form: '10-Q', end: '2026-03-31', filed: '2026-05-08', val: -12, accn: 'q126' }
            ]
          }
        }
      }
    }
  };

  const report = buildSecAnalysisReport({
    ticker: 'ACME',
    companyName: 'Acme Corp',
    filings,
    companyFacts: staleAnnualPlusCurrentQuarter,
    previousReport: null
  });

  assert.equal(report.financials.latest.period, '2026 Q1');
  assert.equal(report.financials.latest.revenueYoY, 0.5);
  assert.equal(report.financials.latest.grossMargin, 0.4);
  assert.equal(report.financials.latest.netMargin, -0.08);
  assert.doesNotMatch(report.summary.join(' '), /2024 FY/);
  assert.match(report.agentMap.currentDataPriority.join(' '), /最新季度/);
});

test('extracts current-quarter metrics from latest filing inline XBRL when companyfacts is stale', () => {
  const html = `
    <xbrli:context id="current"><xbrli:entity><xbrli:identifier>0000000000</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period></xbrli:context>
    <xbrli:context id="currentCostA"><xbrli:entity><xbrli:identifier>0000000000</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="x">a</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period></xbrli:context>
    <xbrli:context id="currentCostB"><xbrli:entity><xbrli:identifier>0000000000</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="x">b</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period></xbrli:context>
    <xbrli:context id="currentCostC"><xbrli:entity><xbrli:identifier>0000000000</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="x">c</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period></xbrli:context>
    <xbrli:context id="prior"><xbrli:entity><xbrli:identifier>0000000000</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-03-31</xbrli:endDate></xbrli:period></xbrli:context>
    <ix:nonFraction contextRef="current" name="us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax" unitRef="U_USD" scale="3">14,735</ix:nonFraction>
    <ix:nonFraction contextRef="currentCostA" name="us-gaap:CostOfRevenue" unitRef="U_USD" scale="3">4,870</ix:nonFraction>
    <ix:nonFraction contextRef="currentCostB" name="us-gaap:CostOfRevenue" unitRef="U_USD" scale="3">11,063</ix:nonFraction>
    <ix:nonFraction contextRef="currentCostC" name="us-gaap:CostOfRevenue" unitRef="U_USD" scale="3">586</ix:nonFraction>
    <ix:nonFraction contextRef="current" name="us-gaap:NetIncomeLoss" unitRef="U_USD" scale="3" sign="-">191,012</ix:nonFraction>
    <ix:nonFraction contextRef="prior" name="us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax" unitRef="U_USD" scale="3">500</ix:nonFraction>
  `;

  const metrics = extractInlineFinancialMetrics(html, filings[0]);
  const report = buildSecAnalysisReport({
    ticker: 'ACME',
    companyName: 'Acme Corp',
    filings,
    companyFacts: { facts: { 'us-gaap': {} } },
    inlineMetrics: metrics,
    previousReport: null
  });

  assert.equal(report.financials.latest.period, '2026 Q1');
  assert.equal(report.financials.latest.revenue, 14735000);
  assert.equal(report.financials.latest.revenueYoY, 28.47);
  assert.equal(report.financials.latest.grossMargin, -0.1211);
  assert.equal(report.financials.latest.netMargin, -12.9631);
});

test('builds a user-facing report without milestone content', () => {
  const report = buildSecAnalysisReport({
    ticker: 'ACME',
    companyName: 'Acme Corp',
    filings,
    companyFacts,
    previousReport: null
  });

  assert.equal(report.ticker, 'ACME');
  assert.equal(report.latestFiling.accessionNumber, '0000000000-26-000010');
  assert.equal(report.financials.quarters.length, 2);
  assert.ok(report.charts.some((chart) => chart.id === 'revenue-yoy'));
  assert.equal(report.milestones, undefined);
  assert.match(report.summary[0], /2026 Q1/);
});

test('merges a new SEC update into the prior report without rewriting historical metrics', () => {
  const prior = buildSecAnalysisReport({
    ticker: 'ACME',
    companyName: 'Acme Corp',
    filings: filings.slice(1),
    companyFacts,
    previousReport: null
  });
  const next = buildSecAnalysisReport({
    ticker: 'ACME',
    companyName: 'Acme Corp',
    filings,
    companyFacts,
    previousReport: prior
  });

  const merged = mergeReportRevision(prior, next);

  assert.equal(merged.revision.revisedSections.includes('latestFiling'), true);
  assert.equal(merged.financials.quarters[0].period, prior.financials.quarters[0].period);
  assert.equal(merged.revision.previousVersionId, prior.versionId);
  assert.equal(merged.thesisStatus, 'revised');
});

test('splits filing text into auditable AI sections and produces fallback insights', () => {
  const sections = splitFilingSections(`
    Business Update
    The company expanded production.
    Revenue
    Revenue increased because of volume growth.
    Guidance
    Management expects revenue to improve next quarter.
    Risk Factors
    Customer concentration remains material.
  `);
  const insights = buildFallbackAiInsights({ sections, latestFiling: filings[0] });

  assert.ok(sections.some((section) => section.name === 'guidance'));
  assert.ok(sections.every((section) => section.hash));
  assert.equal(insights.source, 'fallback');
  assert.equal(insights.sourceQuotes[0].accessionNumber, filings[0].accessionNumber);
  assert.ok(insights.guidanceChanges.length > 0);
});

test('filters unreadable and placeholder AI filing text from the report UI', () => {
  const insights = selectRenderableAiInsights({
    source: 'fallback',
    guidanceChanges: [
      { status: 'not_found', detail: '最新 filing 未定位到明确 Guidance / Outlook。' },
      { status: 'needs_review', detail: 'Guidance / Outlook 相关文本已定位，需人工复核。' },
      { status: 'confirmed', detail: '管理层将全年收入指引上调至 12% 至 14%。' }
    ],
    riskFlags: [
      { severity: 'medium', detail: 'SEC filing document did not contain readable text' },
      { severity: 'low', detail: '最新 filing 未定位到独立 Risk Factors section。' },
      { severity: 'high', detail: '客户集中度风险较上一期上升。' }
    ]
  });

  assert.deepEqual(insights.guidanceChanges, [
    { status: 'confirmed', detail: '管理层将全年收入指引上调至 12% 至 14%。' }
  ]);
  assert.deepEqual(insights.riskFlags, [
    { severity: 'high', detail: '客户集中度风险较上一期上升。' }
  ]);
});

test('normalizes a filing summary into concise analyst-grade points', () => {
  const summary = normalizeFilingSummary({
    headline: '收入增长，但利润率继续承压。',
    bullets: [
      { label: '业绩', detail: '季度收入同比增长 16%，主要由云网络产品拉动。', importance: 'high' },
      { label: '空项', detail: '需要结合后续材料复核。', importance: 'medium' },
      { label: '利润率', detail: '毛利率为 28.8%，净利率为 -10.4%。', importance: 'high' },
      { label: '流动性', detail: '资本开支与现金消耗仍是后续季度的核心约束。', importance: 'medium' },
      { label: '风险', detail: '客户集中度和需求波动可能放大收入波动。', importance: 'medium' },
      { label: '冗余', detail: '该条不应超过五条上限。', importance: 'low' }
    ],
    analystView: '增长质量取决于毛利率修复和现金消耗收窄。'
  }, {
    ticker: 'LITE',
    form: '10-Q',
    filingDate: '2026-06-01',
    accessionNumber: '0001193125-26-249535'
  });

  assert.equal(summary.headline, '收入增长，但利润率继续承压。');
  assert.equal(summary.bullets.length, 4);
  assert.equal(summary.bullets[0].label, '业绩');
  assert.equal(summary.analystView, '增长质量取决于毛利率修复和现金消耗收窄。');
  assert.equal(summary.form, '10-Q');
});

function rawNode({ end, totalRevenue, costOfRevenue, grossProfit, operatingIncome, netIncome }) {
  return {
    endDate: { raw: Math.floor(new Date(`${end}T00:00:00Z`).getTime() / 1000), fmt: end },
    totalRevenue: { raw: totalRevenue },
    costOfRevenue: { raw: costOfRevenue },
    grossProfit: { raw: grossProfit },
    operatingIncome: { raw: operatingIncome },
    netIncome: { raw: netIncome }
  };
}

test('normalizeIncomeStatementPayload flattens Yahoo quarterly + annual income statement modules', () => {
  const raw = {
    quoteSummary: {
      result: [{
        incomeStatementHistoryQuarterly: {
          incomeStatementHistory: [
            rawNode({ end: '2026-03-31', totalRevenue: 65_000_000_000, costOfRevenue: 20_000_000_000, grossProfit: 45_000_000_000, operatingIncome: 30_000_000_000, netIncome: 24_000_000_000 }),
            rawNode({ end: '2025-12-31', totalRevenue: 70_000_000_000, costOfRevenue: 21_000_000_000, grossProfit: 49_000_000_000, operatingIncome: 32_000_000_000, netIncome: 26_000_000_000 })
          ]
        },
        incomeStatementHistory: {
          incomeStatementHistory: [
            rawNode({ end: '2025-06-30', totalRevenue: 245_000_000_000, costOfRevenue: 75_000_000_000, grossProfit: 170_000_000_000, operatingIncome: 110_000_000_000, netIncome: 90_000_000_000 })
          ]
        }
      }]
    }
  };

  const payload = normalizeIncomeStatementPayload('MSFT', raw);
  assert.equal(payload.quarterly.length, 2);
  assert.equal(payload.annual.length, 1);
  assert.equal(payload.quarterly[0].end, '2026-03-31');
  assert.equal(payload.quarterly[0].revenue, 65_000_000_000);
  assert.equal(payload.annual[0].revenue, 245_000_000_000);
});

test('normalizeIncomeStatementPayload throws when neither quarterly nor annual data is present', () => {
  assert.throws(() => normalizeIncomeStatementPayload('XXXX', { quoteSummary: { result: [{}] } }));
});

test('extractFinancialMetricsFromYahoo computes margins and period labels from Yahoo rows', () => {
  const payload = {
    quarterly: [
      { end: '2026-03-31', revenue: 65_000_000_000, costOfRevenue: 20_000_000_000, grossProfit: 45_000_000_000, operatingIncome: 30_000_000_000, netIncome: 24_000_000_000 },
      { end: '2025-12-31', revenue: 70_000_000_000, costOfRevenue: 21_000_000_000, grossProfit: 49_000_000_000, operatingIncome: 32_000_000_000, netIncome: 26_000_000_000 }
    ],
    annual: [
      { end: '2025-06-30', revenue: 245_000_000_000, costOfRevenue: 75_000_000_000, grossProfit: 170_000_000_000, operatingIncome: 110_000_000_000, netIncome: 90_000_000_000 },
      { end: '2024-06-30', revenue: 211_000_000_000, costOfRevenue: 66_000_000_000, grossProfit: 145_000_000_000, operatingIncome: 88_000_000_000, netIncome: 72_000_000_000 }
    ]
  };

  const metrics = extractFinancialMetricsFromYahoo(payload, 12);
  assert.equal(metrics.length, 4);

  const q1 = metrics.find((row) => row.end === '2026-03-31');
  assert.equal(q1.period, '2026 Q1');
  assert.equal(q1.grossMargin, round4(45 / 65));
  assert.equal(q1.netMargin, round4(24 / 65));

  const fy2025 = metrics.find((row) => row.end === '2025-06-30');
  assert.equal(fy2025.period, '2025 FY');
  // FY-over-FY YoY should be computable since two annual rows a year apart are present.
  assert.equal(fy2025.revenueYoY, round4(245 / 211 - 1));

  function round4(value) {
    return Math.round(value * 10000) / 10000;
  }
});

test('extractFinancialMetricsFromYahoo returns an empty list when given no rows', () => {
  assert.deepEqual(extractFinancialMetricsFromYahoo({ quarterly: [], annual: [] }, 12), []);
});

test('buildSecAnalysisReport uses Yahoo-sourced financialMetrics when provided, skipping SEC company facts and inline patches', () => {
  const yahooMetrics = extractFinancialMetricsFromYahoo({
    quarterly: [{ end: '2026-03-31', revenue: 65_000_000_000, costOfRevenue: 20_000_000_000, grossProfit: 45_000_000_000, operatingIncome: 30_000_000_000, netIncome: 24_000_000_000 }],
    annual: []
  }, 12);

  const report = buildSecAnalysisReport({
    ticker: 'TEST',
    companyName: 'Test Corp',
    filings,
    companyFacts,
    inlineMetrics: [{ fy: 2026, fp: 'Q1', end: '2026-03-31', filed: '2026-05-08', revenue: 999_999_999 }],
    financialMetrics: yahooMetrics
  });

  assert.equal(report.financials.source, 'yahoo');
  assert.equal(report.financials.quarters.length, 1);
  // The SEC inline patch's revenue (999,999,999) must NOT have overwritten the Yahoo figure.
  assert.equal(report.financials.quarters[0].revenue, 65_000_000_000);
  assert.match(report.summary[2], /Yahoo Finance/);
});

test('buildSecAnalysisReport falls back to SEC company facts when financialMetrics is not provided', () => {
  const report = buildSecAnalysisReport({ ticker: 'TEST', companyName: 'Test Corp', filings, companyFacts });
  assert.equal(report.financials.source, 'sec');
});

test('buildSecAnalysisReport separates quarterly and annual rows so chart axes stay uniform', () => {
  const yahooMetrics = extractFinancialMetricsFromYahoo({
    quarterly: [
      { end: '2025-12-31', revenue: 70_000_000_000, costOfRevenue: 21_000_000_000, grossProfit: 49_000_000_000, operatingIncome: 32_000_000_000, netIncome: 26_000_000_000 },
      { end: '2026-03-31', revenue: 65_000_000_000, costOfRevenue: 20_000_000_000, grossProfit: 45_000_000_000, operatingIncome: 30_000_000_000, netIncome: 24_000_000_000 }
    ],
    annual: [
      { end: '2024-06-30', revenue: 211_000_000_000, costOfRevenue: 66_000_000_000, grossProfit: 145_000_000_000, operatingIncome: 88_000_000_000, netIncome: 72_000_000_000 },
      { end: '2025-06-30', revenue: 245_000_000_000, costOfRevenue: 75_000_000_000, grossProfit: 170_000_000_000, operatingIncome: 110_000_000_000, netIncome: 90_000_000_000 }
    ]
  }, 12);

  const report = buildSecAnalysisReport({ ticker: 'TEST', companyName: 'Test Corp', filings, companyFacts, financialMetrics: yahooMetrics });

  // quarters 只含季度（fp 为 Qn），annual 只含年报（fp 为 FY），互不混杂。
  assert.ok(report.financials.quarters.length >= 1);
  assert.ok(report.financials.annual.length >= 1);
  assert.ok(report.financials.quarters.every((row) => row.fp !== 'FY'));
  assert.ok(report.financials.annual.every((row) => row.fp === 'FY'));
  // 年度行之间相隔一年，YoY 应可计算；季度行无上一年同季度数据，YoY 为空。
  const fy2025 = report.financials.annual.find((row) => row.period === '2025 FY');
  assert.ok(hasFinite(fy2025?.revenueYoY));
  assert.ok(report.financials.quarters.every((row) => row.revenueYoY === null));
  // headline latest 仍取最新季度，而不是年报。
  assert.notEqual(report.financials.latest?.fp, 'FY');

  function hasFinite(value) {
    return Number.isFinite(value);
  }
});
