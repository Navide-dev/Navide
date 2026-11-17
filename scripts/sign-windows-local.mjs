#!/usr/bin/env node
// Sign the Windows installers of a release on this machine, then put them back.
//
// CI builds the Windows installers unsigned and never sees a signing
// credential: the key lives on a hardware token (YubiKey, a Certum card) or
// behind a vendor login on the release manager's Mac, and the PIN or password
// is typed in or read from the macOS keychain at run time. This script is the
// whole local leg (docs/en-US/releases.md "Windows code signing"):
//
//   1. fetch the unsigned installers and latest.yml (draft release, workflow
//      run artifacts, or a local directory);
//   2. check each installer still matches latest.yml, and that it is unsigned;
//   3. sign each one with jsign (any keystore jsign supports: --storetype);
//   4. verify each signature with osslsigncode, and the signer's CN;
//   5. rebuild every .blockmap with electron-builder's own code and rewrite
//      sha512/size in latest.yml, then re-check both against the signed bytes;
//   6. only with --apply: upload the signed files to the draft release and run
//      mirror.yml so dl.navide.dev serves the same bytes.
//
// Without --apply nothing leaves this machine. --apply refuses a release that
// is already published: assets on a public release are never replaced.
//
// The secret (PIN / keystore password) is never an argument, never written to
// a file and never logged. It reaches jsign only through the environment of
// the jsign child process (`--storepass env:NAVIDE_SIGN_PIN`).
//
// Usage: node scripts/sign-windows-local.mjs --help

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PIN_ENV = 'NAVIDE_SIGN_PIN'
const SYSTEM_CA = '/etc/ssl/cert.pem'
const INSTALLER = /^Navide-.+-win-(x64|arm64)\.exe$/

const USAGE = `usage: node scripts/sign-windows-local.mjs --tag vX.Y.Z --storetype TYPE --publisher CN [options]

Input (one of):
  --tag vX.Y.Z            the release; files come from its draft unless --run or --dir is given
  --run <run-id>          take the installers from that Release workflow run's artifacts
  --dir <path>            take the installers and latest.yml from a local directory
Signing (passed to jsign; nothing here is vendor-specific):
  --storetype TYPE        jsign keystore type: YUBIKEY, PKCS11, CRYPTOCERTUM, PKCS12, ...
  --keystore VALUE        jsign --keystore (PKCS#11 config file, .p12 file, token name)
  --alias NAME            jsign --alias
  --certfile FILE         jsign --certfile (certificate chain, when the token holds only the key)
  --tsaurl URL            timestamp authority (repeatable); without one the signature
                          stops validating when the certificate expires
  --publisher CN          expected signer common name; verification fails on anything else
  --ca-file FILE          CA bundle the signer must chain to (default /etc/ssl/cert.pem;
                          timestamps are always checked against that system bundle)
Secret (one of; never an argument):
  --keychain-service NAME read it from the macOS keychain (security find-generic-password -s NAME)
  --keychain FILE         ... from this keychain file instead of the default search list
  (neither)               prompt for it on the terminal, without echo
Output:
  --out <dir>             where the signed files are kept (default: a new temp directory)
  --repo OWNER/NAME       GitHub repository (default Navide-dev/Navide)
  --apply                 upload to the draft release and refresh the mirror (default: dry run)
  --no-mirror             with --apply, skip mirror.yml (test releases)`

export function parseArgs(argv) {
  const opts = { repo: 'Navide-dev/Navide', tsaurl: [], apply: false, mirror: true, caFile: SYSTEM_CA }
  const valued = {
    '--tag': 'tag', '--run': 'run', '--dir': 'dir', '--storetype': 'storetype', '--keystore': 'keystore',
    '--alias': 'alias', '--certfile': 'certfile', '--publisher': 'publisher', '--ca-file': 'caFile',
    '--keychain-service': 'keychainService', '--keychain': 'keychain', '--out': 'out', '--repo': 'repo',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') opts.apply = true
    else if (arg === '--no-mirror') opts.mirror = false
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--tsaurl') opts.tsaurl.push(requireValue(argv, (i += 1), arg))
    else if (valued[arg]) opts[valued[arg]] = requireValue(argv, (i += 1), arg)
    else if (/^--(storepass|keypass|pin|password)\b/.test(arg)) {
      throw new Error(`${arg} is not accepted: the secret is read from the keychain or the terminal, never from arguments`)
    } else throw new Error(`unknown argument ${arg}`)
  }
  if (opts.help) return opts
  if (!opts.tag) throw new Error('--tag is required')
  if (opts.run && opts.dir) throw new Error('--run and --dir are exclusive')
  if (!opts.storetype) throw new Error('--storetype is required')
  if (!opts.publisher) throw new Error('--publisher is required')
  if (opts.keychain && !opts.keychainService) throw new Error('--keychain needs --keychain-service')
  return opts
}

