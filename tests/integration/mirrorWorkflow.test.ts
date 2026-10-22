import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

describe('mirror workflow', () => {
  const workflow = parse(readFileSync('.github/workflows/mirror.yml', 'utf8'))
  const steps = workflow.jobs.mirror.steps as Array<{ name?: string }>
  const indexOf = (name: string): number => steps.findIndex((step) => step.name === name)

  it('verifies the mirrored bytes before it points the updater feed at them', () => {
    // releases/latest/ is the updater's feed: swapping it before the check
    // would ship a release whose mirror failed while GitHub keeps it a draft.
    const verify = indexOf('Verify the mirror serves what GitHub serves')
    const replaceLatest = indexOf('Replace releases/latest/')
    expect(verify).toBeGreaterThan(-1)
    expect(replaceLatest).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(replaceLatest)
  })

  it('keeps whats-new.json best effort: its steps never fail the mirror', () => {
    // The installers are the mirror's job; the announcements file is extra.
    // Every step that touches it continues on error, and the installer steps
    // never mention it, so a failed export or upload cannot fail the job.
    for (const name of ['Set up Node.js', 'Export the announcements as whats-new.json', 'Publish whats-new.json']) {
      const step = steps[indexOf(name)] as { 'continue-on-error'?: boolean }
      expect(step, name).toBeDefined()
      expect(step['continue-on-error'], name).toBe(true)
    }
    for (const name of ['Download the release (a draft when called by release.yml)', 'Upload to releases/<tag>/', 'Verify the mirror serves what GitHub serves', 'Replace releases/latest/']) {
      const step = steps[indexOf(name)] as { run: string; 'continue-on-error'?: boolean }
      expect(step.run, name).not.toContain('whats-new')
      expect(step['continue-on-error'], name).toBeUndefined()
    }
    const publish = steps[indexOf('Publish whats-new.json')] as { if: string; run: string }
    expect(publish.if).toContain("steps.whats_new_export.outcome == 'success'")
    // After latest/ is replaced, or that sync's --delete would remove it.
    expect(indexOf('Publish whats-new.json')).toBeGreaterThan(indexOf('Replace releases/latest/'))
    expect(publish.run).toContain('releases/latest/whats-new.json')
    const warn = steps[indexOf('Warn when whats-new.json was not published')] as { if: string; run: string }
    expect(warn.if).toContain("steps.whats_new_export.outcome == 'failure'")
    expect(warn.if).toContain("steps.whats_new_publish.outcome == 'failure'")
    expect(warn.run).toContain('::warning::')
  })
})
