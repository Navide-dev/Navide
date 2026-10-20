<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { EditorPort, EditorWriteRequest } from './port'
import { i18n, useNotify } from '../foundation'
import { setContext } from '../shared'
import EditorViewMonaco from './view/EditorViewMonaco.vue'
import { languageForFile, normalizeLanguage } from './languageDetect'
import type { Range, Position } from './types'

const props = defineProps<{
  workspacePath: string
  port: EditorPort
  relPath: string
  name: string
  initialLine?: number
  // Inside the IDE shell the file name is shown by the host tab strip, so the
  // editor hides its own name chip and keeps only the action buttons.
  embedded?: boolean
  // Multiple EditorPanes stay mounted (v-show) in the IDE; only the active one
  // should respond to global keyboard shortcuts. Defaults true for standalone use.
  active?: boolean
  // When an already-open file needs to navigate to a new line (e.g. search result),
  // the host bumps revealSeq so the watch fires even when revealAt is unchanged.
  revealAt?: number
  revealSeq?: number
}>()

const emit = defineEmits<{
  (e: 'dirty', value: boolean): void
  (e: 'addToChat', selection: string): void
  (e: 'explainWithAI', selection: string): void
  (e: 'fixWithAI', selection: string): void
  (e: 'writeTestsWithAI', selection: string): void
  (e: 'askWithAI', payload: { selection: string; question: string }): void
}>()

const { toast, alert, confirm } = useNotify()

const content = ref('')
const dirty = ref(false)
watch(dirty, (v) => emit('dirty', v))

const fileDiagnostics = computed(
  () => props.port.diagnostics({ workspacePath: props.workspacePath, relPath: props.relPath }),
)
// Navigate to a specific line when the host signals a new target (e.g. search results
// clicking an already-open file). revealSeq ensures the watch fires even when revealAt
// is the same line number as before.
watch([() => props.revealAt, () => props.revealSeq] as const, ([line]) => {
  if (line && line > 0) editorRef.value?.revealLine(line)
})
const loadError = ref('')
const loaded = ref(false)
const backendStatus = computed(() => props.port.status.value)
// Backend gave up for good (failed start / socket error) — offer a manual retry
// that restarts the backend; the status watch reloads the file once reconnected.
function retryBackend(): void {
  void props.port.restart()
}
// A one-off load failure while the socket stays connected must not latch the
// error screen forever — let the user retry the read directly.
function retryLoad(): void {
  loadError.value = ''
  void load()
}
const editorRef = ref<InstanceType<typeof EditorViewMonaco> | null>(null)
const closePrepared = ref(false)
let closePreparation: { isCurrent(): boolean; release(): void } | null = null
let readsInFlight = 0
let writesInFlight = 0

function isClosePrepared(): boolean { return closePrepared.value }
async function trackRead<T>(operation: () => Promise<T>): Promise<T> {
  readsInFlight++
  try { return await operation() } finally { readsInFlight-- }
}
async function trackWrite<T>(operation: () => Promise<T>): Promise<T> {
  writesInFlight++
  try { return await operation() } finally { writesInFlight-- }
}

const model = 'qwen2:latest' // analyzer's default; rewrite/complete proxy to local LLM
const langOverride = ref<string | null>(null)
// Effective Monaco language ID: manual override wins, else filename-aware detection.
const lang = computed(() =>
  langOverride.value != null ? normalizeLanguage(langOverride.value) : languageForFile(props.name))

// Status-bar labels keyed by Monaco language ID.
const LANG_MAP: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python',
  json: 'JSON', markdown: 'Markdown', html: 'HTML', css: 'CSS', scss: 'SCSS',
  less: 'Less', shell: 'Shell', go: 'Go', rust: 'Rust', ruby: 'Ruby',
  java: 'Java', kotlin: 'Kotlin', swift: 'Swift', cpp: 'C++', c: 'C',
  csharp: 'C#', php: 'PHP', yaml: 'YAML', ini: 'INI', xml: 'XML', sql: 'SQL',
  graphql: 'GraphQL', dockerfile: 'Dockerfile', bat: 'Batch',
  powershell: 'PowerShell', perl: 'Perl', scala: 'Scala', clojure: 'Clojure',
  coffee: 'CoffeeScript', elixir: 'Elixir', fsharp: 'F#',
  'objective-c': 'Objective-C', pascal: 'Pascal', protobuf: 'Protobuf',
  pug: 'Pug', restructuredtext: 'reStructuredText', solidity: 'Solidity',
  tcl: 'Tcl', twig: 'Twig', vb: 'Visual Basic', wgsl: 'WGSL',
  handlebars: 'Handlebars', liquid: 'Liquid', razor: 'Razor', bicep: 'Bicep',
  hcl: 'HCL', dart: 'Dart', lua: 'Lua', r: 'R', julia: 'Julia',
  plaintext: 'Text',
}
const langDisplay = computed(() => LANG_MAP[lang.value] ?? (lang.value ? lang.value.toUpperCase() : 'Text'))

// ── Status bar cursor position ─────────────────────────────────────────────────
const cursorLine = ref(1)
const cursorCol = ref(1)
const selectionInfo = ref('')
function onCursorChange(pos: Position): void {
  cursorLine.value = pos.line + 1
  cursorCol.value = pos.col + 1
  const sel = editorRef.value?.getSelectionText() ?? ''
  if (sel) {
    const lines = sel.split('\n')
    const words = sel.trim().split(/\s+/).filter(Boolean).length
    if (lines.length > 1) {
      selectionInfo.value = `${lines.length} lines  ${sel.length} chars  ${words} words`
    } else {
      selectionInfo.value = `${sel.length} chars  ${words} words`
    }
  } else {
    selectionInfo.value = ''
    floatingChat.value = null
  }
}

// ── Floating "Add to Chat" button ─────────────────────────────────────────────
const floatingChat = ref<{ x: number; y: number } | null>(null)

function onEditorBodyMouseup(e: MouseEvent): void {
  // event.currentTarget is null once dispatch completes — capture it before the rAF.
  const bodyEl = e.currentTarget as HTMLElement
  requestAnimationFrame(() => {
    const sel = editorRef.value?.getSelectionText() ?? ''
    if (sel.trim()) {
      const rect = bodyEl.getBoundingClientRect()
      floatingChat.value = {
        x: e.clientX - rect.left,
        y: Math.max(4, e.clientY - rect.top - 38),
      }
    }
  })
}

function onAddToChatFloat(): void {
  const sel = editorRef.value?.getSelectionText() ?? ''
  floatingChat.value = null
  emit('addToChat', sel || editorRef.value?.getValue() || '')
}

// ── Encoding state ────────────────────────────────────────────────────────────
const fileEncoding = ref<string>('UTF-8')
const fileBom = ref<boolean>(false)
// Codec name to echo back on save so non-UTF-8 files are not re-encoded.
const fileCodec = ref<string | null>(null)
// Disk mtime seen at load/save time — sent back as expected_mtime so the
// backend can detect external modifications (lost-update protection). Stays
// null when the backend does not return mtime (older API) → conflict logic off.
const fileMtime = ref<number | null>(null)
// Pending save conflict: the file changed on disk since it was loaded.
const saveConflict = ref(false)
const isBinaryFile = ref<boolean>(false)
const isImageFile = ref<boolean>(false)
const imageDataUrl = ref<string>('')
const binarySize = ref<number>(0)
const binaryExt = ref<string>('')

// ── Line ending (EOL) detection ───────────────────────────────────────────────
type EOL = 'LF' | 'CRLF'
const eol = ref<EOL>('LF')
function detectEOL(text: string): EOL {
  return text.includes('\r\n') ? 'CRLF' : 'LF'
}
function convertToEOL(text: string, target: EOL): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return target === 'CRLF' ? normalized.replace(/\n/g, '\r\n') : normalized
}
function changeEOL(target: EOL): void {
  if (isClosePrepared() || eol.value === target) return
  content.value = convertToEOL(content.value, target)
  eol.value = target
  dirty.value = true
}

