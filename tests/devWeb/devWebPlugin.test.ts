import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDevWebGate, devWebPlugins, DEV_WEB_PREFIX, ensurePrivateDir } from '../../scripts/dev-web/devWebPlugin'

const TOKEN = 'a'.repeat(64)
const HOST = '127.0.0.1:5274'

interface FakeRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  ended: boolean
}

function call(
  gate: ReturnType<typeof createDevWebGate>,
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: string }
): Promise<{ res: FakeRes; nextCalled: boolean; req: IncomingMessage }> {
  return new Promise((resolve) => {
    const res: FakeRes = { statusCode: 200, headers: {}, body: '', ended: false }
    const chunks = opts.body === undefined ? [] : [Buffer.from(opts.body)]
    const req = {
      method: opts.method ?? 'GET',
      url: opts.url,
      headers: { host: HOST, ...(opts.headers ?? {}) },
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c
      },
    } as unknown as IncomingMessage
    const fakeRes = {
      writeHead(code: number, headers?: Record<string, string | string[]>) {
        res.statusCode = code
        Object.assign(res.headers, headers ?? {})
        return this
      },
      setHeader(k: string, v: string | string[]) {
        res.headers[k] = v
      },
      end(b?: string) {
        res.body = b ?? ''
        res.ended = true
        resolve({ res, nextCalled: false, req })
      },
    } as unknown as ServerResponse
    void gate(req, fakeRes, () => resolve({ res, nextCalled: true, req }))
  })
}

function makeGate(prove: string | null = 'proof-xyz') {
  return createDevWebGate({
    devToken: TOKEN,
    allowedHost: HOST,
    backend: {
      info: () => ({ status: 'ready', host: '127.0.0.1', port: 8931, httpUrl: 'http://127.0.0.1:8931', wsUrl: 'ws://127.0.0.1:8931/ws?t=ws-secret' }),
      prove: () => prove,
    },
  })
}

async function login(gate: ReturnType<typeof createDevWebGate>): Promise<string> {
  const minted = await call(gate, { method: 'POST', url: `${DEV_WEB_PREFIX}mint`, headers: { 'x-electron-token': TOKEN } })
  const code = JSON.parse(minted.res.body).code as string
  const loggedIn = await call(gate, { url: `${DEV_WEB_PREFIX}login?code=${code}` })
  const cookie = String(loggedIn.res.headers['Set-Cookie'])
  return cookie.split(';')[0]
}

describe('devWebPlugins', () => {
  it('adds nothing unless NAVIDE_DEV_WEB is exactly "1"', () => {
    expect(devWebPlugins(TOKEN, {})).toEqual([])
    expect(devWebPlugins(TOKEN, { NAVIDE_DEV_WEB: '0' })).toEqual([])
    expect(devWebPlugins(TOKEN, { NAVIDE_DEV_WEB: 'true' })).toEqual([])
  })

  it('is serve-only and binds the dev server to 127.0.0.1 when enabled', () => {
    const plugins = devWebPlugins(TOKEN, { NAVIDE_DEV_WEB: '1' })
    expect(plugins).toHaveLength(1)
    expect(plugins[0].apply).toBe('serve')
    const cfg = (plugins[0].config as () => { server: { host: string; strictPort: boolean } })()
    expect(cfg.server.host).toBe('127.0.0.1')
    expect(cfg.server.strictPort).toBe(true)
  })
})

describe('createDevWebGate', () => {
  it('lets a request without a session through untouched, so electron-only still answers 403', async () => {
    const { nextCalled, req } = await call(makeGate(), { url: '/index.html' })
    expect(nextCalled).toBe(true)
    expect(req.headers['x-electron-token']).toBeUndefined()
  })

  it('refuses to mint a login code without the dev token', async () => {
    const { res } = await call(makeGate(), { method: 'POST', url: `${DEV_WEB_PREFIX}mint`, headers: { 'x-electron-token': 'wrong' } })
    expect(res.statusCode).toBe(403)
  })

  it('turns a one-time login code into a host-only, HttpOnly, SameSite=Strict cookie', async () => {
    const gate = makeGate()
    const minted = await call(gate, { method: 'POST', url: `${DEV_WEB_PREFIX}mint`, headers: { 'x-electron-token': TOKEN } })
    expect(minted.res.statusCode).toBe(200)
    const code = JSON.parse(minted.res.body).code as string
    const first = await call(gate, { url: `${DEV_WEB_PREFIX}login?code=${code}` })
    expect(first.res.statusCode).toBe(302)
    const cookie = String(first.res.headers['Set-Cookie'])
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Strict/)
    expect(cookie).not.toMatch(/Domain=/i)
    const second = await call(gate, { url: `${DEV_WEB_PREFIX}login?code=${code}` })
    expect(second.res.statusCode).toBe(403)
  })

  it('injects the dev token for a request carrying a valid session cookie', async () => {
    const gate = makeGate()
    const cookie = await login(gate)
    const { nextCalled, req } = await call(gate, { url: '/src/main.ts', headers: { cookie } })
    expect(nextCalled).toBe(true)
    expect(req.headers['x-electron-token']).toBe(TOKEN)
  })

  it('does not inject the dev token for a forged cookie', async () => {
    const { req } = await call(makeGate(), { url: '/', headers: { cookie: 'navide_dev_web=forged' } })
    expect(req.headers['x-electron-token']).toBeUndefined()
  })

  it('rejects a Host other than the bound 127.0.0.1 address (DNS rebinding)', async () => {
    const gate = makeGate()
    const cookie = await login(gate)
    const { res } = await call(gate, { url: '/', headers: { cookie, host: 'evil.example:5274' } })
    expect(res.statusCode).toBe(403)
  })

  it('serves backend info only to a session', async () => {
    const gate = makeGate()
    expect((await call(gate, { url: `${DEV_WEB_PREFIX}backend` })).res.statusCode).toBe(403)
    const cookie = await login(gate)
    const { res } = await call(gate, { url: `${DEV_WEB_PREFIX}backend`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).wsUrl).toBe('ws://127.0.0.1:8931/ws?t=ws-secret')
  })

  it('signs a window challenge for a session and refuses without one', async () => {
    const gate = makeGate()
    const anon = await call(gate, { method: 'POST', url: `${DEV_WEB_PREFIX}prove`, body: JSON.stringify({ nonce: 'n1' }) })
    expect(anon.res.statusCode).toBe(403)
    const cookie = await login(gate)
    const { res } = await call(gate, { method: 'POST', url: `${DEV_WEB_PREFIX}prove`, headers: { cookie }, body: JSON.stringify({ nonce: 'n1' }) })
    expect(JSON.parse(res.body)).toEqual({ proof: 'proof-xyz' })
  })
})

// POSIX permission bits; Windows has none to check (ensurePrivateDir skips them there).
describe('ensurePrivateDir', () => {
  it.skipIf(process.platform === 'win32')('creates a missing run dir owner-only', () => {
    const base = mkdtempSync(join(tmpdir(), 'dev-web-dir-'))
    try {
      const dir = join(base, 'run')
      ensurePrivateDir(dir)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('refuses a run dir others can write to, or a symlink', () => {
    const base = mkdtempSync(join(tmpdir(), 'dev-web-dir-'))
    try {
      const open = join(base, 'open')
      mkdirSync(open)
      chmodSync(open, 0o777)
      expect(() => ensurePrivateDir(open)).toThrow(/not private/)
      const link = join(base, 'link')
      symlinkSync(base, link)
      expect(() => ensurePrivateDir(link)).toThrow(/not private/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
