import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')
const locale = (code: string): Record<string, any> =>
  JSON.parse(source(`packages/plugin-ui/src/foundation/i18n/locales/${code}.json`))

describe('first-run surfaces', () => {
  it('gives the wizard the UI font: it renders beside .app, not inside it', () => {
    const page = source('src/renderer/src/components/OnboardingWizard.vue').match(/\.ob-page \{[^}]*\}/)?.[0]
    expect(page).toContain('font-family: var(--font-ui)')
  })

  it('opens an agent from the empty stage button, not only the sidebar tab', () => {
    const app = source('src/renderer/src/App.vue')
    const click = app.match(/class="empty-primary" @click="([^"]*)"/)?.[1]
    expect(click).toContain('.spawn()')
    expect(source('src/renderer/src/components/ControlPane.vue')).toMatch(/defineExpose\(\{[^}]*\bspawn\b/)
  })

  it('does not tell someone without Ollama to run ollama serve', () => {
    const modal = source('src/renderer/src/components/SettingsModal.vue')
    const row = modal.match(/<div v-if="!ollamaNotInstalled" class="az-status-row">[\s\S]*?<\/div>/)?.[0]
    expect(row).toContain('ollama serve')
    // The llama.cpp rows report their own binary: Ollama's absence is not theirs.
    expect(modal.match(/v-if="!ollamaNotInstalled"/g)).toHaveLength(1)
  })

  it('finishes the model hint in English instead of trailing off', () => {
    expect(locale('en-US').hint['download-model']).toMatch(/\.$/)
    expect(locale('en-US').hint['download-model']).not.toMatch(/\.\.\.$/)
  })

  it('stops calling the wizard an environment check', () => {
    const appearance = locale('en-US').settings.appearance
    expect(appearance['rerun-env-check']).not.toContain('Environment')
    expect(appearance['environment-hint']).not.toContain('Homebrew')
    expect(appearance['environment-hint']).not.toContain('Ollama')
  })

  it('describes Automation as what it is used for now', () => {
    const automation = locale('en-US').onboard.perm.automation
    expect(automation.desc).not.toContain('must be installed in a real terminal')
    expect(automation.why).not.toContain('install command')
  })
})
