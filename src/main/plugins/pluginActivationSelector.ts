import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import { isPluginTargetCompatible } from './pluginTarget'
import { isValidManifestV2PluginId } from './pluginManifestV2'
import { parseHostTrustJsonObject } from './pluginTrustJson'
import { PLUGIN_ACTIVATION_DIR } from './pluginInstallPaths'
import type { HostCapabilityGrant } from './pluginCapabilityBroker'

export interface PluginPackageSelection {
  packageVersion: string
  target: string
  artifactDigest: string
  /** Packages installed before immutable staging remain at <root>/<id>. */
  layout?: 'legacy-mutable'
}

/** Host proof supplied with the exact selection it authorizes. The persisted
 * selector stores the selection as the role and the grant as its sibling. */
export interface PluginSelectionGrant {
  selection: PluginPackageSelection
  grant: HostCapabilityGrant
}

/** Durable activation progress. It distinguishes an intentional staged
 * candidate from a restart that was interrupted after the old runtime drained. */
export interface PluginActivationProgress {
  /** `factory-rollback` is only ever `prepared`: its one durable cutover
   * writes the finished record, so an interrupted one keeps its active package. */
  kind: 'candidate' | 'rollback' | 'factory-rollback'
  phase: 'prepared' | 'promoted'
}

export interface PluginActivationSelectorRecord {
  schemaVersion: 1
  pluginId: string
  active?: PluginPackageSelection
  candidate?: PluginPackageSelection
  /** Legacy Host confirmation for staged records written before candidate grants. */
  candidateFullShellConfirmed?: true
  /** Host grant structurally bound to the candidate selection. */
  candidateGrant?: HostCapabilityGrant
  previous?: PluginPackageSelection
  /** Durable grant for the retained previous package; rollback must never
   * reconstruct package-version consent from a manifest alone. */
  previousGrant?: HostCapabilityGrant
  /** Grant bound to the active package while candidate cutover is in progress. */
  activeGrant?: HostCapabilityGrant
  activation?: PluginActivationProgress
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function selectorPath(root: string, pluginId: string): string {
  return join(root, PLUGIN_ACTIVATION_DIR, `${pluginId}.json`)
}

/** Canonical immutable package location. Candidate/active/previous are roles
 * selected in the lifecycle record, never directory names that move package
 * bytes between states. */
export function immutablePluginPackageDir(
  root: string,
  pluginId: string,
  packageVersion: string,
  target: string,
): string {
  if (!isValidManifestV2PluginId(pluginId) || !validVersion(packageVersion) || !isPluginTargetCompatible(target)) {
    throw new Error('invalid immutable plugin package identity')
  }
  return join(root, pluginId, packageVersion, target, 'package')
}

function validatePackage(value: unknown): PluginPackageSelection | undefined {
  if (value === undefined) return undefined
  if (
    !isObject(value) ||
    (Object.keys(value).length !== 3 && Object.keys(value).length !== 4) ||
    (value.layout !== undefined && value.layout !== 'legacy-mutable') ||
    (Object.keys(value).length === 4 && value.layout !== 'legacy-mutable') ||
    !validVersion(value.packageVersion) ||
    !isPluginTargetCompatible(value.target) ||
    !validDigest(value.artifactDigest)
  ) throw new Error('invalid plugin lifecycle package selector')
  return {
    packageVersion: value.packageVersion,
    target: value.target,
    artifactDigest: value.artifactDigest,
    ...(value.layout === 'legacy-mutable' ? { layout: value.layout } : {}),
  }
}

function validateActivation(value: unknown): PluginActivationProgress | undefined {
  if (value === undefined) return undefined
  if (
    !isObject(value) ||
    (value.kind !== 'candidate' && value.kind !== 'rollback' && value.kind !== 'factory-rollback') ||
    (value.phase !== 'prepared' && value.phase !== 'promoted')
  ) throw new Error('invalid plugin lifecycle activation progress')
  return { kind: value.kind, phase: value.phase }
}

function sameSelection(left: PluginPackageSelection, right: PluginPackageSelection): boolean {
  return left.packageVersion === right.packageVersion &&
    left.target === right.target &&
    left.artifactDigest === right.artifactDigest &&
    left.layout === right.layout
}

function validateGrant(value: unknown, selection: PluginPackageSelection | undefined): HostCapabilityGrant | undefined {
  if (value === undefined) return undefined
  if (!selection || !isObject(value)) throw new Error('invalid plugin lifecycle previous grant')
  const keys = Object.keys(value)
  if (
    keys.some((key) => !['packageVersion', 'system', 'shell', 'highRiskShellConfirmed', 'storage'].includes(key)) ||
    value.packageVersion !== selection.packageVersion ||
    !Array.isArray(value.system) ||
    value.system.some((item) => item !== 'fs' && item !== 'ui' && item !== 'aiCli' && item !== 'web' &&
      item !== 'agents' && item !== 'agentMessages') ||
    new Set(value.system).size !== value.system.length ||
    (value.shell !== undefined && value.shell !== 'allowlist' && value.shell !== 'full') ||
    (value.highRiskShellConfirmed !== undefined && value.highRiskShellConfirmed !== true) ||
    value.storage !== true
  ) throw new Error('invalid plugin lifecycle previous grant')
  return {
    packageVersion: value.packageVersion,
    system: [...value.system] as HostCapabilityGrant['system'],
    ...(value.shell ? { shell: value.shell } : {}),
    ...(value.highRiskShellConfirmed ? { highRiskShellConfirmed: true } : {}),
    storage: true,
  }
}

function validateRecord(expectedPluginId: string, value: unknown): PluginActivationSelectorRecord {
  if (!isObject(value) || value.schemaVersion !== 1 || value.pluginId !== expectedPluginId) {
    throw new Error('invalid plugin lifecycle selector')
  }
  const keys = Object.keys(value)
  if (
    !keys.includes('schemaVersion') ||
    !keys.includes('pluginId') ||
    keys.some((key) => ![
      'schemaVersion',
      'pluginId',
      'active',
      'candidate',
      'candidateFullShellConfirmed',
      'candidateGrant',
      'previous',
      'previousGrant',
      'activeGrant',
      'activation',
    ].includes(key)) ||
    (value.candidateFullShellConfirmed !== undefined && value.candidateFullShellConfirmed !== true) ||
    (value.candidateFullShellConfirmed === true && value.candidate === undefined)
  ) {
    throw new Error('invalid plugin lifecycle selector')
  }
  const active = validatePackage(value.active)
  const candidate = validatePackage(value.candidate)
  const previous = validatePackage(value.previous)
  const candidateGrant = validateGrant(value.candidateGrant, candidate)
  const previousGrant = validateGrant(value.previousGrant, previous)
  const activeGrant = validateGrant(value.activeGrant, active)
  const activation = validateActivation(value.activation)
  if (
    (previous !== undefined && active === undefined) ||
    (activation?.kind === 'candidate' && activation.phase === 'prepared' && candidate === undefined) ||
    (activation?.kind === 'candidate' && activation.phase === 'prepared' && active === undefined &&
      (previous !== undefined || activeGrant !== undefined)) ||
    (activation?.kind === 'candidate' && activation.phase === 'promoted' &&
      (active === undefined || candidate === undefined || !sameSelection(active, candidate))) ||
    (activation?.kind === 'rollback' && activation.phase === 'prepared' &&
      (active === undefined || previous === undefined || candidate !== undefined)) ||
    (activation?.kind === 'rollback' && activation.phase === 'promoted' &&
      (active === undefined || candidate === undefined || previous !== undefined || sameSelection(active, candidate))) ||
    (activation?.kind === 'factory-rollback' &&
      (activation.phase !== 'prepared' || active === undefined || candidate !== undefined || previous !== undefined))
  ) throw new Error('invalid plugin lifecycle selector')
  return {
    schemaVersion: 1,
    pluginId: expectedPluginId,
    ...(active ? { active } : {}),
    ...(candidate ? { candidate } : {}),
    ...(value.candidateFullShellConfirmed === true ? { candidateFullShellConfirmed: true } : {}),
    ...(candidateGrant ? { candidateGrant } : {}),
    ...(previous ? { previous } : {}),
    ...(previousGrant ? { previousGrant } : {}),
    ...(activeGrant ? { activeGrant } : {}),
    ...(activation ? { activation } : {}),
  }
}

function writeAtomic(path: string, record: PluginActivationSelectorRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    fsyncFileSync(temporary)
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    syncDirectorySync(dirname(path))
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** The one durable lifecycle source of truth. Its projection selects the
 * package, router, and storage tiers together; no parallel selector exists. */
export class PluginActivationSelector {
  constructor(private readonly root: string) {}

  read(pluginId: string): PluginActivationSelectorRecord | null {
    if (!isValidManifestV2PluginId(pluginId)) throw new Error('invalid plugin id')
    const path = selectorPath(this.root, pluginId)
    if (!existsSync(path)) return null
    return validateRecord(pluginId, parseHostTrustJsonObject(readFileSync(path, 'utf8'), 'plugin lifecycle selector'))
  }

  /** Read valid Host-owned records for renderer inventory projection only.
   * Callers still independently verify package trust before activation. */
  list(): PluginActivationSelectorRecord[] {
    const directory = join(this.root, PLUGIN_ACTIVATION_DIR)
    let names: string[]
    try {
      // Sorted: readdir order differs between filesystems and runtimes.
      names = readdirSync(directory).sort()
    } catch {
      return []
    }
    const records: PluginActivationSelectorRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const pluginId = name.slice(0, -'.json'.length)
      if (!isValidManifestV2PluginId(pluginId)) continue
      try {
        const record = this.read(pluginId)
        if (record) records.push(record)
      } catch {
        // A corrupt selector is never a candidate for presentation or activation.
      }
    }
    return records
  }

  packageDir(pluginId: string, selection: PluginPackageSelection): string {
    if (selection.layout === 'legacy-mutable') {
      if (!isValidManifestV2PluginId(pluginId)) throw new Error('invalid plugin id')
      return join(this.root, pluginId)
    }
    return immutablePluginPackageDir(this.root, pluginId, selection.packageVersion, selection.target)
  }

  /** Anchor an already verified pre-staging install without relocating its live files. */
  adoptLegacyActive(
    pluginId: string,
    selection: PluginPackageSelection,
    grant: HostCapabilityGrant,
  ): PluginActivationSelectorRecord {
    if (!isValidManifestV2PluginId(pluginId) || selection.layout !== 'legacy-mutable') {
      throw new Error('invalid legacy package selection')
    }
    const current = this.read(pluginId)
    if (!current?.candidate || current.active || current.activation) {
      throw new Error('legacy package cannot be adopted during another lifecycle transition')
    }
    const active = validatePackage(selection)!
    const next: PluginActivationSelectorRecord = {
      ...current,
      active,
      activeGrant: validateGrant(grant, active),
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  stageCandidate(
    pluginId: string,
    candidate: PluginPackageSelection,
    options: { fullShellConfirmed?: boolean; candidateGrant?: PluginSelectionGrant } = {},
  ): PluginActivationSelectorRecord {
    if (!isValidManifestV2PluginId(pluginId)) throw new Error('invalid plugin id')
    const candidateSelection = validatePackage(candidate)
    if (!candidateSelection || candidateSelection.layout) throw new Error('candidate package is required')
    const current = this.read(pluginId)
    if (current?.candidate && JSON.stringify(current.candidate) !== JSON.stringify(candidateSelection)) {
      throw new Error(`plugin ${pluginId} already has a staged candidate`)
    }
    if (options.candidateGrant && !sameSelection(options.candidateGrant.selection, candidateSelection)) {
      throw new Error('candidate grant does not match the staged package identity')
    }
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      ...(current?.active ? { active: current.active } : {}),
      ...(current?.activeGrant ? { activeGrant: current.activeGrant } : {}),
      candidate: candidateSelection,
      ...(options.fullShellConfirmed ? { candidateFullShellConfirmed: true as const } : {}),
      ...(options.candidateGrant
        ? { candidateGrant: validateGrant(options.candidateGrant.grant, candidateSelection) }
        : {}),
      ...(current?.previous ? { previous: current.previous } : {}),
      ...(current?.previousGrant ? { previousGrant: current.previousGrant } : {}),
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Persist the only restart-in-progress marker before draining the selected
   * runtime. A cold start can therefore distinguish a staged candidate from an
   * interrupted cutover without guessing from package directories. */
  beginActivation(
    pluginId: string,
    options: { previousGrant?: HostCapabilityGrant } = {},
  ): PluginActivationSelectorRecord {
    const current = this.read(pluginId)
    if (!current?.candidate) throw new Error(`plugin ${pluginId} has no staged candidate`)
    if (current.activation) throw new Error(`plugin ${pluginId} activation is already in progress`)
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      ...(current.active ? { active: current.active } : {}),
      candidate: current.candidate,
      ...(current.candidateFullShellConfirmed ? { candidateFullShellConfirmed: true } : {}),
      ...(current.candidateGrant ? { candidateGrant: current.candidateGrant } : {}),
      ...(current.previous ? { previous: current.previous } : {}),
      ...(current.previousGrant ? { previousGrant: current.previousGrant } : {}),
      ...(options.previousGrant
        ? { activeGrant: validateGrant(options.previousGrant, current.active) }
        : current.activeGrant ? { activeGrant: current.activeGrant } : {}),
      activation: { kind: 'candidate', phase: 'prepared' },
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Atomically promote the staged package identity. The preceding active
   * identity becomes previous; package files and snapshots are retained. */
  activateCandidate(pluginId: string): PluginActivationSelectorRecord {
    const current = this.read(pluginId)
    if (!current?.candidate) throw new Error(`plugin ${pluginId} has no staged candidate`)
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      active: current.candidate,
      ...(current.candidateGrant ? { activeGrant: current.candidateGrant } : {}),
      ...(current.activation ? { candidate: current.candidate } : {}),
      ...(current.candidateFullShellConfirmed && current.activation
        ? { candidateFullShellConfirmed: true }
        : {}),
      ...(current.active ? { previous: current.active } : current.previous ? { previous: current.previous } : {}),
      ...(current.active && current.activeGrant ? { previousGrant: current.activeGrant } : {}),
      ...(current.activation ? { activation: { kind: 'candidate', phase: 'promoted' } as const } : {}),
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Mark a fully restored promotion complete. Candidate bytes remain immutable
   * throughout the transaction, then become retained active/previous state. */
  completeActivation(
    pluginId: string,
    options: { activeGrant?: HostCapabilityGrant } = {},
  ): PluginActivationSelectorRecord {
    const current = this.read(pluginId)
    if (!current?.activation) {
      if (!current) throw new Error(`plugin ${pluginId} has no lifecycle record`)
      return current
    }
    if (current.activation.kind !== 'candidate' || current.activation.phase !== 'promoted' || !current.active) {
      throw new Error(`plugin ${pluginId} activation has not been promoted`)
    }
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      active: current.active,
      ...(options.activeGrant
        ? { activeGrant: (() => {
            const grant = validateGrant(options.activeGrant, current.active)
            if (current.activeGrant && JSON.stringify(current.activeGrant) !== JSON.stringify(grant)) {
              throw new Error('active grant does not match the promoted package grant')
            }
            return grant
          })() }
        : current.activeGrant ? { activeGrant: current.activeGrant } : {}),
      ...(current.previous ? { previous: current.previous } : {}),
      ...(current.previousGrant ? { previousGrant: current.previousGrant } : {}),
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Recover only a durable interrupted activation. A pre-promotion crash
   * keeps the selected active package; a post-promotion crash returns to its
   * exact previous selection. Candidate bytes are retained in both cases. */
  recoverInterruptedActivation(pluginId: string): PluginActivationSelectorRecord | null {
    const current = this.read(pluginId)
    if (!current?.activation) return null
    const next: PluginActivationSelectorRecord = current.activation.phase === 'prepared'
      ? {
          schemaVersion: 1,
          pluginId,
          ...(current.active ? { active: current.active } : {}),
          ...(current.candidate ? { candidate: current.candidate } : {}),
          ...(current.candidateFullShellConfirmed ? { candidateFullShellConfirmed: true } : {}),
          ...(current.candidateGrant ? { candidateGrant: current.candidateGrant } : {}),
          ...(current.previous ? { previous: current.previous } : {}),
          ...(current.previousGrant ? { previousGrant: current.previousGrant } : {}),
          ...(current.activeGrant ? { activeGrant: current.activeGrant } : {}),
        }
      : current.activation.kind === 'rollback'
        ? {
            schemaVersion: 1,
            pluginId,
            active: current.active!,
            ...(current.activeGrant ? { activeGrant: current.activeGrant } : {}),
            candidate: current.candidate!,
            ...(current.candidateGrant ? { candidateGrant: current.candidateGrant } : {}),
          }
        : {
          schemaVersion: 1,
          pluginId,
          ...(current.previous ? { active: current.previous } : {}),
          ...(current.previousGrant ? { activeGrant: current.previousGrant } : {}),
          candidate: current.candidate!,
          ...(current.activeGrant ? { candidateGrant: current.activeGrant } : {}),
          ...(current.candidateFullShellConfirmed ? { candidateFullShellConfirmed: true } : {}),
        }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Abort a promoted, not-yet-completed candidate in the live process. The
   * caller must first drain the candidate runtime and re-verify `previous`
   * against current trust before selecting this record. */
  rollbackPromotedActivation(pluginId: string): PluginActivationSelectorRecord {
    const current = this.read(pluginId)
    if (!current?.activation || current.activation.phase !== 'promoted') {
      throw new Error(`plugin ${pluginId} has no promoted activation to roll back`)
    }
    const recovered = this.recoverInterruptedActivation(pluginId)
    if (!recovered) throw new Error(`plugin ${pluginId} has no activation to recover`)
    return recovered
  }

  /** Persist an explicit rollback before the current runtime is drained. A
   * staged update must be resolved first so retained candidate bytes cannot be
   * overwritten by this transition. */
  beginRollback(pluginId: string): PluginActivationSelectorRecord {
    const current = this.read(pluginId)
    if (!current?.active || !current.previous) {
      throw new Error(`plugin ${pluginId} has no previous package to roll back to`)
    }
    if (current.candidate || current.activation) {
      throw new Error(`plugin ${pluginId} cannot roll back while another lifecycle transition is pending`)
    }
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      active: current.active,
      ...(current.activeGrant ? { activeGrant: current.activeGrant } : {}),
      previous: current.previous,
      ...(current.previousGrant ? { previousGrant: current.previousGrant } : {}),
      activation: { kind: 'rollback', phase: 'prepared' },
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Atomically select the retained previous package. The displaced package is
   * retained as a candidate, never deleted or overwritten by rollback. */
  activatePrevious(pluginId: string): PluginActivationSelectorRecord {
    const current = this.read(pluginId)
    if (
      !current?.active ||
      !current.previous ||
      current.activation?.kind !== 'rollback' ||
      current.activation.phase !== 'prepared'
    ) {
      throw new Error(`plugin ${pluginId} has no prepared rollback`)
    }
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      active: current.previous,
      ...(current.previousGrant ? { activeGrant: current.previousGrant } : {}),
      candidate: current.active,
      ...(current.activeGrant ? { candidateGrant: current.activeGrant } : {}),
      activation: { kind: 'rollback', phase: 'promoted' },
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Finish a restored rollback while retaining the displaced package as the
   * next explicit candidate. */
  completeRollback(pluginId: string): PluginActivationSelectorRecord {
    const current = this.read(pluginId)
    if (current?.activation?.kind !== 'rollback' || current.activation.phase !== 'promoted') {
      throw new Error(`plugin ${pluginId} has no promoted rollback to complete`)
    }
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      active: current.active!,
      ...(current.activeGrant ? { activeGrant: current.activeGrant } : {}),
      candidate: current.candidate!,
      ...(current.candidateGrant ? { candidateGrant: current.candidateGrant } : {}),
      ...(current.candidateFullShellConfirmed ? { candidateFullShellConfirmed: true } : {}),
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Persist a factory rollback before the active runtime is drained. The
   * active package stays selected until the factory package has loaded, so a
   * crash before {@link demoteActiveToCandidate} recovers to it. */
  beginFactoryRollback(pluginId: string): PluginActivationSelectorRecord {
    const current = this.read(pluginId)
    if (!current?.active || current.active.layout) {
      throw new Error(`plugin ${pluginId} has no active package to return to its factory package`)
    }
    if (current.candidate || current.activation) {
      throw new Error(`plugin ${pluginId} cannot roll back while another lifecycle transition is pending`)
    }
    if (current.previous) {
      throw new Error(`plugin ${pluginId} retains a previous package to roll back to`)
    }
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      active: current.active,
      ...(current.activeGrant ? { activeGrant: current.activeGrant } : {}),
      activation: { kind: 'factory-rollback', phase: 'prepared' },
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Hand the plugin id back to its App-bundled factory package once it has
   * loaded. A factory package has no selection of its own, so the displaced
   * active package is retained as the next explicit candidate, exactly as when
   * it was first staged over the factory package; no package bytes are removed. */
  demoteActiveToCandidate(pluginId: string): PluginActivationSelectorRecord {
    const current = this.read(pluginId)
    if (current?.activation?.kind !== 'factory-rollback' || !current.active) {
      throw new Error(`plugin ${pluginId} has no prepared factory rollback`)
    }
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      candidate: current.active,
      ...(current.activeGrant ? { candidateGrant: current.activeGrant } : {}),
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Drop a staged candidate that is not mid-activation. The selected package
   * is untouched; unreferenced candidate bytes are quarantined by the next
   * stage of the same identity. */
  discardCandidate(pluginId: string): PluginActivationSelectorRecord | null {
    const current = this.read(pluginId)
    if (!current?.candidate) throw new Error(`plugin ${pluginId} has no staged candidate`)
    if (current.activation) throw new Error(`plugin ${pluginId} activation is in progress`)
    if (!current.active) {
      this.clear(pluginId)
      return null
    }
    const next: PluginActivationSelectorRecord = {
      schemaVersion: 1,
      pluginId,
      active: current.active,
      ...(current.activeGrant ? { activeGrant: current.activeGrant } : {}),
      ...(current.previous ? { previous: current.previous } : {}),
      ...(current.previousGrant ? { previousGrant: current.previousGrant } : {}),
    }
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Stop retaining the previous package and its grant. A package that
   * changed between a Marketplace and a local source must not offer a
   * rollback that restores the other source's consent (card K3, D7). */
  forgetPrevious(pluginId: string): PluginActivationSelectorRecord | null {
    const current = this.read(pluginId)
    if (!current) return null
    if (current.activation) throw new Error(`plugin ${pluginId} activation is in progress`)
    if (!current.previous && !current.previousGrant) return current
    const next: PluginActivationSelectorRecord = { ...current }
    delete next.previous
    delete next.previousGrant
    writeAtomic(selectorPath(this.root, pluginId), next)
    return next
  }

  /** Explicit user removal and a legacy v1 install replace the whole package
   *  tree, so those are the lifecycle paths that clear the selection record. */
  clear(pluginId: string): void {
    if (!isValidManifestV2PluginId(pluginId)) throw new Error('invalid plugin id')
    try {
      unlinkSync(selectorPath(this.root, pluginId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
