// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginDisclosureCard from '../PluginDisclosureCard.vue'
import { computeDisclosure, type RegistryDisclosureFacts } from '../../../../shared/pluginDisclosure'
import type { ScanReport } from '../../../../shared/pluginDisclosureScan'

const FIXTURES = join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures')
const load = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const manifests = new Map((load('disclosure-cases.json').cases as Array<{ name: string; manifest: unknown }>).map((c) => [c.name, c.manifest]))
const scanCases = load('scan-cases.json').cases as Array<{ name: string; disclosureCase: string; scan: ScanReport }>
const scanOf = (name: string): ScanReport => scanCases.find((c) => c.name === name)!.scan
const disclosureOf = (name: string) => computeDisclosure(manifests.get(name) as never)

const REGISTRY: RegistryDisclosureFacts = {
  publisher: { name: 'Acme', verifiedDomain: null, domainVerifiedAt: null },
  signature: { signed: true, keyId: 'registry-2026' },
  review: { status: 'not-required', reviewedAt: null, nativeCodeInspected: null },
  scan: { secretScan: 'not-run', secretFindings: 0, similarityWarning: false, similarTo: null, scannedAt: null },
}

function render(props: Record<string, unknown>) {
  return mount(PluginDisclosureCard, { props: props as never, global: { plugins: [i18n] } })
}

let saved: typeof i18n.global.locale.value
beforeEach(() => {
  saved = i18n.global.locale.value
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  i18n.global.locale.value = saved
})

