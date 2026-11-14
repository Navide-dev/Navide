<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { hasRepairableFinding, STATUS_TIMEOUT_MS, useOnboarding } from '../composables/useOnboarding'
import type {
  CliHealthCandidate, CliHealthEntry, CliHealthStatus, OnboardStatus, UpdateGate,
} from '../composables/useOnboarding'
import InstallTerminal from './InstallTerminal.vue'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  initialHealth: CliHealthStatus
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'resolved'): void
}>()
const { t } = useI18n()

type Step = 'detect' | 'repair' | 'verify'
const steps: Step[] = ['detect', 'repair', 'verify']
const stepIndex = ref(0)
const current = computed(() => steps[stepIndex.value])
const health = ref(props.initialHealth)
const checking = ref(false)
const message = ref('')

// update_failed is reported by the CLI itself and is fixed by re-running the
// vendor's update from CLI management — not by this repair guide.
const affectedKeys = computed(() => new Set(
  health.value.findings.filter((finding) => finding.type !== 'update_failed')
    .map((finding) => finding.agent_key)))
const affectedEntries = computed(() => health.value.entries.filter((entry) => affectedKeys.value.has(entry.agent_key)))

function findingType(entry: CliHealthEntry): 'probe_failed' | 'duplicate_install' {
  const finding = health.value.findings.find(
    (item) => item.agent_key === entry.agent_key && item.type !== 'update_failed')
  return finding?.type === 'probe_failed' ? 'probe_failed' : 'duplicate_install'
}

async function openDiagnostics(entry: CliHealthEntry): Promise<void> {
  const result = await window.agentTeam?.openTerminal(entry.diagnostic_command)
  message.value = result?.ok
    ? t('cli-health.terminal-opened')
    : t('cli-health.terminal-failed', { error: result?.error || 'unknown' })
}

// Paths whose removal was already opened in Terminal this session; they no
// longer count as working backups until the next re-detect refreshes the data.
const removedPaths = ref<Set<string>>(new Set())

// Windows paths arrive with backslashes; the backend compares them as POSIX
// (`Path.as_posix()`), so the npm-prefix checks here must do the same.
function posixPath(path: string): string {
  return path.replace(/\\/g, '/')
}

function sameNpmInstall(entry: CliHealthEntry, first: CliHealthCandidate, second: CliHealthCandidate): boolean {
  const packageName = entry.npm_package
  if (!packageName) return false
  const marker = `/node_modules/${packageName}/`
  const firstPath = posixPath(first.resolved_path)
  const secondPath = posixPath(second.resolved_path)
  if (!firstPath.includes(marker) || !secondPath.includes(marker)) return false
  return firstPath.split(marker)[0] === secondPath.split(marker)[0]
}

function remainingOk(entry: CliHealthEntry, candidate: CliHealthCandidate): CliHealthCandidate | undefined {
  return entry.candidates.find((item) =>
    item !== candidate
    && item.status === 'ok'
    && !removedPaths.value.has(item.resolved_path)
    && !sameNpmInstall(entry, candidate, item))
}

function removalAllowed(entry: CliHealthEntry, candidate: CliHealthCandidate): boolean {
  // Removal must never target the last working install: broken candidates are
  // always removable, working ones only with a surviving working backup.
  if (removedPaths.value.has(candidate.resolved_path)) return false
  if (candidate.status !== 'ok') return true
  return remainingOk(entry, candidate) !== undefined
}

function isNpmOwned(entry: CliHealthEntry, candidate: CliHealthCandidate): boolean {
  const packageName = entry.npm_package
  return Boolean(packageName && posixPath(candidate.resolved_path).includes(`/node_modules/${packageName}/`))
}

function showBlockedNote(entry: CliHealthEntry, candidate: CliHealthCandidate): boolean {
  return candidate.status === 'ok'
    && !removedPaths.value.has(candidate.resolved_path)
    && isNpmOwned(entry, candidate)
    && !removalAllowed(entry, candidate)
}

