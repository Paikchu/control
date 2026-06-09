export function mergePriceData(baseRows, fetchedSeries) {
  const seriesEntries = Object.entries(fetchedSeries).filter(([, rows]) => Array.isArray(rows) && rows.length);
  if (!seriesEntries.length) return baseRows;

  const seriesMaps = Object.fromEntries(seriesEntries.map(([symbol, rows]) => [
    symbol,
    new Map(rows.map((row) => [row.date, row.close]))
  ]));

  return baseRows.map((row) => {
    const merged = { ...row };
    for (const [symbol, prices] of Object.entries(seriesMaps)) {
      const price = prices.get(row.date);
      if (!Number.isFinite(price)) return null;
      merged[symbol] = price;
    }
    return merged;
  }).filter(Boolean);
}
