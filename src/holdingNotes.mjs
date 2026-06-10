export function normalizeHoldingItems(items, legacyText = '', prefix = 'item') {
  if (Array.isArray(items)) {
    return items.map((item, index) => ({
      id: String(item?.id || `${prefix}-${index}`),
      text: String(typeof item === 'string' ? item : item?.text || '')
    }));
  }

  const text = String(legacyText || '').trim();
  return text ? [{ id: `${prefix}-0`, text }] : [];
}

export function normalizeEntryPlan(plan) {
  return {
    batches: Math.max(1, Math.round(Number(plan?.batches) || 3)),
    sharesPerBatch: Math.max(0, Number(plan?.sharesPerBatch) || 0),
    targetWeight: Math.max(0, Math.min(100, Number(plan?.targetWeight) || 0))
  };
}
