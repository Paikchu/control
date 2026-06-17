import { cleanTicker, parseJsonObject } from '../util.mjs';
import { deepseekChat, hasDeepSeekKey, managementModel } from './deepseek.mjs';
import { hasSearchKey, searchWeb } from './searchClient.mjs';
import { getFilingText, getSecCompany, getSecFilingsByForms } from './secClient.mjs';

const DISCLAIMER = '管理层背景与负面信息由 AI 基于公开网络检索结果归纳生成，仅供参考，不构成事实认定或投资建议。';

function execKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function hasManagementChangeItem(filing) {
  return String(filing.items || '')
    .split(',')
    .map((item) => item.trim())
    .includes('5.02');
}

async function readWatermark(db, ticker) {
  const { rows } = await db.query('SELECT * FROM management_watermark WHERE ticker = $1', [ticker]);
  return rows[0] || null;
}

async function writeWatermark(db, ticker, filing) {
  await db.query(`
    INSERT INTO management_watermark (ticker, last_8k_accession, last_8k_date, last_checked_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (ticker) DO UPDATE SET
      last_8k_accession = EXCLUDED.last_8k_accession,
      last_8k_date = EXCLUDED.last_8k_date,
      last_checked_at = EXCLUDED.last_checked_at
  `, [ticker, filing?.accessionNumber || null, filing?.filingDate || null, new Date().toISOString()]);
}

async function readExecutives(db, ticker) {
  const { rows } = await db.query('SELECT * FROM management_executives WHERE ticker = $1 ORDER BY name', [ticker]);
  return rows.map((row) => ({ ...row, profile: JSON.parse(row.profile) }));
}

async function upsertExecutive(db, ticker, key, { name, role, status, profile, sourcedAt, source8k, tenureStart = null, tenureEnd = null }) {
  await db.query(`
    INSERT INTO management_executives (ticker, exec_key, name, role, status, tenure_start, tenure_end, profile, sourced_at, source_8k_accession)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (ticker, exec_key) DO UPDATE SET
      name = EXCLUDED.name,
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      tenure_end = EXCLUDED.tenure_end,
      profile = EXCLUDED.profile,
      sourced_at = EXCLUDED.sourced_at,
      source_8k_accession = EXCLUDED.source_8k_accession
  `, [ticker, key, name, role, status, tenureStart, tenureEnd, JSON.stringify(profile), sourcedAt, source8k || null]);
}

async function markDeparted(db, ticker, key, filing) {
  await db.query(`
    UPDATE management_executives
    SET status = 'departed', tenure_end = $3, source_8k_accession = $4
    WHERE ticker = $1 AND exec_key = $2
  `, [ticker, key, filing.filingDate, filing.accessionNumber]);
}

