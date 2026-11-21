import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Promoting a staged candidate preflights its views in a hidden BrowserWindow,
// which Electron refuses before the app is ready ("Cannot create BrowserWindow
// before app is ready"). Run at module load it also sees the bundled Plans not
// registered yet, so a Registry copy staged over it reads as a first install.
// The launch promotion therefore has to wait for whenReady.
describe('launch promotion of staged plugin candidates', () => {
  it('runs activateStagedFirstInstalls only once the app is ready', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    const statements = source.split(/\n(?=\S)/)
    const calls = statements.filter((statement) => statement.includes('activateStagedFirstInstalls('))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^void app\.whenReady\(\)\s*\.then\(\(\) => pluginTrustRefresh\.activateStagedFirstInstalls\(\)\)/)
  })
})
