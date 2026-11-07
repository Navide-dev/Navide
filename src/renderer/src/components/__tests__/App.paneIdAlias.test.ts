// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so it isn't practical
// to mount it here (same reasoning as App.spawnAdvisories.test.ts). These tests
// parse the source text instead, guarding one wiring rule: every path that
// rebuilds a pane around a CLI that never stopped running must tell the backend
// which pane id that CLI was reached under before, or the id baked into its
// /plan-mcp URL at spawn time stops resolving and every MCP tool fails for it.
// The backend half (alias registry, chain flattening, what still gets refused)
// is covered in backend/tests/test_agent_messaging_alias.py.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string, fromIndex = 0): string {
  const start = appSource.indexOf(startMarker, fromIndex)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('agent_msg.register carries the pane\'s former ids', () => {
  const mirror = block('function mirrorMessagingHandle(', '\nfunction unregisterPaneMessaging')

  it('sends them with every mirror', () => {
    expect(mirror).toContain('former_pane_ids: pane.formerPaneIds ?? [],')
  })

  // A source assertion, like the ones around it: it checks that the payload is
  // built, not what the backend then does with it. The behaviour — an
  // unrealized pane published as "disconnected" rather than "running" — is
  // covered in backend/tests/test_server_link.py.
  it('marks a cold-restore placeholder as not realized', () => {
    expect(mirror).toContain('realized: pane.realized === true,')
  })

  it('re-sends them on a rename or reconnect, not only the first register', () => {
    // A window away past the offline grace period is forgotten along with its
    // aliases; the re-register on reconnect is what puts them back.
    expect(mirror).not.toContain('if (!pane.formerPaneIds)')
  })
})

describe('spawnPane', () => {
  it('carries the former ids onto the pane before it is registered', () => {
    const spawn = block('    formerPaneIds: opts.formerPaneIds', 'registerPaneMessaging(pane,')
    expect(spawn).toContain('formerPaneIds: opts.formerPaneIds?.length ? [...opts.formerPaneIds] : undefined,')
  })
})

describe('the restore funnel', () => {
  // Reload, detach and a run group returning from a detached window all restore
  // from the project record, and all of them may reattach a PTY that is still
  // running — so one place passes the predecessor id for all three.
  const restored = block('async function spawnRestoredPane(', '\ninterface SessionExistsPayload')

  it('passes the saved pane id as the CLI\'s former identity', () => {
    expect(restored).toContain('formerPaneIds: [saved.pane_id],')
  })

  it('is the only spawn path that does so', () => {
    expect(appSource.match(/formerPaneIds: \[/g)).toHaveLength(1)
  })

  it('is what every restore call site goes through', () => {
    expect(appSource.match(/await spawnRestoredPane\(\{/g)).toHaveLength(2)
  })
})

describe('a rebuild claims no former identity', () => {
  // Rebuild kills the CLI and starts another one, which is spawned with the new
  // pane id in its own /plan-mcp URL. There is no process left holding the old
  // id, so aliasing it would name a pane nobody is asking about.
  for (const name of ['rebuildPaneViaResume', 'rebuildPaneClean']) {
    it(`${name} does not`, () => {
      const body = block(`async function ${name}(`, '\n  } finally {')
      expect(body).toContain('replacePaneId: paneId')
      expect(body).not.toContain('formerPaneIds')
    })
  }
})
