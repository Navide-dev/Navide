import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotify } from '@navide/plugin-ui/foundation'
import { usePluginInventory } from './usePluginInventory'
import { usePluginUpdates } from './usePluginUpdates'
import { formatBytes } from '../lib/formatBytes'
import { localizeDeveloperModeError } from '../lib/developerModeErrors'

// The verified install flow shared by the Marketplace (install/update) and the
// Extensions page (update): prepare → optional publisher/risk confirmation →
// commit. Sensitive capabilities, an unknown publisher and native backend
// executables hold the prepared package for PluginTrustDialog; nothing is
// written until the user confirms. Updating is the same flow — the main
// process replaces the installed version on commit.
export interface PendingInstall {
  /** `namespace.name`, shown in the risk copy. */
  label: string
  prepared: PreparedInstallSummary
  /** W1 (S2): an agent's file request this consent carries out; the dialog
   *  names who asked. Absent for the user's own pick. */
  agentRequest?: { requester: string }
  /** L4: this consent is for going back to the kept file version `prepared`
   *  describes, from the version named here; approving rolls back. */
  rollbackFrom?: string
}

/** Card K3: the extra step a package of the same id asks for before it is
 *  replaced (D7), then the publisher or risk step as before. */
export type InstallStep = 'replace' | 'publisher' | 'risk'

function replacesAnother(prepared: PreparedInstallSummary): boolean {
  return prepared.replaces !== undefined || prepared.replacesLocal !== undefined
}

