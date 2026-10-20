import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nothing here may touch the real OS protocol registration or LaunchServices.
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }) => unknown>(),
  setAsDefaultProtocolClient: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { setAsDefaultProtocolClient: electron.setAsDefaultProtocolClient },
  ipcMain: {
    handle: (channel: string, fn: (event: { sender: unknown }) => unknown) => {
      electron.handlers.set(channel, fn)
    },
  },
}))

import {
  DEEP_LINK_REPEAT_MS,
  MAX_PENDING_DEEP_LINKS,
  MAX_RECENT_DEEP_LINKS,
  createDeepLinkRouter,
  registerDeepLinkIpc,
} from './deep-link'
import {
  DEEP_LINK_OPEN_CHANNEL,
  DEEP_LINK_PUBLISH_CHANNEL,
  DEEP_LINK_READY_CHANNEL,
  MAX_DEEP_LINK_LENGTH,
  deepLinkFromArgv,
  parseDeepLink,
  parsePublishDeepLink,
} from '../shared/deepLink'

interface FakeContents {
  id: number
  sent: Array<[string, unknown]>
  destroyed: boolean
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
  once: (event: string, fn: () => void) => void
  destroy: () => void
}

function fakeContents(id: number): FakeContents {
  const onDestroyed: Array<() => void> = []
  const c: FakeContents = {
    id,
    sent: [],
    destroyed: false,
    isDestroyed: () => c.destroyed,
    send: (channel, payload) => c.sent.push([channel, payload]),
    once: (event, fn) => {
      if (event === 'destroyed') onDestroyed.push(fn)
    },
    destroy: () => {
      c.destroyed = true
      onDestroyed.forEach((fn) => fn())
    },
  }
  return c
}

describe('parseDeepLink', () => {
  it('accepts navide://extension/<publisher>.<name>', () => {
    expect(parseDeepLink('navide://extension/navide.git')).toEqual({
      ok: true,
      target: { namespace: 'navide', name: 'git' },
    })
    expect(parseDeepLink('navide://extension/acme-tools.foo.bar')).toEqual({
      ok: true,
      target: { namespace: 'acme-tools', name: 'foo.bar' },
    })
  })

  it('tolerates an upper-cased scheme and one trailing slash', () => {
    expect(parseDeepLink('NAVIDE://EXTENSION/navide.git').ok).toBe(true)
    expect(parseDeepLink('navide://extension/navide.git/').ok).toBe(true)
  })

  it.each([
    ['other host', 'navide://install/navide.git'],
    ['other scheme', 'https://extension/navide.git'],
    ['no id', 'navide://extension/'],
    ['no name', 'navide://extension/navide'],
    ['empty segment', 'navide://extension/navide..git'],
    ['leading dot', 'navide://extension/.navide.git'],
    ['trailing dot', 'navide://extension/navide.git.'],
    ['leading dash', 'navide://extension/-navide.git'],
    ['upper-case id', 'navide://extension/Navide.Git'],
    ['version suffix', 'navide://extension/navide.git@1.0.0'],
    ['query', 'navide://extension/navide.git?install=1'],
    ['fragment', 'navide://extension/navide.git#install'],
    ['extra path', 'navide://extension/navide.git/install'],
    ['two trailing slashes', 'navide://extension/navide.git//'],
    ['path traversal', 'navide://extension/../../etc/passwd'],
    ['encoded traversal', 'navide://extension/navide.%2e%2e%2fgit'],
    ['backslash traversal', 'navide://extension/navide.git\\..\\x'],
    ['embedded url', 'navide://extension/https://evil.example/x.y'],
    ['shell metacharacters', 'navide://extension/navide.git;rm'],
    ['whitespace', 'navide://extension/navide. git'],
    ['newline', 'navide://extension/navide.git\n[main] forged'],
    ['NUL', 'navide://extension/navide.git\u0000'],
    ['non-ASCII look-alike', 'navide://extension/navіde.git'],
    ['full-width', 'navide://extension/ｎavide.git'],
    ['emoji', 'navide://extension/navide.😀'],
    ['bare scheme', 'navide:'],
  ])('rejects %s', (_label, url) => {
    expect(parseDeepLink(url).ok).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(parseDeepLink(undefined).ok).toBe(false)
    expect(parseDeepLink({ toString: () => 'navide://extension/navide.git' }).ok).toBe(false)
  })

  it('rejects overlong links and ids before matching', () => {
    const longId = `a.${'b'.repeat(200)}`
    expect(parseDeepLink(`navide://extension/${longId}`)).toEqual({ ok: false, reason: 'id too long' })
    const huge = `navide://extension/navide.${'g'.repeat(MAX_DEEP_LINK_LENGTH)}`
    expect(parseDeepLink(huge)).toEqual({ ok: false, reason: 'too long' })
    expect(parseDeepLink('x'.repeat(1_000_000))).toEqual({ ok: false, reason: 'too long' })
  })
})

