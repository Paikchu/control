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
  app.use('*', serveStatic({ root: './dist' }));
  app.use('*', serveStatic({ root: './dist', path: 'index.html' }));
}

serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`market data API listening on http://${host}:${port}`);
});
