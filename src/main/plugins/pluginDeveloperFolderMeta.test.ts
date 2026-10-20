// DESIGN-A2 §2.0: the developer folder record beside the Developer Mode store.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('forgets one folder and keeps the others', () => {
    const store = new PluginDeveloperFolderMetaStore(root)
    store.setLoadedBy('acme.one', '/dev/one', { kind: 'user' })
    store.setLoadedBy('acme.two', '/dev/two', { kind: 'user' })
    store.forget('acme.one')
    const saved = JSON.parse(readFileSync(join(root, FILE), 'utf8')) as { folders: Record<string, unknown> }
    expect(Object.keys(saved.folders)).toEqual(['acme.two'])
  })
})
