<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AiCliProfile, AiCliSessionController, AiCliTerminalView, AiCliTerminalResources, SafeAiCliPanelHandle } from './index'
import { terminalSnapshotCandidates, TERMINAL_MOUSE_MODE_RESET, TERMINAL_NEW_PROCESS_RESET, TERMINAL_RECONNECTED_DIVIDER } from './terminalSnapshots'
import { terminalClipboardChunks, extractClipboardImage } from './terminalClipboard'
import { createTerminalMentionMenu } from './terminalMentionMenu'
import { readXtermTheme } from './terminalTheme'
import { createTerminalInputHandlers, encodeShiftEnter } from './terminalInput'
import { createResizeController, type ResizeController } from './terminalResize'
import { installTerminalLinks, extractPlanDocRelPath, isTerminalLinkModifier, isTerminalLinkModifierKey, openTerminalFileLink } from './terminalLinkInteraction'
import { buildMentionPickData, clusterMentionCandidates, shouldOpenMentionMenu, type MentionCandidate } from './terminalMentionModel'
import { setContext, settingsGet, settingsReadiness, settingsReady, settingsSet } from './shared'

const QUIET_MS = 3_500
const QUIET_TIMEOUT_MS = 25_000
const MIN_WIDTH = 280
const MAX_WIDTH = 600
const EARLY_OUTPUT_LIMIT = 64 * 1024

const props = withDefaults(defineProps<{
  controller: AiCliSessionController
  defaultProfileId?: string
  initialCols?: number
  initialRows?: number
  buildContext?: () => string | Promise<string>
  widthKey?: string
  defaultWidth?: number
  allowCancelStart?: boolean
  embedded?: boolean
  injectQuietMs?: number
  injectTimeoutMs?: number
  waitForStartupOutput?: boolean
  profilePreference?: { read(): Promise<string | null>; write(profileId: string): Promise<void> }
  terminalView?: AiCliTerminalView
  terminalResources?: AiCliTerminalResources
  beforeResume?: () => Promise<void>
  workspacePath?: string
}>(), { defaultProfileId: 'claude', initialCols: 100, initialRows: 30, widthKey: 'git-ai-panel-width', defaultWidth: 360, injectQuietMs: QUIET_MS, injectTimeoutMs: QUIET_TIMEOUT_MS })

const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const terminalHost = shallowRef<HTMLElement | null>(null)
const running = ref(props.controller.sessionId !== null)
const pending = ref(false)
const initializing = ref(true)
const collapsed = ref(!open.value)
const error = ref<string | null>(null)
const profiles = ref<AiCliProfile[]>([])
const selectedProfileId = ref(settingsGet(`${props.widthKey}.agent`, props.defaultProfileId))
const panelWidth = ref(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(settingsGet(props.widthKey, props.defaultWidth)) || props.defaultWidth)))
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let serializer: SerializeAddon | null = null
let replayedSnapshot = false
let snapshotTimer: ReturnType<typeof setTimeout> | null = null
let lastSnapshotAt = 0
let lastSnapshotActivityAt = 0
let disposed = false
let selectionSubscription: { dispose(): void } | null = null
let terminalInput: ReturnType<typeof createTerminalInputHandlers> | null = null
let terminalLinks: ReturnType<typeof installTerminalLinks> | null = null
let commandHeld = false
let lastMouseX = 0
let lastMouseY = 0
function trackCommandKey(event: KeyboardEvent | MouseEvent): void {
  if (event instanceof MouseEvent) {
    lastMouseX = event.clientX
    lastMouseY = event.clientY
    commandHeld = isTerminalLinkModifier(event)
    return
  }
  if (!isTerminalLinkModifierKey(event.key)) return
  const held = event.type === 'keydown'
  if (commandHeld === held) return
  commandHeld = held
  // Refresh xterm's link hover when Cmd changes under a stationary pointer.
  terminalHost.value?.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, clientX: lastMouseX, clientY: lastMouseY, metaKey: held,
  }))
}
function clearCommandKey(): void { commandHeld = false }
let mentionMenu: ReturnType<typeof createTerminalMentionMenu> | null = null
let mentionTargets: MentionCandidate[] = []
let mentionTimer: ReturnType<typeof setInterval> | null = null
let resizeObserver: ResizeObserver | null = null
let terminalResize: ResizeController | null = null
const terminalSession = computed(() => running.value ? props.controller.sessionId ?? '' : '')
const lastRawActivityAt = ref(0)
let themeObserver: MutationObserver | null = null
let lastOutputAt = 0
let inputQueue = Promise.resolve()
let initialization: Promise<void> = Promise.resolve()
let earlyOutput = ''
let stopWidthResize: (() => void) | null = null

