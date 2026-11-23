import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORG_SITE_DEFAULT, createOrgHandoff, resolveOrgSite } from './orgHandoff'

// Fake values are assembled at runtime; nothing here is a real credential.
const FAKE_ASSERTION = ['nvsa1', 'test', 'only'].join('.')
const FAKE_TICKET = 'tk' + 'x'.repeat(30)

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void

describe('resolveOrgSite', () => {
  it('defaults to the public site and accepts https or loopback http', () => {
    expect(resolveOrgSite(undefined)).toBe(ORG_SITE_DEFAULT)
    expect(resolveOrgSite('https://staging.example.test/x')).toBe('https://staging.example.test')
    expect(resolveOrgSite('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999')
    expect(resolveOrgSite('http://example.test')).toBeNull()
    expect(resolveOrgSite('https://u:p@example.test')).toBeNull()
    expect(resolveOrgSite('not a url')).toBeNull()
  })
})

describe('createOrgHandoff', () => {
  let server: Server
  let site: string
  let handler: Handler
  let requests: { method?: string; url?: string; body: string }[]

  beforeEach(async () => {
    requests = []
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ticket: FAKE_TICKET, expires_in: 60 }))
    }
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body })
        handler(req, body, res)
      })
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((ok) => server.close(() => ok()))
  })

  function handoff(overrides: Partial<Parameters<typeof createOrgHandoff>[0]> = {}) {
    const opened: string[] = []
    const logs: string[] = []
    const challenges: string[] = []
    const h = createOrgHandoff({
      assertion: async (challenge) => {
        challenges.push(challenge)
        return { ok: true, assertion: FAKE_ASSERTION, memberId: 'm1' }
      },
      openExternal: async (url) => void opened.push(url),
      siteUrl: () => site,
      log: (m) => logs.push(m),
      ...overrides,
    })
    return { h, opened, logs, challenges }
  }

  it('exchanges the assertion and verifier for a ticket and opens it in the fragment', async () => {
    const { h, opened, logs, challenges } = handoff()
    expect(await h.open()).toEqual({ ok: true })
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('POST')
    expect(requests[0].url).toBe('/api/auth/app-exchange')
    const sent = JSON.parse(requests[0].body)
    expect(sent.assertion).toBe(FAKE_ASSERTION)
    // The verifier sent is the one the challenge was made from (S256).
    const s256 = createHash('sha256').update(sent.code_verifier).digest('base64url')
    expect(challenges).toEqual([s256])
    expect(opened).toEqual([`${site}/auth/handoff#t=${FAKE_TICKET}`])
    // Neither secret reaches a log line or a query string.
    for (const line of logs) {
      expect(line).not.toContain(FAKE_ASSERTION)
      expect(line).not.toContain(FAKE_TICKET)
      expect(line).not.toContain(sent.code_verifier)
    }
    expect(opened[0]).not.toContain('?')
  })

  it('carries a site-relative return path and refuses any other', async () => {
    const { h, opened } = handoff()
    expect(await h.open('/invite/abc')).toEqual({ ok: true })
    expect(JSON.parse(requests[0].body).return_to).toBe('/invite/abc')
    expect(opened[0]).toBe(`${site}/auth/handoff#t=${FAKE_TICKET}&r=%2Finvite%2Fabc`)
    expect((await h.open('//evil.test')).ok).toBe(false)
    expect(requests).toHaveLength(1)
  })

  it('opens nothing when the site refuses or the server issues no assertion', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(401)
      res.end('{}')
    }
    const refused = handoff()
    expect(await refused.h.open()).toMatchObject({ ok: false, code: 'EXCHANGE_FAILED' })
    expect(refused.opened).toEqual([])

    const noAssertion = handoff({
      assertion: async () => ({ ok: false, code: 'AUTH_REQUIRED', message: 'sign in' }),
    })
    expect(await noAssertion.h.open()).toMatchObject({ ok: false, code: 'AUTH_REQUIRED' })
    expect(noAssertion.opened).toEqual([])
    expect(requests).toHaveLength(1)
  })

  it('runs one handoff at a time', async () => {
    const assertion = vi.fn(async () => ({ ok: true as const, assertion: FAKE_ASSERTION, memberId: 'm1' }))
    const { h, opened } = handoff({ assertion })
    await Promise.all([h.open(), h.open(), h.open()])
    expect(assertion).toHaveBeenCalledTimes(1)
    expect(opened).toHaveLength(1)
  })

  it('refuses an invalid configured site before asking for anything', async () => {
    const assertion = vi.fn()
    const { h } = handoff({ assertion, siteUrl: () => 'http://example.test' })
    expect(await h.open()).toMatchObject({ ok: false, code: 'ORG_SITE_INVALID' })
    expect(assertion).not.toHaveBeenCalled()
  })
})
