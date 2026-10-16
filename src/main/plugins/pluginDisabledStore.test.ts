import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DISABLED_PLUGINS_FILE, PluginDisabledStore } from './pluginDisabledStore'
import { PluginFactoryOptOutStore } from './pluginFactoryOptOutStore'

describe('PluginDisabledStore', () => {
  it('persists a disabled plugin until it is enabled again', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-disabled-'))
    try {
      new PluginDisabledStore(root).add('acme.demo')

      expect(new PluginDisabledStore(root).has('acme.demo')).toBe(true)
      expect(new PluginDisabledStore(root).has('acme.other')).toBe(false)
      expect(existsSync(join(root, DISABLED_PLUGINS_FILE))).toBe(true)

      new PluginDisabledStore(root).remove('acme.demo')
      expect(new PluginDisabledStore(root).has('acme.demo')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps its state apart from the factory opt-outs in the same root', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-disabled-'))
    try {
      new PluginDisabledStore(root).add('acme.demo')
      new PluginFactoryOptOutStore(root).add('navide.git')

      expect(new PluginFactoryOptOutStore(root).has('acme.demo')).toBe(false)
      expect(new PluginDisabledStore(root).has('navide.git')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
