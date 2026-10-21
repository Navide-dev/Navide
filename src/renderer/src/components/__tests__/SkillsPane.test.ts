// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import SkillsPane from '../SkillsPane.vue'

const skill = {
  name: 'review-code',
  description: 'Review changes carefully',
  enabled: true,
  valid: true,
  path: '/tmp/skills/review-code',
  revision: 'rev-1',
  fields: {
    name: 'review-code',
    description: 'Review changes carefully',
    'user-invocable': true,
    'disable-model-invocation': false,
    'allowed-tools': ['Read', 'Grep'],
    unknown: { preserved: true },
  },
  body: 'Check the diff.',
  attachments: [{ path: 'references/checklist.md', size: 42 }],
}

const agents = [
  { key: 'claude', label: 'Claude Code', state: 'wired', reads_shared_root: false },
  { key: 'kimi', label: 'Kimi Code', state: 'wired', reads_shared_root: false },
  { key: 'pi', label: 'Pi', state: 'wired', reads_shared_root: false },
  { key: 'codex', label: 'Codex', state: 'wired', reads_shared_root: true },
  { key: 'aider', label: 'Aider', state: 'unsupported', reads_shared_root: false },
]

const nativeSkill = {
  name: 'bug-buster',
  description: 'Fixes bugs',
  source: 'copilot',
  owner_agent: 'copilot',
  path: '/Users/x/.copilot/skills/bug-buster',
  real_path: '/Users/x/.copilot/skills/bug-buster',
  aliases: [],
  valid: true,
  error: '',
}

function mockBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    // Consent already on record: the default fixture is about everything
    // *after* the first write into ~/.agents/skills was allowed.
    'skills.list': { ok: true, payload: { skills: [skill], root: '/tmp/skills', agents, write_consented: true } },
    'skills.get': { ok: true, payload: { skill } },
    'skills.create': { ok: true, payload: { skill } },
    'skills.save': { ok: true, payload: { ok: true, skill: { ...skill, revision: 'rev-2' } } },
    'skills.set_enabled': { ok: true, payload: { skill: { ...skill, enabled: false } } },
    'skills.delete': { ok: true, payload: { name: skill.name, deleted: true } },
    'skills.set_targets': { ok: true, payload: { skill } },
    'skills.set_native_targets': { ok: true, payload: { ok: true } },
    ...overrides,
  }
  const send = vi.fn(async (type: string, _payload?: unknown) => responses[type])
  const status = ref('connected')
  const listeners = new Map<string, () => void>()
  const off = vi.fn()
  const on = vi.fn((type: string, callback: () => void) => {
    listeners.set(type, callback)
    return () => { listeners.delete(type); off() }
  })
  return { backend: { send, on, status } as never, send, responses, listeners, off, status }
}

/** In the merged layout nothing is selected on load: click a card to open the drawer. */
async function openCard(wrapper: VueWrapper, name: string): Promise<void> {
  const card = wrapper.findAll('.skill-card').find((c) => c.find('strong').text() === name)
  if (!card) throw new Error(`no card named ${name}`)
  await card.trigger('click')
  await flushPromises()
}

/** Switch to the route (matrix) view. */
async function openMatrixView(wrapper: VueWrapper): Promise<void> {
  const btn = wrapper.findAll('.skills-view-switch button').find((b) => b.text() === 'Route')
  await btn!.trigger('click')
  await flushPromises()
}

