/**
 * Static server for the Slide Anonymizer, behind access passwords.
 *
 * The anonymizer itself runs entirely in the visitor's browser; this server only
 * hands out the built app (dist/) to people who know a password. It never
 * receives slide data, and the Content-Security-Policy below forbids the page
 * from sending data anywhere but back to this origin. The only thing the app
 * reports back is a count: one usage record (size + format, no names) per
 * anonymized slide, filed under the password that signed in (see usage.mjs).
 *
 * No npm dependencies — plain node:http. Configuration via environment:
 *   ANON_PASSWORD_HASH   required, admin password, from `npm run set-password`
 *   ANON_SESSION_SECRET  required, from `npm run set-password`
 *   ANON_ACCOUNTS_FILE   further passwords (default ~/.config/anonymizer/accounts.json,
 *                        managed with `npm run accounts`)
 *   ANON_DATA_DIR        where usage.jsonl is written (default ~/.local/share/anonymizer)
 *   ANON_SESSION_HOURS   session lifetime (default 12)
 *   HOST / PORT          bind address (default 127.0.0.1:8790)
 *   DIST_DIR             built app (default ../dist)
 *   ANON_INSECURE_COOKIE set to 1 for plain-http local testing only
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionSigner, verifyPassword } from './auth.mjs';
import { loadAccounts, publicAccount } from './accounts.mjs';
import { loginPage } from './loginPage.mjs';
import { DATA_DIR, eventsCsv, parseReport, readEvents, recordSlide } from './usage.mjs';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8790);
const DIST = path.resolve(
  process.env.DIST_DIR || fileURLToPath(new URL('../dist', import.meta.url))
);
const SESSION_MS = Number(process.env.ANON_SESSION_HOURS || 12) * 3600 * 1000;
const SECURE = process.env.ANON_INSECURE_COOKIE !== '1';
const COOKIE = SECURE ? '__Host-anon_session' : 'anon_session';

const secret = process.env.ANON_SESSION_SECRET || '';
let accounts;
try {
  accounts = loadAccounts({ adminHash: process.env.ANON_PASSWORD_HASH });
} catch (err) {
  console.error(`Accounts: ${err.message}`);
  process.exit(1);
}
if (!accounts.some((a) => a.id === 'admin') || secret.length < 32) {
  console.error(
    'ANON_PASSWORD_HASH / ANON_SESSION_SECRET missing or invalid. Run `npm run set-password`.'
  );
  process.exit(1);
}
const sessions = sessionSigner(secret, accounts);

/** Files that must load before login (login page branding). */
const PUBLIC_PATHS = new Set(['/favicon.svg', '/brand/logo-wordmark.svg']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  // OCR model; fetched and gunzipped by Tesseract itself (no Content-Encoding).
  '.gz': 'application/octet-stream',
};

const SECURITY_HEADERS = {
  // The page may only talk to this origin: slide bytes cannot be exfiltrated.
  // 'wasm-unsafe-eval' is required to instantiate the WSI-anon WebAssembly.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Robots-Tag': 'noindex, nofollow',
};

/* ------------------------------ Rate limiting ----------------------------- */

const WINDOW_MS = 15 * 60 * 1000;
const PER_CLIENT_FAILS = 10;
// Per directly-connected peer (a Cloudflare edge, or someone hitting the origin
// directly with a forged CF-Connecting-IP). Higher, since edges are shared.
const PER_PEER_FAILS = 60;
const failures = new Map();

function bucket(key) {
  const now = Date.now();
  let b = failures.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    failures.set(key, b);
  }
  return b;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of failures) if (b.resetAt <= now) failures.delete(k);
}, 60_000).unref();

/** Apache appends the peer it saw as the right-most X-Forwarded-For entry. */
function clientKeys(req) {
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const peer = xff[xff.length - 1] || req.socket.remoteAddress || 'unknown';
  const client = String(req.headers['cf-connecting-ip'] || '').trim() || peer;
  return { client: `c:${client}|${peer}`, peer: `p:${peer}`, label: client };
}

function lockedOut(keys) {
  return (
    bucket(keys.client).count >= PER_CLIENT_FAILS || bucket(keys.peer).count >= PER_PEER_FAILS
  );
}

/* --------------------------------- Helpers -------------------------------- */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** The account whose password this browser signed in with, or null. */
function currentAccount(req) {
  return sessions.account(parseCookies(req.headers.cookie)[COOKIE]);
}

