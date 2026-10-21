// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RestoredPanePlaceholder from '../RestoredPanePlaceholder.vue'

function mountPlaceholder(realizing = false, autoNamed = false) {
  return mount(RestoredPanePlaceholder, {
    props: {
      paneId: 'saved-pane-1',
      title: 'Planning',
      autoNamed,
      subtitle: 'Claude · Architect',
      pipeTag: 'P01',
      isFocus: true,
      realizing,
    },
    global: {
      mocks: {
        $t: (key: string) => ({
          'pane.terminal.click-to-resume': 'Click to resume',
          'pane.terminal.resuming': 'Resuming…',
          'pane.terminal.minimize-tooltip': 'Minimize to Sidebar',
        })[key] ?? key,
      },
    },
  })
}

describe('RestoredPanePlaceholder', () => {
  it('shows persisted pane metadata without a terminal host', () => {
    const wrapper = mountPlaceholder()

    expect(wrapper.attributes('data-pane-id')).toBe('saved-pane-1')
    expect(wrapper.classes()).toContain('pane-focus')
    expect(wrapper.text()).toContain('P01')
    expect(wrapper.text()).toContain('Planning')
    expect(wrapper.text()).toContain('Claude · Architect')
    expect(wrapper.text()).toContain('Click to resume')
    expect(wrapper.find('.terminal').exists()).toBe(false)
    expect(wrapper.find('.xterm').exists()).toBe(false)
  })

  it('marks an auto-derived title and leaves a user-set one unmarked', () => {
    expect(mountPlaceholder(false, false).find('.auto-name-mark').exists()).toBe(false)

    const auto = mountPlaceholder(false, true)
    expect(auto.get('.auto-name-mark').text()).toBe('◦')
    // The mark is decoration next to the title, never part of it.
    expect(auto.get('.title').text()).toBe('Planning')
  })

  it('offers a real button so resuming is not mouse-only', async () => {
    const wrapper = mountPlaceholder()
    const resume = wrapper.get('button.resume-prompt')

    // A native <button> gets Enter/Space from the browser — no keydown handler
    // on the container, which is what made the minimize button double-fire.
    expect(resume.attributes('type')).toBe('button')
    expect(wrapper.attributes('role')).toBeUndefined()
    expect(wrapper.attributes('tabindex')).toBeUndefined()

    await resume.trigger('click')
    expect(wrapper.emitted('activate')).toHaveLength(1)

    // Clicking the surrounding pane still resumes, and the button's own click
    // must not bubble into a second activate.
    await wrapper.trigger('click')
    expect(wrapper.emitted('activate')).toHaveLength(2)
  })

  it('does not activate while realization is already in flight', async () => {
    const wrapper = mountPlaceholder(true)

    await wrapper.trigger('click')
    await wrapper.get('button.resume-prompt').trigger('click')
    expect(wrapper.emitted('activate')).toBeUndefined()
    expect(wrapper.get('button.resume-prompt').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Resuming…')
    expect(wrapper.attributes('aria-busy')).toBe('true')
  })

  it('keeps minimize and context-menu actions separate from activation', async () => {
    const wrapper = mountPlaceholder()

    await wrapper.get('.minimize-btn').trigger('click')
    expect(wrapper.emitted('minimize')).toHaveLength(1)
    expect(wrapper.emitted('activate')).toBeUndefined()

    await wrapper.trigger('contextmenu')
    expect(wrapper.emitted('context-menu')).toHaveLength(1)
    expect(wrapper.emitted('activate')).toBeUndefined()
  })

  // Keyboard-activating the nested minimize button must not also resume the
  // pane: a bubbling keydown would fire both actions from one press.
  it('does not activate when the minimize button is used from the keyboard', async () => {
    const wrapper = mountPlaceholder()
    const minimize = wrapper.get('.minimize-btn')

    await minimize.trigger('keydown', { key: 'Enter' })
    await minimize.trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('activate')).toBeUndefined()

    await minimize.trigger('click')
    expect(wrapper.emitted('minimize')).toHaveLength(1)
    expect(wrapper.emitted('activate')).toBeUndefined()
  })
})
