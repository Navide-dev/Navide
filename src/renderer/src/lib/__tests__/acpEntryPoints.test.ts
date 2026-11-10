import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ACP is reachable from one entry point only: the ＋ menu's ACP row, shown
// while Settings → CLI Agents → ACP (experimental) is on (off by default),
// which reaches App.vue's onAcpSpawn. Every other pane takes the TUI path
// exactly as on main. Wiring up another (a spawn form option, an MCP
// argument) edits this test with it.

const SRC = resolve(process.cwd(), 'src')
const ASKS_FOR_ACP = [/\bdisplay\s*:\s*['"]acp['"]/, /\.display\s*=\s*['"]acp['"]/]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path)
    return /\.(ts|vue|mts|js)$/.test(entry.name) ? [path] : []
  })
}

describe('ACP entry points', () => {
  it('only App.vue onAcpSpawn asks for an ACP pane', () => {
    const askers = sources(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8')
      return ASKS_FOR_ACP.some((pattern) => pattern.test(text))
    })
    expect(askers.map((file) => relative(process.cwd(), file))).toEqual(['src/renderer/src/App.vue'])
    const app = readFileSync(join(SRC, 'renderer/src/App.vue'), 'utf8')
    const hits = app.split('\n').filter((line) => ASKS_FOR_ACP.some((pattern) => pattern.test(line)))
    expect(hits).toEqual(["    display: 'acp',"])
    const fn = app.slice(app.indexOf('async function onAcpSpawn('), app.indexOf('async function onManualSpawn('))
    expect(fn).toContain("display: 'acp',")
  })

  it('the ＋ menu offers ACP only while the switch is on', () => {
    const menu = readFileSync(join(SRC, 'renderer/src/components/ControlPane.vue'), 'utf8')
    expect(menu).toMatch(/const addMenuAcpRows = computed\(\(\) =>\n\s+acpEnabled\.value\n/)
    expect(menu).toContain("emit('spawn-acp', {")
    expect(menu.match(/emit\('spawn-acp'/g)).toHaveLength(1)
  })
})
