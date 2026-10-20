// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MANAGER_READY_SENTINEL,
  MANAGER_STAGE_DONE_SENTINEL,
  renderManagerProtocol
} from '../../data/stages'
import { findSentinel } from '../../platform/terminal/lib/buffer'

// Pipeline completion detection reads absolute indices into a pane's rolling
// clean buffer. Three ways that coordinate system breaks are guarded here. The
// arithmetic itself is unit-tested in lib/__tests__/bufferCursor.test.ts; the
// wiring has to be asserted against the source, because App.vue cannot be
// mounted in this suite.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function body(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `missing: ${startMarker}`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start)
  expect(end, `missing: ${endMarker}`).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

/** One top-level function, ending at its own closing brace — not "everything
 *  until the next named landmark", which for the small router helpers below was
 *  a 400-line slice that no assertion was really locked to. */
function fnBody(header: string): string {
  const start = appSource.indexOf(header)
  expect(start, `missing: ${header}`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end, `unterminated: ${header}`).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

function kickoffCompletion(act: string): number {
  const call = /const kickoffResult = await runPipelineKickoff\(\{[\s\S]*?\n    \}\)/.exec(act)
  expect(call, 'the awaited kickoff call').not.toBeNull()
  return call!.index + call![0].length
}

function assertImmediateRouterArm(act: string): void {
  const completed = kickoffCompletion(act)
  const arm = act.indexOf('armRouterCursors(router, pane.id)')
  expect(arm, 'the arm after kickoff completion').toBeGreaterThan(completed)
  const between = act.slice(completed, arm).replace(/\/\/[^\n]*/g, '')
  // Start at the actual await completion, before cancellation and the local
  // result assignment. Neither may hide a new round trip or render pass.
  expect(between).toContain('if (kickoffResult.cancelled)')
  expect(between).toContain('const ok = kickoffResult.sent')
  expect(between, 'an await inside the window').not.toMatch(/\bawait\b/)
  expect(between, 'a render pass inside the window').not.toContain('syncViews()')
  expect(arm).toBeLessThan(act.indexOf("pane.kickoffStatus = ok ? 'sent' : 'failed'"))
}

describe('the 128KB buffer trim cannot silently move the scan window', () => {
  it('uses the shared re-base rule rather than open-coding the arithmetic', () => {
    expect(appSource).toMatch(/from '\.\/lib\/bufferCursor'/)
  })

  describe('the per-pane stage watcher', () => {
    const watcher = body('function startStageWatcher(', '\nfunction handleAnalyzerResult(')

    it('remembers a (length, bytesSeen) pair so a trim is measurable at all', () => {
      // cleanBuffer.length alone cannot distinguish "trimmed" from "quiet":
      // it stays flat in both cases once the cap is reached.
      expect(watcher).toContain('bufferAnchor')
      expect(watcher).toContain('paneCleanBytes(paneId)')
    })

    it('re-bases every absolute position it holds, not only scanFrom', () => {
      // A half-corrected watcher is worse than none: minScanFrom would then be
      // a floor in the OLD coordinate system and could push scanFrom forward
      // again, and lastAnalyzedBufferLen would make newChars negative forever.
      expect(watcher).toContain('droppedPrefix(watcher.bufferAnchor')
      for (const pos of ['scanFrom', 'minScanFrom', 'lastAnalyzedBufferLen', 'lastPollBufLen']) {
        expect(watcher, pos).toContain(`watcher.${pos} = remapCursor(watcher.${pos}, bufDropped)`)
      }
    })

    it('re-bases before the generating check reads the previous length', () => {
      // Otherwise a trim looks like the buffer shrinking, agentGenerating goes
      // false, and question detection runs on a half-written block.
      const rebase = watcher.indexOf('const bufDropped = droppedPrefix(')
      const generating = watcher.indexOf('const agentGenerating =')
      expect(rebase).toBeGreaterThan(-1)
      expect(generating).toBeGreaterThan(rebase)
    })

    it('keeps the past-the-end correction as a backstop, and re-bases before it', () => {
      // The re-base covers trims the watcher observed. A scanFrom captured
      // before the watcher armed (kickoffScanFrom) can still land past the end,
      // and that pre-existing repair is the only thing that catches it.
      expect(watcher).toContain('watcher.scanFrom >= buf.length')
      expect(watcher).toContain('watcher.scanFrom = watcher.minScanFrom')
      // Both lines predate the re-base work, so their presence alone says
      // nothing about it. The ordering does: the re-base moves scanFrom, so a
      // correction that ran first would judge the pre-trim value.
      const rebase = watcher.indexOf('const bufDropped = droppedPrefix(')
      expect(rebase, 'the re-base').toBeGreaterThan(-1)
      expect(watcher.indexOf('watcher.scanFrom >= buf.length')).toBeGreaterThan(rebase)
    })
  })

  describe('the Manager-mode stage router', () => {
    const scan = body('async function managerRouterScan(', '\nfunction queueOrRouteWorkerMsg(')

    it('re-bases each pane it is about to scan', () => {
      // Worker ASK/REPORT, Manager DISPATCH and the two sentinels all read
      // router cursors; the router has no turn-text fallback of any kind, so a
      // skipped region is unrecoverable.
      expect(scan).toContain('rebaseRouterCursors(router, paneId, buf.length)')
      expect(
        scan.split('rebaseRouterCursors(router, router.managerPaneId, buf.length)').length - 1,
        'both Manager-pane reads'
      ).toBe(2)
    })

    it('measures the trim from the same buffer read it is about to scan', () => {
      // Locked to the helper itself. The old end marker was 400+ lines away,
      // so these three assertions were free to be satisfied by anything in
      // between rather than by the re-baser.
      const helper = fnBody('function rebaseRouterCursors(')
      expect(helper).toContain('droppedPrefix(anchor, obs)')
      expect(helper).toContain('router.cursors.set(paneId, remapCursor(')
      expect(helper).toContain('router.armedCursors.set(paneId, remapCursor(')
    })
  })

  describe('the global Manager router', () => {
    const scan = body('async function globalManagerRouterScan(', '\nfunction onStageSlotCompleted(')

    it('re-bases its cursors too — they are the same absolute indices', () => {
      expect(scan).toContain('rebaseGlobalRouterCursor(wp.id, buf.length)')
      expect(scan).toContain('rebaseGlobalRouterCursor(managerPaneId, mBuf.length)')
    })
  })
})

describe('a re-base never runs on an observation that was not observed', () => {
  // droppedPrefix reads (cleanBuffer.length, cleanBytesSeen). When the pane has
  // no terminal ref both halves are fabricated — bufLen came from an
  // empty-string fallback and paneCleanBytes() returns 0 — and the pair reads
  // as "the whole buffer was trimmed". remapCursor then clamps every cursor to
  // 0, ARMED FLOORS INCLUDED, which is exactly the direction the floor exists
  // to prevent: the next scan reads the kickoff echo's ---STAGE-DONE--- and
  // finishes the stage. Normally the watchdog returns before the scan gets
  // there, but not once watchdogFired is latched or another prompt is showing.
  it('both router re-basers ask before touching anything', () => {
    const stage = fnBody('function rebaseRouterCursors(')
    const global = fnBody('function rebaseGlobalRouterCursor(')
    expect(stage).toContain('if (!routerObservationIsReal(paneId, bufLen, router.bufferAnchors)) return')
    expect(global).toContain('if (!routerObservationIsReal(paneId, bufLen, globalRouterAnchors)) return')
    // Before the anchor is overwritten: storing the fabricated pair would make
    // the NEXT real read compute the bogus trim instead.
    for (const [name, fn] of [['stage router', stage], ['global router', global]] as const) {
      const ask = fn.indexOf('routerObservationIsReal')
      const write = fn.indexOf('Anchors.set(')
      expect(write, `${name}: anchor write`).toBeGreaterThan(-1)
      expect(ask, `${name}: guard before anchor write`).toBeLessThan(write)
    }
  })

  it('refuses a pane with no live terminal, and a counter that went backwards', () => {
    const guard = fnBody('function routerObservationIsReal(')
    expect(guard).toContain('if (!paneRefs[paneId]) return false')
    // cleanBytesSeen is monotonic within one terminal, so backwards means this
    // pane id has a rebuilt terminal behind it and the old indices are void.
    expect(guard).toContain('bytesSeen < anchor.bytesSeen')
    expect(guard).toContain('return false')
    // It re-anchors on the rebuild, but must never move a cursor: that is the
    // whole point of refusing.
    expect(guard).not.toContain('remapCursor')
    expect(guard).not.toContain('droppedPrefix')
  })
})

describe('the Manager router does not read its own kickoff echo as a result', () => {
  it('the kickoff protocol really does carry both sentinels at line start', () => {
    // This is what makes an arm-time floor necessary rather than cosmetic: a
    // TUI that echoes the pasted kickoff back verbatim, without a gutter
    // prefix, puts a findSentinel-matching STAGE-DONE in the buffer before the
    // Manager has done anything at all.
    const protocol = renderManagerProtocol([])
    expect(findSentinel(protocol, MANAGER_STAGE_DONE_SENTINEL, 0)).toBeGreaterThanOrEqual(0)
    expect(findSentinel(protocol, MANAGER_READY_SENTINEL, 0)).toBeGreaterThanOrEqual(0)
    // …and a scan that starts past the protocol sees neither.
    expect(findSentinel(protocol, MANAGER_STAGE_DONE_SENTINEL, protocol.length)).toBe(-1)
  })

  it('anchors a floor for every pane the router tracks', () => {
    const helper = body('function armRouterCursors(', '\nfunction rebaseRouterCursors(')
    expect(helper).toContain('markBufferPosition')
    expect(helper).toContain('router.armedCursors.set(paneId, pos)')
    // Every registration site must arm, or the pane it registers keeps a 0
    // floor and the echo hazard above is live for that spawn path.
    const registrations = appSource.split('ensureStageRouter(index)').length - 1
    expect(registrations).toBeGreaterThan(0)
    expect(appSource.split('armRouterCursors(router,').length - 1).toBe(registrations)
  })

  describe('and the floor is taken in the one window where both risks are avoided', () => {
    const act = body('async function activateStage(', '\nasync function spawnPipelineStage(')
    const inject = kickoffCompletion(act)
    const arm = act.indexOf('armRouterCursors(router, pane.id)')

    it('after the kickoff injection, so the echo stays below the floor', () => {
      // Deliberate ordering, and the direction that must never be "fixed":
      // arming first puts the echoed protocol inside the scan window, and it
      // carries ---STAGE-DONE--- (Manager) and ---ASK-START--- (worker) at line
      // start. That reads the instructions as results and pushes every stage.
      expect(inject, 'the kickoff injection').toBeGreaterThan(-1)
      expect(arm, 'the arm').toBeGreaterThan(inject)
    })

    it('…and before anything that awaits, so a fast worker ASK is not lost', () => {
      // Everything between the two is a window in which a real ASK block can
      // land below the floor, and the router has no fallback for one — it is
      // simply never routed to the Manager. Two WS round trips and a syncViews
      // used to sit in there.
      assertImmediateRouterArm(act)
    })

    it.each(['await sendQuiet("test")', 'syncViews()'])(
      'detects %s inserted before the local result assignment', (statement) => {
        const mutant = act.replace('const ok = kickoffResult.sent', `${statement}\n    const ok = kickoffResult.sent`)
        expect(mutant).not.toBe(act)
        expect(() => assertImmediateRouterArm(mutant)).toThrow()
      },
    )

    it('detects a round trip inserted before the cancellation check', () => {
      const mutant = act.replace('if (kickoffResult.cancelled)', 'await sendQuiet("test")\n    if (kickoffResult.cancelled)')
      expect(mutant).not.toBe(act)
      expect(() => assertImmediateRouterArm(mutant)).toThrow()
    })

    it('…but only when the injection verified its echo', () => {
      // markBufferPosition() flushes pending clean output, so a VERIFIED echo
      // is already below the floor. An unverified one may still be in flight
      // (late paste-ack), and a floor taken below a late echo puts the
      // protocol's sentinels back inside the scan window. Tightening the window
      // shrank the slack this case used to get for free.
      expect(act).toContain('if (ok) armRouterCursors(router, pane.id)')
      // The failure case takes no floor: it ends the run (#448) after the
      // stage is recorded spawned (so a resume continues there) and before a
      // watcher is armed over it.
      expect(act).not.toContain('if (managerSlot && !ok) {')
      const failed = act.indexOf('await failRunOnKickoff(')
      expect(failed, 'the failed-kickoff exit').toBeGreaterThan(-1)
      expect(act.lastIndexOf("sendQuiet<ProjectPayload>('pipeline.stage_spawn'")).toBeLessThan(failed)
      expect(act.indexOf('startStageWatcher(index, pane.id, kickoffScanFrom)', failed)).toBeGreaterThan(failed)
      // Registration with the router is NOT conditional: DISPATCH routing has
      // to know about the pane even when its kickoff never landed.
      const wiring = act.slice(inject, act.indexOf("pane.kickoffStatus = ok ? 'sent' : 'failed'"))
      expect(wiring).toContain('router.workerPaneIds.set(slot.label, pane.id)')
      expect(wiring).not.toContain('if (ok) router.')
    })
  })

  it('scans STAGE-DONE from that floor instead of from 0', () => {
    const scan = body('async function managerRouterScan(', '\nfunction queueOrRouteWorkerMsg(')
    expect(scan).not.toContain(`findSentinel(buf, MANAGER_STAGE_DONE_SENTINEL, 0)`)
    expect(scan).toContain('const doneFrom = router.armedCursors.get(router.managerPaneId) ?? 0')
    expect(scan).toContain('findSentinel(buf, MANAGER_STAGE_DONE_SENTINEL, doneFrom)')
  })

  it('scans MANAGER-READY from the floor, not from the advancing message cursor', () => {
    const scan = body('async function managerRouterScan(', '\nfunction queueOrRouteWorkerMsg(')
    const at = scan.indexOf('MANAGER_READY_SENTINEL')
    expect(at).toBeGreaterThan(-1)
    expect(scan.slice(Math.max(0, at - 400), at)).toContain(
      'const cursor = router.armedCursors.get(router.managerPaneId) ?? 0'
    )
  })
})

describe('a cross-agent handoff does not swallow a sibling sentinel', () => {
  const completed = body('function onStageSlotCompleted(', '\nfunction releaseStageSlot(')

  it('checks the sibling for its own sentinel before advancing its scan window', () => {
    // The sibling was nearly done — the handoff only jumped the queue — so it
    // can print its sentinel inside the settle windows. Advancing past it
    // throws away the only signal it will ever emit.
    const advance = completed.indexOf('sw.scanFrom = len')
    const check = completed.indexOf('const sentinelHit =')
    expect(check).toBeGreaterThan(-1)
    expect(advance).toBeGreaterThan(check)
    expect(completed).toContain("onStageSlotCompleted(sw.stageIndex, sibling.id, 'sentinel')")
  })

  it('keeps the handoff-pollution protection it was written for', () => {
    // The advance exists so the injected handoff text is not read as the
    // sibling's own output (the Stage 04 bug). It must still happen when no
    // sentinel was found.
    expect(completed).toContain('if (len > sw.scanFrom) sw.scanFrom = len')
    expect(completed).toContain('sw.lastAnalyzedBufferLen = len')
  })

  it('applies the same vendor guard the poll loop uses', () => {
    // For verified-turn-text vendors the loose buffer scan is deliberately not
    // authoritative — and they lose nothing, judgeTurnText ignores scanFrom.
    expect(completed).toContain('!TURN_TEXT_VENDORS.has(sVendor)')
  })
})
