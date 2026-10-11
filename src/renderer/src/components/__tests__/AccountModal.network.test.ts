// @vitest-environment happy-dom
// "Your network": the devices signed in to this team space and the CLI panes
// running on each, shown inside the account modal.
//
// Source-scan, like SettingsModal.account.test.ts beside it: AccountModal takes
// the whole backend composable as a prop, so mounting it would mean faking a
// WebSocket to assert on markup that is already right there in the file.
//
// What these pin down is the part that is easy to get subtly wrong later:
//   - it is one call, on the timer that was already running
//   - one device is a normal state with something to say, not a blank box
//   - the box does not grow under the pointer when the first snapshot lands
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

const LOCALES = ['en-US', 'zh-TW'] as const
const here = dirname(fileURLToPath(import.meta.url))
const MODAL = readFileSync(resolve(here, '../AccountModal.vue'), 'utf8')
const APP = readFileSync(resolve(here, '../../App.vue'), 'utf8')
/** The one owner of the cross-device snapshot. Assertions about *where* the
 *  read happens have to be able to look at both files, or "this window does not
 *  poll" would pass just as well if nobody polled at all. */
const SHARED = readFileSync(resolve(here, '../../composables/usePairingState.ts'), 'utf8')

function network(locale: (typeof LOCALES)[number]): Record<string, string> {
  const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
  return messages?.settings?.p2p?.network as Record<string, string>
}

