import { execFile, spawnSync } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { basename, join } from 'node:path'
import { isMac } from '../../shared/osplat'

/**
 * Host-side resource limits for one sandboxed third-party backend.
 *
 * Seatbelt and bubblewrap contain files and the network, not CPU or memory,
 * so the Host samples the backend's whole process tree and kills it when it
 * stays over a limit. Sampling is coarse (seconds), so a burst shorter than
 * one interval is not caught; it bounds sustained abuse, not spikes.
 */

export interface BackendResourceLimits {
  /** Resident memory of the whole process tree, in bytes. */
  maxRssBytes: number
  /** Consecutive samples over `maxRssBytes` before the kill. */
  rssStrikes: number
  /** Processes in the tree, including the root. */
  maxProcesses: number
  /** CPU (1.0 = one core) sustained for `cpuKillAfterMs` before the kill. */
  maxCpuCores: number
  cpuKillAfterMs: number
  /** Size of the private data directory, in bytes. */
  maxDataBytes: number
  sampleIntervalMs: number
  /** Measure the data directory every Nth sample (it walks the tree). */
  dataSampleEvery: number
}

export const DEFAULT_BACKEND_RESOURCE_LIMITS: BackendResourceLimits = Object.freeze({
  maxRssBytes: 512 * 1024 * 1024,
  rssStrikes: 2,
  maxProcesses: 8,
  maxCpuCores: 0.95,
  cpuKillAfterMs: 5 * 60_000,
  maxDataBytes: 1024 * 1024 * 1024,
  sampleIntervalMs: 5_000,
  dataSampleEvery: 12,
})

export interface ProcessSample {
  pid: number
  ppid: number
  rssBytes: number
  /** Cumulative CPU time in milliseconds. */
  cpuMs: number
  /** Kernel-recorded executable name (macOS `ucomm`); argv cannot change it. */
  name?: string
}

/**
 * How the Host recognises every process of one sandbox, including one that
 * escaped the process tree. On macOS a fork -> setsid -> fork grandchild is
 * reparented to launchd (ppid 1) and is no longer a descendant of the child the
 * Host spawned. The Seatbelt profile lets a sandboxed process exec only files
 * of its own package, so each such process runs an image from `packageDir`:
 * its kernel name is one of `names`, and lsof shows its text mapped from the
 * package (or the extraction directory under `dataDir`).
 */
export interface SandboxIdentity {
  packageDir: string
  dataDir: string
  names: ReadonlySet<string>
}

/** Bound on each blocking ps/lsof run in the synchronous cleanup (child exit,
 * Host shutdown). A run that times out finds nothing, so the cleanup is
 * best-effort there; the next launch's asynchronous sweep catches leftovers. */
export const SYNC_CLEANUP_TIMEOUT_MS = 3_000

/** macOS keeps at most MAXCOMLEN (16) characters of the executable name. */
const KERNEL_NAME_LENGTH = 16

export function sandboxIdentity(packageDir: string, dataDir: string): SandboxIdentity {
  const names = new Set<string>()
  const pending = [packageDir]
  while (pending.length > 0) {
    const current = pending.pop()!
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile()) {
        try {
          if ((lstatSync(path).mode & 0o111) !== 0) names.add(basename(path).slice(0, KERNEL_NAME_LENGTH))
        } catch {
          // Removed while listing; the package is immutable, so this is benign.
        }
      }
    }
  }
  return { packageDir, dataDir, names }
}

/** Parse `lsof -Fpn` output into pid -> mapped paths. */
export function parseLsofTextMappings(stdout: string): Map<number, string[]> {
  const mappings = new Map<number, string[]>()
  let pid: number | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
      if (!mappings.has(pid)) mappings.set(pid, [])
    } else if (line.startsWith('n') && pid !== null) {
      mappings.get(pid)!.push(line.slice(1))
    }
  }
  return mappings
}

function mapsSandboxImage(paths: readonly string[], identity: SandboxIdentity): boolean {
  return paths.some((path) =>
    path.startsWith(`${identity.packageDir}/`) || path.startsWith(`${identity.dataDir}/`))
}

function lsofArgs(pids: readonly number[]): string[] {
  return ['-nP', '-w', '-a', '-p', pids.join(','), '-d', 'txt', '-Fpn']
}

