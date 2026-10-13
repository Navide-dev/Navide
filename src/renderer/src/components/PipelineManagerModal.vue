<script setup lang="ts">
// Pipeline Manager modal: unifies pipeline + stage editing and role management,
// replacing the old Role Manager and Stages windows. Hosted inside the main
// window — the backend connection, theme and notification host belong to the
// host app, so this component only owns the pipeline/stage/role UI.
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import type { TerminalDockPort } from '@navide/terminal'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import { AiCliDock } from '@navide/plugin-shell'
import type { useRoles, Role, RoleUsage } from '../composables/useRoles'
import type { usePipelines, PipelineSummary } from '../composables/usePipelines'
import { useStages } from '../composables/useStages'
import { stageToBackend } from '../data/stages'
import { buildPmAiContext } from '../lib/pmAiContext'
import { aiTerminalPaneId } from '@navide/plugin-shell'
import { backendErrorText } from '../lib/pipelineErrors'
import { usePipelineRunState, type HostRun } from '../composables/usePipelineRunState'
import PipelineEditor from './pipeline/PipelineEditor.vue'
import RolePropertiesEditor, { rolePropertyProblems } from './pipeline/RolePropertiesEditor.vue'
import type { RoleProperty } from '../lib/pipelineGraph'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  terminalPort: TerminalDockPort
  rolesApi: ReturnType<typeof useRoles>
  pipelinesApi: ReturnType<typeof usePipelines>
  /** Workspace the embedded CLI dock spawns in; empty = no workspace open. */
  workspacePath: string
  /** Deep link: jump straight into this pipeline's detail view when opened. */
  initialPipelineId?: string
  /** Visibility. The modal stays MOUNTED while closed (v-show, not v-if) so the
   *  AiCliDock keeps owning its PTY — unmounting would let the backend janitor
   *  reap a CLI the user is still running. */
  open: boolean
  /** The host window's own run, so the editor locks the moment a run starts
   *  here instead of waiting for the first node-state broadcast. */
  hostRun?: HostRun | null
}>()
const emit = defineEmits<{
  (e: 'close'): void
}>()
const { backend, rolesApi, pipelinesApi } = props

const notify = useNotify()
const { t } = useI18n()

const activeTab = ref<'pipelines' | 'roles'>('pipelines')

const statusClass = computed(() => {
  switch (backend.status.value) {
    case 'connected': return 'status-connected'
    case 'connecting':
    case 'starting': return 'status-starting'
    case 'disconnected': return 'status-disconnected'
    default: return 'status-error'
  }
})

// The header used to interpolate the backend's raw status word, so a zh-TW UI
// read "後端 connected". Every BackendStatus gets its own key instead.
const BACKEND_STATE_KEYS: Record<string, string> = {
  starting: 'label.backend-state-starting',
  connecting: 'label.backend-state-connecting',
  connected: 'label.backend-state-connected',
  disconnected: 'label.backend-state-disconnected',
  error: 'label.backend-state-error',
}
const backendStatusLabel = computed(
  () => t(BACKEND_STATE_KEYS[backend.status.value] ?? 'label.backend-state-error')
)

// Esc is owned by the host's `workbench.action.closeModal` stack — a listener
// here would be dead code behind the capture-phase keybinding dispatcher. The
// host calls this first so a nested confirm dialog closes before the modal.
function closeTopLayer(): boolean {
  const openConfirm = sConfirmReset.value || rConfirmDelete.value || rConfirmReset.value
  if (!openConfirm) return !!editorRef.value?.closeTopLayer()
  sConfirmReset.value = false
  rConfirmDelete.value = false
  rConfirmReset.value = false
  return true
}
defineExpose({ closeTopLayer })

// ══════════════════════════════════════════════════════════════════════════════
// PIPELINES TAB — list view (CRUD) + detail view (stage editor)
// ══════════════════════════════════════════════════════════════════════════════

const plView = ref<'list' | 'detail'>('list')
const plEditingId = ref<string>('')
const plNewName = ref('')
const plCreating = ref(false)
const plBusy = ref(false)
const plSummary = ref('')
const plRenamingId = ref('')
const plRenameText = ref('')

// Stage cache scoped to the pipeline being edited: getActivePipelineId feeds
// both refresh() and the stages.changed broadcast filter, so external edits to
// OTHER pipelines never clobber the list shown here.
const stagesApi = useStages(backend, () => plEditingId.value)
const sActiveStages = computed(() => stagesApi.stages.value)
const sError = ref('')
const sConfirmReset = ref(false)
const sSummary = ref('')
const sExportBusy = ref(false)
const sImporting = ref(false)

// The detail view is the graph editor; it owns selection, history and the
// inspector. This component keeps the pipeline-level actions around it.
const editorRef = ref<InstanceType<typeof PipelineEditor> | null>(null)
const runState = usePipelineRunState(backend, () => props.workspacePath, () => props.hostRun ?? null)
const plLocked = computed(() => runState.isRunning(plEditingId.value))

const plCount = computed(() => pipelinesApi.pipelines.value.length)

const plCurrentPipeline = computed(
  () => pipelinesApi.pipelines.value.find((p) => p.id === plEditingId.value) ?? null
)

async function plEnterDetail(id: string): Promise<void> {
  plEditingId.value = id
  plView.value = 'detail'
  sError.value = ''
  sSummary.value = ''
  await stagesApi.refresh(id)
}

function plBackToList(): void {
  plView.value = 'list'
  plEditingId.value = ''
}

/** Pipeline mutations resolve to null/false and leave the reason in
 *  pipelinesApi.error — the backend's running-project veto arrives that way, so
 *  fold it into the toast instead of showing a bare "failed". */
function plFail(key: string): string {
  const reason = pipelinesApi.error.value
    ? backendErrorText(t, { code: pipelinesApi.errorCode.value, message: pipelinesApi.error.value }, key)
    : ''
  return reason ? `${t(key)} — ${reason}` : t(key)
}

async function plCreate(): Promise<void> {
  if (!plNewName.value.trim() || plBusy.value) return
  plBusy.value = true
  try {
    const p = await pipelinesApi.createPipeline(plNewName.value.trim())
    if (p) { plNewName.value = ''; plCreating.value = false; plSummary.value = t('label.created-name', { name: p.name }) }
    else notify.toast(plFail('error.create-failed'), { type: 'error' })
  } finally {
    plBusy.value = false
  }
}

