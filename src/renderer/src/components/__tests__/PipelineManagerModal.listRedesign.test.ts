// @vitest-environment happy-dom
// Pipeline Manager — pipelines LIST view redesign (direction 甲).
//
// What is worth pinning here is structure and state, not looks:
//  1. every row lays out as the same four grid cells, including the two that
//     are conditionally filled — that is the fix for the right-hand column
//     drifting row by row;
//  2. the row tells the user what the backend already knew (builtin, default,
//     where the definitions live), in the UI locale;
//  3. loading / unreadable / genuinely-empty are three different screens, and
//     the empty one offers exactly ONE next step (resetBuiltin needs a
//     pipeline id, so "restore the builtin pipelines" cannot exist here);
//  4. the row is reachable and operable from the keyboard.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, effectScope, nextTick, type EffectScope } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useRoles, type Role } from '../../composables/useRoles'
import { usePipelines, type PipelineSummary } from '../../composables/usePipelines'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

vi.mock('@navide/plugin-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-shell')>()),
  AiCliDock: defineComponent({ name: 'AiCliDock', render: () => null }),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PipelineManagerModal = (await import('../PipelineManagerModal.vue')).default as any

const WORKSPACE = '/Users/me/Desktop/Agent-Team'
const PIPELINES_PATH = '/data/pipelines.json'

const roles: Role[] = [
  { key: 'pm', label: 'Project Manager', one_line: 'plans', system_prompt: '# PM' },
]
// One builtin+default row and one custom row: the builtin row carries two
// badges and the reset button, the custom row carries neither. Before the grid
// the two rows' right edges could not line up.
const pipelines: PipelineSummary[] = [
  { id: 'default', name: 'Default', builtin: true, stage_count: 5 },
  { id: 'custom', name: 'Custom', builtin: false, stage_count: 3 },
]

