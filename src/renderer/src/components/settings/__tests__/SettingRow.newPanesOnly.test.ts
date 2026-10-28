// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingRow from '../SettingRow.vue'

const tMock = (key: string): string => key

describe('SettingRow – New panes only', () => {
  it('marks only the rows that ask for it', () => {
    const plain = mount(SettingRow, { props: { title: 'A' }, global: { mocks: { $t: tMock } } })
    expect(plain.find('[data-testid="setting-row-new-panes-only"]').exists()).toBe(false)
    const marked = mount(SettingRow, { props: { title: 'A', newPanesOnly: true }, global: { mocks: { $t: tMock } } })
    const chip = marked.find('[data-testid="setting-row-new-panes-only"]')
    expect(chip.text()).toBe('settings.applies.new-panes-only')
    expect(chip.attributes('title')).toBe('settings.applies.new-panes-only-tooltip')
  })
})