export function usePluginInstallFlow() {
  const { t } = useI18n()
  const notify = useNotify()
  const inventory = usePluginInventory()
  const pluginUpdates = usePluginUpdates()
  const busy = ref(false)
  const error = ref('')
  const pendingConfirm = ref<PendingInstall | null>(null)
  const pendingStep = ref<InstallStep | null>(null)
  const publisherConfirmed = ref(false)
  const replaceConfirmed = ref(false)
  // D7: take back data set aside earlier from this source; off unless chosen.
  const reattachBackendData = ref(false)

  function api() {
    return window.agentTeam?.plugins
  }

  function fail(err: unknown): void {
    error.value = localizeDeveloperModeError(ipcErrorMessage(err), t)
  }

  async function commit(
    id: string,
    approval: { publisherConfirmed?: boolean; riskConfirmed?: boolean }
  ): Promise<void> {
    const plugins = api()
    if (!plugins) return
    const pendingSource = pendingConfirm.value?.prepared.id === id ? pendingConfirm.value.prepared.source : undefined
    const local = pendingSource === 'local-unsigned'
    const replace = replaceConfirmed.value
      ? { replaceConfirmed: true, ...(reattachBackendData.value ? { reattachBackendData: true } : {}) }
      : {}
    // The commit names the folder or file digest the dialog showed, so another
    // prepare of the same id meanwhile (an agent's request, a second pick)
    // is refused instead of installed.
    const shown = pendingConfirm.value?.prepared.id === id ? pendingConfirm.value.prepared : undefined
    let committed: { restartRequired?: boolean; activationError?: string } | undefined
    if (pendingSource === 'developer-unpacked') {
      if (!plugins.commitFolderLoad) throw new Error('loading from a folder is unavailable')
      await plugins.commitFolderLoad(id, {
        riskConfirmed: approval.riskConfirmed === true,
        ...(shown?.folder ? { expectedFolder: shown.folder } : {}),
      })
    } else if (local) {
      if (!plugins.commitLocalInstall) throw new Error('installing from a file is unavailable')
      committed = await plugins.commitLocalInstall(id, {
        riskConfirmed: approval.riskConfirmed === true,
        ...replace,
        ...(shown?.digest ? { expectedDigest: shown.digest } : {}),
      })
    } else {
      committed = await plugins.commitInstall(id, { ...approval, ...replace })
    }
    pendingConfirm.value = null
    pendingStep.value = null
    await Promise.all([inventory.refresh(), pluginUpdates.refresh()])
    // L3: an approved update takes effect now, through the same Restart the
    // list offers (the dialog said so before approval, and the switch is
    // recorded with a way back). The main window refreshes once it is done.
    if (committed?.restartRequired === true && !committed.activationError && plugins.restart) {
      try {
        await plugins.restart(id)
      } catch (err) {
        committed = { ...committed, activationError: ipcErrorMessage(err) }
      }
      await Promise.all([inventory.refresh(), pluginUpdates.refresh()])
    }
    // L1: a first install is activated on approval; one that could not be
    // stays staged with Restart and Discard, and the reason is shown.
    if (committed?.activationError) {
      error.value = t('settings.extensions.activationFailed', { plugin: id, reason: committed.activationError })
    }
  }

  // `version` pins the artifact (an update names the newest version this Host
  // can install); omitted, the main process installs the Registry's latest.
  // `testplace` installs an invited test build with the user's Navide Cloud account.
  async function install(namespace: string, name: string, version?: string, options: { testplace?: boolean } = {}): Promise<void> {
    const plugins = api()
    if (!plugins) return
    busy.value = true
    error.value = ''
    try {
      const prepared = await plugins.prepareInstall({
        namespace,
        name,
        ...(version ? { version } : {}),
        ...(options.testplace ? { testplace: true } : {}),
      })
      const requiresPublisherTrust = prepared.requiresPublisherTrust === true
      // A test build is never installed unseen: its source row says what review it had.
      const requiresRiskConfirmation =
        (prepared.requiresRiskConfirmation ?? prepared.requiresConfirmation) || prepared.source === 'testplace'
      if (requiresPublisherTrust || requiresRiskConfirmation || replacesAnother(prepared)) {
        // Hold for the trust dialog — nothing is written until the user confirms.
        pendingConfirm.value = { label: `${namespace}.${name}`, prepared }
        pendingStep.value = replacesAnother(prepared) ? 'replace' : requiresPublisherTrust ? 'publisher' : 'risk'
        publisherConfirmed.value = false
        replaceConfirmed.value = false
        reattachBackendData.value = false
        return
      }
      await commit(prepared.id, {})
    } catch (err) {
      fail(err)
    } finally {
      busy.value = false
    }
  }

  /** Card K3: install a `.vsix` the user picks in the main process's own
   *  file dialog. Always held for consent: the package is unreviewed. */
  async function installFromFile(): Promise<void> {
    const plugins = api()
    if (!plugins?.installFromFile) return
    busy.value = true
    error.value = ''
    try {
      const prepared = await plugins.installFromFile()
      if (!prepared) return
      pendingConfirm.value = { label: prepared.id, prepared }
      pendingStep.value = replacesAnother(prepared) ? 'replace' : 'risk'
      publisherConfirmed.value = false
      replaceConfirmed.value = false
      reattachBackendData.value = false
    } catch (err) {
      fail(err)
    } finally {
      busy.value = false
    }
  }

  /** W1 (S2): an approved agent file request. The Host staged the file (or
   *  folder) when the agent asked; this holds that copy for the same consent
   *  dialog as the user's own pick, naming who asked. A file whose digest is
   *  not the one the request card showed is refused. */
  async function prepareAgentFile(
    stagingId: string,
    expectedDigest: string | null,
    requester: string,
    requesterIdentity?: { callerKind: string; paneName?: string },
  ): Promise<void> {
    const plugins = api()
    if (!plugins?.prepareAgentFileInstall) throw new Error('installing from a file is unavailable')
    busy.value = true
    error.value = ''
    try {
      // G3: the Host keeps who asked with a developer folder after it loads.
      const prepared = await plugins.prepareAgentFileInstall(stagingId, requesterIdentity)
      if (expectedDigest !== null && prepared.digest !== expectedDigest) {
        throw new Error(t('plugin-request.file.digestChanged'))
      }
      pendingConfirm.value = { label: prepared.id, prepared, agentRequest: { requester } }
      pendingStep.value = replacesAnother(prepared) ? 'replace' : 'risk'
      publisherConfirmed.value = false
      replaceConfirmed.value = false
      reattachBackendData.value = false
    } catch (err) {
      fail(err)
    } finally {
      busy.value = false
    }
  }

  /** Card K4: load a developer folder the user picks in the main process's
   *  own folder dialog (Developer Mode on). Always held for consent. */
  async function loadFromFolder(): Promise<void> {
    const plugins = api()
    if (!plugins?.loadFromFolder) return
    await holdForConsent(() => plugins.loadFromFolder!())
  }

  /** Card K4: reload a developer folder; a change to its permissions or
   *  backend asks for consent again, a change to its files does not. */
  async function reloadDeveloperPlugin(id: string): Promise<void> {
    const plugins = api()
    if (!plugins?.reloadDeveloperPlugin) return
    await holdForConsent(async () => {
      const result = await plugins.reloadDeveloperPlugin!(id)
      if (!result.requiresConsent) await inventory.refresh()
      return result.requiresConsent ? result.prepared : null
    })
  }

  async function holdForConsent(prepare: () => Promise<PreparedInstallSummary | null>): Promise<void> {
    busy.value = true
    error.value = ''
    try {
      const prepared = await prepare()
      if (!prepared) return
      pendingConfirm.value = { label: prepared.id, prepared }
      pendingStep.value = 'risk'
      publisherConfirmed.value = false
      replaceConfirmed.value = false
      reattachBackendData.value = false
    } catch (err) {
      fail(err)
    } finally {
      busy.value = false
    }
  }

  /** D7: the user agreed to replace the installed package of this id. */
  async function confirmReplace(reattach = false): Promise<void> {
    const pending = pendingConfirm.value
    if (!pending) return
    replaceConfirmed.value = true
    reattachBackendData.value = reattach === true && pending.prepared.reattachableBackendData !== undefined
    const prepared = pending.prepared
    if (prepared.requiresPublisherTrust === true) {
      pendingStep.value = 'publisher'
      return
    }
    if (prepared.requiresRiskConfirmation ?? prepared.requiresConfirmation) {
      pendingStep.value = 'risk'
      return
    }
    busy.value = true
    try {
      await commit(prepared.id, {})
    } catch (err) {
      fail(err)
    } finally {
      busy.value = false
    }
  }

  async function confirmPublisher(): Promise<void> {
    if (!pendingConfirm.value) return
    publisherConfirmed.value = true
    if (
      pendingConfirm.value.prepared.requiresRiskConfirmation ??
      pendingConfirm.value.prepared.requiresConfirmation
    ) {
      pendingStep.value = 'risk'
      return
    }
    busy.value = true
    try {
      await commit(pendingConfirm.value.prepared.id, { publisherConfirmed: true })
    } catch (err) {
      fail(err)
    } finally {
      busy.value = false
    }
  }

  /** L4 (review M3): going back to a kept file version shows that version's
   *  disclosure in the consent dialog first; approving it rolls back. */
  async function rollbackWithConsent(id: string): Promise<void> {
    const plugins = api()
    if (!plugins?.prepareLocalRollback) return
    busy.value = true
    error.value = ''
    try {
      const prepared = await plugins.prepareLocalRollback(id)
      pendingConfirm.value = { label: prepared.id, prepared, rollbackFrom: prepared.rollbackFrom }
      pendingStep.value = 'risk'
      publisherConfirmed.value = false
      replaceConfirmed.value = false
      reattachBackendData.value = false
    } catch (err) {
      fail(err)
    } finally {
      busy.value = false
    }
  }

  async function confirmRisk(): Promise<void> {
    if (!pendingConfirm.value) return
    if (pendingConfirm.value.rollbackFrom !== undefined) {
      const id = pendingConfirm.value.prepared.id
      busy.value = true
      try {
        await api()?.rollback(id, { consentConfirmed: true })
        pendingConfirm.value = null
        pendingStep.value = null
        await Promise.all([inventory.refresh(), pluginUpdates.refresh()])
      } catch (err) {
        fail(err)
      } finally {
        busy.value = false
      }
      return
    }
    busy.value = true
    try {
      await commit(pendingConfirm.value.prepared.id, {
        publisherConfirmed: publisherConfirmed.value,
        riskConfirmed: true,
      })
    } catch (err) {
      fail(err)
    } finally {
      busy.value = false
    }
  }

  function cancel(): void {
    pendingConfirm.value = null
    pendingStep.value = null
    publisherConfirmed.value = false
    replaceConfirmed.value = false
    reattachBackendData.value = false
  }

  async function uninstall(id: string): Promise<void> {
    const plugins = api()
    if (!plugins) return
    const answer = await askUninstall(t, notify, id)
    if (!answer) return
    busy.value = true
    error.value = ''
    try {
      await removeWithAnswer(plugins, id, answer)
      await Promise.all([inventory.refresh(), pluginUpdates.refresh()])
    } catch (err) {
      fail(err)
    } finally {
      busy.value = false
    }
  }

  return {
    busy,
    error,
    pendingConfirm,
    pendingStep,
    install,
    installFromFile,
    loadFromFolder,
    prepareAgentFile,
    reloadDeveloperPlugin,
    uninstall,
    confirmReplace,
    confirmPublisher,
    confirmRisk,
    rollbackWithConsent,
    cancel,
  }
}

