<script setup lang="ts">
/**
 * CLI management — one row per registered agent CLI.
 *
 * Everything runnable here comes from the backend registry: Navide surfaces the
 * vendor's own update/doctor/install commands and runs them in an embedded
 * terminal the user can see and answer. It never wraps, parses or substitutes a vendor command, and it
 * never downloads or installs anything itself.
 */
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import type { useCliProfiles } from '../composables/useCliProfiles'
import type { useOnboarding } from '../composables/useOnboarding'
import type {
  AutoupdatePolicy, CliHealthEntry, CliUpdateRecord, MaintenanceAction, OnboardDep, UpdateGate,
} from '../composables/useOnboarding'
import InstallTerminal from './InstallTerminal.vue'

const CliInstallDialog = defineAsyncComponent(() => import('./CliInstallDialog.vue'))

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  /** The owner's onboarding instance. It is passed in rather than created here
   *  because the settings page shows the same probe in its CLI list, and a
   *  second useOnboarding() would mean a second `onboarding.status` round trip
   *  — which shells out once per dep. */
  onboarding: ReturnType<typeof useOnboarding>
  /** Account store, so the install dialog's last step can tell "installed" from
   *  "installed and signed in". Optional: without it the dialog simply never
   *  shows a sign-in step, which is the same as today. */
  cliProfiles?: ReturnType<typeof useCliProfiles>
  /** A drawer shows one agent and uses its owner's already refreshed probe. */
  agentKey?: string
}>()
const emit = defineEmits<{ login: [agentKey: string]; 'install-open-change': [open: boolean] }>()

/** 'unknown' = this CLI keeps no credential file Navide can read. */
function signInStateFor(depId: string): 'signed-in' | 'signed-out' | 'unknown' {
  const identity = props.cliProfiles?.identityFor(depId, null)
  if (!identity) return 'unknown'
  return identity.signedIn ? 'signed-in' : 'signed-out'
}
const { t } = useI18n()

const onboarding = props.onboarding
const { cliDeps, cliHealth, loading, maintaining, run: activeRun, runBusy, runFallback } = onboarding
const message = ref('')
/** Dep id whose guided install dialog is open ('' = none). */
const installTarget = ref('')
const panelRef = ref<HTMLElement | null>(null)
const displayedDeps = computed(() => props.agentKey
  ? cliDeps.value.filter((dep) => dep.id === props.agentKey)
  : cliDeps.value)
let installTrigger: HTMLElement | null = null

/** Last gate answer per installed agent CLI: an update runs one at a time per
 *  machine, and only while every pane of that CLI is idle (on Windows: closed). */
const gates = ref<Record<string, UpdateGate>>({})
const GATE_POLL_MS = 3_000
let gateTimer: ReturnType<typeof setInterval> | null = null

function gated(dep: OnboardDep): boolean {
  return dep.group === 'agent_cli' && dep.status !== 'missing' && !!updateCommand(dep)
}

/** What "update" runs: the backend's plan for this install, else the vendor's. */
function updateCommand(dep: OnboardDep): string {
  return dep.update_plan?.command || dep.update_cmd
}

/** npm's global folder is root-owned: no button, say why (Navide never sudo). */
function npmNotWritable(dep: OnboardDep): boolean {
  return dep.update_plan?.reason === 'npm-prefix-not-writable'
}

async function refreshGates(): Promise<void> {
  for (const dep of displayedDeps.value.filter(gated)) {
    const gate = await onboarding.updateGate(dep.id)
    if (gate) gates.value = { ...gates.value, [dep.id]: gate }
  }
}

function updateBlocked(dep: OnboardDep): boolean {
  return gated(dep) && gates.value[dep.id]?.blocked === true
}

function gateReason(dep: OnboardDep, gate: UpdateGate | undefined = gates.value[dep.id]): string {
  if (!gate?.blocked) return ''
  if (gate.reason === 'update-running') return t('cli-manage.update-blocked-running')
  return gate.reason === 'panes-open'
    ? t('cli-manage.update-blocked-open', { label: dep.label, panes: gate.busy_panes.join(', ') })
    : t('cli-manage.update-blocked-busy', { label: dep.label, panes: gate.busy_panes.join(', ') })
}

// The probe often lands after mount: ask as soon as a gated CLI is listed.
watch(() => displayedDeps.value.filter(gated).map((dep) => dep.id).join(','), () => void refreshGates())

