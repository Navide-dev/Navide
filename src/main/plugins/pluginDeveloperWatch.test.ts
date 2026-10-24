// DESIGN-A2 G1: the folder watch behind automatic reload.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ignoredDeveloperFolderChange, watchDeveloperFolder, type FolderWatch } from './pluginDeveloperWatch'

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
