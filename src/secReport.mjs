const metricDefinitions = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet'
  ],
  grossProfit: ['GrossProfit'],
  costOfRevenue: [
    'CostOfRevenue',
    'CostOfGoodsAndServicesSold',
    'CostOfGoodsSold',
    'CostOfRevenueExcludingDepreciationDepletionAndAmortization'
  ],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment']
};

function asNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return current / previous - 1;
}

function margin(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const multiple = 10 ** digits;
  return Math.round(value * multiple) / multiple;
}

function fiscalSortKey(item) {
  return `${String(item.fy || '').padStart(4, '0')}-${String(item.fp || '').padStart(2, '0')}-${item.end || ''}-${item.filed || ''}`;
}

function periodKey(item) {
  return `${item.fy || ''}:${item.fp || ''}:${item.end || ''}`;
}

export function selectCanonicalFinancialQuarters(rows = []) {
  const byFiscalQuarter = new Map();
  rows.forEach((row) => {
    const key = `${row.fy || ''}:${row.fp || ''}`;
    const current = byFiscalQuarter.get(key);
    const rowDate = `${row.end || ''}:${row.filed || ''}`;
    const currentDate = `${current?.end || ''}:${current?.filed || ''}`;
    if (!current || rowDate.localeCompare(currentDate) > 0) byFiscalQuarter.set(key, row);
  });
  return [...byFiscalQuarter.values()]
    .sort((a, b) => fiscalSortKey(a).localeCompare(fiscalSortKey(b)));
}

function collectFacts(companyFacts, names) {
  const gaap = companyFacts?.facts?.['us-gaap'] || {};
  for (const tag of names) {
    const rows = gaap[tag]?.units?.USD;
    if (!Array.isArray(rows)) continue;
    return {
      tag,
      rows: rows
        .filter((row) => ['10-Q', '10-K'].includes(row.form) && ['Q1', 'Q2', 'Q3', 'FY'].includes(row.fp) && Number.isFinite(Number(row.val)))
        .map((row) => ({ ...row, val: Number(row.val) }))
    };
  }
  return { tag: names[0], rows: [] };
}

export function extractFinancialMetrics(companyFacts, limit = 12) {
  const byMetric = Object.fromEntries(
    Object.entries(metricDefinitions).map(([key, tags]) => [key, collectFacts(companyFacts, tags)])
  );
  const periods = new Map();

  Object.entries(byMetric).forEach(([metric, source]) => {
    source.rows.forEach((row) => {
      const key = periodKey(row);
      const existing = periods.get(key) || {
        fy: row.fy,
        fp: row.fp,
        end: row.end,
        filed: row.filed,
        form: row.form,
        accessionNumber: row.accn,
        period: `${row.fy} ${row.fp}`,
        source: { tag: source.tag, accessionNumber: row.accn, filed: row.filed }
      };
      existing[metric] = row.val;
      existing.sources = {
        ...(existing.sources || {}),
        [metric]: { tag: source.tag, accessionNumber: row.accn, filed: row.filed, end: row.end }
      };
      periods.set(key, existing);
    });
  });

  const rows = selectCanonicalFinancialQuarters([...periods.values()])
    .filter((row) => Number.isFinite(row.revenue))
    .slice(-Math.max(1, limit));

  const sameQuarter = new Map();
  rows.forEach((row) => {
    const lastYearKey = `${Number(row.fy) - 1}:${row.fp}`;
    const priorYear = sameQuarter.get(lastYearKey);
    row.revenueYoY = round(pctChange(row.revenue, priorYear?.revenue));
    row.netIncomeYoY = round(pctChange(row.netIncome, priorYear?.netIncome));
    if (!Number.isFinite(row.grossProfit) && Number.isFinite(row.revenue) && Number.isFinite(row.costOfRevenue)) {
      row.grossProfit = row.revenue - Math.abs(row.costOfRevenue);
      row.sources = {
        ...(row.sources || {}),
        grossProfit: {
          ...(row.sources?.costOfRevenue || {}),
          tag: `${row.sources?.revenue?.tag || 'Revenue'} - ${row.sources?.costOfRevenue?.tag || 'CostOfRevenue'}`
        }
      };
    }
    row.grossMargin = round(margin(row.grossProfit, row.revenue));
    row.operatingMargin = round(margin(row.operatingIncome, row.revenue));
    row.netMargin = round(margin(row.netIncome, row.revenue));
    row.fcf = Number.isFinite(row.operatingCashFlow) && Number.isFinite(row.capex)
      ? row.operatingCashFlow - Math.abs(row.capex)
      : null;
    row.fcfMargin = round(margin(row.fcf, row.revenue));
    sameQuarter.set(`${row.fy}:${row.fp}`, row);
  });

  return rows;
}

