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
  return mount(PluginDisclosureCard, { props, global: { plugins: [i18n] } })
}

let saved: string
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
    expect(text).toContain('says this version is signed (key registry-2026); not yet verified')
  })

  it('marks the verified parts only for an install-time (prepareInstall) result', () => {
    const text = render({ disclosure: disclosureOf('ui-only'), scan: scanOf('nothing-found'), registry: REGISTRY, verified: true }).text()
    expect(text).toContain('Verified: the disclosure matches the downloaded package')
    expect(text).toContain('The scan was run and signed by the Navide Registry.')
    expect(text).toContain('Navide Registry signature verified (key registry-2026)')
    expect(text).not.toContain('not yet verified')
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

  it.each(['en-US', 'zh-TW', 'ja-JP'])('renders every fixture case without a missing string (%s)', (locale) => {
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
