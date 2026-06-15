const supportedSecurityTypes = new Set(['STK', 'ETF']);
const optionSecurityTypes = new Set(['OPT', 'FOP']);

function firstValue(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return null;
}

function cleanText(value) {
  return String(value || '').trim();
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanSymbol(value) {
  return cleanText(value).toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 20);
}

function normalizeOptionRight(value) {
  const text = cleanText(value).toUpperCase();
  if (text.startsWith('C')) return 'C';
  if (text.startsWith('P')) return 'P';
  return '';
}

// IBKR hands back expiries as YYYYMMDD (sometimes YYMMDD); normalize to ISO so
// the frontend can format them however it likes.
function normalizeOptionExpiry(value) {
  const text = cleanText(value);
  const full = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;
  const short = text.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (short) return `20${short[1]}-${short[2]}-${short[3]}`;
  return text;
}

const monthAbbr = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Compact, human-readable leg label, e.g. "AAPL 200C Jun'26".
function buildOptionLabel({ underlying, right, strike, expiry, fallback }) {
  const parts = [];
  if (underlying) parts.push(underlying);
  if (strike != null && right) {
    parts.push(`${strike}${right}`);
  } else if (strike != null) {
    parts.push(String(strike));
  } else if (right) {
    parts.push(right === 'C' ? 'CALL' : 'PUT');
  }
  const iso = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const month = monthAbbr[Number(iso[2]) - 1] || iso[2];
    parts.push(`${month}'${iso[1].slice(2)}`);
  } else if (expiry) {
    parts.push(expiry);
  }
  return parts.join(' ') || fallback || '';
}

// 新的 /portfolio2 端点的期权行不带 undSym/strike/putOrCall/expiry 等结构化字段，
// 标的、行权价、方向、到期全编码在 description 里，例如：
//   "NVDA   JAN2027 180 P [NVDA  270115P00180000 100]"
// 优先解析方括号里的 OCC 代码（ROOT YYMMDD{C|P}STRIKE×1000 MULT），最精确；
// 没有方括号时退化解析可读部分。解析失败返回 null，让结构化字段照常生效。
function parseOptionDescription(desc) {
  const text = cleanText(desc);
  if (!text) return null;
  const occ = text.match(/\[([A-Za-z.]+)\s+(\d{6})([CP])(\d{8})(?:\s+(\d+))?\]/);
  if (occ) {
    return {
      underlying: cleanSymbol(occ[1]),
      expiry: `20${occ[2].slice(0, 2)}-${occ[2].slice(2, 4)}-${occ[2].slice(4, 6)}`,
      right: occ[3],
      strike: parseInt(occ[4], 10) / 1000,
      multiplier: occ[5] ? Number(occ[5]) : null
    };
  }
  const readable = text.match(/^([A-Za-z.]+)\s+([A-Z]{3})(\d{4})\s+([\d.]+)\s+([CP])/);
  if (readable) {
    const month = monthAbbr.indexOf(readable[2].toUpperCase()) + 1;
    return {
      underlying: cleanSymbol(readable[1]),
      // 可读部分没有「日」，只能给到月，留空 day 避免编造错误日期。
      expiry: month ? `${readable[3]}-${String(month).padStart(2, '0')}` : '',
      right: readable[5],
      strike: numberOrNull(readable[4]),
      multiplier: null
    };
  }
  return null;
}

