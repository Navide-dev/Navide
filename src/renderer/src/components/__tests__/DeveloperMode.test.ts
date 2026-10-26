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

// One launch with several workspace windows: the main process keeps the
// dismissal and tells every open window.
function launch(state: Record<string, unknown>): void {
  let dismissed = false
  const listeners = new Set<() => void>()
  ;(window as unknown as { agentTeam: unknown }).agentTeam = {
    plugins: {
      developerMode: async () => ({ folders: [], ...state }),
      developerModeReminderDismissed: async () => dismissed,
      dismissDeveloperModeReminder: async () => {
        dismissed = true
        for (const cb of listeners) cb()
      },
      onDeveloperModeReminderDismissed: (cb: () => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
  }
}

describe('DeveloperModeReminder: closed once, closed in every workspace window for the launch', () => {
  const open = async () => {
    const reminder = mount(DeveloperModeReminder, { global: { plugins: [i18n] } })
    await flushPromises()
    return reminder
  }

  it('stays closed in a window already open and in one opened after, while an unclosed launch still reminds', async () => {
    launch({ enabled: true })
    const first = await open()
    const second = await open()
    expect(first.find('[role="status"]').exists()).toBe(true)
    expect(second.find('[role="status"]').exists()).toBe(true)
    await first.get('.nv-devmode-reminder-close').trigger('click')
    await flushPromises()
    expect(first.find('[role="status"]').exists()).toBe(false)
    expect(second.find('[role="status"]').exists()).toBe(false)
    first.unmount()
    second.unmount()
    expect((await open()).find('[role="status"]').exists()).toBe(false)
    // The next launch reminds again.
    launch({ enabled: true })
    expect((await open()).find('[role="status"]').exists()).toBe(true)
  })

  it('says nothing while Developer Mode is off', async () => {
    launch({ enabled: false })
    expect((await open()).find('[role="status"]').exists()).toBe(false)
  })

  it('still says settings changed outside Navide until closed, then not in any window', async () => {
    launch({ enabled: false, externalChange: { detectedAt: '2026-10-21T01:00:00.000Z', modifiedAt: null } })
    const first = await open()
    expect(first.find('.nv-devmode-reminder-external').exists()).toBe(true)
    await first.get('.nv-devmode-reminder-close').trigger('click')
    await flushPromises()
    expect((await open()).find('[role="status"]').exists()).toBe(false)
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