describe('deepLinkFromArgv', () => {
  it('finds the link among launch arguments', () => {
    expect(deepLinkFromArgv(['Navide.exe', '--flag', 'navide://extension/navide.git'])).toBe(
      'navide://extension/navide.git'
    )
    expect(deepLinkFromArgv(['Navide.exe', 'NAVIDE://extension/navide.git'])).toBe(
      'NAVIDE://extension/navide.git'
    )
  })

  it('returns null when there is none', () => {
    expect(deepLinkFromArgv(['Navide.exe', '/Users/me/project', '--navide'])).toBeNull()
  })
})

describe('createDeepLinkRouter', () => {
  let clock: number
  let log: string[]
  let revealed: number[]
  let ensureWindow: ReturnType<typeof vi.fn>
  let windows: FakeContents[]

  function router() {
    return createDeepLinkRouter({
      pickTarget: (ready) => (windows.find((w) => ready.has(w.id) && !w.destroyed) ?? null) as never,
      reveal: (c) => revealed.push(c.id),
      ensureWindow,
      log: (m) => log.push(m),
      now: () => clock,
    })
  }

  beforeEach(() => {
    clock = 10_000
    log = []
    revealed = []
    ensureWindow = vi.fn()
    windows = []
  })

  it('rejects and logs a bad link without opening anything', () => {
    const r = router()
    const win = fakeContents(1)
    windows.push(win)
    r.ready(win as never)
    r.handle('navide://extension/../../etc/passwd')
    r.handle('navide://install/navide.git')
    expect(win.sent).toEqual([])
    expect(r.pending()).toEqual([])
    expect(ensureWindow).not.toHaveBeenCalled()
    expect(log.filter((m) => m.startsWith('[deeplink] rejected'))).toHaveLength(2)
  })

  it('logs a hostile link JSON-quoted and trimmed, so it cannot forge log lines', () => {
    const r = router()
    r.handle(`navide://extension/x\n[main] forged ${'z'.repeat(500)}`)
    expect(log).toHaveLength(1)
    expect(log[0]).not.toContain('\n')
    expect(log[0].length).toBeLessThan(160)
  })

  it('sends a valid link straight to a ready window and reveals it', () => {
    const r = router()
    const win = fakeContents(1)
    windows.push(win)
    expect(r.ready(win as never)).toEqual([])
    r.handle('navide://extension/navide.git')
    expect(win.sent).toEqual([[DEEP_LINK_OPEN_CHANNEL, { namespace: 'navide', name: 'git' }]])
    expect(revealed).toEqual([1])
  })

  it('queues cold-start links until a window is ready, then hands them over in order', () => {
    const r = router()
    r.handle('navide://extension/navide.git')
    r.handle('navide://extension/acme.tool')
    expect(ensureWindow).toHaveBeenCalledTimes(2)
    expect(r.pending()).toHaveLength(2)

    const win = fakeContents(7)
    windows.push(win)
    expect(r.ready(win as never)).toEqual([
      { namespace: 'navide', name: 'git' },
      { namespace: 'acme', name: 'tool' },
    ])
    expect(r.pending()).toEqual([])
    expect(win.sent).toEqual([])
    expect(revealed).toEqual([7])
    // A later ready call (reload) gets nothing twice.
    expect(r.ready(win as never)).toEqual([])
  })

  it('ignores a burst of the same link, but not a later one', () => {
    const r = router()
    const win = fakeContents(1)
    windows.push(win)
    r.ready(win as never)
    for (let i = 0; i < 20; i++) r.handle('navide://extension/navide.git')
    expect(win.sent).toHaveLength(1)
    clock += DEEP_LINK_REPEAT_MS
    r.handle('navide://extension/navide.git')
    expect(win.sent).toHaveLength(2)
  })

  it('suppresses alternating links per id within the window', () => {
    const r = router()
    const win = fakeContents(1)
    windows.push(win)
    r.ready(win as never)
    for (let i = 0; i < 10; i++) {
      r.handle('navide://extension/acme.a')
      r.handle('navide://extension/acme.b')
      clock += 100
    }
    expect(win.sent.map(([, t]) => (t as { name: string }).name)).toEqual(['a', 'b'])
    clock += DEEP_LINK_REPEAT_MS
    r.handle('navide://extension/acme.a')
    r.handle('navide://extension/acme.b')
    expect(win.sent).toHaveLength(4)
  })

  it('bounds the repeat memory, forgetting the oldest id first', () => {
    const r = router()
    const win = fakeContents(1)
    windows.push(win)
    r.ready(win as never)
    for (let i = 0; i <= MAX_RECENT_DEEP_LINKS; i++) r.handle(`navide://extension/acme.x${i}`)
    expect(win.sent).toHaveLength(MAX_RECENT_DEEP_LINKS + 1)
    // x0 was evicted, so it opens again; the newest is still remembered.
    r.handle('navide://extension/acme.x0')
    r.handle(`navide://extension/acme.x${MAX_RECENT_DEEP_LINKS}`)
    expect(win.sent).toHaveLength(MAX_RECENT_DEEP_LINKS + 2)
  })

  it('de-duplicates and bounds the queue', () => {
    const r = router()
    r.handle('navide://extension/navide.git')
    clock += DEEP_LINK_REPEAT_MS
    r.handle('navide://extension/navide.git')
    expect(r.pending()).toHaveLength(1)
    for (let i = 0; i < MAX_PENDING_DEEP_LINKS * 3; i++) r.handle(`navide://extension/acme.tool-${i}`)
    expect(r.pending()).toHaveLength(MAX_PENDING_DEEP_LINKS)
    expect(log.some((m) => m.includes('queue full'))).toBe(true)
  })

  it('queues again once the ready window is gone', () => {
    const r = router()
    const win = fakeContents(1)
    windows.push(win)
    r.ready(win as never)
    win.destroy()
    r.handle('navide://extension/navide.git')
    expect(win.sent).toEqual([])
    expect(r.pending()).toEqual([{ namespace: 'navide', name: 'git' }])
    expect(ensureWindow).toHaveBeenCalledTimes(1)
  })

  it('never exposes an install path: only the open-detail channel is ever sent', () => {
    const r = router()
    const win = fakeContents(1)
    windows.push(win)
    r.ready(win as never)
    r.handle('navide://extension/navide.git')
    clock += DEEP_LINK_REPEAT_MS
    r.handle('navide://extension/acme.tool')
    expect(new Set(win.sent.map(([channel]) => channel))).toEqual(new Set([DEEP_LINK_OPEN_CHANNEL]))
    for (const [, payload] of win.sent) expect(Object.keys(payload as object).sort()).toEqual(['name', 'namespace'])
  })
})

