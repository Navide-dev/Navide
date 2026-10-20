// Decision d5 (W6): a Navide plugin installed from a `.vsix` file whose digest
// Navide blocks after the install. Every local install records the file's
// digest (`PluginLocalTrustRecord.artifactDigest`); each load and each trust
// refresh checks it against the root-signed `blockedDigests`, and the reason
// decides what happens:
//
// - `security`: disabled through the existing quarantine (the load-time
//   verifier refuses it), and the user is told why. It can be removed, never
//   enabled again: enabling re-verifies, which refuses it.
// - `admin`, `qualification-revoked`, and an entry with no reason (or one this
//   release does not know): one warning, where the user keeps using, disables
//   or removes it. The installed list keeps labelling it.
// - `developer-withdrawn`: the installed list labels it; nothing else.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostStrings, type HostStringTable, type SupportedLocale } from '../hostLocale'
import { revealUnsafeLineText } from '../../shared/pluginAgentTools'
import { digestBlock, type LocalBlockReason, type LocalInstallTrustMetadata } from './pluginLocalInstallTrust'
import type { PluginLocalTrustRecord } from './pluginLocalTrust'

export type DigestBlockAction = 'disable' | 'warn' | 'label'

export interface LocalDigestBlock {
  digest: string
  /** Null when the list names no reason, or one this release does not know. */
  reason: LocalBlockReason | null
  action: DigestBlockAction
}

export function digestBlockAction(reason: LocalBlockReason | null): DigestBlockAction {
  if (reason === 'security') return 'disable'
  if (reason === 'developer-withdrawn') return 'label'
  return 'warn'
}

/** The block on the `.vsix` a local trust record was installed from, or null.
 * A record written before d5 names the file only through A3 signer evidence;
 * one with neither cannot be checked. */
export function recordDigestBlock(
  record: PluginLocalTrustRecord,
  trust: LocalInstallTrustMetadata | null,
): LocalDigestBlock | null {
  const digest = record.artifactDigest ?? record.signer?.artifactDigest
  if (!digest) return null
  const block = digestBlock(trust, digest)
  return block ? { digest, reason: block.reason, action: digestBlockAction(block.reason) } : null
}

/** The quarantine reason a `security` block gives at load. */
export function securityBlockReason(pluginId: string): string {
  return `LOCAL_DIGEST_BLOCKED: the file ${pluginId} was installed from was taken down by Navide for a security reason`
}

export const DIGEST_BLOCK_NOTICES_NAME = '.navide-digest-block-notices.json'

/** Which blocks the user was already told about, so each warning is shown
 * once: keyed by plugin id and digest, holding the reason it was shown for (a
 * changed reason, say admin to security, is shown again). */
export class DigestBlockNoticeStore {
  private readonly path: string

  constructor(pluginsRoot: string) {
    this.path = join(pluginsRoot, DIGEST_BLOCK_NOTICES_NAME)
  }

