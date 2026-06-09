const supportedSecurityTypes = new Set(['STK', 'ETF']);

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

export function initIbkrTables(db) {
  db.exec(`
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
      quantity REAL,
      avg_cost REAL,
      market_price REAL,
      market_value REAL,
      unrealized_pnl REAL,
      realized_pnl REAL,
      fetched_at TEXT NOT NULL,
      closed_at TEXT,
      payload TEXT,
      PRIMARY KEY (provider, account_id, conid)
    );

    CREATE TABLE IF NOT EXISTS ibkr_balances (
      provider TEXT NOT NULL DEFAULT 'ibkr',
      account_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      cash_balance REAL,
      net_liquidation REAL,
      market_value REAL,
      fetched_at TEXT NOT NULL,
      payload TEXT,
      PRIMARY KEY (provider, account_id, currency)
    );

    CREATE TABLE IF NOT EXISTS ibkr_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  if (!supportedSecurityTypes.has(secType)) return null;

  const conid = cleanText(firstValue(raw, ['conid', 'conId', 'contract_id', 'contractId']));
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

export function storeIbkrSync(db, { account, positions, balances = [], syncedAt = new Date().toISOString() }) {
  initIbkrTables(db);
  const normalizedAccount = normalizeIbkrAccount(account) || account;
  const accountId = cleanText(normalizedAccount.accountId);
  if (!accountId) throw new Error('IBKR accountId is required');

  const normalizedPositions = positions.map((position) => normalizeIbkrPosition(position) || position).filter((position) => position?.conid && position?.symbol);
  const normalizedBalances = balances.map((balance) => normalizeIbkrBalance(balance) || balance).filter((balance) => balance?.currency);

  const putAccount = db.prepare(`
    INSERT INTO ibkr_accounts (provider, account_id, account_title, last_sync_at, payload)
    VALUES ('ibkr', ?, ?, ?, ?)
    ON CONFLICT(provider, account_id) DO UPDATE SET
      account_title = excluded.account_title,
      last_sync_at = excluded.last_sync_at,
      payload = excluded.payload
  `);
  const putPosition = db.prepare(`
    INSERT INTO ibkr_positions (
      provider, account_id, conid, symbol, name, sec_type, currency, quantity, avg_cost,
      market_price, market_value, unrealized_pnl, realized_pnl, fetched_at, closed_at, payload
    )
    VALUES ('ibkr', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(provider, account_id, conid) DO UPDATE SET
      symbol = excluded.symbol,
      name = excluded.name,
      sec_type = excluded.sec_type,
      currency = excluded.currency,
      quantity = excluded.quantity,
      avg_cost = excluded.avg_cost,
      market_price = excluded.market_price,
      market_value = excluded.market_value,
      unrealized_pnl = excluded.unrealized_pnl,
      realized_pnl = excluded.realized_pnl,
      fetched_at = excluded.fetched_at,
      closed_at = NULL,
      payload = excluded.payload
  `);
  const putBalance = db.prepare(`
    INSERT INTO ibkr_balances (provider, account_id, currency, cash_balance, net_liquidation, market_value, fetched_at, payload)
    VALUES ('ibkr', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, account_id, currency) DO UPDATE SET
      cash_balance = excluded.cash_balance,
      net_liquidation = excluded.net_liquidation,
      market_value = excluded.market_value,
      fetched_at = excluded.fetched_at,
      payload = excluded.payload
  `);
  const putRun = db.prepare(`
    INSERT INTO ibkr_sync_runs (provider, account_id, synced_at, position_count, balance_count)
    VALUES ('ibkr', ?, ?, ?, ?)
  `);
  const closeMissing = db.prepare(`
    UPDATE ibkr_positions
    SET closed_at = ?
    WHERE provider = 'ibkr'
      AND account_id = ?
      AND closed_at IS NULL
      AND conid NOT IN (${normalizedPositions.map(() => '?').join(',') || "''"})
  `);

  db.exec('BEGIN');
  try {
    putAccount.run(accountId, normalizedAccount.accountTitle || accountId, syncedAt, JSON.stringify(normalizedAccount.raw || account));
    normalizedPositions.forEach((position) => {
      putPosition.run(
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
      );
    });
    normalizedBalances.forEach((balance) => {
      putBalance.run(
        accountId,
        balance.currency,
        balance.cashBalance,
        balance.netLiquidation,
        balance.marketValue,
        syncedAt,
        JSON.stringify(balance.raw || balance)
      );
    });
    closeMissing.run(syncedAt, accountId, ...normalizedPositions.map((position) => String(position.conid)));
    putRun.run(accountId, syncedAt, normalizedPositions.length, normalizedBalances.length);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { account: normalizedAccount, positions: normalizedPositions, balances: normalizedBalances, syncedAt };
}

export function readIbkrSnapshot(db, accountId = null) {
  initIbkrTables(db);
  const account = accountId
    ? db.prepare('SELECT * FROM ibkr_accounts WHERE provider = ? AND account_id = ?').get('ibkr', accountId)
    : db.prepare('SELECT * FROM ibkr_accounts WHERE provider = ? ORDER BY last_sync_at DESC LIMIT 1').get('ibkr');
  if (!account) return { account: null, positions: [], balances: [], lastSyncAt: null };

  const positions = db.prepare(`
    SELECT * FROM ibkr_positions
    WHERE provider = 'ibkr' AND account_id = ? AND closed_at IS NULL
    ORDER BY market_value DESC, symbol
  `).all(account.account_id);
  const balances = db.prepare(`
    SELECT * FROM ibkr_balances
    WHERE provider = 'ibkr' AND account_id = ?
    ORDER BY currency
  `).all(account.account_id);

  return {
    account: {
      accountId: account.account_id,
      accountTitle: account.account_title || account.account_id
    },
    positions: positions.map((position) => ({
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
    })),
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
