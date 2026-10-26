import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BuiltinRemovedEarlierStore,
  migrateBuiltinRemovalsToDisabled,
  PluginDisabledStore,
} from './pluginDisabledStore'
import { PluginFactoryOptOutStore } from './pluginFactoryOptOutStore'

function stores(root: string) {
  return {
    optOuts: new PluginFactoryOptOutStore(root),
    disabled: new PluginDisabledStore(root),
    removedEarlier: new BuiltinRemovedEarlierStore(root),
  }
}

describe('upgrading a removed built-in to Disabled', () => {
  it('turns a recorded Git or Mini-IDE removal into Disabled, once', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-builtin-migration-'))
    try {
      new PluginFactoryOptOutStore(root).add('navide.git')
      const warn = vi.fn()

      expect(migrateBuiltinRemovalsToDisabled(stores(root), ['navide.git', 'navide.mini-ide'], warn))
        .toEqual(['navide.git'])
      // As a later launch sees it: the opt-out is gone, the switch and the
      // "data was deleted by that removal" record stay.
      const next = stores(root)
      expect(next.optOuts.has('navide.git')).toBe(false)
      expect(next.disabled.has('navide.git')).toBe(true)
      expect(next.removedEarlier.has('navide.git')).toBe(true)
      expect(next.disabled.has('navide.mini-ide')).toBe(false)
      expect(migrateBuiltinRemovalsToDisabled(next, ['navide.git', 'navide.mini-ide'], warn)).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves a user who never removed anything untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-builtin-migration-'))
    try {
      expect(migrateBuiltinRemovalsToDisabled(stores(root), ['navide.git', 'navide.mini-ide'], vi.fn())).toEqual([])
      expect(stores(root).disabled.has('navide.git')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the opt-out when the switch cannot be written', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-builtin-migration-'))
    try {
      new PluginFactoryOptOutStore(root).add('navide.mini-ide')
      const failing = stores(root)
      vi.spyOn(failing.disabled, 'add').mockImplementation(() => { throw new Error('read-only') })
      const warn = vi.fn()
      expect(migrateBuiltinRemovalsToDisabled(failing, ['navide.mini-ide'], warn)).toEqual([])
      expect(stores(root).optOuts.has('navide.mini-ide')).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('read-only'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
