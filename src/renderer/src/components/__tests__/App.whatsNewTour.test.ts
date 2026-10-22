// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. The logic behind
// the wiring is unit-tested in lib/__tests__/whatsNew.test.ts, tours.test.ts and
// components/__tests__/GuidedTour.test.ts / WhatsNewModal.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('Help → What’s New… (menu action show-whats-new)', () => {
  it('routes the menu action to the on-demand opener', () => {
    const menu = functionBody('onMenuAction')
    expect(menu).toMatch(/action === 'show-whats-new'\) \{\s+showWhatsNewOnDemand\(\)/)
  })

  it('picks the entry with the dev flag, so a dev build shows the next release', () => {
    expect(functionBody('showWhatsNewOnDemand')).toContain(
      'pickWhatsNewOnDemand(window.agentTeam?.version ?? \'\', import.meta.env.DEV)',
    )
  })

  it('says so with a toast when there are no release notes to show', () => {
    const body = functionBody('showWhatsNewOnDemand')
    const empty = body.slice(body.indexOf('if (!entry)'), body.indexOf('whatsNewOnDemand.value = true'))
    expect(empty).toContain("notifyRestore.toast(i18n.global.t('announce.whats-new-none'), { type: 'info' })")
    expect(empty).toContain('return')
  })

  it('translates the no-release-notes message in every shipped locale', () => {
    const localesDir = resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales')
    const message = (locale: string): unknown =>
      JSON.parse(readFileSync(resolve(localesDir, `${locale}.json`), 'utf8')).announce?.['whats-new-none']
    const locales = readdirSync(localesDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    expect(locales.sort()).toEqual(['de-DE', 'en-US', 'es-ES', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW'])
    expect(message('en-US')).toBe('No release notes are available for this version.')
    for (const locale of locales.filter((name) => name !== 'en-US')) {
      expect(typeof message(locale)).toBe('string')
      expect(message(locale)).not.toBe(message('en-US'))
    }
  })

  it('records nothing when an on-demand showing is closed', () => {
    const body = functionBody('closeWhatsNew')
    const onDemand = body.slice(0, body.indexOf('dismissWhatsNew()'))
    expect(onDemand).toContain('whatsNewOnDemand.value')
    expect(onDemand).not.toContain('settingsSet')
    expect(onDemand).not.toContain('markRead')
    expect(onDemand).toContain('return')
  })

  it('leaves the once-per-version path to dismissWhatsNew, unchanged', () => {
    const body = functionBody('dismissWhatsNew')
    expect(body).toContain("settingsSet('agentTeam.whatsNew.lastSeenVersion', current)")
    expect(body).not.toContain('whatsNewOnDemand')
    // The startup evaluation still decides by pickWhatsNew, not the on-demand pick.
    expect(functionBody('evaluateWhatsNew')).toContain('pickWhatsNew(current, seen)')
    expect(functionBody('evaluateWhatsNew')).not.toContain('OnDemand')
  })
})

describe('the tour question and the tour', () => {
  it('mounts the modal with the tour answer and the replay flag', () => {
    expect(appSource).toContain(':tour-done="whatsNewTourDone"')
    expect(appSource).toContain('@close="closeWhatsNew"')
    expect(appSource).toContain('@tour="startWhatsNewTour"')
  })

  it('closes the modal (recording it seen) before starting that version’s tour', () => {
    const body = functionBody('startWhatsNewTour')
    expect(body.indexOf('whatsNewEntry.value?.version')).toBeLessThan(body.indexOf('closeWhatsNew()'))
    expect(body.indexOf('closeWhatsNew()')).toBeLessThan(body.indexOf('releaseTour.start(version)'))
  })

  it('starts the same tour from the announcement centre, marking the release read', () => {
    const body = functionBody('startAnnouncementTour')
    expect(body).toContain('closePopover()')
    expect(body).toContain('announcements.markRead(releaseAnnouncementId(version))')
    expect(body).toContain('releaseTour.start(version)')
    expect(appSource).toMatch(/<AnnouncementsPanel[\s\S]*?@tour="startAnnouncementTour"[\s\S]*?\/>/)
  })

  it('has one tour state and one done record, shared by every entry point', () => {
    expect(appSource).toContain('const releaseTour = useReleaseTour()')
    expect(functionBody('endTour')).toContain('releaseTour.end(completed)')
    expect(appSource).toContain('releaseTour.isDone(entry.version)')
    // No second, App-local tour registry or done key.
    expect(appSource).not.toContain('tourDoneKey(')
    expect(appSource).not.toContain('TOURS[')
  })

  it('only opens or closes Settings to prepare a step', () => {
    const body = functionBody('runTourPrepare')
    expect(body).toMatch(/if \(prepare\.kind === 'settings'\) \{[\s\S]*?openSettingsAt\(prepare\.tab\)[\s\S]*?\} else \{[\s\S]*?showSettings\.value = false/)
    expect(body).not.toContain('settingsSet')
  })

  it('closes Settings the tour opened when the tour ends before its close-settings step', () => {
    const prepare = functionBody('runTourPrepare')
    const opening = prepare.slice(0, prepare.indexOf('} else {'))
    const closing = prepare.slice(prepare.indexOf('} else {'))
    // Only a Settings the tour itself opened is recorded — one the user had
    // open before the tour stays open.
    expect(opening).toContain('if (!showSettings.value) tourOpenedSettings = true')
    expect(opening.indexOf('tourOpenedSettings = true')).toBeLessThan(opening.indexOf('openSettingsAt(prepare.tab)'))
    // The close-settings step clears the record.
    expect(closing).toContain('tourOpenedSettings = false')

    const end = functionBody('endTour')
    expect(end).toContain('if (tourOpenedSettings) showSettings.value = false')
    expect(end).toContain('tourOpenedSettings = false')
    expect(end.indexOf('tourOpenedSettings = false')).toBeLessThan(end.indexOf('releaseTour.end(completed)'))
  })

  it('mounts GuidedTour with the steps, the prepare hook and the end handler', () => {
    expect(appSource).toMatch(
      /<GuidedTour\s+v-if="activeTourSteps"\s+:steps="activeTourSteps"\s+:run-prepare="runTourPrepare"\s+@close="endTour"/,
    )
  })

  it('counts the tour as a modal, and lets Esc leave the tour before anything under it', () => {
    expect(functionBody('mainModalOpen')).toContain('!!activeTourVersion.value')
    expect(appSource).toContain(
      'watch([reconnectPickerOpen, cliInstallRequest, whatsNewEntry, activeTourVersion], () => setContext(\'modalOpen\', mainModalOpen()))',
    )
    const start = appSource.indexOf("registerCommand('workbench.action.closeModal'")
    const close = appSource.slice(start, appSource.indexOf('\n})', start))
    expect(close.indexOf('activeTourVersion.value')).toBeGreaterThan(-1)
    expect(close.indexOf('activeTourVersion.value')).toBeLessThan(close.indexOf('showSettings.value'))
  })

  it('lets Settings be opened at the Voice Input tab', () => {
    expect(appSource).toMatch(/const settingsInitialTab = ref<[^>]*'voice'[^>]*>/)
  })
})
