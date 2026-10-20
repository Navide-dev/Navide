import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// W4 of plan mcp-navide-0-2-27: status, whoami with NAVIDE_PLUGIN_TOKEN,
// publish --via-navide, scan, and validate with the Registry's manifest rules.

const roots: string[] = []
const cli = join(process.cwd(), 'packages/plugin-sdk/bin/navide-plugin.mjs')
const TOKEN = 'nvp_' + 'w4env'

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'navide-plugin-w4-'))
  roots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env })
}

/** spawn, not spawnSync: the fake Registry answers on this process's event loop. */
function runAsync(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function environment(directory: string, token: string | undefined): NodeJS.ProcessEnv {
  return { ...process.env, NAVIDE_PLUGIN_CONFIG_DIR: join(directory, 'config'), NAVIDE_PLUGIN_TOKEN: token ?? '' }
}

function writePackage(directory: string, manifest: object, files: Record<string, string>): void {
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), contents)
  }
  writeFileSync(join(directory, 'artifact-files.json'), `${JSON.stringify({ files: ['manifest.json', ...Object.keys(files)] })}\n`)
}

function frontendManifest(extra: object = {}) {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.todo-scout',
    name: 'TODO Scout',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'A W4 fixture.', license: 'MIT' },
    contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Scout', entry: 'frontend/main/index.html' }] },
    ...extra,
  }
}

type Route = (url: URL, authorization: string | undefined) => { status: number; body: unknown }

