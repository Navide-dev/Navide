// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import AcpPane from '../AcpPane.vue'
import type { AcpPort } from '../../composables/useAcpSession'
import type { PaneHandle } from '../../lib/paneHandle'

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

function mountPane(port: FakePort): { wrapper: VueWrapper; pane: PaneHandle } {
  wrapper = mount(AcpPane, {
    props: { paneId: 'p1', title: 'Agent', agentKey: 'opencode', workspacePath: '/work', acpPort: port },
    global: { plugins: [i18n] },
  }) as VueWrapper
  return { wrapper, pane: wrapper.vm as unknown as PaneHandle }
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  i18n.global.locale.value = 'en-US'
})

describe('AcpPane', () => {
  it('starts its agent over ACP with this pane, CLI and folder, and never claims a terminal session', async () => {
    const port = new FakePort()
    const { pane } = mountPane(port)

    await pane.spawn({ command: [], cwd: '/work', agentKey: 'opencode' })

    expect(port.sent[0]).toEqual({ type: 'acp.create', payload: { pane_id: 'p1', agent_key: 'opencode', cwd: '/work' } })
    expect(pane.display).toBe('acp')
    expect(pane.status).toBe('running')
    expect(pane.displayStatus).toBe('idle')
    expect(pane.sessionId).toBe('')
    // The screen readers stay absent, so screen watchers skip this pane.
    expect(pane.readScreenTail).toBeUndefined()
    expect(pane.fitTerminal).toBeUndefined()
  })

  it('draws the conversation from acp.update and exposes it as the pane text', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })

    port.emit('acp.update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '<script>x</script> done' } } })
    await flushPromises()

    expect(pane.cleanBuffer).toBe('<script>x</script> done')
    expect(pane.cleanBytesSeen).toBeGreaterThan(0)
    expect(pane.lastActivityAt).toBeGreaterThan(0)
    // Shown as text: the agent's output is never rendered as HTML.
    expect(wrapper.find('.acp-transcript script').exists()).toBe(false)
    expect(wrapper.find('.acp-transcript').text()).toContain('<script>x</script> done')
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

  it('risk 1: a pane closed while its agent is still starting stops that agent, exactly once', async () => {
    const port = new FakePort()
    let answerCreate: (r: Reply) => void = () => {}
    port.createReply = new Promise((resolve) => { answerCreate = resolve })
    const { pane } = mountPane(port)
    const spawning = pane.spawn({ command: [], cwd: '/work' })
    await flushPromises()
    expect(pane.displayStatus).toBe('starting')

    const killing = pane.kill({ force: true })
    answerCreate(ok({ session: { session_id: 's1', state: 'idle' } }))
    await Promise.all([spawning, killing])

    expect(port.count('acp.kill')).toBe(1)
    expect(port.sent.find((m) => m.type === 'acp.kill')?.payload).toEqual({ session_id: 's1' })
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

  it('takes inserted text into the composer and survives the calls App.vue makes on any pane', async () => {
    const port = new FakePort()
    const { wrapper, pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })

    expect(pane.insertText('dictated')).toBe(true)
    await flushPromises()
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('dictated')
    expect(pane.hasDraft).toBe(true)
    // The five calls App.vue makes without `?.` must exist on an ACP pane.
    pane.setStopped(true)
    expect(typeof pane.markBufferPosition()).toBe('number')
    expect(typeof pane.cleanBuffer.length).toBe('number')
    pane.markTurnComplete()
    pane.markNeedsInput()
  })

  it('ignores events of another pane', async () => {
    const port = new FakePort()
    const { pane } = mountPane(port)
    await pane.spawn({ command: [], cwd: '/work' })

    for (const handler of port.handlers.get('acp.update') ?? []) {
      handler({ session_id: 'other', pane_id: 'p2', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'not mine' } } })
    }
    await flushPromises()

    expect(pane.cleanBuffer).toBe('')
  })
})
