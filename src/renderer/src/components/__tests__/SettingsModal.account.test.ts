// @vitest-environment happy-dom
// Account sign-in, across the two places it now lives.
//
// The form lives in AccountModal.vue, opened from the titlebar "Sign In"
// button: signing in is the *first* thing a new user does, and burying it in
// Settings meant it could only be found by someone who already knew it was
// there. It is an in-app modal (like Settings), not a separate OS window.
//
// So the split this file pins down is:
//   - AccountModal.vue owns the form — sign in, create account, paste a token
//     (and must not leak the password)
//   - SettingsModal.vue shows read-only link status plus a hint pointing at
//     the titlebar — not a door, not a token form, not a second copy
//   - neither offers a server address: it is built into the app
//
// Neither component is mounted: SettingsModal takes six composable APIs as
// props and pulls in the analyzer, updater and MCP catalog. Same source-scan
// approach as SettingsModal.teamMembers.test.ts.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

const LOCALES = ['en-US', 'zh-TW'] as const
const here = dirname(fileURLToPath(import.meta.url))
const SETTINGS = readFileSync(resolve(here, '../SettingsModal.vue'), 'utf8')
const MODAL = readFileSync(resolve(here, '../AccountModal.vue'), 'utf8')
const APP = readFileSync(resolve(here, '../../App.vue'), 'utf8')
const MAIN = readFileSync(resolve(here, '../../main.ts'), 'utf8')

function block(locale: (typeof LOCALES)[number], path: string[]): Record<string, string> {
  let node = i18n.global.getLocaleMessage(locale) as Record<string, any>
  for (const key of path) node = node?.[key]
  return node as Record<string, string>
}

/** Literal i18n keys a source file asks for under one prefix.
 *  Anchored on the translate call so a WS command name that happens to contain
 *  the same word (`p2p.account.logout`) is not mistaken for a translation key. */
function keysUnder(source: string, prefix: string): string[] {
  const found = new Set<string>()
  const esc = prefix.replace(/\./g, '\\.')
  const re = new RegExp(`[$]?t\\(\\s*'${esc}\\.([a-z0-9]+(?:-[a-z0-9]+)*)'`, 'g')
  for (const m of source.matchAll(re)) found.add(m[1])
  return [...found]
}

