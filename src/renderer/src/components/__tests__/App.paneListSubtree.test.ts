// @vitest-environment happy-dom
// The subtree summary on a parent card in the main-window pane lists — the
// Auto sidebar's cards and the fullscreen PiP rows — and the location hint on
// a carried descendant's row. Mounting App starts
// backend, terminal and onboarding lifecycles, so — like the other
// App.*.test.ts files — the wiring is asserted against its source. The
// computation underneath runs for real in lib/__tests__/paneSubtreeStatus.test.ts.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { subtreeSignals } from '../../lib/paneSubtreeStatus'
import { paneStatusLabelText } from '../../lib/paneStatusLabel'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('the subtree chip on parent cards', () => {
  it('is computed once from the live views, through the shared lib', () => {
    // One definition for every list — and the same one the sidebar tree uses —
    // so no two surfaces can disagree about which family is busy.
    // Split the source assertion so the staged-import guard does not parse it as this test's own import.
    expect(appSource).toContain(["import { subtreeSignals } from ", "'./lib/paneSubtreeStatus'"].join(''))
    expect(appSource).toContain('const paneListSubtree = computed(() => subtreeSignals(paneViews.value))')
  })

  it('renders on both card lists under the status badge', () => {
    const chips = appSource.match(/class="meeting-subtree"\s+v-bind="paneListSubtreeAttrs\(p\.id\)"\s+>\{\{ paneListSubtreeText\(p\.id\) \}\}<\/span>/g) ?? []
    expect(chips).toHaveLength(2)
    // Stacked under the badge, so a parent card stays two lines tall.
    const stacked = appSource.match(/<div class="meeting-status-col">\s+<span class="meeting-badge"[^\n]*\n\s+<span\s+v-if="paneListSubtree\.has\(p\.id\)"\s+class="meeting-subtree"/g) ?? []
    expect(stacked).toHaveLength(2)
    expect(appSource).not.toContain('>↳ {{ paneListSubtree.get(p.id)?.count }}</span>')
    // Only when there is something to say: an all-idle family leaves the card
    // exactly as it was.
    const guards = appSource.match(/v-if="paneListSubtree\.has\(p\.id\)"/g) ?? []
    expect(guards).toHaveLength(2)
  })

  it('carries its legend on the chip, not just a colour', () => {
    expect(appSource).toContain("i18n.global.t('pane.terminal.subtree-tooltip', {")
  })

  it('styles every state it can show', () => {
    for (const state of ['running', 'starting', 'error', 'awaiting']) {
      expect(appSource).toContain(`.meeting-subtree[data-status="${state}"]`)
    }
  })
})

describe('the loop tag on cards', () => {
  it('is icon-only, with the word on hover', () => {
    // The word was dropped to give the pane name back its width.
    expect(appSource).not.toContain('∞ Loop')
    const titled = appSource.match(/:title="\$t\('pane\.terminal\.loop-tag-tooltip'\)"\s*>∞<\/span>/g) ?? []
    expect(titled).toHaveLength(3)
  })
})

/** Lift App's own declarations out of its source and run them. */
function run<T>(names: string[], deps: Record<string, unknown>, exports: string): T {
  const decls = names.map((marker) => {
    const at = appSource.indexOf(marker)
    expect(at, marker).toBeGreaterThan(-1)
    return appSource.slice(at, appSource.indexOf('\n}', at) + (marker.startsWith('const') ? 3 : 2))
  })
  const js = ts.transpileModule(decls.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(deps), `${js}; return { ${exports} }`)(...Object.values(deps)) as T
}

afterEach(() => { i18n.global.locale.value = 'en-US' })