let pendingLoad: Promise<void> | null = null
function load(): Promise<void> {
  if (isClosePrepared()) return Promise.resolve()
  const task = loadFile()
  pendingLoad = task
  return task
}
async function loadFile(): Promise<void> {
  try {
    const p = await trackRead(() => props.port.readFile({
      workspacePath: props.workspacePath,
      relPath: props.relPath,
    }))
    if (isClosePrepared()) return
    if (!p?.ok) {
      // Binary / image / oversized file — show special UI instead of error text
      if (p?.is_binary || p?.is_image) {
        isBinaryFile.value = true
        isImageFile.value = p?.is_image ?? false
        binarySize.value = p?.size ?? 0
        binaryExt.value = p?.ext ?? ''
        loaded.value = true
        // Fetch image bytes as a data URL (a raw file:// src is blocked by
        // webSecurity from the dev http origin). Empty result → placeholder.
        if (isImageFile.value) {
          imageDataUrl.value = await trackRead(() => props.port.readImage({ workspacePath: props.workspacePath, relPath: props.relPath }))
          if (isClosePrepared()) return
        }
        return
      }
      loadError.value = p?.error || 'Unable to read file'
      return
    }
    const raw = p.content ?? ''
    eol.value = detectEOL(raw)
    content.value = raw
    fileEncoding.value = p.encoding ?? 'UTF-8'
    fileCodec.value = p.encoding ?? null
    fileBom.value = p.bom ?? false
    fileMtime.value = p.mtime ?? null
    loaded.value = true
    const targetLine = props.revealAt && props.revealAt > 0
      ? props.revealAt
      : props.initialLine
    if (targetLine && targetLine > 0) {
      await nextTick()
      editorRef.value?.revealLine(targetLine)
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to read file'
  }
}

// Track last edit position so cmd+k cmd+q can navigate back to it.
const lastEditLine = ref<number | null>(null)
const lastEditCol = ref<number | null>(null)

function onChange(v: string): void {
  if (isClosePrepared()) return
  content.value = v
  dirty.value = true
  const cur = editorRef.value?.getCursor()
  if (cur) { lastEditLine.value = cur.line; lastEditCol.value = cur.col }
}

function navigateToLastEdit(): void {
  if (lastEditLine.value === null) return
  editorRef.value?.revealPosition(lastEditLine.value, lastEditCol.value ?? 0)
}

async function save(opts: { force?: boolean } = {}): Promise<void> {
  if (isClosePrepared() || !dirty.value) return
  const preContent = content.value // capture before the async write
  const snapshot = convertToEOL(preContent, eol.value)
  try {
    const params: EditorWriteRequest = {
      workspacePath: props.workspacePath,
      relPath: props.relPath,
      content: snapshot,
    }
    // Preserve the on-disk encoding instead of silently re-encoding to UTF-8.
    if (fileCodec.value) params.encoding = fileCodec.value
    // Conflict detection — only when the backend gave us an mtime baseline.
    if (!opts.force && fileMtime.value !== null) params.expectedMtime = fileMtime.value
    const p = await trackWrite(() => props.port.writeFile(params))
    if (isClosePrepared()) return
    if (p?.conflict) {
      saveConflict.value = true
      return
    }
    if (!p?.ok) {
      void alert(p?.error || 'Save failed', { title: 'Save error' })
      return
    }
    saveConflict.value = false
    if (p.mtime !== undefined) fileMtime.value = p.mtime
    // Only clear dirty when no further edits landed while the request was in-flight.
    if (content.value === preContent) dirty.value = false
    toast(i18n.global.t('editorWindow.saved'), { type: 'success' })
  } catch (err) {
    void alert(err instanceof Error ? err.message : 'Save failed', { title: 'Save error' })
  }
}

// ── Save conflict actions (file changed on disk while dirty) ─────────────────
function conflictOverwrite(): void {
  if (isClosePrepared()) return
  saveConflict.value = false
  void save({ force: true })
}
async function conflictReload(): Promise<void> {
  if (isClosePrepared()) return
  saveConflict.value = false
  await load()
  if (!isClosePrepared()) dirty.value = false
}

// ── Cmd+K rewrite ─────────────────────────────────────────────────────────────
const cmdk = ref<{ open: boolean; instruction: string; busy: boolean; range: Range | null; code: string }>(
  { open: false, instruction: '', busy: false, range: null, code: '' }
)
const proposal = ref<{ range: Range; oldText: string; newText: string } | null>(null)
const proposalEl = ref<HTMLDivElement | null>(null)
const cmdkInput = ref<HTMLInputElement | null>(null)
// Content snapshot taken when Cmd+K opens — a proposal computed against
// different text must never be applied (its stored range would be stale).
let cmdkBaseContent: string | null = null

// Any edit while a proposal is pending shifts the captured range — discard it.
watch(content, () => {
  if (proposal.value) {
    proposal.value = null
    toast(i18n.global.t('editorWindow.ai-rewrite-discarded'), { type: 'info' })
  }
})

function toEditorRange(
  range: { startLine: number; startCol: number; endLine: number; endCol: number } | Range | null,
): Range | null {
  if (!range) return null
  if ('start' in range) return range
  return {
    start: { line: range.startLine, col: range.startCol },
    end: { line: range.endLine, col: range.endCol },
  }
}

function computeProposalDiff(oldText: string, newText: string): Array<{ type: '+' | '-' | ' '; text: string }> {
  const A = oldText.split('\n'), B = newText.split('\n')
  const capA = A.slice(0, 300), capB = B.slice(0, 300)
  const m = capA.length, n = capB.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = capA[i - 1] === capB[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  const out: Array<{ type: '+' | '-' | ' '; text: string }> = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && capA[i - 1] === capB[j - 1]) {
      out.unshift({ type: ' ', text: capA[i - 1] }); i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.unshift({ type: '+', text: capB[j - 1] }); j--
    } else {
      out.unshift({ type: '-', text: capA[i - 1] }); i--
    }
  }
  const CONTEXT = 3
  const changed = new Set(out.map((l, idx) => l.type !== ' ' ? idx : -1).filter((x) => x >= 0))
  const keep = new Set<number>()
  for (const idx of changed)
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(out.length - 1, idx + CONTEXT); k++) keep.add(k)
  const condensed: Array<{ type: '+' | '-' | ' '; text: string }> = []
  let prev = -2
  for (const idx of Array.from(keep).sort((a, b) => a - b)) {
    if (idx > prev + 1 && condensed.length > 0) condensed.push({ type: ' ', text: '⋯' })
    condensed.push(out[idx])
    prev = idx
  }
  return condensed
}

function openCmdK(): void {
  if (isClosePrepared()) return
  const range = toEditorRange(editorRef.value?.getSelectionRange() ?? null)
  const code = editorRef.value?.getSelectionText() ?? ''
  cmdk.value = { open: true, instruction: '', busy: false, range, code }
  cmdkBaseContent = content.value
  proposal.value = null
  void Promise.resolve().then(() => cmdkInput.value?.focus())
}
function closeCmdK(): void {
  cmdk.value.open = false
  editorRef.value?.focus()
}

const QUESTION_RE = /^(?:what|how|why|when|where|who|which|explain|does|is|are|can|should|could|would|tell me|describe|what'?s|how'?s)\b/i

async function submitCmdK(): Promise<void> {
  if (isClosePrepared() || cmdk.value.busy) return
  const instruction = cmdk.value.instruction.trim()
  if (!instruction) return
  if (!cmdk.value.range || !cmdk.value.code) {
    void alert('Select code to rewrite first', { title: 'Cmd+K' })
    return
  }
  // If the instruction is a question, route to AI chat instead of code rewrite
  if (QUESTION_RE.test(instruction)) {
    closeCmdK()
    emit('askWithAI', { selection: cmdk.value.code, question: instruction })
    return
  }
  cmdk.value.busy = true
  try {
    const result = await props.port.rewrite({
      code: cmdk.value.code,
      instruction,
      language: lang.value,
      model,
    })
    if (isClosePrepared()) return
    if (!result.ok || !result.text) {
      void alert(result.error || 'Rewrite failed', { title: 'Cmd+K' })
      return
    }
    // The document may have been edited during the async rewrite — the captured
    // range no longer points at the selected code, so abort instead of proposing.
    if (content.value !== cmdkBaseContent) {
      toast(i18n.global.t('editorWindow.ai-rewrite-discarded'), { type: 'info' })
      cmdk.value.open = false
      return
    }
    proposal.value = { range: cmdk.value.range, oldText: cmdk.value.code, newText: result.text }
    cmdk.value.open = false
    void nextTick(() => proposalEl.value?.focus())
  } catch {
    void alert('Connection error', { title: 'Cmd+K' })
  } finally {
    cmdk.value.busy = false
  }
}

function acceptProposal(): void {
  if (isClosePrepared() || !proposal.value) return
  editorRef.value?.applyEditExternal(proposal.value.range, proposal.value.newText)
  proposal.value = null
  dirty.value = true
  editorRef.value?.focus()
}
function rejectProposal(): void {
  proposal.value = null
  editorRef.value?.focus()
}

// ── Ghost completion (Cmd/Ctrl+I) ────────────────────────────────────────────
const ghostBusy = ref(false)

// ── Find bar (⌘F) ─────────────────────────────────────────────────────────────
const findOpen = ref(false)
const findQuery = ref('')
const findCase = ref(false)
const findWholeWord = ref(false)
const findRegex = ref(false)
const findMatches = ref<Array<{ line: number; startCol: number; endCol: number }>>([])
const findIdx = ref(-1)
// Cap match collection so a short query in a huge file cannot freeze the
// renderer with hundreds of thousands of decorations.
const FIND_MATCH_LIMIT = 1000
const findLimited = ref(false)
// Debounce keystroke-driven rescans (find input + editor edits) — a full
// document scan per character is visibly laggy on large files.
const FIND_DEBOUNCE_MS = 100
let findDebounceTimer: ReturnType<typeof setTimeout> | null = null
function scheduleComputeMatches(opts: { navigate?: boolean } = {}): void {
  if (findDebounceTimer) clearTimeout(findDebounceTimer)
  findDebounceTimer = setTimeout(() => {
    findDebounceTimer = null
    if (findOpen.value) computeMatches(opts)
  }, FIND_DEBOUNCE_MS)
}
const findInputEl = ref<HTMLInputElement | null>(null)
const replaceOpen = ref(false)
const replaceQuery = ref('')
const replaceInputEl = ref<HTMLInputElement | null>(null)

