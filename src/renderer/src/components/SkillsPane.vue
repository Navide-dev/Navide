<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'
import ToggleSwitch from './settings/ToggleSwitch.vue'

type Backend = ReturnType<typeof useBackend>

interface SkillSummary {
  name: string
  description: string
  enabled: boolean
  valid?: boolean
  nativeConflict?: boolean
  /** Agent keys this skill is restricted to; null = every wired agent. */
  targets: string[] | null
  /** Created by Navide (editable, deletable) vs. put in the shared root by the user. */
  managed: boolean
  /** Original location, when this skill was migrated from a CLI's own directory. */
  migratedFrom: string | null
  /** Managed skill whose files stay on this device; only its settings sync. */
  syncTooLarge?: boolean
  /** Managed skill too large for one sync record whose files travel as blobs instead. */
  syncViaBlobs?: boolean
  /** A blob upload or download of this skill's files in flight, when there is one. */
  syncTransfer?: SyncTransfer | null
  path?: string
}

interface SyncTransfer {
  direction: 'upload' | 'download'
  done: number
  total: number
}

function normalizeTransfer(value: unknown): SyncTransfer | null {
  if (!isRecord(value) || (value.direction !== 'upload' && value.direction !== 'download')) return null
  const done = Number(value.done)
  const total = Number(value.total)
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null
  return { direction: value.direction, done, total }
}

/**
 * A skill a CLI keeps in its own directory. Read-only reflection: Navide
 * lists it and can deliver it to *other* agents, but never edits or moves it.
 */
interface NativeSkill {
  name: string
  description: string
  /** Root it was found under, e.g. "copilot". */
  source: string
  /** Agent that already reads it without Navide's help. */
  ownerAgent: string
  path: string
  /** Resolved directory — the identity, since names collide across roots. */
  realPath: string
  aliases: string[]
  valid: boolean
  error: string
  /** Agents the user chose to deliver it to; opt-in, empty by default. */
  targets: string[]
}

/** One CLI vendor and what the managed library can do with it. */
interface SkillAgent {
  key: string
  label: string
  state: 'wired' | 'planned' | 'unsupported'
  /** Discovers ~/.agents/skills itself: shared skills reach it with no delivery. */
  readsSharedRoot: boolean
}

/** One matrix row: a shared skill or a native one, behind one interface. */
type MatrixRow =
  | { kind: 'shared'; key: string; skill: SkillSummary }
  | { kind: 'native'; key: string; skill: NativeSkill }

interface SkillAttachment {
  name: string
  path?: string
}

interface SkillDraft extends SkillSummary {
  revision: string | null
  body: string
  userInvocable: boolean
  disableModelInvocation: boolean
  allowedTools: string
  disallowedTools: string
  model: string
  effort: string
  context: string
  attachments: SkillAttachment[]
  fieldKeys: Set<string>
}

interface ResponseLike {
  payload?: unknown
  error?: { code?: string; message?: string } | null
}

const props = defineProps<{ backend: Backend }>()
const { t } = useI18n()

const skills = ref<SkillSummary[]>([])
const nativeSkills = ref<NativeSkill[]>([])
const agents = ref<SkillAgent[]>([])
/** Whether the user has once allowed writes into ~/.agents/skills. */
const writeConsented = ref(false)
/** Two views over one dataset: browse (cards) and route (matrix). */
const view = ref<'browse' | 'route'>('browse')
/** Source filter shared by both views: 'all' | 'shared' | a native source key. */
const sourceFilter = ref('all')
const rootPath = ref('')
/** Name of the shared skill loaded into the editor draft, if any. */
const selectedName = ref('')
/** Row key of whatever is open in the detail drawer (shared or native). */
const selectedKey = ref('')
const draft = ref<SkillDraft | null>(null)
const savedDraft = ref('')
const draftDirty = computed(() => draft.value !== null && draftFingerprint(draft.value) !== savedDraft.value)
const query = ref('')
const loading = ref(false)
const mutating = ref(false)
const selecting = ref(false)
const busy = computed(() => mutating.value || selecting.value)
const error = ref('')
const conflict = ref(false)
const creating = ref(false)
const newName = ref('')
const newDescription = ref('')

function draftFingerprint(value: SkillDraft): string {
  return JSON.stringify([
    value.name, value.description, value.body, value.userInvocable,
    value.disableModelInvocation, value.allowedTools, value.disallowedTools,
    value.model, value.effort, value.context,
  ])
}


async function openNativeFolder(skill: NativeSkill): Promise<void> {
  if (skill.path) await window.agentTeam?.openPath?.(skill.path)
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeSummary(value: unknown): SkillSummary | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null
  return {
    name: value.name,
    description: stringValue(value.description),
    enabled: booleanValue(value.enabled, true),
    valid: typeof value.valid === 'boolean' ? value.valid : undefined,
    nativeConflict: typeof (value.native_conflict ?? value.nativeConflict) === 'boolean'
      ? Boolean(value.native_conflict ?? value.nativeConflict)
      : undefined,
    targets: normalizeTargets(value.targets),
    managed: booleanValue(value.managed, true),
    migratedFrom: stringValue(value.migrated_from) || null,
    syncTooLarge: value.sync_too_large === true,
    syncViaBlobs: value.sync_via_blobs === true,
    syncTransfer: normalizeTransfer(value.sync_transfer),
    path: stringValue(value.path) || undefined,
  }
}

function normalizeNative(value: unknown, targets: Record<string, string[]>): NativeSkill | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null
  const realPath = stringValue(value.real_path)
  if (!realPath) return null
  return {
    name: value.name,
    description: stringValue(value.description),
    source: stringValue(value.source),
    ownerAgent: stringValue(value.owner_agent) || stringValue(value.source),
    path: stringValue(value.path),
    realPath,
    aliases: Array.isArray(value.aliases)
      ? value.aliases.filter((item): item is string => typeof item === 'string')
      : [],
    valid: booleanValue(value.valid, true),
    error: stringValue(value.error),
    targets: targets[realPath] ?? [],
  }
}

function normalizeNativeTargets(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [real, agents] of Object.entries(value)) {
    if (Array.isArray(agents)) out[real] = agents.filter((a): a is string => typeof a === 'string')
  }
  return out
}

function normalizeTargets(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeAgents(value: unknown): SkillAgent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || !entry.key) return []
    const state = entry.state
    return [{
      key: entry.key,
      label: stringValue(entry.label) || entry.key,
      state: state === 'wired' || state === 'planned' ? state : 'unsupported',
      readsSharedRoot: booleanValue(entry.reads_shared_root, false),
    }]
  })
}

function normalizeAttachments(value: unknown): SkillAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [{ name: entry }]
    if (!isRecord(entry)) return []
    const name = stringValue(entry.name || entry.relative_path || entry.path)
    return name ? [{ name, path: stringValue(entry.path) || undefined }] : []
  })
}

function normalizeDraft(value: unknown): SkillDraft | null {
  const summary = normalizeSummary(value)
  if (!summary || !isRecord(value)) return null
  const fields = isRecord(value.fields) ? value.fields : value
  const list = (key: string): string => {
    const raw = fields[key]
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string').join(', ') : stringValue(raw)
  }
  return {
    ...summary,
    description: stringValue(fields.description, summary.description),
    revision: stringValue(value.revision) || null,
    body: stringValue(value.body),
    userInvocable: booleanValue(fields['user-invocable'] ?? fields.user_invocable, true),
    disableModelInvocation: booleanValue(
      fields['disable-model-invocation'] ?? fields.disable_model_invocation,
      false
    ),
    allowedTools: list('allowed-tools') || list('allowed_tools'),
    disallowedTools: list('disallowed-tools') || list('disallowed_tools'),
    model: stringValue(fields.model),
    effort: stringValue(fields.effort),
    context: stringValue(fields.context),
    attachments: normalizeAttachments(value.attachments ?? value.files),
    fieldKeys: new Set(Object.keys(fields)),
  }
}

