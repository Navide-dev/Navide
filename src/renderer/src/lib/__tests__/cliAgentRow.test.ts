// @vitest-environment node
// The status chips on a Settings → CLI Agents row.
//
// The colours carry meaning the user is told to read (green = normal, amber =
// a deviation, red = unusable or off, grey = a neutral fact), so what this file
// pins is the tone each fact gets — a "not probed yet" painted red would say
// the CLI is missing when nobody has looked.
import { describe, expect, it } from 'vitest'

import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import { cliAgentRowChips, type CliAgentRowFacts } from '../cliAgentRow'

/** Echoes the key back, so an assertion names the string it expects. */
const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}:${Object.values(params).join(',')}` : key

const base: CliAgentRowFacts = {
  install: { status: 'ok', version: '2.1.0' },
  hasPermissionFlag: true,
  permissionMode: 'inherit',
  pushKind: 'rewake',
  pushEnabled: true,
  supportsModel: true,
  modelDefault: { model: '', effort: '' },
  signedIn: true,
  accountCount: 2,
  binaryOverride: false,
  commandOverride: false,
  envOverrideCount: 0,
}

function chips(over: Partial<CliAgentRowFacts> = {}) {
  return cliAgentRowChips({ ...base, ...over }, t)
}

function chip(id: string, over: Partial<CliAgentRowFacts> = {}) {
  return chips(over).find((c) => c.id === id)
}

describe('cliAgentRowChips', () => {
  it('reads a healthy vendor as install, permission, push and accounts', () => {
    expect(chips().map((c) => c.id)).toEqual(['install', 'permission', 'push', 'account'])
  })

  it('shows the version green when installed', () => {
    expect(chip('install')).toMatchObject({
      tone: 'ok',
      label: 'settings.cliAgents.chip.installed:2.1.0',
    })
  })

  it('falls back to a version-less label rather than an empty one', () => {
    expect(chip('install', { install: { status: 'ok', version: '' } })).toMatchObject({
      tone: 'ok',
      label: 'settings.cliAgents.chip.installed-unknown',
    })
  })

  it('shows a missing CLI as a neutral fact and an outdated one amber', () => {
    expect(chip('install', { install: { status: 'missing', version: '' } }))
      .toMatchObject({ tone: 'neutral' })
    expect(chip('install', { install: { status: 'outdated', version: '1.0' } }))
      .toMatchObject({ tone: 'warn' })
  })

  it('says nothing at all until the probe has run', () => {
    // Not the same as "missing": onboarding has simply not answered yet, and a
    // red chip there would accuse an installed CLI of being absent.
    expect(chip('install', { install: null })).toBeUndefined()
  })

  it('treats an unknown install like one not probed yet, not as installed', () => {
    // The quick pass reports "unknown" before the login shell has answered;
    // a green "Installed" there would vouch for a CLI nobody has found.
    expect(chip('install', { install: { status: 'unknown', version: '' } })).toBeUndefined()
  })

  it('names the absence of a model flag, and a pick only once there is one', () => {
    expect(chip('model', { supportsModel: false })).toMatchObject({
      tone: 'neutral',
      label: 'settings.cliAgents.chip.no-model-args',
    })
    // Supported but unset: the row would otherwise carry "vendor default" on
    // every vendor, which is noise rather than a reading of the settings.
    expect(chip('model', { supportsModel: true })).toBeUndefined()
    expect(chip('model', { modelDefault: { model: 'opus-5', effort: '' } })).toMatchObject({
      tone: 'info',
      label: 'settings.cliAgents.chip.model:opus-5',
    })
  })

  it('shows a stored effort as its own chip', () => {
    expect(chip('effort')).toBeUndefined()
    expect(chip('effort', { modelDefault: { model: '', effort: 'high' } })).toMatchObject({
      tone: 'info',
      label: 'settings.cliAgents.chip.effort:high',
    })
  })

  it('keeps a stored model off a vendor that cannot be told one', () => {
    // The setting survives a vendor losing modelArgs (see cliModelDefault.ts),
    // so the row has to report the refusal, not the stale pick.
    expect(chip('model', { supportsModel: false, modelDefault: { model: 'opus-5', effort: '' } }))
      .toMatchObject({ label: 'settings.cliAgents.chip.no-model-args' })
  })

  it('reads an inherited permission as neutral and an override as a deviation', () => {
    expect(chip('permission')).toMatchObject({ tone: 'neutral' })
    expect(chip('permission', { permissionMode: 'force-on' })).toMatchObject({ tone: 'warn' })
    expect(chip('permission', { permissionMode: 'force-off' })).toMatchObject({ tone: 'bad' })
  })

  it('omits the permission chip for a vendor with no flag to skip', () => {
    expect(chip('permission', { hasPermissionFlag: false })).toBeUndefined()
  })

  it('separates having no channel from having one switched off', () => {
    expect(chip('push')).toMatchObject({
      tone: 'info',
      label: 'settings.cliAgents.chip.push:rewake',
    })
    expect(chip('push', { pushEnabled: false })).toMatchObject({ tone: 'bad' })
    expect(chip('push', { pushKind: '', pushEnabled: true })).toMatchObject({
      tone: 'neutral',
      label: 'settings.cliAgents.chip.no-push',
    })
  })

  it('counts accounts when signed in and says so when signed out', () => {
    expect(chip('account')).toMatchObject({ label: 'settings.cliAgents.chip.accounts:2' })
    expect(chip('account', { signedIn: false })).toMatchObject({
      label: 'settings.cliAgents.chip.signed-out',
    })
  })

  it('says nothing about accounts for a CLI whose credentials it cannot read', () => {
    expect(chip('account', { signedIn: null })).toBeUndefined()
  })

  it('flags a binary override as a deviation worth noticing', () => {
    expect(chip('binary', { binaryOverride: true })).toMatchObject({ tone: 'warn' })
    expect(chip('binary')).toBeUndefined()
  })

  it('flags a launch-command override amber — it also switches the model off', () => {
    expect(chip('command', { commandOverride: true })).toMatchObject({
      tone: 'warn',
      label: 'settings.cliAgents.chip.custom-command',
    })
    expect(chip('command')).toBeUndefined()
  })

  it('counts custom env vars and says nothing when there are none', () => {
    expect(chip('env', { envOverrideCount: 2 })).toMatchObject({
      tone: 'warn',
      label: 'settings.cliAgents.chip.custom-env:2',
    })
    expect(chip('env')).toBeUndefined()
  })

  it('derives "no model flag" from the vendor spec rather than a hard-coded list', () => {
    // The point of the chip: droid and aider declare no modelArgs, and adding a
    // twelfth vendor must not mean editing a list here.
    const without = CLI_AGENT_SPECS.filter((s) => !s.modelArgs).map((s) => s.agentKey)
    expect(without.length).toBeGreaterThan(0)
    for (const spec of CLI_AGENT_SPECS) {
      const shown = !!chip('model', { supportsModel: !!spec.modelArgs })
      expect(shown, spec.agentKey).toBe(without.includes(spec.agentKey))
    }
  })
})