describe('SkillsPane', () => {
  let wrapper: VueWrapper | undefined
  const openPath = vi.fn().mockResolvedValue({ ok: true })

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = { openPath } as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    openPath.mockClear()
    vi.restoreAllMocks()
  })

  it('loads the library and renders editable fields and read-only attachments', async () => {
    const { backend, send } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.list', {})
    // Nothing is auto-selected any more; the card is the entry point.
    expect(wrapper.find('.skills-drawer').exists()).toBe(false)
    expect(wrapper.get('.skill-card strong').text()).toBe('review-code')

    await openCard(wrapper, 'review-code')
    expect(send).toHaveBeenCalledWith('skills.get', { name: 'review-code' })
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Check the diff.')
    expect(wrapper.get('.skill-attachments').text()).toContain('references/checklist.md')

    const open = wrapper.findAll('.skills-drawer button').find((b) => b.text() === 'Open Folder')
    await open!.trigger('click')
    expect(openPath).toHaveBeenCalledWith('/tmp/skills/review-code')
  })

  it('marks a managed skill whose files are too large to sync', async () => {
    const { backend } = mockBackend({
      'skills.list': {
        ok: true,
        payload: {
          skills: [{ ...skill, managed: true, sync_too_large: true }, { ...skill, name: 'small', managed: true, sync_too_large: false }],
          root: '/tmp/skills', agents, write_consented: true,
        },
      },
    })
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const badges = wrapper.findAll('[data-testid="skill-sync-too-large"]')
    expect(badges).toHaveLength(1)
    expect(badges[0].text()).toBe('Not synced: too large')
    expect(badges[0].attributes('title')).toContain('on/off and delivery settings still sync')

    await openCard(wrapper, 'review-code')
    expect(wrapper.get('[data-testid="skill-drawer-sync-too-large"]').text()).toBe('Not synced: too large')
    await openCard(wrapper, 'small')
    expect(wrapper.find('[data-testid="skill-drawer-sync-too-large"]').exists()).toBe(false)

    i18n.global.locale.value = 'zh-TW'
    await flushPromises()
    expect(wrapper.get('[data-testid="skill-sync-too-large"]').text()).toBe('檔案太大，不跨裝置同步')
    i18n.global.locale.value = 'ja-JP'
    await flushPromises()
    expect(wrapper.get('[data-testid="skill-sync-too-large"]').text()).toBe('大きすぎて同期不可')
  })

  it('shows a large skill syncing through blobs, with live transfer progress', async () => {
    const { backend, listeners, send } = mockBackend({
      'skills.list': {
        ok: true,
        payload: {
          skills: [{ ...skill, managed: true, sync_too_large: false, sync_via_blobs: true }],
          root: '/tmp/skills', agents, write_consented: true,
        },
      },
    })
    const mounted = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    wrapper = mounted
    await flushPromises()

    expect(mounted.find('[data-testid="skill-sync-too-large"]').exists()).toBe(false)
    const badge = () => mounted.get('[data-testid="skill-sync-via-blobs"]')
    expect(badge().text()).toBe('Files sync separately')
    expect(badge().attributes('title')).toContain('encrypted file uploads')

    const progress = listeners.get('skills.sync_progress') as unknown as (raw: unknown) => void
    progress({ name: 'review-code', transfer: { direction: 'upload', done: 42, total: 100 } })
    await flushPromises()
    expect(badge().text()).toBe('Uploading 42%')
    await openCard(wrapper, 'review-code')
    expect(wrapper.get('[data-testid="skill-drawer-sync-via-blobs"]').text()).toBe('Uploading 42%')

    // Finished: the plain label comes back and the list is read again.
    const lists = send.mock.calls.filter(([type]) => type === 'skills.list').length
    progress({ name: 'review-code', transfer: null })
    await flushPromises()
    expect(badge().text()).toBe('Files sync separately')
    expect(send.mock.calls.filter(([type]) => type === 'skills.list').length).toBe(lists + 1)

    i18n.global.locale.value = 'zh-TW'
    progress({ name: 'review-code', transfer: { direction: 'download', done: 5, total: 10 } })
    await flushPromises()
    expect(badge().text()).toBe('下載中 50%')
  })

  it('creates a skill and reloads it into the editor', async () => {
    const { backend, send } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('.skills-toolbar .primary').trigger('click')
    const inputs = wrapper.findAll('.skills-create input')
    await inputs[0].setValue('new-skill')
    await inputs[1].setValue('A new skill')
    await wrapper.get('.skills-create').trigger('submit')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.create', {
      name: 'new-skill',
      description: 'A new skill',
      consent: true,
    })
  })

  it('refreshes external changes without replacing an unsaved editor draft', async () => {
    const { backend, send, responses, listeners } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    await wrapper.get('.skill-body').setValue('Unsaved local instructions')
    responses['skills.list'] = {
      ok: true,
      payload: { skills: [skill, { ...skill, name: 'installed-externally' }], agents },
    }
    responses['skills.save'] = { ok: false, error: { code: 'SKILL_CONFLICT', message: 'stale revision' } }

    expect(listeners.has('skills.changed')).toBe(true)
    listeners.get('skills.changed')!()
    await flushPromises()

    expect(wrapper.findAll('.skill-card strong').map((card) => card.text())).toContain('installed-externally')
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Unsaved local instructions')
    expect(send.mock.calls.filter(([type]) => type === 'skills.get')).toHaveLength(1)
    await wrapper.get('.skill-editor-actions .primary').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('skills.save', expect.objectContaining({ expected_revision: 'rev-1' }))
    expect(wrapper.find('.skills-conflict').exists()).toBe(true)
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Unsaved local instructions')
  })

  it('keeps a dirty draft visible when another client deletes its skill', async () => {
    const { backend, responses, listeners } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    await wrapper.get('.skill-body').setValue('Keep these instructions')
    responses['skills.list'] = { ok: true, payload: { skills: [], agents } }

    expect(listeners.has('skills.changed')).toBe(true)
    listeners.get('skills.changed')!()
    await flushPromises()

    expect(wrapper.findAll('.skill-card')).toHaveLength(0)
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Keep these instructions')
    expect(wrapper.find('.skills-conflict').exists()).toBe(true)
  })

  it('reloads an unchanged editor and removes its event listener on unmount', async () => {
    const { backend, responses, listeners, off } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    responses['skills.get'] = { ok: true, payload: { skill: { ...skill, body: 'External edit', revision: 'rev-2' } } }

    expect(listeners.has('skills.changed')).toBe(true)
    listeners.get('skills.changed')!()
    await flushPromises()
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('External edit')

    wrapper.unmount()
    wrapper = undefined
    // skills.changed and skills.sync_progress
    expect(off).toHaveBeenCalledTimes(2)
    expect(listeners.has('skills.changed')).toBe(false)
    expect(listeners.has('skills.sync_progress')).toBe(false)
  })

  it('preserves edits typed while a save is awaiting its response', async () => {
    const { backend, send, listeners } = mockBackend()
    const originalSend = send.getMockImplementation()!
    let finishSave: ((value: unknown) => void) | undefined
    send.mockImplementation((type, payload) => type === 'skills.save'
      ? new Promise((resolve) => { finishSave = resolve })
      : originalSend(type, payload))
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    await wrapper.get('.skill-body').setValue('Submitted instructions')
    await wrapper.get('.skill-editor-actions .primary').trigger('click')
    await wrapper.get('.skill-body').setValue('New unsaved instructions')
    finishSave!({ ok: true, payload: { skill: { ...skill, revision: 'rev-2' } } })
    await flushPromises()

    listeners.get('skills.changed')!()
    await flushPromises()

    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('New unsaved instructions')
    expect(send.mock.calls.filter(([type]) => type === 'skills.get')).toHaveLength(1)
  })

  it('keeps edits typed while an external editor refresh is awaiting its response', async () => {
    const { backend, send, listeners } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    const originalSend = send.getMockImplementation()!
    let finishRefresh: ((value: unknown) => void) | undefined
    send.mockImplementation((type, payload) => type === 'skills.get'
      ? new Promise((resolve) => { finishRefresh = resolve })
      : originalSend(type, payload))
    listeners.get('skills.changed')!()
    await flushPromises()

    await wrapper.get('.skill-body').setValue('Typed during external refresh')
    finishRefresh!({ ok: true, payload: { skill: { ...skill, body: 'External instructions', revision: 'rev-2' } } })
    await flushPromises()

    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Typed during external refresh')
  })

  it('does not replace a different selected skill with a late external refresh', async () => {
    const otherSkill = { ...skill, name: 'other-skill', body: 'Other instructions' }
    const { backend, send, listeners } = mockBackend({
      'skills.list': { ok: true, payload: { skills: [skill, otherSkill], agents } },
    })
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    const originalSend = send.getMockImplementation()!
    let finishRefresh: ((value: unknown) => void) | undefined
    send.mockImplementation((type, payload) => {
      if (type !== 'skills.get') return originalSend(type, payload)
      if ((payload as { name: string }).name === otherSkill.name) return Promise.resolve({ ok: true, payload: { skill: otherSkill } })
      return new Promise((resolve) => { finishRefresh = resolve })
    })
    listeners.get('skills.changed')!()
    await flushPromises()
    await openCard(wrapper, otherSkill.name)
    finishRefresh!({ ok: true, payload: { skill: { ...skill, body: 'Late instructions' } } })
    await flushPromises()

    expect(wrapper.get('.skills-drawer h3').text()).toBe(otherSkill.name)
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe(otherSkill.body)
  })

  it('applies the latest external editor refresh when earlier responses finish first', async () => {
    const { backend, send, listeners } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    const originalSend = send.getMockImplementation()!
    const finishRefresh: Array<(value: unknown) => void> = []
    send.mockImplementation((type, payload) => type === 'skills.get'
      ? new Promise((resolve) => { finishRefresh.push(resolve) })
      : originalSend(type, payload))

    listeners.get('skills.changed')!()
    await flushPromises()
    listeners.get('skills.changed')!()
    await flushPromises()
    expect(finishRefresh).toHaveLength(2)
    finishRefresh[0]({ ok: true, payload: { skill: { ...skill, body: 'Earlier external edit', revision: 'rev-2' } } })
    await flushPromises()
    finishRefresh[1]({ ok: true, payload: { skill: { ...skill, body: 'Latest external edit', revision: 'rev-3' } } })
    await flushPromises()

    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Latest external edit')
  })

  it.each([true, false])('keeps a newly selected skill independent of an earlier save result: %s', async (saved) => {
    const otherSkill = { ...skill, name: 'other-skill', body: 'Other instructions' }
    const { backend, send, responses, listeners } = mockBackend({
      'skills.list': { ok: true, payload: { skills: [skill, otherSkill], agents } },
    })
    const originalSend = send.getMockImplementation()!
    let finishSave: ((value: unknown) => void) | undefined
    send.mockImplementation((type, payload) => type === 'skills.save'
      ? new Promise((resolve) => { finishSave = resolve })
      : originalSend(type, payload))
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    await wrapper.get('.skill-body').setValue('Saved first skill')
    await wrapper.get('.skill-editor-actions .primary').trigger('click')
    responses['skills.get'] = { ok: true, payload: { skill: otherSkill } }
    await openCard(wrapper, otherSkill.name)
    finishSave!(saved
      ? { ok: true, payload: { skill: { ...skill, revision: 'rev-2' } } }
      : { ok: false, error: { code: 'SKILL_CONFLICT', message: 'Earlier skill changed' } })
    await flushPromises()
    expect(wrapper.find('.skills-conflict').exists()).toBe(false)

    responses['skills.get'] = { ok: true, payload: { skill: { ...otherSkill, body: 'Latest other instructions', revision: 'other-rev-2' } } }
    listeners.get('skills.changed')!()
    await flushPromises()

    expect(wrapper.get('.skills-drawer h3').text()).toBe(otherSkill.name)
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Latest other instructions')
  })

  it('keeps mutation controls busy while selecting another skill during a save', async () => {
    const otherSkill = { ...skill, name: 'other-skill' }
    const { backend, send, responses } = mockBackend({
      'skills.list': { ok: true, payload: { skills: [skill, otherSkill], agents } },
    })
    const originalSend = send.getMockImplementation()!
    let finishSave: ((value: unknown) => void) | undefined
    send.mockImplementation((type, payload) => type === 'skills.save'
      ? new Promise((resolve) => { finishSave = resolve })
      : originalSend(type, payload))
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    await wrapper.get('.skill-editor-actions .primary').trigger('click')
    responses['skills.get'] = { ok: true, payload: { skill: otherSkill } }
    await openCard(wrapper, otherSkill.name)

    expect(wrapper.get('.skill-editor-actions .primary').attributes('disabled')).toBeDefined()
    finishSave!({ ok: true, payload: { skill: { ...skill, revision: 'rev-2' } } })
    await flushPromises()
    expect(wrapper.get('.skill-editor-actions .primary').attributes('disabled')).toBeUndefined()
  })

  it('does not replace a newer library snapshot with an older list response', async () => {
    const { backend, send, listeners } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    const originalSend = send.getMockImplementation()!
    const finishList: Array<(value: unknown) => void> = []
    send.mockImplementation((type, payload) => type === 'skills.list'
      ? new Promise((resolve) => { finishList.push(resolve) })
      : originalSend(type, payload))
    listeners.get('skills.changed')!()
    listeners.get('skills.changed')!()
    await flushPromises()

    finishList[1]({ ok: true, payload: { skills: [skill, { ...skill, name: 'latest-install' }], agents } })
    await flushPromises()
    finishList[0]({ ok: true, payload: { skills: [skill], agents } })
    await flushPromises()

    expect(wrapper.findAll('.skill-card strong').map((card) => card.text())).toContain('latest-install')
  })

  it.each(['close', 'native'])('releases a pending shared selection after %s navigation', async (navigation) => {
    const { backend, send } = mockBackend({
      'skills.list': { ok: true, payload: { skills: [skill], native: [nativeSkill], agents } },
    })
    const originalSend = send.getMockImplementation()!
    let finishSelection: ((value: unknown) => void) | undefined
    send.mockImplementation((type, payload) => type === 'skills.get'
      ? new Promise((resolve) => { finishSelection = resolve })
      : originalSend(type, payload))
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    if (navigation === 'close') await wrapper.get('.skill-drawer-close').trigger('click')
    else await openCard(wrapper, nativeSkill.name)
    finishSelection!({ ok: true, payload: { skill } })
    await flushPromises()

    expect(wrapper.get('.skills-toolbar .primary').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.skill-body').exists()).toBe(false)
  })

  it.each([false, true])('refreshes missed changes on reconnect and preserves a dirty draft: %s', async (dirty) => {
    const { backend, send, status, responses } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    if (dirty) await wrapper.get('.skill-body').setValue('Unsaved before reconnect')
    status.value = 'disconnected'
    await flushPromises()
    responses['skills.list'] = { ok: true, payload: { skills: [skill, { ...skill, name: 'missed-install' }], agents } }
    responses['skills.get'] = { ok: true, payload: { skill: { ...skill, body: 'Changed while disconnected', revision: 'rev-2' } } }
    status.value = 'connected'
    await flushPromises()

    expect(wrapper.findAll('.skill-card strong').map((card) => card.text())).toContain('missed-install')
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe(
      dirty ? 'Unsaved before reconnect' : 'Changed while disconnected'
    )
    if (dirty) {
      responses['skills.save'] = { ok: false, error: { code: 'SKILL_CONFLICT', message: 'stale revision' } }
      await wrapper.get('.skill-editor-actions .primary').trigger('click')
      await flushPromises()
      expect(send).toHaveBeenCalledWith('skills.save', expect.objectContaining({ expected_revision: 'rev-1' }))
      expect(wrapper.find('.skills-conflict').exists()).toBe(true)
      expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Unsaved before reconnect')
    }
  })

  it('does not treat a saved enabled toggle as unsaved editor content', async () => {
    const { backend, responses, listeners } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, skill.name)
    await wrapper.get('.skill-drawer-toggle [role="switch"]').trigger('click')
    await flushPromises()
    responses['skills.get'] = { ok: true, payload: { skill: { ...skill, body: 'External after toggle', revision: 'rev-2' } } }
    listeners.get('skills.changed')!()
    await flushPromises()

    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('External after toggle')
  })

  it('sends a known-field patch and keeps the draft visible on conflict', async () => {
    const { backend, send } = mockBackend({
      'skills.save': {
        ok: false,
        payload: null,
        error: { code: 'SKILL_CONFLICT', message: 'stale revision' },
      },
    })
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await openCard(wrapper, 'review-code')
    await wrapper.get('.skill-body').setValue('Unsaved local draft')
    await wrapper.get('.skill-editor-actions .primary').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith(
      'skills.save',
      expect.objectContaining({
        name: 'review-code',
        body: 'Unsaved local draft',
        expected_revision: 'rev-1',
        fields: expect.objectContaining({ name: 'review-code', description: 'Review changes carefully' }),
      })
    )
    expect(wrapper.find('.skills-conflict').exists()).toBe(true)
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Unsaved local draft')
  })

  it('uses hyphenated aliases as canonical and synchronizes existing underscore aliases on save', async () => {
    const skillWithAliases = {
      ...skill,
      fields: {
        ...skill.fields,
        'user-invocable': false,
        user_invocable: true,
        'disable-model-invocation': true,
        disable_model_invocation: false,
        'allowed-tools': ['Read'],
        allowed_tools: ['Write'],
        'disallowed-tools': ['Bash'],
        disallowed_tools: ['Edit'],
      },
    }
    const { backend, send } = mockBackend({
      'skills.list': { ok: true, payload: { skills: [skillWithAliases], root: '/tmp/skills' } },
      'skills.get': { ok: true, payload: { skill: skillWithAliases } },
    })
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, 'review-code')

    await wrapper.get('.skill-editor-actions .primary').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith(
      'skills.save',
      expect.objectContaining({
        fields: expect.objectContaining({
          'user-invocable': false,
          user_invocable: false,
          'disable-model-invocation': true,
          disable_model_invocation: true,
          'allowed-tools': ['Read'],
          allowed_tools: ['Read'],
          'disallowed-tools': ['Bash'],
          disallowed_tools: ['Bash'],
        }),
      })
    )
  })

  it('normalizes native_conflict into the list status rail and editor warning', async () => {
    const conflictingSkill = { ...skill, native_conflict: true }
    const { backend } = mockBackend({
      'skills.list': { ok: true, payload: { skills: [conflictingSkill], root: '/tmp/skills' } },
      'skills.get': { ok: true, payload: { skill: conflictingSkill } },
    })
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, 'review-code')

    // Only shown when a CLI's own skill really shares the name — never as
    // decoration on an ordinary shared skill.
    expect(wrapper.get('.skills-drawer .skill-badge.warning').text())
      .toBe(i18n.global.t('settings.skills.native-conflict'))
  })

  it('does not show the native-conflict badge when there is no collision', async () => {
    const { backend } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, 'review-code')

    expect(wrapper.find('.skills-drawer .skill-badge.warning').exists()).toBe(false)
  })

  it('updates enabled state only after success and moves deletions to Trash', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { backend, send } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, 'review-code')

    await wrapper.get('.skill-drawer-toggle [role="switch"]').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('skills.set_enabled', { name: 'review-code', enabled: false })

    await wrapper.get('.skill-editor-actions .danger').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('skills.delete', { name: 'review-code' })
  })
})