onMounted(() => {
  if (!props.agentKey) void onboarding.refresh()
  void refreshGates()
  gateTimer = setInterval(() => void refreshGates(), GATE_POLL_MS)
})
onUnmounted(() => {
  if (gateTimer) clearInterval(gateTimer)
  emit('install-open-change', false)
})
watch(() => props.agentKey, () => { installTarget.value = ''; message.value = '' })
watch(installTarget, async (target) => {
  emit('install-open-change', !!target)
  if (target) {
    installTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  } else {
    await nextTick()
    if (installTrigger?.isConnected) installTrigger.focus()
  }
})

function closeInstallDialog(): boolean {
  if (!installTarget.value) return false
  closeInstall()
  return true
}
defineExpose({ closeInstallDialog })

function closeInstall(): void {
  installTarget.value = ''
  void onboarding.refresh()
}

function entryFor(dep: OnboardDep): CliHealthEntry | undefined {
  return cliHealth.value?.entries.find((entry) => entry.agent_key === dep.id)
}

function lastUpdate(dep: OnboardDep): CliUpdateRecord | undefined {
  return entryFor(dep)?.update_state[0]
}

/** Alternates only matter while a second physical install exists. */
function duplicates(dep: OnboardDep): CliHealthEntry['candidates'] {
  const candidates = entryFor(dep)?.candidates ?? []
  return candidates.length > 1 ? candidates : []
}

function busy(dep: OnboardDep, action: MaintenanceAction): boolean {
  return maintaining.value === `${dep.id}:${action}`
}

async function run(dep: OnboardDep, action: MaintenanceAction): Promise<void> {
  message.value = ''
  // Resolves once the command has exited in the terminal below (or was refused).
  const result = await onboarding.runMaintenance(dep.id, action)
  if (!result) return
  if (result.gate) {
    gates.value = { ...gates.value, [dep.id]: result.gate }
    message.value = gateReason(dep, result.gate)
    return
  }
  if (result.ok) message.value = t('cli-manage.run-finished', { command: result.command })
  else if (result.run_id) message.value = t('cli-manage.run-failed', { command: result.command, error: result.error })
  // An install refusal carries the reason (e.g. a missing prerequisite); the
  // generic text below fits only an action the vendor never shipped.
  else if (result.unanswered || (action === 'install' && result.error)) {
    message.value = t('cli-manage.start-failed', { label: dep.label, error: result.error })
  }
  // A PTY that could not start shows its external-terminal fallback below.
  else if (!result.spawn_failed) message.value = t('cli-manage.command-unavailable', { label: dep.label })
}

async function setPolicy(dep: OnboardDep, event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  if (await onboarding.setAutoupdatePolicy(dep.id, select.value as AutoupdatePolicy)) return
  // The select already shows the refused value; put back what is in effect.
  select.value = dep.autoupdate_policy
  message.value = t('cli-manage.autoupdate-failed', { label: dep.label })
}

async function removeAlternate(command: string): Promise<void> {
  const result = await window.agentTeam?.openTerminal(command)
  message.value = result?.ok
    ? t('cli-manage.terminal-opened', { command })
    : t('cli-manage.terminal-failed', { error: result?.error || 'unknown' })
}

