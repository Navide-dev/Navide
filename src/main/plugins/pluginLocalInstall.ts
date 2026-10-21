// Where a package installed from a file is trusted from (DX report A1, card
// K3). A Registry package carries a Host receipt and is verified against the
// Registry root; a local package carries none and is verified against the
// user's consent record (`pluginLocalTrust.ts`). This module decides which of
// the two applies to an installed package directory, so every load, restart
// and backend spawn makes the same choice.
//
// A directory holding Registry evidence always takes the Registry path,
// unchanged; a local decision is only ever made for a directory with no
// receipt and a consent record naming its exact id and version.

import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { REGISTRY_RECEIPT_NAME, type InstalledTrustDecision } from './pluginInstalledTrust'
import { readLocalTrustRecord, verifyLocalPackage, type PluginLocalTrustContext } from './pluginLocalTrust'
import { readLocalInstallTrust } from './pluginLocalInstallTrust'
import { recordDigestBlock, securityBlockReason } from './pluginDigestBlock'
import { parseManifestJson } from './pluginManifest'
import { pluginSourceFromLegacyProvenance, type LegacyPluginProvenance, type PluginSource } from '../../shared/pluginSource'
import { revealUnsafeLineText } from '../../shared/pluginAgentTools'
import { nativeBackendConsentText, type NativeBackendConsentPrompt } from './pluginThirdPartyBackends'
import type { SupportedLocale } from '../hostLocale'

/** Consent records live beside, never inside, the plugins root: every child
 * of the root is scanned as a package, and a file inside a package would
 * itself change the content the record covers. */
export const PLUGIN_LOCAL_TRUST_DIR = 'plugin-local-trust'

export type LocalRecordRole = 'active' | 'candidate' | 'previous'

export function localTrustRecordPath(pluginsRoot: string, pluginId: string, role: LocalRecordRole = 'active'): string {
  return join(dirname(pluginsRoot), PLUGIN_LOCAL_TRUST_DIR, role === 'active' ? `${pluginId}.json` : `${pluginId}.${role}.json`)
}

/** The consent record covering `pluginId`@`version`, active first. */
export function localTrustRecordFor(pluginsRoot: string, pluginId: string, version: string): string | null {
  for (const role of ['active', 'candidate', 'previous'] as const) {
    const path = localTrustRecordPath(pluginsRoot, pluginId, role)
    try {
      const record = readLocalTrustRecord(path)
      if (record.id === pluginId && record.version === version) return path
    } catch {
      // No record, or one verification will refuse anyway.
    }
  }
  return null
}

/** True when the installed package directory is a local install: no Registry
 * receipt, and a consent record for its manifest's id and version. */
export function isLocalInstalledPackage(pluginsRoot: string, packageDir: string, pluginId: string): boolean {
  return localRecordForDir(pluginsRoot, packageDir, pluginId) !== null
}

function localRecordForDir(pluginsRoot: string, packageDir: string, pluginId: string): string | null {
  if (existsSync(join(packageDir, REGISTRY_RECEIPT_NAME))) return null
  let version: unknown
  try {
    version = parseManifestJson(readFileSync(join(packageDir, 'manifest.json'), 'utf8')).version
  } catch {
    return null
  }
  return typeof version === 'string' ? localTrustRecordFor(pluginsRoot, pluginId, version) : null
}

/**
 * The local-install decision for an installed package directory, in the
 * shape the Registry verifier returns, or null when the directory is not a
 * local install (the caller then verifies it as a Registry package, as on
 * main). A taken-down local package is refused like a quarantined one, with
 * the takedown reason, and so is one whose `.vsix` digest Navide blocked for a
 * security reason since it was installed (decision d5, `pluginDigestBlock.ts`).
 */
export function verifyLocalInstalledPackage(
  pluginsRoot: string,
  packageDir: string,
  pluginId: string,
  trust: PluginLocalTrustContext,
): InstalledTrustDecision | null {
  const recordPath = localRecordForDir(pluginsRoot, packageDir, pluginId)
  if (recordPath === null) return null
  const decision = verifyLocalPackage(packageDir, pluginId, recordPath, trust)
  if (decision.action !== 'allow') return { action: 'quarantine', reason: `${decision.code}: ${decision.reason}` }
  const block = recordDigestBlock(readLocalTrustRecord(recordPath), readLocalInstallTrust(pluginsRoot, trust.pinnedRootKey))
  if (block?.action === 'disable') return { action: 'quarantine', reason: securityBlockReason(pluginId) }
  // Immutable layout: <root>/<id>/<version>/<target>/package.
  return { action: 'allow', artifactDigest: decision.contentDigest, target: basename(dirname(packageDir)) }
}

/** Make the candidate's consent record the active one, at the moment the
 * candidate becomes the active package. */
export function promoteLocalCandidateRecord(pluginsRoot: string, pluginId: string): void {
  const candidate = localTrustRecordPath(pluginsRoot, pluginId, 'candidate')
  if (existsSync(candidate)) renameSync(candidate, localTrustRecordPath(pluginsRoot, pluginId, 'active'))
}

