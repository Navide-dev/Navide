import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GIT_EVENT_TYPES, GIT_REQUEST_TYPES } from '../gitTransport'

const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const gitConsumerRoots = [
  join(repositoryRoot, 'src/renderer/src'),
  join(repositoryRoot, 'plugins/navide-git/src'),
]

function collectGitConsumerSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory() && entry.name === '__tests__') return []
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) return collectGitConsumerSources(entryPath)
      if (
        !entry.isFile()
        || !/\.(ts|vue)$/.test(entry.name)
        || /\.(test|spec)\.(ts|vue)$/.test(entry.name)
      ) return []
      return [entryPath]
    })
    .sort()
}

function collectGitTypes(pattern: RegExp): string[] {
  const matches = new Set<string>()
  for (const sourcePath of gitConsumerRoots.flatMap(collectGitConsumerSources)) {
    const source = readFileSync(sourcePath, 'utf8')
    pattern.lastIndex = 0
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      matches.add(match[1])
    }
  }
  return [...matches].sort()
}

const requestCallPattern = /\b(?:send|runWrite)\s*(?:<[\s\S]*?>\s*)?\(\s*['"](git\.[a-z_]+)['"]/g
const eventSubscriptionPattern = /\bon\s*\(\s*['"](git\.[a-z_]+)['"]/g

describe('Git transport inventory', () => {
  it('matches every Git request issued by the plugin and the Host', () => {
    expect(collectGitTypes(requestCallPattern)).toEqual([...GIT_REQUEST_TYPES].sort())
  })

  it('matches every Git event subscribed by the plugin and the Host', () => {
    expect(collectGitTypes(eventSubscriptionPattern)).toEqual([...GIT_EVENT_TYPES].sort())
  })
})