function commaList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function setAliasedField(
  fields: Record<string, unknown>,
  existingKeys: Set<string>,
  canonicalKey: string,
  legacyKey: string,
  value: unknown
): void {
  fields[canonicalKey] = value
  // The backend merges patches, so an existing legacy alias cannot be removed here.
  // Keep it synchronized with the canonical hyphenated key instead.
  if (existingKeys.has(legacyKey)) fields[legacyKey] = value
}

function responseMessage(resp: ResponseLike, fallback: string): string {
  const payload = isRecord(resp.payload) ? resp.payload : null
  return stringValue(payload?.error) || resp.error?.message || fallback
}

function isConflictResponse(resp: ResponseLike): boolean {
  const payload = isRecord(resp.payload) ? resp.payload : null
  return payload?.conflict === true || resp.error?.code === 'SKILL_CONFLICT'
}

let listRequest = 0
async function loadSkills(preferredName = selectedName.value, external = false): Promise<void> {
  const request = ++listRequest
  if (!external) {
    loading.value = true
    error.value = ''
    conflict.value = false
  }
  try {
    const resp = await props.backend.send<{
      skills?: unknown[]
      native?: unknown[]
      native_targets?: unknown
      agents?: unknown[]
      root?: string
      write_consented?: boolean
      ok?: boolean
      error?: string
    }>('skills.list', {})
    if (request !== listRequest) return
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-load'))
      return
    }
    skills.value = (resp.payload?.skills ?? []).flatMap((item) => {
      const skill = normalizeSummary(item)
      return skill ? [skill] : []
    })
    agents.value = normalizeAgents(resp.payload?.agents)
    const nativeTargets = normalizeNativeTargets(resp.payload?.native_targets)
    nativeSkills.value = (resp.payload?.native ?? []).flatMap((item) => {
      const skill = normalizeNative(item, nativeTargets)
      return skill ? [skill] : []
    })
    rootPath.value = stringValue(resp.payload?.root)
    writeConsented.value = booleanValue(resp.payload?.write_consented, false)
    // A notification may arrive while the user edits or awaits a save. Keep
    // the draft and its revision so the existing save conflict check applies.
    if (external && draft.value && (draftDirty.value || busy.value)) {
      if (!skills.value.some((skill) => skill.name === draft.value?.name)) conflict.value = true
      return
    }
    // Keep whatever was open if it still exists; otherwise the drawer stays
    // closed. Auto-opening the first skill made a read-only entry look like
    // the page's main content.
    const next = skills.value.find((skill) => skill.name === (external ? selectedName.value : preferredName))?.name ?? ''
    if (next) await selectSkill(next, external)
    else if (!matrixRows.value.some((row) => row.key === selectedKey.value)) closeDrawer()
  } catch (err) {
    if (request === listRequest) error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (request === listRequest) loading.value = false
  }
}

let selectionRequest = 0
async function selectSkill(name: string, external = false): Promise<void> {
  if (external && busy.value) return
  const previousDraft = draft.value
  const request = ++selectionRequest
  if (!external) {
    selectedKey.value = `shared:${name}`
    selectedName.value = name
    draft.value = null
    selecting.value = true
    error.value = ''
    conflict.value = false
  }
  try {
    const resp = await props.backend.send<{ skill?: unknown; ok?: boolean; error?: string }>('skills.get', { name })
    if (selectedName.value !== name || request !== selectionRequest) return
    if (external && (draft.value !== previousDraft || draftDirty.value || busy.value)) return
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-load-one'))
      return
    }
    const next = normalizeDraft(resp.payload?.skill)
    if (!next) {
      error.value = t('settings.skills.error-invalid-response')
      return
    }
    draft.value = next
    savedDraft.value = draftFingerprint(next)
  } catch (err) {
    if (selectedName.value === name && request === selectionRequest) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (!external && request === selectionRequest) selecting.value = false
  }
}

/**
 * Ask once before the first write into the user's own ~/.agents/skills.
 * The text names the exact directory and what will land there; declining
 * writes nothing. Consent is recorded server-side and never asked again.
 */
function askWriteConsent(root: string): boolean {
  return window.confirm(t('settings.skills.consent-body', { root }))
}

async function createSkill(): Promise<void> {
  const name = newName.value.trim()
  if (!name || busy.value) return
  mutating.value = true
  error.value = ''
  try {
    let consent = writeConsented.value
    if (!consent) {
      consent = askWriteConsent(rootPath.value)
      if (!consent) return
    }
    let resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.create', {
      name,
      description: newDescription.value.trim(),
      consent,
    })
    // The backend is the source of truth for consent; if it still wants it
    // (e.g. state file reset), ask now rather than fail.
    if (!resp.ok && resp.error?.code === 'SKILL_CONSENT_REQUIRED') {
      const root = (resp.error.details as { root?: string } | undefined)?.root ?? rootPath.value
      if (!askWriteConsent(root)) return
      resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.create', {
        name,
        description: newDescription.value.trim(),
        consent: true,
      })
    }
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-create'))
      return
    }
    writeConsented.value = true
    creating.value = false
    newName.value = ''
    newDescription.value = ''
    await loadSkills(name)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    mutating.value = false
  }
}

async function saveSkill(): Promise<void> {
  if (!draft.value || busy.value) return
  mutating.value = true
  error.value = ''
  conflict.value = false
  const current = draft.value
  const submittedDraft = draftFingerprint(current)
  try {
    const fields: Record<string, unknown> = {
      name: current.name,
      description: current.description,
    }
    setAliasedField(fields, current.fieldKeys, 'user-invocable', 'user_invocable', current.userInvocable)
    setAliasedField(
      fields,
      current.fieldKeys,
      'disable-model-invocation',
      'disable_model_invocation',
      current.disableModelInvocation
    )
    const advanced: Array<[string, string | null, string | string[]]> = [
      ['allowed-tools', 'allowed_tools', commaList(current.allowedTools)],
      ['disallowed-tools', 'disallowed_tools', commaList(current.disallowedTools)],
      ['model', null, current.model],
      ['effort', null, current.effort],
      ['context', null, current.context],
    ]
    for (const [key, legacyKey, value] of advanced) {
      if (
        (Array.isArray(value) ? value.length > 0 : value !== '')
        || current.fieldKeys.has(key)
        || (legacyKey !== null && current.fieldKeys.has(legacyKey))
      ) {
        if (legacyKey === null) fields[key] = value
        else setAliasedField(fields, current.fieldKeys, key, legacyKey, value)
      }
    }
    const resp = await props.backend.send<{ ok?: boolean; skill?: unknown; revision?: string; conflict?: boolean; error?: string }>(
      'skills.save',
      {
        name: current.name,
        fields,
        body: current.body,
        expected_revision: current.revision,
      }
    )
    if (!resp.ok || resp.payload?.ok === false) {
      if (draft.value !== current) return
      conflict.value = isConflictResponse(resp)
      error.value = responseMessage(
        resp,
        conflict.value ? t('settings.skills.conflict-body') : t('settings.skills.error-save')
      )
      return
    }
    const savedSkill = isRecord(resp.payload?.skill) ? resp.payload.skill : null
    current.revision = stringValue(savedSkill?.revision, current.revision ?? '') || current.revision
    if (draft.value === current) savedDraft.value = submittedDraft
    const summary = skills.value.find((skill) => skill.name === current.name)
    if (summary) summary.description = current.description
  } catch (err) {
    if (draft.value === current) error.value = err instanceof Error ? err.message : String(err)
  } finally {
    mutating.value = false
  }
}