/** L4: a file update over a file install keeps the replaced version as the
 * rollback target, so its consent record moves to the `previous` role before
 * the candidate's becomes the active one. Going back to it asks again. */
export function retainActiveLocalRecordAsPrevious(pluginsRoot: string, pluginId: string): void {
  const active = localTrustRecordPath(pluginsRoot, pluginId, 'active')
  if (existsSync(active)) renameSync(active, localTrustRecordPath(pluginsRoot, pluginId, 'previous'))
}

/** L4: a rollback to the kept file version: its record becomes the active one
 * again and the displaced version's record becomes the candidate's, matching
 * the selector (the displaced package is retained as the next candidate). */
export function swapLocalRecordsForRollback(pluginsRoot: string, pluginId: string): void {
  const previous = localTrustRecordPath(pluginsRoot, pluginId, 'previous')
  if (!existsSync(previous)) return
  const active = localTrustRecordPath(pluginsRoot, pluginId, 'active')
  if (existsSync(active)) renameSync(active, localTrustRecordPath(pluginsRoot, pluginId, 'candidate'))
  renameSync(previous, active)
}

/** Drop the consent records of one plugin (removal, or a Registry install
 * replacing a local one). */
export function forgetLocalTrustRecords(pluginsRoot: string, pluginId: string, roles: readonly LocalRecordRole[] = ['active', 'candidate', 'previous']): void {
  for (const role of roles) rmSync(localTrustRecordPath(pluginsRoot, pluginId, role), { force: true })
}

/** The source of an installed package for the main-process dialogs below: its
 * own `source` when a loader set one, else read from its legacy provenance. A
 * developer folder (K4) carries only `provenance: 'developer-local-unpacked'`,
 * so reading `source` alone left its dialogs without the unreviewed line. The
 * pre-release distinction is not needed here: only local sources get a line. */
export function installedPackageSource(
  pkg: { provenance?: LegacyPluginProvenance; source?: PluginSource } | undefined,
): PluginSource | undefined {
  if (!pkg) return undefined
  return pkg.source ?? pluginSourceFromLegacyProvenance(pkg.provenance, false)
}

/** The source line an agent approval names for a package installed from a
 * file or loaded from a developer folder, so an unreviewed package's tools
 * never read like a Marketplace one's. */
const AGENT_APPROVAL_SOURCE_NOTE: Partial<Record<PluginSource, string>> = {
  'local-unsigned': 'Source: a local file, not reviewed by Navide.',
  'developer-unpacked': 'Source: a local folder, not reviewed by Navide; its contents can change at any time.',
}

export function agentApprovalSourceNote(source: PluginSource | undefined): string {
  return (source && AGENT_APPROVAL_SOURCE_NOTE[source]) ?? ''
}

/** The source line the native backend consent puts first in its detail, in
 * the words of the K2 "Source and review" row. Its agent tools ride on that
 * consent, so an unreviewed package must say so there too (MED-2 on #425). */
const LOCAL_SOURCE_CONSENT_LINE: Record<string, string> = {
  'zh-TW': '來源與審核：本機檔案，未經 Navide 審核，未簽章',
  'en-US': 'Source and review: Local file, not reviewed by Navide, unsigned',
  'ja-JP': '提供元と審査：ローカルファイル。Navide の審査なし、署名なし',
}

const DEVELOPER_SOURCE_CONSENT_LINE: Record<string, string> = {
  'zh-TW': '來源與審核：本機資料夾，內容隨時可能變動，未經 Navide 審核',
  'en-US': 'Source and review: Local folder; its contents can change at any time, not reviewed by Navide',
  'ja-JP': '提供元と審査：ローカルフォルダー。内容はいつでも変わる可能性があります。Navide の審査なし',
}

export function localSourceConsentLine(source: PluginSource | undefined, locale: string): string {
  const lines = source === 'local-unsigned'
    ? LOCAL_SOURCE_CONSENT_LINE
    : source === 'developer-unpacked' ? DEVELOPER_SOURCE_CONSENT_LINE : undefined
  if (!lines) return ''
  return lines[locale] ?? lines['en-US']
}

/** The native backend consent dialog's text with the package's own name made
 * safe for a dialog line, and, for an unreviewed package, the source line
 * leading both the message and the detail (MED-2 / MED-3 on #425). */
export function nativeBackendConsentDialog(
  prompt: NativeBackendConsentPrompt,
  locale: SupportedLocale,
  source: PluginSource | undefined,
): ReturnType<typeof nativeBackendConsentText> {
  const text = nativeBackendConsentText({ ...prompt, name: revealUnsafeLineText(prompt.name) }, locale)
  const sourceLine = localSourceConsentLine(source, locale)
  if (!sourceLine) return text
  return { ...text, message: `${sourceLine}\n${text.message}`, detail: `${sourceLine}\n\n${text.detail}` }
}
