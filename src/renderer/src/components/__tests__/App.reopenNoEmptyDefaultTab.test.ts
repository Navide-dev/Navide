// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Source-scanned like the other App.*.test.ts files: App.vue cannot be mounted.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('reopening a workspace adds no empty default tab', () => {
  it('passes the project pane count to the never-persisted branch', () => {
    const at = appSource.indexOf('function _loadRunGroups(')
    const loader = appSource.slice(at, appSource.indexOf('\nfunction createRunGroup(', at))
    expect(loader).toContain('runGroups.value = initialRunGroups(parsed, project.panes?.length ?? 0,')
    expect(loader).not.toContain("parsed ?? [{ id: DEFAULT_RUN_GROUP_ID")
  })
})
