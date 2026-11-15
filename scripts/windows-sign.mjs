// electron-builder custom sign hook (win.signtoolOptions.sign) for SSL.com
// eSigner. The release jobs pass it on the command line only when the
// WINDOWS_SIGNING switch is on (see scripts/windows-signing.mjs), so an
// unsigned build never loads this file.
//
// electron-builder calls it once per file and hash pass; package.json keeps a
// single sha256 pass, so each file costs one eSigner signature. CodeSignTool
// has been known to exit 0 after a failed signing, so the file's signature is
// read back afterwards and anything but a valid signature from the expected
// publisher throws, failing the build.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { codeSignToolArgs, readSignatures, redact, resolveSigning, signatureProblems } from './windows-signing.mjs'

function findOne(dir, test, what) {
  const hits = readdirSync(dir).filter(test)
  if (hits.length !== 1) throw new Error(`windows-sign: expected one ${what} in ${dir}, found ${hits.length}`)
  return join(dir, hits[0])
}

export async function sign(configuration) {
  const env = process.env
  const { enabled, provider } = resolveSigning(env)
  if (!enabled || provider !== 'esigner') throw new Error('windows-sign: loaded without WINDOWS_SIGNING=esigner')
  const toolDir = env.CODESIGNTOOL_DIR
  if (!toolDir) throw new Error('windows-sign: CODESIGNTOOL_DIR is not set (the "Install CodeSignTool" step did not run)')

  const java = join(findOne(toolDir, (name) => name.startsWith('jdk'), 'bundled JDK'), 'bin', 'java.exe')
  const jar = findOne(join(toolDir, 'jar'), (name) => name.startsWith('code_sign_tool') && name.endsWith('.jar'), 'CodeSignTool jar')
  const file = configuration.path
  // cwd: CodeSignTool reads conf/code_sign_tool.properties relative to it.
  const run = spawnSync(java, codeSignToolArgs(jar, file, env), { cwd: toolDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const output = redact(`${run.stdout ?? ''}${run.stderr ?? ''}`, env).trim()
  if (output) console.log(output)
  if (run.error) throw new Error(`windows-sign: could not run CodeSignTool: ${run.error.message}`)
  if (run.status !== 0) throw new Error(`windows-sign: CodeSignTool exited ${run.status} for ${file}`)

  const problems = signatureProblems(readSignatures([file]), env.WINDOWS_PUBLISHER_NAME)
  if (problems.length > 0) throw new Error(`windows-sign: ${problems.join('; ')}`)
}

export default sign