/** In-app confirmation before an installed plugin is removed. */
/** Removal always clears the browser data (site sign-ins, cookies, cache) of a
 *  Navide plugin that declares `web`; the confirmation says so. */
function withWebDataNote(
  t: (key: string, values?: Record<string, unknown>) => string,
  id: string,
  body: string,
): string {
  const declaresWeb = usePluginInventory().installed.value
    .find((plugin) => plugin.id === id)?.manifestPermissions?.system?.includes('web') === true
  return declaresWeb ? `${body} ${t('settings.extensions.marketplace.uninstallClearsWebData', { name: id })}` : body
}

export function confirmUninstall(
  t: (key: string, values?: Record<string, unknown>) => string,
  notify: ReturnType<typeof useNotify>,
  id: string
): Promise<boolean> {
  return notify.confirm(withWebDataNote(t, id, t('settings.extensions.marketplace.uninstallConfirmBody', { name: id })), {
    title: t('settings.extensions.marketplace.uninstallConfirmTitle'),
    confirmText: t('settings.extensions.marketplace.uninstall'),
    cancelText: t('settings.extensions.trust.cancel'),
    danger: true,
  })
}

export interface UninstallAnswer {
  /** Set only when the plugin's native backend left private data on this
   *  device and the dialog asked about it. */
  nativeBackendData?: 'keep' | 'delete'
}

