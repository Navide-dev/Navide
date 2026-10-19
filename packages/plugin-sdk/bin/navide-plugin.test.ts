import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginViewRuntimeClient } from '../src/index'
import { readZipEntries } from '../../../src/main/plugins/pluginPackage'

const roots: string[] = []
const cli = join(process.cwd(), 'packages/plugin-sdk/bin/navide-plugin.mjs')
const target = `${process.platform}-${process.arch}`

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'navide-plugin-sdk-cli-'))
  roots.push(directory)
  return directory
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env })
}

function frontendManifest() {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.frontend',
    name: 'Frontend',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'A frontend fixture.', license: 'MIT' },
    contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Frontend', entry: 'frontend/main/index.html' }] },
  }
}

function backendManifest() {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.backend',
    name: 'Backend',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'A backend fixture.', license: 'MIT' },
    backend: { entry: 'backend/acme-backend', protocolVersion: 1, activation: 'startup' },
  }
}

function targetBinary(): Buffer {
  if (process.platform === 'linux') {
    const binary = Buffer.alloc(20)
    binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    binary.writeUInt16LE(process.arch === 'x64' ? 62 : 183, 18)
    return binary
  }
  if (process.platform === 'win32') {
    const binary = Buffer.alloc(0x86)
    binary.write('MZ')
    binary.writeUInt32LE(0x80, 0x3c)
    binary.write('PE\0\0', 0x80)
    binary.writeUInt16LE(process.arch === 'x64' ? 0x8664 : 0xaa64, 0x84)
    return binary
  }
  const binary = Buffer.alloc(8)
  binary.writeUInt32LE(0xfeedfacf, 0)
  binary.writeUInt32LE(process.arch === 'x64' ? 0x01000007 : 0x0100000c, 4)
  return binary
}

