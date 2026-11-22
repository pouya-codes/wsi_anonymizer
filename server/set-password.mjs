#!/usr/bin/env node
/**
 * Set (or change) the shared access password.
 *
 *   npm run set-password                      # prompts twice, hidden input
 *   echo -n 'secret' | npm run set-password   # non-interactive
 *
 * Writes ANON_PASSWORD_HASH (+ ANON_SESSION_SECRET on first run) to the env
 * file read by the systemd unit (default ~/.config/anonymizer/anonymizer.env,
 * override with ANON_ENV_FILE). Changing the password signs everyone out.
 * Restart the service afterwards: sudo systemctl restart anonymizer
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { hashPassword, randomSecret } from './auth.mjs';

const ENV_FILE =
  process.env.ANON_ENV_FILE || path.join(homedir(), '.config', 'anonymizer', 'anonymizer.env');
const MIN_LENGTH = 10;

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          return reject(new Error('cancelled'));
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main() {
  let password;
  if (process.stdin.isTTY) {
    password = await promptHidden('New access password: ');
    const again = await promptHidden('Repeat password: ');
    if (password !== again) throw new Error('Passwords do not match');
  } else {
    password = await readStdin();
  }
  if (password.length < MIN_LENGTH) throw new Error(`Use at least ${MIN_LENGTH} characters`);

  const existing = await readFile(ENV_FILE, 'utf8').catch(() => '');
  const lines = existing.split('\n').filter((l) => l && !l.startsWith('ANON_PASSWORD_HASH='));
  if (!lines.some((l) => l.startsWith('ANON_SESSION_SECRET='))) {
    lines.push(`ANON_SESSION_SECRET=${randomSecret()}`);
  }
  lines.push(`ANON_PASSWORD_HASH=${await hashPassword(password)}`);

  await mkdir(path.dirname(ENV_FILE), { recursive: true, mode: 0o700 });
  await writeFile(ENV_FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
  await chmod(ENV_FILE, 0o600);
  console.log(`Saved to ${ENV_FILE}. Restart to apply: sudo systemctl restart anonymizer`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
