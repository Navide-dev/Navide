import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { guardPlanFrameNavigation, PLAN_DOC_FRAME_NAME } from './planFrameNavigation'

function navigate(
  contents: EventEmitter,
  details: { url: string; isMainFrame: boolean; frame: { name: string } | null }
): boolean {
  let prevented = false
  contents.emit('will-frame-navigate', { ...details, preventDefault: () => { prevented = true } })
  return prevented
}

describe('guardPlanFrameNavigation', () => {
  const contents = new EventEmitter()
  guardPlanFrameNavigation(contents as unknown as WebContents)
  const planFrame = { name: PLAN_DOC_FRAME_NAME }

  it('keeps a plan frame on its own srcdoc', () => {
    expect(navigate(contents, { url: 'about:srcdoc', isMainFrame: false, frame: planFrame })).toBe(false)
  })

  it.each(['https://attacker.invalid/', 'http://127.0.0.1:8000/', 'about:blank', 'data:text/html,x', 'file:///etc/passwd'])(
    'refuses to take a plan frame to %s',
    (url) => {
      expect(navigate(contents, { url, isMainFrame: false, frame: planFrame })).toBe(true)
    }
  )

  it('leaves other frames and the main frame alone', () => {
    const url = 'https://example.com/'
    expect(navigate(contents, { url, isMainFrame: false, frame: { name: '' } })).toBe(false)
    expect(navigate(contents, { url, isMainFrame: false, frame: null })).toBe(false)
    expect(navigate(contents, { url, isMainFrame: true, frame: planFrame })).toBe(false)
  })
})
