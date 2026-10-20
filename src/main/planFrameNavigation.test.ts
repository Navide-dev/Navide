import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { guardPlanFrameNavigation, PLAN_DOC_FRAME_NAME } from './planFrameNavigation'

type Frame = { name: string; frameTreeNodeId: number }

function guarded() {
  const frames: Frame[] = []
  const contents = Object.assign(new EventEmitter(), { mainFrame: { framesInSubtree: frames } })
  guardPlanFrameNavigation(contents as unknown as WebContents)
  const create = (frame: Frame) => {
    frames.push(frame)
    contents.emit('frame-created', {}, { frame })
  }
  const navigate = (details: { url: string; isMainFrame: boolean; frame: Frame | null }): boolean => {
    let prevented = false
    contents.emit('will-frame-navigate', { ...details, preventDefault: () => { prevented = true } })
    return prevented
  }
  return { frames, create, navigate }
}

describe('guardPlanFrameNavigation', () => {
  const planFrame = { name: PLAN_DOC_FRAME_NAME, frameTreeNodeId: 7 }

  it('keeps a plan frame on its own srcdoc', () => {
    const { create, navigate } = guarded()
    create(planFrame)
    expect(navigate({ url: 'about:srcdoc', isMainFrame: false, frame: planFrame })).toBe(false)
  })

  it.each(['https://attacker.invalid/', 'http://127.0.0.1:8000/', 'about:blank', 'data:text/html,x', 'file:///etc/passwd'])(
    'refuses to take a plan frame to %s',
    (url) => {
      const { create, navigate } = guarded()
      create(planFrame)
      expect(navigate({ url, isMainFrame: false, frame: planFrame })).toBe(true)
    }
  )

  it('still refuses once a script in the plan has renamed its frame', () => {
    const { create, navigate } = guarded()
    create(planFrame)
    const renamed = { ...planFrame, name: 'x' }
    expect(navigate({ url: 'https://attacker.invalid/', isMainFrame: false, frame: renamed })).toBe(true)
  })

  it('forgets a plan frame once it has left the page', () => {
    const { frames, create, navigate } = guarded()
    create(planFrame)
    frames.splice(0)
    create({ name: PLAN_DOC_FRAME_NAME, frameTreeNodeId: 8 })
    const reused = { name: '', frameTreeNodeId: 7 }
    expect(navigate({ url: 'https://example.com/', isMainFrame: false, frame: reused })).toBe(false)
  })

  it('leaves other frames and the main frame alone', () => {
    const { create, navigate } = guarded()
    create(planFrame)
    const url = 'https://example.com/'
    expect(navigate({ url, isMainFrame: false, frame: { name: '', frameTreeNodeId: 9 } })).toBe(false)
    expect(navigate({ url, isMainFrame: false, frame: null })).toBe(false)
    expect(navigate({ url, isMainFrame: true, frame: planFrame })).toBe(false)
  })
})