// IBKR option rows carry the underlying ticker plus contract specifics. We key
// the row on the option's own conid but expose `symbol` as the *underlying* so
// the frontend can fold the leg into the matching share position.
function normalizeOptionPosition(raw, conid) {
  const contractDesc = cleanText(firstValue(raw, ['contractDesc', 'description', 'localSymbol']));
  // /portfolio2 端点只给 description；老端点给结构化字段。结构化字段优先，description 兜底。
  const parsed = parseOptionDescription(contractDesc) || {};
  const underlying = cleanSymbol(firstValue(raw, ['undSym', 'underSymbol', 'underlyingSymbol', 'ticker', 'symbol'])) || parsed.underlying || '';
  if (!conid || !underlying) return null;

  const quantity = numberOrNull(firstValue(raw, ['position', 'quantity', 'qty']));
  const marketPrice = numberOrNull(firstValue(raw, ['mktPrice', 'marketPrice', 'price']));
  const multiplier = numberOrNull(firstValue(raw, ['multiplier', 'mult'])) || parsed.multiplier || 100;
  const marketValue = numberOrNull(firstValue(raw, ['mktValue', 'marketValue', 'value'])) ?? (
    quantity !== null && marketPrice !== null ? quantity * marketPrice * multiplier : null
  );
  const right = normalizeOptionRight(firstValue(raw, ['putOrCall', 'right', 'optType', 'callPut'])) || parsed.right || '';
  const strike = numberOrNull(firstValue(raw, ['strike', 'strikePrice'])) ?? (parsed.strike ?? null);
  const expiryRaw = firstValue(raw, ['expiry', 'lastTradingDay', 'maturityDate', 'expirationDate']);
  const expiry = expiryRaw ? normalizeOptionExpiry(expiryRaw) : (parsed.expiry || '');

  return {
    conid,
    symbol: underlying,
    name: cleanText(firstValue(raw, ['undComp', 'name', 'companyName'])) || underlying,
    secType: 'OPT',
    currency: cleanText(firstValue(raw, ['currency', 'listingExchangeCurrency'])) || 'USD',
    quantity,
    avgCost: numberOrNull(firstValue(raw, ['avgCost', 'avgPrice', 'averageCost', 'costBasisPrice'])),
    marketPrice,
    marketValue,
    unrealizedPnl: numberOrNull(firstValue(raw, ['unrealizedPnl', 'unrealizedPNL', 'unrealizedP&L'])),
    realizedPnl: numberOrNull(firstValue(raw, ['realizedPnl', 'realizedPNL', 'realizedP&L'])),
    underlying,
    right,
    strike,
    expiry,
    multiplier,
    optionLabel: buildOptionLabel({ underlying, right, strike, expiry, fallback: contractDesc })
  };
}

// `db` is the adapter from server/db.mjs: { query(text, params), exec(text), tx(fn) }.
export async function initIbkrTables(db) {
  await db.exec(`
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
  `);
}

export function normalizeIbkrAccount(raw) {
  const accountId = cleanText(firstValue(raw, ['accountId', 'accountIdKey', 'id', 'account']));
  if (!accountId) return null;
  return {
    accountId,
    accountTitle: cleanText(firstValue(raw, ['accountTitle', 'accountAlias', 'alias', 'desc', 'name'])) || accountId,
    raw
  };
}

export function normalizeIbkrPosition(raw) {
  const secType = cleanText(firstValue(raw, ['assetClass', 'secType', 'sectype', 'securityType'])).toUpperCase();
  const conid = cleanText(firstValue(raw, ['conid', 'conId', 'contract_id', 'contractId']));

  if (optionSecurityTypes.has(secType)) return normalizeOptionPosition(raw, conid);
  if (!supportedSecurityTypes.has(secType)) return null;

  const symbol = cleanSymbol(firstValue(raw, ['ticker', 'symbol', 'contractDesc', 'description', 'localSymbol']));
  if (!conid || !symbol) return null;

  const quantity = numberOrNull(firstValue(raw, ['position', 'quantity', 'qty']));
  const marketPrice = numberOrNull(firstValue(raw, ['mktPrice', 'marketPrice', 'price']));
  const marketValue = numberOrNull(firstValue(raw, ['mktValue', 'marketValue', 'value'])) ?? (
    quantity !== null && marketPrice !== null ? quantity * marketPrice : null
  );

  return {
    conid,
    symbol,
    name: cleanText(firstValue(raw, ['name', 'companyName', 'description'])) || symbol,
    secType,
    currency: cleanText(firstValue(raw, ['currency', 'listingExchangeCurrency'])) || 'USD',
    quantity,
    avgCost: numberOrNull(firstValue(raw, ['avgCost', 'avgPrice', 'averageCost', 'costBasisPrice'])),
    marketPrice,
    marketValue,
    unrealizedPnl: numberOrNull(firstValue(raw, ['unrealizedPnl', 'unrealizedPNL', 'unrealizedP&L'])),
    realizedPnl: numberOrNull(firstValue(raw, ['realizedPnl', 'realizedPNL', 'realizedP&L']))
  };
}

