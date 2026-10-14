import { ref, computed, watch } from 'vue'
import type { useBackend } from './useBackend'

/** 'unknown' comes only from the quick pass, before the backend's login-shell
 *  PATH has answered: not found yet, which is not the same as not installed. */
export type DepStatus = 'ok' | 'missing' | 'outdated' | 'unknown'
/** How the binary got installed — decides which official command applies. */
export type InstallMethod = '' | 'npm' | 'homebrew' | 'native' | 'script' | 'unknown'
/** 'vendor' = the CLI keeps updating itself; 'manual' = its own opt-out env var is set. */
export type AutoupdatePolicy = '' | 'vendor' | 'manual'
export type MaintenanceAction = 'update' | 'doctor' | 'install'

export interface OnboardDep {
  id: string
  label: string
  description: string
  group: 'foundation' | 'agent_cli' | 'analyzer'
  status: DepStatus
  version: string
  min_version: string
  optional: boolean
  needs_terminal: boolean
  can_install: boolean
  /** The vendor command an install would run, shown before the user agrees. */
  install_cmd?: string
  /** Bootstrap tools this dep's install needs, with their current state. */
  requirements?: { name: string; ok: boolean }[]
  docs_url: string
  binary_path: string
  resolved_path: string
  install_method: InstallMethod
  update_cmd: string
  doctor_cmd: string
  autoupdate_env: string
  autoupdate_policy: AutoupdatePolicy
  /** The install the user chose for Navide to launch; '' = the PATH default.
   *  Absent on an older backend. */
  binary_override?: string
}

export interface OnboardGate {
  foundation_ready: boolean
  has_any_cli: boolean
  analyzer_ready: boolean
  ollama_ok: boolean
  /** ollama is installed AND its daemon answered — pulling a model can work. */
  ollama_service_up: boolean
  has_model: boolean
  all_required_ready: boolean
  suggested_model: string
}

export interface ModelOption {
  name: string
  size: string
  desc: string
  recommended: boolean
}

export interface CliHealthCandidate {
  path: string
  resolved_path: string
  aliases: string[]
  version: string
  status: 'ok' | 'failed'
  exit_code: number | null
  signal: string
  duration_ms: number | null
  is_primary: boolean
  install_method?: InstallMethod
  install_manager?: string
  removal_command?: string
}

/** One entry of the CLI's OWN update log, read back untouched. */
export interface CliUpdateRecord {
  scope: string
  home: string
  timestamp: string
  outcome: string
  status: string
  version_from: string
  version_to: string
}

export interface CliHealthEntry {
  agent_key: string
  label: string
  diagnostic_command: string
  update_command: string
  docs_url: string
  /** npm package the backend judges ownership by; '' when not npm-installed. */
  npm_package: string
  update_state: CliUpdateRecord[]
  candidates: CliHealthCandidate[]
}

export interface CliHealthFinding {
  type: 'probe_failed' | 'duplicate_install' | 'update_failed'
  agent_key: string
  label: string
  primary?: CliHealthCandidate
  candidates?: CliHealthCandidate[]
  records?: CliUpdateRecord[]
}

export interface CliHealthStatus {
  entries: CliHealthEntry[]
  findings: CliHealthFinding[]
  fingerprint: string
  dismissed: boolean
  needs_attention: boolean
}

export interface OnboardStatus {
  deps: OnboardDep[]
  models: string[]
  gate: OnboardGate
  model_catalog: ModelOption[]
  cli_health: CliHealthStatus
  /** Dep ids whose guided-install prompt the user switched off for good. */
  install_prompt_dismissed?: string[]
  complete: boolean
}

/**
 * Whether any finding is one the repair guide acts on. A failed vendor update
 * is surfaced in CLI management, not by the repair guide — on its own it must
 * neither open the guide nor keep it open.
 */
export function hasRepairableFinding(health: CliHealthStatus): boolean {
  return health.findings.some((finding) => finding.type !== 'update_failed')
}

