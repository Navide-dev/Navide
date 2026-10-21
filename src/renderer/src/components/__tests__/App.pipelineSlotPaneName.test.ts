// @vitest-environment happy-dom
// #448 (0.2.27 re-test): every pipeline slot pane was auto-titled from its
// first reply or its role prompt. The title is also the pane's messaging
// handle, so slots sharing a role collided ("…-2") and a kickoff saying
// "message 畫師" pointed at a name that no longer existed. A slot pane keeps
// its slot label: no auto-title, and no model call that would store one.
//
// App.vue cannot be mounted here, so both functions are lifted out, compiled
// and run against stubs passed by name.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end + 2)
}

async function load(slotLabel: string) {
  const { code } = await transformWithEsbuild(
    `${functionSource('setPaneAutoName')}\n${functionSource('requestLlmPaneName')}\nreturn { setPaneAutoName, requestLlmPaneName }`,
    'AppSlotPaneName.ts',
    { loader: 'ts' },
  )
  const pane: Record<string, unknown> = {
    id: 'p1', agentKey: 'codex', slotLabel, workspacePath: '/ws', messagingName: slotLabel || 'codex-1',
  }
  const backend = { send: vi.fn(async () => ({ ok: true, payload: { ok: true, name: 'model title', changed: true } })) }
  const messaging = { setDerivedName: vi.fn((_id: string, name: string) => name) }
  const deps: Record<string, unknown> = {
    panes: { value: [pane] },
    spawnHistory: { value: [] },
    messaging,
    persistMessagingName: vi.fn(),
    mirrorMessagingHandle: vi.fn(),
    syncViews: vi.fn(),
    backend,
    llmNameRequested: new Set<string>(),
    stripCliSessionContext: (s: string) => s,
    analyzerModel: { value: '' },
  }
  const api = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
    setPaneAutoName: (id: string, name: string, source?: 'heuristic' | 'llm') => void
    requestLlmPaneName: (id: string, material: string) => void
  }
  return { api, pane, backend, messaging }
}

describe('a pipeline slot pane keeps its slot label as its name (#448)', () => {
  it('is not auto-titled, so its messaging handle stays the slot label', async () => {
    const t = await load('畫師')
    t.api.setPaneAutoName('p1', '你是繪本插圖製作團隊的一員')
    expect(t.pane.autoName).toBeUndefined()
    expect(t.pane.messagingName).toBe('畫師')
    expect(t.messaging.setDerivedName).not.toHaveBeenCalled()
    expect(t.backend.send).not.toHaveBeenCalled()
  })

  it('never asks the model for a title the backend would store', async () => {
    const t = await load('審稿')
    t.api.requestLlmPaneName('p1', '你是繪本插圖製作團隊的一員')
    await Promise.resolve()
    expect(t.backend.send).not.toHaveBeenCalled()
  })

  it('a pane outside a pipeline is still auto-titled', async () => {
    const t = await load('')
    t.api.setPaneAutoName('p1', 'Fix the login bug')
    expect(t.pane.autoName).toBe('Fix the login bug')
    expect(t.pane.messagingName).toBe('Fix the login bug')
    t.api.requestLlmPaneName('p1', 'Fix the login bug')
    expect(t.backend.send).toHaveBeenCalled()
  })
})
