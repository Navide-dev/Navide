import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginFactoryOptOutStore } from './pluginFactoryOptOutStore'

describe('PluginFactoryOptOutStore', () => {
  it('persists a factory-package opt-out until it is explicitly restored', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-opt-outs-'))
    try {
      const store = new PluginFactoryOptOutStore(root)
      store.add('navide.git')

      expect(new PluginFactoryOptOutStore(root).has('navide.git')).toBe(true)

      new PluginFactoryOptOutStore(root).remove('navide.git')
      expect(new PluginFactoryOptOutStore(root).has('navide.git')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('warns and treats malformed state as not opted out, never overwriting it until an explicit reset', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-opt-outs-'))
    try {
      const file = join(root, '.navide-factory-plugin-opt-outs.json')
      writeFileSync(file, '{not-json', {
        mode: 0o600,
      })

      const store = new PluginFactoryOptOutStore(root)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      expect(store.has('navide.git')).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable plugin id store'))
      // A change on an unreadable store is refused rather than dropping entries.
      expect(() => store.remove('navide.git')).toThrow(/unreadable/)
      expect(readFileSync(file, 'utf8')).toBe('{not-json')
      store.resetUnreadable()
      expect(new PluginFactoryOptOutStore(root).has('navide.git')).toBe(false)
      expect(new PluginFactoryOptOutStore(root).status()).toBe('ok')
      warn.mockRestore()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('warns once when the store becomes unreadable and once when it reads again', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-opt-outs-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const file = join(root, '.navide-factory-plugin-opt-outs.json')
      writeFileSync(file, '{not-json', { mode: 0o600 })
      const store = new PluginFactoryOptOutStore(root)
      for (let i = 0; i < 3; i += 1) store.has('navide.git')
      new PluginFactoryOptOutStore(root).has('navide.git')
      expect(warn).toHaveBeenCalledTimes(1)
      store.resetUnreadable()
      store.has('navide.git')
      store.has('navide.git')
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('readable again'))
    } finally {
      warn.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