async function setEnabled(skill: SkillSummary, enabled: boolean): Promise<void> {
  if (busy.value) return
  mutating.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.set_enabled', {
      name: skill.name,
      enabled,
    })
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-toggle'))
      return
    }
    skill.enabled = enabled
    if (draft.value?.name === skill.name) draft.value.enabled = enabled
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    mutating.value = false
  }
}

async function deleteSkill(): Promise<void> {
  if (!draft.value || busy.value) return
  const name = draft.value.name
  if (!window.confirm(t('settings.skills.delete-confirm', { name }))) return
  mutating.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.delete', { name })
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-delete'))
      return
    }
    await loadSkills()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    mutating.value = false
  }
}

async function openSkillFolder(): Promise<void> {
  const path = draft.value?.path || rootPath.value
  if (path) await window.agentTeam?.openPath?.(path)
}

const wiredAgents = computed(() => agents.value.filter((agent) => agent.state === 'wired'))

/** Every matrix row: shared skills first, then the CLIs' own, in one shape. */
/**
 * Every row, in one shape, after the search box and the source filter.
 * Both views render from this list, so a filter set in one is what the other
 * shows too — the point of merging them.
 */
const matrixRows = computed<MatrixRow[]>(() => {
  const needle = query.value.trim().toLowerCase()
  const match = (name: string, description: string) =>
    !needle || `${name} ${description}`.toLowerCase().includes(needle)
  const filter = sourceFilter.value
  const rows: MatrixRow[] = []
  if (filter === 'all' || filter === 'shared') {
    for (const skill of skills.value) {
      if (match(skill.name, skill.description)) rows.push({ kind: 'shared', key: `shared:${skill.name}`, skill })
    }
  }
  for (const skill of nativeSkills.value) {
    if (filter !== 'all' && filter !== skill.source) continue
    if (match(skill.name, skill.description)) rows.push({ kind: 'native', key: `native:${skill.realPath}`, skill })
  }
  return rows
})

/** Rows grouped by source, for the matrix's group rows and the browse view's sections. */
const groupedRows = computed<Array<{ source: string; label: string; rows: MatrixRow[] }>>(() => {
  const groups = new Map<string, MatrixRow[]>()
  for (const row of matrixRows.value) {
    const source = row.kind === 'shared' ? 'shared' : row.skill.source
    const list = groups.get(source) ?? []
    list.push(row)
    groups.set(source, list)
  }
  return [...groups.entries()].map(([source, rows]) => ({
    source,
    label: source === 'shared'
      ? t('settings.skills.group-shared', { root: '~/.agents/skills' })
      : t('settings.skills.group-native', { agent: source }),
    rows,
  }))
})

/** Source chips for the filter bar, with counts over the unfiltered set. */
const sourceChips = computed(() => {
  const counts = new Map<string, number>()
  for (const skill of nativeSkills.value) counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1)
  return [
    { key: 'all', label: t('settings.skills.filter-all'), count: skills.value.length + nativeSkills.value.length },
    { key: 'shared', label: t('settings.skills.filter-shared'), count: skills.value.length },
    ...[...counts.entries()].sort().map(([key, count]) => ({ key, label: key, count })),
  ]
})

const selectedRow = computed<MatrixRow | null>(
  () => matrixRows.value.find((row) => row.key === selectedKey.value)
    ?? (draft.value && draftDirty.value && selectedKey.value === `shared:${draft.value.name}`
      ? { kind: 'shared', key: selectedKey.value, skill: draft.value }
      : null)
)

/** Open the drawer for a row; shared rows also load their editor draft. */
async function openRow(row: MatrixRow): Promise<void> {
  selectedKey.value = row.key
  if (row.kind === 'shared') await selectSkill(row.skill.name)
  else {
    selectedName.value = ''
    draft.value = null
  }
}

function closeDrawer(): void {
  selectedKey.value = ''
  selectedName.value = ''
  draft.value = null
}

/** One-line "who receives it" summary for a card, without a full matrix. */
function deliverySummary(row: MatrixRow): { auto: string[]; on: string[] } {
  const auto: string[] = []
  const on: string[] = []
  for (const agent of agents.value) {
    const state = cellState(row, agent)
    if (state === 'auto') auto.push(agent.key)
    else if (state === 'on') on.push(agent.key)
  }
  return { auto, on }
}

type CellState = 'auto' | 'on' | 'off' | 'planned' | 'unsupported'

/**
 * What one matrix cell means. "auto" is the state a switch cannot express:
 * the agent already reads this skill on its own, so it is delivered without
 * Navide and cannot be withheld without touching the user's directory.
 */
function cellState(row: MatrixRow, agent: SkillAgent): CellState {
  if (agent.state !== 'wired') return agent.state
  if (row.kind === 'shared') {
    if (agent.readsSharedRoot) return 'auto'
    if (!row.skill.enabled) return 'off'
    return row.skill.targets === null || row.skill.targets.includes(agent.key) ? 'on' : 'off'
  }
  if (agent.key === row.skill.ownerAgent) return 'auto'
  if (!row.skill.valid) return 'off'
  return row.skill.targets.includes(agent.key) ? 'on' : 'off'
}

function delivers(row: MatrixRow, agent: SkillAgent): boolean {
  const state = cellState(row, agent)
  return state === 'on' || state === 'auto'
}

/** A cell the user can toggle: wired agent, not automatic, row not switched off. */
function cellEditable(row: MatrixRow, agent: SkillAgent): boolean {
  if (agent.state !== 'wired') return false
  if (row.kind === 'shared') return !agent.readsSharedRoot && row.skill.enabled
  return agent.key !== row.skill.ownerAgent && row.skill.valid
}

function cellHint(row: MatrixRow, agent: SkillAgent): string {
  const skill = row.skill.name
  const state = cellState(row, agent)
  if (state === 'planned') return t('settings.skills.matrix-planned-hint', { agent: agent.label })
  if (state === 'unsupported') return t('settings.skills.matrix-unsupported-hint', { agent: agent.label })
  if (state === 'auto') {
    return row.kind === 'shared'
      ? t('settings.skills.matrix-auto-shared-hint', { agent: agent.label })
      : t('settings.skills.matrix-auto-native-hint', { agent: agent.label })
  }
  return t('settings.skills.matrix-cell', { skill, agent: agent.label })
}

function cellGlyph(row: MatrixRow, agent: SkillAgent): string {
  const state = cellState(row, agent)
  if (state === 'unsupported') return '—'
  if (state === 'planned') return '·'
  if (state === 'auto') return '●'
  return state === 'on' ? '✓' : ''
}

/** Agents a row can be toggled for — the ones a full "All" would name. */
function editableAgents(row: MatrixRow): SkillAgent[] {
  return wiredAgents.value.filter((agent) => cellEditable(row, agent))
}

