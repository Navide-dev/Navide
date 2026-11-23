// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

const URL_FOR = 'https://dl.navide.dev/help/cliAgents.menu/zh-TW/0123456789ab.png'

vi.mock('../../../lib/helpScreenshots', () => ({
  helpScreenshotUrl: (id: string) => (id === 'cliAgents.menu' ? URL_FOR : null),
}))

import MockFigure from '../MockFigure.vue'

function mountFigure(props: Record<string, unknown>) {
  return mount(MockFigure, {
    props: { caption: 'Pane menu', ...props },
    slots: { default: '<div class="mock-body">mock drawing</div>' },
    global: { plugins: [i18n] },
  })
}

function frameVisible(wrapper: ReturnType<typeof mountFigure>): boolean {
  return (wrapper.find('.mk-fig-frame').element as HTMLElement).style.display !== 'none'
}

describe('MockFigure screenshots', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('without a shot renders only the mock', () => {
    const wrapper = mountFigure({})
    expect(wrapper.find('img').exists()).toBe(false)
    expect(frameVisible(wrapper)).toBe(true)
    expect(wrapper.text()).toContain('Pane menu')
  })

  it('keeps the mock until the screenshot loads, then swaps it in', async () => {
    const wrapper = mountFigure({ shot: 'cliAgents.menu' })
    const img = wrapper.find('img')
    expect(img.attributes('src')).toBe(URL_FOR)
    expect(img.attributes('alt')).toBe('Pane menu')
    expect((img.element as HTMLElement).style.display).toBe('none')
    expect(frameVisible(wrapper)).toBe(true)

    await img.trigger('load')
    expect((wrapper.find('img').element as HTMLElement).style.display).toBe('')
    expect(frameVisible(wrapper)).toBe(false)
    expect(wrapper.text()).toContain('Pane menu')
  })

  it('falls back to the mock and drops the image when loading fails', async () => {
    const wrapper = mountFigure({ shot: 'cliAgents.menu' })
    await wrapper.find('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(frameVisible(wrapper)).toBe(true)
    expect(wrapper.find('.mock-body').exists()).toBe(true)
  })

  it('never requests the screenshot while offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const wrapper = mountFigure({ shot: 'cliAgents.menu' })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(frameVisible(wrapper)).toBe(true)
  })

  it('shows the mock for a figure with no uploaded screenshot', () => {
    const wrapper = mountFigure({ shot: 'cliAgents.install' })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(frameVisible(wrapper)).toBe(true)
  })
})
