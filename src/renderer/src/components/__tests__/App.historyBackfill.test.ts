// @vitest-environment happy-dom
// Restore rebuilds history rows for panes that were closed before the app last
// quit. It used to stamp both timestamps with project.updated_at, which is
// rewritten on every save — so the whole batch arrived carrying roughly the
// app's start time and piled into "Today", and the entries claimed to have
// been removed at a moment nothing happened. It also hard-coded origin
// 'manual', which mislabelled every mcp-spawned session.
//
// The behaviour of the resulting rows is covered in spawnHistory.test.ts and
// AgentHistoryModal.refresh.test.ts; what is only assertable here is the shape
// of the record restore writes, because App.vue cannot be mounted (backend and
// terminal lifecycles start on mount) and the backfill is inline in restore.
// These are source assertions and no stronger than that.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** The literal restore pushes into spawnHistory for a closed manual pane. */
const backfill = (() => {
  const at = appSource.indexOf('  for (const saved of removedManual) {')
  if (at < 0) throw new Error('backfill loop not found')
  return appSource.slice(at, appSource.indexOf('\n  }\n', at))
})()

describe('restore backfills history without inventing timestamps', () => {
  it('leaves an unrecorded time unknown instead of substituting one', () => {
    expect(backfill).toContain('spawnedAt: saved.spawned_at || undefined')
    expect(backfill).toContain('removedAt: saved.removed_at || undefined')
    // The old stand-in, and every other way of reaching for "now".
    expect(appSource).not.toContain('const fallbackTs =')
    expect(backfill).not.toContain('project?.updated_at')
    expect(backfill).not.toContain('new Date()')
  })

  it('still marks those panes removed, since that much is known', () => {
    // Without this the rows read as live agents that can be jumped to.
    expect(backfill).toContain('removedTimeUnknown: !saved.removed_at || undefined')
  })

  it('reads the origin off the record rather than assuming manual', () => {
    expect(backfill).toContain('origin: backfillOrigin(saved.origin)')
    expect(backfill).not.toContain("origin: 'manual'")
  })

  it('narrows an unrecognised origin to manual, by membership not equality', () => {
    // Comparing against a single origin is what mislabelled mcp panes in the
    // first place, and App.paneOriginPersistence.test.ts bans the pattern.
    expect(appSource).toContain(
      "const HISTORY_ORIGINS: readonly SpawnHistoryEntry['origin'][] = ['manual', 'pipeline', 'mcp']"
    )
    const fn = appSource.slice(appSource.indexOf('function backfillOrigin('))
    expect(fn.slice(0, fn.indexOf('\n}\n')))
      .toContain("HISTORY_ORIGINS.find((known) => known === origin) ?? 'manual'")
  })

  it('clears the unknown-time marker when the real times are recovered', () => {
    // history.snapshot backfills the true first/last event times afterwards;
    // leaving the marker set would keep claiming the time is unknown.
    const enrich = appSource.slice(appSource.indexOf('const ts = paneTs.get('))
    expect(enrich.slice(0, 400)).toContain('entry.removedTimeUnknown = undefined')
  })

  it('does not stamp a removal time over an unknown one when the history is reconciled', () => {
    // Opening Agent History re-hydrates and reconciles. Checking removedAt alone
    // gave every "removed, time unknown" row today's date, and the deep watcher
    // then persisted that invented time to the project mirror.
    const fn = appSource.slice(appSource.indexOf('function reconcileSpawnHistoryLiveness('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('!isHistoryEntryRemoved(e)')
    expect(body).not.toContain('!e.removedAt &&')
  })

  it('carries the two new fields on the restore record type', () => {
    expect(appSource).toContain('  spawned_at?: string\n  removed_at?: string')
  })
})

describe('the history modal can ask for a fresh read', () => {
  const refresh = (() => {
    const at = appSource.indexOf('async function onRefreshHistory(')
    if (at < 0) throw new Error('onRefreshHistory not found')
    return appSource.slice(at, appSource.indexOf('\n}\n', at))
  })()

  it('will not run two refreshes at once, and always clears the flag', () => {
    expect(refresh).toContain('if (historyRefreshing.value) return')
    expect(refresh).toContain('historyRefreshing.value = true')
    expect(refresh).toContain('} finally {')
    expect(refresh).toContain('historyRefreshing.value = false')
  })

  it('never hands hydrate a null persisted list', () => {
    // hydrateSpawnHistory reads a null `persisted` as "a project that predates
    // the backend store" and answers it with a one-time migration write. The
    // in-memory copy avoids that path and doubles as the fallback if the
    // backend read fails.
    expect(refresh).toContain('await hydrateSpawnHistory(currentWorkspace.value, spawnHistory.value.slice(), undefined)')
    expect(refresh).not.toContain('hydrateSpawnHistory(currentWorkspace.value, null')
  })

  it('is wired to the modal in both directions', () => {
    expect(appSource).toContain(':refreshing="historyRefreshing"')
    expect(appSource).toContain('@refresh="onRefreshHistory"')
  })
})
