export const dayMs = 24 * 60 * 60 * 1000;
export const priceTtlMs = 12 * 60 * 60 * 1000;
export const secTickerTtlMs = 7 * dayMs;
export const secFilingsTtlMs = 6 * 60 * 60 * 1000;
export const secDocumentTtlMs = 7 * dayMs;
export const marketOverviewTtlMs = 60 * 1000;

export async function cacheRead(db, key, ttlMs) {
  const { rows } = await db.query('SELECT fetched_at, payload FROM sec_cache WHERE cache_key = $1', [key]);
  const cached = rows[0];
  if (!cached) return null;
  const age = Date.now() - new Date(cached.fetched_at).getTime();
  if (age > ttlMs) return null;
  return JSON.parse(cached.payload);
}

export async function cacheWrite(db, key, payload) {
  await db.query(`
    INSERT INTO sec_cache (cache_key, fetched_at, payload)
    VALUES ($1, $2, $3)
    ON CONFLICT (cache_key) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, payload = EXCLUDED.payload
  `, [key, new Date().toISOString(), JSON.stringify(payload)]);
}

export async function priceCacheRead(db, ticker, rangeKey) {
  const { rows } = await db.query(
    'SELECT fetched_at, payload FROM price_cache WHERE ticker = $1 AND range_key = $2',
    [ticker, rangeKey]
  );
  return rows[0] || null;
}

export async function priceCacheWrite(db, ticker, rangeKey, payload) {
  await db.query(`
    INSERT INTO price_cache (ticker, range_key, fetched_at, payload)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (ticker, range_key) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, payload = EXCLUDED.payload
  `, [ticker, rangeKey, new Date().toISOString(), JSON.stringify(payload)]);
}
