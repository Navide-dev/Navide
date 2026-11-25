import { describe, expect, it } from 'vitest'
import { newSshTmuxSession, sshTmuxSessionField } from '../useSshRemotePrefs'

// The tmux session name an SSH pane runs in on the host (0.2.49): one per
// pane, in the shape the backend accepts (remote_ssh._TMUX_SESSION_RE).
describe('SSH Remote tmux session names', () => {
  it('a new pane gets its own name in the accepted shape', () => {
    const a = newSshTmuxSession()
    const b = newSshTmuxSession()
    expect(a).toMatch(/^navide-[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
    expect(sshTmuxSessionField(a)).toBe(a)
  })

  it('a saved name in any other shape is dropped', () => {
    for (const bad of [undefined, 42, '', 'work', 'navide-x', 'navide-0123456789ABCDEF', 'navide-0123456789abcdef;rm']) {
      expect(sshTmuxSessionField(bad)).toBe('')
    }
  })
})
