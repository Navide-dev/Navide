<script setup lang="ts">
import { computed, defineComponent, h, ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { parsePlanFile, writePlanFile, planProgress, replacePlanSectionBody } from '../composables/usePlanFile'
import type { PlanTodo, PlanSection, TodoStatus } from '../composables/usePlanFile'
import type { useBackend } from '../composables/useBackend'
import { useNotify } from '@navide/plugin-ui/foundation'
import { renderLines, InlineText } from './markdownRender'

const props = defineProps<{
  workspacePath: string
  relPath: string
  backend: ReturnType<typeof useBackend>
  // When true (e.g. history snapshot preview), render read-only: all write
  // interactions are hidden and the write paths early-return, so a snapshot
  // file is never mutated.
  readonly?: boolean
}>()

const { toast } = useNotify()
const { t } = useI18n()

const rawContent = ref('')
let contentRevision = 0
const loading = ref(true)
const loadError = ref('')
const waitingForBackend = ref(false)
const closePrepared = ref(false)
let closePreparation: { isCurrent(): boolean; release(): void } | null = null
let readsInFlight = 0
let writesInFlight = 0
const isReadonly = computed(() => props.readonly === true || closePrepared.value)

function isClosePrepared(): boolean { return closePrepared.value }
async function trackRead<T>(operation: () => Promise<T>): Promise<T> {
  readsInFlight++
  try { return await operation() } finally { readsInFlight-- }
}
async function trackWrite<T>(operation: () => Promise<T>): Promise<T> {
  writesInFlight++
  try { return await operation() } finally { writesInFlight-- }
}
function replaceRawContent(value: string): void {
  rawContent.value = value
  contentRevision++
}

async function loadContent(): Promise<void> {
  if (isClosePrepared()) return
  if (props.backend.status?.value && props.backend.status.value !== 'connected') {
    loading.value = true
    waitingForBackend.value = true
    loadError.value = ''
    return
  }
  loading.value = true
  waitingForBackend.value = false
  loadError.value = ''
  try {
    const resp = await trackRead(() => props.backend.send<{ ok: boolean; content?: string; error?: string }>(
      'fs.read_file',
      { workspace_path: props.workspacePath, rel_path: props.relPath },
    ))
    if (isClosePrepared()) return
    if (resp.payload?.ok && resp.payload.content !== undefined) {
      replaceRawContent(resp.payload.content)
    } else {
      loadError.value = resp.payload?.error ?? t('pane.plans.file-load-failed')
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : t('pane.plans.file-load-failed')
  } finally {
    loading.value = false
  }
}

onMounted(() => void loadContent())
watch(() => props.relPath, loadContent)
watch(() => props.backend.status?.value, (status) => {
  if (status === 'connected' && (waitingForBackend.value || loadError.value === 'ws not open')) {
    void loadContent()
  }
})

// Parsed plan derived from rawContent.
const parsed = computed(() => (rawContent.value ? parsePlanFile(rawContent.value) : null))

// Map section heading to its phase prefix for grouping todos.
function sectionPrefix(heading: string): string {
  const m = heading.match(/Phase\s+([A-Za-z0-9])/i)
  if (!m) return ''
  return `phase-${m[1].toLowerCase()}`
}

interface PhaseGroup {
  heading: string
  todos: PlanTodo[]
}

// Build display groups: one group per ## section, collecting matching todos.
const groups = computed((): PhaseGroup[] => {
  const plan = parsed.value
  if (!plan) return []

  const sections: PlanSection[] = plan.sections
  const claimed = new Set<string>()

  const result: PhaseGroup[] = sections.map((sec) => {
    const prefix = sectionPrefix(sec.heading)
    const todos = plan.todos.filter((t) => {
      if (!prefix) return false
      const match = t.id.startsWith(prefix)
      if (match) claimed.add(t.id)
      return match
    })
    return { heading: sec.heading, todos }
  })

  // Unclaimed todos go into a catch-all group.
  const unclaimed = plan.todos.filter((t) => !claimed.has(t.id))
  if (unclaimed.length > 0) {
    if (sections.length === 0) {
      result.push({ heading: t('pane.plans.group-tasks'), todos: unclaimed })
    } else {
      result.push({ heading: t('pane.plans.group-other-tasks'), todos: unclaimed })
    }
  }

  // Remove empty groups (sections with no matching todos).
  return result.filter((g) => g.todos.length > 0)
})

const overallProgress = computed(() => planProgress(parsed.value?.todos ?? []))

function isPhaseHeading(heading: string): boolean {
  return /^Phase\s+[A-Za-z0-9]/i.test(heading)
}

const documentSections = computed(() => {
  const plan = parsed.value
  if (!plan) return []
  return plan.sections.filter((sec) => !isPhaseHeading(sec.heading) && sec.body.trim())
})

const fileListSection = computed(() => documentSections.value.find((sec) =>
  /修改檔案清單|modified files?|file changes?|files? to change/i.test(sec.heading)
))

const fileList = computed(() => {
  const section = fileListSection.value
  if (!section) return []
  const files: string[] = []
  for (const line of section.body.split('\n')) {
    const matches = [...line.matchAll(/`([^`]+\.(?:ts|tsx|js|jsx|vue|py|md|json|css|scss|html|yml|yaml|toml|sh))`/g)]
    for (const m of matches) files.push(m[1])
    if (matches.length === 0) {
      const bullet = line.match(/^\s*[-*]\s+([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/)
      if (bullet) files.push(bullet[1])
    }
  }
  return [...new Set(files)]
})

// Lazy-render a ```mermaid fence. The mermaid lib is dynamically imported so it
// never loads unless a plan actually contains a diagram (keeps mermaid out of
// the editor-window startup bundle).
const MermaidBlock = defineComponent({
  props: { code: { type: String, default: '' } },
  setup(props) {
    const svg = ref('')
    const error = ref(false)
    let seq = 0
    watch(
      () => props.code,
      async (code) => {
        const id = ++seq
        try {
          const mermaid = (await import('mermaid')).default
          mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict', fontFamily: 'inherit', layout: 'dagre', look: 'classic' })
          const { svg: out } = await mermaid.render(`pfv-mermaid-${Math.random().toString(36).slice(2, 9)}`, code)
          if (id === seq) svg.value = out
        } catch {
          if (id === seq) error.value = true
        }
      },
      { immediate: true },
    )
    return () => {
      if (error.value) return h('pre', { class: 'pfv-line pfv-line--code' }, props.code)
      if (!svg.value) return h('div', { class: 'pfv-mermaid pfv-mermaid--loading' }, t('label.rendering-diagram'))
      return h('div', { class: 'pfv-mermaid', innerHTML: svg.value })
    }
  },
})

// Files without parseable frontmatter render as plain markdown instead of an error.
const fallbackLines = computed(() =>
  !parsed.value && rawContent.value.trim() ? renderLines(rawContent.value) : []
)

// Progress counter per group.
function doneCount(group: PhaseGroup): number {
  return group.todos.filter((t) => t.status === 'done').length
}

// Cycle status on click: pending → in-progress → done → pending. A skipped todo
// (set elsewhere, e.g. the review toolbar) re-joins the cycle at pending on
// click; every other todo's skipped status is preserved on save.
const STATUS_CYCLE: Record<TodoStatus, TodoStatus> = {
  pending: 'in-progress',
  'in-progress': 'done',
  done: 'pending',
  skipped: 'pending',
}

async function saveTodos(updatedTodos: PlanTodo[]): Promise<boolean> {
  if (isReadonly.value) return false
  const plan = parsed.value
  if (!plan) return false
  const newRaw = writePlanFile({ ...plan, todos: updatedTodos }, rawContent.value)

  try {
    const resp = await trackWrite(() => props.backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
      content: newRaw,
    }))
    if (isClosePrepared()) return false
    if (!resp.payload?.ok) {
      toast(resp.payload?.error ?? t('pane.plans.save-failed'))
      return false
    }
    replaceRawContent(newRaw)
    toast(t('pane.plans.saved'), { type: 'success' })
    return true
  } catch (err) {
    toast(err instanceof Error ? err.message : t('pane.plans.save-failed'))
    return false
  }
}

async function toggleTodo(todoId: string): Promise<void> {
  if (isReadonly.value) return
  const plan = parsed.value
  if (!plan) return
  await saveTodos(plan.todos.map((t) => (t.id === todoId ? { ...t, status: STATUS_CYCLE[t.status] } : t)))
}

// Cursor-style to-do management: add via "+ New", remove via the row's ✕.
const addingTodo = ref(false)
const newTodoText = ref('')

function nextTodoId(todos: PlanTodo[]): string {
  let n = todos.length + 1
  while (todos.some((t) => t.id === `todo-${n}`)) n++
  return `todo-${n}`
}

async function addTodo(): Promise<void> {
  if (isReadonly.value) return
  const plan = parsed.value
  const content = newTodoText.value.trim()
  if (!plan || !content) return
  const ok = await saveTodos([...plan.todos, { id: nextTodoId(plan.todos), content, status: 'pending' }])
  if (ok) {
    newTodoText.value = ''
    addingTodo.value = false
  }
}

async function removeTodo(todoId: string): Promise<void> {
  if (isReadonly.value) return
  const plan = parsed.value
  if (!plan) return
  await saveTodos(plan.todos.filter((t) => t.id !== todoId))
}

// Guard against IME composition: Enter committing a candidate must not add a
// half-formed to-do (matches onEditTodoEnter for the edit flow).
function onAddTodoEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  void addTodo()
}

// Shared in-flight guard for the inline edit flows below.
const saving = ref(false)

// ── Inline todo text editing ──────────────────────────────────────────────
const editingTodoId = ref<string | null>(null)
const editTodoText = ref('')

function startEditTodo(todo: PlanTodo): void {
  if (isReadonly.value) return
  editingTodoId.value = todo.id
  editTodoText.value = todo.content
}

function cancelEditTodo(): void {
  editingTodoId.value = null
  editTodoText.value = ''
}

async function saveEditTodo(todoId: string): Promise<void> {
  if (isReadonly.value) return
  const plan = parsed.value
  const content = editTodoText.value.trim()
  if (!plan || !content || saving.value) return
  saving.value = true
  const ok = await saveTodos(plan.todos.map((t) => (t.id === todoId ? { ...t, content } : t)))
  saving.value = false
  if (ok) cancelEditTodo()
}

// Guard against IME composition: Enter committing a candidate must not submit.
function onEditTodoEnter(event: KeyboardEvent, todoId: string): void {
  if (event.isComposing) return
  void saveEditTodo(todoId)
}

// ── Inline section body editing ───────────────────────────────────────────
const editingSection = ref<string | null>(null)
const editSectionText = ref('')

function startEditSection(section: PlanSection): void {
  if (isReadonly.value) return
  editingSection.value = section.heading
  editSectionText.value = section.body
}

function cancelEditSection(): void {
  editingSection.value = null
  editSectionText.value = ''
}

// Re-read the file immediately before writing and use the backend's optimistic
// lock (expected_mtime). On a conflict, re-read once and retry so a concurrent
// todo toggle or external edit doesn't clobber the untouched sections.
async function writeSectionBody(heading: string, edited: string): Promise<boolean> {
  if (isReadonly.value) return false
  async function readFresh(): Promise<{ content: string; mtime: number | undefined } | null> {
    const resp = await trackRead(() => props.backend.send<{ ok: boolean; content?: string; mtime?: number; error?: string }>(
      'fs.read_file',
      { workspace_path: props.workspacePath, rel_path: props.relPath },
    ))
    if (isClosePrepared()) return null
    if (!resp.payload?.ok || resp.payload.content === undefined) {
      toast(resp.payload?.error ?? t('pane.plans.save-failed'))
      return null
    }
    return { content: resp.payload.content, mtime: resp.payload.mtime }
  }

  try {
    const first = await readFresh()
    if (!first) return false
    let newRaw = replacePlanSectionBody(first.content, heading, edited)
    let resp = await trackWrite(() => props.backend.send<{ ok: boolean; conflict?: boolean; error?: string }>('fs.write_file', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
      content: newRaw,
      expected_mtime: first.mtime,
    }))
    if (isClosePrepared()) return false
    if (resp.payload?.conflict) {
      const retry = await readFresh()
      if (!retry) return false
      newRaw = replacePlanSectionBody(retry.content, heading, edited)
      resp = await trackWrite(() => props.backend.send<{ ok: boolean; conflict?: boolean; error?: string }>('fs.write_file', {
        workspace_path: props.workspacePath,
        rel_path: props.relPath,
        content: newRaw,
        expected_mtime: retry.mtime,
      }))
      if (isClosePrepared()) return false
    }
    if (!resp.payload?.ok) {
      toast(resp.payload?.error ?? t('pane.plans.save-failed'))
      return false
    }
    toast(t('pane.plans.saved'), { type: 'success' })
    return true
  } catch (err) {
    toast(err instanceof Error ? err.message : t('pane.plans.save-failed'))
    return false
  }
}

async function saveEditSection(heading: string): Promise<void> {
  if (isReadonly.value || saving.value) return
  saving.value = true
  const ok = await writeSectionBody(heading, editSectionText.value)
  saving.value = false
  if (ok) {
    cancelEditSection()
    await loadContent()
  }
}

function prepareClose(): { isCurrent(): boolean; release(): void } | null {
  if (closePreparation) return closePreparation
  if (props.readonly || isClosePrepared() || loading.value || saving.value || readsInFlight !== 0 || writesInFlight !== 0) return null

  const workspacePath = props.workspacePath
  const relPath = props.relPath
  const revision = contentRevision
  closePrepared.value = true

  let released = false
  const guard = {
    isCurrent: (): boolean => !released
      && closePreparation === guard
      && closePrepared.value
      && props.workspacePath === workspacePath
      && props.relPath === relPath
      && contentRevision === revision,
    release: (): void => {
      if (released) return
      released = true
      if (closePreparation !== guard) return
      closePreparation = null
      closePrepared.value = false
    },
  }
  closePreparation = guard
  return guard
}

function checkboxGlyph(status: TodoStatus): string {
  if (status === 'done') return '●'
  if (status === 'in-progress') return '◐'
  if (status === 'skipped') return '⊘'
  return '○'
}

// Badge config per status.
function badgeLabel(status: TodoStatus): string {
  if (status === 'in-progress') return t('pane.plans.status-in-progress')
  if (status === 'done') return t('pane.plans.status-done')
  if (status === 'skipped') return t('pane.plans.status-skipped')
  return t('pane.plans.status-pending')
}
function badgeClass(status: TodoStatus): string {
  if (status === 'done') return 'pfv-badge pfv-badge--done'
  if (status === 'in-progress') return 'pfv-badge pfv-badge--in-progress'
  if (status === 'skipped') return 'pfv-badge pfv-badge--skipped'
  return 'pfv-badge pfv-badge--pending'
}

defineExpose({ prepareClose })
</script>

<template>
  <div class="pfv">
    <div v-if="loading" class="pfv-loading">
      {{ waitingForBackend ? t('pane.plans.waiting-backend') : t('pane.plans.file-loading') }}
    </div>

    <div v-else-if="loadError" class="pfv-error">{{ loadError }}</div>

    <div v-else-if="parsed" class="pfv-inner">
      <!-- Header -->
      <div class="pfv-header">
        <div class="pfv-title-row">
          <div class="pfv-title">{{ parsed.name }}</div>
          <div v-if="overallProgress.total" class="pfv-total-progress">
            {{ t('pane.plans.progress-done', { done: overallProgress.done, total: overallProgress.total }) }}
          </div>
        </div>
        <div v-if="parsed.overview" class="pfv-overview">{{ parsed.overview }}</div>
      </div>

      <div v-if="fileList.length" class="pfv-card pfv-files">
        <div class="pfv-card-title">{{ t('pane.plans.modified-files') }}</div>
        <ul class="pfv-file-list">
          <li v-for="file in fileList" :key="file">
            <code>{{ file }}</code>
          </li>
        </ul>
      </div>

      <div v-for="section in documentSections" :key="section.heading" class="pfv-card pfv-doc-section">
        <div class="pfv-card-title-row">
          <div class="pfv-card-title">{{ section.heading }}</div>
          <button
            v-if="!isReadonly && editingSection !== section.heading"
            class="pfv-inline-btn"
            @click="startEditSection(section)"
          >{{ t('pane.plans.edit') }}</button>
        </div>
        <div v-if="editingSection === section.heading" class="pfv-section-edit">
          <textarea
            v-model="editSectionText"
            :readonly="isReadonly"
            class="pfv-section-textarea"
            :placeholder="t('pane.plans.doc-edit-placeholder')"
            @keydown.esc="cancelEditSection"
          />
          <div class="pfv-edit-actions">
            <button class="pfv-inline-btn" :disabled="saving || isReadonly" @click="cancelEditSection">
              {{ t('pane.plans.cancel') }}
            </button>
            <button
              class="pfv-inline-btn pfv-inline-btn--primary"
              :disabled="saving || isReadonly"
              @click="saveEditSection(section.heading)"
            >{{ t('pane.plans.save') }}</button>
          </div>
        </div>
        <div v-else class="pfv-doc-body">
          <template v-for="(line, idx) in renderLines(section.body)" :key="section.heading + ':' + idx">
            <div v-if="line.kind === 'blank'" class="pfv-line pfv-line--blank" />
            <div v-else-if="line.kind === 'heading'" :class="['pfv-line', 'pfv-line--heading', 'pfv-line--h' + line.level]"><InlineText :text="line.text" /></div>
            <div v-else-if="line.kind === 'quote'" class="pfv-line pfv-line--quote"><InlineText :text="line.text" /></div>
            <div v-else-if="line.kind === 'bullet'" class="pfv-line pfv-line--bullet"><InlineText :text="line.text" /></div>
            <div v-else-if="line.kind === 'ordered'" class="pfv-line pfv-line--ordered">
              <span class="pfv-ordered-marker">{{ line.marker }}</span> <InlineText :text="line.text" />
            </div>
            <MermaidBlock v-else-if="line.kind === 'codeblock' && line.lang === 'mermaid'" :code="line.text" />
            <pre v-else-if="line.kind === 'codeblock'" class="pfv-line pfv-line--code">{{ line.text }}</pre>
            <div v-else class="pfv-line"><InlineText :text="line.text" /></div>
          </template>
        </div>
      </div>

      <!-- To-dos header: count + Cursor-style "+ New" -->
      <div class="pfv-todos-head">
        <span class="pfv-todos-count">{{ t('pane.plans.todos-count', { count: parsed.todos.length }) }}</span>
        <button v-if="!isReadonly" class="pfv-new-btn" @click="addingTodo = !addingTodo">{{ t('pane.plans.todo-new') }}</button>
      </div>
      <div v-if="addingTodo" class="pfv-new-row">
        <input
          v-model="newTodoText"
          :readonly="isReadonly"
          class="pfv-new-input"
          :placeholder="t('pane.plans.todo-describe-placeholder')"
          @keydown.enter="onAddTodoEnter"
          @keydown.esc="addingTodo = false"
        />
        <button class="pfv-new-btn" :disabled="isReadonly" @click="addTodo">{{ t('pane.plans.todo-add') }}</button>
      </div>

      <!-- Phase groups -->
      <div
        v-for="group in groups"
        :key="group.heading"
        class="pfv-group"
      >
        <div class="pfv-group-header">
          <span class="pfv-group-dot">●</span>
          <span class="pfv-group-title">{{ group.heading }}</span>
          <span v-if="group.todos.length > 0" class="pfv-group-progress">
            {{ t('pane.plans.progress-done', { done: doneCount(group), total: group.todos.length }) }}
          </span>
        </div>

        <div
          v-for="todo in group.todos"
          :key="todo.id"
          class="pfv-todo"
          @click="toggleTodo(todo.id)"
        >
          <span class="pfv-checkbox" :class="{ 'pfv-checkbox--checked': todo.status === 'done' || todo.status === 'in-progress' }">
            {{ checkboxGlyph(todo.status) }}
          </span>
          <template v-if="editingTodoId === todo.id">
            <input
              v-model="editTodoText"
              :readonly="isReadonly"
              class="pfv-todo-edit-input"
              @click.stop
              @keydown.enter="onEditTodoEnter($event, todo.id)"
              @keydown.esc.stop="cancelEditTodo"
            />
            <button class="pfv-inline-btn" :disabled="saving || isReadonly" @click.stop="cancelEditTodo">{{ t('pane.plans.cancel') }}</button>
            <button
              class="pfv-inline-btn pfv-inline-btn--primary"
              :disabled="saving || !editTodoText.trim()"
              @click.stop="saveEditTodo(todo.id)"
            >{{ t('pane.plans.save') }}</button>
          </template>
          <template v-else>
            <span class="pfv-todo-content">{{ todo.content }}</span>
            <span :class="badgeClass(todo.status)">{{ badgeLabel(todo.status) }}</span>
            <button class="pfv-todo-edit" :title="t('pane.plans.edit')" @click.stop="startEditTodo(todo)">✎</button>
            <button class="pfv-todo-remove" :title="t('pane.plans.todo-remove')" @click.stop="removeTodo(todo.id)">✕</button>
          </template>
        </div>
      </div>

      <!-- No groups (no matching sections) but we have todos -->
      <div v-if="groups.length === 0 && parsed.todos.length > 0" class="pfv-group">
        <div class="pfv-group-header">
          <span class="pfv-group-dot">●</span>
          <span class="pfv-group-title">{{ t('pane.plans.group-tasks') }}</span>
          <span class="pfv-group-progress">
            {{ t('pane.plans.progress-done', { done: parsed.todos.filter(td => td.status === 'done').length, total: parsed.todos.length }) }}
          </span>
        </div>
        <div
          v-for="todo in parsed.todos"
          :key="todo.id"
          class="pfv-todo"
          @click="toggleTodo(todo.id)"
        >
          <span class="pfv-checkbox" :class="{ 'pfv-checkbox--checked': todo.status === 'done' || todo.status === 'in-progress' }">
            {{ checkboxGlyph(todo.status) }}
          </span>
          <template v-if="editingTodoId === todo.id">
            <input
              v-model="editTodoText"
              :readonly="isReadonly"
              class="pfv-todo-edit-input"
              @click.stop
              @keydown.enter="onEditTodoEnter($event, todo.id)"
              @keydown.esc.stop="cancelEditTodo"
            />
            <button class="pfv-inline-btn" :disabled="saving || isReadonly" @click.stop="cancelEditTodo">{{ t('pane.plans.cancel') }}</button>
            <button
              class="pfv-inline-btn pfv-inline-btn--primary"
              :disabled="saving || !editTodoText.trim()"
              @click.stop="saveEditTodo(todo.id)"
            >{{ t('pane.plans.save') }}</button>
          </template>
          <template v-else>
            <span class="pfv-todo-content">{{ todo.content }}</span>
            <span :class="badgeClass(todo.status)">{{ badgeLabel(todo.status) }}</span>
            <button class="pfv-todo-edit" :title="t('pane.plans.edit')" @click.stop="startEditTodo(todo)">✎</button>
            <button class="pfv-todo-remove" :title="t('pane.plans.todo-remove')" @click.stop="removeTodo(todo.id)">✕</button>
          </template>
        </div>
      </div>

      <div v-if="groups.length === 0 && parsed.todos.length === 0" class="pfv-empty">
        {{ t('pane.plans.no-tasks') }}
      </div>
    </div>

    <!-- Fallback: no frontmatter — render the whole file as plain markdown -->
    <div v-else-if="fallbackLines.length" class="pfv-doc-body pfv-inner">
      <template v-for="(line, idx) in fallbackLines" :key="'md:' + idx">
        <div v-if="line.kind === 'blank'" class="pfv-line pfv-line--blank" />
        <div v-else-if="line.kind === 'heading'" :class="['pfv-line', 'pfv-line--heading', 'pfv-line--h' + line.level]"><InlineText :text="line.text" /></div>
        <div v-else-if="line.kind === 'quote'" class="pfv-line pfv-line--quote"><InlineText :text="line.text" /></div>
        <div v-else-if="line.kind === 'bullet'" class="pfv-line pfv-line--bullet"><InlineText :text="line.text" /></div>
        <div v-else-if="line.kind === 'ordered'" class="pfv-line pfv-line--ordered">
          <span class="pfv-ordered-marker">{{ line.marker }}</span> <InlineText :text="line.text" />
        </div>
        <MermaidBlock v-else-if="line.kind === 'codeblock' && line.lang === 'mermaid'" :code="line.text" />
        <pre v-else-if="line.kind === 'codeblock'" class="pfv-line pfv-line--code">{{ line.text }}</pre>
        <div v-else class="pfv-line"><InlineText :text="line.text" /></div>
      </template>
    </div>

    <!-- Fallback: empty file -->
    <div v-else class="pfv-invalid">
      <div class="pfv-invalid-msg">
        {{ t('pane.plans.frontmatter-error') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.pfv {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px 32px;
  font-size: var(--font-sm);
  color: var(--text-primary);
  background: var(--bg-base);
  font-family: var(--font-ui, system-ui, sans-serif);
}

.pfv-loading,
.pfv-error {
  color: var(--text-secondary);
  padding: 20px 0;
  font-style: italic;
}

.pfv-error {
  color: var(--danger-fg);
}

.pfv-header {
  margin-bottom: 20px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-default);
}

.pfv-title-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.pfv-title {
  flex: 1;
  font-size: var(--font-lg);
  font-weight: 600;
  margin-bottom: 4px;
}

.pfv-total-progress {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pfv-overview {
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}

.pfv-card {
  border-bottom: 1px solid var(--border-default);
  margin-bottom: 18px;
  padding-bottom: 16px;
}

.pfv-card-title {
  color: var(--text-bright);
  font-size: 15px;
  font-weight: 650;
  margin-bottom: 10px;
}

.pfv-file-list {
  display: grid;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.pfv-file-list code,
.pfv-line code {
  background: var(--bg-muted);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  font-size: var(--font-xs);
}

.pfv-line {
  color: var(--text-primary);
  line-height: 1.55;
  margin: 3px 0;
}

.pfv-line--blank {
  height: 8px;
}

.pfv-inner {
  margin: 0 auto;
  max-width: 860px;
}

.pfv-line--heading {
  color: var(--text-bright);
  font-weight: 650;
  margin-top: 10px;
}

.pfv-line--h1 {
  font-size: 19px;
  margin-top: 20px;
}

.pfv-line--h2 {
  font-size: var(--font-lg);
  margin-top: 16px;
}

.pfv-line--h3 {
  font-size: var(--font-md);
  margin-top: 12px;
}

.pfv-line--h4 {
  font-size: var(--font-sm);
}

.pfv-line--quote {
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
  margin: 4px 0;
  padding-left: 10px;
}

.pfv-link {
  color: var(--accent-fg);
  cursor: pointer;
  text-decoration: none;
}

.pfv-link:hover {
  text-decoration: underline;
}

.pfv-line--bullet {
  padding-left: 18px;
  position: relative;
}

.pfv-line--bullet::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 0.75em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-secondary);
}

.pfv-line--code {
  background: var(--bg-inset);
  border-radius: 4px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  margin: 4px 0;
  overflow-x: auto;
  padding: 6px 8px;
}

.pfv-todos-head {
  align-items: center;
  display: flex;
  justify-content: space-between;
  margin: 4px 0 10px;
}

.pfv-todos-count {
  color: var(--text-bright);
  font-size: 15px;
  font-weight: 650;
}

.pfv-new-btn {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--font-xs);
  padding: 3px 10px;
}

.pfv-new-btn:hover {
  background: var(--bg-hover-strong);
}

.pfv-new-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.pfv-new-input {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  flex: 1;
  font-size: var(--font-sm);
  padding: 5px 8px;
}

.pfv-new-input:focus {
  border-color: var(--accent-focus);
  outline: none;
}

.pfv-todo-remove {
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  font-size: var(--font-2xs);
  opacity: 0;
  padding: 2px 4px;
}

.pfv-todo:hover .pfv-todo-remove {
  opacity: 1;
}

.pfv-todo-remove:hover {
  color: var(--danger-fg);
}

.pfv-card-title-row {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: space-between;
}

.pfv-inline-btn {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  flex-shrink: 0;
  font-size: var(--font-2xs);
  padding: 2px 9px;
}

.pfv-inline-btn:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}

