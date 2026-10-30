import { diffKey, diffSnapshots, type SnapshotDiff } from '../../src/snapshot'
import type { Fixture } from '../fixtures/fixtures'
import type { TerminalDriver } from './driver'

export type TriageCategory = 'oracle-bug' | 'accepted'

/** Per fixture, per diff key: why a difference from the oracle is not an nvterm defect. */
export type Triage = Record<string, Record<string, { category: TriageCategory; reason: string }>>

export interface FixtureResult {
  fixture: string
  diffs: SnapshotDiff[]
  untriaged: SnapshotDiff[]
}

export async function compareFixture(fixture: Fixture, oracle: TerminalDriver, candidate: TerminalDriver, triage: Triage = {}): Promise<FixtureResult> {
  const [expected, actual] = await Promise.all([oracle.run(fixture), candidate.run(fixture)])
  const diffs = diffSnapshots(expected, actual)
  const decisions = triage[fixture.id] ?? {}
  // A '<kind>:*' key triages every difference of that kind in the fixture.
  const triaged = (d: SnapshotDiff): boolean => Boolean(decisions[diffKey(d)] ?? decisions[`${d.kind}:*`])
  return { fixture: fixture.id, diffs, untriaged: diffs.filter((d) => !triaged(d)) }
}

export async function compareAll(fixtures: Fixture[], oracle: TerminalDriver, candidate: TerminalDriver, triage: Triage = {}): Promise<FixtureResult[]> {
  const results: FixtureResult[] = []
  for (const fixture of fixtures) results.push(await compareFixture(fixture, oracle, candidate, triage))
  return results
}
