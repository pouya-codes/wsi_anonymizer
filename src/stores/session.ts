/**
 * Who is signed in (which access password), and usage reporting.
 *
 * The server keeps one record per anonymized slide — size and format only, no
 * names — filed under the password used to sign in. Admins can read them.
 */
import { computed, ref } from 'vue';

export interface Account {
  id: string;
  name: string;
  role: 'user' | 'admin';
}

export const account = ref<Account | null>(null);
export const isAdmin = computed(() => account.value?.role === 'admin');

export async function loadSession(): Promise<void> {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) account.value = (await res.json()).account;
  } catch {
    /* dev server without the API — no account shown */
  }
}

/** Count one anonymized slide. Never blocks or fails the anonymization. */
export function reportSlide(report: { bytes: number; format: string; files: number }): void {
  try {
    void fetch('/api/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* ignore */
  }
}