function yahooPeriodFromEnd(end, isAnnual) {
  const year = Number(end.slice(0, 4));
  const month = Number(end.slice(5, 7));
  const fp = isAnnual ? 'FY' : `Q${Math.ceil(month / 3)}`;
  return { fy: year, fp };
}

// Yahoo's quoteSummary income statement modules only carry an end-of-period date,
// not the filer's own fiscal-quarter label — so the quarter number here is derived
// from the calendar month, which may not match a company's internal fiscal naming
// (e.g. a company with a non-calendar fiscal year). Chronologically correct either way.
function yahooRowFromNode(node, isAnnual) {
  if (!node?.end) return null;
  const { fy, fp } = yahooPeriodFromEnd(node.end, isAnnual);
  return {
    fy,
    fp,
    end: node.end,
    filed: node.end,
    form: isAnnual ? '10-K' : '10-Q',
    accessionNumber: null,
    period: `${fy} ${fp}`,
    revenue: node.revenue,
    costOfRevenue: node.costOfRevenue,
    grossProfit: node.grossProfit,
    operatingIncome: node.operatingIncome,
    netIncome: node.netIncome,
    sources: {
      revenue: { tag: 'yahoo:totalRevenue', end: node.end },
      costOfRevenue: { tag: 'yahoo:costOfRevenue', end: node.end },
      operatingIncome: { tag: 'yahoo:operatingIncome', end: node.end },
      netIncome: { tag: 'yahoo:netIncome', end: node.end }
    }
  };
}

// Builds the same canonical `quarters` shape as extractFinancialMetrics(), but
// sourced entirely from Yahoo Finance's quoteSummary income statement modules
// instead of SEC company facts. Reuses the same margin/YoY math (recomputeDerivedMetrics)
// so SecReportPanel needs no changes regardless of which source produced the rows.
export function extractFinancialMetricsFromYahoo(payload = {}, limit = 12) {
  const rows = [
    ...(payload.annual || []).map((node) => yahooRowFromNode(node, true)),
    ...(payload.quarterly || []).map((node) => yahooRowFromNode(node, false))
  ].filter(Boolean);

  const canonical = selectCanonicalFinancialQuarters(rows)
    .filter((row) => Number.isFinite(row.revenue))
    .slice(-Math.max(1, limit));

  return recomputeDerivedMetrics(canonical);
}

function attrsFromTag(tag) {
  const attrs = {};
  for (const match of String(tag || '').matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function stripInlineText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[$,]/g, '');
}

function parseInlineNumber(rawText, attrs) {
  const cleaned = stripInlineText(rawText);
  if (!cleaned || cleaned === '-' || cleaned === '—') return null;
  const numeric = Number(cleaned.replace(/[()]/g, ''));
  if (!Number.isFinite(numeric)) return null;
  const sign = attrs.sign === '-' || /^\(.*\)$/.test(cleaned) ? -1 : 1;
  const scale = Number(attrs.scale || 0);
  return sign * numeric * (Number.isFinite(scale) ? 10 ** scale : 1);
}

function quarterFromEndDate(end) {
  const month = Number(String(end || '').slice(5, 7));
  if (month === 3) return 'Q1';
  if (month === 6) return 'Q2';
  if (month === 9) return 'Q3';
  if (month === 12) return 'FY';
  return 'Q';
}

