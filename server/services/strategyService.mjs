import { deepseekChat, strategyModel } from './deepseek.mjs';
import { parseJsonObject } from '../util.mjs';

function normalizeStrategyText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\bqqq\b/g, 'QQQ')
    .replace(/\btqqq\b/g, 'TQQQ')
    .replace(/\bspy\b/g, 'SPY')
    .replace(/\btlt\b/g, 'TLT')
    .replace(/\bsgov\b/g, 'SGOV')
    .replace(/\bgld\b/g, 'GLD')
    .replace(/(\d+(?:\.\d+)?)\s*％/g, '$1%')
    .replace(/([，。；])\s*/g, '$1')
    .trim();
}

function compactStrategyName(text) {
  if (/杠杆|TQQQ/i.test(text) && /回撤/.test(text)) return '回撤分批策略';
  if (/均线/.test(text)) return '均线调仓策略';
  if (/现金|SGOV|防守/.test(text)) return '防守调仓策略';
  return '自定义策略';
}

function sentenceFromRaw(description) {
  const text = normalizeStrategyText(description);
  const drawdowns = [...text.matchAll(/(?:回撤|下跌|跌)\s*(\d+(?:\.\d+)?)\s*%?/g)].map((match) => `${match[1]}%`);
  const usesTqqq = /TQQQ|杠杆/i.test(text) && !/不(?:用|使用)?杠杆|不要用杠杆|避免杠杆/.test(text);
  const target = usesTqqq ? 'TQQQ' : 'QQQ';
  const exit = /恢复|回到|前高|退出|清仓/.test(text);

  if (drawdowns.length) {
    const steps = drawdowns.map((level, index) => {
      if (usesTqqq) {
        const weight = index === 0 ? '小幅提高' : '继续提高';
        return `QQQ 回撤达到 ${level} 时，${weight} ${target} 仓位`;
      }
      return `QQQ 回撤达到 ${level} 时，增加 ${target} 仓位`;
    });
    if (exit) steps.push('当 QQQ 修复到前高附近时，退出增强仓位并回到基础配置');
    return steps.join('；') + '。';
  }

  return text.endsWith('。') ? text : `${text}。`;
}

function refineStrategyText(existingStrategy, feedback) {
  const existing = normalizeStrategyText(existingStrategy);
  const note = normalizeStrategyText(feedback);
  if (!existing) return sentenceFromRaw(note);

  if (/不(?:用|使用)?杠杆|不要用杠杆|避免杠杆/.test(note)) {
    return '不使用杠杆。以 QQQ 作为主要买入标的；当 QQQ 出现明确回撤时分批加仓，修复到前高附近后降低新增仓位，回到基础配置。';
  }

  if (/更保守|保守一点|降低风险/.test(note)) {
    return `${existing.replace(/TQQQ 仓位/g, '增强仓位')} 控制单次加仓幅度，优先保留现金缓冲。`;
  }

  if (/止损|退出|清仓/.test(note)) {
    return `${existing.replace(/。$/, '')}；若触发止损或趋势失效，降低风险仓位并回到基础配置。`;
  }

  return `${existing.replace(/。$/, '')}；按追加意见调整：${note.replace(/。$/, '')}。`;
}

function normalizeStrategyDescription(raw) {
  const strategy = raw?.strategy && typeof raw.strategy === 'object' ? raw.strategy : raw;
  const displayText = normalizeStrategyText(strategy?.displayText || strategy?.description || strategy?.text || '');
  if (!displayText) {
    throw new Error('Model did not return a strategy description');
  }
  return {
    name: String(strategy?.name || compactStrategyName(displayText)).slice(0, 24),
    displayText: displayText.endsWith('。') ? displayText : `${displayText}。`
  };
}

export async function describeStrategyWithDeepSeek(description, existingStrategy = '') {
  const content = await deepseekChat({
    model: strategyModel,
    temperature: 0.2,
    system: [
      '你负责把用户的投资策略口语描述整理成页面可展示的自然语言策略。',
      '只整理、纠错、补全用户原意，不新增用户没有表达的交易逻辑。',
      '如果用户给出 existingStrategy，按用户新的反馈改写已有策略。',
      '输出 JSON only，格式：{"name":"不超过12个中文字","displayText":"一段清晰明确的中文策略描述"}。',
      'displayText 不要列结构化字段，不要返回按钮、标签或条件 JSON。'
    ].join('\n'),
    user: JSON.stringify({ description, existingStrategy }, null, 2)
  });
  return normalizeStrategyDescription(parseJsonObject(content));
}

export function describeStrategyFallback(description, existingStrategy = '') {
  const displayText = existingStrategy
    ? refineStrategyText(existingStrategy, description)
    : sentenceFromRaw(description);
  return normalizeStrategyDescription({
    name: compactStrategyName(`${existingStrategy} ${description}`),
    displayText
  });
}
