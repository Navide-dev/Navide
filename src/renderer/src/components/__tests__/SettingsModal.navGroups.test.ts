import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The settings nav is static markup in SettingsModal.vue; mounting the whole
// modal for it is not worth it, so the groups are read off the template.
const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/SettingsModal.vue'), 'utf8')

const helpSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/SettingsSystemHelp.vue'), 'utf8')

function navLabelKeys(): string[] {
  const nav = source.slice(source.indexOf('<nav class="s-nav"'), source.indexOf('</nav>', source.indexOf('<nav class="s-nav"')))
  return [...nav.matchAll(/<SettingsNavItem :label="\$t\('([\w.-]+)'\)"/g)].map((m) => m[1])
}

function navGroups(): { title: string; tabs: string[] }[] {
  const nav = source.slice(source.indexOf('<div class="s-nav-group">'), source.indexOf('</nav>', source.indexOf('<div class="s-nav-group">')))
  return nav.split('<div class="s-nav-group">').slice(1).map((block) => ({
    title: block.match(/\$t\('settings\.nav\.group\.(\w+)'\)/)![1],
    tabs: [...block.matchAll(/@select="activeTab = '([\w-]+)'"/g)].map((m) => m[1]),
  }))
}

describe('SettingsModal nav groups', () => {
  it('gives Navide Services (Cloud, plugins, marketplace) their own group between Agent Assets and System', () => {
    expect(navGroups()).toEqual([
      { title: 'general', tabs: ['general', 'appearance', 'language', 'statusBadges', 'layout', 'notifications', 'voice', 'appLock'] },
      { title: 'accountsAgents', tabs: ['accounts', 'cliAgents', 'analyzer', 'security', 'channels'] },
      { title: 'integration', tabs: ['mcp', 'skills', 'prompts', 'memory', 'credentials', 'cliExtensions'] },
      { title: 'navidePlugins', tabs: ['cross-device', 'extensions', 'marketplace'] },
      { title: 'system', tabs: ['keybindings', 'updates', 'help'] },
    ])
  })

  it('keeps the update badge on Navide Plugins', () => {
    expect(source).toMatch(/:active="activeTab === 'extensions'" :expanded="activeTab === 'extensions'" foldable :badge="pluginUpdates\.count\.value"/)
  })

  it('files the search hits of the moved pages under the new group', () => {
    for (const tab of ['cross-device', 'extensions', 'marketplace']) {
      const entries = [...source.matchAll(new RegExp(`tab: '${tab}',[\\s\\S]*?group: t\\('settings\\.nav\\.group\\.(\\w+)'\\)`, 'g'))]
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) expect(entry[1]).toBe('navidePlugins')
    }
  })

  it('files the search hits of Credentials and Extensions under Agent Assets', () => {
    for (const tab of ['credentials', 'cliExtensions']) {
      const entries = [...source.matchAll(new RegExp(`tab: '${tab}',[\\s\\S]*?group: t\\('settings\\.nav\\.group\\.(\\w+)'\\)`, 'g'))]
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) expect(entry[1]).toBe('integration')
    }
  })

  it('is mirrored page for page by the settings help topic', () => {
    const start = helpSource.indexOf('const tabs: TabRow[] = [')
    const table = helpSource.slice(start, helpSource.indexOf('\n]', start))
    const helpKeys = [...table.matchAll(/navKey: '([\w.-]+)'/g)].map((m) => m[1])
    expect(navLabelKeys()).toHaveLength(25)
    expect(helpKeys).toEqual(navLabelKeys())
  })
})
