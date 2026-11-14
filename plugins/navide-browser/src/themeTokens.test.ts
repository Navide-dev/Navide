import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The window once used --accent-color, --border-subtle and --text-danger,
// which no theme defines: primary buttons, the selected layout and the
// "running" chip rendered white on white. Every custom property the plugin
// reads must be defined by the plugin-ui tokens or by the plugin itself.

const pluginSrc = resolve(__dirname)
const tokenRoot = resolve(__dirname, '../../../packages/plugin-ui/src')

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path, pattern)
    return pattern.test(name) ? [path] : []
  })
}

function defined(paths: string[]): Set<string> {
  const names = new Set<string>()
  for (const path of paths) {
    for (const match of readFileSync(path, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(match[1]!)
  }
  return names
}

describe('Navide Browser theme tokens', () => {
  it('reads only custom properties that a theme or the plugin defines', () => {
    const own = files(pluginSrc, /\.(vue|css)$/)
    const available = defined([...files(tokenRoot, /\.(css|vue)$/), ...own])
    const missing = new Set<string>()
    for (const path of own) {
      for (const match of readFileSync(path, 'utf8').matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!available.has(match[1]!)) missing.add(match[1]!)
      }
    }
    expect([...missing].sort()).toEqual([])
  })
})