/** Synchronous image check, for cleanup paths that must finish before the
 * Host moves on (child exit, quit). */
export function confirmSandboxImagesSync(pids: readonly number[], identity: SandboxIdentity): Set<number> {
  if (pids.length === 0) return new Set()
  const result = spawnSync('lsof', lsofArgs(pids), { encoding: 'utf8', timeout: SYNC_CLEANUP_TIMEOUT_MS })
  const confirmed = new Set<number>()
  for (const [pid, paths] of parseLsofTextMappings(result.stdout ?? '')) {
    if (mapsSandboxImage(paths, identity)) confirmed.add(pid)
  }
  return confirmed
}

export function confirmSandboxImages(pids: readonly number[], identity: SandboxIdentity): Promise<Set<number>> {
  if (pids.length === 0) return Promise.resolve(new Set())
  return new Promise((resolve) => {
    execFile('lsof', lsofArgs(pids), { maxBuffer: 8 * 1024 * 1024 }, (_error, stdout) => {
      const confirmed = new Set<number>()
      for (const [pid, paths] of parseLsofTextMappings(stdout ?? '')) {
        if (mapsSandboxImage(paths, identity)) confirmed.add(pid)
      }
      resolve(confirmed)
    })
  })
}

/** Candidates that escaped to launchd and carry a package executable name. */
export function escapeCandidates(samples: readonly ProcessSample[], identity: SandboxIdentity): number[] {
  return samples
    .filter((sample) => sample.ppid === 1 && sample.name !== undefined && identity.names.has(sample.name))
    .map((sample) => sample.pid)
}

/** The root's tree plus every confirmed escapee and its own descendants. */
export function sandboxProcessTree(
  samples: readonly ProcessSample[],
  rootPid: number | null,
  escaped: ReadonlySet<number>,
): ProcessSample[] {
  const seen = new Set<number>()
  const tree: ProcessSample[] = []
  const roots = [...(rootPid === null ? [] : [rootPid]), ...escaped]
  for (const root of roots) {
    for (const process of processTree(samples, root)) {
      if (seen.has(process.pid)) continue
      seen.add(process.pid)
      tree.push(process)
    }
  }
  return tree
}

function psArgs(): string[] {
  return isMac()
    ? ['-A', '-o', 'pid=,ppid=,rss=,time=,ucomm=']
    : ['-A', '-o', 'pid=,ppid=,rss=,time=']
}

/**
 * Kill every process of one sandbox: what is left of the root's tree and every
 * escapee. Synchronous so a child exit or Host shutdown cannot outrun it.
 * Escapees are matched only when they were reparented to launchd, so another
 * live launch of the same package (whose processes have a live parent) is
 * never touched.
 */
/** Non-blocking variant for the sweep before a launch: escapees only (they
 * are what an earlier launch or Host run can leave behind). */
export async function killEscapedSandboxProcesses(
  identity: SandboxIdentity,
  deps: Pick<ResourceWatchdogDeps, 'listProcesses' | 'confirmImages' | 'kill'> = createHostWatchdogDeps(),
): Promise<number[]> {
  const samples = await deps.listProcesses()
  const candidates = escapeCandidates(samples, identity)
  const escaped = candidates.length > 0 && deps.confirmImages
    ? await deps.confirmImages(candidates, identity)
    : new Set<number>()
  const victims = sandboxProcessTree(samples, null, escaped).map((sample) => sample.pid)
  for (const pid of [...victims].reverse()) deps.kill(pid)
  return victims
}

export function killSandboxProcessesSync(
  rootPid: number | null,
  identity: SandboxIdentity,
  kill: (pid: number) => void = (pid) => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  },
): number[] {
  const listing = spawnSync('ps', psArgs(), { encoding: 'utf8', timeout: SYNC_CLEANUP_TIMEOUT_MS })
  const samples = parsePsOutput(listing.stdout ?? '')
  const escaped = isMac()
    ? confirmSandboxImagesSync(escapeCandidates(samples, identity), identity)
    : new Set<number>()
  const victims = sandboxProcessTree(samples, rootPid, escaped).map((sample) => sample.pid)
  for (const pid of [...victims].reverse()) kill(pid)
  return victims
}

