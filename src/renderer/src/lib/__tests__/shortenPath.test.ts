import { describe, expect, it } from 'vitest'
import { shortenPath } from '../shortenPath'

describe('shortenPath', () => {
  it('leaves a path that fits alone', () => {
    expect(shortenPath('/Users/x/.claude/CLAUDE.md', 64)).toBe('/Users/x/.claude/CLAUDE.md')
  })

  it('drops whole segments from the middle and keeps the head and the file', () => {
    const path = '/private/var/folders/2k/abcdefghij/T/navide-dev-web-123456/settings/analyzer.json'
    const short = shortenPath(path, 48)
    expect(short.startsWith('/private/…/')).toBe(true)
    expect(short.endsWith('/settings/analyzer.json')).toBe(true)
    expect(short.length).toBeLessThanOrEqual(48)
  })

  it('keeps at least the last segment however long it is', () => {
    expect(shortenPath('/a/b/c/' + 'x'.repeat(80), 20)).toBe('/a/…/' + 'x'.repeat(80))
  })

  it('handles Windows separators', () => {
    expect(shortenPath('C:\\Users\\me\\AppData\\Roaming\\Navide\\settings\\analyzer.json', 36)).toBe(
      'C:\\…\\Navide\\settings\\analyzer.json'
    )
  })
})