function requireValue(argv, i, name) {
  const value = argv[i]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

// The jsign argv for one file. The secret is a reference to the child's
// environment, so it never appears in argv (ps, shell history, logs).
export function jsignArgs(opts, file) {
  const args = ['sign', '--storetype', opts.storetype, '--storepass', `env:${PIN_ENV}`, '--alg', 'SHA-256',
    '--name', 'Navide', '--url', 'https://navide.dev']
  if (opts.keystore) args.push('--keystore', opts.keystore)
  if (opts.alias) args.push('--alias', opts.alias)
  if (opts.certfile) args.push('--certfile', opts.certfile)
  if (opts.tsaurl.length > 0) args.push('--tsaurl', opts.tsaurl.join(','), '--tsmode', 'RFC3161', '--tsretries', '3')
  args.push(file)
  return args
}

// latest.yml with the sha512/size of every entry in `updates` (url → {sha512,
// size}) replaced, plus the top-level sha512 of the `path:` file. Text edit,
// like merge-windows-update-manifest.mjs, so nothing else in the file moves.
export function updateManifest(text, updates) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const seen = new Set()
  const topPath = lines.find((line) => line.startsWith('path: '))?.slice('path: '.length).trim()
  let current = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const url = /^\s+- url: (.+)$/.exec(line)
    if (url) {
      current = url[1].trim()
      continue
    }
    if (!line.startsWith(' ')) current = null
    if (current && updates[current]) {
      const field = /^(\s+)(sha512|size): /.exec(line)
      if (field) {
        lines[i] = `${field[1]}${field[2]}: ${updates[current][field[2]]}`
        seen.add(current)
      }
    }
    if (line.startsWith('sha512: ') && topPath && updates[topPath]) lines[i] = `sha512: ${updates[topPath].sha512}`
  }
  const missing = Object.keys(updates).filter((name) => !seen.has(name))
  if (missing.length > 0) throw new Error(`latest.yml does not list ${missing.join(', ')}`)
  return lines.join('\n')
}

// url → { sha512, size } for every `files:` entry of a latest.yml.
export function manifestEntries(text) {
  const entries = {}
  let current = null
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const url = /^\s+- url: (.+)$/.exec(line)
    if (url) {
      current = url[1].trim()
      entries[current] = {}
      continue
    }
    if (!line.startsWith(' ')) current = null
    const field = /^\s+(sha512|size): (.+)$/.exec(line)
    if (current && field) entries[current][field[1]] = field[1] === 'size' ? Number(field[2]) : field[2].trim()
  }
  return entries
}

// The signer CN from `osslsigncode verify` output, or null.
export function signerCommonName(output) {
  const block = /Signer's certificate:\s*\n([\s\S]*?)(?:\n\s*\n|$)/.exec(output)
  const subject = /Subject:\s*(.+)/.exec(block ? block[1] : output)
  if (!subject) return null
  const cn = /(?:^|[/,]\s*)CN\s*=\s*([^/,]+)/.exec(subject[1])
  return cn ? cn[1].trim() : null
}

function sha512File(file) {
  return new Promise((done, fail) => {
    const hash = createHash('sha512')
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('base64')))
  })
}

function run(cmd, args, { env, input, quiet } = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', env: env ?? process.env, input, maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new Error(`${cmd}: ${result.error.message}`)
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (!quiet && output.trim()) console.log(output.trim())
  return { status: result.status, output, stdout: result.stdout ?? '' }
}

function must(cmd, args, options) {
  const result = run(cmd, args, options)
  if (result.status !== 0) throw new Error(`${cmd} ${args[0]} exited ${result.status}`)
  return result
}

