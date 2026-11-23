import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// `@navide/plugin-ui/shared/testing` is public (1.x): a plugin's tests reset
// the shared settings and keybinding state through it. It only works when the
// built entry shares its module instances with `@navide/plugin-ui/shared`,
// which this checks on the dist that tests/support/publicPackagesSetup.ts
// built (the packed tarball carries the same files).
const dist = resolve(import.meta.dirname, '../../packages/plugin-ui/dist')

describe('@navide/plugin-ui/shared/testing', () => {
  it('is exported with its types', () => {
    const manifest = JSON.parse(readFileSync(resolve(dist, '../package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(manifest.exports['./shared/testing']).toEqual({
      types: './dist/shared/testing.d.ts',
      import: './dist/shared/testing.js',
    })
    expect(readFileSync(resolve(dist, 'shared/testing.d.ts'), 'utf8')).toContain('_resetRegistry')
  })

  it('resets the same registry and settings instances the shared entry uses', async () => {
    const shared = await import(pathToFileURL(resolve(dist, 'shared/index.js')).href)
    const testing = await import(pathToFileURL(resolve(dist, 'shared/testing.js')).href)
    expect(Object.keys(testing).sort()).toEqual(['__resetSettingsForTest', '_resetKeybindingsState', '_resetRegistry'])

    shared.registerCommand('acme.probe', () => {})
    expect(shared.hasCommand('acme.probe')).toBe(true)
    testing._resetRegistry()
    expect(shared.hasCommand('acme.probe')).toBe(false)
  })
})
