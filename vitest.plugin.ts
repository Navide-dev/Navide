// Vitest config for one App-bundled first-party plugin, plugins/<dir>.
//
// The root vitest.config.ts does not collect plugins/**: every plugin runs its
// own tests through its own plugins/<dir>/vitest.config.ts, so a plugin's
// suite, CI trigger and Marketplace release no longer ride on the App's.
// Paths stay relative to the repository root, as in the root config, so the
// workspace-package aliases and the artifact setup are shared until a plugin
// moves to a repository of its own.
//
//   pnpm vitest run --config plugins/navide-mini-ide/vitest.config.ts
//   pnpm test:plugins            # every plugin, one after another
import type { ViteUserConfig } from 'vitest/config'
import baseConfig, { excludedTests } from './vitest.config'

export interface PluginVitestOptions {
  /** Modules run before each test file, e.g. the plugin's own UI strings. */
  setupFiles?: string[]
  /** tests/ files that build whole packages and must take turns in one fork. */
  heavy?: string[]
}

const artifactSetup = ['tests/support/publicPackagesSetup.ts']

export function pluginVitestConfig(dir: string, options: PluginVitestOptions = {}): ViteUserConfig {
  const root = `plugins/${dir}`
  const unit = [`${root}/**/*.{test,spec}.ts`]
  const artifacts = [`${root}/tests/**/*.{test,spec}.ts`]
  const heavy = (options.heavy ?? []).map((file) => `${root}/${file}`)
  return {
    ...baseConfig,
    test: {
      ...baseConfig.test,
      projects: [
        { extends: true, test: {
          name: dir, include: unit, exclude: [...excludedTests, ...artifacts],
          setupFiles: options.setupFiles ?? [],
        } },
        { extends: true, test: {
          name: `${dir}-artifacts`, include: artifacts, exclude: [...excludedTests, ...heavy],
          setupFiles: options.setupFiles ?? [], globalSetup: artifactSetup,
        } },
        ...(heavy.length ? [{ extends: true as const, test: {
          name: `${dir}-artifacts-heavy`, include: heavy, exclude: excludedTests,
          setupFiles: options.setupFiles ?? [], globalSetup: artifactSetup,
          poolOptions: { forks: { singleFork: true } },
        } }] : []),
      ],
    },
  }
}
