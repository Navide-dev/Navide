#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signDigest,
  verify as verifyDigest,
} from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { deflateRawSync } from 'node:zlib'
import {
  canonicalArchivePath,
  comparePortableArchivePaths,
  deriveAgentToolPrefix,
  manifestReferencedFiles,
  parseManifestJson,
  parseManifestV2,
  validateAgentTools,
  validatePortableArchiveEntries,
} from '@navide/plugin-contracts'
import { runDevBackend } from './dev-backend.mjs'
import { initPlugin } from './init-template.mjs'
import { readRegularFileNoFollow } from './package-files.mjs'
import {
  TOKEN_ENV,
  assertSecureTransport,
  credentialsPath,
  getJson,
  login,
  openBrowser,
  publish,
  registryUrl,
  removeCredentials,
  resolveToken,
} from './registry-client.mjs'
import { runTestplace } from './testplace.mjs'
import { formatScan, readZipEntries, scanFiles } from './scan.mjs'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function fail(message) {
  throw new Error(message)
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertSafePath(path, label) {
  if (canonicalArchivePath(path, 'regular') === null) {
    fail(`${label} is not a safe package-relative path`)
  }
}

/** One `validateAgentTools` error as the Registry would refuse it, with the value that would pass. */
function agentToolMessage(raw, error) {
  const tools = raw.backend?.agentTools
  const tool = error.index === null || !Array.isArray(tools) ? undefined : tools[error.index]
  const where = `manifest backend.agentTools${error.index === null ? '' : `[${error.index}]`}${error.index !== null && error.field ? `.${error.field}` : ''}`
  const value = (field) => JSON.stringify(tool && typeof tool === 'object' ? tool[field] : undefined)
  const prefix = deriveAgentToolPrefix(raw.id)
  const methods = Array.isArray(raw.backend?.methods) ? raw.backend.methods : []
  const detail = {
    AGENT_TOOL_PREFIX_UNDERIVABLE: `: id ${JSON.stringify(raw.id)} cannot declare agent tools; the last segment of the id, without hyphens, must be 2-16 lower-case letters or digits starting with a letter`,
    AGENT_TOOL_NAME_INVALID: ` ${value('name')} must be '${prefix}_' followed by 1-40 of a-z, 0-9 and _, for example '${prefix}_list'`,
    AGENT_TOOL_PREFIX_MISMATCH: ` ${value('name')} must start with '${prefix}_', the prefix Navide derives from id ${JSON.stringify(raw.id)} (its last segment without hyphens)`,
    AGENT_TOOL_PREFIX_RESERVED: `: the prefix '${prefix}_' that id ${JSON.stringify(raw.id)} derives is reserved for Navide; change the last segment of the id`,
    AGENT_TOOL_NAME_RESERVED: ` ${value('name')} is a built-in Navide tool name; choose another '${prefix}_' name`,
    AGENT_TOOL_NAME_DUPLICATE: ` ${value('name')} is declared twice`,
    AGENT_TOOL_METHOD_UNDECLARED: ` ${value('method')} is not listed in backend.methods (declared: ${methods.length ? methods.join(', ') : 'none'})`,
    AGENT_TOOL_RISK_INVALID: ` ${value('risk')} must be 'read' or 'write'`,
    AGENT_TOOL_TIMEOUT_INVALID: ` ${value('timeoutMs')} must be an integer from 1 to 120000`,
    AGENT_TOOL_FIELD_MISSING: ' is required',
    AGENT_TOOL_FIELD_UNKNOWN: ' is not a known field (allowed: name, method, risk, title, description, inputSchema, timeoutMs)',
  }[error.code] ?? ' is invalid'
  return `${where}${detail} [${error.code}]`
}

function readManifest(directory) {
  const path = join(directory, 'manifest.json')
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile()) fail('manifest.json must be a regular file')
  const raw = parseManifestJson(decodeUtf8(readRegularFileNoFollow(path), 'manifest.json'))
  // The Registry checks agent tools on the raw manifest before anything else.
  const toolErrors = raw && typeof raw === 'object' ? validateAgentTools(raw) : []
  if (toolErrors.length) fail(toolErrors.map((error) => agentToolMessage(raw, error)).join('\n'))
  return parseManifestV2(raw)
}