export function cliHealthGuideForLaunch(status: OnboardStatus | null | undefined): CliHealthStatus | null {
  if (!status?.complete || !status.cli_health?.needs_attention) return null
  return hasRepairableFinding(status.cli_health) ? status.cli_health : null
}

export interface InstallResult {
  ok: boolean
  needs_terminal?: boolean
  command?: string
  output?: string
  error?: string
  docs_url?: string
  dep_id?: string
  label?: string
  /** Bootstrap binaries (brew, npm) the install command needs but cannot find. */
  missing_requirements?: string[]
  /** Ollama is installed but its daemon is not answering. */
  needs_service?: boolean
  /** The PTY id of a started onboarding.run. */
  run_id?: string
  /** The command resolved but its PTY could not start: offer the external
   *  terminal with `command` instead. */
  spawn_failed?: boolean
  /** How the run ended: its exit code, null when it never reported one. */
  exit_code?: number | null
  cancelled?: boolean
  /** The request itself failed (timeout, lost connection): `error` says why. */
  unanswered?: boolean
}

/** The command running (or just finished) in this surface's install terminal. */
export interface ActiveRun {
  /** dep id, `<agent>:<action>`, `model:<name>` or `ollama-service`. */
  key: string
  label: string
  command: string
  runId: string
  state: 'starting' | 'running' | 'exited'
  exitCode: number | null
  signal: string
  cancelled: boolean
  /** The connection dropped mid-run: the backend killed it, no exit arrived. */
  lost: boolean
  /** Why typed input last failed to reach the command ('' = none): a sudo
   *  password that never arrived must not look like a hung prompt. */
  inputError: string
}

/** A resolved command whose embedded terminal could not start. */
export interface RunFallback {
  key: string
  label: string
  command: string
  error: string
}

interface RunExit {
  exitCode: number | null
  signal: string
  cancelled: boolean
  lost: boolean
}

interface TerminalOutputEvent {
  terminal_session_id: string
  data: Uint8Array
}

interface TerminalExitEvent {
  terminal_session_id: string
  exit_code?: number | null
  signal?: string | null
}

/**
 * Why an install did not happen, kept per dep so the card can say it.
 *
 * A failure used to reach the user only through the log pane, which sits at the
 * bottom of the left column behind a scroll and dies with the modal. The
 * fast-failing cases — a missing bootstrap binary answers in well under a
 * second — therefore looked like the button did nothing at all.
 */
export interface InstallFailure {
  /** Backend text, verbatim: the card shows it, the log keeps the full tail. */
  message: string
  /** The command that ran, so the user always has a way forward by hand. */
  command: string
  /** Set when the command itself exited 0 but the dep is still not detected. */
  ranButUndetected: boolean
}

/** onboarding.run answers once the PTY is spawned, not when the command ends;
 *  the budget covers pull_model's `ollama list` reachability check. */
const RUN_START_TIMEOUT_MS = 30_000
/** Output kept for a terminal that mounts (or remounts) after the run began. */
const RUN_OUTPUT_CAP_BYTES = 2_000_000

/**
 * Deadline for `onboarding.status`, which wsClient would otherwise default to
 * 10s. The backend probes 18 deps behind one executor, each with an 8s
 * ceiling, and a `fresh` pass re-runs the login-shell PATH probe first — a
 * heavy ~/.zshrc alone has been measured at 13s+. At the default, the re-detect
 * button and the pass that runs right after an install both reject before the
 * answer arrives, leaving the freshly installed CLI displayed as missing.
 * App.vue's checkOnboarding gives its own call the same 45s for the same reason.
 */
export const STATUS_TIMEOUT_MS = 45_000

function describeExit(exit: RunExit): string {
  if (exit.cancelled) return 'Cancelled'
  if (exit.lost) return 'The connection to the backend was lost; the command was stopped'
  if (exit.signal) return `Stopped by ${exit.signal}`
  return `Exited with code ${exit.exitCode ?? 'unknown'}`
}

