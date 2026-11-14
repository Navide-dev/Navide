// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { buildPlanRuntimeScript, createPlanRuntimeMessageHandler, sanitizePlanSectionHtml } from './planRuntime'
import { syncHeaderMarkup } from './usePlanHtml'

const windows: Window[] = []
afterEach(async () => {
  await Promise.all(windows.splice(0).map(window => window.happyDOM.abort()))
})

const DOC = [
  '<header><h1>Plan name<span class="pill draft">draft</span></h1><p class="overview">One line.</p></header>',
  '<section><h2>Goals</h2><p>Original goals</p></section>',
  '<section><h2>Risks</h2><p>Original risks</p></section>',
  '<section><h2>Phases</h2><ul class="todos"><li data-todo-id="t1">T1</li></ul></section>',
].join('')

/** A frame running the runtime; `posts` collects what it sends the host. */
function frame(editMode: boolean) {
  const window = new Window()
  windows.push(window)
  window.document.body.innerHTML = DOC
  const posts: Array<Record<string, unknown>> = []
  // In a top-level happy-dom window `parent` is the window itself.
  window.addEventListener('message', (event) => {
    const data = (event as unknown as { data: Record<string, unknown> }).data
    if (data && typeof data.type === 'string' && data.documentToken === 'tok') posts.push(data)
  })
  window.eval(buildPlanRuntimeScript({
    documentToken: 'tok', anchors: {}, scrollY: 0, editMode,
    commentLabel: 'Comment', editLabel: 'Edit', deleteLabel: 'Delete', saveLabel: 'Save', cancelLabel: 'Cancel',
  }))
  const doc = window.document
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const input = (el: Element) => el.dispatchEvent(new window.Event('input', { bubbles: true }))
  return { window, doc, posts, settle, input }
}

describe('edit mode in the injected runtime', () => {
  it('makes every prose section and the header editable, never a todo list or the stage pill', async () => {
    const { doc, posts, settle } = frame(true)
    await settle()
    const [goals, risks, phases] = Array.from(doc.querySelectorAll('section'))
    expect(goals.getAttribute('contenteditable')).toBe('true')
    expect(risks.getAttribute('contenteditable')).toBe('true')
    expect(phases.getAttribute('contenteditable')).toBeNull()
    expect(goals.querySelector('h2')?.getAttribute('contenteditable')).toBe('false')
    expect(doc.querySelector('h1')?.getAttribute('contenteditable')).toBe('true')
    expect(doc.querySelector('.pill')?.getAttribute('contenteditable')).toBe('false')
    expect(doc.querySelector('p.overview')?.getAttribute('contenteditable')).toBe('true')
    expect(posts.map(p => p.type)).toEqual(['section-editing', 'edit-mode-changed'])
    expect(posts[1].active).toBe(true)
  })

  it('posts only the sections that changed, once typing pauses', async () => {
    const { window, doc, posts, settle, input } = frame(true)
    await settle()
    posts.length = 0
    const goals = doc.querySelectorAll('section')[0]
    goals.querySelector('p')!.textContent = 'New goals'
    input(goals.querySelector('p')!)
    await settle()
    expect(posts).toEqual([])
    await new Promise(resolve => window.setTimeout(resolve, 1600))
    await settle()
    expect(posts).toEqual([{ type: 'section-edit', anchor: 'Goals', html: '<p>New goals</p>', documentToken: 'tok' }])
  })

  it('saves the name without the stage pill and the overview as plain text on Cmd+S', async () => {
    const { window, doc, posts, settle, input } = frame(true)
    await settle()
    posts.length = 0
    const h1 = doc.querySelector('h1')!
    h1.firstChild!.textContent = 'Renamed  plans '
    input(h1)
    const overview = doc.querySelector('p.overview')!
    overview.innerHTML = 'Seven <b>steps</b>'
    input(overview)
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', metaKey: true }))
    await settle()
    expect(posts).toEqual([
      { type: 'header-edit', field: 'name', text: 'Renamed plans', documentToken: 'tok' },
      { type: 'header-edit', field: 'overview', text: 'Seven steps', documentToken: 'tok' },
    ])
  })

  it('Escape leaves edit mode and saves what was typed, never discarding it', async () => {
    const { window, doc, posts, settle, input } = frame(true)
    await settle()
    posts.length = 0
    const risks = doc.querySelectorAll('section')[1]
    risks.querySelector('p')!.textContent = 'Typed risks'
    input(risks.querySelector('p')!)
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    await settle()
    expect(posts.map(p => p.type)).toEqual(['section-edit', 'section-editing', 'edit-mode-changed'])
    expect(posts[0]).toMatchObject({ anchor: 'Risks', html: '<p>Typed risks</p>' })
    expect(posts[2].active).toBe(false)
    expect(risks.getAttribute('contenteditable')).toBeNull()
  })

  it('turns on only for the host of this document', async () => {
    const { window, doc, posts, settle } = frame(false)
    const request = (documentToken: string) => {
      const event = new window.MessageEvent('message', { data: { type: 'edit-mode', active: true, documentToken } })
      Object.defineProperty(event, 'source', { value: window.eval('parent') })
      window.dispatchEvent(event)
    }
    request('stale')
    await settle()
    expect(doc.querySelector('section')?.getAttribute('contenteditable')).toBeNull()
    request('tok')
    await settle()
    expect(doc.querySelector('section')?.getAttribute('contenteditable')).toBe('true')
    expect(posts.some(p => p.type === 'edit-mode-changed' && p.active === true)).toBe(true)
  })
})

