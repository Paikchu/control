// 收盘后定时刷新期权研判：poke 已在本地运行的 API 的 /api/options/refresh。
// 与 DB 后端解耦——只要 app + IBKR Gateway 处于登录状态即可。
//
// 用法：
//   node scripts/refresh-options.mjs
//   OPTIONS_API_BASE=http://127.0.0.1:8787 node scripts/refresh-options.mjs
//
// 建议用系统调度在每个交易日美股收盘后（含 OI EOD 更新）跑一次，例如 macOS launchd / crontab：
//   # 周一至周五 16:45 美东 ≈ crontab 用本机时区换算后填入
//   45 16 * * 1-5  cd /Users/max/Developer/portfolio-backtest-app && /usr/local/bin/node scripts/refresh-options.mjs >> /tmp/options-refresh.log 2>&1
// （注意：crontab 用的是本机时区，请按美东收盘时间换算；节假日休市时刷新会失败并跳过，不影响下次。）

const base = process.env.OPTIONS_API_BASE || 'http://127.0.0.1:8787';

async function main() {
  const url = `${base.replace(/\/$/, '')}/api/options/refresh`;
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: false })
  });
  const took = ((Date.now() - started) / 1000).toFixed(1);
  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error(`[options-refresh] HTTP ${res.status} (${took}s):`, payload.error || payload);
    process.exit(1);
  }

  const symbols = (payload.snapshots || []).map((s) => `${s.symbol}@${s.snapshotDate}`).join(', ') || '无';
  const bias = payload.forecast?.bias || payload.forecast?.analysis?.bias || '—';
  console.log(`[options-refresh] ok (${took}s) 快照: ${symbols} | 研判: ${bias}`);
  if (payload.errors?.length) {
    for (const e of payload.errors) console.warn(`[options-refresh] ${e.symbol}: ${e.error}`);
  }
}

main().catch((err) => {
  console.error('[options-refresh] 失败:', err.message);
  process.exit(1);
});
