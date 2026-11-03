import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAppNavigation, handleWindowOpen } from './navigationPolicy'

const APP_INDEX = join(process.cwd(), 'out', 'renderer', 'index.html')

describe('isAppNavigation', () => {
  it('admits the dev-server origin and the app own index.html only', () => {
    expect(isAppNavigation('http://localhost:5173/x', 'http://localhost:5173', APP_INDEX)).toBe(true)
    expect(isAppNavigation(pathToFileURL(APP_INDEX).href, null, APP_INDEX)).toBe(true)
    expect(isAppNavigation(`${pathToFileURL(APP_INDEX).href}?window=editor#x`, null, APP_INDEX)).toBe(true)
  })

  it('refuses any other file whose path merely ends in /renderer/index.html', () => {
    const planted = join(process.cwd(), 'downloads', 'evil', 'renderer', 'index.html')
    expect(isAppNavigation(pathToFileURL(planted).href, null, APP_INDEX)).toBe(false)
    expect(isAppNavigation('file:///tmp/renderer/index.html', null, APP_INDEX)).toBe(false)
    expect(isAppNavigation('https://example.com/renderer/index.html', null, APP_INDEX)).toBe(false)
    expect(isAppNavigation('not a url', null, APP_INDEX)).toBe(false)
  })
})

describe('handleWindowOpen', () => {
  it('routes an http(s) link from an app window to the OS browser', () => {
    const openExternal = vi.fn(async () => undefined)
    expect(handleWindowOpen('https://example.com', false, openExternal)).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('never opens anything externally for a plugin view', () => {
    const openExternal = vi.fn(async () => undefined)
    expect(handleWindowOpen('https://example.com', true, openExternal)).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('denies non-http(s) schemes without opening them', () => {
    const openExternal = vi.fn(async () => undefined)
    expect(handleWindowOpen('file:///etc/passwd', false, openExternal)).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
  })
})