const removeOutputListener = props.controller.onOutput((data) => {
  lastOutputAt = Date.now()
  lastRawActivityAt.value = lastOutputAt
  if (terminal) terminal.write(data)
  else earlyOutput = `${earlyOutput}${data}`.slice(-EARLY_OUTPUT_LIMIT)
})
const removeExitListener = props.controller.onExit(() => { running.value = false })

async function saveSnapshot(): Promise<void> {
  if (!props.terminalView || !serializer || !running.value) return
  const fullScreenTui = profiles.value.find(profile => profile.id === selectedProfileId.value)?.fullScreenTui === true
  await props.terminalView.save(terminalSnapshotCandidates(options => serializer!.serialize(options), fullScreenTui))
}

function scheduleSnapshot(): void {
  if (!props.terminalView || disposed) return
  snapshotTimer = setTimeout(() => {
    const now = Date.now()
    if (running.value && lastOutputAt !== 0 && lastOutputAt !== lastSnapshotActivityAt &&
      now - lastOutputAt >= 3000 && now - lastSnapshotAt >= 60_000) {
      const activity = lastOutputAt
      void saveSnapshot().then(() => { lastSnapshotAt = now; lastSnapshotActivityAt = activity })
        .catch(cause => reportError(cause, 'ai-cli.send-failed'))
    }
    scheduleSnapshot()
  }, document.hidden || collapsed.value ? 10_000 : 1000)
}

