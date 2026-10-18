import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// What removing a plugin deletes and what it keeps is a user-facing promise.
// The spec states it in one section; this pins the three decisions in it.

const repoRoot = resolve(__dirname, '../..')
const doc = readFileSync(join(repoRoot, 'docs/en-US/plugin-development-v2.md'), 'utf8')

function section(heading: string): string {
  const start = doc.indexOf(`\n${heading}\n`)
  if (start < 0) throw new Error(`missing section ${heading}`)
  const rest = doc.slice(start + heading.length + 2)
  const next = rest.search(/\n#{2,3} /)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('plugin removal docs', () => {
  const text = section('### Removing a plugin').replace(/\s+/g, ' ')

  it('describes the native backend data choice, deleted by default', () => {
    expect(text).toContain('<userData>/plugin-native-backends/data/<pluginId>/')
    expect(text).toMatch(/deleted by default/i)
    expect(text).toMatch(/only when that directory exists/i)
  })

  it('says removing a plugin keeps publisher trust and the pre-release opt-in', () => {
    expect(text).toContain('removing a plugin keeps publisher trust')
    expect(text).toMatch(/removing a plugin keeps (its|the) "Get pre-releases" opt-in/)
  })
})