function assertInsideRoot(root, candidate) {
  const relativePath = relative(root, realpathSync(candidate))
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    fail(`package entry '${candidate}' resolves outside the package root`)
  }
}

function assertNoSymlinkPath(root, path) {
  let candidate = root
  const segments = path.split('/')
  for (const [index, segment] of segments.entries()) {
    candidate = join(candidate, segment)
    let stat
    try {
      stat = lstatSync(candidate, { bigint: true })
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        fail(`package entry '${path}' is listed in ${CANONICAL_FILE_LIST} but does not exist`)
      }
      throw error
    }
    if (stat.isSymbolicLink()) fail(`package entry '${path}' contains a symlink`)
    if (index < segments.length - 1 && !stat.isDirectory()) {
      fail(`package entry '${path}' has a non-directory ancestor`)
    }
  }
}

const CANONICAL_FILE_LIST = 'artifact-files.json'
const SOURCE_ONLY_SEGMENTS = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'tests'])
const SOURCE_ONLY_FILE = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|pyproject\.toml|vite\.config\.[cm]?[jt]s)$/
const SOURCE_ONLY_EXTENSION = /\.(?:py|pyc|pyo|ts|tsx|vue|map)$/
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:key|pem|p12|pfx))$/i

function artifactTarget(manifest, target) {
  if (manifest.backend) {
    const expected = `${process.platform}-${process.arch}`
    if (target !== expected) {
      fail(`backend package target '${target}' must match the build host target '${expected}'`)
    }
    return target
  }
  if (target !== 'universal') {
    fail(`frontend-only package target must be 'universal', received '${target}'`)
  }
  return target
}

// Same rule as the Host's backendEntryOnDisk and the Registry's
// backend_entry_for_target: only a bare entry gains `.exe` on win32.
function backendEntryForTarget(entry, target) {
  return target.startsWith('win32-') && posix.extname(entry) === '' ? `${entry}.exe` : entry
}

function backendMatchesTarget(bytes, target) {
  const [platform, architecture] = target.split('-', 2)
  if (platform === 'linux') {
    if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return false
    const machine = bytes[5] === 1 ? bytes.readUInt16LE(18) : bytes[5] === 2 ? bytes.readUInt16BE(18) : -1
    return bytes[4] === 2 && ((architecture === 'x64' && machine === 62) || (architecture === 'arm64' && machine === 183))
  }
  if (platform === 'win32') {
    if (bytes.length < 0x40 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') return false
    const offset = bytes.readUInt32LE(0x3c)
    if (offset + 6 > bytes.length || bytes.subarray(offset, offset + 4).toString('ascii') !== 'PE\0\0') return false
    const machine = bytes.readUInt16LE(offset + 4)
    return (architecture === 'x64' && machine === 0x8664) || (architecture === 'arm64' && machine === 0xaa64)
  }
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) return false
  const cpuType = bytes.readUInt32LE(4)
  return (architecture === 'x64' && cpuType === 0x01000007) || (architecture === 'arm64' && cpuType === 0x0100000c)
}

