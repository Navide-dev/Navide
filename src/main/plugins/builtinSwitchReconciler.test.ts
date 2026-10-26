import { describe, it, expect, vi } from 'vitest'
import { createBuiltinSwitchReconciler } from './builtinSwitchReconciler'

describe('createBuiltinSwitchReconciler', () => {
  it('applies a store that turned unreadable (all three fail closed) like a normal disable', async () => {
    let disabled: string[] = []
    const apply = vi.fn(async () => undefined)
    const reconciler = createBuiltinSwitchReconciler({ list: () => disabled, apply, warn: vi.fn() })
    await reconciler.check()
    expect(apply).not.toHaveBeenCalled()

    disabled = ['navide.git', 'navide.mini-ide', 'navide.plans']
    await reconciler.check()
    expect(apply.mock.calls).toEqual([
      ['navide.git', true], ['navide.mini-ide', true], ['navide.plans', true],
    ])
    // Seen once, applied once.
    await reconciler.check()
    expect(apply).toHaveBeenCalledTimes(3)

    disabled = ['navide.plans']
    await reconciler.check()
    expect(apply.mock.calls.slice(3)).toEqual([['navide.git', false], ['navide.mini-ide', false]])
  })

  it('does not re-apply a change the switch already applied', async () => {
    let disabled: string[] = []
    const apply = vi.fn(async () => undefined)
    const reconciler = createBuiltinSwitchReconciler({ list: () => disabled, apply, warn: vi.fn() })
    disabled = ['navide.plans']
    reconciler.sync()
    await reconciler.check()
    expect(apply).not.toHaveBeenCalled()
  })

  it('keeps going and reports when one change fails', async () => {
    let disabled: string[] = []
    const warn = vi.fn()
    const apply = vi.fn(async (id: string) => { if (id === 'navide.git') throw new Error('busy') })
    const reconciler = createBuiltinSwitchReconciler({ list: () => disabled, apply, warn })
    disabled = ['navide.git', 'navide.plans']
    await reconciler.check()
    expect(apply).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('busy'))
  })

  it('skips a queued change the store no longer holds, such as after a reset mid-check', async () => {
    let disabled: string[] = []
    let releaseGit!: () => void
    const apply = vi.fn((id: string) => id === 'navide.git'
      ? new Promise<void>((resolve) => { releaseGit = resolve })
      : Promise.resolve())
    const reconciler = createBuiltinSwitchReconciler({ list: () => disabled, apply, warn: vi.fn() })
    disabled = ['navide.git', 'navide.mini-ide', 'navide.plans']
    const check = reconciler.check()
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    // The user resets the store while Git drains.
    disabled = []
    reconciler.sync()
    releaseGit()
    await check
    expect(apply.mock.calls).toEqual([['navide.git', true]])
    await reconciler.check()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('runs a held switch only after a check in progress, and checks nothing while it is held', async () => {
    let disabled: string[] = []
    const order: string[] = []
    let releaseGit!: () => void
    const apply = vi.fn((id: string) => id === 'navide.git'
      ? new Promise<void>((resolve) => { releaseGit = () => { order.push('git drained'); resolve() } })
      : Promise.resolve())
    const reconciler = createBuiltinSwitchReconciler({ list: () => disabled, apply, warn: vi.fn() })
    disabled = ['navide.git']
    const check = reconciler.check()
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    const held = reconciler.hold(async () => {
      order.push('switch')
      disabled = ['navide.git', 'navide.plans']
      await reconciler.check()
    })
    await Promise.resolve()
    expect(order).toEqual([])
    releaseGit()
    await check
    await held
    expect(order).toEqual(['git drained', 'switch'])
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('does not apply the user switch a second time when a check lands during its drain', async () => {
    let disabled: string[] = []
    const apply = vi.fn(async () => undefined)
    const reconciler = createBuiltinSwitchReconciler({ list: () => disabled, apply, warn: vi.fn() })
    let releaseDrain!: () => void
    const held = reconciler.hold(async () => {
      // The switch records the store first, then drains.
      disabled = ['navide.plans']
      await new Promise<void>((resolve) => { releaseDrain = resolve })
      reconciler.sync()
    })
    await reconciler.check()
    releaseDrain()
    await held
    await reconciler.check()
    expect(apply).not.toHaveBeenCalled()
  })
})
