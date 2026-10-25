<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  EXECUTION_POLICY_MODES,
  isHighRiskExecutionPolicy,
  V2_SYSTEM_NAMESPACES,
  type ExecutionPolicy,
  type ExecutionPolicyMode,
  type PluginSystemNamespace,
} from '@navide/plugin-contracts'
import type {
  ExecutionPolicyApi,
  ExecutionPolicyError,
  ExecutionPolicyOperationResult,
  ExecutionPolicySettingsSnapshot,
  ExecutionPolicySource,
} from '../../../shared/executionPolicy'

const props = defineProps<{
  workspacePath?: string
}>()

const { t, te } = useI18n()
const snapshot = ref<ExecutionPolicySettingsSnapshot | null>(null)
const draft = ref<ExecutionPolicy | null>(null)
const draftBasePolicy = ref<ExecutionPolicy | null>(null)
const draftBaseRevision = ref<number | null>(null)
const selectedSource = ref<ExecutionPolicySource | null>(null)
const shellInput = ref('')
const shellInputError = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const fullConfirmed = ref(false)
const repositoryFullConfirmed = ref(false)
const rebuildArmed = ref(false)
const rebuildConfirmed = ref(false)
const sourceResetArmed = ref(false)
const sourceResetConfirmed = ref(false)
const externalUpdate = ref(false)
let loadSequence = 0
let stopChanged: (() => void) | undefined

const systemNamespaces = [...V2_SYSTEM_NAMESPACES]
const policyModes = [...EXECUTION_POLICY_MODES]

function policyApi(): ExecutionPolicyApi | undefined {
  return window.agentTeam?.executionPolicy
}

function currentWorkspacePath(): string | undefined {
  const workspacePath = props.workspacePath?.trim()
  return workspacePath && workspacePath.length > 0 ? workspacePath : undefined
}

function clonePolicy(policy: ExecutionPolicy): ExecutionPolicy {
  return {
    schemaVersion: policy.schemaVersion,
    mode: policy.mode,
    system: [...policy.system],
    shell: [...policy.shell],
  }
}

function sourceSelectionFor(next: ExecutionPolicySettingsSnapshot): ExecutionPolicySource | null {
  return next.workspace?.selectedSource ?? null
}

function policiesEqual(left: ExecutionPolicy, right: ExecutionPolicy): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.mode === right.mode &&
    left.system.length === right.system.length &&
    left.system.every((item, index) => item === right.system[index]) &&
    left.shell.length === right.shell.length &&
    left.shell.every((item, index) => item === right.shell[index])
}

const draftDirty = computed(() =>
  draft.value !== null && draftBasePolicy.value !== null &&
  !policiesEqual(draft.value, draftBasePolicy.value)
)

function replaceDraftFromSnapshot(next: ExecutionPolicySettingsSnapshot): void {
  snapshot.value = next
  selectedSource.value = sourceSelectionFor(next)
  const source = next.userPolicy ?? next.defaultPolicy
  draft.value = clonePolicy(source)
  draftBasePolicy.value = clonePolicy(source)
  draftBaseRevision.value = next.global.revision
  fullConfirmed.value = false
  shellInputError.value = ''
  externalUpdate.value = false
}

function applySnapshotPreservingDraft(next: ExecutionPolicySettingsSnapshot): void {
  const wasDirty = draftDirty.value
  snapshot.value = next
  selectedSource.value = sourceSelectionFor(next)
  if (!wasDirty) {
    replaceDraftFromSnapshot(next)
    return
  }
  if (draftBaseRevision.value !== next.global.revision) externalUpdate.value = true
}

