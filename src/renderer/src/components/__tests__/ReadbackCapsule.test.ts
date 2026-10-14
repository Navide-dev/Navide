// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ReadbackCapsule from '../ReadbackCapsule.vue'

// The readback pill: shown only while a line is being spoken, with the line and
// how to stop it; its ✕ stops it too.

describe('ReadbackCapsule', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('renders nothing while idle', () => {
    wrapper = mount(ReadbackCapsule, { props: { state: null }, global: { plugins: [i18n] } })
    expect(wrapper.find('.readback-capsule').exists()).toBe(false)
  })

  it('shows the spoken line and the Esc hint; ✕ emits stop', async () => {
    wrapper = mount(ReadbackCapsule, {
      props: { state: { text: 'Navide指揮 is done', paneIds: ['p1'] } },
      global: { plugins: [i18n] },
    })
    const pill = wrapper.get('.readback-capsule')
    expect(pill.text()).toContain('Navide指揮 is done')
    expect(pill.text()).toContain('Esc')
    await wrapper.get('.rc-stop').trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
  })
})
