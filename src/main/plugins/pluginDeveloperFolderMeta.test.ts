// DESIGN-A2 §2.0: the developer folder record beside the Developer Mode store.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { PluginDeveloperFolderMetaStore } from './pluginDeveloperFolderMeta'

const FILE = '.navide-plugin-developer-folders-meta.json'
let root = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-devmeta-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('PluginDeveloperFolderMetaStore', () => {
  it('reads a folder it has no record of as loaded by an unknown party, reloading on changes', () => {
    expect(new PluginDeveloperFolderMetaStore(root).get('acme.todo', '/dev/todo'))
      .toEqual({ path: '/dev/todo', loadedBy: { kind: 'unknown' }, autoReload: true })
  })

  it('keeps who loaded it, the auto-reload choice and the last load', () => {
    const store = new PluginDeveloperFolderMetaStore(root)
    store.setLoadedBy('acme.todo', '/dev/todo', { kind: 'agent', callerKind: 'pane', paneName: 'builder', approvedAt: '2026-10-21T01:00:00.000Z' })
    store.setAutoReload('acme.todo', '/dev/todo', false)
    store.recordLoad('acme.todo', '/dev/todo', { at: '2026-10-21T01:01:00.000Z', trigger: 'user-load' })
    expect(new PluginDeveloperFolderMetaStore(root).get('acme.todo', '/dev/todo')).toEqual({
      path: '/dev/todo',
      loadedBy: { kind: 'agent', callerKind: 'pane', paneName: 'builder', approvedAt: '2026-10-21T01:00:00.000Z' },
      autoReload: false,
      lastLoad: { at: '2026-10-21T01:01:00.000Z', trigger: 'user-load' },
    })
  })

  it('reads a record of another folder of the same id as the default', () => {
    const store = new PluginDeveloperFolderMetaStore(root)
    store.setLoadedBy('acme.todo', '/dev/todo', { kind: 'user' })
    expect(store.get('acme.todo', '/dev/other')).toEqual({ path: '/dev/other', loadedBy: { kind: 'unknown' }, autoReload: true })
  })

  it('shows the default for a damaged file or entry and never throws', () => {
    writeFileSync(join(root, FILE), '{not json')
    const store = new PluginDeveloperFolderMetaStore(root)
    expect(store.get('acme.todo', '/dev/todo').loadedBy).toEqual({ kind: 'unknown' })
    writeFileSync(join(root, FILE), JSON.stringify({
      schemaVersion: 1,
      folders: {
        'acme.bad': { path: '/dev/bad', loadedBy: { kind: 'robot' }, autoReload: true },
        'acme.good': { path: '/dev/good', loadedBy: { kind: 'user' }, autoReload: false },
      },
    }))
    expect(store.get('acme.bad', '/dev/bad').loadedBy).toEqual({ kind: 'unknown' })
    expect(store.get('acme.good', '/dev/good')).toMatchObject({ loadedBy: { kind: 'user' }, autoReload: false })
  })

  it('review MED-2 on #536: a write that fails never throws (a directory where the file belongs)', () => {
    mkdirSync(join(root, FILE))
    const store = new PluginDeveloperFolderMetaStore(root)
    expect(() => store.setLoadedBy('acme.todo', '/dev/todo', { kind: 'user' })).not.toThrow()
    expect(() => store.recordLoad('acme.todo', '/dev/todo', { at: '2026-10-21T01:00:00.000Z', trigger: 'startup' })).not.toThrow()
    expect(() => store.setAutoReload('acme.todo', '/dev/todo', false)).not.toThrow()
    expect(store.get('acme.todo', '/dev/todo').loadedBy).toEqual({ kind: 'unknown' })
  })

  it('forgets one folder and keeps the others', () => {
    const store = new PluginDeveloperFolderMetaStore(root)
    store.setLoadedBy('acme.one', '/dev/one', { kind: 'user' })
    store.setLoadedBy('acme.two', '/dev/two', { kind: 'user' })
    store.forget('acme.one')
    const saved = JSON.parse(readFileSync(join(root, FILE), 'utf8')) as { folders: Record<string, unknown> }
    expect(Object.keys(saved.folders)).toEqual(['acme.two'])
  })
})

describe('signed loader record (review MED-1 on #536)', () => {
  const signer = { entryMac: (entry: string) => createHmac('sha256', 'test-key').update(entry).digest('hex') }
  const agent = { kind: 'agent', callerKind: 'pane', paneName: 'builder', approvedAt: '2026-10-21T01:00:00.000Z' } as const
  const rewrite = (change: (folders: Record<string, Record<string, unknown>>) => void) => {
    const saved = JSON.parse(readFileSync(join(root, FILE), 'utf8')) as { schemaVersion: 1; folders: Record<string, Record<string, unknown>> }
    change(saved.folders)
    writeFileSync(join(root, FILE), JSON.stringify(saved))
  }

  it('reads a record Navide signed as written, through later loads and switches', () => {
    const store = new PluginDeveloperFolderMetaStore(root, signer)
    store.setLoadedBy('acme.todo', '/dev/todo', agent)
    store.recordLoad('acme.todo', '/dev/todo', { at: '2026-10-21T01:01:00.000Z', trigger: 'auto-reload' })
    store.setAutoReload('acme.todo', '/dev/todo', false)
    expect(new PluginDeveloperFolderMetaStore(root, signer).get('acme.todo', '/dev/todo')).toMatchObject({ loadedBy: agent, autoReload: false })
    expect(store.get('acme.todo', '/dev/todo').loadedByUnverified).toBeUndefined()
  })

  it('reads a loader another program rewrote, or an unsigned one, as unknown and says it may have been changed', () => {
    const store = new PluginDeveloperFolderMetaStore(root, signer)
    store.setLoadedBy('acme.todo', '/dev/todo', agent)
    rewrite((folders) => { folders['acme.todo']!.loadedBy = { kind: 'user' } })
    expect(store.get('acme.todo', '/dev/todo')).toMatchObject({ loadedBy: { kind: 'unknown' }, loadedByUnverified: true })
    rewrite((folders) => { delete folders['acme.todo']!.loadedByMac; folders['acme.todo']!.loadedBy = agent })
    expect(store.get('acme.todo', '/dev/todo')).toMatchObject({ loadedBy: { kind: 'unknown' }, loadedByUnverified: true })
  })

  it('a signature moved to another folder or id does not verify', () => {
    const store = new PluginDeveloperFolderMetaStore(root, signer)
    store.setLoadedBy('acme.one', '/dev/one', { kind: 'user' })
    store.setLoadedBy('acme.two', '/dev/two', agent)
    rewrite((folders) => { folders['acme.two']!.loadedBy = { kind: 'user' }; folders['acme.two']!.loadedByMac = folders['acme.one']!.loadedByMac })
    expect(store.get('acme.two', '/dev/two')).toMatchObject({ loadedBy: { kind: 'unknown' }, loadedByUnverified: true })
  })

  it('without a key (no secure storage) the record reads as written, as before', () => {
    const store = new PluginDeveloperFolderMetaStore(root, { entryMac: () => null })
    store.setLoadedBy('acme.todo', '/dev/todo', agent)
    rewrite((folders) => { folders['acme.todo']!.loadedBy = { kind: 'user' } })
    expect(store.get('acme.todo', '/dev/todo')).toMatchObject({ loadedBy: { kind: 'user' } })
    expect(store.get('acme.todo', '/dev/todo').loadedByUnverified).toBeUndefined()
  })
})
