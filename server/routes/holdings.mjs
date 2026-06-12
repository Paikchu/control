import { Hono } from 'hono';
import { cleanTicker } from '../util.mjs';
import { prefetchTickerFilings } from '../services/extractService.mjs';
import {
  latestExtractAccession,
  persistThesisCheck,
  readCachedThesisCheck,
  runThesisCheck,
  thesisHash
} from '../services/thesisService.mjs';

export function holdingsRoutes(db) {
  const app = new Hono();

  app.post('/api/holdings/:ticker/prefetch', (c) => {
    const ticker = cleanTicker(c.req.param('ticker'));
    if (!ticker) return c.json({ error: 'Ticker is required' }, 400);
    prefetchTickerFilings(db, ticker).catch(() => {});
    return c.json({ ticker, status: 'queued' }, 202);
  });

  app.post('/api/holdings/:ticker/thesis-check', async (c) => {
    const ticker = cleanTicker(c.req.param('ticker'));
    if (!ticker) return c.json({ error: 'Ticker is required' }, 400);
    try {
      const body = await c.req.json().catch(() => ({}));
      const thesisItems = Array.isArray(body.thesisItems) ? body.thesisItems.filter((i) => i?.text?.trim()) : [];
      const riskItems = Array.isArray(body.riskItems) ? body.riskItems.filter((i) => i?.text?.trim()) : [];
      const force = Boolean(body.force);
      if (thesisItems.length === 0) return c.json({ error: 'thesisItems is required' }, 400);

      const hash = thesisHash(thesisItems, riskItems);
      const latestAccession = await latestExtractAccession(db, ticker);

      if (!force) {
        const cached = await readCachedThesisCheck(db, ticker, hash, latestAccession);
        if (cached) return c.json({ ...cached, cached: true });
      }

      prefetchTickerFilings(db, ticker).catch(() => {});
      const result = await runThesisCheck(db, ticker, thesisItems, riskItems);
      const generatedAt = new Date().toISOString();
      await persistThesisCheck(db, { ticker, hash, latestAccession, thesisItems, riskItems, result, generatedAt });
      return c.json({ ...result, generatedAt, cached: false });
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  return app;
}