function readSecret(opts) {
  if (opts.keychainService) {
    const args = ['find-generic-password', '-s', opts.keychainService, '-w']
    if (opts.keychain) args.push(opts.keychain)
    const result = spawnSync('security', args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`keychain item "${opts.keychainService}" not found or not readable`)
    return result.stdout.replace(/\n$/, '')
  }
  if (!process.stdin.isTTY) throw new Error('no terminal to ask for the PIN; use --keychain-service')
  // `stty -echo` on the controlling terminal before the prompt appears, so
  // nothing typed after it is echoed; the answer is read with `head -1`, so it
  // never passes through Node's line history or this process's argv.
  const muted = spawnSync('stty', ['-echo'], { stdio: ['inherit', 'inherit', 'inherit'] })
  if (muted.status !== 0) throw new Error('could not turn off terminal echo; use --keychain-service')
  try {
    process.stdout.write(`PIN / password for the ${opts.storetype} keystore: `)
    const answer = spawnSync('head', ['-n', '1'], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' })
    return (answer.stdout ?? '').replace(/\n$/, '')
  } finally {
    spawnSync('stty', ['echo'], { stdio: ['inherit', 'inherit', 'inherit'] })
    process.stdout.write('\n')
  }
}

function fetchInputs(opts, work) {
  const dir = join(work, 'input')
  mkdirSync(dir)
  if (opts.dir) {
    for (const name of readdirSync(opts.dir)) {
      if (INSTALLER.test(name) || name === 'latest.yml') copyFileSync(join(opts.dir, name), join(dir, name))
    }
  } else if (opts.run) {
    // arm64 merges itself into the x64 latest.yml, so its copy is the full one.
    for (const arch of ['x64', 'arm64']) {
      const into = join(work, `artifact-${arch}`)
      must('gh', ['run', 'download', opts.run, '--repo', opts.repo, '--name', `navide-windows-${arch}`, '--dir', into])
      for (const name of readdirSync(into)) {
        if (INSTALLER.test(name) || (arch === 'arm64' && name === 'latest.yml')) copyFileSync(join(into, name), join(dir, name))
      }
    }
  } else {
    must('gh', ['release', 'download', opts.tag, '--repo', opts.repo, '--dir', dir,
      '--pattern', 'Navide-*-win-*.exe', '--pattern', 'latest.yml'])
  }
  if (!existsSync(join(dir, 'latest.yml'))) throw new Error('no latest.yml among the inputs')
  const installers = readdirSync(dir).filter((name) => INSTALLER.test(name)).sort()
  if (installers.length === 0) throw new Error('no Navide-*-win-*.exe among the inputs')
  return { dir, installers }
}

function verifySignature(opts, file) {
  const result = run('osslsigncode', ['verify', '-in', file, '-CAfile', opts.caFile, '-TSA-CAfile', SYSTEM_CA], { quiet: true })
  const cn = signerCommonName(result.output)
  const problems = []
  if (result.status !== 0 || !/Signature verification: ok/.test(result.output)) problems.push('signature does not verify')
  if (cn !== opts.publisher) problems.push(`signer CN is ${cn ?? 'missing'}, expected ${opts.publisher}`)
  return { problems, output: result.output }
}

function isSigned(file) {
  const result = run('osslsigncode', ['extract-signature', '-in', file, '-out', `${file}.sig-probe`], { quiet: true })
  rmSync(`${file}.sig-probe`, { force: true })
  return result.status === 0
}

async function buildBlockMap(file) {
  // electron-builder's own blockmap code, so the result is exactly what its
  // NSIS target would have written for these bytes.
  const req = createRequire(createRequire(import.meta.url).resolve('electron-builder'))
  const { buildBlockMap: build } = req('app-builder-lib/out/targets/blockmap/blockmap')
  return build(file, 'gzip', `${file}.blockmap`)
}

async function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(USAGE)
    return
  }
  for (const tool of ['jsign', 'osslsigncode', ...(opts.dir ? [] : ['gh'])]) {
    if (run('which', [tool], { quiet: true }).status !== 0) throw new Error(`${tool} is not installed (brew install ${tool})`)
  }
  if (opts.tsaurl.length === 0) console.warn('warning: no --tsaurl; the signature will stop validating when the certificate expires')
  if (opts.apply) {
    const draft = must('gh', ['release', 'view', opts.tag, '--repo', opts.repo, '--json', 'isDraft', '--jq', '.isDraft'], { quiet: true })
    if (draft.stdout.trim() !== 'true') throw new Error(`${opts.tag} is not a draft release; published assets are never replaced`)
  }

  const work = mkdtempSync(join(tmpdir(), 'navide-winsign-'))
  try {
    await signRelease(opts, work, resolve(opts.out ?? join(work, 'signed')))
  } finally {
    // The downloads are several hundred MB; only the signed output is kept.
    for (const name of readdirSync(work)) if (join(work, name) !== resolve(opts.out ?? join(work, 'signed'))) rmSync(join(work, name), { recursive: true, force: true })
    if (readdirSync(work).length === 0) rmSync(work, { recursive: true, force: true })
  }
}

