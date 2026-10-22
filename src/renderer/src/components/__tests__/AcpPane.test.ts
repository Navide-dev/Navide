// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import AcpPane from '../AcpPane.vue'
import type { AcpPort } from '../../composables/useAcpSession'

type Reply = { ok: boolean; payload: unknown; error: { code: string; message: string; details?: Record<string, unknown> } | null }

class FakePort implements AcpPort {
  sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  handlers = new Map<string, Array<(payload: unknown) => void>>()
  createReply: Promise<Reply> = Promise.resolve(ok({ session: { session_id: 's1', state: 'idle' } }))

  send<T>(type: string, payload: Record<string, unknown> = {}): Promise<{ id: string; type: string; ok: boolean; payload: T | null; error: Reply['error']; timestamp: string }> {
    this.sent.push({ type, payload })
    const reply: Promise<Reply> = type === 'acp.create' ? this.createReply
      : type === 'acp.prompt' ? Promise.resolve(ok({ status: 'sent' }))
        : type === 'acp.cancel' ? Promise.resolve(ok({ cancel_sent: true }))
          : type === 'acp.permission_answer' ? Promise.resolve(ok({ answered: true }))
            : Promise.resolve(ok({}))
    return reply.then((r) => ({ id: 'x', type: `${type}.result`, timestamp: '', ...r }) as never)
  }

  on(type: string, cb: (payload: unknown) => void): () => void {
    const list = this.handlers.get(type) ?? []
    list.push(cb)
    this.handlers.set(type, list)
    return () => this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== cb))
  }

  emit(type: string, payload: Record<string, unknown>): void {
    for (const handler of this.handlers.get(type) ?? []) handler({ session_id: 's1', pane_id: 'p1', ...payload })
  }

  count(type: string): number {
    return this.sent.filter((m) => m.type === type).length
  }
}

function ok(payload: unknown): Reply {
  return { ok: true, payload, error: null }
}

let wrapper: VueWrapper | undefined

/** What AcpPane exposes (lib/acpHost.ts AcpPaneApi plus what these tests read). */
interface PaneApi {
  spawn(opts: { cwd: string; agentKey?: string; outputLogFile?: string; command?: string[] }): Promise<void>
  kill(opts?: unknown): Promise<void>
  interrupt(): Promise<boolean>
  status: string
  displayStatus: string
  awaitingKind: string | null
  text: string
  textSeen: number
  lastActivityAt: number
  hasDraft: boolean
  permissionWaitLive(): boolean
  setStopped(stopped: boolean): void
  insertText(text: string, opts?: { submit?: boolean }): boolean
  sendPrompt?(text: string): Promise<unknown>
}

function mountPane(port: FakePort): { wrapper: VueWrapper; pane: PaneApi } {
  wrapper = mount(AcpPane, {
    props: { paneId: 'p1', title: 'Agent', agentKey: 'opencode', workspacePath: '/work', acpPort: port },
    global: { plugins: [i18n] },
  }) as VueWrapper
  return { wrapper, pane: wrapper.vm as unknown as PaneApi }
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  i18n.global.locale.value = 'en-US'
})

