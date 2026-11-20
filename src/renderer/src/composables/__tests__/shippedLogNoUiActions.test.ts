// Security guard: the Shipped Log's writes (adding an entry, confirming or
// dismissing a detected command, editing an item, registering a production
// setting, changing or running the daily digest) happen only on a click in
// ShippedLogPanel. An agent can call any registered ui.* command through
// ui_invoke, so none of them may be reachable from a command.
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import nodePath, { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../../../..')
// plugins/ is gone since the official plugins moved to their own repositories
// (0.2.46); scan it only where a checkout still has one.
const SCAN = ['src/renderer/src', 'plugins', 'packages'].filter((dir) => existsSync(dir))

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|vue)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

const files = SCAN.flatMap((d) => sources(join(ROOT, d))).map((p) => ({
  rel: nodePath.relative(ROOT, p).split(nodePath.sep).join('/'),
  text: readFileSync(p, 'latin1').replace(/\r\n?/g, '\n'),
}))
const hits = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.rel).sort()

describe('the Shipped Log has no ui.* action an agent could invoke', () => {
  it('scans the real sources', () => {
    expect(files.some((f) => f.rel.endsWith('src/renderer/src/App.vue'))).toBe(true)
  })

  it('registers no command whose id mentions the shipped log', () => {
    expect(hits(/registerCommand\(\s*['"`][^'"`]*(ship|shipped)/i)).toEqual([])
  })

  it('names ship_log writes only in the panel', () => {
    expect(hits(/['"]ship_log\.(record|detection|override|config_set|digest_set|digest_run)['"]/)).toEqual([
      'src/renderer/src/components/ShippedLogPanel.vue',
    ])
  })

  it('sends ship_log requests only through useShippedLog', () => {
    expect(hits(/\bshipLogCall\b/)).toEqual([
      'src/renderer/src/components/ShippedLogPanel.vue',
      'src/renderer/src/composables/useShippedLog.ts',
    ])
  })
})