/** `stdoutPending` (stdout a child sent without a newline yet) is noticed in
 *  notify mode only; the automatic stop never produces it. */
export type ResourceViolation = 'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending'

/** Review M2 on #375 (contract 5.2): the stdoutPending threshold is the
 *  smaller of 256 MiB and an eighth of the machine's memory. */
export function defaultStdoutPendingThreshold(totalMemoryBytes: number = totalmem()): number {
  return Math.min(256 * 1024 * 1024, Math.floor(totalMemoryBytes / 8))
}

export interface ResourceWatchdogDeps {
  listProcesses(): Promise<ProcessSample[]>
  /** Which candidate pids map an image of this sandbox (macOS escapees). */
  confirmImages?(pids: readonly number[], identity: SandboxIdentity): Promise<Set<number>>
  dataDirBytes(dataDir: string): Promise<number>
  kill(pid: number): void
  now(): number
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** Parse `ps` cumulative CPU time: `[[dd-]hh:]mm:ss[.ff]`. */
export function parsePsCpuTime(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim())
  if (!match) return 0
  const [, days, hours, minutes, seconds] = match
  return Math.round(
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000,
  )
}

export function parsePsOutput(stdout: string): ProcessSample[] {
  const samples: ProcessSample[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s(.*))?$/.exec(line)
    if (!match) continue
    const [, pid, ppid, rss, time, name] = match
    samples.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssBytes: Number(rss) * 1024,
      cpuMs: parsePsCpuTime(time),
      ...(name !== undefined ? { name: name.trim() } : {}),
    })
  }
  return samples
}

/** The root and every descendant of it in one process listing. */
export function processTree(samples: readonly ProcessSample[], rootPid: number): ProcessSample[] {
  const byParent = new Map<number, ProcessSample[]>()
  for (const sample of samples) {
    const siblings = byParent.get(sample.ppid) ?? []
    siblings.push(sample)
    byParent.set(sample.ppid, siblings)
  }
  const root = samples.find((sample) => sample.pid === rootPid)
  if (!root) return []
  const tree: ProcessSample[] = []
  const queue = [root]
  const seen = new Set<number>()
  while (queue.length > 0) {
    const next = queue.shift()!
    if (seen.has(next.pid)) continue
    seen.add(next.pid)
    tree.push(next)
    queue.push(...(byParent.get(next.pid) ?? []))
  }
  return tree
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0
  const pending = [path]
  while (pending.length > 0) {
    const current = pending.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        pending.push(child)
      } else if (entry.isFile()) {
        try {
          total += (await lstat(child)).size
        } catch {
          // Removed between listing and stat.
        }
      }
    }
  }
  return total
}

export function createHostWatchdogDeps(): ResourceWatchdogDeps {
  return {
    listProcesses: () =>
      new Promise((resolve) => {
        execFile('ps', psArgs(), { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
          resolve(error ? [] : parsePsOutput(stdout))
        })
      }),
    confirmImages: confirmSandboxImages,
    dataDirBytes: directoryBytes,
    kill: (pid) => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    },
    now: () => Date.now(),
    setInterval: (callback, ms) => {
      const handle = setInterval(callback, ms)
      handle.unref?.()
      return handle
    },
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  }
}

export interface BackendResourceWatch {
  dispose(): void
  /** Run one sample now (tests and the first check after spawn). */
  sample(): Promise<ResourceViolation | null>
  /** Notify mode, the user chose Stop: the stop that used to happen on its
   *  own (whole tree killed, `onViolation`, watching ends). */
  terminate(item: ResourceViolation): Promise<ResourceViolation>
  /** Notify mode, the user chose Keep running: the item's notice level
   *  becomes twice the larger of the level and the latest usage, and stays
   *  there until this watch ends (contract 5.2). Returns the new level. */
  keepRunning(item: ResourceViolation): number
  /** Notify mode: the latest usage against the thresholds, for the activity page. */
  status?(): BackendResourceStatus
}

/** Units as in `ResourceExceeded`. `levels` differ from `thresholds` only
 *  after Keep running; `waiting` are the items announced and not answered. */
export interface BackendResourceStatus {
  usage: Record<ResourceViolation, number>
  thresholds: Record<ResourceViolation, number>
  levels: Record<ResourceViolation, number>
  waiting: ResourceViolation[]
}

