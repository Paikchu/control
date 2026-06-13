import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { ArrowDown, ArrowUp, Briefcase, ChevronDown, ChevronRight, ExternalLink, Link2, RefreshCw, Search, Trash2 } from 'lucide-react';
import { normalizeEntryPlan, normalizeHoldingItems } from '../holdingNotes.mjs';
import { holdingWeightPercent, summarizeIbkrCash } from '../ibkrCash.mjs';
import { apiBase } from '../api/client.js';
import { companyNameByTicker, ibkrAccountStorageKey, localCompanyName, normalizeTicker, portfolioStorageKey, thesisChecksStorageKey } from '../lib/catalog.js';
import { formatMoney, hasNumber, indexNumberFormat } from '../lib/format.js';
import { ibkrStatusMessage, mergeIbkrPortfolio, readStoredIbkrAccountId, readStoredPortfolio } from '../lib/holdings.js';
import { AddHoldingModal } from '../components/AddHoldingModal.jsx';
import { HoldingDetail } from '../components/HoldingDetail.jsx';
import { HoldingOptionLegs } from '../components/HoldingOptionLegs.jsx';
import { MarketGammaPill } from '../components/MarketGammaPill.jsx';
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
  const [showPortfolioOverview, setShowPortfolioOverview] = useState(false);
  const [dailyChanges, setDailyChanges] = useState({});
  const [dailyChangesStatus, setDailyChangesStatus] = useState('idle');
  const [marketOverview, setMarketOverview] = useState(null);
  const filingSummaryRequests = useRef(new Set());
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
        <div className="portfolioIdentity">
          <span className="controlWordmark">Con<b>trol</b></span>
        </div>
        <div className="marketStrip" aria-label="美股大盘行情">
          {(marketOverview?.indices?.length ? marketOverview.indices : []).map((index) => {
            const up = index.change >= 0;
            return (
              <div key={index.symbol} className={`marketTile ${up ? 'up' : 'down'}`}>
                <div className="marketTileInfo">
                  <span className="marketTileName">{index.name}</span>
                  <strong>{indexNumberFormat.format(index.price)}</strong>
                  <span className="marketTileChange">
                    {up ? <ArrowUp size={11} aria-hidden="true" /> : <ArrowDown size={11} aria-hidden="true" />}
                    {up ? '+' : ''}{index.changePercent.toFixed(2)}%
                    <small>({up ? '+' : ''}{indexNumberFormat.format(index.change)})</small>
                  </span>
                </div>
              </div>
            );
          })}
          {!marketOverview?.indices?.length && <span className="marketStripEmpty">大盘行情加载中…</span>}
        </div>
        <div className="portfolioUtility">
          <MarketGammaPill />
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
                        <a className="ibkrLoginLink" href={ibkrStatus.loginUrl || 'https://localhost:5001'} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开登录页</a>
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
          {/* Header table — fixed, never scrolls. Reserves the same scrollbar
              gutter as the body below so their columns line up. */}
          <div className="overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-[7px] border-b border-b-[#e6e9ed] bg-[rgba(255,255,255,0.96)]">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col />
                <col className="w-[20%]" />
                <col className="w-[20%]" />
                <col className="w-[20%]" />
                <col className="w-[30px]" />
              </colgroup>
              <thead>
                <tr className="h-9 text-[0.72rem] font-[720] tracking-[0.02em] text-[#5f6368] whitespace-nowrap [&>th]:px-2.5">
                  <th scope="col" className="text-left pl-6">股票</th>
                  <th scope="col" className="text-right">市值</th>
                  <th scope="col" className="text-right">价格 / P&amp;L</th>
                  <th scope="col" className="text-right">走势</th>
                  <th scope="col" className="!p-0"></th>
                </tr>
              </thead>
            </table>
          </div>
          {/* Body table — scrolls vertically; the thin 7px scrollbar sits in the
              reserved gutter so it starts below the header, not beside it. */}
          <div className="min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] bg-white [scrollbar-width:thin] [&::-webkit-scrollbar]:w-[7px] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(100,116,139,0.34)]">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col />
                <col className="w-[20%]" />
                <col className="w-[20%]" />
                <col className="w-[20%]" />
                <col className="w-[30px]" />
              </colgroup>
              <tbody>
                {filteredPortfolio.map((holding, index) => {
                  const isOpen = !showPortfolioOverview && expandedHolding === holding.id;
                  const isIbkr = holding.source === 'ibkr';
                  const shareValue = Number(holding.marketValue) || (Number(holding.shares) || 0) * (Number(holding.marketPrice ?? holding.cost) || 0);
                  const optionLegs = Array.isArray(holding.options) ? holding.options : [];
                  const hasOptions = optionLegs.length > 0;
                  const optionsValue = Number(holding.optionsMarketValue) || 0;
                  const isOptionOnly = holding.optionsOnly || (!(Number(holding.shares) > 0) && hasOptions);
                  const headlineValue = isOptionOnly ? optionsValue : shareValue;
                  const weightPercent = holdingWeightPercent(shareValue + optionsValue, portfolioTotalValue);
                  const pnl = Number(holding.unrealizedPnl);
                  const marketPrice = Number(holding.marketPrice);
                  const cost = Number(holding.cost);
                  const valueBtn = 'grid w-full min-h-12 border-0 bg-transparent py-1.5 cursor-pointer content-center justify-items-end gap-[2px] text-right';
                  return (
                    <React.Fragment key={holding.id}>
                    <tr
                      className={`transition-colors [animation:holdingRowEnter_420ms_var(--ease-out-quint)_both] ${hasOptions ? '' : 'border-b border-b-[#eceff2]'} ${isOpen ? 'bg-[#eef4ff]' : 'bg-white hover:bg-[#f5f8fd]'}`}
                      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
                    >
                      <td className={`align-middle p-0 pl-6 ${isOpen ? '[box-shadow:inset_3px_0_0_#0b57d0]' : ''}`}>
                        <button
                          className="grid w-full min-h-12 border-0 bg-transparent py-1.5 cursor-pointer content-center justify-items-start gap-[3px] text-left"
                          onClick={() => selectHolding(holding.id)}
                          aria-pressed={isOpen}
                        >
                          <span className="flex max-w-full items-center gap-1.5 text-[0.88rem] font-[790] tracking-[0.01em] text-[#202124]">
                            {holding.symbol || 'TICKER'} <em className="text-[0.57rem] text-[#7a7f87] not-italic">{isIbkr ? 'IBKR' : '本地'}</em>
                            {hasOptions && (
                              <em className="rounded-full bg-[#eef2ff] px-1.5 py-0.5 text-[0.54rem] font-bold not-italic tracking-wide text-[#4f46e5]">
                                {optionLegs.length} 期权
                              </em>
                            )}
                          </span>
                          <small className="max-w-full truncate text-[0.68rem] font-[570] leading-[1.2] text-[#74787f]">
                            {companyNameByTicker[holding.symbol] || holding.name || holding.symbol}
                          </small>
                          <span className="flex gap-2 text-[0.62rem] font-[600] leading-[1.2] text-[#9aa3b0]">
                            {isOptionOnly
                              ? <span>仅期权</span>
                              : holding.shares != null && <span>数量 {holding.shares}</span>}
                            {!isOptionOnly && Number.isFinite(cost) && cost > 0 && <span>成本 {isIbkr ? cost.toFixed(1) : holding.cost}</span>}
                          </span>
                        </button>
                      </td>
                      <td className="align-middle p-0 px-2.5 text-right">
                        <button className={valueBtn} onClick={() => selectHolding(holding.id)} aria-pressed={isOpen}>
                          <strong className="max-w-full truncate text-[0.76rem] font-[740] leading-[1.2] text-[#303134]">{formatMoney(headlineValue)}</strong>
                          <small className="text-[0.66rem] font-[720] leading-[1.2] text-[#5f6368]">{weightPercent === null ? 'n/a' : `${weightPercent.toFixed(2)}%`}</small>
                        </button>
                      </td>
                      <td className="align-middle p-0 px-2.5 text-right">
                        <button className={valueBtn} onClick={() => selectHolding(holding.id)} aria-pressed={isOpen}>
                          <strong className="max-w-full truncate text-[0.76rem] font-[740] leading-[1.2] text-[#303134]">{isOptionOnly ? '—' : hasNumber(marketPrice) ? formatMoney(marketPrice) : 'n/a'}</strong>
                          <small className={`text-[0.67rem] font-[730] leading-[1.2] ${hasNumber(pnl) ? pnl >= 0 ? 'gain' : 'loss' : ''}`}>{hasNumber(pnl) ? formatMoney(pnl) : 'n/a'}</small>
                        </button>
                      </td>
                      <td className="align-middle p-0 px-2.5 text-right">
                        {(() => {
                          const pct = dailyChanges[holding.symbol]?.changePct;
                          if (!Number.isFinite(pct)) return null;
                          return <span className={`text-[0.76rem] font-[740] leading-[1.2] ${pct >= 0 ? 'gain' : 'loss'}`}>{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</span>;
                        })()}
                      </td>
                      <td className="align-middle p-0 pr-2.5 text-right">
                        {!isIbkr ? (
                          <button className="flex h-12 w-full items-center justify-end border-0 bg-transparent p-0 cursor-pointer text-[#64748b]" onClick={() => removeHolding(holding.id)} aria-label={`删除 ${holding.symbol || '股票'}`}>
                            <Trash2 size={14} />
                          </button>
                        ) : <span aria-hidden="true"></span>}
                      </td>
                    </tr>
                    {hasOptions && (
                      <tr className={`border-b border-b-[#eceff2] ${isOpen ? 'bg-[#eef4ff]' : 'bg-white'}`}>
                        <td colSpan={5} className={`p-0 ${isOpen ? '[box-shadow:inset_3px_0_0_#0b57d0]' : ''}`}>
                          <HoldingOptionLegs legs={optionLegs} compact />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
                {filteredPortfolio.length === 0 && (
                  <tr><td colSpan={5} className="px-5 py-6 text-center text-[0.78rem] text-[#9aa3b0]">没有匹配的持仓。</td></tr>
                )}
              </tbody>
            </table>
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
