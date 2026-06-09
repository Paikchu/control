import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactECharts from 'echarts-for-react';
import { AlertTriangle, Briefcase, ExternalLink, FileDown, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { mergePriceData } from './marketSeries.mjs';
import './styles.css';

const assets = [
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF', type: '股票', color: '#1D4ED8', inception: '1999-03-10' },
  { symbol: 'TQQQ', name: '3x Nasdaq 100', type: '杠杆', color: '#B91C1C', inception: '2010-02-11' },
  { symbol: 'SPY', name: 'S&P 500 ETF', type: '股票', color: '#1D4ED8', inception: '1993-01-29' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', type: '股票', color: '#2457C5', inception: '2010-09-07' },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market', type: '股票', color: '#2457C5', inception: '2001-05-24' },
  { symbol: 'VT', name: 'Vanguard Total World Stock', type: '股票', color: '#2457C5', inception: '2008-06-24' },
  { symbol: 'VUG', name: 'Vanguard Growth ETF', type: '股票', color: '#2457C5', inception: '2004-01-26' },
  { symbol: 'VTV', name: 'Vanguard Value ETF', type: '股票', color: '#2457C5', inception: '2004-01-26' },
  { symbol: 'VGT', name: 'Vanguard Information Technology', type: '股票', color: '#2457C5', inception: '2004-01-26' },
  { symbol: 'VNQ', name: 'Vanguard Real Estate ETF', type: 'REIT', color: '#56667A', inception: '2004-09-23' },
  { symbol: 'VXUS', name: 'Vanguard Total International Stock', type: '股票', color: '#2457C5', inception: '2011-01-26' },
  { symbol: 'TLT', name: '20Y Treasury', type: '债券', color: '#15803D', inception: '2002-07-22' },
  { symbol: 'BND', name: 'Vanguard Total Bond Market', type: '债券', color: '#16724A', inception: '2007-04-03' },
  { symbol: 'AGG', name: 'US Aggregate Bond ETF', type: '债券', color: '#16724A', inception: '2003-09-22' },
  { symbol: 'SHY', name: '1-3Y Treasury ETF', type: '债券', color: '#16724A', inception: '2002-07-22' },
  { symbol: 'IEF', name: '7-10Y Treasury ETF', type: '债券', color: '#16724A', inception: '2002-07-22' },
  { symbol: 'SGOV', name: '0-3M Treasury', type: '债券', color: '#15803D', inception: '2020-05-26' },
  { symbol: 'GLD', name: 'Gold Trust', type: '黄金', color: '#B45309', inception: '2004-11-18' },
  { symbol: 'IAU', name: 'iShares Gold Trust', type: '黄金', color: '#A05E12', inception: '2005-01-21' },
  { symbol: 'CASH', name: 'Cash Yield', type: '现金', color: '#64748B', inception: '1990-01-01' }
];

const fallbackSymbols = ['SPY', 'TLT', 'SGOV', 'GLD'];
const strategyColors = ['#2457C5', '#96392F', '#16724A', '#A05E12', '#56667A'];

const rangePresets = [
  { label: '1Y', years: 1 },
  { label: '3Y', years: 3 },
  { label: '5Y', years: 5 },
  { label: '10Y', years: 10 },
  { label: '全部', start: '2000-01-03', end: '2025-12-31' }
];

const defaultPortfolio = [
  { id: 'holding-asts', symbol: 'ASTS', name: 'AST SpaceMobile', shares: 120, cost: 24.8, thesis: '直连手机卫星网络进展，盯商业化节点与融资节奏。', risk: '发射延迟、监管、摊薄。' },
  { id: 'holding-sats', symbol: 'SATS', name: 'EchoStar', shares: 80, cost: 28.2, thesis: '频谱资产重估与债务处理。', risk: '现金流压力、监管不确定。' },
  { id: 'holding-qqq', symbol: 'QQQ', name: 'Nasdaq 100 ETF', shares: 35, cost: 455, thesis: '核心科技 Beta。', risk: '估值回撤。' }
];

const portfolioStorageKey = 'portfolio-backtest:holdings:v1';
const ibkrAccountStorageKey = 'portfolio-backtest:ibkr-account:v1';

const companyNameByTicker = {
  ...Object.fromEntries(assets.map((asset) => [asset.symbol, asset.name])),
  AAPL: 'Apple',
  AMD: 'Advanced Micro Devices',
  AMZN: 'Amazon',
  ASTS: 'AST SpaceMobile',
  AVGO: 'Broadcom',
  COST: 'Costco',
  CRWD: 'CrowdStrike',
  GOOGL: 'Alphabet',
  GOOG: 'Alphabet',
  META: 'Meta Platforms',
  MSFT: 'Microsoft',
  NFLX: 'Netflix',
  NVDA: 'NVIDIA',
  PLTR: 'Palantir',
  SATS: 'EchoStar',
  SMCI: 'Super Micro Computer',
  TSLA: 'Tesla'
};

function normalizeTicker(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 12);
}

function localCompanyName(symbol) {
  const ticker = normalizeTicker(symbol);
  return companyNameByTicker[ticker] || ticker;
}

function normalizeStoredHolding(holding, index) {
  const symbol = normalizeTicker(String(holding?.symbol || ''));
  if (!symbol) return null;
  return {
    id: String(holding?.id || `holding-${symbol.toLowerCase()}-${index}`),
    symbol,
    name: String(holding?.name || localCompanyName(symbol)),
    shares: holding?.shares ?? 0,
    cost: holding?.cost ?? 0,
    conid: holding?.conid ? String(holding.conid) : '',
    source: String(holding?.source || 'manual'),
    thesis: String(holding?.thesis || ''),
    risk: String(holding?.risk || '')
  };
}

function readStoredPortfolio() {
  if (typeof window === 'undefined') return defaultPortfolio;
  try {
    const saved = window.localStorage.getItem(portfolioStorageKey);
    if (saved === null) return defaultPortfolio;
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return defaultPortfolio;
    return parsed.map(normalizeStoredHolding).filter(Boolean);
  } catch (error) {
    return defaultPortfolio;
  }
}

function readStoredIbkrAccountId() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(ibkrAccountStorageKey) || '';
  } catch {
    return '';
  }
}

function localNoteForIbkrPosition(position, notes) {
  const byConid = notes.find((holding) => holding.conid && String(holding.conid) === String(position.conid));
  if (byConid) return byConid;
  return notes.find((holding) => normalizeTicker(String(holding.symbol || '')) === normalizeTicker(position.symbol)) || null;
}

function ibkrHoldingFromPosition(position, notes) {
  const local = localNoteForIbkrPosition(position, notes);
  return {
    id: `ibkr-${position.conid || position.symbol}`,
    source: 'ibkr',
    conid: position.conid,
    symbol: normalizeTicker(position.symbol),
    name: local?.name || position.name || localCompanyName(position.symbol),
    shares: position.quantity ?? 0,
    cost: position.avgCost ?? 0,
    marketPrice: position.marketPrice,
    marketValue: position.marketValue,
    unrealizedPnl: position.unrealizedPnl,
    realizedPnl: position.realizedPnl,
    currency: position.currency || 'USD',
    secType: position.secType || 'STK',
    fetchedAt: position.fetchedAt,
    thesis: local?.thesis || '',
    risk: local?.risk || ''
  };
}

function mergeIbkrPortfolio(snapshot, localPortfolio) {
  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  return positions.map((position) => ibkrHoldingFromPosition(position, localPortfolio)).filter((holding) => holding.symbol);
}

function ibkrStatusMessage(message) {
  if (message === 'IBKR login failed or API access denied') return 'IBKR 登录已提交，但 API 会话被拒绝。请在 Gateway 登录页确认显示 Client login succeeds，并检查是否选错 Live/Paper。';
  if (message === 'IBKR login required') return '需要登录 IBKR。';
  return message || '';
}

function createCondition(index = 0) {
  return {
    id: `rule-${Date.now()}-${index}`,
    enabled: true,
    label: index ? '深回撤加仓' : '回撤加仓',
    triggerAsset: 'QQQ',
    metric: 'drawdown',
    operator: '>=',
    value: index ? 35 : 25,
    action: 'set_weight',
    targetAsset: 'TQQQ',
    targetWeight: index ? 20 : 10,
    sourceAsset: 'CORE',
    priority: index + 1
  };
}

function createExitCondition(index = 2) {
  return {
    ...createCondition(index),
    id: `rule-exit-${Date.now()}-${index}`,
    label: '恢复退出',
    operator: '<=',
    value: 5,
    targetWeight: 0,
    priority: 99
  };
}