describe('SkillsPane capability matrix', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = {} as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  async function openMatrix(overrides: Record<string, unknown> = {}) {
    const mocked = mockBackend(overrides)
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openMatrixView(wrapper)
    return mocked
  }

  it('renders one column per agent and marks the three capability states apart', async () => {
    await openMatrix()

    const headers = wrapper!.findAll('.skills-matrix thead th')
    expect(headers.map((th) => th.text())).toEqual([
      'Skill', 'claude', 'kimi', 'pi', 'codex', 'aider', '',
    ])
    const cells = wrapper!.findAll('.skills-matrix tbody td')
    // Targets are unset, so every deliverable agent receives it.
    expect(cells[0].classes()).toContain('on')
    expect(cells[1].classes()).toContain('on')
    expect(cells[2].classes()).toContain('on')
    // codex reads ~/.agents/skills itself: automatic, not a switch.
    expect(cells[3].classes()).toContain('auto')
    expect(cells[4].classes()).toContain('unsupported')
  })

  it('paints an automatic cell as delivered but never toggleable', async () => {
    const { send } = await openMatrix()
    const codex = wrapper!.findAll('.skills-matrix tbody td')[3]

    expect(codex.find('button').text()).toBe('●')
    expect((codex.find('button').element as HTMLButtonElement).disabled).toBe(true)
    await codex.find('button').trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalledWith('skills.set_targets', expect.anything())
  })

  it('does not count automatic agents when deciding a row is "all"', async () => {
    const { send } = await openMatrix({
      'skills.list': {
        ok: true,
        payload: { skills: [{ ...skill, targets: ['claude', 'pi'] }], root: '/tmp/skills', agents },
      },
    })

    // Re-adding kimi completes the editable set {claude, kimi, pi}; codex is
    // automatic and must not keep the row from collapsing back to null.
    await wrapper!.findAll('.skills-matrix tbody td')[1].find('button').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.set_targets', { name: 'review-code', agents: null })
  })

  it('never lets an unwired agent be toggled', async () => {
    const { send } = await openMatrix()
    const cells = wrapper!.findAll('.skills-matrix tbody td')

    expect((cells[3].find('button').element as HTMLButtonElement).disabled).toBe(true)
    expect((cells[4].find('button').element as HTMLButtonElement).disabled).toBe(true)

    await cells[4].find('button').trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalledWith('skills.set_targets', expect.anything())
  })

  it('materializes the implicit all-agents list when one cell is switched off', async () => {
    const { send } = await openMatrix()

    await wrapper!.findAll('.skills-matrix tbody td')[1].find('button').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.set_targets', {
      name: 'review-code',
      agents: ['claude', 'pi'],
    })
  })

  it('returns to the unrestricted list when every wired agent is selected again', async () => {
    const { send } = await openMatrix({
      'skills.list': {
        ok: true,
        payload: { skills: [{ ...skill, targets: ['claude', 'pi'] }], root: '/tmp/skills', agents },
      },
    })

    await wrapper!.findAll('.skills-matrix tbody td')[1].find('button').trigger('click')
    await flushPromises()

    // Not ['claude','pi','kimi'] — an explicit full list would freeze today's
    // agents and stop following newly wired ones.
    expect(send).toHaveBeenCalledWith('skills.set_targets', {
      name: 'review-code',
      agents: null,
    })
  })

  it('sends null for the whole row and an empty list for none', async () => {
    const { send } = await openMatrix()
    const bulk = wrapper!.findAll('.skills-matrix td.bulk button')

    await bulk[1].trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('skills.set_targets', { name: 'review-code', agents: [] })

    await bulk[0].trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('skills.set_targets', { name: 'review-code', agents: null })
  })

  it('rolls the cell back when the backend rejects the change', async () => {
    await openMatrix({ 'skills.set_targets': { ok: false, error: { message: 'nope' } } })
    const cell = () => wrapper!.findAll('.skills-matrix tbody td')[1]

    await cell().find('button').trigger('click')
    await flushPromises()

    expect(cell().classes()).toContain('on')
    expect(wrapper!.find('.skills-error').text()).toBeTruthy()
  })

  it('shows a disabled skill as delivered nowhere', async () => {
    await openMatrix({
      'skills.list': {
        ok: true,
        payload: { skills: [{ ...skill, enabled: false }], root: '/tmp/skills', agents },
      },
    })

    const row = wrapper!.find('.skills-matrix tbody tr:not(.group)')
    expect(row.classes()).toContain('off')
    expect(wrapper!.findAll('.skills-matrix tbody td.on')).toHaveLength(0)
    expect(
      (wrapper!.findAll('.skills-matrix tbody td')[0].find('button').element as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })
})


