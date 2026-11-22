#!/usr/bin/env node
/**
 * Manage access passwords (accounts) other than the admin password.
 *
 *   npm run accounts                                   # list
 *   npm run accounts -- add mapcore --name "Mapcore"   # new user account, prints a generated password
 *   npm run accounts -- add ops --name "Ops" --role admin
 *   npm run accounts -- reset mapcore                  # new generated password (signs that account out)
 *   npm run accounts -- rename mapcore "MAPcore"
 *   npm run accounts -- remove mapcore
 *
 * Pipe a password in to choose it yourself:  echo -n 'secret…' | npm run accounts -- add x
 * The admin password stays in the env file (npm run set-password).
 * Restart afterwards: sudo systemctl restart anonymizer
 */
import { randomInt } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashPassword } from './auth.mjs';
import { ACCOUNTS_FILE, ADMIN_ID, ID_RE, ROLES, readAccountsFile } from './accounts.mjs';

const MIN_LENGTH = 10;

/** Same shape as the original shared password: cpath-xxxxx-xxxxx-xxxxx. */
function generatePassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const group = () => Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `cpath-${group()}-${group()}-${group()}`;
}

async function passwordFromStdinOrGenerate() {
  if (process.stdin.isTTY) return { password: generatePassword(), generated: true };
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!password) return { password: generatePassword(), generated: true };
  if (password.length < MIN_LENGTH) throw new Error(`Use at least ${MIN_LENGTH} characters`);
  return { password, generated: false };
}

async function save(list) {
  await mkdir(path.dirname(ACCOUNTS_FILE), { recursive: true, mode: 0o700 });
  await writeFile(ACCOUNTS_FILE, `${JSON.stringify({ accounts: list }, null, 2)}\n`, { mode: 0o600 });
  await chmod(ACCOUNTS_FILE, 0o600);
}

function option(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const RESTART = 'Restart to apply: sudo systemctl restart anonymizer';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift() ?? 'list';
  const list = readAccountsFile();
  const find = (id) => {
    if (id === ADMIN_ID) throw new Error('The admin password is managed with `npm run set-password`.');
    const a = list.find((x) => x.id === id);
    if (!a) throw new Error(`No account "${id}". Accounts: ${list.map((x) => x.id).join(', ') || 'none'}`);
    return a;
  };

  if (cmd === 'list') {
    console.log(`${ADMIN_ID.padEnd(16)} admin  Admin  (ANON_PASSWORD_HASH in the env file)`);
    for (const a of list) console.log(`${a.id.padEnd(16)} ${a.role.padEnd(6)} ${a.name}  (added ${a.created ?? '?'})`);
    console.log(`\n${ACCOUNTS_FILE}`);
    return;
  }
  if (cmd === 'add') {
    const role = option(args, 'role') ?? 'user';
    const name = option(args, 'name');
    const [id] = args;
    if (!ID_RE.test(id ?? '')) throw new Error('Account id: lowercase letters, digits and dashes (e.g. mapcore)');
    if (id === ADMIN_ID || list.some((a) => a.id === id)) throw new Error(`Account "${id}" already exists`);
    if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);
    const { password, generated } = await passwordFromStdinOrGenerate();
    list.push({ id, name: name || id, role, hash: await hashPassword(password), created: new Date().toISOString().slice(0, 10) });
    await save(list);
    console.log(`Added ${id} (${role}).${generated ? `\nPassword: ${password}\n(Shown once — it is stored only as a hash.)` : ''}\n${RESTART}`);
    return;
  }
  if (cmd === 'reset') {
    const a = find(args[0]);
    const { password, generated } = await passwordFromStdinOrGenerate();
    a.hash = await hashPassword(password);
    await save(list);
    console.log(`New password for ${a.id}.${generated ? `\nPassword: ${password}` : ''}\n${RESTART}`);
    return;
  }
  if (cmd === 'rename') {
    const a = find(args[0]);
    if (!args[1]) throw new Error('Usage: rename <id> "<display name>"');
    a.name = args[1];
    await save(list);
    console.log(`Renamed ${a.id} to "${a.name}". ${RESTART}`);
    return;
  }
  if (cmd === 'remove') {
    const a = find(args[0]);
    await save(list.filter((x) => x !== a));
    console.log(`Removed ${a.id}; its usage records are kept. ${RESTART}`);
    return;
  }
  throw new Error(`Unknown command "${cmd}". Use list, add, reset, rename or remove.`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
