<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { useOnboarding, type InstallFailure, type OnboardDep } from '../composables/useOnboarding'
import { missingProviders, orderInstalls, providerFor } from '../lib/installPlan'
import { usePermissions, PERMISSION_KEYS } from '../composables/usePermissions'
import OnboardingStepCard from './OnboardingStepCard.vue'
import OnboardingPreview from './OnboardingPreview.vue'
import InstallTerminal from './InstallTerminal.vue'
import { useSettings } from '../composables/useSettings'
import { AVAILABLE_UI_LOCALES, isBetaUiLocale } from '@navide/plugin-ui/foundation'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const emit = defineEmits<{ (e: 'complete'): void; (e: 'close'): void }>()

const { t } = useI18n()
const settings = useSettings()
function selectLanguage(event: Event): void {
  settings.setLanguage((event.target as HTMLSelectElement).value)
}

const ob = useOnboarding(props.backend)
const perms = usePermissions()

onMounted(() => {
  void ob.refresh()
  void perms.refresh()
})

// The wizard can be closed mid-install; its timers and a running command must
// not outlive it.
onBeforeUnmount(() => ob.dispose())

/** Install button label — carries the elapsed seconds of the running install. */
function installLabel(dep: OnboardDep): string {
  if (ob.installing.value !== dep.id) return t('onboard.install')
  const secs = ob.installElapsedSec.value
  return secs > 0 ? `${t('onboard.installing')} (${secs}s)` : t('onboard.installing')
}

// Re-detect during an install would race the refresh the install itself runs,
// and the loser's response overwrites the winner's status.
const detectBusy = computed(() => ob.loading.value || !!ob.installing.value || ob.runBusy.value)
/** A command is running in the install terminal: every other action waits. */
const busy = computed(() => !!ob.installing.value || ob.runBusy.value)

// ── Blockers ──────────────────────────────────────────────────────────────────
// The backend already reports each dep's prerequisites and their current state.
// The wizard used to drop that entirely, so `brew install python3` on a Mac
// without Homebrew failed in well under a second and said so only in the log
// pane — below the fold, and gone with the modal. That is what "I click Python
// and nothing happens" was.

/** Unmet prerequisites of `dep` that this app can install itself. */
function blockers(dep: OnboardDep): OnboardDep[] {
  return missingProviders(dep, ob.deps.value)
}

/** Prerequisite binaries with no dep behind them (curl) — the user installs
 *  these; naming them is still better than a button that just fails. */
function manualBlockers(dep: OnboardDep): string[] {
  return (dep.requirements ?? [])
    .filter((r) => !r.ok && !providerFor(r.name, ob.deps.value))
    .map((r) => r.name)
}

/**
 * The failure to show on `dep`'s card: its own, or a prerequisite's. Homebrew
 * and Node have no card of their own in the wizard, so a link of the chain
 * that failed has to be reported on the card whose Install ran it.
 */
function failureFor(dep: OnboardDep): { dep: OnboardDep; failure: InstallFailure } | null {
  const own = ob.installErrors.value[dep.id]
  if (own) return { dep, failure: own }
  for (const link of orderInstalls([dep], ob.deps.value)) {
    const failure = ob.installErrors.value[link.id]
    if (failure) return { dep: link, failure }
  }
  return null
}

/** What the card must say before the user clicks, or after a click failed. */
function cardError(card: OnboardDep): string {
  const failed = failureFor(card)
  const dep = failed?.dep ?? card
  const failure = failed?.failure
  if (failure?.ranButUndetected) {
    // "Not detected" would be wrong when something WAS found and it is just too
    // old: `brew install python3` succeeds while /usr/bin/python3 (3.9) still
    // wins the PATH, and the card has to name that, not claim an empty result.
    // Python gets the two concrete repairs; they would mislead on any other dep.
    const outdatedKey =
      dep.id === 'python' ? 'onboard.installed-still-outdated-python' : 'onboard.installed-still-outdated'
    return dep.status === 'outdated'
      ? t(outdatedKey, { label: dep.label, version: dep.version })
      : t('onboard.installed-not-detected', { label: dep.label })
  }
  if (failure) {
    // Always leave a way forward: the exact command can be run by hand in a
    // terminal, which is the only escape when the in-app install keeps failing.
    const head = t('onboard.install-failed', { reason: failure.message })
    return failure.command ? `${head}\n\n${t('onboard.run-by-hand', { cmd: failure.command })}` : head
  }
  // No click yet: name the blocker up front rather than after a dead-looking
  // button press. A prerequisite this app can install joins the chain the
  // Install button runs, so it is announced rather than reported as a block;
  // one it cannot (Node on Linux has no install command) still blocks.
  const providers = blockers(card)
  const manual = [...providers.filter((p) => !p.can_install).map((p) => p.label), ...manualBlockers(card)]
  const names = providers.map((p) => p.label)
  if (manual.length) return t('onboard.blocked-by', { names: [...new Set([...names, ...manual])].join('、') })
  return names.length ? t('onboard.installs-first', { names: names.join('、') }) : ''
}

