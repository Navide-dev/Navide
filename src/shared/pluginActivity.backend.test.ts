import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePluginActivityReport } from './pluginActivity'

// What the backend builds (D-e): backend/tests/test_plugin_audit_log.py
// regenerates this file from a seeded database and fails when it drifts.
const backendReport = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/activity-report-backend.json'), 'utf8')
) as Record<string, unknown>

describe('the backend activity report (contract 5.1)', () => {
  it('is accepted whole by the renderer parser', () => {
    expect(parsePluginActivityReport(backendReport)).toEqual(backendReport)
  })

  it('fills every list the page shows, agentActions included (B2)', () => {
    for (const key of ['toolCalls', 'files', 'commands', 'daily', 'declaredUnused', 'undeclared', 'anomalies', 'agentActions']) {
      expect((backendReport[key] as unknown[]).length, key).toBeGreaterThan(0)
    }
  })
})
