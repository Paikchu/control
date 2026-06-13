import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { apiBase } from '../api/client.js';

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
  const sign = millions >= 0 ? '+' : '';
  return `${sign}${millions.toFixed(1)}M`;
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'America/New_York',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

// header「大盘预测」入口：自取 /api/options/overview，点开看 PCR/Net Gamma/墙位 + DeepSeek 研判。
export function MarketGammaPill() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ snapshots: [], forecast: null });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/options/overview`);
      const payload = await res.json();
      setData({ snapshots: payload.snapshots || [], forecast: payload.forecast || null });
      setError('');
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  // 点击外部关闭。
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/api/options/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      const payload = await res.json();
      if (payload.error) setError(payload.error);
      setData({ snapshots: payload.snapshots || [], forecast: payload.forecast || null });
      if (payload.errors?.length) {
        setError(payload.errors.map((e) => `${e.symbol}: ${e.error}`).join('；'));
      }
    } catch (err) {
      setError(err.message || '刷新失败');
    } finally {
      setRefreshing(false);
    }
  }, []);

  const forecast = data.forecast?.analysis || null;
  const headBias = useMemo(() => {
    if (forecast?.bias) return forecast.bias;
    const votes = data.snapshots.map((s) => s.bias).filter(Boolean);
    if (!votes.length) return null;
    const bull = votes.filter((b) => b === 'bullish').length;
    const bear = votes.filter((b) => b === 'bearish').length;
    if (bull > bear) return 'bullish';
    if (bear > bull) return 'bearish';
    return 'neutral';
  }, [forecast, data.snapshots]);

  const meta = biasMeta(headBias);
  const lastFetched = data.snapshots[0]?.fetchedAt || data.forecast?.generatedAt;

  return (
    <div className="gammaPill" ref={rootRef}>
      <button
        type="button"
        className={`gammaPillButton ${meta.cls}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="大盘期权研判"
      >
        <Activity size={13} aria-hidden="true" />
        <span className="gammaPillLabel">大盘</span>
        <strong>{meta.label}</strong>
      </button>

      {open && (
        <div className="gammaPopover">
          <div className="gammaPopoverHead">
            <span>大盘期权研判</span>
            <button
              type="button"
              className="gammaRefresh"
              onClick={refresh}
              disabled={refreshing}
              title="抓取最新期权数据并重新研判"
            >
              <RefreshCw size={13} className={refreshing ? 'spin' : ''} aria-hidden="true" />
            </button>
          </div>

          {forecast && (
            <div className="gammaForecast">
              <div className="gammaForecastTop">
                <span className={`gammaBadge ${biasMeta(forecast.bias).cls}`}>{biasMeta(forecast.bias).label}</span>
                {Number.isFinite(forecast.confidence) && (
                  <span className="gammaConf">信心 {Math.round(forecast.confidence * 100)}%</span>
                )}
                <span className="gammaHorizon">{forecast.horizon || '1-3个交易日'}</span>
              </div>
              {forecast.summary && <p className="gammaSummary">{forecast.summary}</p>}
              {forecast.drivers?.length > 0 && (
                <ul className="gammaList">
                  {forecast.drivers.map((d, i) => (
                    <li key={`d${i}`}>{d}</li>
                  ))}
                </ul>
              )}
              {forecast.risks?.length > 0 && (
                <ul className="gammaList risk">
                  {forecast.risks.map((r, i) => (
                    <li key={`r${i}`}>⚠ {r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="gammaMetrics">
            {data.snapshots.length === 0 && !loading && (
              <div className="gammaEmpty">暂无期权快照，点右上角刷新（需 IBKR Gateway 已登录）。</div>
            )}
            {data.snapshots.map((s) => (
              <div className="gammaCard" key={s.symbol}>
                <div className="gammaCardHead">
                  <strong>{s.symbol}</strong>
                  <span className="gammaSpot">{fmtNum(s.spot, 2)}</span>
                  <span className={`gammaBadge sm ${biasMeta(s.bias).cls}`}>{biasMeta(s.bias).label}</span>
                </div>
                <div className="gammaGrid">
                  <div><span>PCR(量)</span><b>{fmtNum(s.pcrVolume)}</b></div>
                  <div><span>PCR(OI)</span><b>{fmtNum(s.pcrOI)}</b></div>
                  <div><span>Net Gamma</span><b className={s.netGamma >= 0 ? 'pos' : 'neg'}>{fmtGamma(s.netGamma)}</b></div>
                  <div><span>Gamma翻转</span><b>{fmtNum(s.gammaFlip, 2)}</b></div>
                  <div><span>Call墙</span><b>{fmtNum(s.callWall, 0)}</b></div>
                  <div><span>Put墙</span><b>{fmtNum(s.putWall, 0)}</b></div>
                </div>
              </div>
            ))}
          </div>

          {error && <div className="gammaError">{error}</div>}
          <div className="gammaFoot">
            {lastFetched ? `数据截至 ${fmtTime(lastFetched)}（美东，可能为延迟行情）` : '尚未抓取数据'}
          </div>
        </div>
      )}
    </div>
  );
}
