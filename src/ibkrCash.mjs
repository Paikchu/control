export function summarizeIbkrCash(snapshot) {
  const balances = Array.isArray(snapshot?.balances)
    ? snapshot.balances.filter((balance) => Number.isFinite(Number(balance?.cashBalance)))
    : [];
  const baseBalance = balances.find((balance) => balance.currency === 'BASE');
  const primaryBalance = baseBalance || (balances.length === 1 ? balances[0] : null);

  return {
    cashBalance: primaryBalance ? Number(primaryBalance.cashBalance) : null,
    netLiquidation: primaryBalance && Number.isFinite(Number(primaryBalance.netLiquidation))
      ? Number(primaryBalance.netLiquidation)
      : null,
    currencyBalances: balances.filter((balance) => balance.currency !== 'BASE')
  };
}

export function holdingWeightPercent(marketValue, totalValue) {
  const value = Number(marketValue);
  const total = Number(totalValue);
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null;
  return value / total * 100;
}
