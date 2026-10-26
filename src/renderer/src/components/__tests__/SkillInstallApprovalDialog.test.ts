// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import SkillInstallApprovalDialog, {
  type SkillDeliveryApproval,
  type SkillInstallApproval,
} from '../SkillInstallApprovalDialog.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'

function approval(over: Partial<SkillInstallApproval> = {}): SkillInstallApproval {
  return {
    approval_id: 'a1',
    owner: 'pane:p1',
    name: 'verify',
    source: { kind: 'github', repository: 'example/skills', commit: 'c'.repeat(40), subdir: 'skills/verify' },
    digest: 'd'.repeat(64),
    files: [{ path: 'SKILL.md', size: 42 }, { path: 'run.sh', size: 10, script: true }],
    skill_md: '---\nname: verify\n---\n<b>not html</b>',
    warnings: ['The package contains scripts'],
    targets: null,
    expires_at: Date.now() / 1000 + 600,
    status: 'pending',
    ...over,
  }
}

function delivery(over: Partial<SkillDeliveryApproval> = {}): SkillDeliveryApproval {
  return {
    approval_id: 'd1',
    action: 'delivery',
    owner: 'pane:p1',
    name: 'verify',
    skill_id: 'shared:verify',
    real_path: '',
    targets: ['claude', 'codex'],
    enabled: true,
    current: { targets: ['claude'], enabled: false },
    expires_at: Date.now() / 1000 + 600,
    status: 'pending',
    ...over,
  }
}

