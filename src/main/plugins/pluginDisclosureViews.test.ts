// R2 MED-6 on #436: the disclosure card says a Navide plugin's views can reach
// the network only for a package that has views. The Host reads that from the
// manifest's `contributes.views`, outside the signed disclosure card.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { manifestHasViews, type InstalledManifest } from './pluginManifest'

const v2 = (extra: Record<string, unknown>): InstalledManifest =>
  ({ schemaVersion: 2, id: 'acme.demo', version: '1.0.0', publisher: 'acme', ...extra }) as unknown as InstalledManifest

describe('manifestHasViews', () => {
  it('is true for a v2 package with views and false for one without contributes', () => {
    expect(manifestHasViews(v2({ contributes: { views: [{ id: 'main', kind: 'custom' }] } }))).toBe(true)
    // Backend or agent tools only, or an extension pack: no view.
    expect(manifestHasViews(v2({ backend: { entry: 'bin/demo' } }))).toBe(false)
    expect(manifestHasViews(v2({ extensionPack: ['acme.a'] }))).toBe(false)
  })

  it('treats a v1 package, which is a frontend, as having views', () => {
    expect(manifestHasViews({ schemaVersion: 1, id: 'acme.old' } as unknown as InstalledManifest)).toBe(true)
  })
})

describe('every disclosure card source passes hasViews', () => {
  const ipc = readFileSync(resolve(process.cwd(), 'src/main/plugins/pluginIpc.ts'), 'utf8')

  it('sets it on the Marketplace, file and folder install summaries, and on the kept-version rollback consent (L4)', () => {
    expect(ipc.match(/^\s+hasViews: manifestHasViews\(/gm)).toHaveLength(4)
  })

  it('sets it on the installed disclosures the Disclosure overview reads', () => {
    const start = ipc.indexOf("ipcMain.handle('plugins:installedDisclosures'")
    const handler = ipc.slice(start, ipc.indexOf('ipcMain.handle(', start + 1))
    expect(handler).toContain('...activeHasViews(pkg.id)')
  })

  it('passes it from the trust dialog and the Disclosure overview to the card', () => {
    const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')
    expect(read('src/renderer/src/components/PluginTrustDialog.vue').match(/:has-views="pending\.prepared\.hasViews"/g)).toHaveLength(2)
    expect(read('src/renderer/src/components/PluginDisclosureOverview.vue')).toContain(':has-views="entry.hasViews"')
  })
})
