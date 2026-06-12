export function formatMoney(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function pct(n, digits = 1) {
  if (!Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(digits)}%`;
}

export function compactMoney(n) {
  if (!Number.isFinite(n)) return 'n/a';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return formatMoney(n);
}

export function hasNumber(n) {
  return Number.isFinite(n);
}

export const indexNumberFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