async function load(options: { replaceDraft?: boolean } = {}): Promise<void> {
  const api = policyApi()
  if (!api) {
    error.value = t('settings.executionPolicy.unavailable')
    return
  }
  const sequence = ++loadSequence
  const replaceDraft = options.replaceDraft ?? !draftDirty.value
  loading.value = true
  if (!externalUpdate.value) error.value = ''
  try {
    const next = await api.inspect(props.workspacePath)
    if (sequence !== loadSequence) return
    if (replaceDraft) replaceDraftFromSnapshot(next)
    else applySnapshotPreservingDraft(next)
  } catch {
    if (sequence === loadSequence) error.value = t('settings.executionPolicy.unavailable')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

const workspaceSnapshot = computed(() => snapshot.value?.workspace ?? null)
const recommendation = computed(() => workspaceSnapshot.value?.recommendation ?? null)
const recommendationIsHighRisk = computed(() => {
  const policy = recommendation.value?.policy
  return !!policy && isHighRiskExecutionPolicy(policy)
})
const repositoryNeedsConfirmation = computed(() => recommendationIsHighRisk.value && !repositoryFullConfirmed.value)
watch([() => props.workspacePath, () => recommendation.value?.fingerprint], () => {
  repositoryFullConfirmed.value = false
}, { flush: 'sync' })
const effectiveSource = computed<ExecutionPolicySource | null>(() => {
  if (workspaceSnapshot.value) return workspaceSnapshot.value.activeSource
  return snapshot.value?.global.state === 'user'
    ? 'user'
    : snapshot.value?.global.state === 'default'
      ? 'default'
      : null
})
const policyMutationAvailable = computed(() => {
  const state = snapshot.value?.recovery.state
  return state === 'missing' || state === 'healthy'
})
const draftIsHighRisk = computed(() => !!draft.value && isHighRiskExecutionPolicy(draft.value))
const canSave = computed(() => {
  if (!draft.value || busy.value || !policyMutationAvailable.value) return false
  return !draftIsHighRisk.value || fullConfirmed.value
})
const hasUserPolicy = computed(() => snapshot.value?.userPolicy !== null && snapshot.value?.userPolicy !== undefined)

function modeLabel(mode: ExecutionPolicyMode): string {
  return t(`settings.executionPolicy.mode.${mode}`)
}

function sourceLabel(source: ExecutionPolicySource): string {
  return t(`settings.executionPolicy.source.${source}`)
}

function recommendationStateLabel(state: NonNullable<typeof recommendation.value>['state']): string {
  return t(`settings.executionPolicy.recommendationState.${state}`)
}

function recoveryStateLabel(state: NonNullable<ExecutionPolicySettingsSnapshot['recovery']>['state']): string {
  return t(`settings.executionPolicy.recoveryState.${state}`)
}

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : t('settings.executionPolicy.none')
}

/** `full` and `denylist` are both high risk but for opposite reasons — one says
 * "everything", the other grants by default — so they must not share one
 * sentence. The acknowledgement text especially: it is what the user attests
 * to. */
function highRiskWarningKey(mode: ExecutionPolicyMode | undefined): string {
  return mode === 'denylist'
    ? 'settings.executionPolicy.denylistWarning'
    : 'settings.executionPolicy.fullWarning'
}

function highRiskConfirmationKey(mode: ExecutionPolicyMode | undefined): string {
  return mode === 'denylist'
    ? 'settings.executionPolicy.denylistConfirmation'
    : 'settings.executionPolicy.fullConfirmation'
}

/** The commands a denylist can still reach. Read from the Host default policy
 * in the snapshot, which the Host builds from HOST_SHELL_EXECUTABLE_ALLOWLIST —
 * the same list the denylist enforcement point intersects against. Never spell
 * the names here: a literal would rot the moment the Host list changes. */
const hostSupportedShellList = computed(() => listOrNone(snapshot.value?.defaultPolicy.shell ?? []))

function setMode(mode: ExecutionPolicyMode): void {
  if (!draft.value) return
  draft.value.mode = mode
  fullConfirmed.value = false
  if (mode === 'full') {
    draft.value.system = []
    draft.value.shell = []
  }
}

function toggleSystem(namespace: PluginSystemNamespace): void {
  if (!draft.value || draft.value.mode === 'full') return
  const next = new Set(draft.value.system)
  if (next.has(namespace)) next.delete(namespace)
  else next.add(namespace)
  draft.value.system = systemNamespaces.filter((item) => next.has(item))
}

function addShell(): void {
  if (!draft.value || draft.value.mode === 'full') return
  shellInputError.value = ''
  const name = shellInput.value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._+-]*$/u.test(name)) {
    shellInputError.value = t('settings.executionPolicy.shellInvalid')
    return
  }
  if (draft.value.shell.includes(name)) {
    shellInputError.value = t('settings.executionPolicy.shellDuplicate', { name })
    return
  }
  draft.value.shell = [...draft.value.shell, name]
  shellInput.value = ''
}

function removeShell(name: string): void {
  if (!draft.value) return
  draft.value.shell = draft.value.shell.filter((item) => item !== name)
}

type OperationKind = 'save' | 'resetUser' | 'source' | 'rebuild' | 'resetSources'

function operationErrorMessage(operationError: ExecutionPolicyError): string {
  const key = `settings.executionPolicy.errors.${operationError.code}`
  return te(key) ? t(key) : operationError.message
}

function applyOperationResult(
  result: ExecutionPolicyOperationResult,
  operation: OperationKind,
): boolean {
  if (!result.ok) {
    error.value = operationErrorMessage(result.error)
    applySnapshotPreservingDraft(result.snapshot)
    if (result.error.code === 'policy-conflict') externalUpdate.value = true
    return false
  }
  if (operation === 'save' || operation === 'resetUser' || operation === 'rebuild') {
    replaceDraftFromSnapshot(result.snapshot)
  } else {
    applySnapshotPreservingDraft(result.snapshot)
  }
  notice.value = t(`settings.executionPolicy.notice.${operation}`)
  return true
}

