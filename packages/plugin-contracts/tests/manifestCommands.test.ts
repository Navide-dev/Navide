import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseManifestV2 } from '../src/index'

function manifest(commands?: unknown): Record<string, any> {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.runner',
    name: 'Runner',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'A runner fixture.', license: 'MIT' },
    contributes: {
      views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Runner', entry: 'frontend/main/index.html' }],
      ...(commands === undefined ? {} : { commands }),
    },
    backend: { entry: 'backend/runner', protocolVersion: 1, activation: 'startup', methods: ['tests.run'] },
  }
}

const viewCommand = { id: 'acme.runner.runTests', title: 'Run tests', run: { view: 'main' } }

function refusal(raw: Record<string, any>): string {
  try {
    parseManifestV2(raw)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the manifest to be refused')
}

describe('a manifest with no commands', () => {
  it('parses to exactly what it did before the field existed', () => {
    const parsed = parseManifestV2(manifest())
    expect(parsed.contributes).toEqual(manifest().contributes)
    expect(Object.keys(parsed.contributes ?? {})).toEqual(['views'])
  })
})

describe('contributes.commands', () => {
  it('accepts a view command and a method command', () => {
    const commands = [
      { ...viewCommand, run: { view: 'main', target: { tab: 'tests' } }, suggestedKey: 'cmd+alt+t' },
      { id: 'acme.runner.runAll', title: 'Run all', run: { method: 'tests.run' } },
    ]
    expect(parseManifestV2(manifest(commands)).contributes?.commands).toEqual(commands)
  })

  it.each([
    ['an empty list', [], /must contain 1-32/],
    ['too many', Array.from({ length: 33 }, (_, i) => ({ ...viewCommand, id: `acme.runner.c${i}` })), /must contain 1-32/],
    ['another plugin\'s prefix', [{ ...viewCommand, id: 'other.runner.runTests' }], /is invalid/],
    ['a Host id', [{ ...viewCommand, id: 'workbench.action.showCommands' }], /is invalid/],
    ['no name after the plugin id', [{ ...viewCommand, id: 'acme.runner' }], /is invalid/],
    ['a duplicate', [viewCommand, viewCommand], /declared twice/],
    ['an unknown field', [{ ...viewCommand, when: 'x' }], /unknown field 'when'/],
    ['an unsafe title', [{ ...viewCommand, title: '<b>Run</b>' }], /unsafe characters/],
    ['no run', [{ id: viewCommand.id, title: 't' }], /missing required field 'run'/],
    ['an empty run', [{ ...viewCommand, run: {} }], /must name a view or a method/],
    ['view and method together', [{ ...viewCommand, run: { view: 'main', method: 'tests.run' } }], /unknown field 'method'/],
    ['an undeclared view', [{ ...viewCommand, run: { view: 'other' } }], /not a view this manifest declares/],
    ['an undeclared method', [{ ...viewCommand, run: { method: 'tests.stop' } }], /not listed in backend.methods/],
    ['a shell string', [{ ...viewCommand, run: { shell: 'rm -rf /' } }], /must name a view or a method/],
    ['a non-string target', [{ ...viewCommand, run: { view: 'main', target: { tab: 1 } } }], /target\.tab/],
  ])('refuses %s', (_name, commands, message) => {
    expect(refusal(manifest(commands))).toMatch(message)
  })

  it.each(['workbench', 'ui', 'editor', 'git', 'navide'])('refuses commands under the Host namespace %s', (head) => {
    const raw = manifest([{ ...viewCommand, id: `${head}.runner.runTests` }])
    raw.id = `${head}.runner`
    raw.publisher = head
    expect(refusal(raw)).toMatch(/namespace of Navide's own commands/)
  })

  it('lets a Host-named publisher declare everything but commands', () => {
    const raw = manifest()
    raw.id = 'git.runner'
    raw.publisher = 'git'
    expect(parseManifestV2(raw).id).toBe('git.runner')
  })
})

describe('the two schema copies', () => {
  it('stay identical', () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
    expect(read('packages/plugin-contracts/src/schemas/plugin-manifest-v2.schema.json'))
      .toBe(read('docs/plugin-contracts/plugin-manifest-v2.schema.json'))
  })
})