/** Jump the accordion to the prerequisite's own card so it can be installed. */
function goToBlocker(dep: OnboardDep): void {
  const first = blockers(dep)[0]
  if (first) picked.value = first.id
}

// An install's output lands in one burst; without this the pane stays pinned
// to the first line and the actual error scrolls out of sight.
const logEl = ref<HTMLElement | null>(null)
watch(
  () => ob.logLines.value.length,
  async () => {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  },
)

// ── Steps ─────────────────────────────────────────────────────────────────────
// No environment step: the packaged app never runs Homebrew, Node, pnpm,
// Python or uv itself, and a CLI that needs one installs it as a prerequisite
// (installMissing below). CLI management still detects and installs them.
type StepId = 'agents' | 'permissions' | 'ready'

// The permission step only exists where the OS has permissions to grant.
const steps = computed<StepId[]>(() =>
  perms.supported.value
    ? ['agents', 'permissions', 'ready']
    : ['agents', 'ready'],
)
const stepIndex = ref(0)
const current = computed<StepId>(() => steps.value[Math.min(stepIndex.value, steps.value.length - 1)])
const isLast = computed(() => stepIndex.value >= steps.value.length - 1)
const progress = computed(() => (stepIndex.value / Math.max(1, steps.value.length - 1)) * 100)

function stepDone(id: StepId): boolean {
  // Analyzer lives in Settings now (see compute_gate) — a CLI completes this step.
  if (id === 'agents') return ob.hasAnyCli.value
  if (id === 'permissions') return perms.allGranted.value
  return ob.allRequiredReady.value
}

// ── Accordion ─────────────────────────────────────────────────────────────────
interface Card {
  key: string
  done: boolean
}

const cards = computed<Card[]>(() => {
  if (current.value === 'agents') {
    return ob.cliDeps.value.map((d) => ({ key: d.id, done: d.status === 'ok' }))
  }
  if (current.value === 'permissions') {
    return PERMISSION_KEYS.map((k) => ({ key: k, done: perms.isSettled(k) }))
  }
  return []
})

const picked = ref('')
watch(current, () => {
  picked.value = ''
  infoKey.value = ''
})

// Without an explicit pick, the first unfinished card is the open one. With
// every card finished none opens: falling back to the last card left it
// expanded with its install actions, reading as "this one is still missing".
const activeKey = computed(() => {
  if (picked.value && cards.value.some((c) => c.key === picked.value)) return picked.value
  return cards.value.find((c) => !c.done)?.key ?? ''
})

const infoKey = ref('')
function toggleInfo(key: string): void {
  infoKey.value = infoKey.value === key ? '' : key
}

// Clearing the pick hands the accordion back to "first unfinished card", which
// reads as a collapse. Needed now that finished cards expand too.
function togglePick(key: string): void {
  picked.value = picked.value === key ? '' : key
}

// ── Permissions ───────────────────────────────────────────────────────────────
// Full Disk Access cannot be requested in-app; the user flips it in System
// Settings, so poll while the step is on screen to pick the change up.
watch(
  current,
  (id) => (id === 'permissions' ? perms.startPolling() : perms.stopPolling()),
  { immediate: true },
)

const PERM_PANES: Record<TccPermissionKey, string> = {
  automation: 'Privacy & Security › Automation',
  notifications: 'Notifications',
  folders: 'Privacy & Security › Files and Folders',
  fullDisk: 'Privacy & Security › Full Disk Access',
}
// Full Disk Access has no in-app request path — only System Settings.
const SETTINGS_ONLY: TccPermissionKey[] = ['fullDisk']

