import { Hono } from 'hono';
import { describeStrategyFallback, describeStrategyWithDeepSeek } from '../services/strategyService.mjs';

export function strategyRoutes() {
  const app = new Hono();

  app.post('/api/parse-strategy', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const description = String(body.description || '').trim();
      if (!description) {
        return c.json({ error: 'Description is required' }, 400);
      }
      const existingStrategy = String(body.existingStrategy || '').trim();
      try {
        return c.json({ strategy: await describeStrategyWithDeepSeek(description, existingStrategy), source: 'deepseek' });
      } catch (error) {
        return c.json({ strategy: describeStrategyFallback(description, existingStrategy), source: 'fallback', warning: error.message });
      }
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  return app;
}
