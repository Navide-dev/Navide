// @vitest-environment happy-dom
// The rich output view: turns with rendered replies, links opened outside the
// window, and a copy button per code block.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'

// happy-dom's DOM breaks DOMPurify (renderMarkdown then fails closed to plain
// text), so the view is tested on markdownToHtml's output.
vi.mock('../../lib/richTurns', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/richTurns')>()
  return { ...mod, renderMarkdown: mod.markdownToHtml }
})

import RichOutputView from '../RichOutputView.vue'
import type { RichTurn } from '../../lib/richTurns'

let wrapper: VueWrapper | undefined

function view(turns: RichTurn[]): VueWrapper {
  wrapper = mount(RichOutputView, { props: { turns }, global: { plugins: [i18n] }, attachTo: document.body })
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
  delete (window as { agentTeam?: unknown }).agentTeam
})

describe('RichOutputView', () => {
  it('explains what it shows when there are no turns yet', () => {
    const w = view([])
    expect(w.find('[data-testid="rich-empty"]').text()).toContain('since this window opened')
  })

  it('shows the prompt as text and the reply as rendered Markdown', () => {
    const w = view([{ id: 1, prompt: '<b>hi</b>', reply: '## Result\n\n- **done**' }])
    expect(w.find('[data-testid="rich-prompt"]').text()).toContain('<b>hi</b>')
    const reply = w.find('[data-testid="rich-reply"]')
    expect(reply.find('h2').text()).toBe('Result')
    expect(reply.find('li strong').text()).toBe('done')
  })

  it('opens an http(s) link outside the window and never navigates', async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true })
    ;(window as { agentTeam?: unknown }).agentTeam = { openExternal }
    const w = view([{ id: 1, prompt: '', reply: '[docs](https://example.com/a)' }])
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    w.find('a').element.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a')
  })

  it('copies a code block\'s raw text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const w = view([{ id: 1, prompt: '', reply: '```sh\necho "a < b"\n```' }])
    await w.find('button.rich-copy').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('echo "a < b"')
    expect(w.find('button.rich-copy').text()).toBe('Copied')
  })
})
