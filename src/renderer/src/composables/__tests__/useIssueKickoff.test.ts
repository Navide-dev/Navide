import { describe, it, expect } from 'vitest'
import { buildIssueKickoff } from '../../lib/issueDispatch'
import type { Issue } from '../../lib/issueDispatch'

const baseIssue: Issue = {
  number: 7,
  title: 'Button does not respond on mobile',
  state: 'open',
  author: 'alice',
  labels: ['bug'],
  assignees: [],
  updated_at: '2026-06-01T00:00:00Z',
  url: 'https://github.com/org/repo/issues/7',
}

describe('buildIssueKickoff', () => {
  it('includes the issue number and title', () => {
    const text = buildIssueKickoff(baseIssue, 'github', 'guided')
    expect(text).toContain('#7')
    expect(text).toContain('Button does not respond on mobile')
  })

  it('guided mode: contains the STOP instruction', () => {
    const text = buildIssueKickoff(baseIssue, 'github', 'guided')
    expect(text).toContain('STOP here')
  })

  it('auto mode: does NOT contain the STOP instruction', () => {
    const text = buildIssueKickoff(baseIssue, 'github', 'auto')
    expect(text).not.toContain('STOP here')
  })

  it('auto mode: mentions autonomous end-to-end', () => {
    const text = buildIssueKickoff(baseIssue, 'github', 'auto')
    expect(text).toContain('autonomously')
  })

  it('github provider: uses gh close command', () => {
    const text = buildIssueKickoff(baseIssue, 'github', 'auto')
    expect(text).toContain('gh issue close 7')
    expect(text).not.toContain('glab')
  })

  it('gitlab provider: uses glab close command', () => {
    const text = buildIssueKickoff(baseIssue, 'gitlab', 'auto')
    expect(text).toContain('glab issue close 7')
    expect(text).not.toContain('gh issue close')
  })

  it('github provider: uses gh view command', () => {
    const text = buildIssueKickoff(baseIssue, 'github', 'guided')
    expect(text).toContain('gh issue view 7')
  })

  it('gitlab provider: uses glab view command', () => {
    const text = buildIssueKickoff(baseIssue, 'gitlab', 'guided')
    expect(text).toContain('glab issue view 7')
  })

  it('unknown provider: falls back to gh commands', () => {
    const text = buildIssueKickoff(baseIssue, 'unknown', 'auto')
    expect(text).toContain('gh issue view 7')
    expect(text).toContain('gh issue close 7')
  })
})