function metricPeriodKey(row) {
  return `${row.fy}:${row.fp}:${row.end}`;
}

function recomputeDerivedMetrics(rows) {
  const sameQuarter = new Map();
  rows.forEach((row) => {
    const lastYearKey = `${Number(row.fy) - 1}:${row.fp}`;
    const priorYear = sameQuarter.get(lastYearKey);
    row.revenueYoY = round(pctChange(row.revenue, priorYear?.revenue));
    row.netIncomeYoY = round(pctChange(row.netIncome, priorYear?.netIncome));
    if (!Number.isFinite(row.grossProfit) && Number.isFinite(row.revenue) && Number.isFinite(row.costOfRevenue)) {
      row.grossProfit = row.revenue - Math.abs(row.costOfRevenue);
      row.sources = {
        ...(row.sources || {}),
        grossProfit: {
          ...(row.sources?.costOfRevenue || {}),
          tag: `${row.sources?.revenue?.tag || 'Revenue'} - ${row.sources?.costOfRevenue?.tag || 'CostOfRevenue'}`
        }
      };
    }
    row.grossMargin = round(margin(row.grossProfit, row.revenue));
    row.operatingMargin = round(margin(row.operatingIncome, row.revenue));
    row.netMargin = round(margin(row.netIncome, row.revenue));
    row.fcf = Number.isFinite(row.operatingCashFlow) && Number.isFinite(row.capex)
      ? row.operatingCashFlow - Math.abs(row.capex)
      : null;
    row.fcfMargin = round(margin(row.fcf, row.revenue));
    sameQuarter.set(`${row.fy}:${row.fp}`, row);
  });
  return rows;
}