// Builds one ExecutiveProfile: searches the open web, then has DeepSeek synthesize
// background/achievements/redFlags. Any redFlag whose source URL isn't among the actual
// search results we fetched is dropped — negative claims must be traceable, not invented.
async function buildExecutiveProfile({ companyName, name, roleHint = null }) {
  if (!hasSearchKey() || !hasDeepSeekKey()) {
    return {
      name,
      role: roleHint || '',
      background: [],
      achievements: [],
      redFlags: [],
      overallAssessment: { summary: '搜索或 DeepSeek API Key 未配置，无法生成管理层分析。', trustScore: null }
    };
  }

  const queries = [
    `${name} ${companyName} title role executive`,
    `${name} ${companyName} biography career background`,
    `${name} ${companyName} achievements track record`,
    `${name} ${companyName} lawsuit scandal controversy SEC investigation`
  ];
  const resultSets = await Promise.all(queries.map((q) => searchWeb(q, { maxResults: 5 }).catch(() => [])));
  const sources = resultSets.flat();

  if (!sources.length) {
    return {
      name,
      role: roleHint || '',
      background: [],
      achievements: [],
      redFlags: [],
      overallAssessment: { summary: '未检索到公开资料。', trustScore: null }
    };
  }

  try {
    const content = await deepseekChat({
      model: managementModel,
      system: [
        '你是负责上市公司管理层背调的研究员。',
        '只能使用用户提供的搜索结果作为信息来源，不能使用你自己的知识编造内容。',
        'role、background[].text、achievements[].text、redFlags[].text、overallAssessment.summary 必须全部使用简体中文撰写——即使搜索结果是英文，也要先理解内容再用中文转述/翻译，禁止直接抄英文原文；人名、公司名、产品名、机构名可保留英文原文。',
        'source.title 和 source.url 保持搜索结果中的原文，不要翻译。',
        'role 字段是该人物当前在 companyName 担任的职务，基于搜索结果确定；如果搜索结果没有明确说明，使用给定的 roleHint 并翻译成中文；都没有则留空。',
        '每条 background / achievements / redFlags 必须带 source（{title,url}，必须是给定搜索结果中的真实 url）和 confidence(0-1)。',
        '没有匹配来源支撑的内容不要输出，尤其是 redFlags（负面信息）：没有可点击来源就必须省略，不能编造或推测。',
        'redFlags 每条额外带 severity: low|medium|high。',
        'overallAssessment.summary 用一句中文总结；trustScore 是 0-100 的整数，越高代表可信度/口碑越好；如证据不足可为 null。',
        '输出 JSON: {"role":"","background":[{"text":"","source":{"title":"","url":""},"confidence":0}],"achievements":[...],"redFlags":[{"text":"","severity":"","source":{},"confidence":0}],"overallAssessment":{"summary":"","trustScore":0}}'
      ].join('\n'),
      user: JSON.stringify({
        companyName,
        name,
        roleHint,
        sources: sources.map((s) => ({ title: s.title, url: s.url, snippet: s.snippet.slice(0, 600) }))
      })
    });
    const parsed = parseJsonObject(content);
    const validUrls = new Set(sources.map((s) => s.url));
    const keepSourced = (item) => item?.source?.url && validUrls.has(item.source.url);
    return {
      name,
      role: parsed.role || roleHint || '',
      background: (parsed.background || []).filter(keepSourced),
      achievements: (parsed.achievements || []).filter(keepSourced),
      redFlags: (parsed.redFlags || []).filter(keepSourced),
      overallAssessment: parsed.overallAssessment || { summary: '', trustScore: null }
    };
  } catch {
    return {
      name,
      role: roleHint || '',
      background: [],
      achievements: [],
      redFlags: [],
      overallAssessment: { summary: 'AI 分析生成失败。', trustScore: null }
    };
  }
}

// Cold start: pull the current roster from the latest DEF 14A proxy statement.
async function extractRosterFromDef14a(db, ticker, companyName) {
  const filings = await getSecFilingsByForms(db, ticker, ['DEF 14A'], { limit: 1 });
  const filing = filings[0];
  if (!filing) return { roster: [], filing: null };

  const text = await getFilingText(db, filing);
  if (!hasDeepSeekKey()) return { roster: [], filing };

  // The Compensation Discussion & Analysis intro reliably names that year's Named Executive
  // Officers (e.g. '...Named Executives ("NEOs"), who are: A, B, C.') — anchoring on the
  // "NEO" abbreviation is far more reliable across companies than guessing a byte offset.
  const neoIdx = text.search(/\bNEOs?\b/);
  const window = neoIdx === -1 ? text.slice(0, 30000) : text.slice(Math.max(0, neoIdx - 2500), neoIdx + 2500);

  const content = await deepseekChat({
    model: managementModel,
    system: [
      '你是 SEC 委托书(DEF 14A)分析员。',
      '给定文本片段通常包含公司当年 Named Executive Officers (NEO) 名单的说明段落。',
      '只提取明确列出的高管姓名，不要包含独立董事候选人，不要编造文本中没有出现的人。',
      '输出 JSON: {"roster":[{"name":""}]}'
    ].join('\n'),
    user: JSON.stringify({ ticker, companyName, text: window })
  });
  const parsed = parseJsonObject(content);
  return { roster: parsed.roster || [], filing };
}

// Extracts who left / who was appointed from one Item 5.02 8-K.
async function extractPersonnelChanges(db, ticker, filing) {
  const text = await getFilingText(db, filing);
  if (!hasDeepSeekKey()) return { departures: [], appointments: [] };

  const content = await deepseekChat({
    model: managementModel,
    system: [
      '你是 SEC 8-K Item 5.02 (高管/董事变动) 分析员。',
      '只基于给定文本提取本次披露的人事变动，不要编造。',
      'departures: 本次离任/卸任人员姓名与原职务；appointments: 本次新任命人员姓名与新职务。',
      'role 字段必须用简体中文描述职务（如"首席财务官"），人名保留原文。',
      '没有变动的字段输出空数组。',
      '输出 JSON: {"departures":[{"name":"","role":""}],"appointments":[{"name":"","role":""}]}'
    ].join('\n'),
    user: JSON.stringify({ ticker, filingDate: filing.filingDate, text: text.slice(0, 12000) })
  });
  const parsed = parseJsonObject(content);
  return { departures: parsed.departures || [], appointments: parsed.appointments || [] };
}

