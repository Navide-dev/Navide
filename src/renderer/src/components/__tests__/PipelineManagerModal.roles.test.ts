// @vitest-environment happy-dom
// Pipeline Manager — Roles tab. Regression cover for the "green Saved banner on
// a rejected save" bug: useRoles.upsert()/remove() resolve to null/false on
// backend rejection instead of throwing, so rSave()'s try/catch never fired and
// the success banner was written unconditionally.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { defineComponent, effectScope, type EffectScope } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useRoles, type Role } from '../../composables/useRoles'
import { usePipelines } from '../../composables/usePipelines'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// The dock owns a real PTY terminal (xterm); the roles tab never touches it.
vi.mock('@navide/plugin-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-shell')>()),
  AiCliDock: defineComponent({ name: 'AiCliDock', render: () => null }),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PipelineManagerModal = (await import('../PipelineManagerModal.vue')).default as any

i18n.global.locale.value = 'en-US'

const pm: Role = {
  key: 'pm', label: 'Project Manager', one_line: 'plans the work',
  system_prompt: '# Role: PM', is_default: true,
}
const dev: Role = {
  key: 'dev', label: 'Developer', one_line: 'writes the code',
  system_prompt: '# Role: Dev', is_default: true,
}
const baseRoles: Role[] = [pm, dev]