async function setTargets(skill: SkillSummary, next: string[] | null): Promise<void> {
  if (busy.value) return
  mutating.value = true
  error.value = ''
  const previous = skill.targets
  skill.targets = next
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.set_targets', {
      name: skill.name,
      agents: next,
    })
    if (!resp.ok || resp.payload?.ok === false) {
      skill.targets = previous
      error.value = responseMessage(resp, t('settings.skills.error-targets'))
      return
    }
    if (draft.value?.name === skill.name) draft.value.targets = next
  } catch (err) {
    skill.targets = previous
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    mutating.value = false
  }
}

async function setNativeTargets(skill: NativeSkill, next: string[]): Promise<void> {
  if (busy.value) return
  mutating.value = true
  error.value = ''
  const previous = skill.targets
  skill.targets = next
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>(
      'skills.set_native_targets',
      { real_path: skill.realPath, agents: next }
    )
    if (!resp.ok || resp.payload?.ok === false) {
      skill.targets = previous
      error.value = responseMessage(resp, t('settings.skills.error-targets'))
    }
  } catch (err) {
    skill.targets = previous
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    mutating.value = false
  }
}

/** Toggle one cell. Shared rows materialize the implicit "every agent" list first. */
async function toggleCell(row: MatrixRow, agent: SkillAgent): Promise<void> {
  if (!cellEditable(row, agent)) return
  if (row.kind === 'native') {
    const current = row.skill.targets
    const next = current.includes(agent.key)
      ? current.filter((key) => key !== agent.key)
      : [...current, agent.key]
    await setNativeTargets(row.skill, next)
    return
  }
  const editable = editableAgents(row).map((entry) => entry.key)
  const current = row.skill.targets ?? editable
  const next = current.includes(agent.key)
    ? current.filter((key) => key !== agent.key)
    : [...current, agent.key]
  // Back to every editable agent means no restriction at all, so the skill
  // keeps following the agent list instead of freezing today's members.
  const all = editable.every((key) => next.includes(key))
  await setTargets(row.skill, all ? null : next)
}

async function setRow(row: MatrixRow, all: boolean): Promise<void> {
  if (row.kind === 'native') {
    if (!row.skill.valid) return
    await setNativeTargets(row.skill, all ? editableAgents(row).map((a) => a.key) : [])
    return
  }
  if (!row.skill.enabled) return
  await setTargets(row.skill, all ? null : [])
}

/**
 * Migrate a CLI's own skill into ~/.agents/skills. Per-item, every time,
 * with the three facts the plan requires spelled out: what moves, what is
 * left in its place, and that it can be undone. Declining does nothing.
 */
async function migrateNative(skill: NativeSkill): Promise<void> {
  if (busy.value || !skill.valid) return
  const ok = window.confirm(
    t('settings.skills.migrate-body', { name: skill.name, from: skill.path, root: rootPath.value, agent: skill.source })
  )
  if (!ok) return
  mutating.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.migrate_native', {
      real_path: skill.realPath,
      consent: true,
    })
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-migrate'))
      return
    }
    await loadSkills(skill.name)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    mutating.value = false
  }
}

/** Undo a migration: the skill goes back where it came from, the link goes away. */
async function restoreNative(skill: SkillSummary): Promise<void> {
  if (busy.value || !skill.migratedFrom) return
  const ok = window.confirm(t('settings.skills.restore-body', { name: skill.name, to: skill.migratedFrom }))
  if (!ok) return
  mutating.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.restore_native', {
      name: skill.name,
    })
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-restore'))
      return
    }
    await loadSkills()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    mutating.value = false
  }
}

function rowSourceLabel(row: MatrixRow): string {
  if (row.kind === 'shared') {
    if (row.skill.migratedFrom) return t('settings.skills.source-migrated')
    return row.skill.managed
      ? t('settings.skills.source-shared')
      : t('settings.skills.source-shared-user')
  }
  return t('settings.skills.source-native', { agent: row.skill.source })
}

/**
 * Live blob transfers by skill name, from `skills.sync_progress`. `null` means
 * "finished since the list was loaded", which outranks a stale transfer the
 * list still carries.
 */
const liveTransfers = ref<Record<string, SyncTransfer | null>>({})

function transferOf(skill: SkillSummary): SyncTransfer | null {
  const name = skill.name
  return name in liveTransfers.value ? liveTransfers.value[name] : (skill.syncTransfer ?? null)
}

/** The badge for a skill whose files sync as blobs: progress while moving, else a plain label. */
function blobSyncBadge(skill: SkillSummary): string {
  const transfer = transferOf(skill)
  if (!transfer) return t('settings.skills.sync-via-blobs')
  const percent = Math.min(100, Math.floor((transfer.done / transfer.total) * 100))
  return t(transfer.direction === 'upload' ? 'settings.skills.sync-uploading' : 'settings.skills.sync-downloading', { percent })
}

let offChanged: (() => void) | undefined
let offProgress: (() => void) | undefined
onMounted(() => {
  offChanged = props.backend.on('skills.changed', () => void loadSkills(selectedName.value, true))
  offProgress = props.backend.on('skills.sync_progress', (raw) => {
    if (!isRecord(raw) || typeof raw.name !== 'string') return
    const transfer = normalizeTransfer(raw.transfer)
    liveTransfers.value = { ...liveTransfers.value, [raw.name]: transfer }
    // A finished download has just written the skill: show what landed.
    if (!transfer) void loadSkills(selectedName.value, true)
  })
  void loadSkills()
})
onUnmounted(() => {
  offChanged?.()
  offProgress?.()
})
watch(
  () => props.backend.status.value,
  (status, previous) => {
    if (status === 'connected' && previous !== 'connected') void loadSkills(selectedName.value, true)
  }
)
</script>

