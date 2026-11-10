// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const store = vi.hoisted(() => ({}) as Record<string, unknown>)
vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  settingsGet: (key: string, fallback: unknown) => (key in store ? store[key] : fallback),
  settingsSet: (key: string, value: unknown) => { store[key] = value },
  onSettingsChanged: () => () => {},
  settingsReady: () => Promise.resolve(),
}))

import { AGENT_IDENTITIES_KEY, createAgentConsole } from '../useAgentConsole'
import type { SchedulerJob } from '../../lib/schedulerJobs'

function fakeBackend() {
  const handlers = new Map<string, (p: unknown) => void>()
  return {
    on: (type: string, cb: (p: unknown) => void) => { handlers.set(type, cb); return () => handlers.delete(type) },
    emit: (type: string, p: unknown) => handlers.get(type)?.(p),
    send: vi.fn(async (_type: string, _payload: unknown) => ({ ok: true, payload: NOTES })),
  }
}

function job(id: string, action: Partial<SchedulerJob['action']>, extra: Partial<SchedulerJob> = {}): SchedulerJob {
  return {
    id,
    name: id,
    enabled: true,
    schedule: { kind: 'daily', at: '08:30', tz: 'Asia/Taipei' },
    action: { kind: 'message', workspace: '/w', ...action },
    ...extra,
  } as SchedulerJob
}

const NOTES = {
  agent_key: 'hermes',
  memory: { status: 'ok', root: '/fake/memories', entries: [{ name: 'MEMORY.md', path: '/fake/memories/MEMORY.md', modified_at: 1, preview: 'x' }] },
  todos: { status: 'unsupported', root: '', entries: [] },
}

async function make(jobs: SchedulerJob[] = []) {
  const backend = fakeBackend()
  const scheduler = { jobs: ref(jobs), runNow: vi.fn(async () => {}), refresh: vi.fn(async () => {}) }
  const setJobEnabled = vi.fn(async () => true)
  const upsertJob = vi.fn(async (j: { id: string }) => j.id !== 'bad')
  const api = createAgentConsole(backend as never, scheduler as never, { openSettings: vi.fn(), setJobEnabled, upsertJob })
  await new Promise((r) => setTimeout(r, 0))
  return { api, backend, scheduler, setJobEnabled, upsertJob }
}

const pane = (paneId: string, name = 'Secretary') => ({ paneId, name, agentKey: 'hermes', workspacePath: '/w' })

describe('agent console – identities', () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

  it('gives a new agent pane an identity and stores it', async () => {
    const { api } = await make()
    api.reconcile([pane('p1')])
    const a = api.identityForPane('p1')
    expect(a).toMatchObject({ name: 'Secretary', agentKey: 'hermes', paneId: 'p1' })
    expect((store[AGENT_IDENTITIES_KEY] as unknown[]).length).toBe(1)
  })

  it('keeps the identity when its pane closes, and reattaches a reopened pane by name', async () => {
    const { api } = await make()
    api.reconcile([pane('p1')])
    const id = api.identityForPane('p1')!.id
    api.reconcile([])
    expect(api.identities.value).toMatchObject([{ id, paneId: null }])
    api.reconcile([pane('p2')])
    expect(api.identityForPane('p2')?.id).toBe(id)
    expect(api.identities.value).toHaveLength(1)
  })

  it('follows a rename and a detected session id of the linked pane', async () => {
    const { api } = await make()
    api.reconcile([pane('p1')])
    api.reconcile([{ ...pane('p1', 'Researcher'), sessionId: 'navide-1' }])
    expect(api.identityForPane('p1')).toMatchObject({ name: 'Researcher', sessionId: 'navide-1' })
  })

  it('gives two agents different colours', async () => {
    const { api } = await make()
    api.reconcile([pane('p1', 'A'), pane('p2', 'B')])
    expect(api.identityForPane('p1')!.color).not.toBe(api.identityForPane('p2')!.color)
  })
})

describe('agent console – turn clock', () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

  it('reads turn start and end from agent.activity', async () => {
    const { api, backend } = await make()
    api.reconcile([pane('p1')])
    backend.emit('agent.activity', { pane_id: 'p1', event_type: 'agent_active', detail: 'user', timestamp: '2026-11-10T04:00:00Z' })
    expect(api.turnFor('p1').startedAt).toBe(Date.parse('2026-11-10T04:00:00Z'))
    backend.emit('agent.activity', { pane_id: 'p1', event_type: 'turn_complete', timestamp: '2026-11-10T04:02:00Z' })
    expect(api.turnFor('p1')).toEqual({ startedAt: null, endedAt: Date.parse('2026-11-10T04:02:00Z') })
  })

  it('ignores panes that are not agent panes', async () => {
    const { api, backend } = await make()
    backend.emit('agent.activity', { pane_id: 'cli', event_type: 'turn_complete', timestamp: '2026-11-10T04:02:00Z' })
    expect(api.turnFor('cli')).toEqual({ startedAt: null, endedAt: null })
  })
})

