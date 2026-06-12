import React from 'react';
import { normalizeTicker } from '../lib/catalog.js';

export function AddHoldingModal({
  ticker,
  shares,
  cost,
  status,
  onTickerChange,
  onSharesChange,
  onCostChange,
  onSubmit,
  onClose
}) {
  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={onClose}>
      <form className="tickerModal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="tickerModalHead">
          <h2>添加股票</h2>
          <button type="button" className="modalCloseButton" onClick={onClose}>取消</button>
        </div>
        <label>
          <span>Ticker</span>
          <input
            autoFocus
            value={ticker}
            onChange={(event) => onTickerChange(normalizeTicker(event.target.value))}
            placeholder="NVDA"
          />
        </label>
        <div className="tickerModalGrid">
          <label>
            <span>股数</span>
            <input
              inputMode="decimal"
              value={shares}
              onChange={(event) => onSharesChange(event.target.value)}
              placeholder="10"
            />
          </label>
          <label>
            <span>成本</span>
            <input
              inputMode="decimal"
              value={cost}
              onChange={(event) => onCostChange(event.target.value)}
              placeholder="120.5"
            />
          </label>
        </div>
        {status && <p>{status}</p>}
        <button type="submit" className="parseButton" disabled={status === '读取公司名称'}>添加股票</button>
      </form>
    </div>
  );
}
