import { describe, expect, it } from 'vitest'
import { formatIssueForDispatch, type IssueDetail } from '../issueDispatch'

describe('formatIssueForDispatch', () => {
  const base: IssueDetail = {
    number: 42, title: 'A bug', state: 'open', author: 'alice',
    labels: ['bug'], assignees: [], updated_at: 'x',
    url: 'https://github.com/o/r/issues/42',
    body: 'Steps to reproduce', created_at: 'y', comments: [],
  }

  it('composes number, title, body and link', () => {
    const t = formatIssueForDispatch(base)
    expect(t).toContain('#42 A bug')
    expect(t).toContain('Steps to reproduce')
    expect(t).toContain('Link: https://github.com/o/r/issues/42')
  })

  it('includes comments when present', () => {
    const t = formatIssueForDispatch({
      ...base,
      comments: [{ author: 'bob', body: 'me too', created_at: 'z' }],
    })
    expect(t).toContain('--- comments ---')
    expect(t).toContain('bob: me too')
  })

  it('omits the comments section when there are none', () => {
    const t = formatIssueForDispatch(base)
    expect(t).not.toContain('--- comments ---')
  })

  it('omits the body section when body is empty', () => {
    const t = formatIssueForDispatch({ ...base, body: '   ' })
    expect(t).toContain('#42 A bug')
    // no stray body block — title is immediately followed by the link
    expect(t).not.toMatch(/A bug\n\n\s+\n/)
  })
})