async function plSetActive(id: string): Promise<void> {
  if (plBusy.value) return
  plBusy.value = true
  try {
    const ok = await pipelinesApi.setActivePipeline(id, props.workspacePath)
    if (ok) plSummary.value = t('label.default-pipeline-updated')
    else notify.toast(plFail('error.set-default-failed'), { type: 'error' })
  } finally {
    plBusy.value = false
  }
}

function plStartRename(id: string, currentName: string): void {
  plRenamingId.value = id
  plRenameText.value = currentName
}

async function plConfirmRename(): Promise<void> {
  if (!plRenameText.value.trim() || plBusy.value) return
  plBusy.value = true
  try {
    const ok = await pipelinesApi.renamePipeline(plRenamingId.value, plRenameText.value.trim())
    if (ok) {
      plSummary.value = t('label.renamed')
      plRenamingId.value = ''
    } else {
      notify.toast(plFail('error.rename-failed'), { type: 'error' })
    }
  } finally {
    plBusy.value = false
  }
}

async function plDelete(id: string, name: string): Promise<void> {
  if (!(await notify.confirm(t('hint.delete-pipeline-confirm', { name }), { title: t('label.delete-pipeline-title'), confirmText: t('action.delete') }))) return
  plBusy.value = true
  try {
    const ok = await pipelinesApi.deletePipeline(id, props.workspacePath)
    if (ok) {
      plSummary.value = t('label.deleted-name', { name })
      plBackToList()
    } else {
      notify.toast(plFail('error.delete-failed'), { type: 'error' })
    }
  } finally {
    plBusy.value = false
  }
}

async function plResetBuiltin(p: PipelineSummary): Promise<void> {
  if (!(await notify.confirm(t('hint.reset-pipeline-confirm', { name: p.name }), { title: t('label.reset-pipeline-title'), confirmText: t('action.reset') }))) return
  plBusy.value = true
  try {
    const ok = await pipelinesApi.resetBuiltin(p.id, props.workspacePath)
    if (ok) {
      plSummary.value = t('label.reset-name', { name: p.name })
      if (plView.value === 'detail' && plEditingId.value === p.id) {
        await stagesApi.refresh(p.id)
        await editorRef.value?.reload()
      }
    } else {
      notify.toast(plFail('error.reset-failed'), { type: 'error' })
    }
  } finally {
    plBusy.value = false
  }
}

// Deep link into a pipeline's detail view. Used by the host's
// `initialPipelineId` prop when the modal is opened from a specific pipeline.
// Unknown ids get one list refresh before being ignored.
async function openPipelineDeepLink(pipelineId: string): Promise<void> {
  activeTab.value = 'pipelines'
  if (!pipelinesApi.pipelines.value.some((p) => p.id === pipelineId)) {
    await pipelinesApi.refresh()
    if (!pipelinesApi.pipelines.value.some((p) => p.id === pipelineId)) return
  }
  await plEnterDetail(pipelineId)
}

// Fires when the modal is opened with an id (and on a later id change while it
// stays open); deferred until the pipeline list has loaded.
let deepLinkPending = false
watch(
  () => [props.open, props.initialPipelineId] as const,
  ([open, id], prev) => {
    if (!open) { deepLinkPending = false; return }
    // Only a real closed→open transition resets the view; on the immediate run
    // the state is already fresh and the stage refs below are still in their TDZ.
    const justOpened = !!prev && !prev[0]
    if (!id) {
      // Opened without a deep link. The modal stays mounted between openings so
      // the CLI dock keeps its PTY, so reset the view the way a fresh window did.
      if (justOpened) plBackToList()
      return
    }
    if (!pipelinesApi.isLoaded.value) { deepLinkPending = true; return }
    deepLinkPending = false
    void openPipelineDeepLink(id)
  },
  { immediate: true }
)
watch(
  () => pipelinesApi.isLoaded.value,
  (loaded) => {
    if (!loaded || !deepLinkPending || !props.open) return
    deepLinkPending = false
    if (props.initialPipelineId) void openPipelineDeepLink(props.initialPipelineId)
  }
)

// ══════════════════════════════════════════════════════════════════════════════
// STAGE EDITOR (pipeline detail view)
// ══════════════════════════════════════════════════════════════════════════════

