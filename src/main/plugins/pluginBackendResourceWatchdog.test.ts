import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  createHostWatchdogDeps,
  defaultStdoutPendingThreshold,
  DEFAULT_BACKEND_RESOURCE_LIMITS,
  escapeCandidates,
  killEscapedSandboxProcesses,
  parseLsofTextMappings,
  sandboxProcessTree,
  parsePsCpuTime,
  parsePsOutput,
  processTree,
  watchBackendResources,
  type ProcessSample,
  type ResourceWatchdogDeps,
} from './pluginBackendResourceWatchdog'

const MiB = 1024 * 1024

function fakeDeps(listing: () => ProcessSample[], options: { dataBytes?: number; now?: () => number } = {}) {
  const killed: number[] = []
  const deps: ResourceWatchdogDeps = {
    listProcesses: async () => listing(),
    dataDirBytes: async () => options.dataBytes ?? 0,
    kill: (pid) => killed.push(pid),
    now: options.now ?? (() => 0),
    setInterval: () => 'handle',
    clearInterval: vi.fn(),
  }
  return { deps, killed }
}

const limits = { ...DEFAULT_BACKEND_RESOURCE_LIMITS, dataSampleEvery: 1 }

describe('ps parsing', () => {
  it('parses cumulative CPU time formats', () => {
    expect(parsePsCpuTime('0:01.50')).toBe(1_500)
    expect(parsePsCpuTime('01:02:03')).toBe(3_723_000)
    expect(parsePsCpuTime('2-00:00:00')).toBe(172_800_000)
    expect(parsePsCpuTime('garbage')).toBe(0)
  })

  it('parses rows and builds the process tree of one root', () => {
    const samples = parsePsOutput('  10   1  1024 0:00.10\n  11  10  2048 0:01.00\n  12  11  10 0:00.00\n  99   1 5 0:00.00\nbad row\n')
    expect(samples).toHaveLength(4)
    expect(samples[1]).toEqual({ pid: 11, ppid: 10, rssBytes: 2048 * 1024, cpuMs: 1_000 })
    expect(processTree(samples, 10).map((sample) => sample.pid)).toEqual([10, 11, 12])
    expect(processTree(samples, 404)).toEqual([])
  })
})

