import { describe, expect, it } from 'vitest'
import { diffLines, textChangedSinceApproval, visiblePlanLines } from './planHistory'

const html = (body: string, extra = '') => [
  '<!doctype html><html><body>',
  '<script type="application/json" id="plan-meta">{"schemaVersion":1,"stage":"approved","todos":[]}</script>',
  '<style>p { color: red }</style>',
  '<header><h1>Plan<span class="pill approved">approved</span></h1></header>',
  `<section><h2>Goals</h2><p>${body}</p></section>`,
  extra,
  '</body></html>',
].join('\n')

describe('visible plan text', () => {
  it('keeps the prose and drops markup, the meta island and styles', () => {
    expect(visiblePlanLines(html('Ship &amp; measure &#x2713;'))).toEqual(['Planapproved', 'Goals', 'Ship & measure ✓'])
  })

  it('drops the frontmatter of a markdown plan', () => {
    expect(visiblePlanLines('---\nname: P\nstage: draft\n---\n\n## Goals\n\nShip it\n')).toEqual(['## Goals', 'Ship it'])
  })
})

describe('line diff', () => {
  it('marks only what changed, in order', () => {
    expect(diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e'])).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'same', text: 'd' },
      { kind: 'add', text: 'e' },
    ])
  })

  it('stays complete for inputs too large to align', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`)
    const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`)
    const diff = diffLines(before, after)
    expect(diff.filter(line => line.kind === 'del')).toHaveLength(3000)
    expect(diff.filter(line => line.kind === 'add')).toHaveLength(3000)
  })
})

describe('changed since approval', () => {
  const todos = (status: string) => `<ul class="todos"><li data-todo-id="t1" data-status="${status}">Ship</li></ul>`

  it('ignores todo progress and the stage badge, which move after approval', () => {
    const approved = html('Text', todos('pending'))
    const later = html('Text', todos('done')).replace('pill approved">approved', 'pill in-progress">in-progress')
    expect(textChangedSinceApproval(approved, later)).toBe(false)
  })

  it('reports a change to the prose', () => {
    expect(textChangedSinceApproval(html('Text'), html('Text, changed'))).toBe(true)
  })
})
