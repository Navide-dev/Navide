// @vitest-environment happy-dom
// #448: a failed node says why on the canvas, not only in the toast, the
// pipeline log and pipeline_status.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PipelineNodeCard from '../PipelineNodeCard.vue'
import type { GraphNode } from '../../../lib/pipelineGraph'

i18n.global.locale.value = 'en-US'

const node: GraphNode = {
  id: 'a', kind: 'slot', label: 'A', position: { x: 0, y: 0 },
  slot: { agentKey: 'codex', roleKey: 'dev', label: 'A', kickoffBody: '', isCommander: false },
}

describe('PipelineNodeCard', () => {
  it('shows why a failed node failed', () => {
    const w = mount(PipelineNodeCard, {
      props: { node, run: { status: 'failed', error: 'kickoff never reached the agent after 3 attempts' } },
      global: { plugins: [i18n] },
    })
    expect(w.find('.pnc-status').attributes('title')).toBe('kickoff never reached the agent after 3 attempts')
    expect(w.find('.pnc').attributes('aria-label')).toContain('kickoff never reached the agent after 3 attempts')
    w.unmount()
  })

  it('badges an imported step that needs review', () => {
    const w = mount(PipelineNodeCard, { props: { node: { ...node, needsReview: true } }, global: { plugins: [i18n] } })
    const mark = w.find('.pnc-mark--review')
    expect(mark.exists()).toBe(true)
    expect(mark.attributes('aria-label')).toBe(i18n.global.t('pipelineEditor.node.needs-review'))
    w.unmount()
    const plain = mount(PipelineNodeCard, { props: { node }, global: { plugins: [i18n] } })
    expect(plain.find('.pnc-mark--review').exists()).toBe(false)
    plain.unmount()
  })

  it('adds no reason to a node that has none', () => {
    const w = mount(PipelineNodeCard, { props: { node, run: { status: 'done' } }, global: { plugins: [i18n] } })
    expect(w.find('.pnc-status').attributes('title')).toBeUndefined()
    w.unmount()
  })
})