describe('PipelineManagerModal — roles tab', () => {
  let wrapper: VueWrapper | undefined
  let scope: EffectScope | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    scope?.stop()
    scope = undefined
  })

  async function open(
    roles: Role[] = baseRoles,
    options: { initialPipelineId?: string; selectRoles?: boolean } = {},
  ): Promise<{
    wrapper: VueWrapper
    mock: ReturnType<typeof createMockBackend>
    rolesApi: ReturnType<typeof useRoles>
  }> {
    const mock = createMockBackend('connected')
    mock.setResponse('roles.list', { roles, path: '/data/roles.json' })
    mock.setResponse('pipelines.list', {
      pipelines: [{ id: 'default', name: 'Default', builtin: true, stage_count: 0 }],
      active_pipeline_id: 'default',
      path: '/data/pipelines.json',
    })
    mock.setResponse('stages.list', {
      stages: [],
      pipeline_id: 'default',
      path: '/data/stages.json',
    })

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
        workspacePath: '/tmp/ws',
        open: true,
        initialPipelineId: options.initialPipelineId,
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    })
    await flushPromises()
    wrapper = w

    if (options.selectRoles !== false) {
      await w.findAll('.tabs button')[1].trigger('click')
      await flushPromises()
    }
    return { wrapper: w, mock, rolesApi }
  }

  it('opens an already-loaded initial pipeline after stage state is initialized', async () => {
    const { wrapper: w, mock } = await open(baseRoles, {
      initialPipelineId: 'default',
      selectRoles: false,
    })

    expect(w.text()).toContain('Default')
    expect(mock.sent).toContainEqual(expect.objectContaining({
      type: 'stages.list',
      payload: { pipeline_id: 'default' },
    }))
  })

  /** The roles tab body (index 1; index 0 is the pipelines tab). */
  function tab(w: VueWrapper): DOMWrapper<Element> {
    return w.findAll('.tab-body')[1]
  }
  function fields(w: VueWrapper): {
    key: DOMWrapper<HTMLInputElement>
    label: DOMWrapper<HTMLInputElement>
  } {
    const inputs = tab(w).findAll('.split-detail input')
    return {
      key: inputs[0] as DOMWrapper<HTMLInputElement>,
      label: inputs[1] as DOMWrapper<HTMLInputElement>,
    }
  }
  function saveBtn(w: VueWrapper): DOMWrapper<Element> {
    return tab(w).find('.detail-head .primary')
  }

  /** Pick an existing role and dirty its label so Save is enabled. */
  async function editExisting(w: VueWrapper, index = 0): Promise<void> {
    await tab(w).findAll('.split-list li')[index].trigger('click')
    await fields(w).label.setValue('Renamed Label')
    await flushPromises()
  }

  it('shows the error and no Saved banner when the backend rejects the upsert', async () => {
    const { wrapper: w, mock } = await open()
    mock.setResponse('roles.upsert', null, {
      ok: false, error: { code: 'ERR', message: 'roles.json is read-only' },
    })

    await editExisting(w)
    expect(saveBtn(w).attributes('disabled')).toBeUndefined()
    await saveBtn(w).trigger('click')
    await flushPromises()

    expect(tab(w).find('.err-msg').exists()).toBe(true)
    expect(tab(w).find('.err-msg').text()).toContain('roles.json is read-only')
    expect(tab(w).find('.summary-ok').exists()).toBe(false)
    expect(tab(w).text()).not.toContain('Saved')
  })

  it('shows the Saved banner only when the upsert actually succeeded', async () => {
    const { wrapper: w, mock } = await open()
    const saved: Role = { ...pm, label: 'Renamed Label' }
    mock.setResponse('roles.upsert', { role: saved, roles: [saved, dev] })

    await editExisting(w)
    await saveBtn(w).trigger('click')
    await flushPromises()

    expect(tab(w).find('.summary-ok').text()).toBe('Saved "Renamed Label"')
    expect(tab(w).find('.err-msg').exists()).toBe(false)
    expect(mock.sent.find((s) => s.type === 'roles.upsert')?.payload.label).toBe('Renamed Label')
  })

  it('clears a stale Saved banner when the next save is rejected', async () => {
    const { wrapper: w, mock } = await open()
    const saved: Role = { ...pm, label: 'Renamed Label' }
    mock.setResponse('roles.upsert', { role: saved, roles: [saved, dev] })

    await editExisting(w)
    await saveBtn(w).trigger('click')
    await flushPromises()
    expect(tab(w).find('.summary-ok').exists()).toBe(true)

    mock.setResponse('roles.upsert', null, {
      ok: false, error: { code: 'ERR', message: 'disk full' },
    })
    await fields(w).label.setValue('Second Attempt')
    await flushPromises()
    await saveBtn(w).trigger('click')
    await flushPromises()

    expect(tab(w).find('.summary-ok').exists()).toBe(false)
    expect(tab(w).find('.err-msg').text()).toContain('disk full')
  })

  it('reports a rejected key rename instead of claiming success', async () => {
    // A key change now goes to roles.rename, which either moves everything or
    // moves nothing. A refusal is still a refusal: no green banner.
    const { wrapper: w, mock, rolesApi } = await open()
    mock.setResponse('roles.rename', null, {
      ok: false, error: { code: 'INTERNAL_ERROR', message: 'roles.json is read-only' },
    })

    // rSorted is label-sorted: Developer, Project Manager.
    await tab(w).findAll('.split-list li')[0].trigger('click')
    await fields(w).key.setValue('engineer')
    await flushPromises()
    await saveBtn(w).trigger('click')
    await flushPromises()

    expect(mock.sent.find((s) => s.type === 'roles.rename')?.payload).toMatchObject({
      old_key: 'dev', new_key: 'engineer',
    })
    expect(tab(w).find('.err-msg').text()).toBe('roles.json is read-only')
    expect(tab(w).find('.summary-ok').exists()).toBe(false)
    // Nothing was written, so the half-finished two-key state is unreachable.
    expect(rolesApi.roles.value.map((r) => r.key)).toEqual(['pm', 'dev'])
  })

  it('never splits a key rename into upsert + delete', async () => {
    // The old two-step left both keys behind whenever roles.delete refused,
    // which it does as soon as any stage slot names the role.
    const { wrapper: w, mock } = await open()
    const renamed: Role = { ...dev, key: 'engineer' }
    mock.setResponse('roles.rename', {
      role: renamed, roles: [pm, renamed], repointed_pipeline_ids: [],
    })

    await tab(w).findAll('.split-list li')[0].trigger('click')
    await fields(w).key.setValue('engineer')
    await flushPromises()
    await saveBtn(w).trigger('click')
    await flushPromises()

    expect(mock.sent.some((s) => s.type === 'roles.upsert')).toBe(false)
    expect(mock.sent.some((s) => s.type === 'roles.delete')).toBe(false)
    expect(tab(w).find('.summary-ok').exists()).toBe(true)
  })

  it('keeps the half-typed new role when the roles list changes underneath', async () => {
    const { wrapper: w, mock } = await open()

    await tab(w).find('.new-btn').trigger('click')
    await fields(w).key.setValue('qa')
    await fields(w).label.setValue('QA Engin')
    await flushPromises()

    // Another window saves a role; the backend broadcast rewrites rolesApi.roles.
    const other: Role = { key: 'ux', label: 'UX', one_line: '', system_prompt: '# Role: UX' }
    mock.emit('roles.changed', { roles: [...baseRoles, other] })
    await flushPromises()

    expect(tab(w).find('.detail-head h3').text()).toBe(i18n.global.t('label.new-role'))
    expect(fields(w).key.element.value).toBe('qa')
    expect(fields(w).label.element.value).toBe('QA Engin')
  })

  it('counts every role an import could not write and names the first reason', async () => {
    const { wrapper: w, mock } = await open()
    // dev is rejected by the backend; the third entry has no system_prompt.
    mock.setResponse('roles.upsert', null, {
      ok: false, error: { code: 'ERR', message: 'roles.json is read-only' },
    })
    const openJson = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({ roles: [dev, { key: 'broken' }] }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).agentTeam = { openJson }

    await tab(w).findAll('.toolbar .ghost')[1].trigger('click')
    await flushPromises()

    expect(tab(w).find('.summary-ok').text()).toContain('Imported 0 role(s)')
    expect(tab(w).find('.summary-ok').text()).toContain('2 failed')
    expect(tab(w).find('.err-msg').text()).toContain('dev: roles.json is read-only')
    expect(tab(w).findAll('.toolbar .ghost')[1].attributes('disabled')).toBeUndefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).agentTeam
  })

  it('keeps a role\'s declared step fields through an import', async () => {
    const { wrapper: w, mock } = await open()
    const properties = [{ name: 'effort', type: 'options', options: [{ value: 'low' }, { value: 'high' }] }]
    mock.setResponse('roles.upsert', { role: { ...dev, properties }, roles: [pm, { ...dev, properties }] })
    const openJson = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify({ roles: [{ ...dev, properties }, pm] }) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).agentTeam = { openJson }

    await tab(w).findAll('.toolbar .ghost')[1].trigger('click')
    await flushPromises()

    const sent = mock.sent.filter((s) => s.type === 'roles.upsert')
    expect(sent[0].payload.properties).toEqual(properties)
    // A role exported without fields must not wipe the ones it has.
    expect('properties' in sent[1].payload).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).agentTeam
  })

  it('saves the step fields declared in the role editor', async () => {
    const { wrapper: w, mock } = await open()
    const saved: Role = { ...pm, properties: [{ name: 'field1', type: 'string' }] }
    mock.setResponse('roles.upsert', { role: saved, roles: [saved, dev] })

    await tab(w).findAll('.split-list li')[1].trigger('click') // Project Manager (sorted)
    await flushPromises()
    await tab(w).find('.rpe-add').trigger('click')
    await flushPromises()
    await saveBtn(w).trigger('click')
    await flushPromises()

    const sent = mock.sent.filter((s) => s.type === 'roles.upsert').at(-1)
    expect(sent?.payload.properties).toEqual([{ name: 'field1', type: 'string' }])
  })

  it('will not save fields the backend would refuse, and leaves untouched fields out', async () => {
    const { wrapper: w, mock } = await open()
    await tab(w).findAll('.split-list li')[1].trigger('click')
    await flushPromises()
    await tab(w).find('.rpe-add').trigger('click')
    await tab(w).find('.rpe-add').trigger('click')
    await tab(w).findAll('.rpe-name')[1].setValue('field1') // duplicate name
    await tab(w).findAll('.rpe-name')[1].trigger('change')
    await flushPromises()
    expect(saveBtn(w).attributes('disabled')).toBeDefined()

    // A plain label edit on a role whose fields did not change sends none.
    await tab(w).findAll('.split-list li')[0].trigger('click')
    await fields(w).label.setValue('Dev 2')
    await flushPromises()
    mock.setResponse('roles.upsert', { role: { ...dev, label: 'Dev 2' }, roles: [pm, { ...dev, label: 'Dev 2' }] })
    await saveBtn(w).trigger('click')
    await flushPromises()
    expect('properties' in (mock.sent.filter((s) => s.type === 'roles.upsert').at(-1)?.payload ?? {})).toBe(false)
  })
})