async function save(): Promise<void> {
  const api = policyApi()
  if (!api || !draft.value || !canSave.value) return
  const expectedRevision = draftBaseRevision.value
  if (expectedRevision === null) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.setUser({
      policy: clonePolicy(draft.value),
      expectedRevision,
      ...(draftIsHighRisk.value ? { highRiskConfirmed: fullConfirmed.value } : {}),
      ...(currentWorkspacePath() ? { workspacePath: currentWorkspacePath() } : {}),
    })
    applyOperationResult(result, 'save')
  } catch {
    error.value = t('settings.executionPolicy.unavailable')
  } finally {
    busy.value = false
  }
}

async function resetUser(): Promise<void> {
  const api = policyApi()
  if (!api) return
  const expectedRevision = snapshot.value?.global.revision
  if (expectedRevision === undefined) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.resetUser(
      {
        expectedRevision,
        ...(currentWorkspacePath() ? { workspacePath: currentWorkspacePath() } : {}),
      },
    )
    applyOperationResult(result, 'resetUser')
  } catch {
    error.value = t('settings.executionPolicy.unavailable')
  } finally {
    busy.value = false
  }
}

async function selectSource(source: ExecutionPolicySource): Promise<void> {
  const api = policyApi()
  const workspacePath = props.workspacePath?.trim()
  if (!api || !workspacePath) return
  const request = source === 'repository'
    ? recommendation.value?.state === 'valid' && recommendation.value.fingerprint
      ? { source, expectedFingerprint: recommendation.value.fingerprint } as const
      : null
    : { source } as const
  if (!request) return
  if (source === 'repository' && repositoryNeedsConfirmation.value) {
    if (snapshot.value) selectedSource.value = sourceSelectionFor(snapshot.value)
    return
  }
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.selectSource({
      workspacePath,
      request,
      ...(source === 'repository' && recommendationIsHighRisk.value
        ? { highRiskConfirmed: repositoryFullConfirmed.value }
        : {}),
    })
    applyOperationResult(result, 'source')
  } catch {
    if (snapshot.value) selectedSource.value = sourceSelectionFor(snapshot.value)
    error.value = t('settings.executionPolicy.unavailable')
  } finally {
    busy.value = false
  }
}

async function rebuild(): Promise<void> {
  const api = policyApi()
  if (!api || !rebuildConfirmed.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.rebuild({
      confirmed: true,
      ...(currentWorkspacePath() ? { workspacePath: currentWorkspacePath() } : {}),
    })
    if (applyOperationResult(result, 'rebuild')) {
      rebuildArmed.value = false
      rebuildConfirmed.value = false
    }
  } catch {
    error.value = t('settings.executionPolicy.unavailable')
  } finally {
    busy.value = false
  }
}

function armRebuild(): void {
  rebuildArmed.value = true
  rebuildConfirmed.value = false
}

function cancelRebuild(): void {
  rebuildArmed.value = false
  rebuildConfirmed.value = false
}

async function resetSourceSelections(): Promise<void> {
  const api = policyApi()
  if (!api || !sourceResetConfirmed.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.resetSourceSelections({
      confirmed: true,
      ...(currentWorkspacePath() ? { workspacePath: currentWorkspacePath() } : {}),
    })
    if (applyOperationResult(result, 'resetSources')) {
      sourceResetArmed.value = false
      sourceResetConfirmed.value = false
    }
  } catch {
    error.value = t('settings.executionPolicy.unavailable')
  } finally {
    busy.value = false
  }
}

function armSourceReset(): void {
  sourceResetArmed.value = true
  sourceResetConfirmed.value = false
}

function cancelSourceReset(): void {
  sourceResetArmed.value = false
  sourceResetConfirmed.value = false
}

async function reloadLatest(): Promise<void> {
  await load({ replaceDraft: true })
}

onMounted(() => {
  stopChanged = policyApi()?.onChanged(() => { void load({ replaceDraft: false }) })
  void load({ replaceDraft: true })
})

onUnmounted(() => stopChanged?.())
watch(() => props.workspacePath, () => { void load({ replaceDraft: !draftDirty.value }) })
</script>