function toApiExecutive(row) {
  return {
    name: row.name,
    role: row.role,
    status: row.status,
    tenureStart: row.tenure_start,
    tenureEnd: row.tenure_end,
    sourcedAt: row.sourced_at,
    sourceFiling: row.source_8k_accession,
    background: row.profile.background || [],
    achievements: row.profile.achievements || [],
    redFlags: row.profile.redFlags || [],
    overallAssessment: row.profile.overallAssessment || { summary: '', trustScore: null }
  };
}

function buildResponse(ticker, executives, meta) {
  return {
    ticker,
    generatedAt: new Date().toISOString(),
    active: executives.filter((e) => e.status === 'active').map(toApiExecutive),
    departed: executives.filter((e) => e.status === 'departed').map(toApiExecutive),
    refreshed: meta.refreshed,
    reason: meta.reason,
    disclaimer: DISCLAIMER
  };
}

// Permanent, incrementally-maintained cache. Only re-searches the open web when an
// 8-K Item 5.02 (officer/director change) appears since the last scan, and only for the
// people that filing actually names — everyone else's profile is reused untouched.
export async function getManagementReport(db, ticker, { force = false } = {}) {
  const clean = cleanTicker(ticker);
  const company = await getSecCompany(db, clean).catch(() => null);
  const companyName = company?.name || clean;

  const watermark = await readWatermark(db, clean);
  const existing = await readExecutives(db, clean);
  const now = new Date().toISOString();

  if (!watermark || existing.length === 0) {
    const { roster, filing } = await extractRosterFromDef14a(db, clean, companyName);
    const profiles = await Promise.all(roster.map((r) => buildExecutiveProfile({ companyName, name: r.name })));
    for (const profile of profiles) {
      await upsertExecutive(db, clean, execKey(profile.name), {
        name: profile.name,
        role: profile.role,
        status: 'active',
        profile,
        sourcedAt: now,
        source8k: null
      });
    }
    const latest8K = (await getSecFilingsByForms(db, clean, ['8-K', '8-K/A'], { limit: 1 }))[0];
    await writeWatermark(db, clean, latest8K || filing);
    return buildResponse(clean, await readExecutives(db, clean), {
      refreshed: true,
      reason: '首次分析：已从 DEF 14A 委托书构建管理层名册'
    });
  }

  const recent8Ks = await getSecFilingsByForms(db, clean, ['8-K', '8-K/A'], { limit: 50, force });
  const watermarkDate = watermark.last_8k_date || '';
  const newFilings = recent8Ks
    .filter((f) => f.accessionNumber !== watermark.last_8k_accession && f.filingDate >= watermarkDate)
    .filter(hasManagementChangeItem)
    .sort((a, b) => a.filingDate.localeCompare(b.filingDate));

  let changed = false;
  for (const filing of newFilings) {
    const { departures, appointments } = await extractPersonnelChanges(db, clean, filing);
    for (const dep of departures) {
      await markDeparted(db, clean, execKey(dep.name), filing);
      changed = true;
    }
    for (const app of appointments) {
      const profile = await buildExecutiveProfile({ companyName, name: app.name, roleHint: app.role });
      await upsertExecutive(db, clean, execKey(app.name), {
        name: app.name,
        role: profile.role || app.role,
        status: 'active',
        profile,
        sourcedAt: now,
        source8k: filing.accessionNumber
      });
      changed = true;
    }
    await writeWatermark(db, clean, filing);
  }

  if (force) {
    const activeNow = (await readExecutives(db, clean)).filter((e) => e.status === 'active');
    const refreshedProfiles = await Promise.all(
      activeNow.map((exec) => buildExecutiveProfile({ companyName, name: exec.name, roleHint: exec.role }))
    );
    for (let i = 0; i < activeNow.length; i++) {
      await upsertExecutive(db, clean, activeNow[i].exec_key, {
        name: activeNow[i].name,
        role: refreshedProfiles[i].role || activeNow[i].role,
        status: 'active',
        profile: refreshedProfiles[i],
        sourcedAt: now,
        source8k: activeNow[i].source_8k_accession
      });
    }
    changed = true;
  }

  return buildResponse(clean, await readExecutives(db, clean), {
    refreshed: changed,
    reason: newFilings.length
      ? `检测到 ${newFilings.length} 条 8-K Item 5.02 人事变动`
      : force
        ? '手动强制刷新'
        : '未检测到管理层变动，使用永久缓存'
  });
}
