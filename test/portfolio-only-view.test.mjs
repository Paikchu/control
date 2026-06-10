import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('renders the holdings workspace without the backtest view switcher', () => {
  assert.doesNotMatch(source, /\bactiveView\b/);
  assert.doesNotMatch(source, /className="viewTabs"/);
  assert.match(source, /<main className="workspace">\s*\{portfolioView\}\s*<\/main>/);
  assert.match(html, /<title>Portfolio Holdings<\/title>/);
});

test('uses a Google Finance-inspired holdings and research layout', () => {
  assert.match(source, /className="portfolioToolbar"/);
  assert.match(source, /className="holdingSearch"/);
  assert.match(source, /className="portfolioGrid"/);
  assert.match(source, /key=\{holding\.id\} className=\{`holdingDetail/);
  assert.match(source, /displayedPortfolio\.some\(\(holding\) => holding\.id === expandedHolding\)/);
});

test('shows IBKR cash separately from security positions', () => {
  assert.match(source, /className="portfolioCash"/);
  assert.match(source, /IBKR 现金/);
  assert.match(source, /ibkrCashSummary\.cashBalance/);
  assert.match(source, /ibkrCashSummary\.currencyBalances/);
});

test('shows each holding weight against total portfolio value', () => {
  assert.match(source, /holdingWeightPercent\(marketValue, portfolioTotalValue\)/);
  assert.match(source, /className="holdingWeight"/);
});
