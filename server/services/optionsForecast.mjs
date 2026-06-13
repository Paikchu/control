import { deepseekChat, hasDeepSeekKey } from './deepseek.mjs';
import { parseJsonObject } from '../util.mjs';
import { compactMetricsForModel } from '../../src/optionsAnalytics.mjs';

export const optionsForecastModel = process.env.DEEPSEEK_OPTIONS_MODEL || 'deepseek-chat';

const SYSTEM_PROMPT = `你是一位专注美股指数期权的资深衍生品分析师。
你只依据提供的 SPY 与 QQQ 期权结构指标，对「未来 1-3 个交易日」的短期走势做研判。

解读要点：
- Net Gamma（做市商净伽马）为正时，做市商倾向压制波动 → 市场更易区间震荡、向 pin 价收敛；
  为负时做市商助涨助跌 → 波动放大、容易出现趋势性单边。
- gammaFlip 是正负伽马的翻转价位：现价在其上方偏稳、下方偏不稳。
- Put/Call Ratio 偏高（>1.1）通常对应避险/偏空情绪，偏低（<0.7）对应乐观；但需结合是否过度而反向。
- callWall 视为上方阻力，putWall 视为下方支撑。

要求：
- 语气客观，明确这是基于期权结构的「概率性研判」而非确定性预测。
- 必须返回如下 JSON（不要额外文字）：
{
  "bias": "bullish" | "neutral" | "bearish",
  "confidence": 0到1的小数,
  "horizon": "1-3个交易日",
  "summary": "中文，≤120字的总体研判",
  "spy": { "view": "中文一句", "support": 数字或null, "resistance": 数字或null },
  "qqq": { "view": "中文一句", "support": 数字或null, "resistance": 数字或null },
  "drivers": ["驱动因素，中文，2-4条"],
  "risks": ["该研判可能失效的风险点，中文，1-3条"]
}`;

function normalizeBias(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('bull')) return 'bullish';
  if (text.includes('bear')) return 'bearish';
  return 'neutral';
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(1, Math.max(0, num));
}

// metricsList: [{ symbol, metrics }] —— 直接用纯指标，不依赖 DB。
export async function forecastFromMetrics(metricsList) {
  if (!hasDeepSeekKey()) {
    return { available: false, reason: 'DEEPSEEK_API_KEY 未配置', forecast: null };
  }
  const compact = {};
  for (const { symbol, metrics } of metricsList) {
    if (metrics) compact[symbol] = compactMetricsForModel(metrics);
  }
  if (!Object.keys(compact).length) {
    return { available: false, reason: '没有可用的期权指标', forecast: null };
  }

  const content = await deepseekChat({
    model: optionsForecastModel,
    temperature: 0.2,
    system: SYSTEM_PROMPT,
    user: `期权结构指标如下（gex 单位为 $/1% 标的变动）：\n${JSON.stringify(compact)}`
  });

  const raw = parseJsonObject(content);
  const forecast = {
    bias: normalizeBias(raw.bias),
    confidence: clampConfidence(raw.confidence),
    horizon: String(raw.horizon || '1-3个交易日'),
    summary: String(raw.summary || '').slice(0, 200),
    spy: raw.spy || null,
    qqq: raw.qqq || null,
    drivers: Array.isArray(raw.drivers) ? raw.drivers.map(String).slice(0, 4) : [],
    risks: Array.isArray(raw.risks) ? raw.risks.map(String).slice(0, 3) : []
  };
  return { available: true, reason: null, forecast, model: optionsForecastModel };
}
