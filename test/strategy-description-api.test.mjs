import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function startApi() {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: String(port), DEEPSEEK_API_KEY: '' },
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

async function postStrategy(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/parse-strategy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  return payload;
}

test('整理用户输入为自然语言策略展示文本', async () => {
  const api = startApi();
  await api.ready;
  test.after(() => api.stop());

  const payload = await postStrategy(api.port, {
    description: 'qqq回撤25买一点tqqq，跌35再加，回到高点附近就退'
  });

  assert.equal(typeof payload.strategy.name, 'string');
  assert.equal(typeof payload.strategy.displayText, 'string');
  assert.match(payload.strategy.displayText, /QQQ/);
  assert.match(payload.strategy.displayText, /TQQQ/);
  assert.match(payload.strategy.displayText, /25%/);
  assert.match(payload.strategy.displayText, /35%/);
  assert.ok(!Array.isArray(payload.strategy.conditions), 'display payload should not expose manual condition rows');
});

test('基于用户追加意见继续修改已有策略文本', async () => {
  const api = startApi();
  await api.ready;
  test.after(() => api.stop());

  const payload = await postStrategy(api.port, {
    description: '不要用杠杆，改成只在回撤时买QQQ',
    existingStrategy: '当 QQQ 回撤 25% 时，将 TQQQ 仓位提高到 10%；回撤 35% 时提高到 20%。'
  });

  assert.match(payload.strategy.displayText, /不使用杠杆|不用杠杆|避免杠杆/);
  assert.match(payload.strategy.displayText, /QQQ/);
  assert.doesNotMatch(payload.strategy.displayText, /TQQQ 仓位提高/);
});