  private read(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    } catch {
      return {}
    }
  }

  private static key(pluginId: string, digest: string): string {
    return `${pluginId}@${digest}`
  }

  shown(pluginId: string, block: LocalDigestBlock): boolean {
    return this.read()[DigestBlockNoticeStore.key(pluginId, block.digest)] === (block.reason ?? 'none')
  }

  record(pluginId: string, block: LocalDigestBlock): void {
    const notices = { ...this.read(), [DigestBlockNoticeStore.key(pluginId, block.digest)]: block.reason ?? 'none' }
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(notices, null, 2), { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}

export interface DigestBlockPrompt {
  pluginId: string
  version: string
  reason: LocalBlockReason | null
  action: 'disable' | 'warn'
}

export type DigestBlockChoice = 'keep' | 'disable' | 'remove'

interface DigestBlockStrings {
  title: string
  warned: (plugin: string) => string
  disabled: (plugin: string) => string
  reasons: Record<LocalBlockReason | 'none', (publisher: string) => string>
  warnedDetail: string
  disabledDetail: string
  warnButtons: [string, string, string]
  disabledButtons: [string, string]
}

const STRINGS: HostStringTable<DigestBlockStrings> = {
  'zh-TW': {
    title: 'Navide 外掛已被封鎖',
    warned: (plugin) => `你從檔案安裝的 Navide 外掛 ${plugin} 已列入 Navide 的封鎖清單。`,
    disabled: (plugin) => `Navide 已停用你從檔案安裝的 Navide 外掛 ${plugin}。`,
    reasons: {
      security: () => 'Navide 因安全問題下架了這一份檔案。',
      admin: () => 'Navide 已下架這一份檔案。',
      'qualification-revoked': (publisher) => `Navide 已撤銷發佈者 ${publisher} 的開發者資格。`,
      'developer-withdrawn': () => '這一份檔案已由開發者撤回。',
      none: () => 'Navide 已把這一份檔案列入封鎖清單，沒有註明原因。',
    },
    warnedDetail: '它目前仍在執行。你可以繼續使用、停用或移除；「設定 → 擴充」的清單會一直標示它已被封鎖。',
    disabledDetail: '它無法再啟用。按「移除」可以刪除它。',
    warnButtons: ['繼續使用', '停用', '移除'],
    disabledButtons: ['確定', '移除'],
  },
  'en-US': {
    title: 'Navide plugin blocked',
    warned: (plugin) => `The Navide plugin ${plugin}, which you installed from a file, is on Navide's blocked list.`,
    disabled: (plugin) => `Navide disabled the Navide plugin ${plugin}, which you installed from a file.`,
    reasons: {
      security: () => 'Navide took this file down for a security reason.',
      admin: () => 'Navide took this file down.',
      'qualification-revoked': (publisher) => `Navide revoked the developer qualification of its publisher ${publisher}.`,
      'developer-withdrawn': () => 'Its developer withdrew this file.',
      none: () => 'Navide put this file on its blocked list without giving a reason.',
    },
    warnedDetail: 'It still runs. You can keep using it, disable it or remove it; Settings → Extensions keeps showing that it is blocked.',
    disabledDetail: 'It cannot be enabled again. Choose Remove to delete it.',
    warnButtons: ['Keep using', 'Disable', 'Remove'],
    disabledButtons: ['OK', 'Remove'],
  },
  'ja-JP': {
    title: 'Navide プラグインがブロックされました',
    warned: (plugin) => `ファイルからインストールした Navide プラグイン ${plugin} が Navide のブロックリストに追加されました。`,
    disabled: (plugin) => `ファイルからインストールした Navide プラグイン ${plugin} を Navide が無効にしました。`,
    reasons: {
      security: () => 'Navide がセキュリティ上の理由でこのファイルを取り下げました。',
      admin: () => 'Navide がこのファイルを取り下げました。',
      'qualification-revoked': (publisher) => `Navide が発行者 ${publisher} の開発者資格を取り消しました。`,
      'developer-withdrawn': () => '開発者がこのファイルを取り下げました。',
      none: () => 'Navide は理由を示さずにこのファイルをブロックリストに追加しました。',
    },
    warnedDetail: 'まだ動作しています。使い続ける、無効にする、削除する、のいずれかを選べます。「設定 → 拡張機能」の一覧には、ブロックされていることが表示され続けます。',
    disabledDetail: '再び有効にすることはできません。「削除」を選ぶと削除できます。',
    warnButtons: ['使い続ける', '無効にする', '削除'],
    disabledButtons: ['OK', '削除'],
  },
}

/** The one-time dialog for a block, in the user's language; `choices[i]` is
 * what button `i` means. Button 0 changes nothing, so dismissing is safe. */
export function digestBlockDialogText(
  prompt: DigestBlockPrompt,
  locale: SupportedLocale,
): { title: string; message: string; detail: string; buttons: string[]; choices: DigestBlockChoice[] } {
  const strings = hostStrings(STRINGS, locale)
  const plugin = `${revealUnsafeLineText(prompt.pluginId)} ${revealUnsafeLineText(prompt.version)}`
  const reasonLine = strings.reasons[prompt.reason ?? 'none'](revealUnsafeLineText(prompt.pluginId.split('.')[0]))
  if (prompt.action === 'disable') {
    return {
      title: strings.title,
      message: strings.disabled(plugin),
      detail: `${reasonLine}\n\n${strings.disabledDetail}`,
      buttons: [...strings.disabledButtons],
      choices: ['keep', 'remove'],
    }
  }
  return {
    title: strings.title,
    message: strings.warned(plugin),
    detail: `${reasonLine}\n\n${strings.warnedDetail}`,
    buttons: [...strings.warnButtons],
    choices: ['keep', 'disable', 'remove'],
  }
}
