// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WebhooksPane from '../WebhooksPane.vue'
import type { WebhookStatus, WebhookTrigger } from '../../../lib/webhookTriggers'

const trigger = (over: Partial<WebhookTrigger> = {}): WebhookTrigger => ({
  id: 't1', name: 'CI', workspace: '/w', pipeline_id: 'p', kind: 'webhook', enabled: true, per_minute: 6, per_day: 20,
  no_gate_ack: false, unattended: false, approval_timeout_min: 30, github_events: [], form_fields: [], form_public: false, ...over,
})

const status = (over: Partial<WebhookStatus> = {}): WebhookStatus => ({
  settings: { enabled: true, port: 4000, public_host: '' }, listening: true, port: 4000, error: '',
  guard_enabled: true, key_protection: 'keychain', unattended_supported: true, triggers: [trigger()], runs: [], ...over,
})

type Reply = { ok: boolean; payload?: unknown; error?: { code: string; message: string; details?: unknown } }

async function mountPane(state: WebhookStatus, replies: Record<string, Reply> = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  const send = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    sent.push({ type, payload })
    if (replies[type]) return replies[type]
    if (type === 'pipelines.list') return { ok: true, payload: { pipelines: [{ id: 'p', name: 'Main' }] } }
    return { ok: true, payload: state }
  })
  const i18n = createI18n({ legacy: false, locale: 'en', missing: (_l, key) => key, messages: { en: {} } })
  const wrapper = mount(WebhooksPane, {
    props: { backend: { send, on: vi.fn(), status: { value: 'connected' } } as never, workspacePath: '/w' },
    global: { plugins: [i18n], directives: { truncate: {} } },
  })
  await flushPromises()
  return { wrapper, sent }
}

const q = (id: string) => `[data-testid="${id}"]`

describe('WebhooksPane disclosures', () => {
  it('turning unattended on sends nothing until the disclosure is ticked', async () => {
    const { wrapper, sent } = await mountPane(status())
    await wrapper.find('.wh-more-body [role="switch"]').trigger('click')
    await flushPromises()
    const text = wrapper.find(q('webhooks-disclose')).text()
    for (const line of ['webhooks.unattended.skips', 'webhooks.unattended.external', 'webhooks.unattended.scripts', 'webhooks.unattended.hook']) {
      expect(text).toContain(line)
    }
    expect(sent.some((m) => m.type === 'webhook.trigger.set_unattended')).toBe(false)
    expect(wrapper.find(q('webhooks-disclose-confirm')).attributes('disabled')).toBeDefined()
    await wrapper.find(q('webhooks-disclose-tick')).setValue(true)
    await wrapper.find(q('webhooks-disclose-confirm')).trigger('click')
    await flushPromises()
    expect(sent.find((m) => m.type === 'webhook.trigger.set_unattended')?.payload).toEqual({ id: 't1', unattended: true })
  })

  it('turning it off needs no tick', async () => {
    const { wrapper, sent } = await mountPane(status({ triggers: [trigger({ unattended: true })] }))
    await wrapper.find('.wh-more-body [role="switch"]').trigger('click')
    await flushPromises()
    expect(sent.find((m) => m.type === 'webhook.trigger.set_unattended')?.payload).toEqual({ id: 't1', unattended: false })
  })

  it('on Linux a GitHub trigger shows the weak key disclosure, then sends the acknowledgement', async () => {
    const state = status({ key_protection: 'file', triggers: [trigger({ kind: 'github', enabled: false })] })
    const { wrapper, sent } = await mountPane(state, {
      'webhook.trigger.enable': { ok: false, error: { code: 'WEAK_KEY_ACK_REQUIRED', message: 'x' } },
    })
    await wrapper.find('.wh-head [role="switch"]').trigger('click')
    await flushPromises()
    expect(wrapper.find(q('webhooks-disclose')).text()).toContain('webhooks.weakKey.body')
    await wrapper.find(q('webhooks-disclose-tick')).setValue(true)
    await wrapper.find(q('webhooks-disclose-confirm')).trigger('click')
    await flushPromises()
    expect(sent.filter((m) => m.type === 'webhook.trigger.enable').pop()?.payload).toMatchObject({ weak_key_acknowledged: true })
  })
})

