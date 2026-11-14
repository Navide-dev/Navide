// Windows Hello for App Lock, through the bundled navide-hello.exe helper
// (native/navide-hello). Windows 11 only: the helper parents the system dialog
// to Navide's window with an API Windows 10 does not have, so Windows 10 and
// any machine without the helper unlock with the PIN alone.
//
// Asking takes a process launch, so availability is cached: refresh() runs at
// start and whenever Settings reads the status, and isAvailable() answers
// from the last result.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** First Windows 11 build. */
export const WINDOWS_11_BUILD = 22000
const CHECK_TIMEOUT_MS = 15_000
/** The user is looking at the dialog: give them time. */
const VERIFY_TIMEOUT_MS = 120_000

/** Exit code of the helper, or null when it could not run or timed out. */
export type RunHelper = (path: string, args: string[], timeoutMs: number) => Promise<number | null>

export interface WindowsHelloDeps {
  platform: NodeJS.Platform
  /** `os.release()`: "10.0.<build>" on Windows. */
  osRelease: string
  helperPath: () => string | null
  run: RunHelper
  log: (line: string) => void
}

export function isWindows11(platform: NodeJS.Platform, osRelease: string): boolean {
  if (platform !== 'win32') return false
  const build = Number(osRelease.split('.')[2])
  return Number.isInteger(build) && build >= WINDOWS_11_BUILD
}

/** Packaged: resources/bin; checkout: build/hello (pnpm build:hello). */
export function windowsHelloHelperPath(isPackaged: boolean, resourcesPath: string, appPath: string): string | null {
  const path = isPackaged
    ? join(resourcesPath, 'bin', 'navide-hello.exe')
    : join(appPath, 'build', 'hello', 'navide-hello.exe')
  return existsSync(path) ? path : null
}

export const runHelper: RunHelper = (path, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(path, args, { timeout: timeoutMs, windowsHide: true }, (err) => {
      if (!err) return resolve(0)
      const code = (err as { code?: unknown }).code
      resolve(typeof code === 'number' && !err.killed ? code : null)
    })
  })

/** An HWND from `BrowserWindow.getNativeWindowHandle()`, as the helper reads it. */
export function hwndArg(handle: Buffer): string {
  return handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0))
}

export class WindowsHello {
  private available = false

  constructor(private readonly deps: WindowsHelloDeps) {}

  /** Whether this machine can have Windows Hello unlock at all (Windows 11). */
  supported(): boolean {
    return isWindows11(this.deps.platform, this.deps.osRelease)
  }

  isAvailable(): boolean {
    return this.available
  }

  /** Ask the helper again. Resolves to whether the answer changed. */
  async refresh(): Promise<boolean> {
    const before = this.available
    const path = this.supported() ? this.deps.helperPath() : null
    if (!path) {
      this.available = false
      return before !== this.available
    }
    const code = await this.deps.run(path, ['check'], CHECK_TIMEOUT_MS)
    if (code !== 0 && code !== 1) this.deps.log(`app-lock: Windows Hello check failed (exit ${code ?? 'none'})`)
    this.available = code === 0
    return before !== this.available
  }

  /** Resolves once the user passed Windows Hello; rejects otherwise. */
  async verify(hwnd: string, message: string): Promise<void> {
    const path = this.available ? this.deps.helperPath() : null
    if (!path) throw new Error('Windows Hello is not available')
    const code = await this.deps.run(path, ['verify', hwnd, message], VERIFY_TIMEOUT_MS)
    if (code === 0) return
    if (code !== 1) this.deps.log(`app-lock: Windows Hello verify failed (exit ${code ?? 'none'})`)
    throw new Error('Windows Hello did not verify')
  }
}
