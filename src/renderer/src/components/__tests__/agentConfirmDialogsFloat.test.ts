// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import AgentAccountSwitchConfirmDialog from '../AgentAccountSwitchConfirmDialog.vue'
import AgentSignInConfirmDialog from '../AgentSignInConfirmDialog.vue'

// An agent's account switch / sign-in confirmation must float over the window
// that asked: semantic.css gives .nv-dialog-scrim its look only, so each dialog
// positions its own overlay. Without it the card sat in the page flow at the
// window's top-left and pushed the shell down, reading as a separate window.
const here = resolve(__dirname, '..')
const dialogs = [
  { file: 'AgentAccountSwitchConfirmDialog.vue', root: 'switch-confirm', component: AgentAccountSwitchConfirmDialog },
  { file: 'AgentSignInConfirmDialog.vue', root: 'signin-confirm', component: AgentSignInConfirmDialog },
] as const

const request = {
  agentKey: 'claude',
  profileId: 'p1',
  mode: 'folder',
  accountLabel: 'Work',
  fromLabel: 'Personal',
  toLabel: 'Work',
  callerPaneId: 'pa',
  callerName: 'builder',
  workspacePath: '/Users/me/project',
  reason: 'quota ran out',
  reasonTruncated: false,
  confirmBy: Date.now() + 45_000,
}

function rootRule(file: string, root: string): string {
  const source = readFileSync(resolve(here, file), 'utf8')
  const match = source.match(new RegExp(`\\n\\.${root} \\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  delete (window as { agentTeam?: unknown }).agentTeam
})

describe.each(dialogs)('$file floats over its window', ({ file, root, component }) => {
  it('covers the whole window and centres the card', () => {
    const rule = rootRule(file, root)
    expect(rule).toMatch(/position:\s*fixed/)
    expect(rule).toMatch(/inset:\s*0/)
    expect(rule).toMatch(/display:\s*flex/)
    expect(rule).toMatch(/align-items:\s*center/)
    expect(rule).toMatch(/justify-content:\s*center/)
  })

  it('stacks above every other modal the main window can have open', () => {
    const level = Number(rootRule(file, root).match(/z-index:\s*calc\(var\(--z-modal\) \+ (\d+)\)/)?.[1])
    // AgentHistoryModal (152) is the highest modal below the guided tour and menus.
    expect(level).toBeGreaterThan(152)
  })

  it('brings its window to the front when it opens', () => {
    const focusSelf = vi.fn(async () => ({ ok: true }))
    ;(window as { agentTeam?: unknown }).agentTeam = { focusSelf }
    // One request shape serves both dialogs; each reads only its own fields.
    wrapper = mount(component as Parameters<typeof mount>[0], {
      props: { request } as Record<string, unknown>,
      global: { plugins: [i18n] },
      attachTo: document.body,
    }) as VueWrapper
    expect(wrapper.find(`.${root}`).exists()).toBe(true)
    expect(focusSelf).toHaveBeenCalledTimes(1)
  })
})
