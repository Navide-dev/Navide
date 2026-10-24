import { describe, it, expect } from 'vitest'
import {
  WHATS_NEW,
  pickWhatsNew,
  pickWhatsNewOnDemand,
  pickText,
  whatsNewFor,
  cmpSemver,
  type WhatsNewText,
} from '../whatsNew'

describe('cmpSemver', () => {
  it('orders X.Y.Z versions', () => {
    expect(cmpSemver('0.1.65', '0.1.64')).toBe(1)
    expect(cmpSemver('0.1.64', '0.1.65')).toBe(-1)
    expect(cmpSemver('0.2.0', '0.1.99')).toBe(1)
    expect(cmpSemver('1.0.0', '1.0.0')).toBe(0)
  })

  it('treats a blank string as the oldest version', () => {
    expect(cmpSemver('0.1.65', '')).toBe(1)
    expect(cmpSemver('', '0.0.1')).toBe(-1)
  })
})

describe('WHATS_NEW', () => {
  // v0.1.78's announcement was once lost by writing the next release's notes
  // over the existing entry instead of prepending a new one. Ordering and
  // uniqueness both survive that mistake — only a gap check catches it.
  it('announces every version with no gaps', () => {
    const versions = WHATS_NEW.map((entry) => entry.version).sort(cmpSemver)
    const missing: string[] = []
    for (let i = 1; i < versions.length; i++) {
      const [prevMajor, prevMinor, prevPatch] = versions[i - 1].split('.').map(Number)
      const [major, minor, patch] = versions[i].split('.').map(Number)
      // A minor or major bump restarts patch numbering, so the last patch of
      // the previous line is unknowable here — only same-line pairs can gap.
      if (major !== prevMajor || minor !== prevMinor) continue
      for (let p = prevPatch + 1; p < patch; p++) missing.push(`${major}.${minor}.${p}`)
    }
    expect(missing).toEqual([])
  })

  it('has no duplicate versions', () => {
    // The sibling of the gap above: an in-place edit can also leave two entries
    // claiming the same version, which the gap check cannot see.
    const versions = WHATS_NEW.map((entry) => entry.version)
    expect(versions).toHaveLength(new Set(versions).size)
  })
})

describe('pickWhatsNew', () => {
  it('returns the entry when the current version has one and it is unseen', () => {
    expect(pickWhatsNew('0.1.65', '')?.version).toBe('0.1.65')
  })

  it('returns null when everything up to the current version was seen', () => {
    expect(pickWhatsNew('0.1.65', '0.1.65')).toBeNull()
  })

  it('still fires for a later version whose update jumped past the entry', () => {
    // The module ships from a later release, so an entry authored under an
    // already-shipped version must still show to anyone updating past it.
    // Read the newest entry rather than naming a version: the list is now
    // contiguous, so any hard-coded gap would close on the next release.
    const newest = WHATS_NEW.reduce((a, b) => (cmpSemver(b.version, a.version) > 0 ? b : a))
    expect(pickWhatsNew('9.9.9', '')?.version).toBe(newest.version)
  })

  it('does not show an announcement for a version not yet running', () => {
    expect(pickWhatsNew('0.1.64', '')).toBeNull()
  })

  it('returns null when the current version is empty', () => {
    expect(pickWhatsNew('', '0.1.60')).toBeNull()
  })

  it('agrees with whatsNewFor for a known version', () => {
    expect(pickWhatsNew('0.1.65', '0.1.64')).toEqual(whatsNewFor('0.1.65'))
  })
})

describe('pickText', () => {
  const text: WhatsNewText = { 'zh-TW': '你好', 'en-US': 'hi' }

  it('selects the requested locale', () => {
    expect(pickText(text, 'en-US')).toBe('hi')
    expect(pickText(text, 'zh-TW')).toBe('你好')
  })

  it('falls back to zh-TW for an unknown locale', () => {
    expect(pickText(text, 'ja-JP')).toBe('你好')
    expect(pickText(text, 'it-IT')).toBe('你好')
  })

  it('falls back to en-US for a later UI language', () => {
    expect(pickText(text, 'ko-KR')).toBe('hi')
    expect(pickText(text, 'zh-CN')).toBe('hi')
    expect(pickText({ ...text, 'ko-KR': '안녕' }, 'ko-KR')).toBe('안녕')
  })
})

