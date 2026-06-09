import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

const apiPort = Number(process.env.PORT || 8787);
const webPort = Number(process.env.VITE_PORT || 5173);
const host = '127.0.0.1';
const children = new Set();

function log(message) {
  process.stdout.write(`${message}\n`);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function run(label, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  });

  children.add(child);
  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (signal) return;
    stopAll(code ?? 0);
  });

  return child;
}

function stopAll(code = 0) {
  for (const child of children) {
    child.kill('SIGTERM');
  }
  process.exitCode = code;
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

if (!existsSync('node_modules')) {
  log('Missing node_modules. Run npm install first.');
  process.exit(1);
}

const [apiFree, webFree] = await Promise.all([
  isPortFree(apiPort),
  isPortFree(webPort)
]);

if (!apiFree) {
  log(`API port is busy: http://${host}:${apiPort}`);
  process.exit(1);
}

if (!webFree) {
  log(`Web port is busy: http://${host}:${webPort}`);
  process.exit(1);
}

log(`API: http://${host}:${apiPort}`);
log(`Web: http://${host}:${webPort}`);
log('Press Ctrl+C to stop both processes.');

run('api', process.execPath, ['server.mjs'], { PORT: String(apiPort) });
run('web', 'npx', ['vite', '--host', host, '--port', String(webPort), '--strictPort']);