export function extractInlineFinancialMetrics(html, filing = {}) {
  const contexts = {};
  for (const match of String(html || '').matchAll(/<xbrli:context\b([^>]*)>([\s\S]*?)<\/xbrli:context>/gi)) {
    const attrs = attrsFromTag(match[1]);
    const body = match[2];
    contexts[attrs.id] = {
      id: attrs.id,
      start: body.match(/<xbrli:startDate>([^<]+)/i)?.[1] || null,
      end: body.match(/<xbrli:endDate>([^<]+)/i)?.[1] || body.match(/<xbrli:instant>([^<]+)/i)?.[1] || null,
      segment: /<xbrli:segment>/i.test(body)
    };
  }

  const facts = [];
  for (const match of String(html || '').matchAll(/<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/gi)) {
    const attrs = attrsFromTag(match[1]);
    const context = contexts[attrs.contextRef];
    const value = parseInlineNumber(match[2], attrs);
    if (!context?.start || !context?.end || !Number.isFinite(value)) continue;
    facts.push({
      name: attrs.name || '',
      contextRef: attrs.contextRef,
      start: context.start,
      end: context.end,
      segment: context.segment,
      value,
      scale: Number(attrs.scale || 0)
    });
  }

  const periods = [...new Set(facts.map((fact) => `${fact.start}:${fact.end}`))].map((key) => {
    const [start, end] = key.split(':');
    return { start, end };
  });

  const pickFact = (period, tags, { allowSegment = false } = {}) => {
    const candidates = facts.filter((fact) => (
      fact.start === period.start &&
      fact.end === period.end &&
      tags.includes(fact.name) &&
      (allowSegment || !fact.segment)
    ));
    return candidates.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0] || null;
  };

  const sumSegmentFacts = (period, tags) => {
    const deduped = new Map();
    facts.filter((fact) => fact.start === period.start && fact.end === period.end && fact.segment && tags.includes(fact.name))
      .forEach((fact) => {
        deduped.set(`${fact.name}:${fact.contextRef}:${fact.value}`, fact);
      });
    const values = [...deduped.values()];
    if (!values.length) return null;
    return values.reduce((sum, fact) => sum + Math.abs(fact.value), 0);
  };

  const revenueTags = [
    'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax',
    'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
    'us-gaap:Revenues',
    'us-gaap:SalesRevenueNet'
  ];
  const costTags = [
    'us-gaap:CostOfRevenue',
    'us-gaap:CostOfGoodsAndServicesSold',
    'us-gaap:CostOfGoodsSold',
    'us-gaap:CostOfRevenueExcludingDepreciationDepletionAndAmortization'
  ];
  const grossTags = ['us-gaap:GrossProfit'];
  const netTags = ['us-gaap:NetIncomeLoss'];
  const operatingTags = ['us-gaap:OperatingIncomeLoss'];

  const rows = periods.map((period) => {
    const revenue = pickFact(period, revenueTags);
    if (!revenue) return null;
    const cost = pickFact(period, costTags) || { value: sumSegmentFacts(period, costTags), name: costTags[0] };
    const gross = pickFact(period, grossTags);
    const net = pickFact(period, netTags);
    const operating = pickFact(period, operatingTags);
    const fp = quarterFromEndDate(period.end);
    const fy = Number(period.end.slice(0, 4));
    return {
      fy,
      fp,
      end: period.end,
      filed: filing.filingDate || '',
      form: filing.form || '',
      accessionNumber: filing.accessionNumber || '',
      period: `${fy} ${fp}`,
      source: { tag: revenue.name, accessionNumber: filing.accessionNumber || '', filed: filing.filingDate || '', source: 'inline-xbrl' },
      sources: {
        revenue: { tag: revenue.name, accessionNumber: filing.accessionNumber || '', filed: filing.filingDate || '', source: 'inline-xbrl' },
        costOfRevenue: cost?.value !== null ? { tag: cost.name, accessionNumber: filing.accessionNumber || '', filed: filing.filingDate || '', source: 'inline-xbrl' } : undefined,
        grossProfit: gross ? { tag: gross.name, accessionNumber: filing.accessionNumber || '', filed: filing.filingDate || '', source: 'inline-xbrl' } : undefined,
        operatingIncome: operating ? { tag: operating.name, accessionNumber: filing.accessionNumber || '', filed: filing.filingDate || '', source: 'inline-xbrl' } : undefined,
        netIncome: net ? { tag: net.name, accessionNumber: filing.accessionNumber || '', filed: filing.filingDate || '', source: 'inline-xbrl' } : undefined
      },
      revenue: revenue.value,
      costOfRevenue: cost?.value ?? null,
      grossProfit: gross?.value ?? null,
      operatingIncome: operating?.value ?? null,
      netIncome: net?.value ?? null
    };
  }).filter(Boolean);

  return recomputeDerivedMetrics(rows.sort((a, b) => fiscalSortKey(a).localeCompare(fiscalSortKey(b))));
}

function latestFinancialQuarter(metrics) {
  const quarterly = metrics.filter((row) => row.fp !== 'FY' && Number.isFinite(row.revenue));
  return quarterly.at(-1) || metrics[metrics.length - 1] || null;
}

function describeTrend(latest) {
  if (!latest) return 'SEC company facts 暂未给出可用季度营收数据，报告先保留文件追踪和验收状态。';
  const bits = [`${latest.period} 营收 ${formatCompact(latest.revenue)}`];
  if (latest.revenueYoY !== null) bits.push(`同比 ${formatPercent(latest.revenueYoY)}`);
  if (latest.grossMargin !== null) bits.push(`毛利率 ${formatPercent(latest.grossMargin)}`);
  if (latest.netMargin !== null) bits.push(`净利率 ${formatPercent(latest.netMargin)}`);
  return `${bits.join('，')}。`;
}

function reportVersionId(ticker, filings, metrics) {
  const latest = filings[0]?.accessionNumber || 'no-filing';
  const period = latestFinancialQuarter(metrics)?.period || 'no-period';
  return `${ticker}:${latest}:${period}`;
}