function isWordBoundary(haystack: string, matchStart: number, matchLen: number): boolean {
  const isWC = (ch: string) => /[a-zA-Z0-9_]/.test(ch)
  const before = matchStart === 0 || !isWC(haystack[matchStart - 1])
  const after = matchStart + matchLen >= haystack.length || !isWC(haystack[matchStart + matchLen])
  return before && after
}
/** True when the query contains only word characters — whole-word is meaningful. */
function queryIsAllWord(q: string): boolean { return /^[a-zA-Z0-9_]+$/.test(q) }

watch([findQuery, findCase, findWholeWord, findRegex], () => { if (findOpen.value) scheduleComputeMatches() })
// Content changed while find is open → recompute highlights but don't scroll/steal focus.
// The user may be editing in the editor itself; navigating to a match would be disruptive.
watch(content, () => { if (findOpen.value && findQuery.value) scheduleComputeMatches({ navigate: false }) })

// Sync findOpen/editorTextFocus to keybinding context so when-clauses work.
watch(findOpen, (v) => {
  if (!props.embedded || props.active !== false) setContext('findOpen', v)
})
watch(() => props.active, (active) => {
  if (!props.embedded) return
  if (active === false) {
    setContext('findOpen', false)
    setContext('editorTextFocus', false)
  } else {
    // Restore find context in nextTick so the deactivating tab's synchronous
    // context clear (above) always runs before the new tab's restore, regardless
    // of Vue watcher order (which depends on component mount order).
    void nextTick(() => setContext('findOpen', findOpen.value))
  }
})

function openFind(): void {
  const sel = editorRef.value?.getSelectionText() ?? ''
  if (!findOpen.value) {
    findOpen.value = true
    if (sel) findQuery.value = sel
  }
  void nextTick(() => { findInputEl.value?.focus(); findInputEl.value?.select() })
  if (findQuery.value) computeMatches()
}
function useSelectionForFind(): void {
  const sel = editorRef.value?.getSelectionText() ?? ''
  if (sel) findQuery.value = sel
  findOpen.value = true
  void nextTick(() => { findInputEl.value?.focus(); findInputEl.value?.select() })
  if (findQuery.value) computeMatches()
}
function closeFind(): void {
  findOpen.value = false
  replaceOpen.value = false
  if (findDebounceTimer) { clearTimeout(findDebounceTimer); findDebounceTimer = null }
  findMatches.value = []
  findIdx.value = -1
  findLimited.value = false
  editorRef.value?.setDecorations([])
  editorRef.value?.focus()
}
function computeMatches({ navigate = true }: { navigate?: boolean } = {}): void {
  const q = findQuery.value
  if (!q) {
    findMatches.value = []
    findIdx.value = -1
    editorRef.value?.setDecorations([])
    return
  }
  const text = editorRef.value?.getValue() ?? content.value
  const lines = text.split('\n')
  const matches: Array<{ line: number; startCol: number; endCol: number }> = []
  let limited = false

  if (findRegex.value) {
    try {
      const flags = 'g' + (findCase.value ? '' : 'i')
      const re = new RegExp(q, flags)
      for (let li = 0; li < lines.length && !limited; li++) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(lines[li])) !== null) {
          if (matches.length >= FIND_MATCH_LIMIT) { limited = true; break }
          matches.push({ line: li, startCol: m.index, endCol: m.index + m[0].length })
          if (m[0].length === 0) { re.lastIndex++; break }
        }
      }
    } catch {
      // Invalid regex — show no matches
    }
  } else {
    const needle = findCase.value ? q : q.toLowerCase()
    for (let li = 0; li < lines.length && !limited; li++) {
      const haystack = findCase.value ? lines[li] : lines[li].toLowerCase()
      let start = 0
      while (true) {
        const idx = haystack.indexOf(needle, start)
        if (idx === -1) break
        if (!findWholeWord.value || !queryIsAllWord(q) || isWordBoundary(haystack, idx, q.length)) {
          if (matches.length >= FIND_MATCH_LIMIT) { limited = true; break }
          matches.push({ line: li, startCol: idx, endCol: idx + q.length })
        }
        start = idx + needle.length
      }
    }
  }

  findLimited.value = limited
  findMatches.value = matches
  if (findIdx.value < 0 || findIdx.value >= matches.length) findIdx.value = matches.length > 0 ? 0 : -1
  updateFindDecorations()
  if (navigate && findIdx.value >= 0) goToMatch(findIdx.value)
}
function updateFindDecorations(): void {
  editorRef.value?.setDecorations(findMatches.value.map((m, i) => ({
    id: `find-${i}`,
    type: 'highlight' as const,
    range: { start: { line: m.line, col: m.startCol }, end: { line: m.line, col: m.endCol } },
    className: i === findIdx.value ? 'ev-dec-current' : undefined,
  })))
}
function goToMatch(idx: number): void {
  findIdx.value = idx
  updateFindDecorations()
  const m = findMatches.value[idx]
  if (m) {
    editorRef.value?.revealPosition(m.line, m.startCol)
    // revealPosition schedules an async focus() on the editor textarea.
    // Queue a later microtask to give focus back to the find input so the user
    // can keep pressing Enter/Shift+Enter without re-clicking the search box.
    if (findOpen.value) void Promise.resolve().then(() => findInputEl.value?.focus())
  }
}
function nextMatch(): void {
  if (!findMatches.value.length) return
  goToMatch((findIdx.value + 1) % findMatches.value.length)
}
function prevMatch(): void {
  if (!findMatches.value.length) return
  goToMatch((findIdx.value - 1 + findMatches.value.length) % findMatches.value.length)
}
function openReplace(): void {
  replaceOpen.value = true
  openFind()
  void nextTick(() => replaceInputEl.value?.focus())
}
function replaceNext(): void {
  if (isClosePrepared() || findIdx.value < 0 || !findMatches.value.length) return
  const m = findMatches.value[findIdx.value]
  let replacement = replaceQuery.value
  if (findRegex.value) {
    // Expand backreferences ($1, $& etc.) by applying the regex to the matched slice.
    try {
      const text = editorRef.value?.getValue() ?? content.value
      const lineText = text.split('\n')[m.line] ?? ''
      const flags = findCase.value ? '' : 'i'
      const re = new RegExp(findQuery.value, flags)
      replacement = lineText.slice(m.startCol, m.endCol).replace(re, replaceQuery.value)
    } catch { /* invalid regex — use literal replacement */ }
  }
  editorRef.value?.applyEditExternal(
    { start: { line: m.line, col: m.startCol }, end: { line: m.line, col: m.endCol } },
    replacement,
  )
  dirty.value = true
  void nextTick(() => computeMatches({ navigate: true }))
}
function replaceAll(): void {
  if (isClosePrepared() || !findMatches.value.length) return
  const q = findQuery.value
  const oldText = editorRef.value?.getValue() ?? content.value
  let newText: string
  try {
    if (findRegex.value) {
      // Regex mode: use query as regex; allow backreferences in replacement string.
      // 'm' flag so ^/$ anchor per line, matching the per-line highlighter.
      const flags = findCase.value ? 'gm' : 'gim'
      const re = new RegExp(q, flags)
      newText = oldText.replace(re, replaceQuery.value)
    } else {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const needWordBoundary = findWholeWord.value && queryIsAllWord(q)
      const pattern = needWordBoundary ? `\\b${escaped}\\b` : escaped
      const flags = findCase.value ? 'g' : 'gi'
      const re = new RegExp(pattern, flags)
      // Escape $ in replacement so it's treated as a literal string, not a backreference.
      const literalReplace = replaceQuery.value.replace(/\$/g, '$$$$')
      newText = oldText.replace(re, literalReplace)
    }
  } catch {
    return // Invalid regex
  }
  if (newText === oldText) return
  const lines = oldText.split('\n')
  const lastLine = lines.length - 1
  // Route through applyEditExternal so the change is registered in UndoStack.
  editorRef.value?.applyEditExternal(
    { start: { line: 0, col: 0 }, end: { line: lastLine, col: lines[lastLine].length } },
    newText,
  )
  dirty.value = true
  void nextTick(() => computeMatches({ navigate: false }))
}
function selectCurrentFindMatch(): void {
  const idx = findIdx.value >= 0 ? findIdx.value : 0
  const m = findMatches.value[idx]
  if (!m) return
  editorRef.value?.setSelection({ line: m.line, col: m.startCol }, { line: m.line, col: m.endCol })
  closeFind()
  void nextTick(() => editorRef.value?.focus())
}
function onFindKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); closeFind() }
  else if (e.key === 'Enter' && e.altKey) { e.preventDefault(); selectCurrentFindMatch() }
  else if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prevMatch() : nextMatch() }
  else if (e.key === 'Tab' && replaceOpen.value) { e.preventDefault(); replaceInputEl.value?.focus() }
  else if (e.altKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); findCase.value = !findCase.value }
  else if (e.altKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); findWholeWord.value = !findWholeWord.value }
  else if (e.altKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); findRegex.value = !findRegex.value }
}
function onReplaceKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); closeFind() }
  else if (e.key === 'Enter' && e.altKey) { e.preventDefault(); replaceAll() }
  else if (e.key === 'Enter') { e.preventDefault(); replaceNext() }
  else if (e.key === 'Tab') { e.preventDefault(); findInputEl.value?.focus() }
}

