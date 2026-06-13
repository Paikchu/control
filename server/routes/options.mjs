import { Hono } from 'hono';
import { fetchAllOptionMetrics, dumpOptionFields } from '../services/optionsService.mjs';
import { forecastFromMetrics, optionsForecastModel } from '../services/optionsForecast.mjs';
import {
  storeOptionSnapshot,
  readLatestSnapshots,
  readLatestForecast,
  readForecast,
  storeForecast,
  usEasternDate
} from '../services/optionsStore.mjs';

export function optionsRoutes(db) {
  const app = new Hono();

  // header 用：永远读 DB 里最新的快照 + 研判（即使陈旧）。
  app.get('/api/options/overview', async (c) => {
    const snapshots = await readLatestSnapshots(db);
    const forecast = await readLatestForecast(db);
    return c.json({ snapshots, forecast });
  });

  // 抓取 → 存快照 → 调 DeepSeek（按交易日去重，已存在则不重复调用）。
  app.post('/api/options/refresh', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const force = Boolean(body.force);
    try {
      const results = await fetchAllOptionMetrics();
      const okMetrics = results.filter((r) => r.metrics);
      for (const { metrics } of okMetrics) {
        await storeOptionSnapshot(db, metrics);
      }

      const snapshotDate = usEasternDate(new Date());
      let forecastResult = await readForecast(db, snapshotDate, optionsForecastModel);

      // 当天还没研判、或强制刷新，且至少有一个标的成功时，调用 DeepSeek。
      if ((!forecastResult || force) && okMetrics.length) {
        const fc = await forecastFromMetrics(okMetrics.map((r) => ({ symbol: r.symbol, metrics: r.metrics })));
        if (fc.available) {
          await storeForecast(db, {
            snapshotDate,
            model: fc.model,
            bias: fc.forecast.bias,
            confidence: fc.forecast.confidence,
            payload: fc.forecast
          });
          forecastResult = await readForecast(db, snapshotDate, fc.model);
        }
      }

      return c.json({
        snapshots: await readLatestSnapshots(db),
        forecast: forecastResult || (await readLatestForecast(db)),
        errors: results.filter((r) => r.error).map((r) => ({ symbol: r.symbol, error: r.error }))
      });
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  // 调试：核对 IBKR snapshot 字段码。GET /api/options/debug-fields?symbol=SPY
  app.get('/api/options/debug-fields', async (c) => {
    try {
      return c.json(await dumpOptionFields(c.req.query('symbol') || 'SPY'));
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  return app;
}