async function sDoReset(): Promise<void> {
  try {
    const resp = await backend.send<{ stages: unknown[] }>(
      'stages.reset', { pipeline_id: plEditingId.value, workspace_path: props.workspacePath }
    )
    sConfirmReset.value = false
    if (!resp.ok) { sError.value = backendErrorText(t, resp.error, 'error.reset-failed'); return }
    sSummary.value = t('label.reset-to-factory-defaults')
    await stagesApi.refresh(plEditingId.value)
    await editorRef.value?.reload()
  } catch (err) {
    sConfirmReset.value = false
    sError.value = err instanceof Error ? err.message : t('error.reset-failed')
  }
}
async function sExport(): Promise<void> {
  if (!window.agentTeam?.saveJson) return
  sExportBusy.value = true
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    // Export the snake_case backend shape so a round-trip import (raw dicts fed
    // back to stages.upsert) preserves short_title / slots[].agent_key etc.
    const envelope = { format_version: 1, exported_at: new Date().toISOString(), stages: sActiveStages.value.map(stageToBackend) }
    const result = await window.agentTeam.saveJson({ title: t('label.export-stages-title'), defaultName: `agent-team-stages-${stamp}.json`, content: JSON.stringify(envelope, null, 2) })
    if (result.ok) sSummary.value = t('label.exported-stages', { count: envelope.stages.length })
  } catch (err) {
    sError.value = t('pipelineEditor.error.export-failed', { message: err instanceof Error ? err.message : String(err) })
  } finally {
    sExportBusy.value = false
  }
}
async function sImport(): Promise<void> {
  if (!window.agentTeam?.openJson) return
  sImporting.value = true; sError.value = ''
  try {
    const result = await window.agentTeam.openJson({ title: t('label.import-stages-title') })
    if (result.ok && result.content) {
      try {
        const parsed = JSON.parse(result.content)
        const raw: unknown[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.stages) ? parsed.stages : [])
        let ok = 0, failed = 0
        let firstFailure = ''
        for (const entry of raw) {
          const s = entry as Record<string, unknown>
          if (!s.id) { failed++; continue }
          const resp = await backend.send(
            'stages.upsert',
            { stage: s, pipeline_id: plEditingId.value, workspace_path: props.workspacePath }
          )
          if (resp.ok) ok++
          else {
            failed++
            if (!firstFailure) firstFailure = backendErrorText(t, resp.error, 'error.save-failed')
          }
        }
        if (firstFailure) sError.value = firstFailure
        sSummary.value = t('label.imported-stages', { count: ok }) + (failed ? t('label.import-failed-count', { count: failed }) : '')
        await stagesApi.refresh(plEditingId.value)
        await editorRef.value?.reload()
      } catch (err) { sError.value = t('error.invalid-json', { message: (err as Error).message }) }
    }
  } finally {
    sImporting.value = false
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ROLES TAB
// ══════════════════════════════════════════════════════════════════════════════

interface DraftRole {
  key: string; label: string; one_line: string; system_prompt: string
  /** The role's declared step fields (the node inspector's form). */
  properties: RoleProperty[]
  isNew: boolean; originalKey: string
}

const rSelectedKey = ref<string | null>(null)
const rDraft = ref<DraftRole | null>(null)
const rSaving = ref(false)
const rError = ref('')
// Stage slots a ROLE_IN_USE rejection blamed. Held beside rError and cleared
// with it: the backend sentence only gives a count, so without these the user
// is told "no" with nowhere to go.
const rErrorUsages = ref<RoleUsage[]>([])
const rConfirmDelete = ref(false)
const rConfirmReset = ref(false)
const rSummary = ref('')
const rImporting = ref(false)
const rExportBusy = ref(false)

const rSorted = computed(() =>
  [...rolesApi.roles.value].sort((a, b) => a.label.localeCompare(b.label))
)

watch(() => rolesApi.roles.value, (rs) => {
  // Never steal the draft while the user is composing a new role: rStartNew()
  // leaves rSelectedKey null, which the first branch would otherwise claim.
  if (rDraft.value?.isNew) return
  if (rs.length > 0 && rSelectedKey.value === null) rSelectKey(rs[0].key)
  else if (rSelectedKey.value && !rs.find((r) => r.key === rSelectedKey.value))
    rSelectKey(rs[0]?.key ?? null)
}, { deep: false })

function rFromRole(r: Role, isNew: boolean): DraftRole {
  return {
    key: r.key, label: r.label, one_line: r.one_line, system_prompt: r.system_prompt,
    properties: JSON.parse(JSON.stringify(r.properties ?? [])) as RoleProperty[],
    isNew, originalKey: isNew ? '' : r.key,
  }
}
function rSelectKey(key: string | null): void {
  rSelectedKey.value = key; rError.value = ''; rErrorUsages.value = []
  if (!key) { rDraft.value = null; return }
  const r = rolesApi.find(key)
  if (r) rDraft.value = rFromRole(r, false)
}
function rStartNew(): void {
  rSelectedKey.value = null; rError.value = ''; rErrorUsages.value = []
  rDraft.value = { key: '', label: '', one_line: '', system_prompt: '# Role: \nYou are a...\n\n# Guidelines:\n1. ...\n\n# Output Format:\n...', properties: [], isNew: true, originalKey: '' }
}

const rIsDirty = computed(() => {
  if (!rDraft.value) return false
  if (rDraft.value.isNew) return true
  const r = rolesApi.find(rDraft.value.originalKey)
  if (!r) return true
  return r.label !== rDraft.value.label || r.one_line !== rDraft.value.one_line || r.system_prompt !== rDraft.value.system_prompt || r.key !== rDraft.value.key || rPropertiesChanged.value
})
/** Whether the draft's step fields differ from the stored role's. */
const rPropertiesChanged = computed(() => {
  const d = rDraft.value
  if (!d) return false
  const stored = d.isNew ? [] : (rolesApi.find(d.originalKey)?.properties ?? [])
  return JSON.stringify(stored) !== JSON.stringify(d.properties)
})
const rPropertiesValid = computed(() =>
  !rDraft.value || rolePropertyProblems(rDraft.value.properties).every((p) => p.length === 0)
)
/** True when the drafted key belongs to a DIFFERENT role than the one being
 *  edited — the state that both disables Save and fails roles.rename. */
const rKeyTaken = computed(() => {
  if (!rDraft.value) return false
  const target = rDraft.value.key.trim()
  if (!target) return false
  const existing = rolesApi.find(target)
  return !!existing && existing.key !== rDraft.value.originalKey
})

const rCanSave = computed(() => {
  if (!rDraft.value) return false
  if (!rDraft.value.key.trim() || !rDraft.value.label.trim() || !rDraft.value.system_prompt.trim()) return false
  // Block if the target key is already taken by a DIFFERENT role (covers both
  // new and rename); rKeyTaken drives the explanation shown beside the field.
  if (rKeyTaken.value) return false
  if (!rPropertiesValid.value) return false
  return rIsDirty.value
})

/** ROLE_KEY_EXISTS is the one rejection with an actionable escape route: the
 *  leftover key is unused by any slot, so deleting it is allowed even though
 *  deleting the original is not. ROLE_NOT_FOUND means the role being renamed is
 *  gone (another window deleted it); the roles.changed broadcast has already
 *  refreshed the list, so say that rather than echoing the backend's English.
 *  Every other code just reports itself. */
function rRenameErrorMessage(
  code: string,
  message: string,
  newKey: string,
  oldKey: string
): string {
  if (code === 'ROLE_KEY_EXISTS') return t('hint.role-key-exists-recover', { key: newKey })
  if (code === 'ROLE_NOT_FOUND') return t('hint.role-not-found-refresh', { key: oldKey })
  return message || t('error.save-failed')
}

async function rSave(): Promise<void> {
  if (!rDraft.value || !rCanSave.value) return
  rSaving.value = true; rError.value = ''; rErrorUsages.value = []; rSummary.value = ''
  const payload = {
    key: rDraft.value.key.trim(), label: rDraft.value.label.trim(), one_line: rDraft.value.one_line.trim(), system_prompt: rDraft.value.system_prompt,
    // Sent only when changed: omitted, the backend keeps what the role has.
    ...(rPropertiesChanged.value ? { properties: rDraft.value.properties } : {}),
  }
  // Capture before awaiting — the draft can be swapped out while requests are in flight.
  const originalKey = rDraft.value.originalKey
  const wasRename = !rDraft.value.isNew && originalKey && originalKey !== payload.key
  try {
    // A key change is a single backend move: it repoints every stage slot naming
    // the role and drops the old key atomically. Doing it here as
    // upsert-then-delete stalled halfway, because roles.delete refuses while a
    // slot still names the role.
    if (wasRename) {
      const outcome = await rolesApi.rename(originalKey, payload)
      if (!outcome.ok) {
        rError.value = rRenameErrorMessage(outcome.code, outcome.message, payload.key, originalKey)
        notify.toast(rError.value, { type: 'error' })
        return
      }
      rSelectKey(outcome.role.key)
      rSummary.value = t('label.saved-name', { name: payload.label })
      const repointed = outcome.repointedPipelineIds.length
      // The rename edited stage data, so say so rather than letting pipelines
      // change under the user silently.
      if (repointed > 0) {
        notify.toast(t('label.role-rename-repointed', { count: repointed }), { type: 'success' })
      }
      return
    }
    // rolesApi.* resolve to null/false on failure instead of throwing, so the
    // catch below never sees backend errors — surface them explicitly.
    const role = await rolesApi.upsert(payload)
    if (!role) {
      rError.value = rolesApi.error.value || t('error.save-failed')
      notify.toast(rError.value, { type: 'error' })
      return
    }
    rSelectKey(role.key)
    rSummary.value = t('label.saved-name', { name: payload.label })
  } catch (err) { rError.value = String((err as Error).message ?? err) }
  finally { rSaving.value = false }
}
async function rDoDelete(): Promise<void> {
  if (!rDraft.value || rDraft.value.isNew) { rConfirmDelete.value = false; return }
  const ok = await rolesApi.remove(rDraft.value.originalKey || rDraft.value.key)
  rConfirmDelete.value = false
  if (ok) rSelectKey(rSorted.value[0]?.key ?? null)
  else {
    rError.value = rolesApi.error.value
    rErrorUsages.value = rolesApi.roleUsages.value
  }
}

/** Jump from a blocking usage to the stage that owns it, so the fix is one
 *  click away. Reuses the deep-link path the host uses. */
async function rGoToUsage(usage: RoleUsage): Promise<void> {
  await openPipelineDeepLink(usage.pipeline_id)
  await nextTick()
  editorRef.value?.focusSlot(usage.stage_id, usage.slot_label)
}
async function rDoReset(): Promise<void> {
  const ok = await rolesApi.reset()
  rConfirmReset.value = false
  rErrorUsages.value = []
  if (ok) rSelectKey(rSorted.value[0]?.key ?? null)
  else rError.value = rolesApi.error.value
}
async function rExport(): Promise<void> {
  if (!window.agentTeam?.saveJson) return
  rExportBusy.value = true
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const envelope = { format_version: 1, exported_at: new Date().toISOString(), roles: rolesApi.roles.value }
    const result = await window.agentTeam.saveJson({ title: t('label.export-roles-title'), defaultName: `agent-team-roles-${stamp}.json`, content: JSON.stringify(envelope, null, 2) })
    if (result.ok) rSummary.value = t('label.exported-roles', { count: envelope.roles.length })
  } catch (err) {
    rError.value = t('pipelineEditor.error.export-failed', { message: err instanceof Error ? err.message : String(err) })
  } finally {
    rExportBusy.value = false
  }
}
async function rImport(): Promise<void> {
  if (!window.agentTeam?.openJson) return
  rImporting.value = true; rError.value = ''; rErrorUsages.value = []
  try {
    const result = await window.agentTeam.openJson({ title: t('label.import-roles-title') })
    if (result.ok && result.content) {
      try {
        const parsed = JSON.parse(result.content)
        const raw: unknown[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.roles) ? parsed.roles : [])
        // Every entry is accounted for: a malformed one or a rejected upsert
        // used to vanish, so "Imported 3" could mean 3 of 10.
        let ok = 0, failed = 0
        let firstFailure = ''
        for (const entry of raw) {
          const e = entry as Record<string, unknown>
          if (!(typeof e?.key === 'string' && e.key && typeof e.system_prompt === 'string')) {
            failed++
            if (!firstFailure) firstFailure = t('pipelineEditor.error.role-entry-invalid', { key: typeof e?.key === 'string' && e.key ? e.key : '?' })
            continue
          }
          const saved = await rolesApi.upsert({
            key: e.key, label: String(e.label ?? e.key), one_line: String(e.one_line ?? ''), system_prompt: e.system_prompt,
            // Exports carry each role's declared fields; dropping them here
            // made an imported role lose its step settings form.
            ...(Array.isArray(e.properties) ? { properties: e.properties } : {}),
          })
          if (saved) ok++
          else {
            failed++
            if (!firstFailure) firstFailure = `${e.key}: ${rolesApi.error.value || t('error.save-failed')}`
          }
        }
        if (firstFailure) rError.value = firstFailure
        rSummary.value = t('label.imported-roles', { count: ok }) + (failed ? t('label.import-failed-count', { count: failed }) : '')
      } catch (err) { rError.value = t('error.invalid-json', { message: (err as Error).message }) }
    }
  } finally {
    rImporting.value = false
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// AI PANEL — shared AiCliDock (embedded CLI PTY) bound to the host's workspace
// ══════════════════════════════════════════════════════════════════════════════

// The host window's current workspace; empty when none is open, which is the
// dock's own "No workspace available" empty state.
const aiWorkspace = computed(() => props.workspacePath)

// Pane id derived per (surface, workspace) so a PM surface on another workspace
// never steals/reaps this one's PTY; stable for a given workspace, which keeps
// useTerminal's localStorage keys (terminal-pty / terminal-scroll) stable
// across close/reopen — that is what lets a still-running CLI be reattached
// instead of respawned. The dock is keyed by it so switching workspace rebuilds
// the dock (its reattach is once per dock life).
const aiPaneId = computed(() => aiTerminalPaneId('pm', aiWorkspace.value))

/** Snapshot of what the user is looking at, injected by the dock after a
 *  fresh spawn (buildPmAiContext stays a pure, unit-tested function). */
function buildAiContext(): string {
  const inDetail = plView.value === 'detail' && !!plEditingId.value
  return buildPmAiContext({
    workspacePath: aiWorkspace.value,
    pipelineName: inDetail ? (plCurrentPipeline.value?.name ?? plEditingId.value) : null,
    stages: inDetail ? sActiveStages.value.map(stageToBackend) : [],
    pipelines: pipelinesApi.pipelines.value.map((p) => ({
      name: p.name,
      stageCount: p.stage_count,
      isDefault: p.id === pipelinesApi.activePipelineId.value,
    })),
    roles: rolesApi.roles.value.map((r) => ({ key: r.key, label: r.label, oneLine: r.one_line })),
  })
}
</script>

<template>
  <Teleport to="body">
    <div v-show="open" class="pm-overlay" role="dialog" aria-modal="true" :aria-label="$t('label.pipeline-manager')">
      <div class="pm-modal">
  <div class="app">
    <header class="top">
      <div class="title">{{ $t('label.pipeline-manager') }}</div>
      <nav class="tabs">
        <button :class="{ active: activeTab === 'pipelines' }" @click="activeTab = 'pipelines'">
          {{ $t('settings.nav.pipelines') }}
        </button>
        <button :class="{ active: activeTab === 'roles' }" @click="activeTab = 'roles'">
          {{ $t('settings.nav.roles') }}
        </button>
      </nav>
      <div class="meta">
        <span class="dot" :class="statusClass"></span>
        <span>{{ $t('label.backend-status', { status: backendStatusLabel }) }}</span>
      </div>
      <button class="pm-close" :title="$t('action.close-esc')" @click="emit('close')">✕</button>
    </header>

    <div class="main-row">
    <div class="tab-col">
    <!-- ── PIPELINES TAB ─────────────────────────────────────────────────── -->
    <div v-show="activeTab === 'pipelines'" class="tab-body">
      <!-- List view -->
      <template v-if="plView === 'list'">
        <div class="toolbar">
          <button class="ghost" :disabled="plBusy" @click="plCreating = !plCreating">{{ $t('action.new-pipeline') }}</button>
          <span v-if="plSummary" class="summary-ok">{{ plSummary }}</span>
          <span v-if="plCount" class="pl-count">{{ $t('label.pipeline-count', { count: plCount }) }}</span>
        </div>
        <div v-if="plCreating" class="pl-create-row">
          <input
            v-model="plNewName" type="text" :placeholder="$t('label.pipeline-name-placeholder')" class="pl-input"
            spellcheck="false"
            @keyup.enter="plCreate" @keyup.escape="plCreating = false; plNewName = ''" />
          <button class="ghost" :disabled="!plNewName.trim() || plBusy" @click="plCreate">{{ $t('action.create') }}</button>
          <button class="ghost" @click="plCreating = false; plNewName = ''">{{ $t('action.cancel') }}</button>
        </div>
        <!-- Four grid cells per row, and the two optional ones (badges, reset)
             live inside always-rendered wrappers — that is what keeps the
             actions column at a fixed width instead of drifting per row. -->
        <ul v-if="plCount" class="pl-list">
          <li
            v-for="p in pipelinesApi.pipelines.value" :key="p.id"
            class="pl-item" :class="{ 'pl-active': p.id === pipelinesApi.activePipelineId.value }"
            role="button" tabindex="0"
            :aria-label="$t('action.open-pipeline-named', { name: p.name })"
            @click="plEnterDetail(p.id)"
            @keydown.enter.prevent="plEnterDetail(p.id)"
            @keydown.space.prevent="plEnterDetail(p.id)">
            <span class="pl-name" v-truncate>{{ p.name }}</span>
            <span class="pl-tags">
              <span v-if="p.id === pipelinesApi.activePipelineId.value" class="pl-badge">{{ $t('label.default') }}</span>
              <span v-if="p.builtin" class="pl-badge pl-badge--builtin">{{ $t('label.builtin') }}</span>
            </span>
            <span class="pl-meta">{{ $t('label.stage-count', { count: p.stage_count }) }}</span>
            <span class="pl-actions">
              <button
                v-if="p.builtin" class="icon-btn" :disabled="plBusy"
                :title="$t('action.reset-factory-stages')" :aria-label="$t('action.reset-factory-stages')"
                @click.stop="plResetBuiltin(p)">↺</button>
              <span class="pl-enter" :title="$t('action.open-pipeline')" aria-hidden="true">›</span>
            </span>
          </li>
        </ul>
        <!-- The backend ships two builtin pipelines, so an empty list means
             "could not read them", not "none exist" — hence three states. -->
        <p v-else-if="pipelinesApi.loading.value" class="pl-state nv-loading nv-loading--inline">
          {{ $t('label.loading-pipelines') }}
        </p>
        <div v-else-if="pipelinesApi.error.value" class="pl-state pl-empty">
          <p class="pl-empty-title">{{ $t('label.pipelines-unreadable') }}</p>
          <p class="pl-empty-body">{{ $t('hint.pipelines-unreadable') }}</p>
          <div class="pl-empty-actions">
            <button class="ghost pl-retry" :disabled="pipelinesApi.loading.value" @click="pipelinesApi.refresh()">
              {{ $t('action.retry') }}
            </button>
          </div>
        </div>
        <div v-else class="pl-state pl-empty">
          <p class="pl-empty-title">{{ $t('label.pipelines-empty') }}</p>
          <p class="pl-empty-body">{{ $t('hint.pipelines-empty') }}</p>
          <div class="pl-empty-actions">
            <button class="ghost pl-empty-create" :disabled="plBusy" @click="plCreating = true">
              {{ $t('action.new-pipeline') }}
            </button>
          </div>
        </div>
        <div v-if="pipelinesApi.pipelinesPath.value" class="pl-source">
          <span>{{ $t('label.pipeline-definition-file') }}</span>
          <span class="pl-source-path" v-truncate>{{ pipelinesApi.pipelinesPath.value }}</span>
        </div>
      </template>

      <!-- Detail view: pipeline header + stage editor -->
      <template v-else>
        <p v-if="sError" class="err-msg pad">{{ sError }}</p>
        <PipelineEditor
          ref="editorRef"
          class="pl-editor"
          :backend="backend"
          :pipeline-id="plEditingId"
          :roles="rolesApi.roles.value"
          :workspace-path="workspacePath"
          :run="runState.run.value"
          :locked="plLocked"
          @leave="emit('close')"
        >
          <template #lead>
            <button class="icon-btn back-btn" :title="$t('action.back')" :aria-label="$t('action.back')" @click="plBackToList">←</button>
            <template v-if="plRenamingId === plEditingId">
              <input
                v-model="plRenameText" class="pl-input pl-rename" spellcheck="false"
                @keyup.enter="plConfirmRename" @keyup.escape="plRenamingId = ''" />
              <button class="ghost tiny" :disabled="plBusy" @click="plConfirmRename">✓</button>
              <button class="ghost tiny" @click="plRenamingId = ''">✕</button>
            </template>
            <h2 v-else class="pl-detail-title">
              <span class="pl-detail-name" v-truncate>{{ plCurrentPipeline?.name ?? plEditingId }}</span>
              <button
                class="icon-btn" :disabled="plBusy" :title="$t('action.rename')"
                @click="plStartRename(plEditingId, plCurrentPipeline?.name ?? '')">✎</button>
            </h2>
            <span v-if="plEditingId === pipelinesApi.activePipelineId.value" class="pl-badge">{{ $t('label.default') }}</span>
          </template>
          <template #trail>
            <div class="toolbar">
              <button class="ghost" :disabled="sExportBusy" @click="sExport">{{ sExportBusy ? '…' : $t('settings.roles.export-json') }}</button>
              <button class="ghost" :disabled="sImporting || plLocked" @click="sImport">{{ sImporting ? '…' : $t('settings.roles.import-json') }}</button>
              <button class="ghost danger-link" :disabled="plLocked" @click="sConfirmReset = true">↺ {{ $t('action.reset-defaults') }}</button>
              <span v-if="sSummary" class="summary-ok">{{ sSummary }}</span>
            </div>
            <div class="pl-detail-actions">
              <button
                v-if="plEditingId !== pipelinesApi.activePipelineId.value" class="ghost" :disabled="plBusy"
                @click="plSetActive(plEditingId)">{{ $t('action.set-as-default') }}</button>
              <button
                class="icon-btn danger-icon"
                :disabled="plBusy || pipelinesApi.pipelines.value.length <= 1"
                :title="pipelinesApi.pipelines.value.length <= 1 ? $t('hint.at-least-one-pipeline') : $t('action.delete-pipeline')"
                @click="plDelete(plEditingId, plCurrentPipeline?.name ?? '')">🗑</button>
            </div>
          </template>
        </PipelineEditor>
      </template>
    </div>

    <!-- ── ROLES TAB ─────────────────────────────────────────────────────── -->
    <div v-show="activeTab === 'roles'" class="tab-body">
      <div class="toolbar">
        <button class="ghost" :disabled="rExportBusy" @click="rExport">{{ rExportBusy ? '…' : $t('settings.roles.export-json') }}</button>
        <button class="ghost" :disabled="rImporting" @click="rImport">{{ rImporting ? '…' : $t('settings.roles.import-json') }}</button>
        <button class="ghost danger-link" @click="rConfirmReset = true">↺ {{ $t('action.reset-defaults') }}</button>
        <span v-if="rSummary" class="summary-ok">{{ rSummary }}</span>
      </div>
      <!-- Toolbar actions (import/export) can fail with no role open; the
           detail pane's error line would then never render. -->
      <p v-if="rError && !rDraft" class="err-msg pad">{{ rError }}</p>
      <div class="split">
        <aside class="split-list">
          <button class="primary new-btn nv-btn nv-btn--primary" @click="rStartNew">{{ $t('settings.roles.new-role') }}</button>
          <ul>
            <li
              v-for="r in rSorted" :key="r.key"
              :class="{ active: rSelectedKey === r.key && rDraft && !rDraft.isNew }"
              @click="rSelectKey(r.key)">
              <div class="row-g"><span class="mono-key">{{ r.key }}</span><span v-if="r.is_default" class="badge">{{ $t('label.default') }}</span></div>
              <div class="item-label">{{ r.label }}</div>
              <div class="item-sub" v-truncate>{{ r.one_line }}</div>
            </li>
          </ul>
        </aside>
        <section v-if="rDraft" class="split-detail">
          <div class="detail-head">
            <h3>{{ rDraft.isNew ? $t('label.new-role') : $t('label.edit-role') }}</h3>
            <div class="row-g gap">
              <button v-if="!rDraft.isNew" class="danger nv-btn nv-btn--danger" @click="rConfirmDelete = true">{{ $t('settings.roles.delete') }}</button>
              <button class="primary nv-btn nv-btn--primary" :disabled="!rCanSave || rSaving" @click="rSave">{{ rSaving ? $t('label.saving') : rDraft.isNew ? $t('action.create') : $t('settings.roles.save') }}</button>
            </div>
          </div>
          <p v-if="rError" class="err-msg">{{ rError }}</p>
          <div v-if="rErrorUsages.length" class="role-usage-block">
            <p class="hint">{{ $t('hint.role-in-use-list') }}</p>
            <ul class="role-usage-list">
              <li v-for="(u, i) in rErrorUsages" :key="i">
                <button class="usage-link" :title="$t('action.go-to-stage')" @click="rGoToUsage(u)">
                  {{ u.pipeline_name || u.pipeline_id }} › {{ u.stage_title || u.stage_id }} › {{ u.slot_label || $t('label.unassigned') }}
                </button>
              </li>
            </ul>
          </div>
          <div class="two-col">
            <div class="field">
              <label class="lbl">{{ $t('settings.roles.key-label') }}</label>
              <input v-model="rDraft.key" type="text" placeholder="lowercase_key" spellcheck="false" :disabled="!rDraft.isNew && rDraft.originalKey === 'pm'" />
              <p v-if="rKeyTaken" class="warn-msg">
                {{ rDraft.isNew ? $t('error.key-exists') : $t('hint.role-key-exists-recover', { key: rDraft.key.trim() }) }}
              </p>
            </div>
            <div class="field">
              <label class="lbl">{{ $t('settings.roles.label-label') }}</label>
              <input v-model="rDraft.label" type="text" :placeholder="$t('label.role-label-placeholder')" spellcheck="false" />
            </div>
          </div>
          <div class="field">
            <label class="lbl">{{ $t('settings.roles.one-line-label') }}</label>
            <input v-model="rDraft.one_line" type="text" :placeholder="$t('label.role-one-line-placeholder')" spellcheck="false" />
          </div>
          <div class="field">
            <label class="lbl">{{ $t('settings.roles.system-prompt-label') }}</label>
            <textarea v-model="rDraft.system_prompt" rows="14" spellcheck="false"></textarea>
            <p class="hint">{{ $t('hint.prompt-chars-new-spawns', { count: rDraft.system_prompt.length }) }}</p>
          </div>
          <RolePropertiesEditor v-model="rDraft.properties" class="role-fields" />
        </section>
        <section v-else class="split-detail empty-detail">
          <p>{{ $t('hint.select-role-or-create') }}</p>
        </section>
      </div>
    </div>
    </div><!-- end tab-col -->

    <!-- Right AI terminal dock (rail toggle + resize + embedded CLI PTY) -->
    <AiCliDock
      :key="aiPaneId"
      width-key="pm-ai-panel-width"
      agent-key-storage-key="pm-ai-agent"
      :pane-id="aiPaneId"
      origin="pipeline-manager"
      :workspace-path="aiWorkspace"
      :terminal-port="terminalPort"
      :build-context="buildAiContext"
    />
    </div><!-- end main-row -->

    <!-- ── Confirm dialogs ───────────────────────────────────────────────── -->
    <div v-if="sConfirmReset" class="modal" @click.self="sConfirmReset = false">
      <div class="modal-card">
        <h3>{{ $t('hint.reset-stages-title') }}</h3>
        <p>{{ $t('hint.reset-stages-warning') }}</p>
        <div class="modal-actions">
          <button class="ghost" @click="sConfirmReset = false">{{ $t('action.cancel') }}</button>
          <button class="danger nv-btn nv-btn--danger" @click="sDoReset">{{ $t('action.reset') }}</button>
        </div>
      </div>
    </div>
    <div v-if="rConfirmDelete" class="modal" @click.self="rConfirmDelete = false">
      <div class="modal-card">
        <h3>{{ $t('settings.roles.delete-confirm-title', { label: rDraft?.label }) }}</h3>
        <p>{{ $t('settings.roles.cannot-undo') }}</p>
        <div class="modal-actions">
          <button class="ghost" @click="rConfirmDelete = false">{{ $t('action.cancel') }}</button>
          <button class="danger nv-btn nv-btn--danger" @click="rDoDelete">{{ $t('action.delete') }}</button>
        </div>
      </div>
    </div>
    <div v-if="rConfirmReset" class="modal" @click.self="rConfirmReset = false">
      <div class="modal-card">
        <h3>{{ $t('settings.roles.reset-confirm-title') }}</h3>
        <p>{{ $t('settings.roles.reset-confirm-body') }}</p>
        <div class="modal-actions">
          <button class="ghost" @click="rConfirmReset = false">{{ $t('action.cancel') }}</button>
          <button class="danger nv-btn nv-btn--danger" @click="rDoReset">{{ $t('action.reset-defaults') }}</button>
        </div>
      </div>
    </div>
  </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* A full-window workspace, not a dialog: a pipeline graph needs the room.
   It sits under the titlebar (window controls stay reachable) and covers
   the rest of the main window; Esc and ✕ still return to it. */
.pm-overlay {
  position: fixed;
  inset: var(--titlebar-height, 0px) 0 0 0;
  background: var(--bg-base);
  z-index: calc(var(--z-modal) + 120);
  display: flex;
  -webkit-app-region: no-drag;
  animation: pm-enter var(--motion-base) var(--ease-out) both;
}
.pm-modal {
  flex: 1;
  min-width: 0;
  height: 100%;
  border-top: 1px solid var(--border-muted);
  overflow: hidden;
}
@keyframes pm-enter { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) { .pm-overlay { animation: none; } }
.pm-close {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-lg);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-control);
  line-height: 1;
}
.pm-close:hover {
  background: var(--bg-muted);
  color: var(--text-bright);
}
/* Surface ladder, matching SettingsModal: chrome = --bg-base, content cards =
   --bg-subtle, deepest well = --bg-inset. This body used to be --bg-inset,
   one step darker than the rest of the modal family. */
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
  color: var(--text-bright);
  font-family: var(--font-ui);
  font-size: var(--font-sm);
  overflow: hidden;
}
.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.title {
  font-size: var(--font-md);
  font-weight: 600;
}
.tabs {
  display: flex;
  gap: 2px;
}
.tabs button {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.tabs button:hover {
  background: var(--bg-muted);
  color: var(--text-bright);
}
.tabs button.active {
  background: var(--accent-subtle);
  color: var(--accent-bright);
  font-weight: 600;
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot.status-connected { background: var(--success-fg); }
.dot.status-starting { background: var(--status-badge-fg, var(--status-starting-fg)); }
.dot.status-disconnected { background: var(--text-secondary); }
.dot.status-error { background: var(--danger-fg); }

.main-row {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}
.tab-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.tab-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 16px;
  flex-shrink: 0;
}
.toolbar button {
  font-size: var(--font-2xs);
  padding: 5px 10px;
}
.summary-ok {
  font-size: var(--font-2xs);
  color: var(--success-fg);
}

/* ── Pipeline list view ───────────────────────────────────────────────────── */
.pl-create-row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 0 16px 8px;
}
.pl-input {
  flex: 0 1 260px;
}
.pl-count {
  margin-left: auto;
  font-size: var(--font-2xs);
  color: var(--text-muted);
}
/* SettingsCard shape: content card on --bg-subtle inside a --border-default
   frame, so the rows read as one block instead of floating on the chrome. */
