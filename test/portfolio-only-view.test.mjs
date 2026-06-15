import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const entry = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/views/PortfolioApp.jsx', import.meta.url), 'utf8');
const tickerGroup = readFileSync(new URL('../src/components/HoldingTickerGroup.jsx', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('renders the holdings workspace without the backtest view switcher', () => {
  assert.doesNotMatch(app, /\bactiveView\b/);
  assert.doesNotMatch(app, /className="viewTabs"/);
  assert.match(entry, /render\(<PortfolioApp \/>\)/);
  assert.match(app, /<main className="workspace">\s*\{portfolioView\}\s*<\/main>/);
  assert.match(html, /<title>Control<\/title>/);
});

test('uses a Google Finance-inspired holdings and research layout', () => {
  assert.match(app, /className="portfolioToolbar"/);
  assert.match(app, /className="holdingSearch"/);
  assert.match(app, /className="portfolioGrid"/);
  assert.match(app, /displayedPortfolio\.some\(\(holding\) => holding\.id === expandedHolding\)/);
});

test('summarizes IBKR cash alongside security positions', () => {
  assert.match(app, /summarizeIbkrCash\(ibkrSnapshot\)/);
  assert.match(app, /ibkrCashSummary\.cashBalance/);
  assert.match(app, /ibkrCashSummary\.netLiquidation \?\? portfolioMarketValue/);
});

test('shows each holding weight against total portfolio value', () => {
  // 持仓权重展示已下沉到 ticker 分组组件的「正股」子行。
  assert.match(tickerGroup, /holdingWeightPercent\(shareValue, portfolioTotalValue\)/);
  assert.match(tickerGroup, /shareWeight === null \? 'n\/a' : `\$\{shareWeight\.toFixed\(2\)\}%`/);
});

test('groups each ticker with the underlying and its option legs as equal-weight rows', () => {
  // ticker 头部只放股价 + 今日涨跌幅；正股与期权腿是平权子行。
  assert.match(tickerGroup, /export function HoldingTickerGroup/);
  assert.match(app, /<HoldingTickerGroup/);
  assert.match(tickerGroup, /const legs = Array\.isArray\(holding\.options\)/);
  assert.match(tickerGroup, /const showShareRow = !holding\.optionsOnly/);
});
