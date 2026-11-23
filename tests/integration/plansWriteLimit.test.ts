import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_BACKEND_BRIDGE_QUEUE_BYTES } from '../../src/main/plugins/pluginBackendLimits'

// navide-plans' src/planPaging.ts SINGLE_WRITE_MAX_JSON_BYTES, recorded for the
// pinned version; navide-plans checks its own constant against the same value.
const contract = JSON.parse(readFileSync('tests/fixtures/navide-plans/contract.json', 'utf8')) as {
  singleWriteMaxJsonBytes: number
}

describe('Plans single-write limit', () => {
  it('keeps a single plans.write_document at half the Host input queue, leaving room for envelope and concurrent frames', () => {
    expect(contract.singleWriteMaxJsonBytes).toBe(MAX_BACKEND_BRIDGE_QUEUE_BYTES / 2)
  })
})