.pl-list {
  list-style: none;
  margin: 0 16px;
  padding: 0;
  overflow-y: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
/* Grid, not flex: name | badges | stage count | actions. The two optional
   cells used to shift the right edge row by row. */
.pl-item {
  display: grid;
  grid-template-columns: 1fr auto 88px 52px;
  gap: 12px;
  align-items: center;
  min-height: 44px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-muted);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out);
}
.pl-item:last-child {
  border-bottom: none;
}
/* Translucent mix, so the row separator survives the hover. */
.pl-item:hover {
  background: var(--bg-hover);
}
/* Quiet fill plus a locator rail — selection is not carried by colour alone. */
.pl-item.pl-active {
  background: var(--bg-selected);
  box-shadow: inset 3px 0 0 var(--accent-emphasis);
}
/* The house focus ring (semantic.css `.nv-btn:focus-visible`) is an inset
   shadow rather than an outline, and the row needs it for the same reason: the
   list scrolls, so an outline on the first or last row would be clipped. */
.pl-item:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
/* Focus does not cost the selected row its locator rail. */
.pl-item.pl-active:focus-visible {
  box-shadow:
    inset 3px 0 0 var(--accent-emphasis),
    inset 0 0 0 2px var(--accent-focus);
}
.pl-name {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.pl-meta {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  text-align: right;
}
.pl-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
/* Accent, not success: "this is the default pipeline" is neither a completion
   nor a run, and green here collided with the header's connection dot. */
.pl-badge {
  font-size: var(--font-3xs);
  font-weight: 600;
  color: var(--accent-bright);
  background: var(--accent-subtle);
  border: 1px solid var(--accent-muted);
  border-radius: var(--radius-xs);
  padding: 1px 5px;
  white-space: nowrap;
}
.pl-badge--builtin {
  color: var(--text-secondary);
  background: var(--bg-muted);
  border-color: var(--border-default);
}
.pl-enter {
  color: var(--text-muted);
  font-size: var(--font-md);
  line-height: 1;
}
.pl-state {
  margin: 0 16px;
  flex-shrink: 0;
}
.pl-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 20px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  text-align: center;
}
.pl-empty-title {
  margin: 0;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-bright);
}
.pl-empty-body {
  margin: 0;
  max-width: 46ch;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  line-height: var(--lh-base);
}
.pl-empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
/* "Show where the data lives", the same affordance SettingsModal's meta row
   gives every tab. pipelinesPath was already fetched and never displayed. */