.pfv-inline-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

.pfv-inline-btn--primary {
  border-color: var(--accent-focus);
}

.pfv-section-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pfv-section-textarea {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  min-height: 120px;
  padding: 8px;
  resize: vertical;
  width: 100%;
}

.pfv-section-textarea:focus {
  border-color: var(--accent-focus);
  outline: none;
}

.pfv-edit-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.pfv-todo-edit-input {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  flex: 1;
  font-size: var(--font-sm);
  padding: 3px 7px;
}

.pfv-todo-edit-input:focus {
  border-color: var(--accent-focus);
  outline: none;
}

.pfv-todo-edit {
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  font-size: var(--font-xs);
  opacity: 0;
  padding: 2px 4px;
}

.pfv-todo:hover .pfv-todo-edit {
  opacity: 1;
}

.pfv-todo-edit:hover {
  color: var(--accent-fg);
}

.pfv-line--ordered {
  padding-left: 4px;
}

.pfv-ordered-marker {
  color: var(--text-secondary);
  margin-right: 4px;
}

.pfv-mermaid {
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  margin: 8px 0;
  overflow-x: auto;
  padding: 12px;
}

.pfv-mermaid svg {
  height: auto;
  max-width: 100%;
}

.pfv-mermaid--loading {
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-style: italic;
}

