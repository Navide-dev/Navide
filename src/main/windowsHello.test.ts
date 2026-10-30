import { describe, expect, it, vi } from 'vitest'

import { hwndArg, isWindows11, WindowsHello, type WindowsHelloDeps } from './windowsHello'

// The helper is a fake: these tests pin what main does with its exit codes.
function hello(over: Partial<WindowsHelloDeps> = {}) {
  const run = vi.fn(async (_path: string, args: string[]) => (args[0] === 'check' ? 0 : 0))
  const log = vi.fn()
  const deps: WindowsHelloDeps = {
    platform: 'win32',
    osRelease: '10.0.22631',
    helperPath: () => 'C:\\Navide\\resources\\bin\\navide-hello.exe',
    run,
    log,
    ...over,
  }
  return { hello: new WindowsHello(deps), run: deps.run as typeof run, log }
}

describe('isWindows11', () => {
  it('is true from build 22000 on Windows and false everywhere else', () => {
    expect(isWindows11('win32', '10.0.22000')).toBe(true)
    expect(isWindows11('win32', '10.0.26100')).toBe(true)
    expect(isWindows11('win32', '10.0.19045')).toBe(false)
    expect(isWindows11('win32', 'garbage')).toBe(false)
    expect(isWindows11('darwin', '10.0.22631')).toBe(false)
    expect(isWindows11('linux', '10.0.22631')).toBe(false)
  })
})

describe('hwndArg', () => {
  it('reads a 64-bit handle little-endian, and a 32-bit one', () => {
    const wide = Buffer.alloc(8)
    wide.writeBigUInt64LE(0x1_0002_0304n)
    expect(hwndArg(wide)).toBe(String(0x1_0002_0304))
    const narrow = Buffer.alloc(4)
    narrow.writeUInt32LE(0x40506)
    expect(hwndArg(narrow)).toBe(String(0x40506))
  })
})

describe('WindowsHello', () => {
  it('is unavailable until a check says so, and follows the latest check', async () => {
    const t = hello()
    expect(t.hello.isAvailable()).toBe(false)
    expect(await t.hello.refresh()).toBe(true)
    expect(t.hello.isAvailable()).toBe(true)
    expect(t.run).toHaveBeenCalledWith('C:\\Navide\\resources\\bin\\navide-hello.exe', ['check'], expect.any(Number))
    t.run.mockResolvedValueOnce(1)
    expect(await t.hello.refresh()).toBe(true)
    expect(t.hello.isAvailable()).toBe(false)
    expect(t.log).not.toHaveBeenCalled()
  })

  it('never runs the helper on Windows 10, macOS, Linux, or without the helper', async () => {
    for (const over of [{ osRelease: '10.0.19045' }, { platform: 'darwin' as const }, { platform: 'linux' as const }, { helperPath: () => null }]) {
      const t = hello(over)
      expect(await t.hello.refresh()).toBe(false)
      expect(t.hello.isAvailable()).toBe(false)
      expect(t.run).not.toHaveBeenCalled()
    }
  })

  it('treats a helper that crashed or timed out as unavailable, and logs it', async () => {
    const t = hello({ run: vi.fn(async () => null) })
    await t.hello.refresh()
    expect(t.hello.isAvailable()).toBe(false)
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('check failed'))
  })

  it('verifies only on exit 0, parenting the dialog to the given window', async () => {
    const t = hello()
    await expect(t.hello.verify('123', 'unlock Navide')).rejects.toThrow('not available')
    await t.hello.refresh()
    await expect(t.hello.verify('123', 'unlock Navide')).resolves.toBeUndefined()
    expect(t.run).toHaveBeenLastCalledWith(expect.any(String), ['verify', '123', 'unlock Navide'], expect.any(Number))
    t.run.mockResolvedValueOnce(1)
    await expect(t.hello.verify('123', 'unlock Navide')).rejects.toThrow('did not verify')
    expect(t.log).not.toHaveBeenCalled()
    t.run.mockResolvedValueOnce(2)
    await expect(t.hello.verify('123', 'unlock Navide')).rejects.toThrow('did not verify')
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('verify failed (exit 2)'))
  })
})
