// Yahoo Finance 估值数据 + AI DCF 假设 → 确定性贴现现金流计算。
//
// 设计原则：LLM 不擅长多步算术，所以 AI 只提出 DCF 假设参数（增长率/利润率/折现率/
// 永续增长率）和定性判断（驱动因素、风险），公允价值的实际计算永远由本文件的纯函数
// 完成，不采用 AI 直接给出的数字 —— 这是唯一能避免 DCF 算术幻觉的方式。

const DCF_YEARS = 5;

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const multiple = 10 ** digits;
  return Math.round(value * multiple) / multiple;
}

// 标准两阶段 DCF：5 年显式预测 + Gordon Growth 永续价值，按股本和净现金折算到每股。
export function deterministicDcf(assumptions = {}, inputs = {}) {
  const { revenueGrowth, fcfMargin, discountRate, terminalGrowth } = assumptions;
  const { totalRevenue, netCash = 0, sharesOutstanding } = inputs;

  if (![revenueGrowth, fcfMargin, discountRate, terminalGrowth, totalRevenue, sharesOutstanding]
    .every((value) => Number.isFinite(value))) {
    return null;
  }
  if (discountRate <= terminalGrowth || sharesOutstanding <= 0 || totalRevenue <= 0) {
    return null;
  }

  let revenue = totalRevenue;
  let presentValueSum = 0;
  let terminalYearFcf = 0;
  for (let year = 1; year <= DCF_YEARS; year += 1) {
    revenue *= 1 + revenueGrowth;
    const fcf = revenue * fcfMargin;
    presentValueSum += fcf / (1 + discountRate) ** year;
    terminalYearFcf = fcf;
  }

  const terminalValue = (terminalYearFcf * (1 + terminalGrowth)) / (discountRate - terminalGrowth);
  const presentTerminalValue = terminalValue / (1 + discountRate) ** DCF_YEARS;
  const enterpriseValue = presentValueSum + presentTerminalValue;
  const equityValue = enterpriseValue + (Number.isFinite(netCash) ? netCash : 0);
  const fairValuePerShare = equityValue / sharesOutstanding;

  return Number.isFinite(fairValuePerShare) ? round(fairValuePerShare, 2) : null;
}

const FALLBACK_DISCOUNT_RATE = { bear: 0.11, base: 0.09, bull: 0.08 };
const FALLBACK_GROWTH_MULTIPLIER = { bear: 0.5, base: 1, bull: 1.3 };
const FALLBACK_MARGIN_MULTIPLIER = { bear: 0.7, base: 1, bull: 1.2 };

function fallbackScenarios(valuation) {
  const financials = valuation?.financials || {};
  const baseGrowth = Number.isFinite(financials.revenueGrowth) ? financials.revenueGrowth : 0.06;
  const baseMargin = Number.isFinite(financials.freeCashflow) && Number.isFinite(financials.totalRevenue) && financials.totalRevenue > 0
    ? financials.freeCashflow / financials.totalRevenue
    : 0.15;

  return ['bear', 'base', 'bull'].map((caseName) => ({
    case: caseName,
    revenueGrowth: round(Math.max(0, baseGrowth * FALLBACK_GROWTH_MULTIPLIER[caseName]), 4),
    fcfMargin: round(Math.max(0.02, baseMargin * FALLBACK_MARGIN_MULTIPLIER[caseName]), 4),
    discountRate: FALLBACK_DISCOUNT_RATE[caseName],
    terminalGrowth: 0.025
  }));
}

// 无 DeepSeek API key 或调用失败时的退化方案：用硬数据启发式生成假设，不给定性结论。
export function buildFallbackValuationInsights(valuation) {
  return {
    source: 'fallback',
    confidence: 0.3,
    scenarios: fallbackScenarios(valuation),
    verdict: null,
    keyDrivers: [],
    risks: [{ severity: 'medium', detail: 'DEEPSEEK_API_KEY 未配置或调用失败，DCF 假设为系统启发式默认值，仅供参考，不构成投资建议。' }],
    reasoning: ''
  };
}

