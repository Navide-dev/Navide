import { mkdtempSync, mkdirSync, existsSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { uniqueOpenWorkspaces, workspaceIdentityKey } from './workspace-identity'

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

describe('uniqueOpenWorkspaces', () => {
  it('lists a primary that is also adopted once, first occurrence kept in order (#448)', () => {
    expect(uniqueOpenWorkspaces(['/home/u/Navide', '/home/u', '/home/u/Navide'], 'linux')).toEqual([
      '/home/u/Navide',
      '/home/u',
    ])
  })

  it('treats a trailing slash or a dot segment as the same folder', () => {
    expect(uniqueOpenWorkspaces(['/a/proj', '/a/proj/', '/a/./proj', '/a/other'], 'darwin')).toEqual([
      '/a/proj',
      '/a/other',
    ])
  })

  it('ignores case and separator style on Windows only', () => {
    expect(uniqueOpenWorkspaces(['C:\\Work\\Proj', 'c:/work/proj/', 'C:\\Work\\Other'], 'win32')).toEqual([
      'C:\\Work\\Proj',
      'C:\\Work\\Other',
    ])
    expect(uniqueOpenWorkspaces(['/a/Proj', '/a/proj'], 'linux')).toEqual(['/a/Proj', '/a/proj'])
  })

  it('does not expand ~', () => {
    expect(uniqueOpenWorkspaces(['~/proj', '/home/u/proj'], 'linux')).toEqual(['~/proj', '/home/u/proj'])
  })
})