<template>
  <div class="execution-policy-pane">
    <p v-if="loading" class="ep-loading">{{ $t('settings.executionPolicy.loading') }}</p>
    <p v-if="error" class="ep-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ep-notice" role="status">{{ notice }}</p>
    <div v-if="externalUpdate" class="ep-conflict" role="alert">
      <span>{{ $t('settings.executionPolicy.externalUpdate') }}</span>
      <button type="button" class="nv-btn nv-btn--sm" :disabled="busy" @click="reloadLatest">
        {{ $t('settings.executionPolicy.reloadLatest') }}
      </button>
    </div>

    <section class="ep-section ep-effective" data-section="effective-policy">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.effectiveTitle') }}</h2>
        <span v-if="workspaceSnapshot" class="ep-status" :class="`ep-status-${workspaceSnapshot.status}`">
          {{ $t(`settings.executionPolicy.status.${workspaceSnapshot.status}`) }}
        </span>
      </div>
      <p v-if="!workspaceSnapshot" class="ep-hint">{{ $t('settings.executionPolicy.noWorkspace') }}</p>
      <template v-else>
        <p class="ep-summary">
          {{ $t('settings.executionPolicy.effectiveSource') }}:
          <strong>{{ effectiveSource ? sourceLabel(effectiveSource) : $t('settings.executionPolicy.status.unavailable') }}</strong>
          · {{ $t('settings.executionPolicy.modeLabel') }}: <strong>{{ modeLabel(workspaceSnapshot.policy.mode) }}</strong>
        </p>
        <div class="ep-policy-card ep-effective-policy">
          <div><span class="ep-k">{{ $t('settings.executionPolicy.systemLabel') }}</span><span class="ep-v">{{ listOrNone(workspaceSnapshot.policy.system) }}</span></div>
          <div><span class="ep-k">{{ $t('settings.executionPolicy.shellLabel') }}</span><span class="ep-v">{{ listOrNone(workspaceSnapshot.policy.shell) }}</span></div>
        </div>
        <p v-if="workspaceSnapshot.status !== 'active'" class="ep-warning" role="alert">
          {{ $t(`settings.executionPolicy.statusDetail.${workspaceSnapshot.status}`) }}
        </p>
      </template>
    </section>

    <section v-if="snapshot" class="ep-section" data-section="policy-source">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.sourceTitle') }}</h2>
      </div>
      <p class="ep-hint">{{ $t('settings.executionPolicy.sourceHint') }}</p>
      <div class="ep-source-list">
        <label v-for="source in (['default', 'user', 'repository'] as ExecutionPolicySource[])" :key="source" class="ep-source-option">
          <input
            type="radio"
            name="execution-policy-source"
            :value="source"
            v-model="selectedSource"
            :disabled="busy || !workspaceSnapshot || (source === 'user' && !hasUserPolicy) || (source === 'repository' && (recommendation?.state !== 'valid' || repositoryNeedsConfirmation))"
            @change="selectSource(source)"
          />
          <span>
            <strong>{{ sourceLabel(source) }}</strong>
            <small v-if="source === 'repository' && recommendation">{{ recommendationStateLabel(recommendation.state) }}</small>
          </span>
        </label>
      </div>
      <p v-if="!workspaceSnapshot" class="ep-hint">{{ $t('settings.executionPolicy.sourceNeedsWorkspace') }}</p>
      <p v-if="snapshot.sourceRecovery.state === 'corrupt'" class="ep-warning" role="alert">
        {{ $t('settings.executionPolicy.sourceCorruptHint') }}
      </p>
      <p v-else-if="snapshot.sourceRecovery.state === 'unsafe-entry' || snapshot.sourceRecovery.state === 'unavailable'" class="ep-warning ep-manual-recovery" role="alert">
        {{ $t('settings.executionPolicy.sourceManualRecoveryHint') }}
      </p>
      <ul v-if="snapshot.sourceRecovery.unsafePaths.length" class="ep-path-list">
        <li v-for="path in snapshot.sourceRecovery.unsafePaths" :key="path"><code>{{ path }}</code></li>
      </ul>
      <button
        v-if="snapshot.sourceRecovery.canReset && !sourceResetArmed"
        class="ep-reset-sources nv-btn nv-btn--sm"
        :disabled="busy"
        type="button"
        @click="armSourceReset"
      >{{ $t('settings.executionPolicy.resetSourceSelections') }}</button>
      <form v-if="sourceResetArmed" class="ep-source-reset-confirm" role="dialog" aria-modal="true" @submit.prevent="resetSourceSelections">
        <p>{{ $t('settings.executionPolicy.resetSourceSelectionsBody') }}</p>
        <label>
          <input v-model="sourceResetConfirmed" type="checkbox" class="nv-check" />
          {{ $t('settings.executionPolicy.resetSourceSelectionsCheck') }}
        </label>
        <div class="ep-actions">
          <button type="submit" class="nv-btn nv-btn--danger nv-btn--sm" :disabled="!sourceResetConfirmed || busy">{{ $t('settings.executionPolicy.resetSourceSelectionsConfirm') }}</button>
          <button type="button" class="nv-btn nv-btn--sm" @click="cancelSourceReset">{{ $t('settings.executionPolicy.cancel') }}</button>
        </div>
      </form>
    </section>

    <section v-if="recommendation" class="ep-section" data-section="repository-recommendation">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.recommendationTitle') }}</h2>
        <span class="ep-untrusted">{{ $t('settings.executionPolicy.untrusted') }}</span>
      </div>
      <p class="ep-hint">{{ $t('settings.executionPolicy.recommendationHint') }}</p>
      <p class="ep-recommendation-state">{{ recommendationStateLabel(recommendation.state) }}</p>
      <div v-if="recommendation.policy" class="ep-policy-card ep-recommendation-policy">
        <div><span class="ep-k">{{ $t('settings.executionPolicy.modeLabel') }}</span><span class="ep-v">{{ modeLabel(recommendation.policy.mode) }}</span></div>
        <div><span class="ep-k">{{ $t('settings.executionPolicy.systemLabel') }}</span><span class="ep-v">{{ listOrNone(recommendation.policy.system) }}</span></div>
        <div><span class="ep-k">{{ $t('settings.executionPolicy.shellLabel') }}</span><span class="ep-v">{{ listOrNone(recommendation.policy.shell) }}</span></div>
      </div>
      <div v-if="recommendation.state === 'valid' && recommendationIsHighRisk" class="ep-warning">
        <p>{{ $t(highRiskWarningKey(recommendation.policy?.mode)) }}</p>
        <label>
          <input v-model="repositoryFullConfirmed" type="checkbox" class="ep-repository-full-confirmation nv-check" />
          {{ $t(highRiskConfirmationKey(recommendation.policy?.mode)) }}
        </label>
      </div>
      <div v-if="recommendation.state === 'valid' && recommendation.fingerprint && workspaceSnapshot?.selectedSource !== 'repository'" class="ep-accept-row">
        <button
          class="ep-accept-recommendation nv-btn"
          :disabled="busy || repositoryNeedsConfirmation"
          @click="selectSource('repository')"
        >{{ $t('settings.executionPolicy.acceptRecommendation') }}</button>
      </div>
    </section>

    <section v-if="snapshot && draft" class="ep-section" data-section="user-policy">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.userTitle') }}</h2>
        <span class="ep-readonly" v-if="!hasUserPolicy">{{ $t('settings.executionPolicy.notCreated') }}</span>
      </div>
      <p class="ep-hint">{{ $t('settings.executionPolicy.userHint') }}</p>
      <div class="ep-mode-list" role="radiogroup" :aria-label="$t('settings.executionPolicy.modeLabel')">
        <label v-for="mode in policyModes" :key="mode" class="ep-mode-option" :data-mode="mode">
          <input
            type="radio"
            name="execution-policy-mode"
            :value="mode"
            :checked="draft.mode === mode"
            @change="setMode(mode)"
          />
          <span>{{ modeLabel(mode) }}</span>
        </label>
      </div>

      <div v-if="draftIsHighRisk" class="ep-full-warning" role="alert">
        {{ $t(highRiskWarningKey(draft.mode)) }}
        <label class="ep-confirm-label">
          <input v-model="fullConfirmed" type="checkbox" class="ep-full-confirmation nv-check" />
          {{ $t(highRiskConfirmationKey(draft.mode)) }}
        </label>
      </div>

      <template v-if="draft.mode !== 'full'">
        <div class="ep-editor-block">
          <h3>{{ $t(`settings.executionPolicy.${draft.mode === 'denylist' ? 'systemDenylistLabel' : 'systemAllowlistLabel'}`) }}</h3>
          <p class="ep-hint">{{ $t(`settings.executionPolicy.${draft.mode === 'denylist' ? 'systemDenylistHint' : 'systemAllowlistHint'}`) }}</p>
          <div class="ep-checkbox-grid">
            <label v-for="namespace in systemNamespaces" :key="namespace">
              <input
                type="checkbox"
                class="nv-check"
                :checked="draft.system.includes(namespace)"
                :data-system="namespace"
                @change="toggleSystem(namespace)"
              />
              <code>{{ namespace }}</code>
            </label>
          </div>
        </div>
        <div class="ep-editor-block">
          <h3>{{ $t(`settings.executionPolicy.${draft.mode === 'denylist' ? 'shellDenylistLabel' : 'shellAllowlistLabel'}`) }}</h3>
          <p class="ep-hint">{{ $t(`settings.executionPolicy.${draft.mode === 'denylist' ? 'shellDenylistHint' : 'shellAllowlistHint'}`) }}</p>
          <p v-if="draft.mode === 'denylist'" class="ep-hint ep-shell-scope">
            {{ $t('settings.executionPolicy.shellDenylistScope', { executables: hostSupportedShellList }) }}
          </p>
          <form class="ep-shell-add" @submit.prevent="addShell">
            <input
              v-model="shellInput"
              class="nv-input"
              :aria-label="$t(`settings.executionPolicy.${draft.mode === 'denylist' ? 'shellDenylistLabel' : 'shellAllowlistLabel'}`)"
              :placeholder="$t('settings.executionPolicy.shellPlaceholder')"
              :aria-invalid="Boolean(shellInputError)"
              pattern="[A-Za-z0-9][A-Za-z0-9._+-]*"
            />
            <button type="submit" class="nv-btn" :disabled="!shellInput.trim()">{{ $t('settings.executionPolicy.add') }}</button>
          </form>
          <p v-if="shellInputError" class="ep-error" role="alert">{{ shellInputError }}</p>
          <div v-if="draft.shell.length" class="ep-chip-list">
            <span v-for="name in draft.shell" :key="name" class="ep-chip">
              <code>{{ name }}</code>
              <button type="button" :aria-label="$t('settings.executionPolicy.removeShell', { name })" @click="removeShell(name)">×</button>
            </span>
          </div>
          <p v-else class="ep-empty">{{ $t('settings.executionPolicy.none') }}</p>
        </div>
      </template>

      <div class="ep-actions">
        <button class="ep-save nv-btn nv-btn--primary" :disabled="!canSave" @click="save">{{ $t('settings.executionPolicy.save') }}</button>
        <button class="ep-reset nv-btn" :disabled="busy || !hasUserPolicy || !policyMutationAvailable" @click="resetUser">{{ $t('settings.executionPolicy.resetUser') }}</button>
      </div>
    </section>

    <section class="ep-section" data-section="host-default">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.hostDefaultTitle') }}</h2>
        <span class="ep-readonly">{{ $t('settings.executionPolicy.readOnly') }}</span>
      </div>
      <p class="ep-hint">{{ $t('settings.executionPolicy.hostDefaultHint') }}</p>
      <div v-if="snapshot" class="ep-policy-card">
        <div><span class="ep-k">{{ $t('settings.executionPolicy.modeLabel') }}</span><span class="ep-v">{{ modeLabel(snapshot.defaultPolicy.mode) }}</span></div>
        <div><span class="ep-k">{{ $t('settings.executionPolicy.systemLabel') }}</span><span class="ep-v">{{ listOrNone(snapshot.defaultPolicy.system) }}</span></div>
        <div><span class="ep-k">{{ $t('settings.executionPolicy.shellLabel') }}</span><span class="ep-v">{{ listOrNone(snapshot.defaultPolicy.shell) }}</span></div>
      </div>
    </section>

    <section v-if="snapshot" class="ep-section" data-section="recovery">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.recoveryTitle') }}</h2>
        <span class="ep-status" :class="`ep-status-${snapshot.recovery.state}`">{{ recoveryStateLabel(snapshot.recovery.state) }}</span>
      </div>
      <p v-if="snapshot.recovery.state === 'corrupt'" class="ep-warning" role="alert">
        {{ $t('settings.executionPolicy.corruptHint') }}
      </p>
      <p v-else-if="snapshot.recovery.state === 'unsafe-entry' || snapshot.recovery.state === 'directory-unsafe' || snapshot.recovery.state === 'directory-unavailable'" class="ep-warning ep-manual-recovery" role="alert">
        {{ $t('settings.executionPolicy.manualRecoveryHint') }}
      </p>
      <ul v-if="snapshot.recovery.unsafePaths.length" class="ep-path-list">
        <li v-for="path in snapshot.recovery.unsafePaths" :key="path"><code>{{ path }}</code></li>
      </ul>
      <button v-if="snapshot.recovery.canRebuild && !rebuildArmed" class="ep-rebuild nv-btn nv-btn--sm" :disabled="busy" @click="armRebuild">
        {{ $t('settings.executionPolicy.rebuild') }}
      </button>
      <button
        v-if="snapshot.recovery.state === 'unsafe-entry' || snapshot.recovery.state === 'directory-unsafe' || snapshot.recovery.state === 'directory-unavailable' || snapshot.sourceRecovery.state === 'unsafe-entry' || snapshot.sourceRecovery.state === 'unavailable'"
        class="ep-recheck nv-btn nv-btn--sm"
        :disabled="busy"
        type="button"
        @click="reloadLatest"
      >{{ $t('settings.executionPolicy.recheck') }}</button>
      <form v-if="rebuildArmed" class="ep-rebuild-confirm" @submit.prevent="rebuild">
        <p>{{ $t('settings.executionPolicy.rebuildConfirmBody') }}</p>
        <label><input v-model="rebuildConfirmed" type="checkbox" class="nv-check" /> {{ $t('settings.executionPolicy.rebuildConfirmCheck') }}</label>
        <div class="ep-actions">
          <button type="submit" class="nv-btn nv-btn--danger nv-btn--sm" :disabled="!rebuildConfirmed || busy">{{ $t('settings.executionPolicy.rebuildConfirm') }}</button>
          <button type="button" class="nv-btn nv-btn--sm" @click="cancelRebuild">{{ $t('settings.executionPolicy.cancel') }}</button>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.execution-policy-pane {
  /* The Extensions page that hosts this pane owns the scroll, so this is a
     plain block: a second scroller here would split one page into two. */
  padding: 0 22px var(--space-2);
  font-size: var(--font-sm);
  color: var(--text-primary);
}
/* Each part of the policy is a settings card: a row with its title on the left
   and its state on the right, then its description and controls, with
   hairlines between sub-rows — the same grammar as the other Settings pages. */
