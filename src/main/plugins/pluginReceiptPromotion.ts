// A Testplace build promoted to the Navide Marketplace keeps its bytes (DX
// report §9.5: same artifact, same digest, testers need not reinstall). Only
// its Registry receipt changes: the testplace envelope (channel, expiresAt) is
// replaced by the Registry's new stable or pre-release one.
//
// The installed version directory is immutable, so the receipt is never
// edited in place. The swap is its own install transaction: copy the version
// directory to staging, write the new receipt there, verify the staged copy
// with the installed-package verifier, then swap whole directories by rename.
// If the swap fails, the old directory is renamed back. The version, target
// and digest are unchanged, so the lifecycle selection, the capability grant
// and the plugin's stored data stay exactly as they were.
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import { PLUGIN_QUARANTINE_DIR, PLUGIN_STAGING_DIR } from './pluginInstallPaths'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  type InstalledTrustDecision,
  type RegistryInstallReceipt,
} from './pluginInstalledTrust'
import { sha256Hex } from './pluginVerify'

export interface ReceiptSwapDeps {
  copyDir(from: string, to: string): void
  writeFile(path: string, data: string): void
  rename(from: string, to: string): void
  rmrf(path: string): void
  mkdirp(path: string): void
  syncDirectory(path: string): void
}

export const defaultReceiptSwapDeps: ReceiptSwapDeps = {
  copyDir: (from, to) => cpSync(from, to, { recursive: true, errorOnExist: true, force: false }),
  writeFile: (path, data) => {
    writeFileSync(path, data, 'utf8')
    fsyncFileSync(path)
  },
  rename: renameSync,
  rmrf: (path) => rmSync(path, { recursive: true, force: true }),
  mkdirp: (path) => mkdirSync(path, { recursive: true }),
  syncDirectory: syncDirectorySync,
}

/**
 * Replace the receipt of the installed version in `packageDir` with `next`.
 * Refuses unless `next` names the same package, version, target, publisher and
 * artifact digest as the current receipt, and the retained artifact still
 * hashes to that digest. `verify` checks the staged copy before the swap.
 */
export function swapRegistryReceipt(
  pluginsRoot: string,
  packageDir: string,
  pluginId: string,
  next: RegistryInstallReceipt,
  verify: (stagedDir: string) => InstalledTrustDecision,
  deps: ReceiptSwapDeps = defaultReceiptSwapDeps,
): void {
  const current = JSON.parse(readFileSync(join(packageDir, REGISTRY_RECEIPT_NAME), 'utf8')) as RegistryInstallReceipt
  for (const field of ['packageId', 'version', 'target', 'publisherId', 'artifactDigest'] as const) {
    if (current[field] !== next[field]) {
      throw new Error(`the new Registry receipt does not match the installed ${pluginId}: ${field} differs`)
    }
  }
  if (next.packageId !== pluginId || next.envelope.artifactDigest !== next.artifactDigest) {
    throw new Error(`the new Registry receipt does not name ${pluginId}'s installed artifact`)
  }
  if (sha256Hex(new Uint8Array(readFileSync(join(packageDir, REGISTRY_ARTIFACT_NAME)))) !== next.artifactDigest) {
    throw new Error(`the installed artifact of ${pluginId} no longer matches its digest`)
  }

  const stagingRoot = join(pluginsRoot, PLUGIN_STAGING_DIR)
  const staged = join(stagingRoot, `${pluginId}.receipt.${randomUUID()}`)
  deps.mkdirp(stagingRoot)
  try {
    deps.copyDir(packageDir, staged)
    deps.writeFile(join(staged, REGISTRY_RECEIPT_NAME), JSON.stringify(next, null, 2))
    deps.syncDirectory(staged)
    const decision = verify(staged)
    if (decision.action !== 'allow' || decision.artifactDigest !== next.artifactDigest || decision.expired) {
      throw new Error(`the staged ${pluginId} did not verify with its new receipt${decision.action === 'quarantine' ? `: ${decision.reason}` : ''}`)
    }
  } catch (error) {
    deps.rmrf(staged)
    throw error
  }

  const quarantineRoot = join(pluginsRoot, PLUGIN_QUARANTINE_DIR)
  const previous = join(quarantineRoot, `${pluginId}.receipt-swap.${randomUUID()}`)
  try {
    deps.mkdirp(quarantineRoot)
    deps.rename(packageDir, previous)
  } catch (error) {
    deps.rmrf(staged)
    throw error
  }
  try {
    deps.rename(staged, packageDir)
    deps.syncDirectory(dirname(packageDir))
  } catch (error) {
    // Put the old directory back; the staged copy is only a copy.
    deps.rename(previous, packageDir)
    deps.rmrf(staged)
    throw error
  }
  deps.rmrf(previous)
}
