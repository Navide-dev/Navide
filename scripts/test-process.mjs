import { execFileSync } from 'node:child_process'
import { delimiter, dirname } from 'node:path'

export function testEnvironment(overrides = {}) {
  const env = {
    ...process.env,
    ...overrides,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
  }
  // Artifact identity must match the production build, even from a test caller.
  delete env.NODE_ENV
  return env
}

export function run(command, args, env = testEnvironment()) {
  console.log(`> ${command} ${args.join(' ')}`)
  try {
    execFileSync(command, args, { stdio: 'inherit', env })
  } catch (error) {
    process.exit(typeof error.status === 'number' ? error.status : 1)
  }
}

export function pnpm(args) {
  // Under Bun the same `run <script>` arguments go to Bun itself. On Windows
  // process.execPath can be Bun's generated `node` shim, which parses argv with
  // Node semantics, so resolve the real Bun CLI.
  if (process.versions.bun) return run(globalThis.Bun?.which('bun') ?? process.execPath, args)
  // Windows .cmd shims cannot be passed to execFile. Package scripts inherit
  // the actual pnpm entrypoint; NAVIDE_PNPM supports an explicit local toolchain.
  const entry = process.env.NAVIDE_PNPM ?? process.env.npm_execpath
  if (!entry) throw new Error('Run this entrypoint through pnpm, or set NAVIDE_PNPM')
  if (/\.(?:m?js|cjs)$/.test(entry)) run(process.execPath, [entry, ...args])
  else run(entry, args)
}