.ep-section {
  margin: 0;
  padding: var(--space-4) 0;
  border-top: 1px solid var(--border-muted);
}
.ep-section.ep-effective { border-top: 0; padding-top: var(--space-1); }
/* Sections are divided by hairlines, Linear-style; the one part the user edits
   is the page's single card, with the accent edge. */
[data-section='user-policy'] {
  margin: var(--space-2) 0 var(--space-4);
  padding: var(--space-row-y) var(--space-row-x);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  box-shadow: inset 3px 0 0 var(--accent-emphasis);
}
[data-section='user-policy'] + .ep-section { border-top: 0; }
.ep-effective {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px var(--space-5);
}
.ep-effective > .ep-section-heading,
.ep-effective > .ep-warning,
.ep-effective > .ep-hint { flex-basis: 100%; }
.ep-effective > .ep-summary { margin: 0; }
.ep-effective > .ep-effective-policy { flex-basis: 100%; margin-top: var(--space-2); margin-bottom: 0; }
.ep-section:last-child { margin-bottom: 0; }
/* A healthy store is a line, not a card: it only becomes a card with something to say. */
.ep-section[data-section='recovery']:not(:has(.ep-warning, .ep-path-list, form, button)) {
  padding-block: var(--space-1);
  border-color: transparent;
  background: transparent;
}
.ep-accept-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.ep-section-heading { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-bottom: 2px; }
/* The section's state sits right beside its title. */
.ep-section h2 { margin: 0; font-size: var(--font-row-title); font-weight: 600; color: var(--text-bright); }
.ep-section h3 { margin: 0 0 2px; font-size: var(--font-sm); font-weight: 600; color: var(--text-bright); }
.ep-hint, .ep-summary, .ep-recommendation-state, .ep-empty {
  margin: 2px 0 var(--space-3);
  color: var(--text-secondary);
  font-size: var(--font-row-desc);
  line-height: var(--lh-base);
}
.ep-section > :last-child { margin-bottom: 0; }
.ep-summary { font-size: var(--font-sm); color: var(--text-primary); }
.ep-summary strong { color: var(--text-bright); font-weight: 600; }
.ep-loading, .ep-notice, .ep-error { margin: 0 0 var(--space-3); font-size: var(--font-xs); }
.ep-error, .ep-warning { color: var(--danger-fg); }
.ep-warning { font-size: var(--font-xs); line-height: var(--lh-base); }
.ep-notice { color: var(--success-fg); }
/* Small status words beside a heading: a quiet pill, coloured by meaning. */
.ep-readonly, .ep-untrusted, .ep-status {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 600;
}
/* Untrusted is "not yet checked", a caution; risk and danger tones stay for real risk. */
.ep-untrusted { background: var(--attention-subtle); color: var(--attention-fg); }
/* Every button on the page has a 32px target. */
.execution-policy-pane .nv-btn { min-height: var(--control-h-lg); }
/* An offset ring that also shows on the filled Save button (the house ring is inset). */
.execution-policy-pane .nv-btn:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 2px; }
.ep-status-active, .ep-status-healthy { background: var(--success-subtle); color: var(--success-fg); }
.ep-status-corrupt, .ep-status-stale, .ep-status-unavailable, .ep-status-unsafe-entry, .ep-status-directory-unsafe, .ep-status-directory-unavailable { background: var(--risk-subtle); color: var(--risk-fg); }
/* Read-only policies as definition rows: the field on the left, its value on
   the right, hairlines between — the settings row, read-only. */
