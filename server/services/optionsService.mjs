import { ibkrRequest } from './ibkrClient.mjs';
import { computeOptionMetrics } from '../../src/optionsAnalytics.mjs';

// ── 配置 ──────────────────────────────────────────────────────────────────
// IBKR Client Portal API 的 snapshot 字段码。⚠️ 不同 Gateway 版本字段码可能有出入，
// 上线前务必用 dumpOptionFields() 对着真实 Gateway 核对一遍，别凭这里的默认值跑生产。
export const SNAPSHOT_FIELDS = {
  lastPrice: '31',
  impliedVol: '7283', // Option Implied Vol %
  delta: '7308',
  gamma: '7309',
  theta: '7310',
  vega: '7311',
  openInterest: '7638', // Option Open Interest
  volume: '87' // Volume
};

const TARGETS = ['SPY', 'QQQ'];
const STRIKE_BAND = 0.15; // 现价 ±15%
const MAX_EXPIRY_DAYS = 45; // ~6 周
const SNAPSHOT_BATCH = 40;
const SNAPSHOT_SETTLE_MS = 1500; // 两段式 snapshot 之间的等待

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// IBKR 的数值常带逗号/千分位后缀(K/M)/前缀符号，统一解析成 number。
export function parseIbNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value).trim().replace(/,/g, '');
  if (!text || text === 'N/A') return null;
  let multiplier = 1;
  const suffix = text.slice(-1).toUpperCase();
  if (suffix === 'K') multiplier = 1e3;
  else if (suffix === 'M') multiplier = 1e6;
  else if (suffix === 'B') multiplier = 1e9;
  if (multiplier !== 1) text = text.slice(0, -1);
  const num = Number(text);
  return Number.isFinite(num) ? num * multiplier : null;
}

// secdef/search 返回底层 conid 及可用到期月(OPT section 的 months)。
async function findUnderlying(symbol) {
  const payload = await ibkrRequest(`/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}&secType=STK`);
  const rows = Array.isArray(payload) ? payload : [];
  const match = rows.find((row) => String(row?.symbol || '').toUpperCase() === symbol) || rows[0];
  if (!match?.conid) throw new Error(`找不到 ${symbol} 的底层 conid`);
  const optSection = (match.sections || []).find((s) => s.secType === 'OPT');
  const months = optSection?.months ? String(optSection.months).split(';').filter(Boolean) : [];
  return { conid: String(match.conid), months };
}

async function snapshotFields(conids, fields) {
  if (!conids.length) return {};
  const params = new URLSearchParams({ conids: conids.join(','), fields: fields.join(',') });
  const payload = await ibkrRequest(`/iserver/marketdata/snapshot?${params.toString()}`);
  const rows = Array.isArray(payload) ? payload : [];
  const byConid = {};
  for (const row of rows) {
    if (row?.conid !== undefined) byConid[String(row.conid)] = row;
  }
  return byConid;
}

// 两段式：CPAPI 首次 snapshot 常返回不全的字段，间隔后再取一次并以后者补全。
async function snapshotTwoPass(conids, fields) {
  const merged = {};
  for (let i = 0; i < conids.length; i += SNAPSHOT_BATCH) {
    const batch = conids.slice(i, i + SNAPSHOT_BATCH);
    await snapshotFields(batch, fields); // 预热
    await sleep(SNAPSHOT_SETTLE_MS);
    const second = await snapshotFields(batch, fields);
    Object.assign(merged, second);
  }
  return merged;
}

async function getSpot(conid) {
  const snap = await snapshotFields([conid], [SNAPSHOT_FIELDS.lastPrice]);
  await sleep(800);
  const snap2 = await snapshotFields([conid], [SNAPSHOT_FIELDS.lastPrice]);
  const row = snap2[conid] || snap[conid] || {};
  return parseIbNumber(row[SNAPSHOT_FIELDS.lastPrice]);
}

function daysUntil(maturityYyyymmdd) {
  const text = String(maturityYyyymmdd || '');
  if (text.length !== 8) return Infinity;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const target = Date.UTC(year, month - 1, day);
  return Math.round((target - Date.now()) / (24 * 60 * 60 * 1000));
}

