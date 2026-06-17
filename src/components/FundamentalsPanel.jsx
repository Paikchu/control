import React from 'react';
import ReactECharts from 'echarts-for-react';
import { selectCanonicalFinancialQuarters } from '../secReport.mjs';
import { compactMoney, hasNumber, pct } from '../lib/format.js';

// 基本面页签：营收/利润率（来自 Yahoo Finance）+ 估值/DCF（来自 Yahoo + AI 假设）
// 合并为单一连贯面板，只展示数据卡片与图表，不带标题、解释文字或文本告警。

function verdictClass(verdict) {
  if (verdict === '低估') return 'thesisBadgeOk';
  if (verdict === '高估') return 'thesisBadgeDanger';
  if (verdict === '合理') return 'thesisBadgeNeutral';
  return 'thesisBadgePending';
}

function scenarioLabel(caseName) {
  if (caseName === 'bear') return '熊市';
  if (caseName === 'bull') return '牛市';
  return '基准';
}

function revenueChartOption(rows) {
  const periods = rows.map((row) => row.period);
  const grid = { left: 46, right: 16, top: 28, bottom: 28 };
  const axisText = { color: '#6b7280', fontSize: 10 };
  // 季度视图下 Yahoo 无上一年同季度数据，YoY 全空 —— 隐藏空线，只画营收柱。
  const hasYoY = rows.some((row) => hasNumber(row.revenueYoY));
  const series = [
    { name: '营收', type: 'bar', data: rows.map((row) => row.revenue), itemStyle: { color: '#2563eb' }, barMaxWidth: 22 }
  ];
  if (hasYoY) {
    series.push({
      name: 'YoY',
      type: 'line',
      yAxisIndex: 1,
      data: rows.map((row) => row.revenueYoY),
      showSymbol: true,
      symbolSize: 5,
      connectNulls: true,
      label: { show: true, formatter: ({ value }) => hasNumber(value) ? pct(value, 0) : '', color: '#0f7a4d', fontSize: 10 },
      lineStyle: { color: '#0f7a4d', width: 2 }
    });
  }
  const moneyAxis = { type: 'value', axisLabel: { ...axisText, formatter: (v) => compactMoney(v) }, splitLine: { lineStyle: { color: '#e5e7eb' } } };
  const pctAxis = { type: 'value', axisLabel: { ...axisText, formatter: (v) => pct(v, 0) }, splitLine: { show: false } };
  return {
    animation: false,
    legend: { top: 0, right: 4, itemWidth: 14, itemHeight: 4, textStyle: { color: '#5f6b7a', fontSize: 10 } },
    grid,
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: periods, axisLabel: axisText, axisTick: { show: false } },
    yAxis: hasYoY ? [moneyAxis, pctAxis] : [moneyAxis],
    series
  };
}

function marginChartOption(rows) {
  const periods = rows.map((row) => row.period);
  const grid = { left: 46, right: 16, top: 28, bottom: 28 };
  const axisText = { color: '#6b7280', fontSize: 10 };
  return {
    animation: false,
    legend: { top: 0, right: 4, itemWidth: 14, itemHeight: 4, textStyle: { color: '#5f6b7a', fontSize: 10 } },
    grid,
    tooltip: { trigger: 'axis', valueFormatter: (value) => pct(value, 1) },
    xAxis: { type: 'category', data: periods, axisLabel: axisText, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { ...axisText, formatter: (v) => pct(v, 0) }, splitLine: { lineStyle: { color: '#e5e7eb' } } },
    series: [
      { name: '毛利率', type: 'line', data: rows.map((row) => row.grossMargin), showSymbol: true, symbolSize: 4, connectNulls: true, lineStyle: { color: '#2563eb', width: 2 } },
      { name: '经营利润率', type: 'line', data: rows.map((row) => row.operatingMargin), showSymbol: true, symbolSize: 4, connectNulls: true, lineStyle: { color: '#b15c00', width: 2 } },
      { name: '净利率', type: 'line', data: rows.map((row) => row.netMargin), showSymbol: true, symbolSize: 4, connectNulls: true, lineStyle: { color: '#0f7a4d', width: 2 } }
    ]
  };
}

