import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { marketRoutes } from './routes/market.mjs';
import { ibkrRoutes } from './routes/ibkr.mjs';
import { strategyRoutes } from './routes/strategy.mjs';
import { secRoutes } from './routes/sec.mjs';
import { holdingsRoutes } from './routes/holdings.mjs';
import { optionsRoutes } from './routes/options.mjs';

export function createApp(db) {
  const app = new Hono();

  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['content-type'] }));

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.route('/', marketRoutes(db));
  app.route('/', ibkrRoutes(db));
  app.route('/', strategyRoutes());
  app.route('/', secRoutes(db));
  app.route('/', holdingsRoutes(db));
  app.route('/', optionsRoutes(db));

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  return app;
}
