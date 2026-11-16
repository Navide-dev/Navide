/**
 * The remote container pane's agent key: resolvable for a live pane, absent
 * from every list that enumerates spawnable vendors.
 */

import { describe, expect, it } from 'vitest'

import {
  AGENT_SPECS,
  CLI_AGENT_SPECS,
  REBUILD_CAPABLE_AGENTS,
  RESTORE_PIN_AGENTS,
  REMOTE_AGENT_KEY,
  REMOTE_AGENT_SPEC,
  agentProfileFor,
  agentUsesBracketedPaste,
  type AgentSpec,
} from '@navide/plugin-shell'
import { TERMINAL_AGENT_KEY } from '../../composables/useAgentMessaging'
import { VENDORS_REPORTING_INTERRUPT, VENDORS_WITHOUT_TURN_END } from '../agentMessaging'

describe('remote container agent spec', () => {
  const spec: AgentSpec = REMOTE_AGENT_SPEC

  it("resolves 'remote' to its own spec, which is not the terminal", () => {
    expect(REMOTE_AGENT_KEY).toBe('remote')
    expect(spec.agentKey).toBe(REMOTE_AGENT_KEY)
    expect(agentProfileFor('remote')).toBe(REMOTE_AGENT_SPEC)
    expect(REMOTE_AGENT_KEY).not.toBe(TERMINAL_AGENT_KEY)
  })

  it('takes messages mid-turn and never infers a turn end from silence', () => {
    expect(spec.acceptsMidTurnInput).toBe(true)
    expect(spec.turnEndInferredFromSilence).toBeFalsy()
    expect(VENDORS_WITHOUT_TURN_END.has(REMOTE_AGENT_KEY)).toBe(false)
    expect(agentUsesBracketedPaste('remote')).toBe(true)
  })

  it('declares nothing tied to a local account, session or model', () => {
    for (const field of [
      'quotaSemantics', 'quotaExhausted', 'loginExpired', 'resumeArgs', 'resumeWithoutId', 'supportsRebuild',
      'supportsRestorePin', 'pinsSessionIdAtLaunch', 'needsSessionMarker', 'needsSessionHome', 'modelArgs',
      'effortArgs', 'skipPermissionFlag', 'pushChannel', 'supportsGhostReconnect', 'startupTrust', 'kind',
    ] as const) {
      expect(spec[field], field).toBeUndefined()
    }
    expect(VENDORS_REPORTING_INTERRUPT.has(REMOTE_AGENT_KEY)).toBe(false)
  })

  it('is in no list a menu, setting or vendor cross-check reads', () => {
    expect(AGENT_SPECS.map((s) => s.agentKey)).not.toContain(REMOTE_AGENT_KEY)
    expect(CLI_AGENT_SPECS.map((s) => s.agentKey)).not.toContain(REMOTE_AGENT_KEY)
    expect(REBUILD_CAPABLE_AGENTS).not.toContain(REMOTE_AGENT_KEY)
    expect(RESTORE_PIN_AGENTS).not.toContain(REMOTE_AGENT_KEY)
    // The vendor directory, which the spec assembly test and the backend
    // registry cross-check (test_cli_vendors_registry.py) both read.
    const vendorFiles = import.meta.glob('../../platform/plugin-shell/agents/*.ts', { eager: true }) as Record<string, { SPEC?: AgentSpec }>
    expect(Object.values(vendorFiles).map((mod) => mod.SPEC?.agentKey)).not.toContain(REMOTE_AGENT_KEY)
  })
})