export function normalizeIbkrBalance(raw) {
  const currency = cleanText(firstValue(raw, ['currency', 'Currency'])).toUpperCase();
  if (!currency) return null;
  return {
    currency,
    cashBalance: numberOrNull(firstValue(raw, ['cashBalance', 'cashbalance', 'cash', 'totalCash', 'settledCash', 'settledcash'])),
    netLiquidation: numberOrNull(firstValue(raw, ['netLiquidation', 'netLiquidationValue', 'netliquidationvalue', 'nlv'])),
    marketValue: numberOrNull(firstValue(raw, ['marketValue', 'marketvalue', 'stockMarketValue', 'stockmarketvalue', 'securitiesGrossPositionValue'])),
    raw
  };
}

export async function storeIbkrSync(db, { account, positions, balances = [], syncedAt = new Date().toISOString() }) {
  const normalizedAccount = normalizeIbkrAccount(account) || account;
  const accountId = cleanText(normalizedAccount.accountId);
  if (!accountId) throw new Error('IBKR accountId is required');

  const normalizedPositions = positions.map((position) => normalizeIbkrPosition(position) || position).filter((position) => position?.conid && position?.symbol);
  const normalizedBalances = balances.map((balance) => normalizeIbkrBalance(balance) || balance).filter((balance) => balance?.currency);

  await db.tx(async (query) => {
    await query(`
      INSERT INTO ibkr_accounts (provider, account_id, account_title, last_sync_at, payload)
      VALUES ('ibkr', $1, $2, $3, $4)
      ON CONFLICT (provider, account_id) DO UPDATE SET
        account_title = EXCLUDED.account_title,
        last_sync_at = EXCLUDED.last_sync_at,
        payload = EXCLUDED.payload
    `, [accountId, normalizedAccount.accountTitle || accountId, syncedAt, JSON.stringify(normalizedAccount.raw || account)]);

    for (const position of normalizedPositions) {
      await query(`
        INSERT INTO ibkr_positions (
          provider, account_id, conid, symbol, name, sec_type, currency, quantity, avg_cost,
          market_price, market_value, unrealized_pnl, realized_pnl, fetched_at, closed_at, payload
        )
        VALUES ('ibkr', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, $14)
        ON CONFLICT (provider, account_id, conid) DO UPDATE SET
          symbol = EXCLUDED.symbol,
          name = EXCLUDED.name,
          sec_type = EXCLUDED.sec_type,
          currency = EXCLUDED.currency,
          quantity = EXCLUDED.quantity,
          avg_cost = EXCLUDED.avg_cost,
          market_price = EXCLUDED.market_price,
          market_value = EXCLUDED.market_value,
          unrealized_pnl = EXCLUDED.unrealized_pnl,
          realized_pnl = EXCLUDED.realized_pnl,
          fetched_at = EXCLUDED.fetched_at,
          closed_at = NULL,
          payload = EXCLUDED.payload
      `, [
        accountId,
        String(position.conid),
        position.symbol,
        position.name || position.symbol,
        position.secType || 'STK',
        position.currency || 'USD',
        position.quantity,
        position.avgCost,
        position.marketPrice,
        position.marketValue,
        position.unrealizedPnl,
        position.realizedPnl,
        syncedAt,
        JSON.stringify(position)
      ]);
    }

    for (const balance of normalizedBalances) {
      await query(`
        INSERT INTO ibkr_balances (provider, account_id, currency, cash_balance, net_liquidation, market_value, fetched_at, payload)
        VALUES ('ibkr', $1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (provider, account_id, currency) DO UPDATE SET
          cash_balance = EXCLUDED.cash_balance,
          net_liquidation = EXCLUDED.net_liquidation,
          market_value = EXCLUDED.market_value,
          fetched_at = EXCLUDED.fetched_at,
          payload = EXCLUDED.payload
      `, [
        accountId,
        balance.currency,
        balance.cashBalance,
        balance.netLiquidation,
        balance.marketValue,
        syncedAt,
        JSON.stringify(balance.raw || balance)
      ]);
    }

    const keptConids = normalizedPositions.map((position) => String(position.conid));
    await query(`
      UPDATE ibkr_positions
      SET closed_at = $1
      WHERE provider = 'ibkr'
        AND account_id = $2
        AND closed_at IS NULL
        AND NOT (conid = ANY($3))
    `, [syncedAt, accountId, keptConids]);

    await query(`
      INSERT INTO ibkr_sync_runs (provider, account_id, synced_at, position_count, balance_count)
      VALUES ('ibkr', $1, $2, $3, $4)
    `, [accountId, syncedAt, normalizedPositions.length, normalizedBalances.length]);
  });

  return { account: normalizedAccount, positions: normalizedPositions, balances: normalizedBalances, syncedAt };
}

