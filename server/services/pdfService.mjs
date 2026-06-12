import PDFDocument from 'pdfkit';
import { cacheRead, cacheWrite, secDocumentTtlMs } from './cache.mjs';
import { cleanAccession, cleanTicker } from '../util.mjs';
import { getFilingText, getSecFilings } from './secClient.mjs';

function createPdfBuffer({ title, subtitle, sourceUrl, text }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48, bufferPages: true });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.info.Title = title;
    doc.font('Helvetica-Bold').fontSize(16).text(title, { lineGap: 4 });
    doc.moveDown(0.35);
    doc.font('Helvetica').fontSize(9).fillColor('#4b5563').text(subtitle);
    doc.text(sourceUrl, { link: sourceUrl, underline: true });
    doc.moveDown();
    doc.fillColor('#111827').font('Helvetica').fontSize(8.5);

    const body = text.length > 450000 ? `${text.slice(0, 450000)}\n\n[Truncated locally after 450,000 characters. Open the SEC source link for the full filing.]` : text;
    body.split('\n').forEach((line) => {
      doc.text(line || ' ', {
        width: 500,
        lineGap: 2,
        continued: false
      });
    });

    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i += 1) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(`Page ${i + 1} of ${pageCount}`, 48, 750, {
        width: 500,
        align: 'right'
      });
    }

    doc.end();
  });
}

export async function downloadFilingPdf(db, ticker, accessionNumber) {
  const clean = cleanTicker(ticker);
  const accession = cleanAccession(accessionNumber);
  const filings = await getSecFilings(db, clean, 50);
  const filing = filings.filings.find((item) => item.accessionNumber === accession);
  if (!filing) {
    throw new Error(`Filing ${accession} was not found for ${clean}`);
  }

  const cacheKey = `sec:pdf:${clean}:${accession}`;
  const cached = await cacheRead(db, cacheKey, secDocumentTtlMs);
  if (cached?.base64) {
    return { filing, pdf: Buffer.from(cached.base64, 'base64'), source: 'cache' };
  }

  const text = await getFilingText(db, filing);

  const title = `${clean} ${filing.form} ${filing.filingDate}`;
  const subtitle = `${filing.companyName} | Accession ${filing.accessionNumber}`;
  const pdf = await createPdfBuffer({ title, subtitle, sourceUrl: filing.documentUrl, text });
  await cacheWrite(db, cacheKey, { base64: pdf.toString('base64'), filing, sourceUrl: filing.documentUrl });
  return { filing, pdf, source: 'sec' };
}
