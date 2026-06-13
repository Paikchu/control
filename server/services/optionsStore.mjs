// 期权快照 / DeepSeek 研判的持久化。snapshot_date 用美东日期，
// 这样「每个交易日一次」的去重和收盘后刷新都对齐美股交易日。

export function usEasternDate(date = new Date()) {
  // en-CA 给出 YYYY-MM-DD；timeZone 处理夏令时。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export async function storeOptionSnapshot(db, metrics) {
  const snapshotDate = usEasternDate(new Date());
  await db.query(
    `INSERT INTO option_snapshots
       (symbol, snapshot_date, fetched_at, spot, pcr_volume, pcr_oi, net_gamma, gamma_flip, call_wall, put_wall, bias, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (symbol, snapshot_date) DO UPDATE SET
       fetched_at = EXCLUDED.fetched_at, spot = EXCLUDED.spot,
       pcr_volume = EXCLUDED.pcr_volume, pcr_oi = EXCLUDED.pcr_oi,
       net_gamma = EXCLUDED.net_gamma, gamma_flip = EXCLUDED.gamma_flip,
       call_wall = EXCLUDED.call_wall, put_wall = EXCLUDED.put_wall,
       bias = EXCLUDED.bias, payload = EXCLUDED.payload`,
    [
      metrics.symbol,
      snapshotDate,
      metrics.asOf || new Date().toISOString(),
      metrics.spot ?? null,
      metrics.pcrVolume ?? null,
      metrics.pcrOI ?? null,
      metrics.netGamma ?? null,
      metrics.gammaFlip ?? null,
      metrics.callWall ?? null,
      metrics.putWall ?? null,
      metrics.bias ?? null,
      JSON.stringify(metrics)
    ]
  );
  return snapshotDate;
}

// 每个标的取最新一天的快照。
export async function readLatestSnapshots(db) {
  const { rows } = await db.query(
    `SELECT s.* FROM option_snapshots s
     JOIN (SELECT symbol, MAX(snapshot_date) AS d FROM option_snapshots GROUP BY symbol) latest
       ON s.symbol = latest.symbol AND s.snapshot_date = latest.d`
  );
  return rows.map((row) => ({
    symbol: row.symbol,
    snapshotDate: row.snapshot_date,
    fetchedAt: row.fetched_at,
    spot: row.spot,
    pcrVolume: row.pcr_volume,
    pcrOI: row.pcr_oi,
    netGamma: row.net_gamma,
    gammaFlip: row.gamma_flip,
    callWall: row.call_wall,
    putWall: row.put_wall,
    bias: row.bias,
    detail: safeParse(row.payload)
  }));
}

export async function storeForecast(db, { snapshotDate, model, bias, confidence, payload }) {
  await db.query(
    `INSERT INTO option_forecasts (snapshot_date, model, generated_at, bias, confidence, payload)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (snapshot_date, model) DO UPDATE SET
       generated_at = EXCLUDED.generated_at, bias = EXCLUDED.bias,
       confidence = EXCLUDED.confidence, payload = EXCLUDED.payload`,
    [snapshotDate, model, new Date().toISOString(), bias ?? null, confidence ?? null, JSON.stringify(payload)]
  );
}

export async function readForecast(db, snapshotDate, model) {
  const { rows } = await db.query(
    'SELECT * FROM option_forecasts WHERE snapshot_date = $1 AND model = $2',
    [snapshotDate, model]
  );
  if (!rows[0]) return null;
  return {
    snapshotDate: rows[0].snapshot_date,
    model: rows[0].model,
    generatedAt: rows[0].generated_at,
    bias: rows[0].bias,
    confidence: rows[0].confidence,
    analysis: safeParse(rows[0].payload)
  };
}

// 最近一天的研判（任意 model）。
export async function readLatestForecast(db) {
  const { rows } = await db.query(
    'SELECT * FROM option_forecasts ORDER BY snapshot_date DESC, generated_at DESC LIMIT 1'
  );
  if (!rows[0]) return null;
  return {
    snapshotDate: rows[0].snapshot_date,
    model: rows[0].model,
    generatedAt: rows[0].generated_at,
    bias: rows[0].bias,
    confidence: rows[0].confidence,
    analysis: safeParse(rows[0].payload)
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