describe('PluginDisclosureCard provenance (review I1 on #354)', () => {
  it('labels listing/detail data as unverified and never as signed', () => {
    const text = render({ disclosure: disclosureOf('ui-only'), scan: scanOf('nothing-found'), registry: REGISTRY, verified: false }).text()
    expect(text).toContain('not yet verified')
    expect(text).not.toContain('Verified:')
    expect(text).not.toContain('signed by the Navide Registry.')
    expect(text).toContain('The scan was run by the Navide Registry.')
    expect(text).toContain('The Navide Registry records that this version is signed (key registry-2026)')
  })

  it('states the publisher domain as the Registry\'s unsigned record, never as verified', () => {
    const registry = { ...REGISTRY, publisher: { name: 'Acme', verifiedDomain: 'acme.example', domainVerifiedAt: '2026-10-01T00:00:00Z' } }
    for (const verified of [false, true]) {
      const facts = render({ disclosure: disclosureOf('ui-only'), scan: null, registry, verified }).get('.nv-disclosure-facts').text()
      expect(facts).toContain('The Navide Registry records that the publisher controls acme.example')
      expect(facts).not.toMatch(/domain verified/i)
    }
  })

  it('marks the verified parts only for an install-time (prepareInstall) result', () => {
    const text = render({ disclosure: disclosureOf('ui-only'), scan: scanOf('nothing-found'), registry: REGISTRY, verified: true }).text()
    expect(text).toContain('Verified: the disclosure matches the downloaded package')
    expect(text).toContain('The scan was run and signed by the Navide Registry.')
    expect(text).not.toContain('not yet verified')
  })

  // Review of #360, F1: "verified" names only what prepareInstall checked.
  it('a verified card without a scan report never mentions a scan signature', () => {
    const text = render({ disclosure: disclosureOf('ui-only'), scan: null, registry: REGISTRY, verified: true }).text()
    expect(text).toContain('Verified: the disclosure matches the downloaded package. This version has no system scan.')
    expect(text).not.toMatch(/scan report's Navide Registry signature/)
  })

  // Review of #360, F2: the unsigned registry object never feeds a "verified"
  // sentence; its signature fields stay a record in the unsigned facts.
  it.each([false, true])('states the registry signature fields as a record only (verified=%s)', (verified) => {
    const forged = { ...REGISTRY, signature: { signed: true, keyId: 'attacker-key' } }
    const facts = render({ disclosure: disclosureOf('ui-only'), scan: null, registry: forged, verified }).get('.nv-disclosure-facts').text()
    expect(facts).toContain('The Navide Registry records that this version is signed (key attacker-key)')
    expect(facts).not.toMatch(/signature verified|verified \(key/i)
    const unsignedClaim = { ...REGISTRY, signature: { signed: false, keyId: null } }
    const text = render({ disclosure: disclosureOf('ui-only'), scan: null, registry: unsignedClaim, verified }).get('.nv-disclosure-facts').text()
    expect(text).toContain('The Navide Registry records no signature for this version')
  })

  it.each([false, true])('always shows the registry facts as unsigned (verified=%s)', (verified) => {
    const wrapper = render({ disclosure: disclosureOf('ui-only'), scan: null, registry: REGISTRY, verified })
    expect(wrapper.text()).toContain('Navide Registry records (unsigned)')
    expect(wrapper.text()).toContain('Published automatically, not reviewed by a person')
  })
})

describe('PluginDisclosureCard content', () => {
  it('puts what the scan found but the package does not declare first, in an alert', () => {
    const wrapper = render({ disclosure: disclosureOf('ui-only'), scan: scanOf('ui-only-runs-git-push-undeclared'), verified: false })
    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('Runs git push, but declares no shell permission')
    expect(wrapper.find('.nv-disclosure-level--highest').exists()).toBe(true)
    const html = wrapper.html()
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf('nv-disclosure-sentences'))
  })

  it('says "not found" as a fact of the static scan, never "none"', () => {
    const text = render({ disclosure: disclosureOf('ui-only'), scan: scanOf('nothing-found') }).text()
    expect(text).toContain('The static scan found no commands.')
    expect(text).toContain('this is not a complete list')
    expect(text).not.toMatch(/\bNone\b/)
  })

  it('shows an incomplete scan prominently and at least high', () => {
    const wrapper = render({ disclosure: disclosureOf('ui-only'), scan: scanOf('scanner-error-and-too-complex') })
    expect(wrapper.find('.nv-disclosure-incomplete').text()).toContain('Scan incomplete')
    expect(wrapper.find('.nv-disclosure-level--high').exists()).toBe(true)
  })

  it('without a scan says so and shows only the declaration', () => {
    const text = render({ disclosure: disclosureOf('shell-allowlist-no-backend'), scan: null }).text()
    expect(text).toContain('published before system scans')
    expect(text).toContain('Can reach remote hosts through those commands')
  })

  it('without disclosure data says so instead of computing a card', () => {
    const wrapper = render({ disclosure: null })
    expect(wrapper.text()).toContain('published without disclosure data')
    expect(wrapper.find('.nv-disclosure-level').exists()).toBe(false)
  })

  it.each(['en-US', 'zh-TW', 'ja-JP'] as const)('renders every fixture case without a missing string (%s)', (locale) => {
    i18n.global.locale.value = locale
    for (const scanCase of scanCases) {
      const text = render({
        disclosure: disclosureOf(scanCase.disclosureCase),
        scan: scanCase.scan,
        registry: REGISTRY,
      }).text()
      // A missing string falls back to its key (`shell.remoteWrite`, ...);
      // capability addresses such as shell.run are legitimate text.
      expect(text, scanCase.name).not.toMatch(
        /pluginDisclosure\.|\b(?:shell\.(?:remoteWrite|remoteRead|localWrite|local|other|unknownSubcommand|dynamic)|files\.(?:write|read)|network\.hosts|code\.(?:eval|obfuscated)|native\.(?:summary|unscannable)|coverage\.incomplete|notFound\.[a-zA-Z]+)\b/
      )
    }
  })
})

// Review of #360, L1 and L2: the card follows the D6 order under a one-line
// summary, and each of the four levels has its own icon.
describe('PluginDisclosureCard layout', () => {
  it('opens with the template summary and keeps the D6 order', () => {
    const wrapper = render({ disclosure: disclosureOf('ui-only'), scan: scanOf('ui-only-runs-git-push-undeclared'), registry: REGISTRY, verified: false })
    expect(wrapper.get('.nv-disclosure-summary').text()).toBe('Shows its own views')
    const html = wrapper.html()
    const order = ['nv-disclosure-summary', 'nv-disclosure-level', 'nv-disclosure-undeclared', 'nv-disclosure-sentences',
      'nv-disclosure-declared', 'nv-disclosure-limits', 'nv-disclosure-facts']
    const positions = order.map((name) => html.indexOf(`class="${name}`))
    expect(positions.every((at) => at >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('draws a different icon for each of the four levels', () => {
    const shown = ['ui-only', 'fs-read-only-scopes', 'shell-allowlist-no-backend', 'shell-full-ai-cli'].map((name) => {
      const wrapper = render({ disclosure: disclosureOf(name), scan: null })
      return { level: wrapper.get('.nv-disclosure-level').classes().join(' '), icon: wrapper.get('.nv-disclosure-level-icon').html() }
    })
    expect(new Set(shown.map((entry) => entry.level)).size).toBe(4)
    expect(new Set(shown.map((entry) => entry.icon)).size).toBe(4)
  })
})

// Review of #360, L3: third-party strings cannot reorder or hide card text.
describe('PluginDisclosureCard invisible characters', () => {
  it('spells out bidi and zero-width characters in scan strings and Registry facts', () => {
    const base = scanOf('devmap-push-and-reads')
    const scan = { ...base, network: { hosts: [{ ...base.network.hosts[0], host: 'evil‮moc.example' }] } }
    const registry = {
      ...REGISTRY,
      publisher: { name: 'Acme', verifiedDomain: 'acme​.example', domainVerifiedAt: '2026-10-01T00:00:00Z' },
      signature: { signed: true, keyId: 'key⁦x' },
    }
    const text = render({ disclosure: disclosureOf('devmap-0.2.0'), scan, registry, verified: false }).text()
    expect(text).not.toMatch(/[​‮⁦]/)
    expect(text).toContain('evil\\u{202e}moc.example')
    expect(text).toContain('acme\\u{200b}.example')
    expect(text).toContain('key\\u{2066}x')
  })
})

// Card K2 (DX report §10.4), RULE ZERO: the "Source and review" row is the only
// thing a marketplace source adds. The baseline file was written by main's card
// before the row existed; `<!--v-if-->` placeholders are not rendered and are
// left out of the comparison.
describe('PluginDisclosureCard source row (K2)', () => {
  const MAIN_BASELINE = './__snapshots__/PluginDisclosureCard.main-baseline.html'
  const strip = (html: string): string => html.replace(/<!--v-if-->/g, '').replace(/^[ \t]*\n/gm, '')
  const cases = (): Array<[string, Record<string, unknown>]> => [
    ['verified card', { disclosure: disclosureOf('ui-only'), scan: scanOf('nothing-found'), registry: REGISTRY, verified: true }],
    ['listing card', { disclosure: disclosureOf('ui-only'), scan: scanOf('nothing-found'), registry: REGISTRY, verified: false }],
    ['no disclosure', { disclosure: null, scan: null, registry: null, verified: true }],
  ]
  const baseline = (): string => cases().map(([name, props]) => `<!-- ${name} -->\n${strip(render(props).html())}`).join('\n')

  it('renders exactly what main rendered when no source is given', async () => {
    await expect(baseline()).toMatchFileSnapshot(MAIN_BASELINE)
  })

  it('adds only one "Reviewed" row for a marketplace source; the rest of the DOM is main\'s', async () => {
    const html = cases().map(([name, props]) => {
      const wrapper = render({ ...props, source: 'marketplace' })
      const rows = wrapper.findAll('.nv-source-row')
      expect(rows).toHaveLength(1)
      expect(rows[0].text()).toBe('Source and review Reviewed')
      rows[0].element.remove()
      return `<!-- ${name} -->\n${strip(wrapper.html())}`
    }).join('\n')
    await expect(html).toMatchFileSnapshot(MAIN_BASELINE)
  })
})
