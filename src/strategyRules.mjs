function normalizeTicker(value, fallback) {
  const text = String(value || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 12);
  return text || fallback;
}

function buildCondition({ index, triggerAsset, targetAsset, value, targetWeight, operator = '>=' }) {
  return {
    id: `derived-rule-${Date.now()}-${index}`,
    enabled: true,
    label: operator === '<=' ? '恢复退出' : `${value}% 回撤`,
    triggerAsset,
    metric: 'drawdown',
    operator,
    value,
    action: 'set_weight',
    targetAsset,
    targetWeight,
    sourceAsset: 'CORE',
    priority: operator === '<=' ? 99 : index + 1
  };
}

export function deriveConditionsFromText(text, existingConditions = []) {
  const source = String(text || '').trim();
  if (!source) return [];

  const upper = source.toUpperCase();
  const triggerAsset = normalizeTicker(upper.match(/\b([A-Z]{2,5})\b(?=[^。；,，]*回撤)/)?.[1], 'QQQ');
  const avoidsLeverage = /不使用杠杆|不用杠杆|避免杠杆|不要用杠杆/.test(source);
  const mentionedLeveraged = upper.match(/\b(TQQQ|SQQQ|UPRO|SOXL|TECL)\b/)?.[1];
  const existingTarget = existingConditions.find((condition) => Number(condition.targetWeight) > 0)?.targetAsset;
  const targetAsset = avoidsLeverage ? triggerAsset : normalizeTicker(mentionedLeveraged || existingTarget, 'TQQQ');

  const values = Array.from(source.matchAll(/回撤[^0-9]{0,10}(\d{1,2})(?:\.\d+)?\s*%?/g))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 90)
    .filter((value, index, items) => items.indexOf(value) === index)
    .sort((a, b) => a - b);

  const entries = values.map((value, index) => {
    const existing = existingConditions.find((condition) => Number(condition.value) === value && condition.operator !== '<=');
    return buildCondition({
      index,
      triggerAsset,
      targetAsset,
      value,
      targetWeight: Number(existing?.targetWeight) || Math.min(60, (index + 1) * 10)
    });
  });

  if (/恢复|前高|退出|退回|清仓/.test(source) && entries.length) {
    const existingExit = existingConditions.find((condition) => condition.operator === '<=' || Number(condition.targetWeight) === 0);
    entries.push(buildCondition({
      index: entries.length,
      triggerAsset,
      targetAsset,
      value: Number(existingExit?.value) || 5,
      targetWeight: 0,
      operator: '<='
    }));
  }

  return entries;
}