/** The in-app remove confirmation. When the plugin's native backend left
 *  private data on this device, the dialog also discloses its size and
 *  location and offers to keep it; unticked (the default) deletes it. Resolves
 *  null when the user cancels. */
export async function askUninstall(
  t: (key: string, values?: Record<string, unknown>) => string,
  notify: ReturnType<typeof useNotify>,
  id: string
): Promise<UninstallAnswer | null> {
  let data: { exists: boolean; bytes: number; path: string } | null = null
  try {
    data = (await window.agentTeam?.plugins?.nativeBackendData?.(id)) ?? null
  } catch (err) {
    // Without the answer the dialog cannot disclose the data, so removal keeps
    // it, exactly as before the choice existed.
    console.warn('[plugins] native backend data lookup failed', err)
  }
  if (!data?.exists) return (await confirmUninstall(t, notify, id)) ? {} : null
  const confirmed = await notify.confirm(
    withWebDataNote(t, id, t('settings.extensions.marketplace.uninstallConfirmBodyWithData', { name: id, size: formatBytes(data.bytes) })),
    {
      title: t('settings.extensions.marketplace.uninstallConfirmTitle'),
      confirmText: t('settings.extensions.marketplace.uninstall'),
      cancelText: t('settings.extensions.trust.cancel'),
      danger: true,
      detail: data.path,
      checkboxLabel: t('settings.extensions.marketplace.uninstallKeepNativeData'),
    }
  )
  if (!confirmed) return null
  return { nativeBackendData: notify.dialogCheckbox.value ? 'keep' : 'delete' }
}

/** Remove with the dialog's answer; no data choice keeps the old call shape. */
export function removeWithAnswer(
  plugins: { remove: (id: string, nativeBackendData?: 'keep' | 'delete') => Promise<unknown> },
  id: string,
  answer: UninstallAnswer
): Promise<unknown> {
  return answer.nativeBackendData ? plugins.remove(id, answer.nativeBackendData) : plugins.remove(id)
}

// Electron prefixes a main-process throw with the channel it came through.
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/

/** The message to show for a failed plugin IPC call: the main process's own
 *  words, without Electron's wrapper. The full text still goes to the console. */
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const shown = raw.replace(IPC_ERROR_PREFIX, '')
  if (shown !== raw) console.error(raw)
  return shown
}