describe('SkillInstallApprovalDialog', () => {
  let wrapper: VueWrapper | undefined

  const trustConfirm = vi.fn(async (action: string, deviceId: string, subject: string) => ({
    nonce: 'n', expires: '0', mac: `${action}|${deviceId}|${subject}`,
  }))

  beforeEach(() => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  async function open(mock: ReturnType<typeof createMockBackend>): Promise<VueWrapper> {
    const w = mount(SkillInstallApprovalDialog, {
      props: { backend: mock.backend },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return w
  }

  it('asks for pending requests on mount and stays hidden without any', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('skills.install_approvals.list', { approvals: [] })
    wrapper = await open(mock)
    expect(mock.sent.map((s) => s.type)).toContain('skills.install_approvals.list')
    expect(wrapper.find('.sa-dialog').exists()).toBe(false)
  })

  it('shows a request, sends the approval, and closes once resolved', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('skills.install_approvals.list', { approvals: [] })
    mock.setResponse('skills.install_approval.decide', { approval: { status: 'installed', error: null } })
    wrapper = await open(mock)

    mock.emit('skills.install_approval_request', approval())
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('verify')
    expect(text).toContain('example/skills@cccccccccccc/skills/verify')
    expect(text).toContain('d'.repeat(12))
    expect(text).toContain('run.sh')
    expect(text).toContain('pane:p1')
    expect(text).toContain(i18n.global.t('skill-approval.targets-all'))

    await wrapper.find('.sa-toggle').trigger('click')
    expect(wrapper.find('.sa-skill-md').text()).toContain('<b>not html</b>')
    expect(wrapper.find('.sa-skill-md b').exists()).toBe(false)

    await wrapper.find('.sa-approve').trigger('click')
    await flushPromises()
    const decide = mock.sent.find((s) => s.type === 'skills.install_approval.decide')
    expect(decide?.payload).toEqual({
      approval_id: 'a1', approve: true,
      confirm: { nonce: 'n', expires: '0', mac: 'skills.install_approval.decide||a1:approve' },
    })
    expect(wrapper.find('.sa-dialog').exists()).toBe(false)
  })

  it('names a skill that ships with Navide as bundled, not as a path', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('skills.install_approvals.list', { approvals: [] })
    wrapper = await open(mock)

    mock.emit('skills.install_approval_request', approval({ source: { kind: 'bundled', name: 'plugin-authoring' } }))
    await flushPromises()
    expect(wrapper.text()).toContain(
      i18n.global.t('skill-approval.source-bundled', { name: 'navide:plugin-authoring' }),
    )
  })

  it('sends a rejection', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('skills.install_approvals.list', { approvals: [approval()] })
    mock.setResponse('skills.install_approval.decide', { approval: { status: 'rejected', error: null } })
    wrapper = await open(mock)
    expect(wrapper.find('.sa-dialog').exists()).toBe(true)
    await wrapper.find('.sa-reject').trigger('click')
    await flushPromises()
    const decide = mock.sent.find((s) => s.type === 'skills.install_approval.decide')
    expect(decide?.payload).toEqual({
      approval_id: 'a1', approve: false,
      confirm: { nonce: 'n', expires: '0', mac: 'skills.install_approval.decide||a1:reject' },
    })
  })

  it('closes when another window resolves the request', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('skills.install_approvals.list', { approvals: [] })
    wrapper = await open(mock)
    mock.emit('skills.install_approval_request', approval())
    await flushPromises()
    expect(wrapper.find('.sa-dialog').exists()).toBe(true)
    mock.emit('skills.install_approval_resolved', { approval_id: 'a1', status: 'rejected' })
    await flushPromises()
    expect(wrapper.find('.sa-dialog').exists()).toBe(false)
  })

  it('keeps the dialog open with the error when installation fails', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('skills.install_approvals.list', { approvals: [approval()] })
    mock.setResponse('skills.install_approval.decide', { approval: { status: 'failed', error: 'name taken' } })
    wrapper = await open(mock)
    await wrapper.find('.sa-approve').trigger('click')
    mock.emit('skills.install_approval_resolved', { approval_id: 'a1', status: 'failed' })
    await flushPromises()
    expect(wrapper.find('.sa-error').text()).toContain('name taken')
    expect(wrapper.find('.sa-approve').exists()).toBe(false)
    await wrapper.find('.sa-dismiss').trigger('click')
    expect(wrapper.find('.sa-dialog').exists()).toBe(false)
  })

  it('shows the failure when another window approved the request', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('skills.install_approvals.list', { approvals: [approval()] })
    wrapper = await open(mock)
    mock.emit('skills.install_approval_resolved', { approval_id: 'a1', status: 'failed', error: 'name taken' })
    await flushPromises()
    expect(wrapper.find('.sa-error').text()).toContain('name taken')
    expect(wrapper.find('.sa-approve').exists()).toBe(false)
    expect(wrapper.find('.sa-dismiss').exists()).toBe(true)
    expect(mock.sent.some((s) => s.type === 'skills.install_approval.decide')).toBe(false)
  })

  it('shows a delivery change as before and after, and approves it through the same decide', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('skills.install_approvals.list', { approvals: [delivery()] })
    mock.setResponse('skills.install_approval.decide', { approval: { status: 'installed', error: null } })
    wrapper = await open(mock)
    const text = wrapper.text()
    expect(text).toContain(i18n.global.t('skill-approval.delivery-title', { name: 'verify' }))
    expect(text).toContain(i18n.global.t('skill-approval.delivery-shared'))
    expect(wrapper.find('.sa-before').text()).toBe('claude')
    expect(wrapper.find('.sa-after').text()).toBe('claude, codex')
    expect(wrapper.find('.sa-turns-on').exists()).toBe(true)
    expect(wrapper.find('.sa-files').exists()).toBe(false)
    expect(wrapper.find('.sa-approve').text()).toBe(i18n.global.t('skill-approval.delivery-approve'))
    await wrapper.find('.sa-approve').trigger('click')
    await flushPromises()
    const decide = mock.sent.find((s) => s.type === 'skills.install_approval.decide')
    expect(decide?.payload).toEqual({
      approval_id: 'd1', approve: true,
      confirm: { nonce: 'n', expires: '0', mac: 'skills.install_approval.decide||d1:approve' },
    })
    expect(wrapper.find('.sa-dialog').exists()).toBe(false)
  })

  it('names a native skill by its folder and shows a failed delivery change', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('skills.install_approvals.list', {
      approvals: [delivery({ real_path: '/home/u/.claude/skills/x', enabled: null, targets: ['codex'], current: { targets: [], enabled: null } })],
    })
    mock.setResponse('skills.install_approval.decide', { approval: { status: 'failed', error: '' } })
    wrapper = await open(mock)
    expect(wrapper.text()).toContain('/home/u/.claude/skills/x')
    expect(wrapper.find('.sa-before').text()).toBe(i18n.global.t('skill-approval.delivery-none'))
    expect(wrapper.find('.sa-turns-on').exists()).toBe(false)
    await wrapper.find('.sa-approve').trigger('click')
    await flushPromises()
    expect(wrapper.find('.sa-error').text()).toBe(i18n.global.t('skill-approval.delivery-failed'))
  })

  it('offers only a dismiss for an expired request', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('skills.install_approvals.list', { approvals: [approval({ expires_at: Date.now() / 1000 - 1 })] })
    wrapper = await open(mock)
    expect(wrapper.find('.sa-error').text()).toBe(i18n.global.t('skill-approval.expired'))
    expect(wrapper.find('.sa-approve').exists()).toBe(false)
    await wrapper.find('.sa-dismiss').trigger('click')
    expect(wrapper.find('.sa-dialog').exists()).toBe(false)
    expect(mock.sent.some((s) => s.type === 'skills.install_approval.decide')).toBe(false)
  })
})
