// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { blockTourWhile, tourBlocked } from '../useTourBlockers'
import QuestionAlert from '../../components/QuestionAlert.vue'

// M4: the coach-mark mask sits above overlays that pop up by themselves — a
// CLI question, the job editor — and swallowed their clicks. While one is up
// the tour steps aside, and comes back as soon as it closes.
describe('tour blockers', () => {
  function host(open: ReturnType<typeof ref<boolean>>) {
    return defineComponent({
      setup() {
        blockTourWhile(() => !!open.value)
        return () => h('div')
      },
    })
  }

  it('blocks the tour while a registered overlay is open, and lets go when it closes', async () => {
    const open = ref(false)
    const w = mount(host(open))
    expect(tourBlocked.value).toBe(false)
    open.value = true
    await nextTick()
    expect(tourBlocked.value).toBe(true)
    open.value = false
    await nextTick()
    expect(tourBlocked.value).toBe(false)
    w.unmount()
  })

  it('lets go when an open overlay is unmounted, and counts each overlay on its own', async () => {
    const a = ref(true)
    const b = ref(true)
    const wa = mount(host(a))
    const wb = mount(host(b))
    expect(tourBlocked.value).toBe(true)
    wa.unmount()
    expect(tourBlocked.value).toBe(true)
    b.value = false
    await nextTick()
    expect(tourBlocked.value).toBe(false)
    wb.unmount()
  })

  it('is blocked by a CLI question while it is on screen', async () => {
    const question = { prompt: 'Which?', type: 'choice' as const, options: ['A'] }
    const w = mount(QuestionAlert, { props: { visible: true, questions: [question] }, attachTo: document.body })
    expect(tourBlocked.value).toBe(true)
    await w.setProps({ visible: false })
    expect(tourBlocked.value).toBe(false)
    w.unmount()
  })

  it('is blocked by the job editor while it is open', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/JobEditorModal.vue'), 'utf8')
    expect(source).toContain('blockTourWhile(() => props.open)')
  })
})
