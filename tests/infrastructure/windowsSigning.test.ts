import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  codeSignToolArgs, commonName, filesToVerify, PROVIDERS, redact, resolveSigning, signatureProblems,
} from '../../scripts/windows-signing.mjs'

type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> }
type Job = { steps: Step[] }

const script = resolve('scripts/windows-signing.mjs')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'windows-signing-'))
  roots.push(dir)
  return dir
}

// Fake values only, assembled at runtime; nothing here is a real credential.
function fakeEnv(): Record<string, string> {
  const env: Record<string, string> = { WINDOWS_SIGNING: 'esigner' }
  for (const name of [...PROVIDERS.esigner.variables, ...PROVIDERS.esigner.secrets]) env[name] = `fake-${name.toLowerCase()}-${process.pid}`
  env.WINDOWS_PUBLISHER_NAME = 'CN=Example Publisher, O=Example Publisher, C=TW'
  return env
}

describe('resolveSigning', () => {
  it('is off when the switch is unset or blank, whatever else is present', () => {
    expect(resolveSigning({})).toEqual({ enabled: false })
    expect(resolveSigning({ ...fakeEnv(), WINDOWS_SIGNING: '  ' })).toEqual({ enabled: false })
  })

  it('is on only when every variable and secret of the provider is set', () => {
    expect(resolveSigning(fakeEnv())).toEqual({ enabled: true, provider: 'esigner' })
    const env = fakeEnv()
    delete env.ES_TOTP_SECRET
    env.CODESIGNTOOL_SHA256 = ''
    expect(() => resolveSigning(env)).toThrow('these are not set: CODESIGNTOOL_SHA256, ES_TOTP_SECRET')
  })

  it('refuses an unknown provider instead of building unsigned', () => {
    expect(() => resolveSigning({ WINDOWS_SIGNING: 'azure' })).toThrow('not a known provider')
  })
})

describe('CodeSignTool invocation', () => {
  it('signs the file in place with each credential as its own argv entry', () => {
    const env = fakeEnv()
    const args = codeSignToolArgs('C:\\t\\jar\\code_sign_tool.jar', 'C:\\out\\Navide.exe', env)
    expect(args.slice(0, 3)).toEqual(['-jar', 'C:\\t\\jar\\code_sign_tool.jar', 'sign'])
    expect(args).toContain(`-password=${env.ES_PASSWORD}`)
    expect(args).toContain('-input_file_path=C:\\out\\Navide.exe')
    expect(args.at(-1)).toBe('-override')
  })

  it('redacts every secret from tool output', () => {
    const env = fakeEnv()
    const text = `user ${env.ES_USERNAME} pw ${env.ES_PASSWORD} totp ${env.ES_TOTP_SECRET} id ${env.ES_CREDENTIAL_ID}`
    const out = redact(text, env)
    for (const name of PROVIDERS.esigner.secrets) expect(out).not.toContain(env[name])
    expect(out).toBe('user *** pw *** totp *** id ***')
  })
})

describe('signature checks', () => {
  it('reads the CN out of plain and quoted subjects', () => {
    expect(commonName('CN=Example Publisher, O=Example Publisher, C=TW')).toBe('Example Publisher')
    expect(commonName('O=X, CN="Example, Inc.", C=US')).toBe('Example, Inc.')
    expect(commonName('Example Publisher')).toBeNull()
  })

  it('flags unsigned, broken and foreign-signed files and passes the rest', () => {
    const publisher = 'CN=Example Publisher, O=Example Publisher, C=TW'
    const problems = signatureProblems([
      { Path: 'a.exe', Status: 'Valid', Subject: 'CN=Example Publisher, O=Example Publisher, L=Taipei, C=TW' },
      { Path: 'b.exe', Status: 'NotSigned', Subject: '' },
      { Path: 'c.exe', Status: 'HashMismatch', Subject: 'CN=Example Publisher' },
      { Path: 'd.exe', Status: 'Valid', Subject: 'CN=Someone Else' },
    ], publisher)
    expect(problems).toEqual([
      'b.exe: signature status NotSigned',
      'c.exe: signature status HashMismatch',
      'd.exe: signed by "CN=Someone Else", expected CN=Example Publisher',
    ])
    // A bare name works as the expected publisher too.
    expect(signatureProblems([{ Path: 'a.exe', Status: 'Valid', Subject: 'CN=Example Publisher' }], 'Example Publisher')).toEqual([])
  })

  it('checks the installers and every packaged .exe, nothing else', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'Navide-1.0.0-win-x64.exe'), '')
    writeFileSync(join(dir, 'Navide-1.0.0-win-x64.exe.blockmap'), '')
    writeFileSync(join(dir, 'latest.yml'), '')
    mkdirSync(join(dir, 'win-unpacked', 'resources', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'win-unpacked', 'Navide.exe'), '')
    writeFileSync(join(dir, 'win-unpacked', 'resources', 'bin', 'navide-hello.EXE'), '')
    writeFileSync(join(dir, 'win-unpacked', 'resources', 'app.asar'), '')
    expect(filesToVerify(dir)).toEqual([
      join(dir, 'Navide-1.0.0-win-x64.exe'),
      join(dir, 'win-unpacked', 'Navide.exe'),
      join(dir, 'win-unpacked', 'resources', 'bin', 'navide-hello.EXE'),
    ])
  })
})

