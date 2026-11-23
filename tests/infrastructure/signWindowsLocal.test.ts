import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { jsignArgs, manifestEntries, parseArgs, signerCommonName, updateManifest } from '../../scripts/sign-windows-local.mjs'

type Step = { name?: string; run?: string; env?: Record<string, string> }
type Job = { if?: string; steps?: Step[] }

const base = ['--tag', 'v9.9.9', '--storetype', 'YUBIKEY', '--publisher', 'Example Publisher']

const manifest = [
  'version: 9.9.9',
  'files:',
  '  - url: Navide-9.9.9-win-x64.exe',
  '    sha512: OLDX64==',
  '    size: 100',
  '  - url: Navide-9.9.9-win-arm64.exe',
  '    sha512: OLDARM==',
  '    size: 90',
  'path: Navide-9.9.9-win-x64.exe',
  'sha512: OLDX64==',
  "releaseDate: '2026-11-17T00:00:00.000Z'",
  '',
].join('\n')

describe('parseArgs', () => {
  it('defaults to a dry run against the main repository', () => {
    const opts = parseArgs(base)
    expect(opts.apply).toBe(false)
    expect(opts.mirror).toBe(true)
    expect(opts.repo).toBe('Navide-dev/Navide')
  })

  it('never accepts the secret as an argument', () => {
    for (const flag of ['--storepass', '--keypass', '--pin', '--password']) {
      expect(() => parseArgs([...base, flag, 'x'])).toThrow(/never from arguments/)
    }
  })

  it('requires a tag, a keystore type and the expected publisher', () => {
    expect(() => parseArgs(['--storetype', 'YUBIKEY', '--publisher', 'P'])).toThrow(/--tag/)
    expect(() => parseArgs(['--tag', 'v1.0.0', '--publisher', 'P'])).toThrow(/--storetype/)
    expect(() => parseArgs(['--tag', 'v1.0.0', '--storetype', 'YUBIKEY'])).toThrow(/--publisher/)
  })
})

describe('jsignArgs', () => {
  it('points jsign at the environment for the secret and passes the keystore through', () => {
    const opts = parseArgs([...base, '--keystore', 'token.cfg', '--alias', 'key', '--tsaurl', 'http://a', '--tsaurl', 'http://b'])
    const args = jsignArgs(opts, 'in.exe')
    expect(args[args.indexOf('--storepass') + 1]).toBe('env:NAVIDE_SIGN_PIN')
    expect(args).toEqual(expect.arrayContaining(['--storetype', 'YUBIKEY', '--keystore', 'token.cfg', '--alias', 'key', '--tsaurl', 'http://a,http://b']))
    expect(args.at(-1)).toBe('in.exe')
  })
})

describe('updateManifest', () => {
  it('rewrites sha512 and size of each signed installer and the top-level sha512, nothing else', () => {
    const out = updateManifest(manifest, {
      'Navide-9.9.9-win-x64.exe': { sha512: 'NEWX64==', size: 111 },
      'Navide-9.9.9-win-arm64.exe': { sha512: 'NEWARM==', size: 99 },
    })
    expect(manifestEntries(out)).toEqual({
      'Navide-9.9.9-win-x64.exe': { sha512: 'NEWX64==', size: 111 },
      'Navide-9.9.9-win-arm64.exe': { sha512: 'NEWARM==', size: 99 },
    })
    expect(parse(out).sha512).toBe('NEWX64==')
    expect(parse(out).releaseDate).toBe('2026-11-17T00:00:00.000Z')
    expect(out.split('\n').length).toBe(manifest.split('\n').length)
  })

  it('fails for an installer the manifest does not list', () => {
    expect(() => updateManifest(manifest, { 'Navide-9.9.9-win-ia32.exe': { sha512: 'X', size: 1 } })).toThrow(/does not list/)
  })
})

describe('signerCommonName', () => {
  it('reads the CN of the signer certificate from osslsigncode output', () => {
    const output = [
      'Signer\'s certificate:',
      '\tSigner #0:',
      '\t\tSubject: /CN=Example Publisher/O=Example/C=TW',
      '\t\tIssuer : /CN=Example CA',
      '',
      'Signature verification: ok',
    ].join('\n')
    expect(signerCommonName(output)).toBe('Example Publisher')
    expect(signerCommonName('No signature found')).toBeNull()
  })
})

describe('release.yml', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as { jobs: Record<string, Job> }

  it('gives the Windows jobs no secrets: installers are signed locally', () => {
    for (const name of ['release-windows-x64', 'release-windows-arm64']) {
      const text = JSON.stringify(workflow.jobs[name])
      expect(text).not.toMatch(/secrets\./)
      expect(text).not.toMatch(/ES_|WINDOWS_SIGNING|CodeSignTool/)
    }
  })

  it('keeps the release a draft for local signing when WINDOWS_SIGN_LOCALLY is set', () => {
    for (const name of ['mirror-release', 'publish-release']) {
      expect(workflow.jobs[name].if).toContain("vars.WINDOWS_SIGN_LOCALLY != 'true'")
    }
  })
})
