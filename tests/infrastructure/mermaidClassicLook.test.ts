import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { expect, it } from 'vitest'

// mermaid 12 lays out flowchart, state, class and ER diagrams with ELK and
// paints them in the `neo` look unless told otherwise. Plans keep the
// mermaid 11 appearance, so every initialize call pins both options.
const repositoryRoot = resolve(import.meta.dirname, '../..')
const roots = [
  join(repositoryRoot, 'src'),
  ...readdirSync(join(repositoryRoot, 'plugins')).map((name) => join(repositoryRoot, 'plugins', name, 'src')),
]

function sourceFiles(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '__tests__' ? [] : sourceFiles(path)
    return /\.(vue|ts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : []
  })
}

const calls = roots.flatMap(sourceFiles).flatMap((path) => {
  const source = readFileSync(path, 'utf8')
  return [...source.matchAll(/mermaid\.initialize\(\{([^}]*)\}\)/g)].map((match) => ({
    file: relative(repositoryRoot, path).split(sep).join('/'),
    options: match[1],
  }))
})

it('finds every mermaid.initialize call site', () => {
  // A scan that matches nothing would pass the check below vacuously.
  expect(calls.map((call) => call.file).sort()).toEqual([
    'plugins/navide-mini-ide/src/editor/PlanFileView.vue',
    'plugins/navide-plans/src/retained/PlanMarkdownBody.vue',
    'src/renderer/src/editor/PlanFileView.vue',
    'src/renderer/src/editor/PlanMarkdownBody.vue',
    'src/renderer/src/preview/MarkdownPreview.vue',
  ])
})

for (const { file, options } of calls) {
  it(`pins the dagre layout and classic look in ${file}`, () => {
    expect(options).toMatch(/\blayout: 'dagre'/)
    expect(options).toMatch(/\blook: 'classic'/)
  })
}