describe('registerDeepLinkIpc', () => {
  it('only hands queued links to main-window renderers', () => {
    const r = createDeepLinkRouter({
      pickTarget: () => null,
      reveal: () => {},
      ensureWindow: () => {},
      log: () => {},
    })
    r.handle('navide://extension/navide.git')
    const main = fakeContents(1)
    const plugin = fakeContents(2)
    registerDeepLinkIpc(r, (c) => c === (main as never))
    const handler = electron.handlers.get(DEEP_LINK_READY_CHANNEL)!
    expect(handler({ sender: plugin })).toEqual([])
    expect(r.pending()).toHaveLength(1)
    expect(handler({ sender: main })).toEqual([{ namespace: 'navide', name: 'git' }])
  })
})

describe('main-process wiring', () => {
  const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('registers the scheme with the OS only in packaged builds', () => {
    expect(mainSource).toContain('if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)')
    expect(mainSource.match(/setAsDefaultProtocolClient/g)).toHaveLength(1)
    expect(electron.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })

  it('routes open-url, second-instance argv and launch argv through the router', () => {
    expect(mainSource).toMatch(/app\.on\('open-url', \(event, url\) => \{\s*event\.preventDefault\(\)\s*deepLinks\.handle\(url\)/)
    expect(mainSource).toMatch(/app\.on\('second-instance', \(_event, argv\) => \{[\s\S]{0,300}deepLinkFromArgv\(argv\)[\s\S]{0,80}deepLinks\.handle\(link\)/)
    expect(mainSource).toContain('deepLinkFromArgv(process.argv)')
  })

  it('packaged builds declare the navide scheme', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
    expect(pkg.build.protocols).toEqual([{ name: 'Navide', schemes: ['navide'] }])
  })
})

describe('parsePublishDeepLink (navide-plugin publish --via-navide)', () => {
  it('decodes the fixture the CLI line tests with', () => {
    // Shared with 27-CLI線 (#463): the same string on both sides keeps the encoding in step.
    expect(parsePublishDeepLink('navide://publish?path=%2Ftmp%2Fa%20b%2Fx-1.0.0-universal.vsix&target=darwin-arm64')).toEqual({
      ok: true,
      target: { kind: 'publish', path: '/tmp/a b/x-1.0.0-universal.vsix', target: 'darwin-arm64' },
    })
  })

  it('takes a Windows path and no target', () => {
    expect(parsePublishDeepLink('navide://publish?path=C%3A%5Cpkg%5Cx-1.0.0-win32-x64.vsix')).toEqual({
      ok: true,
      target: { kind: 'publish', path: 'C:\\pkg\\x-1.0.0-win32-x64.vsix', target: null },
    })
  })

  it.each([
    ['no path', 'navide://publish?target=universal'],
    ['relative path', 'navide://publish?path=x.vsix'],
    ['not a vsix', 'navide://publish?path=%2Fetc%2Fpasswd'],
    ['two paths', 'navide://publish?path=%2Fa.vsix&path=%2Fb.vsix'],
    ['extra parameter', 'navide://publish?path=%2Fa.vsix&registry=http%3A%2F%2Fevil'],
    ['token parameter', 'navide://publish?path=%2Fa.vsix&token=x'],
    ['bad target', 'navide://publish?path=%2Fa.vsix&target=..%2F..'],
    ['control character', 'navide://publish?path=%2Fa%0A.vsix'],
    ['other host', 'navide://publishx?path=%2Fa.vsix'],
    ['raw space', 'navide://publish?path=/a b.vsix'],
    ['too long', `navide://publish?path=%2F${'a'.repeat(4100)}.vsix`],
  ])('rejects %s', (_label, url) => {
    expect(parsePublishDeepLink(url).ok).toBe(false)
  })

  it('routes a publish link on its own channel, and never as an extension', () => {
    const contents = fakeContents(7)
    const router = createDeepLinkRouter({
      pickTarget: () => contents as never,
      reveal: () => {},
      ensureWindow: () => {},
      log: () => {},
    })
    router.ready(contents as never)
    router.handle('navide://publish?path=%2Ftmp%2Fx-1.0.0-universal.vsix')
    expect(contents.sent).toEqual([[DEEP_LINK_PUBLISH_CHANNEL, { kind: 'publish', path: '/tmp/x-1.0.0-universal.vsix', target: null }]])
    expect(contents.sent.some(([channel]) => channel === DEEP_LINK_OPEN_CHANNEL)).toBe(false)
  })

  it('queues a publish link until a window is ready', () => {
    const contents = fakeContents(8)
    let ready = false
    const router = createDeepLinkRouter({
      pickTarget: () => (ready ? (contents as never) : null),
      reveal: () => {},
      ensureWindow: () => {},
      log: () => {},
    })
    router.handle('navide://publish?path=%2Ftmp%2Fx-1.0.0-universal.vsix')
    ready = true
    expect(router.ready(contents as never)).toEqual([{ kind: 'publish', path: '/tmp/x-1.0.0-universal.vsix', target: null }])
  })
})