async function useBinary(dep: OnboardDep, path: string): Promise<void> {
  let error = ''
  try {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>(
      'onboarding.cli_health.select_binary', { agent_key: dep.id, path })
    if (resp.payload?.ok === false) error = resp.payload.error || 'unknown'
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  message.value = error
    ? t('cli-manage.use-failed', { label: dep.label, error })
    : t('cli-manage.use-done', { label: dep.label, path })
  if (!error) await onboarding.refresh()
}

const hasFailedUpdate = computed(() => new Set(
  (cliHealth.value?.findings ?? [])
    .filter((finding) => finding.type === 'update_failed')
    .map((finding) => finding.agent_key),
))

/** The outcome string is the vendor's, not ours: translate the values we know
 *  and pass anything else through verbatim rather than showing a missing key. */
function outcomeLabel(outcome: string): string {
  return outcome === 'success' || outcome === 'failed'
    ? t(`cli-manage.outcome.${outcome}`)
    : outcome || t('cli-manage.outcome.unknown')
}

function formatTime(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}
</script>

<template>
  <div ref="panelRef" class="cm">
    <div class="cm-head">
      <div>
        <h3 class="cm-title">{{ $t('cli-manage.title') }}</h3>
        <p class="cm-hint">{{ $t('cli-manage.hint') }}</p>
      </div>
      <button class="cm-btn" :disabled="loading" @click="onboarding.refresh({ fresh: true })">
        {{ loading ? $t('cli-manage.detecting') : $t('cli-manage.redetect') }}
      </button>
    </div>

    <p v-if="message" class="cm-message">{{ message }}</p>

    <div v-for="dep in displayedDeps" :key="dep.id" class="cm-row" :data-agent-key="dep.id">
      <div class="cm-row-head">
        <span class="cm-name">{{ dep.label }}</span>
        <span :class="['cm-badge', dep.status]">{{ $t(`cli-manage.status.${dep.status}`) }}</span>
        <span v-if="dep.version" class="cm-version">{{ dep.version }}</span>
        <span v-if="dep.latest_version" class="cm-badge update-available" data-testid="cli-update-available">
          {{ $t('cli-manage.update-available', { version: dep.latest_version }) }}
        </span>
        <span v-if="dep.install_method" class="cm-method">
          {{ $t(`cli-manage.method.${dep.install_method}`) }}
        </span>
      </div>

      <div v-if="dep.resolved_path" class="cm-path" :title="dep.resolved_path">{{ dep.resolved_path }}</div>

      <div v-if="lastUpdate(dep)" :class="['cm-update', { failed: hasFailedUpdate.has(dep.id) }]">
        <span>{{ $t('cli-manage.last-update') }}</span>
        <strong>{{ outcomeLabel(lastUpdate(dep)!.outcome) }}</strong>
        <span>{{ formatTime(lastUpdate(dep)!.timestamp) }}</span>
        <code v-if="lastUpdate(dep)!.version_from">
          {{ lastUpdate(dep)!.version_from }}{{ lastUpdate(dep)!.version_to ? ` → ${lastUpdate(dep)!.version_to}` : '' }}
        </code>
        <span class="cm-scope">{{ lastUpdate(dep)!.scope }}</span>
      </div>

      <div v-if="duplicates(dep).length" class="cm-dupes">
        <div class="cm-dupes-title">{{ $t('cli-manage.duplicates', { count: duplicates(dep).length }) }}</div>
        <div v-for="candidate in duplicates(dep)" :key="candidate.resolved_path" class="cm-dupe">
          <code>{{ candidate.resolved_path }}</code>
          <span v-if="candidate.is_primary" class="cm-active">{{ $t('cli-manage.active') }}</span>
          <button v-else class="cm-btn small" @click="useBinary(dep, candidate.path)">
            {{ $t('cli-manage.use-this') }}
          </button>
          <button
            v-if="candidate.removal_command"
            class="cm-btn small danger"
            @click="removeAlternate(candidate.removal_command)"
          >
            {{ $t('cli-manage.remove') }}
          </button>
        </div>
      </div>

      <div class="cm-actions">
        <button
          v-if="updateCommand(dep) && !npmNotWritable(dep)"
          class="cm-btn"
          :class="{ 'cm-update-to': dep.latest_version }"
          data-testid="cli-update-button"
          :disabled="!!maintaining || runBusy || updateBlocked(dep)"
          :title="updateBlocked(dep) ? gateReason(dep) : updateCommand(dep)"
          @click="run(dep, 'update')"
        >
          {{ busy(dep, 'update')
            ? $t('cli-manage.opening')
            : dep.latest_version
              ? $t('cli-manage.update-to', { version: dep.latest_version })
              : $t('cli-manage.update', { command: updateCommand(dep) }) }}
        </button>
        <a v-else-if="dep.docs_url" class="cm-btn link" :href="dep.docs_url" target="_blank" rel="noreferrer">
          {{ $t('cli-manage.update-via-docs') }}
        </a>

        <button v-if="dep.doctor_cmd" class="cm-btn" :disabled="!!maintaining || runBusy" :title="dep.doctor_cmd" @click="run(dep, 'doctor')">
          {{ $t('cli-manage.doctor', { command: dep.doctor_cmd }) }}
        </button>

        <button
          v-if="dep.status === 'missing' && dep.can_install"
          class="cm-btn"
          :disabled="!!maintaining || runBusy"
          @click="installTarget = dep.id"
        >
          {{ $t('cli-manage.install') }}
        </button>
        <!-- An install that is present but misbehaving (or one the launch
             guide was dismissed on) is repaired here by running the vendor's
             own install command again, in a terminal like update/doctor. The
             guided dialog is for missing CLIs: it reads "installed" as done. -->
        <button
          v-else-if="dep.can_install && dep.install_cmd"
          class="cm-btn"
          :disabled="!!maintaining || runBusy"
          :title="dep.install_cmd"
          @click="run(dep, 'install')"
        >
          {{ busy(dep, 'install') ? $t('cli-manage.opening') : $t('cli-manage.reinstall', { command: dep.install_cmd }) }}
        </button>

        <label v-if="dep.autoupdate_env || gated(dep)" class="cm-policy">
          {{ $t('cli-manage.autoupdate') }}
          <select :value="dep.autoupdate_policy" @change="setPolicy(dep, $event)">
            <option value="vendor">{{ $t('cli-manage.policy.vendor') }}</option>
            <option value="manual">{{ $t('cli-manage.policy.manual') }}</option>
          </select>
        </label>
      </div>
      <p v-if="updateCommand(dep) && updateBlocked(dep)" class="cm-gate" data-testid="cli-update-gate">{{ gateReason(dep) }}</p>
      <p v-if="npmNotWritable(dep)" class="cm-gate" data-testid="cli-update-npm-not-writable">
        {{ $t('cli-manage.update-npm-not-writable') }}
      </p>
    </div>

    <!-- The maintenance command running (or last run) from this panel. -->
    <InstallTerminal v-if="activeRun || runFallback" class="cm-terminal" :onboarding="onboarding" />

    <p class="cm-footnote">{{ $t('cli-manage.footnote') }}</p>

    <!-- Same guided flow the spawn dropdown and a 127 exit open, so an install
         started here reports prerequisites, failures and detection alike. -->
    <CliInstallDialog
      v-if="installTarget"
      :backend="backend"
      :dep-id="installTarget"
      origin="settings"
      :sign-in-state="signInStateFor(installTarget)"
      @close="closeInstall"
      @installed="() => void cliProfiles?.refresh()"
      @login="(agentKey: string) => emit('login', agentKey)"
      @vue:mounted="() => nextTick(() => panelRef?.querySelector<HTMLElement>('.ci-dialog .ci-close')?.focus())"
    />
  </div>
</template>

<style scoped>
.cm { display: flex; flex-direction: column; gap: 12px; }
.cm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.cm-title { font-size: var(--font-md); font-weight: 700; margin: 0 0 4px; }
.cm-hint { font-size: var(--font-xs); color: var(--text-muted, #8b95a3); margin: 0; max-width: 52em; }
.cm-message { font-size: var(--font-xs); color: var(--text-muted, #8b95a3); margin: 0; word-break: break-all; }

.cm-row {
  border: 1px solid var(--border-default); border-radius: 10px;
  padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
}
.cm-row-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cm-name { font-weight: 700; font-size: 13.5px; }
.cm-badge { font-size: var(--font-2xs); border-radius: 99px; padding: 1px 8px; background: var(--bg-muted); }
.cm-badge.ok { color: #2b8a3e; }
.cm-badge.missing { color: #8b95a3; }
.cm-badge.outdated { color: #c77400; }
.cm-badge.update-available { color: #1c7ed6; }
.cm-btn.cm-update-to { border-color: var(--success-emphasis); color: var(--success-fg); font-weight: 600; }
.cm-gate { font-size: var(--font-xs); color: var(--text-muted, #8b95a3); margin: 0; }
.cm-version, .cm-method, .cm-scope { font-size: 11.5px; color: var(--text-muted, #8b95a3); }
.cm-method { border: 1px solid var(--border-default); border-radius: 99px; padding: 0 8px; }
.cm-path {
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px;
  color: var(--text-muted, #8b95a3); overflow-x: auto; white-space: nowrap;
}

.cm-update { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--font-xs); }
.cm-update.failed { color: #c0392b; }
.cm-update code { font-size: 11.5px; }

.cm-dupes { display: flex; flex-direction: column; gap: 6px; }
.cm-dupes-title { font-size: var(--font-xs); color: #c77400; }
.cm-dupe { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; }
.cm-dupe code { overflow-x: auto; }
.cm-active { color: var(--text-muted, #8b95a3); }

.cm-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cm-btn {
  font-size: var(--font-xs); padding: 4px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border-default); background: var(--bg-muted);
  color: inherit; text-decoration: none;
}
/* Hover feedback only — colour is left alone so `.cm-btn.danger` keeps its red
 * label. Transition and focus ring come from semantic.css. */
.cm-btn:hover:not(:disabled) { background: var(--bg-hover-strong); border-color: var(--border-strong); }
.cm-btn:disabled { opacity: 0.5; cursor: default; }
.cm-btn.small { padding: 2px 8px; }
.cm-btn.danger { color: #c0392b; }
.cm-policy { display: flex; align-items: center; gap: 6px; font-size: var(--font-xs); margin-left: auto; }
.cm-terminal { margin: 4px 0 8px; }
.cm-footnote { font-size: 11.5px; color: var(--text-muted, #8b95a3); margin: 0; }
</style>