function terminalFontKey(event: KeyboardEvent): void {
  if (!props.terminalView || !terminal || !event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return
  let size = Number(terminal.options.fontSize)
  if (event.code === 'Equal' || event.key === '=' || event.key === '+') size++
  else if (event.code === 'Minus' || event.key === '-') size--
  else if (event.code === 'Digit0' || event.key === '0') size = 12
  else return
  event.preventDefault()
  if (size <= 0) return
  terminal.options.fontSize = size
  void props.terminalView.setFontSize(size).then(fitAndResize)
    .catch(cause => reportError(cause, 'ai-cli.resize-failed'))
}

async function pasteClipboardText(text: string): Promise<void> {
  if (!running.value || pending.value || !terminal) return
  const profile = profiles.value.find(item => item.id === selectedProfileId.value)
  const bracketed = terminal.modes.bracketedPasteMode || (/[\r\n]/.test(text) && profile?.bracketedPaste === true)
  terminal.clearSelection()
  terminalInput?.resetSelection()
  // Send the existing 512-unit burst in call order without a round-trip per
  // chunk. Failed writes are surfaced, never retried and duplicated.
  const results = await Promise.allSettled(terminalClipboardChunks(text, bracketed).map(chunk => props.controller.send(chunk)))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

function clipboardPaste(event: ClipboardEvent): void {
  if (!props.terminalResources || event.target !== terminal?.textarea) return
  const text = event.clipboardData?.getData('text/plain')
  const image = text ? null : extractClipboardImage(event.clipboardData)
  if (!text && !image) return
  event.preventDefault()
  event.stopPropagation()
  if (terminal?.textarea) terminal.textarea.value = ''
  void (async () => {
    if (text) await pasteClipboardText(text)
    else if (image) {
      const path = await props.terminalResources!.saveClipboardImage(image)
      if (!path) throw new Error('Clipboard image could not be saved')
      await pasteClipboardText(path)
    }
  })().catch(cause => reportError(cause, 'ai-cli.send-failed'))
}

function terminalContextMenu(event: MouseEvent): void {
  if (!props.terminalResources) return
  event.preventDefault()
  event.stopPropagation()
  terminal?.focus()
  void props.terminalResources.showContextMenu(terminal?.getSelection() ?? '')
    .catch(cause => reportError(cause, 'ai-cli.send-failed'))
}

async function refreshMentionTargets(): Promise<void> {
  if (!props.terminalResources || !running.value) { mentionTargets = []; return }
  try { mentionTargets = clusterMentionCandidates(await props.terminalResources.listMentionTargets()) }
  catch { mentionTargets = [] }
}

function reportError(cause: unknown, fallbackKey: string): void {
  error.value = cause instanceof Error ? cause.message : t(fallbackKey)
}

function enqueueInput(data: string): Promise<void> {
  const next = inputQueue.catch(() => undefined).then(() => props.controller.send(data))
  inputQueue = next.catch(() => undefined)
  return next
}

async function fitAndResize(): Promise<void> {
  if (terminalResize) {
    if (!collapsed.value) terminalResize.applyFit()
    return
  }
  if (!terminal || !fitAddon || !running.value || collapsed.value) return
  fitAddon.fit()
  await props.controller.resize(terminal.cols, terminal.rows)
}

async function start(): Promise<void> {
  await initialization
  if (pending.value || running.value) return
  pending.value = true
  error.value = null
  if (props.waitForStartupOutput) lastOutputAt = 0
  try {
    if (props.terminalView && replayedSnapshot) {
      terminal?.write(TERMINAL_NEW_PROCESS_RESET + TERMINAL_RECONNECTED_DIVIDER)
      replayedSnapshot = false
    }
    await props.controller.start(
      selectedProfileId.value,
      terminal?.cols || props.initialCols,
      terminal?.rows || props.initialRows,
      { yolo: settingsGet<string>('agentTeam.yolo', '1') !== '0' },
    )
    running.value = props.controller.sessionId !== null
    if (!running.value) return
    void refreshMentionTargets()
    if (!props.waitForStartupOutput) lastOutputAt = Date.now()
    await nextTick()
    await fitAndResize()
    const context = (await props.buildContext?.())?.trim()
    if (context) {
      await waitForQuiet()
      await enqueueInput(`\u001b[200~${context}\u001b[201~`)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await enqueueInput('\r')
    }
    terminal?.focus()
  } catch (cause) {
    reportError(cause, 'ai-cli.start-failed')
  } finally {
    pending.value = false
  }
}

function selectProfile(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  selectProfileId(value)
}

function selectProfileId(value: string): void {
  if (running.value || pending.value || !profiles.value.some(profile => profile.id === value)) return
  selectedProfileId.value = value
  persistProfile(value)
}

function persistProfile(value: string): void {
  if (props.profilePreference) {
    void props.profilePreference.write(value).catch(cause => reportError(cause, 'ai-cli.start-failed'))
  } else settingsSet(`${props.widthKey}.agent`, value)
}

function beginWidthResize(event: PointerEvent): void {
  if (collapsed.value) return
  event.preventDefault()
  const startX = event.clientX
  const startWidth = panelWidth.value
  const move = (next: PointerEvent) => {
    panelWidth.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth - (next.clientX - startX)))
  }
  const finish = () => {
    settingsSet(props.widthKey, panelWidth.value)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    stopWidthResize = null
  }
  stopWidthResize?.()
  stopWidthResize = finish
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish, { once: true })
}

async function stop(): Promise<void> {
  if (props.allowCancelStart && pending.value && !running.value) {
    try { await props.controller.cancelStart?.() }
    catch (cause) { reportError(cause, 'ai-cli.stop-failed') }
    return
  }
  if (!running.value || pending.value) return
  pending.value = true
  error.value = null
  try {
    await props.controller.stop()
    running.value = false
  } catch (cause) {
    reportError(cause, 'ai-cli.stop-failed')
  } finally {
    pending.value = false
  }
}

async function interrupt(): Promise<void> {
  if (!running.value || pending.value) return
  try {
    await props.controller.interrupt()
  } catch (cause) {
    reportError(cause, 'ai-cli.interrupt-failed')
  }
}

function focus(): void {
  if (collapsed.value) collapsed.value = false
  void nextTick(() => terminal?.focus())
}

