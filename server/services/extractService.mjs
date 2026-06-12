import { splitFilingSections } from '../../src/secReport.mjs';
import { htmlToText, parseJsonObject } from '../util.mjs';
import { deepseekChat, hasDeepSeekKey, secAnalysisModel } from './deepseek.mjs';
import { getFilingRaw, getSecFilings, isInsiderFiling, secQueueFetch } from './secClient.mjs';

export function extractHtmlTables(html) {
  const tables = [];
  const re = /<table[\s>][\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tableHtml = m[0];
    const start = Math.max(0, m.index - 300);
    const ctx = html.slice(start, m.index);
    const titleMatch = ctx.match(/(?:<(?:h[1-6]|p|div|td|th)[^>]*>)([^<]{4,120})<\/(?:h[1-6]|p|div|td|th)>\s*$/i);
    const caption = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const title = (caption ? htmlToText(caption[1]) : titleMatch ? htmlToText(titleMatch[1]) : '').slice(0, 120).trim();
    const text = htmlToText(tableHtml).replace(/[ \t]+/g, ' ').trim();
    if (text.length > 40) tables.push({ title, text: text.slice(0, 4000) });
  }
  return tables;
}

async function getFilingIndexDocuments(filing) {
  try {
    const resp = await secQueueFetch(filing.indexUrl, 'text/html,application/json,*/*');
    const text = await resp.text();
    const docs = [];
    const re = /href="(\/Archives\/edgar\/data\/[^"]+\.(htm|html|txt))"[^>]*>\s*([^<]+)<\/a>[\s\S]*?<td[^>]*>([^<]*EX-99[^<]*|[^<]*exhibit 99[^<]*)<\/td>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      docs.push({ url: `https://www.sec.gov${m[1]}`, description: m[4].trim() });
    }
    return docs;
  } catch {
    return [];
  }
}

