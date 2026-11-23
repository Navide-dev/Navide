// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Closing a workspace from the sidebar ends every CLI running in it. The menu
// row says "close workspace" and nothing about the panes, so it asks first —
// the same shape as closing an idle pane. It used to also unspawn their
// records, which made it the one workspace action a reopen could not undo;
// now the records are kept and a reopen resumes them, and the dialog says so.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = read('src/renderer/src/App.vue')

/** A top-level function's text, up to the next declaration. */
function body(source: string, name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = source.indexOf(pat)
    if (at < 0) continue
    const rest = source.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return source.slice(at, at + pat.length + (next ? next.index : 3000))
  }
  throw new Error(`${name} not found`)
}

const zh = JSON.parse(read('src/renderer/src/i18n/locales/zh-TW.json'))
const en = JSON.parse(read('src/renderer/src/i18n/locales/en-US.json'))

describe('closing a workspace asks before it takes the panes', () => {
  const fn = body(appSource, 'closeWorkspace')

  it('asks before anything is torn down', () => {
    // Ordering is the guarantee: a dialog raised after switchToWorkspace or
    // onKill would be asking about a teardown already under way.
    const asked = fn.indexOf('confirm-close.sidebar-ws-title')
    expect(asked).toBeGreaterThan(-1)
    expect(asked).toBeLessThan(fn.indexOf('await switchToWorkspace('))
    expect(asked).toBeLessThan(fn.indexOf('onKill('))
  })

  it('closes nothing when the dialog is declined', () => {
    const declined = fn.indexOf('if (!ok) return')
    expect(declined).toBeGreaterThan(-1)
    expect(declined).toBeLessThan(fn.indexOf('onKill('))
  })

  it('counts the panes it is about to take down', () => {
    // The body says how many panes go with the workspace, so the two counts it
    // is chosen by have to be the panes this close actually takes. The keys
    // themselves moved to closeDialogBodyKey; what stays here is the counting.
    expect(fn).toContain("panes.value.filter((p) => normWs(p.workspacePath) === normWs(path))")
    expect(fn).toContain('const count = inWorkspace.length')
    expect(fn).toContain('i18n.global.t(')
  })

  it('does not promise a resume for the pipeline panes it unspawns', () => {
    // The plain body now says every pane comes back. Pipeline panes take the
    // markRemoved branch below, so a workspace holding any of them needs
    // wording that says which ones do not.
    expect(fn).toContain("const pipelineCount = inWorkspace.filter((p) => p.origin === 'pipeline').length")
    // Which sentence is true of which workspace is behaviour-tested in
    // lib/__tests__/workspaceCloseRun.test.ts — it got this wrong twice while
    // it lived here as a nested ternary that only string-scanning covered.
    // What has to hold here is the wiring and that every key it can return
    // exists in both locales with the placeholders it interpolates.
    expect(fn).toContain('closeDialogBodyKey({ count, pipelineCount })')
    expect(fn).toContain('{ name, count, pipelineCount }')
    expect(appSource).toContain(
      "import { closeDialogBodyKey, closeEndsTheRun, restoreBlockedByRun } from './lib/workspaceCloseRun'"
    )
    const lib = read('src/renderer/src/lib/workspaceCloseRun.ts')
    const returned = [...lib.matchAll(/return '(confirm-close\.[a-z-]+)'/g)].map((m) => m[1])
    expect(returned.length).toBe(4)
    for (const keys of [zh['confirm-close'], en['confirm-close']]) {
      for (const full of returned) {
        const k = full.replace('confirm-close.', '')
        expect(typeof keys[k]).toBe('string')
      }
      expect(keys['sidebar-ws-body-pipeline']).toContain('{count}')
      expect(keys['sidebar-ws-body-pipeline']).toContain('{pipelineCount}')
      expect(keys['sidebar-ws-body-pipeline-only']).toContain('{count}')
    }
  })

  it('keeps the pane records so reopening the workspace can resume them', () => {
    // Cold restore takes only spawn_status 'spawned' records, so unspawning
    // here is what lost the panes for good. Ending the CLI is still right —
    // keeping its seat is what the reopen needs.
    expect(fn).toContain('await onKill(pane.id, { markRemoved: false, force: false })')
    // markRemoved is what decides it, so the branch must not send the message
    // that retires a record for the panes it promises to bring back.
    const kept = fn.slice(fn.indexOf('await onKill(pane.id, { markRemoved: false, force: false })'))
    expect(kept).not.toContain("'manual_pane.unspawn'")
    expect(kept).not.toContain("'pipeline.slot_unspawn'")
  })

  it('retires the pipeline records it says will not come back, by pane id', () => {
    // The dialog names them, so the close has to actually retire them — and by
    // a key that cannot drift. onKill addresses a slot by (stage index, slot
    // label) and resolves the index against the WINDOW's active stage list,
    // which onWorkspaceCheck repoints at the workspace on screen: closing a
    // project whose run used another pipeline either misses, or lands on a
    // valid index and retires a DIFFERENT slot, since labels repeat.
    const slots = fn.slice(fn.indexOf("if (pane.origin === 'pipeline') {"), fn.indexOf('continue'))
    expect(slots).toContain('await onKill(pane.id, { markRemoved: false })')
    expect(slots).toContain("sendQuiet<ProjectPayload>('pipeline.slot_unspawn_by_pane'")
    expect(slots).toContain('pane_id: pane.id')
    // Neither half of the drifting key may be used here.
    expect(slots).not.toContain('stage_index')
    expect(slots).not.toContain('slot_label')
    // No peek: the handler needs no index, so there is nothing to look up.
    expect(fn).not.toContain("'project.peek'")
  })

  it('does not carry reclaimIdlePane\'s spawn-history take-back, which cannot fire here', () => {
    // reclaimIdlePane undoes onKill's removedAt stamp because its pane stays.
    // Copying that here looks right and does nothing: spawnHistory holds only
    // the workspace on screen, and this loop always runs against another one,
    // so the stamp never finds an entry. A take-back would be dead code with a
    // source-scanning test that passes while exercising nothing.
    expect(fn).not.toContain('histEntry')
    expect(appSource).toContain(
      'historyEntriesFor(spawnHistory.value, spawnHistoryWorkspaceIdentity(currentWorkspace.value))'
    )
  })

  it('keeps the messaging handle the reopened pane is addressed by', () => {
    // onKill drops the persisted name; the restore reads it back as the pane's
    // preferred name, so losing it re-derives a handle from the fallback chain
    // and senders that knew the old one are writing to nothing. Captured
    // before the kill, put back after it — the same order reclaimIdlePane uses.
    const capture = fn.indexOf('const messagingName =')
    const kill = fn.indexOf('await onKill(pane.id, { markRemoved: false, force: false })')
    const restore = fn.indexOf('if (messagingName) persistMessagingName(pane.id, messagingName)')
    expect(capture).toBeGreaterThan(-1)
    expect(capture).toBeLessThan(kill)
    expect(restore).toBeGreaterThan(kill)
  })

  it('still ends the CLI of a pane that never realized', () => {
    // onKill kills through the pane's terminal ref, which a placeholder does
    // not have — the unspawn it no longer sends is what used to reach those
    // processes (and the ones whose kill was refused). Asked for after the
    // kill, which closes the session first, so a live PTY here means the kill
    // did not happen.
    // Sliced from the kill, so containment IS the ordering claim — the pipeline
    // branch above has a sweep of its own and indexOf would find that one.
    const kept = fn.slice(fn.indexOf('await onKill(pane.id, { markRemoved: false, force: false })'))
    expect(kept).toContain("sendQuiet<{ ok: boolean }>('manual_pane.release_pty', { pane_id: pane.id })")
  })

  it('records the opt-out only on a confirmed close', () => {
    // Cancelling means "not this workspace", which says nothing about the next.
    const optOut = fn.indexOf('confirmBeforeCloseWorkspace.value = false')
    expect(optOut).toBeGreaterThan(-1)
    expect(optOut).toBeGreaterThan(fn.indexOf('if (!ok) return'))
    expect(fn).toContain('notifyRestore.dialogCheckbox.value')
  })

  it('keeps its own setting, separate from the welcome-picker confirmation', () => {
    // confirmBeforeClose guards returning to the picker, which leaves every
    // pane record intact — a user who turned that off has not agreed to skip
    // the one that removes them.
    expect(appSource).toContain(
      "const confirmBeforeCloseWorkspace = makeStickyBool('agentTeam.confirmCloseWorkspace', true)"
    )
    expect(fn).not.toContain('confirmBeforeClose.value')
  })

  it('can be turned back on from Settings once the dialog is opted out of', () => {
    // A "don't show again" with no way back is a one-way door: the next close
    // would be as silent as the one that prompted this whole guard.
    const settings = read('src/renderer/src/components/SettingsModal.vue')
    expect(settings).toContain('confirmBeforeCloseWorkspace?: boolean')
    expect(settings).toContain("(e: 'update:confirmBeforeCloseWorkspace', v: boolean): void")
    expect(settings).toContain('data-settings-section="general-confirm-close-workspace"')
    expect(appSource).toContain(
      'v-model:confirm-before-close-workspace="confirmBeforeCloseWorkspace"'
    )
    for (const keys of [zh['settings']['general'], en['settings']['general']]) {
      expect(typeof keys['confirm-close-workspace']).toBe('string')
      expect(typeof keys['confirm-close-workspace-hint']).toBe('string')
    }
  })

  it('leaves detach unguarded — it hands the panes over rather than ending them', () => {
    expect(body(appSource, 'detachWorkspace')).not.toContain('confirm-close.sidebar-ws-title')
  })

  it('sends only messages the backend actually handles', () => {
    // The message name is two independent strings: sendQuiet's literal here and
    // @handler's in ws_handlers.py. Nothing else compares them — this file's
    // tests scan renderer source, and the backend's call the handler by name —
    // so a typo on either side ships as a silently dropped request.
    const handlers = read('backend/agent_team_backend/ws_handlers.py')
    for (const msg of ['manual_pane.release_pty', 'pipeline.slot_unspawn_by_pane']) {
      expect(fn).toContain(`'${msg}'`)
      expect(handlers).toContain(`@handler("${msg}")`)
    }
  })

  it('ships the wording in both locales', () => {
    for (const keys of [zh['confirm-close'], en['confirm-close']]) {
      for (const k of ['sidebar-ws-title', 'sidebar-ws-body', 'sidebar-ws-body-empty', 'sidebar-ws-confirm']) {
        expect(typeof keys[k]).toBe('string')
        expect(keys[k].length).toBeGreaterThan(0)
      }
    }
    expect(zh['confirm-close']['sidebar-ws-body']).toContain('{count}')
    expect(en['confirm-close']['sidebar-ws-body']).toContain('{count}')
    // The body promised the panes were gone for good. It has to stop saying so
    // now that a reopen brings them back, or the dialog talks a user out of a
    // close that costs them nothing but the running turn.
    expect(zh['confirm-close']['sidebar-ws-body']).toContain('接續')
    expect(en['confirm-close']['sidebar-ws-body']).toMatch(/resume/i)
    expect(zh['confirm-close']['sidebar-ws-title']).toContain('{name}')
    expect(en['confirm-close']['sidebar-ws-title']).toContain('{name}')
  })
})
