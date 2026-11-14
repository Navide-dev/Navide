import { describe, expect, it } from 'vitest'
import { parsePluginCommandTarget } from './pluginCommands'

describe('parsePluginCommandTarget', () => {
  it('keeps a path or a pane id', () => {
    expect(parsePluginCommandTarget({ path: 'src/a.ts' })).toEqual({ path: 'src/a.ts' })
    expect(parsePluginCommandTarget({ paneId: 'p1' })).toEqual({ paneId: 'p1' })
  })

  it('refuses anything else', () => {
    expect(parsePluginCommandTarget(null)).toBeNull()
    expect(parsePluginCommandTarget({})).toBeNull()
    expect(parsePluginCommandTarget({ path: '' })).toBeNull()
    expect(parsePluginCommandTarget({ path: 'a', other: 'b' })).toBeNull()
    expect(parsePluginCommandTarget({ paneId: 3 })).toBeNull()
    expect(parsePluginCommandTarget({ path: 'x'.repeat(4097) })).toBeNull()
  })
})
