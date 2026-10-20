import { mkdtempSync, mkdirSync, existsSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceIdentityKey } from './workspace-identity'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'ws-identity-'))
  roots.push(root)
  const dir = join(root, 'proj')
  mkdirSync(dir)
  return dir
}

describe('workspaceIdentityKey', () => {
  it('gives one key to a case variant where the volume ignores case', () => {
    const dir = project()
    const variant = dir.replace(/proj$/, 'PROJ')
    if (!existsSync(variant)) return // case-sensitive volume: a different folder
    expect(workspaceIdentityKey(variant)).toBe(workspaceIdentityKey(dir))
  })

  it('gives one key to a symlink and a trailing slash', () => {
    const dir = project()
    const link = join(dir, '..', 'link')
    symlinkSync(dir, link)
    expect(workspaceIdentityKey(link)).toBe(workspaceIdentityKey(dir))
    expect(workspaceIdentityKey(`${dir}/`)).toBe(workspaceIdentityKey(dir))
  })

  it('falls back to the trimmed string for a folder that is gone', () => {
    expect(workspaceIdentityKey(' /no/such/folder/ ')).toBe('/no/such/folder')
    expect(workspaceIdentityKey('')).toBe('')
  })
})
