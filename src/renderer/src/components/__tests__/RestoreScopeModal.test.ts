// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RestoreScopeModal from '../RestoreScopeModal.vue'

function mountModal(open = true) {
  return mount(RestoreScopeModal, {
    props: { open, count: 6 },
    global: {
      stubs: { teleport: true },
      mocks: {
        $t: (key: string) => ({
          'restore.scope-title': 'Resume previous conversations',
          'restore.scope-message': 'This workspace has 6 previous sessions.',
          'restore.scope-single': 'Resume One CLI',
          'restore.scope-page': 'Resume Current Grid Page',
          'restore.scope-tab': 'Resume Active Tab',
          'restore.scope-all': 'Resume All CLIs',
          'restore.scope-fresh': 'Start All Fresh',
        })[key] ?? key,
      },
    },
  })
}

describe('RestoreScopeModal', () => {
  it('selects each configured resume scope', async () => {
    const wrapper = mountModal()
    const buttons = wrapper.findAll('.scope-actions button')

    await buttons[0].trigger('click')
    await buttons[1].trigger('click')
    await buttons[2].trigger('click')
    await buttons[3].trigger('click')

    expect(wrapper.emitted('select')?.map(([scope]) => scope)).toEqual(['single', 'page', 'tab', 'all'])
  })

  it('keeps explicit fresh separate from cancelling or dismissing', async () => {
    const wrapper = mountModal()
    await wrapper.get('.fresh').trigger('click')
    await wrapper.get('.restore-scope-modal').trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('fresh')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