describe('windows-signing resolve CLI', () => {
  function runResolve(env: Record<string, string>) {
    const output = join(tempDir(), 'github-output')
    writeFileSync(output, '')
    const run = spawnSync(process.execPath, [script, 'resolve'], {
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, ...env }, encoding: 'utf8',
    })
    return { ...run, output: readFileSync(output, 'utf8') }
  }

  it('writes enabled=false and succeeds with no switch, warning when secrets are set anyway', () => {
    const off = runResolve({})
    expect(off.status).toBe(0)
    expect(off.output).toBe('enabled=false\n')
    const { WINDOWS_SIGNING: _, ...secretsOnly } = fakeEnv()
    const warned = runResolve(secretsOnly)
    expect(warned.status).toBe(0)
    expect(warned.output).toBe('enabled=false\n')
    expect(warned.stdout).toContain('::warning::')
  })

  it('fails the job when the switch is on but incomplete, without echoing any value', () => {
    const env = fakeEnv()
    delete env.ES_PASSWORD
    const run = runResolve(env)
    expect(run.status).toBe(1)
    expect(run.output).toBe('')
    expect(run.stderr).toContain('ES_PASSWORD')
    for (const name of PROVIDERS.esigner.secrets) if (env[name]) expect(run.stderr + run.stdout).not.toContain(env[name])
  })

  it('writes enabled=true when complete', () => {
    const run = runResolve(fakeEnv())
    expect(run.status).toBe(0)
    expect(run.output).toBe('enabled=true\n')
  })
})

describe('release workflow signing switch', () => {
  const jobs = (parse(readFileSync('.github/workflows/release.yml', 'utf8')) as { jobs: Record<string, Job> }).jobs
  const windows = { x64: jobs['release-windows-x64'], arm64: jobs['release-windows-arm64'] }

  it('keeps the unsigned electron-builder call unchanged when the switch is off', () => {
    for (const [arch, job] of Object.entries(windows)) {
      const build = job.steps.find((step) => step.name === 'Build application')!
      const lines = build.run!.split('\n').map((line) => line.trim())
      const elseAt = lines.indexOf('else')
      expect(lines[elseAt + 1]).toBe(`node node_modules/electron-builder/cli.js --win --${arch} --publish never`)
      expect(lines[elseAt + 2]).toBe('fi')
      expect(build.run).toContain('-c.win.forceCodeSigning=true')
      expect(build.env!.WINDOWS_SIGNING_ENABLED).toBe('${{ steps.signing.outputs.enabled }}')
      // No credential reaches an unsigned build.
      for (const name of PROVIDERS.esigner.secrets) {
        expect(build.env![name]).toBe(`\${{ steps.signing.outputs.enabled == 'true' && secrets.${name} || '' }}`)
      }
    }
  })

  it('resolves before building and verifies before anything is uploaded', () => {
    for (const job of Object.values(windows)) {
      const names = job.steps.map((step) => step.name)
      const at = (name: string) => names.indexOf(name)
      const resolveStep = job.steps[at('Resolve Windows signing')]
      expect(resolveStep.id).toBe('signing')
      expect(resolveStep.run).toBe('node scripts/windows-signing.mjs resolve')
      expect(at('Resolve Windows signing')).toBeLessThan(at('Install CodeSignTool'))
      expect(at('Install CodeSignTool')).toBeLessThan(at('Build application'))
      expect(at('Build application')).toBeLessThan(at('Verify Windows signatures'))
      expect(at('Verify Windows signatures')).toBeLessThan(at('Attach installers to the workflow run'))
      expect(at('Verify Windows signatures')).toBeLessThan(at('Upload to the draft GitHub Release'))
      for (const name of ['Install CodeSignTool', 'Verify Windows signatures']) {
        expect(job.steps[at(name)].if).toBe("steps.signing.outputs.enabled == 'true'")
      }
      expect(job.steps[at('Install CodeSignTool')].run).toContain('sha256sum -c -')
    }
  })

  it('leaves every other job alone', () => {
    for (const [name, job] of Object.entries(jobs)) {
      if (name === 'release-windows-x64' || name === 'release-windows-arm64') continue
      expect(JSON.stringify(job)).not.toMatch(/WINDOWS_SIGNING|windows-sign|ES_PASSWORD/)
    }
  })
})