describe('0.2.10 — Channels and Voice Input', () => {
  const entry = whatsNewFor('0.2.10')

  it('is authored, major, with a card for each headline feature and a tour', () => {
    expect(entry).toBeDefined()
    expect(entry?.major).toBe(true)
    expect(entry?.features?.map((f) => f.name['en-US'])).toEqual(['Channels', 'Voice Input'])
    expect(entry?.tour?.map((s) => s.id)).toEqual([
      'welcome',
      'channels-settings',
      'channels-pane',
      'voice-settings',
      'voice-dictate',
      'done',
    ])
  })

  it('carries ja-JP for every line, so a Japanese UI is not shown Chinese', () => {
    const texts: WhatsNewText[] = [
      entry!.title,
      ...entry!.highlights,
      ...entry!.features!.flatMap((f) => [f.name, f.tagline, f.where]),
    ]
    for (const text of texts) expect(text['ja-JP'], text['en-US']).toBeTruthy()
    expect(pickText(entry!.title, 'ja-JP')).toBe(entry!.title['ja-JP'])
  })

  it('shows once to someone updating from 0.2.9, and not again after dismissal', () => {
    // App.vue's evaluateWhatsNew: show pickWhatsNew(current, seen); dismissing
    // writes seen = current.
    expect(pickWhatsNew('0.2.10', '0.2.9')?.version).toBe('0.2.10')
    expect(pickWhatsNew('0.2.10', '0.2.10')).toBeNull()
  })

  it('shows 0.2.10, not 0.2.9, to someone jumping from 0.2.8', () => {
    expect(pickWhatsNew('0.2.10', '0.2.8')?.version).toBe('0.2.10')
  })

  it('is not shown to a build still running 0.2.9', () => {
    expect(pickWhatsNew('0.2.9', '0.2.8')?.version).toBe('0.2.9')
    expect(pickWhatsNew('0.2.9', '0.2.9')).toBeNull()
  })
})

// R3 MED-2 on 0.2.26: release.sh bumps package.json to 0.2.26 at release time,
// so the entry must exist before that bump. These pin it without touching
// package.json: the bump is simulated by passing 0.2.26 as the running version.
describe('0.2.26 — wake, Auto resume, file and folder installs', () => {
  const entry = whatsNewFor('0.2.26')

  it('is authored and carries ja-JP for every line', () => {
    expect(entry).toBeDefined()
    expect(entry?.features?.map((f) => f.name['en-US'])).toEqual(['Wake from chat', 'Resume scope Auto', 'Install from a file or folder'])
    const texts: WhatsNewText[] = [
      entry!.title,
      ...entry!.highlights,
      ...entry!.features!.flatMap((f) => [f.name, f.tagline, f.where]),
    ]
    for (const text of texts) expect(text['ja-JP'], text['en-US']).toBeTruthy()
  })

  it('shows once to someone updating from 0.2.25', () => {
    expect(pickWhatsNew('0.2.26', '0.2.25')?.version).toBe('0.2.26')
    expect(pickWhatsNew('0.2.26', '0.2.26')).toBeNull()
    expect(pickWhatsNewOnDemand('0.2.26', false)?.version).toBe('0.2.26')
    expect(WHATS_NEW[3].version).toBe('0.2.26')
    expect(WHATS_NEW[4].version).toBe('0.2.25')
  })
})

// Authored ahead of the 0.2.27 bump, like 0.2.26 above. One entry for the
// release: Navide Browser (#459) and blocked local installs, with the
// downgrade to 0.2.26 (decision d6 (a)); docs wrap-up adjusts the wording.
describe('0.2.27 — Navide Browser and blocked local installs', () => {
  const entry = whatsNewFor('0.2.27')

  it('is authored and carries ja-JP for every line', () => {
    expect(entry).toBeDefined()
    for (const text of [entry!.title, ...entry!.highlights]) expect(text['ja-JP'], text['en-US']).toBeTruthy()
  })

  it('names Navide Browser and the downgrade to 0.2.26', () => {
    expect(entry!.title['en-US']).toContain('Navide Browser')
    expect(entry!.highlights.some((text) => text['en-US'].startsWith('Navide Browser'))).toBe(true)
    expect(entry!.highlights.some((text) =>
      text['en-US'].startsWith('Behaviour change:') && text['en-US'].includes('0.2.26') && text['en-US'].includes('quarantined'),
    )).toBe(true)
  })

  it('shows once to someone updating from 0.2.26, and not to a build still running 0.2.26', () => {
    expect(pickWhatsNew('0.2.27', '0.2.26')?.version).toBe('0.2.27')
    expect(pickWhatsNew('0.2.27', '0.2.27')).toBeNull()
    expect(WHATS_NEW[2].version).toBe('0.2.27')
    expect(pickWhatsNew('0.2.26', '0.2.25')?.version).toBe('0.2.26')
  })
})

