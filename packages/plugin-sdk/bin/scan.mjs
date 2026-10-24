// `navide-plugin scan`: the Registry's publish-time static scan, run locally
// on a .vsix or on the files `package` would put in one. The scanner is the
// JavaScript port in @navide/plugin-contracts, held to the Registry's
// scanner by docs/plugin-contracts/static-scan-fixtures.

import { inflateRawSync } from 'node:zlib'
import { declaredVsScanned, disclosurePermissions, parseManifestJson, scanPackageFiles } from '@navide/plugin-contracts'

const MAX_ENTRY_BYTES = 50 * 1024 * 1024
const MAX_TOTAL_BYTES = 200 * 1024 * 1024

function fail(message) {
  throw new Error(message)
}

/** The regular entries of a ZIP archive (stored or deflated, no ZIP64), as path → bytes. */
export function readZipEntries(bytes) {
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 0xffff); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end === -1) fail('package is not a ZIP archive')
  const count = bytes.readUInt16LE(end + 10)
  let offset = bytes.readUInt32LE(end + 16)
  const files = new Map()
  let total = 0
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) fail('package has a damaged ZIP directory')
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const size = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const local = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (size > MAX_ENTRY_BYTES) fail(`package entry '${name}' exceeds the 50 MiB size limit`)
    total += size
    if (total > MAX_TOTAL_BYTES) fail('package entries exceed the 200 MiB size limit')
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) fail(`package entry '${name}' has a damaged ZIP header`)
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const data = bytes.subarray(start, start + compressedSize)
    if (method === 0) files.set(name, data)
    else if (method === 8) files.set(name, inflateRawSync(data, { maxOutputLength: Math.max(size, 1) }))
    else fail(`package entry '${name}' uses unsupported ZIP method ${method}`)
  }
  return files
}

/** The report and its declared-vs-scanned comparison for one package's files. */
export function scanFiles({ files, artifactDigest, target }) {
  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes) fail('package must contain manifest.json at its root')
  const manifest = parseManifestJson(Buffer.from(manifestBytes).toString('utf8'))
  const report = scanPackageFiles({ files, artifactDigest, target, manifest })
  if (report === null) fail('only Manifest v2 packages are scanned (schemaVersion 2)')
  return {
    id: manifest.id,
    version: manifest.version,
    report,
    declaredVsScanned: declaredVsScanned({ permissions: disclosurePermissions(manifest) }, report),
  }
}

const command = (call) => (call.subcommand === null ? call.executable : `${call.executable} ${call.subcommand}`)

/** Plain-text lines for a terminal. */
export function formatScan({ id, version, report, declaredVsScanned: comparison }) {
  const lines = [`Scanned ${id}@${version} for ${report.target} (scanner ${report.scanner.version}, the same rules as the Registry)`]
  const { coverage } = report
  lines.push(`  files: ${coverage.filesScanned} of ${coverage.filesTotal} scanned`)
  const incomplete = [
    ...(coverage.timedOut ? ['timed out'] : []),
    ...(coverage.truncated ? ['truncated'] : []),
    ...coverage.skipped.filter((item) => item.reason === 'scannerError' || item.reason === 'tooComplex').map((item) => `${item.reason} ×${item.count}`),
  ]
  if (incomplete.length) lines.push(`  incomplete: ${incomplete.join(', ')} (reviewers and users see an incomplete scan)`)
  const calls = report.shell.calls
  lines.push(`  shell: ${calls.length ? calls.map((call) => `${command(call)} [${call.category}, ${call.source}]`).join('; ') : 'none'}`)
  if (report.shell.dynamic.count) lines.push(`  shell commands built at run time: ${report.shell.dynamic.count}`)
  const hosts = [...new Set(report.network.hosts.map((item) => item.host))]
  lines.push(`  network hosts: ${hosts.length ? hosts.join(', ') : 'none'}`)
  if (report.files.readPaths.length) lines.push(`  reads: ${report.files.readPaths.join(', ')}`)
  if (report.files.writePaths.length) lines.push(`  writes: ${report.files.writePaths.join(', ')}`)
  if (report.files.dynamicPaths) lines.push(`  file paths built at run time: ${report.files.dynamicPaths}`)
  if (report.capabilities.length) lines.push(`  capabilities: ${report.capabilities.map((item) => item.address).join(', ')}`)
  const code = report.code.frontend
  if (code) {
    const dynamicCode = [['eval', code.eval], ['Function', code.newFunction], ['import()', code.dynamicImport], ['string timers', code.stringTimers]]
      .filter(([, value]) => value)
      .map(([label, value]) => `${label} ×${value}`)
    if (dynamicCode.length) lines.push(`  dynamic code: ${dynamicCode.join(', ')}`)
    if (code.obfuscationSignals.length) lines.push(`  obfuscation signals: ${code.obfuscationSignals.join(', ')}`)
  }
  for (const binary of report.native) {
    lines.push(`  native ${binary.path}: ${binary.format} ${binary.arch}; libraries: ${binary.libraries.join(', ') || 'none'}; notable imports: ${binary.notableImports.join(', ') || 'none'}`)
    if (binary.packer) lines.push(`    packed with ${binary.packer}: not scannable`)
    if (binary.embeddedRuntime) lines.push(`    embeds a ${binary.embeddedRuntime} runtime: its bundled code is not scanned`)
  }
  if (comparison.undeclared.length) {
    lines.push('Found but not declared in the manifest (users see these in red):')
    for (const item of comparison.undeclared) lines.push(`  ${item.kind}: ${item.key}`)
  } else lines.push('Everything found is declared in the manifest.')
  if (comparison.declaredNotSeen.length) {
    lines.push('Declared but not found by the scan:')
    for (const item of comparison.declaredNotSeen) lines.push(`  ${item.kind}: ${item.key}`)
  }
  return lines
}