describe('PipelineManagerModal — list view redesign', () => {
  let wrapper: VueWrapper | undefined
  let scope: EffectScope | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    scope?.stop()
    scope = undefined
    i18n.global.locale.value = 'en-US'
  })

  async function open(
    options: {
      locale?: 'en-US' | 'zh-TW'
      listOk?: boolean
      listError?: { code: string; message: string }
    } = {}
  ) {
    i18n.global.locale.value = options.locale ?? 'en-US'
    const mock = createMockBackend('connected')
    mock.setResponse('roles.list', { roles, path: '/data/roles.json' })
    if (options.listOk === false) {
      mock.setResponse('pipelines.list', null, {
        ok: false,
        error: options.listError ?? { code: 'ERR', message: 'backend not connected' },
      })
    } else {
      mock.setResponse('pipelines.list', {
        pipelines,
        active_pipeline_id: 'default',
        path: PIPELINES_PATH,
      })
    }
    mock.setResponse('stages.list', { stages: [], pipeline_id: 'default', path: '/data/stages.json' })

    scope = effectScope()
    let rolesApi!: ReturnType<typeof useRoles>
    let pipelinesApi!: ReturnType<typeof usePipelines>
    scope.run(() => {
      rolesApi = useRoles(mock.backend)
      pipelinesApi = usePipelines(mock.backend)
    })
    await flushPromises()

    const w = mount(PipelineManagerModal, {
      props: {
        backend: mock.backend,
        terminalPort: createTerminalDockStub(),
        rolesApi,
        pipelinesApi,
        workspacePath: WORKSPACE,
        open: true,
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    })
    await flushPromises()
    wrapper = w
    return { wrapper: w, mock, pipelinesApi }
  }

  const tab = (w: VueWrapper) => w.findAll('.tab-body')[0]
  const t = (key: string, named?: Record<string, unknown>) =>
    named ? i18n.global.t(key, named) : i18n.global.t(key)

  // ── phase-row: the grid ────────────────────────────────────────────────────

  it('lays every row out as the same four cells, whatever is in them', async () => {
    const { wrapper: w } = await open()
    const rows = tab(w).findAll('.pl-list .pl-item')
    expect(rows).toHaveLength(2)

    for (const row of rows) {
      const cells = row.element.children
      // Exactly four: name | badges | stage count | actions. The optional
      // badge and reset button live INSIDE cells 2 and 4, so a row that has
      // neither still occupies the same four tracks.
      expect(cells).toHaveLength(4)
      expect(cells[0].className).toContain('pl-name')
      expect(cells[1].className).toContain('pl-tags')
      expect(cells[2].className).toContain('pl-meta')
      expect(cells[3].className).toContain('pl-actions')
    }
  })

  it('gives the non-builtin row an actions cell too, so the column cannot drift', async () => {
    const { wrapper: w } = await open()
    // Two rows, one reset button (only `default` is builtin) — but two action
    // cells and two chevrons. That asymmetry used to move the right edge.
    expect(tab(w).findAll('.pl-list .pl-actions')).toHaveLength(2)
    expect(tab(w).findAll('.pl-list .pl-enter')).toHaveLength(2)
    expect(tab(w).findAll('.pl-list .icon-btn')).toHaveLength(1)
  })

  // ── phase-info: badges, count, source path ─────────────────────────────────

  it('marks the builtin rows with a translated badge, and only the builtin rows', async () => {
    const { wrapper: w } = await open({ locale: 'zh-TW' })
    const rows = tab(w).findAll('.pl-list .pl-item')

    const builtinBadges = tab(w).findAll('.pl-badge--builtin')
    expect(builtinBadges).toHaveLength(1)
    expect(builtinBadges[0].text()).toBe(t('label.builtin'))
    expect(builtinBadges[0].text()).not.toBe('Built-in')
    // It belongs to the builtin row, not the custom one.
    expect(rows[0].find('.pl-badge--builtin').exists()).toBe(true)
    expect(rows[1].find('.pl-badge--builtin').exists()).toBe(false)
  })

  it('gives the default+builtin row two distinct badges and the custom row none', async () => {
    const { wrapper: w } = await open()
    const rows = tab(w).findAll('.pl-list .pl-item')
    // Two badges on row 0: `default` is both the active pipeline and builtin.
    // Before the redesign builtin was never surfaced, so this row had one.
    expect(rows[0].findAll('.pl-badge')).toHaveLength(2)
    const defaultBadges = rows[0].findAll('.pl-badge:not(.pl-badge--builtin)')
    expect(defaultBadges).toHaveLength(1)
    expect(defaultBadges[0].text()).toBe(t('label.default'))
    expect(rows[1].findAll('.pl-badge')).toHaveLength(0)
  })

  it('states how many pipelines there are', async () => {
    const { wrapper: w } = await open({ locale: 'zh-TW' })
    expect(tab(w).find('.pl-count').text()).toBe(t('label.pipeline-count', { count: 2 }))
  })

  it('shows where the pipeline definitions live', async () => {
    const { wrapper: w } = await open()
    const source = tab(w).find('.pl-source')
    expect(source.exists()).toBe(true)
    expect(source.text()).toContain(t('label.pipeline-definition-file'))
    expect(source.find('.pl-source-path').text()).toBe(PIPELINES_PATH)
  })

  // ── phase-shell / i18n: the header status word ─────────────────────────────

  it('translates the backend status word instead of interpolating the raw one', async () => {
    const { wrapper: w } = await open({ locale: 'zh-TW' })
    const meta = w.find('.meta').text()
    expect(meta).toBe(t('label.backend-status', { status: t('label.backend-state-connected') }))
    // The raw BackendStatus value used to leak straight through.
    expect(meta).not.toContain('connected')
  })

  it('has a translated word for every BackendStatus, in both locales', () => {
    const states = ['starting', 'connecting', 'connected', 'disconnected', 'error']
    for (const locale of ['en-US', 'zh-TW'] as const) {
      i18n.global.locale.value = locale
      for (const s of states) {
        const key = `label.backend-state-${s}`
        expect(i18n.global.t(key), `${locale} ${key}`).not.toBe(key)
      }
    }
  })

  // ── phase-empty: three distinct states ─────────────────────────────────────

  it('says the definitions could not be read when the list call failed, and offers a retry', async () => {
    const { wrapper: w, mock, pipelinesApi } = await open({ listOk: false })
    expect(pipelinesApi.error.value).not.toBe('')
    expect(tab(w).find('.pl-list').exists()).toBe(false)

    const empty = tab(w).find('.pl-empty')
    expect(empty.find('.pl-empty-title').text()).toBe(t('label.pipelines-unreadable'))
    expect(empty.find('.pl-empty-body').text()).toBe(t('hint.pipelines-unreadable'))
    // Not the old "No pipelines loaded…" copy, which described loading.
    expect(empty.text()).not.toContain(t('label.no-pipelines'))

    const before = mock.sent.filter((s) => s.type === 'pipelines.list').length
    await empty.find('.pl-retry').trigger('click')
    await flushPromises()
    expect(mock.sent.filter((s) => s.type === 'pipelines.list')).toHaveLength(before + 1)
  })

  it('invites the user to create one when the list is genuinely empty — with exactly one CTA', async () => {
    const { wrapper: w, pipelinesApi } = await open()
    pipelinesApi.pipelines.value = []
    pipelinesApi.error.value = ''
    await nextTick()

    const empty = tab(w).find('.pl-empty')
    expect(empty.find('.pl-empty-title').text()).toBe(t('label.pipelines-empty'))
    expect(empty.find('.pl-empty-body').text()).toBe(t('hint.pipelines-empty'))
    // ONE next step. A second "restore the builtin pipelines" button was drawn
    // in the mockup, but resetBuiltin(id) needs a pipeline id and an empty list
    // has none to give it, so it must not exist.
    expect(empty.findAll('.pl-empty-actions button')).toHaveLength(1)
    expect(empty.find('.pl-empty-create').text()).toBe(t('action.new-pipeline'))

    await empty.find('.pl-empty-create').trigger('click')
    await nextTick()
    expect(tab(w).find('.pl-create-row').exists()).toBe(true)
  })

  it('shows a loading line while the first list call is still in flight', async () => {
    const { wrapper: w, pipelinesApi } = await open()
    pipelinesApi.pipelines.value = []
    pipelinesApi.error.value = ''
    pipelinesApi.loading.value = true
    await nextTick()

    const loading = tab(w).find('.pl-state.nv-loading')
    expect(loading.exists()).toBe(true)
    expect(loading.text()).toBe(t('label.loading-pipelines'))
    // Loading is not the same screen as "nothing here".
    expect(tab(w).find('.pl-empty').exists()).toBe(false)
  })

  // ── phase-a11y ─────────────────────────────────────────────────────────────

  it('makes the row focusable and operable from the keyboard', async () => {
    const { wrapper: w } = await open()
    const row = tab(w).findAll('.pl-list .pl-item')[1]
    // role="button" alone is not focusable — it needs a tab stop.
    expect(row.attributes('tabindex')).toBe('0')
    expect(row.attributes('role')).toBe('button')
    expect(row.attributes('aria-label')).toBe(
      t('action.open-pipeline-named', { name: 'Custom' })
    )

    await row.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(tab(w).find('.pl-detail-title').text()).toContain('Custom')
  })

  it('labels the two row affordances instead of shipping bare glyphs', async () => {
    const { wrapper: w } = await open()
    const reset = tab(w).find('.pl-list .icon-btn')
    expect(reset.attributes('aria-label')).toBe(t('action.reset-factory-stages'))
    expect(reset.attributes('title')).toBe(t('action.reset-factory-stages'))

    const chevron = tab(w).find('.pl-list .pl-enter')
    expect(chevron.attributes('title')).toBe(t('action.open-pipeline'))
    // Decorative: the row's own aria-label already names the action, so the
    // chevron must not be announced a second time.
    expect(chevron.attributes('aria-hidden')).toBe('true')
  })

  it('keeps both row affordances rendered, not hover-revealed', async () => {
    const { wrapper: w } = await open()
    // A display:none element cannot be tabbed to. Both are in the DOM with no
    // hover interaction needed.
    expect(tab(w).find('.pl-list .icon-btn').isVisible()).toBe(true)
    expect(tab(w).find('.pl-list .pl-enter').isVisible()).toBe(true)
  })

  // ── i18n bookkeeping for the keys this redesign added ──────────────────────

  it('ships every new key in both locales with matching placeholders', () => {
    const dir = 'packages/plugin-ui/src/foundation/i18n/locales'
    const read = (f: string) =>
      JSON.parse(readFileSync(resolve(process.cwd(), dir, f), 'utf8')) as Record<
        string,
        Record<string, string>
      >
    const en = read('en-US.json')
    const zh = read('zh-TW.json')
    const ADDED = [
      'action.open-pipeline',
      'action.open-pipeline-named',
      'label.pipeline-count',
      'label.builtin',
      'label.pipeline-definition-file',
      'label.loading-pipelines',
      'label.pipelines-unreadable',
      'label.pipelines-empty',
      'label.backend-state-starting',
      'label.backend-state-connecting',
      'label.backend-state-connected',
      'label.backend-state-disconnected',
      'label.backend-state-error',
      'hint.pipelines-unreadable',
      'hint.pipelines-empty',
    ]
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const key of ADDED) {
      const [group, leaf] = key.split('.') as [string, string]
      expect(en[group]?.[leaf], `en-US is missing ${key}`).toBeTypeOf('string')
      expect(zh[group]?.[leaf], `zh-TW is missing ${key}`).toBeTypeOf('string')
      expect(placeholders(zh[group][leaf]), `${key} placeholders`).toEqual(
        placeholders(en[group][leaf])
      )
    }
    // The old empty-state key is still used by ControlPane, so its copy is
    // untouched — the redesign added keys rather than repurposing that one.
    expect(en.label['no-pipelines']).toBe('No pipelines loaded…')
    expect(en.label['backend-status']).toBe('backend {status}')
  })
})
