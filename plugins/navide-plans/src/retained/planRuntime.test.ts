// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { preparePlanDocHtml } from '../planSecurity'
import { buildPlanRuntimeScript, buildTodoStatusRuntime } from './planRuntime'
import { replaceSectionBody } from './usePlanHtml'

const windows: Window[] = []
afterEach(async () => {
  await Promise.all(windows.splice(0).map(window => window.happyDOM.abort()))
})

describe('packaged Plans runtime', () => {
  it('injects layout overrides so wide tables wrap and the document uses the frame width', () => {
    const window = new Window()
    windows.push(window)
    window.document.body.innerHTML = '<div class="wrap"><div class="tablewrap"><table><tr><td>x</td></tr></table></div></div>'
    window.eval(buildPlanRuntimeScript({
      documentToken: 'current', anchors: {}, scrollY: 0,
      commentLabel: 'Comment', editLabel: 'Edit', deleteLabel: 'Delete', saveLabel: 'Save', cancelLabel: 'Cancel',
    }))
    const css = [...window.document.querySelectorAll('style')].map(s => s.textContent).join('')
    expect(css).toContain('.tablewrap td,.tablewrap td code{overflow-wrap:anywhere}')
    expect(css).toContain('.wrap{max-width:1180px}')
    expect(css).toContain('.wrap td ul,.wrap td p{max-width:none}')
  })

  it('updates and removes note badges only for the authenticated current preview', () => {
    const window = new Window()
    windows.push(window)
    window.document.body.innerHTML = '<section><h2>Scope</h2><p>Details</p></section>'
    window.eval(buildPlanRuntimeScript({
      documentToken: 'current', anchors: {}, scrollY: 0,
      commentLabel: 'Comment', editLabel: 'Edit', deleteLabel: 'Delete', saveLabel: 'Save', cancelLabel: 'Cancel',
    }))
    const update = (anchors: Record<string, number>, token = 'current', source: unknown = window.eval('parent')) => {
      const event = new window.MessageEvent('message', {
        data: { type: 'review-note-anchors-updated', documentToken: token, anchors },
      })
      Object.defineProperty(event, 'source', { value: source })
      window.dispatchEvent(event)
    }
    update({ Scope: 2 }, 'stale')
    update({ Scope: 2 }, 'current', {})
    expect(window.document.querySelector('.plan-rt-badge')).toBeNull()
    update({ Scope: 2 })
    expect(window.document.querySelector('.plan-rt-badge')?.textContent).toBe('2')
    update({ Scope: 1 })
    expect(window.document.querySelector('.plan-rt-badge')?.textContent).toBe('1')
    update({})
    expect(window.document.querySelector('.plan-rt-badge')).toBeNull()
  })

  it.each([false, true])('edits prose without replacing the heading or neighboring content (section=%s)', (section) => {
    const window = new Window()
    windows.push(window)
    const body = '<p>Original risk</p><h3>Mitigation</h3><p>Keep this detail</p>'
    const region = `<h2>Risks</h2>${body}`
    const source = `<html><body><h1>Plan</h1>${section ? `<section>${region}</section>` : region}<h2>Validation</h2><p>Keep validation</p></body></html>`
    window.document.body.innerHTML = source
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    window.eval(buildPlanRuntimeScript({
      documentToken: 'test-token', anchors: {}, scrollY: 0,
      commentLabel: 'Comment', editLabel: 'Edit', deleteLabel: 'Delete', saveLabel: 'Save', cancelLabel: 'Cancel',
    }))
    const heading = window.document.querySelector('h2')!
    const regionElement = heading.closest('section') ?? heading.closest('.plan-rt-section') ?? heading
    regionElement.dispatchEvent(new window.MouseEvent('mouseenter'))
    const button = (label: string) => [...window.document.querySelectorAll('.plan-rt-secbar button')].find(node => node.textContent === label)!
    button('Edit').dispatchEvent(new window.MouseEvent('click'))
    const editable = window.document.querySelector('[contenteditable="true"]')!
    expect(editable.textContent).toContain('Original risk')
    editable.querySelector('p')!.textContent = 'Updated risk'
    button('Save').dispatchEvent(new window.MouseEvent('click'))
    const edit = postMessage.mock.calls.map(([message]) => message).find(
      (message): message is { type: 'section-edit'; html: string } => typeof message === 'object' && message !== null
        && 'type' in message && message.type === 'section-edit' && 'html' in message && typeof message.html === 'string',
    )
    expect(edit).toMatchObject({ anchor: 'Risks', html: '<p>Updated risk</p><h3>Mitigation</h3><p>Keep this detail</p>' })
    if (!edit) throw new Error('Runtime did not emit a section edit')
    const result = replaceSectionBody(source, 'Risks', edit.html)
    expect(result).toBe(source.replace(body, `\n${edit.html}\n`))
  })

  it('keeps the enclosing document tags and the next higher heading when replacing a final prose body', () => {
    const source = '<html><body><main><h2>Risks</h2><p>Old</p></main><h1>Appendix</h1></body></html>'
    expect(replaceSectionBody(source, 'Risks', '<p>New</p>')).toBe(
      '<html><body><main><h2>Risks</h2>\n<p>New</p>\n</main><h1>Appendix</h1></body></html>',
    )
  })

  // In the about:srcdoc frame "#id" resolves against the host URL, so the
  // default click never reaches :target (a CSS lightbox stays shut).
  it('keeps "#id" link clicks inside the frame so :target lightboxes open and close', () => {
    const window = new Window({ url: 'about:srcdoc' })
    windows.push(window)
    window.document.body.innerHTML =
      '<div class="rp-z" id="z1"><a id="open" href="#z1"><img alt=""></a><a id="close" href="#_">x</a></div>' +
      '<a id="external" href="https://example.com/">out</a>'
    window.eval(buildPlanRuntimeScript({
      documentToken: 'current', anchors: {}, scrollY: 0,
      commentLabel: 'Comment', editLabel: 'Edit', deleteLabel: 'Delete', saveLabel: 'Save', cancelLabel: 'Cancel',
    }))
    const click = (selector: string) => {
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
      window.document.querySelector(selector)!.dispatchEvent(event)
      return event
    }
    expect(click('#open img').defaultPrevented).toBe(true)
    expect(window.location.hash).toBe('#z1')
    expect(click('#close').defaultPrevented).toBe(true)
    expect(window.location.hash).toBe('#_')
    expect(click('#external').defaultPrevented).toBe(false)
  })

  it('embeds todo IDs containing a script close safely while preserving their values', () => {
    const todoIds = ['</script><script>bad()</script>', 'quote"<&']
    const prepared = preparePlanDocHtml('<html><body><h2>Tasks</h2></body></html>', {
      buildTrustedRuntimeScript: ({ documentToken }) => buildTodoStatusRuntime(documentToken, todoIds),
    })
    const document = new DOMParser().parseFromString(prepared.html, 'text/html')
    expect(document.querySelectorAll('script')).toHaveLength(1)
    const runtime = document.querySelector('script')!.textContent!
    expect(runtime).not.toContain('</script')
    expect(JSON.parse(runtime.match(/var validTodoIds = (.*);/)![1])).toEqual(todoIds)
  })
})