// ── Go-to-line overlay (⌘L) ──────────────────────────────────────────────────
const gotoOpen = ref(false)
const gotoLineInput = ref('')
const gotoInputEl = ref<HTMLInputElement | null>(null)

// Cursor position saved before goto opens; restored on Escape
let _gotoSavedLine = 1
let _gotoSavedCol = 0

function openGoto(): void {
  _gotoSavedLine = cursorLine.value
  _gotoSavedCol = cursorCol.value - 1
  gotoOpen.value = true
  gotoLineInput.value = String(cursorLine.value)
  void nextTick(() => { gotoInputEl.value?.focus(); gotoInputEl.value?.select() })
}
function closeGoto(): void {
  gotoOpen.value = false
  editorRef.value?.focus()
}
function _applyGotoInput(): void {
  const parts = gotoLineInput.value.split(':')
  const line = parseInt(parts[0], 10)
  const col = parts[1] !== undefined ? parseInt(parts[1], 10) : NaN
  if (!isNaN(line) && line > 0) {
    if (!isNaN(col) && col > 0) editorRef.value?.revealPosition(line - 1, col - 1)
    else editorRef.value?.revealLine(line)
  }
}
function submitGoto(): void {
  _applyGotoInput()
  closeGoto()
}
function onGotoKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    editorRef.value?.revealPosition(_gotoSavedLine - 1, _gotoSavedCol)
    closeGoto()
  } else if (e.key === 'Enter') {
    e.preventDefault(); submitGoto()
  }
}
// Live preview: move editor view as user types line number
watch(gotoLineInput, () => { if (gotoOpen.value) _applyGotoInput() })

// ── Right-click context menu ──────────────────────────────────────────────────
const ctxOpen = ref(false)
const ctxX = ref(0)
const ctxY = ref(0)
const ctxMenuEl = ref<HTMLElement | null>(null)
async function showContextMenu(e: MouseEvent): Promise<void> {
  e.preventDefault()
  const container = (e.currentTarget as HTMLElement).getBoundingClientRect()
  ctxX.value = e.clientX - container.left
  ctxY.value = e.clientY - container.top
  ctxOpen.value = true
  await nextTick()
  if (ctxMenuEl.value) {
    const rect = ctxMenuEl.value.getBoundingClientRect()
    if (rect.right > window.innerWidth) ctxX.value -= rect.right - window.innerWidth + 4
    if (rect.bottom > window.innerHeight) ctxY.value -= rect.bottom - window.innerHeight + 4
  }
}
function closeContextMenu(): void { ctxOpen.value = false }
let _ctxEscHandler: ((e: KeyboardEvent) => void) | null = null
watch(ctxOpen, (open) => {
  if (_ctxEscHandler) { document.removeEventListener('keydown', _ctxEscHandler, true); _ctxEscHandler = null }
  if (!open) {
    document.removeEventListener('click', closeContextMenu, true)
    return
  }
  _ctxEscHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeContextMenu() }
  document.addEventListener('keydown', _ctxEscHandler, true)
  document.addEventListener('click', closeContextMenu, true)
})
async function ctxPaste(): Promise<void> {
  closeContextMenu()
  if (isClosePrepared()) return
  try {
    const text = await navigator.clipboard.readText()
    if (!isClosePrepared() && text) editorRef.value?.insertText(text)
  } catch { /* permission denied */ }
  editorRef.value?.focus()
}
function ctxCopy(): void {
  closeContextMenu()
  const sel = editorRef.value?.getSelectionText() ?? ''
  if (sel) void navigator.clipboard.writeText(sel)
  editorRef.value?.focus()
}
function ctxCut(): void {
  closeContextMenu()
  if (isClosePrepared()) return
  const sel = editorRef.value?.getSelectionText() ?? ''
  if (sel) {
    void navigator.clipboard.writeText(sel)
    // insertText('') is a no-op in Monaco — delete the selection via a real edit.
    const range = toEditorRange(editorRef.value?.getSelectionRange() ?? null)
    if (range) editorRef.value?.applyEditExternal(range, '')
  }
  editorRef.value?.focus()
}

function onEditorBodyFocusin(e: FocusEvent): void {
  if (props.embedded && props.active === false) return
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'TEXTAREA') {
    setContext('editorTextFocus', true)
  } else if (tag === 'INPUT') {
    // goto-line input is inside ep-body; clear editor focus so keybindings don't fire
    setContext('editorTextFocus', false)
  }
}
function onEditorBodyFocusout(e: FocusEvent): void {
  if ((e.target as HTMLElement)?.tagName === 'TEXTAREA') {
    const body = e.currentTarget as HTMLElement
    const related = e.relatedTarget as HTMLElement | null
    if (!related || !body.contains(related)) {
      setContext('editorTextFocus', false)
    }
  }
}

async function requestGhost(): Promise<void> {
  if (isClosePrepared() || ghostBusy.value) return
  const cur = editorRef.value?.getCursor()
  const value = editorRef.value?.getValue() ?? ''
  if (!cur) return
  const lines = value.split('\n')
  const prefix = [...lines.slice(0, cur.line), lines[cur.line]?.slice(0, cur.col) ?? ''].join('\n')
  const suffix = [lines[cur.line]?.slice(cur.col) ?? '', ...lines.slice(cur.line + 1)].join('\n')
  ghostBusy.value = true
  try {
    const result = await props.port.complete({
      prefix, suffix, language: lang.value, model,
    })
    if (isClosePrepared()) return
    if (result.ok && result.text) {
      // Guard: cursor may have moved while waiting for the AI response.
      // Showing ghost text at a different position than where it was computed is wrong.
      const newCur = editorRef.value?.getCursor()
      if (!newCur || newCur.line !== cur.line || newCur.col !== cur.col) return
      editorRef.value?.setGhost(result.text)
      editorRef.value?.focus()
    } else {
      toast(result.error || i18n.global.t('editorWindow.no-completion'), { type: 'info' })
    }
  } catch {
    // ignore — timeout or WS close; ghostBusy is reset in finally
  } finally {
    ghostBusy.value = false
  }
}

// ── Keyboard shortcuts (window-level) ─────────────────────────────────────────
function onKeydown(e: KeyboardEvent): void {
  // When embedded, several panes share the window; only the active one reacts so
  // a shortcut never fires on a hidden file.
  if (props.embedded && props.active === false) return
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); void save() }
  else if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openCmdK() }
  else if (mod && (e.key === 'i' || e.key === 'I')) { e.preventDefault(); void requestGhost() }
  else if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind() }
  else if (mod && (e.key === 'g' || e.key === 'G') && findOpen.value) {
    e.preventDefault()
    e.shiftKey ? prevMatch() : nextMatch()
  }
  // Cmd/Ctrl+L (go to line) is NOT duplicated here: the central keybinding
  // dispatcher owns it (defaults.ts `cmd+l` -> editor.action.gotoLine, when
  // editorOpen) and consumes the event before this bubble-phase listener.
}

let _unsubGitChanged: (() => void) | null = null

onMounted(() => {
  // The host (IDE shell) owns the window title when embedded.
  if (!props.embedded) document.title = `${props.name} — Mini-IDE`
  window.addEventListener('keydown', onKeydown)
  // Wait for the consumer's connection before loading, then retry on reconnect.
  watch(
    () => props.port.status.value,
    (s) => {
      if (s === 'connected' && !loaded.value) {
        // A load that failed while the socket was down (e.g. request timeout)
        // must not latch the error forever — clear it and retry on reconnect.
        loadError.value = ''
        void load()
      }
    },
    { immediate: true },
  )
  // Reload from disk when git changes the working tree (checkout, reset, etc.)
  // but only if the user hasn't made local edits.
  _unsubGitChanged = props.port.onFilesChanged((workspacePath) => {
    // Deliberate: a tab opened from outside the window's workspace uses its own
    // parent directory as workspace root, which no git watcher reports on, so
    // it never auto-reloads here. Correct — that root is not a repo we watch.
    if (workspacePath !== props.workspacePath) return
    if (isClosePrepared() || !loaded.value || dirty.value) return
    const preContent = content.value // snapshot to detect edits typed mid-read
    void (async () => {
      try {
        const result = await trackRead(() => props.port.readFile({
          workspacePath: props.workspacePath,
          relPath: props.relPath,
        }))
        if (isClosePrepared() || !result.ok) return
        // The user may have started typing while the read was in flight —
        // applying the disk version now would clobber those keystrokes.
        if (dirty.value || content.value !== preContent) return
        if (result.mtime !== undefined) fileMtime.value = result.mtime
        const fresh = result.content ?? ''
        if (fresh !== content.value) {
          eol.value = detectEOL(fresh)
          content.value = fresh
        }
      } catch { /* ignore — WS transient error */ }
    })()
  })
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  if (findDebounceTimer) { clearTimeout(findDebounceTimer); findDebounceTimer = null }
  if (_ctxEscHandler) { document.removeEventListener('keydown', _ctxEscHandler, true); _ctxEscHandler = null }
  document.removeEventListener('click', closeContextMenu, true)
  _unsubGitChanged?.()
  _unsubGitChanged = null
  // Clear keybinding contexts so a closed tab's stale state can't block
  // shortcuts in other panes.
  setContext('findOpen', false)
  setContext('editorTextFocus', false)
})

