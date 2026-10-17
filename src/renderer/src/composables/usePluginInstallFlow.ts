import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotify } from '@navide/plugin-ui/foundation'
import { usePluginInventory } from './usePluginInventory'
import { usePluginUpdates } from './usePluginUpdates'
import { formatBytes } from '../lib/formatBytes'
import { disclosureList } from '../lib/disclosureText'

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
}

export function usePluginInstallFlow() {
  const { t, te, locale } = useI18n()
  const notify = useNotify()
  const inventory = usePluginInventory()
  const pluginUpdates = usePluginUpdates()
  const busy = ref(false)
  const error = ref('')
  const pendingConfirm = ref<PendingInstall | null>(null)
  const pendingStep = ref<'publisher' | 'risk' | null>(null)
  const publisherConfirmed = ref(false)

  function api() {
    return window.agentTeam?.plugins
  }

  function fail(err: unknown): void {
    error.value = ipcErrorMessage(err)
  }

  async function commit(
    id: string,
    approval: { publisherConfirmed?: boolean; riskConfirmed?: boolean }
  ): Promise<void> {
    const plugins = api()
    if (!plugins) return
    await plugins.commitInstall(id, approval)
    pendingConfirm.value = null
    pendingStep.value = null
    await Promise.all([inventory.refresh(), pluginUpdates.refresh()])
  }

  // `version` pins the artifact (an update names the newest version this Host
  // can install); omitted, the main process installs the Registry's latest.
  async function install(namespace: string, name: string, version?: string): Promise<void> {
    const plugins = api()
    if (!plugins) return
    busy.value = true
    error.value = ''
    try {
      const prepared = await plugins.prepareInstall(
        version ? { namespace, name, version } : { namespace, name }
      )
      const requiresPublisherTrust = prepared.requiresPublisherTrust === true
      const requiresRiskConfirmation =
        prepared.requiresRiskConfirmation ?? prepared.requiresConfirmation
      if (requiresPublisherTrust || requiresRiskConfirmation) {
        // Hold for the trust dialog — nothing is written until the user confirms.
        pendingConfirm.value = { label: `${namespace}.${name}`, prepared }
        pendingStep.value = requiresPublisherTrust ? 'publisher' : 'risk'
        publisherConfirmed.value = false
        return
      }
      await commit(prepared.id, {})
      // Plan B D2: an update that did not ask is noted, saying what it added
      // (items that need no confirmation) or that it added nothing.
      const diff = prepared.disclosureDiff
      if (diff) {
        const values = { name: `${namespace}.${name}`, version: prepared.version }
        const added = diff.added.map((item) => {
          const key = `pluginDisclosure.diff.item.${item.kind}`
          return te(key) ? t(key, { key: item.key }) : `${item.kind}: ${item.key}`
        })
        notify.toast(
          diff.widened
            ? t('pluginDisclosure.diff.updatedAdded', { ...values, items: disclosureList(locale.value, added) })
            : t('pluginDisclosure.diff.updatedNoNew', values),
          { type: 'info' }
        )
      }
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

  async function confirmRisk(): Promise<void> {
    if (!pendingConfirm.value) return
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
    uninstall,
    confirmPublisher,
    confirmRisk,
    cancel,
  }
}

/** In-app confirmation before an installed plugin is removed. */
export function confirmUninstall(
  t: (key: string, values?: Record<string, unknown>) => string,
  notify: ReturnType<typeof useNotify>,
  id: string
): Promise<boolean> {
  return notify.confirm(t('settings.extensions.marketplace.uninstallConfirmBody', { name: id }), {
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
    t('settings.extensions.marketplace.uninstallConfirmBodyWithData', { name: id, size: formatBytes(data.bytes) }),
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