// Regression: an <h2> with no <section> ancestor is editable like any other, so
// the preview must serialize only that heading's own sibling prose and the host
// must replace exactly that range — never the heading text, a sibling of the
// heading's container, or the container's own closing tag.
describe('section-less heading edits round-trip', () => {
  // Drives the real runtime in happy-dom (hover the region, click Edit, rewrite
  // the first paragraph, click Save) and feeds the real postMessage payload to
  // the real host-side writer.
  function editFirstHeading(source: string, anchor: string, rewritten: string) {
    const window = new Window()
    windows.push(window)
    window.document.body.innerHTML = source
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    window.eval(buildPlanRuntimeScript({
  documentToken: 'test-token', anchors: {}, scrollY: 0,
  commentLabel: 'Comment', editLabel: 'Edit', deleteLabel: 'Delete', saveLabel: 'Save', cancelLabel: 'Cancel',
}))
    const heading = window.document.querySelector('h2')!
    const region = heading.closest('section') ?? heading.closest('.plan-rt-section') ?? heading
    region.dispatchEvent(new window.MouseEvent('mouseenter'))
    const button = (label: string) =>
      [...window.document.querySelectorAll('.plan-rt-secbar button')].find(
        (node) => node.textContent === label,
      )!
    button('Edit').dispatchEvent(new window.MouseEvent('click'))
    const editable = window.document.querySelector('[contenteditable="true"]')!
    // The editable region is the heading's prose body, never the bare heading.
    expect(editable.querySelector('p')).not.toBeNull()
    editable.querySelector('p')!.textContent = rewritten
    button('Save').dispatchEvent(new window.MouseEvent('click'))
    const edit = postMessage.mock.calls
      .map(([message]) => message)
      .find(
        (message): message is { type: 'section-edit'; anchor: string; html: string } =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'section-edit',
      )
    if (!edit) throw new Error('Runtime did not emit a section edit')
    return { edit, written: replaceSectionBody(source, anchor, edit.html) }
  }

  it('replaces only the prose of a heading that has no section ancestor', () => {
    const body = '<p>Original risk</p><h3>Mitigation</h3><p>Keep this detail</p>'
    const source = `<h1>Plan</h1><h2>Risks</h2>${body}<h2>Validation</h2><p>Keep validation</p>`
    const { edit, written } = editFirstHeading(source, 'Risks', 'Updated risk')
    expect(edit.html).toBe('<p>Updated risk</p><h3>Mitigation</h3><p>Keep this detail</p>')
    expect(written).toBe(source.replace(body, `\n${edit.html}\n`))
  })

  it.each([
    [
      'an aside followed by siblings',
      '<aside><h2>Note</h2><p>n</p></aside><p>after</p><h2>Next</h2><p>x</p>',
      'Note',
      '<p>n</p>',
    ],
    [
      'a table cell',
      '<table><tr><td><h2>Cell</h2><p>c</p></td><td>other</td></tr></table>',
      'Cell',
      '<p>c</p>',
    ],
    [
      'a list item',
      '<ul><li><h2>Alpha</h2><p>a</p></li><li><h2>Beta</h2><p>b</p></li></ul>',
      'Alpha',
      '<p>a</p>',
    ],
    ['a header element', '<header><h2>Subtitle</h2><p>meta</p></header>', 'Subtitle', '<p>meta</p>'],
  ])('clamps the edited body to %s', (_case, source, anchor, body) => {
    const { edit, written } = editFirstHeading(source, anchor, 'Rewritten')
    expect(edit.html).toBe('<p>Rewritten</p>')
    expect(written).toBe(source.replace(body, `\n${edit.html}\n`))
  })
})