describe('WebhooksPane keys', () => {
  it('shows a new key once, and it is gone when dismissed', async () => {
    const value = 'nv' + 'wh_visible'
    const { wrapper } = await mountPane(status({ triggers: [] }), {
      'webhook.trigger.create': { ok: true, payload: { trigger: trigger(), token: value, problem: '' } },
    })
    await wrapper.find(q('webhooks-new')).trigger('click')
    await wrapper.find(q('webhooks-form-name')).setValue('CI')
    await wrapper.find(q('webhooks-form-create')).trigger('click')
    await flushPromises()
    expect(wrapper.find(q('webhooks-reveal')).text()).toContain(value)
    await wrapper.find(q('webhooks-reveal-done')).trigger('click')
    await flushPromises()
    expect(wrapper.html()).not.toContain(value)
  })

  it('a form sends its fields, stays private unless ticked, and shows its address once', async () => {
    const value = 'nv' + 'wh_form'
    const { wrapper, sent } = await mountPane(status({ triggers: [] }), {
      'webhook.trigger.create': { ok: true, payload: { trigger: trigger({ kind: 'form' }), token: value, problem: '' } },
    })
    await wrapper.find(q('webhooks-new')).trigger('click')
    await wrapper.find(q('webhooks-form-name')).setValue('Ask')
    await wrapper.find(q('webhooks-form-kind')).setValue('form')
    expect(wrapper.find(q('webhooks-form-create')).attributes('disabled')).toBeDefined()
    await wrapper.find(`${q('webhooks-form-field')} input`).setValue('Your name')
    await wrapper.find(q('webhooks-form-create')).trigger('click')
    await flushPromises()
    const payload = sent.find((m) => m.type === 'webhook.trigger.create')?.payload
    expect(payload).toMatchObject({ kind: 'form', form_public: false })
    expect((payload?.fields as Array<{ label: string }>)[0].label).toBe('Your name')
    expect(wrapper.find(q('webhooks-reveal')).text()).toContain(`/form/${value}`)
  })

  it('a form row keeps no address on screen', async () => {
    const { wrapper } = await mountPane(status({ triggers: [trigger({ kind: 'form' })] }))
    expect(wrapper.html()).not.toContain('/webhook/t1')
  })

  it('offers no address before a port exists', async () => {
    const { wrapper } = await mountPane(status({ port: 0, settings: { enabled: true, port: 0, public_host: '' } }))
    expect(wrapper.html()).not.toContain('127.0.0.1:0')
  })

  it('says why a binding was refused', async () => {
    const { wrapper } = await mountPane(status({ triggers: [trigger({ enabled: false })] }), {
      'webhook.trigger.enable': { ok: false, error: { code: 'BINDING_REFUSED', message: 'x', details: { reason: 'vendor-refused' } } },
    })
    await wrapper.find('.wh-head [role="switch"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.settings-notice').exists()).toBe(true)
  })

  it('deleting takes a second click', async () => {
    const { wrapper, sent } = await mountPane(status())
    await wrapper.find(q('webhooks-delete')).trigger('click')
    expect(sent.some((m) => m.type === 'webhook.trigger.delete')).toBe(false)
    await wrapper.find(q('webhooks-delete')).trigger('click')
    await flushPromises()
    expect(sent.some((m) => m.type === 'webhook.trigger.delete')).toBe(true)
  })

  it('a run waiting for a person says how long is left', async () => {
    const stops = Math.floor(Date.now() / 1000) + 600
    const { wrapper } = await mountPane(status({
      runs: [{ trigger_id: 't1', workspace: '/w', started_at: 1, unattended: false, waiting_since: 1, stops_at: stops }],
    }))
    expect(wrapper.find(q('webhooks-state')).text()).toContain('webhooks.state.waiting')
  })

  it('Guard off leaves both switches disabled and says so', async () => {
    const { wrapper } = await mountPane(status({ guard_enabled: false }))
    expect(wrapper.find('.settings-notice').text()).toContain('webhooks.guardOff')
    expect(wrapper.find('.wh-head [role="switch"]').attributes('disabled')).toBeDefined()
  })
})
