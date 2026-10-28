// Status chips for one row of Settings → CLI Agents.
//
// The page already held every one of these facts, but each in its own section:
// knowing how `claude` is currently set up meant scrolling past the permission
// overrides, the push channels and the CLI management panel. This turns the
// row itself into the summary, so the sections below are where you go to
// change something, not to find out what it is.
//
// Pure on purpose: the caller supplies the already-resolved facts and a
// translator, so the mapping can be tested without mounting the settings modal.

import type { CliModelDefault, CliPermissionMode } from '@navide/plugin-shell'

/** Green = installed / allowed, amber = a deviation worth noticing, red =
 *  unusable or switched off, blue = a chosen value or a channel that is on,
 *  grey = a neutral fact. */
export type CliRowChipTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral'

export interface CliRowChip {
  id: string
  tone: CliRowChipTone
  label: string
}

export interface CliAgentRowFacts {
  /** Onboarding's probe for this CLI. null = not probed yet, which is not the
   *  same as "missing" and must not be painted red. */
  install: { status: 'ok' | 'missing' | 'outdated' | 'unknown'; version: string } | null
  /** False for the vendors with no permission flag to skip (grok / opencode /
   *  pi), where an override row would be a no-op. */
  hasPermissionFlag: boolean
  permissionMode: CliPermissionMode
  /** The push channel kind this vendor declares, '' = it has none. */
  pushKind: string
  pushEnabled: boolean
  /** Vendor declares launch-time model arguments. False = asking it for a
   *  model is refused rather than silently ignored, so the row says so. */
  supportsModel: boolean
  /** The vendor's stored launch pick. Empty strings mean "vendor default",
   *  which is not a fact worth a chip — only a chosen value is shown. */
  modelDefault: CliModelDefault
  /** null = this CLI keeps no credential file Navide can read. */
  signedIn: boolean | null
  accountCount: number
  /** The backend launches a user-chosen install (`binary_override`). */
  binaryOverride: boolean
  /** A `agentTeam.cliCommand.<agentKey>` override is in effect. Amber, not
   *  neutral: it also switches off the model and effort above it. */
  commandOverride: boolean
  /** How many `agentTeam.cliEnv.<agentKey>` variables are set. */
  envOverrideCount: number
}

type Translate = (key: string, params?: Record<string, unknown>) => string

/** Ordered as the row reads: what it is, what it runs as, how it is reached. */
export function cliAgentRowChips(facts: CliAgentRowFacts, t: Translate): CliRowChip[] {
  const chips: CliRowChip[] = []
  const chip = (id: string, tone: CliRowChipTone, label: string): void => {
    chips.push({ id, tone, label })
  }

  // 'unknown' is "not found yet" (see DepStatus), so it reads like null.
  if (facts.install && facts.install.status !== 'unknown') {
    const { status, version } = facts.install
    if (status === 'missing') {
      // Not installing a CLI is a choice, not a risk: a neutral fact.
      chip('install', 'neutral', t('settings.cliAgents.chip.not-installed'))
    } else if (status === 'outdated') {
      chip('install', 'warn', t('settings.cliAgents.chip.outdated', { version }))
    } else {
      chip(
        'install',
        'ok',
        version
          ? t('settings.cliAgents.chip.installed', { version })
          : t('settings.cliAgents.chip.installed-unknown')
      )
    }
  }

  // A vendor that cannot be told a model says so; one that can shows the pick
  // only when there is one, because "vendor default" is what every untouched
  // row would say and a chip on every row stops being information.
  if (!facts.supportsModel) {
    chip('model', 'neutral', t('settings.cliAgents.chip.no-model-args'))
  } else if (facts.modelDefault.model) {
    chip('model', 'info', t('settings.cliAgents.chip.model', { model: facts.modelDefault.model }))
  }
  if (facts.modelDefault.effort) {
    chip('effort', 'info', t('settings.cliAgents.chip.effort', { effort: facts.modelDefault.effort }))
  }

  if (facts.hasPermissionFlag) {
    if (facts.permissionMode === 'force-on') {
      chip('permission', 'warn', t('settings.cliAgents.chip.perm-force-on'))
    } else if (facts.permissionMode === 'force-off') {
      chip('permission', 'bad', t('settings.cliAgents.chip.perm-force-off'))
    } else {
      chip('permission', 'neutral', t('settings.cliAgents.chip.perm-inherit'))
    }
  }

  if (!facts.pushKind) {
    chip('push', 'neutral', t('settings.cliAgents.chip.no-push'))
  } else if (facts.pushEnabled) {
    // On is a configured state, not health: info (blue), so green stays
    // "installed" alone on the card.
    chip('push', 'info', t('settings.cliAgents.chip.push', { kind: facts.pushKind }))
  } else {
    chip('push', 'bad', t('settings.cliAgents.chip.push-off'))
  }

  if (facts.signedIn === false) {
    chip('account', 'neutral', t('settings.cliAgents.chip.signed-out'))
  } else if (facts.signedIn === true) {
    chip('account', 'neutral', t('settings.cliAgents.chip.accounts', { count: facts.accountCount }))
  }

  if (facts.binaryOverride) {
    chip('binary', 'warn', t('settings.cliAgents.chip.custom-binary'))
  }

  if (facts.commandOverride) {
    chip('command', 'warn', t('settings.cliAgents.chip.custom-command'))
  }

  if (facts.envOverrideCount > 0) {
    chip('env', 'warn', t('settings.cliAgents.chip.custom-env', { count: facts.envOverrideCount }))
  }

  return chips
}
