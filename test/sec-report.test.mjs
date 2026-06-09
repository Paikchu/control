import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSecAnalysisReport,
  buildFallbackAiInsights,
  extractInlineFinancialMetrics,
  extractFinancialMetrics,
  mergeReportRevision,
  splitFilingSections
} from '../src/secReport.mjs';

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