describe('account modal', () => {
  it('is a modal, not a window type', () => {
    expect(MAIN).not.toContain("case 'account'")
    expect(MAIN).not.toContain('AccountWindow' + 'App')
    expect(MODAL).toMatch(/class="s-overlay[^"]*"[^>]*@click\.self="emit\('close'\)"/)
    expect(MODAL).toContain("e.key === 'Escape'")
  })

  it('offers the three modes', () => {
    expect(MODAL).toContain("'login', 'register', 'token'")
    expect(MODAL).toMatch(/id="acct-password"[\s\S]{0,240}type="password"/)
    expect(MODAL).toMatch(/id="acct-token"[\s\S]{0,240}type="password"/)
  })

  it('talks to the existing backend calls', () => {
    expect(MODAL).toContain('p2p.account.${mode.value}')
    expect(MODAL).toContain("'p2p.link.configure', { token: token.value }")
    expect(MODAL).toContain("'p2p.account.logout'")
    expect(MODAL).toContain("'p2p.link.status'")
  })

  it('never keeps the password around', () => {
    // Sent once and exchanged for a token; anything that outlives the request
    // is a credential sitting in a renderer process.
    expect(MODAL).toMatch(/password\.value = ''/)
    expect(MODAL).toMatch(/password\.value = ''[\s\S]{0,300}status\.value = resp\.payload\.status/)
  })

  // Registering asks for email and password only. The server derives the
  // display name and the network name from the email, and neither can be
  // changed afterwards, so offering fields here would be a one-way decision
  // taken by someone who has no way to judge it yet.
  it('does not ask for a display name or a network name', () => {
    expect(MODAL).not.toContain('acct-display')
    expect(MODAL).not.toMatch(/payload\.displayName\s*=/)
  })

  it('submits on Enter from the password and token fields', () => {
    expect(MODAL.match(/@keyup\.enter="submit"/g)?.length).toBe(2)
  })

  it('shows the account and offers sign-out once signed in', () => {
    // Anchored on the display name rather than the role: role went with the
    // identity convergence (the server stopped returning it), so an assertion
    // that kept naming it would be pinning down a row that cannot render.
    // The window grew a connection row above these; what this pins is that the
    // account details are inside the signed-in branch, not how far down.
    expect(MODAL).toMatch(/v-if="signedIn"[\s\S]{0,2000}status\.displayName/)
    expect(MODAL).toMatch(/@click="signOut"/)
    expect(MODAL).toContain("emit('changed')")
  })

  it('translates a server that predates accounts instead of showing its code', () => {
    expect(MODAL).toContain("'UNKNOWN_TYPE'")
    expect(MODAL).toContain('account.err-unsupported')
  })

  it('has every string it shows, in both locales', () => {
    const keys = keysUnder(MODAL, 'account')
    expect(keys.length).toBeGreaterThan(4)
    const nested = keysUnder(MODAL, 'settings.p2p.account')
    expect(nested.length).toBeGreaterThan(3)
    for (const locale of LOCALES) {
      const strings = block(locale, ['account'])
      expect(strings, locale).toBeTruthy()
      for (const key of keys) expect(strings[key], `${locale}/${key}`).toBeTruthy()
      const acct = block(locale, ['settings', 'p2p', 'account'])
      for (const key of nested) expect(acct[key], `${locale}/${key}`).toBeTruthy()
      for (const mode of ['login', 'register', 'token']) {
        expect(acct[`tab-${mode}`], `${locale}/tab-${mode}`).toBeTruthy()
        expect(acct[`submit-${mode}`], `${locale}/submit-${mode}`).toBeTruthy()
      }
    }
  })

  // Soft gate: an unverified account signs in and works. What the modal owes
  // the user is a way to notice and a way to act, not a wall.
  it('shows the verification notice with a resend button while unverified', () => {
    expect(MODAL).toContain("'p2p.account.resend_verification'")
    expect(MODAL).toMatch(/v-if="signedIn && verifyPending"[\s\S]{0,400}account\.verify-sent/)
    expect(MODAL).toMatch(/account\.verify-resend[\s\S]{0,120}<\/button>/)
    // The link-readiness gate rides on the same attribute now: a resend that
    // cannot leave the machine is a button that answers after the click.
    expect(MODAL).toMatch(/:disabled="resending \|\| !linkReady"[\s\S]{0,200}resendVerification/)
  })

  it('only ticks an email the server actually confirmed', () => {
    // "Unknown" is not "confirmed": a reconnecting link reports no flag, and a
    // tick shown then would tell an unverified user they are done.
    expect(MODAL).toContain("status.value?.emailVerified === true")
    expect(MODAL).toMatch(/v-if="verified"[\s\S]{0,120}account\.verified/)
  })

  it('seeds the notice from the registration reply, not from the next poll', () => {
    // The link has only just been told to reconnect; waiting for its auth.hello
    // would leave a new account with no sign that a mail was sent at all.
    expect(MODAL).toMatch(/account\.emailVerified !== true/)
    // And the poll only trusts a connected link.
    expect(MODAL).toMatch(/state === 'connected'[\s\S]{0,160}emailVerified === false/)
  })

  it('translates the verification codes instead of showing them raw', () => {
    expect(MODAL).toMatch(/'RATE_LIMITED'[\s\S]{0,120}verify-rate-limited/)
    expect(MODAL).toMatch(/'EMAIL_UNVERIFIED'[\s\S]{0,120}verify-required/)
  })

  it('shows no server address field', () => {
    // The address is built into the app; a typo'd one produced a link that
    // silently never dialled, with no correct value a user could discover.
    // (`serverUrl` still appears once, as a field of the status payload type.)
    expect(MODAL).not.toMatch(/<input[^>]*server/i)
    expect(MODAL).not.toMatch(/v-model="[^"]*[sS]erverUrl"/)
    expect(MODAL).not.toContain('serverUrl:'.concat(' ref'))
  })
})

