#!/usr/bin/env node
// Decides which CI job groups a pull request needs, from the files it changes.
//
// The suites read across the frontend/backend line (frontend tests read
// backend/agent_team_backend/*.py, backend tests read src/main and parts of
// src/renderer), so the rule is an allowlist, never a guess: a group is
// skipped only when every changed file is on the other side's allowlist.
// Anything unlisted, an empty diff, a diff that cannot be read, and every
// event other than a pull request run everything.
// tests/infrastructure/ciPathFilter.test.ts ratchets the allowlists against
// what the other suite actually reads.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Changes here cannot affect the backend suites (backend jobs may be skipped).
export const FRONTEND_ONLY = ['src/renderer/', 'src/preload/', 'e2e/']

// Inside FRONTEND_ONLY, but read by backend tests or backend code.
export const FRONTEND_SHARED = [
  'src/renderer/plugins/',
  'src/renderer/src/platform/plugin-shell/',
  'src/renderer/src/components/AccountModal.vue',
  'src/renderer/src/components/CliAgentsHelp.vue',
  'src/renderer/src/composables/useResourceLimits.ts',
  'src/renderer/src/lib/__tests__/fixtures/n8n-forged-signals.json',
  'src/renderer/src/lib/promptSkillSeed.ts',
  'src/renderer/src/main.ts',
]

// Changes here cannot affect the frontend or build suites (those jobs may be
// skipped). Frontend tests read backend/agent_team_backend directly and the
// CLI suite starts the real backend, so only the backend's own tests qualify.
export const BACKEND_ONLY = ['backend/tests/']

// Inside BACKEND_ONLY, but imported by the frontend CLI suite
// (tests/cli/backendWire.test.ts drives the backend through this harness).
export const BACKEND_SHARED = [
  'backend/tests/__init__.py',
  'backend/tests/cli_regression/__init__.py',
  'backend/tests/cli_regression/support/',
]

const matches = (file, patterns) =>
  patterns.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p))

export function isFrontendOnly(file) {
  return matches(file, FRONTEND_ONLY) && !matches(file, FRONTEND_SHARED)
}

export function isBackendOnly(file) {
  return matches(file, BACKEND_ONLY) && !matches(file, BACKEND_SHARED)
}

/** @returns {{ backend: boolean, frontend: boolean }} which groups must run */
export function scopes({ event, files }) {
  if (event !== 'pull_request' || !files || files.length === 0) return { backend: true, frontend: true }
  return {
    backend: !files.every(isFrontendOnly),
    frontend: !files.every(isBackendOnly),
  }
}

function changedFiles() {
  // The pull_request checkout is the merge commit: its first parent is the
  // base branch, so this is exactly what the merge would change.
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], { encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

function main() {
  const event = process.env.GITHUB_EVENT_NAME ?? ''
  let files = null
  if (event === 'pull_request') {
    try {
      files = changedFiles()
    } catch (error) {
      process.stdout.write(`could not list changed files, running everything: ${error.message}\n`)
    }
  }
  const result = scopes({ event, files })
  process.stdout.write(`event=${event} changed=${files?.length ?? 'unknown'}\n`)
  for (const file of files ?? []) {
    const side = isFrontendOnly(file) ? 'frontend-only' : isBackendOnly(file) ? 'backend-only' : 'shared'
    process.stdout.write(`  ${side.padEnd(13)} ${file}\n`)
  }
  process.stdout.write(`backend=${result.backend}\nfrontend=${result.frontend}\n`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `backend=${result.backend}\nfrontend=${result.frontend}\n`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
