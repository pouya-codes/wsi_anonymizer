/**
 * Access accounts: one per password.
 *
 *  - "admin" is the original shared password (ANON_PASSWORD_HASH, set with
 *    `npm run set-password`). Admins can see the usage records.
 *  - Further accounts (e.g. one per department) live in accounts.json next to
 *    the env file and are managed with `npm run accounts` (server/manage-accounts.mjs).
 *
 * accounts.json: { "accounts": [ { id, name, role: "user" | "admin", hash, created } ] }
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseHash } from './auth.mjs';

export const CONFIG_DIR = path.join(homedir(), '.config', 'anonymizer');
export const ACCOUNTS_FILE =
  process.env.ANON_ACCOUNTS_FILE || path.join(CONFIG_DIR, 'accounts.json');
export const ADMIN_ID = 'admin';
export const ID_RE = /^[a-z0-9-]{1,32}$/;
export const ROLES = ['user', 'admin'];

/** Accounts as stored in accounts.json (without the env-file admin). */
export function readAccountsFile(file = ACCOUNTS_FILE) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const list = JSON.parse(raw).accounts;
  if (!Array.isArray(list)) throw new Error(`${file}: "accounts" must be a list`);
  return list;
}

/**
 * Every account that can sign in: the env-file admin first, then accounts.json.
 * Throws on anything malformed so the server never starts half-configured.
 */
export function loadAccounts({ adminHash, file = ACCOUNTS_FILE } = {}) {
  const out = [];
  if (adminHash) {
    const parsed = parseHash(adminHash);
    if (!parsed) throw new Error('ANON_PASSWORD_HASH is not a valid scrypt hash');
    out.push({ id: ADMIN_ID, name: 'Admin', role: 'admin', hash: adminHash, parsed });
  }
  for (const a of readAccountsFile(file)) {
    if (!ID_RE.test(a.id ?? '')) throw new Error(`${file}: invalid account id ${JSON.stringify(a.id)}`);
    if (a.id === ADMIN_ID) throw new Error(`${file}: "${ADMIN_ID}" is reserved for ANON_PASSWORD_HASH`);
    if (out.some((o) => o.id === a.id)) throw new Error(`${file}: duplicate account ${a.id}`);
    if (!ROLES.includes(a.role)) throw new Error(`${file}: account ${a.id} has unknown role ${a.role}`);
    const parsed = parseHash(a.hash);
    if (!parsed) throw new Error(`${file}: account ${a.id} has an invalid hash`);
    out.push({ id: a.id, name: String(a.name || a.id), role: a.role, hash: a.hash, parsed });
  }
  return out;
}

/** What the browser may see about an account. */
export function publicAccount(a) {
  return { id: a.id, name: a.name, role: a.role };
}
