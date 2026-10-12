import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  createHostWatchdogDeps,
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
