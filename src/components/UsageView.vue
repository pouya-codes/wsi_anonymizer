<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import { currentView } from '@/stores/nav';
import type { Account } from '@/stores/session';
import { formatBytes } from '@/utils/format';

/** [time ms, account id, bytes, format] — one per anonymized slide. */
type UsageEvent = [number, string, number, string];
type Period = '7d' | '30d' | 'year' | 'all';

const accounts = ref<Account[]>([]);
const events = ref<UsageEvent[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const loadedAt = ref<Date | null>(null);
const period = ref<Period>('30d');

const periods: { value: Period; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'year', label: 'This year' },
  { value: 'all', label: 'All time' },
];

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/usage', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 403 ? 'Only the admin password can see usage.' : `Server error ${res.status}`);
    const data = await res.json();
    accounts.value = data.accounts;
    events.value = data.events;
    loadedAt.value = new Date();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

// Load when the tab is first opened, and fresh each time it is opened again.
watch(currentView, (v) => v === 'usage' && void load(), { immediate: true });

const since = computed(() => {
  const now = new Date();
  switch (period.value) {
    case '7d':
      return now.getTime() - 7 * 86400e3;
    case '30d':
      return now.getTime() - 30 * 86400e3;
    case 'year':
      return new Date(now.getFullYear(), 0, 1).getTime();
    default:
      return 0;
  }
});
const inPeriod = computed(() => events.value.filter((e) => e[0] >= since.value));

/** Configured accounts, plus any removed ones that still have records. */
const allAccounts = computed<(Account & { removed?: boolean })[]>(() => {
  const known = new Set(accounts.value.map((a) => a.id));
  const removed = [...new Set(events.value.map((e) => e[1]))]
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: id, role: 'user' as const, removed: true }));
  return [...accounts.value, ...removed];
});

const byAccount = computed(() =>
  allAccounts.value
    .map((a) => {
      const mine = inPeriod.value.filter((e) => e[1] === a.id);
      const ever = events.value.filter((e) => e[1] === a.id);
      return {
        ...a,
        slides: mine.length,
        bytes: mine.reduce((s, e) => s + e[2], 0),
        days: new Set(mine.map((e) => dayKey(e[0]))).size,
        last: ever.length ? Math.max(...ever.map((e) => e[0])) : null,
      };
    })
    .sort((x, y) => y.slides - x.slides || x.name.localeCompare(y.name))
);

const totals = computed(() => ({
  slides: inPeriod.value.length,
  bytes: inPeriod.value.reduce((s, e) => s + e[2], 0),
  active: new Set(inPeriod.value.map((e) => e[1])).size,
  last: events.value.length ? Math.max(...events.value.map((e) => e[0])) : null,
}));

