import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// index.ts cannot be imported in a unit test (it boots Electron), so the closed
// action list behind `trust:confirm` is read from source, the way the renderer's
// App.* tests guard App.vue.
const source = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

function actions(): string[] {
  const start = source.indexOf('const TRUST_CONFIRM_ACTIONS = new Set([')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('])', start)
  return [...source.slice(start, end).matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1])
}

describe('trust:confirm action list', () => {
  it('mints confirmations for loosening terminal command protection', () => {
    expect(actions()).toEqual(expect.arrayContaining([
      'guard.terminal.set_category',
      'guard.terminal.add_pattern',
      'guard.terminal.remove_pattern',
    ]))
  })

  it('mints confirmations for loosening Guard grading', () => {
    expect(actions()).toEqual(expect.arrayContaining([
      'guard.builtin.set_level',
      'guard.rules.add',
      'guard.rules.remove',
      'guard.branches.remove',
    ]))
  })

  it('mints confirmations for deciding an agent plugin request', () => {
    expect(actions()).toContain('plugins.agent_request.decide')
    expect(actions()).toContain('plugins.agent_request.finish')
  })

  it('is only reachable from an app window', () => {
    const handler = source.slice(source.indexOf("ipcMain.handle('trust:confirm'"))
    const body = handler.slice(0, handler.indexOf('\n})'))
    expect(body).toContain('if (!isAppWindowSender(event)) return null')
    expect(body).toContain('!TRUST_CONFIRM_ACTIONS.has(action)) return null')
  })
})
