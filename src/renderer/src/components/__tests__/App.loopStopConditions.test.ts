// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { loopBackoffMs, loopInjectFailures, LOOP_INJECT_FAIL_LIMIT } from '../../lib/completion'

// The App.vue half of the loop's stop conditions (F1, F4, F5, F6). The real
// App functions run with IO replaced at their boundaries, the way
// App.quotaFailover.behavior.test.ts does it; the pure parts are covered in
// lib/__tests__/loopStopConditions.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const source = parse(appSource).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
const NAMES = ['fireLoopContinue', 'stopLoopSpinning', 'armLoopTurn', 'onInterrupt', 'batchInterrupt', 'onEvolveAction']

function appFunctions(scope: Record<string, unknown>) {
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && NAMES.includes(node.name?.text ?? ''))
  expect(selected).toHaveLength(NAMES.length)
  const js = ts.transpileModule(selected.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(scope), `${js}\nreturn { ${NAMES.join(',')} }`)(...Object.values(scope)) as Record<string, (...args: any[]) => any>
}

function harness() {
  const panes = ref([{
    id: 'p1', realized: true, loopActive: true, loopWaitUntil: null as number | null,
    loopEstimateResetAt: 0 as number | null, loopSkillId: 'loop' as string | null,
    loopTurnCount: 0, loopMaxTurns: 0,
    quotaGateIncidentId: null as string | null, resumeContinueAvailable: false,
  }])
  const pane = panes.value[0]
  const watcher: Record<string, any> = {
    armedAt: 1, continuing: false, continues: 0, stalledRuns: 0, nextContinueAt: 0,
    toolUsesThisTurn: 0, emptyCharged: false, toolJudged: false, injectFailures: 0,
  }
  const loopLimitWatchers = new Map([['p1', watcher]])
  const loopGen = new Map([['p1', 1]])
  const acquire = vi.fn(async () => {})
  const inject = vi.fn(async (..._args: any[]) => true)
  const notify = vi.fn()
  const interrupt = vi.fn(async () => true)
  const persistPaneStopped = vi.fn()
  const scope = {
    panes, loopLimitWatchers, loopGen,
    acquireInjectionSlot: acquire, releaseInjectionSlot: vi.fn(), injectPane: inject,
    withLoopDoneInstruction: (s: string) => s, loopResumeTextFor: () => '繼續',
    stopLoopComplete: vi.fn(), loopBackoffMs, LOOP_ESTIMATE_WINDOW_MS: 18_000_000,
    loopInjectFailures, LOOP_INJECT_FAIL_LIMIT,
    bumpLoopGen: (id: string) => { const g = (loopGen.get(id) ?? 0) + 1; loopGen.set(id, g); return g },
    stopLoopLimitWatcher: (id: string) => { loopLimitWatchers.delete(id) },
    sysNotify: { notifyPaneState: notify }, i18n: { global: { t: (k: string) => k } },
    paneRefs: { p1: { sessionId: 's1', interrupt } }, persistPaneStopped,
    closePopover: vi.fn(), focusPaneFromNotification: vi.fn(), reclaimPaneFromMenu: vi.fn(), evolve: { openPanel: vi.fn() },
    acp: { owns: () => false }, // lib/acpHost.ts: no ACP pane here
  }
  return { pane, watcher, loopLimitWatchers, loopGen, acquire, inject, notify, interrupt, persistPaneStopped, fns: appFunctions(scope) }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => { vi.useRealTimers() })

