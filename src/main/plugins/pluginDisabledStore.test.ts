import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  describe('a damaged store', () => {
    const file = (root: string) => join(root, DISABLED_PLUGINS_FILE)
    const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    it('keeps a backup of every write', () => {
      const root = mkdtempSync(join(tmpdir(), 'navide-plugin-disabled-'))
      try {
        new PluginDisabledStore(root).add('navide.plans')
        new PluginDisabledStore(root).add('acme.demo')
        expect(JSON.parse(readFileSync(`${file(root)}.bak`, 'utf8')).pluginIds).toEqual(['navide.plans', 'acme.demo'])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('restores from the backup, sets the damaged file aside and says so', () => {
      const root = mkdtempSync(join(tmpdir(), 'navide-plugin-disabled-'))
      const warn = quiet()
      try {
        new PluginDisabledStore(root).add('navide.git')
        new PluginDisabledStore(root).add('acme.demo')
        writeFileSync(file(root), '{torn', { mode: 0o600 })

        const store = new PluginDisabledStore(root)
        expect(store.has('navide.git')).toBe(true)
        expect(store.has('acme.demo')).toBe(true)
        expect(store.status()).toBe('restored')
        expect(JSON.parse(readFileSync(file(root), 'utf8')).pluginIds).toEqual(['navide.git', 'acme.demo'])
        const aside = readdirSync(root).filter((name) => name.startsWith(`${DISABLED_PLUGINS_FILE}.corrupt-`))
        expect(aside).toHaveLength(1)
        expect(readFileSync(join(root, aside[0]), 'utf8')).toBe('{torn')
        // Adding after the restore keeps every other entry.
        store.add('navide.plans')
        expect(new PluginDisabledStore(root).has('acme.demo')).toBe(true)
      } finally {
        warn.mockRestore()
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('fails closed for the built-ins only when neither copy can be read, and never overwrites it', () => {
      const root = mkdtempSync(join(tmpdir(), 'navide-plugin-disabled-'))
      const warn = quiet()
      try {
        writeFileSync(file(root), '{torn', { mode: 0o600 })
        writeFileSync(`${file(root)}.bak`, 'also torn', { mode: 0o600 })
        const store = new PluginDisabledStore(root)
        expect(store.status()).toBe('unreadable')
        for (const id of ['navide.plans', 'navide.git', 'navide.mini-ide']) expect(store.has(id)).toBe(true)
        // Marketplace packages read as before: enabled.
        expect(store.has('acme.demo')).toBe(false)
        expect(() => store.add('acme.demo')).toThrow(/unreadable/)
        expect(() => store.remove('navide.git')).toThrow(/unreadable/)
        expect(readFileSync(file(root), 'utf8')).toBe('{torn')

        store.resetUnreadable()
        expect(store.status()).toBe('ok')
        expect(store.has('navide.git')).toBe(false)
        expect(readdirSync(root).filter((name) => name.includes('.corrupt-'))).toHaveLength(2)
      } finally {
        warn.mockRestore()
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('sees a write by another handle on the same file', () => {
      const root = mkdtempSync(join(tmpdir(), 'navide-plugin-disabled-'))
      try {
        const reader = new PluginDisabledStore(root)
        expect(reader.has('navide.plans')).toBe(false)
        new PluginDisabledStore(root).add('navide.plans')
        expect(reader.has('navide.plans')).toBe(true)
        new PluginDisabledStore(root).remove('navide.plans')
        expect(reader.has('navide.plans')).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