// Authored ahead of the 0.2.28 bump, like 0.2.27 above. The default UI
// language line is the wording #519 settled; Korean (Beta) is added by its own PR.
describe('0.2.28 — take effect at once, window tools and the English fallback', () => {
  const entry = whatsNewFor('0.2.28')

  it('is authored and carries ja-JP for every line', () => {
    expect(entry).toBeDefined()
    for (const text of [entry!.title, ...entry!.highlights]) expect(text['ja-JP'], text['en-US']).toBeTruthy()
  })

  it('says the default UI language is now English and the Developer Mode re-consent', () => {
    expect(entry!.highlights.some((text) => text['en-US'].startsWith('The default UI language has changed:'))).toBe(true)
    expect(entry!.highlights.some((text) =>
      text['en-US'].startsWith('Behaviour change:') && text['en-US'].includes('Developer Mode') && text['en-US'].includes('0.2.27'),
    )).toBe(true)
  })

  it('shows once to someone updating from 0.2.27, and not to a build still running 0.2.27', () => {
    expect(pickWhatsNew('0.2.28', '0.2.27')?.version).toBe('0.2.28')
    expect(pickWhatsNew('0.2.28', '0.2.28')).toBeNull()
    expect(pickWhatsNew('0.2.27', '0.2.26')?.version).toBe('0.2.27')
  })
})

// The 0.2.29 entry: six more interface languages, with the server's Node.js
// security update leading the highlights.
describe('0.2.29 — six more languages', () => {
  const entry = whatsNewFor('0.2.29')

  it('is authored and carries ja-JP for every line', () => {
    expect(entry).toBeDefined()
    for (const text of [entry!.title, ...entry!.highlights, entry!.note!]) expect(text['ja-JP'], text['en-US']).toBeTruthy()
  })

  it('leads with the server Node.js upgrade and its three high-severity CVEs', () => {
    const first = entry!.highlights[0]['en-US']
    expect(first).toContain('22.23.4')
    for (const cve of ['CVE-2026-106069', 'CVE-2026-111497', 'CVE-2026-105482']) expect(first).toContain(cve)
    expect(entry!.note!['en-US']).toContain('https://nodejs.org/en/blog/vulnerability/october-2026-security-releases')
  })

  it('shows once to someone updating from 0.2.28, as the newest entry, and not to a build still running 0.2.28', () => {
    expect(pickWhatsNew('0.2.29', '0.2.28')?.version).toBe('0.2.29')
    expect(pickWhatsNew('0.2.29', '0.2.29')).toBeNull()
    expect(WHATS_NEW[0].version).toBe('0.2.29')
    expect(pickWhatsNew('0.2.28', '0.2.27')?.version).toBe('0.2.28')
  })
})

describe('pickWhatsNewOnDemand (Help → What’s New…)', () => {
  it('reopens the running version’s entry even after it was seen', () => {
    expect(pickWhatsNewOnDemand('0.2.10', false)?.version).toBe('0.2.10')
  })

  it('never shows a shipped build notes for a version it is not running', () => {
    expect(pickWhatsNewOnDemand('0.2.9', false)?.version).toBe('0.2.9')
  })

  it('shows a dev build the newest authored entry, whatever package.json says', () => {
    const newest = WHATS_NEW.reduce((a, b) => (cmpSemver(b.version, a.version) > 0 ? b : a))
    expect(pickWhatsNewOnDemand('0.2.9', true)?.version).toBe(newest.version)
    expect(pickWhatsNewOnDemand('', true)?.version).toBe(newest.version)
  })

  it('has nothing to show a shipped build with no version', () => {
    expect(pickWhatsNewOnDemand('', false)).toBeNull()
  })
})
