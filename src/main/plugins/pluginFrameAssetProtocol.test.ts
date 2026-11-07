import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_FRAME_SCHEME,
  PluginFrameAssetProtocol,
  pluginFrameConnectSources,
  pluginFrameCsp,
} from './pluginFrameAssetProtocol'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function packageDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'navide-frame-assets-'))
  roots.push(root)
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>')
  return root
}

const mountOf = (connectHosts?: string[]) => ({
  artifactId: 'a'.repeat(64),
  packageId: 'acme.status',
  packageVersion: '1.0.0',
  root: packageDir(),
  ...(connectHosts ? { connectHosts } : {}),
})

describe('pluginFrameConnectSources', () => {
  it('admits TLS schemes for every declared host and the plain ones only for loopback and IPv4 literals', () => {
    expect(pluginFrameConnectSources(['api.github.com', '*.example.com', 'localhost', '127.0.0.1'])).toEqual([
      'https://api.github.com', 'wss://api.github.com',
      'https://*.example.com', 'wss://*.example.com',
      'https://localhost', 'wss://localhost', 'http://localhost', 'ws://localhost',
      'https://127.0.0.1', 'wss://127.0.0.1', 'http://127.0.0.1', 'ws://127.0.0.1',
    ])
    expect(pluginFrameConnectSources(undefined)).toEqual([])
  })
})

describe('pluginFrameCsp', () => {
  it("keeps connect-src 'none' without declared hosts and lists the sources with them", () => {
    expect(pluginFrameCsp(undefined)).toContain("connect-src 'none'")
    expect(pluginFrameCsp([])).toContain("connect-src 'none'")
    const csp = pluginFrameCsp(['api.github.com'])
    expect(csp).toContain('connect-src https://api.github.com wss://api.github.com;')
    // C1 switch off (the default): a v2 package's frame may connect anywhere and the session hook records it;
    // a legacy descriptor (no list) keeps 'none' either way.
    expect(pluginFrameCsp(['api.github.com'], false)).toContain('connect-src *;')
    expect(pluginFrameCsp([], false)).toContain('connect-src *;')
    expect(pluginFrameCsp(undefined, false)).toContain("connect-src 'none'")
    // Everything else is unchanged by a declaration.
    for (const fixed of ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "img-src 'self' data:", "object-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "worker-src 'none'"]) {
      expect(csp).toContain(fixed)
      expect(pluginFrameCsp(undefined)).toContain(fixed)
    }
  })
})

describe('PluginFrameAssetProtocol', () => {
  it('serves each mount with its own CSP, so one package cannot borrow another one’s hosts', async () => {
    const protocol = new PluginFrameAssetProtocol()
    const open = await protocol.mount(mountOf(['api.github.com']))
    const closed = await protocol.mount(mountOf())
    const openResponse = await protocol.handle(new Request(`${open}index.html`))
    const closedResponse = await protocol.handle(new Request(`${closed}index.html`))
    expect(openResponse.status).toBe(200)
    expect(openResponse.headers.get('Content-Security-Policy')).toContain('connect-src https://api.github.com wss://api.github.com;')
    expect(closedResponse.status).toBe(200)
    expect(closedResponse.headers.get('Content-Security-Policy')).toContain("connect-src 'none'")
  })

  it('names the package of a live frame URL and nothing else', async () => {
    const protocol = new PluginFrameAssetProtocol()
    const origin = await protocol.mount(mountOf(['api.github.com']))
    const mount = protocol.mountOf(`${origin}index.html?workspace_path=%2Fw&v2=1&contribution=main`)
    expect(mount).toMatchObject({ packageId: 'acme.status', packageVersion: '1.0.0', connectHosts: ['api.github.com'] })
    expect(mount).not.toHaveProperty('csp')
    expect(protocol.mountOf('https://api.github.com/')).toBeNull()
    expect(protocol.mountOf(`${PLUGIN_FRAME_SCHEME}://${'0'.repeat(64)}/index.html`)).toBeNull()
    expect(protocol.mountOf(undefined)).toBeNull()
    expect(protocol.mountOf('not a url')).toBeNull()
    protocol.revoke(origin)
    expect(protocol.mountOf(`${origin}index.html`)).toBeNull()
  })

  it('does not let a later caller change the hosts of a mount through the array it passed', async () => {
    const protocol = new PluginFrameAssetProtocol()
    const hosts = ['api.github.com']
    const origin = await protocol.mount(mountOf(hosts))
    hosts.push('evil.example')
    const response = await protocol.handle(new Request(`${origin}index.html`))
    expect(response.headers.get('Content-Security-Policy')).not.toContain('evil.example')
    expect(protocol.mountOf(origin)?.connectHosts).toEqual(['api.github.com'])
  })
})
