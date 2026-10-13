import { describe, expect, it, vi } from 'vitest'
import { createQuitCancelReset } from './quit-cancel-watch'

// A quit that was cancelled after the teardown had already stopped the backend
// and the plugin backends must bring them back and lift the shutdown screen;
// one cancelled before that only has to clear what the quit set.
describe('createQuitCancelReset', () => {
  function deps(teardownRan: boolean, failRestart = false) {
    let ran = teardownRan
    const steps: string[] = []
    const restart = async (): Promise<void> => {
      if (failRestart) throw new Error('spawn failed')
      steps.push('restart backend')
    }
    return {
      steps,
      deps: {
        clearQuitFlags: () => { steps.push('clear flags') },
        clearCleanExit: () => { steps.push('clear clean exit') },
        takeTeardownRan: () => { const was = ran; ran = false; return was },
        restartBackend: () => restart(),
        reopenBackendPlugins: () => { steps.push('reopen plugin backends') },
        broadcastCancelled: () => { steps.push('broadcast cancelled') },
      },
    }
  }

  it('after the teardown: clears the quit, then brings everything back in order', async () => {
    const { steps, deps: d } = deps(true)
    await createQuitCancelReset(d)()
    expect(steps).toEqual([
      'clear flags', 'clear clean exit', 'restart backend', 'reopen plugin backends', 'broadcast cancelled',
    ])
  })

  it('before the teardown: only clears the quit', async () => {
    const { steps, deps: d } = deps(false)
    await createQuitCancelReset(d)()
    expect(steps).toEqual(['clear flags', 'clear clean exit'])
  })

  it('brings the teardown back once, however many cancels report it', async () => {
    const { steps, deps: d } = deps(true)
    const reset = createQuitCancelReset(d)
    await reset()
    steps.length = 0
    await reset()
    expect(steps).toEqual(['clear flags', 'clear clean exit'])
  })

  it('a backend that fails to restart still gets the plugin backends and the screen back', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { steps, deps: d } = deps(true, true)
    await createQuitCancelReset(d)()
    expect(steps).toEqual(['clear flags', 'clear clean exit', 'reopen plugin backends', 'broadcast cancelled'])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
