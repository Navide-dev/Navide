import { describe, expect, it, vi } from 'vitest'
import {
  applyApprovedRequest,
  recoverApplyingRequests,
  recoveryResult,
  type PluginRequestApplyDeps,
  type PluginRequestRecord,
} from '../pluginAgentRequestApply'

function record(kind: PluginRequestRecord['kind'], version: string | null, status = 'applying'): PluginRequestRecord {
  return {
    approval_id: `a-${kind}`,
    kind,
    status,
    target: { id: 'nerdtechnic.devmap', namespace: 'nerdtechnic', name: 'devmap', version, fromVersion: '0.2.0' },
  }
}

function deps(installed: Array<{ id: string; packageVersion?: string }>): PluginRequestApplyDeps & {
  finish: ReturnType<typeof vi.fn>
} {
  return {
    install: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
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

    const rolled = deps([{ id: 'nerdtechnic.devmap', packageVersion: '0.1.0' }])
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