function toggleLineComment(): void { editorRef.value?.toggleLineComment() }
function addLineComment(): void { editorRef.value?.addLineComment() }
function removeLineComment(): void { editorRef.value?.removeLineComment() }
function toggleBlockComment(): void { editorRef.value?.toggleBlockComment() }
function jumpToLine(n: number): void { editorRef.value?.revealLine(n); editorRef.value?.focus() }
function deleteLine(): void { editorRef.value?.deleteLine() }
function deleteWordLeft(): void { editorRef.value?.deleteWordLeft() }
function deleteWordRight(): void { editorRef.value?.deleteWordRight() }
function deleteLineLeft(): void { editorRef.value?.deleteLineLeft() }
function deleteLineRight(): void { editorRef.value?.deleteLineRight() }
function insertLineBelow(): void { editorRef.value?.insertLineBelow() }
function insertLineAbove(): void { editorRef.value?.insertLineAbove() }
function moveLineUp(): void { editorRef.value?.moveLineUp() }
function moveLineDown(): void { editorRef.value?.moveLineDown() }
function jumpToBracket(): void { editorRef.value?.jumpToBracket() }
function selectToBracket(): void { editorRef.value?.selectToBracket() }
function duplicateLineDown(): void { editorRef.value?.duplicateLineDown() }
function duplicateLineUp(): void { editorRef.value?.duplicateLineUp() }
function indentLine(): void { editorRef.value?.indentLine() }
function dedentLine(): void { editorRef.value?.dedentLine() }
function cursorTop(): void { editorRef.value?.cursorTop() }
function cursorBottom(): void { editorRef.value?.cursorBottom() }
function cursorTopSelect(): void { editorRef.value?.cursorTopSelect() }
function cursorBottomSelect(): void { editorRef.value?.cursorBottomSelect() }
function cursorLineStart(): void { editorRef.value?.cursorLineStart() }
function cursorLineEnd(): void { editorRef.value?.cursorLineEnd() }
function cursorLineStartSelect(): void { editorRef.value?.cursorLineStartSelect() }
function cursorLineEndSelect(): void { editorRef.value?.cursorLineEndSelect() }
function selectCurrentWord(): void { editorRef.value?.selectCurrentWord() }
function cursorWordLeft(): void { editorRef.value?.cursorWordLeft() }
function cursorWordRight(): void { editorRef.value?.cursorWordRight() }
function cursorWordLeftSelect(): void { editorRef.value?.cursorWordLeftSelect() }
function cursorWordRightSelect(): void { editorRef.value?.cursorWordRightSelect() }
function scrollLineUp(): void { editorRef.value?.scrollLineUp() }
function scrollLineDown(): void { editorRef.value?.scrollLineDown() }

// ── Tab size / indentation ────────────────────────────────────────────────────
const editorTabSize = ref(2)
const editorUseSpaces = ref(true)
const indentPickerOpen = ref(false)
function openIndentPicker(): void { indentPickerOpen.value = !indentPickerOpen.value; encodingPickerOpen.value = false }

const encodingPickerOpen = ref(false)
const ENCODING_OPTIONS = [
  'UTF-8', 'UTF-8 with BOM', 'UTF-16', 'UTF-16 LE', 'UTF-16 BE',
  'Latin-1', 'Windows 1252', 'Windows 1251',
  'GB2312', 'GBK', 'Big5', 'Shift JIS', 'EUC-JP', 'EUC-KR',
]
function openEncodingPicker(): void { encodingPickerOpen.value = !encodingPickerOpen.value; indentPickerOpen.value = false }
async function reopenWithEncoding(enc: string): Promise<void> {
  if (isClosePrepared()) return
  encodingPickerOpen.value = false
  // Reopening replaces the buffer with the on-disk content — never silently
  // discard unsaved edits.
  if (dirty.value) {
    const ok = await confirm(
      'Reopening with a different encoding discards your unsaved changes. Continue?',
      { title: 'Unsaved changes', confirmText: 'Reopen' },
    )
    if (!ok || isClosePrepared()) return
  }
  // Map display name → Python codec name for re-open request
  const encMap: Record<string, string> = {
    'UTF-8': 'utf-8', 'UTF-8 with BOM': 'utf-8-sig', 'UTF-16': 'utf-16',
    'UTF-16 LE': 'utf-16-le', 'UTF-16 BE': 'utf-16-be',
    'Latin-1': 'latin-1', 'Windows 1252': 'cp1252', 'Windows 1251': 'cp1251',
    'GB2312': 'gb2312', 'GBK': 'gbk', 'Big5': 'big5',
    'Shift JIS': 'shift_jis', 'EUC-JP': 'euc_jp', 'EUC-KR': 'euc_kr',
  }
  try {
    const result = await trackRead(() => props.port.readFile({
      workspacePath: props.workspacePath,
      relPath: props.relPath,
      encoding: encMap[enc] ?? enc.toLowerCase(),
    }))
    if (isClosePrepared()) return
    if (result.ok && result.content !== undefined) {
      content.value = result.content
      fileEncoding.value = enc
      fileCodec.value = encMap[enc] ?? enc.toLowerCase()
      fileBom.value = result.bom ?? false
      fileMtime.value = result.mtime ?? fileMtime.value
      eol.value = detectEOL(result.content)
      dirty.value = false
    } else {
      toast(result.error ?? i18n.global.t('editorWindow.reopen-encoding-failed'), { type: 'error' })
    }
  } catch { toast(i18n.global.t('editorWindow.encoding-switch-failed'), { type: 'error' }) }
}
function setIndent(size: number, spaces: boolean): void {
  editorTabSize.value = size
  editorUseSpaces.value = spaces
  editorRef.value?.setTabSize(size)
  editorRef.value?.setUseSpaces(spaces)
}
function transformToUppercase(): void { editorRef.value?.transformToUppercase() }
function transformToLowercase(): void { editorRef.value?.transformToLowercase() }
function transformToTitleCase(): void { editorRef.value?.transformToTitleCase() }
function transformToSnakeCase(): void { editorRef.value?.transformToSnakeCase() }
function transformToCamelCase(): void { editorRef.value?.transformToCamelCase() }
function transformToKebabCase(): void { editorRef.value?.transformToKebabCase() }
function transformToPascalCase(): void { editorRef.value?.transformToPascalCase() }
function transformToBase64(): void { editorRef.value?.transformToBase64() }
function transformFromBase64(): void { editorRef.value?.transformFromBase64() }
function transformToUrlEncoded(): void { editorRef.value?.transformToUrlEncoded() }
function transformFromUrlEncoded(): void { editorRef.value?.transformFromUrlEncoded() }
function trimTrailingWhitespace(): void { editorRef.value?.trimTrailingWhitespace() }
function formatDocument(): void { editorRef.value?.formatDocument() }
function formatSelection(): void { editorRef.value?.formatSelection() }
function expandSelection(): void { editorRef.value?.expandSelection() }
function shrinkSelection(): void { editorRef.value?.shrinkSelection() }
function joinLines(): void { editorRef.value?.joinLines() }
function sortLinesAscending(): void { editorRef.value?.sortLinesAscending() }
function sortLinesDescending(): void { editorRef.value?.sortLinesDescending() }
function reverseLines(): void { editorRef.value?.reverseLines() }
function removeDuplicateLines(): void { editorRef.value?.removeDuplicateLines() }
function openLinkAtCursor(): boolean { return editorRef.value?.openLinkAtCursor() ?? false }
function selectLine(): void { editorRef.value?.selectLine() }
function transpose(): void { editorRef.value?.transpose() }
function indentationToSpaces(): void { editorRef.value?.indentationToSpaces() }
function indentationToTabs(): void { editorRef.value?.indentationToTabs() }

function selectNextOccurrence(): void {
  editorRef.value?.selectNextOccurrence()
}

function selectAllOccurrences(): void {
  const sel = editorRef.value?.getSelectionText() || editorRef.value?.getWordAtCursor() || ''
  if (!sel) return
  findQuery.value = sel
  if (!findOpen.value) findOpen.value = true
  computeMatches()
  void nextTick(() => { findInputEl.value?.focus(); findInputEl.value?.select() })
}

function setLanguage(l: string): void { langOverride.value = l || null }
function zoomIn(): void { editorRef.value?.zoomIn() }
function zoomOut(): void { editorRef.value?.zoomOut() }
function zoomReset(): void { editorRef.value?.zoomReset() }
function toggleLineNumbers(): void { editorRef.value?.toggleLineNumbers() }
function toggleWordWrap(): void { editorRef.value?.toggleWordWrap() }
function undo(): void { editorRef.value?.undo() }
function redo(): void { editorRef.value?.redo() }
function selectAll(): void { editorRef.value?.selectAll() }

function focusEditor(): void { editorRef.value?.focus() }