describe('settings — read-only link status', () => {
  it('neither opens a window nor duplicates the form', () => {
    expect(SETTINGS).not.toContain('openAccount' + 'Window')
    expect(SETTINGS).not.toContain('submitP2pAccount')
    expect(SETTINGS).not.toMatch(/id="p2p-password"/)
    expect(SETTINGS).not.toMatch(/id="p2p-token"/)
    expect(SETTINGS).not.toContain('p2p-advanced')
    expect(SETTINGS).not.toContain('p2p.link.configure')
    expect(SETTINGS).not.toContain('p2p.account.logout')
  })

  it('no longer offers a server address', () => {
    expect(SETTINGS).not.toContain('p2pServerUrl')
    expect(SETTINGS).not.toMatch(/id="p2p-server-url"/)
  })

  it('keeps the status block and points at the titlebar', () => {
    expect(SETTINGS).toContain("'p2p.link.status'")
    expect(SETTINGS).toMatch(/data-settings-section="general-p2p"[\s\S]{0,1600}settings\.p2p\.account\.hint-titlebar/)
    expect(SETTINGS).toContain('data-settings-section="general-p2p-policy"')
  })

  it('has every string it shows, in both locales', () => {
    const keys = keysUnder(SETTINGS, 'settings.p2p.account')
    expect(keys.length).toBeGreaterThan(0)
    for (const locale of LOCALES) {
      const strings = block(locale, ['settings', 'p2p', 'account'])
      for (const key of keys) expect(strings[key], `${locale}/${key}`).toBeTruthy()
      // Orphans of the removed form must not linger.
      const p2p = block(locale, ['settings', 'p2p'])
      for (const gone of ['server-url', 'server-url-placeholder']) expect(p2p[gone], `${locale}/${gone}`).toBeUndefined()
    }
  })
})

describe('re-signing the pane-authorization rules', () => {
  it('has an action for it, because this section has no save button', () => {
    // Every change here writes as it is made — there is no save. So the
    // account window's "open the rules and save them once" described an act
    // that did not exist anywhere in the app, and the only way to perform it
    // was to add a rule and remove it again.
    expect(SETTINGS).toContain('resignP2pPolicy')
    expect(SETTINGS).toContain('settings.p2p.policy.resign')
    // Unchanged rules, new signature: that is the whole repair.
    expect(SETTINGS).toMatch(
      /async function resignP2pPolicy\(\)[\s\S]{0,200}saveP2pPolicy\(policyDoc\.value\)/,
    )
  })

  it('explains what saving does, next to the button', () => {
    expect(SETTINGS).toContain('settings.p2p.policy.resign-hint')
    expect(SETTINGS).toContain('p2pPolicyResigned')
  })

  it('can be scrolled to from outside this window', () => {
    // The account view points here now, so "which tab" is not enough — the
    // rules are one section of a page.
    expect(SETTINGS).toMatch(/setSection: async \(tab: Tab, section: string\)/)
    expect(SETTINGS).toContain('data-settings-section="general-p2p-policy"')
  })

  it('lives on its own page, not at the bottom of General', () => {
    // Two cards at the end of the longest page in this window is where somebody
    // told "open the rules" went looking and did not find them.
    expect(SETTINGS).toContain("activeTab === 'cross-device'")
    expect(SETTINGS).toContain("settings.nav.crossDevice")
    const general = SETTINGS.slice(
      SETTINGS.indexOf(`v-show="activeTab === 'general'"`),
      SETTINGS.indexOf(`v-show="activeTab === 'cross-device'"`),
    )
    expect(general).not.toContain('data-settings-section="general-p2p"')
    expect(general).not.toContain('data-settings-section="general-p2p-policy"')
  })

  it('sends every entry point to the new page', () => {
    // A search result or an "open rules" click that still named General would
    // land on a page these cards are no longer on.
    expect(SETTINGS).toMatch(/id: 'general-p2p',\n\s*tab: 'cross-device',/)
    expect(SETTINGS).toMatch(/id: 'general-p2p-policy',\n\s*tab: 'cross-device',/)
    expect(APP).toContain("setSection('cross-device', 'general-p2p-policy')")
  })

  it('polls the link while the page showing it is open', () => {
    // The poll followed the cards, not the page they used to be on: left on
    // General it would keep asking for something nobody is looking at, and stop
    // the moment somebody actually opened it.
    expect(SETTINGS).toMatch(/if \(p2pTimer\)[\s\S]{0,400}if \(tab !== 'cross-device'\) return/)
  })

  for (const locale of LOCALES) {
    it(`names the page in ${locale}`, () => {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, unknown>
      const nav = (messages.settings as Record<string, unknown>).nav as Record<string, string>
      expect(nav.crossDevice).toBeTruthy()
    })
  }

  for (const locale of LOCALES) {
    it(`names the re-sign action in ${locale}`, () => {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, unknown>
      const policy = (
        ((messages.settings as Record<string, unknown>).p2p as Record<string, unknown>)
          .policy as Record<string, string>
      )
      expect(policy.resign).toBeTruthy()
      expect(policy['resign-hint']).toBeTruthy()
      expect(policy.resigned).toBeTruthy()
    })
  }
})