.pfv-group {
  margin-bottom: 18px;
}

.pfv-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  padding: 4px 0;
  font-weight: 600;
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.pfv-group-dot {
  color: var(--accent-fg);
  font-size: var(--font-3xs);
}

.pfv-group-title {
  flex: 1;
  color: var(--text-primary);
}

.pfv-group-progress {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  font-weight: 400;
}

.pfv-todo {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.1s;
  line-height: 1.45;
}

.pfv-todo:hover {
  background: var(--bg-hover-faint);
}

.pfv-checkbox {
  font-size: 15px;
  flex-shrink: 0;
  user-select: none;
  color: var(--text-secondary);
}

.pfv-checkbox--checked {
  color: var(--success-fg);
}

.pfv-todo-content {
  flex: 1;
  font-size: var(--font-sm);
}

.pfv-badge {
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pfv-badge--pending {
  background: var(--bg-muted);
  color: var(--text-secondary);
}

.pfv-badge--in-progress {
  background: var(--attention-subtle);
  color: var(--attention-bright);
}

.pfv-badge--done {
  background: var(--success-subtle);
  color: var(--success-fg);
}

.pfv-badge--skipped {
  background: var(--bg-muted);
  color: var(--text-muted);
  text-decoration: line-through;
}

.pfv-empty {
  color: var(--text-secondary);
  font-style: italic;
  padding: 20px 0;
}

.pfv-invalid {
  padding: 20px 0;
}

.pfv-invalid-msg {
  color: var(--warning-fg);
  font-style: italic;
}
</style>
