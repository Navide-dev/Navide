import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_RECENTLY_CLOSED, parseRegistryDoc, WindowRegistry } from './window-registry'

describe('WindowRegistry recently closed windows', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'win-reg-closed-'))
    file = join(dir, 'open-windows.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const fresh = (): WindowRegistry => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    return reg
  }

  it('remembers a closed window whole: workspace, adopted workspaces and bounds', () => {
    const reg = fresh()
    reg.setWorkspace(1, '/ws/a')
    reg.setAdoptedWorkspaces(1, ['/ws/b', '/ws/c'])
    reg.setBounds(1, { x: 10, y: 20, width: 900, height: 700 })
    reg.remove(1, 1234)
    expect(reg.recentlyClosedWindows()).toEqual([{
      workspace_path: '/ws/a',
      adopted_workspaces: ['/ws/b', '/ws/c'],
      bounds: { x: 10, y: 20, width: 900, height: 700 },
      closed_at: 1234,
    }])
  })

  it('keeps the newest first and at most MAX_RECENTLY_CLOSED', () => {
    const reg = fresh()
    for (let i = 0; i < MAX_RECENTLY_CLOSED + 3; i++) {
      reg.setWorkspace(i + 1, `/ws/${i}`)
      reg.remove(i + 1, i)
    }
    const list = reg.recentlyClosedWindows()
    expect(list).toHaveLength(MAX_RECENTLY_CLOSED)
    expect(list[0].workspace_path).toBe(`/ws/${MAX_RECENTLY_CLOSED + 2}`)
    expect(list.at(-1)?.workspace_path).toBe('/ws/3')
  })

  it('does not list the same window twice', () => {
    const reg = fresh()
    reg.setWorkspace(1, '/ws/a')
    reg.remove(1, 1)
    reg.setWorkspace(2, '/ws/a')
    reg.remove(2, 2)
    expect(reg.recentlyClosedWindows().map((w) => w.closed_at)).toEqual([2])
  })

  it('records nothing for the windows a quit closes', () => {
    const reg = fresh()
    reg.setWorkspace(1, '/ws/a')
    reg.setWorkspace(2, '/ws/b')
    reg.markCleanExit()
    reg.remove(1)
    reg.remove(2)
    expect(reg.recentlyClosedWindows()).toEqual([])
  })

  it('records nothing for a detached group window, a Welcome window or an auxiliary window', () => {
    const reg = fresh()
    reg.setWorkspace(1, '/ws/a')
    reg.setDetachedGroup(1, 'g1')
    reg.remove(1)
    reg.remove(2) // never tracked: a Welcome window
    reg.addAux(3, { kind: 'plans', workspace_path: '/ws/a' })
    reg.remove(3)
    expect(reg.recentlyClosedWindows()).toEqual([])
  })

  it('survives a relaunch, and taking an entry removes it', () => {
    const reg = fresh()
    reg.setWorkspace(1, '/ws/a')
    reg.remove(1, 1)
    reg.setWorkspace(2, '/ws/b')
    reg.remove(2, 2)
    reg.markCleanExit()

    const next = fresh()
    expect(next.recentlyClosedWindows().map((w) => w.workspace_path)).toEqual(['/ws/b', '/ws/a'])
    expect(next.takeRecentlyClosed(1)?.workspace_path).toBe('/ws/a')
    expect(next.takeRecentlyClosed()?.workspace_path).toBe('/ws/b')
    expect(next.takeRecentlyClosed()).toBeNull()
    expect(parseRegistryDoc(readFileSync(file, 'utf-8')).recentlyClosed).toEqual([])
  })

  it('drops malformed and detached entries from a stored doc', () => {
    writeFileSync(file, JSON.stringify({
      version: 1, cleanExit: true, windows: [],
      recentlyClosed: [
        { workspace_path: '/ws/a', closed_at: 5 },
        { workspace_path: '' },
        { workspace_path: '/ws/d', detached_group: 'g', closed_at: 4 },
        { workspace_path: '/ws/b' },
      ],
    }))
    expect(fresh().recentlyClosedWindows()).toEqual([
      { workspace_path: '/ws/a', closed_at: 5 },
      { workspace_path: '/ws/b', closed_at: 0 },
    ])
  })
})