describe('the published legal pages', () => {
  it('links to them from the page that agrees to them', () => {
    // Both surfaces resolve the address through preload rather than writing
    // one: there is exactly one table of these, in src/shared/legalLinks.ts.
    expect(SETTINGS).toContain("openLegal('privacy')")
    expect(SETTINGS).toContain("openLegal('boundaries')")
    expect(MODAL).toContain("openLegal('privacy')")
    // No terms page: Navide is MIT-licensed software with a free account, so
    // there is no contract for a reader to agree to — and that page was the
    // only one that would have needed company details and a governing law.
    expect(SETTINGS).not.toContain("openLegal('terms')")
    expect(MODAL).not.toContain("openLegal('terms')")
  })

  it('never assembles a URL of its own', () => {
    // A hand-written address is one that goes stale silently, and this is the
    // one kind of link where a wrong page is a legal problem rather than a 404.
    expect(SETTINGS).not.toMatch(/https:\/\/navide\.dev\/(privacy|terms|boundaries)/)
    expect(MODAL).not.toMatch(/https:\/\/navide\.dev\/(privacy|terms|boundaries)/)
    expect(SETTINGS).toContain('window.agentTeam?.openLegal(route)')
    expect(MODAL).toContain('window.agentTeam?.openLegal(route)')
  })

  for (const locale of LOCALES) {
    it(`labels them in ${locale}`, () => {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, unknown>
      const p2p = (messages.settings as Record<string, unknown>).p2p as Record<string, string>
      expect(p2p['legal-privacy']).toBeTruthy()
      expect(p2p['legal-boundaries']).toBeTruthy()
    })
  }
})

describe('nobody writes the site address by hand', () => {
  // Claimed in an earlier round and not actually enforced — the audit was
  // right. These are the two surfaces that link to the published pages, and a
  // literal here is the failure mode that costs most: it goes stale silently,
  // and a wrong legal page is not a 404.
  const SITE = 'https://navide' + '.dev'

  it('never appears in the account window', () => {
    expect(MODAL).not.toContain(SITE)
  })

  it('never appears in the settings window', () => {
    expect(SETTINGS).not.toContain(SITE)
  })

  it('lives in exactly one module, which both of them ask', () => {
    const shared = readFileSync(resolve(here, '../../../../shared/legalLinks.ts'), 'utf8')
    expect(shared).toContain(`export const LEGAL_SITE = '${SITE}'`)
    expect(MODAL).toContain('openLegal(')
    expect(SETTINGS).toContain('openLegal(')
  })
})