function requestPermission(key: TccPermissionKey): void {
  const payload =
    key === 'notifications'
      ? { title: t('onboard.notif-test-title'), body: t('onboard.notif-test-body') }
      : undefined
  void perms.request(key, payload)
}

const activePermission = computed<TccPermissionKey | null>(() =>
  current.value === 'permissions' ? ((activeKey.value || null) as TccPermissionKey | null) : null,
)

// ── Footer ────────────────────────────────────────────────────────────────────
async function installMissing(deps: OnboardDep[]): Promise<void> {
  // In list order, `brew install node` runs before Homebrew exists and exits
  // 127. orderInstalls pulls each prerequisite ahead of whatever needs it —
  // the helper existed already but nothing was calling it.
  for (const d of orderInstalls(deps, ob.deps.value)) {
    if (d.status === 'ok' || !d.can_install) continue
    // Resolves once the command has exited and a fresh re-detect has run.
    const result = await ob.install(d)
    // A failed, cancelled or blocked link blocks everything downstream of it.
    if (!result?.ok) break
    // Exit 0 but still undetected: continuing would run the next command
    // (which may need this one) against a machine that cannot see it — on a
    // fresh Mac every `brew install …` after Homebrew failed with exit 127.
    if (ob.deps.value.find((x) => x.id === d.id)?.status !== 'ok') break
  }
}

// Escape hatch: the wizard must never be a dead end. Skipping persists the
// complete flag so it doesn't re-block every launch — later gaps are covered
// in-app (missing-CLI badges in the spawn dropdown, the exit=127 install
// prompt), and Settings → General re-opens this wizard on demand.
function skipForNow(): void {
  void saveComplete().then((saved) => { if (saved) emit('close') })
}

function finish(): void {
  void saveComplete().then((saved) => { if (saved) emit('complete') })
}

/** Why the complete flag could not be saved; '' while it has not failed. */
const completeError = ref('')