function multiplesChartOption(valuation) {
  const chart = valuation?.charts?.multiples || { labels: [], values: [] };
  const axisText = { color: '#6b7280', fontSize: 10 };
  return {
    animation: false,
    grid: { left: 46, right: 16, top: 28, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: chart.labels, axisLabel: axisText, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: axisText, splitLine: { lineStyle: { color: '#e5e7eb' } } },
    series: [{ type: 'bar', data: chart.values, itemStyle: { color: '#2563eb' }, barMaxWidth: 32 }]
  };
}

function priceTargetChartOption(valuation) {
  const chart = valuation?.charts?.priceTarget || {};
  const dates = chart.dates || [];
  const axisText = { color: '#6b7280', fontSize: 10 };
  const markLines = [];
  if (hasNumber(chart.targetLow)) markLines.push({ name: '目标低', yAxis: chart.targetLow, lineStyle: { color: '#b91c1c' } });
  if (hasNumber(chart.targetMean)) markLines.push({ name: '目标均值', yAxis: chart.targetMean, lineStyle: { color: '#0f7a4d' } });
  if (hasNumber(chart.targetHigh)) markLines.push({ name: '目标高', yAxis: chart.targetHigh, lineStyle: { color: '#2563eb' } });

  return {
    animation: false,
    grid: { left: 46, right: 16, top: 28, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: dates.slice(-180), axisLabel: { ...axisText, show: false }, axisTick: { show: false } },
    yAxis: { type: 'value', axisLabel: { ...axisText, formatter: (v) => `$${v}` }, splitLine: { lineStyle: { color: '#e5e7eb' } } },
    series: [{
      name: '价格',
      type: 'line',
      data: (chart.closes || []).slice(-180),
      showSymbol: false,
      lineStyle: { color: '#334155', width: 2 },
      markLine: { silent: true, symbol: 'none', label: { formatter: '{b}' }, data: markLines }
    }]
  };
}

