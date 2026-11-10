// @vitest-environment happy-dom
// Scanner 1.2.0 sites on the disclosure card: shown only when the report has
// them, every invisible character spelled out, a hidden excerpt named as such.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginDisclosureCard from '../PluginDisclosureCard.vue'
import { computeDisclosure } from '../../../../shared/pluginDisclosure'
import type { ScanReport } from '../../../../shared/pluginDisclosureScan'

const FIXTURES = join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures')
const load = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const manifest = (load('disclosure-cases.json').cases as Array<{ name: string; manifest: unknown }>).find((c) => c.name === 'devmap-0.2.0')!.manifest
const base = (load('scan-cases.json').cases as Array<{ name: string; scan: ScanReport }>).find((c) => c.name === 'devmap-push-and-reads')!.scan

function render(scan: ScanReport) {
  return mount(PluginDisclosureCard, { props: { disclosure: computeDisclosure(manifest as never), scan } as never, global: { plugins: [i18n] } })
}

let saved: typeof i18n.global.locale.value
beforeEach(() => {
  saved = i18n.global.locale.value
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  i18n.global.locale.value = saved
})

describe('PluginDisclosureCard scan sites', () => {
  it('shows no site list for a report without sites (scanner 1.1.0 and older)', () => {
    expect(render(base).find('.nv-disclosure-sites').exists()).toBe(false)
  })

  it('lists each site with file:line:col and its excerpt', () => {
    const scan: ScanReport = {
      ...base,
      network: { hosts: [{ host: 'api.example.com', source: 'frontend', count: 2, sites: [
        { file: 'frontend/a.js', line: 3, col: 7, excerpt: "fetch('https://api.example.com/v1')" },
        { file: 'frontend/b.js', line: 1, col: 1, excerpt: null },
      ] }] },
    }
    const sites = render(scan).find('.nv-disclosure-sites')
    expect(sites.text()).toContain('Where the static scan saw these (2)')
    expect(sites.text()).toContain('Host api.example.com')
    expect(sites.findAll('.nv-disclosure-site-where').map((w) => w.text())).toEqual(['frontend/a.js:3:7', 'frontend/b.js:1:1'])
    expect(sites.find('.nv-disclosure-site-excerpt').text()).toBe("fetch('https://api.example.com/v1')")
    expect(sites.find('.nv-disclosure-site-hidden').text()).toContain('looks like a secret')
  })

  it('spells out invisible characters in excerpts and file names', () => {
    const scan: ScanReport = {
      ...base,
      capabilities: [{ address: 'shell.run', source: 'frontend', sites: [{ file: 'a‮.js', line: 1, col: 1, excerpt: 'x​y' }] }],
    }
    const text = render(scan).find('.nv-disclosure-sites').text()
    expect(text).not.toMatch(/[​‮]/)
    expect(text).toContain('x\\u{200b}y')
    expect(text).toContain('a\\u{202e}.js:1:1')
  })
})
