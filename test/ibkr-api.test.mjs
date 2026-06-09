import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

function startMockGateway() {
  const port = randomPort();
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    hits.push(`${req.method} ${url.pathname}`);

    if (url.pathname === '/v1/api/portfolio/accounts') {
      json(res, 200, [{ id: 'DU-P2', accountTitle: 'Paper Portfolio' }]);
      return;
    }

    if (url.pathname === '/v1/api/portfolio2/DU-P2/positions') {
      json(res, 200, [{
        conid: '9408',
        description: 'MCD',
        secType: 'STK',
        currency: 'USD',
        position: 12,
        marketPrice: 258.83,
        marketValue: 3105.96,
        avgPrice: 266.21,
        unrealizedPnl: 88.55
      }]);
      return;
    }

    if (url.pathname === '/v1/api/portfolio/DU-P2/ledger') {
      json(res, 200, {
        USD: {
          currency: 'USD',
          cashbalance: 100,
          netliquidationvalue: 3205.96,
          stockmarketvalue: 3105.96
        }
      });
      return;
    }

    if (url.pathname === '/v1/api/iserver/auth/status') {
      json(res, 200, { connected: true, authenticated: false, message: '' });
      return;
    }

    if (url.pathname === '/v1/api/iserver/auth/ssodh/init') {
      json(res, 200, { connected: true, authenticated: true, message: '' });
      return;
    }

    json(res, 404, { error: `unexpected ${req.method} ${url.pathname}` });
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port,
    hits,
    ready,
    stop: () => server.close()
  };
}

function startUnauthorizedGateway() {
  const port = randomPort();
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/v1/api/portfolio/accounts') {
      json(res, 401, {});
      return;
    }
    if (url.pathname === '/v1/api/iserver/auth/status') {
      json(res, 200, { connected: false, authenticated: false, message: '' });
      return;
    }
    json(res, 404, {});
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port,
    ready,
    stop: () => server.close()
  };
}

function startApi(ibkrPort) {
  const port = randomPort();
  const dataDir = mkdtempSync(join(tmpdir(), 'portfolio-backtest-api-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      IBKR_BASE_URL: `http://127.0.0.1:${ibkrPort}/v1/api`,
      DATA_DIR: dataDir,
      DEEPSEEK_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('API did not start')), 5000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('market data API listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (text.includes('EADDRINUSE')) {
        clearTimeout(timer);
        reject(new Error(text));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`API exited with ${code}`));
    });
  });

  return {
    port,
    ready,
    stop: () => child.kill()
  };
}

test('syncs portfolio2 positions from the Client Portal Gateway', async () => {
  const gateway = startMockGateway();
  await gateway.ready;
  const api = startApi(gateway.port);
  await api.ready;
  test.after(() => {
    api.stop();
    gateway.stop();
  });

  const response = await fetch(`http://127.0.0.1:${api.port}/api/ibkr/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  const payload = await response.json();

  assert.equal(response.status, 200, payload.error);
  assert.equal(payload.account.accountId, 'DU-P2');
  assert.equal(payload.positions.length, 1);
  assert.equal(payload.positions[0].symbol, 'MCD');
  assert.equal(payload.balances[0].netLiquidation, 3205.96);
  assert.ok(gateway.hits.includes('GET /v1/api/portfolio2/DU-P2/positions'));
});

test('maps Gateway 401 to a login action', async () => {
  const gateway = startUnauthorizedGateway();
  await gateway.ready;
  const api = startApi(gateway.port);
  await api.ready;
  test.after(() => {
    api.stop();
    gateway.stop();
  });

  const response = await fetch(`http://127.0.0.1:${api.port}/api/ibkr/accounts`);
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.match(payload.error, /重新登录 IBKR Portal/);
});