<template>
  <div class="skills-pane" data-settings-section="skills">
    <!-- ── Toolbar: title, filter chips, view switch, actions ─────────── -->
    <div class="skills-toolbar">
      <div>
        <h2>{{ t('settings.skills.title') }}</h2>
        <p>{{ t('settings.skills.intro') }}</p>
      </div>
      <div class="skills-toolbar-actions">
        <button type="button" :disabled="loading || busy" @click="loadSkills()">
          {{ t('action.refresh') }}
        </button>
        <button type="button" class="primary" :disabled="busy" @click="creating = true">
          {{ t('settings.skills.new') }}
        </button>
      </div>
    </div>

    <p v-if="error" class="skills-error" role="alert">{{ error }}</p>
    <div v-if="conflict" class="skills-conflict">
      <div>
        <strong>{{ t('settings.skills.conflict-title') }}</strong>
        <span>{{ t('settings.skills.conflict-body') }}</span>
      </div>
      <button type="button" @click="selectSkill(selectedName)">{{ t('settings.skills.reload') }}</button>
    </div>

    <form v-if="creating" class="skills-create" @submit.prevent="createSkill">
      <label>
        <span>{{ t('settings.skills.name') }}</span>
        <input v-model="newName" required pattern="[a-z0-9][a-z0-9_-]{0,63}" maxlength="64" autocomplete="off" spellcheck="false" />
      </label>
      <label>
        <span>{{ t('settings.skills.description') }}</span>
        <input v-model="newDescription" autocomplete="off" />
      </label>
      <div class="skills-create-actions">
        <button type="button" @click="creating = false">{{ t('action.cancel') }}</button>
        <button type="submit" class="primary" :disabled="!newName.trim() || busy">
          {{ t('settings.skills.create') }}
        </button>
      </div>
    </form>

    <!-- One filter bar drives both views: what you narrow to in browse is
         what the matrix shows, and vice versa. -->
    <div class="skills-filterbar">
      <div class="skills-chips" role="group" :aria-label="t('settings.skills.filter-label')">
        <button
          v-for="chip in sourceChips"
          :key="chip.key"
          type="button"
          class="skills-chip"
          :class="{ on: sourceFilter === chip.key }"
          :aria-pressed="sourceFilter === chip.key"
          @click="sourceFilter = chip.key"
        >{{ chip.label }}<span class="count">{{ chip.count }}</span></button>
      </div>
      <input
        v-model="query"
        class="skills-search"
        type="search"
        :placeholder="t('settings.skills.search')"
      />
      <div class="skills-view-switch" role="group" :aria-label="t('settings.skills.view-label')">
        <button
          type="button"
          :class="{ on: view === 'browse' }"
          :aria-pressed="view === 'browse'"
          @click="view = 'browse'"
        >{{ t('settings.skills.view-browse') }}</button>
        <button
          type="button"
          :class="{ on: view === 'route' }"
          :aria-pressed="view === 'route'"
          @click="view = 'route'"
        >{{ t('settings.skills.view-route') }}</button>
      </div>
    </div>

    <div class="skills-body" :class="{ 'drawer-open': selectedRow !== null }">
      <!-- ── Main region: browse (cards) or route (matrix) ──────────── -->
      <div class="skills-main">
        <div v-if="loading" class="skills-state nv-loading">{{ t('label.loading') }}</div>
        <div v-else-if="matrixRows.length === 0" class="skills-state nv-empty">
          <strong>{{ t('settings.skills.empty-title') }}</strong>
          <span>{{ t('settings.skills.empty-body') }}</span>
        </div>

        <!-- Browse: cards grouped by source. Each card carries one source
             badge and a compact "who receives it" line — enough to scan,
             never a full control surface. -->
        <template v-else-if="view === 'browse'">
          <section v-for="group in groupedRows" :key="group.source" class="skills-group">
            <h3 class="skills-group-title">
              {{ group.label }}<span class="count">{{ group.rows.length }}</span>
            </h3>
            <div class="skills-cards">
              <button
                v-for="row in group.rows"
                :key="row.key"
                type="button"
                class="skill-card"
                :class="{
                  active: selectedKey === row.key,
                  off: row.kind === 'shared' ? !row.skill.enabled : !row.skill.valid,
                  native: row.kind === 'native',
                }"
                @click="openRow(row)"
              >
                <span class="skill-card-head">
                  <strong v-truncate>{{ row.skill.name }}</strong>
                  <span class="skill-source-tag" :class="row.kind">{{ rowSourceLabel(row) }}</span>
                  <span
                    v-if="row.kind === 'shared' && row.skill.syncTooLarge"
                    class="skill-badge warning"
                    data-testid="skill-sync-too-large"
                    :title="t('settings.skills.sync-too-large-hint')"
                  >{{ t('settings.skills.sync-too-large') }}</span>
                  <span
                    v-else-if="row.kind === 'shared' && row.skill.syncViaBlobs"
                    class="skill-badge"
                    data-testid="skill-sync-via-blobs"
                    :title="t('settings.skills.sync-via-blobs-hint')"
                  >{{ blobSyncBadge(row.skill) }}</span>
                </span>
                <span class="skill-card-desc" v-truncate>
                  {{ row.skill.description || (row.kind === 'native' ? row.skill.error : '') || t('settings.skills.no-description') }}
                </span>
                <span class="skill-card-delivery" aria-hidden="true">
                  <span v-if="deliverySummary(row).auto.length" class="dchip auto">
                    {{ t('settings.skills.delivery-auto', { n: deliverySummary(row).auto.length }) }}
                  </span>
                  <span v-for="key in deliverySummary(row).on" :key="key" class="dchip on">{{ key }}</span>
                  <span
                    v-if="!deliverySummary(row).auto.length && !deliverySummary(row).on.length"
                    class="dchip none"
                  >{{ t('settings.skills.delivery-none') }}</span>
                </span>
              </button>
            </div>
          </section>
        </template>

        <!-- Route: the matrix, with source group rows. Same rows, same
             filter; the row name opens the same drawer as a card does. -->
        <section v-else class="skills-matrix">
          <div class="skills-matrix-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col" class="corner">{{ t('settings.skills.matrix-skill') }}</th>
                  <th
                    v-for="agent in agents"
                    :key="agent.key"
                    scope="col"
                    :class="agent.state"
                    :title="agent.label"
                  >{{ agent.key }}</th>
                  <th scope="col" class="bulk"></th>
                </tr>
              </thead>
              <tbody v-for="group in groupedRows" :key="group.source">
                <tr class="group">
                  <th scope="rowgroup" :colspan="agents.length + 2">{{ group.label }}</th>
                </tr>
                <tr
                  v-for="row in group.rows"
                  :key="row.key"
                  :class="{
                    off: row.kind === 'shared' ? !row.skill.enabled : !row.skill.valid,
                    native: row.kind === 'native',
                    active: selectedKey === row.key,
                  }"
                >
                  <th scope="row">
                    <button type="button" class="matrix-name" @click="openRow(row)">{{ row.skill.name }}</button>
                    <span v-if="row.kind === 'shared' && !row.skill.enabled" class="matrix-note">
                      {{ t('settings.skills.matrix-disabled-row') }}
                    </span>
                    <span v-else-if="row.kind === 'native' && !row.skill.valid" class="matrix-note">
                      {{ row.skill.error || t('settings.skills.invalid') }}
                    </span>
                  </th>
                  <td
                    v-for="agent in agents"
                    :key="agent.key"
                    :class="cellState(row, agent)"
                  >
                    <button
                      type="button"
                      :disabled="!cellEditable(row, agent) || busy"
                      :aria-pressed="delivers(row, agent)"
                      :aria-label="cellHint(row, agent)"
                      :title="cellHint(row, agent)"
                      @click="toggleCell(row, agent)"
                    >{{ cellGlyph(row, agent) }}</button>
                  </td>
                  <td class="bulk">
                    <button
                      type="button"
                      :disabled="editableAgents(row).length === 0 || busy"
                      @click="setRow(row, true)"
                    >{{ t('settings.skills.matrix-row-all') }}</button>
                    <button
                      type="button"
                      :disabled="editableAgents(row).length === 0 || busy"
                      @click="setRow(row, false)"
                    >{{ t('settings.skills.matrix-row-none') }}</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul class="skills-matrix-legend">
            <li><span class="swatch auto">●</span>{{ t('settings.skills.matrix-legend-auto') }}</li>
            <li><span class="swatch on">✓</span>{{ t('settings.skills.matrix-legend-on') }}</li>
            <li><span class="swatch off"></span>{{ t('settings.skills.matrix-legend-off') }}</li>
            <li><span class="swatch unsupported">—</span>{{ t('settings.skills.matrix-legend-unsupported') }}</li>
          </ul>
        </section>
      </div>

      <!-- ── Drawer: one detail surface for any row ────────────────── -->
      <aside v-if="selectedRow" class="skills-drawer" :aria-label="selectedRow.skill.name">
        <header class="skill-drawer-head">
          <div class="skill-drawer-title">
            <h3>{{ selectedRow.skill.name }}</h3>
            <span class="skill-source-tag" :class="selectedRow.kind">{{ rowSourceLabel(selectedRow) }}</span>
            <span
              v-if="selectedRow.kind === 'shared' && selectedRow.skill.valid === false"
              class="skill-badge danger"
            >{{ t('settings.skills.invalid') }}</span>
            <span
              v-if="selectedRow.kind === 'shared' && selectedRow.skill.nativeConflict"
              class="skill-badge warning"
              :title="t('settings.skills.native-conflict-hint')"
            >{{ t('settings.skills.native-conflict') }}</span>
            <span
              v-if="selectedRow.kind === 'shared' && selectedRow.skill.syncTooLarge"
              class="skill-badge warning"
              data-testid="skill-drawer-sync-too-large"
              :title="t('settings.skills.sync-too-large-hint')"
            >{{ t('settings.skills.sync-too-large') }}</span>
            <span
              v-else-if="selectedRow.kind === 'shared' && selectedRow.skill.syncViaBlobs"
              class="skill-badge"
              data-testid="skill-drawer-sync-via-blobs"
              :title="t('settings.skills.sync-via-blobs-hint')"
            >{{ blobSyncBadge(selectedRow.skill) }}</span>
          </div>
          <button type="button" class="skill-drawer-close" :aria-label="t('action.close')" @click="closeDrawer">✕</button>
        </header>

        <!-- Shared rows carry Navide's own on/off; a native skill has no such
             switch because it is not Navide's to switch. -->
        <section v-if="selectedRow.kind === 'shared'" class="skill-drawer-section skill-drawer-toggle">
          <span>
            <strong>{{ t('settings.skills.enabled') }}</strong>
            <small>{{ t('settings.skills.enabled-hint') }}</small>
          </span>
          <ToggleSwitch
            :model-value="selectedRow.skill.enabled"
            :disabled="busy"
            :aria-label="t(selectedRow.skill.enabled ? 'settings.skills.disable' : 'settings.skills.enable', { name: selectedRow.skill.name })"
            @update:model-value="setEnabled(selectedRow.skill, $event)"
          />
        </section>

        <!-- Delivery, in the same words for every row -->
        <section class="skill-drawer-section">
          <h4>{{ t('settings.skills.delivery-title') }}</h4>
          <div class="skill-drawer-chips">
            <template v-for="agent in agents" :key="agent.key">
              <button
                v-if="cellState(selectedRow, agent) !== 'unsupported'"
                type="button"
                class="dchip"
                :class="cellState(selectedRow, agent)"
                :disabled="!cellEditable(selectedRow, agent) || busy"
                :aria-pressed="delivers(selectedRow, agent)"
                :title="cellHint(selectedRow, agent)"
                @click="toggleCell(selectedRow, agent)"
              >{{ agent.key }}</button>
            </template>
          </div>
          <p class="skill-drawer-hint">{{ t('settings.skills.delivery-hint') }}</p>
        </section>

        <!-- Native: read-only preview + the one place "move here" lives -->
        <template v-if="selectedRow.kind === 'native'">
          <section class="skill-drawer-section">
            <h4>{{ t('settings.skills.location') }}</h4>
            <code class="skill-drawer-path">{{ selectedRow.skill.path }}</code>
            <p v-if="selectedRow.skill.aliases.length" class="skill-drawer-hint">
              {{ t('settings.skills.also-linked-from', { roots: selectedRow.skill.aliases.join(', ') }) }}
            </p>
            <p v-if="!selectedRow.skill.valid" class="skills-error">{{ selectedRow.skill.error }}</p>
          </section>
          <footer class="skill-drawer-actions">
            <button type="button" @click="openNativeFolder(selectedRow.skill)">
              {{ t('settings.skills.open-folder') }}
            </button>
            <button
              type="button"
              class="primary"
              :disabled="busy || !selectedRow.skill.valid"
              :title="t('settings.skills.migrate-hint')"
              @click="migrateNative(selectedRow.skill)"
            >{{ t('settings.skills.migrate') }}</button>
          </footer>
        </template>

        <!-- Shared but the user's own: read-only preview -->
        <template v-else-if="draft && !draft.managed">
          <section class="skill-drawer-section">
            <h4>{{ t('settings.skills.location') }}</h4>
            <code class="skill-drawer-path">{{ draft.path }}</code>
            <p class="skill-drawer-hint">{{ t('settings.skills.editor-readonly-hint') }}</p>
          </section>
          <section v-if="draft.description" class="skill-drawer-section">
            <h4>{{ t('settings.skills.description') }}</h4>
            <p class="skill-drawer-prose">{{ draft.description }}</p>
          </section>
          <section v-if="draft.body" class="skill-drawer-section">
            <h4>{{ t('settings.skills.instructions') }}</h4>
            <pre class="skill-drawer-prose">{{ draft.body.slice(0, 600) }}{{ draft.body.length > 600 ? '…' : '' }}</pre>
          </section>
          <footer class="skill-drawer-actions">
            <button type="button" @click="openSkillFolder">{{ t('settings.skills.open-folder') }}</button>
          </footer>
        </template>

        <!-- Shared and ours: the editor -->
        <template v-else-if="draft">
          <p class="skill-drawer-hint">{{ t('settings.skills.editor-hint') }}</p>
          <div class="skill-form">
            <label>
              <span>{{ t('settings.skills.name') }}</span>
              <input :value="draft.name" disabled />
            </label>
            <label>
              <span>{{ t('settings.skills.description') }}</span>
              <textarea v-model="draft.description" rows="2"></textarea>
            </label>
            <div class="skill-switches">
              <label>
                <span>
                  <strong>{{ t('settings.skills.user-invocable') }}</strong>
                  <small>{{ t('settings.skills.user-invocable-hint') }}</small>
                </span>
                <ToggleSwitch v-model="draft.userInvocable" :aria-label="t('settings.skills.user-invocable')" />
              </label>
              <label>
                <span>
                  <strong>{{ t('settings.skills.model-invocation') }}</strong>
                  <small>{{ t('settings.skills.model-invocation-hint') }}</small>
                </span>
                <ToggleSwitch
                  :model-value="!draft.disableModelInvocation"
                  :aria-label="t('settings.skills.model-invocation')"
                  @update:model-value="draft.disableModelInvocation = !$event"
                />
              </label>
            </div>
            <label>
              <span>{{ t('settings.skills.instructions') }}</span>
              <textarea v-model="draft.body" class="skill-body" rows="12" spellcheck="false"></textarea>
            </label>

            <details class="skill-advanced">
              <summary>{{ t('settings.skills.advanced') }}</summary>
              <div class="skill-advanced-grid">
                <label><span>{{ t('settings.skills.allowed-tools') }}</span><input v-model="draft.allowedTools" /></label>
                <label><span>{{ t('settings.skills.disallowed-tools') }}</span><input v-model="draft.disallowedTools" /></label>
                <label><span>{{ t('settings.skills.model') }}</span><input v-model="draft.model" /></label>
                <label><span>{{ t('settings.skills.effort') }}</span><input v-model="draft.effort" /></label>
                <label><span>{{ t('settings.skills.context') }}</span><input v-model="draft.context" /></label>
              </div>
            </details>

            <section class="skill-attachments">
              <div>
                <strong>{{ t('settings.skills.attachments') }}</strong>
                <span>{{ t('settings.skills.attachments-hint') }}</span>
              </div>
              <ul v-if="draft.attachments.length">
                <li v-for="attachment in draft.attachments" :key="attachment.path || attachment.name">
                  {{ attachment.name }}
                </li>
              </ul>
              <p v-else>{{ t('settings.skills.no-attachments') }}</p>
            </section>

            <footer class="skill-editor-actions">
              <button
                v-if="draft.migratedFrom"
                type="button"
                :disabled="busy"
                :title="draft.migratedFrom"
                @click="restoreNative(draft)"
              >{{ t('settings.skills.restore') }}</button>
              <button type="button" class="danger" :disabled="busy || !draft.managed" @click="deleteSkill">
                {{ t('settings.skills.delete') }}
              </button>
              <button type="button" class="primary" :disabled="busy || draft.valid === false || !draft.managed" @click="saveSkill">
                {{ t('settings.skills.save') }}
              </button>
            </footer>
          </div>
          <footer class="skill-drawer-actions secondary">
            <button type="button" @click="openSkillFolder">{{ t('settings.skills.open-folder') }}</button>
          </footer>
        </template>

        <div v-else class="skills-state nv-loading">{{ t('label.loading') }}</div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.skills-pane {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  /* Horizontal gutter matches the settings page gutter so the pane lines up with
     the <h1> and the scope band the settings modal renders above it. */
  padding: 16px 22px 18px;
  gap: 12px;
  overflow: hidden;
  color: var(--text-primary);
}
.skills-toolbar,
.skill-editor-head,
.skill-editor-actions,
.skills-toolbar-actions,
.skills-create-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.skills-toolbar h2,
.skill-editor-head h3 { margin: 0; color: var(--text-bright); }
.skills-toolbar h2 { font-size: 15px; }
.skill-editor-head h3 { font-size: var(--font-md); }
.skills-toolbar p,
.skill-editor-head p { margin: 3px 0 0; color: var(--text-secondary); font-size: var(--font-2xs); }
button,
input,
textarea {
  font: inherit;
}
button {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-muted);
  color: var(--text-primary);
  padding: 5px 9px;
  cursor: pointer;
}
button:hover:not(:disabled) { background: var(--bg-elevated); color: var(--text-bright); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
button.danger { color: var(--danger-fg); }
button:focus-visible,
input:focus-visible,
textarea:focus-visible,
summary:focus-visible { outline: 2px solid var(--accent-emphasis); outline-offset: 2px; }
.skills-error {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--danger-fg) 45%, var(--border-default));
  border-radius: var(--radius-control);
  color: var(--danger-fg);
  background: color-mix(in srgb, var(--danger-fg) 8%, var(--bg-subtle));
  font-size: var(--font-2xs);
}
.skills-conflict {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  padding: 8px 10px;
  border-left: 3px solid var(--attention-fg);
  background: color-mix(in srgb, var(--attention-fg) 8%, var(--bg-subtle));
  font-size: var(--font-2xs);
}
.skills-conflict div { display: flex; flex-direction: column; gap: 2px; }
.skills-create {
  display: grid;
  grid-template-columns: minmax(130px, 0.65fr) minmax(220px, 1.35fr) auto;
  align-items: end;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
}
.skills-create label,
.skill-form > label,
.skill-advanced-grid label { display: flex; flex-direction: column; gap: 4px; }
.skills-create label > span,
.skill-form > label > span,
.skill-advanced-grid label > span {
  font-size: var(--font-3xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
input,
textarea {
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text-primary);
  padding: 7px 8px;
}
textarea { resize: vertical; line-height: var(--lh-base); }
input:focus,
textarea:focus { border-color: var(--accent-emphasis); }
input:disabled { color: var(--text-muted); background: var(--bg-muted); }
.skills-search { flex: 0 0 auto; }
.skills-state { display: flex; flex-direction: column; gap: 4px; padding: 18px 8px; color: var(--text-secondary); font-size: var(--font-2xs); text-align: center; }
.skills-state strong { color: var(--text-bright); }
.skill-editor-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.skill-badge { border-radius: var(--radius-pill); padding: 2px 7px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
.skill-badge.danger { color: var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 12%, transparent); }
.skill-badge.warning { color: var(--attention-fg); background: color-mix(in srgb, var(--attention-fg) 12%, transparent); }
.skill-form { display: flex; flex-direction: column; gap: 12px; margin-top: 14px; }
.skill-switches { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--border-default); border-radius: var(--radius-card); overflow: hidden; }
.skill-switches label { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 10px; }
.skill-switches label + label { border-left: 1px solid var(--border-muted); }
.skill-switches label > span { display: flex; flex-direction: column; gap: 2px; }
.skill-switches strong { color: var(--text-bright); font-size: var(--font-2xs); }
.skill-switches small { color: var(--text-secondary); font-size: var(--font-3xs); }
.skill-body { min-height: 210px; font-family: Menlo, Monaco, monospace; font-size: var(--font-2xs); }
.skill-advanced { border: 1px solid var(--border-default); border-radius: var(--radius-card); background: var(--bg-muted); }
.skill-advanced summary { padding: 9px 10px; cursor: pointer; color: var(--text-bright); font-size: var(--font-2xs); font-weight: 600; }
.skill-advanced-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 0 10px 10px; }
.skill-attachments { display: grid; grid-template-columns: minmax(170px, 0.7fr) minmax(0, 1.3fr); gap: 12px; padding: 10px; border: 1px solid var(--border-default); border-radius: var(--radius-card); }
.skill-attachments > div { display: flex; flex-direction: column; gap: 2px; }
.skill-attachments strong { color: var(--text-bright); font-size: var(--font-2xs); }
.skill-attachments span,
.skill-attachments p,
.skill-attachments li { color: var(--text-secondary); font-size: var(--font-3xs); }
.skill-attachments p,
.skill-attachments ul { margin: 0; }
.skill-attachments ul { padding-left: 18px; font-family: Menlo, Monaco, monospace; }
.skill-editor-actions { padding-top: 2px; }