/** Literal i18n keys the file asks for under `settings.p2p.network`. */
function networkKeys(): string[] {
  const found = new Set<string>()
  const re = /[$]?t\(\s*'settings\.p2p\.network\.([a-z0-9]+(?:-[a-z0-9]+)*)'/g
  for (const m of MODAL.matchAll(re)) found.add(m[1])
  return [...found]
}

describe('account modal — your network', () => {
  it('asks the backend for the whole network in one call', () => {
    // Devices, presence and panes in one read: three round trips per poll tick
    // would be three chances to render a half-updated picture. The read itself
    // is in the shared state — this window does not issue one of its own, or
    // the prompt over the app and this card would answer different moments.
    expect(MODAL).not.toContain("'p2p.network.snapshot'")
    expect(MODAL).toContain('const loadNetwork = pairingState.refresh')
    expect(SHARED).toContain("'p2p.network.snapshot'")
    expect(SHARED.match(/'p2p\.network\./g)?.length).toBe(1)
  })

  it('rides the status poll instead of starting a second timer', () => {
    // The backend keeps its copy current from the server's sessions.changed and
    // presence.changed pushes, so this is a cache read, not server traffic.
    expect(MODAL).toMatch(/async function refresh\(\)[\s\S]{0,200}loadStatus\(\)[\s\S]{0,80}loadNetwork\(\)/)
    expect(MODAL).toContain('timer = setInterval(() => void refresh(), 3000)')
    expect(MODAL.match(/setInterval\(/g)?.length).toBe(1)
    // Both events are named where the reason for reading a cache is explained,
    // because dropping either one silently stops the view updating.
    expect(MODAL).toContain('sessions.changed')
    expect(MODAL).toContain('presence.changed')
  })

  it('renders a row per device with an online dot and a pane count', () => {
    // The window is generous because what sits between the loop and the name
    // is comment, and this is not the test that pins the row's shape — that is
    // AccountModal.deviceRow.test.ts, which renders it.
    expect(MODAL).toMatch(/v-for="device in devices"[\s\S]{0,2200}deviceLabel\(device\)/)
    expect(MODAL).toMatch(/class="dot"\s*:class="device\.online \? 'ok' : 'idle'"/)
    expect(MODAL).toContain('paneCountLabel(device.paneCount)')
    // The label falls back to the id, shortened — a server that sends no
    // deviceName must still produce something a person can tell apart.
    expect(MODAL).toMatch(/deviceName\) return device\.deviceName/)
    expect(MODAL).toMatch(/device\.deviceId\.slice\(0, 12\)/)
  })

  it('badges the machine the user is sitting at', () => {
    expect(MODAL).toMatch(/v-if="device\.isLocal"[\s\S]{0,160}settings\.p2p\.network\.this-device/)
  })

  it('files the panes into folding sections instead of one flat list', () => {
    // This replaced a flat `v-for="pane in device.panes"`: seventy-four rows in
    // which the two that were running sat between sixty-three that had never
    // been opened, distinguishable only by a pill read one row at a time.
    expect(MODAL).toMatch(/v-for="group in visibleGroups\(device\)"/)
    expect(MODAL).toMatch(/v-for="row in group\.rows"/)
    expect(MODAL).toMatch(/pane-name" v-truncate>\{\{ row\.pane\.title \}\}/)
    // The section header is the status, so the rows below carry no pill. A pill
    // reappearing here would be the repetition this structure removed.
    const grouped = MODAL.slice(
      MODAL.indexOf('v-for="group in visibleGroups(device)"'),
      MODAL.indexOf('<p v-if="!device.panes.length"'),
    )
    expect(grouped).not.toContain('pane-pill')
    // `pane-wsrule` is the boundary caption and is expected; the repeated
    // per-row workspace column is what must not come back.
    expect(grouped).not.toContain('class="pane-ws"')
  })

  it('names the window an embedded AI panel lives in, and only for a panel', () => {
    // The roster carries `surface` only for a panel (absent for a window pane,
    // and from an older peer), so every other row renders exactly as before.
    expect(MODAL).toContain("import { dockWindowLabelKey } from '../lib/dockWindow'")
    expect(MODAL).toMatch(/surface\?: string/)
    for (const pane of ['hit.pane', 'row.pane']) {
      const label = `dockWindowLabelKey(${pane}.surface)`
      expect(MODAL).toContain(`v-if="${label}" class="pane-window"`)
      expect(MODAL).toContain(`{{ t(${label}!) }}`)
    }
  })

  it('says the state on a search hit, which has no section to say it', () => {
    // The one rule that keeps dropping the pill honest: out of its section a
    // row has nothing else reporting what state it is in, so the flat search
    // list puts the pill and the workspace back.
    const flat = MODAL.slice(MODAL.indexOf('v-if="searching"'), MODAL.indexOf('v-else class="pane-roster"'))
    expect(flat).toMatch(/class="pane-pill" :class="'st-' \+ badgeOf\(hit\.pane\.status\)"/)
    expect(flat).toContain('statusLabel(hit.pane.status)')
    expect(flat).toContain('hit.pane.workspace')
    // Across every machine: a hit means something regardless of which device
    // holds it, and the sections are per-device.
    expect(MODAL).toMatch(/for \(const device of devices\.value\)[\s\S]{0,400}hits\.push/)
  })

  it('folds what the user did not come for, and remembers the choice', () => {
    // Defaults carry the whole benefit: the panes that were never opened were
    // 85% of the list, and another machine's roster is context, not the thing
    // this dialog was opened for.
    expect(MODAL).toMatch(/group === 'not-opened'/)
    expect(MODAL).toMatch(/folded\(deviceFoldKey\(device\), !device\.isLocal\)/)
    // A blocked or corrupt store must not take the list with it.
    expect(MODAL).toMatch(/localStorage\.getItem\(FOLD_STORE\)[\s\S]{0,200}catch/)
  })

  it('gives the roster a ceiling', () => {
    // There was none: seventy-four rows grew the card until the dialog was as
    // tall as the screen, and the only scroll was the whole modal body.
    expect(MODAL).toMatch(/\.pane-roster[^{]*\{[^}]*max-height/)
    expect(MODAL).toMatch(/\.pane-roster[^{]*\{[^}]*overflow-y: auto/)
  })

  it('has every state word the wire can carry', () => {
    // The wire vocabulary: the sidebar's own badge words (sessions.upsert
    // enforces the list), plus `disconnected` which only the directory knows,
    // plus `not-opened` which this device substitutes for a pane that was
    // restored but never opened, plus `waiting` from a machine too old to send
    // a badge word. Every one of them has to render as something.
    const WIRE = [
      'running', 'idle', 'starting', 'awaiting', 'exited', 'error', 'stopped',
      'disconnected', 'not-opened', 'waiting',
    ]
    for (const locale of LOCALES) {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
      for (const state of WIRE) {
        const badge = state === 'not-opened' ? 'waiting' : state === 'waiting' ? 'idle' : state
        expect(messages.paneStatus[badge], `${locale}/paneStatus.${badge}`).toBeTruthy()
      }
    }
  })

  it('shows a word from a newer build raw rather than hiding the pane', () => {
    // A machine on a build newer than this one can report a state this one has
    // no label for. Falling back to the raw word keeps the pane visible and
    // legible; the failure this guards against is a blank pill, or worse, a
    // dotted i18n key shown to a person.
    expect(MODAL).toMatch(/const label = t\(key\)[\s\S]{0,60}label === key \? value : label/)
  })

  it('calls a pane what the sidebar calls it, by reading the same words', () => {
    // The invariant is unchanged — one pane must not be two different things in
    // two places — but it is now structural rather than kept in step by hand.
    // This used to be two vocabularies (`settings.p2p.network.status-*` here,
    // `paneStatus.*` in the sidebar) with a test asserting they matched; they
    // did not, and could not, because they were maintained separately: the
    // sidebar said "idle", this said "Waiting", for the same pane.
    // The mapping is now applied in exactly one function, `badgeOf`, which the
    // label, the pill class and the section a pane is filed under all call — so
    // they cannot disagree. They did: the pill was built from the raw wire word
    // while the text was built from the mapped one.
    expect(MODAL).toMatch(/function badgeOf\(value: string\): string \{\s*return WIRE_TO_BADGE\[value\] \?\? value/)
    expect(MODAL).toMatch(/`paneStatus\.\$\{badgeOf\(value\)\}`/)
    expect(MODAL.match(/WIRE_TO_BADGE\[/g)?.length, 'the mapping is applied once').toBe(1)

    // The regression line. Reintroducing a private copy of the vocabulary is
    // exactly how the two drifted apart the first time, and it would pass every
    // other test in this file.
    expect(MODAL).not.toContain('settings.p2p.network.status-')
    for (const locale of LOCALES) {
      const strings = network(locale)
      const copies = Object.keys(strings).filter((k) => k.startsWith('status-'))
      expect(copies, `${locale} still carries a second status vocabulary`).toEqual([])
    }
  })

  it('reports the badge word from the same expression the sidebar renders', () => {
    // The two ends of this feature live in different processes, and the only
    // thing keeping them honest is that one function answers for both. Two
    // copies of the expression is how the sidebar came to say "running" while
    // the network view said "not opened" about the same pane.
    const uses = [...APP.matchAll(/paneDisplayStatus\(/g)].length
    expect(uses, 'paneDisplayStatus should be declared once and called by every reader').toBe(5)
    expect(APP).toMatch(/reportPaneBusy\(pane\.id, [^,]+, paneDisplayStatus\(pane\)\)/)
    expect(APP).toMatch(/status: paneDisplayStatus\(p\) \|\| 'waiting'/)
    // ui.pane.close reports what closing a pane interrupted, and "was it busy"
    // has to be the same question the sidebar answers — a second expression
    // here would let the advisory say "idle" about a pane the sidebar shows
    // as running, which is the drift this test exists to prevent.
    expect(APP).toMatch(/status: paneDisplayStatus\(doomed\)/)
    // ui.pane.interrupt reports the state the interrupt key landed on, and it
    // has to be the word the sidebar was showing at that instant — a second
    // expression here would let it answer "running" about a pane everyone
    // else could see was idle, which is the whole point of reporting it.
    expect(APP).toMatch(/const status = paneDisplayStatus\(pane\)/)

    // Both facts in one message: the registry must never hold this tick's flag
    // beside the last tick's word.
    expect(APP).toMatch(/'agent_msg\.set_busy', \{ pane_id: paneId, busy, status \}/)
  })

  it('translates the two wire words that are not badge words', () => {
    // `not-opened` and `waiting` are the only two that need a mapping, and both
    // are load-bearing: without the first a cold-restore placeholder renders
    // raw, and without the second a pane on an un-upgraded machine would be
    // labelled "not opened" — which is a different claim entirely.
    expect(MODAL).toContain(
      "const WIRE_TO_BADGE: Record<string, string> = { 'not-opened': 'waiting', waiting: 'idle' }",
    )
  })

  it('colours the pills by state', () => {
    expect(MODAL).toMatch(/\.pane-pill\.st-running \{[^}]*--success-fg/)
    // `waiting` is the badge word for "not opened" — a restore placeholder, the
    // quietest thing on the list. It used to wear the loud attention pill,
    // because the class was built from the raw wire word, where `waiting` means
    // a live idle pane. Now both ends read the mapped word, so it is hollow.
    expect(MODAL).toMatch(/\.pane-pill\.st-waiting,[\s\S]{0,200}background: none; border-color/)
    expect(MODAL).toMatch(/\.pane-pill\.st-disconnected \{[^}]*border-color/)
    // A pane holding a prompt open is the reason to look at another machine's
    // list at all, so it is loud rather than hollow.
    expect(MODAL).toMatch(/\.pane-pill\.st-awaiting \{[^}]*--attention-fg/)
    // A state with no rule of its own renders as the default pill, which reads
    // as "nothing to see here" — the wrong answer for a pane whose CLI died.
    for (const dead of ['error', 'stopped', 'exited']) {
      expect(MODAL, `st-${dead} has no colour rule`).toMatch(
        new RegExp(`\\.pane-pill\\.st-${dead}[^{]*\\{[^}]*--danger-fg|\\.pane-pill\\.st-${dead},`),
      )
    }
    for (const quiet of ['idle', 'starting']) {
      expect(MODAL, `st-${quiet} has no colour rule`).toMatch(
        new RegExp(`\\.pane-pill\\.st-${quiet}[,\\s]`),
      )
    }
    // `st-not-opened` is gone on purpose: the class is built from the badge
    // word now, and `not-opened` maps to `waiting`, which the hollow rule above
    // covers. A rule keyed on the wire word would never match again.
    expect(MODAL).not.toContain('.pane-pill.st-not-opened {')
  })

  // ---- the trust surface ----------------------------------------------------

  it('shows the knock list only when something is waiting', () => {
    // An empty box here would read as a feature to configure; the absence of a
    // request is the normal state.
    expect(MODAL).toContain('v-if="accessRequests.length" class="card net-card"')
    expect(MODAL).toContain('v-if="signedIn && blocked.length"')
  })

  it('puts the decision above the network it is about', () => {
    // The only part of the panel waiting on the user goes first. Both kinds of
    // waiting now sit under one heading — pairing and access requests are two
    // shapes of "something needs you", and two near-identical titles side by
    // side read as one list somebody split in half.
    const needsYou = MODAL.indexOf('settings.p2p.trust.needs-you')
    const net = MODAL.indexOf('settings.p2p.network.title')
    expect(needsYou).toBeGreaterThan(-1)
    expect(needsYou).toBeLessThan(net)
    // And each row says which of the two it is.
    expect(MODAL).toContain('settings.p2p.trust.kind-device')
    expect(MODAL).toContain('settings.p2p.trust.kind-access')
  })

  it('offers all three answers to a knock', () => {
    for (const action of ['approveRequest(req)', 'dismissRequest(req)', 'blockRequest(req)']) {
      expect(MODAL).toContain(action)
    }
    expect(MODAL).toContain('unblock(entry)')
  })

  it('cannot act on two knocks at once', () => {
    // Every one of these writes the whole policy document, so a second click
    // landing mid-write would be a read-modify-write race against ourselves.
    expect(MODAL).toMatch(/if \(deciding\.value\) return/)
    // The link-readiness gate rides on the same attribute, so the count is of
    // buttons that share the one-at-a-time lock rather than of a literal.
    expect(MODAL.match(/:disabled="!!deciding \|\| !linkReady"/g)?.length).toBe(4)
  })

  it('approving a knock carries a window-minted confirmation, like any policy write', () => {
    expect(MODAL).toMatch(/withConfirmation\('p2p\.access_requests\.approve', '', \{ key: req\.key \}, req\.key\)/)
    // ...and the two policy writers bind the document itself.
    expect(MODAL).toMatch(/withConfirmation\('p2p\.policy\.set', '', \{ policy: doc \}, canonicalJson\(doc\)\)/)
  })

  it('re-reads after every decision, so a row leaves only when it really did', () => {
    expect(MODAL).toMatch(/await props\.backend\.send\(type, args\)[\s\S]{0,60}await loadNetwork\(\)/)
  })

  it('reads the trust state from the snapshot it already polls', () => {
    // Not a second timer and not a subscription: one read, so the panel cannot
    // draw half of one moment and half of the next.
    expect(MODAL).toContain('network.value?.accessRequests ?? []')
    expect(MODAL).toContain('network.value?.blocked ?? []')
    expect(MODAL).toMatch(/const network = computed[\s\S]{0,120}pairingState\.snapshot/)
  })

  it('gives a remote agent no way to approve itself', () => {
    // The hole this closes is the one RustDesk defends against by swallowing
    // clicks in its accept window that land right after a remote-injected
    // click: a peer that can drive the UI can otherwise grant itself access.
    // Here the defence is structural rather than timing-based — the trust
    // decisions are backend messages the modal sends, never `ui.*` commands,
    // and `ui_invoke` can only reach a registered command. Registering one of
    // these would hand every CLI agent on this machine, local or relayed in,
    // the ability to approve a device on the user's behalf.
    const commands = [...APP.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1])
    expect(commands.length).toBeGreaterThan(0)
    for (const name of commands) {
      expect(name).not.toMatch(/trust|access_request|approve|unblock/i)
    }
    // ...and the modal reaches them the only way that stays out of that registry.
    for (const type of [
      'p2p.access_requests.approve',
      'p2p.access_requests.dismiss',
      'p2p.trust.block',
      'p2p.trust.unblock',
    ]) {
      expect(MODAL).toContain(type)
      expect(APP).not.toContain(type)
    }
  })

  // ---- rate limiting --------------------------------------------------------

  it('does not tell a throttled sign-in that a mail was sent', () => {
    // RATE_LIMITED now arrives from two places. The verification-resend
    // sentence ("a link was just sent") would send someone throttled for
    // repeated sign-in attempts looking through an inbox for something nobody
    // sent, so the mail wording is reachable only from the resend call site.
    expect(MODAL).toMatch(/where === 'resend'[\s\S]{0,80}verify-rate-limited/)
    expect(MODAL).toContain("explain(resp.error, resp.error?.message ?? t('account.err-generic'), 'resend')")
  })

  it('says how long the wait is, using what the server reported', () => {
    // "Try again later" with no number is the kind of message people retry
    // against pointlessly; the server already sends retryAfterMs.
    expect(MODAL).toContain('error?.details?.retryAfterMs')
    expect(MODAL).toContain("t('account.err-rate-limited', { seconds })")
    expect(MODAL).toContain("t('account.err-rate-limited-soon')")
    for (const locale of LOCALES) {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
      expect(messages.account['err-rate-limited'], `${locale}/err-rate-limited`).toContain('{seconds}')
      expect(messages.account['err-rate-limited-soon'], `${locale}/soon`).toBeTruthy()
    }
  })

  // ---- the switch and what it discloses ---------------------------------------

  it('turns the link off without throwing the account away', () => {
    // Signing out was the only way to stop this machine talking to the server,
    // and it discards the credential — so "off for now" cost the user their
    // account on this device.
    expect(MODAL).toContain("'p2p.link.set_paused'")
    expect(MODAL).toContain('paused: !paused.value')
  })

  it('shows paused as its own thing, not as a connection failure', () => {
    // Pausing is something a person did. Rendering it as "unreachable" would
    // blame the network for their own switch.
    expect(MODAL).toMatch(/paused \? t\('settings\.p2p\.link\.paused'\)/)
    expect(MODAL).toContain('status.value?.paused === true')
  })

  it('reports the link state and reason the backend gave, not a summary', () => {
    expect(MODAL).toContain("settings.p2p.state-' + state")
    expect(MODAL).toContain('status.detail')
    for (const locale of LOCALES) {
      const p2p = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p
      for (const state of [
        'unconfigured',
        'connecting',
        'waiting-for-keychain',
        'connected',
        'unreachable',
        'unauthorized',
      ]) {
        expect(p2p[`state-${state}`], `${locale}/state-${state}`).toBeTruthy()
      }
    }
  })

  it('has one vocabulary for the link state, not two', () => {
    // There were two sets of these words and two lamps: the card read
    // `network.state` and knew only "connected or not", so a rejected token
    // showed amber there and red in the footer — on one screen, about one fact.
    expect(MODAL).not.toContain('settings.p2p.link.state-')
    expect(MODAL).not.toContain("network?.state === 'connected'")
    for (const locale of LOCALES) {
      const link = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.link
      expect(Object.keys(link).filter((k) => k.startsWith('state-'))).toEqual([])
    }
    // One function decides the colour, and all three lamps call it.
    expect(MODAL).toContain('function dotFor(value: string)')
    expect(MODAL.match(/:class="[^"]*dotClass/g)?.length).toBeGreaterThanOrEqual(3)
  })

  // ---- trust notices -----------------------------------------------------------

  it('tells a first sighting apart from a changed key', () => {
    // In the data these are the same event; only the pinning makes them
    // different, and only one of them is a refusal happening right now.
    expect(MODAL).toContain("n.kind === 'device-key-changed'")
    expect(MODAL).toContain("n.kind === 'policy-unverified'")
  })

  it('offers no button on a changed key, and shows both fingerprints', () => {
    // The backend refuses to dismiss these, so a button here would always fail
    // and read as a bug rather than as a rule. Comparing the two fingerprints
    // out of band is the only real answer, so both are on screen.
    const changed = MODAL.slice(
      MODAL.indexOf("n.kind === 'device-key-changed'"),
      MODAL.indexOf("n.kind === 'policy-unverified'"),
    )
    expect(changed).toContain('n.pinnedFingerprint')
    expect(changed).toContain('n.offeredFingerprint')
    expect(changed).not.toContain('dismissNotice')
  })

  it('flags a new device that landed in the own-machines ring', () => {
    // That ring skips the rules entirely, so it is the one first sighting that
    // is not merely informational.
    expect(MODAL).toContain('n.own')
    expect(MODAL).toContain('settings.p2p.trust.first-seen-own')
  })

  it('no longer offers to vouch for a device from the card', () => {
    // Approving where the row sat pinned whatever key the directory advertised,
    // with nobody comparing anything. It is gone rather than hidden: the only
    // thing that writes a pin now is a pairing two people confirmed, and rows
    // that survive here are pins taken under the older rule.
    const start = MODAL.indexOf('settings.p2p.trust.pending-body')
    expect(start).toBeGreaterThan(-1)
    const section = MODAL.slice(start, MODAL.indexOf('</section>', start))
    expect(section).toContain('row.fingerprint')
    expect(section).not.toContain('approveDevice')
    expect(MODAL).not.toContain("'p2p.trust.device.approve'")
  })

  it('offers a third answer that decides nothing', () => {
    // Without it the card gave a person two options and no way to leave: decide
    // now, or be asked again in three seconds, forever. Unpair looked like the
    // way out and was not — it dropped the pin, and the row grew back.
    expect(MODAL).toContain("'p2p.trust.device.defer'")
    const start = MODAL.indexOf('settings.p2p.trust.pending-body')
    const section = MODAL.slice(start, MODAL.indexOf('</section>', start))
    expect(section).toContain('deferDevice(row)')
    expect(section).toContain('settings.p2p.trust.pending-later')
    // Block is still there, so "not now" is genuinely a third answer rather
    // than the only other one.
    expect(section).toContain('blockPending(row)')
  })

  it('keeps unpair off the pending card entirely', () => {
    // It is not an answer to the question the card asks, and using it as one is
    // what "I rejected it and it came back" was: the pin went, and the row was
    // rebuilt from the directory on the next poll.
    const start = MODAL.indexOf('settings.p2p.trust.pending-body')
    const section = MODAL.slice(start, MODAL.indexOf('</section>', start))
    expect(section).not.toContain('unpairDevice')
  })

  it('lets a device be forgotten from the device list too', () => {
    // Once vouched for, a machine leaves the pending section entirely — so
    // without this the only surface offering unpair would be the one a paired
    // device has already left.
    const start = MODAL.indexOf('v-for="device in devices"')
    const row = MODAL.slice(start, MODAL.indexOf('</div>', MODAL.indexOf('dev-meta', start)))
    expect(row).toContain('unpairDevice(device.deviceId)')
    // Not on this machine's own row: there is no pairing with yourself to undo.
    // Nor on a row still waiting to be vouched for — there is no pin to forget
    // there, so unpairing found nothing and the row came straight back.
    expect(row).toMatch(
      /v-if="!device\.isLocal && device\.trustState === 'trusted'"[\s\S]{0,320}unpairDevice/,
    )
    // Quiet, and last: on a row that is already settled this is the thing you
    // are least likely to have come for.
    expect(row).toContain('dev-review dev-undo')
  })

  it('unpairs through the same one-at-a-time gate as the other trust acts', () => {
    // Every button in this panel shares `pending`, which is what stops a second
    // click landing while the first is in flight and the view is about to be
    // replaced by a fresh snapshot.
    expect(MODAL).toMatch(
      /async function unpairDevice\(deviceId: string\)[\s\S]{0,120}if \(pending\.value \|\| !deviceId\) return/,
    )
    expect(MODAL).toMatch(/unpairDevice[\s\S]{0,400}await loadNetwork\(\)/)
  })

  it('titles the pending card with the machine name, not its uuid', () => {
    // "Is this f9c30189-79e6-…?" is not a question anybody can answer, and this
    // card carries the strongest button in the panel. The id stays reachable as
    // a tooltip because that is what the logs show — it is not the question.
    const start = MODAL.indexOf('settings.p2p.trust.pending-body')
    const section = MODAL.slice(start, MODAL.indexOf('</section>', start))
    expect(section).toContain('row.deviceName || row.deviceId')
    expect(section).toContain(':title="row.deviceId"')
    // Placed the way the device list places a machine: online, and what it has
    // open. No essay — the fingerprint is the thing being compared.
    expect(section).toContain('row.online')
    expect(section).toContain('row.paneCount')
    expect(section).toContain('row.fingerprint')
  })

  it('tells the device list where each machine stands, and offers the matching action', () => {
    // The list said nothing about trust, so an unvouched device looked exactly
    // like a vouched one — same row, same unpair button — while the card above
    // asked for confirmation. Two surfaces, one device, opposite stories.
    const start = MODAL.indexOf('settings.p2p.network.title')
    const section = MODAL.slice(start, MODAL.indexOf('</section>', start))
    expect(section).toContain("'settings.p2p.trust.state-' + device.trustState")
    // Unpair forgets a pin, so it is only offered where there is one.
    expect(section).toContain("device.trustState === 'trusted'")
    // Review is offered by whether the card below is actually asking, not by
    // the trust state alone — see the test that pins that.
    expect(section).toContain('hasPendingRow(device)')
    expect(section).toContain('reviewPending()')
  })



  it('lets a pending device be refused, not only approved', () => {
    // With approval as the only button, somebody who did not recognise a
    // machine could only leave it alone — and doing nothing looked exactly like
    // refusing while the row stayed listed forever.
    const start = MODAL.indexOf('settings.p2p.trust.pending-body')
    const section = MODAL.slice(start, MODAL.indexOf('</section>', start))
    expect(section).toContain('settings.p2p.trust.pending-block')
    expect(section).toContain('blockPending(row)')
    expect(MODAL).toContain("'p2p.trust.block'")
  })

  it('has no notion of a directory-only row left to special-case', () => {
    // Every row on this card is a machine that actually knocked, so the flag
    // that used to mark the other kind — and the two buttons that had to be
    // hidden on it — are gone rather than merely unused.
    expect(MODAL).not.toContain('fromDirectory')
  })

  it('defers through the same one-at-a-time gate as the other trust acts', () => {
    expect(MODAL).toMatch(
      /async function deferDevice\(row: PendingDevice\)[\s\S]{0,120}if \(pending\.value\) return/,
    )
    expect(MODAL).toMatch(/deferDevice[\s\S]{0,500}await loadNetwork\(\)/)
  })

  it('keeps pending approvals out of the notice list', () => {
    // A notice records that something happened and can be acknowledged away. A
    // pending approval is a question that is still open, and acknowledging the
    // first-sighting notice must not be able to answer it — so it reads from
    // its own field rather than filtering the notices.
    expect(MODAL).toContain('network.value?.trustPending')
    const start = MODAL.indexOf('settings.p2p.trust.pending-body')
    const section = MODAL.slice(start, MODAL.indexOf('</section>', start))
    expect(section).not.toContain('dismissNotice')
    expect(section).not.toContain('trustNotices')
  })

  it('no longer tells the reader that an own first sighting skips the rules', () => {
    // It used to, and it was true then. Approval made it false, and copy that
    // describes a defence the code stopped providing is worse than no copy: it
    // reads as reassurance at exactly the moment someone is deciding whether to
    // ask about a machine they did not add.
    for (const locale of LOCALES) {
      const trust = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p
        .trust as Record<string, string>
      expect(trust['first-seen-own-body']).toBeTruthy()
      expect(trust['first-seen-own-body']).not.toMatch(/skip your rules entirely\./)
      expect(trust['first-seen-own-body']).not.toMatch(/完全不經過你的規則。/)
    }
  })

  // The card's own markup. Not sliced to `</section>` any more: the card now
  // lives inside the network section, so that tag is the end of the whole
  // section with the connection card and the entire device list in between.
  function lockedMarkup(): string {
    const start = MODAL.indexOf('class="card locked-card"')
    expect(start).toBeGreaterThan(-1)
    const end = MODAL.indexOf('<div class="card net-card"', start)
    expect(end).toBeGreaterThan(start)
    return MODAL.slice(start, end)
  }

  it('says when the trust journal cannot be used, without calling pairing broken', () => {
    // Review KC-3: an unreadable journal is kept, not overwritten, and the
    // person is told — pairing itself is unaffected, so this is not the lock card.
    const start = MODAL.indexOf('v-if="trustJournalProblem"')
    expect(start).toBeGreaterThan(-1)
    expect(start).toBeLessThan(MODAL.indexOf('class="card locked-card"'))
    const card = MODAL.slice(start, MODAL.indexOf('</div>', start))
    expect(card).toContain("t('settings.p2p.trust.journal-problem')")
    expect(card).toContain('{{ trustJournalProblem }}')
    expect(card).not.toMatch(/<button/)
    expect(MODAL).toContain("const trustJournalProblem = computed(() => network.value?.trustJournalProblem ?? '')")
  })

  it('says a damaged record is damaged and that pairing again is the fix', () => {
    // 2026-10-11: a record cut off by a Keychain write read as "had trust state
    // and no longer does", which points at an attack, not at the one fix.
    const locked = lockedMarkup()
    expect(locked).toMatch(
      /v-if="trustDamaged"[^>]*>\s*\{\{ t\('settings\.p2p\.trust\.damaged-body'\) \}\}[\s\S]*v-else[^>]*>\s*\{\{ t\('settings\.p2p\.trust\.locked-body'\) \}\}/,
    )
    const armed = locked.slice(locked.indexOf('v-else-if="rebuildArmed"'), locked.indexOf('rebuildTrust()'))
    expect(armed).toContain("trustDamaged ? 'settings.p2p.trust.damaged-rebuild-warn' : 'settings.p2p.trust.rebuild-warn'")
    expect(MODAL).toContain("const trustDamaged = computed(() => network.value?.trustDamaged === true)")
  })

  it('offers no way out at all while the read is still being retried', () => {
    // The dangerous state, and the one that used to be indistinguishable from a
    // record that is really gone: a locked keychain, a dismissed authorisation
    // dialog and a `security` timeout all read the same from here. Offering to
    // erase every pairing on the strength of one of those is offering to
    // destroy something nothing is wrong with, so the buttons are not merely
    // disabled — the whole branch is absent.
    const locked = lockedMarkup()
    const transient = locked.slice(
      locked.indexOf('v-if="trustLockedTransient"'),
      locked.indexOf('v-else-if="rebuildDone"'),
    )
    expect(transient).toContain('settings.p2p.trust.locked-retrying')
    expect(transient).not.toMatch(/<button/)
    // Written as one chain, so "not transient" is stated once rather than
    // repeated on every branch that has to stay in step with it.
    expect(locked).toMatch(
      /v-if="trustLockedTransient"[\s\S]*v-else-if="rebuildDone"[\s\S]*v-else-if="rebuildArmed"[\s\S]*<div v-else class="locked-acts">/,
    )
  })

  it('cannot clear a trust lock in one press', () => {
    // This used to assert the card had no button at all, and that was true
    // until "start over" shipped. The guarantee it was really holding is the
    // one kept here: starting over is exactly what an attacker who deleted
    // that state is waiting for, so it must never be one click away.
    //
    // The behavioural half of this lives in AccountModal.deviceRow.test.ts
    // ("sends nothing until the second press"). It does not replace this one:
    // that test clicks the FIRST button it finds, so a template that grew a
    // second button wired straight to rebuildTrust would still leave it green.
    // This is the structural half — what the markup is allowed to contain.
    const locked = lockedMarkup()
    expect(locked).toContain('settings.p2p.trust.locked-body')

    // The resting state — the read has settled, so there is a decision to make.
    // Anchored on the last branch of the chain, which is the only one reached
    // when nothing else applies.
    const resting = locked.slice(locked.indexOf('<div v-else class="locked-acts">'))
    expect(resting).toMatch(/<button/)
    expect(resting.match(/<button/g)).toHaveLength(1)
    expect(resting).toContain('rebuildArmed = true')
    expect(resting).not.toContain('rebuildTrust')

    // And the only call that actually sends it is behind the cost.
    expect(locked.indexOf('trust.rebuild-warn')).toBeLessThan(locked.indexOf('rebuildTrust()'))
  })

  it('keeps the gap the layout asks for', () => {
    // The card sits between the connection card and the directory because the
    // warning has to be read before the list it makes untrustworthy. The gap is
    // part of that arrangement, not decoration — it was lost to a parallel edit
    // once already, without any test noticing.
    const css = MODAL.slice(MODAL.indexOf('.locked-card {'))
    expect(css.slice(0, css.indexOf('}'))).toMatch(/margin-bottom:\s*10px/)
  })

  it('puts the trust lock between the connection and the directory', () => {
    // Placement is the message: the device list below cannot be trusted while
    // this is unresolved, so the warning has to be read before the list, not
    // scrolled past above it.
    const link = MODAL.indexOf('class="card link-card"')
    const locked = MODAL.indexOf('class="card locked-card"')
    const list = MODAL.indexOf('<div class="card net-card"', link)
    expect(link).toBeGreaterThan(-1)
    expect(locked).toBeGreaterThan(link)
    expect(list).toBeGreaterThan(locked)
  })

  it('has every link string it shows, in both locales', () => {
    const keys = new Set<string>()
    for (const m of MODAL.matchAll(/[$]?t\(\s*'settings\.p2p\.link\.([a-z0-9]+(?:-[a-z0-9]+)*)'/g)) {
      keys.add(m[1])
    }
    expect(keys.size).toBeGreaterThan(0)
    for (const locale of LOCALES) {
      const link = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.link
      for (const key of keys) expect(link?.[key], `${locale}/link.${key}`).toBeTruthy()
    }
  })

  it('has every trust string it shows, in both locales', () => {
    const keys = new Set<string>()
    const re = /[$]?t\(\s*'settings\.p2p\.trust\.([a-z0-9]+(?:-[a-z0-9]+)*)'/g
    for (const m of MODAL.matchAll(re)) keys.add(m[1])
    expect(keys.size).toBeGreaterThan(0)
    for (const locale of LOCALES) {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
      const trust = messages?.settings?.p2p?.trust as Record<string, string>
      for (const key of keys) {
        expect(trust?.[key], `${locale}/settings.p2p.trust.${key}`).toBeTruthy()
      }
    }
  })

  it('says something useful with only one machine signed in', () => {
    // The user's normal state, and the one a blank box would fail.
    expect(MODAL).toMatch(/soloDevice = computed\([\s\S]{0,120}devices\.value\[0\]\.isLocal/)
    expect(MODAL).toMatch(/v-if="soloDevice"[\s\S]{0,120}settings\.p2p\.network\.solo/)
    // A device with no panes is not an empty section either. It now hangs off
    // the pane count rather than off a v-else, because the sections between
    // them are a v-for that simply produces nothing.
    expect(MODAL).toMatch(/v-if="!device\.panes\.length" class="hint net-note">[\s\S]{0,80}settings\.p2p\.network\.no-panes/)
  })

  it('has a waiting state and a not-linked state, not a blank box', () => {
    expect(MODAL).toMatch(/v-if="networkUnavailable"[\s\S]{0,160}settings\.p2p\.network\.unavailable/)
    expect(MODAL).toMatch(/v-else-if="!network"[\s\S]{0,160}settings\.p2p\.network\.loading/)
    // The distinction is made where the read happens; this window shows it.
    expect(MODAL).toContain('const networkUnavailable = pairingState.unavailable')
    expect(SHARED).toContain("resp.error?.code === 'P2P_NOT_CONFIGURED'")
  })

  it('reserves the section height so the modal does not jump', () => {
    expect(MODAL).toMatch(/\.net-card \{[^}]*min-height/)
  })

  it('shows the last picture with a caveat when the link is down', () => {
    // Refusing would read as "you have no network"; the machines did not stop
    // existing because the socket blinked.
    expect(MODAL).toMatch(/networkStale = computed\([\s\S]{0,160}state !== 'connected'/)
    // Second in the chain: a read that failed is a different fact and gets its
    // own sentence, because this one named the link on a screen whose
    // connection card was green. Which sentence appears when is asserted by
    // mounting, in AccountModal.staleness.test.ts.
    expect(MODAL).toMatch(/v-else-if="networkStale"[\s\S]{0,120}settings\.p2p\.network\.link-offline/)
  })

  it('drops the network when the account signs out', () => {
    // It belonged to that account; whoever signs in next must not be shown
    // someone else's machines.
    expect(MODAL).toMatch(/resent\.value = false\s*\n[\s\S]{0,320}pairingState\.clear\(\)/)
    expect(SHARED).toMatch(/clear\(\): void \{[\s\S]{0,80}snapshot\.value = null/)
  })

  it('sits between the account card and sign out, in the same visual language', () => {
    const section = MODAL.indexOf('<section v-if="signedIn" class="net">')
    expect(section).toBeGreaterThan(MODAL.indexOf('<div class="card">'))
    expect(section).toBeLessThan(MODAL.indexOf('@click="signOut"'))
    expect(MODAL).toContain('<div class="card net-card">')
    expect(MODAL).toMatch(/class="hint net-note"/)
  })

  it('has every string it shows, in both locales', () => {
    const keys = networkKeys()
    expect(keys.length).toBeGreaterThan(6)
    for (const locale of LOCALES) {
      const strings = network(locale)
      expect(strings, locale).toBeTruthy()
      for (const key of keys) expect(strings[key], `${locale}/${key}`).toBeTruthy()
      // The count label is three fixed keys rather than a plural rule, so all
      // three have to exist even though only one is asked for literally.
      for (const key of ['panes', 'panes-one', 'panes-none']) {
        expect(strings[key], `${locale}/${key}`).toBeTruthy()
      }
      expect(strings['panes'], locale).toContain('{count}')
    }
  })
})

describe('email verification', () => {
  it('says "not verified" on the address line, not only in the notice below', () => {
    // The notice sits below the device id and the identity block — far enough
    // down that somebody reading the address itself would not see it. This is
    // the state of that line, so it belongs on it, and it mirrors the tick that
    // a verified address already gets in the same place.
    const start = MODAL.indexOf("settings.p2p.account.email")
    const section = MODAL.slice(start, start + 900)
    expect(section).toContain('settings.p2p.account.not-verified')
    expect(section).toMatch(/v-else-if="signedIn"[\s\S]{0,120}not-verified/)
  })

  it('lets a stale "we sent you a link" be re-asked on the spot', () => {
    // The backend polls and adopts a push, so this changes nothing about what
    // is eventually true. What it changes is the person looking at "check your
    // mail" seconds after they did — without a way to ask, the only evidence
    // they have is that clicking the link achieved nothing.
    expect(MODAL).toContain("'p2p.account.check_verification'")
    expect(MODAL).toContain('settings.p2p.account.verify-check')
    expect(MODAL).toMatch(/@click="checkVerification"/)
    // A second click cannot stack, the same gate every other act here uses.
    expect(MODAL).toMatch(
      /async function checkVerification\(\)[\s\S]{0,120}if \(checking\.value\) return/,
    )
  })

  it('re-reads the whole status rather than inferring it from one field', () => {
    // The card above reads from `status`; this call only knows emailVerified.
    expect(MODAL).toMatch(
      /resp\.payload\?\.emailVerified\) \{[\s\S]{0,300}await loadStatus\(\)/,
    )
  })

  it('says so when the answer is still no', () => {
    // Otherwise the button looks like it did nothing at all, which is the same
    // complaint one level up.
    expect(MODAL).toContain('checkedStillPending')
    expect(MODAL).toContain('settings.p2p.account.verify-still-pending')
  })
})

describe('the unverified-rules notice', () => {
  const NOTICE = MODAL.slice(
    MODAL.indexOf("n.kind === 'policy-unverified'"),
    MODAL.indexOf("n.kind === 'device-first-seen'"),
  )

  it('offers the act the sentence asks for, in the window the sentence is in', () => {
    // It said "open the rules and save them once" and pointed nowhere — from a
    // window that does not contain the rules. Worse, that section has no save
    // button at all, so the instruction described an act that did not exist.
    expect(NOTICE).toContain('settings.p2p.trust.policy-sign')
    expect(NOTICE).toContain('signPolicyNow')
    expect(MODAL).toContain("'p2p.policy.set'")
  })

  it('signs the server’s own copy, not anything cached here', () => {
    // Signing a stale document would replace the rules with older ones while
    // looking like it only repaired a signature.
    expect(MODAL).toMatch(
      /async function signPolicyNow\(\)[\s\S]{0,600}send<\{ policy\?: unknown \}>\('p2p\.policy\.get'/,
    )
    expect(MODAL).toMatch(
      /p2p\.policy\.get[\s\S]{0,800}withConfirmation\('p2p\.policy\.set', '', \{ policy: doc \}, canonicalJson\(doc\)\)/,
    )
  })

  it('signs deny-all when there is nothing to re-sign, and says so', () => {
    // A machine that never had rules still has to be able to clear the warning,
    // and "nothing is allowed yet" is not what the button sounded like.
    expect(MODAL).toContain("{ version: 1, default: 'deny', rules: [] }")
    expect(NOTICE).toContain('settings.p2p.trust.policy-signed-default')
  })

  it('re-reads after signing so the notice leaves the screen', () => {
    expect(MODAL).toMatch(/signedDefaultPolicy\.value = usingDefault[\s\S]{0,200}await refresh\(\)/)
  })

  it('shows a refusal verbatim, under the button', () => {
    // A refusal to sign is the whole problem here; paraphrasing it would remove
    // the only clue to why.
    expect(NOTICE).toContain('policySignError')
    expect(MODAL).toContain('policySignError.value = resp.error?.message')
  })

  it('points at the rules with something clickable', () => {
    expect(NOTICE).toContain('settings.p2p.trust.policy-open-rules')
    expect(NOTICE).toContain("emit('open-rules')")
    expect(MODAL).toContain("(e: 'open-rules'): void")
  })
})

describe('what a trust-changing click carries', () => {
  it('asks main for a one-time confirmation and sends it', () => {
    // The backend refuses all six without one, and only a window can obtain it:
    // MCP and the plugin broker hold the same socket and have no path to the
    // key. That is the whole difference the check is drawing.
    expect(MODAL).toContain("window.agentTeam?.trustConfirm(action, deviceId, subject)")
    for (const action of [
      'p2p.pair.start',
      'p2p.pair.confirm',
      'p2p.trust.device.unpair',
      'p2p.trust.device.defer',
      'p2p.trust.block',
      'p2p.trust.unblock',
      'p2p.policy.set',
    ]) {
      expect(MODAL).toContain(`withConfirmation('${action}'`)
    }
  })

  it('sends a null confirmation through rather than inventing an error', () => {
    // The backend's refusal names the reason; a different one made up here
    // would hide it.
    expect(MODAL).toMatch(/return \{ \.\.\.payload, confirm \}/)
  })
})


describe('this machine’s own fingerprint', () => {
  it('is on the account card, because another machine’s box asks for it', () => {
    // The confirmation box over there asks a person to type this machine's
    // first four characters. Until this line existed the app showed that value
    // nowhere, so the step could only be guessed at or asked for over the wire
    // — which is what the comparison exists to catch.
    expect(MODAL).toContain("settings.p2p.fingerprint")
    expect(MODAL).toContain('status.selfFingerprint')
    // Right under the device id, which is the other thing that identifies this
    // machine to somebody standing at it.
    expect(MODAL).toMatch(/settings\.p2p\.device-id[\s\S]{0,900}status\.selfFingerprint/)
  })

  it('can be read off the screen and copied', () => {
    // The entire use of this line is being carried to another machine.
    expect(MODAL).toContain('user-select: text')
    expect(MODAL).toContain('navigator.clipboard?.writeText(value)')
    expect(MODAL).toContain('copyFingerprint')
  })

  it('says in the source why it must not be tidied away', () => {
    // A bare hex string on a settings card reads as decoration, and the reason
    // it is not lives on another machine's screen.
    expect(MODAL).toContain(
      'The only reason this line exists is so that the confirmation box',
    )
  })

})

describe('pairing, from both ends', () => {
  const CARD = MODAL.slice(
    MODAL.indexOf("settings.p2p.pair.title"),
    MODAL.indexOf('settings.p2p.trust.pending-body'),
  )

  it('asks rather than grants', () => {
    // The button here used to pair the other machine outright once you had
    // typed four characters of its fingerprint — one side deciding, the other
    // finding out when something started running on it.
    expect(MODAL).toContain("'p2p.pair.start'")
    expect(MODAL).toContain('startPairing(device)')
    expect(MODAL).toContain('settings.p2p.pair.start')
    // The one-sided path is gone rather than merely unused.
    expect(MODAL).not.toContain('askToTrust')
    expect(MODAL).not.toContain('trustEntryMatches')
    expect(MODAL).not.toContain('maskedFingerprint')
  })

  it('shows the same six digits on both screens, with two answers', () => {
    expect(CARD).toContain('row.code')
    expect(CARD).toContain('settings.p2p.pair.match')
    expect(CARD).toContain('settings.p2p.pair.mismatch')
    expect(CARD).toContain('answerPairing(row, true)')
    expect(CARD).toContain('answerPairing(row, false)')
  })

  it('says a different sentence at each end', () => {
    // "You asked them" and "they asked you" are different situations, and the
    // person who did not start it is the one who most needs telling why a card
    // just appeared.
    expect(CARD).toContain("row.role === 'responder'")
    expect(CARD).toContain('settings.p2p.pair.asked-by')
    expect(CARD).toContain('settings.p2p.pair.asking')
  })

  it('offers no decision before there is one to make', () => {
    // Until the other machine answers there are no digits to compare, so a
    // button that decided something would be offered before its question exists.
    // The stage pill sits between them now, so the window is wider.
    expect(CARD).toMatch(/v-if="!row\.code"[\s\S]{0,700}pair\.waiting-response/)
  })

  it('takes the buttons away once this side has answered', () => {
    // The point is not that the sentence appears — it is that the two answers
    // are in the *other* branch. With the buttons outside the v-if/v-else they
    // stayed clickable after confirming, and a second click would answer a
    // question this side had already answered.
    //
    // So this reads the structure rather than the copy: the waiting paragraph,
    // and then the element that carries the buttons, which must open with
    // v-else (or v-else-if) to belong to the same conditional.
    const at = CARD.indexOf("row.state === 'awaiting-remote'")
    expect(at).toBeGreaterThan(-1)
    // The waiting branch is a <template> now (a pill, a line, and a note), so
    // the element after it is the one that must carry v-else.
    const after = CARD.slice(CARD.indexOf('</template>', at) + '</template>'.length)
    const nextTag = after.match(/<(\w+)([^>]*)>/)
    expect(nextTag, 'nothing follows the waiting branch').not.toBeNull()
    expect(nextTag![2], 'the buttons are not in the other branch').toMatch(/v-else/)
    // And that is the element holding them.
    const branch = after.slice(0, after.indexOf('</div>'))
    expect(branch).toContain('answerPairing(row, true)')
    expect(branch).toContain('answerPairing(row, false)')
  })

  it('carries a confirmation token for both answers', () => {
    // Refusing is as much a decision as accepting: a remote agent must not be
    // able to do either on somebody's behalf.
    expect(MODAL).toContain("withConfirmation('p2p.pair.start'")
    expect(MODAL).toContain("withConfirmation('p2p.pair.confirm'")
  })

  it('tells the person what the other machine did', () => {
    // All three describe something they did not do and would otherwise never
    // learn — which is the complaint the two-sided exchange answers.
    expect(MODAL).toContain("n.kind === 'device-pairing'")
    expect(MODAL).toContain("settings.p2p.pair.' + n.pairing")
    // Remote commands are in the collapsed log now, one line per device.
    expect(MODAL).toContain('settings.p2p.pair.log-line')
  })

  for (const locale of ['en-US', 'zh-TW'] as const) {
    it(`names every pairing state in ${locale}`, () => {
      const pair = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.pair
      for (const key of [
        'title', 'start', 'asking', 'asked-by', 'waiting-response', 'waiting-remote',
        'compare', 'match', 'mismatch', 'paired', 'refused', 'revoked', 'log-line',
      ]) {
        expect(pair[key], key).toBeTruthy()
      }
    })
  }
})

describe('nothing is clickable before the link is up', () => {
  // Every one of these goes to the relay, and a link still dialling answers
  // with "configured but not connected right now, retry shortly" — a sentence
  // that arrives after the click, which makes the button look broken rather
  // than unavailable.
  const ACTIONS = [
    'signPolicyNow',
    'checkVerification',
    'resendVerification',
    'startPairing(device)',
    'answerPairing(row, true)',
    'answerPairing(row, false)',
    'unpairDevice(device.deviceId)',
    'blockPending(row)',
    'deferDevice(row)',
    'approveRequest(req)',
    'blockRequest(req)',
    'unblock(entry)',
  ]

  it('reads the state the panel is already polling', () => {
    expect(MODAL).toContain("const linkReady = computed(() => state.value === 'connected')")
  })

  for (const action of ACTIONS) {
    it(`disables ${action} while the link is not connected`, () => {
      // Find the button that fires it and check its own :disabled.
      const at = MODAL.indexOf(`@click="${action}"`)
      expect(at, action).toBeGreaterThan(-1)
      const button = MODAL.slice(MODAL.lastIndexOf('<button', at), at)
      expect(button, action).toMatch(/:disabled="[^"]*linkReady/)
    })
  }

  it('says which kind of "not now" it is', () => {
    // "Connecting" is worth waiting out; the others are not, and a disabled
    // button with no reason is the same puzzle one level down.
    expect(MODAL).toContain('settings.p2p.link-connecting')
    expect(MODAL).toContain('settings.p2p.link-not-connected')
    expect(MODAL).toContain('linkWaitReason')
  })
})

describe('the account footer', () => {
  it('puts the link state and the legal link on one row', () => {
    // Two stacked lines with an underlined link read as a web page footer
    // rather than as part of an app.
    expect(MODAL).toContain('class="foot-row"')
    expect(MODAL).toMatch(/\.legal-row \{[^}]*margin-left: auto/)
  })

  it('underlines the link only on hover', () => {
    expect(MODAL).toMatch(/\.legal-link \{[^}]*text-decoration: none/)
    expect(MODAL).toMatch(/\.legal-link:hover \{[^}]*text-decoration: underline/)
  })
})

describe('why the link is not usable', () => {
  it('shows the socket’s own words under the sentence explaining them', () => {
    // "Not connected" is the half the person can already see. Which of
    // "starting up", "the address is not answering" and "your token was
    // rejected" it is decides whether waiting is the right thing to do.
    expect(MODAL).toContain('linkErrorDetail')
    expect(MODAL).toContain('status.value?.lastError')
    expect(MODAL).toMatch(/linkWaitReason[\s\S]{0,200}linkErrorDetail/)
  })

  it('shows nothing extra once the link is up', () => {
    expect(MODAL).toMatch(/linkErrorDetail = computed\(\(\) => \(linkReady\.value \? ''/)
  })
})

describe('the two title-bar windows are loaded before they are asked for', () => {
  // Measured on this machine from the production build: SettingsModal is 507 KB
  // of JavaScript (~315 ms to parse) plus a 150 KB stylesheet, the account
  // window 67 KB (~25 ms) plus 18 KB. All of it used to be paid after the click
  // and before anything was drawn.
  it('uses one module specifier per window, shared by the prewarm and the component', () => {
    // The failure this guards is silent: a second arrow function with the same
    // path still works, until one of them is edited and the prewarm starts
    // warming something nobody opens.
    for (const name of ['SettingsModal', 'AccountModal']) {
      const uses = APP.match(new RegExp(`import\\('\\./components/${name}\\.vue'\\)`, 'g')) ?? []
      expect(uses).toHaveLength(1)
    }
    expect(APP).toContain('const SettingsModal = defineAsyncComponent(loadSettingsModal)')
    expect(APP).toContain('const AccountModal = defineAsyncComponent(loadAccountModal)')
    expect(APP).toMatch(/schedulePrewarm\([\s\S]{0,120}loadSettingsModal\(\)[\s\S]{0,40}loadAccountModal\(\)/)
  })

  it('warms at idle with a deadline, and cancels with the window', () => {
    // Eager loading would move half a megabyte of parsing into the seconds the
    // app is spawning panes; a fixed delay would postpone it past the early
    // clicks it exists for. The scheduling itself is tested in prewarm.test.ts;
    // what belongs here is that this caller asks for that form and disposes it.
    expect(APP).toMatch(/schedulePrewarm\([\s\S]{0,240}idleTimeoutMs: 4000/)
    expect(APP).toMatch(/schedulePrewarm\([\s\S]{0,280}fallbackDelayMs: 2500/)
    expect(APP).toMatch(/const cancel = schedulePrewarm\([\s\S]{0,900}onUnmounted\(cancel\)/)
    // And there is one mechanism, not two: the inline warm this replaced is gone.
    expect(APP).not.toContain('const warmSettings')
  })

  it('does not make the account window wait for its first read', () => {
    // Reported as a suspect and it is not one: the poll is started, not
    // awaited, and the template has a "reading" state for the gap.
    expect(MODAL).toContain('void refresh()')
    expect(MODAL).not.toMatch(/watch\(\(\) => props\.open[\s\S]{0,200}await refresh\(\)/)
    expect(MODAL).toMatch(/v-else-if="!network"[\s\S]{0,160}settings\.p2p\.network\.loading/)
  })
})

describe('a device that is not there', () => {
  const LIST = MODAL.slice(
    MODAL.indexOf('v-for="device in devices"'),
    MODAL.indexOf('settings.p2p.network.solo'),
  )

  it('says so where the trust state would be', () => {
    // "Waiting for you to vouch" beside a machine that cannot answer reads as
    // an invitation to do something that will not work. Which of the two
    // matters right now is whether it is there at all.
    // Two axes, not a v-else-if chain: presence answers "is it there", trust
    // answers "may it drive this machine". Chained, an offline row lost its
    // trust state entirely, so a paired machine and a stranger looked identical
    // the moment either went away. They are now on two lines rather than side
    // by side — the trust pill beside the name, presence under it — so what
    // this holds is that both are still drawn for an offline device.
    expect(LIST).toMatch(/v-if="!device\.isLocal && device\.trustState"/)
    expect(LIST).toContain('deviceMeta(device)')
    // Rendered proof that both survive an offline row, since a slice of source
    // cannot tell a drawn element from a dead branch: see
    // AccountModal.deviceRow.test.ts, "gives the name the whole line".
  })

  it('says when it was last seen, so offline does not read as gone', () => {
    // The roster is the server's memory of machines that have signed in. The
    // formatting is in a pure function with its own test; what belongs here is
    // that the row asks for it at all.
    expect(MODAL).toContain('device.lastSeenAt')
    expect(MODAL).toContain('relativeTime(at, Date.now())')
    // Never the raw value: it printed `Last seen 2026-09-05T02:39:47.539Z`.
    expect(MODAL).not.toContain("t('settings.p2p.network.last-seen', { when:")
  })

  it('offers no pairing button at all — hidden, not disabled', () => {
    // Pairing is four frames and two people; against a machine that is not
    // there it produces a card that waits five minutes and expires.
    const at = LIST.indexOf('startPairing(device)')
    expect(at).toBeGreaterThan(-1)
    const button = LIST.slice(LIST.lastIndexOf('<button', at), at)
    expect(button).toMatch(/v-if="device\.canTrust"/)
    // canTrust is false for an offline device — asserted on the backend — and
    // v-if removes the element rather than greying it out.
    expect(button).not.toMatch(/v-show/)
  })

  it('still offers the way out of a pairing', () => {
    // The one act that does not need the other machine, and a device you want
    // rid of is often one that is not there.
    expect(LIST).toMatch(/device\.trustState === 'trusted'"[\s\S]{0,220}unpairDevice/)
  })

  it('does not point an offline row at the pending card', () => {
    expect(LIST).toMatch(/!device\.isLocal && device\.online && hasPendingRow\(device\)/)
  })
})

describe('the UX pass over the connection surface', () => {
  it('uses only tokens the design system defines', () => {
    // Five of these were invented here and resolve to nothing, which is why the
    // "offline" pill had no border and the amber text was the browser default.
    for (const token of ['--warn-fg', '--ok-fg', '--bg-default', '--border)', '--accent)']) {
      expect(MODAL, token).not.toContain(`var(${token}`)
    }
  })

  it('says why a button is disabled rather than just greying it', () => {
    // A greyed button with no reason is the same puzzle one level down.
    expect(MODAL.match(/:title="linkWaitReason \|\| undefined"/g)?.length).toBeGreaterThanOrEqual(8)
  })

  it('makes the two text buttons look like buttons', () => {
    // A bare word with a transparent border, on a row of text, is a label.
    expect(MODAL).toMatch(/\.dev-review \{[\s\S]{0,200}border: 1px solid var\(--border-default\)/)
    // Destructive is quiet at rest and red on hover, so the row does not look
    // alarming for simply existing.
    expect(MODAL).toMatch(/\.dev-undo:hover \{[^}]*--danger-fg/)
  })

  it('shows the connection as the first thing in the account card', () => {
    // "Can this machine reach the others" is what people open this for; which
    // account it is, is the second question.
    const card = MODAL.slice(MODAL.indexOf('<template v-if="signedIn">'))
    const first = card.indexOf('settings.p2p.status-label')
    const email = card.indexOf('settings.p2p.account.email')
    expect(first).toBeGreaterThan(-1)
    expect(first).toBeLessThan(email)
  })

  it('says when it will try again, not just that it failed', () => {
    expect(MODAL).toContain('linkRetryIn')
    expect(MODAL).toContain('settings.p2p.link-retry-in')
  })

  it('pills are capsules and no longer struck through', () => {
    expect(MODAL).toMatch(/\.dev-tag \{[\s\S]{0,200}--radius-pill/)
    expect(MODAL).not.toContain('text-decoration: line-through')
  })

  it('names the trust state with the same word as the button', () => {
    for (const locale of LOCALES) {
      const trust = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.trust
      // "Paired" / "Not paired", matching "Pair with this device…" — the old
      // "waiting for you to vouch" named an act no button performs.
      expect(trust['state-trusted']).not.toMatch(/vouch|信任/)
      expect(trust['state-pending']).not.toMatch(/vouch|確認/)
    }
  })
})

describe('the identity notices inside the account card', () => {
  it('carries the heading the key was written for', () => {
    // A run of unlabelled notices under the account details reads as more
    // account details. The key existed and stopped being rendered when this
    // block moved into the card.
    expect(MODAL).toContain("settings.p2p.trust.notices-title")
    expect(MODAL).toMatch(/class="ident"[\s\S]{0,400}ident-label/)
  })

  it('separates itself with the muted divider the rest of the card uses', () => {
    expect(MODAL).toMatch(/\.ident \{[^}]*border-top: 1px solid var\(--border-muted\)/)
  })
})

describe('the second UX pass', () => {
  it('reads nothing as "not signed in" before the first answer arrives', () => {
    // "Unknown" is not "signed out", and rendering it that way is a claim —
    // the wrong one for everybody who is signed in.
    expect(MODAL).toContain('const loaded = computed(() => status.value !== null)')
    expect(MODAL).toContain('settings.p2p.loading')
  })

  it('translates the one string in the window that was hardcoded', () => {
    expect(MODAL).not.toContain('title="Close (ESC)"')
    expect(MODAL).toContain("settings.p2p.close")
  })

  it('tells a refusal in force apart from something that happened', () => {
    // "This device changed its key" and "we paired" are the same shape in the
    // data; nothing on the row said which was blocking traffic right now.
    expect(MODAL).toContain('const alertKinds = [')
    expect(MODAL).toContain("'req-alert': alertKinds.includes(n.kind)")
    expect(MODAL).toMatch(/\.req-alert \{[^}]*--danger-fg/)
    expect(MODAL).toContain('settings.p2p.trust.key-changed-refusing')
  })

  it('collapses the routine log instead of letting it push everything off', () => {
    // One line per delivery is the right record and the wrong list.
    expect(MODAL).toContain('const logNotices = computed')
    // The list the card renders must be the filtered one, or the collapse is a
    // second copy rather than a move.
    expect(MODAL).toContain('v-for="n in standingNotices"')
    expect(MODAL).toMatch(
      /const standingNotices = computed\([\s\S]{0,140}!LOG_KINDS\.includes\(n\.kind\)/,
    )
    expect(MODAL).toMatch(/<details[^>]*class="cmd-log"/)
    expect(MODAL).toContain('settings.p2p.pair.commands-summary')
  })

  it('labels the two values on a pairing card', () => {
    // Six digits and sixteen hex characters, one above the other, are two
    // things a person is asked to do different things with.
    expect(MODAL).toContain('settings.p2p.pair.code-label')
    expect(MODAL).toContain('settings.p2p.pair.fingerprint-label')
  })

  it('says where a button-less pairing stage is', () => {
    expect(MODAL).toContain('settings.p2p.pair.step-sent')
    expect(MODAL).toContain('settings.p2p.pair.step-you-confirmed')
    expect(MODAL).toContain('settings.p2p.pair.auto-updates')
  })

  it('points at the rules from the list the rules are about', () => {
    // Being paired is identity, not permission. The pill read as "may drive
    // this machine", which is one window away from true.
    expect(MODAL).toContain('settings.p2p.network.who-can-command')
    expect(MODAL).toMatch(/net-rules[\s\S]{0,120}open-rules/)
  })

  it('says each fact once', () => {
    // serverUrl and the device id were on two cards each, which made the
    // second one look like another account panel.
    // Counting where each value is *rendered*, not every mention: the device
    // id is also read in a v-if that decides whether to render it at all.
    expect(MODAL.match(/\{\{ status\??\.serverUrl \}\}/g)?.length).toBe(1)
    expect(MODAL.match(/\{\{ status\??\.deviceId \}\}/g)?.length).toBe(1)
  })

  it('answers "what now" beside the unverified pill', () => {
    expect(MODAL).toContain('settings.p2p.account.not-verified-next')
    expect(MODAL).toContain('!verified && signedIn && !verifyPending')
  })

  it('offers the way in when this is the only machine', () => {
    // "Nobody else is here" is not an answer to "how do I get somebody here".
    expect(MODAL).toContain('settings.p2p.first-pair-title')
    for (const step of ['first-pair-1', 'first-pair-2', 'first-pair-3']) {
      expect(MODAL).toContain(`settings.p2p.${step}`)
    }
  })

  it('says what signing in buys when only a token is stored', () => {
    expect(MODAL).toMatch(/v-if="tokenOnly"[\s\S]{0,120}token-only-note/)
  })

  it('puts the account card below the things that are waiting', () => {
    // It answers "which account is this", which nobody opens this window to
    // find out while a machine is asking to pair.
    const pairing = MODAL.indexOf('v-if="signedIn && pairings.length"')
    const card = MODAL.indexOf('<div class="card">')
    const net = MODAL.indexOf('settings.p2p.network.title')
    expect(pairing).toBeLessThan(card)
    expect(card).toBeLessThan(net)
  })
})

describe('the UX re-audit fixes', () => {
  it('classifies the socket failure here, where the language is known', () => {
    // Written in the backend it was hardcoded English, so a Chinese window
    // explained an English error in English.
    //
    // *Which* error maps to which sentence is asserted in
    // lib/__tests__/linkStatus.test.ts, by calling the function — this file can
    // only see strings, and a classifier wired to the wrong branch keeps every
    // string it had. All this checks is that the component asks that function.
    expect(MODAL).toContain("import { linkErrorKey } from '../lib/linkStatus'")
    expect(MODAL).toMatch(/const key = linkErrorKey\(raw\)/)
    expect(MODAL).toMatch(/key \? t\(`settings\.p2p\.\$\{key\}`\) : raw/)
    // The original is still reachable, because a translated sentence loses the
    // one detail that identifies the failure.
    expect(MODAL).toMatch(/linkErrorPlain[\s\S]{0,120}:title="linkErrorDetail"/)
  })

  it('keeps a heading over the waiting region whichever kind is there', () => {
    // The first merge hid the second heading with CSS, which left the region
    // untitled whenever there were only access requests — the common case.
    expect(MODAL).not.toContain('visually-continues')
    expect(MODAL).toContain('v-if="signedIn && needsYouCount"')
    expect(MODAL).toContain('const needsYouCount = computed')
    // One section, two lists.
    expect(MODAL).toMatch(/needsYouCount \}\)[\s\S]{0,400}v-if="trustPending\.length"/)
    expect(MODAL).toMatch(/v-if="accessRequests\.length" class="card net-card"/)
  })

  it('groups every fingerprint in fours', () => {
    // Sixteen unbroken hex characters is the comparison people give up on, and
    // letter-spacing looks like grouping without being it.
    expect(MODAL).toContain('function grouped(')
    expect(MODAL).toMatch(/raw\.match\(\/\.\{1,4\}\/g\)\?\.join\(' '\)/)
    expect(MODAL).not.toMatch(/\{\{ row\.fingerprint \}\}/)
    expect(MODAL).not.toMatch(/\{\{ status\.selfFingerprint \}\}/)
  })

  it('renders the third pairing stage it invented a key for', () => {
    expect(MODAL).toContain('settings.p2p.pair.step-waiting-them')
  })

  it('says why a button is off, even when it also has an action tooltip', () => {
    for (const key of ['pending-later-title', 'unpair-title']) {
      expect(MODAL, key).toContain(`linkWaitReason || t('settings.p2p.trust.${key}')`)
    }
  })

  it('calls removing a token something other than signing out', () => {
    expect(MODAL).toContain('settings.p2p.account.remove-token')
    expect(MODAL).toMatch(/tokenOnly \? 'settings\.p2p\.account\.remove-token'/)
  })

  it('has no undefined token left, including the sixth', () => {
    for (const token of ['--fg-muted', '--warn-fg', '--ok-fg', '--bg-default', '--border)', '--accent)']) {
      expect(MODAL, token).not.toContain(`var(${token}`)
    }
  })

  it('defines each rule once', () => {
    // The later definition won silently, so reading the first told you the
    // opposite of what rendered.
    for (const rule of ['.btn.small', '.dot.warn', '.acct-foot']) {
      const hits = MODAL.split('\n').filter((l) => l.trimStart().startsWith(`${rule} {`))
      expect(hits.length, rule).toBe(1)
    }
  })

  it('gives the footer both links and moves the link detail to the link card', () => {
    const foot = MODAL.slice(MODAL.indexOf('class="acct-foot"'))
    expect(foot).toContain('settings.p2p.legal-privacy')
    expect(foot).toContain('settings.p2p.legal-boundaries')
    expect(foot).not.toContain('class="detail"')
    expect(MODAL).toMatch(/link\.paused-body[\s\S]{0,200}status\?\.detail/)
  })

  it('leaves no square pill', () => {
    expect(MODAL).not.toMatch(/border-radius: var\(--radius-xs\)/)
  })

  it('folds the receipts, not just one kind of them', () => {
    // A remote command, a completed pairing and a first sighting are all
    // receipts; twenty of them push the four kinds that are refusals off.
    expect(MODAL).toMatch(/LOG_KINDS = \['remote-command', 'device-pairing', 'device-first-seen'\]/)
    expect(MODAL).toContain('const logByDevice = computed')
    expect(MODAL).toContain('settings.p2p.pair.log-line')
  })
})

describe('the empty-policy card that was removed', () => {
  it('does not tell somebody their own machines cannot reach them', () => {
    // It said: "no rules yet on this device — nothing from your other machines
    // can reach this one until you write at least one rule." That is false, and
    // false for exactly the audience it named.
    //
    // A machine this device has paired with lands in RING_SELF, and RING_SELF
    // skips the policy check outright. One it has not paired with is refused
    // earlier, by _authenticate_sender, as NOT_PAIRED. Neither path reaches the
    // state the card described — the policy governs devices belonging to other
    // people's accounts, which is not what the card was about.
    //
    // This is here so the next audit reads "a claim that was not true" rather
    // than "a missing prompt". Adding it back needs different words.
    expect(MODAL).not.toContain('settings.p2p.network.no-rules')
    for (const locale of LOCALES) {
      const network = (i18n.global.getLocaleMessage(locale) as Record<string, any>)
        .settings.p2p.network as Record<string, string>
      expect(network['no-rules']).toBeUndefined()
      expect(network['no-rules-body']).toBeUndefined()
    }
    // The backend fact stays — it is true, it simply has no honest use here yet.
    expect(MODAL).toContain('policyEmpty?: boolean')
  })
})
