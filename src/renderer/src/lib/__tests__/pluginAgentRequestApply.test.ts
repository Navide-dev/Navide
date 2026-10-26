import { describe, expect, it, vi } from 'vitest'
import {
  applyApprovedRequest,
  recoverApplyingRequests,
  recoveryResult,
  type InstalledPackage,
  type PluginRequestApplyDeps,
  type PluginRequestRecord, isAppliableKind, ROLLBACK_CONSENT_REQUIRED_TEXT } from '../pluginAgentRequestApply'

function record(kind: PluginRequestRecord['kind'], version: string | null, status = 'applying'): PluginRequestRecord {
  return {
    approval_id: `a-${kind}`,
    kind,
    status,
    target: { id: 'nerdtechnic.devmap', namespace: 'nerdtechnic', name: 'devmap', version, fromVersion: '0.2.0' },
  }
}

function deps(installed: InstalledPackage[]): PluginRequestApplyDeps & {
  finish: ReturnType<typeof vi.fn>
} {
  return {
    install: vi.fn(async () => undefined),
    installStaged: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    enable: vi.fn(async () => undefined),
    listInstalled: vi.fn(async () => installed),
    finish: vi.fn(async () => undefined),
  }
}

describe('recovery of requests a restart left applying', () => {
  it('completes a remove whose package is gone and an update or rollback at the target version', () => {
    expect(recoveryResult(record('plugin-remove', null), [])).toEqual({ status: 'completed', error: null })
    const at = [{ id: 'nerdtechnic.devmap', packageVersion: '0.3.0' }]
    expect(recoveryResult(record('plugin-update', '0.3.0'), at)).toEqual({ status: 'completed', error: null })
    expect(recoveryResult(record('plugin-rollback', '0.3.0'), at)).toEqual({ status: 'completed', error: null })
    expect(recoveryResult(record('plugin-install', '0.3.0'), at)).toEqual({ status: 'completed', error: null })
  })

  it('marks everything else failed with interrupted', () => {
    const at = [{ id: 'nerdtechnic.devmap', packageVersion: '0.2.0' }]
    expect(recoveryResult(record('plugin-remove', null), at)).toEqual({ status: 'failed', error: 'interrupted' })
    expect(recoveryResult(record('plugin-update', '0.3.0'), at)).toEqual({ status: 'failed', error: 'interrupted' })
    expect(recoveryResult(record('plugin-install', '0.3.0'), [])).toEqual({ status: 'failed', error: 'interrupted' })
  })

  it('finishes only the applying requests', async () => {
    const d = deps([{ id: 'nerdtechnic.devmap', packageVersion: '0.3.0' }])
    const settled = await recoverApplyingRequests(
      [record('plugin-update', '0.3.0'), record('plugin-install', '0.3.0', 'pending'), record('plugin-remove', null)],
      d,
    )
    expect(settled).toEqual([
      { approvalId: 'a-plugin-update', status: 'completed', error: null },
      { approvalId: 'a-plugin-remove', status: 'failed', error: 'interrupted' },
    ])
    expect(d.finish).toHaveBeenCalledTimes(2)
  })
})

describe('applyApprovedRequest', () => {
  it('runs the window flow for each kind and reports what the installed packages show', async () => {
    const updated = deps([{ id: 'nerdtechnic.devmap', packageVersion: '0.3.0' }])
    await expect(applyApprovedRequest(record('plugin-update', '0.3.0'), updated)).resolves.toEqual({ status: 'completed', error: null })
    expect(updated.install).toHaveBeenCalledWith('nerdtechnic', 'devmap', '0.3.0')
    expect(updated.finish).toHaveBeenCalledWith('a-plugin-update', { status: 'completed', error: null })

    const rolled = deps([{ id: 'nerdtechnic.devmap', packageVersion: '0.1.0', rollbackToVersion: '0.1.0' }])
    await applyApprovedRequest(record('plugin-rollback', '0.1.0'), rolled)
    expect(rolled.rollback).toHaveBeenCalledWith('nerdtechnic.devmap')

    const removed = deps([])
    await expect(applyApprovedRequest(record('plugin-remove', null), removed)).resolves.toEqual({ status: 'completed', error: null })
    expect(removed.remove).toHaveBeenCalledWith('nerdtechnic.devmap')
  })

  it('reports a cancelled trust dialog as not applied and a thrown error as its message', async () => {
    const cancelled = deps([{ id: 'nerdtechnic.devmap', packageVersion: '0.2.0' }])
    await expect(applyApprovedRequest(record('plugin-update', '0.3.0'), cancelled)).resolves.toEqual({
      status: 'failed', error: 'not-applied',
    })
    const thrown = deps([])
    thrown.install = vi.fn(async () => { throw new Error('signature check failed') })
    await expect(applyApprovedRequest(record('plugin-install', '0.3.0'), thrown)).resolves.toEqual({
      status: 'failed', error: 'signature check failed',
    })
    expect(thrown.finish).toHaveBeenCalledWith('a-plugin-install', { status: 'failed', error: 'signature check failed' })
  })
})

