import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getDb, initSchema } from './server/db.mjs';
import { createApp } from './server/app.mjs';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

const db = await getDb();
await initSchema(db);

const app = createApp(db);

// In the Docker image the same process serves the built frontend from dist/.
if (process.env.SERVE_STATIC === '1') {
  // 缓存策略：带 content-hash 的 /assets/* 可永久缓存；index.html 必须每次校验，
  // 否则发布新版后浏览器会继续用缓存的旧 index.html（引用旧 bundle）= 看到旧界面。
  app.use('*', async (c, next) => {
    await next();
    const path = c.req.path;
    if (path.startsWith('/assets/')) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (path === '/' || path.endsWith('.html')) {
      c.header('Cache-Control', 'no-cache');
    }
  });
  app.use('*', serveStatic({ root: './dist' }));
  app.use('*', serveStatic({ root: './dist', path: 'index.html' }));
}

serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`market data API listening on http://${host}:${port}`);
});
