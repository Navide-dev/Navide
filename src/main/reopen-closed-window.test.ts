import { describe, expect, it } from 'vitest'
import { planReopen } from './reopen-closed-window'

const bounds = { x: 1, y: 2, width: 900, height: 700 }
const entry = { workspace_path: '/ws/a', adopted_workspaces: ['/ws/b', '/ws/c'], bounds }

describe('planReopen', () => {
  it('reopens every workspace in one window with the saved bounds', () => {
    expect(planReopen(entry, { exists: () => true, isOpen: () => false })).toEqual({
      open: { workspace_path: '/ws/a', adopted_workspaces: ['/ws/b', '/ws/c'], bounds },
      focus: [],
      missing: [],
    })
  })

  it('focuses a workspace already open elsewhere instead of opening it twice', () => {
    const plan = planReopen(entry, { exists: () => true, isOpen: (p) => p === '/ws/b' })
    expect(plan.open).toEqual({ workspace_path: '/ws/a', adopted_workspaces: ['/ws/c'], bounds })
    expect(plan.focus).toEqual(['/ws/b'])
  })

  it('skips a folder that is gone and promotes the next one when the main one is gone', () => {
    const plan = planReopen(entry, { exists: (p) => p !== '/ws/a', isOpen: () => false })
    expect(plan.open).toEqual({ workspace_path: '/ws/b', adopted_workspaces: ['/ws/c'], bounds })
    expect(plan.missing).toEqual(['/ws/a'])
  })

  it('opens nothing when every workspace is open or gone', () => {
    const plan = planReopen(entry, { exists: (p) => p !== '/ws/c', isOpen: (p) => p !== '/ws/c' })
    expect(plan).toEqual({ open: null, focus: ['/ws/a', '/ws/b'], missing: ['/ws/c'] })
  })
})