function prepareClose(): { isCurrent(): boolean; release(): void } | null {
  if (closePreparation) return closePreparation
  if (isClosePrepared() || readsInFlight !== 0 || writesInFlight !== 0 || cmdk.value.busy || ghostBusy.value) return null
  const pane = editorRef.value
  const modelIdentity = pane?.getModelIdentity()
  if (!loaded.value || loadError.value || isBinaryFile.value || !pane || !modelIdentity) return null

  const workspacePath = props.workspacePath
  const relPath = props.relPath
  closePrepared.value = true
  pane.setReadOnly(true)

  let released = false
  const guard = {
    isCurrent: (): boolean => !released
      && closePreparation === guard
      && closePrepared.value
      && props.workspacePath === workspacePath
      && props.relPath === relPath
      && editorRef.value === pane
      && pane.getModelIdentity() === modelIdentity,
    release: (): void => {
      if (released) return
      released = true
      if (closePreparation !== guard) return
      closePreparation = null
      closePrepared.value = false
      pane.setReadOnly(false)
    },
  }
  closePreparation = guard
  return guard
}

/** Waits for the current load, then positions the existing Monaco model without rereading it. */
async function revealPositionWhenReady(line: number, column: number): Promise<boolean> {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) return false
  await pendingLoad
  if (!loaded.value || loadError.value) return false
  await nextTick()
  const editor = editorRef.value
  if (!editor) return false
  editor.revealPosition(line - 1, column - 1)
  return true
}

defineExpose({
  save, prepareClose, openCmdK, requestGhost, openFind, useSelectionForFind, nextMatch, prevMatch, openGoto,
  focus: focusEditor, revealPositionWhenReady,
  toggleLineComment, addLineComment, removeLineComment, toggleBlockComment, jumpToLine,
  deleteLine, deleteWordLeft, deleteWordRight, deleteLineLeft, deleteLineRight, insertLineBelow, insertLineAbove,
  moveLineUp, moveLineDown, jumpToBracket, selectToBracket, duplicateLineDown, duplicateLineUp,
  indentLine, dedentLine, cursorTop, cursorBottom, cursorTopSelect, cursorBottomSelect,
  cursorLineStart, cursorLineEnd, cursorLineStartSelect, cursorLineEndSelect,
  selectCurrentWord,
  cursorWordLeft, cursorWordRight, cursorWordLeftSelect, cursorWordRightSelect,
  scrollLineUp, scrollLineDown,
  transformToUppercase, transformToLowercase, transformToTitleCase,
  transformToSnakeCase, transformToCamelCase, transformToKebabCase, transformToPascalCase,
  transformToBase64, transformFromBase64, transformToUrlEncoded, transformFromUrlEncoded,
  trimTrailingWhitespace, formatDocument, formatSelection,
  joinLines, sortLinesAscending, sortLinesDescending,
  reverseLines, removeDuplicateLines, openLinkAtCursor,
  selectLine,
  transpose, indentationToSpaces, indentationToTabs,
  expandSelection, shrinkSelection,
  selectNextOccurrence, selectAllOccurrences,
  navigateToLastEdit,
  foldAt: (line: number) => editorRef.value?.foldAt(line),
  unfoldAt: (line: number) => editorRef.value?.unfoldAt(line),
  toggleFoldAt: (line: number) => editorRef.value?.toggleFoldAt(line),
  foldAll: () => editorRef.value?.foldAll(),
  unfoldAll: () => editorRef.value?.unfoldAll(),
  foldToLevel: (n: number) => editorRef.value?.foldToLevel(n),
  foldRecursively: (line: number) => editorRef.value?.foldRecursively(line),
  unfoldRecursively: (line: number) => editorRef.value?.unfoldRecursively(line),
  setLanguage, zoomIn, zoomOut, zoomReset, toggleLineNumbers, toggleWordWrap,
  undo, redo, selectAll,
  openReplace,
  getContent: () => content.value,
  changeEOL,
  setIndent,
  getCursorLine: () => editorRef.value?.getCursorLine?.() ?? editorRef.value?.getCursor()?.line ?? 0,
  insertCursorAbove: () => editorRef.value?.insertCursorAbove(),
  insertCursorBelow: () => editorRef.value?.insertCursorBelow(),
  addCursorsToLineEnds: () => editorRef.value?.addCursorsToLineEnds(),
  getWordAtCursor: () => editorRef.value?.getWordAtCursor() ?? '',
  getSelection: () => editorRef.value?.getSelectionText() ?? '',
  insertTextAtCursor: (text: string) => editorRef.value?.insertText(text),
  getCursorLineText: (): string => {
    const cur = editorRef.value?.getCursor()
    if (!cur) return ''
    return content.value.split('\n')[cur.line] ?? ''
  },
})
</script>