function removalCommand(entry: CliHealthEntry, candidate: CliHealthCandidate): string {
  if (!removalAllowed(entry, candidate)) return ''
  // The backend's command is final (empty = unavailable): it is built for
  // the terminal shell of this platform, which the renderer cannot know.
  return candidate.removal_command ?? ''
}

const pendingRemoval = ref<{ entry: CliHealthEntry; candidate: CliHealthCandidate } | null>(null)

function isPendingRemoval(candidate: CliHealthCandidate): boolean {
  return pendingRemoval.value?.candidate === candidate
}

function requestRemoval(entry: CliHealthEntry, candidate: CliHealthCandidate): void {
  message.value = ''
  pendingRemoval.value = { entry, candidate }
}

function cancelRemoval(): void {
  pendingRemoval.value = null
}

async function confirmRemoval(): Promise<void> {
  if (!pendingRemoval.value) return
  const { entry, candidate } = pendingRemoval.value
  pendingRemoval.value = null
  const result = await window.agentTeam?.openTerminal(removalCommand(entry, candidate))
  if (result?.ok) {
    removedPaths.value = new Set(removedPaths.value).add(candidate.resolved_path)
    message.value = t('cli-health.removal-opened', { label: entry.label })
  } else {
    message.value = t('cli-health.terminal-failed', { error: result?.error || 'unknown' })
  }
}