export async function readIbkrSnapshot(db, accountId = null) {
  const accountResult = accountId
    ? await db.query('SELECT * FROM ibkr_accounts WHERE provider = $1 AND account_id = $2', ['ibkr', accountId])
    : await db.query('SELECT * FROM ibkr_accounts WHERE provider = $1 ORDER BY last_sync_at DESC LIMIT 1', ['ibkr']);
  const account = accountResult.rows[0];
  if (!account) return { account: null, positions: [], balances: [], lastSyncAt: null };

  const { rows: positions } = await db.query(`
    SELECT * FROM ibkr_positions
    WHERE provider = 'ibkr' AND account_id = $1 AND closed_at IS NULL
    ORDER BY market_value DESC, symbol
  `, [account.account_id]);
  const { rows: balances } = await db.query(`
    SELECT * FROM ibkr_balances
    WHERE provider = 'ibkr' AND account_id = $1
    ORDER BY currency
  `, [account.account_id]);

  return {
    account: {
      accountId: account.account_id,
      accountTitle: account.account_title || account.account_id
    },
    positions: positions.map((position) => {
      const base = {
        conid: position.conid,
        symbol: position.symbol,
        name: position.name || position.symbol,
        secType: position.sec_type,
        currency: position.currency,
        quantity: position.quantity,
        avgCost: position.avg_cost,
        marketPrice: position.market_price,
        marketValue: position.market_value,
        unrealizedPnl: position.unrealized_pnl,
        realizedPnl: position.realized_pnl,
        fetchedAt: position.fetched_at,
        source: 'ibkr'
      };
      // Option specifics (strike / right / expiry / label) only live in the
      // stored payload, so unpack them back onto the snapshot for OPT rows.
      if (position.sec_type === 'OPT') {
        let extra = {};
        try { extra = JSON.parse(position.payload || '{}'); } catch { extra = {}; }
        return {
          ...base,
          underlying: extra.underlying || position.symbol,
          right: extra.right || '',
          strike: extra.strike ?? null,
          expiry: extra.expiry || '',
          multiplier: extra.multiplier || 100,
          optionLabel: extra.optionLabel || ''
        };
      }
      return base;
    }),
    balances: balances.map((balance) => ({
      currency: balance.currency,
      cashBalance: balance.cash_balance,
      netLiquidation: balance.net_liquidation,
      marketValue: balance.market_value,
      fetchedAt: balance.fetched_at
    })),
    lastSyncAt: account.last_sync_at
  };
}