.pl-source {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-shrink: 0;
  margin: 8px 16px 0;
  padding: 6px 0 8px;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.pl-source-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

/* ── Pipeline detail header ───────────────────────────────────────────────── */
.role-fields {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-muted);
}
.pl-editor {
  flex: 1;
  min-height: 0;
}
.back-btn {
  font-size: var(--font-md);
  color: var(--text-secondary);
}
.back-btn:hover {
  color: var(--text-bright);
}
.pl-detail-title {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.pl-detail-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Inside the editor's single toolbar row the stage actions sit inline. */
.pl-editor .toolbar {
  padding: 0;
}
.pl-rename {
  flex: 0 1 260px;
}
.pl-detail-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.tiny {
  font-size: var(--font-2xs);
  padding: 3px 7px;
}
.pad {
  padding: 8px 16px;
}

/* ── Split layout (list + editor) ─────────────────────────────────────────── */
.split {
  flex: 1;
  display: grid;
  grid-template-columns: 300px 1fr;
  min-height: 0;
  border-top: 1px solid var(--border-muted);
}
.split-list {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-muted);
  background: var(--bg-base);
  overflow-y: auto;
}
.new-btn {
  margin: 10px;
  flex-shrink: 0;
}
.split-list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.split-list li {
  padding: 9px 12px;
  border-bottom: 1px solid var(--bg-subtle);
  cursor: pointer;
}
.split-list li:hover {
  background: var(--bg-subtle);
}
.split-list li.active {
  background: var(--accent-subtle);
}
.split-detail {
  padding: 14px 18px;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.empty-detail {
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-muted);
}
.detail-head h3 {
  margin: 0;
  font-size: var(--font-row-title);
}
.row-g {
  display: flex;
  align-items: center;
  gap: 6px;
}
.row-g.gap {
  gap: 8px;
}
.mono-key {
  font-family: Menlo, Monaco, monospace;
  font-size: var(--font-3xs);
  color: var(--accent-bright);
  background: var(--bg-muted);
  padding: 1px 6px;
  border-radius: var(--radius-xs);
}
.badge {
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
}
.item-label {
  font-weight: 600;
  margin-top: 2px;
}
.item-sub {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Fields ───────────────────────────────────────────────────────────────── */
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lbl {
  font-size: var(--font-3xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
input[type='text'],
select,
textarea {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  font-family: inherit;
  font-size: var(--font-sm);
  box-sizing: border-box;
  width: 100%;
}
textarea {
  resize: vertical;
  line-height: var(--lh-base);
}
textarea.mono {
  font-family: Menlo, Monaco, monospace;
  font-size: var(--font-xs);
  min-height: 100px;
}
input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--accent-emphasis);
}
input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ── Buttons ──────────────────────────────────────────────────────────────── */
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: var(--font-xs);
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* The family primary is accent blue (.nv-btn--primary). This override cannot
   simply be deleted: scoping raises the bare `button` rule above to
   `button[data-v-x]` (0,1,1), which outranks `.nv-btn--primary` (0,1,0) and
   would repaint these buttons grey. So it stays, pointing at accent tokens. */
button.primary {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
button.primary:not(:disabled):hover {
  background: var(--accent-focus);
  border-color: var(--accent-focus);
}
button.danger {
  background: var(--danger-deep);
  border-color: var(--danger-muted);
  color: var(--text-on-emphasis);
}
button.danger:hover {
  background: var(--danger-muted);
}
button.ghost {
  background: transparent;
}
button.ghost:hover:not(:disabled) {
  background: var(--bg-muted);
}
/* 24px square: the house click target (--icon-btn-md). It used to be
   `padding: 2px 4px`, far under the minimum. */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: var(--icon-btn-md);
  height: var(--icon-btn-md);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  padding: 0;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}
.icon-btn:hover:not(:disabled) {
  background: var(--bg-muted);
  color: var(--text-bright);
}
.icon-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
/* These are not `.nv-icon-btn`, so they do not inherit the family ring; a
   keyboard user has to be able to see which glyph is focused. */
.icon-btn:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.danger-icon {
  color: var(--danger-fg);
}
.danger-link {
  color: var(--danger-fg);
}

/* ── Slots ────────────────────────────────────────────────────────────────── */

/* ── Messages ─────────────────────────────────────────────────────────────── */
.hint {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  margin: 0;
}
.warn-msg {
  color: var(--attention-fg);
  font-size: var(--font-2xs);
  margin: 4px 0 0;
}
.err-msg {
  color: var(--danger-fg);
  font-size: var(--font-xs);
  margin: 0;
}
.role-usage-block {
  margin: 6px 0 0;
}
.role-usage-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.usage-link {
  border: none;
  background: transparent;
  padding: 0;
  color: var(--accent-bright);
  font-size: var(--font-2xs);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.usage-link:hover {
  text-decoration: underline;
}

/* ── Modals ───────────────────────────────────────────────────────────────── */
/* Nested inside .pm-overlay: must sit above the modal shell that
   hosts them, hence a z-index past the shell's own stacking level. */
.modal {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: calc(var(--z-modal) + 121);
}
.modal-card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 20px 22px;
  max-width: 460px;
}
.modal-card h3 {
  margin: 0 0 10px;
  font-size: var(--font-row-title);
}
.modal-card p {
  font-size: var(--font-xs);
  color: var(--text-primary);
  margin: 0 0 14px;
  line-height: 1.6;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
