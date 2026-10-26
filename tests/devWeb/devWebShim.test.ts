import { describe, expect, it, vi } from 'vitest'
import { createDevWebBridge } from '../../src/renderer/src/devWeb/devWebShim'

function bridgeWith(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown> = async () => ({})) {
  const notices: string[] = []
  const bridge = createDevWebBridge({
    fetchJson: fetchImpl,
    notify: (name) => notices.push(name),
    platform: 'darwin',
  }) as Record<string, any>
  return { bridge, notices }
}

describe('dev web bridge', () => {
  it('answers an unimplemented call with a visible notice and an undefined result', async () => {
    const { bridge, notices } = bridgeWith()
    await expect(bridge.openTerminal('/tmp')).resolves.toBeUndefined()
    await expect(bridge.updater.check()).resolves.toBeUndefined()
    expect(notices).toEqual(['openTerminal', 'updater.check'])
  })

  it('gives startup calls that are read unguarded an empty, well-formed result', async () => {
    const { bridge, notices } = bridgeWith()
    await expect(bridge.updater.getState()).resolves.toMatchObject({ status: 'unsupported' })
    await expect(bridge.getDetachedGroups()).resolves.toEqual([])
    await expect(bridge.readKeybindings()).resolves.toEqual({ ok: false })
    expect(notices).toEqual(['updater.getState', 'getDetachedGroups', 'readKeybindings'])
  })

  it('is never mistaken for a promise', () => {
    const { bridge } = bridgeWith()
    expect(bridge.then).toBeUndefined()
    expect(bridge.updater.then).toBeUndefined()
  })

  it('treats on* subscriptions as silent no-ops that return a disposer', () => {
    const { bridge, notices } = bridgeWith()
    const off = bridge.onMenuAction(() => {})
    expect(typeof off).toBe('function')
    off()
    bridge.windowControls.onMaximizeChanged(() => {})
    expect(notices).toEqual([])
  })

  it('gets backend info and window proofs from the dev server', async () => {
    const fetchJson = vi.fn(async (url: string) =>
      url.endsWith('/backend') ? { status: 'ready', wsUrl: 'ws://127.0.0.1:8931/ws?t=x' } : { proof: 'p' }
    )
    const { bridge, notices } = bridgeWith(fetchJson)
    await expect(bridge.getBackendInfo()).resolves.toEqual({ status: 'ready', wsUrl: 'ws://127.0.0.1:8931/ws?t=x' })
    await expect(bridge.proveWindow('n')).resolves.toBe('p')
    expect(fetchJson).toHaveBeenCalledWith('/__navide_dev_web/backend', undefined)
    expect(notices).toEqual([])
  })

  it('serves the synchronous startup values the renderer reads before mounting', () => {
    const { bridge } = bridgeWith()
    expect(bridge.platform).toBe('darwin')
    expect(JSON.parse(bridge.getBootstrapSettings())).toEqual({})
    expect(typeof bridge.version).toBe('string')
  })
})