async function signRelease(opts, work, out) {
  mkdirSync(out, { recursive: true })
  const { dir, installers } = fetchInputs(opts, work)
  const manifestText = readFileSync(join(dir, 'latest.yml'), 'utf8')
  const listed = manifestEntries(manifestText)

  for (const name of installers) {
    const entry = listed[name]
    if (!entry) throw new Error(`${name} is not listed in latest.yml`)
    if ((await sha512File(join(dir, name))) !== entry.sha512) throw new Error(`${name} does not match latest.yml: not the file CI built`)
    if (isSigned(join(dir, name))) throw new Error(`${name} is already signed; start from the unsigned CI output`)
    copyFileSync(join(dir, name), join(out, name))
  }

  const secret = readSecret(opts)
  const env = { ...process.env, [PIN_ENV]: secret }
  const updates = {}
  try {
    for (const name of installers) {
      const file = join(out, name)
      console.log(`signing ${name}`)
      const signed = run('jsign', jsignArgs(opts, file), { env })
      if (signed.status !== 0) throw new Error(`jsign failed for ${name}`)
      const { problems, output } = verifySignature(opts, file)
      if (problems.length > 0) {
        console.error(output)
        throw new Error(`${name}: ${problems.join('; ')}`)
      }
      const info = await buildBlockMap(file)
      updates[name] = { sha512: info.sha512, size: info.size }
    }
  } finally {
    delete env[PIN_ENV]
  }

  const manifest = updateManifest(manifestText, updates)
  writeFileSync(join(out, 'latest.yml'), manifest)
  // Re-read everything from disk: the manifest must describe the bytes we upload.
  const written = manifestEntries(manifest)
  for (const name of installers) {
    const file = join(out, name)
    if ((await sha512File(file)) !== written[name].sha512 || statSync(file).size !== written[name].size) {
      throw new Error(`${name}: latest.yml does not match the signed file`)
    }
    if (!existsSync(`${file}.blockmap`)) throw new Error(`${name}.blockmap missing`)
  }

  const uploads = [...installers.flatMap((name) => [join(out, name), join(out, `${name}.blockmap`)]), join(out, 'latest.yml')]
  console.log(`\nsigned and verified ${installers.length} installer(s); files in ${out}:`)
  for (const file of uploads) console.log(`  ${basename(file)}  ${statSync(file).size} bytes`)

  if (!opts.apply) {
    console.log(`\ndry run: nothing uploaded. Re-run with --apply to upload to the ${opts.tag} draft${opts.mirror ? ' and refresh dl.navide.dev' : ''}.`)
    return
  }
  must('gh', ['release', 'upload', opts.tag, '--repo', opts.repo, '--clobber', ...uploads])
  const check = join(work, 'uploaded')
  must('gh', ['release', 'download', opts.tag, '--repo', opts.repo, '--dir', check, ...uploads.flatMap((file) => ['--pattern', basename(file)])])
  for (const file of uploads) {
    if (!readFileSync(join(check, basename(file))).equals(readFileSync(file))) throw new Error(`${basename(file)}: the release does not serve the signed bytes`)
  }
  console.log(`uploaded to the ${opts.tag} draft and read back byte for byte`)
  if (!opts.mirror) return
  const since = new Date(Date.now() - 5000).toISOString()
  must('gh', ['workflow', 'run', 'mirror.yml', '--repo', opts.repo, '-f', `tag=${opts.tag}`, '-f', 'refresh_latest=true'])
  let runId = ''
  for (let tries = 0; tries < 30 && !runId; tries += 1) {
    spawnSync('sleep', ['4'])
    runId = must('gh', ['run', 'list', '--repo', opts.repo, '--workflow', 'mirror.yml', '--event', 'workflow_dispatch',
      '--created', `>=${since}`, '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId // ""'], { quiet: true }).stdout.trim()
  }
  if (!runId) throw new Error('mirror.yml was dispatched but its run did not show up; check Actions')
  must('gh', ['run', 'watch', runId, '--repo', opts.repo, '--exit-status'])
  console.log(`dl.navide.dev mirrors the signed files. Publish when ready:\n  gh release edit ${opts.tag} --repo ${opts.repo} --draft=false --latest`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`sign-windows-local: ${error.message}`)
    process.exit(1)
  })
}
