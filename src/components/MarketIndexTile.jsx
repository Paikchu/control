import React from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { indexNumberFormat } from '../lib/format.js';

const BIAS_META = {
  bullish: { label: '偏多', cls: 'bull' },
  bearish: { label: '偏空', cls: 'bear' },
  neutral: { label: '中性', cls: 'flat' }
};

function biasMeta(bias) {
  return BIAS_META[bias] || { label: '—', cls: 'flat' };
}

function fmtNum(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

// Net Gamma 单位是 $/1% 标的变动，数值大，用百万($M)展示。
function fmtGamma(value) {
  if (!Number.isFinite(value)) return '—';
  const millions = value / 1e6;
  return `${millions >= 0 ? '+' : ''}${millions.toFixed(0)}M`;
}

// 一个大盘指数卡片。S&P 500 / Nasdaq 这两个会带上 SPY / QQQ 的期权研判，
// 直接嵌在卡片里（不再藏在 pill 弹层后面）。
export function MarketIndexTile({ index, options }) {
  const up = index.change >= 0;
  const bias = options ? biasMeta(options.bias) : null;

  const isVix = index.symbol === '^VIX' || index.name?.toUpperCase() === 'VIX';
  return (
    <div className={`marketTile ${up ? 'up' : 'down'} ${options ? 'marketTileWide' : ''} ${isVix ? 'vixTile' : ''}`}>
      <div className="marketTileInfo">
        <span className="marketTileName">{index.name}</span>
        <strong>{indexNumberFormat.format(index.price)}</strong>
        <span className="marketTileChange">
          {up ? <ArrowUp size={11} aria-hidden="true" /> : <ArrowDown size={11} aria-hidden="true" />}
          {up ? '+' : ''}{index.changePercent.toFixed(2)}%
          <small>({up ? '+' : ''}{indexNumberFormat.format(index.change)})</small>
        </span>
      </div>

      {options && (
        <div className="marketTileOptions">
          <div className="moHead">
            <span className="moSym">{options.symbol} {fmtNum(options.spot, 2)}</span>
            <span className={`moBias ${bias.cls}`}>{bias.label}</span>
          </div>
          <div className="moGrid">
            <div><span>PCR(OI)</span><b>{fmtNum(options.pcrOI)}</b></div>
            <div><span>净伽马</span><b className={options.netGamma >= 0 ? 'pos' : 'neg'}>{fmtGamma(options.netGamma)}</b></div>
            <div><span>Call墙</span><b>{fmtNum(options.callWall, 0)}</b></div>
            <div><span>Put墙</span><b>{fmtNum(options.putWall, 0)}</b></div>
          </div>
        </div>
      )}
    </div>
  );
}