// Closing on a failed save would bring the wizard back next launch with no
// word why, so it stays open with the error and the same button retries.
async function saveComplete(): Promise<boolean> {
  completeError.value = ''
  let error = ''
  try {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>(
      'onboarding.complete', { complete: true })
    if (resp.payload?.ok === false) error = resp.payload.error || 'unknown'
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  completeError.value = error ? t('onboard.complete-failed', { error }) : ''
  return !error
}
</script>

<template>
  <div class="ob-page">
    <header class="ob-top">
      <ol class="ob-steps">
        <li v-for="(s, i) in steps" :key="s" :class="{ active: current === s, done: stepDone(s) }">
          <button type="button" @click="stepIndex = i">{{ $t(`onboard.step.${s}`) }}</button>
          <span v-if="i < steps.length - 1" class="ob-chev" aria-hidden="true">›</span>
        </li>
      </ol>
      <select class="ob-lang-btn" :value="settings.language.value" :aria-label="$t('settings.appearance.language')" @change="selectLanguage">
        <option v-for="code in AVAILABLE_UI_LOCALES" :key="code" :value="code">
          {{ $t(`settings.appearance.language-${code}`) }}{{ isBetaUiLocale(code) ? ` (${$t('settings.appearance.language-beta')})` : '' }}
        </option>
      </select>
      <div class="ob-progress"><span :style="{ width: `${progress}%` }" /></div>
    </header>

    <div class="ob-split">
      <!-- ── Left: guided cards ───────────────────────────────────────────── -->
      <main class="ob-main">
        <h1 class="ob-head">{{ $t(`onboard.head.${current}`) }}</h1>

        <!-- Agents -->
        <template v-if="current === 'agents'">
          <OnboardingStepCard
            v-for="d in ob.cliDeps.value"
            :key="d.id"
            :title="d.label"
            :description="d.description"
            :meta="d.version"
            :optional="d.optional"
            :done="d.status === 'ok'"
            :expanded="activeKey === d.id"
            :error="cardError(d)"
            @toggle="togglePick(d.id)"
          >
            <template #actions>
              <!-- Prerequisites (Homebrew, Node) have no card of their own any
                   more: Install runs them first, in order. -->
              <button
                v-if="d.can_install && d.status !== 'ok'"
                class="ob-btn primary"
                :disabled="busy"
                @click="installMissing([d])"
              >
                {{ installLabel(d) }}
              </button>
              <a v-else-if="d.docs_url && d.status !== 'ok'" class="ob-btn primary" :href="d.docs_url" target="_blank" rel="noreferrer">
                {{ $t('onboard.install-guide') }}
              </a>
              <button class="ob-btn ghost" :disabled="detectBusy" @click="ob.refresh()">
                {{ ob.loading.value ? $t('label.detecting') : $t('action.re-detect') }}
              </button>
            </template>
          </OnboardingStepCard>

        </template>

        <!-- Permissions -->
        <template v-else-if="current === 'permissions'">
          <OnboardingStepCard
            v-for="k in PERMISSION_KEYS"
            :key="k"
            :title="$t(`onboard.perm.${k}.title`)"
            :description="$t(`onboard.perm.${k}.desc`)"
            :optional="SETTINGS_ONLY.includes(k)"
            :done="perms.statuses.value[k] === 'granted'"
            :expanded="activeKey === k"
            :warning="perms.statuses.value[k] === 'denied' ? $t(`onboard.perm.${k}.denied`) : ''"
            @toggle="togglePick(k)"
          >
            <template #actions>
              <button
                v-if="!SETTINGS_ONLY.includes(k) && perms.statuses.value[k] !== 'denied'"
                class="ob-btn primary"
                :disabled="!!perms.requesting.value"
                @click="requestPermission(k)"
              >
                {{ perms.requesting.value === k ? $t('onboard.requesting') : $t('onboard.allow') }}
              </button>
              <button
                v-else
                class="ob-btn primary"
                @click="perms.openSettings(k)"
              >
                {{ $t('onboard.open-settings') }}
              </button>
              <button class="ob-btn ghost" @click="perms.refresh()">{{ $t('action.re-detect') }}</button>
              <button
                class="ob-info"
                type="button"
                :aria-label="$t('onboard.why')"
                @click="toggleInfo(k)"
              >
                ⓘ
              </button>
              <p v-if="infoKey === k" class="ob-note">{{ $t(`onboard.perm.${k}.why`) }}</p>
            </template>
          </OnboardingStepCard>
        </template>

        <!-- Ready -->
        <template v-else>
          <p class="ob-hint">{{ $t('hint.ready-check') }}</p>
          <ul class="ob-gate">
            <li :class="{ ok: ob.hasAnyCli.value }">
              <span>{{ ob.hasAnyCli.value ? '✓' : '○' }}</span> {{ $t('label.at-least-one-cli') }}
            </li>
            <li v-if="perms.supported.value" :class="{ ok: perms.allGranted.value }">
              <span>{{ perms.allGranted.value ? '✓' : '○' }}</span> {{ $t('onboard.perm-gate') }} ·
              {{ $t('label.optional') }}
            </li>
          </ul>
          <button class="ob-linkbtn" :disabled="detectBusy" @click="ob.refresh()">
            {{ ob.loading.value ? $t('label.detecting') : $t('action.re-detect') }}
          </button>
        </template>

        <!-- Install log -->
        <!-- The running (or last) command: live output, prompts, exit code. -->
        <InstallTerminal
          v-if="ob.run.value || ob.runFallback.value"
          class="ob-install-terminal"
          :onboarding="ob"
        />
        <div v-if="ob.logLines.value.length" ref="logEl" class="ob-log">
          <div v-for="(l, i) in ob.logLines.value" :key="i" class="ob-log-line">{{ l }}</div>
        </div>
      </main>

      <!-- ── Right: illustration ──────────────────────────────────────────── -->
      <aside class="ob-aside">
        <OnboardingPreview
          v-if="activePermission"
          variant="settings"
          :pane="PERM_PANES[activePermission]"
          :caption="$t(`onboard.perm.${activePermission}.pane-hint`)"
          :granted="perms.statuses.value[activePermission] === 'granted'"
        />
        <OnboardingPreview v-else variant="app" :caption="$t(`onboard.aside.${current}`)" />
      </aside>
    </div>

    <footer class="ob-footer">
      <button class="ob-btn ghost" :disabled="busy" @click="skipForNow">{{ $t('action.skip-for-now') }}</button>
      <button v-if="stepIndex > 0" class="ob-btn ghost" :disabled="busy" @click="stepIndex--">{{ $t('action.back') }}</button>
      <span class="ob-spacer" />
      <span v-if="completeError" class="ob-complete-error" role="alert">{{ completeError }}</span>
      <button
        v-if="!isLast"
        class="ob-btn primary"
        :disabled="busy"
        @click="stepIndex++"
      >
        {{ $t('action.next') }}
      </button>
      <button
        v-else
        class="ob-btn primary"
        :disabled="!ob.allRequiredReady.value"
        :title="ob.allRequiredReady.value ? '' : $t('hint.not-ready')"
        @click="finish"
      >
        {{ $t('action.open-app') }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.ob-page {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 140);
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
  -webkit-app-region: no-drag;
}

/* ── Top stepper ────────────────────────────────────────────────────────────── */
.ob-top {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px 22px 16px;
}
.ob-steps {
  display: flex;
  align-items: center;
  gap: 14px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.ob-steps li {
  display: flex;
  align-items: center;
  gap: 14px;
}
.ob-steps button {
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-muted);
  transition: color 0.15s;
}
.ob-steps li.done button {
  color: var(--text-secondary);
}
.ob-steps li.active button {
  color: var(--text-bright);
}
.ob-chev {
  font-size: 15px;
  color: var(--text-disabled);
}
.ob-lang-btn {
  position: absolute;
  right: 22px;
  display: flex;
  align-items: center;
  gap: 2px;
  background: none;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
  font-size: var(--font-2xs);
  color: var(--text-muted);
}
.ob-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--border-muted);
}
.ob-progress span {
  display: block;
  height: 100%;
  background: var(--text-bright);
  transition: width 0.25s ease;
}

