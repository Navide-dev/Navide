#!/usr/bin/env node
// Opt-in Authenticode signing for the Windows release jobs.
//
// Off unless the `WINDOWS_SIGNING` repository variable names a provider: with
// it unset the release jobs run exactly the unsigned build they always have.
// With it set, every piece the provider needs must be present, every file
// electron-builder signs must end up with a valid signature from the expected
// publisher, or the job fails — a release is never quietly shipped unsigned
// once signing was asked for. docs/en-US/windows-code-signing.md lists the
// GitHub variable and secret names.
//
// The only provider today is SSL.com eSigner (an OV certificate whose key
// lives in SSL.com's cloud HSM), driven through its CodeSignTool CLI from the
// electron-builder sign hook in scripts/windows-sign.mjs.
//
// Usage:
//   node scripts/windows-signing.mjs resolve        validate the switch; prints
//                                                    enabled=true|false (GITHUB_OUTPUT form)
//   node scripts/windows-signing.mjs verify <dir>    check every installer and
//                                                    packaged .exe under <dir>

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROVIDERS = {
  esigner: {
    secrets: ['ES_USERNAME', 'ES_PASSWORD', 'ES_CREDENTIAL_ID', 'ES_TOTP_SECRET'],
    variables: ['WINDOWS_PUBLISHER_NAME', 'CODESIGNTOOL_SHA256'],
  },
}

// Returns { enabled: false } when signing is off, { enabled: true, provider }
// when it is on and complete; throws, naming what is missing, otherwise.
export function resolveSigning(env) {
  const provider = (env.WINDOWS_SIGNING ?? '').trim()
  if (provider === '') return { enabled: false }
  const spec = PROVIDERS[provider]
  if (!spec) {
    throw new Error(`WINDOWS_SIGNING=${provider} is not a known provider (known: ${Object.keys(PROVIDERS).join(', ')})`)
  }
  const missing = [...spec.variables, ...spec.secrets].filter((name) => !(env[name] ?? '').trim())
  if (missing.length > 0) {
    throw new Error(`WINDOWS_SIGNING=${provider} but these are not set: ${missing.join(', ')}`)
  }
  return { enabled: true, provider }
}

// The CodeSignTool command line that signs `file` in place. Credentials are
// passed as separate argv entries (no shell), never through a command string.
export function codeSignToolArgs(jar, file, env) {
  return [
    '-jar', jar, 'sign',
    `-username=${env.ES_USERNAME}`,
    `-password=${env.ES_PASSWORD}`,
    `-credential_id=${env.ES_CREDENTIAL_ID}`,
    `-totp_secret=${env.ES_TOTP_SECRET}`,
    `-input_file_path=${file}`,
    '-override',
  ]
}

// Replace every secret value in `text`, so tool output can be logged safely.
export function redact(text, env, names = PROVIDERS.esigner.secrets) {
  let out = text
  for (const name of names) {
    const value = env[name]
    if (value) out = out.split(value).join('***')
  }
  return out
}

// The CN attribute of an X.500 subject such as `CN=Foo, O=Foo, C=TW`.
export function commonName(subject) {
  const match = /(?:^|,\s*)CN=("(?:[^"]|"")*"|[^,]*)/.exec(subject ?? '')
  if (!match) return null
  const value = match[1].trim()
  return value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value
}

// `results` are Get-AuthenticodeSignature rows: { Path, Status, Subject }.
// Returns one line per file that is unsigned, invalid or signed by someone else.
export function signatureProblems(results, publisherName) {
  const expected = commonName(publisherName) ?? publisherName
  const problems = []
  for (const row of results) {
    if (row.Status !== 'Valid') problems.push(`${row.Path}: signature status ${row.Status}`)
    else if (commonName(row.Subject) !== expected) problems.push(`${row.Path}: signed by "${row.Subject}", expected CN=${expected}`)
  }
  return problems
}

// The installers in `dir` plus every .exe in the unpacked app beside them.
export function filesToVerify(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (entry.endsWith('.exe') && statSync(path).isFile()) files.push(path)
    else if (entry.endsWith('-unpacked') && statSync(path).isDirectory()) files.push(...walkExe(path))
  }
  return files.sort()
}

function walkExe(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walkExe(path))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) found.push(path)
  }
  return found
}

// Windows only: one PowerShell call for every file.
export function readSignatures(files) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '@($paths | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_;',
    '  [pscustomobject]@{ Path = $_; Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } })',
    '  | ConvertTo-Json -Depth 3 -AsArray',
  ].join('\n')
  const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(files),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(out)
}

function main(argv) {
  const [command, dir] = argv
  if (command === 'resolve') {
    let result
    try {
      result = resolveSigning(process.env)
    } catch (error) {
      console.error(`::error::${error.message}`)
      process.exit(1)
    }
    if (!result.enabled && PROVIDERS.esigner.secrets.some((name) => process.env[name])) {
      console.log('::warning::Signing secrets are set but the WINDOWS_SIGNING variable is not, so this build stays unsigned.')
    }
    const line = `enabled=${result.enabled}\n`
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
    process.stdout.write(result.enabled ? `Windows signing on (${result.provider})\n` : 'Windows signing off: building unsigned\n')
    return
  }
  if (command === 'verify') {
    const target = resolve(dir ?? 'dist-release')
    if (!existsSync(target)) {
      console.error(`windows-signing: ${target} not found`)
      process.exit(2)
    }
    const files = filesToVerify(target)
    if (files.length === 0) {
      console.error(`windows-signing: no .exe under ${target}`)
      process.exit(1)
    }
    const problems = signatureProblems(readSignatures(files), process.env.WINDOWS_PUBLISHER_NAME ?? '')
    if (problems.length > 0) {
      for (const line of problems) console.error(`::error::${line}`)
      console.error(`windows-signing: ${problems.length} of ${files.length} executables are not signed by the expected publisher`)
      process.exit(1)
    }
    console.log(`windows-signing: all ${files.length} executables carry a valid signature from CN=${commonName(process.env.WINDOWS_PUBLISHER_NAME) ?? process.env.WINDOWS_PUBLISHER_NAME}`)
    return
  }
  console.error('usage: windows-signing.mjs resolve | verify <dir>')
  process.exit(2)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
