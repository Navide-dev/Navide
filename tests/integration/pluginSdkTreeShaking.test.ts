import { describe, expect, inject, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'

// A third-party plugin bundles the packed SDK with its own bundler. The
// Registry scanner reads capability addresses out of that bundle, so any SDK
// code the plugin does not call must be removable, or the scan reports
// capabilities the plugin never uses (devmap 0.2.0: aiCli, ui).
async function bundleConsumer(source: string): Promise<string> {
  const tarballs = inject('publicPackageTarballs')
  // The runner's TEMP can be an 8.3 short path (C:\Users\RUNNER~1).
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'navide-sdk-tree-shaking-')))
  try {
    for (const name of ['@navide/plugin-contracts', '@navide/plugin-sdk']) {
      const directory = join(root, 'node_modules', name)
      mkdirSync(directory, { recursive: true })
      execFileSync('tar', ['-xzf', tarballs[name], '--strip-components=1', '-C', directory])
    }
    writeFileSync(join(root, 'main.js'), source)
    const outDir = join(root, 'dist')
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir,
        minify: false,
        lib: { entry: join(root, 'main.js'), formats: ['es'], fileName: 'main' },
      },
    })
    return readdirSync(outDir).map((file) => readFileSync(join(outDir, file), 'utf8')).join('\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('public plugin packages are tree-shakeable', () => {
  it('bundles no capability address for a plugin that only uses PluginError', async () => {
    const bundle = await bundleConsumer(`
import { PluginError } from '@navide/plugin-sdk'
console.log(new PluginError('INTERNAL_ERROR', 'probe').code)
`)
    expect(bundle).toContain('class PluginError')
    expect(bundle).not.toContain('aiCli.generateCommitMessage')
    expect(bundle).not.toContain('ui.openPluginWindow')
  }, 120_000)

  it('bundles only the capabilities a view that calls ready() and PluginError uses', async () => {
    const bundle = await bundleConsumer(`
import { PluginError, viewReady } from '@navide/plugin-sdk'
try { viewReady() } catch (error) { if (!(error instanceof PluginError)) throw error }
`)
    expect(bundle).toContain('Plugin view runtime is unavailable.')
    expect(bundle).not.toContain('aiCli.generateCommitMessage')
    expect(bundle).not.toContain('ui.openPluginWindow')
  }, 120_000)

  it('still bundles the window capability when a view imports it on its own', async () => {
    const bundle = await bundleConsumer(`
import { openContributionWindow } from '@navide/plugin-sdk'
void openContributionWindow({ contributionKey: 'acme.demo.window' })
`)
    expect(bundle).toContain('ui.openPluginWindow')
    expect(bundle).not.toContain('aiCli.generateCommitMessage')
  }, 120_000)

  it('drops the reverse git method table when a plugin reads only the forward mapping', async () => {
    const bundle = await bundleConsumer(`
import { gitCapabilityMethod } from '@navide/plugin-contracts'
console.log(gitCapabilityMethod('status'))
`)
    expect(bundle).toContain('function gitCapabilityMethod')
    expect(bundle).not.toContain('Object.fromEntries')
  }, 120_000)
})
