import {
  buildFallbackAiInsights,
  buildSecAnalysisReport,
  extractInlineFinancialMetrics,
  normalizeFilingSummary,
  splitFilingSections
} from '../../src/secReport.mjs';
import { cleanAccession, cleanTicker, parseJsonObject } from '../util.mjs';
import { deepseekChat, hasDeepSeekKey, secAnalysisModel } from './deepseek.mjs';
import { getFilingRaw, getFilingText, getSecCompanyFacts, getSecFilings } from './secClient.mjs';

async function readLatestReport(db, ticker) {
  const { rows } = await db.query(
    'SELECT payload FROM sec_report_versions WHERE ticker = $1 ORDER BY generated_at DESC LIMIT 1',
    [ticker]
  );
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].payload);
  } catch {
    return null;
  }
}

async function persistReport(db, report) {
  await db.query(`
    INSERT INTO sec_report_versions (ticker, version_id, generated_at, latest_accession_number, payload)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (ticker, version_id) DO UPDATE SET
      generated_at = EXCLUDED.generated_at,
      latest_accession_number = EXCLUDED.latest_accession_number,
      payload = EXCLUDED.payload
  `, [
    report.ticker,
    report.versionId,
    report.generatedAt,
    report.latestFiling?.accessionNumber || null,
    JSON.stringify(report)
  ]);

  for (const quarter of report.financials?.quarters || []) {
    for (const metric of ['revenue', 'costOfRevenue', 'grossProfit', 'operatingIncome', 'netIncome', 'operatingCashFlow', 'capex', 'fcf']) {
      if (!Number.isFinite(quarter[metric])) continue;
      const source = quarter.sources?.[metric] || quarter.source || {};
      await db.query(`
        INSERT INTO sec_report_facts (ticker, period, metric, value, source_tag, accession_number, filed)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (ticker, period, metric) DO UPDATE SET
          value = EXCLUDED.value,
          source_tag = EXCLUDED.source_tag,
          accession_number = EXCLUDED.accession_number,
          filed = EXCLUDED.filed
      `, [
        report.ticker,
        quarter.period,
        metric,
        quarter[metric],
        source.tag || null,
        source.accessionNumber || quarter.accessionNumber || null,
        source.filed || quarter.filed || null
      ]);
    }
  }
}

async function analyzeFilingSectionsWithDeepSeek({ ticker, filing, sections }) {
  if (!hasDeepSeekKey()) return buildFallbackAiInsights({ sections, latestFiling: filing });

  try {
    const content = await deepseekChat({
      model: secAnalysisModel,
      system: [
        '你是美股 SEC 财报分析员。',
        '必须优先使用最新 filing 和最新季度数据，不能因为 FY 数据较完整就回退到 2024 年。',
        '必须优先使用最新 filing 和最新季度数据，不能因为 FY 数据较完整就回退到 2024 年。',
        '必须优先使用最新 filing 和最新季度数据，不能因为 FY 数据较完整就回退到 2024 年。',
        '只基于用户给定的 SEC section 输出 JSON。',
        '不要编造数字；数字必须来自文本或留空。',
        '每个结论必须带 section、quote、confidence。',
        '输出 JSON: {"source":"deepseek","confidence":0-1,"guidanceChanges":[],"riskFlags":[],"liquidityNotes":[],"sourceQuotes":[]}'
      ].join('\n'),
      user: JSON.stringify({
        ticker,
        accessionNumber: filing.accessionNumber,
        form: filing.form,
        filingDate: filing.filingDate,
        sections: sections.map((section) => ({ name: section.name, text: section.text.slice(0, 5000), hash: section.hash }))
      })
    });
    return {
      ...buildFallbackAiInsights({ sections, latestFiling: filing }),
      ...parseJsonObject(content),
      source: 'deepseek'
    };
  } catch {
    return buildFallbackAiInsights({ sections, latestFiling: filing });
  }
}

async function getAiInsightsForLatestFiling(db, ticker, filing) {
  if (!filing) return null;
  try {
    const text = await getFilingText(db, filing);
    const sections = splitFilingSections(text);
    return analyzeFilingSectionsWithDeepSeek({ ticker, filing, sections });
  } catch (error) {
    return {
      source: 'error',
      confidence: 0,
      guidanceChanges: [],
      riskFlags: [{ severity: 'medium', detail: error.message }],
      liquidityNotes: [],
      sourceQuotes: []
    };
  }
}

async function getInlineMetricsForLatestFiling(db, filing) {
  if (!filing) return [];
  try {
    const raw = await getFilingRaw(db, filing);
    return extractInlineFinancialMetrics(raw, filing);
  } catch {
    return [];
  }
}