describe('agent console – schedules', () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

  it('matches jobs by pane id, and by name only when the job names no id', async () => {
    const { api } = await make([
      job('by-id', { pane_id: 'p1' }),
      job('by-name', { pane_name: 'Secretary' }),
      job('other-id', { pane_id: 'p9', pane_name: 'Secretary' }),
      job('pipeline', { kind: 'pipeline_start' }),
    ])
    expect(api.jobsFor('p1', 'Secretary').map((j) => j.id)).toEqual(['by-id', 'by-name'])
  })

  it('wakes with the enabled job that runs next', async () => {
    const { api, scheduler } = await make([
      job('late', { pane_id: 'p1' }, { state: { next_run_at: 200 } }),
      job('soon', { pane_id: 'p1' }, { state: { next_run_at: 100 } }),
      job('off', { pane_id: 'p1' }, { enabled: false, state: { next_run_at: 50 } }),
    ])
    expect(await api.wakeNow('p1', 'Secretary')).toBe(true)
    expect(scheduler.runNow).toHaveBeenCalledWith(expect.objectContaining({ id: 'soon' }))
  })

  it('has nothing to wake with when no job is enabled', async () => {
    const { api, scheduler } = await make([job('off', { pane_id: 'p1' }, { enabled: false })])
    expect(await api.wakeNow('p1', 'Secretary')).toBe(false)
    expect(scheduler.runNow).not.toHaveBeenCalled()
  })

  it('pauses only the enabled jobs, then re-reads the list', async () => {
    const { api, setJobEnabled, scheduler } = await make([
      job('on', { pane_id: 'p1' }),
      job('off', { pane_id: 'p1' }, { enabled: false }),
    ])
    await api.setSchedulesPaused('p1', 'Secretary', true)
    expect(setJobEnabled.mock.calls).toEqual([['on', false]])
    expect(scheduler.refresh).toHaveBeenCalled()
  })
})

describe('agent console – memory and todos', () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

  it('reads agent.notes per vendor and keeps the answer', async () => {
    const { api, backend } = await make()
    expect(api.notesFor('hermes')).toBeNull()
    await api.refreshNotes('hermes')
    expect(backend.send).toHaveBeenCalledWith('agent.notes', { agent_key: 'hermes', limit: 5 })
    expect(api.notesFor('hermes')?.memory.entries[0].name).toBe('MEMORY.md')
  })

  it('does not ask for a CLI vendor', async () => {
    const { api, backend } = await make()
    await api.refreshNotes('claude')
    expect(backend.send).not.toHaveBeenCalled()
  })

  it('re-reads after a finished turn only for a vendor already loaded', async () => {
    const { api, backend } = await make()
    api.reconcile([pane('p1')])
    backend.emit('agent.activity', { pane_id: 'p1', event_type: 'turn_complete', timestamp: '2026-11-10T01:00:00Z' })
    expect(backend.send).not.toHaveBeenCalled()
    await api.refreshNotes('hermes')
    backend.emit('agent.activity', { pane_id: 'p1', event_type: 'turn_complete', timestamp: '2026-11-10T01:05:00Z' })
    expect(backend.send).toHaveBeenCalledTimes(2)
  })
})

describe('agent console – rename retargeting', () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

  it('finds message jobs that address the name, whatever pane id they carry', async () => {
    const { api } = await make([
      job('a', { pane_name: 'Secretary' }),
      job('b', { pane_name: 'Secretary', pane_id: 'p9' }),
      job('c', { pane_name: 'Other' }),
      job('d', { pane_id: 'p1' }),
    ])
    expect(api.jobsNamed('Secretary').map((j) => j.id)).toEqual(['a', 'b'])
    expect(api.jobsNamed('')).toEqual([])
  })

  it('upserts only the action with the new name and reports the failures', async () => {
    const jobs = [job('a', { pane_name: 'Secretary', text: 'hi' }), job('bad', { pane_name: 'Secretary', text: 'yo' })]
    const { api, upsertJob, scheduler } = await make(jobs)
    const failed = await api.retargetJobs(jobs, 'Assistant')
    expect(upsertJob).toHaveBeenCalledWith({ id: 'a', action: { kind: 'message', workspace: '/w', pane_name: 'Assistant', text: 'hi' } })
    expect(failed).toEqual(['bad'])
    expect(scheduler.refresh).toHaveBeenCalled()
  })
})
