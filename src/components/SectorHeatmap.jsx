import React from 'react';
import ReactECharts from 'echarts-for-react';
import { sectorByTicker } from '../lib/catalog.js';
import { formatMoney } from '../lib/format.js';

function dailyChangeColor(pct) {
  if (!Number.isFinite(pct)) return '#e2e8f0';
  if (pct >= 4) return '#14532d';
  if (pct >= 2) return '#166534';
  if (pct >= 1) return '#15803d';
  if (pct >= 0.3) return '#16a34a';
  if (pct > 0) return '#22c55e';
  if (pct > -0.3) return '#fca5a5';
  if (pct > -1) return '#ef4444';
  if (pct > -2) return '#dc2626';
  if (pct > -4) return '#b91c1c';
  return '#991b1b';
}

// Dark text on light-colored blocks, white on dark blocks
function labelTextColor(pct) {
  if (!Number.isFinite(pct)) return '#334155';
  if (pct > 0 && pct < 0.3) return '#14532d';
  if (pct > -0.3 && pct <= 0) return '#7f1d1d';
  return '#ffffff';
}

// 账户总览：资产摘要 + 行业热力图（面积 = 仓位，颜色 = 当日涨跌）。
export function SectorHeatmap({
  displayedPortfolio,
  dailyChanges,
  dailyChangesStatus,
  ibkrCashSummary,
  portfolioMarketValue,
  portfolioTotalValue,
  onRefreshQuotes,
  onBack
}) {
  const totalValue = portfolioTotalValue;
  const sectorMap = {};
  displayedPortfolio.forEach((holding) => {
    const mv = Number(holding.marketValue) || (Number(holding.shares) || 0) * (Number(holding.marketPrice ?? holding.cost) || 0);
    if (!mv) return;
    const sector = sectorByTicker[holding.symbol] || '其他';
    if (!sectorMap[sector]) sectorMap[sector] = [];
    const daily = dailyChanges[holding.symbol];
    const changePct = daily?.changePct ?? null;
    const pnl = Number(holding.unrealizedPnl);
    sectorMap[sector].push({
      name: holding.symbol,
      value: mv,
      changePct,
      pnl: Number.isFinite(pnl) ? pnl : 0,
      portfolioPct: totalValue > 0 ? (mv / totalValue * 100) : 0,
    });
  });

  const treemapData = Object.entries(sectorMap).map(([sector, items]) => ({
    name: sector,
    children: items.map((item) => ({
      name: item.name,
      value: item.value,
      changePct: item.changePct,
      pnl: item.pnl,
      portfolioPct: item.portfolioPct,
      itemStyle: { color: dailyChangeColor(item.changePct) },
      label: { color: labelTextColor(item.changePct), textShadowBlur: 0 },
    })),
  }));

  const heatmapOption = {
    animation: true,
    animationDuration: 500,
    animationEasing: 'cubicOut',
    animationDurationUpdate: 350,
    animationEasingUpdate: 'cubicInOut',
    backgroundColor: 'transparent',
    tooltip: {
      formatter: (params) => {
        if (!params.data?.value || params.treePathInfo?.length < 2) return '';
        const { name, value, changePct, portfolioPct, pnl } = params.data;
        const changeStr = Number.isFinite(changePct)
          ? `<span style="color:${changePct >= 0 ? '#15803d' : '#dc2626'};font-weight:700">${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%</span>`
          : '<span style="color:#94a3b8">n/a</span>';
        const pnlStr = Number.isFinite(pnl) && pnl !== 0
          ? `<br/><span style="color:#64748b">总盈亏</span> <span style="color:${pnl >= 0 ? '#15803d' : '#dc2626'}">${pnl >= 0 ? '+' : ''}${formatMoney(pnl)}</span>`
          : '';
        return `<div style="font-family:var(--font-body);padding:2px 0">` +
          `<strong style="color:#0f172a;font-size:14px">${name}</strong><br/>` +
          `<span style="color:#64748b">日涨跌</span> ${changeStr}<br/>` +
          `<span style="color:#64748b">市值</span> <span style="color:#1e293b">${formatMoney(value)}</span><br/>` +
          `<span style="color:#64748b">仓位</span> <span style="color:#1e293b">${portfolioPct?.toFixed(2)}%</span>${pnlStr}` +
          `</div>`;
      },
      backgroundColor: '#ffffff',
      borderColor: '#e2e8f0',
      borderWidth: 1,
      textStyle: { color: '#1e293b', fontSize: 12 },
      extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.12);',
    },
    series: [{
      type: 'treemap',
      data: treemapData,
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      width: '100%',
      height: '100%',
      roam: false,
      nodeClick: false,
      breadcrumb: { show: false },
      label: {
        show: true,
        position: 'inside',
        verticalAlign: 'middle',
        align: 'center',
        color: '#ffffff',
        fontSize: 12,
        fontWeight: 'bold',
        lineHeight: 19,
        textShadowBlur: 0,
        overflow: 'truncate',
        formatter: (params) => {
          if (params.data?.children) return '';
          const { name, changePct, portfolioPct } = params.data;
          if (!portfolioPct || portfolioPct < 0.6) return '';
          const changeStr = Number.isFinite(changePct)
            ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`
            : '';
          if (portfolioPct < 1.5) return name;
          return changeStr ? `${name}\n${changeStr}` : name;
        },
      },
      upperLabel: {
        show: true,
        height: 30,
        color: '#0f172a',
        fontSize: 12,
        fontWeight: 800,
        backgroundColor: 'rgba(203,213,225,0.95)',
        borderColor: 'transparent',
        padding: [6, 12],
        formatter: (params) => params.name,
      },
      itemStyle: { borderWidth: 1, borderColor: '#f1f5f9', borderRadius: 3, gapWidth: 1 },
      levels: [
        {
          itemStyle: { borderWidth: 4, borderColor: '#e2e8f0', borderRadius: 6, gapWidth: 4 },
          upperLabel: {
            show: true,
            height: 30,
            color: '#0f172a',
            fontSize: 12,
            fontWeight: 800,
            backgroundColor: 'rgba(203,213,225,0.95)',
            padding: [6, 12],
            formatter: (params) => params.name,
          },
        },
        { itemStyle: { borderWidth: 1, borderColor: 'rgba(255,255,255,.25)', borderRadius: 3, gapWidth: 1 }, label: { show: true } },
      ],
    }],
  };

  const cashValue = ibkrCashSummary.cashBalance ?? 0;
  const stocksValue = portfolioMarketValue;
  const totalDayChange = displayedPortfolio.reduce((sum, h) => {
    const d = dailyChanges[h.symbol];
    if (!d) return sum;
    const mv = Number(h.marketValue) || (Number(h.shares) || 0) * (Number(h.marketPrice ?? h.cost) || 0);
    return sum + mv * (d.changePct / 100);
  }, 0);
  const totalDayChangePct = stocksValue > 0 ? (totalDayChange / stocksValue) * 100 : null;

  return (
    <article className="holdingDetail holdingDetailDesktop overviewPane" aria-label="账户总览">
      <div className="holdingDetailHeader overviewHeader">
        <div className="overviewHeaderLeft">
          <span className="overviewHeaderTitle">账户总览</span>
          {dailyChangesStatus === 'loading' && <span className="overviewLoadingBadge">更新中…</span>}
          {dailyChangesStatus === 'loaded' && Number.isFinite(totalDayChangePct) && (
            <span className={`overviewDayBadge ${totalDayChangePct >= 0 ? 'pos' : 'neg'}`}>
              今日 {totalDayChangePct >= 0 ? '+' : ''}{totalDayChangePct.toFixed(2)}%
              {' '}({totalDayChange >= 0 ? '+' : ''}{formatMoney(totalDayChange)})
            </span>
          )}
        </div>
        <div className="overviewHeaderRight">
          <button className="overviewRefreshBtn" onClick={onRefreshQuotes}>
            刷新行情
          </button>
          <button className="addAssetButton" onClick={onBack}>
            返回持仓
          </button>
        </div>
      </div>
      <div className="holdingTabBody overviewBody">
        <div className="overviewSummaryRow">
          <div className="overviewStat">
            <span>总资产</span>
            <strong>{formatMoney(portfolioTotalValue)}</strong>
          </div>
          {cashValue > 0 && (
            <div className="overviewStat">
              <span>现金</span>
              <strong>{formatMoney(cashValue)}</strong>
            </div>
          )}
          <div className="overviewStat">
            <span>股票市值</span>
            <strong>{formatMoney(stocksValue)}</strong>
          </div>
          {Number.isFinite(totalDayChangePct) && (
            <div className="overviewStat">
              <span>今日变动</span>
              <strong className={totalDayChangePct >= 0 ? 'gain' : 'loss'}>
                {totalDayChangePct >= 0 ? '+' : ''}{totalDayChangePct.toFixed(2)}%
              </strong>
            </div>
          )}
          <div className="overviewStatChart">
            <ReactECharts option={{
              animation: false,
              tooltip: { trigger: 'item', formatter: '{b}: {d}%', backgroundColor: '#ffffff', textStyle: { color: '#1e293b', fontSize: 12 }, borderColor: '#e2e8f0', extraCssText: 'border-radius:8px;box-shadow:0 4px 12px rgba(15,23,42,.1);' },
              series: [{
                type: 'pie',
                radius: ['52%', '80%'],
                data: [
                  { name: '股票', value: stocksValue, itemStyle: { color: '#3b82f6' } },
                  ...(cashValue > 0 ? [{ name: '现金', value: cashValue, itemStyle: { color: '#64748b' } }] : []),
                ],
                label: { show: false },
                emphasis: { scale: false },
              }],
            }} style={{ height: 90, width: 90 }} notMerge />
          </div>
        </div>
        <div className="overviewHeatmapWrap">
          <span className="overviewHeatmapLabel">行业热力图 · 面积 = 仓位占比 · 颜色 = 今日涨跌</span>
          <ReactECharts option={heatmapOption} style={{ height: '100%', width: '100%' }} notMerge />
        </div>
      </div>
    </article>
  );
}