function parseFileList(directory) {
  const listPath = join(directory, CANONICAL_FILE_LIST)
  let parsed
  try {
    parsed = parseManifestJson(decodeUtf8(readRegularFileNoFollow(listPath), CANONICAL_FILE_LIST))
  } catch (error) {
    fail(`${CANONICAL_FILE_LIST} must be a JSON object with a files array: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.files)) {
    fail(`${CANONICAL_FILE_LIST} must contain only a files array`)
  }
  const paths = parsed.files
  if (paths.length === 0 || paths.some((path) => typeof path !== 'string')) {
    fail(`${CANONICAL_FILE_LIST}.files must be a nonempty string array`)
  }
  return paths
}

function assertPublishableFile(path) {
  const segments = path.split('/')
  if (segments.includes('.navide-dev')) {
    fail(`package entry '${path}' is dev-backend data (.navide-dev); remove it from ${CANONICAL_FILE_LIST}`)
  }
  if (segments.some((segment) => SOURCE_ONLY_SEGMENTS.has(segment))) {
    fail(`package entry '${path}' is source-only build input`)
  }
  if (SOURCE_ONLY_FILE.test(path) || SOURCE_ONLY_EXTENSION.test(path) || SECRET_FILE.test(path)) {
    fail(`package entry '${path}' is source-only or secret material`)
  }
}

function collectFiles(directory, paths, root = realpathSync(directory)) {
  const files = []
  let totalSize = 0
  for (const path of paths) {
    assertSafePath(path, `package entry '${path}'`)
    assertPublishableFile(path)
    const fullPath = join(directory, path)
    assertNoSymlinkPath(root, path)
    let stat
    try {
      stat = lstatSync(fullPath, { bigint: true })
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        fail(`package entry '${path}' is listed in ${CANONICAL_FILE_LIST} but does not exist`)
      }
      throw error
    }
    if (!stat.isFile()) fail(`package entry '${path}' must be a regular file`)
    assertInsideRoot(root, fullPath)
    if (stat.size > 50n * 1024n * 1024n) fail(`package entry '${path}' exceeds the 50 MiB size limit`)
    totalSize += Number(stat.size)
    if (totalSize > 200 * 1024 * 1024) fail('package entries exceed the 200 MiB size limit')
    files.push({ path, bytes: readRegularFileNoFollow(fullPath) })
  }
  return files
}

function validateFiles(manifest, files, target, root) {
  const paths = new Set(files.map((file) => file.path))
  if (!paths.has('manifest.json')) fail('package must contain manifest.json at its root')
  // A view's declared detail target schema is an explicit manifest reference and
  // may live outside the frontend/assets/backend roots; everything else keeps
  // the original package boundary.
  const declaredTargetSchemas = new Set(
    (manifest.contributes?.views ?? [])
      .map((view) => view.targetSchema)
      .filter((path) => typeof path === 'string' && path.length > 0),
  )
  for (const path of paths) {
    if (path === 'manifest.json' || path === 'README.md') continue
    if (path.startsWith('frontend/') || path.startsWith('assets/') || path.startsWith('backend/')) continue
    if (declaredTargetSchemas.has(path)) continue
    fail(`package entry '${path}' is outside the frontend/assets/backend package boundary`)
  }
  const backendEntry = manifest.backend ? backendEntryForTarget(manifest.backend.entry, target) : null
  for (const path of manifestReferencedFiles(manifest)) {
    const referenced = path === manifest.backend?.entry ? backendEntry : path
    if (!paths.has(referenced)) {
      fail(
        existsSync(join(root, referenced))
          ? `manifest references '${referenced}', but ${CANONICAL_FILE_LIST} does not list it; add it to the files array`
          : `manifest references '${referenced}', but that file does not exist`,
      )
    }
  }
  const backendEntries = [...paths].filter((path) => path.startsWith('backend/'))
  const frontendEntries = [...paths].filter((path) => path.startsWith('frontend/'))
  if (backendEntry) {
    if (backendEntries.length !== 1 || backendEntries[0] !== backendEntry) {
      fail('backend package must contain exactly its declared self-contained backend executable')
    }
    const backend = files.find((file) => file.path === backendEntry)
    const backendStat = lstatSync(join(root, backendEntry), { bigint: true })
    if (!backendStat.isFile() || (process.platform !== 'win32' && (backendStat.mode & 0o111n) === 0n)) {
      fail(`backend entry '${backendEntry}' must be marked executable`)
    }
    if (!backend || backend.bytes.subarray(0, 2).equals(Buffer.from('#!')) || !backendMatchesTarget(backend.bytes, target)) {
      fail(`backend entry '${backendEntry}' does not match declared target ${target}`)
    }
  } else if (backendEntries.length !== 0) {
    fail('frontend-only package must not contain backend entries')
  }
  if (!manifest.contributes && frontendEntries.length !== 0) {
    fail('backend-only package must not contain frontend entries')
  }
}

function validateDirectory(directory, target = 'universal') {
  const root = resolve(directory)
  if (!lstatSync(root, { bigint: true }).isDirectory()) {
    fail(`package directory '${directory}' is not a directory`)
  }
  const rootRealPath = realpathSync(root)
  const manifest = readManifest(root)
  artifactTarget(manifest, target)
  const files = collectFiles(root, parseFileList(root), rootRealPath).sort((left, right) =>
    comparePortableArchivePaths(left.path, right.path)
  )
  const issue = validatePortableArchiveEntries(
    files.map((file) => ({ path: file.path, type: 'regular' }))
  )
  if (issue) {
    if (issue.kind === 'unsafe-path') {
      fail(`package entry '${issue.path}' is not a safe package-relative path`)
    }
    if (issue.kind === 'duplicate') {
      fail(`portable archive collision: '${issue.path}' duplicates another entry`)
    }
    fail(`portable archive collision: '${issue.path}' is a regular-file ancestor`)
  }
  validateFiles(manifest, files, target, root)
  return { root, manifest, files, target }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function u16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value, 0)
  return buffer
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

/** Write one deflated (method 8, level 9) ZIP with fixed metadata.
 *
 * Fixed timestamps, modes, and deflate level keep one canonical file list
 * reproducible: rebuilding the same tree yields the same bytes, so the signed
 * digest it produces can be rebuilt. The registry's Python builder
 * (`registry.package.build_package`) applies the same method and level; whether
 * the two match byte-for-byte also depends on their zlib implementations. */
function makeZip(files) {
  const local = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const checksum = crc32(file.bytes)
    const deflated = deflateRawSync(file.bytes, { level: 9 })
    const header = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(8),
      u16(0x21),
      u16(0),
      u32(checksum),
      u32(deflated.length),
      u32(file.bytes.length),
      u16(name.length),
      u16(0),
      name,
      deflated,
    ])
    local.push(header)
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(0x0314),
        u16(20),
        u16(0x0800),
        u16(8),
        u16(0x21),
        u16(0),
        u32(checksum),
        u32(deflated.length),
        u32(file.bytes.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32((file.executable ? 0o100755 : 0o100644) << 16),
        u32(offset),
        name,
      ])
    )
    offset += header.length
  }
  const centralBytes = Buffer.concat(central)
  const localBytes = Buffer.concat(local)
  return Buffer.concat([
    localBytes,
    centralBytes,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBytes.length),
    u32(localBytes.length),
    u16(0),
  ])
}

/** The archive `package` writes for a validated directory. */
function archiveOf(result) {
  return makeZip(result.files.map((file) => ({
    ...file,
    executable: result.manifest.backend && backendEntryForTarget(result.manifest.backend.entry, result.target) === file.path,
  })))
}

function packageDirectory(directory, output, target) {
  const result = validateDirectory(directory, target)
  const outputPath = resolve(output ?? `${result.manifest.id}-${result.manifest.version}-${result.target}.vsix`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, archiveOf(result))
  return { outputPath, manifest: result.manifest, target: result.target }
}

/** Scan a .vsix, or a directory as `package` would build it. A package
 *  without a native backend is universal; one with a backend defaults to the
 *  build host's target, as `package` does. */
function scanPath(path, targetOption) {
  if (lstatSync(resolve(path), { bigint: true }).isDirectory()) {
    const result = validateDirectory(path, targetOption ?? 'universal')
    return scanFiles({
      files: new Map(result.files.map((file) => [file.path, file.bytes])),
      artifactDigest: createHash('sha256').update(archiveOf(result)).digest('hex'),
      target: result.target,
    })
  }
  const bytes = readRegularFileNoFollow(path)
  const files = readZipEntries(bytes)
  const manifest = files.has('manifest.json') ? parseManifestJson(decodeUtf8(files.get('manifest.json'), 'manifest.json')) : null
  return scanFiles({
    files,
    artifactDigest: createHash('sha256').update(bytes).digest('hex'),
    target: targetOption ?? (manifest?.backend ? `${process.platform}-${process.arch}` : 'universal'),
  })
}

/** The navide://publish link that opens Navide's publish form with this package (agreed with the App's W3 form). */
function navidePublishLink(packagePath, target) {
  const path = realpathSync(resolve(packagePath))
  if (!lstatSync(path, { bigint: true }).isFile()) fail(`package '${packagePath}' must be a regular file`)
  if (!path.endsWith('.vsix')) fail(`--via-navide hands over a .vsix package; build one with \`navide-plugin package\``)
  if (path.length > 1024) fail('the package path is longer than 1024 characters; move the .vsix to a shorter path')
  if (target !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(target)) fail(`target '${target}' is not a package target such as 'universal' or 'darwin-arm64'`)
  return `navide://publish?path=${encodeURIComponent(path)}${target === undefined ? '' : `&target=${encodeURIComponent(target)}`}`
}

/** A Registry error as one line: its stable code and message when it sends one. */
function registryFailure(registry, path, status, body) {
  const detail = body?.detail
  if (status === 404 && detail === 'Not Found') return `${registry} does not offer ${path}; it predates this command`
  if (detail && typeof detail === 'object' && typeof detail.code === 'string') {
    return `${registry} refused (${status} ${detail.code}): ${detail.message ?? ''}`
  }
  return `${registry} refused (${status})${typeof detail === 'string' ? `: ${detail}` : ''}`
}

function statusLines(body) {
  if (!body.items.length) return [`No versions submitted${body.namespace ? ` in ${body.namespace}` : ''} yet.`]
  const lines = []
  for (const item of body.items) {
    const state = item.yanked ? 'yanked' : item.status
    const channel = item.channel && item.channel !== 'stable' ? ` [${item.channel}]` : ''
    lines.push(`${item.identity}@${item.version}${channel}  ${state}  ${item.targets.join(', ')}  submitted ${item.submitted_at}`)
    if (item.status === 'rejected' && item.reason) lines.push(`  reason: ${item.reason}`)
    if (item.status === 'pending') lines.push('  waiting for review; the scan summary appears once it is approved')
    for (const [target, scan] of Object.entries(item.scan_by_target ?? {})) {
      if (!scan || scan.risk === null) continue
      const undeclared = scan.declared_vs_scanned?.undeclared ?? []
      lines.push(`  ${target}: risk ${scan.risk}${undeclared.length ? `; found but not declared: ${undeclared.map((entry) => `${entry.kind} ${entry.key}`).join(', ')}` : ''}`)
    }
  }
  return lines
}

function packageDigest(path) {
  return createHash('sha256').update(readRegularFileNoFollow(path)).digest('hex')
}

function readKey(path, label, requireOwnerOnly) {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile()) fail(`${label} must be a regular file`)
  // NTFS reports 0o666 for every file, so the owner-only bits describe only a POSIX fs.
  if (requireOwnerOnly && process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n) {
    fail(`${label} must have owner-only permissions`)
  }
  return readRegularFileNoFollow(path)
}