/** Over a threshold in notify mode (contract 5.2). Units: memory and disk in
 *  bytes, processes a count, cpu in cores (sustained for `cpuKillAfterMs`). */
export interface ResourceExceeded {
  item: ResourceViolation
  usage: number
  threshold: number
}

/** Plan B watchdog option C: tell, do not stop. Without it the watch stops
 *  the backend on its own, as before. */
export interface ResourceNotifyMode {
  onExceeded: (exceeded: ResourceExceeded) => void
  /** The backend's stdout waiting for a newline, in bytes (#375's
   *  `stdoutPending.bytes`); absent, the item reads 0 and is never noticed. */
  stdoutPending?: { bytes: () => number; threshold: number }
}

/**
 * Watch one process tree. On a violation the whole tree is killed once, the
 * callback reports why, and watching stops; the supervisor sees an ordinary
 * child exit and fails the generation.
 */
export function watchBackendResources(
  rootPid: number,
  dataDir: string,
  onViolation: (violation: ResourceViolation) => void,
  limits: BackendResourceLimits = DEFAULT_BACKEND_RESOURCE_LIMITS,
  deps: ResourceWatchdogDeps = createHostWatchdogDeps(),
  identity?: SandboxIdentity,
  notify?: ResourceNotifyMode,
): BackendResourceWatch {
  let disposed = false
  let sampling = false
  let rssStrikes = 0
  let samples = 0
  let cpuOverSince: number | null = null
  let lastCpu: { atMs: number; cpuMs: number } | null = null
  // CPU time of processes that already exited is not lost from the total:
  // `ps` reports live processes only, so a respawning child resets it. The
  // monotonic max keeps the delta from going negative.
  const handle = deps.setInterval(() => void watch.sample(), limits.sampleIntervalMs)

  // Notify mode: each item's notice level, its latest usage, the items
  // announced and not yet answered, and the last tree (for Stop).
  const stdoutPendingThreshold = notify?.stdoutPending?.threshold ?? defaultStdoutPendingThreshold()
  const thresholds: Record<ResourceViolation, number> = {
    memory: limits.maxRssBytes,
    cpu: limits.maxCpuCores,
    processes: limits.maxProcesses,
    disk: limits.maxDataBytes,
    stdoutPending: stdoutPendingThreshold,
  }
  const levels: Record<ResourceViolation, number> = { ...thresholds }
  const latest: Record<ResourceViolation, number> = { memory: 0, cpu: 0, processes: 0, disk: 0, stdoutPending: 0 }
  const pending = new Set<ResourceViolation>()
  let lastTree: readonly ProcessSample[] = []
  const exceed = (item: ResourceViolation, usage: number): void => {
    if (pending.has(item)) return
    pending.add(item)
    try {
      notify!.onExceeded({ item, usage, threshold: levels[item] })
    } catch {
      // A reporting failure must not change what the backend does.
    }
  }

  const violate = (violation: ResourceViolation, tree: readonly ProcessSample[]): ResourceViolation => {
    watch.dispose()
    for (const process of [...tree].reverse()) deps.kill(process.pid)
    try {
      onViolation(violation)
    } catch {
      // A reporting failure must not keep the child alive.
    }
    return violation
  }

  /** Notify mode: the same measurements against each item's notice level;
   *  over one, the user is told once per notice and nothing is stopped. */
  const sampleNotifying = async (tree: readonly ProcessSample[]): Promise<null> => {
    lastTree = tree
    latest.processes = tree.length
    if (tree.length > levels.processes) exceed('processes', tree.length)
    const rss = tree.reduce((sum, process) => sum + process.rssBytes, 0)
    latest.memory = rss
    rssStrikes = rss > levels.memory ? rssStrikes + 1 : 0
    if (rssStrikes >= limits.rssStrikes) exceed('memory', rss)

    const now = deps.now()
    const cpuMs = tree.reduce((sum, process) => sum + process.cpuMs, 0)
    if (lastCpu && now > lastCpu.atMs) {
      const cores = Math.max(0, cpuMs - lastCpu.cpuMs) / (now - lastCpu.atMs)
      latest.cpu = cores
      if (cores >= levels.cpu) {
        cpuOverSince ??= lastCpu.atMs
        if (now - cpuOverSince >= limits.cpuKillAfterMs) exceed('cpu', cores)
      } else {
        cpuOverSince = null
      }
    }
    lastCpu = { atMs: now, cpuMs: Math.max(cpuMs, lastCpu?.cpuMs ?? 0) }

    if (samples % limits.dataSampleEvery === 1 || limits.dataSampleEvery <= 1) {
      const bytes = await deps.dataDirBytes(dataDir)
      latest.disk = bytes
      if (bytes > levels.disk) exceed('disk', bytes)
    }
    if (notify?.stdoutPending) {
      let pendingBytes = 0
      try {
        pendingBytes = notify.stdoutPending.bytes()
      } catch {
        // Unreadable reads as nothing pending.
      }
      latest.stdoutPending = pendingBytes
      if (pendingBytes > levels.stdoutPending) exceed('stdoutPending', pendingBytes)
    }
    return null
  }

  const watch: BackendResourceWatch = {
    dispose() {
      if (disposed) return
      disposed = true
      deps.clearInterval(handle)
    },
    async terminate(item) {
      if (disposed) return item
      // List the tree again so a process started since the last sample is
      // stopped too (review LOW1 on #386); the last sample only if listing
      // fails. A listing without the tree means the backend is gone: like
      // main, nothing is killed, since its pids may belong to others now (N1).
      let tree = lastTree
      try {
        const listing = await deps.listProcesses()
        const candidates = identity ? escapeCandidates(listing, identity) : []
        const escaped = identity && candidates.length > 0 && deps.confirmImages
          ? await deps.confirmImages(candidates, identity)
          : new Set<number>()
        tree = sandboxProcessTree(listing, rootPid, escaped)
      } catch {
        // Keep the last sampled tree.
      }
      if (disposed) return item
      if (tree.length === 0) {
        watch.dispose()
        return item
      }
      return violate(item, tree)
    },
    status() {
      return {
        usage: { ...latest },
        thresholds: { ...thresholds },
        levels: { ...levels },
        waiting: [...pending],
      }
    },
    keepRunning(item) {
      levels[item] = 2 * Math.max(levels[item], latest[item])
      pending.delete(item)
      if (item === 'memory') rssStrikes = 0
      if (item === 'cpu') cpuOverSince = null
      return levels[item]
    },
    async sample() {
      if (disposed || sampling) return null
      sampling = true
      try {
        const listing = await deps.listProcesses()
        const candidates = identity ? escapeCandidates(listing, identity) : []
        const escaped = identity && candidates.length > 0 && deps.confirmImages
          ? await deps.confirmImages(candidates, identity)
          : new Set<number>()
        if (!listing.some((sample) => sample.pid === rootPid) && escaped.size === 0) return null
        const tree = sandboxProcessTree(listing, rootPid, escaped)
        if (disposed || tree.length === 0) return null
        samples += 1
        if (notify) return await sampleNotifying(tree)
        if (tree.length > limits.maxProcesses) return violate('processes', tree)
        const rss = tree.reduce((sum, process) => sum + process.rssBytes, 0)
        rssStrikes = rss > limits.maxRssBytes ? rssStrikes + 1 : 0
        if (rssStrikes >= limits.rssStrikes) return violate('memory', tree)

        const now = deps.now()
        const cpuMs = tree.reduce((sum, process) => sum + process.cpuMs, 0)
        if (lastCpu && now > lastCpu.atMs) {
          const cores = Math.max(0, cpuMs - lastCpu.cpuMs) / (now - lastCpu.atMs)
          if (cores >= limits.maxCpuCores) {
            cpuOverSince ??= lastCpu.atMs
            if (now - cpuOverSince >= limits.cpuKillAfterMs) return violate('cpu', tree)
          } else {
            cpuOverSince = null
          }
        }
        lastCpu = { atMs: now, cpuMs: Math.max(cpuMs, lastCpu?.cpuMs ?? 0) }

        if (samples % limits.dataSampleEvery === 1 || limits.dataSampleEvery <= 1) {
          if ((await deps.dataDirBytes(dataDir)) > limits.maxDataBytes) return violate('disk', tree)
        }
        return null
      } finally {
        sampling = false
      }
    },
  }
  return watch
}