function buildAlerts(metrics, filings) {
  const alerts = [];
  const latest = metrics.at(-1);
  const previous = metrics.at(-2);
  if (latest?.grossMargin !== null && previous?.grossMargin !== null && previous && latest.grossMargin - previous.grossMargin <= -0.03) {
    alerts.push({ severity: 'high', label: '毛利率压缩', detail: `较上一期下降 ${formatPercent(Math.abs(latest.grossMargin - previous.grossMargin))}` });
  }
  if (latest?.netMargin !== null && previous?.netMargin !== null && previous && latest.netMargin < 0 && previous.netMargin >= 0) {
    alerts.push({ severity: 'high', label: '净利转负', detail: `${latest.period} 净利率 ${formatPercent(latest.netMargin)}` });
  }
  if (filings.some((filing) => filing.form === '8-K')) {
    alerts.push({ severity: 'medium', label: '8-K 更新', detail: '近期存在 8-K，可能包含业绩公告、融资或重大事项。' });
  }
  if (!alerts.length) alerts.push({ severity: 'low', label: '未触发硬性异常', detail: '当前报告未发现利润率或文件类型层面的自动告警。' });
  return alerts;
}

function chartSeries(metrics) {
  return [
    {
      id: 'revenue-yoy',
      title: '营收与同比',
      type: 'bar-line',
      data: metrics.map((row) => ({ period: row.period, revenue: row.revenue, revenueYoY: row.revenueYoY }))
    },
    {
      id: 'margin-lines',
      title: '利润率走势',
      type: 'line',
      data: metrics.map((row) => ({
        period: row.period,
        grossMargin: row.grossMargin,
        operatingMargin: row.operatingMargin,
        netMargin: row.netMargin
      }))
    },
    {
      id: 'profit-fcf',
      title: '净利润与自由现金流',
      type: 'bar',
      data: metrics.map((row) => ({ period: row.period, netIncome: row.netIncome, fcf: row.fcf }))
    }
  ];
}

export function splitFilingSections(text) {
  const source = String(text || '').replace(/\r/g, '\n');
  const sectionDefs = [
    ['businessUpdate', /business update|overview|recent developments/i],
    ['revenueDrivers', /revenue|sales/i],
    ['margins', /gross margin|operating income|margin/i],
    ['liquidity', /liquidity|cash flow|working capital/i],
    ['guidance', /guidance|outlook|forecast|expect/i],
    ['riskFactors', /risk factors/i],
    ['subsequentEvents', /subsequent events/i]
  ];
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const buckets = Object.fromEntries(sectionDefs.map(([name]) => [name, []]));
  let current = 'businessUpdate';

  for (const line of lines) {
    const hit = sectionDefs.find(([, pattern]) => pattern.test(line));
    if (hit) current = hit[0];
    if (buckets[current].join(' ').length < 9000) buckets[current].push(line);
  }

  return Object.entries(buckets)
    .filter(([, value]) => value.length)
    .map(([name, value]) => ({
      name,
      text: value.join('\n').slice(0, 9000),
      hash: simpleHash(value.join('\n'))
    }));
}

export function buildFallbackAiInsights({ sections = [], latestFiling = null }) {
  const findSection = (name) => sections.find((section) => section.name === name);
  const guidance = findSection('guidance');
  const risks = findSection('riskFactors');
  const liquidity = findSection('liquidity');
  return {
    source: 'fallback',
    confidence: 0.58,
    sections: sections.map((section) => ({ name: section.name, hash: section.hash })),
    guidanceChanges: guidance
      ? [{ status: 'needs_review', detail: 'Guidance / Outlook 相关文本已定位，需 DeepSeek V4 或人工复核后写入正式结论。' }]
      : [{ status: 'not_found', detail: '最新 filing 未定位到明确 Guidance / Outlook；需结合 8-K、earnings release 或电话会材料继续复核。' }],
    riskFlags: risks
      ? [{ severity: 'medium', detail: 'Risk Factors section 存在，需要与上一版逐段 diff。' }]
      : [{ severity: 'low', detail: '最新 filing 未定位到独立 Risk Factors section；仍需关注 8-K、流动性、摊薄和内控披露。' }],
    liquidityNotes: liquidity ? ['Liquidity / cash flow section 已纳入 AI 分析队列。'] : [],
    sourceQuotes: latestFiling ? [{ accessionNumber: latestFiling.accessionNumber, section: guidance?.name || sections[0]?.name || 'filing', quote: (guidance?.text || sections[0]?.text || '').slice(0, 220) }] : []
  };
}

