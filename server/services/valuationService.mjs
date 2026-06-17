import { buildFallbackValuationInsights, buildValuationReport } from '../../src/valuationReport.mjs';
import { cleanTicker, parseJsonObject } from '../util.mjs';
import { deepseekChat, hasDeepSeekKey, valuationModel } from './deepseek.mjs';
import { getPrices, getValuation } from './yahoo.mjs';

const REPORT_TTL_MS = 6 * 60 * 60 * 1000;

async function readLatestReport(db, ticker) {
  const { rows } = await db.query(
    'SELECT generated_at, payload FROM valuation_reports WHERE ticker = $1 ORDER BY generated_at DESC LIMIT 1',
    [ticker]
  );
  if (!rows[0]) return null;
  try {
    return { generatedAt: rows[0].generated_at, report: JSON.parse(rows[0].payload) };
  } catch {
    return null;
  }
}

async function persistReport(db, report) {
  await db.query(`
    INSERT INTO valuation_reports (ticker, version_id, generated_at, payload)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (ticker, version_id) DO UPDATE SET
      generated_at = EXCLUDED.generated_at,
      payload = EXCLUDED.payload
  `, [report.ticker, report.versionId, report.generatedAt, JSON.stringify(report)]);
}

// AI 只给出 DCF 假设参数（增长率/利润率/折现率/永续增长率）和定性判断 —— 绝不让模型
// 自己算出公允价值数字，避免多步算术幻觉。真正的算术由 src/valuationReport.mjs 完成。
async function analyzeValuationWithDeepSeek({ ticker, valuation }) {
  if (!hasDeepSeekKey()) return buildFallbackValuationInsights(valuation);

  try {
    const content = await deepseekChat({
      model: valuationModel,
      system: [
        '你是美股估值分析师，只根据用户提供的硬数据做判断。',
        '任务：为 bear / base / bull 三种情景各给出一组 DCF 假设参数 —— revenueGrowth（未来5年年化收入增长率）、',
        'fcfMargin（自由现金流占收入比例）、discountRate（折现率/WACC）、terminalGrowth（永续增长率，必须小于 discountRate）。',
        '禁止自己计算或输出公允价值/每股价值等结果数字 —— 那部分由系统用标准 DCF 公式重新计算，你给的任何数字结果都会被忽略。',
        '你只负责：1) 给出三组合理的假设参数；2) 给出 verdict（高估/合理/低估）的定性判断；3) keyDrivers 和 risks 必须引用给定的具体数字，不能编造。',
        '输出 JSON: {"scenarios":[{"case":"bear","revenueGrowth":0,"fcfMargin":0,"discountRate":0,"terminalGrowth":0},{"case":"base",...},{"case":"bull",...}],"verdict":"高估|合理|低估","confidence":0-1,"keyDrivers":[{"label":"","detail":""}],"risks":[{"severity":"high|medium|low","detail":""}],"reasoning":""}'
      ].join('\n'),
      user: JSON.stringify({ ticker, valuation })
    });
    const parsed = parseJsonObject(content);
    if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
      return buildFallbackValuationInsights(valuation);
    }
    return { ...parsed, source: 'deepseek' };
  } catch {
    return buildFallbackValuationInsights(valuation);
  }
}

export async function getValuationReport(db, ticker, { force = false } = {}) {
  const clean = cleanTicker(ticker);

  if (!force) {
    const cached = await readLatestReport(db, clean);
    if (cached && Date.now() - new Date(cached.generatedAt).getTime() < REPORT_TTL_MS) {
      return { ...cached.report, persisted: true, source: 'cache' };
    }
  }

  const valuation = await getValuation(db, clean, { force });
  const prices = await getPrices(db, clean).catch(() => null);
  const aiInsights = await analyzeValuationWithDeepSeek({ ticker: clean, valuation });

  const report = buildValuationReport({
    ticker: clean,
    companyName: valuation.companyName,
    valuation,
    prices,
    aiInsights
  });

  await persistReport(db, report);
  return { ...report, persisted: true };
}
