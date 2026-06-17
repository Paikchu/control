import { Hono } from 'hono';
import { cleanTicker } from '../util.mjs';
import { getManagementReport } from '../services/managementService.mjs';

export function managementRoutes(db) {
  const app = new Hono();

  app.get('/api/management/:ticker', async (c) => {
    const ticker = cleanTicker(c.req.param('ticker'));
    const force = c.req.query('force') === '1';
    if (!ticker) return c.json({ error: 'Ticker is required' }, 400);
    try {
      return c.json(await getManagementReport(db, ticker, { force }));
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  return app;
}
