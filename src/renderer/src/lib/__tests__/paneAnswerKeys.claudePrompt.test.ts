// Is Claude Code at its input prompt, or on a first-run setup menu? Read from
// real Claude Code 2.1.327 screens captured in a fresh devcontainer (xterm row
// text by row number, blank rows restored), so a menu without numbers is covered.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atClaudeInputPrompt, onCursorMenu } from '../paneAnswerKeys'

const screen = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
// Captured after Reconnect; the first open showed the same picker.
const theme = screen('claude-2.1.327-first-run-theme.txt')
const loginMethod = screen('claude-2.1.327-first-run-login-method.txt')
// A set-up container at its prompt; its footer says "run /login" itself.
const empty = screen('claude-2.1.327-prompt.txt')
const typed = screen('claude-2.1.327-prompt-login-typed.txt')

describe('atClaudeInputPrompt', () => {
  it('is true for the prompt framed by its two rules, typed in or empty', () => {
    expect(atClaudeInputPrompt(typed)).toBe(true)
    expect(atClaudeInputPrompt(empty)).toBe(true)
  })

  it('is false on the first-run text-style picker, which has no numbers', () => {
    expect(atClaudeInputPrompt(theme)).toBe(false)
  })

  it('is false on the numbered login-method menu and on a blank screen', () => {
    expect(atClaudeInputPrompt(loginMethod)).toBe(false)
    expect(atClaudeInputPrompt('')).toBe(false)
  })
})

describe('onCursorMenu', () => {
  it('sees both first-run menus, numbered or not', () => {
    expect(onCursorMenu(theme)).toBe(true)
    expect(onCursorMenu(loginMethod)).toBe(true)
  })

  it('does not take the prompt line itself for a menu cursor', () => {
    expect(onCursorMenu(empty)).toBe(false)
    expect(onCursorMenu('')).toBe(false)
  })

  it('does not take a prompt still being drawn (no rule below yet) for a menu', () => {
    const halfDrawn = empty.split('\n').slice(0, 7).join('\n')
    expect(atClaudeInputPrompt(halfDrawn)).toBe(false)
    expect(onCursorMenu(halfDrawn)).toBe(false)
  })
})
