import { describe, expect, it } from 'vitest'
import { mcpRiskKinds } from '../mcpRisk'

describe('mcpRiskKinds', () => {
  it('names a known package however it is launched or pinned', () => {
    expect(mcpRiskKinds([{ command: 'uvx', args: ['windows-mcp'] }])).toEqual(['desktop', 'shell'])
    expect(mcpRiskKinds([{ command: 'uvx', args: ['windows-mcp==0.5.0'] }])).toEqual(['desktop', 'shell'])
    expect(mcpRiskKinds([{ command: 'npx', args: ['-y', '@wonderwhy-er/desktop-commander@latest'] }])).toEqual(['shell'])
  })

  it('flags a server that reports a shell tool, case-folded', () => {
    expect(mcpRiskKinds([{ command: 'node', tools: [{ name: 'PowerShell' }] }])).toEqual(['shell'])
    expect(mcpRiskKinds([{ tools: [{ name: 'run_command' }] }])).toEqual(['shell'])
  })

  it('leaves ordinary servers and look-alike names alone', () => {
    expect(mcpRiskKinds([{ command: 'npx', args: ['-y', '@upstash/context7-mcp'] }])).toEqual([])
    expect(mcpRiskKinds([{ tools: [{ name: 'shell_lint' }, { name: 'process' }, { name: 'filesystem' }] }])).toEqual([])
    expect(mcpRiskKinds([{ command: 'npx', args: ['windows-mcp-docs'] }])).toEqual([])
    expect(mcpRiskKinds([])).toEqual([])
  })
})