async function fakeRegistry(route: Route) {
  const requests: Array<{ url: URL; authorization?: string }> = []
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push({ url, authorization: request.headers.authorization })
    const { status, body } = route(url, request.headers.authorization)
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const notFound = { status: 404, body: { detail: 'Not Found' } }

describe('navide-plugin whoami reads the token publish would send', { timeout: 30_000 }, () => {
  it('asks the Registry who NAVIDE_PLUGIN_TOKEN belongs to, ahead of a stored login', async () => {
    const directory = root()
    const registry = await fakeRegistry((url, authorization) =>
      url.pathname === '/api/publisher/me' && authorization === `Bearer ${TOKEN}`
        ? { status: 200, body: { namespace: 'acme', display_name: 'Acme', qualification: 'approved', frozen: false, public_key_fingerprint: null, token_expires_at: null } }
        : notFound)
    try {
      mkdirSync(join(directory, 'config'))
      writeFileSync(join(directory, 'config', 'credentials.json'), JSON.stringify({
        [registry.url]: { token: 'nvp_' + 'stored', namespace: 'stored-namespace', expires_at: '2999-01-01T00:00:00' },
      }))
      const whoami = await runAsync(['whoami', '--registry', registry.url], directory, environment(directory, TOKEN))
      expect(whoami.status, whoami.stderr).toBe(0)
      expect(whoami.stdout).toContain(`acme on ${registry.url}; token from NAVIDE_PLUGIN_TOKEN does not expire`)
      expect(whoami.stdout).not.toContain('stored-namespace')

      // Without the env token the stored login answers offline, as before.
      const stored = await runAsync(['whoami', '--registry', registry.url], directory, environment(directory, undefined))
      expect(stored.status, stored.stderr).toBe(0)
      expect(stored.stdout).toContain(`stored-namespace on ${registry.url}; token expires`)
      expect(registry.requests).toHaveLength(1)
    } finally {
      await registry.close()
    }
  })

  it('shows the Registry error code for a rejected token', async () => {
    const directory = root()
    const registry = await fakeRegistry(() => ({ status: 401, body: { detail: { code: 'TOKEN_EXPIRED', message: 'publisher token expired' } } }))
    try {
      const whoami = await runAsync(['whoami', '--registry', registry.url], directory, environment(directory, TOKEN))
      expect(whoami.status).not.toBe(0)
      expect(whoami.stderr).toContain('refused (401 TOKEN_EXPIRED): publisher token expired')
    } finally {
      await registry.close()
    }
  })
})

describe('navide-plugin status', { timeout: 30_000 }, () => {
  const item = (version: string, extra: object) => ({
    namespace: 'acme', name: 'todo-scout', identity: 'acme.todo-scout', version, channel: 'stable', targets: ['universal'],
    status: 'approved', reason: null, yanked: false, submitted_at: `2026-10-${version.slice(-1).padStart(2, '1')}T00:00:00+00:00`,
    reviewed_at: null, scan_by_target: { universal: { risk: null, declared_vs_scanned: null } }, ...extra,
  })
  const items = [
    item('1.0.4', { status: 'pending' }),
    item('1.0.3', {
      status: 'approved',
      scan_by_target: { universal: { risk: 'high', declared_vs_scanned: { undeclared: [{ kind: 'shell', key: 'git push' }], declaredNotSeen: [] } } },
    }),
    item('1.0.2', { status: 'rejected', reason: 'The view loads a remote script.' }),
    item('1.0.1', { status: 'approved', yanked: true }),
  ]

  it('lists pending, approved, rejected with its reason, and yanked versions', async () => {
    const directory = root()
    const registry = await fakeRegistry((url, authorization) =>
      url.pathname === '/api/publisher/me/versions' && authorization === `Bearer ${TOKEN}`
        ? { status: 200, body: { namespace: 'acme', items } }
        : notFound)
    try {
      const status = await runAsync(['status', '--registry', registry.url], directory, environment(directory, TOKEN))
      expect(status.status, status.stderr).toBe(0)
      const lines = status.stdout.split('\n')
      expect(lines.find((line) => line.startsWith('acme.todo-scout@1.0.4 '))).toContain(' pending ')
      expect(status.stdout).toContain('waiting for review')
      expect(lines.find((line) => line.startsWith('acme.todo-scout@1.0.3 '))).toContain(' approved ')
      expect(status.stdout).toContain('universal: risk high; found but not declared: shell git push')
      expect(lines.find((line) => line.startsWith('acme.todo-scout@1.0.2 '))).toContain(' rejected ')
      expect(status.stdout).toContain('reason: The view loads a remote script.')
      expect(lines.find((line) => line.startsWith('acme.todo-scout@1.0.1 '))).toContain(' yanked ')

      const json = await runAsync(['status', 'acme.todo-scout@1.0.2', '--registry', registry.url, '--json'], directory, environment(directory, TOKEN))
      expect(json.status, json.stderr).toBe(0)
      expect(JSON.parse(json.stdout)).toEqual({ namespace: 'acme', items })
      const query = registry.requests[1].url.searchParams
      expect([query.get('extension'), query.get('version')]).toEqual(['acme.todo-scout', '1.0.2'])
    } finally {
      await registry.close()
    }
  })

  it('reports the qualification gate and a Registry without the endpoint', async () => {
    const directory = root()
    let answer = { status: 403, body: { detail: { code: 'QUALIFICATION_REQUIRED', message: 'developer qualification is not approved' } } } as { status: number; body: unknown }
    const registry = await fakeRegistry(() => answer)
    try {
      const gated = await runAsync(['status', '--registry', registry.url], directory, environment(directory, TOKEN))
      expect(gated.status).not.toBe(0)
      expect(gated.stderr).toContain('refused (403 QUALIFICATION_REQUIRED)')
      answer = notFound
      const old = await runAsync(['status', '--registry', registry.url], directory, environment(directory, TOKEN))
      expect(old.status).not.toBe(0)
      expect(old.stderr).toContain('does not offer /api/publisher/me/versions')
    } finally {
      await registry.close()
    }
  })

  it('needs a token and never sends one over plain http off loopback', () => {
    const directory = root()
    const missing = run(['status', '--registry', 'http://127.0.0.1:9'], directory, environment(directory, undefined))
    expect(missing.stderr).toContain('status needs NAVIDE_PLUGIN_TOKEN')
    const insecure = run(['status', '--registry', 'http://registry.example.test'], directory, environment(directory, TOKEN))
    expect(insecure.status).not.toBe(0)
    expect(insecure.stderr).toContain('refusing to send a publish token')
  })
})

describe('navide-plugin publish --via-navide', { timeout: 30_000 }, () => {
  it('hands the package to Navide by link and never reads or writes a token', () => {
    const directory = join(root(), 'a b')
    mkdirSync(directory)
    writePackage(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
    const env = environment(directory, TOKEN)
    expect(run(['package', directory, '--out', 'x-1.0.0-universal.vsix'], directory, env).status).toBe(0)
    const handed = run(['publish', 'x-1.0.0-universal.vsix', '--via-navide', '--target', 'universal', '--no-browser'], directory, env)
    expect(handed.status, handed.stderr).toBe(0)
    const path = realpathSync(join(directory, 'x-1.0.0-universal.vsix'))
    expect(handed.stdout).toContain(`navide://publish?path=${encodeURIComponent(path)}&target=universal`)
    expect(handed.stdout).not.toContain(TOKEN)
    expect(existsSync(join(directory, 'config'))).toBe(false)

    // The fixture agreed with the App's deep-link parser.
    expect(`navide://publish?path=${encodeURIComponent('/tmp/a b/x-1.0.0-universal.vsix')}&target=darwin-arm64`)
      .toBe('navide://publish?path=%2Ftmp%2Fa%20b%2Fx-1.0.0-universal.vsix&target=darwin-arm64')
  })

  it('refuses options that belong to a direct upload, and anything but a .vsix', () => {
    const directory = root()
    writePackage(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
    const env = environment(directory, undefined)
    expect(run(['package', directory, '--out', 'f.vsix'], directory, env).status).toBe(0)
    for (const extra of [['--registry', 'http://127.0.0.1:9'], ['--token', 'nvp_' + 'x'], ['--signature', 'f.sig'], ['--insecure-http']]) {
      const refused = run(['publish', 'f.vsix', '--via-navide', ...extra], directory, env)
      expect(refused.status).not.toBe(0)
      expect(refused.stderr).toContain(`--via-navide cannot be combined with ${extra[0]}`)
    }
    const notVsix = run(['publish', 'manifest.json', '--via-navide', '--no-browser'], directory, env)
    expect(notVsix.stderr).toContain('--via-navide hands over a .vsix package')
    expect(run(['publish', 'f.vsix', '--no-browser'], directory, env).stderr).toContain('--no-browser applies to publish --via-navide only')
  })
})

describe('navide-plugin scan', { timeout: 30_000 }, () => {
  it('reports what the Registry scan finds and what the manifest does not declare', () => {
    const directory = root()
    writePackage(directory, frontendManifest(), {
      'frontend/main/index.html': '<!doctype html><script src="app.js"></script>',
      'frontend/main/app.js': "invoke('shell.run', { command: 'git push origin main' }); fetch('https://api.example.com/v1')",
    })
    const env = environment(directory, undefined)
    const scanned = run(['scan', directory], directory, env)
    expect(scanned.status, scanned.stderr).toBe(0)
    expect(scanned.stdout).toContain('shell: git push [remoteWrite, frontend]')
    expect(scanned.stdout).toContain('network hosts: api.example.com')
    expect(scanned.stdout).toContain('Found but not declared in the manifest')
    expect(scanned.stdout).toContain('  shell: git push')

    // The directory scans exactly as the .vsix `package` builds from it.
    expect(run(['package', directory, '--out', 'f.vsix'], directory, env).status).toBe(0)
    const fromDirectory = JSON.parse(run(['scan', directory, '--json'], directory, env).stdout)
    const fromPackage = JSON.parse(run(['scan', 'f.vsix', '--json'], directory, env).stdout)
    delete fromDirectory.report.scannedAt
    delete fromPackage.report.scannedAt
    expect(fromPackage).toEqual(fromDirectory)
    expect(fromPackage.declaredVsScanned.undeclared).toEqual([{ kind: 'shell', key: 'git push' }, { kind: 'shell', key: 'shell.run' }])
  })
})

describe('navide-plugin validate uses the Registry manifest rules', { timeout: 30_000 }, () => {
  function backendManifest(agentTools: object[]) {
    return {
      ...frontendManifest(),
      backend: { entry: 'backend/scout', protocolVersion: 1, activation: 'startup', methods: ['scout.list'], agentTools },
    }
  }
  const tool = (name: string, method = 'scout.list') => ({
    name, method, risk: 'read', title: 'List TODOs', description: 'List the TODOs.', inputSchema: { type: 'object' },
  })

  it('names the agent tool prefix the id derives', () => {
    const directory = root()
    writePackage(directory, backendManifest([tool('scout_list'), tool('todoscout_find', 'scout.find')]), {})
    const validated = run(['validate', directory], directory, environment(directory, undefined))
    expect(validated.status).not.toBe(0)
    expect(validated.stderr).toContain(
      `manifest backend.agentTools[0].name "scout_list" must start with 'todoscout_', the prefix Navide derives from id "acme.todo-scout"`,
    )
    expect(validated.stderr).toContain('[AGENT_TOOL_PREFIX_MISMATCH]')
    expect(validated.stderr).toContain('manifest backend.agentTools[1].method "scout.find" is not listed in backend.methods (declared: scout.list)')
  })

  it('names the allowed values and a file missing from artifact-files.json', () => {
    const directory = root()
    writePackage(directory, frontendManifest({ permissions: { system: ['network'] } }), { 'frontend/main/index.html': '<!doctype html>' })
    const env = environment(directory, undefined)
    expect(run(['validate', directory], directory, env).stderr).toContain('unknown namespace "network"; allowed: fs, ui, aiCli')

    writePackage(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
    writeFileSync(join(directory, 'artifact-files.json'), `${JSON.stringify({ files: ['manifest.json'] })}\n`)
    const unlisted = run(['validate', directory], directory, env)
    expect(unlisted.stderr).toContain("manifest references 'frontend/main/index.html', but artifact-files.json does not list it")
    expect(readFileSync(join(directory, 'frontend/main/index.html'), 'utf8')).toBe('<!doctype html>')
  })
})
