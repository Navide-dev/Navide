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
    // never mention it, so a failed export, upload or check cannot fail the job.
    const whatsNew = [
      'Set up Node.js', 'Export the announcements as whats-new.json',
      'Publish whats-new.json to releases/<tag>/', 'Publish whats-new.json to releases/latest/',
      'Check the mirrored whats-new.json',
    ]
    for (const name of whatsNew) {
      const step = steps[indexOf(name)] as { 'continue-on-error'?: boolean }
      expect(step, name).toBeDefined()
      expect(step['continue-on-error'], name).toBe(true)
    }
    for (const name of ['Download the release (a draft when called by release.yml)', 'Upload to releases/<tag>/', 'Verify the mirror serves what GitHub serves', 'Replace releases/latest/']) {
      const step = steps[indexOf(name)] as { run: string; 'continue-on-error'?: boolean }
      expect(step.run, name).not.toContain('whats-new')
      expect(step['continue-on-error'], name).toBeUndefined()
    }
    // latest/ is uploaded after Replace (whose --delete removed it), only when
    // Replace ran, and never waits on the releases/<tag>/ upload or check.
    const latest = steps[indexOf('Publish whats-new.json to releases/latest/')] as { if: string; run: string }
    expect(indexOf('Publish whats-new.json to releases/latest/')).toBeGreaterThan(indexOf('Replace releases/latest/'))
    expect(latest.if).toContain("steps.replace_latest.outcome == 'success'")
    expect(latest.if).not.toContain('whats_new_publish')
    expect(latest.if).not.toContain('whats_new_check')
    expect(indexOf('Check the mirrored whats-new.json')).toBeGreaterThan(indexOf('Publish whats-new.json to releases/latest/'))
    expect(latest.run).not.toContain('cmp')
    const warn = steps[indexOf('Warn when whats-new.json was not published')] as { if: string; run: string }
    for (const id of ['whats_new_export', 'whats_new_publish', 'whats_new_latest']) expect(warn.if).toContain(id)
    expect(warn.run).toContain('::warning::')
    expect(warn.run).toContain('GITHUB_STEP_SUMMARY')
  })
})
