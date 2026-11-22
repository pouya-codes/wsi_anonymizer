/**
 * Password helpers: scrypt password hashes and signed session cookies.
 *
 * Hash format (colon separated so it is safe in systemd EnvironmentFiles):
 *   scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>
 *
 * Session cookies: see sessionSigner().
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  );
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scryptAsync(password, salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

export function parseHash(encoded) {
  const parts = String(encoded ?? '').trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, N, r, p, salt, hash] = parts;
  const out = {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64url'),
    hash: Buffer.from(hash, 'base64url'),
  };
  if (![out.N, out.r, out.p].every(Number.isInteger) || !out.salt.length || !out.hash.length) {
    return null;
  }
  return out;
}

export async function verifyPassword(password, parsed) {
  const key = await scryptAsync(String(password ?? ''), parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
  });
  return timingSafeEqual(key, parsed.hash);
}

/**
 * Session cookies for several accounts (one per access password).
 * Value: `<account id>.<expiry ms>.<HMAC>`. Each account's HMAC key is derived
 * from the session secret AND that account's password hash, so changing one
 * password signs out only the people who used it.
 */
export function sessionSigner(secret, accounts) {
  const keys = new Map(
    accounts.map((a) => [
      a.id,
      createHmac('sha256', secret).update(`session-key:${a.id}:${a.hash}`).digest(),
    ])
  );
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const sign = (id, expiry) =>
    createHmac('sha256', keys.get(id)).update(`v2.${id}.${expiry}`).digest('base64url');
  return {
    issue(id, ttlMs) {
      const expiry = Date.now() + ttlMs;
      return `${id}.${expiry}.${sign(id, expiry)}`;
    },
    /** The signed-in account, or null. */
    account(value) {
      const m = /^([a-z0-9-]{1,32})\.(\d{13,16})\.([A-Za-z0-9_-]{43})$/.exec(String(value ?? ''));
      if (!m || !keys.has(m[1])) return null;
      const expiry = Number(m[2]);
      if (!(expiry > Date.now())) return null;
      const expected = Buffer.from(sign(m[1], expiry));
      const given = Buffer.from(m[3]);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      return byId.get(m[1]);
    },
  };
}

export function randomSecret() {
  return randomBytes(32).toString('base64url');
}