function packageDirectory(directory: string, manifest: object, files: Record<string, Buffer | string>): void {
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(directory, path)
    const parent = fullPath.slice(0, fullPath.lastIndexOf('/'))
    if (parent) mkdirSync(parent, { recursive: true })
    writeFileSync(fullPath, contents)
  }
  writeFileSync(
    join(directory, 'artifact-files.json'),
    `${JSON.stringify({ files: ['manifest.json', ...Object.keys(files)] })}\n`,
  )
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// Every CLI command is its own Node process, several per test: the cost is
// process startup, which stretches with machine load, not a race.
describe('navide-plugin canonical artifacts', { timeout: 30_000 }, () => {
  it('packages a deterministic frontend-only archive from its explicit file list', () => {
    const directory = root()
    packageDirectory(directory, frontendManifest(), {
      'frontend/main/index.html': '<!doctype html>',
      'frontend/main/app.js': 'console.log(1)',
    })
    const first = join(directory, 'first.vsix')
    const second = join(directory, 'second.vsix')
    expect(run(['package', directory, '--out', first], directory).status).toBe(0)
    expect(run(['package', directory, '--out', second], directory).status).toBe(0)
    expect(readFileSync(first)).toEqual(readFileSync(second))
    expect(readZipEntries(readFileSync(first)).map((entry) => entry.path)).toEqual([
      'frontend/main/app.js', 'frontend/main/index.html', 'manifest.json',
    ])
  })

  it('requires one native backend executable and its exact build-host target', () => {
    const directory = root()
    const backendPath = process.platform === 'win32' ? 'backend/acme-backend.exe' : 'backend/acme-backend'
    packageDirectory(directory, backendManifest(), { [backendPath]: targetBinary() })
    chmodSync(join(directory, backendPath), 0o755)
    expect(run(['package', directory, '--target', 'universal'], directory).status).not.toBe(0)
    const archive = join(directory, 'backend.vsix')
    const packaged = run(['package', directory, '--target', target, '--out', archive], directory)
    expect(packaged.status, packaged.stderr).toBe(0)
    const backend = readZipEntries(readFileSync(archive)).find((entry) => entry.path === backendPath)
    expect(backend?.executable).toBe(true)
  })

  it('signs and verifies the complete archive digest with an ephemeral key', () => {
    const directory = root()
    packageDirectory(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
    const archive = join(directory, 'frontend.vsix')
    expect(run(['package', directory, '--out', archive], directory).status).toBe(0)
    const keys = generateKeyPairSync('ed25519')
    const privateKey = join(directory, 'private.pem')
    const publicKey = join(directory, 'public.pem')
    writeFileSync(privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    chmodSync(privateKey, 0o600)
    writeFileSync(publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }))
    const signature = join(directory, 'frontend.sig')
    expect(run(['sign', archive, '--key', privateKey, '--out', signature], directory).status).toBe(0)
    expect(run(['verify', archive, '--key', publicKey, '--signature', signature], directory).status).toBe(0)
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('tampered')]))
    expect(run(['verify', archive, '--key', publicKey, '--signature', signature], directory).status).not.toBe(0)
  })

  // NTFS reports 0o666 for every file, so the owner-only bits exist only on a POSIX fs.
  it.skipIf(process.platform === 'win32')('refuses to sign with a private key other users can read', () => {
    const directory = root()
    packageDirectory(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
    const archive = join(directory, 'frontend.vsix')
    expect(run(['package', directory, '--out', archive], directory).status).toBe(0)
    const privateKey = join(directory, 'private.pem')
    writeFileSync(privateKey, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
    chmodSync(privateKey, 0o644)
    const signed = run(['sign', archive, '--key', privateKey, '--out', join(directory, 'frontend.sig')], directory)
    expect(signed.status).not.toBe(0)
    expect(signed.stderr).toContain('private key must have owner-only permissions')
  })

  it('rejects source-only files and duplicate file-list keys', () => {
    const directory = root()
    packageDirectory(directory, frontendManifest(), {
      'frontend/main/index.html': '<!doctype html>',
      'frontend/main/source.ts': 'export {}',
    })
    expect(run(['validate', directory], directory).status).not.toBe(0)
    writeFileSync(join(directory, 'artifact-files.json'), '{"files":["manifest.json"],"files":["manifest.json"]}\n')
    expect(run(['validate', directory], directory).status).not.toBe(0)
  })

  it('admits a manifest-declared detail target schema outside the frontend/assets/backend roots', () => {
    const manifest = frontendManifest() as {
      contributes: { views: Array<{ id: string; kind: string; location: string; title: string; entry: string; targetSchema?: string }> }
    }
    manifest.contributes.views = [
      ...manifest.contributes.views,
      {
        id: 'detail',
        kind: 'custom',
        location: 'detail',
        title: 'Detail',
        entry: 'frontend/detail/index.html',
        targetSchema: 'schemas/detail-target.json',
      },
    ]
    const accepted = root()
    packageDirectory(accepted, manifest, {
      'frontend/main/index.html': '<!doctype html>',
      'frontend/detail/index.html': '<!doctype html>',
      'schemas/detail-target.json': '{"type":"object"}',
    })
    const validated = run(['validate', accepted], accepted)
    expect(validated.status, validated.stderr).toBe(0)

    // An undeclared file in the same directory is still outside the boundary.
    const rejected = root()
    packageDirectory(rejected, manifest, {
      'frontend/main/index.html': '<!doctype html>',
      'frontend/detail/index.html': '<!doctype html>',
      'schemas/detail-target.json': '{"type":"object"}',
      'schemas/undeclared.json': '{"type":"object"}',
    })
    expect(run(['validate', rejected], rejected).status).not.toBe(0)
  })
})

function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** A stand-in Registry: /api/cli/token checks the PKCE pair the CLI sent to
 *  /cli/authorize, /api/publish records the upload. */