function signPackage(packagePath, privateKeyPath, output) {
  const digest = packageDigest(packagePath)
  const signature = signDigest(null, Buffer.from(digest, 'ascii'), createPrivateKey(readKey(privateKeyPath, 'private key', true))).toString('base64')
  const outputPath = resolve(output ?? `${packagePath}.sig`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${signature}\n`, { mode: 0o600 })
  return { outputPath, digest }
}

function verifyPackage(packagePath, publicKeyPath, signaturePath) {
  const digest = packageDigest(packagePath)
  const signature = readRegularFileNoFollow(signaturePath).toString('utf8').trim()
  if (!signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) fail('signature must be base64')
  if (!verifyDigest(null, Buffer.from(digest, 'ascii'), createPublicKey(readKey(publicKeyPath, 'public key', false)), Buffer.from(signature, 'base64'))) {
    fail('signature does not verify the complete archive digest')
  }
  return digest
}

/** Ed25519 keypair as <name>.key (PKCS#8, 0600, never overwritten) and
 *  <name>.pub (SPKI): the formats the Registry and `sign` read. */
function generateKeys(outDir, name) {
  const keys = generateKeyPairSync('ed25519')
  mkdirSync(outDir, { recursive: true })
  const privatePath = resolve(outDir, `${name}.key`)
  const publicPath = resolve(outDir, `${name}.pub`)
  const fd = openSync(privatePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
  try {
    writeSync(fd, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  } finally {
    closeSync(fd)
  }
  writeFileSync(publicPath, keys.publicKey.export({ type: 'spki', format: 'pem' }))
  return { privatePath, publicPath }
}

function usage() {
  return [
    'Usage:',
    '  navide-plugin init <directory> --id <namespace.name> [--name <display name>]',
    '  navide-plugin validate <directory> [--target <target>]',
    '  navide-plugin scan <package.vsix | directory> [--target <target>] [--json]',
    '  navide-plugin package <directory> [--target <target>] [--out <file>]',
    '  navide-plugin keygen [--out-dir <directory>] [--name <name>]',
    '  navide-plugin sign <package> --key <private-key> [--out <signature>]',
    '  navide-plugin verify <package> --key <public-key> --signature <signature>',
    '  navide-plugin login [--registry <url>] [--label <label>] [--no-browser] [--insecure-http]',
    '  navide-plugin whoami [--registry <url>]',
    '  navide-plugin status [<namespace.name>[@<version>]] [--registry <url>] [--json]',
    '  navide-plugin logout [--registry <url>]',
    '  navide-plugin publish <package> [--registry <url>] [--target <target>] [--signature <file-or-value>] [--channel testplace] [--insecure-http]',
    '  navide-plugin publish <package.vsix> --via-navide [--target <target>] [--no-browser]',
    '  navide-plugin testplace invite|code|versions|revoke|promote ... (run `navide-plugin testplace` for details)',
    '  navide-plugin dev-backend <directory> [--call <method>] [--args <json>] [--subscribe <event,...>] [--data <directory>]',
    '',
    `The registry defaults to $NAVIDE_REGISTRY_URL, then https://server.navide.dev/registry.`,
    'publish, whoami and status read the token from NAVIDE_PLUGIN_TOKEN, then `navide-plugin login`. Registries must use https unless they are on loopback.',
    'publish --via-navide hands the package to the running Navide, where you sign in and submit it; the CLI reads no token.',
  ].join('\n')
}