export async function getSecAnalysisReport(db, ticker, { force = false } = {}) {
  const clean = cleanTicker(ticker);
  const [filingsPayload, companyFacts] = await Promise.all([
    getSecFilings(db, clean, 20, force),
    getSecCompanyFacts(db, clean, force)
  ]);
  const previousReport = await readLatestReport(db, clean);
  const latestFiling = filingsPayload.filings[0];
  const [aiInsights, inlineMetrics] = await Promise.all([
    getAiInsightsForLatestFiling(db, clean, latestFiling),
    getInlineMetricsForLatestFiling(db, latestFiling)
  ]);
  const report = buildSecAnalysisReport({
    ticker: clean,
    companyName: filingsPayload.company?.name || companyFacts.entityName || clean,
    filings: filingsPayload.filings,
    companyFacts,
    previousReport,
    aiInsights,
    inlineMetrics
  });
  await persistReport(db, report);
  return {
    ...report,
    source: 'sec',
    persisted: true
  };
}

async function analyzeFilingSummaryWithDeepSeek({ ticker, filing, sections }) {
  const content = await deepseekChat({
    model: secAnalysisModel,
    system: [
      '你是负责美股基本面研究的资深金融分析师。',
      '只根据给定 SEC filing 内容输出中文摘要，不使用外部信息，不编造数字。',
      'headline、label、detail、analystView 所有字段必须使用简体中文；公司名、产品名和 SEC 表格术语可以保留英文。',
      '优先识别：收入与增长驱动、利润率、现金流与流动性、资本开支、管理层指引、重大交易、融资、诉讼、客户集中度和会计风险。',
      '8-K 要说明事件是什么、对盈利或资产负债表的影响；10-Q/10-K 要说明业绩变化、质量和关键风险。',
      '没有证据的维度直接省略。禁止输出“需要复核”“未找到”“建议关注”等空泛措辞。',
      'headline 必须是一句有方向性的结论。',
      'bullets 输出 3 至 5 条，每条包含 label、detail、importance；detail 必须带具体事实或明确影响。',
      'analystView 用一句话说明该 filing 对投资判断的具体含义，不给买卖建议。',
      '输出 JSON: {"headline":"","bullets":[{"label":"","detail":"","importance":"high|medium|low"}],"analystView":""}'
    ].join('\n'),
    user: JSON.stringify({
      ticker,
      form: filing.form,
      filingDate: filing.filingDate,
      reportDate: filing.reportDate,
      accessionNumber: filing.accessionNumber,
      sections: sections.slice(0, 7).map((section) => ({
        name: section.name,
        text: section.text.slice(0, 4500)
      }))
    })
  });
  return normalizeFilingSummary({
    ...parseJsonObject(content),
    source: 'deepseek',
    generatedAt: new Date().toISOString()
  }, filing);
}

const FAILED_SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function getSecFilingSummary(db, ticker, accessionNumber) {
  const clean = cleanTicker(ticker);
  const accession = cleanAccession(accessionNumber);
  const { rows } = await db.query(
    'SELECT payload, generated_at FROM sec_filing_summaries WHERE ticker = $1 AND accession_number = $2',
    [clean, accession]
  );
  if (rows[0]?.payload) {
    const cached = JSON.parse(rows[0].payload);
    const hasContent = cached.headline || cached.bullets?.length || cached.analystView;
    const ageMs = Date.now() - new Date(rows[0].generated_at || 0).getTime();
    // Return good summaries always; return failed ones within 7-day negative-cache window.
    if (hasContent || ageMs < FAILED_SUMMARY_TTL_MS) return cached;
  }
  if (!hasDeepSeekKey()) {
    throw new Error('DEEPSEEK_API_KEY is required for filing summaries');
  }

  const filingsPayload = await getSecFilings(db, clean, 50);
  const filing = filingsPayload.filings.find((item) => item.accessionNumber === accession);
  if (!filing) throw new Error('SEC filing not found');

  const text = await getFilingText(db, filing);
  const sections = splitFilingSections(text);
  const summary = await analyzeFilingSummaryWithDeepSeek({ ticker: clean, filing, sections });

  // Always persist — empty/failed results are cached as a negative entry so we don't
  // re-call DeepSeek on every page visit. Stale failed entries expire after 7 days (see above).
  await db.query(`
    INSERT INTO sec_filing_summaries (ticker, accession_number, generated_at, payload)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (ticker, accession_number) DO UPDATE SET
      generated_at = EXCLUDED.generated_at,
      payload = EXCLUDED.payload
  `, [clean, accession, summary.generatedAt, JSON.stringify(summary)]);

  if (!summary.headline && !summary.bullets.length && !summary.analystView) {
    throw new Error('AI filing summary did not contain usable analysis');
  }
  return summary;
}