describe('escaped process identification (macOS)', () => {
  const identity = { packageDir: '/pkg', dataDir: '/data', names: new Set(['acme-backend']) }

  it('reads the kernel executable name, trailing padding included', () => {
    const [sample] = parsePsOutput('  42     1   1024   0:00.10 acme-backend        \n')
    expect(sample).toMatchObject({ pid: 42, ppid: 1, name: 'acme-backend' })
    expect(parsePsOutput(' 7 1 10 0:00.00 name with spaces \n')[0].name).toBe('name with spaces')
  })

  it('only launchd-parented processes with a package executable name are candidates', () => {
    const samples = [
      { pid: 10, ppid: 1, rssBytes: 0, cpuMs: 0, name: 'acme-backend' },
      { pid: 11, ppid: 1, rssBytes: 0, cpuMs: 0, name: 'Finder' },
      { pid: 12, ppid: 500, rssBytes: 0, cpuMs: 0, name: 'acme-backend' },
      { pid: 13, ppid: 1, rssBytes: 0, cpuMs: 0 },
    ]
    expect(escapeCandidates(samples, identity)).toEqual([10])
  })

  it('confirms candidates by the image lsof reports, and includes their descendants', () => {
    const mappings = parseLsofTextMappings('p10\nftxt\nn/pkg/backend/acme-backend\nftxt\nn/usr/lib/dyld\np11\nftxt\nn/Applications/Other\n')
    expect(mappings.get(10)).toEqual(['/pkg/backend/acme-backend', '/usr/lib/dyld'])
    expect(mappings.get(11)).toEqual(['/Applications/Other'])
    const samples = [
      { pid: 5, ppid: 400, rssBytes: 0, cpuMs: 0 },
      { pid: 6, ppid: 5, rssBytes: 0, cpuMs: 0 },
      { pid: 10, ppid: 1, rssBytes: 0, cpuMs: 0 },
      { pid: 20, ppid: 10, rssBytes: 0, cpuMs: 0 },
      { pid: 30, ppid: 1, rssBytes: 0, cpuMs: 0 },
    ]
    expect(sandboxProcessTree(samples, 5, new Set([10])).map((sample) => sample.pid).sort()).toEqual([10, 20, 5, 6])
    expect(sandboxProcessTree(samples, null, new Set([10])).map((sample) => sample.pid).sort()).toEqual([10, 20])
  })

  it('counts a confirmed escapee in the watched tree', async () => {
    const { deps, killed } = fakeDeps(() => [
      { pid: 5, ppid: 400, rssBytes: MiB, cpuMs: 0, name: 'acme-backend' },
      { pid: 10, ppid: 1, rssBytes: 600 * MiB, cpuMs: 0, name: 'acme-backend' },
    ])
    deps.confirmImages = async (pids) => new Set(pids)
    const watch = watchBackendResources(5, '/data', vi.fn(), { ...limits, rssStrikes: 1 }, deps, identity)
    expect(await watch.sample()).toBe('memory')
    expect(killed.sort()).toEqual([10, 5])
  })

  it('the pre-launch sweep kills confirmed escapees only, without blocking', async () => {
    const { deps, killed } = fakeDeps(() => [
      { pid: 10, ppid: 1, rssBytes: 0, cpuMs: 0, name: 'acme-backend' },
      { pid: 20, ppid: 10, rssBytes: 0, cpuMs: 0 },
      { pid: 30, ppid: 1, rssBytes: 0, cpuMs: 0, name: 'acme-backend' },
      { pid: 40, ppid: 99, rssBytes: 0, cpuMs: 0, name: 'acme-backend' },
    ])
    deps.confirmImages = async () => new Set([10])
    expect((await killEscapedSandboxProcesses(identity, deps)).sort()).toEqual([10, 20])
    expect(killed.sort()).toEqual([10, 20])
  })

  it('keeps watching escapees after the root is gone', async () => {
    const { deps, killed } = fakeDeps(() => [{ pid: 10, ppid: 1, rssBytes: 600 * MiB, cpuMs: 0, name: 'acme-backend' }])
    deps.confirmImages = async () => new Set([10])
    expect(await watchBackendResources(5, '/data', vi.fn(), { ...limits, rssStrikes: 1 }, deps, identity).sample()).toBe('memory')
    expect(killed).toEqual([10])
  })
})