// command -> [positional argument count, value options, boolean flags, positional is optional]
const COMMANDS = {
  init: [1, ['--id', '--name'], []],
  validate: [1, ['--target'], []],
  scan: [1, ['--target'], ['--json']],
  package: [1, ['--target', '--out'], []],
  keygen: [0, ['--out-dir', '--name'], []],
  sign: [1, ['--key', '--out'], []],
  verify: [1, ['--key', '--signature'], []],
  login: [0, ['--registry', '--label'], ['--no-browser', '--insecure-http']],
  whoami: [0, ['--registry'], []],
  status: [1, ['--registry'], ['--json'], true],
  logout: [0, ['--registry'], []],
  publish: [1, ['--registry', '--target', '--signature', '--token', '--channel'], ['--insecure-http', '--via-navide', '--no-browser']],
  'dev-backend': [1, ['--call', '--args', '--subscribe', '--data'], []],
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const spec = COMMANDS[command]
  if (!spec) fail(usage())
  const [declaredCount, valueOptions, flags, optional] = spec
  const positionalCount = optional && (rest[0] === undefined || rest[0].startsWith('--')) ? 0 : declaredCount
  const positional = rest.slice(0, positionalCount)
  if (positional.length !== positionalCount || positional.some((value) => value.startsWith('--'))) fail(usage())
  const options = new Map()
  for (let index = positionalCount; index < rest.length; index += 1) {
    const key = rest[index]
    if (options.has(key)) fail(usage())
    if (flags.includes(key)) {
      options.set(key, true)
    } else if (valueOptions.includes(key) && rest[index + 1] !== undefined) {
      options.set(key, rest[index + 1])
      index += 1
    } else {
      fail(usage())
    }
  }
  return { command, positional, options }
}