function sessionCookie(value, maxAgeSec) {
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    SECURE ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function send(res, status, body, headers = {}) {
  // no-transform: stop Cloudflare from rewriting pages (e.g. injecting its
  // analytics beacon, which the CSP would block anyway).
  const cache = headers['Cache-Control'] || 'no-store';
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    'Cache-Control': `${cache}, no-transform`,
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  send(res, 303, '', { Location: location, 'Cache-Control': 'no-store', ...headers });
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ Static files ------------------------------ */

async function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
  }
  if (rel.includes('\0')) return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
  let file = path.resolve(DIST, `.${path.posix.normalize(`/${rel}`)}`);
  if (file !== DIST && !file.startsWith(DIST + path.sep)) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = path.join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info) {
    // Single-page app: unknown extension-less paths get the shell.
    if (path.extname(rel)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    file = path.join(DIST, 'index.html');
  }

  const body = await readFile(file).catch(() => null);
  if (!body) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  // Content-hashed bundles, and OCR files under a versioned folder: never change.
  const hashed = ['assets', 'ocr'].some((d) => file.startsWith(path.join(DIST, d) + path.sep));
  send(res, 200, req.method === 'HEAD' ? '' : body, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    // `private`: Cloudflare must never cache password-protected files.
    'Cache-Control': hashed ? 'private, max-age=31536000, immutable' : 'private, no-cache',
  });
}

/* --------------------------------- Routes --------------------------------- */

async function handleLogin(req, res) {
  const keys = clientKeys(req);
  if (lockedOut(keys)) {
    console.warn(`login locked out for ${keys.label}`);
    return send(res, 429, loginPage({ error: 'Too many attempts. Try again in 15 minutes.' }), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
  let password = '';
  try {
    password = new URLSearchParams(await readBody(req)).get('password') || '';
  } catch {
    return send(res, 413, 'Request too large', { 'Content-Type': 'text/plain' });
  }

  let account = null;
  if (password) {
    for (const a of accounts) {
      if (await verifyPassword(password, a.parsed)) {
        account = a;
        break;
      }
    }
  }
  if (account) {
    failures.delete(keys.client);
    console.log(`login ok for ${keys.label} as ${account.id}`);
    return redirect(res, '/', {
      'Set-Cookie': sessionCookie(sessions.issue(account.id, SESSION_MS), Math.floor(SESSION_MS / 1000)),
    });
  }

  bucket(keys.client).count += 1;
  bucket(keys.peer).count += 1;
  console.warn(`login failed for ${keys.label}`);
  await sleep(600);
  return send(res, 401, loginPage({ error: 'Incorrect password.' }), {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

/* ----------------------------------- API ---------------------------------- */

const json = (res, status, data) =>
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

/** Usage reports per account per minute — a whole folder of slides is fine. */
const REPORTS_PER_MINUTE = 300;
const reportCounts = new Map();
setInterval(() => reportCounts.clear(), 60_000).unref();

async function handleApi(req, res, p, account) {
  if (p === '/api/session' && req.method === 'GET') {
    return json(res, 200, { account: publicAccount(account) });
  }
  if (p === '/api/usage' && req.method === 'POST') {
    const n = (reportCounts.get(account.id) ?? 0) + 1;
    reportCounts.set(account.id, n);
    if (n > REPORTS_PER_MINUTE) return json(res, 429, { error: 'too many reports' });
    let report;
    try {
      report = parseReport(await readBody(req, 1024));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    await recordSlide(account.id, report);
    return json(res, 201, { ok: true });
  }
  if ((p === '/api/usage' || p === '/api/usage.csv') && req.method === 'GET') {
    if (account.role !== 'admin') return json(res, 403, { error: 'admin only' });
    if (p === '/api/usage.csv') {
      const names = new Map(accounts.map((a) => [a.id, a.name]));
      return send(res, 200, await eventsCsv(names), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="anonymizer-usage.csv"',
        'Cache-Control': 'no-store',
      });
    }
    return json(res, 200, { accounts: accounts.map(publicAccount), events: await readEvents() });
  }
  return json(res, 404, { error: 'not found' });
}

async function route(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz') {
    return send(res, 200, 'ok', { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  }
  if (p === '/login') {
    if (req.method === 'POST') return handleLogin(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { Allow: 'GET, POST' });
    if (currentAccount(req)) return redirect(res, '/');
    return send(res, 200, loginPage({}), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
  if (p === '/logout') {
    return redirect(res, '/login', { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (p.startsWith('/api/')) {
    const account = currentAccount(req);
    if (!account) return json(res, 401, { error: 'sign in required' });
    return handleApi(req, res, p, account);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, '', { Allow: 'GET, HEAD' });
  }
  if (PUBLIC_PATHS.has(p)) return serveStatic(req, res, p);
  if (!currentAccount(req)) {
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    return wantsHtml
      ? redirect(res, '/login')
      : send(res, 401, 'Sign in required', { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  }
  return serveStatic(req, res, p);
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Server error', { 'Content-Type': 'text/plain' });
    else res.end();
  });
});
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.listen(PORT, HOST, () => {
  console.log(`Slide Anonymizer serving ${DIST} on http://${HOST}:${PORT}`);
  console.log(`Accounts: ${accounts.map((a) => `${a.id} (${a.role})`).join(', ')}; usage log in ${DATA_DIR}`);
});