.ep-policy-card {
  display: grid;
  margin: 0 0 var(--space-3);
  font-size: var(--font-sm);
  line-height: var(--lh-base);
}
.ep-policy-card > div {
  display: grid;
  grid-template-columns: minmax(140px, 220px) minmax(0, 1fr);
  gap: var(--space-3);
  padding: 6px 0;
  border-top: 1px solid var(--border-muted);
}
.ep-policy-card .ep-k { color: var(--text-secondary); }
.ep-policy-card .ep-v { color: var(--text-primary); font-family: var(--font-mono); font-size: var(--font-xs); }
.ep-rebuild-confirm, .ep-source-reset-confirm {
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-card);
  background: var(--danger-subtle);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}
.ep-rebuild-confirm p, .ep-source-reset-confirm p { margin-top: 0; }
.ep-rebuild-confirm label, .ep-source-reset-confirm label { display: flex; align-items: center; gap: var(--space-2); }
.ep-conflict {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--risk-muted);
  border-radius: var(--radius-card);
  background: var(--risk-subtle);
  color: var(--text-bright);
  font-size: var(--font-xs);
}
.ep-conflict button { flex: 0 0 auto; }
.ep-recommendation-policy { margin-top: var(--space-2); }
/* Mode and source are segmented controls: one bordered strip, a segment per
   choice, the checked one tinted. The radio stays in the DOM for keyboard and
   assistive tech; the segment draws its focus. */