describe('AcpPane', () => {
  it('starts its agent over ACP with this pane, CLI and folder', async () => {
    const port = new FakePort()
    const { pane } = mountPane(port)

    await pane.spawn({ command: [], cwd: '/work', agentKey: 'opencode' })

    expect(port.sent[0]).toEqual({ type: 'acp.create', payload: { pane_id: 'p1', agent_key: 'opencode', cwd: '/work' } })
    expect(pane.status).toBe('running')
    expect(pane.displayStatus).toBe('idle')
  })

  it('draws the conversation from acp.update and exposes it as the pane text', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })

    port.emit('acp.update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '<script>x</script> done' } } })
    await flushPromises()

    expect(pane.text).toBe('<script>x</script> done')
    expect(pane.textSeen).toBeGreaterThan(0)
    expect(pane.lastActivityAt).toBeGreaterThan(0)
    // Shown as text: the agent's output is never rendered as HTML.
    expect(wrapper.find('.acp-transcript script').exists()).toBe(false)
    expect(wrapper.find('.acp-transcript').text()).toContain('<script>x</script> done')
  })

  it('marks a refused prompt as not sent and puts its text back in the composer', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })
    const send = port.send.bind(port)
    port.send = ((type: string, payload?: Record<string, unknown>) => (type === 'acp.prompt'
      ? Promise.resolve({ id: 'x', type, timestamp: '', ok: false, payload: null, error: { code: 'ACP_NO_SESSION', message: 'gone' } })
      : send(type, payload))) as FakePort['send']

    await wrapper.find('textarea').setValue('hello agent')
    await wrapper.find('[data-testid="acp-send"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="acp-unsent"]').text()).toBe('Not sent')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('hello agent')
    expect(pane.text).toBe('')
  })

  it('streams a reply into bounded parts: small chunks join one, a long reply starts more', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })
    const chunk = (text: string): void => {
      port.emit('acp.update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
    }

    for (const piece of ['a', 'b', 'c']) chunk(piece)
    await flushPromises()
    expect(wrapper.findAll('.acp-entry[data-role="agent"] > span').map((n) => n.text())).toEqual(['abc'])

    chunk('x'.repeat(2046))
    await flushPromises()
    expect(wrapper.findAll('.acp-entry[data-role="agent"] > span')).toHaveLength(2)
    expect(pane.text).toBe(`abc${'x'.repeat(2046)}`)
  })

  it('marks a prompt whose reply was lost as not confirmed, and keeps it out of the composer', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })
    const send = port.send.bind(port)
    port.send = ((type: string, payload?: Record<string, unknown>) => (type === 'acp.prompt'
      ? Promise.reject(new Error('request acp.prompt timeout'))
      : send(type, payload))) as FakePort['send']

    await wrapper.find('textarea').setValue('hello agent')
    await wrapper.find('[data-testid="acp-send"]').trigger('click')
    await flushPromises()

    // The backend may have it: it is neither shown as sent nor offered for a resend.
    expect(wrapper.find('[data-testid="acp-unconfirmed"]').text()).toBe('Not confirmed')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('')
    expect(pane.text).toBe('> hello agent')
  })

  it('marks a prompt that never left the window as not sent', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })
    const send = port.send.bind(port)
    port.send = ((type: string, payload?: Record<string, unknown>) => (type === 'acp.prompt'
      ? Promise.reject(new Error('ws not open'))
      : send(type, payload))) as FakePort['send']

    await wrapper.find('textarea').setValue('hello agent')
    await wrapper.find('[data-testid="acp-send"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="acp-unsent"]').exists()).toBe(true)
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('hello agent')
  })

  it('follows the bottom while text streams in only when the reader is already there', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })
    const el = wrapper.find('.acp-transcript').element as HTMLElement
    // The content grows as the DOM does: 10px per rendered character.
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 + 10 * (el.textContent ?? '').length })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 200 })
    const chunk = async (text: string): Promise<void> => {
      port.emit('acp.update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
      await flushPromises()
    }

    el.scrollTop = 800 // at the bottom
    await chunk('one')
    expect(el.scrollTop).toBe(1030)

    el.scrollTop = 300 // scrolled up to read
    await chunk('two')
    expect(el.scrollTop).toBe(300)
  })

  it('sends what is typed as a prompt', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })

    await wrapper.find('textarea').setValue('hello agent')
    await wrapper.find('[data-testid="acp-send"]').trigger('click')
    await flushPromises()

    expect(port.sent.find((m) => m.type === 'acp.prompt')?.payload).toEqual({ session_id: 's1', text: 'hello agent' })
  })

  it('shows a permission request and answers it with the option the user picked', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })
    port.emit('acp.state', { state: 'running' })
    port.emit('acp.permission', {
      request_id: 'r1',
      toolCall: { title: 'Write notes.md' },
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
    })
    await flushPromises()

    expect(pane.displayStatus).toBe('awaiting')
    expect(pane.awaitingKind).toBe('permission')
    const buttons = wrapper.findAll('[data-testid="acp-permission"] button')
    expect(buttons.map((b) => b.text())).toEqual(['Allow once', 'Reject'])
    await buttons[1].trigger('click')
    await flushPromises()

    expect(port.sent.find((m) => m.type === 'acp.permission_answer')?.payload).toEqual({ session_id: 's1', request_id: 'r1', option_id: 'no' })
    port.emit('acp.permission_closed', { request_id: 'r1' })
    await flushPromises()
    expect(pane.displayStatus).toBe('running')
  })

  it('interrupts with a cancel of the turn', async () => {
    const port = new FakePort()
    const { pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })

    expect(await pane.interrupt()).toBe(true)
    expect(port.count('acp.cancel')).toBe(1)
  })

  it('risk 1: closing a pane mid-start takes effect at once, without waiting for the start', async () => {
    const port = new FakePort()
    let answerCreate: (r: Reply) => void = () => {}
    port.createReply = new Promise((resolve) => { answerCreate = resolve })
    const { pane } = mountPane(port)
    const spawning = pane.spawn({ command: [], cwd: '/work' })
    await flushPromises()
    expect(pane.displayStatus).toBe('starting')

    // The start never answers here: kill() must still resolve (acp.create may take minutes).
    await pane.kill({ force: true })

    expect(port.sent.filter((m) => m.type === 'acp.kill').map((m) => m.payload)).toEqual([{ pane_id: 'p1' }])
    expect(pane.displayStatus).toBe('exited')

    // The backend abandons the start; its refusal leaves the pane closed, not failed.
    answerCreate({ ok: false, payload: null, error: { code: 'ACP_CANCELLED', message: 'the pane was closed' } })
    await spawning
    expect(pane.displayStatus).toBe('exited')
  })

  it('risk 1: a start that still answers with a session after the close is stopped too', async () => {
    const port = new FakePort()
    let answerCreate: (r: Reply) => void = () => {}
    port.createReply = new Promise((resolve) => { answerCreate = resolve })
    const { pane } = mountPane(port)
    const spawning = pane.spawn({ command: [], cwd: '/work' })
    await flushPromises()

    await pane.kill({ force: true })
    answerCreate(ok({ session: { session_id: 's1', state: 'idle' } }))
    await spawning

    expect(port.sent.filter((m) => m.type === 'acp.kill').map((m) => m.payload)).toEqual([
      { pane_id: 'p1' }, { session_id: 's1' },
    ])
    expect(pane.displayStatus).toBe('exited')
  })

  it('risk 1: a pane closed after its agent started stops it, exactly once', async () => {
    const port = new FakePort()
    const { pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })

    await pane.kill({ force: true })

    expect(port.count('acp.kill')).toBe(1)
    expect(pane.status).toBe('exited')
  })

  it('says why a start failed, with the agent output', async () => {
    const port = new FakePort()
    port.createReply = Promise.resolve({
      ok: false, payload: null,
      error: { code: 'ACP_HANDSHAKE_FAILED', message: 'initialize: version 2', details: { stderr_tail: 'boom' } },
    })
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })
    await flushPromises()

    expect(pane.displayStatus).toBe('error')
    expect(wrapper.find('[data-testid="acp-ended"]').text()).toContain('initialize: version 2')
    expect(wrapper.find('[data-testid="acp-ended"] pre').text()).toBe('boom')
  })

  it('reports an exit with its code and stops showing open requests', async () => {
    const port = new FakePort()
    const { pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })
    port.emit('acp.permission', { request_id: 'r1', options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] })
    port.emit('acp.exit', { code: 3, stderr_tail: 'fatal' })
    await flushPromises()

    expect(pane.displayStatus).toBe('exited')
    expect(pane.permissionWaitLive()).toBe(false)
  })

  it('takes inserted text into the composer', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })

    expect(pane.insertText('dictated')).toBe(true)
    await flushPromises()
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('dictated')
    expect(pane.hasDraft).toBe(true)
    pane.setStopped(true)
    await flushPromises()
    expect(wrapper.find('.acp-stopped').exists()).toBe(true)
  })

  it('ignores events of another pane', async () => {
    const port = new FakePort()
    const { pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })

    for (const handler of port.handlers.get('acp.update') ?? []) {
      handler({ session_id: 'other', pane_id: 'p2', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'not mine' } } })
    }
    await flushPromises()

    expect(pane.text).toBe('')
  })
})
