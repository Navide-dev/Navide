import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { plansBackendStoppedNotice } from '../plansBackendStoppedNotice'

const root = join(__dirname, '../../../../..')

describe('plansBackendStoppedNotice', () => {
  afterEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  it('names only the folder and says how to bring the backend back, in each language', () => {
    const cases = [
      ['en-US', 'The Plans backend for \u201cproject-a\u201d stopped after repeated failures. Open Plans for this workspace to restart it, or restart Navide.'],
      ['zh-TW', '\u300cproject-a\u300d\u7684 Plans \u5f8c\u7aef\u591a\u6b21\u5931\u6557\u5f8c\u5df2\u505c\u6b62\u3002\u958b\u555f\u6b64\u5de5\u4f5c\u5340\u7684 Plans \u5373\u53ef\u91cd\u65b0\u555f\u52d5\u5176\u5f8c\u7aef\uff0c\u6216\u91cd\u65b0\u555f\u52d5 Navide\u3002'],
      ['ja-JP', '\u300cproject-a\u300d\u306e Plans \u30d0\u30c3\u30af\u30a8\u30f3\u30c9\u306f\u5931\u6557\u304c\u7e70\u308a\u8fd4\u3055\u308c\u305f\u305f\u3081\u505c\u6b62\u3057\u307e\u3057\u305f\u3002\u3053\u306e\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u3067 Plans \u3092\u958b\u304f\u3068\u518d\u8d77\u52d5\u3067\u304d\u307e\u3059\u3002\u307e\u305f\u306f Navide \u3092\u518d\u8d77\u52d5\u3057\u3066\u304f\u3060\u3055\u3044\u3002'],
    ] as const
    for (const [locale, text] of cases) {
      i18n.global.locale.value = locale
      expect(plansBackendStoppedNotice('/Users/someone/work/project-a')).toBe(text)
    }
  })

  it('keeps the rest of a Windows path out of the text', () => {
    const text = plansBackendStoppedNotice('C:\\Users\\someone\\project-b\\')
    expect(text).toContain('\u201cproject-b\u201d')
    expect(text).not.toContain('someone')
  })

  it('is shown from the Host report the main window receives', () => {
    const app = readFileSync(join(root, 'src/renderer/src/App.vue'), 'utf8')
    const preload = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
    const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
    const relay = readFileSync(join(root, 'src/main/plansBackendStoppedRelay.ts'), 'utf8')
    // main hands the report to the relay, which sends it to a loaded main window.
    expect(main).toContain('plansBackendStoppedRelay.notify(workspacePath)')
    expect(relay).toContain("webContents.send('plans:backendStopped', { workspacePath })")
    expect(preload).toContain("ipcRenderer.on('plans:backendStopped', listener)")
    expect(app).toMatch(
      /onPlansBackendStopped\?\.\(\(\{ workspacePath \}\) => \{\s*notifyRestore\.toast\(plansBackendStoppedNotice\(workspacePath\), \{ type: 'error' \}\)/,
    )
  })
})