.ep-mode-list, .ep-source-list {
  display: inline-flex;
  flex-wrap: wrap;
  max-width: 100%;
  margin: var(--space-1) 0 var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  overflow: hidden;
}
.ep-mode-option, .ep-source-option {
  position: relative;
  display: flex;
  align-items: center;
  min-height: var(--control-h-lg);
  padding: 4px 14px;
  border-left: 1px solid var(--border-default);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.ep-mode-option:first-child, .ep-source-option:first-child { border-left: 0; }
.ep-mode-option:hover, .ep-source-option:hover:not(:has(input:disabled)) { background: var(--bg-hover); }
.ep-mode-option:has(input:checked), .ep-source-option:has(input:checked) {
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-weight: 600;
}
.ep-mode-option:has(input:focus-visible), .ep-source-option:has(input:focus-visible) {
  outline: 2px solid var(--accent-focus);
  outline-offset: -2px;
}
.ep-source-option:has(input:disabled) { cursor: not-allowed; opacity: 0.55; }
.ep-mode-option input, .ep-source-option input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}
.ep-source-option span { display: flex; flex-direction: column; gap: 0; min-width: 0; }
.ep-source-option strong { font-weight: inherit; }
.ep-source-option small { color: var(--text-secondary); font-size: var(--font-2xs); font-weight: 400; }
.ep-full-warning, .ep-warning:has(label) {
  margin: 0 0 var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-left: 2px solid var(--risk-fg);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--risk-subtle);
  color: var(--text-primary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}
