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

describe('git account IPC is only reachable from an app window', () => {
  // These add, remove and rebind the accounts whose tokens git operations use.
  // A plugin webview or an embedded frame must not be able to; plugins reach
  // the store through the main-process adapter, not through this IPC.
  for (const channel of [
    'git-accounts:available',
    'git-accounts:list',
    'git-accounts:add',
    'git-accounts:update',
    'git-accounts:remove',
    'git-accounts:bind',
    'git-accounts:unbind',
    'git-accounts:getBinding',
  ]) {
    it(channel, () => {
      expect(handlerBody(channel)).toContain('if (!isAppWindowSender(event)) return UNTRUSTED_SENDER')
    })
  }

  it('shell:openTerminal and settings:cdp-debug-write keep theirs', () => {
    for (const channel of ['shell:openTerminal', 'settings:cdp-debug-write']) {
      expect(handlerBody(channel)).toContain('if (!isAppWindowSender(event)) return UNTRUSTED_SENDER')
    }
  })
})
