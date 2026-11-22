/**
 * Usage log: one JSON line per anonymized slide.
 *
 *   {"t":"2026-11-12T16:40:00.000Z","account":"mapcore","bytes":179369515,"format":"svs","files":1}
 *
 * Only counts are kept — never file names, paths, label text or slide content.
 * The account is taken from the session cookie, not from the request body.
 * File: $ANON_DATA_DIR/usage.jsonl (default ~/.local/share/anonymizer).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const DATA_DIR =
  process.env.ANON_DATA_DIR || path.join(homedir(), '.local', 'share', 'anonymizer');
const LOG = path.join(DATA_DIR, 'usage.jsonl');

const MAX_BYTES = 1e13; // 10 TB: anything larger is not a real slide
const FORMAT_RE = /^[a-z0-9]{1,12}$/;

/** Validate a report from the browser; returns the fields to log or throws. */
export function parseReport(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('invalid JSON');
  }
  const bytes = Number(data?.bytes);
  const files = Number(data?.files ?? 1);
  const format = String(data?.format ?? '').toLowerCase().replace(/^\./, '');
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BYTES) throw new Error('invalid bytes');
  if (!Number.isSafeInteger(files) || files < 1 || files > 100000) throw new Error('invalid files');
  if (!FORMAT_RE.test(format)) throw new Error('invalid format');
  return { bytes, format, files };
}

export async function recordSlide(accountId, report) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ t: new Date().toISOString(), account: accountId, ...report });
  await appendFile(LOG, `${line}\n`, { mode: 0o600 });
}

/** Every logged slide as [time ms, account, bytes, format]; bad lines are skipped. */
export async function readEvents() {
  const text = await readFile(LOG, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const t = Date.parse(e.t);
      if (Number.isFinite(t) && typeof e.account === 'string') {
        out.push([t, e.account, Number(e.bytes) || 0, String(e.format || '')]);
      }
    } catch {
      /* a torn last line after a crash — ignore */
    }
  }
  return out;
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export async function eventsCsv(names) {
  const rows = [['time_utc', 'account', 'account_name', 'bytes', 'format']];
  for (const [t, account, bytes, format] of await readEvents()) {
    rows.push([new Date(t).toISOString(), account, names.get(account) ?? '(removed)', bytes, format]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