describe('watchBackendResources', () => {
  it('kills the whole tree after consecutive samples over the memory limit', async () => {
    const tree = [
      { pid: 10, ppid: 1, rssBytes: 400 * MiB, cpuMs: 0 },
      { pid: 11, ppid: 10, rssBytes: 200 * MiB, cpuMs: 0 },
    ]
    const { deps, killed } = fakeDeps(() => tree)
    const onViolation = vi.fn()
    const watch = watchBackendResources(10, '/data', onViolation, limits, deps)
    expect(await watch.sample()).toBeNull()
    expect(killed).toEqual([])
    expect(await watch.sample()).toBe('memory')
    expect(killed.sort()).toEqual([10, 11])
    expect(onViolation).toHaveBeenCalledWith('memory')
    expect(deps.clearInterval).toHaveBeenCalled()
    expect(await watch.sample()).toBeNull()
  })

  it('resets the memory strikes when usage drops', async () => {
    let rss = 600 * MiB
    const { deps, killed } = fakeDeps(() => [{ pid: 10, ppid: 1, rssBytes: rss, cpuMs: 0 }])
    const watch = watchBackendResources(10, '/data', vi.fn(), limits, deps)
    await watch.sample()
    rss = 100 * MiB
    await watch.sample()
    rss = 600 * MiB
    expect(await watch.sample()).toBeNull()
    expect(killed).toEqual([])
  })

  it('kills a tree with too many processes', async () => {
    const tree = Array.from({ length: 9 }, (_, index) => ({
      pid: 100 + index, ppid: index === 0 ? 1 : 100, rssBytes: MiB, cpuMs: 0,
    }))
    const { deps, killed } = fakeDeps(() => tree)
    expect(await watchBackendResources(100, '/data', vi.fn(), limits, deps).sample()).toBe('processes')
    expect(killed).toHaveLength(9)
  })

  it('kills sustained CPU use only after the grace period', async () => {
    let now = 0
    let cpu = 0
    const { deps, killed } = fakeDeps(() => [{ pid: 10, ppid: 1, rssBytes: MiB, cpuMs: cpu }], { now: () => now })
    const watch = watchBackendResources(10, '/data', vi.fn(), limits, deps)
    await watch.sample()
    for (let elapsed = 5_000; elapsed < limits.cpuKillAfterMs; elapsed += 5_000) {
      now = elapsed
      cpu = elapsed
      expect(await watch.sample()).toBeNull()
    }
    now = limits.cpuKillAfterMs
    cpu = limits.cpuKillAfterMs
    expect(await watch.sample()).toBe('cpu')
    expect(killed).toEqual([10])
  })

  it('kills a backend whose data directory grows past its limit', async () => {
    const { deps, killed } = fakeDeps(() => [{ pid: 10, ppid: 1, rssBytes: MiB, cpuMs: 0 }], {
      dataBytes: limits.maxDataBytes + 1,
    })
    expect(await watchBackendResources(10, '/data', vi.fn(), limits, deps).sample()).toBe('disk')
    expect(killed).toEqual([10])
  })

  it('stops quietly when the process is gone', async () => {
    const { deps, killed } = fakeDeps(() => [])
    expect(await watchBackendResources(10, '/data', vi.fn(), limits, deps).sample()).toBeNull()
    expect(killed).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('kills a real child that exceeds a memory limit', async () => {
    const child = spawn(process.execPath, ['-e', 'const keep = Buffer.alloc(64 * 1024 * 1024, 1); setInterval(() => keep[0]++, 50)'])
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)))
    try {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const onViolation = vi.fn()
      const watch = watchBackendResources(
        child.pid!,
        '/nonexistent',
        onViolation,
        { ...limits, maxRssBytes: 32 * MiB, rssStrikes: 1, sampleIntervalMs: 60_000 },
        createHostWatchdogDeps(),
      )
      expect(await watch.sample()).toBe('memory')
      expect(await exited).toBe('SIGKILL')
      expect(onViolation).toHaveBeenCalledWith('memory')
    } finally {
      // A failed sample (no `ps` in a sandbox, a timeout under load) must not
      // leave the 64 MiB child running forever under launchd.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 30_000)
})

// Plan B watchdog option C (contract 5.2): over a threshold the user is told
// and decides; nothing is stopped until they choose Stop.
describe('watchBackendResources in notify mode', () => {
  const one = (rssBytes: number, cpuMs = 0) => [{ pid: 10, ppid: 1, rssBytes, cpuMs }]

  it('notifies instead of killing, keeps watching, and does not repeat while the notice waits', async () => {
    let rss = 600 * MiB
    const { deps, killed } = fakeDeps(() => one(rss))
    const onViolation = vi.fn()
    const onExceeded = vi.fn()
    const watch = watchBackendResources(10, '/data', onViolation, limits, deps, undefined, { onExceeded })
    expect(await watch.sample()).toBeNull()
    expect(await watch.sample()).toBeNull()
    expect(onExceeded).toHaveBeenCalledTimes(1)
    expect(onExceeded).toHaveBeenCalledWith({ item: 'memory', usage: 600 * MiB, threshold: limits.maxRssBytes })
    rss = 700 * MiB
    await watch.sample()
    await watch.sample()
    expect(onExceeded).toHaveBeenCalledTimes(1)
    expect(killed).toEqual([])
    expect(onViolation).not.toHaveBeenCalled()
    expect(deps.clearInterval).not.toHaveBeenCalled()
  })

  it('Stop runs the same stop as before: the whole tree killed, onViolation, watching ends', async () => {
    const tree = [
      { pid: 10, ppid: 1, rssBytes: 400 * MiB, cpuMs: 0 },
      { pid: 11, ppid: 10, rssBytes: 200 * MiB, cpuMs: 0 },
    ]
    const { deps, killed } = fakeDeps(() => tree)
    const onViolation = vi.fn()
    const watch = watchBackendResources(10, '/data', onViolation, limits, deps, undefined, { onExceeded: vi.fn() })
    await watch.sample()
    await watch.sample()
    expect(await watch.terminate('memory')).toBe('memory')
    expect(killed.sort()).toEqual([10, 11])
    expect(onViolation).toHaveBeenCalledWith('memory')
    expect(deps.clearInterval).toHaveBeenCalled()
    expect(await watch.sample()).toBeNull()
  })

  it('Keep running tells again only at twice the larger of the level and the usage, and never lowers it', async () => {
    let rss = 600 * MiB
    const { deps, killed } = fakeDeps(() => one(rss))
    const onExceeded = vi.fn()
    const watch = watchBackendResources(10, '/data', vi.fn(), limits, deps, undefined, { onExceeded })
    await watch.sample()
    await watch.sample()
    expect(watch.keepRunning('memory')).toBe(1200 * MiB)
    rss = 1100 * MiB
    for (let i = 0; i < 4; i++) await watch.sample()
    rss = 100 * MiB
    await watch.sample()
    rss = 700 * MiB
    for (let i = 0; i < 4; i++) await watch.sample()
    expect(onExceeded).toHaveBeenCalledTimes(1)
    rss = 1300 * MiB
    await watch.sample()
    await watch.sample()
    expect(onExceeded).toHaveBeenCalledTimes(2)
    expect(onExceeded).toHaveBeenLastCalledWith({ item: 'memory', usage: 1300 * MiB, threshold: 1200 * MiB })
    expect(killed).toEqual([])
  })

  it('doubles the CPU usage value and keeps the 5-minute window', async () => {
    let now = 0
    let cpu = 0
    let rate = 1.0
    const { deps } = fakeDeps(() => [{ pid: 10, ppid: 1, rssBytes: MiB, cpuMs: cpu }], { now: () => now })
    const onExceeded = vi.fn()
    const watch = watchBackendResources(10, '/data', vi.fn(), limits, deps, undefined, { onExceeded })
    const advance = async (ms: number) => {
      for (let t = 0; t < ms; t += 5_000) {
        now += 5_000
        cpu += 5_000 * rate
        await watch.sample()
      }
    }
    await watch.sample()
    await advance(limits.cpuKillAfterMs)
    expect(onExceeded).toHaveBeenCalledWith({ item: 'cpu', usage: 1, threshold: limits.maxCpuCores })
    expect(watch.keepRunning('cpu')).toBe(2)
    rate = 1.9
    await advance(limits.cpuKillAfterMs * 2)
    expect(onExceeded).toHaveBeenCalledTimes(1)
    rate = 2.5
    await advance(limits.cpuKillAfterMs - 5_000)
    expect(onExceeded).toHaveBeenCalledTimes(1)
    await advance(10_000)
    expect(onExceeded).toHaveBeenCalledTimes(2)
    expect(onExceeded).toHaveBeenLastCalledWith({ item: 'cpu', usage: 2.5, threshold: 2 })
  })

  it('notifies for processes and disk with their own levels', async () => {
    const tree = Array.from({ length: 9 }, (_, index) => ({ pid: 100 + index, ppid: index === 0 ? 1 : 100, rssBytes: MiB, cpuMs: 0 }))
    const { deps, killed } = fakeDeps(() => tree, { dataBytes: limits.maxDataBytes + 1 })
    const onExceeded = vi.fn()
    await watchBackendResources(100, '/data', vi.fn(), limits, deps, undefined, { onExceeded }).sample()
    expect(onExceeded).toHaveBeenCalledWith({ item: 'processes', usage: 9, threshold: limits.maxProcesses })
    expect(onExceeded).toHaveBeenCalledWith({ item: 'disk', usage: limits.maxDataBytes + 1, threshold: limits.maxDataBytes })
    expect(killed).toEqual([])
  })

  // Review (a) on #371: notices live in memory; after a restart the new watch
  // measures again from the default levels and raises a new notice.
  it('a new watch after a restart notices again at the default level', async () => {
    const { deps } = fakeDeps(() => one(1300 * MiB))
    const first = vi.fn()
    const before = watchBackendResources(10, '/data', vi.fn(), limits, deps, undefined, { onExceeded: first })
    await before.sample()
    await before.sample()
    before.keepRunning('memory')
    before.dispose()
    const after = vi.fn()
    const restarted = watchBackendResources(10, '/data', vi.fn(), limits, deps, undefined, { onExceeded: after })
    await restarted.sample()
    await restarted.sample()
    expect(after).toHaveBeenCalledWith({ item: 'memory', usage: 1300 * MiB, threshold: limits.maxRssBytes })
  })
})

describe('watch status (the activity page reads it)', () => {
  it('reports the latest usage, the default thresholds, the notice levels and what waits for an answer', async () => {
    const { deps } = fakeDeps(() => [{ pid: 10, ppid: 1, rssBytes: 600 * MiB, cpuMs: 0 }])
    const watch = watchBackendResources(10, '/data', vi.fn(), limits, deps, undefined, { onExceeded: vi.fn() })
    await watch.sample()
    await watch.sample()
    const stdoutPending = defaultStdoutPendingThreshold()
    expect(watch.status!()).toEqual({
      usage: { memory: 600 * MiB, cpu: 0, processes: 1, disk: 0, stdoutPending: 0 },
      thresholds: { memory: limits.maxRssBytes, cpu: limits.maxCpuCores, processes: limits.maxProcesses, disk: limits.maxDataBytes, stdoutPending },
      levels: { memory: limits.maxRssBytes, cpu: limits.maxCpuCores, processes: limits.maxProcesses, disk: limits.maxDataBytes, stdoutPending },
      waiting: ['memory'],
    })
    watch.keepRunning('memory')
    expect(watch.status!()).toMatchObject({ levels: { memory: 1200 * MiB }, waiting: [] })
  })
})

// Review M2 on #375 (contract 5.2): stdout a child sent without a newline yet
// is a fifth item, noticed like the others; threshold min(256 MiB, RAM / 8).
describe('stdoutPending in notify mode', () => {
  it('defaults to the smaller of 256 MiB and an eighth of the memory', () => {
    expect(defaultStdoutPendingThreshold(16 * 1024 * MiB)).toBe(256 * MiB)
    expect(defaultStdoutPendingThreshold(1024 * MiB)).toBe(128 * MiB)
  })

  it('tells the user when it passes the threshold, again only at twice the level, and never stops the backend', async () => {
    let pending = 10 * MiB
    const { deps, killed } = fakeDeps(() => [{ pid: 10, ppid: 1, rssBytes: MiB, cpuMs: 0 }])
    const onExceeded = vi.fn()
    const watch = watchBackendResources(10, '/data', vi.fn(), limits, deps, undefined, {
      onExceeded, stdoutPending: { bytes: () => pending, threshold: 128 * MiB },
    })
    await watch.sample()
    expect(onExceeded).not.toHaveBeenCalled()
    pending = 200 * MiB
    await watch.sample()
    await watch.sample()
    expect(onExceeded).toHaveBeenCalledTimes(1)
    expect(onExceeded).toHaveBeenCalledWith({ item: 'stdoutPending', usage: 200 * MiB, threshold: 128 * MiB })
    expect(watch.keepRunning('stdoutPending')).toBe(400 * MiB)
    pending = 390 * MiB
    await watch.sample()
    expect(onExceeded).toHaveBeenCalledTimes(1)
    pending = 401 * MiB
    await watch.sample()
    expect(onExceeded).toHaveBeenLastCalledWith({ item: 'stdoutPending', usage: 401 * MiB, threshold: 400 * MiB })
    expect(killed).toEqual([])
    expect(watch.status!()).toMatchObject({ usage: { stdoutPending: 401 * MiB }, thresholds: { stdoutPending: 128 * MiB } })
  })

  it('without a source (before #375) it is never noticed', async () => {
    const { deps } = fakeDeps(() => [{ pid: 10, ppid: 1, rssBytes: MiB, cpuMs: 0 }])
    const onExceeded = vi.fn()
    const watch = watchBackendResources(10, '/data', vi.fn(), limits, deps, undefined, { onExceeded })
    await watch.sample()
    expect(onExceeded).not.toHaveBeenCalled()
    expect(watch.status!().usage.stdoutPending).toBe(0)
  })
})

// Review LOW1/LOW2 on #386: Stop in notify mode is the same stop as the
// automatic one, on a freshly listed tree.
describe('Stop equals the automatic stop', () => {
  const tree = [
    { pid: 10, ppid: 1, rssBytes: 400 * MiB, cpuMs: 0 },
    { pid: 11, ppid: 10, rssBytes: 200 * MiB, cpuMs: 0 },
    { pid: 12, ppid: 11, rssBytes: MiB, cpuMs: 0 },
  ]

  it('kills the same tree in the same order, with the same onViolation and the same end of watching', async () => {
    const main = fakeDeps(() => tree)
    const mainViolation = vi.fn()
    const automatic = watchBackendResources(10, '/data', mainViolation, limits, main.deps)
    await automatic.sample()
    await automatic.sample()

    const optionC = fakeDeps(() => tree)
    const cViolation = vi.fn()
    const notified = watchBackendResources(10, '/data', cViolation, limits, optionC.deps, undefined, { onExceeded: vi.fn() })
    await notified.sample()
    await notified.sample()
    await notified.terminate('memory')

    expect(main.killed).toEqual([12, 11, 10])
    expect(optionC.killed).toEqual(main.killed)
    expect(cViolation.mock.calls).toEqual(mainViolation.mock.calls)
    expect(optionC.deps.clearInterval).toHaveBeenCalledTimes(1)
    expect(main.deps.clearInterval).toHaveBeenCalledTimes(1)
  })

  it('lists the tree again at Stop, so a process started since the last sample is stopped too', async () => {
    let listing = tree.slice(0, 2)
    const { deps, killed } = fakeDeps(() => listing)
    const watch = watchBackendResources(10, '/data', vi.fn(), limits, deps, undefined, { onExceeded: vi.fn() })
    await watch.sample()
    await watch.sample()
    listing = tree
    await watch.terminate('memory')
    expect(killed).toEqual([12, 11, 10])
  })

  // Review N1 on #386: a backend that is already gone leaves pids that may be reused.
  it('kills nothing when the fresh listing no longer has the tree', async () => {
    let listing = tree
    const { deps, killed } = fakeDeps(() => listing)
    const onViolation = vi.fn()
    const watch = watchBackendResources(10, '/data', onViolation, limits, deps, undefined, { onExceeded: vi.fn() })
    await watch.sample()
    await watch.sample()
    listing = []
    await watch.terminate('memory')
    expect(killed).toEqual([])
    expect(onViolation).not.toHaveBeenCalled()
    expect(deps.clearInterval).toHaveBeenCalledTimes(1)
  })

  it('falls back to the last sample only when listing fails', async () => {
    let fail = false
    const { deps, killed } = fakeDeps(() => {
      if (fail) throw new Error('ps failed')
      return tree
    })
    const watch = watchBackendResources(10, '/data', vi.fn(), limits, deps, undefined, { onExceeded: vi.fn() })
    await watch.sample()
    await watch.sample()
    fail = true
    await watch.terminate('memory')
    expect(killed).toEqual([12, 11, 10])
  })
})

