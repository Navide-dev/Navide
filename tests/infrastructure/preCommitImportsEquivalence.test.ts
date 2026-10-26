import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The pre-commit relative-import scan was quadratic (it re-summed every blanked
// piece for each string literal), so staging App.vue took seconds per file.
// The linear rewrite must print exactly what the frozen original printed.
const HOOK = readFileSync(resolve('.githooks', 'pre-commit'), 'utf8')
const NEW_PARSER = /RELATIVE_IMPORTS_PY <<'PY'\n([\s\S]*?)\nPY\n/.exec(HOOK)?.[1] ?? ''
const OLD_PARSER = readFileSync(resolve('tests', 'fixtures', 'pre-commit', 'relative_imports_v1.py'), 'utf8')
const pythonAvailable = spawnSync('python3', ['-c', 'pass'], { encoding: 'utf8', timeout: 10_000 }).status === 0

/** Runs a parser over `source` as if it were the staged file `name`. */
function scan(parser: string, name: string, source: string): string {
  const r = spawnSync('python3', ['-c', parser, name], { input: source, encoding: 'utf8', timeout: 300_000 })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout
}

const SYNTHETIC: Record<string, string> = {
  'empty.ts': '',
  'template.ts': [
    "import { a } from './a'",
    'const t = `from \'./not-a\' ${cond ? "./nested" : \'./other\'} import(\'./nope\')`',
    "export const lazy = () => import('./dyn')",
    'const u = `${`inner ${"x"}`}` ; import \'./after-template\'',
    '',
  ].join('\n'),
  'quotes.ts': [
    "const s = 'it\\'s from \\'./escaped\\''",
    'const d = "say \\"import(\'./q\')\\" ok"',
    "import { b } from \"./double\"",
    "import { c } from '../up/c'",
    "const unterminated = 'no close",
    "import './side'",
    '',
  ].join('\n'),
  'comments.ts': [
    "// import { x } from './line-comment'",
    "/* import('./block')",
    "   from './still-block' */ import { y } from './real'",
    "/** @see import('./doc') */",
    "export { z } from '../re/export' // trailing from './x'",
    '',
  ].join('\n'),
  'regex.ts': [
    "const re = /from '.\\/r'/g",
    "const re2 = /['\"]/",
    "import { r } from './after-regex'",
    '',
  ].join('\n'),
  'crlf.ts': "import { a } from './crlf-a'\r\nimport './crlf-side'\r\n// from './crlf-comment'\r\nexport * from '../crlf-b'\r\n",
  'multi.ts': "import {\n  one,\n  two,\n} from './multi'\nimport type { T } from './types.js'\n",
  'C.vue': [
    '<template><p>from \'./tpl\'</p></template>',
    '<script setup lang="ts">',
    "import Child from './Child.vue'",
    "const s = \"import './in-string'\"",
    '</script>',
    '<script lang="ts">',
    "export { k } from '../k'",
    '</script>',
    '',
  ].join('\n'),
  'empty.vue': '<template><div /></template>\n',
  'mod.py': "from .x import y\ns = 'from \\'./z\\' import'\nimport './q'\n",
  'unterminated.ts': 'const x = `never closed from \'./t\'',
  'trailing-quote.ts': "import './a'\n'",
}

const REAL = [
  'src/renderer/src/components/PairingPrompt.vue',
  'src/renderer/src/components/AccountModal.vue',
  'src/main/plugins/pluginThirdPartyBackends.ts',
  'src/renderer/src/composables/__tests__/useSettings.test.ts',
  'src/renderer/src/lib/__tests__/cliAwaitingInput.test.ts',
  'tests/infrastructure/preCommitImports.test.ts',
  'backend/agent_team_backend/channels/__init__.py',
]

// The old parser needs ~10 s on each of these; opt in with PRE_COMMIT_SLOW=1.
const BIG = [
  'src/renderer/src/App.vue',
  'src/main/plugins/frontendPluginManager.ts',
  'backend/agent_team_backend/channels/manager.py',
]

describe.skipIf(!pythonAvailable)('pre-commit relative import parser', () => {
  it('is extracted from the hook', () => {
    expect(NEW_PARSER).toContain('lits[off]')
  })

  it.each(Object.entries(SYNTHETIC))('prints what the original printed for %s', (name, source) => {
    expect(scan(NEW_PARSER, name, source)).toBe(scan(OLD_PARSER, name, source))
  })

  // Windows Python writes print()'s newline as \r\n, so split on either.
  it('still finds the real imports in the synthetic cases', () => {
    expect(scan(NEW_PARSER, 'template.ts', SYNTHETIC['template.ts']).split(/\r?\n/))
      .toEqual(['./a', './dyn', ''])
    expect(scan(NEW_PARSER, 'comments.ts', SYNTHETIC['comments.ts']).split(/\r?\n/))
      .toEqual(['./real', '../re/export', ''])
  })

  it.each(REAL)('prints what the original printed for %s', (path) => {
    const source = readFileSync(resolve(path), 'utf8')
    expect(scan(NEW_PARSER, path, source)).toBe(scan(OLD_PARSER, path, source))
  })

  it.runIf(process.env.PRE_COMMIT_SLOW === '1').each(BIG)('prints what the original printed for %s', (path) => {
    const source = readFileSync(resolve(path), 'utf8')
    expect(scan(NEW_PARSER, path, source)).toBe(scan(OLD_PARSER, path, source))
  }, 300_000)
})
