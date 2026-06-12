import { Hono } from 'hono';
import { cleanAccession, cleanTicker, safeFilename } from '../util.mjs';
import { getSecCompany, getSecFilings } from '../services/secClient.mjs';
import { getSecAnalysisReport, getSecFilingSummary } from '../services/secReportService.mjs';
import { downloadFilingPdf } from '../services/pdfService.mjs';

export function secRoutes(db) {
  const app = new Hono();

  app.get('/api/sec/company/:ticker', async (c) => {
    const ticker = cleanTicker(c.req.param('ticker'));
    if (!ticker) return c.json({ error: 'Ticker is required' }, 400);
    try {
      return c.json(await getSecCompany(db, ticker));
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  app.get('/api/sec/filings/:ticker', async (c) => {
    const ticker = cleanTicker(c.req.param('ticker'));
    const limit = Number(c.req.query('limit') || 20);
    const force = c.req.query('force') === '1';
    if (!ticker) return c.json({ error: 'Ticker is required' }, 400);
    try {
      return c.json(await getSecFilings(db, ticker, limit, force));
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  app.get('/api/sec/report/:ticker', async (c) => {
    const ticker = cleanTicker(c.req.param('ticker'));
    const force = c.req.query('force') === '1';
    if (!ticker) return c.json({ error: 'Ticker is required' }, 400);
    try {
      return c.json(await getSecAnalysisReport(db, ticker, { force }));
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  app.get('/api/sec/filings/:ticker/:accession/summary', async (c) => {
    const ticker = cleanTicker(c.req.param('ticker'));
    const accession = cleanAccession(c.req.param('accession'));
    if (!ticker || !accession) return c.json({ error: 'Ticker and accession are required' }, 400);
    try {
      return c.json(await getSecFilingSummary(db, ticker, accession));
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  // 例如 /api/sec/filings/AAPL/0000320193-25-000071.pdf
  app.get('/api/sec/filings/:ticker/:accessionPdf{[0-9-]+\\.pdf}', async (c) => {
    const ticker = cleanTicker(c.req.param('ticker'));
    const accession = cleanAccession(c.req.param('accessionPdf').replace(/\.pdf$/, ''));
    if (!ticker || !accession) return c.json({ error: 'Ticker and accession are required' }, 400);
    try {
      const { filing, pdf } = await downloadFilingPdf(db, ticker, accession);
      const filename = safeFilename(`${ticker}-${filing.form}-${filing.filingDate}-${filing.accessionNumber}.pdf`);
      return c.body(pdf, 200, {
        'content-type': 'application/pdf',
        'content-length': String(pdf.length),
        'content-disposition': `attachment; filename="${filename}"`
      });
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  return app;
}
