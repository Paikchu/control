import React from 'react';
import ReactECharts from 'echarts-for-react';
import { selectCanonicalFinancialQuarters, selectRenderableAiInsights } from '../secReport.mjs';
import { compactMoney, hasNumber, pct } from '../lib/format.js';
import { AlertTriangle } from 'lucide-react';

function reportChartOption(report, chartId, displayQuarters = null) {
  const quarters = displayQuarters || report?.financials?.quarters || [];
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

// SEC 文件信号面板（基本面页签）：硬指标 + AI 信号 + 季度图表。
export function SecReportPanel({ ticker, report, status, onRefresh }) {
  const latest = report?.financials?.latest;
  const quarters = selectCanonicalFinancialQuarters(report?.financials?.quarters || []);
  const aiInsights = selectRenderableAiInsights(report?.ai);
  const hasAiInsights = aiInsights.guidanceChanges.length > 0 || aiInsights.riskFlags.length > 0;

  return (
    <section className="secAnalysisPanel" aria-label="SEC 文件信号">
      <div className="secAnalysisHead">
        <div>
          <span>SEC 文件信号</span>
          <strong>{report?.companyName || ticker}</strong>
        </div>
        <button className="addAssetButton" onClick={onRefresh} disabled={status === 'loading'}>
          {status === 'loading' ? '读取中' : '更新信号'}
        </button>
      </div>

      {status === 'loading' && <p className="secFilingState">正在读取 SEC company facts 和近期 filing...</p>}
      {status === 'error' && <p className="secFilingState">SEC 读取失败。文件下载仍可使用。</p>}
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

          {hasAiInsights && (
            <div className="secAiGrid">
              {aiInsights.guidanceChanges.length > 0 && (
                <div>
                  <span>Guidance / Outlook</span>
                  {aiInsights.guidanceChanges.slice(0, 3).map((item, index) => (
                    <p key={`guidance-${index}`}>{item.detail}</p>
                  ))}
                </div>
              )}
              {aiInsights.riskFlags.length > 0 && (
                <div>
                  <span>文件风险</span>
                  {aiInsights.riskFlags.slice(0, 3).map((item, index) => (
                    <p key={`risk-${index}`}>{item.detail}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {quarters.length > 0 && (
            <>
              <div className="secChartGrid">
                <div className="secMiniChart">
                  <span>营收变化</span>
                  <ReactECharts option={reportChartOption(report, 'revenue-yoy', quarters)} style={{ height: 190 }} notMerge />
                </div>
                <div className="secMiniChart">
                  <span>利润率变化</span>
                  <ReactECharts option={reportChartOption(report, 'margin-lines', quarters)} style={{ height: 190 }} notMerge />
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
