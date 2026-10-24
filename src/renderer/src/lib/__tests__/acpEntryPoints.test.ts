import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ACP is unreachable until its entry point ships on purpose: no pane asks for
// display 'acp' yet, so every pane takes the TUI path exactly as on main.
// Wiring one up (a spawn form option, an MCP argument) edits this test with it.

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
  it('no production code asks for an ACP pane', () => {
    const askers = sources(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8')
      return ASKS_FOR_ACP.some((pattern) => pattern.test(text))
    })
    expect(askers.map((file) => relative(process.cwd(), file))).toEqual([])
  })
})