export function selectRenderableAiInsights(ai = {}) {
  const blockedStatuses = new Set(['not_found', 'needs_review', 'error']);
  const blockedText = [
    /did not contain readable text/i,
    /未定位到明确/i,
    /未定位到独立/i,
    /需要.*复核/i,
    /需.*复核/i,
    /等待.*复核/i,
    /未触发文本风险信号/i
  ];
  const keep = (item) => {
    const detail = String(item?.detail || '').trim();
    if (!detail || blockedStatuses.has(String(item?.status || '').toLowerCase())) return false;
    return !blockedText.some((pattern) => pattern.test(detail));
  };
  return {
    guidanceChanges: (ai.guidanceChanges || []).filter(keep),
    riskFlags: (ai.riskFlags || []).filter(keep)
  };
}

export function normalizeFilingSummary(summary = {}, filing = {}) {
  const blockedText = [
    /did not contain readable text/i,
    /未找到/i,
    /未定位到/i,
    /无法读取/i,
    /需要.*复核/i,
    /需.*复核/i,
    /等待.*复核/i
  ];
  const cleanText = (value, maxLength) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  const isUseful = (value) => value && !blockedText.some((pattern) => pattern.test(value));
  const bullets = (Array.isArray(summary.bullets) ? summary.bullets : [])
    .map((item) => ({
      label: cleanText(item?.label, 24),
      detail: cleanText(item?.detail, 320),
      importance: ['high', 'medium', 'low'].includes(item?.importance) ? item.importance : 'medium'
    }))
    .filter((item) => item.label && isUseful(item.detail))
    .slice(0, 4);
  const headline = cleanText(summary.headline, 180);
  const analystView = cleanText(summary.analystView, 260);

  return {
    ticker: String(filing.ticker || '').toUpperCase(),
    form: String(filing.form || ''),
    filingDate: String(filing.filingDate || ''),
    accessionNumber: String(filing.accessionNumber || ''),
    headline: isUseful(headline) ? headline : '',
    bullets,
    analystView: isUseful(analystView) ? analystView : '',
    source: String(summary.source || 'deepseek'),
    generatedAt: String(summary.generatedAt || new Date().toISOString())
  };
}

function simpleHash(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16);
}

function mergeFinancialMetrics(companyFactsMetrics, inlineMetrics, limit = 12) {
  const byPeriod = new Map();
  companyFactsMetrics.forEach((row) => byPeriod.set(metricPeriodKey(row), row));
  inlineMetrics.forEach((row) => byPeriod.set(metricPeriodKey(row), { ...byPeriod.get(metricPeriodKey(row)), ...row }));
  return recomputeDerivedMetrics(selectCanonicalFinancialQuarters([...byPeriod.values()])
    .filter((row) => Number.isFinite(row.revenue))
    .slice(-Math.max(1, limit)));
}