describe('F4: only the loop-done check is widened', () => {
  it('the done-marker handler uses the decorated matcher; LOOP_WAIT and stage sentinels stay exact', () => {
    expect(source).toContain('turnEndsWithLoopDone(ev.text, LOOP_DONE_MARKER)')
    expect(source).not.toContain('turnEndsWithSentinel(ev.text, LOOP_DONE_MARKER)')
    expect(source).toContain('turnEndsWithSentinel(text, LOOP_WAIT_MARKER)')
    expect(source).toContain('turnEndsWithSentinel(text, stage.sentinel)')
    expect(source.match(/turnEndsWithLoopDone\(/g)).toHaveLength(1)
  })
})

describe('F5: the continue arms at injection start, after the slot is held', () => {
  it('arms with the time the inject started, not the time it returned', async () => {
    const h = harness()
    h.acquire.mockImplementationOnce(async () => { vi.setSystemTime(20_000) })
    h.inject.mockImplementationOnce(async () => { vi.setSystemTime(25_000); return true })
    await h.fns.fireLoopContinue('p1')
    expect(h.watcher.armedAt).toBe(20_000)
  })

  it('time spent queued for the injection slot is not inside the arm window', async () => {
    const h = harness()
    // Queued 10s behind other panes: the arm must not reach back to 10_000.
    h.acquire.mockImplementationOnce(async () => { vi.setSystemTime(20_000) })
    await h.fns.fireLoopContinue('p1')
    expect(h.watcher.armedAt).toBeGreaterThanOrEqual(20_000)
  })

  it('a failed inject keeps the previous arm, so the next poll retries as on main', async () => {
    const h = harness()
    h.inject.mockResolvedValueOnce(false)
    await h.fns.fireLoopContinue('p1')
    expect(h.watcher.armedAt).toBe(1)
  })

  it('armLoopTurn without a time arms at now (loop-start, skill-cast, resume)', () => {
    const h = harness()
    h.fns.armLoopTurn('p1')
    expect(h.watcher.armedAt).toBe(10_000)
  })
})

describe('F6: three failed continues in a row stop the loop', () => {
  it('stops, turns the loop off and notifies on the third consecutive failure', async () => {
    const h = harness()
    h.inject.mockResolvedValue(false)
    await h.fns.fireLoopContinue('p1')
    await h.fns.fireLoopContinue('p1')
    expect(h.pane.loopActive).toBe(true)
    expect(h.watcher.injectFailures).toBe(2)
    await h.fns.fireLoopContinue('p1')
    expect(h.pane.loopActive).toBe(false)
    expect(h.loopLimitWatchers.has('p1')).toBe(false)
    expect(h.notify).toHaveBeenCalledWith('p1', 'attention', 'pane.terminal.loop-inject-failed-notify-title', 'pane.terminal.loop-inject-failed-notify-body')
  })

  it('one success resets the count', async () => {
    const h = harness()
    h.inject.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    for (let i = 0; i < 5; i++) await h.fns.fireLoopContinue('p1')
    expect(h.pane.loopActive).toBe(true)
    expect(h.watcher.injectFailures).toBe(2)
  })

  it('an inject cancelled by a quota hold is not counted', async () => {
    const h = harness()
    h.inject.mockImplementation(async (...args: any[]) => {
      h.pane.quotaGateIncidentId = 'inc'
      expect(args[4]()).toBe(true)
      return false
    })
    for (let i = 0; i < 3; i++) {
      await h.fns.fireLoopContinue('p1')
      h.pane.quotaGateIncidentId = null
    }
    expect(h.watcher.injectFailures).toBe(0)
    expect(h.pane.loopActive).toBe(true)
  })
})

describe('F1: interrupting a pane stops its loop', () => {
  it('turns the loop off, notifies, and still sends the interrupt', async () => {
    const h = harness()
    expect(await h.fns.onInterrupt('p1')).toBe(true)
    expect(h.pane.loopActive).toBe(false)
    expect(h.notify).toHaveBeenCalledWith('p1', 'attention', 'pane.terminal.loop-interrupted-notify-title', 'pane.terminal.loop-interrupted-notify-body')
    expect(h.interrupt).toHaveBeenCalledTimes(1)
    expect(h.persistPaneStopped).toHaveBeenCalledWith('p1', true)
  })

  it('a later turn_complete cannot send a continue', async () => {
    const h = harness()
    await h.fns.onInterrupt('p1')
    await h.fns.fireLoopContinue('p1')
    expect(h.inject).not.toHaveBeenCalled()
  })

  it('an explicit interrupt from an agent (ui.pane.interrupt) stops the loop', async () => {
    // ui.pane.interrupt calls onInterrupt(paneId) with no options.
    expect(source).toContain('const sent = await onInterrupt(paneId)\n')
    const h = harness()
    await h.fns.onInterrupt('p1')
    expect(h.pane.loopActive).toBe(false)
  })

  it('a batch interrupt keeps the loop running', async () => {
    const h = harness()
    await h.fns.batchInterrupt(['p1'])
    expect(h.interrupt).toHaveBeenCalledTimes(1)
    expect(h.pane.loopActive).toBe(true)
    expect(h.loopLimitWatchers.has('p1')).toBe(true)
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('an evolve interrupt keeps the loop running', async () => {
    const h = harness()
    h.fns.onEvolveAction({ kind: 'evolve-interrupt', paneId: 'p1' })
    await vi.waitFor(() => expect(h.interrupt).toHaveBeenCalledTimes(1))
    expect(h.pane.loopActive).toBe(true)
    expect(h.loopLimitWatchers.has('p1')).toBe(true)
    expect(h.notify).not.toHaveBeenCalled()
  })

  // Idle = the loop is between turns (backoff / LOOP_WAIT) and the interrupt
  // key lands on a CLI with nothing running; busy = a turn is in progress.
  const STATES = {
    busy: (h: ReturnType<typeof harness>) => { h.interrupt.mockResolvedValue(true) },
    idle: (h: ReturnType<typeof harness>) => {
      h.interrupt.mockResolvedValue(false)
      h.watcher.nextContinueAt = Date.now() + 60_000
      h.pane.loopWaitUntil = Date.now() + 60_000
    },
  }

  it.each(Object.keys(STATES))('an explicit interrupt stops the loop while %s', async (state) => {
    const h = harness()
    STATES[state as keyof typeof STATES](h)
    await h.fns.onInterrupt('p1')
    expect(h.pane.loopActive).toBe(false)
    expect(h.loopLimitWatchers.has('p1')).toBe(false)
  })

  it.each(Object.keys(STATES))('batch and evolve interrupts keep the loop while %s', async (state) => {
    for (const run of [
      (h: ReturnType<typeof harness>) => h.fns.batchInterrupt(['p1']),
      async (h: ReturnType<typeof harness>) => {
        h.fns.onEvolveAction({ kind: 'evolve-interrupt', paneId: 'p1' })
        await vi.waitFor(() => expect(h.interrupt).toHaveBeenCalledTimes(1))
      },
    ]) {
      const h = harness()
      STATES[state as keyof typeof STATES](h)
      await run(h)
      expect(h.interrupt).toHaveBeenCalledTimes(1)
      expect(h.pane.loopActive).toBe(true)
      expect(h.loopLimitWatchers.has('p1')).toBe(true)
    }
  })

  it('a pane without an active loop is interrupted exactly as before', async () => {
    const h = harness()
    h.pane.loopActive = false
    const gen = h.loopGen.get('p1')
    expect(await h.fns.onInterrupt('p1')).toBe(true)
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.loopGen.get('p1')).toBe(gen)
    expect(h.interrupt).toHaveBeenCalledTimes(1)
    expect(h.persistPaneStopped).toHaveBeenCalledWith('p1', true)
  })
})

describe('notifications exist in every locale', () => {
  it.each(['en-US', 'ja-JP', 'zh-TW'])('%s', (name) => {
    const locale = JSON.parse(readFileSync(resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${name}.json`), 'utf8'))
    for (const key of ['loop-inject-failed-notify-title', 'loop-inject-failed-notify-body', 'loop-interrupted-notify-title', 'loop-interrupted-notify-body']) {
      expect(locale.pane.terminal[key]).toBeTruthy()
    }
  })
})