function generatePrices(startYear = 1999, endYear = 2026) {
  const rows = [];
  const values = { QQQ: 100, SPY: 100, TLT: 100, SGOV: 100, GLD: 100 };
  let qqqHigh = 100;
  for (let y = startYear; y <= endYear; y++) {
    for (let m = 0; m < 12; m++) {
      for (let d = 1; d <= 28; d++) {
        const date = new Date(Date.UTC(y, m, d));
        const dow = date.getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const t = rows.length;
        let qRet = 0.00042 + Math.sin(t / 43) * 0.0022 + Math.cos(t / 91) * 0.0013;
        if (y === 2000) qRet -= 0.0042;
        if (y === 2001) qRet -= 0.0034;
        if (y === 2002) qRet -= 0.0026;
        if (y === 2008) qRet -= 0.0046;
        if (y === 2020 && m < 3) qRet -= 0.007;
        if (y === 2022) qRet -= 0.0032;
        if ((y === 2003) || (y === 2009) || (y === 2020 && m > 3) || (y === 2023)) qRet += 0.0038;
        const spyRet = qRet * 0.58 + 0.00015;
        const tltRet = -qRet * 0.32 + 0.00012 + Math.sin(t / 57) * 0.0009;
        const gldRet = -qRet * 0.16 + 0.00018 + Math.cos(t / 64) * 0.0011;
        values.QQQ *= 1 + qRet;
        values.SPY *= 1 + spyRet;
        values.TLT *= 1 + tltRet;
        values.SGOV *= 1 + 0.00016;
        values.GLD *= 1 + gldRet;
        qqqHigh = Math.max(qqqHigh, values.QQQ);
        const tqqqRet = Math.max(-0.35, qRet * 3 - 0.00025);
        const prevTqqq = rows.length ? rows[rows.length - 1].TQQQ : 100;
        rows.push({
          date: date.toISOString().slice(0, 10),
          QQQ: values.QQQ,
          TQQQ: prevTqqq * (1 + tqqqRet),
          SPY: values.SPY,
          VOO: values.SPY,
          TLT: values.TLT,
          SGOV: values.SGOV,
          GLD: values.GLD,
          CASH: 100 * Math.pow(1.04, t / 252),
          qqqDrawdown: values.QQQ / qqqHigh - 1
        });
      }
    }
  }
  return rows;
}

const priceData = generatePrices();
const apiBase = 'http://127.0.0.1:8787';

