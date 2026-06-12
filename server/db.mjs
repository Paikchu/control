import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Database adapter: PostgreSQL (DATABASE_URL) in deployment, embedded PGlite
// otherwise, so `npm run api` and the test suite work without Docker.
// Both speak the same SQL dialect ($1 placeholders, ON CONFLICT, tsquery).

let backend = null;

async function createBackend() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    return {
      kind: 'postgres',
      query: (text, params = []) => pool.query(text, params),
      exec: (text) => pool.query(text),
      // Transactions need a dedicated connection when using a pool.
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn((text, params = []) => client.query(text, params));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end()
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });
  const lite = new PGlite(process.env.PGLITE_MEMORY === '1' ? undefined : join(dataDir, 'pglite'));
  const query = (text, params = []) => lite.query(text, params);
  return {
    kind: 'pglite',
    query,
    exec: (text) => lite.exec(text),
    // PGlite is single-connection, so the pool dance is unnecessary.
    tx: async (fn) => {
      await query('BEGIN');
      try {
        const result = await fn(query);
        await query('COMMIT');
        return result;
      } catch (error) {
        await query('ROLLBACK');
        throw error;
      }
    },
    close: () => lite.close()
  };
}

export async function getDb() {
  if (!backend) backend = await createBackend();
  return backend;
}

export const schemaSql = `
  CREATE TABLE IF NOT EXISTS price_cache (
    ticker TEXT NOT NULL,
    range_key TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (ticker, range_key)
  );

  CREATE TABLE IF NOT EXISTS sec_cache (
    cache_key TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sec_report_versions (
    ticker TEXT NOT NULL,
    version_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    latest_accession_number TEXT,
    payload TEXT NOT NULL,
    PRIMARY KEY (ticker, version_id)
  );

  CREATE TABLE IF NOT EXISTS sec_report_facts (
    ticker TEXT NOT NULL,
    period TEXT NOT NULL,
    metric TEXT NOT NULL,
    value DOUBLE PRECISION,
    source_tag TEXT,
    accession_number TEXT,
    filed TEXT,
    PRIMARY KEY (ticker, period, metric)
  );

  CREATE TABLE IF NOT EXISTS sec_filing_summaries (
    ticker TEXT NOT NULL,
    accession_number TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (ticker, accession_number)
  );

  CREATE TABLE IF NOT EXISTS sec_filing_extracts (
    ticker            TEXT NOT NULL,
    accession_number  TEXT NOT NULL,
    form              TEXT,
    filing_date       TEXT,
    report_date       TEXT,
    kind              TEXT NOT NULL,
    label             TEXT NOT NULL,
    period            TEXT NOT NULL DEFAULT '',
    value             DOUBLE PRECISION,
    unit              TEXT,
    detail            TEXT,
    quote             TEXT,
    importance        TEXT,
    generated_at      TEXT NOT NULL,
    PRIMARY KEY (ticker, accession_number, kind, label, period)
  );

  CREATE TABLE IF NOT EXISTS sec_filing_extract_status (
    ticker            TEXT NOT NULL,
    accession_number  TEXT NOT NULL,
    status            TEXT NOT NULL,
    reason            TEXT,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (ticker, accession_number)
  );

  CREATE TABLE IF NOT EXISTS holding_thesis_checks (
    ticker                   TEXT NOT NULL,
    thesis_hash              TEXT NOT NULL,
    latest_accession_number  TEXT NOT NULL,
    thesis_text              TEXT,
    payload                  TEXT NOT NULL,
    generated_at             TEXT NOT NULL,
    PRIMARY KEY (ticker, thesis_hash, latest_accession_number)
  );

  CREATE TABLE IF NOT EXISTS sec_filing_chunks (
    ticker TEXT NOT NULL,
    accession_number TEXT NOT NULL,
    form TEXT,
    filing_date TEXT,
    section TEXT,
    chunk_text TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ibkr_accounts (
    provider TEXT NOT NULL DEFAULT 'ibkr',
    account_id TEXT NOT NULL,
    account_title TEXT,
    last_sync_at TEXT,
    payload TEXT,
    PRIMARY KEY (provider, account_id)
  );

  CREATE TABLE IF NOT EXISTS ibkr_positions (
    provider TEXT NOT NULL DEFAULT 'ibkr',
    account_id TEXT NOT NULL,
    conid TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    sec_type TEXT,
    currency TEXT,
    quantity DOUBLE PRECISION,
    avg_cost DOUBLE PRECISION,
    market_price DOUBLE PRECISION,
    market_value DOUBLE PRECISION,
    unrealized_pnl DOUBLE PRECISION,
    realized_pnl DOUBLE PRECISION,
    fetched_at TEXT NOT NULL,
    closed_at TEXT,
    payload TEXT,
    PRIMARY KEY (provider, account_id, conid)
  );

  CREATE TABLE IF NOT EXISTS ibkr_balances (
    provider TEXT NOT NULL DEFAULT 'ibkr',
    account_id TEXT NOT NULL,
    currency TEXT NOT NULL,
    cash_balance DOUBLE PRECISION,
    net_liquidation DOUBLE PRECISION,
    market_value DOUBLE PRECISION,
    fetched_at TEXT NOT NULL,
    payload TEXT,
    PRIMARY KEY (provider, account_id, currency)
  );

  CREATE TABLE IF NOT EXISTS ibkr_sync_runs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'ibkr',
    account_id TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    position_count INTEGER NOT NULL,
    balance_count INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_extracts_ticker ON sec_filing_extracts(ticker, kind);
  CREATE INDEX IF NOT EXISTS idx_extract_status_ticker ON sec_filing_extract_status(ticker);
  CREATE INDEX IF NOT EXISTS idx_chunks_ticker ON sec_filing_chunks(ticker, accession_number);
  CREATE INDEX IF NOT EXISTS idx_chunks_fts ON sec_filing_chunks
    USING GIN (to_tsvector('english', chunk_text));
`;

export async function initSchema(db) {
  await db.exec(schemaSql);
}
