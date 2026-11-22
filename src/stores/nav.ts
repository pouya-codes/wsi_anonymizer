import { nextTick, ref } from 'vue';

export type AppView = 'anonymize' | 'labels' | 'guide' | 'usage';

/** Which view is shown (all stay mounted so their state survives switching). */
export const currentView = ref<AppView>('anonymize');

export type GuideSection =
  | 'overview'
  | 'before'
  | 'step1'
  | 'output'
  | 'step2'
  | 'resume'
  | 'share'
  | 'faq';

const GUIDE_SEEN_KEY = 'anonymizer.guideSeen';

function readSeen(): boolean {
  try {
    return localStorage.getItem(GUIDE_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether this browser has opened (or dismissed) the guide before. */
export const guideSeen = ref(readSeen());

export function markGuideSeen(): void {
  guideSeen.value = true;
  try {
    localStorage.setItem(GUIDE_SEEN_KEY, '1');
  } catch {
    /* private window / storage blocked — the prompt just shows again next time */
  }
}

/** Show the guide, scrolled to one section. */
export async function openGuide(section: GuideSection = 'overview'): Promise<void> {
  markGuideSeen();
  currentView.value = 'guide';
  await nextTick();
  const el = document.getElementById(`guide-${section}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else window.scrollTo({ top: 0 });
}
