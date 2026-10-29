import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseManifestV2 as parseContractManifest } from '../../../packages/plugin-contracts/src/index'
import { parseManifestV2 } from '../../../src/main/plugins/pluginManifestV2'

// The release build validates the staged package with the same contract
// (navide-plugin validate); a backend method named `browser.take_over` passed
// every unit test and only failed there. Parse the source manifest here so a
// name, schema or agent-tool rule the contract refuses fails early.

const sourceDir = resolve(fileURLToPath(new URL('..', import.meta.url)))

describe('Navide Browser source manifest', () => {
  it('passes the Manifest v2 contract, agent tools included', () => {
    const raw = JSON.parse(readFileSync(`${sourceDir}/manifest.json`, 'utf8')) as Record<string, unknown>
    // The SDK validator's rules (backend.methods names) and the Host's (agent tools).
    expect(() => parseContractManifest(raw)).not.toThrow()
    const parsed = parseManifestV2(raw)
    expect(parsed.id).toBe('navide.browser')
    const backend = parsed.backend!
    // Every tool's method is declared, and every declared method is served by a tool.
    expect([...new Set(backend.agentTools!.map((tool) => tool.method))].sort()).toEqual([...backend.methods].sort())
  })
})
