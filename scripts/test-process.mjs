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
  // Under `bun run` on Windows, process.execPath can be Bun's generated `node`
  // shim, which parses argv with Node semantics; resolve the real Bun CLI.
  run(globalThis.Bun?.which('bun') ?? process.execPath, args)
}
