import { Hono } from 'hono';
import { readIbkrSnapshot } from '../../src/ibkrSync.mjs';
import { getIbkrAccounts, getIbkrStatus, syncIbkrAccount } from '../services/ibkrClient.mjs';

export function ibkrRoutes(db) {
  const app = new Hono();

  app.get('/api/ibkr/status', async (c) => {
    return c.json({
      status: await getIbkrStatus(),
      snapshot: await readIbkrSnapshot(db, c.req.query('accountId') || null)
    });
  });

  app.get('/api/ibkr/accounts', async (c) => {
    try {
      return c.json({ accounts: await getIbkrAccounts() });
    } catch (error) {
      return c.json({ error: error.message }, 502);
    }
  });

  app.get('/api/ibkr/snapshot', async (c) => {
    return c.json(await readIbkrSnapshot(db, c.req.query('accountId') || null));
  });

  app.post('/api/ibkr/sync', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const accountId = String(body.accountId || '').trim();
      const result = await syncIbkrAccount(db, accountId);
      return c.json({
        ...await readIbkrSnapshot(db, result.account.accountId),
        status: await getIbkrStatus()
      });
    } catch (error) {
      return c.json({
        error: error.message,
        snapshot: await readIbkrSnapshot(db)
      }, 502);
    }
  });

  return app;
}