function metric(curve) {
  const start = curve[0]?.value ?? 1;
  const end = curve[curve.length - 1]?.value ?? start;
  const years = Math.max(1 / 252, curve.length / 252);
  let peak = start;
  let maxDd = 0;
  let worstDay = curve[0]?.date;
  const returns = [];
  for (let i = 0; i < curve.length; i++) {
    peak = Math.max(peak, curve[i].value);
    const dd = curve[i].value / peak - 1;
    if (dd < maxDd) {
      maxDd = dd;
      worstDay = curve[i].date;
    }
    if (i > 0) returns.push(curve[i].value / curve[i - 1].value - 1);
  }
  const annualized = Math.pow(end / start, 1 / years) - 1;
  const avg = returns.reduce((a, b) => a + b, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / Math.max(1, returns.length);
  const vol = Math.sqrt(variance) * Math.sqrt(252);
  const sharpe = vol ? (annualized - 0.04) / vol : 0;
  const calmar = maxDd ? annualized / Math.abs(maxDd) : 0;
  return { start, end, annualized, maxDd, vol, sharpe, calmar, worstDay, totalReturn: end / start - 1 };
}

function backtest({ rows, holdings, rules }) {
  if (!rows.length) {
    return { curve: [], drawdowns: [], allocations: [], trades: [], stats: metric([]) };
  }
  const initial = holdings.reduce((sum, h) => sum + h.amount, 0);
  const units = {};
  const trades = [];
  const weights = {};
  const priceFor = (row, symbol) => row[symbol] ?? row.SPY ?? row.QQQ ?? 1;
  const sourceSymbol = holdings.find((h) => !['TQQQ', 'CASH'].includes(h.symbol))?.symbol ?? 'QQQ';
  const conditions = normalizeConditions(rules);
  const trackedSymbols = Array.from(new Set([
    sourceSymbol,
    ...holdings.map((h) => h.symbol),
    ...conditions.flatMap((condition) => [condition.triggerAsset, condition.targetAsset])
  ]));
  const peaks = Object.fromEntries(trackedSymbols.map((symbol) => [symbol, priceFor(rows[0], symbol)]));
  const history = Object.fromEntries(trackedSymbols.map((symbol) => [symbol, []]));
  holdings.forEach((h) => {
    units[h.symbol] = h.amount / priceFor(rows[0], h.symbol);
    weights[h.symbol] = h.amount / initial;
  });
  const curve = [];
  const allocations = [];
  for (const row of rows) {
    trackedSymbols.forEach((symbol) => {
      const price = priceFor(row, symbol);
      peaks[symbol] = Math.max(peaks[symbol] || price, price);
      history[symbol].push(price);
    });
    let total = Object.entries(units).reduce((sum, [sym, unit]) => sum + unit * priceFor(row, sym), 0);
    const targets = new Map();
    conditions.forEach((condition) => {
      if (!condition.enabled || !conditionTriggered(condition, row, peaks, history, priceFor)) return;
      const current = targets.get(condition.targetAsset);
      const weight = condition.targetWeight / 100;
      if (!current || condition.priority >= current.priority || weight > current.weight) {
        targets.set(condition.targetAsset, { ...condition, weight });
      }
    });

    targets.forEach((target, targetAsset) => {
      if (Math.abs((weights[targetAsset] || 0) - target.weight) <= 0.01) return;
      const currentValue = (units[targetAsset] || 0) * priceFor(row, targetAsset);
      const targetValue = total * target.weight;
      const diff = targetValue - currentValue;
      const fundingSymbol = target.sourceAsset === 'CORE' ? sourceSymbol : target.sourceAsset;
      units[targetAsset] = targetValue / priceFor(row, targetAsset);
      if (fundingSymbol !== targetAsset) {
        units[fundingSymbol] = Math.max(0, ((units[fundingSymbol] || 0) * priceFor(row, fundingSymbol) - diff) / priceFor(row, fundingSymbol));
      }
      total = Object.entries(units).reduce((sum, [sym, unit]) => sum + unit * priceFor(row, sym), 0);
      Object.keys(weights).forEach((s) => { weights[s] = ((units[s] || 0) * priceFor(row, s)) / total; });
      weights[targetAsset] = ((units[targetAsset] || 0) * priceFor(row, targetAsset)) / total;
      trades.push({ date: row.date, action: `${targetAsset} 调到 ${(target.weight * 100).toFixed(0)}%`, value: total });
    });
    const point = { date: row.date, value: total };
    curve.push(point);
    const sum = Object.entries(units).reduce((acc, [sym, unit]) => acc + unit * priceFor(row, sym), 0);
    allocations.push({
      date: row.date,
      QQQ: (((units.QQQ || 0) * priceFor(row, 'QQQ')) / sum) * 100,
      TQQQ: (((units.TQQQ || 0) * priceFor(row, 'TQQQ')) / sum) * 100,
      CASH: (((units.CASH || 0) * priceFor(row, 'CASH')) / sum) * 100
    });
  }
  let peak = curve[0].value;
  const drawdowns = curve.map((p) => {
    peak = Math.max(peak, p.value);
    return { date: p.date, value: p.value / peak - 1 };
  });
  return { curve, drawdowns, allocations, trades, stats: metric(curve) };
}

function normalizeConditions(rules) {
  if (Array.isArray(rules?.conditions) && rules.conditions.length) {
    return rules.conditions.map((condition, index) => ({
      ...createCondition(index),
      ...condition,
      id: condition.id || `condition-${index}`,
      value: Number(condition.value) || 0,
      targetWeight: Number(condition.targetWeight) || 0,
      priority: Number(condition.priority) || index + 1
    }));
  }

  const thresholds = Array.isArray(rules?.thresholds) ? rules.thresholds : [];
  const entries = thresholds.map((r, index) => ({
    ...createCondition(index),
    id: `legacy-entry-${index}`,
    label: `${r.drawdown}% 回撤`,
    value: Number(r.drawdown) || 0,
    targetWeight: Number(r.weight) || 0,
    priority: index + 1
  }));

  if (Number.isFinite(Number(rules?.exitRecovery))) {
    entries.push({
      ...createCondition(entries.length),
      id: 'legacy-exit',
      label: '恢复退出',
      operator: '<=',
      value: Number(rules.exitRecovery),
      targetWeight: 0,
      priority: 99
    });
  }

  return entries;
}

function conditionTriggered(condition, row, peaks, history, priceFor) {
  const symbol = condition.triggerAsset;
  const price = priceFor(row, symbol);
  let metricValue = 0;

  if (condition.metric === 'drawdown') {
    metricValue = ((peaks[symbol] || price) - price) / (peaks[symbol] || price) * 100;
  } else {
    const lookback = Math.max(5, Math.round(condition.value));
    const points = history[symbol] || [];
    if (points.length < lookback) return false;
    const slice = points.slice(-lookback);
    const average = slice.reduce((sum, item) => sum + item, 0) / slice.length;
    metricValue = price >= average ? 1 : 0;
    return condition.metric === 'price_above_ma' ? metricValue === 1 : metricValue === 0;
  }

  return condition.operator === '<=' ? metricValue <= condition.value : metricValue >= condition.value;
}

function displaySeries(points, interval) {
  if (interval === '日') return points;
  const bucket = new Map();
  points.forEach((point) => {
    const date = new Date(`${point.date}T00:00:00Z`);
    let key;
    if (interval === '周') {
      const weekStart = new Date(date);
      weekStart.setUTCDate(date.getUTCDate() - date.getUTCDay());
      key = weekStart.toISOString().slice(0, 10);
    } else {
      key = point.date.slice(0, 7);
    }
    bucket.set(key, point);
  });
  return Array.from(bucket.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function formatMoney(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function pct(n, digits = 1) {
  if (!Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(digits)}%`;
}

function compactMoney(n) {
  if (!Number.isFinite(n)) return 'n/a';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return formatMoney(n);
}

function hasNumber(n) {
  return Number.isFinite(n);
}

function tickerMatches(query) {
  const text = query.trim().toUpperCase();
  const matched = assets.filter((asset) => {
    if (!text) return true;
    return asset.symbol.includes(text) || asset.name.toUpperCase().includes(text) || asset.type.includes(query.trim());
  });
  return matched
    .sort((a, b) => {
      const aStarts = a.symbol.startsWith(text) ? 0 : 1;
      const bStarts = b.symbol.startsWith(text) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, 6);
}

function secFilingsUrl(symbol) {
  const query = encodeURIComponent(symbol.trim().toUpperCase());
  return `https://www.sec.gov/edgar/search/#/q=${query}&category=custom&forms=10-K%252C10-Q%252C8-K`;
}

function secCompanyUrl(symbol) {
  const query = encodeURIComponent(symbol.trim().toUpperCase());
  return `https://www.sec.gov/edgar/search/#/entityName=${query}`;
}

function reportChartOption(report, chartId) {
  const quarters = report?.financials?.quarters || [];
  const periods = quarters.map((row) => row.period);
  const grid = { left: 46, right: 16, top: 28, bottom: 28 };
  const axisText = { color: '#6b7280', fontSize: 10 };
  if (chartId === 'revenue-yoy') {
    return {
      animation: false,
      legend: { top: 0, right: 4, itemWidth: 14, itemHeight: 4, textStyle: { color: '#5f6b7a', fontSize: 10 } },
      grid,
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: periods, axisLabel: axisText, axisTick: { show: false } },
      yAxis: [
        { type: 'value', axisLabel: { ...axisText, formatter: (v) => compactMoney(v) }, splitLine: { lineStyle: { color: '#e5e7eb' } } },
        { type: 'value', axisLabel: { ...axisText, formatter: (v) => pct(v, 0) }, splitLine: { show: false } }
      ],
      series: [
        { name: '营收', type: 'bar', data: quarters.map((row) => row.revenue), itemStyle: { color: '#2563eb' }, barMaxWidth: 22 },
        {
          name: 'YoY',
          type: 'line',
          yAxisIndex: 1,
          data: quarters.map((row) => row.revenueYoY),
          showSymbol: true,
          symbolSize: 5,
          label: { show: true, formatter: ({ value }) => hasNumber(value) ? pct(value, 0) : '', color: '#0f7a4d', fontSize: 10 },
          lineStyle: { color: '#0f7a4d', width: 2 }
        }
      ]
    };
  }
  if (chartId === 'profit-fcf') {
    return {
      animation: false,
      grid,
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: periods, axisLabel: axisText, axisTick: { show: false } },
      yAxis: { type: 'value', axisLabel: { ...axisText, formatter: (v) => compactMoney(v) }, splitLine: { lineStyle: { color: '#e5e7eb' } } },
      series: [
        { name: '净利润', type: 'bar', data: quarters.map((row) => row.netIncome), itemStyle: { color: '#334155' }, barMaxWidth: 20 },
        { name: 'FCF', type: 'bar', data: quarters.map((row) => row.fcf), itemStyle: { color: '#b15c00' }, barMaxWidth: 20 }
      ]
    };
  }
  return {
    animation: false,
    grid,
    tooltip: { trigger: 'axis', valueFormatter: (value) => pct(value, 1) },
    xAxis: { type: 'category', data: periods, axisLabel: axisText, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { ...axisText, formatter: (v) => pct(v, 0) }, splitLine: { lineStyle: { color: '#e5e7eb' } } },
    series: [
      { name: '毛利率', type: 'line', data: quarters.map((row) => row.grossMargin), showSymbol: true, symbolSize: 4, lineStyle: { color: '#2563eb', width: 2 } },
      { name: '经营利润率', type: 'line', data: quarters.map((row) => row.operatingMargin), showSymbol: true, symbolSize: 4, lineStyle: { color: '#b15c00', width: 2 } },
      { name: '净利率', type: 'line', data: quarters.map((row) => row.netMargin), showSymbol: true, symbolSize: 4, lineStyle: { color: '#0f7a4d', width: 2 } }
    ]
  };
}

function createStrategy(id, name = `策略 ${id}`) {
  return {
    id,
    name,
    positions: [
      { id: `${id}-qqq`, symbol: 'QQQ', amount: 14000 },
      { id: `${id}-tqqq`, symbol: 'TQQQ', amount: 0 }
    ],
    rules: {
      tags: ['回撤', '调仓', '退出'],
      conditions: [createCondition(0), createCondition(1), createExitCondition()],
      displayText: '当 QQQ 回撤达到 25% 时，小幅提高 TQQQ 仓位；回撤达到 35% 时继续提高 TQQQ 仓位；当 QQQ 修复到前高附近时，退出增强仓位并回到基础配置。'
    }
  };
}

function clampStrategyPositions(strategy, totalFunding, positionId = null, nextAmount = null) {
  const positions = strategy.positions.map((position) => {
    if (position.id !== positionId) return position;
    return { ...position, amount: Math.max(0, nextAmount || 0) };
  });
  const invested = positions.reduce((sum, position) => sum + position.amount, 0);
  if (invested <= totalFunding || invested === 0) return { ...strategy, positions };

  if (positionId) {
    const otherInvested = positions.reduce((sum, position) => position.id === positionId ? sum : sum + position.amount, 0);
    return {
      ...strategy,
      positions: positions.map((position) => position.id === positionId
        ? { ...position, amount: Math.max(0, totalFunding - otherInvested) }
        : position)
    };
  }

  const scale = totalFunding / invested;
  return {
    ...strategy,
    positions: positions.map((position) => ({ ...position, amount: position.amount * scale }))
  };
}

function App() {
  const [activeView, setActiveView] = useState('backtest');
  const [strategies, setStrategies] = useState([
    createStrategy(1, '深回撤增强'),
    {
      ...createStrategy(2, '保守触发'),
      rules: { thresholds: [{ drawdown: 30, weight: 8 }, { drawdown: 40, weight: 15 }], exitRecovery: 5 }
    }
  ]);
  const [totalFunding, setTotalFunding] = useState(20000);
  const [dateRange, setDateRange] = useState({ start: '2000-01-03', end: '2025-12-31' });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activeTicker, setActiveTicker] = useState(null);
  const [marketSeries, setMarketSeries] = useState({});
  const [tickerStatus, setTickerStatus] = useState({});
  const [ruleDrafts, setRuleDrafts] = useState({});
  const [parseStatus, setParseStatus] = useState({});
  const [portfolio, setPortfolio] = useState(() => readStoredPortfolio());
  const [expandedHolding, setExpandedHolding] = useState(() => readStoredPortfolio()[0]?.id ?? null);
  const [ibkrStatus, setIbkrStatus] = useState({ gateway: 'checking', authenticated: false, message: '' });
  const [ibkrAccounts, setIbkrAccounts] = useState([]);
  const [selectedIbkrAccount, setSelectedIbkrAccount] = useState(() => readStoredIbkrAccountId());
  const [ibkrSnapshot, setIbkrSnapshot] = useState(null);
  const [ibkrSyncStatus, setIbkrSyncStatus] = useState('idle');
  const [ibkrError, setIbkrError] = useState('');
  const [addHoldingOpen, setAddHoldingOpen] = useState(false);
  const [newHoldingTicker, setNewHoldingTicker] = useState('');
  const [newHoldingShares, setNewHoldingShares] = useState('');
  const [newHoldingCost, setNewHoldingCost] = useState('');
  const [addHoldingStatus, setAddHoldingStatus] = useState('');
  const [viewportKey, setViewportKey] = useState(0);
  const [secFilings, setSecFilings] = useState({});
  const [secStatus, setSecStatus] = useState({});
  const [secReports, setSecReports] = useState({});
  const [secReportStatus, setSecReportStatus] = useState({});
  const sheetTouchStart = useRef(null);
  const selectedTickers = useMemo(() => {
    const symbols = new Set();
    strategies.forEach((strategy) => {
      strategy.positions.forEach((position) => {
        const symbol = position.symbol.trim().toUpperCase();
        if (/^[A-Z0-9.-]{1,12}$/.test(symbol) && symbol !== 'CASH') symbols.add(symbol);
      });
    });
    return Array.from(symbols).sort();
  }, [strategies]);
  const rows = useMemo(() => {
    return mergePriceData(priceData, marketSeries).filter((r) => r.date >= dateRange.start && r.date <= dateRange.end);
  }, [dateRange, marketSeries]);
  const strategyResults = useMemo(() => strategies.map((strategy, index) => {
    const invested = strategy.positions.reduce((sum, position) => sum + position.amount, 0);
    const cashAmount = Math.max(0, totalFunding - invested);
    const holdings = [...strategy.positions, { id: `${strategy.id}-cash`, symbol: 'CASH', amount: cashAmount }];
    return {
      strategy,
      color: strategyColors[index % strategyColors.length],
      result: backtest({ rows, holdings, rules: strategy.rules })
    };
  }), [rows, strategies, totalFunding]);
  const primaryResult = strategyResults[0]?.result ?? backtest({ rows, holdings: [], rules: { thresholds: [], exitRecovery: 5 } });
  const ibkrPortfolio = useMemo(() => mergeIbkrPortfolio(ibkrSnapshot, portfolio), [ibkrSnapshot, portfolio]);
  const displayedPortfolio = useMemo(() => (
    ibkrPortfolio.length ? ibkrPortfolio : portfolio.map((holding) => ({ ...holding, source: holding.source || 'manual' }))
  ), [ibkrPortfolio, portfolio]);
  const selectedHolding = displayedPortfolio.find((holding) => holding.id === expandedHolding) ?? displayedPortfolio[0];
  const showingIbkrPortfolio = ibkrPortfolio.length > 0;
  const hasIbkrAccess = ibkrStatus.authenticated || ibkrAccounts.length > 0 || Boolean(ibkrSnapshot?.lastSyncAt);

  function updateStrategy(strategyId, updater) {
    setStrategies((items) => items.map((strategy) => strategy.id === strategyId ? updater(strategy) : strategy));
  }

  function updatePosition(strategyId, positionId, key, value) {
    updateStrategy(strategyId, (strategy) => ({
      ...strategy,
      positions: strategy.positions.map((h) => h.id === positionId ? { ...h, [key]: value } : h)
    }));
  }

  function updatePositionAmount(strategyId, positionId, nextAmount) {
    updateStrategy(strategyId, (strategy) => clampStrategyPositions(strategy, totalFunding, positionId, nextAmount));
  }

  function updateTotalFunding(value) {
    const nextTotal = Math.max(0, value || 0);
    setTotalFunding(nextTotal);
    setStrategies((items) => items.map((strategy) => clampStrategyPositions(strategy, nextTotal)));
  }

  function addStrategy() {
    setStrategies((items) => [...items, createStrategy(items.length + 1)]);
  }

  function addAssetRow(strategyId) {
    updateStrategy(strategyId, (strategy) => {
      const used = new Set(strategy.positions.map((item) => item.symbol));
      const nextSymbol = fallbackSymbols.find((symbol) => !used.has(symbol)) ?? `ETF${strategy.positions.length + 1}`;
      return {
        ...strategy,
        positions: [...strategy.positions, { id: `${strategy.id}-${Date.now()}`, symbol: nextSymbol, amount: 0 }]
      };
    });
  }

  function removeAssetRow(strategyId, positionId) {
    updateStrategy(strategyId, (strategy) => {
      const positions = strategy.positions.filter((position) => position.id !== positionId);
      return {
        ...strategy,
        positions: positions.length ? positions : [{ id: `${strategy.id}-${Date.now()}`, symbol: 'QQQ', amount: 0 }]
      };
    });
  }

  function updateRuleDraft(strategyId, value) {
    setRuleDrafts((current) => ({ ...current, [strategyId]: value }));
  }

  async function parseRuleDraft(strategyId) {
    const description = (ruleDrafts[strategyId] || '').trim();
    if (!description) return;
    const currentStrategy = strategies.find((item) => item.id === strategyId);

    setParseStatus((current) => ({ ...current, [strategyId]: '转换中' }));
    try {
      const response = await fetch(`${apiBase}/api/parse-strategy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description,
          existingStrategy: currentStrategy?.rules?.displayText || ''
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '解析失败');
      updateStrategy(strategyId, (strategy) => ({
        ...strategy,
        name: payload.strategy.name || strategy.name,
        rules: {
          ...strategy.rules,
          displayText: payload.strategy.displayText || strategy.rules.displayText || description
        }
      }));
      setRuleDrafts((current) => ({ ...current, [strategyId]: '' }));
      setParseStatus((current) => ({ ...current, [strategyId]: '已生成' }));
    } catch (error) {
      setParseStatus((current) => ({ ...current, [strategyId]: '生成失败' }));
    }
  }

  function updateDate(key, value) {
    setDateRange((range) => ({ ...range, [key]: value }));
  }

  function selectTicker(strategyId, positionId, symbol) {
    updatePosition(strategyId, positionId, 'symbol', symbol);
    setActiveTicker(null);
  }

  function updateHolding(holdingId, key, value) {
    const ibkrHolding = displayedPortfolio.find((holding) => holding.id === holdingId && holding.source === 'ibkr');
    if (ibkrHolding && ['thesis', 'risk', 'name'].includes(key)) {
      setPortfolio((items) => {
        const matchedIndex = items.findIndex((holding) => (
          (holding.conid && String(holding.conid) === String(ibkrHolding.conid))
          || normalizeTicker(String(holding.symbol || '')) === ibkrHolding.symbol
        ));
        const nextNote = {
          id: matchedIndex >= 0 ? items[matchedIndex].id : `note-${ibkrHolding.conid || ibkrHolding.symbol}`,
          conid: ibkrHolding.conid,
          symbol: ibkrHolding.symbol,
          name: key === 'name' ? value : ibkrHolding.name,
          shares: ibkrHolding.shares,
          cost: ibkrHolding.cost,
          thesis: key === 'thesis' ? value : ibkrHolding.thesis,
          risk: key === 'risk' ? value : ibkrHolding.risk,
          source: 'ibkr-note'
        };
        if (matchedIndex < 0) return [...items, nextNote];
        return items.map((holding, index) => index === matchedIndex ? { ...holding, ...nextNote, [key]: value } : holding);
      });
      return;
    }
    setPortfolio((items) => items.map((holding) => holding.id === holdingId ? { ...holding, [key]: value } : holding));
  }

  async function resolveCompanyName(symbol) {
    const ticker = normalizeTicker(symbol);
    if (!ticker) return '';
    if (companyNameByTicker[ticker]) return companyNameByTicker[ticker];
    try {
      const response = await fetch(`${apiBase}/api/sec/company/${encodeURIComponent(ticker)}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '公司名称获取失败');
      return payload.name || ticker;
    } catch (error) {
      return ticker;
    }
  }

  function updateHoldingTicker(holdingId, value) {
    const symbol = normalizeTicker(value);
    const immediateName = localCompanyName(symbol);
    setPortfolio((items) => items.map((holding) => holding.id === holdingId
      ? { ...holding, symbol, name: immediateName }
      : holding));

    if (!symbol || companyNameByTicker[symbol]) return;
    resolveCompanyName(symbol).then((name) => {
      setPortfolio((items) => items.map((holding) => (
        holding.id === holdingId && holding.symbol === symbol
          ? { ...holding, name }
          : holding
      )));
    });
  }

  function selectHolding(holdingId) {
    setExpandedHolding((current) => {
      const isPortraitPhone = window.matchMedia('(max-width: 767px) and (orientation: portrait)').matches;
      if (isPortraitPhone && current === holdingId) return null;
      return holdingId;
    });
  }

  async function loadIbkrStatus({ preserveError = false } = {}) {
    setIbkrSyncStatus((current) => current === 'syncing' ? current : 'checking');
    try {
      const response = await fetch(`${apiBase}/api/ibkr/status${selectedIbkrAccount ? `?accountId=${encodeURIComponent(selectedIbkrAccount)}` : ''}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'IBKR 状态读取失败');
      setIbkrStatus(payload.status || { gateway: 'offline', authenticated: false });
      if (payload.snapshot?.positions?.length || payload.snapshot?.lastSyncAt) setIbkrSnapshot(payload.snapshot);
      if (!preserveError) {
        setIbkrError(payload.status?.gateway === 'offline'
          ? 'IBKR Gateway 未运行'
          : !payload.status?.authenticated && payload.status?.message
            ? ibkrStatusMessage(payload.status.message)
            : '');
      }
      setIbkrSyncStatus('idle');
      return payload.status;
    } catch (error) {
      setIbkrStatus({ gateway: 'offline', authenticated: false, message: error.message });
      if (!preserveError) setIbkrError('IBKR Gateway 未运行');
      setIbkrSyncStatus('idle');
      return { gateway: 'offline', authenticated: false };
    }
  }

  async function loadIbkrAccounts() {
    const response = await fetch(`${apiBase}/api/ibkr/accounts`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'IBKR 账户读取失败');
    const accounts = payload.accounts || [];
    setIbkrAccounts(accounts);
    if (!selectedIbkrAccount && accounts[0]?.accountId) setSelectedIbkrAccount(accounts[0].accountId);
    return accounts;
  }

  async function syncIbkrPositions(accountId = selectedIbkrAccount) {
    setIbkrSyncStatus('syncing');
    setIbkrError('');
    try {
      const response = await fetch(`${apiBase}/api/ibkr/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'IBKR 同步失败');
      setIbkrSnapshot(payload);
      setIbkrStatus(payload.status || { gateway: 'running', authenticated: true });
      if (payload.account?.accountId) setSelectedIbkrAccount(payload.account.accountId);
      setIbkrSyncStatus('synced');
      if (payload.positions?.[0]?.conid) {
        setExpandedHolding((current) => payload.positions.some((position) => `ibkr-${position.conid}` === current) ? current : `ibkr-${payload.positions[0].conid}`);
      }
      return payload;
    } catch (error) {
      setIbkrError(error.message || 'IBKR 同步失败');
      setIbkrSyncStatus('error');
      await loadIbkrStatus({ preserveError: true });
      return null;
    }
  }

  async function refreshIbkr() {
    const status = await loadIbkrStatus();
    if (status?.gateway === 'offline') return;
    try {
      const accounts = await loadIbkrAccounts();
      const accountId = selectedIbkrAccount || accounts[0]?.accountId || '';
      await syncIbkrPositions(accountId);
    } catch (error) {
      setIbkrError(error.message || 'IBKR 同步失败');
      setIbkrSyncStatus('error');
    }
  }

  function changeIbkrAccount(accountId) {
    setSelectedIbkrAccount(accountId);
    syncIbkrPositions(accountId);
  }

  function addHolding() {
    setNewHoldingTicker('');
    setNewHoldingShares('');
    setNewHoldingCost('');
    setAddHoldingStatus('');
    setAddHoldingOpen(true);
  }

  async function submitNewHolding(event) {
    event.preventDefault();
    const symbol = normalizeTicker(newHoldingTicker);
    if (!symbol) {
      setAddHoldingStatus('请输入股票代码');
      return;
    }
    if (portfolio.some((holding) => holding.symbol.trim().toUpperCase() === symbol)) {
      setAddHoldingStatus('这个股票已在列表中');
      return;
    }
    if (newHoldingShares === '' || newHoldingCost === '') {
      setAddHoldingStatus('请输入股数和成本');
      return;
    }
    const shares = Number(newHoldingShares) || 0;
    const cost = Number(newHoldingCost) || 0;

    setAddHoldingStatus('读取公司名称');
    const name = await resolveCompanyName(symbol);
    const id = `holding-${Date.now()}`;
    setPortfolio((items) => [...items, { id, symbol, name, shares, cost, thesis: '', risk: '' }]);
    setExpandedHolding(id);
    setAddHoldingOpen(false);
    setAddHoldingStatus('');
  }

  function removeHolding(holdingId) {
    setPortfolio((items) => {
      const nextItems = items.filter((holding) => holding.id !== holdingId);
      setExpandedHolding((current) => {
        if (current !== holdingId) return current;
        return nextItems[0]?.id ?? null;
      });
      return nextItems;
    });
  }

  async function loadSecFilings(symbol, force = false) {
    const ticker = symbol.trim().toUpperCase();
    if (!ticker || (!force && secFilings[ticker])) return;
    setSecStatus((current) => ({ ...current, [ticker]: 'loading' }));
    try {
      const response = await fetch(`${apiBase}/api/sec/filings/${encodeURIComponent(ticker)}?limit=12${force ? '&force=1' : ''}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'SEC 文件获取失败');
      setSecFilings((current) => ({ ...current, [ticker]: payload }));
      setSecStatus((current) => ({ ...current, [ticker]: 'loaded' }));
    } catch (error) {
      setSecStatus((current) => ({ ...current, [ticker]: 'error' }));
    }
  }

  async function loadSecReport(symbol, force = false) {
    const ticker = symbol.trim().toUpperCase();
    if (!ticker || (!force && secReports[ticker])) return;
    setSecReportStatus((current) => ({ ...current, [ticker]: 'loading' }));
    try {
      const response = await fetch(`${apiBase}/api/sec/report/${encodeURIComponent(ticker)}${force ? '?force=1' : ''}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'SEC 分析报告获取失败');
      setSecReports((current) => ({ ...current, [ticker]: payload }));
      setSecReportStatus((current) => ({ ...current, [ticker]: 'loaded' }));
    } catch (error) {
      setSecReportStatus((current) => ({ ...current, [ticker]: 'error' }));
    }
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(portfolioStorageKey, JSON.stringify(portfolio));
    } catch (error) {
      // Local persistence is best-effort; the editable in-memory list still works.
    }
  }, [portfolio]);

  useEffect(() => {
    try {
      if (selectedIbkrAccount) window.localStorage.setItem(ibkrAccountStorageKey, selectedIbkrAccount);
    } catch (error) {
      // Account preference is optional; sync still works when it is not persisted.
    }
  }, [selectedIbkrAccount]);

  useEffect(() => {
    if (activeView !== 'portfolio') return;
    let cancelled = false;
    async function bootIbkr() {
      const status = await loadIbkrStatus();
      if (cancelled || status?.gateway === 'offline') return;
      try {
        const accounts = await loadIbkrAccounts();
        if (cancelled) return;
        const accountId = selectedIbkrAccount || accounts[0]?.accountId || '';
        await syncIbkrPositions(accountId);
      } catch (error) {
        if (!cancelled) {
          setIbkrError(error.message || 'IBKR 同步失败');
          setIbkrSyncStatus('error');
        }
      }
    }
    bootIbkr();
    return () => {
      cancelled = true;
    };
  }, [activeView]);

  useEffect(() => {
    const missing = selectedTickers.filter((symbol) => !marketSeries[symbol] && !['loading', 'error'].includes(tickerStatus[symbol]));
    if (!missing.length) return undefined;

    const timer = window.setTimeout(() => {
      missing.forEach(async (symbol) => {
        setTickerStatus((current) => ({ ...current, [symbol]: 'loading' }));
        try {
          const response = await fetch(`${apiBase}/api/prices/${encodeURIComponent(symbol)}`);
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || `Failed to load ${symbol}`);
          setMarketSeries((current) => ({ ...current, [symbol]: payload.rows }));
          setTickerStatus((current) => ({ ...current, [symbol]: payload.source || 'loaded' }));
        } catch (error) {
          setTickerStatus((current) => ({ ...current, [symbol]: 'error' }));
        }
      });
    }, 650);

    return () => window.clearTimeout(timer);
  }, [selectedTickers, marketSeries, tickerStatus]);

  useEffect(() => {
    if (activeView !== 'portfolio' || !expandedHolding) return;
    const holding = displayedPortfolio.find((item) => item.id === expandedHolding);
    if (!holding?.symbol) return;
    loadSecFilings(holding.symbol);
    loadSecReport(holding.symbol);
  }, [activeView, expandedHolding, displayedPortfolio]);

  useEffect(() => {
    if (activeView !== 'portfolio' || !expandedHolding) return undefined;
    const holding = displayedPortfolio.find((item) => item.id === expandedHolding);
    if (!holding?.symbol) return undefined;
    const timer = window.setInterval(() => {
      loadSecFilings(holding.symbol, true);
      loadSecReport(holding.symbol, true);
    }, 3 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [activeView, expandedHolding, displayedPortfolio]);

  useEffect(() => {
    let frame = 0;
    const handleResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setViewportKey((value) => value + 1));
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  function applyRangePreset(preset) {
    if (preset.start) {
      setDateRange({ start: preset.start, end: preset.end });
      return;
    }
    const end = new Date(`${dateRange.end}T00:00:00Z`);
    end.setUTCFullYear(end.getUTCFullYear() - preset.years);
    setDateRange((range) => ({ ...range, start: end.toISOString().slice(0, 10) }));
  }

  function handleSheetTouchStart(event) {
    sheetTouchStart.current = event.touches[0]?.clientY ?? null;
  }

  function handleSheetTouchEnd(event) {
    if (sheetTouchStart.current === null) return;
    const endY = event.changedTouches[0]?.clientY ?? sheetTouchStart.current;
    const delta = endY - sheetTouchStart.current;
    sheetTouchStart.current = null;
    if (delta < -34) setMobileOpen(true);
    if (delta > 34) setMobileOpen(false);
  }

  const chartInterval = rows.length <= 90 ? '日' : rows.length <= 756 ? '周' : '月';
  const displayCurve = displaySeries(primaryResult.curve, chartInterval);
  const displayDrawdowns = displaySeries(primaryResult.drawdowns, chartInterval);
  const equityOption = {
    animation: false,
    legend: { top: 0, right: 8, itemWidth: 18, itemHeight: 3, textStyle: { color: '#5F6B7A', fontFamily: 'Instrument Sans, Noto Sans SC, sans-serif', fontSize: 12 } },
    grid: { left: 52, right: 18, top: 34, bottom: 36 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => formatMoney(v), borderWidth: 0, backgroundColor: '#172033', textStyle: { color: '#F7F3EA' } },
    xAxis: { type: 'category', data: displayCurve.map((p) => p.date), axisLabel: { hideOverlap: true, color: '#7A8493', fontSize: 11 }, axisLine: { lineStyle: { color: '#D7DEE7' } }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: '#7A8493', fontSize: 11, formatter: (v) => `$${Math.round(v / 1000)}k` }, splitLine: { lineStyle: { color: '#E7ECF2' } } },
    series: strategyResults.map(({ strategy, color, result }) => ({
      name: strategy.name,
      type: 'line',
      data: displaySeries(result.curve, chartInterval).map((p) => p.value),
      smooth: 0.18,
      showSymbol: false,
      lineStyle: { color, width: 2.4 }
    }))
  };
  const ddOption = {
    animation: false,
    legend: { top: 0, right: 8, itemWidth: 18, itemHeight: 3, textStyle: { color: '#5F6B7A', fontFamily: 'Instrument Sans, Noto Sans SC, sans-serif', fontSize: 12 } },
    grid: { left: 52, right: 18, top: 28, bottom: 34 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => pct(v, 1), borderWidth: 0, backgroundColor: '#172033', textStyle: { color: '#F7F3EA' } },
    xAxis: { type: 'category', data: displayDrawdowns.map((p) => p.date), axisLabel: { hideOverlap: true, color: '#7A8493', fontSize: 11 }, axisLine: { lineStyle: { color: '#D7DEE7' } }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: '#7A8493', fontSize: 11, formatter: (v) => `${Math.round(v * 100)}%` }, splitLine: { lineStyle: { color: '#E7ECF2' } } },
    series: strategyResults.map(({ strategy, color, result }) => ({
      name: strategy.name,
      type: 'line',
      data: displaySeries(result.drawdowns, chartInterval).map((p) => p.value),
      showSymbol: false,
      areaStyle: { color: 'rgba(150,57,47,.035)' },
      lineStyle: { color, width: 1.8 }
    }))
  };

  const panel = (
    <aside className="ticket">
      <section className="block">
        <div className="blockHead"><h2>资产配置</h2></div>
        <div className="capitalGrid">
          <label>
            <span>总资金</span>
            <input value={Math.round(totalFunding)} onChange={(e) => updateTotalFunding(Number(e.target.value) || 0)} />
          </label>
        </div>
      </section>

      <section className="block">
        <div className="blockHead">
          <h2>策略规则</h2>
          <button className="addAssetButton" onClick={addStrategy}><Plus size={15} />添加策略</button>
        </div>
        {strategies.map((strategy) => (
          <div className="strategyCard" key={strategy.id}>
            <div className="strategyHead">
              <input value={strategy.name} onChange={(e) => updateStrategy(strategy.id, (current) => ({ ...current, name: e.target.value }))} />
              <button className="addAssetButton" onClick={() => addAssetRow(strategy.id)}><Plus size={15} />资产</button>
            </div>
            <div className="assetConfig">
              <div className="assetConfigHeader"><span>Ticker</span><span>持仓</span><span></span></div>
              {strategy.positions.map((h) => (
                <div className="assetConfigRow" key={h.id} data-testid={`asset-row-${h.id}`}>
                  <div className="tickerPicker">
                    <input
                      className="tickerInput"
                      value={h.symbol}
                      onFocus={() => setActiveTicker(h.id)}
                      onChange={(e) => {
                        setActiveTicker(h.id);
                        updatePosition(strategy.id, h.id, 'symbol', e.target.value.toUpperCase());
                      }}
                      onBlur={() => window.setTimeout(() => setActiveTicker((current) => current === h.id ? null : current), 120)}
                    />
                    {activeTicker === h.id && (
                      <div className="tickerMenu">
                        {tickerMatches(h.symbol).map((asset) => (
                          <button
                            type="button"
                            key={asset.symbol}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => selectTicker(strategy.id, h.id, asset.symbol)}
                          >
                            <strong>{asset.symbol}</strong>
                            <span>{asset.name}</span>
                            <em>{asset.type}</em>
                          </button>
                        ))}
                        {!tickerMatches(h.symbol).length && <div className="tickerEmpty">可直接输入新的 Yahoo Finance 代码</div>}
                      </div>
                    )}
                  </div>
                  <input data-testid={`amount-${h.symbol}`} value={Math.round(h.amount)} onChange={(e) => updatePositionAmount(strategy.id, h.id, Number(e.target.value) || 0)} />
                  <button className="iconButton" onClick={() => removeAssetRow(strategy.id, h.id)} aria-label={`删除 ${h.symbol}`}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <div className="ruleComposer">
              <textarea
                value={ruleDrafts[strategy.id] || ''}
                onChange={(e) => updateRuleDraft(strategy.id, e.target.value)}
                placeholder={strategy.rules.displayText ? '继续输入修改意见，例如：更保守一点，不要用杠杆。' : '描述你的策略，例如：QQQ 回撤 25% 时买一点 TQQQ，回撤 35% 时继续加，恢复到前高附近退出。'}
              />
              <button className="parseButton" onClick={() => parseRuleDraft(strategy.id)} disabled={parseStatus[strategy.id] === '转换中'}>
                {parseStatus[strategy.id] === '转换中' ? '生成中' : '生成策略'}
              </button>
              {parseStatus[strategy.id] && <span>{parseStatus[strategy.id]}</span>}
            </div>
            <div className="strategyOutput">
              <span>生成后的策略</span>
              <p>{strategy.rules.displayText || '生成后会显示整理后的自然语言策略。'}</p>
            </div>
          </div>
        ))}
      </section>
    </aside>
  );

  const isPhoneViewport = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;

  function renderSecAnalysisReport(ticker) {
    const report = secReports[ticker];
    const status = secReportStatus[ticker];
    const latest = report?.financials?.latest;
    const quarters = report?.financials?.quarters || [];

    return (
      <section className="secAnalysisPanel" aria-label="SEC 分析报告">
        <div className="secAnalysisHead">
          <div>
            <span>SEC 分析报告</span>
            <strong>{report?.companyName || ticker}</strong>
          </div>
          <button className="addAssetButton" onClick={() => loadSecReport(ticker, true)} disabled={status === 'loading'}>
            {status === 'loading' ? '生成中' : '更新报告'}
          </button>
        </div>

        {status === 'loading' && <p className="secFilingState">正在读取 SEC company facts 和近期 filing...</p>}
        {status === 'error' && <p className="secFilingState">报告生成失败。SEC 文件下载仍可使用。</p>}
        {report && (
          <>
            <div className="secInsightGrid">
              <div>
                <span>最新季度营收</span>
                <strong>{compactMoney(latest?.revenue)}</strong>
                <em>{hasNumber(latest?.revenueYoY) ? `${latest?.period} / YoY ${pct(latest?.revenueYoY)}` : latest?.period || 'n/a'}</em>
              </div>
              <div>
                <span>毛利率</span>
                <strong>{pct(latest?.grossMargin)}</strong>
                <em>{latest?.period || 'n/a'}</em>
              </div>
              <div>
                <span>净利率</span>
                <strong>{pct(latest?.netMargin)}</strong>
                <em>{hasNumber(latest?.netIncomeYoY) ? `净利润 YoY ${pct(latest?.netIncomeYoY)}` : latest?.period || 'n/a'}</em>
              </div>
            </div>

            <div className="secSummaryList">
              {report.summary.map((line) => <p key={line}>{line}</p>)}
            </div>

            <div className="secAlertRail">
              {report.alerts.map((alert) => (
                <div className={`secAlert ${alert.severity}`} key={`${alert.label}-${alert.detail}`}>
                  <AlertTriangle size={15} />
                  <span>{alert.label}</span>
                  <em>{alert.detail}</em>
                </div>
              ))}
            </div>

            <div className="secAiGrid">
              <div>
                <span>Guidance / Outlook</span>
                {(report.ai?.guidanceChanges || []).slice(0, 3).map((item, index) => (
                  <p key={`guidance-${index}`}>{item.detail || item.status || '已定位 guidance 相关文本。'}</p>
                ))}
                {!report.ai?.guidanceChanges?.length && <p>最新 SEC 文件未定位到明确 Guidance / Outlook，等待 8-K 或 earnings release 复核。</p>}
              </div>
              <div>
                <span>AI 风险信号</span>
                {(report.ai?.riskFlags || []).slice(0, 3).map((item, index) => (
                  <p key={`risk-${index}`}>{item.detail || item.label || '风险文本需要复核。'}</p>
                ))}
                {!report.ai?.riskFlags?.length && <p>未触发文本风险信号。</p>}
              </div>
            </div>

            {quarters.length > 0 && (
              <>
                <div className="secChartGrid">
                  <div className="secMiniChart">
                    <span>营收变化</span>
                    <ReactECharts option={reportChartOption(report, 'revenue-yoy')} style={{ height: 190 }} notMerge />
                  </div>
                  <div className="secMiniChart">
                    <span>利润率变化</span>
                    <ReactECharts option={reportChartOption(report, 'margin-lines')} style={{ height: 190 }} notMerge />
                  </div>
                </div>
                <div className="secMetricTableWrap">
                  <table className="secMetricTable">
                    <thead>
                      <tr>
                        <th>季度</th>
                        <th>营收</th>
                        <th>YoY</th>
                        <th>毛利率</th>
                        <th>经营利率</th>
                        <th>净利率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quarters.slice(-8).map((row, index) => (
                        <tr key={`${row.period}-${row.accessionNumber || row.filed}-${index}`}>
                          <td>{row.period}</td>
                          <td>{compactMoney(row.revenue)}</td>
                          <td>{pct(row.revenueYoY)}</td>
                          <td>{pct(row.grossMargin)}</td>
                          <td>{pct(row.operatingMargin)}</td>
                          <td>{pct(row.netMargin)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>
    );
  }

  function renderHoldingDetail(holding, className = '') {
    if (!holding) return null;
    const ticker = holding.symbol.trim().toUpperCase();
    const filingPayload = ticker ? secFilings[ticker] : null;
    const filingStatus = ticker ? secStatus[ticker] : null;
    const marketValue = Number(holding.marketValue) || (Number(holding.shares) || 0) * (Number(holding.marketPrice ?? holding.cost) || 0);
    const isIbkr = holding.source === 'ibkr';

    return (
      <article className={`holdingDetail ${className}`.trim()} aria-label="持仓详情">
        <div className="detailHero">
          <div>
            <span>{ticker || 'TICKER'}{isIbkr ? ' / IBKR' : ''}</span>
            <h3>{holding.name || '未命名持仓'}</h3>
          </div>
          <strong>{formatMoney(marketValue)}</strong>
        </div>
        {isIbkr && (
          <div className="ibkrMetricGrid">
            <div><span>数量</span><strong>{Number(holding.shares || 0).toLocaleString('en-US', { maximumFractionDigits: 4 })}</strong></div>
            <div><span>平均成本</span><strong>{formatMoney(Number(holding.cost) || 0)}</strong></div>
            <div><span>现价</span><strong>{hasNumber(Number(holding.marketPrice)) ? formatMoney(Number(holding.marketPrice)) : 'n/a'}</strong></div>
            <div><span>P&L</span><strong className={Number(holding.unrealizedPnl) >= 0 ? 'gain' : 'loss'}>{hasNumber(Number(holding.unrealizedPnl)) ? formatMoney(Number(holding.unrealizedPnl)) : 'n/a'}</strong></div>
            <div><span>货币</span><strong>{holding.currency || 'USD'}</strong></div>
            <div><span>ConID</span><strong>{holding.conid}</strong></div>
          </div>
        )}
        <div className="holdingNotes">
          <label>
            <span>持仓逻辑</span>
            <textarea value={holding.thesis} onChange={(e) => updateHolding(holding.id, 'thesis', e.target.value)} />
          </label>
          <label>
            <span>风险点</span>
            <textarea value={holding.risk} onChange={(e) => updateHolding(holding.id, 'risk', e.target.value)} />
          </label>
        </div>
        {ticker && renderSecAnalysisReport(ticker)}
        <div className="secFilingPanel">
          <div className="secFilingHead">
            <span>SEC 文件</span>
            <em>{filingPayload?.company?.name || ticker}</em>
          </div>
          {filingStatus === 'loading' && <p className="secFilingState">正在获取 10-K / 10-Q / 8-K...</p>}
          {filingStatus === 'error' && <p className="secFilingState">自动获取失败，可先用 SEC 搜索打开。</p>}
          {filingStatus !== 'loading' && filingPayload?.filings?.length === 0 && <p className="secFilingState">未找到 10-K / 10-Q / 8-K。</p>}
          {filingPayload?.filings?.length > 0 && (
            <div className="secFilingList">
              {filingPayload.filings.map((filing) => (
                <div className="secFilingRow" key={filing.accessionNumber}>
                  <div>
                    <strong>{filing.form}</strong>
                    <span>{filing.filingDate}{filing.reportDate ? ` / ${filing.reportDate}` : ''}</span>
                  </div>
                  <a
                    href={`${apiBase}${filing.pdfUrl}`}
                    download={`${ticker}-${filing.form}-${filing.filingDate}.pdf`}
                  >
                    下载 PDF
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="secStrip">
          <button className="addAssetButton" onClick={() => {
            loadSecFilings(holding.symbol, true);
            loadSecReport(holding.symbol, true);
          }}>
            <FileDown size={16} />
            {filingStatus === 'loading' ? '获取中' : '刷新 SEC'}
          </button>
          <a href={secFilingsUrl(holding.symbol)} target="_blank" rel="noreferrer">
            <FileDown size={16} />
            搜索公司
          </a>
          <a href={secCompanyUrl(holding.symbol)} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            SEC 档案
          </a>
        </div>
      </article>
    );
  }

  const portfolioView = (
    <section className="portfolioDesk" aria-label="个人持仓">
      <div className="portfolioGrid">
        <aside className="holdingList" aria-label="持仓列表">
          <div className={`ibkrPanel ${hasIbkrAccess ? 'connected' : ''}`}>
            <div>
              <strong>{hasIbkrAccess ? 'IBKR 已连接' : ibkrStatus.gateway === 'offline' ? 'IBKR Gateway 未运行' : '需要登录 IBKR'}</strong>
              <span>
                {ibkrSnapshot?.lastSyncAt ? `最后同步 ${new Date(ibkrSnapshot.lastSyncAt).toLocaleString('zh-CN')}` : '未同步账户持仓'}
              </span>
            </div>
            <div className="ibkrActions">
              {ibkrAccounts.length > 0 && (
                <select value={selectedIbkrAccount} onChange={(event) => changeIbkrAccount(event.target.value)}>
                  {ibkrAccounts.map((account) => (
                    <option key={account.accountId} value={account.accountId}>{account.accountTitle || account.accountId}</option>
                  ))}
                </select>
              )}
              <a className="ibkrLoginLink" href={ibkrStatus.loginUrl || 'https://localhost:5001'} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开登录页</a>
              <button className="iconTextButton" onClick={refreshIbkr} disabled={ibkrSyncStatus === 'syncing'}>
                <RefreshCw size={14} />
                {ibkrSyncStatus === 'syncing' ? '同步中' : '刷新状态'}
              </button>
            </div>
            {(ibkrError || (!hasIbkrAccess && ibkrStatus.gateway !== 'offline')) && (
              <p>{ibkrError || '完成 IBKR 2FA 后点击刷新状态。'}</p>
            )}
          </div>
          <div className="portfolioHead">
            <div>
              <h2>{showingIbkrPortfolio ? 'IBKR 持仓' : '个人持仓'}</h2>
            </div>
            <button className="addAssetButton" onClick={addHolding}><Plus size={15} />手动添加</button>
          </div>
          {displayedPortfolio.length === 0 && (
            <div className="holdingEmpty">
              <strong>没有可显示的持仓</strong>
              <span>登录 IBKR 同步，或先手动添加股票。</span>
            </div>
          )}
          {displayedPortfolio.map((holding) => {
            const isOpen = expandedHolding === holding.id;
            const isIbkr = holding.source === 'ibkr';
            const marketValue = Number(holding.marketValue) || (Number(holding.shares) || 0) * (Number(holding.marketPrice ?? holding.cost) || 0);
            const pnl = Number(holding.unrealizedPnl);
            return (
              <article className={`holdingRow ${isOpen ? 'open' : ''}`} key={holding.id}>
                <div className="holdingSummary">
                  <button className="holdingSelect" onClick={() => selectHolding(holding.id)} aria-pressed={isOpen}>
                    <span className="holdingTicker">{holding.symbol || 'TICKER'} <em>{isIbkr ? 'IBKR' : '本地'}</em></span>
                    <span className="holdingValue">
                      {formatMoney(marketValue)}
                      {isIbkr && hasNumber(pnl) && <small className={pnl >= 0 ? 'gain' : 'loss'}>{formatMoney(pnl)}</small>}
                    </span>
                  </button>
                  {!isIbkr ? (
                    <button className="holdingDelete" onClick={() => removeHolding(holding.id)} aria-label={`删除 ${holding.symbol || '股票'}`}>
                      <Trash2 size={15} />
                    </button>
                  ) : <span className="holdingLock">只读</span>}
                </div>
                <div className="holdingFields">
                  <label>
                    <span>Ticker</span>
                    <input value={holding.symbol} readOnly={isIbkr} onFocus={() => setExpandedHolding(holding.id)} onChange={(e) => updateHoldingTicker(holding.id, e.target.value)} />
                  </label>
                  <label>
                    <span>公司</span>
                    <input value={holding.name} onFocus={() => setExpandedHolding(holding.id)} onChange={(e) => updateHolding(holding.id, 'name', e.target.value)} />
                  </label>
                  <label>
                    <span>股数</span>
                    <input inputMode="decimal" value={holding.shares} readOnly={isIbkr} onFocus={() => setExpandedHolding(holding.id)} onChange={(e) => updateHolding(holding.id, 'shares', e.target.value)} />
                  </label>
                  <label>
                    <span>{isIbkr ? '平均成本' : '成本'}</span>
                    <input inputMode="decimal" value={holding.cost} readOnly={isIbkr} onFocus={() => setExpandedHolding(holding.id)} onChange={(e) => updateHolding(holding.id, 'cost', e.target.value)} />
                  </label>
                </div>
                {isOpen && isPhoneViewport && <div className="holdingInlineDetail">{renderHoldingDetail(holding)}</div>}
              </article>
            );
          })}
        </aside>

        {!isPhoneViewport && renderHoldingDetail(selectedHolding, 'holdingDetailDesktop')}
      </div>
    </section>
  );

  return (
    <div className="shell">
      <nav className="viewTabs" aria-label="页面切换">
        <button className={activeView === 'backtest' ? 'active' : ''} onClick={() => setActiveView('backtest')}>回测</button>
        <button className={activeView === 'portfolio' ? 'active' : ''} onClick={() => setActiveView('portfolio')}><Briefcase size={15} />持仓</button>
      </nav>
      <div className={`app ${activeView === 'portfolio' ? 'portfolioMode' : ''}`}>
      <div className={`mobileSheet ${mobileOpen ? 'open' : ''}`} onTouchStart={handleSheetTouchStart} onTouchEnd={handleSheetTouchEnd}>
        <button
          className="sheetGrip"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label={mobileOpen ? '下滑收起配置面板' : '上拉打开资产配置'}
        >
          <span className="sheetHandleBars" aria-hidden="true"><i /><i /></span>
          <span className="sheetHint">{mobileOpen ? '下滑收起配置' : '上拉配置资产'}</span>
        </button>
        {panel}
      </div>
      <div className="desktopPanel">{panel}</div>
      <main className="workspace">
        {activeView === 'backtest' ? (
          <>
        <section className="metrics">
          {strategyResults.map(({ strategy, color, result }) => (
            <div key={strategy.id} style={{ '--accent': color }}>
              <span>{strategy.name}</span>
              <strong>{formatMoney(result.stats.end)}</strong>
              <em className={result.stats.totalReturn >= 0 ? 'pos' : 'neg'}>{pct(result.stats.totalReturn)} / 回撤 {pct(result.stats.maxDd)}</em>
            </div>
          ))}
        </section>
        <section className="chartPanel">
          <div className="chartHeader">
            <div className="panelTitle"><h2>收益曲线</h2><span>策略或时间变化后自动回测，当前坐标按{chartInterval}展示</span></div>
            <div className="rangeBar" aria-label="Backtest Range Bar">
              <input
                type="date"
                value={dateRange.start}
                onInput={(e) => updateDate('start', e.currentTarget.value)}
                onChange={(e) => updateDate('start', e.currentTarget.value)}
              />
              <span>至</span>
              <input
                type="date"
                value={dateRange.end}
                onInput={(e) => updateDate('end', e.currentTarget.value)}
                onChange={(e) => updateDate('end', e.currentTarget.value)}
              />
              <div className="rangePresets">
                {rangePresets.map((preset) => <button key={preset.label} onClick={() => applyRangePreset(preset)}>{preset.label}</button>)}
              </div>
            </div>
          </div>
          <ReactECharts key={`equity-${viewportKey}`} option={equityOption} style={{ height: 330 }} />
          <div className="seriesNote">回测按 {primaryResult.curve.length.toLocaleString()} 个交易日计算；图表显示 {displayCurve.length.toLocaleString()} 个{chartInterval}末节点。</div>
        </section>
        <section>
          <div className="chartPanel">
            <div className="panelTitle"><h2>回撤曲线</h2><span>显示多策略最大回撤路径</span></div>
            <ReactECharts key={`drawdown-${viewportKey}`} option={ddOption} style={{ height: 260 }} />
          </div>
        </section>
          </>
        ) : portfolioView}
      </main>
      </div>
      {addHoldingOpen && (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => setAddHoldingOpen(false)}>
          <form className="tickerModal" onSubmit={submitNewHolding} onMouseDown={(event) => event.stopPropagation()}>
            <div className="tickerModalHead">
              <h2>添加股票</h2>
              <button type="button" className="modalCloseButton" onClick={() => setAddHoldingOpen(false)}>取消</button>
            </div>
            <label>
              <span>Ticker</span>
              <input
                autoFocus
                value={newHoldingTicker}
                onChange={(event) => {
                  setNewHoldingTicker(normalizeTicker(event.target.value));
                  setAddHoldingStatus('');
                }}
                placeholder="NVDA"
              />
            </label>
            <div className="tickerModalGrid">
              <label>
                <span>股数</span>
                <input
                  inputMode="decimal"
                  value={newHoldingShares}
                  onChange={(event) => {
                    setNewHoldingShares(event.target.value);
                    setAddHoldingStatus('');
                  }}
                  placeholder="10"
                />
              </label>
              <label>
                <span>成本</span>
                <input
                  inputMode="decimal"
                  value={newHoldingCost}
                  onChange={(event) => {
                    setNewHoldingCost(event.target.value);
                    setAddHoldingStatus('');
                  }}
                  placeholder="120.5"
                />
              </label>
            </div>
            {addHoldingStatus && <p>{addHoldingStatus}</p>}
            <button type="submit" className="parseButton" disabled={addHoldingStatus === '读取公司名称'}>添加股票</button>
          </form>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
