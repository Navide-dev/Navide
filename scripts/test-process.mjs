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

export function bun(args) {
  // Run package scripts on Bun itself. On Windows process.execPath can be Bun's
  // generated `node` shim, which parses argv with Node semantics, so resolve the
  // real Bun CLI.
  if (!process.versions.bun) throw new Error('Run this entrypoint through Bun (`bun run <script>`)')
  return run(globalThis.Bun?.which('bun') ?? process.execPath, args)
}