describe('the subtree summary text', () => {
  const views = ref([
    { id: 'lead', status: 'idle' },
    { id: 'a', spawnedBy: 'lead', status: 'running' },
    { id: 'b', spawnedBy: 'lead', status: 'running' },
    { id: 'c', spawnedBy: 'lead', status: 'awaiting' },
    { id: 'solo', status: 'idle' },
    { id: 'kid', spawnedBy: 'solo', status: 'running' },
  ])
  const paneListSubtree = computed(() => subtreeSignals(views.value))
  const { paneListSubtreeText } = run<{ paneListSubtreeText: (id: string) => string }>(
    ['function paneListSubtreeText('],
    { paneListSubtree, i18n, paneStatusLabelText },
    'paneListSubtreeText',
  )

  it('names the selected status and only its own count', () => {
    // Two running, one awaiting: awaiting wins, and it counts one — not three.
    expect(paneListSubtreeText('lead')).toBe(`sub ${paneStatusLabelText('awaiting')} 1`)
    expect(paneListSubtreeText('solo')).toBe(`sub ${paneStatusLabelText('running')} 1`)
    views.value = [...views.value, { id: 'kid2', spawnedBy: 'solo', status: 'running' }]
    expect(paneListSubtreeText('solo')).toBe(`sub ${paneStatusLabelText('running')} 2`)
    expect(paneListSubtreeText('a')).toBe('')
  })

  it('is translated, not hard-coded', () => {
    i18n.global.locale.value = 'zh-TW'
    expect(paneListSubtreeText('lead')).toBe(`sub ${paneStatusLabelText('awaiting')} 1`)
  })
})

describe('the location hint on a carried row', () => {
  function harness() {
    const panes = ref([
      { id: 'here', workspacePath: '/project', runGroupId: 'g1' },
      { id: 'mini', workspacePath: '/project', runGroupId: 'g1' },
      { id: 'away', workspacePath: '/project', runGroupId: 'g2' },
      { id: 'loose', workspacePath: '/project', runGroupId: '' },
      { id: 'remote', workspacePath: '/other/', runGroupId: 'r1' },
      { id: 'remote-loose', workspacePath: '/other', runGroupId: '' },
    ])
    const tabFilteredPaneIds = computed(() => new Set(['here', 'mini']))
    const deps = {
      computed, i18n, panes, tabFilteredPaneIds,
      currentWorkspace: ref('/project'),
      minimizedPanes: ref(new Set(['mini', 'remote'])),
      stageTabShapes: computed(() => [
        { key: 'g1', label: 'Build' }, { key: 'g2', label: 'A very long review tab' }, { key: 'manual', label: 'manual' },
      ]),
      workspaceGroups: computed(() => [{ path: '/project', label: 'project' }, { path: '/other', label: 'Other One' }]),
      runGroupsByWorkspace: ref({ '/other': [{ id: 'r1', name: 'Remote run' }] }),
      normWs: (p: string) => p.replace(/\/+$/, ''),
    }
    return run<{ paneListLocation: { value: Map<string, string[]> } }>(
      ['const paneListLocation = computed('], deps, 'paneListLocation',
    ).paneListLocation
  }

  it('says minimized, which tab, and which workspace — and nothing for a pane on the stage', () => {
    const loc = harness()
    expect(loc.value.has('here')).toBe(false)
    expect(loc.value.get('mini')).toEqual(['Minimized to sidebar'])
    expect(loc.value.get('away')).toEqual(['Tab: A very long review tab'])
    expect(loc.value.get('loose')).toEqual(['Tab: manual'])
    expect(loc.value.get('remote')).toEqual(['Project: Other One', 'Tab: Remote run', 'Minimized to sidebar'])
    expect(loc.value.get('remote-loose')).toEqual(['Project: Other One', `Tab: ${i18n.global.t('label.manual')}`])
  })

  it('is translated', () => {
    i18n.global.locale.value = 'zh-TW'
    const loc = harness()
    expect(loc.value.get('remote')).toEqual(['工作區：Other One', '分頁：Remote run', '已縮到側欄'])
  })

  it('renders on every list with the full text on hover', () => {
    const hints = appSource.match(/v-if="paneListLocation\.has\(p\.id\)"\s+class="pane-list-location"\s+v-truncate\s*>/g) ?? []
    expect(hints).toHaveLength(3)
  })
})
