// @vitest-environment happy-dom
// A2-3 (DESIGN-A2 G2): the "Local folder" info card of a developer folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import DeveloperFolderInfoCard from '../DeveloperFolderInfoCard.vue'

const FINGERPRINT = 'ab12cd34ef56'.padEnd(64, '0')
const LOCALES = ['zh-TW', 'en-US', 'ja-JP'] as const

let saved: typeof i18n.global.locale.value
beforeEach(() => {
  saved = i18n.global.locale.value
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  i18n.global.locale.value = saved
  delete (window as unknown as { agentTeam?: unknown }).agentTeam
})

const card = (folder: Record<string, unknown>) =>
  mount(DeveloperFolderInfoCard, { props: { folder: { pluginId: 'acme.devtodo', path: '/Users/me/dev-todo', ...folder } as never }, global: { plugins: [i18n] } })

describe('DeveloperFolderInfoCard', () => {
  it('shows the folder, the last load, its fingerprint and who loaded it, in every locale', () => {
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      const wrapper = card({
        lastLoad: { at: '2026-10-21T01:00:00.000Z', trigger: 'auto-reload', fingerprint: FINGERPRINT, fileCount: 37 },
        loadedBy: { kind: 'agent', callerKind: 'pane', paneName: 'builder', approvedAt: '2026-10-21T00:59:00.000Z' },
      })
      expect(wrapper.get('[role="dialog"]').text()).toContain(i18n.global.t('pluginDisclosure.source.developer-unpacked'))
      expect(wrapper.get('.nv-folder-card-path').text()).toBe('/Users/me/dev-todo')
      expect(wrapper.get('.nv-folder-card-trigger').text()).toBe(i18n.global.t('settings.extensions.developerMode.infoCard.trigger.auto-reload'))
      expect(wrapper.get('.nv-folder-card-fingerprint code').text()).toBe('ab12cd34ef56')
      expect(wrapper.get('.nv-folder-card-files').text()).toBe(i18n.global.t('settings.extensions.developerMode.infoCard.fileCount', { count: 37 }))
      expect(wrapper.get('.nv-folder-card-loader').text()).toContain('builder')
      const notes = wrapper.findAll('.nv-folder-card-note').map((note) => note.text())
      expect(notes).toEqual([
        i18n.global.t('settings.extensions.developerMode.infoCard.notReviewed'),
        i18n.global.t('settings.extensions.developerMode.infoCard.mayChange'),
      ])
      wrapper.unmount()
    }
  })

  it('copies the whole fingerprint and reveals the folder through the Host', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const revealPath = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { revealPath }
    const wrapper = card({ lastLoad: { at: '2026-10-21T01:00:00.000Z', trigger: 'user-load', fingerprint: FINGERPRINT, fileCount: 2 }, loadedBy: { kind: 'user' } })
    await wrapper.get('.nv-folder-card-copy').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(FINGERPRINT)
    expect(wrapper.get('.nv-folder-card-copy').text()).toBe(i18n.global.t('settings.extensions.developerMode.infoCard.copied'))
    await wrapper.get('.nv-folder-card-reveal').trigger('click')
    expect(revealPath).toHaveBeenCalledWith('/Users/me/dev-todo')
    expect(wrapper.get('.nv-folder-card-loader').text()).toBe(i18n.global.t('settings.extensions.developerMode.loadedByUser'))
  })

  it('says "computing" before the fingerprint is taken, and "not recorded" for an older load', () => {
    const computing = card({ lastLoad: { at: '2026-10-21T01:00:00.000Z', trigger: 'startup' }, loadedBy: { kind: 'unknown' } })
    expect(computing.get('.nv-folder-card-fingerprint').text()).toBe(i18n.global.t('settings.extensions.developerMode.infoCard.computing'))
    expect(computing.get('.nv-folder-card-loader').text()).toBe(i18n.global.t('settings.extensions.developerMode.loadedByUnknown'))
    const older = card({})
    expect(older.get('.nv-folder-card-loaded').text()).toBe(i18n.global.t('settings.extensions.developerMode.infoCard.notRecorded'))
    expect(older.get('.nv-folder-card-fingerprint').text()).toBe(i18n.global.t('settings.extensions.developerMode.infoCard.notRecorded'))
  })

  it('review MED-1 on #536 / #552: a loader record that does not verify says so, and an unsigned one says it is not signed', () => {
    const changed = card({ loadedBy: { kind: 'unknown' }, loadedByUnverified: 'changed' })
    expect(changed.get('.nv-folder-card-loader').text()).toBe(i18n.global.t('settings.extensions.developerMode.loadedByUnverified'))
    const rekeyed = card({ loadedBy: { kind: 'unknown' }, loadedByUnverified: 'key-changed' })
    expect(rekeyed.get('.nv-folder-card-loader').text()).toBe(i18n.global.t('settings.extensions.developerMode.loadedByKeyChanged'))
    const unsigned = card({ loadedBy: { kind: 'user' }, loadedByUnsigned: true })
    expect(unsigned.get('.nv-folder-card-loader').text()).toBe(
      `${i18n.global.t('settings.extensions.developerMode.loadedByUser')} ${i18n.global.t('settings.extensions.developerMode.loadedByUnsigned')}`,
    )
  })
})