/** The version the Registry recorded, from its publish response body. */
function publishedVersion(body) {
  try {
    const version = JSON.parse(body)?.version
    return typeof version === 'string' ? version : ''
  } catch {
    return ''
  }
}

/** SemVer pre-release suffix (build metadata is not one). */
function isPrereleaseVersion(version) {
  return version.split('+', 1)[0].includes('-')
}

async function main(argv) {
  // Subcommands with their own arguments (testplace.mjs).
  if (argv[0] === 'testplace') return runTestplace(argv.slice(1))
  const { command, positional, options } = parseArgs(argv)
  const [argument] = positional
  if (command === 'init') {
    if (!options.get('--id')) fail(usage())
    const result = initPlugin(argument, options.get('--id'), options.get('--name'))
    console.log(`Created ${result.id} (${result.name}) in ${result.root}`)
    console.log(`Next: navide-plugin validate ${argument}`)
    return
  }
  if (command === 'validate') {
    const result = validateDirectory(argument, options.get('--target') ?? 'universal')
    console.log(`Validated ${result.manifest.id}@${result.manifest.version} for ${result.target}`)
    return
  }
  if (command === 'package') {
    const result = packageDirectory(argument, options.get('--out'), options.get('--target') ?? 'universal')
    console.log(`Packaged ${result.manifest.id}@${result.manifest.version} for ${result.target} to ${result.outputPath}`)
    return
  }
  if (command === 'keygen') {
    const result = generateKeys(options.get('--out-dir') ?? '.', options.get('--name') ?? 'publisher')
    console.log(`private key: ${result.privatePath}`)
    console.log(`public key:  ${result.publicPath}`)
    return
  }
  if (command === 'sign') {
    if (!options.get('--key')) fail(usage())
    const result = signPackage(argument, options.get('--key'), options.get('--out'))
    console.log(`Signed complete archive digest ${result.digest} to ${result.outputPath}`)
    return
  }
  if (command === 'verify') {
    if (!options.get('--key') || !options.get('--signature')) fail(usage())
    const digest = verifyPackage(argument, options.get('--key'), options.get('--signature'))
    console.log(`Verified complete archive digest ${digest}`)
    return
  }
  if (command === 'dev-backend') {
    process.exitCode = await runDevBackend(argument, readManifest(argument), {
      call: options.get('--call'),
      args: options.get('--args'),
      subscribe: (options.get('--subscribe') ?? '').split(',').filter(Boolean),
      dataDir: options.get('--data'),
    })
    return
  }
  if (command === 'scan') {
    const scanned = scanPath(argument, options.get('--target'))
    if (options.get('--json') === true) console.log(JSON.stringify(scanned, null, 2))
    else for (const line of formatScan(scanned)) console.log(line)
    return
  }
  if (command === 'publish' && options.get('--via-navide') === true) {
    for (const option of ['--registry', '--token', '--signature', '--insecure-http']) {
      if (options.has(option)) fail(`--via-navide cannot be combined with ${option}: Navide's publish form chooses the registry, signs you in and submits`)
    }
    // Navide's publish form has no channel: a Testplace build handed over
    // would go to ordinary Marketplace review and be public once approved.
    if (options.has('--channel')) {
      fail(`--via-navide cannot be combined with --channel: Navide's publish form sends every build to Marketplace review, where an approved build is public. Publish a Testplace build directly with \`navide-plugin publish ${argument} --channel testplace\` (it reads your publisher token).`)
    }
    const link = navidePublishLink(argument, options.get('--target'))
    console.log(`Handing ${argument} to Navide: ${link}`)
    if (options.get('--no-browser') !== true) openBrowser(link)
    console.log('Review and submit it in Navide\'s publish form; the CLI sends nothing and reads no token. If Navide did not open, open the link above. Afterwards, `navide-plugin status` shows the review.')
    return
  }
  if (options.has('--no-browser') && command === 'publish') fail('--no-browser applies to publish --via-navide only')
  const registry = registryUrl(options.get('--registry'))
  if (command === 'login' || command === 'publish') {
    assertSecureTransport(registry, { insecureHttp: options.get('--insecure-http') === true })
  }
  if (command === 'login') {
    const { entry, path } = await login(registry, {
      label: options.get('--label') ?? 'navide-plugin CLI',
      noBrowser: options.get('--no-browser') === true,
    })
    console.log(`Logged in to ${registry} as ${entry.namespace}; token expires ${entry.expires_at} (saved to ${path}).`)
    return
  }
  if (command === 'whoami') {
    const resolved = resolveToken(registry)
    if (!resolved) fail(`not logged in to ${registry}; run \`navide-plugin login --registry ${registry}\``)
    if (!resolved.entry) {
      // NAVIDE_PLUGIN_TOKEN, which publish would send: only the Registry knows whose it is.
      assertSecureTransport(registry)
      const { status, body } = await getJson(registry, '/api/publisher/me', resolved.token)
      if (status !== 200 || !body) fail(registryFailure(registry, '/api/publisher/me', status, body))
      console.log(`${body.namespace} on ${registry}; token from ${TOKEN_ENV} ${body.token_expires_at ? `expires ${body.token_expires_at}` : 'does not expire'}`)
      if (body.qualification && body.qualification !== 'approved') console.log(`developer qualification: ${body.qualification}`)
      if (body.frozen) console.log(`${body.namespace} is frozen: it cannot publish`)
      return
    }
    const entry = resolved.entry
    // The Registry writes expires_at as naive UTC; read an offset-less value as UTC.
    const expiresAt = typeof entry.expires_at === 'string' && !/(?:Z|[+-]\d\d:\d\d)$/i.test(entry.expires_at) ? `${entry.expires_at}Z` : entry.expires_at
    const expired = expiresAt && Date.parse(expiresAt) <= Date.now()
    console.log(`${entry.namespace} on ${registry}; token ${expired ? 'expired' : 'expires'} ${entry.expires_at}`)
    if (expired) process.exitCode = 1
    return
  }
  if (command === 'status') {
    const resolved = resolveToken(registry)
    if (!resolved) fail(`status needs ${TOKEN_ENV} or \`navide-plugin login --registry ${registry}\``)
    assertSecureTransport(registry)
    const query = new URLSearchParams()
    if (argument) {
      const [extension, version] = argument.split('@', 2)
      query.set('extension', extension)
      if (version) query.set('version', version)
    }
    const path = `/api/publisher/me/versions${argument ? `?${query}` : ''}`
    const { status, body } = await getJson(registry, path, resolved.token)
    if (status !== 200 || !body || !Array.isArray(body.items)) fail(registryFailure(registry, '/api/publisher/me/versions', status, body))
    if (options.get('--json') === true) console.log(JSON.stringify(body, null, 2))
    else for (const line of statusLines(body)) console.log(line)
    return
  }
  if (command === 'logout') {
    const removed = removeCredentials(registry)
    console.log(
      removed
        ? `Removed the stored token for ${registry} from ${credentialsPath()}. Revoke it on the publisher dashboard to invalidate it on the registry.`
        : `No stored token for ${registry}.`,
    )
    return
  }
  if (options.has('--token')) {
    console.error('navide-plugin: warning: --token is visible in the process list and shell history; set NAVIDE_PLUGIN_TOKEN or run `navide-plugin login` instead')
  }
  const target = options.get('--target') ?? 'universal'
  console.log(`Publishing ${argument} (${target}) to ${registry}`)
  const result = await publish(registry, argument, {
    target,
    signature: options.get('--signature'),
    token: options.get('--token'),
    channel: options.get('--channel'),
  })
  console.log(`${result.status} ${result.body}`)
  if (result.status < 200 || result.status >= 300) process.exitCode = 1
  else if (options.get('--channel') === 'testplace') {
    console.log(
      'This is a Testplace build: only testers you invite can install it, and it expires in 90 days. Invite them with `navide-plugin testplace invite add`.',
    )
  } else if (isPrereleaseVersion(publishedVersion(result.body))) {
    console.log(
      'This version is a pre-release: it will be public to everyone who turns on Get pre-releases for this Navide plugin, and it goes through review. To test with specific people only, publish with --channel testplace instead.',
    )
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`navide-plugin: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
