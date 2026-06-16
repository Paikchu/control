import React from 'react';
import { ChevronDown, ChevronRight, Trash2, TrendingUp, TrendingDown } from 'lucide-react';
import { holdingWeightPercent } from '../ibkrCash.mjs';
import { formatMoney, hasNumber } from '../lib/format.js';
import { useFlash } from '../lib/useFlash.js';
import { Sparkline } from './Sparkline.jsx';

// 一个 ticker = 轻量分组头（只放股价 + 今日涨跌幅）+ 二级菜单里平权的子行：
// 正股一行、每条期权腿一行，各自带市值与盈亏，正股和期权重要性相同。
export function HoldingTickerGroup({
  holding,
  isOpen,
  isIbkr,
  companyName,
  dailyChangePct,
  lastClose,
  portfolioTotalValue,
  expanded,
  onToggle,
  onSelect,
  onRemove
}) {
  const legs = Array.isArray(holding.options) ? holding.options : [];
  const showShareRow = !holding.optionsOnly;
  const shareValue = Number(holding.marketValue)
    || (Number(holding.shares) || 0) * (Number(holding.marketPrice ?? holding.cost) || 0);
  const shareWeight = holdingWeightPercent(shareValue, portfolioTotalValue);
  const sharePnl = Number(holding.unrealizedPnl);
  // Number(null) 会变 0，会让纯期权 ticker 的行头显示 $0；缺价时保留 NaN → 显示 n/a。
  // 纯期权仓位没有 IBKR 正股价格，回退到 Yahoo 日线收盘价（lastClose）。
  const marketPrice = holding.marketPrice == null
    ? (Number.isFinite(Number(lastClose)) ? Number(lastClose) : NaN)
    : Number(holding.marketPrice);

  const priceFlash = useFlash(Number.isFinite(marketPrice) ? marketPrice : null);
  const pnlFlash = useFlash(hasNumber(sharePnl) ? sharePnl : null);

  // 子行右侧两列固定宽，和 sticky 表头对齐：市值列 / 盈亏列。
  // 注意：不要用 Tailwind 的 `block` 工具类——本项目 styles.css 有同名 `.block`
  // 卡片样式会冲突（见记忆 tailwind-setup）。用 flex-col 排版避开。
  const valueCol = 'flex w-[86px] shrink-0 items-baseline justify-end gap-1.5';
  const pnlCol = 'flex w-[72px] shrink-0 items-center justify-end';

  return (
    <div className={`border-b border-b-[#eceff2] ${isOpen ? 'bg-[#eef4ff] [box-shadow:inset_3px_0_0_#0b57d0]' : 'bg-white'}`}>
      {/* 分组头：ticker + 公司名 + 今日股价/涨跌幅 */}
      <div className="flex items-center gap-1 pl-3 pr-3">
        <button
          type="button"
          className="flex h-7 w-6 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-[#9aa3b0] cursor-pointer hover:text-[#5f6368]"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? `收起 ${holding.symbol} 明细` : `展开 ${holding.symbol} 明细`}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent py-1.5 text-left cursor-pointer"
          onClick={() => onSelect(holding.id)}
          aria-pressed={isOpen}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <span className="text-[0.9rem] font-[790] tracking-[0.01em] text-[#202124] shrink-0">
              {holding.symbol || 'TICKER'}
            </span>
            {legs.length > 0 && (
              <em className="shrink-0 rounded-full bg-[#eef2ff] px-1.5 py-0.5 text-[0.52rem] font-bold not-italic tracking-wide text-[#4f46e5]">
                {legs.length} 期权
              </em>
            )}
            <span className="min-w-0 truncate text-[0.64rem] font-[520] text-[#9aa3b0]">
              {companyName || holding.name || ''}
            </span>
          </span>
          <Sparkline symbol={holding.symbol} width={72} height={22} />
          {/* 价格 + 涨跌幅横排 */}
          <span className="flex shrink-0 items-center gap-1.5 pr-1">
            <strong className={`text-[0.95rem] font-[760] leading-none text-[#202124] ${priceFlash ? `flash-${priceFlash}` : ''}`}>
              {hasNumber(marketPrice) ? formatMoney(marketPrice) : 'n/a'}
            </strong>
            {Number.isFinite(dailyChangePct) && (
              <span className={`flex items-center gap-0.5 text-[0.7rem] font-[720] leading-none ${dailyChangePct >= 0 ? 'gain' : 'loss'}`}>
                <span aria-hidden="true" className="text-[0.58rem]">{dailyChangePct >= 0 ? '▲' : '▼'}</span>
                {`${dailyChangePct >= 0 ? '+' : ''}${dailyChangePct.toFixed(2)}%`}
              </span>
            )}
          </span>
        </button>
      </div>

      {/* 二级菜单：正股 + 期权腿，平权子行 */}
      {expanded && (
        <div className="pb-0.5">
          {showShareRow && (
            <div
              className="group flex min-h-[1.75rem] cursor-pointer items-center gap-2 py-0.5 pl-9 pr-3 hover:bg-[#f5f8fd]"
              onClick={() => onSelect(holding.id)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="flex h-4 min-w-[2.2rem] items-center justify-center rounded bg-[#eef1f6] px-1.5 text-[0.58rem] font-extrabold tracking-wide text-[#4b5563]">正股</span>
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="text-[0.7rem] font-[680] text-[#374151]">
                    {Number(holding.shares) || 0} 股
                  </span>
                  {hasNumber(Number(holding.cost)) && Number(holding.cost) > 0 && (
                    <span className="text-[0.61rem] font-[520] text-[#9aa3b0]">成本 {isIbkr ? Number(holding.cost).toFixed(1) : holding.cost}</span>
                  )}
                </span>
              </span>
              <span className={valueCol}>
                <span className="text-[0.74rem] font-[720] leading-[1.2] text-[#303134]">{formatMoney(shareValue)}</span>
                <span className="text-[0.62rem] font-[640] leading-[1.2] text-[#9aa3b0]">{shareWeight === null ? 'n/a' : `${shareWeight.toFixed(2)}%`}</span>
              </span>
              <span className={pnlCol}>
                <span className={`text-[0.74rem] font-[720] leading-[1.2] ${hasNumber(sharePnl) ? (sharePnl >= 0 ? 'gain' : 'loss') : 'text-[#9aa3b0]'} ${pnlFlash ? `flash-${pnlFlash}` : ''}`}>
                  {hasNumber(sharePnl) ? formatMoney(sharePnl) : 'n/a'}
                </span>
              </span>
              {!isIbkr ? (
                <button
                  type="button"
                  className="flex h-6 w-5 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-[#c2c8d0] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#ef4444] cursor-pointer"
                  onClick={(event) => { event.stopPropagation(); onRemove(holding.id); }}
                  aria-label={`删除 ${holding.symbol || '股票'}`}
                >
                  <Trash2 size={13} />
                </button>
              ) : <span className="w-5 shrink-0" aria-hidden="true" />}
            </div>
          )}

          {legs.map((leg) => {
            const isCall = leg.right === 'C';
            const isShort = leg.side === 'short';
            const legPnl = Number(leg.unrealizedPnl);
            const legValue = Number(leg.marketValue);
            const legWeight = holdingWeightPercent(legValue, portfolioTotalValue);
            return (
              <div
                key={leg.id}
                className="group flex min-h-[1.75rem] cursor-pointer items-center gap-2 py-0.5 pl-9 pr-3 hover:bg-[#f5f8fd]"
                onClick={() => onSelect(holding.id)}
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  {/* 方向 badge：买/卖 */}
                  <span className={`flex h-4 items-center justify-center rounded px-1.5 text-[0.56rem] font-extrabold tracking-wide text-white ${isShort ? 'bg-rose-600' : 'bg-emerald-600'}`}>
                    {isShort ? '卖' : '买'}
                  </span>
                  {/* 期权类型 badge：C/P */}
                  <span className={`flex h-4 w-4 items-center justify-center rounded text-[0.56rem] font-extrabold text-white ${isCall ? 'bg-emerald-500' : 'bg-rose-500'}`}>
                    {isCall ? 'C' : 'P'}
                  </span>
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="text-[0.7rem] font-[680] text-[#374151]">
                      {leg.strike != null ? leg.strike : '—'}
                    </span>
                    <span className="text-[0.61rem] font-[520] text-[#9aa3b0]">{formatExpiry(leg.expiry)}</span>
                    <span className={`text-[0.61rem] font-[620] ${isShort ? 'text-rose-600' : 'text-emerald-700'}`}>
                      {isShort ? '-' : '+'}{Math.abs(leg.quantity)}张
                    </span>
                  </span>
                </span>
                <span className={valueCol}>
                  <span className="text-[0.74rem] font-[720] leading-[1.2] text-[#303134]">{hasNumber(legValue) ? formatMoney(legValue) : 'n/a'}</span>
                  <span className="text-[0.62rem] font-[640] leading-[1.2] text-[#9aa3b0]">{legWeight === null ? 'n/a' : `${legWeight.toFixed(2)}%`}</span>
                </span>
                <span className={pnlCol}>
                  <span className={`text-[0.74rem] font-[720] leading-[1.2] ${hasNumber(legPnl) ? (legPnl >= 0 ? 'gain' : 'loss') : 'text-[#9aa3b0]'}`}>
                    {hasNumber(legPnl) ? formatMoney(legPnl) : 'n/a'}
                  </span>
                </span>
                <span className="w-5 shrink-0" aria-hidden="true" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatExpiry(expiry) {
  const iso = String(expiry || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!iso) return expiry || '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(iso[2]) - 1] || iso[2]}${iso[3]}'${iso[1].slice(2)}`;
}
