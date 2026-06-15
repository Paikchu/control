import React, { useEffect, useState, useRef } from 'react';
import { apiBase } from '../api/client.js';

// Cache sparkline data in sessionStorage to avoid re-fetching on re-render.
// Key: symbol, value: { data, ts }
const memCache = new Map();
const MEM_TTL = 5 * 60 * 1000;

async function fetchSparkline(symbol) {
  const cached = memCache.get(symbol);
  if (cached && Date.now() - cached.ts < MEM_TTL) return cached.data;
  const res = await fetch(`${apiBase}/api/chart/${encodeURIComponent(symbol)}/sparkline`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  memCache.set(symbol, { data, ts: Date.now() });
  return data;
}

function buildPath(points, w, h, pad = 2) {
  if (!points.length) return '';
  const xs = points.map(p => p.t);
  const vs = points.map(p => p.v);
  const minX = xs[0], maxX = xs[xs.length - 1];
  const minV = Math.min(...vs), maxV = Math.max(...vs);
  const rangeX = maxX - minX || 1;
  const rangeV = maxV - minV || 1;
  const toX = t => pad + ((t - minX) / rangeX) * (w - pad * 2);
  const toY = v => (h - pad) - ((v - minV) / rangeV) * (h - pad * 2);
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`).join(' ');
}

export function Sparkline({ symbol, width = 72, height = 24, className = '' }) {
  const [state, setState] = useState({ points: [], previousClose: null, loading: true });
  const abortRef = useRef(null);

  useEffect(() => {
    if (!symbol) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    fetchSparkline(symbol)
      .then(data => {
        if (!ctrl.signal.aborted) {
          setState({ points: data.points ?? [], previousClose: data.previousClose, loading: false });
        }
      })
      .catch(() => { if (!ctrl.signal.aborted) setState(s => ({ ...s, loading: false })); });

    return () => ctrl.abort();
  }, [symbol]);

  if (state.loading || state.points.length < 2) {
    return <span style={{ display: 'inline-block', width, height }} />;
  }

  const lastV = state.points[state.points.length - 1].v;
  const ref = state.previousClose ?? state.points[0].v;
  const up = lastV >= ref;
  const color = up ? '#1e7e45' : '#c0392b';
  const path = buildPath(state.points, width, height);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={path} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
      <circle
        cx={(() => { const xs = state.points.map(p => p.t); const minX = xs[0], maxX = xs[xs.length - 1], rangeX = maxX - minX || 1; return (2 + ((state.points[state.points.length - 1].t - minX) / rangeX) * (width - 4)).toFixed(1); })()}
        cy={(() => { const vs = state.points.map(p => p.v); const minV = Math.min(...vs), maxV = Math.max(...vs), rangeV = maxV - minV || 1; return ((height - 2) - ((lastV - minV) / rangeV) * (height - 4)).toFixed(1); })()}
        r="2"
        fill={color}
      />
    </svg>
  );
}
