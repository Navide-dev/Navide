// @vitest-environment happy-dom
// The status bar's notifications item (bell + popover). Source-scanned like the
// other App.*.test.ts files: App.vue cannot be mounted. Pins that the item
// opens the popover like its neighbours, that the popover writes through the
// shared notification prefs, and that Settings → Notifications reads the same
// shared state, so the two surfaces never disagree.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = read('src/renderer/src/App.vue')
const settingsSource = read('src/renderer/src/components/SettingsModal.vue')
const popoverSource = read('src/renderer/src/composables/useStatusBarPopover.ts')

function sliceBetween(src: string, start: string, end: string): string {
  const at = src.indexOf(start)
  return at === -1 ? '' : src.slice(at, src.indexOf(end, at))
}

describe('status bar — notifications item', () => {
  const originalLocale = i18n.global.locale.value
  afterEach(() => {
    i18n.global.locale.value = originalLocale
  })

  const item = sliceBetween(appSource, 'class="sb-item sb-clickable sb-notify"', '</span>\n        <span')
  const panel = sliceBetween(appSource, '<!-- Notifications popover -->', '/>')

  it('sits in the status bar and opens its popover by click or Enter', () => {
    expect(item).not.toBe('')
    expect(item).toContain(`@click="togglePopover('notify')"`)
    expect(item).toContain(`@keydown.enter="togglePopover('notify')"`)
    expect(item).toContain('role="button"')
    expect(popoverSource).toMatch(/StatusBarPopoverId = [^\n]*'notify'/)
  })

  it('the popover writes through the shared prefs and opens the Settings page', () => {
    expect(panel).toContain(`v-if="openPopover === 'notify'"`)
    expect(panel).toContain('@update:system-notify="setSystemNotifyOn"')
    expect(panel).toContain('@update:notify-sound="setNotifySoundOn"')
    expect(panel).toContain(`openSettingsAt('notifications')`)
  })

  it('Settings → Notifications shows the shared state and still saves through the old setters', () => {
    expect(settingsSource).toMatch(/const systemNotifyEnabledModel = systemNotifyOn\b/)
    expect(settingsSource).toMatch(/const notifySoundEnabledModel = notifySoundOn\b/)
    expect(settingsSource).toContain('setSystemNotifyEnabled(systemNotifyEnabledModel.value)')
    expect(settingsSource).toContain('setNotifySoundEnabled(notifySoundEnabledModel.value)')
  })

  it('every string it uses is translated in all three locales', () => {
    const keys = ['notifyBar.tooltip-on', 'notifyBar.tooltip-off', 'notifyBar.sound-off', 'notifyBar.open-settings', 'notifyBar.close']
    const title = sliceBetween(appSource, 'const notifyBarTitle = computed(', '\n)\n')
    expect(item).toContain(':title="notifyBarTitle"')
    for (const key of keys) expect(title + read('src/renderer/src/components/NotifyPanel.vue')).toContain(key)
    for (const key of keys) {
      i18n.global.locale.value = 'en-US'
      const en = i18n.global.t(key)
      expect(en, key).not.toBe(key)
      for (const locale of ['zh-TW', 'ja-JP'] as const) {
        i18n.global.locale.value = locale
        expect(i18n.global.t(key), `${locale} ${key}`).not.toBe(en)
      }
    }
  })
})
