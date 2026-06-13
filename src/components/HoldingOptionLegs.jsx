import React from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { formatMoney, hasNumber } from '../lib/format.js';

// Compact strip of option legs that sits directly under a stock row so the
// shares and the options on the same ticker read as a single position.
export function HoldingOptionLegs({ legs = [], compact = false }) {
  if (!legs.length) return null;

  return (
    <div className={`flex flex-wrap gap-1.5 ${compact ? 'pl-6 pr-3 pb-2' : ''}`}>
      {legs.map((leg) => {
        const isCall = leg.right === 'C';
        const isShort = leg.side === 'short';
        const pnl = Number(leg.unrealizedPnl);
        const qtyLabel = `${isShort ? '' : '+'}${leg.quantity}`;
        return (
          <div
            key={leg.id}
            className={`group flex items-center gap-2 rounded-lg border px-2 py-1 text-[0.66rem] leading-none transition-colors ${
              isCall
                ? 'border-emerald-200 bg-emerald-50/70 hover:bg-emerald-50'
                : 'border-rose-200 bg-rose-50/70 hover:bg-rose-50'
            }`}
            title={`${leg.label} · ${qtyLabel} 张 · ${hasNumber(Number(leg.marketValue)) ? formatMoney(Number(leg.marketValue)) : 'n/a'}`}
          >
            <span
              className={`flex h-4 min-w-[1rem] items-center justify-center rounded px-1 text-[0.58rem] font-extrabold text-white ${
                isCall ? 'bg-emerald-600' : 'bg-rose-600'
              }`}
            >
              {isCall ? 'C' : 'P'}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="font-bold tracking-tight text-[#1f2937]">
                {leg.strike != null ? leg.strike : '—'}
                <span className="ml-1 font-semibold text-[#6b7280]">{formatExpiry(leg.expiry)}</span>
              </span>
              <span className="flex items-center gap-1.5 text-[0.6rem] font-semibold text-[#7a828f]">
                <span className={isShort ? 'text-rose-600' : 'text-emerald-700'}>
                  {isShort ? <TrendingDown size={10} className="inline" /> : <TrendingUp size={10} className="inline" />}
                  {qtyLabel}张
                </span>
                {hasNumber(Number(leg.marketValue)) && (
                  <span className="text-[#5f6368]">{formatMoney(Number(leg.marketValue))}</span>
                )}
              </span>
            </span>
            {hasNumber(pnl) && (
              <span className={`ml-0.5 font-bold ${pnl >= 0 ? 'gain' : 'loss'}`}>
                {pnl >= 0 ? '+' : ''}{formatMoney(pnl)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatExpiry(expiry) {
  const iso = String(expiry || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!iso) return expiry || '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(iso[2]) - 1] || iso[2]}${iso[3]}'${iso[1].slice(2)}`;
}
