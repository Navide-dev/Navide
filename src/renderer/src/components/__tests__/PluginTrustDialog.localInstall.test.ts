// @vitest-environment happy-dom
// Card K3: the consent dialog for a Navide plugin installed from a file.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginTrustDialog from '../PluginTrustDialog.vue'
import { computeDisclosure, type DisclosureManifestInput } from '../../../../shared/pluginDisclosure'

const LOCALES = ['zh-TW', 'en-US', 'ja-JP'] as const

function pending(extra: Record<string, unknown> = {}) {
  return {
    label: 'acme.todo',
    prepared: {
      id: 'acme.todo',
      version: '1.0.0',
      trustTier: 'unsigned',
      sensitive: [],
      containsBackendExecutable: true,
      requiresConfirmation: true,
      publisherId: 'acme',
      requiresPublisherTrust: false,
      requiresRiskConfirmation: true,
      disclosure: null,
      scan: null,
      registry: null,
      source: 'local-unsigned',
      digest: 'a'.repeat(64),
      ...extra,
    },
  }
}

function render(step: 'replace' | 'risk', extra: Record<string, unknown> = {}) {
  return mount(PluginTrustDialog, {
    props: { pending: pending(extra), step } as never,
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
}

let saved: typeof i18n.global.locale.value
beforeEach(() => {
  saved = i18n.global.locale.value
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  i18n.global.locale.value = saved
  document.body.innerHTML = ''
})

describe('PluginTrustDialog for a file install (K3)', () => {
  it('shows the fixed warning, the local source row, the claimed publisher and no scan, in every locale', () => {
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      const dialog = render('risk')
      const warning = dialog.get('.ext-local-warning')
      expect(warning.attributes('role')).toBe('note')
      expect(warning.text()).toBe(i18n.global.t('settings.extensions.localInstall.warning'))
      const row = dialog.get('.nv-source-row')
      expect(row.attributes('data-source')).toBe('local-unsigned')
      expect(row.text()).toContain(i18n.global.t('pluginDisclosure.source.selfDeclared', { publisher: 'acme' }))
      expect(dialog.text()).toContain(i18n.global.t('settings.extensions.localInstall.signature'))
      expect(dialog.text()).toContain('a'.repeat(64))
      // A local install is never called reviewed or verified.
      expect(dialog.find('.ext-trust-badge.ext-verified').exists()).toBe(false)
      expect(dialog.text()).not.toContain(i18n.global.t('pluginDisclosure.source.marketplace'))
      dialog.unmount()
    }
  })

  it('starts on Cancel and keeps consent disabled until the user acknowledges the risk', async () => {
    const dialog = render('risk')
    await flushPromises()
    await nextTick()
    expect(document.activeElement?.classList.contains('ext-cancel')).toBe(true)
    const confirm = dialog.get('.ext-confirm-risk')
    expect(confirm.attributes('disabled')).toBeDefined()
    await confirm.trigger('click')
    expect(dialog.emitted('confirmRisk')).toBeUndefined()
    await dialog.get('.ext-local-ack-input').setValue(true)
    expect(confirm.attributes('disabled')).toBeUndefined()
    await confirm.trigger('click')
    expect(dialog.emitted('confirmRisk')).toHaveLength(1)
  })

  it('reads the disclosure as the Host reading the manifest, never as Registry-verified', () => {
    const disclosure = computeDisclosure({
      schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.todo', name: 'Todo', version: '1.0.0', publisher: 'acme',
      permissions: {}, marketplace: { description: 'Todo', license: 'MIT' },
      contributes: { views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Todo', entry: 'frontend/left/index.html' }] },
    } as unknown as DisclosureManifestInput)
    const dialog = render('risk', { disclosure })
    const provenance = dialog.get('.nv-disclosure-provenance')
    expect(provenance.text()).toBe(i18n.global.t('pluginDisclosure.provenance.local'))
    expect(provenance.classes()).toContain('nv-disclosure-provenance--unverified')
    expect(dialog.text()).not.toContain(i18n.global.t('pluginDisclosure.provenance.verifiedNoScan'))
  })

  it('asks before replacing a Marketplace install, and says nothing is kept', async () => {
    const dialog = render('replace', { replaces: { version: '0.9.0', source: 'marketplace' } })
    expect(dialog.text()).toContain(i18n.global.t('settings.extensions.localInstall.replaceMarketplace', { id: 'acme.todo', version: '0.9.0' }))
    expect(dialog.text()).toContain(i18n.global.t('settings.extensions.localInstall.replaceResets'))
    expect(dialog.find('.ext-confirm-risk').exists()).toBe(false)
    await dialog.get('.ext-confirm-replace').trigger('click')
    expect(dialog.emitted('confirmReplace')).toHaveLength(1)
  })

  it('asks before a Marketplace install replaces a local one', () => {
    const dialog = render('replace', { source: undefined, trustTier: 'signed-verified', replacesLocal: { version: '1.1.0-local' } })
    expect(dialog.text()).toContain(i18n.global.t('settings.extensions.localInstall.replaceWithMarketplace', { id: 'acme.todo', version: '1.0.0' }))
  })

  it('leaves a Marketplace install without the local warning or acknowledgement', () => {
    const dialog = render('risk', { source: undefined, trustTier: 'signed-verified', digest: undefined })
    expect(dialog.find('.ext-local-warning').exists()).toBe(false)
    expect(dialog.find('.ext-local-ack').exists()).toBe(false)
    expect(dialog.get('.ext-confirm-risk').attributes('disabled')).toBeUndefined()
  })

  it('says plainly when the takedown check could not be done, and only then (MED-1)', () => {
    const unknown = render('risk', { takedownChecked: false })
    expect(unknown.get('.ext-local-takedown').text()).toBe(i18n.global.t('settings.extensions.localInstall.takedownUnknown'))
    unknown.unmount()
    const checked = render('risk', { takedownChecked: true })
    expect(checked.find('.ext-local-takedown').exists()).toBe(false)
  })

  it('discloses that the data is kept aside, and takes it back only when the user ticks it (D7)', async () => {
    const dialog = render('replace', {
      replaces: { version: '0.9.0', source: 'marketplace' },
      backendDataSetAside: true,
      reattachableBackendData: true,
    })
    expect(dialog.get('.ext-replace-data').text()).toBe(i18n.global.t('settings.extensions.localInstall.replaceDataSetAside'))
    const box = dialog.get('.ext-replace-reattach-input').element as HTMLInputElement
    expect(box.checked).toBe(false)
    await dialog.get('.ext-confirm-replace').trigger('click')
    await dialog.get('.ext-replace-reattach-input').setValue(true)
    await dialog.get('.ext-confirm-replace').trigger('click')
    expect(dialog.emitted('confirmReplace')).toEqual([[false], [true]])
  })
})

describe('PluginTrustDialog: the signature of a file install (A3)', () => {
  const signed = (state: 'verified' | 'revoked' | 'unverifiable') => ({ localSignature: { state, publisherId: 'acme', keyId: 'k1' } })

  it('names the vetted developer who signed it and still says this version was not reviewed', () => {
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      const dialog = render('risk', signed('verified'))
      expect(dialog.get('.ext-local-warning').text())
        .toBe(i18n.global.t('settings.extensions.localInstall.signatureState.warningVerified', { publisher: 'acme' }))
      const line = dialog.get('.ext-local-signature')
      expect(line.attributes('data-signature')).toBe('verified')
      expect(line.text()).toBe(i18n.global.t('settings.extensions.localInstall.signatureState.verified', { publisher: 'acme' }))
      const row = dialog.get('.nv-source-row')
      expect(row.attributes('data-source')).toBe('local-signed')
      expect(row.text()).not.toContain(i18n.global.t('pluginDisclosure.source.selfDeclared', { publisher: 'acme' }))
      // Consent is still asked for exactly as for an unsigned file.
      expect(dialog.get('.ext-confirm-risk').attributes('disabled')).toBeDefined()
      dialog.unmount()
    }
  })

  it('says a revoked signature is no longer valid', () => {
    for (const locale of LOCALES) {
      i18n.global.locale.value = locale
      const dialog = render('risk', signed('revoked'))
      expect(dialog.get('.ext-local-signature').text())
        .toBe(i18n.global.t('settings.extensions.localInstall.signatureState.revoked', { publisher: 'acme' }))
      expect(dialog.get('.ext-local-warning').text())
        .toBe(i18n.global.t('settings.extensions.localInstall.signatureState.warningRevoked', { publisher: 'acme' }))
      expect(dialog.get('.nv-source-row .nv-source-badge').text()).toBe(i18n.global.t('pluginDisclosure.source.signatureRevoked'))
      dialog.unmount()
    }
  })

  it('treats a signature no vetted key matches as unsigned', () => {
    i18n.global.locale.value = 'en-US'
    const dialog = render('risk', signed('unverifiable'))
    expect(dialog.get('.ext-local-warning').text()).toBe(i18n.global.t('settings.extensions.localInstall.warning'))
    expect(dialog.get('.ext-local-signature').text())
      .toBe(i18n.global.t('settings.extensions.localInstall.signatureState.unverifiable', { publisher: 'acme' }))
    expect(dialog.get('.nv-source-row').attributes('data-source')).toBe('local-unsigned')
  })
})

describe('PluginTrustDialog for going back to a kept file version (L4, review M3)', () => {
  it('shows the renewed-consent note with the kept version disclosure, source and digest', () => {
    const dialog = mount(PluginTrustDialog, {
      props: { pending: { ...pending(), rollbackFrom: '1.1.0' }, step: 'risk' } as never,
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
    const note = dialog.get('[data-testid="ext-trust-rollback-consent"]')
    expect(note.text()).toBe(i18n.global.t('settings.extensions.rollback.confirmLocalConsent', { id: 'acme.todo', version: '1.0.0' }))
    // The same local disclosure as a file install: fixed warning, source row, digest.
    expect(dialog.get('.ext-local-warning').text()).toBe(i18n.global.t('settings.extensions.localInstall.warning'))
    expect(dialog.get('.nv-source-row').attributes('data-source')).toBe('local-unsigned')
    expect(dialog.text()).toContain('a'.repeat(64))
    // Consent still needs the explicit acknowledgement.
    expect(dialog.get('.ext-confirm-risk').attributes('disabled')).toBeDefined()
    dialog.unmount()
  })

  it('shows no rollback note for an ordinary file install', () => {
    const dialog = render('risk')
    expect(dialog.find('[data-testid="ext-trust-rollback-consent"]').exists()).toBe(false)
    dialog.unmount()
  })
})

describe('PluginTrustDialog after a failed approval', () => {
  function renderWith(extra: Record<string, unknown>) {
    return mount(PluginTrustDialog, {
      props: { pending: { ...pending(), ...extra }, step: 'risk' } as never,
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
  }

  it('says why in the dialog, and does not offer a used-up file again', async () => {
    const dialog = renderWith({ commitError: 'Version taken.', needsFileAgain: true })
    const alert = dialog.get('.ext-trust-error')
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toContain('Version taken.')
    expect(alert.text()).toContain(i18n.global.t('settings.extensions.localInstall.chooseAgain'))
    await dialog.get('.ext-local-ack-input').setValue(true)
    expect(dialog.get('.ext-confirm-risk').attributes('disabled')).toBeDefined()
  })

  it('keeps approving possible when the prepared copy is still there', async () => {
    const dialog = renderWith({ commitError: 'Could not install.' })
    expect(dialog.get('.ext-trust-error').text()).not.toContain(i18n.global.t('settings.extensions.localInstall.chooseAgain'))
    await dialog.get('.ext-local-ack-input').setValue(true)
    expect(dialog.get('.ext-confirm-risk').attributes('disabled')).toBeUndefined()
  })

  it('shows nothing before any approval failed', () => {
    expect(render('risk').find('.ext-trust-error').exists()).toBe(false)
  })
})
