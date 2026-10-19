import type { WebContents } from 'electron'

/** The `name` of the plan document iframes (PlanDocPreview.vue, and PlansApp.vue in navide-plans). */
export const PLAN_DOC_FRAME_NAME = 'navide-plan-doc'

/** A plan document only ever shows its own srcdoc. Its injected CSP cannot stop
 * a meta refresh or a link from taking the frame to another page, where that
 * CSP no longer applies, so any such navigation is refused here. Every other
 * frame, and every main frame, navigates exactly as before. */
export function guardPlanFrameNavigation(contents: WebContents): void {
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || event.frame?.name !== PLAN_DOC_FRAME_NAME) return
    if (event.url !== 'about:srcdoc') event.preventDefault()
  })
}
