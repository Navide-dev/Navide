// Carrying out an agent's Navide plugin request once the user approved it in
// this window (plan B, B2-c; contract section 6). The approval card (D-c)
// calls applyApprovedRequest after `plugins.agent_request.decide` answered
// `applying`; the window's own install, rollback and remove flows do the work,
// trust dialog included, and the result is reported with
// `plugins.agent_request.finish`. recoverApplyingRequests settles requests a
// restart left `applying`.

export type PluginRequestKind =
  | 'plugin-install' | 'plugin-update' | 'plugin-rollback' | 'plugin-remove' | 'plugin-enable'
  /** W1 (S2): a local file or folder the Host staged for an agent. */
  | 'plugin-install-file'

/** The kinds applyApprovedRequest carries out. A card must not approve any
 *  other kind: approving moves it to `applying`, and nothing here would apply it. */
const APPLIABLE_KINDS: ReadonlySet<string> = new Set<PluginRequestKind>([
  'plugin-install', 'plugin-update', 'plugin-rollback', 'plugin-remove', 'plugin-enable', 'plugin-install-file',
])

export function isAppliableKind(kind: string): kind is PluginRequestKind {
  return APPLIABLE_KINDS.has(kind)
}

export interface PluginRequestRecord {
  approval_id: string
  kind: PluginRequestKind
  status: string
  target: {
    id: string
    namespace: string
    name: string
    version: string | null
    fromVersion: string | null
    /** plugin-install-file: the Host's staged copy and the digest the card shows. */
    stagingId?: string
    digest?: string | null
  }
}

export interface InstalledPackage {
  id: string
  packageVersion?: string
  /** The retained previous version a rollback restores (Extensions' rollback). */
  rollbackToVersion?: string
  /** The Extensions Disabled switch (Marketplace packages). */
  disabled?: boolean
}

export type FinishStatus = { status: 'completed'; error: null } | { status: 'failed'; error: string }

export interface PluginRequestApplyDeps {
  /** prepareInstall → trust dialog → commitInstall; resolves once the flow has
   *  settled (committed, cancelled or failed). */
  install(namespace: string, name: string, version: string): Promise<void>
  /** W1 (S2): the staged copy → the local consent dialog → its commit;
   *  resolves once that flow has settled. */
  installStaged(stagingId: string, digest: string | null): Promise<void>
  /** Extensions' rollback: restores the retained previous version. */
  rollback(pluginId: string): Promise<void>
  /** The Extensions remove flow (it asks whether to keep native backend data). */
  remove(pluginId: string): Promise<void>
  /** The Extensions Enable switch (the user's own action: plugins.setDisabled(id, false)). */
  enable(pluginId: string): Promise<void>
  listInstalled(): Promise<InstalledPackage[]>
  /** `plugins.agent_request.finish` with a window confirmation (subject: approval_id). */
  finish(approvalId: string, result: FinishStatus): Promise<void>
}

/** Whether the installed packages show the request carried out. */
export function requestApplied(record: PluginRequestRecord, installed: readonly InstalledPackage[]): boolean {
  const current = installed.find((pkg) => pkg.id === record.target.id)
  if (record.kind === 'plugin-remove') return current === undefined
  if (record.kind === 'plugin-enable') return current !== undefined && current.disabled === false
  return current !== undefined && current.packageVersion === record.target.version
}

/** A request a restart left `applying`: done if the installed packages show it, else interrupted. */
export function recoveryResult(record: PluginRequestRecord, installed: readonly InstalledPackage[]): FinishStatus {
  return requestApplied(record, installed)
    ? { status: 'completed', error: null }
    : { status: 'failed', error: 'interrupted' }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A rollback restores the retained previous version only; it runs only when
 *  that is the version the user approved, else the reason it cannot. */
async function rollbackToApproved(
  pluginId: string,
  version: string | null,
  deps: Pick<PluginRequestApplyDeps, 'rollback' | 'listInstalled'>,
): Promise<string | null> {
  const retained = (await deps.listInstalled()).find((pkg) => pkg.id === pluginId)?.rollbackToVersion
  if (version === null || retained !== version) {
    return `the version kept for rollback is ${retained ?? 'none'}, not the approved ${version ?? 'none'}`
  }
  try {
    await deps.rollback(pluginId)
  } catch (error) {
    // L4 (review r2): the Host's refusal names a consent the agent cannot
    // give; the agent is told that plainly, never the Host's text.
    if (errorText(error).includes('ROLLBACK_CONSENT_REQUIRED')) return ROLLBACK_CONSENT_REQUIRED_TEXT
    throw error
  }
  return null
}

/** What an agent's rollback request finishes with when going back to a kept
 *  file version still waits for the user's renewed consent. */
export const ROLLBACK_CONSENT_REQUIRED_TEXT =
  'consent-required: going back to a kept file version needs the user\'s renewed consent, with that version\'s disclosure, in the Navide main window'

/** Carry out one approved request in this window and report the result. */
export async function applyApprovedRequest(record: PluginRequestRecord, deps: PluginRequestApplyDeps): Promise<FinishStatus> {
  const { id, namespace, name, version } = record.target
  let failure: string | null = null
  try {
    if (record.kind === 'plugin-remove') await deps.remove(id)
    else if (record.kind === 'plugin-enable') await deps.enable(id)
    else if (record.kind === 'plugin-rollback') failure = await rollbackToApproved(id, version, deps)
    else if (record.kind === 'plugin-install-file') {
      if (record.target.stagingId) await deps.installStaged(record.target.stagingId, record.target.digest ?? null)
      else failure = 'the request names no staged package'
    }
    else if (version !== null) await deps.install(namespace, name, version)
    else failure = 'the request names no version'
  } catch (error) {
    failure = errorText(error)
  }
  let result: FinishStatus
  if (failure !== null) {
    result = { status: 'failed', error: failure }
  } else {
    const installed = await deps.listInstalled()
    result = requestApplied(record, installed)
      ? { status: 'completed', error: null }
      : { status: 'failed', error: 'not-applied' }
  }
  await deps.finish(record.approval_id, result)
  return result
}

/** Settle every request the backend still holds as `applying` (window start),
 *  except those a still-connected main window is carrying out (`inLiveWindow`). */
export async function recoverApplyingRequests(
  requests: readonly PluginRequestRecord[],
  deps: Pick<PluginRequestApplyDeps, 'listInstalled' | 'finish'>,
  inLiveWindow: ReadonlySet<string> = new Set(),
): Promise<Array<{ approvalId: string } & FinishStatus>> {
  const applying = requests.filter((record) => record.status === 'applying' && !inLiveWindow.has(record.approval_id))
  if (applying.length === 0) return []
  const installed = await deps.listInstalled()
  const settled: Array<{ approvalId: string } & FinishStatus> = []
  for (const record of applying) {
    const result = recoveryResult(record, installed)
    await deps.finish(record.approval_id, result)
    settled.push({ approvalId: record.approval_id, ...result })
  }
  return settled
}
