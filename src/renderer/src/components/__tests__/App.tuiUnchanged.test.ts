import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs helper shared with the fixture regeneration (no types)
import { FIXTURE, sectionText, withoutHooks } from './fixtures/acpUnchanged.mjs'

// ACP must not change the TUI path (user, 2026-10-23): every existing App.vue
// function or template block it reaches is main's text plus the listed ACP
// lines only. See fixtures/acpUnchanged.mjs for how the fixture is made.
interface Entry { file: string; kind: 'function' | 'block'; name?: string; start?: string; hooks: string[]; main: string }

const entries = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Entry[]

describe('the TUI path is main, word for word', () => {
  it.each(entries.map((e) => [`${e.file} ${e.name ?? e.start}`, e] as const))('%s', (_label, entry) => {
    const current = sectionText(readFileSync(resolve(process.cwd(), entry.file), 'utf8'), entry) as string
    expect(withoutHooks(current, entry.hooks)).toBe(entry.main)
  })
})