export function FundamentalsPanel({ ticker, report, reportStatus, valuation, valuationStatus, onRefresh }) {
  const [periodMode, setPeriodMode] = React.useState('quarter');

  const latest = report?.financials?.latest;
  const quarterRows = selectCanonicalFinancialQuarters(report?.financials?.quarters || []);
  const annualRows = selectCanonicalFinancialQuarters(report?.financials?.annual || []);
  const canToggle = annualRows.length > 0;
  const showAnnual = periodMode === 'annual' && canToggle;
  const activeRows = showAnnual ? annualRows : quarterRows;
  const periodLabel = showAnnual ? '年度' : '季度';

  const val = valuation?.valuation;
  const scenarios = valuation?.scenarios || [];
  const range = valuation?.fairValueRange;

  const loading = reportStatus === 'loading' || valuationStatus === 'loading';

  return (
    <section className="secAnalysisPanel fundamentalsPanel" aria-label="基本面">
      <div className="secAnalysisHead fundamentalsHead">
        <button className="addAssetButton" onClick={onRefresh} disabled={loading}>
          {loading ? '读取中' : '更新'}
        </button>
      </div>

      {loading && !report && <p className="secFilingState">正在读取财务与估值数据...</p>}
      {reportStatus === 'error' && !report && <p className="secFilingState">数据读取失败，稍后重试。</p>}

      {report && (
        <>
          <div className="secInsightGrid">
            <div>
              <span>最新季度营收</span>
              <strong>{compactMoney(latest?.revenue)}</strong>
              <em>{latest?.period || 'n/a'}</em>
            </div>
            <div>
              <span>毛利率</span>
              <strong>{pct(latest?.grossMargin)}</strong>
              <em>{latest?.period || 'n/a'}</em>
            </div>
            <div>
              <span>净利率</span>
              <strong>{pct(latest?.netMargin)}</strong>
              <em>{latest?.period || 'n/a'}</em>
            </div>
            {val && (
              <div>
                <span>当前价格</span>
                <strong>{hasNumber(val.currentPrice) ? `$${val.currentPrice.toFixed(2)}` : 'n/a'}</strong>
                <em>市值 {compactMoney(val.marketCap)}</em>
              </div>
            )}
            {valuation && (
              <div>
                <span>公允价值区间</span>
                <strong>{hasNumber(range?.low) && hasNumber(range?.high) ? `$${range.low} - $${range.high}` : 'n/a'}</strong>
                <em>基准 ${hasNumber(range?.mid) ? range.mid : 'n/a'}</em>
              </div>
            )}
            {valuation && (
              <div>
                <span>估值判断</span>
                <strong><span className={`thesisBadge ${verdictClass(valuation.verdict)}`}>{valuation.verdict || '待定'}</span></strong>
                <em>{hasNumber(valuation.confidence) ? `AI 置信度 ${pct(valuation.confidence, 0)}` : ''}</em>
              </div>
            )}
          </div>

          {activeRows.length > 0 && (
            <>
              {canToggle && (
                <div className="secPeriodToggle" role="tablist" aria-label="季度或年度">
                  <button className={!showAnnual ? 'active' : ''} onClick={() => setPeriodMode('quarter')} role="tab" aria-selected={!showAnnual}>季度</button>
                  <button className={showAnnual ? 'active' : ''} onClick={() => setPeriodMode('annual')} role="tab" aria-selected={showAnnual}>年度</button>
                </div>
              )}
              <div className="secChartGrid">
                <div className="secMiniChart">
                  <span>营收变化（{periodLabel}）</span>
                  <ReactECharts option={revenueChartOption(activeRows)} style={{ height: 190 }} notMerge />
                </div>
                <div className="secMiniChart">
                  <span>利润率变化（{periodLabel}）</span>
                  <ReactECharts option={marginChartOption(activeRows)} style={{ height: 190 }} notMerge />
                </div>
              </div>
              <div className="secMetricTableWrap">
                <table className="secMetricTable">
                  <thead>
                    <tr>
                      <th>{periodLabel}</th>
                      <th>营收</th>
                      <th>YoY</th>
                      <th>毛利率</th>
                      <th>经营利率</th>
                      <th>净利率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeRows.slice(-8).map((row, index) => (
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

          {scenarios.length > 0 && (
            <div className="dcfScenarioGrid">
              {scenarios.map((scenario) => (
                <div className={`dcfScenarioCard dcfScenario-${scenario.case}`} key={scenario.case}>
                  <span>{scenarioLabel(scenario.case)}</span>
                  <strong>{hasNumber(scenario.fairValuePerShare) ? `$${scenario.fairValuePerShare}` : 'n/a'}</strong>
                  <em>{hasNumber(scenario.upsidePercent) ? `${scenario.upsidePercent > 0 ? '+' : ''}${scenario.upsidePercent}% vs 现价` : ''}</em>
                  <div className="dcfScenarioAssumptions">
                    <span>收入增速 {pct(scenario.revenueGrowth, 1)}</span>
                    <span>FCF 利润率 {pct(scenario.fcfMargin, 1)}</span>
                    <span>折现率 {pct(scenario.discountRate, 1)}</span>
                    <span>永续增长 {pct(scenario.terminalGrowth, 1)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {valuation && (
            <div className="secChartGrid">
              <div className="secMiniChart">
                <span>估值倍数</span>
                <ReactECharts option={multiplesChartOption(valuation)} style={{ height: 190 }} notMerge />
              </div>
              <div className="secMiniChart">
                <span>价格 vs 分析师目标价</span>
                <ReactECharts option={priceTargetChartOption(valuation)} style={{ height: 190 }} notMerge />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
