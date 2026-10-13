// Security guard: workspace self-evolution settings and runs may only be
// changed by the user clicking in EvolvePanel. An agent can call any
// registered ui.* command through ui_invoke, so a command that reached
// evolve.set / evolve.run_now would let it widen the permission scope
// (propose-only → fix) or start runs itself, bypassing the user.
// This scans the shipped renderer and plugin sources, not a mounted app, so
// a command registered anywhere (App.vue included) is caught.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import nodePath, { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../../../..')
const SCAN = ['src/renderer/src', 'plugins', 'packages']

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|vue)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

type Source = { rel: string; text: string }

/** A path relative to the repo root, as the assertions spell it. */
function repoRel(root: string, p: string, path: typeof nodePath = nodePath): string {
  // On Windows relative() answers with backslashes.
  return path.relative(root, p).split(path.sep).join('/')
}

/** Source text as the patterns read it: a CRLF checkout reads as LF. */
function sourceText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n')
}

const files: Source[] = SCAN.flatMap((d) => sources(join(ROOT, d))).map((p) => ({
  rel: repoRel(ROOT, p),
  // latin1 keeps App.vue's NUL byte from tripping a UTF-8 decode.
  text: sourceText(readFileSync(p, 'latin1')),
}))

const hitsIn = (list: Source[], re: RegExp) => list.filter((f) => re.test(f.text)).map((f) => f.rel).sort()
const hits = (re: RegExp) => hitsIn(files, re)

describe('evolve has no ui.* action an agent could invoke', () => {
  it('scans the real sources', () => {
    expect(files.some((f) => f.rel.endsWith('src/renderer/src/App.vue'))).toBe(true)
  })

  it('registers no command whose id mentions evolve', () => {
    expect(hits(/registerCommand\(\s*['"`][^'"`]*evolve/i)).toEqual([])
  })

  it('sends evolve.set / evolve.run_now only from useEvolve', () => {
    // Quoted string literals only: backticks also mark names in comments.
    expect(hits(/['"]evolve\.(set|run_now)['"]/)).toEqual(['src/renderer/src/composables/useEvolve.ts'])
  })

  it('calls the evolve write helpers only from the panel', () => {
    expect(hits(/\bevolve(Set|RunNow)\b/)).toEqual([
      'src/renderer/src/components/EvolvePanel.vue',
      'src/renderer/src/composables/useEvolve.ts',
    ])
  })
})

describe('the guard reads Windows paths and line endings the same way', () => {
  const root = 'C:\\a\\Agent-Team'
  const win = (rel: string) => repoRel(root, `${root}\\${rel.split('/').join('\\')}`, nodePath.win32)

  it('spells a Windows path with forward slashes', () => {
    expect(win('src/renderer/src/App.vue')).toBe('src/renderer/src/App.vue')
  })

  it('still catches an evolve command in a CRLF source on a Windows path', () => {
    const list: Source[] = [
      { rel: win('src/renderer/src/App.vue'), text: sourceText("x\r\nregisterCommand(\r\n  'ui.evolve.set',\r\n  fn)\r\n") },
      { rel: win('src/renderer/src/composables/useEvolve.ts'), text: sourceText("send('evolve.set')\r\n") },
    ]
    expect(hitsIn(list, /registerCommand\(\s*['"`][^'"`]*evolve/i)).toEqual(['src/renderer/src/App.vue'])
    expect(hitsIn(list, /['"]evolve\.(set|run_now)['"]/)).toEqual(['src/renderer/src/composables/useEvolve.ts'])
    expect(list.every((f) => !f.text.includes('\r'))).toBe(true)
  })
})
