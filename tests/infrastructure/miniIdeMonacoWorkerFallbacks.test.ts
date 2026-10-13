import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Plugin } from 'vite'
import { expect, it } from 'vitest'
import miniIdeConfig from '../../plugins/navide-mini-ide/vite.config'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const monacoRoot = realpathSync(join(repositoryRoot, 'node_modules/monaco-editor'))

function dropFallbacks(code: string, id: string): unknown {
  const plugin = (miniIdeConfig.plugins ?? [])
    .flat()
    .find((entry): entry is Plugin => !!entry && typeof entry === 'object' && 'name' in entry
      && entry.name === 'drop-monaco-worker-fallbacks')
  if (!plugin?.transform) throw new Error('drop-monaco-worker-fallbacks is not registered')
  const transform = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform.handler
  return (transform as (code: string, id: string) => unknown).call({}, code, id)
}

for (const [language, worker] of [['typescript', 'ts'], ['css', 'css'], ['html', 'html'], ['json', 'json']]) {
  const managerPath = join(monacoRoot, `esm/vs/language/${language}/workerManager.js`)
  const source = readFileSync(managerPath, 'utf8')

  // Vite can hand a transform the module id with a query (`?v=<hash>` from the
  // dep optimizer, `?import`), and a match on the bare path then skipped the
  // module: the duplicate worker came back and the shape check never ran.
  for (const id of [managerPath, `${managerPath}?v=0a1b2c3d`]) {
    it(`drops the ${worker} worker fallback from ${id.slice(managerPath.length) || 'the bare id'}`, () => {
      expect(source).toContain(`new URL('${worker}.worker.js', import.meta.url)`)
      const result = dropFallbacks(source, id) as { code: string } | null
      expect(result).not.toBeNull()
      expect(result!.code).toContain('createWorker: undefined,')
      expect(result!.code).not.toContain(`${worker}.worker.js`)
    })

    it(`fails when the ${worker} fallback changes shape at ${id.slice(managerPath.length) || 'the bare id'}`, () => {
      expect(() => dropFallbacks(source.replace('createWorker:', 'makeWorker:'), id))
        .toThrow(/Monaco worker fallback not found/)
    })
  }
}

it('leaves every other module alone', () => {
  expect(dropFallbacks('export {}', join(monacoRoot, 'esm/vs/editor/editor.api.js?v=0a1b2c3d'))).toBeNull()
  expect(dropFallbacks('export {}', '/workspace/src/workerManager.js')).toBeNull()
})