/* ── Split layout ───────────────────────────────────────────────────────────── */
.ob-split {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-height: 0;
}
.ob-main {
  overflow-y: auto;
  padding: 48px 56px 32px;
}
.ob-aside {
  overflow: hidden;
  border-left: 1px solid var(--border-muted);
  background: var(--bg-inset);
}
@media (max-width: 1000px) {
  .ob-split {
    grid-template-columns: minmax(0, 1fr);
  }
  .ob-aside {
    display: none;
  }
  .ob-main {
    padding: 32px 28px;
  }
}

.ob-head {
  margin: 0 0 32px;
  font-size: 34px;
  line-height: 1.2;
  font-weight: 750;
  letter-spacing: -0.02em;
  color: var(--text-bright);
}
.ob-hint {
  font-size: 13.5px;
  color: var(--text-secondary);
  margin: 0 0 16px;
  line-height: 1.55;
}

/* ── Card actions ───────────────────────────────────────────────────────────── */
.ob-btn {
  font-size: var(--font-sm);
  padding: 9px 18px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  text-decoration: none;
  line-height: var(--lh-tight);
}
.ob-btn:hover:not(:disabled) {
  background: var(--bg-muted);
  color: var(--text-bright);
}
.ob-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ob-btn.primary {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
.ob-btn.primary:hover:not(:disabled) {
  background: var(--accent-focus);
  color: var(--text-on-emphasis);
}
.ob-info {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 0;
  background: none;
  color: var(--text-muted);
  font-size: 15px;
  cursor: pointer;
}
.ob-info:hover {
  color: var(--text-bright);
}
.ob-note {
  flex-basis: 100%;
  margin: 4px 0 0;
  font-size: var(--font-xs);
  line-height: 1.55;
  color: var(--text-muted);
}
.ob-linkbtn {
  background: none;
  border: 0;
  padding: 4px 0;
  font-size: 12.5px;
  color: var(--accent-fg);
  cursor: pointer;
}
.ob-linkbtn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── Ready gate ─────────────────────────────────────────────────────────────── */
.ob-gate {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}
.ob-gate li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 4px;
  font-size: var(--font-md);
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-muted);
}
.ob-gate li.ok {
  color: var(--success-fg);
}
.ob-gate li span {
  font-weight: 700;
}

.ob-install-terminal {
  margin-top: 20px;
}
.ob-log {
  margin-top: 20px;
  max-height: 140px;
  overflow-y: auto;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  padding: 8px 10px;
  font: 11px/1.5 ui-monospace, Menlo, monospace;
  color: var(--text-secondary);
}
.ob-log-line {
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── Footer ─────────────────────────────────────────────────────────────────── */
.ob-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 22px;
  border-top: 1px solid var(--border-muted);
}
.ob-spacer {
  flex: 1;
}
.ob-complete-error {
  color: var(--danger-fg);
  font-size: 12px;
}
</style>
