import { Hono } from 'hono';
import { getMarketOverview, getPrices, getSparkline } from '../services/yahoo.mjs';
import { cleanTicker } from '../util.mjs';

export function marketRoutes(db) {
  const app = new Hono();

  app.get('/api/market/overview', async (c) => {
    try {
      return c.json(await getMarketOverview(db));
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  app.get('/api/prices/:ticker', async (c) => {
    const ticker = cleanTicker(c.req.param('ticker'));
    if (!ticker) return c.json({ error: 'Ticker is required' }, 400);
    try {
      return c.json(await getPrices(db, ticker));
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  app.get('/api/chart/:symbol/sparkline', async (c) => {
    const symbol = cleanTicker(c.req.param('symbol'));
    if (!symbol) return c.json({ error: 'Symbol required' }, 400);
    try {
      return c.json(await getSparkline(symbol));
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  return app;
}