// Whether this panel's terminal currently holds focus. Published as the shared
// `terminalFocus` keybinding context, which every rule written to yield to a
// focused PTY reads (`escape` in the Plan window, the Git window's git.*
// chords). The Host renderer's own terminal composable publishes it for CLI
// panes; a plugin window has no such composable, so without this the guard is
// vacuously true there and the key is consumed before the PTY ever sees it.
let ownsTerminalFocus = false

function claimTerminalFocus(): void {
  ownsTerminalFocus = true
  setContext('terminalFocus', true)
}

function releaseTerminalFocus(): void {
  if (!ownsTerminalFocus) return
  ownsTerminalFocus = false
  setContext('terminalFocus', false)
}

function onTerminalFocusOut(event: FocusEvent): void {
  // Focus moving within the terminal (xterm swaps its helper textarea) is not a
  // release. Anything else is — including a null relatedTarget, which is what a
  // click on a non-focusable element elsewhere in the window reports; treating
  // that as "only the window blurred" would strand the context on for good.
  const next = event.relatedTarget
  if (next instanceof Node && terminalHost.value?.contains(next)) return
  releaseTerminalFocus()
}

async function waitForQuiet(): Promise<void> {
  const deadline = Date.now() + props.injectTimeoutMs
  while (running.value && Date.now() < deadline &&
    ((props.waitForStartupOutput && lastOutputAt === 0) || Date.now() - lastOutputAt < props.injectQuietMs)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function submitPrompt(prompt: string): Promise<boolean> {
  if (!running.value) await start()
  if (!running.value) return false
  await waitForQuiet()
  if (!running.value) return false
  try {
    await enqueueInput(`\u001b[200~${prompt}\u001b[201~`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await enqueueInput('\r')
    focus()
    return true
  } catch (cause) {
    reportError(cause, 'ai-cli.send-failed')
    return false
  }
}

async function pasteText(text: string): Promise<boolean> {
  if (!running.value || pending.value) return false
  try {
    await enqueueInput(text)
    return true
  } catch (cause) {
    reportError(cause, 'ai-cli.send-failed')
    return false
  }
}

async function injectNow(): Promise<void> {
  if (!running.value || !props.buildContext) return
  const text = await props.buildContext()
  if (!text || !await pasteText(`\u001b[200~${text}\u001b[201~`)) return
  await new Promise(resolve => setTimeout(resolve, 300))
  await pasteText('\r')
}

onMounted(() => {
  terminal = new Terminal({
    convertEol: !props.terminalView,
    cursorBlink: true,
    scrollback: props.terminalView ? 10_000 : 5_000,
    fontFamily: props.terminalView ? 'Menlo, Monaco, "Courier New", monospace' : 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 12,
    theme: props.terminalView ? readXtermTheme() : { background: '#00000000' },
    ...(props.terminalView ? { macOptionClickForcesSelection: true, minimumContrastRatio: 7, allowProposedApi: true } : {}),
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  if (props.terminalView) {
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = '11'
    serializer = new SerializeAddon()
    terminal.loadAddon(serializer)
    window.addEventListener('keydown', terminalFontKey, true)
  }
  if (props.terminalResources) {
    mentionMenu = createTerminalMentionMenu({
      terminal,
      host: () => terminalHost.value,
      onPick: (query, addresses) => {
        const data = buildMentionPickData(query, addresses)
        if (data && running.value) void enqueueInput(data).catch(cause => reportError(cause, 'ai-cli.send-failed'))
      },
    })
    mentionTimer = setInterval(() => { void refreshMentionTargets() }, 10_000)
  }
  if (terminalHost.value) {
    terminal.open(terminalHost.value)
    if (props.terminalView && props.controller.redraw) {
      terminalResize = createResizeController(
        terminal, fitAddon!, terminalSession, terminalHost, lastRawActivityAt,
        async (_session, cols, rows) => {
          await props.controller.resize(cols, rows)
          return { ok: true, payload: {}, error: null }
        },
        async (_session, cols, rows) => {
          await props.controller.redraw!(cols, rows)
          return { ok: true, payload: {}, error: null }
        },
        () => false,
        () => undefined,
      )
      terminalResize.attachObserver(terminalHost.value)
    }
    if (props.terminalView) {
      themeObserver = new MutationObserver(() => {
        if (terminal) terminal.options.theme = readXtermTheme()
      })
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    }
    // focusin/focusout rather than the textarea's own focus/blur: xterm owns
    // that element and may replace it, and these bubble from whichever one it
    // is currently using.
    terminalHost.value.addEventListener('focusin', claimTerminalFocus)
    terminalHost.value.addEventListener('focusout', onTerminalFocusOut)
    if (props.terminalResources) {
      if (props.terminalResources.openFilePicker && props.terminalResources.openExternal) {
        terminalLinks = installTerminalLinks({
          terminal,
          element: terminalHost.value,
          isCmdHeld: () => commandHeld,
          sessionId: () => props.controller.sessionId ?? undefined,
          workspacePath: () => props.workspacePath,
          extractPlanDocRelPath,
          openExternal: url => props.terminalResources!.openExternal!(url).catch(cause => reportError(cause, 'ai-cli.send-failed')),
          openFilePicker: request => {
            void openTerminalFileLink(props.terminalResources!, { query: request.query, candidates: request.candidates, ...(request.line !== undefined ? { line: request.line } : {}) })
              .catch(cause => reportError(cause, 'ai-cli.send-failed'))
          },
          ...(props.terminalResources.openPlan ? { openPlan: ({ relPath }: { relPath: string }) => props.terminalResources!.openPlan!(relPath).catch(cause => reportError(cause, 'ai-cli.send-failed')) } : {}),
        })
        terminalHost.value.addEventListener('mousedown', terminalLinks.handler, true)
        terminalHost.value.addEventListener('mousemove', trackCommandKey)
        window.addEventListener('keydown', trackCommandKey)
        window.addEventListener('keyup', trackCommandKey)
        window.addEventListener('blur', clearCommandKey)
      }
      terminalHost.value.addEventListener('paste', clipboardPaste, true)
      terminalHost.value.addEventListener('contextmenu', terminalContextMenu)
      selectionSubscription = terminal.onSelectionChange(() => {
        void props.terminalResources!.reportSelection(terminal?.getSelection() ?? '')
          .catch(cause => reportError(cause, 'ai-cli.send-failed'))
      })
      terminalInput = createTerminalInputHandlers({
        terminal,
        isAgentPane: () => true,
        send: data => {
          if (running.value) void enqueueInput(data).catch(cause => reportError(cause, 'ai-cli.send-failed'))
        },
        encodeNewline: () => encodeShiftEnter(profiles.value.find(profile => profile.id === selectedProfileId.value)),
        finalizeStaleComposition: () => {
          const helper = (terminal as unknown as { _core?: { _compositionHelper?: { isComposing: boolean; compositionend(): void } } })?._core?._compositionHelper
          if (helper?.isComposing) helper.compositionend()
        },
        reportEmptyCopy: () => {
          void props.terminalResources!.reportSelection('').catch(cause => reportError(cause, 'ai-cli.send-failed'))
        },
        copy: text => {
          void navigator.clipboard.writeText(text).catch(cause => reportError(cause, 'ai-cli.send-failed'))
        },
      })
      terminal.attachCustomKeyEventHandler(terminalInput.keyHandler)
      terminal.attachCustomWheelEventHandler(terminalInput.wheelHandler)
    }
  }
  if (earlyOutput) {
    terminal.write(earlyOutput)
    earlyOutput = ''
  }
  terminal.onData((data) => {
    if (!running.value) return
    void enqueueInput(data).catch((cause) => reportError(cause, 'ai-cli.send-failed'))
    if (mentionMenu?.active) mentionMenu.onData(data)
    else if (mentionMenu && terminal && mentionTargets.length) {
      const buffer = terminal.buffer.active
      const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(false, 0, buffer.cursorX) ?? ''
      if (shouldOpenMentionMenu(data, line)) setTimeout(() => {
        if (!disposed) mentionMenu?.open(mentionTargets)
      }, 0)
    }
  })
  if (!terminalResize) {
    resizeObserver = new ResizeObserver(() => {
      void fitAndResize().catch((cause) => reportError(cause, 'ai-cli.resize-failed'))
    })
    if (terminalHost.value) resizeObserver.observe(terminalHost.value)
  }
  initialization = (async () => {
    if (props.terminalView) {
      const state = await props.terminalView.read()
      if (disposed) return
      terminal!.options.fontSize = state.fontSize
      if (state.lastSize) terminal!.resize(state.lastSize.cols, state.lastSize.rows)
      if (state.snapshot) {
        await new Promise<void>(resolve => terminal!.write(state.snapshot!, resolve))
        replayedSnapshot = true
      }
      terminal!.write(TERMINAL_MOUSE_MODE_RESET)
    }
    let canPersistSettings = false
    try {
      await settingsReady()
      canPersistSettings = true
    } catch {
      // The owning v2 surface renders a retry affordance. Keep this panel
      // usable with non-persistent defaults, but never write them back.
    }
    profiles.value = await props.controller.listProfiles()
    if (props.profilePreference) {
      selectedProfileId.value = await props.profilePreference.read() ?? props.defaultProfileId
    }
    if (!profiles.value.some(({ id }) => id === selectedProfileId.value)) {
      selectedProfileId.value = profiles.value[0]?.id ?? props.defaultProfileId
      if (canPersistSettings) persistProfile(selectedProfileId.value)
    }
    await props.beforeResume?.()
    if (disposed) return
    const resumed = await props.controller.resume(terminal?.cols || props.initialCols, terminal?.rows || props.initialRows)
    if (resumed && props.controller.sessionId) {
      replayedSnapshot = false
      running.value = true
      void refreshMentionTargets()
      selectedProfileId.value = resumed.profileId
      if (canPersistSettings) persistProfile(resumed.profileId)
    }
    await fitAndResize()
    scheduleSnapshot()
  })().catch((cause) => reportError(cause, 'ai-cli.start-failed')).finally(() => { initializing.value = false })
})

watch(collapsed, async (value) => {
  open.value = !value
  if (value) return
  await nextTick()
  await fitAndResize().catch((cause) => reportError(cause, 'ai-cli.resize-failed'))
})
watch(open, value => { collapsed.value = !value })

// If the first authoritative snapshot failed, the panel may have rendered with
// non-persistent defaults while the surrounding v2 surface offers Retry. Apply
// the real snapshot when that retry succeeds, without reacting to later user
// edits or queued writes.
watch(() => settingsReadiness.status, (status) => {
  if (status !== 'ready') return
  selectedProfileId.value = settingsGet(`${props.widthKey}.agent`, selectedProfileId.value)
  panelWidth.value = Math.min(
    MAX_WIDTH,
    Math.max(MIN_WIDTH, Number(settingsGet(props.widthKey, panelWidth.value)) || panelWidth.value),
  )
})

onUnmounted(() => {
  window.removeEventListener('keydown', terminalFontKey, true)
  disposed = true
  if (snapshotTimer) clearTimeout(snapshotTimer)
  if (mentionTimer) clearInterval(mentionTimer)
  mentionMenu?.close()
  void saveSnapshot().catch(() => undefined)
  terminalHost.value?.removeEventListener('focusin', claimTerminalFocus)
  terminalHost.value?.removeEventListener('focusout', onTerminalFocusOut)
  terminalHost.value?.removeEventListener('paste', clipboardPaste, true)
  terminalHost.value?.removeEventListener('contextmenu', terminalContextMenu)
  if (terminalLinks) terminalHost.value?.removeEventListener('mousedown', terminalLinks.handler, true)
  terminalHost.value?.removeEventListener('mousemove', trackCommandKey)
  window.removeEventListener('keydown', trackCommandKey)
  window.removeEventListener('keyup', trackCommandKey)
  window.removeEventListener('blur', clearCommandKey)
  terminalLinks?.dispose()
  selectionSubscription?.dispose()
  // A panel unmounted while focused never fires focusout, and a stuck-on
  // context would disable every `!terminalFocus` binding in the window.
  releaseTerminalFocus()
  resizeObserver?.disconnect()
  terminalResize?.dispose()
  themeObserver?.disconnect()
  stopWidthResize?.()
  removeOutputListener()
  removeExitListener()
  terminal?.dispose()
  fitAddon?.dispose()
  props.controller.dispose()
})

defineExpose<SafeAiCliPanelHandle>({
  get status() { return running.value ? 'running' : pending.value ? 'starting' : 'idle' },
  get profiles() { return profiles.value },
  get profileId() { return selectedProfileId.value },
  get initializing() { return initializing.value },
  selectProfile: selectProfileId,
  start, focus, submitPrompt, stop, interrupt, pasteText, injectNow,
})
</script>

<template>
  <section
    class="navide-safe-ai-cli"
    :class="{ 'is-collapsed': collapsed && !embedded, 'is-embedded': embedded }"
    :style="embedded || collapsed ? undefined : { width: `${panelWidth}px` }"
    :aria-label="t('ai-cli.label')"
  >
    <div v-if="!collapsed && !embedded" class="navide-safe-ai-cli__resizer" @pointerdown="beginWidthResize" />
    <header v-if="!embedded" class="navide-safe-ai-cli__toolbar">
      <strong>{{ t('ai-cli.title') }}</strong>
      <select
        v-if="!running"
        :value="selectedProfileId"
        :aria-label="t('ai-cli.profile')"
        @change="selectProfile"
      >
        <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.label }}</option>
      </select>
      <span class="navide-safe-ai-cli__spacer" />
      <button v-if="running" type="button" :disabled="pending" @click="interrupt">{{ t('ai-cli.interrupt') }}</button>
      <button v-if="!running && (!pending || !allowCancelStart)" type="button" :disabled="pending" @click="start">{{ t('ai-cli.start') }}</button>
      <button v-else-if="!running && pending && allowCancelStart" type="button" @click="stop">{{ t('ai-cli.stop') }}</button>
      <button v-else type="button" :disabled="pending" @click="stop">{{ t('ai-cli.stop') }}</button>
      <button class="navide-safe-ai-cli__toggle" type="button" :aria-expanded="!collapsed" @click="collapsed = !collapsed">{{ collapsed ? '▴' : '▾' }}</button>
    </header>
    <div v-show="!collapsed" ref="terminalHost" class="navide-safe-ai-cli__terminal" />
    <p v-if="error" class="navide-safe-ai-cli__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.navide-safe-ai-cli { position: relative; display: flex; width: 360px; min-width: 280px; max-width: 600px; min-height: 0; flex: 0 0 auto; flex-direction: column; border-left: 1px solid var(--border-subtle); background: var(--bg-primary); color: var(--text-primary); }
.navide-safe-ai-cli__resizer { position: absolute; z-index: 1; top: 0; bottom: 0; left: -3px; width: 6px; cursor: col-resize; }
.navide-safe-ai-cli__toolbar { display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 4px 8px; border-bottom: 1px solid var(--border-subtle); }
.navide-safe-ai-cli__toolbar strong { font-size: var(--font-xs); }
.navide-safe-ai-cli__toolbar select { min-width: 0; max-width: 132px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--bg-secondary); color: var(--text-secondary); }
.navide-safe-ai-cli__spacer { flex: 1; }
.navide-safe-ai-cli__toolbar button { border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--bg-secondary); color: var(--text-secondary); padding: 3px 7px; cursor: pointer; }
.navide-safe-ai-cli__toolbar button:hover { background: var(--bg-hover); color: var(--text-primary); }
.navide-safe-ai-cli__toolbar button:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.navide-safe-ai-cli__toolbar button:active { transform: translateY(1px); }
.navide-safe-ai-cli__toolbar button:disabled { cursor: default; opacity: .5; }
.navide-safe-ai-cli__terminal { flex: 1; min-height: 180px; padding: 6px; overflow: hidden; }
.navide-safe-ai-cli__error { margin: 0; padding: 6px 8px; color: var(--danger-fg); font-size: var(--font-xs); }
.navide-safe-ai-cli.is-collapsed { width: 42px; min-width: 42px; min-height: 34px; }
.navide-safe-ai-cli.is-collapsed .navide-safe-ai-cli__toolbar > :not(:last-child) { display: none; }
.navide-safe-ai-cli.is-embedded { width: 100%; min-width: 0; max-width: none; flex: 1; border-left: 0; }
</style>
