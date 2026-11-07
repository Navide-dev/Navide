// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { channelsBotRequest, requestChannelsBot } from '../../channelsBotRequest'
import ChannelsPane from '../settings/ChannelsPane.vue'

// Requests agents file through the channels_* MCP tools (plan mcp-bot_507912 P2):
// the agent only asks; the press is the user's, and a bot's credential is typed
// here only, never read from the clipboard on an agent's behalf.

vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  isMacPlatform: () => true,
}))

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>
const clip = { reads: 0 }

const pairingRequest = {
  id: 'req-1',
  kind: 'pairing-approve',
  requester: { pane_id: 'p-41', address: 'proj/lead' },
  reason: 'my teammate',
  target: { platform: 'telegram', account: 'default', code: 'K7Q2M9XA', sender_name: 'neil', bind_pane: 'dev' },
  draft: {},
  status: 'pending',
  error: null,
  expires_at: 9e9,
}

function seed(requests: unknown[] = []): void {
  mock.setResponse('channels.list', { ok: true, enabled: true, platforms: [] })
  mock.setResponse('channels.bindings', { ok: true, bindings: [] })
  mock.setResponse('channels.overview', { ok: true, bots: [] })
  mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
  mock.setResponse('channels.allow.list', { ok: true, entries: [] })
  mock.setResponse('channels.agent_request.list', { ok: true, requests })
}

async function render(): Promise<VueWrapper> {
  wrapper = mount(ChannelsPane, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  mock = createMockBackend('connected')
  clip.reads = 0
  Object.defineProperty(navigator, 'clipboard', {
    value: { readText: async () => { clip.reads += 1; return '' }, writeText: async () => {} },
    configurable: true,
  })
})
afterEach(() => {
  wrapper?.unmount()
  channelsBotRequest.value = null
})

describe('agent requests on the Channels page', () => {
  it('shows a request with who asked and why, and sends the user\'s approval', async () => {
    seed([pairingRequest])
    mock.setResponse('channels.agent_request.decide', { ok: true, request: { ...pairingRequest, status: 'completed' } })
    const w = await render()
    const card = w.get('[data-testid="channel-agent-request"]')
    expect(card.text()).toContain('Let neil talk to telegram and bind their chat to pane “dev”')
    expect(card.text()).toContain('Asked by proj/lead')
    expect(card.text()).toContain('my teammate')
    await card.get('[data-testid="channel-agent-approve"]').trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.agent_request.decide')?.payload).toEqual({ id: 'req-1', approve: true })
  })

  it('drops a request once it is settled', async () => {
    seed([pairingRequest])
    const w = await render()
    expect(w.findAll('[data-testid="channel-agent-request"]')).toHaveLength(1)
    mock.emit('channels.agent_request.changed', { ...pairingRequest, status: 'rejected' })
    await flushPromises()
    expect(w.find('[data-testid="channel-agent-requests"]').exists()).toBe(false)
  })

  it('opens an agent\'s add-a-bot form with its name, never reads the clipboard, and reports the bot added', async () => {
    seed()
    mock.setResponse('channels.quick_add', { ok: true, account: 'x', name: '', identity: '', link: null })
    const w = await render()
    requestChannelsBot({ platform: 'feishu', account: '', add: { name: 'Support', requestId: 'req-2', requester: 'proj/lead' } })
    await flushPromises()
    const card = w.get('[data-platform="feishu"]')
    expect(card.get('[data-testid="channel-agent-add-note"]').text()).toContain('proj/lead asked for this bot')
    expect((card.get('input[name="name"]').element as HTMLInputElement).value).toBe('Support')
    expect(clip.reads).toBe(0)
    await card.get('input[name="app_id"]').setValue('cli_x')
    await card.get('input[name="app_secret"]').setValue('s3cret')
    await card.get('form').trigger('submit')
    await flushPromises()
    const added = mock.sent.find((s) => s.type === 'channels.quick_add')?.payload as { config: { name?: string }; account?: string }
    expect(added.config.name).toBe('Support')
    const finish = mock.sent.find((s) => s.type === 'channels.agent_request.finish')?.payload as Record<string, unknown>
    expect(finish).toMatchObject({ id: 'req-2', ok: true })
    expect(finish.account).toBe(added.account)
  })
})