const byFormat = computed(() => {
  const m = new Map<string, number>();
  for (const e of inPeriod.value) m.set(e[3] || '?', (m.get(e[3] || '?') ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
});

/** Breakdown by day for short periods, by month otherwise (local time). */
const byDay = computed(() => period.value === '7d' || period.value === '30d');
function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthKey(t: number): string {
  return dayKey(t).slice(0, 7);
}
const columns = computed(() => byAccount.value.filter((a) => a.slides > 0));
const breakdown = computed(() => {
  const key = byDay.value ? dayKey : monthKey;
  const rows = new Map<string, Map<string, number>>();
  for (const e of inPeriod.value) {
    const k = key(e[0]);
    if (!rows.has(k)) rows.set(k, new Map());
    const r = rows.get(k)!;
    r.set(e[1], (r.get(e[1]) ?? 0) + 1);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([k, r]) => ({ k, counts: r, total: [...r.values()].reduce((s, n) => s + n, 0) }));
});
const peak = computed(() => Math.max(1, ...breakdown.value.map((r) => r.total)));

function periodLabel(k: string): string {
  const [y, m, d] = k.split('-').map(Number);
  return d
    ? new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function when(t: number | null): string {
  if (t == null) return 'Never';
  const d = new Date(t);
  const today = dayKey(Date.now()) === dayKey(t);
  return today
    ? `Today ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
</script>

<template>
  <div>
    <div class="view-header">
      <div>
        <h1>Usage</h1>
        <p>
          Slides anonymized under each access password. Only counts are recorded — one
          entry per saved slide with its size and format. No file names, label text or
          slide content ever reach the server. Visible to admin passwords only.
        </p>
      </div>
      <div class="button-row">
        <Button
          label="Refresh"
          icon="pi pi-refresh"
          text
          size="small"
          :loading="loading"
          @click="load"
        />
        <a
          class="p-button p-button-outlined p-button-sm usage-csv"
          href="/api/usage.csv"
          download
        ><i class="pi pi-download" /> Download log (CSV)</a>
      </div>
    </div>

    <div
      v-if="error"
      class="banner banner--error"
    >
      {{ error }}
    </div>

    <div class="usage-filter">
      <div class="filter-group">
        <button
          v-for="p in periods"
          :key="p.value"
          type="button"
          class="filter-btn"
          :class="{ active: period === p.value }"
          @click="period = p.value"
        >
          {{ p.label }}
        </button>
      </div>
      <span
        v-if="loadedAt"
        class="hint"
      >Updated {{ loadedAt.toLocaleTimeString() }}</span>
    </div>

    <div class="tiles">
      <div class="tile">
        <span class="tile__label">Slides anonymized</span>
        <span class="tile__value">{{ totals.slides.toLocaleString() }}</span>
      </div>
      <div class="tile">
        <span class="tile__label">Data processed</span>
        <span class="tile__value">{{ formatBytes(totals.bytes) }}</span>
      </div>
      <div class="tile">
        <span class="tile__label">Passwords used</span>
        <span class="tile__value">{{ totals.active }} <small>of {{ accounts.length }}</small></span>
      </div>
      <div class="tile">
        <span class="tile__label">Last activity</span>
        <span class="tile__value tile__value--sm">{{ when(totals.last) }}</span>
      </div>
    </div>

    <div class="card">
      <h2 class="card__title">By password</h2>
      <table class="usage-table">
        <thead>
          <tr>
            <th>Password</th>
            <th>Access</th>
            <th class="num">Slides</th>
            <th class="num">Data</th>
            <th class="num">Active days</th>
            <th>Last used</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="a in byAccount"
            :key="a.id"
          >
            <td>
              <strong>{{ a.name }}</strong>
              <code class="acct-id">{{ a.id }}</code>
              <span
                v-if="a.removed"
                class="hint"
              > (password removed)</span>
            </td>
            <td>
              <span
                class="badge"
                :class="a.role === 'admin' ? 'badge--importing' : 'badge--queued'"
              >{{ a.role === 'admin' ? 'Admin' : 'User' }}</span>
            </td>
            <td class="num">{{ a.slides.toLocaleString() }}</td>
            <td class="num">{{ a.slides ? formatBytes(a.bytes) : '—' }}</td>
            <td class="num">{{ a.days || '—' }}</td>
            <td>{{ when(a.last) }}</td>
          </tr>
        </tbody>
      </table>
      <p
        v-if="byFormat.length"
        class="hint"
        style="margin: 12px 0 0"
      >
        Formats:
        <template
          v-for="([fmt, n], i) in byFormat"
          :key="fmt"
        >{{ i ? ' · ' : '' }}{{ fmt.toUpperCase() }} {{ n }}</template>
      </p>
    </div>

    <div class="card">
      <h2 class="card__title">{{ byDay ? 'By day' : 'By month' }}</h2>
      <div
        v-if="!breakdown.length"
        class="empty-state"
      >
        No slides anonymized in this period.
      </div>
      <div
        v-else
        class="map-table-wrap"
      >
        <table class="usage-table">
          <thead>
            <tr>
              <th>{{ byDay ? 'Day' : 'Month' }}</th>
              <th
                v-for="c in columns"
                :key="c.id"
                class="num"
              >
                {{ c.name }}
              </th>
              <th class="num">Total</th>
              <th style="width: 30%" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in breakdown"
              :key="r.k"
            >
              <td>{{ periodLabel(r.k) }}</td>
              <td
                v-for="c in columns"
                :key="c.id"
                class="num"
              >
                {{ r.counts.get(c.id) ?? '—' }}
              </td>
              <td class="num"><strong>{{ r.total }}</strong></td>
              <td>
                <div class="bar">
                  <div
                    class="bar__fill"
                    :style="{ width: `${(r.total / peak) * 100}%` }"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p class="hint">
      Passwords are added, reset or removed on the server with
      <code>npm run accounts</code>; the admin password with <code>npm run set-password</code>.
    </p>
  </div>
</template>

<style scoped>
.usage-csv {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
}

.usage-filter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.filter-group {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.filter-btn {
  background: transparent;
  color: var(--text-dim);
  border: 0;
  padding: 7px 12px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.filter-btn + .filter-btn {
  border-left: 1px solid var(--border);
}

.filter-btn.active {
  background: var(--bg-elev-2);
  color: var(--text);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.tile__label {
  color: var(--text-dim);
  font-size: 12px;
}

.tile__value {
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.tile__value small {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-dim);
}

.tile__value--sm {
  font-size: 18px;
  padding-top: 6px;
}

.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.usage-table th,
.usage-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}

.usage-table th {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
}

.usage-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.acct-id {
  margin-left: 8px;
  color: var(--text-dim);
  font-size: 12px;
}

.bar {
  height: 8px;
  background: var(--bg-elev-2);
  border-radius: 4px;
  overflow: hidden;
}

.bar__fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
}

@media (max-width: 760px) {
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
