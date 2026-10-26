// DESIGN-A2 G1: the folder watch behind automatic reload.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEVELOPER_FOLDER_BUILD_MARKER,
  developerFolderBuildGate,
  ignoredDeveloperFolderChange,
  watchDeveloperFolder,
  type FolderWatch,
} from './pluginDeveloperWatch'

let dir = ''
let watched: FolderWatch | null = null

afterEach(() => {
  watched?.close()
  watched = null
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('ignoredDeveloperFolderChange', () => {
  it('ignores version control writes only', () => {
    expect(ignoredDeveloperFolderChange('.git/index')).toBe(true)
    expect(ignoredDeveloperFolderChange('sub\\.git\\HEAD')).toBe(true)
    expect(ignoredDeveloperFolderChange('frontend/left/index.html')).toBe(false)
    expect(ignoredDeveloperFolderChange('.gitignore')).toBe(false)
    expect(ignoredDeveloperFolderChange(null)).toBe(false)
  })
})

describe('watchDeveloperFolder', () => {
  it('calls once after a burst of writes in nested folders settles, and never after close', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'navide-devwatch-')))
    mkdirSync(join(dir, 'frontend', 'left'), { recursive: true })
    const onChange = vi.fn()
    watched = watchDeveloperFolder(dir, onChange)
    // Real file system events: a watch that has just started can miss the
    // first writes (macOS FSEvents), and under load events take seconds. Keep
    // writing bursts until one arrives, then check that a burst is one call.
    let i = 0
    await vi.waitFor(() => {
      for (let n = 0; n < 5; n++) writeFileSync(join(dir, 'frontend', 'left', 'index.html'), `<p>${i++}</p>`)
      expect(onChange).toHaveBeenCalled()
    }, { timeout: 20_000, interval: 1_000 })
    onChange.mockClear()
    for (let n = 0; n < 5; n++) writeFileSync(join(dir, 'frontend', 'left', 'index.html'), `<p>burst ${n}</p>`)
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 15_000, interval: 50 })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(onChange).toHaveBeenCalledTimes(1)
    onChange.mockClear()

    watched.close()
    writeFileSync(join(dir, 'frontend', 'left', 'index.html'), '<p>after</p>')
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(onChange).not.toHaveBeenCalled()
  }, 60_000)
})

describe('developerFolderBuildGate (plan 4a05af P1)', () => {
  const mark = (seconds: number) => {
    const marker = join(dir, DEVELOPER_FOLDER_BUILD_MARKER)
    writeFileSync(marker, '')
    utimesSync(marker, seconds, seconds)
  }

  it('lets every change reload a folder that has no marker, as before', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'navide-devgate-')))
    const gate = developerFolderBuildGate(dir)
    expect([gate(), gate(), gate()]).toEqual([true, true, true])
  })

  it('once the folder has a marker, reloads only when a newer marker is written', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'navide-devgate-')))
    mark(1_000)
    const gate = developerFolderBuildGate(dir)
    // The build is writing: files change, the marker does not.
    expect([gate(), gate()]).toEqual([false, false])
    // A build that cleans its output removes the marker first.
    rmSync(join(dir, DEVELOPER_FOLDER_BUILD_MARKER))
    expect(gate()).toBe(false)
    mark(2_000)
    expect(gate()).toBe(true)
    expect(gate()).toBe(false)
  })

  it('switches to waiting for the marker when one first appears', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'navide-devgate-')))
    const gate = developerFolderBuildGate(dir)
    expect(gate()).toBe(true)
    mark(1_000)
    expect(gate()).toBe(true)
    expect(gate()).toBe(false)
  })
})
