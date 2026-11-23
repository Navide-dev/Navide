import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PANE_RECORD_WRITE_FAILED,
  WORKSPACE_CHECK_GAVE_UP,
  notePaneRecordWrite,
  workspaceCheckGaveUp,
} from '../restoreDiagnostics'

const pane = { workspacePath: '/Users/a/wh/wm', name: 'm1', paneId: 'p-1' }

describe('notePaneRecordWrite', () => {
  it('records nothing when the record was saved', async () => {
    const record = vi.fn()
    await notePaneRecordWrite(Promise.resolve({ project: {} }), pane, record)
    expect(record).not.toHaveBeenCalled()
  })

  it('records a refused or timed-out write (sendQuiet answers null)', async () => {
    const record = vi.fn()
    await notePaneRecordWrite(Promise.resolve(null), pane, record)
    expect(record).toHaveBeenCalledWith({
      level: 'warn',
      code: PANE_RECORD_WRITE_FAILED,
      message: 'pane "m1" in /Users/a/wh/wm: its record was not saved (refused or timed out); it will not be restored after a restart',
      paneId: 'p-1',
    })
  })

  it('records a write that threw, by error name only', async () => {
    const record = vi.fn()
    await notePaneRecordWrite(Promise.reject(new TypeError('token=abc')), pane, record)
    expect(record.mock.calls[0][0].message).toContain('(TypeError)')
    expect(record.mock.calls[0][0].message).not.toContain('token')
  })
})

describe('workspaceCheckGaveUp', () => {
  it('names the workspace and the attempts', () => {
    expect(workspaceCheckGaveUp('/Users/a/wh/wm', 5)).toEqual({
      level: 'warn',
      code: WORKSPACE_CHECK_GAVE_UP,
      message: '/Users/a/wh/wm: project.peek failed 5 times; its panes were not restored',
    })
  })
})

describe('App.vue wiring', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

  function functionSource(name: string): string {
    const start = app.search(new RegExp(`(?:async )?function ${name}\\(`))
    expect(start, `${name} should exist`).toBeGreaterThan(-1)
    return app.slice(start, app.indexOf('\n}\n', start))
  }

  it('an external cli_open_agent pane notes a record write that failed', () => {
    const body = functionSource('createStandaloneRequestedPane')
    expect(body).toMatch(/void notePaneRecordWrite\(sendQuiet<ProjectPayload>\('manual_pane\.spawn'/)
    expect(body).not.toMatch(/void sendQuiet<ProjectPayload>\('manual_pane\.spawn'/)
  })

  it('a workspace check out of retries is recorded before it falls through', () => {
    const body = functionSource('onWorkspaceCheck')
    const retry = body.indexOf('workspaceCheckRetries < WORKSPACE_CHECK_MAX_RETRIES')
    const gaveUp = body.indexOf('recordDiagnostic(workspaceCheckGaveUp(path, workspaceCheckRetries + 1))')
    expect(retry).toBeGreaterThan(-1)
    expect(gaveUp).toBeGreaterThan(retry)
    expect(gaveUp).toBeLessThan(body.indexOf('workspaceCheckRetries = 0'))
  })
})
