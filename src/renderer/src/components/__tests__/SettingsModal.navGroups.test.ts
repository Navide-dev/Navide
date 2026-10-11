import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The settings nav is static markup in SettingsModal.vue; mounting the whole
// modal for it is not worth it, so the groups are read off the template.
const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/SettingsModal.vue'), 'utf8')

function navGroups(): { title: string; tabs: string[] }[] {
  const nav = source.slice(source.indexOf('<div class="s-nav-group">'), source.indexOf('</nav>', source.indexOf('<div class="s-nav-group">')))
  return nav.split('<div class="s-nav-group">').slice(1).map((block) => ({
    title: block.match(/\$t\('settings\.nav\.group\.(\w+)'\)/)![1],
    tabs: [...block.matchAll(/@select="activeTab = '([\w-]+)'"/g)].map((m) => m[1]),
  }))
}

describe('SettingsModal nav groups', () => {
  it('gives Navide plugins their own group between Agent Assets and System', () => {
    expect(navGroups()).toEqual([
      { title: 'general', tabs: ['general', 'appearance', 'language', 'statusBadges', 'layout', 'notifications', 'voice'] },
      { title: 'accountsAgents', tabs: ['accounts', 'cliAgents', 'cliExtensions', 'analyzer', 'security', 'channels', 'cross-device', 'credentials'] },
      { title: 'integration', tabs: ['mcp', 'skills', 'prompts', 'memory'] },
      { title: 'navidePlugins', tabs: ['extensions', 'marketplace'] },
      { title: 'system', tabs: ['keybindings', 'updates', 'help'] },
    ])
  })

  it('keeps the update badge on Navide Plugins', () => {
    expect(source).toMatch(/:active="activeTab === 'extensions'" :badge="pluginUpdates\.count\.value"/)
  })

  it('files the search hits of the moved pages under the new group', () => {
    for (const tab of ['extensions', 'marketplace']) {
      const entries = [...source.matchAll(new RegExp(`tab: '${tab}',[\\s\\S]*?group: t\\('settings\\.nav\\.group\\.(\\w+)'\\)`, 'g'))]
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) expect(entry[1]).toBe('navidePlugins')
    }
  })
})
