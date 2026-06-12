import React, { useEffect, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { Plus, Trash2 } from 'lucide-react';
import { apiBase } from '../api/client.js';
import {
  backtest,
  createCondition,
  createExitCondition,
  displaySeries,
  generatePrices,
  normalizeConditions
} from '../engine/backtest.js';
import { fallbackSymbols, normalizeTicker, rangePresets, strategyColors, tickerMatches } from '../lib/catalog.js';
import { formatMoney, pct } from '../lib/format.js';
import { mergePriceData } from '../marketSeries.mjs';
import { deriveConditionsFromText } from '../strategyRules.mjs';

// 回测工作台。当前应用只挂载持仓视图（PRODUCT 决策，见 PROJECT_GUIDE），
// 该组件保持自包含，挂载即可恢复回测 UI。

const priceData = generatePrices();

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

export function BacktestView() {
  const [strategies, setStrategies] = useState([
    createStrategy(1, '深回撤增强'),
    {
      ...createStrategy(2, '保守触发'),
      rules: { thresholds: [{ drawdown: 30, weight: 8 }, { drawdown: 40, weight: 15 }], exitRecovery: 5 }
    }
  ]);
  const [totalFunding, setTotalFunding] = useState(20000);
  const [dateRange, setDateRange] = useState({ start: '2000-01-03', end: '2025-12-31' });
  const [activeTicker, setActiveTicker] = useState(null);
  const [marketSeries, setMarketSeries] = useState({});
  const [tickerStatus, setTickerStatus] = useState({});
  const [ruleDrafts, setRuleDrafts] = useState({});
  const [parseStatus, setParseStatus] = useState({});

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
          conditions: (() => {
            const derived = deriveConditionsFromText(payload.strategy.displayText || description, normalizeConditions(strategy.rules));
            return derived.length ? derived : normalizeConditions(strategy.rules);
          })(),
          displayText: payload.strategy.displayText || strategy.rules.displayText || description
        }
      }));
      setRuleDrafts((current) => ({ ...current, [strategyId]: '' }));
      setParseStatus((current) => ({ ...current, [strategyId]: '规则已更新' }));
    } catch (error) {
      setParseStatus((current) => ({ ...current, [strategyId]: '转换失败' }));
    }
  }

  function updateCondition(strategyId, conditionId, key, value) {
    updateStrategy(strategyId, (strategy) => ({
      ...strategy,
      rules: {
        ...strategy.rules,
        conditions: normalizeConditions(strategy.rules).map((condition) => {
          if (condition.id !== conditionId) return condition;
          const nextValue = ['value', 'targetWeight', 'priority'].includes(key) ? Number(value) || 0 : value;
          return { ...condition, [key]: nextValue };
        })
      }
    }));
  }

  function addCondition(strategyId) {
    updateStrategy(strategyId, (strategy) => {
      const conditions = normalizeConditions(strategy.rules);
      return {
        ...strategy,
        rules: {
          ...strategy.rules,
          conditions: [...conditions, createCondition(conditions.length)]
        }
      };
    });
  }

  function removeCondition(strategyId, conditionId) {
    updateStrategy(strategyId, (strategy) => {
      const conditions = normalizeConditions(strategy.rules).filter((condition) => condition.id !== conditionId);
      return {
        ...strategy,
        rules: {
          ...strategy.rules,
          conditions: conditions.length ? conditions : [createCondition(0)]
        }
      };
    });
  }

  function selectTicker(strategyId, positionId, symbol) {
    updatePosition(strategyId, positionId, 'symbol', symbol);
    setActiveTicker(null);
  }

  function applyRangePreset(preset) {
    if (preset.start) {
      setDateRange({ start: preset.start, end: preset.end });
      return;
    }
    const end = new Date(`${dateRange.end}T00:00:00Z`);
    end.setUTCFullYear(end.getUTCFullYear() - preset.years);
    setDateRange((range) => ({ ...range, start: end.toISOString().slice(0, 10) }));
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

  return (
    <section className="backtestDesk" aria-label="策略回测">
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
                  {parseStatus[strategy.id] === '转换中' ? '转换中' : '整理规则'}
                </button>
                {parseStatus[strategy.id] && <span>{parseStatus[strategy.id]}</span>}
              </div>
              <div className="strategyOutput">
                <span>当前规则</span>
                <p>{strategy.rules.displayText || '整理后会显示当前策略。'}</p>
              </div>
              <div className="conditionTableWrap">
                <div className="conditionTableHead">
                  <span>触发条件</span>
                  <button className="textButton" onClick={() => addCondition(strategy.id)}><Plus size={14} />条件</button>
                </div>
                <div className="conditionTable" role="table" aria-label={`${strategy.name} 条件表`}>
                  <div className="conditionHeader" role="row">
                    <span>资产</span>
                    <span>指标</span>
                    <span>方向</span>
                    <span>阈值</span>
                    <span>目标</span>
                    <span>权重</span>
                    <span>优先</span>
                    <span></span>
                  </div>
                  {normalizeConditions(strategy.rules).map((condition) => (
                    <div className="conditionRow" role="row" key={condition.id}>
                      <input value={condition.triggerAsset} onChange={(e) => updateCondition(strategy.id, condition.id, 'triggerAsset', normalizeTicker(e.target.value))} aria-label="触发资产" />
                      <select value={condition.metric} onChange={(e) => updateCondition(strategy.id, condition.id, 'metric', e.target.value)} aria-label="指标">
                        <option value="drawdown">回撤</option>
                        <option value="price_above_ma">高于均线</option>
                        <option value="price_below_ma">低于均线</option>
                      </select>
                      <select value={condition.operator} onChange={(e) => updateCondition(strategy.id, condition.id, 'operator', e.target.value)} aria-label="方向">
                        <option value=">=">达到</option>
                        <option value="<=">回到</option>
                      </select>
                      <input inputMode="decimal" value={condition.value} onChange={(e) => updateCondition(strategy.id, condition.id, 'value', e.target.value)} aria-label="阈值" />
                      <input value={condition.targetAsset} onChange={(e) => updateCondition(strategy.id, condition.id, 'targetAsset', normalizeTicker(e.target.value))} aria-label="目标资产" />
                      <input inputMode="decimal" value={condition.targetWeight} onChange={(e) => updateCondition(strategy.id, condition.id, 'targetWeight', e.target.value)} aria-label="目标权重" />
                      <input inputMode="numeric" value={condition.priority} onChange={(e) => updateCondition(strategy.id, condition.id, 'priority', e.target.value)} aria-label="优先级" />
                      <button className="iconButton dangerButton" onClick={() => removeCondition(strategy.id, condition.id)} aria-label="删除条件"><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </section>
      </aside>

      <section className="charts">
        <div className="rangeRow">
          {rangePresets.map((preset) => (
            <button key={preset.label} onClick={() => applyRangePreset(preset)}>{preset.label}</button>
          ))}
        </div>
        <ReactECharts option={equityOption} style={{ height: 320 }} notMerge />
        <ReactECharts option={ddOption} style={{ height: 220 }} notMerge />
      </section>
    </section>
  );
}
