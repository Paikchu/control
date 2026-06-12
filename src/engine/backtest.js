// 回测内核：纯函数，不依赖 React 和网络。
// 策略合同以 rules.conditions[] 为准；旧 thresholds/exitRecovery 仅在
// normalizeConditions 里兼容。

export function createCondition(index = 0) {
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

export function createExitCondition(index = 2) {
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

// 离线基准价格：在外部行情不可用时保证回测可运行。
export function generatePrices(startYear = 1999, endYear = 2026) {
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

export function metric(curve) {
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

export function backtest({ rows, holdings, rules }) {
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

export function normalizeConditions(rules) {
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

export function conditionTriggered(condition, row, peaks, history, priceFor) {
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

export function displaySeries(points, interval) {
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
