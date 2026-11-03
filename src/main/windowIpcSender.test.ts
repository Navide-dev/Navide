import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// index.ts cannot be imported in a unit test (it boots Electron), so the
// sender checks are read from source, as permissionsIpcSender.test.ts does.
const source = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

function handlerBody(channel: string): string {
  const start = source.indexOf(`'${channel}'`)
  expect(start, `a handler for ${channel} should exist`).toBeGreaterThan(-1)
  const next = source.indexOf('ipcMain.handle(', start)
  return source.slice(start, next === -1 ? undefined : next)
}

describe('git, log-search and window-opening IPC is only reachable from an app window', () => {
  // Each one runs git, reads arbitrary log paths, or opens a window: a plugin
  // view, a webview guest or an embedded frame must not be able to.
  for (const channel of [
    'git:diff-head',
    'logs:searchContent',
    'window:openEditor',
    'editor:openFolder',
    'window:openMain',
  ]) {
    it(channel, () => {
      expect(handlerBody(channel)).toMatch(/if \(!isAppWindowSender\(event\)\) return /)
    })
  }
})