/* ── Filter bar: one bar, both views ───────────────────────────────────── */
.skills-filterbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.skills-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.skills-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: var(--font-2xs);
}
.skills-chip.on { background: var(--bg-elevated); color: var(--text-bright); border-color: var(--border-emphasis, var(--border-default)); font-weight: 600; }
.skills-chip .count { font-size: var(--font-3xs); opacity: 0.6; font-variant-numeric: tabular-nums; }
.skills-filterbar .skills-search { flex: 1; min-width: 140px; max-width: 260px; }
.skills-filterbar .skills-view-switch { margin-left: auto; }

/* ── Body: main region + optional drawer ───────────────────────────────── */
.skills-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-height: 0;
  flex: 1;
  gap: 12px;
}
.skills-body.drawer-open { grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); }
.skills-main { min-width: 0; min-height: 0; overflow-y: auto; }
.skills-state { display: flex; flex-direction: column; gap: 4px; padding: 18px 8px; color: var(--text-secondary); font-size: var(--font-2xs); text-align: center; }
.skills-state strong { color: var(--text-bright); }

/* ── Browse: cards grouped by source ───────────────────────────────────── */
.skills-group { margin-bottom: 16px; }
.skills-group-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0 2px 8px;
  font-size: var(--font-2xs);
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}
.skills-group-title .count { font-size: var(--font-3xs); font-weight: 500; opacity: 0.6; font-variant-numeric: tabular-nums; }
.skills-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}
.skill-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  padding: 9px 11px;
  text-align: left;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  min-width: 0;
}
.skill-card:hover:not(:disabled) { background: var(--bg-muted); border-color: var(--border-default); }
.skill-card.active { border-color: var(--accent-fg, var(--border-emphasis)); background: var(--bg-muted); }
.skill-card.off { opacity: 0.55; }
.skill-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.skill-card-head strong { font-size: var(--font-xs); color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-card-desc {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.skill-card-delivery { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px; }

/* delivery chips — cards (read-only) and drawer (interactive) share the look */
.dchip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--font-3xs);
  font-weight: 600;
  border: 1px solid var(--border-muted);
  color: var(--text-secondary);
  background: transparent;
  white-space: nowrap;
  line-height: var(--lh-base);
}
.dchip.on { color: var(--success-fg); border-color: color-mix(in srgb, var(--success-fg) 40%, transparent); }
.dchip.auto { color: var(--success-fg); background: color-mix(in srgb, var(--success-fg) 14%, transparent); border-color: transparent; }
.dchip.none { font-style: italic; opacity: 0.8; }
.dchip.planned, .dchip.off { opacity: 0.7; }
button.dchip { cursor: pointer; }
button.dchip:disabled { cursor: default; opacity: 1; }
button.dchip.off:disabled { opacity: 0.45; }
button.dchip.on:hover:not(:disabled), button.dchip.off:hover:not(:disabled) { background: var(--bg-elevated); }

