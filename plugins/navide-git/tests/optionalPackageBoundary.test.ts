import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  HOST_GIT_EVENT_TYPES,
  HOST_GIT_REQUEST_TYPES,
  HOST_GIT_TIMEOUT_MS,
  type HostGitTransport,
  type HostGitTransportError,
  type HostGitTransportResponse,
  type HostGitTransportStatusSource,
} from '../../../src/shared/gitCompatibility'
import {
  DEFAULT_GIT_TIMEOUT_MS,
  GIT_EVENT_TYPES,
  GIT_REQUEST_TYPES,
  type GitTransport,
  type GitTransportError,
  type GitTransportResponse,
  type GitTransportStatusSource,
} from '../src/git-feature/gitTransport'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function sourceText(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) return sourceText(path)
      return /\.(?:ts|vue)$/.test(entry.name) ? readFileSync(path, 'utf8') : ''
    })
    .join('\n')
}

function productionSourceText(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name === '__tests__' || /\.(?:test|spec)\.ts$/.test(entry.name)) return ''
      const path = join(root, entry.name)
      if (entry.isDirectory()) return productionSourceText(path)
      return /\.(?:ts|vue)$/.test(entry.name) ? readFileSync(path, 'utf8') : ''
    })
    .join('\n')
}

describe('factory first-party package boundary', () => {
  it('does not keep a second private feature package system', () => {
    expect(existsSync(join(repositoryRoot, 'packages', 'features'))).toBe(false)
    expect(existsSync(join(repositoryRoot, 'packages', 'internal'))).toBe(false)
  })

  it('builds navide.git only from public plugin packages', () => {
    const manifest = readJson(join(repositoryRoot, 'plugins', 'navide-git', 'package.json'))
    const dependencies = Object.keys((manifest.dependencies ?? {}) as Record<string, string>)

    expect(dependencies.sort()).toEqual([
      '@navide/plugin-ui',
      'vue',
      'vue-i18n',
    ])
  })

  it('does not import Host implementation aliases', () => {
    const source = sourceText(join(repositoryRoot, 'plugins', 'navide-git', 'src'))
    for (const privateAlias of ['@navide/git-feature', '@navide/terminal', '@navide/plugin-shell']) {
      expect(source.includes(privateAlias), privateAlias).toBe(false)
    }
  })

  it('keeps the optional Git package out of the Host production build graph', () => {
    const hostSource = [
      productionSourceText(join(repositoryRoot, 'src', 'main')),
      productionSourceText(join(repositoryRoot, 'src', 'preload')),
      productionSourceText(join(repositoryRoot, 'src', 'renderer')),
      readFileSync(join(repositoryRoot, 'electron.vite.config.ts'), 'utf8'),
      readFileSync(join(repositoryRoot, 'vite.mini-ide.config.ts'), 'utf8'),
      readFileSync(join(repositoryRoot, 'vite.plans.config.ts'), 'utf8'),
      readFileSync(join(repositoryRoot, 'vitest.config.ts'), 'utf8'),
      readFileSync(join(repositoryRoot, 'tsconfig.node.json'), 'utf8'),
      readFileSync(join(repositoryRoot, 'tsconfig.web.json'), 'utf8'),
    ].join('\n')

    expect(hostSource).not.toContain("from '@navide/git-feature'")
    expect(hostSource).not.toContain('plugins/navide-git/src/git-feature')
  })

  it('keeps the temporary Host recovery inventory aligned with navide.git', () => {
    expect(HOST_GIT_REQUEST_TYPES).toEqual(GIT_REQUEST_TYPES)
    expect(HOST_GIT_EVENT_TYPES).toEqual(GIT_EVENT_TYPES)
    expect(HOST_GIT_TIMEOUT_MS).toBe(DEFAULT_GIT_TIMEOUT_MS)
    expectTypeOf<HostGitTransport>().toEqualTypeOf<GitTransport>()
    expectTypeOf<HostGitTransportResponse>().toEqualTypeOf<GitTransportResponse>()
    expectTypeOf<HostGitTransportError>().toEqualTypeOf<GitTransportError>()
    expectTypeOf<HostGitTransportStatusSource>().toEqualTypeOf<GitTransportStatusSource>()
  })

  it('ships versioned factory artifacts and no legacy Git bundle', () => {
    const manifest = readJson(join(repositoryRoot, 'package.json'))
    const scripts = (manifest.scripts ?? {}) as Record<string, string>
    const build = (manifest.build ?? {}) as { extraResources?: Array<{ from?: string }> }
    const resourceSources = (build.extraResources ?? []).map((entry) => entry.from ?? '')

    expect(scripts.build).toContain('build:official-plugins')
    expect(scripts.build).not.toContain('build:git:legacy')
    expect(resourceSources).toContain('dist-plugins/mini-ide')
    expect(resourceSources).toContain('dist-plugins/plans')
    expect(resourceSources).not.toContain('dist-plugins/git')
    expect(resourceSources).toContain('dist-plugins/official-artifacts/factory-resources')
  })
})
