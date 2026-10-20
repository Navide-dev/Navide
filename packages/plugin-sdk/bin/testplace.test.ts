import { createServer, type Server } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runTestplace } from './testplace.mjs'

type Seen = { method: string; path: string; authorization?: string; body: unknown }

const cli = join(process.cwd(), 'packages/plugin-sdk/bin/navide-plugin.mjs')
const token = 'nvp_' + 'testplace'
let server: Server
let registry = ''
let seen: Seen[] = []
let replies: Record<string, [number, unknown]> = {}
let configDir = ''
const savedEnv = { ...process.env }

beforeEach(async () => {
  seen = []
  replies = {}
  configDir = mkdtempSync(join(tmpdir(), 'navide-testplace-cli-'))
  process.env.NAVIDE_PLUGIN_CONFIG_DIR = configDir
  process.env.NAVIDE_PLUGIN_TOKEN = token
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      seen.push({ method: request.method ?? '', path, authorization: request.headers.authorization, body: raw ? JSON.parse(raw) : undefined })
      const [status, body] = replies[`${request.method} ${path}`] ?? [404, { detail: { code: 'NOT_FOUND', message: 'extension not found' } }]
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  registry = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterEach(async () => {
  process.env = { ...savedEnv }
  rmSync(configDir, { recursive: true, force: true })
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function run(args: string[]): Promise<string[]> {
  const lines: string[] = []
  await runTestplace([...args, '--registry', registry], { log: (line: string) => lines.push(line) })
  return lines
}

describe('navide-plugin testplace', () => {
  it('creates invites with the publish token and shows each join token once', async () => {
    replies['POST /api/testplace/acme/files/invites'] = [
      201,
      { invites: [{ id: 1, label: 'a@example.com', source: 'invite', state: 'pending', join_token: 'tpi_one' }] },
    ]
    const lines = await run(['invite', 'add', 'acme.files', 'a@example.com'])
    expect(seen).toEqual([
      { method: 'POST', path: '/api/testplace/acme/files/invites', authorization: `Bearer ${token}`, body: { labels: ['a@example.com'] } },
    ])
    expect(lines.join('\n')).toContain('tpi_one')
    expect(lines.join('\n')).toContain('shown only now')
  })

  it('creates a public code and says the first one waits for review', async () => {
    replies['POST /api/testplace/acme/files/codes'] = [201, { id: 3, state: 'in-review', max_testers: 50, testers: 0, code: 'tpc_x' }]
    const lines = await run(['code', 'create', 'acme.files', '--max-testers', '50'])
    expect(seen[0].body).toEqual({ max_testers: 50 })
    expect(lines.join('\n')).toContain('tpc_x')
    expect(lines.join('\n')).toContain('light review')
  })

  it('revokes and promotes a version', async () => {
    replies['POST /api/testplace/acme/files/versions/1.0.0/revoke'] = [200, { version: '1.0.0', targets: ['universal'], revoked: true }]
    replies['POST /api/testplace/acme/files/versions/1.0.0/promote'] = [200, { version: '1.0.0', targets: ['universal'], promotion_status: 'requested' }]
    await run(['revoke', 'acme.files', '1.0.0', '--reason', 'crash on start'])
    await run(['promote', 'acme.files', '1.0.0'])
    expect(seen.map((s) => [s.path, s.body])).toEqual([
      ['/api/testplace/acme/files/versions/1.0.0/revoke', { reason: 'crash on start' }],
      ['/api/testplace/acme/files/versions/1.0.0/promote', undefined],
    ])
  })

  it('reports the Registry error code', async () => {
    replies['POST /api/testplace/acme/files/invites'] = [409, { detail: { code: 'INVITE_LIMIT', message: 'an extension has at most 100 invites (100 in use)' } }]
    await expect(run(['invite', 'add', 'acme.files', 'x'])).rejects.toThrow('409 INVITE_LIMIT')
  })

  it('needs a token and sends nothing without one', async () => {
    delete process.env.NAVIDE_PLUGIN_TOKEN
    await expect(run(['invite', 'list', 'acme.files'])).rejects.toThrow('NAVIDE_PLUGIN_TOKEN')
    expect(seen).toEqual([])
  })

  it('rejects an unknown subcommand or a malformed id', async () => {
    await expect(run(['invite', 'nope', 'acme.files'])).rejects.toThrow('Usage')
    await expect(run(['invite', 'list', 'ACME'])).rejects.toThrow('namespace.name')
  })

  it('is reachable from the navide-plugin command', () => {
    const result = spawnSync(process.execPath, [cli, 'testplace'], { encoding: 'utf8', env: process.env })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('navide-plugin testplace invite add')
  })
})
