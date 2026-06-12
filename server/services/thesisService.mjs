import { parseJsonObject, simpleHash32 } from '../util.mjs';
import { deepseekChat, hasDeepSeekKey, secAnalysisModel } from './deepseek.mjs';

export function thesisHash(thesisItems, riskItems) {
  const str = JSON.stringify({ t: thesisItems.map((i) => i.text), r: riskItems.map((i) => i.text) });
  return simpleHash32(str);
}

export async function latestExtractAccession(db, ticker) {
  const { rows } = await db.query(
    `SELECT accession_number FROM sec_filing_extract_status WHERE ticker = $1 AND status = 'done' ORDER BY updated_at DESC LIMIT 1`,
    [ticker]
  );
  return rows[0]?.accession_number || 'none';
}

export async function readCachedThesisCheck(db, ticker, hash, latestAccession) {
  const { rows } = await db.query(
    'SELECT payload FROM holding_thesis_checks WHERE ticker = $1 AND thesis_hash = $2 AND latest_accession_number = $3',
    [ticker, hash, latestAccession]
  );
  return rows[0]?.payload ? JSON.parse(rows[0].payload) : null;
}

export async function persistThesisCheck(db, { ticker, hash, latestAccession, thesisItems, riskItems, result, generatedAt }) {
  await db.query(`
    INSERT INTO holding_thesis_checks (ticker, thesis_hash, latest_accession_number, thesis_text, payload, generated_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (ticker, thesis_hash, latest_accession_number) DO UPDATE SET
      thesis_text = EXCLUDED.thesis_text, payload = EXCLUDED.payload, generated_at = EXCLUDED.generated_at
  `, [
    ticker, hash, latestAccession,
    JSON.stringify({ thesisItems, riskItems }),
    JSON.stringify(result),
    generatedAt
  ]);
}

// Two-step agent pipeline: ① extract English search keywords from the Chinese
// thesis, ② retrieve filing chunks + structured extracts and have the model
// verify each thesis item against them.
export async function runThesisCheck(db, ticker, thesisItems, riskItems) {
  if (!hasDeepSeekKey()) throw new Error('DEEPSEEK_API_KEY is required for thesis checks');

  const { rows: extracts } = await db.query(
    'SELECT * FROM sec_filing_extracts WHERE ticker = $1 ORDER BY filing_date DESC, kind',
    [ticker]
  );

  let keywords = [];
  try {
    const kwContent = await deepseekChat({
      model: secAnalysisModel,
      system: '从用户的中文持仓逻辑中提取用于检索英文 SEC filing 的关键词和指标名。输出 JSON: {"keywords": ["英文词1","英文词2"]}',
      user: JSON.stringify({ thesisItems: thesisItems.map((i) => i.text) })
    });
    const parsed = parseJsonObject(kwContent);
    keywords = Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 8) : [];
  } catch {
  }

  let relevantChunks = [];
  if (keywords.length > 0) {
    try {
      const ftsQuery = keywords.map((k) => `"${k.replace(/"/g, '')}"`).join(' OR ');
      const { rows } = await db.query(`
        SELECT ticker, accession_number, section, chunk_text FROM sec_filing_chunks
        WHERE ticker = $1 AND to_tsvector('english', chunk_text) @@ websearch_to_tsquery('english', $2)
        LIMIT 12
      `, [ticker, ftsQuery]);
      relevantChunks = rows;
    } catch {
      const { rows } = await db.query(
        'SELECT ticker, accession_number, section, chunk_text FROM sec_filing_chunks WHERE ticker = $1 LIMIT 12',
        [ticker]
      );
      relevantChunks = rows;
    }
  }

  const content = await deepseekChat({
    model: secAnalysisModel,
    system: [
      '你是专业的投资逻辑验证助手。根据给定的 SEC filing 结构化数据和原文段落，对每条持仓逻辑进行自洽性和时效性验证。',
      '自洽性：把每条逻辑拆成前提 → 结论，判断 ① 前提是否属实（有 filing 证据），② 前提能否推出结论。',
      '时效性：用最新 filing 判断逻辑现在是否成立，是否有变化。',
      '输出信号，不给买卖建议。数字和结论必须有 quote 溯源，无证据判 no_evidence 不得编造。',
      '输出 JSON: {"items":[{"thesisId":"","verdict":"supported|weakened|broken|no_evidence","consistency":"consistent|self_contradictory|premise_false","confidence":0.0,"premises":[{"claim":"","holds":true,"note":"","evidenceRef":0}],"analysis":"中文","changes":"中文","retrieval":{"keywords":[],"hitFilings":[]},"evidence":[{"accessionNumber":"","period":"","metric":"","quote":""}]}],"crossItemConflicts":[{"between":[],"detail":""}],"coverage":{"filingsUsed":0,"filingsExpected":8}}'
    ].join('\n'),
    user: JSON.stringify({
      ticker,
      thesisItems,
      riskItems,
      extracts: extracts.slice(0, 120),
      relevantChunks: relevantChunks.map((c) => ({ accessionNumber: c.accession_number, section: c.section, text: c.chunk_text.slice(0, 800) })),
      keywords
    })
  });

  const result = parseJsonObject(content);
  result.coverage = result.coverage || { filingsUsed: extracts.length, filingsExpected: 8 };
  return result;
}
