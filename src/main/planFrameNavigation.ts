import type { WebContents } from 'electron'

/** The `name` of the plan document iframes (PlanDocPreview.vue, and PlansApp.vue in navide-plans). */
export const PLAN_DOC_FRAME_NAME = 'navide-plan-doc'

/** A plan document only ever shows its own srcdoc. Its injected CSP cannot stop
 * a meta refresh or a link from taking the frame to another page, where that
 * CSP no longer applies, so any such navigation is refused here. Every other
 * frame, and every main frame, navigates exactly as before. */
export function guardPlanFrameNavigation(contents: WebContents): void {
  // A frame's name is the Host's when the frame is created, before any script
  // in the document runs; later the document can rename itself. So plan frames
  // are known by id from creation on, and the ids of frames gone from the page
  // are dropped whenever a new plan frame arrives.
  const planFrames = new Set<number>()
  contents.on('frame-created', (_event, { frame }) => {
    if (frame?.name !== PLAN_DOC_FRAME_NAME) return
    const live = new Set(contents.mainFrame.framesInSubtree.map((f) => f.frameTreeNodeId))
    for (const id of planFrames) if (!live.has(id)) planFrames.delete(id)
    planFrames.add(frame.frameTreeNodeId)
  })
  contents.on('will-frame-navigate', (event) => {
    const frame = event.frame
    if (event.isMainFrame || !frame) return
    if (!planFrames.has(frame.frameTreeNodeId) && frame.name !== PLAN_DOC_FRAME_NAME) return
    if (event.url !== 'about:srcdoc') event.preventDefault()
  })
}
