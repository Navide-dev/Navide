import { describe, expect, it } from 'vitest'
import { loginPaneExitAction, loginPaneRestartable } from '../loginPaneLifecycle'

describe('loginPaneExitAction', () => {
  it('closes a slot-less sign-in pane whose CLI exited 0', () => {
    expect(loginPaneExitAction({ tracked: true, exitCode: 0 })).toBe('close')
  })

  it('keeps a slot-less sign-in pane whose sign-in failed, so the error stays visible', () => {
    expect(loginPaneExitAction({ tracked: true, exitCode: 1 })).toBe('keep')
    expect(loginPaneExitAction({ tracked: true, exitCode: null })).toBe('keep')
    expect(loginPaneExitAction({ tracked: true, exitCode: undefined })).toBe('keep')
  })

  it('leaves a slot sign-in pane to the login-harvest broadcast, success or not', () => {
    expect(loginPaneExitAction({ tracked: false, exitCode: 0 })).toBe('keep')
    expect(loginPaneExitAction({ tracked: false, exitCode: 1 })).toBe('keep')
  })
})

describe('loginPaneRestartable', () => {
  it('offers a restart once a sign-in pane has ended', () => {
    expect(loginPaneRestartable({ isLogin: true }, 'exited')).toBe(true)
    expect(loginPaneRestartable({ isLogin: true }, 'error')).toBe(true)
  })

  it('not while the sign-in is still running', () => {
    expect(loginPaneRestartable({ isLogin: true }, 'running')).toBe(false)
    expect(loginPaneRestartable({ isLogin: true }, undefined)).toBe(false)
  })

  it('never for an ordinary pane', () => {
    expect(loginPaneRestartable({}, 'exited')).toBe(false)
    expect(loginPaneRestartable({ isLogin: false }, 'exited')).toBe(false)
  })
})
