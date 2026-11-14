import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A plugin surface must call `loadTheme()` with no arguments.
 *
 * `useTheme.loadTheme(backendFallback)` promotes the fallback into the shared
 * settings store when the store holds no local value (pinned by
 * useTheme.test.ts). A plugin surface mirrors that store back to the Host, so
 * a surface passing a fallback would write the theme back and the two would
 * take turns overriding each other. The symptom — host and guest flipping
 * themes — is very hard to trace to the one argument that caused it, and
 * adding that argument looks like a reasonable thing to do ("let the plugin
 * take a default theme from the backend too").
 *
 * Three barriers stand between that mistake and a live loop today: this
 * convention, `canWriteKey` refusing writes to keys a surface does not own,
 * and the entry-query seed making `fromLocal` true. Only the last two had
 * tests; this pins the first.
 *
 * `App.vue` is deliberately absent: it is the host document, it owns the
 * theme, and its `loadTheme({ theme, theme_custom })` at the project-load path
 * is the legitimate use this rule exists to distinguish from.
 */
const repoRoot = resolve(import.meta.dirname, '../../../..')

const SURFACES = [
  'plugins/navide-git/src/GitLeftApp.vue',
  'plugins/navide-git/src/GitWindowApp.vue',
  // The Plans window is a separate file from the v2 package but the same kind
  // of surface, with the same store.
  'src/renderer/src/PlanWindowApp.vue',
]

describe('plugin surface theme call sites', () => {
  it('never hands loadTheme a backend fallback', () => {
    const offenders: string[] = []
    for (const relative of SURFACES) {
      const source = readFileSync(resolve(repoRoot, relative), 'utf8')
      for (const [index, line] of source.split('\n').entries()) {
        if (/\bloadTheme\(\s*[^)\s]/.test(line)) {
          offenders.push(`${relative}:${index + 1} — ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('still watches files that actually call loadTheme', () => {
    // Guards against the list above silently going stale — a renamed or moved
    // surface would otherwise make this suite pass by watching nothing.
    for (const relative of SURFACES) {
      const source = readFileSync(resolve(repoRoot, relative), 'utf8')
      expect({ relative, calls: /\bloadTheme\(/.test(source) }).toEqual({ relative, calls: true })
    }
  })
})