describe('host validation of edit-mode messages', () => {
  function handler() {
    const source = {} as Window
    const hooks = {
      getSourceWindow: () => source,
      getDocumentToken: () => 'tok',
      getTodoIds: () => [],
      getAnchors: () => ['Goals'],
      onTodoClicked: vi.fn(), onSectionComment: vi.fn(), onScrollPos: vi.fn(), onOpenCode: vi.fn(),
      onSectionEdit: vi.fn(), onSectionDelete: vi.fn(), onSectionEditing: vi.fn(),
      onHeaderEdit: vi.fn(), onEditModeChanged: vi.fn(),
    }
    const handle = createPlanRuntimeMessageHandler(hooks)
    const send = (data: Record<string, unknown>) =>
      handle(new MessageEvent('message', { source, data: { documentToken: 'tok', ...data } }))
    return { hooks, send }
  }

  it('accepts a section of any length', () => {
    const { hooks, send } = handler()
    send({ type: 'section-edit', anchor: 'Goals', html: `<p>${'x'.repeat(250_000)}</p>` })
    expect(hooks.onSectionEdit).toHaveBeenCalledTimes(1)
  })

  it('accepts a name or overview, never an empty name or another field', () => {
    const { hooks, send } = handler()
    send({ type: 'header-edit', field: 'name', text: 'Renamed' })
    send({ type: 'header-edit', field: 'overview', text: '' })
    send({ type: 'header-edit', field: 'name', text: '   ' })
    send({ type: 'header-edit', field: 'stage', text: 'approved' })
    send({ type: 'header-edit', field: 'name', text: 7 })
    expect(hooks.onHeaderEdit.mock.calls).toEqual([['name', 'Renamed'], ['overview', '']])
  })

  it('passes edit-mode changes through only as booleans', () => {
    const { hooks, send } = handler()
    send({ type: 'edit-mode-changed', active: 'yes' })
    send({ type: 'edit-mode-changed', active: false })
    expect(hooks.onEditModeChanged.mock.calls).toEqual([[false]])
  })
})

describe('the section sanitizer never lets edited text become code', () => {
  it.each([
    ['<p>a</p><script>alert(1)</script>', '<p>a</p>'],
    ['<img src="x" onerror="alert(1)">b', 'b'],
    ['<svg onload="alert(1)"><circle /></svg>c', 'c'],
    ['<iframe src="https://example.com"></iframe>d', 'd'],
    ['<style>p{}</style>e', 'e'],
    ['<p onclick="alert(1)" style="color:red" id="plan-meta" class="x">f</p>', '<p>f</p>'],
    ['<a href="javascript:alert(1)">g</a>', '<a>g</a>'],
    ['<a href="java\tscript:alert(1)">h</a>', '<a>h</a>'],
    ['<a href=" data:text/html,<script>alert(1)</script>">i</a>', '<a>i</a>'],
    ['<a href="vbscript:msgbox(1)">j</a>', '<a>j</a>'],
    ['<a href="https://example.com" onmouseover="alert(1)">k</a>', '<a href="https://example.com">k</a>'],
    ['<p>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>', '<p>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
    ['<script type="application/json" id="plan-meta">{"stage":"done"}</script>l', 'l'],
  ])('%s', (input, expected) => {
    expect(sanitizePlanSectionHtml(input)).toBe(expected)
  })
})

describe('header markup sync', () => {
  const doc = '<header><h1>Old<span class="pill draft">draft</span></h1><p class="overview">Old line</p></header><h1>Body h1</h1>'

  it('replaces the name before the stage pill and the overview, escaped', () => {
    expect(syncHeaderMarkup(doc, 'name', 'A <b>&</b>'))
      .toBe('<header><h1>A &lt;b&gt;&amp;&lt;/b&gt;<span class="pill draft">draft</span></h1><p class="overview">Old line</p></header><h1>Body h1</h1>')
    expect(syncHeaderMarkup(doc, 'overview', '<script>x</script>'))
      .toBe('<header><h1>Old<span class="pill draft">draft</span></h1><p class="overview">&lt;script&gt;x&lt;/script&gt;</p></header><h1>Body h1</h1>')
  })

  it('leaves a document without a header alone', () => {
    expect(syncHeaderMarkup('<h1>Only</h1>', 'name', 'New')).toBe('<h1>Only</h1>')
  })
})