/**
 * useOnboarding — drives the first-run environment wizard. The backend is the
 * single source of truth for dep definitions + status; this composable only
 * fetches, triggers installs, and exposes derived gate flags.
 */
export function useOnboarding(backend: ReturnType<typeof useBackend>) {
  const status = ref<OnboardStatus | null>(null)
  const loading = ref(false)
  const installing = ref('') // dep id currently being installed ('' = none)
  const maintaining = ref('') // '<agent>:<action>' currently running ('' = none)
  const pulling = ref('') // model name currently being pulled ('' = none)
  const logLines = ref<string[]>([])
  /** Seconds the current install has been running. */
  const installElapsedSec = ref(0)
  /** One run at a time per surface; kept after exit so its output stays visible. */
  const run = ref<ActiveRun | null>(null)
  /** Set when a run's PTY could not start: the external terminal is the way on. */
  const runFallback = ref<RunFallback | null>(null)
  const runBusy = computed(() => run.value !== null && run.value.state !== 'exited')
  /** Last install failure per dep id, so the card can show it in place. */
  const installErrors = ref<Record<string, InstallFailure>>({})

  // Refreshes overlap (watcher ticks, Re-detect, the pass after an install)
  // and can answer out of order. Each takes a number; a full answer is applied
  // only when no newer refresh has already applied one.
  let refreshSeq = 0
  let appliedSeq = 0

  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let runChunks: Uint8Array[] = []
  let runBytes = 0
  const runSinks = new Set<(data: Uint8Array) => void>()
  let runSize = { cols: 100, rows: 24 }
  /** The surface went away; a run whose start was still in flight is killed
   *  as soon as its id arrives, since nothing is left to show or answer it. */
  let disposed = false

  function log(line: string): void {
    logLines.value = [...logLines.value, line].slice(-200)
  }

  /** Log a headline plus the tail of a multi-line detail (stderr, etc.). */
  function logDetail(headline: string, detail: string): void {
    log(headline)
    for (const line of detail.trim().split('\n').slice(-20)) log(`  ${line}`)
  }

  function setInstallError(depId: string, failure: InstallFailure): void {
    installErrors.value = { ...installErrors.value, [depId]: failure }
  }

  /** Drop a dep's stale failure — on retry, and once it detects as installed. */
  function clearInstallError(depId: string): void {
    if (!(depId in installErrors.value)) return
    const next = { ...installErrors.value }
    delete next[depId]
    installErrors.value = next
  }

  function stopElapsed(): void {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  }

  function startElapsed(): void {
    stopElapsed()
    installElapsedSec.value = 0
    elapsedTimer = setInterval(() => {
      installElapsedSec.value += 1
    }, 1000)
  }

  function keepRunOutput(data: Uint8Array): void {
    runChunks.push(data)
    runBytes += data.byteLength
    while (runBytes > RUN_OUTPUT_CAP_BYTES && runChunks.length > 1) {
      runBytes -= runChunks.shift()!.byteLength
    }
    for (const sink of runSinks) sink(data)
  }

  /** Stream the run's output into a terminal: replays what came before it. */
  function attachRunOutput(sink: (data: Uint8Array) => void): () => void {
    for (const chunk of runChunks) sink(chunk)
    runSinks.add(sink)
    return () => {
      runSinks.delete(sink)
    }
  }

  /**
   * Start a whitelisted command in a backend PTY and wait for it to exit. The
   * request names a kind and ids only; the backend resolves the command.
   * Resolves with `exit: null` when nothing started (refused, or no PTY).
   */
  async function startRun(
    key: string,
    label: string,
    request: Record<string, unknown>,
  ): Promise<{ result: InstallResult | null; exit: RunExit | null }> {
    if (runBusy.value) {
      log(`⏳ ${label} has to wait for ${run.value?.label ?? 'the current command'} to finish.`)
      return { result: null, exit: null }
    }
    runFallback.value = null
    runChunks = []
    runBytes = 0
    run.value = {
      key, label, command: '', runId: '', state: 'starting',
      exitCode: null, signal: '', cancelled: false, lost: false, inputError: '',
    }
    let runId = ''
    let settle: (exit: RunExit) => void = () => {}
    const exited = new Promise<RunExit>((resolve) => {
      settle = resolve
    })
    const finish = (exit: Omit<RunExit, 'cancelled'>): void => {
      if (!run.value || run.value.runId !== runId || run.value.state === 'exited') return
      run.value = { ...run.value, state: 'exited', exitCode: exit.exitCode, signal: exit.signal, lost: exit.lost }
      settle({ ...exit, cancelled: run.value.cancelled })
    }
    // Subscribed before the request: a fast command can print and exit before
    // the reply naming its id arrives, so early events wait here for it. Every
    // pane's output arrives meanwhile, so the held output is capped, oldest
    // dropped first — this run's own output is the newest by then.
    const early: Array<['out', TerminalOutputEvent] | ['exit', TerminalExitEvent]> = []
    let earlyBytes = 0
    const onOutput = (p: TerminalOutputEvent): void => {
      if (runId) {
        if (p.terminal_session_id === runId) keepRunOutput(p.data)
        return
      }
      early.push(['out', p])
      earlyBytes += p.data.byteLength
      while (earlyBytes > RUN_OUTPUT_CAP_BYTES) {
        const i = early.findIndex(([kind]) => kind === 'out')
        earlyBytes -= (early[i][1] as TerminalOutputEvent).data.byteLength
        early.splice(i, 1)
      }
    }
    const onExit = (p: TerminalExitEvent): void => {
      if (!runId) early.push(['exit', p])
      else if (p.terminal_session_id === runId) {
        finish({ exitCode: p.exit_code ?? null, signal: p.signal ?? '', lost: false })
      }
    }
    const offOutput = backend.on('terminal.output', onOutput as (p: unknown) => void)
    const offExit = backend.on('terminal.exit', onExit as (p: unknown) => void)
    // The backend kills a run when its connection drops, and that exit event
    // goes to the dead connection — without this the run would never end here.
    const stopStatusWatch = watch(backend.status, (value) => {
      if (value !== 'connected') finish({ exitCode: null, signal: '', lost: true })
    })
    const release = (): void => {
      offOutput()
      offExit()
      stopStatusWatch()
    }
    let resp: Awaited<ReturnType<typeof backend.send<InstallResult>>>
    try {
      resp = await backend.send<InstallResult>(
        'onboarding.run',
        { ...request, cols: runSize.cols, rows: runSize.rows },
        RUN_START_TIMEOUT_MS,
      )
    } catch (e) {
      release()
      run.value = null
      throw e
    }
    const r = resp.payload
    if (!r?.ok || !r.run_id) {
      release()
      run.value = null
      if (r?.spawn_failed && r.command) {
        runFallback.value = { key, label, command: r.command, error: r.error ?? '' }
      }
      return { result: r ?? { ok: false, error: resp.error?.message }, exit: null }
    }
    runId = r.run_id
    run.value = { ...run.value!, runId, command: r.command ?? '', state: 'running' }
    log(`▶ ${r.command ?? label}`)
    if (disposed) void cancelRun()
    for (const [kind, p] of early) {
      if (kind === 'out') onOutput(p)
      else onExit(p)
    }
    const exit = await exited
    release()
    return { result: r, exit }
  }

  /** Kill the running command's whole process group. */
  async function cancelRun(): Promise<void> {
    const current = run.value
    if (!current || current.state !== 'running') return
    run.value = { ...current, cancelled: true }
    try {
      await backend.send('terminal.kill', { terminal_session_id: current.runId })
    } catch (e) {
      log(`✗ Could not cancel: ${e instanceof Error ? e.message : String(e)}`)
      // Still running: re-enable Cancel, and do not report a later exit as cancelled.
      if (run.value?.runId === current.runId && run.value.state === 'running') {
        run.value = { ...run.value, cancelled: false }
      }
    }
  }

  /** Keystrokes typed into the run's terminal (sudo password, prompts). Not
   *  flagged `human`: that would log dev time against the home folder. */
  function runInput(data: string): void {
    const current = run.value
    if (!current || current.state !== 'running') return
    const lost = (error: string): void => {
      log(`✗ Input did not reach ${current.label}: ${error}`)
      if (run.value?.runId === current.runId) run.value = { ...run.value, inputError: error }
    }
    void backend.send<{ ok?: boolean; error?: string }>(
      'terminal.input', { terminal_session_id: current.runId, data },
    ).then((resp) => {
      if (!resp.ok) lost(resp.error?.message || 'refused')
      else if (resp.payload?.ok === false) lost(resp.payload.error || 'refused')
    }, (e) => lost(e instanceof Error ? e.message : String(e)))
  }

  function runResize(cols: number, rows: number): void {
    runSize = { cols, rows }
    const current = run.value
    if (!current || current.state !== 'running') return
    // Cosmetic: the next resize corrects it, so the log is enough.
    void backend.send('terminal.resize', { terminal_session_id: current.runId, cols, rows }).catch((e) => {
      log(`✗ Resize did not reach ${current.label}: ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  /** Close a finished run's terminal. */
  function dismissRun(): void {
    if (runBusy.value) return
    run.value = null
    runChunks = []
    runBytes = 0
  }

  /** The secondary way on when the embedded terminal could not start. */
  async function openFallbackInTerminal(): Promise<boolean> {
    const fallback = runFallback.value
    if (!fallback) return false
    const opened = await window.agentTeam?.openTerminal(fallback.command)
    if (!opened?.ok) {
      log(`✗ Could not open an external terminal: ${opened?.error || 'unavailable'}`)
      log(`  Run this yourself, then click Re-detect: ${fallback.command}`)
      return false
    }
    log(`↗ Opened in external terminal: ${fallback.command}`)
    log('  After it finishes, click Re-detect.')
    return true
  }

  /** Release timers and kill a command still running — the surface is going away. */
  function dispose(): void {
    disposed = true
    stopElapsed()
    void cancelRun()
  }

  async function refresh(opts?: { fresh?: boolean }): Promise<void> {
    const seq = ++refreshSeq
    loading.value = true
    try {
      if (!status.value) {
        // First paint: the PATH-presence pass answers instantly (no login
        // shell, no version subprocesses), so a missing CLI shows "not
        // installed" immediately instead of after the full batch's slowest
        // probe. The full pass below replaces it.
        try {
          const quick = await backend.send<OnboardStatus>('onboarding.status_quick', {})
          if (quick.payload && !status.value) status.value = quick.payload
        } catch {
          // Older backend without the quick pass — the full status follows.
        }
      }
      // fresh re-probes the backend's login-shell PATH cache; pass it when an
      // installer just ran and may have written a new PATH export.
      const resp = await backend.send<OnboardStatus>(
        'onboarding.status',
        opts?.fresh ? { fresh: true } : {},
        STATUS_TIMEOUT_MS
      )
      if (resp.payload && seq > appliedSeq) {
        appliedSeq = seq
        status.value = resp.payload
      }
    } catch (e) {
      log(`✗ Detection failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      // An older refresh finishing must not clear the flag for a newer one.
      if (seq === refreshSeq) loading.value = false
    }
  }

  async function install(dep: OnboardDep): Promise<InstallResult | null> {
    if (installing.value || runBusy.value) {
      // Returning silently here made a second click look like a dead button:
      // every install button is disabled during an install, but a click that
      // lands in the gap before the re-render still arrives at this guard.
      const busy = deps.value.find((d) => d.id === installing.value)
      log(`⏳ ${dep.label} has to wait for ${busy?.label ?? run.value?.label ?? installing.value} to finish.`)
      return null
    }
    clearInstallError(dep.id)
    installing.value = dep.id
    startElapsed()
    log(`▶ Installing ${dep.label}…`)
    try {
      const { result: r, exit } = await startRun(dep.id, dep.label, { kind: 'install', dep_id: dep.id })
      if (!exit) {
        const reason = r?.error || 'unknown'
        logDetail(`✗ ${dep.label} installation failed:`, reason)
        setInstallError(dep.id, {
          message: reason.trim(),
          command: r?.command ?? dep.install_cmd ?? '',
          ranButUndetected: false,
        })
        return r
      }
      const command = r?.command ?? dep.install_cmd ?? ''
      // A fresh pass either way: even a failed installer may have put
      // something on PATH, and the card must show what is there now.
      await refresh({ fresh: true })
      const after = deps.value.find((d) => d.id === dep.id)
      if (exit.exitCode !== 0 || exit.cancelled || exit.lost) {
        const reason = describeExit(exit)
        log(`✗ ${dep.label}: ${reason}`)
        // Homebrew exits non-zero on "already installed" often enough that the
        // command can fail while the tool is in fact present: no red card then.
        if (after?.status === 'ok') clearInstallError(dep.id)
        else setInstallError(dep.id, { message: reason, command, ranButUndetected: false })
        return { ...r, ok: false, error: reason, exit_code: exit.exitCode, cancelled: exit.cancelled }
      }
      if (after?.status === 'ok') {
        log(`✓ ${dep.label} installed.`)
        clearInstallError(dep.id)
      } else {
        log(`⚠ ${dep.label} installed successfully but is still not detected.`)
        log('  It may need a new shell session, or it landed outside PATH.')
        // Exit 0 with the card still red is the other way this reads as
        // "nothing happened" — the card has to say what actually occurred.
        setInstallError(dep.id, { message: '', command, ranButUndetected: true })
      }
      return { ...r, ok: true, exit_code: 0 }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      log(`✗ ${dep.label} installation error: ${reason}`)
      setInstallError(dep.id, {
        message: reason,
        command: dep.install_cmd ?? '',
        ranButUndetected: false,
      })
      return null
    } finally {
      installing.value = ''
      stopElapsed()
    }
  }

  /** Run one non-install command to its end, then re-detect. */
  async function runAndRedetect(
    key: string,
    label: string,
    request: Record<string, unknown>,
  ): Promise<InstallResult | null> {
    let outcome: Awaited<ReturnType<typeof startRun>>
    try {
      outcome = await startRun(key, label, request)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      log(`✗ ${label}: ${reason}`)
      // A result, not null: null means "not started, nothing to say" to callers
      // (CLI management has no log view and would show nothing at all).
      return { ok: false, error: reason, unanswered: true }
    }
    const { result: r, exit } = outcome
    if (!exit) {
      if (r) log(`✗ ${label}: ${r.error || 'unavailable'}`)
      if (r?.needs_service) log('  Start the Ollama service, then try again.')
      return r
    }
    await refresh({ fresh: true })
    if (exit.exitCode !== 0 || exit.cancelled || exit.lost) {
      const reason = describeExit(exit)
      log(`✗ ${label}: ${reason}`)
      return { ...r, ok: false, error: reason, exit_code: exit.exitCode, cancelled: exit.cancelled }
    }
    log(`✓ ${label} finished.`)
    return { ...r, ok: true, exit_code: 0 }
  }

  async function pullModel(model?: string): Promise<InstallResult | null> {
    if (pulling.value) return null
    const name = model || status.value?.gate.suggested_model || 'qwen2.5-coder'
    pulling.value = name
    log(`▶ Downloading model ${name}…`)
    try {
      return await runAndRedetect(`model:${name}`, `Model ${name}`, { kind: 'pull_model', model: name })
    } finally {
      pulling.value = ''
    }
  }

  /**
   * Start the Ollama daemon. Installing the formula does not start it, and
   * without it `ollama pull` fails and the model list stays empty forever.
   */
  async function startOllamaService(): Promise<InstallResult | null> {
    return runAndRedetect('ollama-service', 'Ollama service', { kind: 'start_ollama' })
  }

  /**
   * Run one of the CLI's OWN maintenance commands in the install terminal.
   * The action id is resolved to a command by the backend registry — the
   * renderer never composes a command, and Navide never wraps the vendor's.
   * Serialised through `maintaining` so two CLIs cannot update at once.
   */
  async function runMaintenance(agentKey: string, action: MaintenanceAction): Promise<InstallResult | null> {
    if (maintaining.value) return null
    maintaining.value = `${agentKey}:${action}`
    try {
      return await runAndRedetect(`${agentKey}:${action}`, `${agentKey} ${action}`, {
        kind: 'maintenance',
        agent_key: agentKey,
        action,
      })
    } finally {
      maintaining.value = ''
    }
  }

  /** Resolves false when the policy was not stored, so the caller can say so. */
  async function setAutoupdatePolicy(agentKey: string, policy: AutoupdatePolicy): Promise<boolean> {
    try {
      const resp = await backend.send<InstallResult>('onboarding.cli_autoupdate', {
        agent_key: agentKey,
        policy,
      })
      if (!resp.payload?.ok) {
        log(`✗ ${agentKey} auto-update policy: ${resp.payload?.error || 'rejected'}`)
        return false
      }
    } catch (e) {
      log(`✗ ${agentKey} auto-update policy failed: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
    await refresh()
    return true
  }

  /**
   * Stop (or resume) raising the guided-install prompt for one CLI. Declining
   * a prompt is deliberately NOT the same as this: the prompt keeps coming
   * back until the user opts out here, and the choice is per CLI, not global.
   */
  async function dismissInstallPrompt(depId: string, dismissed = true): Promise<boolean> {
    try {
      const resp = await backend.send<InstallResult>('onboarding.install_prompt', {
        dep_id: depId,
        dismissed,
      })
      if (!resp.payload?.ok) {
        log(`✗ ${depId} install prompt: ${resp.payload?.error || 'rejected'}`)
        return false
      }
    } catch (e) {
      log(`✗ ${depId} install prompt failed: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
    if (status.value) {
      const current = new Set(status.value.install_prompt_dismissed ?? [])
      if (dismissed) current.add(depId)
      else current.delete(depId)
      status.value.install_prompt_dismissed = [...current]
    }
    return true
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const deps = computed(() => status.value?.deps ?? [])
  const foundationDeps = computed(() => deps.value.filter((d) => d.group === 'foundation'))
  const cliDeps = computed(() => deps.value.filter((d) => d.group === 'agent_cli'))
  const analyzerDeps = computed(() => deps.value.filter((d) => d.group === 'analyzer'))
  const models = computed(() => status.value?.models ?? [])
  const modelCatalog = computed<ModelOption[]>(() => status.value?.model_catalog ?? [])
  const gate = computed<OnboardGate | null>(() => status.value?.gate ?? null)
  const foundationReady = computed(() => gate.value?.foundation_ready ?? false)
  const hasAnyCli = computed(() => gate.value?.has_any_cli ?? false)
  const analyzerReady = computed(() => gate.value?.analyzer_ready ?? false)
  const ollamaServiceUp = computed(() => gate.value?.ollama_service_up ?? false)
  const allRequiredReady = computed(() => gate.value?.all_required_ready ?? false)
  const cliHealth = computed<CliHealthStatus | null>(() => status.value?.cli_health ?? null)
  const installPromptDismissed = computed(
    () => new Set(status.value?.install_prompt_dismissed ?? [])
  )

  return {
    status, loading, installing, maintaining, pulling, logLines,
    installElapsedSec, installErrors,
    run, runBusy, runFallback, attachRunOutput, cancelRun, runInput, runResize,
    dismissRun, openFallbackInTerminal,
    refresh, install, pullModel, startOllamaService, runMaintenance,
    setAutoupdatePolicy, dismissInstallPrompt, dispose,
    deps, foundationDeps, cliDeps, analyzerDeps, models, modelCatalog, gate,
    foundationReady, hasAnyCli, analyzerReady, allRequiredReady, ollamaServiceUp,
    cliHealth, installPromptDismissed,
  }
}