/* one source tag, everywhere */
.skill-source-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-muted);
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  white-space: nowrap;
  flex: none;
}
.skill-source-tag.native { border-style: dashed; }

/* ── Drawer ────────────────────────────────────────────────────────────── */
.skills-drawer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px 16px;
  gap: 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
}
.skill-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.skill-drawer-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.skill-drawer-title h3 { margin: 0; font-size: var(--font-md); color: var(--text-bright); }
.skill-drawer-close { padding: 2px 7px; font-size: var(--font-xs); line-height: 1; }
.skill-drawer-section { display: flex; flex-direction: column; gap: 6px; }
.skill-drawer-section h4 { margin: 0; font-size: var(--font-3xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); }
.skill-drawer-toggle { flex-direction: row; align-items: center; justify-content: space-between; gap: 10px; }
.skill-drawer-toggle strong { display: block; font-size: var(--font-xs); color: var(--text-bright); }
.skill-drawer-toggle small { display: block; font-size: 10.5px; color: var(--text-secondary); }
.skill-drawer-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.skill-drawer-hint { margin: 0; font-size: 10.5px; color: var(--text-secondary); line-height: 1.4; }
.skill-drawer-path { display: block; font-size: 10.5px; padding: 5px 8px; border-radius: var(--radius-control); background: var(--bg-muted); word-break: break-all; }
.skill-drawer-prose { margin: 0; font-size: 11.5px; line-height: var(--lh-base); color: var(--text-primary); white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto; }
.skill-drawer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.skill-drawer-actions.secondary { justify-content: flex-start; margin-top: 0; }
.skill-badge { border-radius: var(--radius-pill); padding: 2px 7px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
.skill-badge.danger { color: var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 12%, transparent); }
.skill-badge.warning { color: var(--attention-fg); background: color-mix(in srgb, var(--attention-fg) 12%, transparent); }

