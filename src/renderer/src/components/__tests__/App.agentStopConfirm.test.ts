import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import enUS from '../../../../../packages/plugin-ui/src/foundation/i18n/locales/en-US.json'

// "Stop and remove agent…" forgets the agent identity (name, color, resume
// link), which nothing in the UI restores, so it asks before doing anything.
// App.vue cannot be mounted by the suite, so the handler is asserted against
// the source like the other App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function handlerBody(): string {
  const start = appSource.indexOf('async function onStopAgentIdentity(')
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end)
}

describe('Stop and remove agent', () => {
  it('confirms before closing the pane or removing the identity', () => {
    const body = handlerBody()
    const confirmAt = body.indexOf('notifyRestore.confirm(')
    expect(confirmAt).toBeGreaterThan(-1)
    expect(body).toContain('if (!ok) return')
    expect(body).toContain('danger: true')
    expect(confirmAt).toBeLessThan(body.indexOf('onKill('))
    expect(confirmAt).toBeLessThan(body.indexOf('agentConsole.remove('))
  })

  it('names only keys the locale has', () => {
    const menu = (enUS as { agentPane: { menu: Record<string, string> } }).agentPane.menu
    for (const m of handlerBody().matchAll(/'agentPane\.menu\.([a-z-]+)'/g)) expect(menu[m[1]], m[1]).toBeTruthy()
  })
})
