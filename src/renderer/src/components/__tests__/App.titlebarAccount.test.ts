// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The titlebar "Sign In" button and the account modal it opens.
//
// Source-scanned, like the other App.*.test.ts files: App.vue mounts the
// backend, terminal and onboarding lifecycles and is not practical to mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

const at = (needle: string): number => {
  const i = appSource.indexOf(needle)
  expect(i, needle).toBeGreaterThan(-1)
  return i
}

describe('titlebar account button', () => {
  it('sits immediately before the settings gear', () => {
    // The gear must keep its edge position, so the button goes ahead of it.
    // The workspace-switch button is ahead of both, but no longer as its
    // neighbour: it now leads the centred .titlebar-id block.
    const account = at('class="titlebar-account"')
    const gear = at('class="titlebar-gear"')
    expect(account).toBeLessThan(gear)
    expect(appSource.slice(account, gear)).not.toContain('<button class="titlebar-ws-btn"')
    expect(appSource.lastIndexOf('@click="onSwitchWorkspace"', gear)).toBeLessThan(account)
  })

  it('opens the modal and reflects the signed-in account', () => {
    const btn = appSource.slice(at('class="titlebar-account"'), at('class="titlebar-gear"'))
    expect(btn).toContain('@click="openAccountModal"')
    expect(btn).toContain("$t('action.sign-in')")
    expect(btn).toContain('p2pAccountLabel')
    expect(btn).toContain('titlebar-account-dot')
    expect(appSource).toMatch(/const p2pAccountLabel = computed[\s\S]{0,300}a\.accountEmail \|\| a\.displayName/)
  })

  it('mounts AccountModal as an in-app overlay, not a window', () => {
    expect(appSource).toContain("import('./components/AccountModal.vue')")
    expect(appSource).toMatch(/<AccountModal[\s\S]{0,300}:open="showAccount"[\s\S]{0,300}@changed=/)
    expect(appSource).not.toContain('openAccount' + 'Window')
  })

  it('reads the link status from the backend and refreshes on change', () => {
    const fn = appSource.slice(at('async function loadP2pAccount('), at('function openAccountModal('))
    expect(fn).toContain("'p2p.link.status'")
    expect(appSource).toContain('@changed="() => void loadP2pAccount()"')
  })

  it('is reachable from the native Window menu', () => {
    expect(appSource).toContain("action === 'open-account'")
  })
})
