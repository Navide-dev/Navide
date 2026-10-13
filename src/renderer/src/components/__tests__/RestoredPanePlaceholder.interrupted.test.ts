// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RestoredPanePlaceholder from '../RestoredPanePlaceholder.vue'

function mountPlaceholder(interrupted?: boolean) {
  return mount(RestoredPanePlaceholder, {
    props: { paneId: 'saved-pane-1', title: 'Planning', interrupted },
    global: {
      mocks: {
        $t: (key: string) => ({
          'pane.terminal.interrupted-at-launch': 'Working at restart',
          'pane.terminal.interrupted-at-launch-tooltip': 'This pane was working when Navide restarted',
        })[key] ?? key,
      },
    },
  })
}

describe('RestoredPanePlaceholder interrupted marker', () => {
  it('marks a pane that was working when the app restarted', () => {
    const mark = mountPlaceholder(true).get('.interrupted-mark')
    expect(mark.text()).toBe('Working at restart')
    expect(mark.attributes('title')).toBe('This pane was working when Navide restarted')
  })

  it('shows nothing for any other placeholder', () => {
    expect(mountPlaceholder(false).find('.interrupted-mark').exists()).toBe(false)
    expect(mountPlaceholder().find('.interrupted-mark').exists()).toBe(false)
  })

  it('keeps the mark out of the title', () => {
    expect(mountPlaceholder(true).get('.title').text()).toBe('Planning')
  })
})
