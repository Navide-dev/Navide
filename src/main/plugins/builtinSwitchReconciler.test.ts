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
})
