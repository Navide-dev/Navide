import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Both Git panels (the navide.git plugin and the renderer's recovery copy)
// show why a history or commit read failed, the same way.
const root = join(__dirname, '..', '..', '..')
const copies = {
  plugin: readFileSync(join(root, 'plugins/navide-git/src/components/GitPane.vue'), 'utf8'),
  renderer: readFileSync(join(root, 'src/renderer/src/components/GitPane.vue'), 'utf8'),
}

describe.each(Object.entries(copies))('GitPane (%s) — read errors', (_name, source) => {
  it('shows the history read error above the list it keeps', () => {
    const error = source.indexOf(`<div v-if="logError" class="read-error" role="alert">{{ $t('git.read-failed', { reason: logError }) }}</div>`)
    const empty = source.indexOf(`<div v-if="!latestLog.length" class="empty-msg">`)
    expect(error).toBeGreaterThan(-1)
    expect(empty).toBeGreaterThan(error)
  })

  it('shows the commit read error where the detail would be', () => {
    expect(source).toMatch(
      /v-if="commitDetailLoading"[^\n]*\n\s*<div v-else-if="!commitDetailData && commitDetailError" class="read-error" role="alert">\{\{ \$t\('git\.read-failed', \{ reason: commitDetailError \}\) \}\}<\/div>\n\s*<template v-else-if="commitDetailData">/,
    )
  })

  it('takes both errors from useGit', () => {
    expect(source).toContain('gitStatus, statusError, logError, commitDetailError, statusLoaded,')
  })
})
