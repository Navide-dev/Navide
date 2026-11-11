import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { packagedBackendBinary } from './backend-binary'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function resources(): string {
  const d = mkdtempSync(join(tmpdir(), 'navide-backend-binary-'))
  made.push(d)
  mkdirSync(join(d, 'bin'))
  return d
}

describe('packagedBackendBinary', () => {
  it('runs the executable inside a onedir bundle', () => {
    const r = resources()
    mkdirSync(join(r, 'bin', 'agent_team_backend', '_internal'), { recursive: true })
    expect(packagedBackendBinary(r, false)).toBe(join(r, 'bin', 'agent_team_backend', 'agent_team_backend'))
    expect(packagedBackendBinary(r, true)).toBe(join(r, 'bin', 'agent_team_backend', 'agent_team_backend.exe'))
  })

  it('falls back to a single-file build', () => {
    const r = resources()
    writeFileSync(join(r, 'bin', 'agent_team_backend'), '')
    expect(packagedBackendBinary(r, false)).toBe(join(r, 'bin', 'agent_team_backend'))
  })

  it('names the Windows single-file exe when nothing is there', () => {
    const r = resources()
    expect(packagedBackendBinary(r, true)).toBe(join(r, 'bin', 'agent_team_backend.exe'))
  })
})
