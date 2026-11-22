<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import Button from 'primevue/button';
import ConfirmDialog from 'primevue/confirmdialog';
import Toast from 'primevue/toast';
import { useConfirm } from 'primevue/useconfirm';
import AnonymizeView from '@/components/AnonymizeView.vue';
import LabelsView from '@/components/LabelsView.vue';
import GuideView from '@/components/GuideView.vue';
import UsageView from '@/components/UsageView.vue';
import { useLabelsStore } from '@/stores/labels';
import { useLocalAnonStore } from '@/stores/localAnon';
import { currentView, guideSeen, markGuideSeen, openGuide, type AppView } from '@/stores/nav';
import { account, isAdmin, loadSession } from '@/stores/session';
import logoUrl from '@/assets/logo-wordmark.svg';

const anon = useLocalAnonStore();
const labels = useLabelsStore();
const confirm = useConfirm();

const tabs: { id: AppView; step: number; label: string; icon: string }[] = [
  { id: 'anonymize', step: 1, label: 'Anonymize slides', icon: 'pi pi-shield' },
  { id: 'labels', step: 2, label: 'Read labels', icon: 'pi pi-tag' },
];

const busy = () => anon.running || labels.ocrRunning || labels.dirty;

// New slides written into the folder the label list shows → list them too.
watch(
  () => anon.running,
  (running, was) => {
    if (was && !running) void labels.refreshIfShowing(anon.outputDir);
  }
);

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  if (!busy()) return;
  event.preventDefault();
  event.returnValue = '';
}

onMounted(() => {
  window.addEventListener('beforeunload', warnBeforeUnload);
  void loadSession();
});
onBeforeUnmount(() => window.removeEventListener('beforeunload', warnBeforeUnload));

/** Logout is a server route that clears the session cookie (see server/server.mjs). */
function signOut(): void {
  const go = () => window.location.assign('/logout');
  if (!busy()) return go();
  confirm.require({
    header: 'Sign out?',
    message: anon.running
      ? 'Slides are still being anonymized; this will stop when you sign out.'
      : labels.dirty
        ? 'Some label text is not saved yet and will be lost.'
        : 'Labels are still being read; this will stop when you sign out.',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Stay',
    acceptLabel: 'Sign out',
    acceptClass: 'p-button-danger',
    accept: go,
  });
}
</script>

<template>
  <header class="topbar">
    <div class="topbar__brand">
      <img
        :src="logoUrl"
        alt="cPathPortal"
        class="topbar__logo"
      />
      <span class="topbar__title">Slide Anonymizer</span>
    </div>
    <span
      v-tooltip.bottom="'Slides, labels and file names are read and written by your browser only. The site records just a count of slides anonymized per access password.'"
      class="privacy-pill"
    >
      <i class="pi pi-lock" /> Runs on your computer — nothing is uploaded
    </span>
    <div class="topbar__right">
      <span
        v-if="account"
        v-tooltip.bottom="'The access password you signed in with'"
        class="account-pill"
      >
        <i class="pi pi-user" /> {{ account.name }}
      </span>
      <Button
        label="Sign out"
        icon="pi pi-sign-out"
        text
        severity="secondary"
        size="small"
        @click="signOut"
      />
    </div>
  </header>

  <main class="workspace">
    <nav
      class="steps"
      aria-label="Steps"
    >
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        class="steps__tab"
        :class="{ active: currentView === t.id }"
        :aria-current="currentView === t.id ? 'page' : undefined"
        @click="currentView = t.id"
      >
        <span class="steps__num">{{ t.step }}</span>
        <i :class="t.icon" />
        {{ t.label }}
        <i
          v-if="t.id === 'anonymize' && anon.running"
          class="pi pi-spin pi-spinner"
        />
        <i
          v-if="t.id === 'labels' && labels.ocrRunning"
          class="pi pi-spin pi-spinner"
        />
        <span
          v-if="t.id === 'labels' && labels.dirty"
          class="steps__dot"
          title="Unsaved changes"
        />
      </button>
      <button
        v-if="isAdmin"
        type="button"
        class="steps__tab steps__tab--push"
        :class="{ active: currentView === 'usage' }"
        :aria-current="currentView === 'usage' ? 'page' : undefined"
        @click="currentView = 'usage'"
      >
        <i class="pi pi-chart-bar" />
        Usage
      </button>
      <button
        type="button"
        class="steps__tab steps__tab--guide"
        :class="{ active: currentView === 'guide', 'steps__tab--push': !isAdmin }"
        :aria-current="currentView === 'guide' ? 'page' : undefined"
        @click="openGuide()"
      >
        <i class="pi pi-book" />
        Guide
      </button>
    </nav>

    <div
      v-if="!guideSeen && currentView !== 'guide'"
      class="banner banner--info guide-prompt"
    >
      <i class="pi pi-compass" />
      <span>
        <strong>First time here?</strong> The guide walks through both steps, what is
        saved in your folder and what to remove before sharing.
      </span>
      <Button
        label="Open the guide"
        size="small"
        @click="openGuide()"
      />
      <Button
        v-tooltip.bottom="'Dismiss'"
        icon="pi pi-times"
        text
        rounded
        size="small"
        severity="secondary"
        aria-label="Dismiss"
        @click="markGuideSeen"
      />
    </div>

    <AnonymizeView v-show="currentView === 'anonymize'" />
    <LabelsView v-show="currentView === 'labels'" />
    <GuideView v-show="currentView === 'guide'" />
    <UsageView
      v-if="isAdmin"
      v-show="currentView === 'usage'"
    />
  </main>

  <footer class="app-footer">
    Label reading by <a
      href="https://github.com/naptha/tesseract.js"
      target="_blank"
      rel="noopener noreferrer"
    >Tesseract.js</a> OCR, also in your browser.
    Label, macro and metadata removal by
    <a
      href="https://gitlab.com/empaia/integration/wsi-anon"
      target="_blank"
      rel="noopener noreferrer"
    >EMPAIA WSI-anon</a>
    (WebAssembly, in your browser). Removing labels and metadata does not remove
    the tissue itself; review slides before sharing.
  </footer>

  <Toast position="bottom-right" />
  <ConfirmDialog />
</template>