<template>
  <div class="editor-pane">
    <!-- Tabs (standalone mode only; embedded mode uses EditorWindowApp tab bar) -->
    <div v-if="!embedded" class="ep-tabs">
      <div class="ep-tab active">
        <span class="ep-tab-name">{{ name }}</span>
        <span v-if="dirty" class="ep-dirty" :title="$t('label.unsaved')">●</span>
      </div>
      <div class="ep-spacer" />
      <button class="ep-act" :title="$t('editorWindow.pane.ai-complete-title')" :disabled="ghostBusy || !loaded" @click="requestGhost">
        {{ ghostBusy ? '…' : '✦ ' + $t('editorWindow.pane.complete') }}
      </button>
      <button class="ep-act" :title="$t('editorWindow.pane.ai-rewrite-title')" :disabled="!loaded" @click="openCmdK">✦ Cmd+K</button>
    </div>

    <!-- Editor -->
    <div class="ep-body" @focusin="onEditorBodyFocusin" @focusout="onEditorBodyFocusout" @contextmenu="showContextMenu" @mouseup="onEditorBodyMouseup">
      <div v-if="!loaded && backendStatus === 'error'" class="ep-error ep-backend-error">
        <span>{{ port.lastError.value || $t('error.backend-start-failed') }}</span>
        <button class="ep-retry" @click="retryBackend">{{ $t('action.retry') }}</button>
      </div>
      <div v-else-if="loadError" class="ep-error ep-backend-error">
        <span>{{ loadError }}</span>
        <button class="ep-retry" @click="retryLoad">{{ $t('action.retry') }}</button>
      </div>
      <!-- Binary / image file preview -->
      <div v-else-if="loaded && isBinaryFile" class="ep-binary">
        <div v-if="isImageFile && imageDataUrl" class="ep-binary-img-wrap">
          <img :src="imageDataUrl" class="ep-binary-img" :alt="props.name" />
        </div>
        <div v-else class="ep-binary-placeholder">
          <span class="ep-binary-icon">⬛</span>
          <p class="ep-binary-name">{{ props.name }}</p>
          <p class="ep-binary-meta">{{ $t('preview.binary-file') }} · {{ binaryExt.toUpperCase().replace('.','') || 'BIN' }} · {{ binarySize > 1048576 ? (binarySize/1048576).toFixed(1)+' MB' : binarySize > 1024 ? (binarySize/1024).toFixed(1)+' KB' : binarySize+' B' }}</p>
          <p class="ep-binary-hint">{{ $t('preview.cannot-display-text') }}</p>
        </div>
      </div>
      <EditorViewMonaco
        v-else-if="loaded"
        ref="editorRef"
        :model-value="content"
        :language="lang"
        :diagnostics="fileDiagnostics"
        :read-only="closePrepared"
        @update:model-value="onChange"
        @cursor-change="onCursorChange"
      />
      <div v-else class="ep-loading">
        {{ backendStatus === 'connected' ? $t('label.loading') : $t('label.waiting-backend') }}
      </div>

      <!-- Floating "Add to Chat" button — appears on text selection -->
      <Transition name="ep-float-fade">
        <button
          v-if="floatingChat && selectionInfo"
          class="ep-float-chat-btn"
          :style="{ left: floatingChat.x + 'px', top: floatingChat.y + 'px' }"
          @mousedown.prevent="onAddToChatFloat"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0">
            <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l.72 1.5h1.47a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1 0-1.5h1.47L6.94 12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
          </svg>
          {{ $t('action.add-to-ai-chat') }}
        </button>
      </Transition>

      <!-- Context menu -->
      <div v-if="ctxOpen" class="ep-ctx-backdrop" @mousedown.self="closeContextMenu">
        <div ref="ctxMenuEl" class="ep-ctx-menu" :style="{ left: ctxX + 'px', top: ctxY + 'px' }">
          <button class="ep-ctx-item" @click="ctxCut">{{ $t('action.cut') }}</button>
          <button class="ep-ctx-item" @click="ctxCopy">{{ $t('action.copy') }}</button>
          <button class="ep-ctx-item" @click="ctxPaste">{{ $t('action.paste') }}</button>
          <div class="ep-ctx-sep" />
          <button class="ep-ctx-item" @click="() => { closeContextMenu(); toggleLineComment() }">{{ $t('action.toggle-comment') }}</button>
          <button class="ep-ctx-item" @click="() => { closeContextMenu(); openFind() }">{{ $t('action.find') }}</button>
          <div class="ep-ctx-sep" />
          <button class="ep-ctx-item" @click="() => { const sel = editorRef?.getSelectionText?.() ?? ''; closeContextMenu(); emit('addToChat', sel || editorRef?.getValue?.() || '') }">{{ $t('action.add-to-ai-chat') }}</button>
          <button class="ep-ctx-item ep-ctx-ai" @click="() => { const sel = editorRef?.getSelectionText?.() ?? ''; closeContextMenu(); emit('explainWithAI', sel || editorRef?.getValue?.() || '') }">{{ $t('action.explain-with-ai') }}</button>
          <button class="ep-ctx-item ep-ctx-ai" @click="() => { const sel = editorRef?.getSelectionText?.() ?? ''; closeContextMenu(); emit('fixWithAI', sel || editorRef?.getValue?.() || '') }">{{ $t('action.fix-with-ai') }}</button>
          <button class="ep-ctx-item ep-ctx-ai" @click="() => { const sel = editorRef?.getSelectionText?.() ?? ''; closeContextMenu(); emit('writeTestsWithAI', sel || editorRef?.getValue?.() || '') }">{{ $t('editorWindow.pane.generate-tests') }}</button>
          <div class="ep-ctx-sep" />
          <button class="ep-ctx-item" @click="() => { closeContextMenu(); editorRef?.selectAll() }">{{ $t('settings.keybindings.cmd.editor_action_selectAll') }}</button>
        </div>
      </div>

      <!-- Go-to-line overlay -->
      <div v-if="gotoOpen" class="ep-goto-overlay">
        <div class="ep-goto-box">
          <span class="ep-goto-label">{{ $t('editorWindow.pane.go-to-line') }}</span>
          <input
            ref="gotoInputEl"
            v-model="gotoLineInput"
            type="number"
            class="ep-goto-input"
            :placeholder="$t('label.line-number')"
            min="1"
            @keydown="onGotoKeydown"
          />
          <button class="ep-act" @click="submitGoto">{{ $t('editorWindow.pane.go') }}</button>
        </div>
      </div>
    </div>

    <!-- Cmd+K bar -->
    <div v-if="cmdk.open" class="ep-cmdk">
      <span class="ep-cmdk-badge">✦ Cmd+K</span>
      <input
        ref="cmdkInput"
        v-model="cmdk.instruction"
        class="ep-cmdk-input"
        :placeholder="$t('label.inline-edit-placeholder')"
        @keydown.enter="submitCmdK"
        @keydown.esc="closeCmdK"
      />
      <button class="ep-act primary" :disabled="cmdk.busy" @click="submitCmdK">{{ cmdk.busy ? $t('editorWindow.pane.thinking') : QUESTION_RE.test(cmdk.instruction.trim()) ? $t('editorWindow.pane.ask') : $t('editorWindow.pane.rewrite') }}</button>
      <button class="ep-act" @click="closeCmdK">{{ $t('action.cancel') }}</button>
    </div>

    <!-- AI diff proposal -->
    <div
      v-if="proposal"
      ref="proposalEl"
      class="ep-proposal"
      tabindex="-1"
      @keydown.tab.prevent="acceptProposal"
      @keydown.esc.prevent="rejectProposal"
    >
      <div class="ep-prop-head">
        <span>{{ $t('editorWindow.pane.proposal-title') }} <span class="ep-prop-hint">{{ $t('editorWindow.pane.proposal-hint') }}</span></span>
        <div class="ep-prop-actions">
          <button class="ep-act success" @click="acceptProposal">✓ {{ $t('editorWindow.pane.accept') }}</button>
          <button class="ep-act" @click="rejectProposal">✕ {{ $t('editorWindow.pane.reject') }}</button>
        </div>
      </div>
      <div class="ep-prop-diff">
        <pre
          v-for="(ln, li) in computeProposalDiff(proposal.oldText, proposal.newText)"
          :key="li"
          class="ep-diff-line"
          :class="ln.type === '+' ? 'ep-diff-add' : ln.type === '-' ? 'ep-diff-del' : 'ep-diff-ctx'"
        ><span class="ep-diff-sign">{{ ln.type === '+' ? '+' : ln.type === '-' ? '-' : ' ' }}</span>{{ ln.text }}</pre>
      </div>
    </div>

    <!-- Find / Replace bar (⌘F / ⌘⌥F / Esc) -->
    <div v-if="findOpen" class="ep-find">
      <div class="ep-find-row">
        <input
          ref="findInputEl"
          v-model="findQuery"
          class="ep-find-input"
          :placeholder="$t('label.find-in-editor')"
          @keydown="onFindKeydown"
        />
        <button
          class="ep-find-btn"
          :class="{ active: findCase }"
          :title="$t('action.match-case-shortcut')"
          @click="findCase = !findCase"
        >Aa</button>
        <button
          class="ep-find-btn"
          :class="{ active: findWholeWord }"
          :title="$t('action.match-whole-word')"
          @click="findWholeWord = !findWholeWord"
        >W|</button>
        <button
          class="ep-find-btn"
          :class="{ active: findRegex }"
          :title="$t('action.use-regex')"
          @click="findRegex = !findRegex"
        >.*</button>
        <span class="ep-find-count" :title="findLimited ? $t('label.find-limited', { n: findMatches.length }) : undefined">
          <template v-if="findQuery && findMatches.length === 0">{{ $t('label.no-results') }}</template>
          <template v-else-if="findMatches.length">{{ findIdx + 1 }}/{{ findMatches.length }}{{ findLimited ? '+' : '' }}</template>
        </span>
        <button class="ep-find-nav" :title="$t('action.prev-match') + ' (⇧↵)'" :disabled="!findMatches.length" @click="prevMatch">↑</button>
        <button class="ep-find-nav" :title="$t('action.next-match') + ' (↵)'" :disabled="!findMatches.length" @click="nextMatch">↓</button>
        <button
          class="ep-find-btn"
          :class="{ active: replaceOpen }"
          :title="$t('action.toggle-replace')"
          @click="replaceOpen = !replaceOpen"
        >ab</button>
        <button class="ep-find-close" :title="$t('action.close-esc')" @click="closeFind">✕</button>
      </div>
      <div v-if="replaceOpen" class="ep-find-row">
        <input
          ref="replaceInputEl"
          v-model="replaceQuery"
          class="ep-find-input"
          :placeholder="$t('label.replace-in-editor')"
          @keydown="onReplaceKeydown"
        />
        <button class="ep-find-nav" :title="$t('editorWindow.pane.replace-title')" :disabled="findIdx < 0" @click="replaceNext">⇥</button>
        <button class="ep-find-nav" :title="$t('editorWindow.pane.replace-all-title')" :disabled="!findMatches.length" @click="replaceAll">⇥⇥</button>
      </div>
    </div>

    <!-- Save conflict bar — the file changed on disk since it was loaded -->
    <div v-if="saveConflict" class="ep-conflict">
      <span class="ep-conflict-msg">{{ $t('label.save-conflict') }}</span>
      <button class="ep-act" @click="conflictOverwrite">{{ $t('action.overwrite') }}</button>
      <button class="ep-act" @click="conflictReload">{{ $t('action.reload') }}</button>
    </div>

    <!-- Status bar -->
    <div class="ep-statusbar">
      <span class="ep-status-pos">{{ $t('editorWindow.pane.cursor-position', { line: cursorLine, col: cursorCol }) }}</span>
      <span v-if="selectionInfo" class="ep-status-sel">{{ selectionInfo }}</span>
      <span class="ep-status-right">
        <button class="ep-status-eol" :title="$t('editorWindow.pane.eol-title', { eol })" @click="changeEOL(eol === 'LF' ? 'CRLF' : 'LF')">{{ eol }}</button>
        <span class="ep-status-sep">·</span>
        <button class="ep-status-indent" :title="editorUseSpaces ? $t('editorWindow.pane.indent-spaces-title', { size: editorTabSize }) : $t('editorWindow.pane.indent-tabs-title')" @click="openIndentPicker">{{ editorUseSpaces ? $t('editorWindow.pane.spaces-size', { size: editorTabSize }) : $t('editorWindow.pane.tab-size', { size: editorTabSize }) }}</button>
        <span class="ep-status-sep">·</span>
        <span class="ep-status-lang">{{ langDisplay }}</span>
        <span class="ep-status-sep">·</span>
        <button
          class="ep-status-enc"
          :title="$t('editorWindow.pane.encoding-title', { encoding: fileEncoding + (fileBom ? ' (BOM)' : '') })"
          @click="openEncodingPicker"
        >{{ fileEncoding }}{{ fileBom ? ' BOM' : '' }}</button>
      </span>
      <!-- Indent picker -->
      <div v-if="indentPickerOpen" class="ep-indent-picker">
        <div class="ep-indent-header">{{ $t('editorWindow.pane.indentation') }}</div>
        <button v-for="n in [2, 4, 6, 8]" :key="n" class="ep-indent-opt" :class="{ active: editorUseSpaces && editorTabSize === n }" @click="setIndent(n, true); indentPickerOpen = false">{{ $t('editorWindow.pane.n-spaces', { n }) }}</button>
        <div class="ep-indent-sep" />
        <button v-for="n in [2, 4, 8]" :key="'t' + n" class="ep-indent-opt" :class="{ active: !editorUseSpaces && editorTabSize === n }" @click="setIndent(n, false); indentPickerOpen = false">{{ $t('editorWindow.pane.n-tabs', { n }) }}</button>
      </div>
      <!-- Encoding picker -->
      <div v-if="encodingPickerOpen" class="ep-indent-picker ep-enc-picker">
        <div class="ep-indent-header">{{ $t('editorWindow.pane.reopen-encoding') }}</div>
        <button
          v-for="enc in ENCODING_OPTIONS"
          :key="enc"
          class="ep-indent-opt"
          :class="{ active: fileEncoding === enc }"
          @click="reopenWithEncoding(enc)"
        >{{ enc }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
  color: var(--text-primary);
}
.ep-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.ep-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
}
.ep-tab.active { border-color: var(--accent-emphasis); color: var(--text-bright); background: var(--bg-elevated); }
.ep-dirty { color: var(--attention-fg); font-size: var(--font-3xs); }
.ep-spacer { flex: 1; }
.ep-act {
  font-size: 11.5px;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ep-act:hover:not(:disabled) { background: var(--bg-muted); color: var(--text-bright); }
.ep-act:focus-visible, .ep-retry:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.ep-act:disabled { opacity: 0.5; cursor: default; }
.ep-act.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ep-act.success { background: var(--success-emphasis); border-color: var(--success-strong); color: var(--text-on-emphasis); }
.ep-body { flex: 1; position: relative; min-height: 0; }
.ep-error, .ep-loading { padding: 24px; color: var(--text-muted); font-size: var(--font-xs); }
.ep-error { color: var(--danger-fg); }
.ep-backend-error { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
.ep-retry {
  font-size: 11.5px;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ep-retry:hover { background: var(--bg-muted); color: var(--text-bright); }

/* Binary / image file preview */
.ep-binary { flex: 1; display: flex; align-items: center; justify-content: center; overflow: auto; background: var(--bg-subtle); }
.ep-binary-img-wrap { max-width: 100%; max-height: 100%; padding: 24px; }
.ep-binary-img { max-width: 100%; max-height: 70vh; object-fit: contain; border-radius: var(--radius-xs); box-shadow: 0 2px 16px rgba(0,0,0,.3); }
.ep-binary-placeholder { text-align: center; padding: 48px 24px; color: var(--text-muted); }
.ep-binary-icon { font-size: 40px; display: block; opacity: 0.3; margin-bottom: 12px; }
.ep-binary-name { font-size: 15px; font-weight: 600; color: var(--text-secondary); margin: 0 0 6px; }
.ep-binary-meta { font-size: var(--font-xs); margin: 0 0 10px; opacity: 0.7; }
.ep-binary-hint { font-size: var(--font-2xs); opacity: 0.5; margin: 0; }

/* Encoding picker */
.ep-enc-picker { max-height: 280px; overflow-y: auto; }

.ep-cmdk {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-default);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.ep-cmdk-badge { font-size: var(--font-2xs); font-weight: 700; color: var(--accent-fg); }
.ep-cmdk-input {
  flex: 1;
  padding: 6px 10px;
  font-size: 12.5px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  outline: none;
}
.ep-cmdk-input:focus { border-color: var(--accent-emphasis); }

.ep-proposal {
  flex-shrink: 0;
  max-height: 40%;
  overflow: auto;
  border-top: 1px solid var(--border-default);
  background: var(--bg-subtle);
}
.ep-prop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 11.5px;
  color: var(--text-secondary);
  position: sticky;
  top: 0;
  background: var(--bg-subtle);
}
.ep-prop-actions { display: flex; gap: 6px; }
.ep-prop-hint { font-size: var(--font-3xs); color: var(--text-muted); margin-left: 8px; font-weight: 400; }
.ep-prop-diff {
  display: flex;
  flex-direction: column;
  padding: 4px 0;
  background: var(--bg-base);
  overflow-x: auto;
}
.ep-diff-line {
  margin: 0;
  padding: 0 12px;
  font: 12px/1.6 ui-monospace, Menlo, monospace;
  white-space: pre;
  display: flex;
  gap: 6px;
}
.ep-diff-sign { flex-shrink: 0; width: 10px; }
.ep-diff-add { color: var(--diff-add-fg); background: var(--diff-add-bg); }
.ep-diff-del { color: var(--diff-del-fg); background: var(--diff-del-bg); }
.ep-diff-ctx { color: var(--text-muted); }

.ep-conflict {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-top: 1px solid var(--border-default);
  background: var(--bg-subtle);
  flex-shrink: 0;
  font-size: var(--font-xs);
}
.ep-conflict-msg { color: var(--attention-fg); flex: 1; }

.ep-find {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 10px;
  border-top: 1px solid var(--border-default);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.ep-find-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ep-find-input {
  flex: 1;
  max-width: 240px;
  padding: 4px 8px;
  font-size: 12.5px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  color: var(--text-primary);
  outline: none;
}
.ep-find-input:focus { border-color: var(--accent-emphasis); }
.ep-find-btn {
  padding: 3px 7px;
  font-size: var(--font-2xs);
  font-family: inherit;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ep-find-btn.active { background: var(--accent-muted); color: var(--accent-fg); border-color: var(--accent-emphasis); }
.ep-find-count { font-size: var(--font-2xs); color: var(--text-muted); min-width: 52px; text-align: center; }
.ep-find-nav {
  padding: 3px 8px;
  font-size: var(--font-sm);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ep-find-nav:hover:not(:disabled) { background: var(--bg-muted); }
.ep-find-nav:disabled { opacity: 0.4; cursor: default; }
.ep-find-close {
  padding: 3px 7px;
  font-size: var(--font-2xs);
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.ep-find-close:hover { color: var(--text-primary); }

.ep-goto-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
  z-index: 20;
}
.ep-goto-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-top: none;
  border-radius: 0 0 8px 8px;
  pointer-events: all;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.ep-goto-label { font-size: var(--font-xs); color: var(--text-secondary); white-space: nowrap; }
.ep-goto-input {
  width: 72px;
  padding: 4px 8px;
  font-size: var(--font-sm);
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  color: var(--text-primary);
  outline: none;
  text-align: center;
}
.ep-goto-input:focus { border-color: var(--accent-emphasis); }
.ep-goto-input::-webkit-inner-spin-button,
.ep-goto-input::-webkit-outer-spin-button { -webkit-appearance: none; }

.ep-ctx-backdrop {
  position: absolute; inset: 0; z-index: 200;
}
.ep-ctx-menu {
  position: absolute;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 16px rgba(0,0,0,.28);
  padding: 4px 0;
  min-width: 160px;
  z-index: 201;
}
.ep-ctx-item {
  display: block; width: 100%; text-align: left;
  padding: 5px 14px; font-size: var(--font-xs);
  background: none; border: none; cursor: pointer;
  color: var(--text-primary);
}
.ep-ctx-item:hover { background: var(--accent-muted); }
.ep-ctx-item.ep-ctx-ai { color: var(--accent-fg); }
.ep-ctx-sep { height: 1px; background: var(--border-default); margin: 3px 0; }

.ep-statusbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  height: 22px;
  background: var(--bg-inset);
  color: var(--text-muted);
  font-size: var(--font-2xs);
  flex-shrink: 0;
  user-select: none;
  border-top: 1px solid var(--border-muted);
}
.ep-status-pos { font-variant-numeric: tabular-nums; }
.ep-status-sel { font-variant-numeric: tabular-nums; padding-left: 8px; }
.ep-status-right { display: flex; align-items: center; gap: 1px; }
.ep-status-sep { opacity: 0.35; padding: 0 3px; }
.ep-status-eol, .ep-status-indent, .ep-status-enc {
  background: none; border: none; cursor: pointer; padding: 1px 6px;
  color: var(--text-muted); font-size: inherit; font-family: inherit;
  border-radius: 3px; transition: background 0.1s, color 0.1s;
}
.ep-status-eol:hover, .ep-status-indent:hover, .ep-status-enc:hover {
  background: var(--bg-hover); color: var(--text-primary);
}
.ep-status-lang { padding: 0 3px; }
.ep-indent-picker {
  position: absolute; bottom: calc(100% + 4px); right: 8px;
  background: var(--bg-overlay); border: 1px solid var(--border-default);
  border-radius: var(--radius-sm); box-shadow: 0 4px 16px rgba(0,0,0,.28);
  padding: 4px 0; min-width: 140px; z-index: 300;
}
.ep-indent-header { padding: 4px 12px 2px; font-size: var(--font-3xs); opacity: 0.5; text-transform: uppercase; letter-spacing: .04em; }
.ep-indent-opt { display: block; width: 100%; text-align: left; padding: 4px 12px; background: none; border: none; cursor: pointer; font-size: var(--font-xs); color: var(--text-primary); }
.ep-indent-opt:hover, .ep-indent-opt.active { background: var(--accent-muted); color: var(--accent-fg); }
.ep-indent-sep { height: 1px; background: var(--border-default); margin: 3px 0; }

.ep-float-chat-btn {
  position: absolute;
  z-index: 150;
  display: flex; align-items: center; gap: 5px;
  padding: 4px 10px; font-size: var(--font-2xs); font-weight: 600;
  background: var(--accent-emphasis); color: var(--text-on-emphasis);
  border: none; border-radius: var(--radius-sm); cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  transform: translateX(-50%);
  pointer-events: all;
  white-space: nowrap;
  user-select: none;
}
.ep-float-chat-btn:hover { filter: brightness(1.12); }
.ep-float-fade-enter-active, .ep-float-fade-leave-active { transition: opacity 0.1s, transform 0.1s; }
.ep-float-fade-enter-from, .ep-float-fade-leave-to { opacity: 0; transform: translateX(-50%) translateY(4px); }
</style>
