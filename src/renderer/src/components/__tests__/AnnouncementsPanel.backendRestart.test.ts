// @vitest-environment happy-dom
// H3: a backend-restart row's Rebuild buttons go out as pane actions, never as
// quota actions (the panel's catch-all branch).
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AnnouncementsPanel from '../AnnouncementsPanel.vue'
import type { Announcement } from '../../composables/useAnnouncements'
import { i18n } from '@navide/plugin-ui/foundation'

describe('AnnouncementsPanel – backend restart row (H3)', () => {
  it('emits each Rebuild as a pane action with its pane id', async () => {
    const row: Announcement = {
      id: 'backend-restart:1',
      kind: 'backend-restart',
      title: 'Backend restarted at 10:00',
      highlights: ['Turn interrupted: worker-1'],
      read: false,
      actions: [
        { kind: 'pane-rebuild', paneId: 'p-1', name: 'worker-1' },
        { kind: 'pane-rebuild', paneId: 'p-2', name: 'worker-2' },
      ],
    }
    i18n.global.locale.value = 'en-US'
    const wrapper = mount(AnnouncementsPanel, { props: { items: [row] }, global: { plugins: [i18n] } })
    const buttons = wrapper.get('[data-ann-id="backend-restart:1"]').findAll('.an-acts button')
    expect(buttons.map((b) => b.text())).toEqual(['Rebuild worker-1', 'Rebuild worker-2'])
    await buttons[1].trigger('click')
    expect(wrapper.emitted('pane-action')).toEqual([[{ kind: 'pane-rebuild', paneId: 'p-2', name: 'worker-2' }]])
    expect(wrapper.emitted('quota-action')).toBeUndefined()
  })
})