describe('the cross-device page after the UX pass', () => {
  it('says why each control is disabled', () => {
    // A greyed control with no reason is the same puzzle one level down. Which
    // reason it is, is asserted by the re-audit block below.
    expect(SETTINGS.match(/:title="p2pDisabledReason \|\| undefined"/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('reads the same state vocabulary as the account window', () => {
    // Two sets of words for one fact, on two screens, is how "unauthorized"
    // came to read as one thing here and another there.
    expect(SETTINGS).toContain("settings.p2p.state-' + p2pState")
    expect(SETTINGS).not.toContain('settings.p2p.link.state-')
  })

  it('uses only tokens the design system defines', () => {
    for (const token of ['--warn-fg', '--ok-fg', '--bg-default', '--border)', '--accent)']) {
      expect(SETTINGS, token).not.toContain(`var(${token}`)
    }
  })
})

describe('the rules list after the UX pass', () => {
  it('has two columns with a header', () => {
    // As one run of text separated by a middle dot and an arrow, "who" and
    // "what they may reach" had to be parsed apart on every line.
    expect(SETTINGS).toContain('settings.p2p.policy.col-source')
    expect(SETTINGS).toContain('settings.p2p.policy.col-target')
    // The header row itself, not just the class name: renaming the class in
    // the template alone left this green.
    expect(SETTINGS).toMatch(
      /<li class="policy-rule policy-rule-head">[\s\S]{0,300}col-source[\s\S]{0,200}col-target/,
    )
    expect(SETTINGS).toContain('policy-rule-from')
    expect(SETTINGS).toContain('policy-rule-to')
    // The single-run version is gone rather than unused.
    expect(SETTINGS).not.toContain('policy-rule-text')
  })

  it('does not stack two sentences about the same fact', () => {
    // "These rules live on the server" and "the link is not connected" are one
    // fact from two sides; stacked they read as two separate problems.
    expect(SETTINGS).toContain('!p2pPolicy?.editable && !p2pWaitReason')
  })

  it('leaves the address to the window that can act on it', () => {
    // It was labelled here first; then C2 removed the whole duplicated block,
    // because a second read-only copy is a second place for the two to
    // disagree. The account window shows it, and can change it.
    expect(SETTINGS).not.toContain('p2pStatus.serverUrl')
    expect(SETTINGS).toContain('settings.p2p.account.hint-titlebar')
  })

  it('has a container class of its own', () => {
    expect(SETTINGS).toContain("class=\"s-body cross-device-body\"")
    expect(SETTINGS).toMatch(/\.cross-device-body \{/)
  })

  it('files the cross-device search entries under the page they are on', () => {
    // The group label is no longer a literal in the source — it reuses the
    // sidebar's own group key — so assert both halves: that the rows point at
    // that key, and that the key reads "Navide Services".
    const GROUP_KEY = /group: t\('settings\.nav\.group\.navidePlugins'\)/.source
    expect(SETTINGS).toMatch(new RegExp(`id: 'general-p2p',[\\s\\S]{0,200}${GROUP_KEY}`))
    expect(SETTINGS).toMatch(new RegExp(`id: 'general-p2p-policy',[\\s\\S]{0,260}${GROUP_KEY}`))
    expect(block('en-US', ['settings', 'nav', 'group']).navidePlugins).toBe('Navide Services')
  })
})

describe('the cross-device page after the re-audit', () => {
  it('gives each disabled reason its own sentence', () => {
    // *Which* state produces which sentence is asserted in
    // lib/__tests__/linkStatus.test.ts, by calling the function. This file can
    // only see strings, and a condition wired to `false` keeps every string it
    // had — which is exactly how the first version of this test passed.
    expect(SETTINGS).toContain("import { disabledReasonKey } from '../lib/linkStatus'")
    expect(SETTINGS).toMatch(/const reason = disabledReasonKey\(\{[\s\S]{0,200}busy: p2pPolicyBusy\.value/)
    expect(SETTINGS).toMatch(/editable: p2pPolicy\.value\?\.editable === true/)
    expect(SETTINGS.match(/:title="p2pDisabledReason \|\| undefined"/g)?.length).toBeGreaterThanOrEqual(4)
    expect(SETTINGS).not.toContain(':title="p2pWaitReason || undefined"')
  })

  it('demotes the re-sign action below editing the rules', () => {
    // It repairs a warning that appears rarely; at the same weight as "add
    // rule" it looked like part of editing.
    expect(SETTINGS).toMatch(/class="policy-secondary"[\s\S]{0,200}resignP2pPolicy/)
    expect(SETTINGS).toMatch(/\.policy-secondary \{/)
  })

  it('does not print the account facts the other window already owns', () => {
    // A second read-only copy is a second thing to keep in sync and a second
    // place for the two to disagree.
    expect(SETTINGS).not.toContain('p2pStatus.serverUrl')
    expect(SETTINGS).not.toContain('p2pStatus.deviceId')
    expect(SETTINGS).not.toContain('p2pStatus.detail')
  })

  it('says "nothing is allowed by default" only when there are rules', () => {
    // With none, this and the "no rules yet" line said the same thing twice.
    expect(SETTINGS).toMatch(/v-if="policyDoc\.rules\.length" class="policy-deny"/)
  })

  it('renders the wildcard more quietly than a real name', () => {
    expect(SETTINGS).toContain('function isAnyField(')
    expect(SETTINGS).toContain("'policy-any': isAnyField(rule.to.workspace)")
    expect(SETTINGS).toMatch(/\.policy-any \{ color: var\(--text-secondary\)/)
  })

  it('has no leftover styles for a class the template dropped', () => {
    expect(SETTINGS).not.toContain('p2p-tabs')
  })
})
