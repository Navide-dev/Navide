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

  it('exports whats-new.json before uploading it, and puts it in latest/ after the --delete syncs', () => {
    const exportStep = indexOf('Export the announcements as whats-new.json')
    expect(exportStep).toBeGreaterThan(-1)
    expect(exportStep).toBeLessThan(indexOf('Upload to releases/<tag>/'))
    const run = (steps[indexOf('Replace releases/latest/')] as { run: string }).run
    const copy = run.indexOf('whats-new.json "s3://${MIRROR_BUCKET}/releases/latest/whats-new.json"')
    expect(copy).toBeGreaterThan(run.lastIndexOf('--delete'))
  })
})