/** Send a state write; the error to show, or '' once it is saved. */
async function saveError(type: string, payload: Record<string, unknown>): Promise<string> {
  try {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>(type, payload)
    return resp.payload?.ok === false ? resp.payload.error || 'unknown' : ''
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

async function useBinary(entry: CliHealthEntry, candidate: CliHealthCandidate): Promise<void> {
  message.value = ''
  const error = await saveError('onboarding.cli_health.select_binary', {
    agent_key: entry.agent_key,
    path: candidate.path,
  })
  if (error) {
    message.value = t('cli-health.save-failed', { error })
    return
  }
  // The override resolves this CLI's findings on the backend; re-read them so
  // the guide stays open only for other CLIs, and a later skip dismisses what
  // is left rather than the set the guide opened with.
  try {
    const resp = await props.backend.send<OnboardStatus>('onboarding.status', {}, STATUS_TIMEOUT_MS)
    if (resp.payload?.cli_health) {
      pendingRemoval.value = null
      removedPaths.value = new Set()
      health.value = resp.payload.cli_health
    }
  } catch {
    // The choice is saved; re-detect on the last step can still refresh this.
  }
  if (!hasRepairableFinding(health.value)) {
    emit('resolved')
    return
  }
  message.value = t('cli-health.binary-selected', { label: entry.label })
}

async function recheck(): Promise<void> {
  checking.value = true
  message.value = ''
  try {
    // fresh: the user just changed installs in Terminal, which the backend's
    // cached login-shell PATH cannot have seen.
    const resp = await props.backend.send<OnboardStatus>(
      'onboarding.status', { fresh: true }, STATUS_TIMEOUT_MS)
    if (!resp.payload?.cli_health) return
    // Fresh probe data supersedes any in-flight confirmation or session-local
    // removal tracking (object identities change with the new payload).
    pendingRemoval.value = null
    removedPaths.value = new Set()
    health.value = resp.payload.cli_health
    if (!hasRepairableFinding(health.value)) {
      emit('resolved')
      return
    }
    message.value = t('cli-health.still-detected')
  } catch (e) {
    message.value = t('cli-health.recheck-failed', { error: e instanceof Error ? e.message : String(e) })
  } finally {
    checking.value = false
  }
}

// ── Update the install Navide launches (0.2.42) ──────────────────────────────
// The same run as CLI management's update: the backend picks the command for
// how this install got there, runs it in the visible terminal below, one at a
// time per machine and only while that CLI's panes are idle.
const onboarding = useOnboarding(props.backend)
const { maintaining, run: activeRun, runFallback } = onboarding
const gates = ref<Record<string, UpdateGate>>({})
const GATE_POLL_MS = 3_000
let gateTimer: ReturnType<typeof setInterval> | null = null
/** Per CLI updated from this guide: what Verify reports. */
const updateResults = ref<Record<string, { label: string; from: string; to: string; error: string }>>({})

function updatable(entry: CliHealthEntry): boolean {
  return !!entry.latest_version && !!entry.update_plan?.command
}

function primaryOf(entry: CliHealthEntry | undefined): CliHealthCandidate | undefined {
  return entry?.candidates.find((candidate) => candidate.is_primary) ?? entry?.candidates[0]
}

async function refreshGates(): Promise<void> {
  for (const entry of affectedEntries.value.filter(updatable)) {
    const gate = await onboarding.updateGate(entry.agent_key)
    if (gate) gates.value = { ...gates.value, [entry.agent_key]: gate }
  }
}

function updateBlocked(entry: CliHealthEntry): boolean {
  return gates.value[entry.agent_key]?.blocked === true
}

function gateReason(entry: CliHealthEntry, gate: UpdateGate | undefined = gates.value[entry.agent_key]): string {
  if (!gate?.blocked) return ''
  if (gate.reason === 'update-running') return t('cli-manage.update-blocked-running')
  const params = { label: entry.label, panes: gate.busy_panes.join(', ') }
  return gate.reason === 'panes-open'
    ? t('cli-manage.update-blocked-open', params)
    : t('cli-manage.update-blocked-busy', params)
}

onMounted(() => {
  void refreshGates()
  gateTimer = setInterval(() => void refreshGates(), GATE_POLL_MS)
})
onUnmounted(() => {
  if (gateTimer) clearInterval(gateTimer)
  onboarding.dispose()
})

async function updateEntry(entry: CliHealthEntry): Promise<void> {
  message.value = ''
  const from = primaryOf(entry)?.version || ''
  // Resolves once the command has exited in the terminal (or was refused).
  const result = await onboarding.runMaintenance(entry.agent_key, 'update')
  if (!result) return
  if (result.gate) {
    gates.value = { ...gates.value, [entry.agent_key]: result.gate }
    message.value = gateReason(entry, result.gate)
    return
  }
  // A PTY that could not start shows its external-terminal fallback instead.
  if (result.spawn_failed) return
  if (!result.run_id && !result.ok) {
    message.value = t('cli-health.update-failed', { error: result.error || 'unknown' })
    return
  }
  await verifyUpdate(entry, from, result.ok ? '' : result.error || 'unknown')
}

/** Go to Verify and detect again; report the version before and after. */
async function verifyUpdate(entry: CliHealthEntry, from: string, error: string): Promise<void> {
  stepIndex.value = steps.indexOf('verify')
  checking.value = true
  try {
    const resp = await props.backend.send<OnboardStatus>('onboarding.status', { fresh: true }, STATUS_TIMEOUT_MS)
    if (resp.payload?.cli_health) {
      pendingRemoval.value = null
      removedPaths.value = new Set()
      health.value = resp.payload.cli_health
    }
    const after = health.value.entries.find((item) => item.agent_key === entry.agent_key)
    updateResults.value = {
      ...updateResults.value,
      [entry.agent_key]: { label: entry.label, from, to: primaryOf(after)?.version || '', error },
    }
  } catch (e) {
    message.value = t('cli-health.recheck-failed', { error: e instanceof Error ? e.message : String(e) })
  } finally {
    checking.value = false
  }
}

async function dismiss(): Promise<void> {
  message.value = ''
  // An update can leave nothing to repair: there is no finding set to
  // dismiss then, only a guide to close.
  if (!health.value.fingerprint) {
    emit('resolved')
    return
  }
  const error = await saveError('onboarding.cli_health.dismiss', {
    fingerprint: health.value.fingerprint,
  })
  // Closing anyway would bring the guide back next launch with no word why.
  if (error) {
    message.value = t('cli-health.save-failed', { error })
    return
  }
  emit('close')
}
</script>

<template>
  <div class="ch-page">
    <section class="ch-dialog" role="dialog" aria-modal="true" :aria-label="$t('cli-health.title')">
      <header class="ch-top">
        <div>
          <div class="ch-kicker">{{ $t('cli-health.kicker') }}</div>
          <h1>{{ $t('cli-health.title') }}</h1>
        </div>
        <ol class="ch-steps">
          <li v-for="(step, index) in steps" :key="step" :class="{ active: current === step, done: index < stepIndex }">
            <span>{{ index < stepIndex ? '✓' : index + 1 }}</span>
            {{ $t(`cli-health.step.${step}`) }}
          </li>
        </ol>
      </header>

      <main class="ch-main">
        <template v-if="current === 'detect'">
          <h2>{{ $t('cli-health.detect-title') }}</h2>
          <p class="ch-lead">{{ $t('cli-health.detect-desc') }}</p>
          <section v-for="entry in affectedEntries" :key="entry.agent_key" class="ch-card">
            <div class="ch-card-head">
              <strong>{{ entry.label }}</strong>
              <span class="ch-warning">{{ $t(`cli-health.finding.${findingType(entry)}`) }}</span>
            </div>
            <div v-for="candidate in entry.candidates" :key="candidate.resolved_path" class="ch-candidate" :class="{ primary: candidate.is_primary }">
              <div class="ch-candidate-top">
                <span>{{ candidate.is_primary ? $t('cli-health.active') : $t('cli-health.alternate') }}</span>
                <code>{{ candidate.version || $t('cli-health.unknown-version') }}</code>
                <span v-if="candidate.signal" class="ch-signal">{{ candidate.signal }}</span>
              </div>
              <code class="ch-path">{{ candidate.path }}</code>
              <div v-if="candidate.is_primary && entry.latest_version" class="ch-update" data-testid="cli-health-update">
                <div class="ch-update-line">
                  <span>{{ $t('cli-health.update-current', { version: candidate.version || $t('cli-health.unknown-version') }) }}</span>
                  <span class="ch-arrow" aria-hidden="true">→</span>
                  <span>{{ $t('cli-health.update-latest', { version: entry.latest_version }) }}</span>
                  <span class="ch-update-spacer" />
                  <button
                    v-if="updatable(entry)"
                    class="ch-btn update ch-update-btn"
                    :disabled="!!maintaining || updateBlocked(entry)"
                    :title="updateBlocked(entry) ? gateReason(entry) : entry.update_plan?.command"
                    @click="updateEntry(entry)"
                  >
                    {{ $t('cli-health.update-to', { version: entry.latest_version }) }}
                  </button>
                  <a v-else-if="entry.docs_url" class="ch-docs" :href="entry.docs_url" target="_blank" rel="noreferrer">
                    {{ $t('cli-health.update-docs') }} ↗
                  </a>
                </div>
                <p v-if="updatable(entry)" class="ch-update-note">
                  {{ $t('cli-health.update-runs-with', { command: entry.update_plan?.command }) }}
                </p>
                <p v-else-if="entry.update_plan?.reason === 'npm-prefix-not-writable'" class="ch-update-note">
                  {{ $t('cli-health.update-npm-not-writable') }}
                </p>
                <p v-else class="ch-update-note">{{ $t('cli-health.update-no-command') }}</p>
                <p v-if="updatable(entry) && updateBlocked(entry)" class="ch-gate" data-testid="cli-health-update-gate">
                  {{ gateReason(entry) }}
                </p>
              </div>
              <div class="ch-candidate-actions">
                <button
                  v-if="candidate.status === 'ok' && !candidate.is_primary"
                  class="ch-btn primary ch-use-binary"
                  @click="useBinary(entry, candidate)"
                >
                  {{ $t('cli-health.use-version', { version: candidate.version || $t('cli-health.unknown-version') }) }}
                </button>
                <button
                  v-if="removalCommand(entry, candidate) && !isPendingRemoval(candidate)"
                  class="ch-btn danger ch-remove-binary"
                  @click="requestRemoval(entry, candidate)"
                >
                  {{ $t('cli-health.remove-installation') }}
                </button>
              </div>
              <div v-if="isPendingRemoval(candidate)" class="ch-confirm">
                <strong>{{ $t('cli-health.confirm-remove-title') }}</strong>
                <p>{{ $t('cli-health.confirm-remove-desc', { path: candidate.path, version: candidate.version || $t('cli-health.unknown-version') }) }}</p>
                <p v-if="remainingOk(entry, candidate)">
                  {{ $t('cli-health.confirm-remove-keep', { path: remainingOk(entry, candidate)?.path }) }}
                </p>
                <div class="ch-confirm-actions">
                  <button class="ch-btn ghost ch-cancel-removal" @click="cancelRemoval">{{ $t('action.cancel') }}</button>
                  <button class="ch-btn danger ch-confirm-removal" @click="confirmRemoval">{{ $t('cli-health.confirm-continue') }}</button>
                </div>
              </div>
              <p v-if="showBlockedNote(entry, candidate)" class="ch-blocked">
                {{ $t('cli-health.removal-blocked') }}
              </p>
            </div>
            <div class="ch-actions-note">{{ $t('cli-health.use-version-note') }}</div>
            <div v-if="entry.latest_version && entry.candidates.length > 1" class="ch-actions-note">
              {{ $t('cli-health.update-only-active') }}
            </div>
          </section>
        </template>

        <template v-else-if="current === 'repair'">
          <h2>{{ $t('cli-health.repair-title') }}</h2>
          <p class="ch-lead">{{ $t('cli-health.repair-desc') }}</p>
          <section v-for="entry in affectedEntries" :key="entry.agent_key" class="ch-card repair">
            <strong>{{ entry.label }}</strong>
            <ol>
              <li>{{ $t('cli-health.keep-primary') }}</li>
              <li>{{ $t('cli-health.remove-alternate') }}</li>
              <li>{{ $t('cli-health.run-doctor') }}</li>
            </ol>
            <button class="ch-btn primary" @click="openDiagnostics(entry)">
              {{ $t('cli-health.open-terminal') }} · <code>{{ entry.diagnostic_command }}</code>
            </button>
            <div class="ch-version-actions">
              <button
                v-for="candidate in entry.candidates.filter((item) => item.status === 'ok' && !item.is_primary)"
                :key="candidate.resolved_path"
                class="ch-btn primary"
                @click="useBinary(entry, candidate)"
              >
                {{ $t('cli-health.use-version', { version: candidate.version || $t('cli-health.unknown-version') }) }}
              </button>
            </div>
          </section>
        </template>

        <template v-else>
          <div class="ch-verify">
            <div class="ch-check">✓</div>
            <template v-if="Object.keys(updateResults).length">
              <h2>{{ $t('cli-health.update-verify-title') }}</h2>
              <p class="ch-lead">{{ $t('cli-health.update-verify-desc') }}</p>
              <section
                v-for="(result, key) in updateResults"
                :key="key"
                class="ch-card ch-update-result"
                data-testid="cli-health-update-result"
              >
                <strong>{{ result.label }}</strong>
                <span v-if="result.error" class="ch-warning">{{ $t('cli-health.update-failed', { error: result.error }) }}</span>
                <span v-else-if="result.to && result.to !== result.from" class="ch-updated">
                  ✓ {{ $t('cli-health.update-updated', { from: result.from || $t('cli-health.unknown-version'), to: result.to }) }}
                </span>
                <span v-else class="ch-warning">
                  {{ $t('cli-health.update-unchanged', { version: result.to || result.from || $t('cli-health.unknown-version') }) }}
                </span>
              </section>
            </template>
            <template v-else>
              <h2>{{ $t('cli-health.verify-title') }}</h2>
              <p class="ch-lead">{{ $t('cli-health.verify-desc') }}</p>
            </template>
            <button class="ch-btn primary" :disabled="checking" @click="recheck">
              {{ checking ? $t('label.detecting') : $t('action.re-detect') }}
            </button>
          </div>
        </template>

        <InstallTerminal v-if="activeRun || runFallback" class="ch-terminal" :onboarding="onboarding" />
        <p v-if="message" class="ch-message">{{ message }}</p>
      </main>

      <footer class="ch-footer">
        <button class="ch-btn ghost" :disabled="!!maintaining" @click="dismiss">{{ $t('action.skip-for-now') }}</button>
        <span />
        <button v-if="stepIndex > 0" class="ch-btn ghost" @click="stepIndex--">{{ $t('action.back') }}</button>
        <button v-if="stepIndex < steps.length - 1" class="ch-btn primary" @click="stepIndex++">{{ $t('action.next') }}</button>
        <button v-else class="ch-btn ghost" :disabled="!!maintaining" @click="dismiss">{{ $t('cli-health.close') }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.ch-page {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 141);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: rgba(0, 0, 0, .58);
  backdrop-filter: blur(3px);
  color: var(--text-primary);
  -webkit-app-region: no-drag;
}
.ch-dialog {
  width: min(880px, calc(100vw - 56px));
  max-height: min(760px, calc(100vh - 56px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: 16px;
  background: var(--bg-base);
  box-shadow: 0 22px 70px rgba(0, 0, 0, .48);
}
.ch-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  padding: 24px 30px 20px;
  border-bottom: 1px solid var(--border-muted);
}
.ch-kicker { color: var(--accent-bright); font-size: var(--font-xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 5px 0 0; color: var(--text-bright); font-size: 25px; }
.ch-steps { display: flex; gap: 22px; margin: 0; padding: 0; list-style: none; color: var(--text-muted); font-size: var(--font-xs); }
.ch-steps li { display: flex; align-items: center; gap: 7px; }
.ch-steps li span { display: grid; place-items: center; width: 23px; height: 23px; border: 1px solid var(--border-default); border-radius: 50%; }
.ch-steps li.active { color: var(--text-bright); }
.ch-steps li.active span { border-color: var(--accent-bright); color: var(--accent-bright); }
.ch-steps li.done span { border-color: var(--success-emphasis); background: var(--success-emphasis); color: var(--text-on-emphasis); }
.ch-main { width: 100%; padding: 30px; overflow: auto; box-sizing: border-box; }
h2 { margin: 0 0 8px; color: var(--text-bright); font-size: 22px; }
.ch-lead { margin: 0 0 26px; color: var(--text-secondary); line-height: 1.6; }
.ch-card { padding: 20px; margin-bottom: 14px; border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-subtle); }
.ch-card-head, .ch-candidate-top { display: flex; align-items: center; gap: 10px; }
.ch-card-head { justify-content: space-between; margin-bottom: 14px; }
.ch-warning { color: var(--attention-fg); font-size: var(--font-xs); }
.ch-candidate { padding: 12px 14px; margin-top: 8px; border-left: 3px solid var(--border-default); background: var(--bg-base); border-radius: 6px; }
.ch-candidate.primary { border-left-color: var(--accent-bright); }
.ch-candidate-top { color: var(--text-secondary); font-size: var(--font-xs); }
.ch-candidate-top code { margin-left: auto; color: var(--text-bright); }
.ch-signal { color: var(--danger-fg); font-weight: 700; }
.ch-path { display: block; margin-top: 8px; color: var(--text-muted); font-size: var(--font-2xs); overflow-wrap: anywhere; }
.ch-candidate-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.ch-confirm { margin-top: 12px; padding: 12px 14px; border: 1px solid var(--danger-fg); border-radius: 8px; background: var(--bg-subtle); font-size: var(--font-sm); }
.ch-confirm p { margin: 6px 0 0; color: var(--text-secondary); line-height: var(--lh-base); overflow-wrap: anywhere; }
.ch-confirm-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.ch-blocked { margin: 10px 0 0; color: var(--text-muted); font-size: var(--font-xs); line-height: var(--lh-base); }
.ch-actions-note { margin-top: 14px; color: var(--text-secondary); font-size: var(--font-xs); line-height: var(--lh-base); }
.ch-version-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.repair ol { color: var(--text-secondary); line-height: 1.8; }
.ch-verify { text-align: center; padding-top: 50px; }
.ch-check { display: grid; place-items: center; width: 54px; height: 54px; margin: 0 auto 18px; border-radius: 50%; background: var(--success-emphasis); color: var(--text-on-emphasis); font-size: 25px; }
.ch-message { color: var(--attention-fg); text-align: center; }
.ch-footer { display: flex; align-items: center; gap: 10px; margin-top: auto; padding: 16px 30px; border-top: 1px solid var(--border-muted); }
.ch-footer span { flex: 1; }
.ch-btn { border: 1px solid var(--border-default); border-radius: 7px; padding: 9px 14px; cursor: pointer; color: var(--text-primary); background: var(--bg-subtle); }
.ch-btn.primary { border-color: var(--accent-emphasis); background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ch-btn.danger { border-color: var(--danger-fg); color: var(--danger-fg); background: transparent; }
.ch-btn.ghost { background: transparent; }
.ch-btn.update { border-color: var(--success-emphasis); background: var(--success-emphasis); color: var(--text-on-emphasis); font-weight: 600; }
.ch-update { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--accent-emphasis); border-radius: 8px; background: var(--bg-subtle); }
.ch-update-line { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: var(--font-sm); color: var(--text-bright); }
.ch-update-spacer { flex: 1; }
.ch-arrow { color: var(--accent-bright); }
.ch-update-note { margin: 6px 0 0; color: var(--text-muted); font-size: var(--font-2xs); overflow-wrap: anywhere; }
.ch-gate { margin: 6px 0 0; color: var(--attention-fg); font-size: var(--font-xs); }
.ch-docs { color: var(--accent-bright); font-size: var(--font-xs); }
.ch-update-result { display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; }
.ch-updated { color: var(--success-fg); font-size: var(--font-xs); }
.ch-terminal { margin-top: 14px; }
/* Hover feedback: the variants restate their own resting colour so the base
 * rule cannot recolour them. Transition and focus ring come from semantic.css. */
.ch-btn:hover:not(:disabled) { background: var(--bg-hover-strong); border-color: var(--border-strong); color: var(--text-bright); }
.ch-btn.update:hover:not(:disabled) { background: var(--success-strong); border-color: var(--success-strong); color: var(--text-on-emphasis); }
.ch-btn.primary:hover:not(:disabled) { background: var(--accent-focus); border-color: var(--accent-focus); color: var(--text-on-emphasis); }
.ch-btn.danger:hover:not(:disabled) { background: var(--bg-hover-strong); border-color: var(--danger-fg); color: var(--danger-fg); }
.ch-btn.ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); color: var(--text-bright); }
.ch-btn:disabled { opacity: .55; cursor: default; }
.ch-btn code { font-size: var(--font-2xs); }
@media (max-width: 760px) {
  .ch-page { padding: 14px; }
  .ch-dialog { width: calc(100vw - 28px); max-height: calc(100vh - 28px); }
  .ch-top { align-items: flex-start; flex-direction: column; gap: 16px; padding: 20px; }
  .ch-steps { gap: 12px; }
  .ch-main { padding: 22px 20px; }
  .ch-footer { padding: 14px 20px; }
}
</style>