// 对一个到期月，解析落在现价 ±band 内的所有 call/put 合约 conid。
async function resolveContractsForMonth(underlyingConid, month, spot) {
  const strikePayload = await ibkrRequest(
    `/iserver/secdef/strikes?conid=${underlyingConid}&sectype=OPT&month=${encodeURIComponent(month)}`
  );
  const lower = spot * (1 - STRIKE_BAND);
  const upper = spot * (1 + STRIKE_BAND);
  const contracts = [];
  for (const right of ['C', 'P']) {
    const strikes = (strikePayload?.[right === 'C' ? 'call' : 'put'] || []).filter(
      (strike) => strike >= lower && strike <= upper
    );
    for (const strike of strikes) {
      const info = await ibkrRequest(
        `/iserver/secdef/info?conid=${underlyingConid}&sectype=OPT&month=${encodeURIComponent(month)}&strike=${strike}&right=${right}`
      );
      const rows = Array.isArray(info) ? info : [];
      for (const row of rows) {
        if (daysUntil(row.maturityDate) > MAX_EXPIRY_DAYS) continue;
        if (!row?.conid) continue;
        contracts.push({
          conid: String(row.conid),
          strike: Number(row.strike ?? strike),
          right,
          maturityDate: row.maturityDate
        });
      }
    }
  }
  return contracts;
}

// 抓单个标的完整期权指标。
export async function fetchOptionMetrics(symbol) {
  const { conid, months } = await findUnderlying(symbol);
  const spot = await getSpot(conid);
  if (!spot) throw new Error(`${symbol} 现价获取失败（市场数据权限/会话？）`);

  // 只取最近的 1~2 个到期月（已用 MAX_EXPIRY_DAYS 二次过滤具体到期日）。
  const chosenMonths = months.slice(0, 2);
  let contracts = [];
  for (const month of chosenMonths) {
    contracts = contracts.concat(await resolveContractsForMonth(conid, month, spot));
  }
  if (!contracts.length) throw new Error(`${symbol} 没有解析到符合范围的期权合约`);

  const fields = [
    SNAPSHOT_FIELDS.gamma,
    SNAPSHOT_FIELDS.delta,
    SNAPSHOT_FIELDS.impliedVol,
    SNAPSHOT_FIELDS.openInterest,
    SNAPSHOT_FIELDS.volume
  ];
  const snaps = await snapshotTwoPass(contracts.map((c) => c.conid), fields);

  const enriched = contracts.map((c) => {
    const row = snaps[c.conid] || {};
    return {
      ...c,
      gamma: parseIbNumber(row[SNAPSHOT_FIELDS.gamma]),
      delta: parseIbNumber(row[SNAPSHOT_FIELDS.delta]),
      impliedVol: parseIbNumber(row[SNAPSHOT_FIELDS.impliedVol]),
      openInterest: parseIbNumber(row[SNAPSHOT_FIELDS.openInterest]),
      volume: parseIbNumber(row[SNAPSHOT_FIELDS.volume])
    };
  });

  const asOf = new Date().toISOString();
  return computeOptionMetrics({ symbol, spot, contracts: enriched, asOf });
}

// 抓全部目标标的。单个失败不影响其它（记 error）。
export async function fetchAllOptionMetrics() {
  const results = [];
  for (const symbol of TARGETS) {
    try {
      results.push({ symbol, metrics: await fetchOptionMetrics(symbol), error: null });
    } catch (error) {
      results.push({ symbol, metrics: null, error: error.message });
    }
  }
  return results;
}

// 调试：打印某标的一个 ATM 合约的全部原始字段，用来核对 SNAPSHOT_FIELDS 字段码。
export async function dumpOptionFields(symbol = 'SPY') {
  const { conid, months } = await findUnderlying(symbol);
  const spot = await getSpot(conid);
  const contracts = await resolveContractsForMonth(conid, months[0], spot);
  const atm = contracts.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
  if (!atm) return { symbol, spot, note: '无合约' };
  // 取一大批常见字段码，看哪些有值。
  const probe = ['31', '83', '84', '86', '87', '7283', '7308', '7309', '7310', '7311', '7633', '7638', '7639', '7762'];
  await snapshotFields([atm.conid], probe);
  await sleep(SNAPSHOT_SETTLE_MS);
  const snap = await snapshotFields([atm.conid], probe);
  return { symbol, spot, atmStrike: atm.strike, conid: atm.conid, raw: snap[atm.conid] || {} };
}

export { TARGETS };