@media (max-width: 900px) {
  .skills-pane { overflow-y: auto; }
  .skills-body, .skills-body.drawer-open { grid-template-columns: 1fr; }
  .skills-main { overflow: visible; }
  .skills-drawer { overflow: visible; }
  .skills-create { grid-template-columns: 1fr; }
  .skill-switches,
  .skill-advanced-grid,
  .skill-attachments { grid-template-columns: 1fr; }
  .skill-switches label + label { border-left: 0; border-top: 1px solid var(--border-muted); }
}

/* ── Capability matrix ─────────────────────────────────────────────────── */
.skills-view-switch {
  display: inline-flex;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  overflow: hidden;
}
.skills-view-switch button {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 5px 11px;
  font-size: var(--font-2xs);
}
.skills-view-switch button.on { background: var(--bg-elevated); color: var(--text-bright); font-weight: 600; }
.skills-matrix {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 9px;
}
/* The matrix is the one place a horizontal scrollbar is correct: one column
   per vendor cannot be reflowed without losing the comparison it exists for. */
.skills-matrix-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-control);
}
.skills-matrix table { border-collapse: separate; border-spacing: 0; font-size: var(--font-2xs); width: 100%; }
.skills-matrix th,
.skills-matrix td { border-bottom: 1px solid var(--border-muted); padding: 0; white-space: nowrap; }
.skills-matrix thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-weight: 600;
  padding: 6px 7px;
  text-align: center;
}
.skills-matrix thead th.planned,
.skills-matrix thead th.unsupported { opacity: 0.55; }
.skills-matrix thead th.corner,
.skills-matrix tbody th {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-muted);
  text-align: left;
  padding: 4px 9px 4px 7px;
  min-width: 150px;
}
.skills-matrix thead th.corner { z-index: 3; }
.skills-matrix tbody th { background: var(--bg-base); }
.skills-matrix tr.active tbody th,
.skills-matrix tbody tr.active th { color: var(--text-bright); }
.skills-matrix .matrix-name {
  border: 0;
  background: transparent;
  padding: 2px 0;
  font-size: var(--font-2xs);
  color: inherit;
  text-align: left;
}
.skills-matrix .matrix-name:hover { text-decoration: underline; background: transparent; }
.skills-matrix .matrix-note { display: block; color: var(--text-secondary); font-size: var(--font-3xs); }
.skills-matrix tbody tr.off th,
.skills-matrix tbody tr.off td { opacity: 0.5; }
.skills-matrix td > button {
  width: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 5px 7px;
  min-width: 34px;
  font-size: var(--font-2xs);
  line-height: 1.4;
  text-align: center;
}
.skills-matrix td.on > button { color: var(--accent-success, #6BC77F); font-weight: 700; }
.skills-matrix td.planned > button,
.skills-matrix td.unsupported > button { color: var(--text-secondary); opacity: 0.6; }
.skills-matrix td.unsupported { background: var(--bg-muted); }
.skills-matrix td.bulk { padding: 3px 7px; display: flex; gap: 5px; }
.skills-matrix td.bulk button { padding: 2px 7px; font-size: var(--font-3xs); }
.skills-matrix-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--text-secondary);
  font-size: 10.5px;
}
.skills-matrix-legend li { display: flex; align-items: center; gap: 5px; }
.skills-matrix-legend .swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 15px;
  border: 1px solid var(--border-muted);
  border-radius: 3px;
}
.skills-matrix-legend .swatch.on { color: var(--accent-success, #6BC77F); font-weight: 700; }
.skills-matrix-legend .swatch.unsupported { background: var(--bg-muted); }
/* ── Two sources ─────────────────────────────────────────────────────── */
.skills-group-title {
  margin: 10px 4px 4px;
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.skill-migrate { padding: 3px 8px; font-size: var(--font-2xs); white-space: nowrap; }
.skill-source-tag,
.skills-matrix .matrix-source {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  white-space: nowrap;
}
.skills-matrix tbody tr.group th {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-muted);
  text-align: left;
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
  padding: 5px 9px 4px 7px;
}
.skills-matrix td.auto > button {
  color: var(--accent-success, #6BC77F);
  background: color-mix(in srgb, var(--accent-success, #6BC77F) 14%, transparent);
  cursor: default;
}
.skills-matrix td.auto > button:disabled { opacity: 1; }
.skills-matrix tbody tr.native th { border-left: 3px dashed var(--border-muted); }
.skills-matrix-legend .swatch.auto {
  color: var(--accent-success, #6BC77F);
  background: color-mix(in srgb, var(--accent-success, #6BC77F) 14%, transparent);
  border-color: transparent;
}
</style>
