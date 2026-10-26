import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// startBackend without a catalog writes an EMPTY approved-backend catalog over
// the one on disk. Every spawn in main — first start, manual restart and the
// crash auto-restart — must hand it the approved one instead.
describe('startBackend call sites', () => {
  it('every spawn in index.ts passes the approved backend plugin catalog', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    const calls: string[] = []
    const re = /\bstartBackend\(/g
    for (let match = re.exec(source); match; match = re.exec(source)) {
      let depth = 1
      let end = match.index + match[0].length
      while (depth > 0 && end < source.length) {
        const ch = source[end++]
        if (ch === '(') depth++
        else if (ch === ')') depth--
      }
      calls.push(source.slice(match.index, end))
    }
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const call of calls) expect(call).toContain('approvedBackendPluginCatalog()')
  })
})