describe('a rollback only to the version the user approved', () => {
  it('does not roll back when the kept version is another one, and says why', async () => {
    const d = deps([{ id: 'nerdtechnic.devmap', packageVersion: '0.3.0', rollbackToVersion: '0.2.0' }])
    await expect(applyApprovedRequest(record('plugin-rollback', '0.1.0'), d)).resolves.toEqual({
      status: 'failed', error: 'the version kept for rollback is 0.2.0, not the approved 0.1.0',
    })
    expect(d.rollback).not.toHaveBeenCalled()
    expect(d.finish).toHaveBeenCalledWith('a-plugin-rollback', {
      status: 'failed', error: 'the version kept for rollback is 0.2.0, not the approved 0.1.0',
    })
  })

  it('tells the agent plainly when going back still needs the user\'s renewed consent (L4)', async () => {
    const d = deps([{ id: 'nerdtechnic.devmap', packageVersion: '0.3.0', rollbackToVersion: '0.2.0' }])
    d.rollback = vi.fn(async () => { throw new Error('ROLLBACK_CONSENT_REQUIRED [nerdtechnic.devmap]: going back to the file version 0.2.0 needs your consent again') })
    await expect(applyApprovedRequest(record('plugin-rollback', '0.2.0'), d)).resolves.toEqual({
      status: 'failed', error: ROLLBACK_CONSENT_REQUIRED_TEXT,
    })
    expect(ROLLBACK_CONSENT_REQUIRED_TEXT.startsWith('consent-required:')).toBe(true)
    expect(ROLLBACK_CONSENT_REQUIRED_TEXT).not.toContain('ROLLBACK_CONSENT_REQUIRED [')
  })

  it('does not roll back when no version is kept', async () => {
    const d = deps([{ id: 'nerdtechnic.devmap', packageVersion: '0.3.0' }])
    await expect(applyApprovedRequest(record('plugin-rollback', '0.2.0'), d)).resolves.toMatchObject({ status: 'failed' })
    expect(d.rollback).not.toHaveBeenCalled()
  })
})

describe('recovery leaves alone what another open window is applying', () => {
  it('skips the requests a live main window approved', async () => {
    const d = deps([])
    const settled = await recoverApplyingRequests(
      [record('plugin-install', '0.3.0'), record('plugin-remove', null)],
      d,
      new Set(['a-plugin-install']),
    )
    expect(settled).toEqual([{ approvalId: 'a-plugin-remove', status: 'completed', error: null }])
    expect(d.finish).toHaveBeenCalledTimes(1)
  })
})

describe('a plugin-enable request (B2-c option B)', () => {
  it('enables only when approved and applied, and checks the package really is enabled', async () => {
    const enabled = deps([{ id: 'nerdtechnic.devmap', packageVersion: '0.2.0', disabled: false }])
    await expect(applyApprovedRequest(record('plugin-enable', '0.2.0'), enabled)).resolves.toEqual({ status: 'completed', error: null })
    expect(enabled.enable).toHaveBeenCalledWith('nerdtechnic.devmap')
    const still = deps([{ id: 'nerdtechnic.devmap', packageVersion: '0.2.0', disabled: true }])
    await expect(applyApprovedRequest(record('plugin-enable', '0.2.0'), still)).resolves.toEqual({ status: 'failed', error: 'not-applied' })
  })

  it('recovers as completed only when the package is enabled', () => {
    expect(recoveryResult(record('plugin-enable', '0.2.0'), [{ id: 'nerdtechnic.devmap', disabled: false }])).toEqual({ status: 'completed', error: null })
    expect(recoveryResult(record('plugin-enable', '0.2.0'), [{ id: 'nerdtechnic.devmap', disabled: true }])).toEqual({ status: 'failed', error: 'interrupted' })
    expect(recoveryResult(record('plugin-enable', '0.2.0'), [])).toEqual({ status: 'failed', error: 'interrupted' })
  })
})

describe('isAppliableKind', () => {
  it('names exactly the kinds applyApprovedRequest carries out', () => {
    expect(['plugin-install', 'plugin-update', 'plugin-rollback', 'plugin-remove', 'plugin-enable'].every(isAppliableKind)).toBe(true)
    // A kind added on the backend first must not be approvable before this side applies it.
    expect(isAppliableKind('skill')).toBe(false)
  })
})

describe('W1 (S2): an approved agent file request', () => {
  const fileRecord = (stagingId?: string): PluginRequestRecord => ({
    approval_id: 'a-file',
    kind: 'plugin-install-file',
    status: 'applying',
    target: {
      id: 'acme.todo', namespace: 'acme', name: 'todo', version: '1.0.0', fromVersion: null,
      ...(stagingId ? { stagingId, digest: 'ab'.repeat(32) } : {}),
    },
  })

  it('installs the staged copy through the window\'s consent flow, bound to the card\'s digest', async () => {
    const d = deps([{ id: 'acme.todo', packageVersion: '1.0.0' }])
    expect(isAppliableKind('plugin-install-file')).toBe(true)
    await expect(applyApprovedRequest(fileRecord('cd'.repeat(16)), d)).resolves.toEqual({ status: 'completed', error: null })
    expect(d.installStaged).toHaveBeenCalledWith('cd'.repeat(16), 'ab'.repeat(32))
    expect(d.install).not.toHaveBeenCalled()
  })

  it('fails a request with no staged copy, and one the user cancelled in the dialog', async () => {
    const none = deps([])
    expect(await applyApprovedRequest(fileRecord(), none)).toEqual({ status: 'failed', error: 'the request names no staged package' })
    expect(none.installStaged).not.toHaveBeenCalled()
    const cancelled = deps([])
    expect(await applyApprovedRequest(fileRecord('cd'.repeat(16)), cancelled)).toEqual({ status: 'failed', error: 'not-applied' })
  })
})
