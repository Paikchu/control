import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { Briefcase, ChevronDown, ChevronRight, ExternalLink, Link2, RefreshCw, Search } from 'lucide-react';
import { normalizeEntryPlan, normalizeHoldingItems } from '../holdingNotes.mjs';
import { summarizeIbkrCash } from '../ibkrCash.mjs';
import { apiBase } from '../api/client.js';
import { companyNameByTicker, ibkrAccountStorageKey, localCompanyName, normalizeTicker, portfolioStorageKey, thesisChecksStorageKey } from '../lib/catalog.js';
import { formatMoney } from '../lib/format.js';
import { ibkrStatusMessage, mergeIbkrPortfolio, readStoredIbkrAccountId, readStoredPortfolio } from '../lib/holdings.js';
import { AddHoldingModal } from '../components/AddHoldingModal.jsx';
import { HoldingDetail } from '../components/HoldingDetail.jsx';
import { HoldingTickerGroup } from '../components/HoldingTickerGroup.jsx';
import { MarketIndexTile } from '../components/MarketIndexTile.jsx';
import { SectorHeatmap } from '../components/SectorHeatmap.jsx';

// 持仓工作台：当前应用的唯一视图。
// 状态全部集中在这里，展示型组件（HoldingDetail / SectorHeatmap 等）只收 props。
export function PortfolioApp() {
  const [portfolio, setPortfolio] = useState(() => readStoredPortfolio());
  const [expandedHolding, setExpandedHolding] = useState(() => readStoredPortfolio()[0]?.id ?? null);
  const [ibkrStatus, setIbkrStatus] = useState({ gateway: 'checking', authenticated: false, message: '' });
  const [ibkrAccounts, setIbkrAccounts] = useState([]);
  const [selectedIbkrAccount, setSelectedIbkrAccount] = useState(() => readStoredIbkrAccountId());
  const [ibkrSnapshot, setIbkrSnapshot] = useState(null);
  const [ibkrSyncStatus, setIbkrSyncStatus] = useState('idle');
  const [ibkrError, setIbkrError] = useState('');
  const [ibkrPopoverOpen, setIbkrPopoverOpen] = useState(false);
  const [expandedBroker, setExpandedBroker] = useState('ibkr');
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
  const [filingSummaries, setFilingSummaries] = useState({});
  const [filingSummaryStatus, setFilingSummaryStatus] = useState({});
  const [holdingTab, setHoldingTab] = useState('thesis');
  const [holdingQuery, setHoldingQuery] = useState('');
  const [collapsedTickers, setCollapsedTickers] = useState(() => new Set());
  const [showPortfolioOverview, setShowPortfolioOverview] = useState(false);
  const [dailyChanges, setDailyChanges] = useState({});
  const [dailyChangesStatus, setDailyChangesStatus] = useState('idle');
  const [marketOverview, setMarketOverview] = useState(null);
  const [optionsBySymbol, setOptionsBySymbol] = useState({});
  const filingSummaryRequests = useRef(new Set());
  const ibkrLoginPollRef = useRef(null);
  const [thesisChecks, setThesisChecks] = useState(() => {
    try { return JSON.parse(localStorage.getItem(thesisChecksStorageKey) || '{}'); } catch { return {}; }
  });
  const [thesisCheckStatus, setThesisCheckStatus] = useState({});
  const [expandedThesisItem, setExpandedThesisItem] = useState({});
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('holdingSidebarWidth'));
      return Number.isFinite(stored) && stored >= 280 ? stored : 440;
    } catch { return 440; }
  });
  const [resizing, setResizing] = useState(false);
  const portfolioGridRef = useRef(null);

  function startSidebarResize(event) {
    event.preventDefault();
    const grid = portfolioGridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const min = 300;
    const max = Math.min(820, rect.width - 380); // always leave room for the research pane
    let latest = sidebarWidth;
    setResizing(true);
    const onMove = (e) => {
      latest = Math.max(min, Math.min(max, e.clientX - rect.left));
      setSidebarWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      try { localStorage.setItem('holdingSidebarWidth', String(Math.round(latest))); } catch {}
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  const ibkrPortfolio = useMemo(() => mergeIbkrPortfolio(ibkrSnapshot, portfolio), [ibkrSnapshot, portfolio]);
  const displayedPortfolio = useMemo(() => (
    ibkrPortfolio.length ? ibkrPortfolio : portfolio.map((holding) => ({ ...holding, source: holding.source || 'manual' }))
  ), [ibkrPortfolio, portfolio]);
  const filteredPortfolio = useMemo(() => {
    const query = holdingQuery.trim().toLowerCase();
    if (!query) return displayedPortfolio;
    return displayedPortfolio.filter((holding) => (
      holding.symbol.toLowerCase().includes(query)
      || holding.name.toLowerCase().includes(query)
    ));
  }, [displayedPortfolio, holdingQuery]);
  const portfolioMarketValue = useMemo(() => displayedPortfolio.reduce((total, holding) => {
    const marketValue = Number(holding.marketValue) || (Number(holding.shares) || 0) * (Number(holding.marketPrice ?? holding.cost) || 0);
    return total + marketValue;
  }, 0), [displayedPortfolio]);
  const ibkrCashSummary = useMemo(() => summarizeIbkrCash(ibkrSnapshot), [ibkrSnapshot]);
  const portfolioTotalValue = ibkrCashSummary.netLiquidation ?? portfolioMarketValue;
  const selectedHolding = displayedPortfolio.find((holding) => holding.id === expandedHolding) ?? displayedPortfolio[0];
  const hasIbkrAccess = ibkrStatus.authenticated || ibkrAccounts.length > 0 || Boolean(ibkrSnapshot?.lastSyncAt);

  function updateHolding(holdingId, key, value) {
    const ibkrHolding = displayedPortfolio.find((holding) => holding.id === holdingId && holding.source === 'ibkr');
    if (ibkrHolding && ['thesis', 'risk', 'name', 'thesisItems', 'riskItems', 'entryPlan'].includes(key)) {
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
          thesisItems: key === 'thesisItems' ? value : ibkrHolding.thesisItems,
          riskItems: key === 'riskItems' ? value : ibkrHolding.riskItems,
          entryPlan: key === 'entryPlan' ? value : ibkrHolding.entryPlan,
          source: 'ibkr-note'
        };
        if (matchedIndex < 0) return [...items, nextNote];
        return items.map((holding, index) => index === matchedIndex ? { ...holding, ...nextNote, [key]: value } : holding);
      });
      return;
    }
    setPortfolio((items) => items.map((holding) => holding.id === holdingId ? { ...holding, [key]: value } : holding));
  }

  function addHoldingItem(holding, key) {
    const prefix = key === 'thesisItems' ? 'thesis' : 'risk';
    const items = normalizeHoldingItems(holding[key], holding[key === 'thesisItems' ? 'thesis' : 'risk'], prefix);
    updateHolding(holding.id, key, [...items, { id: `${prefix}-${Date.now()}`, text: '' }]);
  }

  function updateHoldingItem(holding, key, itemId, text) {
    const prefix = key === 'thesisItems' ? 'thesis' : 'risk';
    const items = normalizeHoldingItems(holding[key], holding[key === 'thesisItems' ? 'thesis' : 'risk'], prefix);
    updateHolding(holding.id, key, items.map((item) => item.id === itemId ? { ...item, text } : item));
  }

  function removeHoldingItem(holding, key, itemId) {
    const prefix = key === 'thesisItems' ? 'thesis' : 'risk';
    const items = normalizeHoldingItems(holding[key], holding[key === 'thesisItems' ? 'thesis' : 'risk'], prefix);
    updateHolding(holding.id, key, items.filter((item) => item.id !== itemId));
  }

  function updateEntryPlan(holding, key, value) {
    updateHolding(holding.id, 'entryPlan', normalizeEntryPlan({
      ...holding.entryPlan,
      [key]: value
    }));
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

  function selectHolding(holdingId) {
    setExpandedHolding(holdingId);
    setShowPortfolioOverview(false);
  }

  function toggleTickerExpanded(holdingId) {
    setCollapsedTickers((current) => {
      const next = new Set(current);
      if (next.has(holdingId)) next.delete(holdingId);
      else next.add(holdingId);
      return next;
    });
  }

  async function fetchDailyChanges() {
    const symbols = displayedPortfolio.map((h) => h.symbol).filter(Boolean);
    if (!symbols.length) return;
    setDailyChangesStatus('loading');
    const results = {};
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const response = await fetch(`${apiBase}/api/prices/${encodeURIComponent(symbol)}`);
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.rows) || payload.rows.length < 2) return;
        const rows = payload.rows;
        const last = rows[rows.length - 1];
        const prev = rows[rows.length - 2];
        if (last?.close && prev?.close) {
          results[symbol] = { changePct: (last.close / prev.close - 1) * 100, close: last.close };
        }
      } catch (_) {}
    }));
    setDailyChanges(results);
    setDailyChangesStatus('loaded');
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

  // 网关登录页（/sso/Dispatcher）登录成功后只会停在「Client login succeeds」——那页
  // 由网关自身托管，改不了它的跳转。所以用弹窗登录：开一个登录弹窗，主页这边轮询
  // 登录态，认证成功就自动关弹窗并同步，用户全程留在主页。
  function openIbkrLogin() {
    const url = ibkrStatus.loginUrl || 'https://localhost:5001';
    const popup = window.open(url, 'ibkrLogin', 'width=520,height=700');
    setIbkrError('请在弹窗中完成 IBKR 登录与 2FA，成功后会自动返回并同步。');
    if (ibkrLoginPollRef.current) clearInterval(ibkrLoginPollRef.current);
    const startedAt = Date.now();
    ibkrLoginPollRef.current = setInterval(async () => {
      // 弹窗被手动关闭或超过 3 分钟未完成：停止轮询。
      if ((popup && popup.closed) || Date.now() - startedAt > 180000) {
        clearInterval(ibkrLoginPollRef.current);
        ibkrLoginPollRef.current = null;
        return;
      }
      const status = await loadIbkrStatus({ preserveError: true });
      if (status?.authenticated) {
        clearInterval(ibkrLoginPollRef.current);
        ibkrLoginPollRef.current = null;
        try { if (popup && !popup.closed) popup.close(); } catch {}
        setIbkrError('');
        await refreshIbkr();
      }
    }, 2500);
  }

  function changeIbkrAccount(accountId) {
    setSelectedIbkrAccount(accountId);
    syncIbkrPositions(accountId);
  }

  function disconnectIbkr() {
    setIbkrAccounts([]);
    setIbkrSnapshot(null);
    setIbkrStatus({ gateway: 'offline', authenticated: false, message: '' });
    setIbkrError('');
    setIbkrPopoverOpen(false);
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
    setPortfolio((items) => [...items, {
      id,
      symbol,
      name,
      shares,
      cost,
      thesis: '',
      risk: '',
      thesisItems: [],
      riskItems: [],
      entryPlan: normalizeEntryPlan()
    }]);
    setExpandedHolding(id);
    setAddHoldingOpen(false);
    setAddHoldingStatus('');
    fetch(`${apiBase}/api/holdings/${symbol}/prefetch`, { method: 'POST' }).catch(() => {});
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
      if (!response.ok) throw new Error(payload.error || 'SEC 文件信号获取失败');
      setSecReports((current) => ({ ...current, [ticker]: payload }));
      setSecReportStatus((current) => ({ ...current, [ticker]: 'loaded' }));
    } catch (error) {
      setSecReportStatus((current) => ({ ...current, [ticker]: 'error' }));
    }
  }

  async function loadFilingSummary(symbol, filing) {
    const ticker = symbol.trim().toUpperCase();
    const accession = filing?.accessionNumber;
    const key = `${ticker}:${accession}`;
    if (!ticker || !accession || filingSummaryRequests.current.has(key)) return;
    if (filingSummaries[key]) return;

    filingSummaryRequests.current.add(key);
    setFilingSummaryStatus((current) => ({ ...current, [key]: 'loading' }));
    try {
      const response = await fetch(
        `${apiBase}/api/sec/filings/${encodeURIComponent(ticker)}/${encodeURIComponent(accession)}/summary`
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'SEC 文件摘要生成失败');
      setFilingSummaries((current) => ({ ...current, [key]: payload }));
      setFilingSummaryStatus((current) => ({ ...current, [key]: 'loaded' }));
    } catch (error) {
      setFilingSummaryStatus((current) => ({ ...current, [key]: 'error' }));
    } finally {
      filingSummaryRequests.current.delete(key);
    }
  }

  function persistThesisChecks(next) {
    setThesisChecks(next);
    try { localStorage.setItem(thesisChecksStorageKey, JSON.stringify(next)); } catch {}
  }

  async function runHoldingThesisCheck(holding, force = false) {
    const ticker = holding.symbol.trim().toUpperCase();
    const thesisItems = (holding.thesisItems || []).filter((i) => i.text?.trim());
    if (thesisItems.length === 0) return;
    setThesisCheckStatus((s) => ({ ...s, [ticker]: 'loading' }));
    try {
      const resp = await fetch(`${apiBase}/api/holdings/${encodeURIComponent(ticker)}/thesis-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ thesisItems, riskItems: holding.riskItems || [], force })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '检验失败');
      persistThesisChecks((prev) => ({ ...prev, [ticker]: { ...data, checkedAt: new Date().toISOString() } }));
      setThesisCheckStatus((s) => ({ ...s, [ticker]: 'loaded' }));
    } catch (err) {
      setThesisCheckStatus((s) => ({ ...s, [ticker]: 'error:' + err.message }));
    }
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(portfolioStorageKey, JSON.stringify(portfolio));
    } catch (error) {
      // Local persistence is best-effort; the editable in-memory list still works.
    }
  }, [portfolio]);

  // 卸载时清掉登录轮询定时器，避免泄漏。
  useEffect(() => () => {
    if (ibkrLoginPollRef.current) clearInterval(ibkrLoginPollRef.current);
  }, []);

  useEffect(() => {
    try {
      if (selectedIbkrAccount) window.localStorage.setItem(ibkrAccountStorageKey, selectedIbkrAccount);
    } catch (error) {
      // Account preference is optional; sync still works when it is not persisted.
    }
  }, [selectedIbkrAccount]);

  useEffect(() => {
    if (!displayedPortfolio.length) {
      if (expandedHolding) setExpandedHolding(null);
      return;
    }
    if (!displayedPortfolio.some((holding) => holding.id === expandedHolding)) {
      setExpandedHolding(displayedPortfolio[0].id);
    }
  }, [displayedPortfolio, expandedHolding]);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadMarketOverview() {
      try {
        const response = await fetch(`${apiBase}/api/market/overview`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || '指数行情获取失败');
        if (!cancelled) setMarketOverview(payload);
      } catch (error) {
        // 行情条是辅助信息，失败时保留上一次数据。
      }
    }
    loadMarketOverview();
    const timer = window.setInterval(loadMarketOverview, 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // SPY / QQQ 期权研判：直接嵌进 S&P 500 / Nasdaq 指数卡片，不再藏在 pill 弹层后面。
  useEffect(() => {
    let cancelled = false;
    async function loadOptionsOverview() {
      try {
        const response = await fetch(`${apiBase}/api/options/overview`);
        const payload = await response.json();
        if (cancelled) return;
        const map = {};
        for (const snapshot of payload.snapshots || []) map[snapshot.symbol] = snapshot;
        setOptionsBySymbol(map);
      } catch (error) {
        // 研判是辅助信息，失败时保留上一次数据。
      }
    }
    loadOptionsOverview();
    const timer = window.setInterval(loadOptionsOverview, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!expandedHolding) return;
    const holding = displayedPortfolio.find((item) => item.id === expandedHolding);
    if (!holding?.symbol) return;
    loadSecFilings(holding.symbol);
    loadSecReport(holding.symbol);
  }, [expandedHolding, displayedPortfolio]);

  useEffect(() => {
    if (!['sec', 'fundamentals'].includes(holdingTab) || !expandedHolding) return undefined;
    const holding = displayedPortfolio.find((item) => item.id === expandedHolding);
    const ticker = holding?.symbol?.trim().toUpperCase();
    const filings = secFilings[ticker]?.filings || [];
    if (!ticker || !filings.length) return undefined;

    let cancelled = false;
    let cursor = 0;
    const worker = async () => {
      while (!cancelled && cursor < filings.length) {
        const filing = filings[cursor];
        cursor += 1;
        await loadFilingSummary(ticker, filing);
      }
    };
    Promise.all([worker(), worker()]);
    return () => {
      cancelled = true;
    };
  }, [holdingTab, expandedHolding, displayedPortfolio, secFilings]);

  useEffect(() => {
    if (!expandedHolding) return undefined;
    const holding = displayedPortfolio.find((item) => item.id === expandedHolding);
    if (!holding?.symbol) return undefined;
    const timer = window.setInterval(() => {
      loadSecFilings(holding.symbol, true);
      loadSecReport(holding.symbol, true);
    }, 3 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [expandedHolding, displayedPortfolio]);

  const displayedSymbolsKey = displayedPortfolio.map((h) => h.symbol).join(',');
  useEffect(() => {
    if (displayedPortfolio.length > 0) {
      setDailyChangesStatus('idle');
      fetchDailyChanges();
    }
  }, [displayedSymbolsKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const portfolioView = (
    <section className="portfolioDesk" aria-label="个人持仓">
      <header className="portfolioToolbar">
        <div className="marketStrip" aria-label="美股大盘行情">
          {(marketOverview?.indices?.length ? marketOverview.indices : []).map((index) => {
            // SPY 研判并入 S&P 500(^GSPC)，QQQ 研判并入 Nasdaq(^IXIC)。
            const optSymbol = index.symbol === '^GSPC' ? 'SPY' : index.symbol === '^IXIC' ? 'QQQ' : null;
            return (
              <MarketIndexTile
                key={index.symbol}
                index={index}
                options={optSymbol ? optionsBySymbol[optSymbol] : null}
              />
            );
          })}
          {!marketOverview?.indices?.length && <span className="marketStripEmpty">大盘行情加载中…</span>}
        </div>
        <div className="portfolioUtility">
          <button className={`brokerConnectButton ${hasIbkrAccess ? 'connected' : ''}`} onClick={() => setIbkrPopoverOpen((open) => !open)} aria-expanded={ibkrPopoverOpen}>
            <Link2 size={14} />
            {hasIbkrAccess && <span className="brokerConnectDot" />}
          </button>
          {ibkrPopoverOpen && (
            <div className="brokerHubPopover">
              <div className="brokerHubHeader">
                <Link2 size={14} />
                <span>券商连接</span>
              </div>
              <div className="brokerList">
                {/* IBKR */}
                <div className={`brokerCard ${hasIbkrAccess ? 'connected' : ''}`}>
                  <button className="brokerCardHeader" onClick={() => setExpandedBroker(expandedBroker === 'ibkr' ? null : 'ibkr')}>
                    <div className="brokerCardMeta">
                      <Briefcase size={15} />
                      <div>
                        <strong>Interactive Brokers</strong>
                        <span>{hasIbkrAccess ? '已连接' : ibkrStatus.gateway === 'offline' ? 'Gateway 未运行' : '需要登录'}</span>
                      </div>
                    </div>
                    <div className="brokerCardRight">
                      {hasIbkrAccess && <span className="brokerStatusDot connected" />}
                      {expandedBroker === 'ibkr' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </div>
                  </button>
                  {expandedBroker === 'ibkr' && (
                    <div className="brokerCardBody">
                      <span className="brokerSyncTime">
                        {ibkrSnapshot?.lastSyncAt ? `最后同步 ${new Date(ibkrSnapshot.lastSyncAt).toLocaleString('zh-CN')}` : '未同步账户持仓'}
                      </span>
                      <div className="ibkrActions">
                        {ibkrAccounts.length > 0 && (
                          <select value={selectedIbkrAccount} onChange={(event) => changeIbkrAccount(event.target.value)}>
                            {ibkrAccounts.map((account) => (
                              <option key={account.accountId} value={account.accountId}>{account.accountTitle || account.accountId}</option>
                            ))}
                          </select>
                        )}
                        <button className="ibkrLoginLink" type="button" onClick={openIbkrLogin}><ExternalLink size={14} />打开登录页</button>
                        <button className="iconTextButton" onClick={refreshIbkr} disabled={ibkrSyncStatus === 'syncing'}>
                          <RefreshCw size={14} />
                          {ibkrSyncStatus === 'syncing' ? '同步中' : '刷新状态'}
                        </button>
                        {hasIbkrAccess && (
                          <button className="iconTextButton ibkrDisconnectBtn" onClick={disconnectIbkr}>
                            断开连接
                          </button>
                        )}
                      </div>
                      {(ibkrError || (!hasIbkrAccess && ibkrStatus.gateway !== 'offline')) && (
                        <p className="brokerCardError">{ibkrError || '完成 IBKR 2FA 后点击刷新状态。'}</p>
                      )}
                    </div>
                  )}
                </div>
                {/* Placeholder brokers — future integrations */}
                {[{ id: 'alpaca', label: 'Alpaca' }, { id: 'tiger', label: '老虎证券' }].map((broker) => (
                  <div key={broker.id} className="brokerCard disabled">
                    <div className="brokerCardHeader">
                      <div className="brokerCardMeta">
                        <Link2 size={15} />
                        <div>
                          <strong>{broker.label}</strong>
                          <span>即将支持</span>
                        </div>
                      </div>
                      <span className="brokerComingSoon">敬请期待</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </header>
      <div className="portfolioGrid" ref={portfolioGridRef} style={{ '--sidebar-w': `${sidebarWidth}px` }}>
        <aside className="holdingList" aria-label="持仓列表">
          <label className="holdingSearch">
            <Search size={16} aria-hidden="true" />
            <input
              value={holdingQuery}
              onChange={(event) => setHoldingQuery(event.target.value)}
              placeholder="搜索股票或公司"
              aria-label="搜索持仓"
            />
          </label>
          <button
            className={`portfolioOverviewCard ${showPortfolioOverview ? 'active' : ''}`}
            onClick={() => setShowPortfolioOverview((v) => !v)}
            aria-pressed={showPortfolioOverview}
          >
            <div className="overviewCardLeft">
              <ReactECharts option={{
                animation: false,
                series: [{
                  type: 'pie',
                  radius: ['46%', '78%'],
                  data: [
                    { name: '股票', value: portfolioMarketValue, itemStyle: { color: '#1d4ed8' } },
                    ...(ibkrCashSummary.cashBalance > 0 ? [{ name: '现金', value: ibkrCashSummary.cashBalance, itemStyle: { color: '#64748b' } }] : []),
                  ],
                  label: { show: false },
                  emphasis: { scale: false },
                }],
              }} style={{ height: 52, width: 52 }} notMerge />
            </div>
            <div className="overviewCardRight">
              <span>账户总览分析</span>
              <div className="overviewCardStats">
                <div>
                  <em>总资产</em>
                  <strong>{formatMoney(portfolioTotalValue)}</strong>
                </div>
                {ibkrCashSummary.cashBalance > 0 && (
                  <div>
                    <em>现金</em>
                    <strong>{formatMoney(ibkrCashSummary.cashBalance)}</strong>
                  </div>
                )}
                <div>
                  <em>股票</em>
                  <strong>{formatMoney(portfolioMarketValue)}</strong>
                </div>
              </div>
            </div>
            <span className="overviewCardArrow" aria-hidden="true">›</span>
          </button>
          {/* 持仓列表：无表头，每个 ticker 一组（Google Finance 风格行头 + 平权子行）。 */}
          <div className="min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] border-t border-t-[#e6e9ed] bg-white [scrollbar-width:thin] [&::-webkit-scrollbar]:w-[7px] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(100,116,139,0.34)]">
            {filteredPortfolio.map((holding) => (
              <HoldingTickerGroup
                key={holding.id}
                holding={holding}
                isOpen={!showPortfolioOverview && expandedHolding === holding.id}
                isIbkr={holding.source === 'ibkr'}
                companyName={companyNameByTicker[holding.symbol] || holding.name || holding.symbol}
                dailyChangePct={dailyChanges[holding.symbol]?.changePct}
                portfolioTotalValue={portfolioTotalValue}
                expanded={!collapsedTickers.has(holding.id)}
                onToggle={() => toggleTickerExpanded(holding.id)}
                onSelect={selectHolding}
                onRemove={removeHolding}
              />
            ))}
            {filteredPortfolio.length === 0 && (
              <div className="px-5 py-6 text-center text-[0.78rem] text-[#9aa3b0]">没有匹配的持仓。</div>
            )}
          </div>
        </aside>

        <div
          className={`holdingResizer ${resizing ? 'dragging' : ''}`}
          onPointerDown={startSidebarResize}
          onDoubleClick={() => { setSidebarWidth(440); try { localStorage.setItem('holdingSidebarWidth', '440'); } catch {} }}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整持仓列表宽度"
          title="拖动调整宽度（双击重置）"
        />

        <section className="researchPane" aria-label="研究面板">
          {showPortfolioOverview
            ? (
              <SectorHeatmap
                displayedPortfolio={displayedPortfolio}
                dailyChanges={dailyChanges}
                dailyChangesStatus={dailyChangesStatus}
                ibkrCashSummary={ibkrCashSummary}
                portfolioMarketValue={portfolioMarketValue}
                portfolioTotalValue={portfolioTotalValue}
                onRefreshQuotes={() => { setDailyChangesStatus('idle'); fetchDailyChanges(); }}
                onBack={() => setShowPortfolioOverview(false)}
              />
            )
            : (
              <HoldingDetail
                holding={selectedHolding}
                className="holdingDetailDesktop"
                holdingTab={holdingTab}
                setHoldingTab={setHoldingTab}
                secFilings={secFilings}
                secStatus={secStatus}
                secReports={secReports}
                secReportStatus={secReportStatus}
                filingSummaries={filingSummaries}
                filingSummaryStatus={filingSummaryStatus}
                thesisChecks={thesisChecks}
                thesisCheckStatus={thesisCheckStatus}
                expandedThesisItem={expandedThesisItem}
                setExpandedThesisItem={setExpandedThesisItem}
                updateHoldingItem={updateHoldingItem}
                removeHoldingItem={removeHoldingItem}
                addHoldingItem={addHoldingItem}
                updateEntryPlan={updateEntryPlan}
                runHoldingThesisCheck={runHoldingThesisCheck}
                loadSecFilings={loadSecFilings}
                loadSecReport={loadSecReport}
              />
            )}
        </section>
      </div>
    </section>
  );

  return (
    <div className="shell">
      <div className="app portfolioMode">
        <main className="workspace">
          {portfolioView}
        </main>
      </div>
      {addHoldingOpen && (
        <AddHoldingModal
          ticker={newHoldingTicker}
          shares={newHoldingShares}
          cost={newHoldingCost}
          status={addHoldingStatus}
          onTickerChange={(value) => { setNewHoldingTicker(value); setAddHoldingStatus(''); }}
          onSharesChange={(value) => { setNewHoldingShares(value); setAddHoldingStatus(''); }}
          onCostChange={(value) => { setNewHoldingCost(value); setAddHoldingStatus(''); }}
          onSubmit={submitNewHolding}
          onClose={() => setAddHoldingOpen(false)}
        />
      )}
    </div>
  );
}
