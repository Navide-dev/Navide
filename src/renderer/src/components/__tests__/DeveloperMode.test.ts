// @vitest-environment happy-dom
// Card K4: the launch reminder while Developer Mode is on, and the consent
// dialog for a developer folder.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import DeveloperModeReminder from '../DeveloperModeReminder.vue'
import PluginTrustDialog from '../PluginTrustDialog.vue'

const LOCALES = ['zh-TW', 'en-US', 'ja-JP'] as const

function withDeveloperMode(enabled: boolean): void {
  ;(window as unknown as { agentTeam: unknown }).agentTeam = {
    plugins: { developerMode: async () => ({ enabled, folders: [] }) },
  }
}

let saved: typeof i18n.global.locale.value
beforeEach(() => {
  saved = i18n.global.locale.value
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  i18n.global.locale.value = saved
  delete (window as unknown as { agentTeam?: unknown }).agentTeam
})

describe('DeveloperModeReminder (K4)', () => {
  it('reminds on every launch while Developer Mode is on, in every locale', async () => {
    withDeveloperMode(true)
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      const reminder = mount(DeveloperModeReminder, { global: { plugins: [i18n] } })
      await flushPromises()
      expect(reminder.get('[role="status"]').text()).toContain(i18n.global.t('settings.extensions.developerMode.reminder'))
      reminder.unmount()
    }
  })

  it('says nothing while it is off, and closes for this launch only', async () => {
    withDeveloperMode(false)
    const off = mount(DeveloperModeReminder, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(off.find('[role="status"]').exists()).toBe(false)
    withDeveloperMode(true)
    const on = mount(DeveloperModeReminder, { global: { plugins: [i18n] } })
    await flushPromises()
    await on.get('.nv-devmode-reminder-close').trigger('click')
    expect(on.find('[role="status"]').exists()).toBe(false)
  })
})

describe('DeveloperModeReminder: settings changed outside Navide (A2-5, G5)', () => {
  it('says so on launch in every locale, also while the switch it turned on is not applied', async () => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = {
      plugins: { developerMode: async () => ({ enabled: false, externalChange: { detectedAt: '2026-10-21T01:00:00.000Z', modifiedAt: null }, folders: [] }) },
    }
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      const reminder = mount(DeveloperModeReminder, { global: { plugins: [i18n] } })
      await flushPromises()
      const text = reminder.get('.nv-devmode-reminder-external').text()
      const expected = i18n.global.t('settings.extensions.developerMode.externalChange', { time: 'TIME' })
      expect(text.startsWith(expected.split('TIME')[0]!)).toBe(true)
      expect(text).not.toContain(i18n.global.t('settings.extensions.developerMode.reminder'))
      reminder.unmount()
    }
  })
})

describe('PluginTrustDialog for a developer folder (K4)', () => {
  const pending = {
    label: 'acme.devtodo',
    prepared: {
      id: 'acme.devtodo', version: '0.1.0', trustTier: 'unsigned', sensitive: [], containsBackendExecutable: true,
      requiresConfirmation: true, publisherId: 'acme', requiresPublisherTrust: false, requiresRiskConfirmation: true,
      disclosure: null, scan: null, registry: null, source: 'developer-unpacked', folder: '/Users/me/dev-todo',
    },
  }

  it('warns that the folder may change and is not compared, names the folder, and needs the acknowledgement', async () => {
    const dialog = mount(PluginTrustDialog, { props: { pending, step: 'risk' } as never, global: { plugins: [i18n] }, attachTo: document.body })
    expect(dialog.get('.ext-local-warning').text()).toBe(i18n.global.t('settings.extensions.developerMode.folderWarning'))
    expect(dialog.text()).toContain('/Users/me/dev-todo')
    expect(dialog.get('.nv-source-row').attributes('data-source')).toBe('developer-unpacked')
    const confirm = dialog.get('.ext-confirm-risk')
    expect(confirm.attributes('disabled')).toBeDefined()
    await dialog.get('.ext-local-ack-input').setValue(true)
    expect(confirm.attributes('disabled')).toBeUndefined()
    dialog.unmount()
  })
})