describe('SkillsPane native skills', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = { openPath: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  async function open(view: 'browse' | 'route', extra: Record<string, unknown> = {}) {
    const mocked = mockBackend({
      'skills.list': {
        ok: true,
        payload: {
          skills: [skill],
          native: [nativeSkill],
          native_targets: {},
          root: '/tmp/skills',
          agents,
          ...extra,
        },
      },
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    if (view === 'route') await openMatrixView(wrapper)
    return mocked
  }

  it('lists a native skill read-only under its own group with its source', async () => {
    await open('browse')

    // Its own group, its own source tag on the card, and no enable switch
    // anywhere for it: it is not ours to switch.
    const groups = wrapper!.findAll('.skills-group-title').map((g) => g.text())
    expect(groups.some((g) => g.startsWith("copilot's own"))).toBe(true)
    const card = wrapper!.find('.skill-card.native')
    expect(card.text()).toContain('bug-buster')
    expect(card.find('.skill-source-tag').text()).toBe("copilot's own")

    await card.trigger('click')
    await flushPromises()
    expect(wrapper!.find('.skills-drawer').exists()).toBe(true)
    expect(wrapper!.findAll('.skills-drawer [role="switch"]')).toHaveLength(0)
    expect(wrapper!.find('.skills-drawer textarea').exists()).toBe(false)
  })

  it('shows a native row in the matrix, automatic for its owner and opt-in elsewhere', async () => {
    await open('route')

    const rows = wrapper!.findAll('.skills-matrix tbody tr:not(.group)')
    expect(rows).toHaveLength(2)
    const native = rows[1]
    expect(native.classes()).toContain('native')
    const cells = native.findAll('td')
    // Owner (copilot) is not among the fixture agents; every wired cell is
    // opt-in and therefore off by default.
    expect(cells[0].classes()).toContain('off')
    expect(cells[1].classes()).toContain('off')
    expect(cells[3].classes()).toContain('off') // codex: native rows are not "auto" for shared-root readers
    expect(cells[4].classes()).toContain('unsupported')
  })

  it('opts a native skill in to another agent by real path', async () => {
    const { send } = await open('route')

    await wrapper!.findAll('.skills-matrix tbody tr:not(.group)')[1].findAll('td')[0].find('button').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.set_native_targets', {
      real_path: '/Users/x/.copilot/skills/bug-buster',
      agents: ['claude'],
    })
  })

  it('marks the owner cell automatic when the owner is a listed agent', async () => {
    await open('route', {
      native: [{ ...nativeSkill, source: 'claude', owner_agent: 'claude', path: '/Users/x/.claude/skills/bug-buster', real_path: '/Users/x/.claude/skills/bug-buster' }],
    })

    const cells = wrapper!.findAll('.skills-matrix tbody tr:not(.group)')[1].findAll('td')
    expect(cells[0].classes()).toContain('auto')
    expect((cells[0].find('button').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('never delivers an invalid native skill', async () => {
    const { send } = await open('route', {
      native: [{ ...nativeSkill, valid: false, error: 'SKILL.md missing' }],
    })
    const row = wrapper!.findAll('.skills-matrix tbody tr:not(.group)')[1]

    expect(row.classes()).toContain('off')
    expect(row.text()).toContain('SKILL.md missing')
    await row.findAll('td')[0].find('button').trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalledWith('skills.set_native_targets', expect.anything())
  })

  it('makes a shared skill the user created read-only in the editor', async () => {
    const mocked = mockBackend({
      'skills.list': {
        ok: true,
        payload: { skills: [{ ...skill, managed: false }], native: [], root: '/tmp/skills', agents },
      },
      'skills.get': { ok: true, payload: { skill: { ...skill, managed: false } } },
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await openCard(wrapper, 'review-code')

    // A read-only skill gets a preview, not an editor: no inputs, no save.
    expect(wrapper.find('.skills-drawer textarea').exists()).toBe(false)
    expect(wrapper.find('.skills-drawer input:not([type="search"])').exists()).toBe(false)
    expect(wrapper.find('.skill-editor-actions').exists()).toBe(false)
    expect(wrapper.text()).toContain('edit it where it lives')
  })
})

describe('SkillsPane write consent', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = {} as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  async function startCreate(consented: boolean) {
    const mocked = mockBackend({
      'skills.list': {
        ok: true,
        payload: { skills: [], native: [], root: '/Users/x/.agents/skills', agents, write_consented: consented },
      },
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    const newButton = wrapper.findAll('.skills-toolbar-actions button').find((b) => b.text() === 'New Skill')!
    await newButton.trigger('click')
    await wrapper.find('.skills-create input').setValue('fresh')
    return mocked
  }

  it('asks once, names the exact folder, and sends consent only after yes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { send } = await startCreate(false)

    await wrapper!.find('.skills-create').trigger('submit')
    await flushPromises()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toContain('/Users/x/.agents/skills')
    expect(send).toHaveBeenCalledWith('skills.create', {
      name: 'fresh', description: '', consent: true,
    })
  })

  it('writes nothing when the user declines', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { send } = await startCreate(false)

    await wrapper!.find('.skills-create').trigger('submit')
    await flushPromises()

    expect(send).not.toHaveBeenCalledWith('skills.create', expect.anything())
  })

  it('does not ask again once consent is on record', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const { send } = await startCreate(true)

    await wrapper!.find('.skills-create').trigger('submit')
    await flushPromises()

    expect(confirm).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('skills.create', {
      name: 'fresh', description: '', consent: true,
    })
  })

  it('re-asks when the backend still wants consent, then retries', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const mocked = mockBackend({
      'skills.list': {
        ok: true,
        payload: { skills: [], native: [], root: '/Users/x/.agents/skills', agents, write_consented: true },
      },
    })
    let calls = 0
    mocked.send.mockImplementation(async (type: string) => {
      if (type === 'skills.create' && calls++ === 0) {
        return { ok: false, error: { code: 'SKILL_CONSENT_REQUIRED', message: 'x', details: { root: '/Users/x/.agents/skills' } } }
      }
      return type === 'skills.create'
        ? { ok: true, payload: { skill } }
        : { ok: true, payload: { skills: [], native: [], root: '/Users/x/.agents/skills', agents, write_consented: true } }
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    const newButton = wrapper.findAll('.skills-toolbar-actions button').find((b) => b.text() === 'New Skill')!
    await newButton.trigger('click')
    await wrapper.find('.skills-create input').setValue('fresh')

    await wrapper.find('.skills-create').trigger('submit')
    await flushPromises()

    expect(confirm).toHaveBeenCalledTimes(1)
    const creates = mocked.send.mock.calls.filter((c) => c[0] === 'skills.create')
    expect(creates).toHaveLength(2)
    expect(creates[1][1]).toMatchObject({ consent: true })
  })
})

describe('SkillsPane migrate and restore', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = { openPath: vi.fn() } as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  async function openList(payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const mocked = mockBackend({
      'skills.list': { ok: true, payload: { skills: [], native: [], root: '/Users/x/.agents/skills', agents, write_consented: true, ...payload } },
      'skills.migrate_native': { ok: true, payload: { skill, from: nativeSkill.path } },
      'skills.restore_native': { ok: true, payload: { name: 'review-code', restored_to: '/x' } },
      ...extra,
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return mocked
  }

  /** Migrate lives in the drawer: open the native card, then click it. */
  async function clickMigrate(): Promise<void> {
    await openCard(wrapper!, 'bug-buster')
    const btn = wrapper!.findAll('.skills-drawer button').find((b) => b.text() === 'Move into Shared Library')
    await btn!.trigger('click')
    await flushPromises()
  }

  it('migrates only after a confirm that names source, destination and undo', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { send } = await openList({ native: [nativeSkill] })

    await clickMigrate()

    const text = confirm.mock.calls[0][0] as string
    expect(text).toContain('/Users/x/.copilot/skills/bug-buster')   // from
    expect(text).toContain('/Users/x/.agents/skills')               // to
    expect(text).toContain('copilot keeps reading it')              // link stays
    expect(text).toContain('Restore')                               // undo
    expect(send).toHaveBeenCalledWith('skills.migrate_native', {
      real_path: '/Users/x/.copilot/skills/bug-buster',
      consent: true,
    })
  })

  it('does nothing when the migrate confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { send } = await openList({ native: [nativeSkill] })

    await clickMigrate()

    expect(send).not.toHaveBeenCalledWith('skills.migrate_native', expect.anything())
  })

  it('never offers migrate for an invalid native skill', async () => {
    await openList({ native: [{ ...nativeSkill, valid: false, error: 'SKILL.md missing' }] })
    await openCard(wrapper!, 'bug-buster')

    const btn = wrapper!.findAll('.skills-drawer button').find((b) => b.text() === 'Move into Shared Library')
    expect((btn!.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows restore only for a migrated skill and confirms the destination', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const migrated = { ...skill, migrated_from: '/Users/x/.copilot/skills/review-code' }
    const { send } = await openList(
      { skills: [migrated] },
      { 'skills.get': { ok: true, payload: { skill: migrated } } }
    )
    await openCard(wrapper!, 'review-code')

    const restore = wrapper!.findAll('.skill-editor-actions button').find((b) => b.text() === 'Restore')
    expect(restore).toBeDefined()
    await restore!.trigger('click')
    await flushPromises()

    expect(confirm.mock.calls[0][0]).toContain('/Users/x/.copilot/skills/review-code')
    expect(send).toHaveBeenCalledWith('skills.restore_native', { name: 'review-code' })
  })

  it('has no restore button for a skill born in the shared root', async () => {
    await openList({ skills: [skill] })
    await openCard(wrapper!, 'review-code')

    const labels = wrapper!.findAll('.skill-editor-actions button').map((b) => b.text())
    expect(labels).not.toContain('Restore')
  })
})

describe('SkillsPane merged browse/route layout', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = { openPath: vi.fn() } as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  const second = { ...nativeSkill, name: 'code-review-expert', path: '/Users/x/.copilot/skills/code-review-expert', real_path: '/Users/x/.copilot/skills/code-review-expert' }
  const claudeOne = { ...nativeSkill, name: 'minimax-vision', source: 'claude', owner_agent: 'claude', path: '/Users/x/.claude/skills/minimax-vision', real_path: '/Users/x/.claude/skills/minimax-vision' }

  async function mountAll() {
    const mocked = mockBackend({
      'skills.list': {
        ok: true,
        payload: { skills: [skill], native: [nativeSkill, second, claudeOne], native_targets: {}, root: '/tmp/skills', agents, write_consented: true },
      },
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return mocked
  }

  it('groups cards by source with counts and one source tag per card', async () => {
    await mountAll()

    const titles = wrapper!.findAll('.skills-group-title').map((g) => [
      g.text().replace(g.find('.count').text(), '').trim(),
      g.find('.count').text(),
    ])
    expect(titles).toEqual([
      ['Shared library · ~/.agents/skills', '1'],
      ["copilot's own", '2'],
      ["claude's own", '1'],
    ])
    // exactly one source tag per card, never a second badge or a per-row button
    for (const card of wrapper!.findAll('.skill-card')) {
      expect(card.findAll('.skill-source-tag')).toHaveLength(1)
      expect(card.findAll('button')).toHaveLength(0)
    }
  })

  it('applies one source filter to both views', async () => {
    await mountAll()
    const chip = wrapper!.findAll('.skills-chip').find((c) => c.text().startsWith('copilot'))!
    await chip.trigger('click')

    expect(wrapper!.findAll('.skill-card')).toHaveLength(2)
    expect(wrapper!.findAll('.skill-card').every((c) => c.classes('native'))).toBe(true)

    await openMatrixView(wrapper!)
    const rows = wrapper!.findAll('.skills-matrix tbody tr:not(.group)')
    expect(rows).toHaveLength(2)
    expect(wrapper!.findAll('.skills-matrix tbody tr.group')).toHaveLength(1)
  })

  it('opens the same drawer from a card and from a matrix row name', async () => {
    await mountAll()

    await openCard(wrapper!, 'bug-buster')
    expect(wrapper!.get('.skills-drawer h3').text()).toBe('bug-buster')
    expect(wrapper!.get('.skills-drawer .skill-source-tag').text()).toBe("copilot's own")

    await openMatrixView(wrapper!)
    const claudeRow = wrapper!.findAll('.skills-matrix tbody tr:not(.group)').find((r) => r.find('th').text().includes('minimax-vision'))!
    await claudeRow.find('.matrix-name').trigger('click')
    await flushPromises()
    expect(wrapper!.get('.skills-drawer h3').text()).toBe('minimax-vision')
    // The matrix row and the drawer agree on which row is active.
    expect(claudeRow.classes()).toContain('active')
  })

  it('shows delivery on the card without making it a control', async () => {
    await mountAll()
    const shared = wrapper!.findAll('.skill-card').find((c) => c.find('strong').text() === 'review-code')!

    // codex is a shared-root reader → "1 read it themselves"; claude/kimi/pi are delivered.
    const chips = shared.findAll('.dchip').map((c) => c.text())
    expect(chips).toContain('1 read it themselves')
    expect(chips).toEqual(expect.arrayContaining(['claude', 'kimi', 'pi']))
    // native, opt-in, nothing chosen → says so
    const native = wrapper!.findAll('.skill-card').find((c) => c.find('strong').text() === 'bug-buster')!
    expect(native.text()).toContain('not delivered anywhere')
  })

  it('lets the drawer toggle delivery for a shared skill with chips', async () => {
    const { send } = await mountAll()
    await openCard(wrapper!, 'review-code')

    const kimi = wrapper!.findAll('.skill-drawer-chips button').find((b) => b.text() === 'kimi')!
    expect(kimi.classes()).toContain('on')
    await kimi.trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.set_targets', { name: 'review-code', agents: ['claude', 'pi'] })
    // codex chip is automatic: present, marked, and disabled
    const codex = wrapper!.findAll('.skill-drawer-chips button').find((b) => b.text() === 'codex')!
    expect(codex.classes()).toContain('auto')
    expect((codex.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('closes the drawer and keeps nothing selected on reload', async () => {
    await mountAll()
    await openCard(wrapper!, 'review-code')
    expect(wrapper!.find('.skills-drawer').exists()).toBe(true)

    await wrapper!.get('.skill-drawer-close').trigger('click')
    expect(wrapper!.find('.skills-drawer').exists()).toBe(false)

    const refresh = wrapper!.findAll('.skills-toolbar-actions button').find((b) => b.text() === 'Refresh')!
    await refresh.trigger('click')
    await flushPromises()
    expect(wrapper!.find('.skills-drawer').exists()).toBe(false)
  })
})

// "Move into Shared Library" moves a CLI's own skill and leaves a link, so the
// page intro must not promise that nothing here ever moves those skills.
describe('SkillsPane intro', () => {
  it.each(['zh-TW', 'en-US', 'ja-JP'] as const)('names the one action that moves a CLI skill (%s)', (locale) => {
    const previous = i18n.global.locale.value
    i18n.global.locale.value = locale
    try {
      const intro = i18n.global.t('settings.skills.intro')
      expect(intro).toContain(i18n.global.t('settings.skills.migrate'))
      expect(intro).toContain(i18n.global.t('settings.skills.restore'))
    } finally {
      i18n.global.locale.value = previous
    }
  })
})