async function fakeRegistry(publishResponse = '{"review_status":"pending"}') {
  const uploads: Array<{ url: URL; authorization?: string; body: Buffer }> = []
  let challenge = ''
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const raw = await body(request)
    if (url.pathname === '/api/cli/token') {
      const { code, code_verifier: verifier } = JSON.parse(raw.toString('utf8'))
      const ok = code === 'one-time-code' && createHash('sha256').update(verifier).digest('base64url') === challenge
      response.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(ok ? { token: 'nvp_test', namespace: 'acme', expires_at: '2999-01-01T00:00:00+00:00' } : { detail: 'bad code' }))
      return
    }
    if (url.pathname === '/api/publish') {
      uploads.push({ url, authorization: request.headers.authorization, body: raw })
      response.writeHead(201, { 'Content-Type': 'application/json' })
      response.end(publishResponse)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  return {
    url,
    uploads,
    setChallenge: (value: string) => {
      challenge = value
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Run `login --no-browser` and play the browser: read the authorize URL it
 *  prints, then follow the Registry's redirect to its loopback callback. */
async function loginThroughBrowser(
  registry: Awaited<ReturnType<typeof fakeRegistry>>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  callback: (authorize: URL) => Record<string, string>,
  beforeCallback?: (port: string | null, query: URLSearchParams) => Promise<void>,
) {
  const child = spawn(process.execPath, [cli, 'login', '--registry', registry.url, '--no-browser'], { cwd, env })
  // Listen before the callback: on a refused callback the CLI exits as soon as it
  // has answered, and a 'close' emitted before the fetch settles would be lost.
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  // A CLI that exits before printing the URL fails the test now, not at its timeout.
  const authorize = await new Promise<URL>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const match = /Opening (\S+)/.exec(stdout)
      if (match) resolve(new URL(match[1]))
    })
    void closed.then((code) => reject(new Error(`login exited (${code}) before printing the authorize URL: ${stderr}`)))
  })
  registry.setChallenge(authorize.searchParams.get('code_challenge') ?? '')
  const port = authorize.searchParams.get('port')
  if (beforeCallback) await beforeCallback(port, new URLSearchParams(callback(authorize)))
  // The CLI may exit as soon as it has answered, so its exit also ends this wait;
  // a failed request while it is still running fails the test with its stderr.
  await new Promise<void>((resolve, reject) => {
    fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams(callback(authorize))}`).then(
      () => resolve(),
      (error: unknown) => reject(new Error(`login callback request failed (${String(error)}): ${stderr}`)),
    )
    void closed.then(() => resolve())
  })
  const status = await closed
  return { status, stdout, stderr }
}

describe('navide-plugin developer workflow', { timeout: 30_000 }, () => {
  it('scaffolds a plugin that validates and packages without a build step', () => {
    const directory = root()
    const created = run(['init', 'hello', '--id', 'acme.hello-world'], directory)
    expect(created.status, created.stderr).toBe(0)
    const manifest = JSON.parse(readFileSync(join(directory, 'hello', 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ schemaVersion: 2, id: 'acme.hello-world', publisher: 'acme', name: 'Hello World' })
    expect(run(['validate', 'hello'], directory).status).toBe(0)
    const packaged = run(['package', 'hello'], directory)
    expect(packaged.status, packaged.stderr).toBe(0)
    const archive = join(directory, 'acme.hello-world-0.1.0-universal.vsix')
    expect(readZipEntries(readFileSync(archive)).map((entry) => entry.path)).toEqual([
      'README.md', 'frontend/main/index.html', 'frontend/main/main.js', 'manifest.json',
    ])
    expect(run(['init', 'hello', '--id', 'acme.other'], directory).status).not.toBe(0)
    expect(run(['init', 'bad', '--id', 'NoNamespace'], directory).status).not.toBe(0)
  })

  it('scaffolds a view that sends the same readiness handshake as the SDK', () => {
    // A stub of the preload bridge the SDK's runtime client requires; every call is recorded.
    const bridge = (calls: string[]) => ({
      ready: () => calls.push('ready'),
      onOpenTarget: () => () => undefined,
    })
    const sdkCalls: string[] = []
    const previous = (globalThis as { nav?: unknown }).nav
    ;(globalThis as { nav?: unknown }).nav = bridge(sdkCalls)
    try {
      createPluginViewRuntimeClient().ready()
    } finally {
      ;(globalThis as { nav?: unknown }).nav = previous
    }

    const directory = root()
    expect(run(['init', 'hello', '--id', 'acme.hello-world'], directory).status).toBe(0)
    const html = readFileSync(join(directory, 'hello', 'frontend/main/index.html'), 'utf8')
    expect(html).toContain('<script src="./main.js"></script>')
    const scaffoldCalls: string[] = []
    const status = { textContent: '' }
    const context: Record<string, unknown> = {
      nav: bridge(scaffoldCalls),
      document: { getElementById: (id: string) => (id === 'status' ? status : null) },
    }
    context.window = context
    context.globalThis = context
    runInNewContext(readFileSync(join(directory, 'hello', 'frontend/main/main.js'), 'utf8'), context)
    expect(status.textContent).not.toBe('')
    expect(scaffoldCalls).toEqual(['ready'])
    expect(scaffoldCalls).toEqual(sdkCalls)
  })

  it('generates an owner-only keypair that signs, and never overwrites a key', () => {
    const directory = root()
    expect(run(['keygen', '--out-dir', 'keys', '--name', 'acme'], directory).status).toBe(0)
    const privateKey = join(directory, 'keys', 'acme.key')
    if (process.platform !== 'win32') expect(statSync(privateKey).mode & 0o777).toBe(0o600)
    const before = readFileSync(privateKey)
    expect(run(['keygen', '--out-dir', 'keys', '--name', 'acme'], directory).status).not.toBe(0)
    expect(readFileSync(privateKey)).toEqual(before)
    packageDirectory(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
    expect(run(['package', directory, '--out', 'f.vsix'], directory).status).toBe(0)
    expect(run(['sign', 'f.vsix', '--key', 'keys/acme.key'], directory).status).toBe(0)
    expect(run(['verify', 'f.vsix', '--key', 'keys/acme.pub', '--signature', 'f.vsix.sig'], directory).status).toBe(0)
  })

  it('logs in through the loopback redirect, publishes with the stored token, and logs out', async () => {
    const directory = root()
    const env = { ...process.env, NAVIDE_PLUGIN_CONFIG_DIR: join(directory, 'config'), NAVIDE_PLUGIN_TOKEN: '' }
    const registry = await fakeRegistry()
    try {
      const login = await loginThroughBrowser(registry, directory, env, (authorize) => ({
        code: 'one-time-code',
        state: authorize.searchParams.get('state') ?? '',
      }))
      expect(login.status, login.stderr).toBe(0)
      const credentials = join(directory, 'config', 'credentials.json')
      if (process.platform !== 'win32') expect(statSync(credentials).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(credentials, 'utf8'))[registry.url]).toMatchObject({ token: 'nvp_test', namespace: 'acme' })
      const whoami = run(['whoami', '--registry', registry.url], directory, env)
      expect(whoami.stdout).toContain('acme on')

      packageDirectory(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
      expect(run(['package', directory, '--out', 'f.vsix'], directory).status).toBe(0)
      writeFileSync(join(directory, 'f.sig'), 'c2lnbmF0dXJl\n')
      const published = spawn(process.execPath, [cli, 'publish', 'f.vsix', '--registry', registry.url, '--signature', 'f.sig'], { cwd: directory, env })
      expect(await new Promise((resolve) => published.on('close', resolve))).toBe(0)
      expect(registry.uploads).toHaveLength(1)
      const [upload] = registry.uploads
      expect(upload.authorization).toBe('Bearer nvp_test')
      expect(upload.url.searchParams.get('target')).toBe('universal')
      expect(upload.url.searchParams.get('signature')).toBe('c2lnbmF0dXJl')
      expect(upload.body.includes(readFileSync(join(directory, 'f.vsix')))).toBe(true)

      expect(run(['logout', '--registry', registry.url], directory, env).status).toBe(0)
      expect(run(['whoami', '--registry', registry.url], directory, env).status).not.toBe(0)
    } finally {
      await registry.close()
    }
  })

  it('refuses a callback whose state does not match and stores nothing', async () => {
    const directory = root()
    const env = { ...process.env, NAVIDE_PLUGIN_CONFIG_DIR: join(directory, 'config') }
    const registry = await fakeRegistry()
    try {
      const login = await loginThroughBrowser(registry, directory, env, () => ({ code: 'one-time-code', state: 'forged-state-value' }))
      expect(login.status).not.toBe(0)
      expect(login.stderr).toContain('state mismatch')
      expect(existsSync(join(directory, 'config', 'credentials.json'))).toBe(false)
    } finally {
      await registry.close()
    }
  })

  it('reads the naive UTC expiry the Registry stores, whatever the local time zone', () => {
    const directory = root()
    // East of UTC, a naive timestamp read as local time lands hours early.
    const env = { ...process.env, NAVIDE_PLUGIN_CONFIG_DIR: join(directory, 'config'), TZ: 'Asia/Taipei' }
    mkdirSync(join(directory, 'config'))
    const registry = 'http://127.0.0.1:9'
    const store = (offsetMs: number) => writeFileSync(
      join(directory, 'config', 'credentials.json'),
      JSON.stringify({ [registry]: { token: 'nvp_t', namespace: 'acme', expires_at: new Date(Date.now() + offsetMs).toISOString().replace('Z', '') } }),
    )
    store(60_000)
    const valid = run(['whoami', '--registry', registry], directory, env)
    expect(valid.status, valid.stdout).toBe(0)
    expect(valid.stdout).toContain('token expires')
    store(-60_000)
    const expired = run(['whoami', '--registry', registry], directory, env)
    expect(expired.status).not.toBe(0)
    expect(expired.stdout).toContain('token expired')
  })

  it('says what a pre-release publish means (K5)', async () => {
    const directory = root()
    const env = { ...process.env, NAVIDE_PLUGIN_CONFIG_DIR: join(directory, 'config'), NAVIDE_PLUGIN_TOKEN: 'nvp_env' }
    packageDirectory(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
    expect(run(['package', directory, '--out', 'f.vsix'], directory).status).toBe(0)
    const hint = 'public to everyone who turns on Get pre-releases'
    for (const [version, shown] of [['1.1.0-beta.1', true], ['1.1.0', false], ['1.1.0+build.7', false]] as const) {
      const registry = await fakeRegistry(JSON.stringify({ version, review_status: 'pending' }))
      try {
        const child = spawn(process.execPath, [cli, 'publish', 'f.vsix', '--registry', registry.url], { cwd: directory, env })
        let stdout = ''
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
        })
        expect(await new Promise((resolve) => child.on('close', resolve))).toBe(0)
        expect(stdout.includes(hint), `${version}: ${stdout}`).toBe(shown)
        if (shown) expect(stdout).toContain('wait for Testplace (Navide 0.2.27)')
      } finally {
        await registry.close()
      }
    }
  })

  it('warns that --token is visible to other processes', async () => {
    const directory = root()
    const env = { ...process.env, NAVIDE_PLUGIN_CONFIG_DIR: join(directory, 'config') }
    const registry = await fakeRegistry()
    try {
      packageDirectory(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
      expect(run(['package', directory, '--out', 'f.vsix'], directory).status).toBe(0)
      const child = spawn(process.execPath, [cli, 'publish', 'f.vsix', '--registry', registry.url, '--token', 'nvp_argv'], { cwd: directory, env })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      expect(await new Promise((resolve) => child.on('close', resolve))).toBe(0)
      expect(stderr).toContain('--token is visible in the process list')
      expect(stderr).toContain('NAVIDE_PLUGIN_TOKEN')
      expect(registry.uploads[0].authorization).toBe('Bearer nvp_argv')
    } finally {
      await registry.close()
    }
  })

  it('refuses a plain-http registry off loopback unless --insecure-http is given', async () => {
    const directory = root()
    const env = { ...process.env, NAVIDE_PLUGIN_CONFIG_DIR: join(directory, 'config'), NAVIDE_PLUGIN_TOKEN: 'nvp_env' }
    packageDirectory(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
    expect(run(['package', directory, '--out', 'f.vsix'], directory).status).toBe(0)
    for (const args of [['publish', 'f.vsix'], ['login', '--no-browser']]) {
      const refused = run([...args, '--registry', 'http://registry.example.test'], directory, env)
      expect(refused.status).not.toBe(0)
      expect(refused.stderr).toContain('refusing to send a publish token to http://registry.example.test over plain http')
    }
    const registry = await fakeRegistry()
    try {
      // 0.0.0.0 reaches this machine's listener without being a loopback name.
      const insecure = registry.url.replace('127.0.0.1', '0.0.0.0')
      const child = spawn(process.execPath, [cli, 'publish', 'f.vsix', '--registry', insecure, '--insecure-http'], { cwd: directory, env })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      const status = await new Promise((resolve) => child.on('close', resolve))
      expect(stderr).toContain(`--insecure-http sends the publish token to ${insecure} unencrypted`)
      if (process.platform !== 'win32') {
        expect(status, stderr).toBe(0)
        expect(registry.uploads[0].authorization).toBe('Bearer nvp_env')
      }
    } finally {
      await registry.close()
    }
  })

  it('answers 400 to a login callback whose Host is not the loopback address', async () => {
    const directory = root()
    const env = { ...process.env, NAVIDE_PLUGIN_CONFIG_DIR: join(directory, 'config') }
    const registry = await fakeRegistry()
    try {
      const login = await loginThroughBrowser(registry, directory, env, (authorize) => ({
        code: 'one-time-code',
        state: authorize.searchParams.get('state') ?? '',
      }), async (port, query) => {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const request = httpRequest(
            { host: '127.0.0.1', port, path: `/callback?${query}`, headers: { Host: `attacker.example:${port}` } },
            (response) => {
              response.resume()
              resolve(response.statusCode)
            },
          )
          request.on('error', reject)
          request.end()
        })
        expect(status).toBe(400)
      })
      // The rejected request did not consume the callback; the real one still logs in.
      expect(login.status, login.stderr).toBe(0)
    } finally {
      await registry.close()
    }
  })

  it('refuses to publish without a token', () => {
    const directory = root()
    const env = { ...process.env, NAVIDE_PLUGIN_CONFIG_DIR: join(directory, 'config'), NAVIDE_PLUGIN_TOKEN: '' }
    packageDirectory(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
    expect(run(['package', directory, '--out', 'f.vsix'], directory).status).toBe(0)
    const published = run(['publish', 'f.vsix', '--registry', 'http://127.0.0.1:9'], directory, env)
    expect(published.status).not.toBe(0)
    expect(published.stderr).toContain('publish needs NAVIDE_PLUGIN_TOKEN')
  })
})