export function buildSecAnalysisReport({ ticker, companyName, filings = [], companyFacts, previousReport = null, aiInsights = null, inlineMetrics = [], financialMetrics = null }) {
  const cleanTicker = String(ticker || '').toUpperCase();
  const filteredFilings = [...filings]
    .filter((filing) => filing.accessionNumber)
    .sort((a, b) => String(b.filingDate || '').localeCompare(String(a.filingDate || '')));
  // financialMetrics (Yahoo-sourced) bypasses both SEC company facts and SEC inline-XBRL
  // patches — once we have a clean Yahoo source for revenue/margins, SEC text shouldn't
  // silently overwrite it again.
  const allMetrics = financialMetrics
    ? mergeFinancialMetrics(financialMetrics, [], 12)
    : mergeFinancialMetrics(extractFinancialMetrics(companyFacts, 12), inlineMetrics, 12);
  const financialsSource = financialMetrics ? 'yahoo' : 'sec';
  // 季度与年度分开存放，前端可切换；横坐标因此天然统一（季度全是 Qn，年度全是 FY）。
  const quarterMetrics = allMetrics.filter((row) => row.fp !== 'FY');
  const annualMetrics = allMetrics.filter((row) => row.fp === 'FY');
  const latest = latestFinancialQuarter(allMetrics);
  const latestFiling = filteredFilings[0] || null;
  const versionId = reportVersionId(cleanTicker, filteredFilings, allMetrics);

  const report = {
    versionId,
    ticker: cleanTicker,
    companyName: companyName || cleanTicker,
    generatedAt: new Date().toISOString(),
    latestFiling,
    thesisStatus: previousReport ? 'revised' : 'new',
    summary: [
      describeTrend(latest),
      latestFiling ? `最新文件是 ${latestFiling.form}，提交日 ${latestFiling.filingDate}，accession ${latestFiling.accessionNumber}。` : '尚未发现可用 SEC 文件。',
      financialsSource === 'yahoo'
        ? '营收/利润率硬指标来自 Yahoo Finance（最近约4个季度+历年年报，无法计算的 YoY 显示为空）；AI 文本结论仍基于 SEC filing 并保留引用。'
        : '硬指标来自 SEC company facts；AI 文本结论必须保留 filing 引用后才进入正式报告。'
    ],
    agentMap: {
      currentDataPriority: [
        '必须优先使用最新 filing 和最新季度数据，不能因为 FY 数据较完整就回退到 2024 年。',
        '必须优先使用最新 filing 和最新季度数据，不能因为 FY 数据较完整就回退到 2024 年。',
        '必须优先使用最新 filing 和最新季度数据，不能因为 FY 数据较完整就回退到 2024 年。'
      ],
      accuracyChecks: [
        'headline period 必须等于 latest quarterly period，除非没有任何季度数据。',
        'YoY 必须用同一 fiscal quarter 的上一年数据计算。',
        '毛利率优先用 GrossProfit；缺失时用 Revenue - CostOfRevenue 推导，并保留 source tag。'
      ]
    },
    financials: {
      quarters: quarterMetrics,
      annual: annualMetrics,
      latest,
      source: financialsSource
    },
    alerts: buildAlerts(quarterMetrics, filteredFilings),
    ai: aiInsights || {
      source: 'not_run',
      confidence: 0,
      guidanceChanges: [],
      riskFlags: [],
      liquidityNotes: [],
      sourceQuotes: []
    },
    charts: chartSeries(quarterMetrics),
    sources: filteredFilings.slice(0, 6).map((filing) => ({
      form: filing.form,
      filingDate: filing.filingDate,
      accessionNumber: filing.accessionNumber,
      url: filing.documentUrl || filing.indexUrl
    }))
  };

  return previousReport ? mergeReportRevision(previousReport, report) : report;
}

export function mergeReportRevision(previousReport, nextReport) {
  const revisedSections = [];
  if (previousReport?.latestFiling?.accessionNumber !== nextReport.latestFiling?.accessionNumber) revisedSections.push('latestFiling');
  if (previousReport?.financials?.quarters?.length !== nextReport.financials?.quarters?.length) revisedSections.push('financials');
  if (JSON.stringify(previousReport?.alerts || []) !== JSON.stringify(nextReport.alerts || [])) revisedSections.push('alerts');

  return {
    ...nextReport,
    thesisStatus: revisedSections.length ? 'revised' : 'unchanged',
    revision: {
      previousVersionId: previousReport?.versionId || null,
      revisedSections,
      unchangedSections: ['sources'].filter((section) => !revisedSections.includes(section)),
      createdAt: nextReport.generatedAt
    }
  };
}

export function formatCompact(value) {
  if (!Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${round(value / 1_000_000_000, 1)}B`;
  if (abs >= 1_000_000) return `$${round(value / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `$${round(value / 1_000, 1)}K`;
  return `$${round(value, 1)}`;
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${round(value * 100, 1)}%`;
}