.ep-warning:has(label) p { margin: 0; }
.ep-confirm-label, .ep-warning:has(label) label { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); font-weight: 600; }
/* The allowlist and shell parts are sub-rows of the user policy card. */
.ep-editor-block {
  margin: 0 calc(-1 * var(--space-row-x)) var(--space-3);
  padding: var(--space-3) var(--space-row-x) 0;
  border-top: 1px solid var(--border-muted);
}
.ep-editor-block .ep-hint { margin-bottom: var(--space-2); }
.ep-checkbox-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-5);
}
.ep-checkbox-grid label { display: flex; gap: var(--space-2); align-items: center; min-height: var(--control-h-sm); cursor: pointer; }
.ep-checkbox-grid code, .ep-chip code { font-family: var(--font-mono); font-size: var(--font-xs); }
.ep-shell-add { display: flex; gap: var(--space-2); }
.ep-shell-add input { flex: 0 1 240px; min-width: 0; }
.ep-chip-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--space-2); }
.ep-chip {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  height: 24px;
  padding: 0 2px 0 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: var(--bg-base);
}
.ep-chip button {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ep-chip button { position: relative; }
/* The visible circle stays small inside the chip; the hit area is 32px. */
.ep-chip button::after { content: ''; position: absolute; inset: -6px; }
.ep-chip button:hover { background: var(--bg-hover-strong); color: var(--text-bright); }
.ep-chip button:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.ep-empty { margin-top: var(--space-2); font-style: italic; }
.ep-path-list { margin: var(--space-2) 0 var(--space-3); padding-left: 20px; color: var(--text-secondary); font-size: var(--font-xs); }
.ep-path-list code { overflow-wrap: anywhere; }
.ep-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
.ep-recheck { margin-left: var(--space-2); }
</style>
