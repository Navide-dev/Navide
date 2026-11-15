import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// While navide.git lives in this repository, its copy of the bridge contract
// and the Host's are one file twice; each side's own test freezes its copy.
describe('navide.git bridge contract copies', () => {
  it('are identical', () => {
    expect(readFileSync('plugins/navide-git/src/git-feature/gitBridgeContract.json', 'utf8'))
      .toBe(readFileSync('src/shared/gitBridgeContract.json', 'utf8'))
  })
})