async function extractForm4Data(filing) {
  try {
    const resp = await secQueueFetch(filing.documentUrl, 'text/xml,application/xml,*/*');
    const xml = await resp.text();
    const getTag = (tag, src) => { const m = src.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')); return m ? m[1].trim() : ''; };
    const getAllTags = (tag, src) => { const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'); const r = []; let m; while ((m = re.exec(src)) !== null) r.push(m[1]); return r; };

    const ownerName = getTag('rptOwnerName', xml) || getTag('issuerName', xml);
    const ownerTitle = getTag('officerTitle', xml);
    const isDirector = /<isDirector>1/.test(xml);
    const is10b51 = /<datesExercisableAndExpiration|<planName>/.test(xml);
    const generatedAt = new Date().toISOString();

    const items = [];
    for (const txn of getAllTags('nonDerivativeTransaction', xml)) {
      const code = getTag('transactionCode', txn);
      const shares = parseFloat(getTag('transactionShares', txn).replace(/[^0-9.-]/g, '')) || 0;
      const price = parseFloat(getTag('transactionPricePerShare', txn).replace(/[^0-9.-]/g, '')) || 0;
      const sharesAfter = parseFloat(getTag('sharesOwnedFollowingTransaction', txn).replace(/[^0-9.-]/g, '')) || 0;
      if (!code || shares === 0) continue;
      const label = `Insider ${code === 'S' ? 'sale' : code === 'P' ? 'purchase' : `transaction (${code})`} - ${ownerName}`;
      const detail = `${ownerName}${ownerTitle ? ` (${ownerTitle})` : ''} — code ${code}, ${shares.toLocaleString()} shares @ $${price.toFixed(2)}, holding after: ${sharesAfter.toLocaleString()}${is10b51 ? ' [10b5-1 plan]' : ''}`;
      items.push({ label, detail, code, shares, price, sharesAfter, is10b51, isDirector });
    }
    return { ownerName, items, generatedAt };
  } catch {
    return null;
  }
}

async function extractFilingWithDeepSeek(filing, tables, sections) {
  if (!hasDeepSeekKey()) return [];

  const tablesSample = tables.slice(0, 8).map((t, i) => ({ i, title: t.title, text: t.text.slice(0, 1800) }));
  const sectionsSample = sections.slice(0, 5).map((s) => ({ name: s.name, text: s.text.slice(0, 1500) }));

  try {
    const content = await deepseekChat({
      model: secAnalysisModel,
      system: [
        '你是美股 SEC 财报数据提取专家。只根据给定内容提取数据，禁止编造。',
        '每个提取结果必须有 quote 字段引用原文（不超过 80 字符）。',
        '数字必须保留原始量级，识别表头中的 "in thousands/millions" 并在 unit 里注明。',
        '括号数字表示负值。分部收入、KPI、指引是最重要的提取目标。',
        '输出 JSON: {"extracts": [{"kind":"financial|segment|kpi|guidance|event","label":"指标名","period":"2025 Q2","value":null,"unit":"USD millions","detail":"中文说明","quote":"原文引用","importance":"high|medium|low"}]}'
      ].join('\n'),
      user: JSON.stringify({
        ticker: filing.ticker, form: filing.form, filingDate: filing.filingDate,
        accessionNumber: filing.accessionNumber,
        tables: tablesSample, sections: sectionsSample
      })
    });
    const parsed = parseJsonObject(content);
    return Array.isArray(parsed.extracts) ? parsed.extracts : [];
  } catch {
    return [];
  }
}

async function persistFilingChunks(db, filing, sections) {
  try {
    await db.query(
      'DELETE FROM sec_filing_chunks WHERE ticker = $1 AND accession_number = $2',
      [filing.ticker, filing.accessionNumber]
    );
    for (const section of sections) {
      const text = section.text || '';
      for (let offset = 0; offset < text.length; offset += 1400) {
        const chunk = text.slice(offset, offset + 1500);
        if (chunk.trim().length > 30) {
          await db.query(
            'INSERT INTO sec_filing_chunks (ticker, accession_number, form, filing_date, section, chunk_text) VALUES ($1, $2, $3, $4, $5, $6)',
            [filing.ticker, filing.accessionNumber, filing.form, filing.filingDate, section.name, chunk]
          );
        }
      }
    }
  } catch {
  }
}

async function setExtractStatus(db, filing, status, reason, updatedAt) {
  await db.query(`
    INSERT INTO sec_filing_extract_status (ticker, accession_number, status, reason, updated_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (ticker, accession_number) DO UPDATE SET
      status = EXCLUDED.status, reason = EXCLUDED.reason, updated_at = EXCLUDED.updated_at
  `, [filing.ticker, filing.accessionNumber, status, reason, updatedAt]);
}

async function putExtract(db, filing, item, generatedAt) {
  await db.query(`
    INSERT INTO sec_filing_extracts
      (ticker, accession_number, form, filing_date, report_date, kind, label, period, value, unit, detail, quote, importance, generated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (ticker, accession_number, kind, label, period) DO UPDATE SET
      value = EXCLUDED.value, unit = EXCLUDED.unit, detail = EXCLUDED.detail,
      quote = EXCLUDED.quote, importance = EXCLUDED.importance, generated_at = EXCLUDED.generated_at
  `, [
    filing.ticker, filing.accessionNumber, filing.form, filing.filingDate, filing.reportDate,
    item.kind, item.label, item.period, item.value, item.unit, item.detail, item.quote, item.importance,
    generatedAt
  ]);
}

export async function ensureFilingExtracted(db, filing) {
  const { rows } = await db.query(
    'SELECT status FROM sec_filing_extract_status WHERE ticker = $1 AND accession_number = $2',
    [filing.ticker, filing.accessionNumber]
  );
  const existing = rows[0];
  if (existing?.status === 'done' || existing?.status === 'pending') return;

  await setExtractStatus(db, filing, 'pending', null, new Date().toISOString());

  try {
    const generatedAt = new Date().toISOString();

    if (isInsiderFiling(filing.form)) {
      const data = await extractForm4Data(filing);
      if (!data || data.items.length === 0) {
        await setExtractStatus(db, filing, 'skipped', 'no transactions', generatedAt);
        return;
      }
      for (const item of data.items) {
        await putExtract(db, filing, {
          kind: 'event',
          label: item.label,
          period: filing.filingDate,
          value: item.shares,
          unit: 'shares',
          detail: item.detail,
          quote: '',
          importance: 'high'
        }, generatedAt);
      }
      await setExtractStatus(db, filing, 'done', null, generatedAt);
      return;
    }

    const raw = await getFilingRaw(db, filing);
    const text = htmlToText(raw);
    const tables = extractHtmlTables(raw);
    const sections = splitFilingSections(text);

    let extraAttachments = [];
    if (filing.form === '8-K' || filing.form === '8-K/A') {
      extraAttachments = await getFilingIndexDocuments(filing);
    }

    let allTables = [...tables];
    for (const att of extraAttachments.slice(0, 3)) {
      try {
        const attResp = await secQueueFetch(att.url, 'text/html,*/*');
        const attHtml = await attResp.text();
        const attTables = extractHtmlTables(attHtml);
        allTables = [...allTables, ...attTables];
        const attText = htmlToText(attHtml);
        const attSections = splitFilingSections(attText);
        for (const sec of attSections) {
          const existing2 = sections.find((s) => s.name === sec.name);
          if (existing2) existing2.text += '\n' + sec.text;
          else sections.push(sec);
        }
      } catch {
      }
    }

    const aiExtracts = await extractFilingWithDeepSeek(filing, allTables, sections);
    await persistFilingChunks(db, filing, sections);

    let savedCount = 0;
    for (const item of aiExtracts) {
      if (!item.kind || !item.label) continue;
      await putExtract(db, filing, {
        kind: String(item.kind).slice(0, 30),
        label: String(item.label).slice(0, 200),
        period: String(item.period || '').slice(0, 30),
        value: Number.isFinite(Number(item.value)) ? Number(item.value) : null,
        unit: String(item.unit || '').slice(0, 50),
        detail: String(item.detail || '').slice(0, 500),
        quote: String(item.quote || '').slice(0, 300),
        importance: String(item.importance || 'medium').slice(0, 10)
      }, generatedAt);
      savedCount++;
    }

    const status = savedCount > 0 ? 'done' : 'skipped';
    const reason = savedCount > 0 ? null : 'no extracts returned';
    await setExtractStatus(db, filing, status, reason, generatedAt);
  } catch (err) {
    await setExtractStatus(db, filing, 'error', err.message.slice(0, 200), new Date().toISOString());
  }
}

const _prefetchInFlight = new Set();

export async function prefetchTickerFilings(db, ticker) {
  if (_prefetchInFlight.has(ticker)) return;
  _prefetchInFlight.add(ticker);
  try {
    const [businessFilings, allFilingsPayload] = await Promise.all([
      getSecFilings(db, ticker, 8),
      getSecFilings(db, ticker, 50)
    ]);
    const insiderFilings = allFilingsPayload.filings
      .filter((f) => isInsiderFiling(f.form))
      .slice(0, 20);

    const toExtract = [...businessFilings.filings.slice(0, 8), ...insiderFilings];
    for (const filing of toExtract) {
      await ensureFilingExtracted(db, filing);
    }
  } catch {
  } finally {
    _prefetchInFlight.delete(ticker);
  }
}
