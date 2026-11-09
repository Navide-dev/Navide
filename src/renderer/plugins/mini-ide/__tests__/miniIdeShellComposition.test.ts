import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Guards the seam that makes privileged shell actions work in BOTH mini-IDE
// hosts. A plugin WebContentsView has no `window.agentTeam` (plugin-preload
// withholds it), so a direct `window.agentTeam?.revealPath(...)` in the shared
// component tree resolves on `undefined` and no-ops — silently, because of the
// optional chaining. Every such call must go through `composables/hostShell`,
// which the plugin build aliases to the capability shim.

const repositoryRoot = resolve(__dirname, '../../../../..')
const read = (rel: string): string => readFileSync(resolve(repositoryRoot, rel), 'utf8')

describe('mini-IDE shell composition', () => {
  it('aliases hostShell to the capability shim in the plugin build', () => {
    const buildConfig = read('vite.mini-ide.config.ts')
    expect(buildConfig).toContain('capabilityShell')
    // Same relative-form coverage as the useBackend alias above it.
    expect(buildConfig).toMatch(/hostShell\$\/,\s*replacement: capabilityShell/)
  })

  it('routes every reveal in the shared tree through hostShell', () => {
    for (const file of [
      'src/renderer/src/EditorWindowApp.vue',
      'src/renderer/src/components/ExplorerPane.vue',
    ]) {
      const source = read(file)
      expect(source, `${file} must not reveal through the preload bridge directly`)
        .not.toMatch(/agentTeam\??\.?\??\.revealPath/)
      expect(source, `${file} must import the shell seam`).toMatch(/from '\.{1,2}\/(composables\/)?hostShell'/)
    }
  })

  it('keeps the host and plugin implementations in lockstep', () => {
    const exportsOf = (source: string): string[] =>
      [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]!).sort()
    expect(exportsOf(read('src/renderer/plugins/mini-ide/capabilityShell.ts')))
      .toEqual(exportsOf(read('src/renderer/src/composables/hostShell.ts')))
  })

  it('maps the ui host capabilities the embedded GitPane sends', () => {
    // These have no backend WS handler — they are main-process host actions.
    // An unmapped entry answers UNMAPPED_CAPABILITY and the menu item dies.
    const shim = read('src/renderer/plugins/mini-ide/capabilityBackend.ts')
    for (const method of ['reveal_path', 'open_external', 'open_in_editor', 'open_workspace', 'pick_folder']) {
      expect(shim, `ui.${method} must be mapped`).toContain(`'ui.${method}': { ns: 'ui', method: '${method}' }`)
    }
  })
})