function deriveVerdict(upsidePercent) {
  if (!Number.isFinite(upsidePercent)) return null;
  if (upsidePercent >= 15) return '低估';
  if (upsidePercent <= -15) return '高估';
  return '合理';
}

function simpleHash(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16);
}

export function buildValuationMultiplesChart(valuation) {
  const multiples = valuation?.multiples || {};
  return {
    labels: ['Trailing P/E', 'Forward P/E', 'P/S', 'P/B', 'EV/EBITDA'],
    values: [
      multiples.trailingPE ?? null,
      multiples.forwardPE ?? null,
      multiples.priceToSales ?? null,
      multiples.priceToBook ?? null,
      multiples.enterpriseToEbitda ?? null
    ]
  };
}

export function buildPriceTargetChart(valuation, prices = null) {
  const rows = prices?.rows || [];
  const analyst = valuation?.analyst || {};
  return {
    dates: rows.map((row) => row.date),
    closes: rows.map((row) => row.close),
    targetLow: analyst.targetLowPrice ?? null,
    targetMean: analyst.targetMeanPrice ?? null,
    targetHigh: analyst.targetHighPrice ?? null,
    currentPrice: valuation?.currentPrice ?? null
  };
}

// 组装最终估值报告：硬数据 + AI 假设/定性判断 + 本文件确定性重算的 DCF 结果。
export function buildValuationReport({ ticker, companyName, valuation, prices = null, aiInsights = null }) {
  const cleanTicker = String(ticker || '').toUpperCase();
  const ai = aiInsights || buildFallbackValuationInsights(valuation);

  const inputs = {
    totalRevenue: valuation?.financials?.totalRevenue,
    netCash: Number.isFinite(valuation?.financials?.totalCash) && Number.isFinite(valuation?.financials?.totalDebt)
      ? valuation.financials.totalCash - valuation.financials.totalDebt
      : 0,
    sharesOutstanding: valuation?.sharesOutstanding
  };

  const currentPrice = valuation?.currentPrice;
  const scenarios = (ai.scenarios || []).map((assumption) => {
    const fairValuePerShare = deterministicDcf(assumption, inputs);
    const upsidePercent = Number.isFinite(fairValuePerShare) && Number.isFinite(currentPrice) && currentPrice > 0
      ? round((fairValuePerShare / currentPrice - 1) * 100, 1)
      : null;
    return { ...assumption, fairValuePerShare, upsidePercent };
  });

  const bearScenario = scenarios.find((row) => row.case === 'bear') || null;
  const baseScenario = scenarios.find((row) => row.case === 'base') || scenarios[0] || null;
  const bullScenario = scenarios.find((row) => row.case === 'bull') || null;

  const fairValueRange = baseScenario ? {
    low: bearScenario?.fairValuePerShare ?? null,
    mid: baseScenario?.fairValuePerShare ?? null,
    high: bullScenario?.fairValuePerShare ?? null
  } : null;

  const verdict = ai.verdict || deriveVerdict(baseScenario?.upsidePercent);
  const versionId = simpleHash(`${cleanTicker}:${currentPrice}:${JSON.stringify(scenarios)}`);

  return {
    versionId,
    ticker: cleanTicker,
    companyName: companyName || cleanTicker,
    generatedAt: new Date().toISOString(),
    valuation,
    scenarios,
    fairValueRange,
    verdict,
    confidence: Number.isFinite(ai.confidence) ? ai.confidence : null,
    keyDrivers: ai.keyDrivers || [],
    risks: ai.risks || [],
    reasoning: ai.reasoning || '',
    source: ai.source || 'deepseek',
    charts: {
      multiples: buildValuationMultiplesChart(valuation),
      priceTarget: buildPriceTargetChart(valuation, prices)
    },
    disclaimer: 'AI 仅提供 DCF 假设参数与定性判断；公允价值由系统使用标准两阶段 DCF 公式重新计算，未采用 AI 直接给出的数字。本报告不构成投资建议。'
  };
}
