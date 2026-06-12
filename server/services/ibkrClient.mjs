import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  normalizeIbkrAccount,
  normalizeIbkrBalance,
  normalizeIbkrPosition,
  storeIbkrSync
} from '../../src/ibkrSync.mjs';

const ibkrBaseUrl = process.env.IBKR_BASE_URL || 'https://127.0.0.1:5001/v1/api';

function ensureLocalIbkrBase() {
  const base = new URL(ibkrBaseUrl);
  // host.docker.internal lets the Docker container reach a gateway on the host.
  if (!['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(base.hostname)) {
    throw new Error('IBKR_BASE_URL must point to localhost');
  }
  return base;
}

function ibkrErrorMessage(statusCode, payload) {
  const message = payload?.error || payload?.message;
  if (message) return message;
  if (statusCode === 401) return '请重新登录 IBKR Portal';
  if (statusCode === 403) return 'IBKR API 会话被拒绝，请确认 Gateway 登录状态和账户权限';
  return `IBKR HTTP ${statusCode}`;
}

function ibkrRequest(pathname, { method = 'GET', body = null } = {}) {
  const base = ensureLocalIbkrBase();
  const basePath = base.pathname.replace(/\/$/, '');
  const cleanPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${basePath}${cleanPath}`, base);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = transport({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      rejectUnauthorized: ['localhost', '127.0.0.1', 'host.docker.internal'].includes(url.hostname) ? false : undefined,
      headers: {
        accept: 'application/json',
        'user-agent': 'PortfolioBacktest/0.1',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      },
      timeout: 1800
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        const text = data.trim();
        let parsed = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { raw: text };
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(ibkrErrorMessage(response.statusCode, parsed));
          error.statusCode = response.statusCode;
          error.payload = parsed;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('IBKR Gateway timeout'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 应用（可能在容器内）通过 host.docker.internal 访问 Gateway，但用户的浏览器
// 打不开这个域名——登录链接必须用浏览器可达的主机名。IBKR_LOGIN_URL 可显式覆盖。
function browserLoginUrl(base) {
  if (process.env.IBKR_LOGIN_URL) return process.env.IBKR_LOGIN_URL;
  const url = new URL(base);
  url.pathname = '';
  url.search = '';
  if (url.hostname === 'host.docker.internal') url.hostname = 'localhost';
  return url.toString();
}

export async function getIbkrStatus() {
  const loginUrl = new URL(browserLoginUrl(ensureLocalIbkrBase()));
  loginUrl.pathname = '';
  loginUrl.search = '';
  try {
    const payload = await ibkrRequest('/iserver/auth/status', { method: 'POST', body: {} });
    if (payload?.connected && !payload?.authenticated) {
      try {
        const initPayload = await ibkrRequest('/iserver/auth/ssodh/init', {
          method: 'POST',
          body: { publish: true, compete: true }
        });
        return {
          gateway: 'running',
          authenticated: Boolean(initPayload?.authenticated),
          connected: Boolean(initPayload?.connected || payload?.connected),
          competing: Boolean(initPayload?.competing),
          loginUrl: loginUrl.toString(),
          message: initPayload?.message || payload?.message || ''
        };
      } catch {
        return {
          gateway: 'running',
          authenticated: false,
          connected: true,
          competing: Boolean(payload?.competing),
          loginUrl: loginUrl.toString(),
          message: payload?.message || 'IBKR brokerage session needs reinitialization'
        };
      }
    }
    return {
      gateway: 'running',
      authenticated: Boolean(payload?.authenticated),
      connected: Boolean(payload?.connected),
      competing: Boolean(payload?.competing),
      loginUrl: loginUrl.toString(),
      message: payload?.message || ''
    };
  } catch (error) {
    if ([401, 403].includes(error.statusCode)) {
      return {
        gateway: 'running',
        authenticated: false,
        connected: false,
        loginUrl: loginUrl.toString(),
        message: error.statusCode === 403 ? 'IBKR login failed or API access denied' : 'IBKR login required'
      };
    }
    return {
      gateway: 'offline',
      authenticated: false,
      loginUrl: loginUrl.toString(),
      message: describeOfflineError(error)
    };
  }
}

// 把底层连接错误翻译成可操作的中文提示，并带上当前连接目标，
// 方便区分「Gateway 没启动」「Docker 连不到宿主机」「网络超时」等情况。
function describeOfflineError(error) {
  const target = ibkrBaseUrl;
  const inDocker = /host\.docker\.internal/.test(target);
  const code = error?.code || (/ECONNREFUSED/.test(error?.message || '') ? 'ECONNREFUSED' : '');

  if (code === 'ECONNREFUSED') {
    return inDocker
      ? `连不上 IBKR Gateway（${target}）。请确认：① Gateway 已在宿主机 5001 端口运行；② 应用在 Docker 中，需通过 host.docker.internal 访问宿主机。若只在本地用 IBKR，建议改用 npm start 原生启动。`
      : `连不上 IBKR Gateway（${target}）。请先在本机启动 Client Portal Gateway（bin/run.sh root/conf.yaml）并完成登录。`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `无法解析 IBKR Gateway 主机名（${target}）。Docker 内请确认 docker-compose 已配置 host.docker.internal:host-gateway。`;
  }
  if (/timeout/i.test(error?.message || '')) {
    return `连接 IBKR Gateway 超时（${target}）。Gateway 可能在运行但拒绝了来源 IP，请检查 conf.yaml 的 ips.allow 是否包含来访地址。`;
  }
  return `IBKR Gateway 不可用（${target}）：${error?.message || '未知错误'}`;
}

export async function getIbkrAccounts() {
  const payload = await ibkrRequest('/portfolio/accounts');
  const rawAccounts = Array.isArray(payload) ? payload : payload?.accounts || [];
  return rawAccounts.map(normalizeIbkrAccount).filter(Boolean);
}

function ibkrRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.positions)) return payload.positions;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function shouldFallbackIbkrPositions(error) {
  return [400, 404, 405].includes(error.statusCode);
}

async function getIbkrPositions(accountId) {
  try {
    const payload = await ibkrRequest(`/portfolio2/${encodeURIComponent(accountId)}/positions?direction=d&sort=mktValue`);
    return ibkrRows(payload).map(normalizeIbkrPosition).filter(Boolean);
  } catch (error) {
    if (!shouldFallbackIbkrPositions(error)) throw error;
  }

  try {
    await ibkrRequest(`/portfolio/${encodeURIComponent(accountId)}/positions/invalidate`, { method: 'POST', body: {} });
  } catch (error) {
    if (!shouldFallbackIbkrPositions(error)) throw error;
  }

  const positions = [];
  for (let page = 0; page < 20; page += 1) {
    const payload = await ibkrRequest(`/portfolio/${encodeURIComponent(accountId)}/positions/${page}`);
    const rows = ibkrRows(payload);
    const normalized = rows.map(normalizeIbkrPosition).filter(Boolean);
    positions.push(...normalized);
    if (rows.length < 100) break;
  }
  return positions;
}

async function getIbkrBalances(accountId) {
  try {
    const payload = await ibkrRequest(`/portfolio/${encodeURIComponent(accountId)}/ledger`);
    const rows = Array.isArray(payload)
      ? payload
      : Object.entries(payload || {}).map(([currency, value]) => ({ currency, ...value }));
    return rows.map(normalizeIbkrBalance).filter(Boolean);
  } catch {
    return [];
  }
}

export async function syncIbkrAccount(db, accountId = '') {
  const accounts = await getIbkrAccounts();
  const account = accounts.find((item) => item.accountId === accountId) || accounts[0];
  if (!account) throw new Error('No IBKR account available');
  const positions = await getIbkrPositions(account.accountId);
  const balances = await getIbkrBalances(account.accountId);
  return storeIbkrSync(db, {
    account,
    positions,
    balances,
    syncedAt: new Date().toISOString()
  });
}
