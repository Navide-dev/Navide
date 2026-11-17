import { afterEach, describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { useBackend } from '../useBackend'
import { platformId, setPlatformId } from '../../../../shared/osplat'
import { createHostTerminalDockPort } from '../hostSurfacePorts'
import {
  runTerminalDockContract,
  type TerminalDockContractHarness,
  type TerminalDockRequestRecord,
} from '../../ports/__tests__/terminalDock.contract'

// The platform to restore after a test that switched it: whatever this file
// saw when it loaded — the host, or an injection from a vitest setup file.
// Restoring to the host instead silently undid that injection for every
// later test in the file (see src/shared/platformBaseline.test.ts).
const BASELINE = platformId()

type HostBackend = ReturnType<typeof useBackend>

function createHarness(): TerminalDockContractHarness {
  const status = ref<'connected'>('connected')
  const shell = ref('bash')
  const autoRestart = ref(null)
  const sent: TerminalDockRequestRecord[] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  async function send<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<{ ok: true; payload: T | null; error: null }> {
    sent.push({ type, payload, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
    return { ok: true, payload: null, error: null }
  }

  function on(type: string, callback: (payload: unknown) => void): () => void {
    const callbacks = listeners.get(type) ?? new Set()
    listeners.set(type, callbacks)
    callbacks.add(callback)
    return () => callbacks.delete(callback)
  }

  const backend = { status, shell, autoRestart, send, on } as unknown as HostBackend
  return {
    port: createHostTerminalDockPort(backend),
    sent,
    emitOutput: (payload) => { listeners.get('terminal.output')?.forEach((callback) => callback(payload)) },
    emitExit: (payload) => { listeners.get('terminal.exit')?.forEach((callback) => callback(payload)) },
  }
}

runTerminalDockContract(createHarness)

describe('Host terminal dock adapter', () => {
  afterEach(() => setPlatformId(BASELINE))

  it('does not bind raw route details into the port consumer type', () => {
    expect(createHarness().port).toHaveProperty('create')
    expect(createHarness().port).not.toHaveProperty('send')
  })

  // The dock cannot see the platform (plugin windows have no bridge for it),
  // so the host port is where the shell's command form is decided.
  it('builds the spawn argv for the platform it runs on', () => {
    const { port } = createHarness()
    setPlatformId('darwin')
    expect(port.spawnArgv?.('/bin/zsh', 'claude')).toEqual(['/bin/zsh', '-ilc', 'claude'])
    setPlatformId('win32')
    expect(port.spawnArgv?.('powershell.exe', 'claude')).toEqual([
      'powershell.exe',
      '-NoLogo',
      '-NoExit',
      '-Command',
      'claude',
    ])
  })
})

describe('Host terminal dock adapter – remote container panes', () => {
  const base = {
    paneId: 'pane-1', createGeneration: 'g-1', agentKey: 'claude', command: 'claude', cwd: '/w', env: null,
    cols: 80, rows: 24, metadata: null, outputLogFile: null, loginProfileId: null, isLogin: false, replacesTerminalId: null,
  }

  it('sends the remote target as a top-level field for a remote pane', async () => {
    const harness = createHarness()
    const remote = { host: 'devbox', container: 'app', network: { mode: 'bridge' as const, gateway: '172.17.0.1' }, cli: 'claude' as const }
    await harness.port.create({ ...base, agentKey: 'remote', remote }, 10)
    expect(harness.sent[0].payload.remote).toEqual(remote)
    expect(harness.sent[0].payload.agent_key).toBe('remote')
    expect(harness.sent[0].payload.metadata).toBeNull()
  })

  it('leaves a local pane payload without any remote key', async () => {
    const harness = createHarness()
    await harness.port.create(base, 10)
    expect(harness.sent[0].payload).not.toHaveProperty('remote')
  })
})
