// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

// P-2: prompts sync across devices by id, and the slug alone ('skill',
// 'skill-2' for any non-ASCII name) collides when two devices each create one.
// A new or duplicated prompt gets a random suffix; an existing id never moves
// (renaming it would sync as a delete plus an add).

// vi.hoisted: the mock factory is hoisted above this body, and the i18n
// instance reads settingsGet while the import graph is still evaluating.
const store = vi.hoisted(() => ({}) as Record<string, unknown>)
vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (key in store ? store[key] : fallback),
  settingsSet: (key: string, value: unknown) => {
    store[key] = value
  },
  onSettingsChanged: () => {},
}))
// promptSkills seeds its builtin name through the shared i18n instance, so
// this stub has to satisfy createI18n as well as useI18n.
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: () => ({
    install() {},
    global: { t: (key: string) => key, locale: { value: 'en-US' } },
  }),
}))

import PromptSkillsPane from '../PromptSkillsPane.vue'
import { PROMPT_SKILLS_SETTING_KEY, type PromptSkill } from '../../lib/promptSkills'
import { reloadPromptSkills } from '../../composables/usePromptSkills'

function seed(): void {
  const skill: PromptSkill = {
    id: 'a',
    name: 'skill a',
    icon: 'advance',
    description: '',
    prompt: 'do the thing',
    resumePrompt: '',
    maxTurns: 0,
    category: 'dev',
    enabled: true,
    isDefault: true,
  }
  store[PROMPT_SKILLS_SETTING_KEY] = [skill]
  reloadPromptSkills()
}

function storedIds(): string[] {
  return (store[PROMPT_SKILLS_SETTING_KEY] as PromptSkill[]).map((s) => s.id)
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key]
})

describe('Settings → Prompts – ids of new prompts', () => {
  it('gives a new prompt a random suffix and leaves existing ids alone', async () => {
    seed()
    const w = mount(PromptSkillsPane)
    await w.get('.prompts-toolbar button.primary').trigger('click')

    const ids = storedIds()
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe('a')
    expect(ids[1]).toMatch(/^settings-prompts-new-name-[0-9a-f]{6}$/)
  })

  it('gives a duplicate a random suffix', async () => {
    seed()
    const w = mount(PromptSkillsPane)
    await w.find('.prompt-card').trigger('click')
    const dup = w.findAll('.drawer-actions.secondary button').find((b) => b.text() === 'settings.prompts.duplicate')
    await dup!.trigger('click')

    const ids = storedIds()
    expect(ids[0]).toBe('a')
    expect(ids[1]).toMatch(/^a-copy-[0-9a-f]{6}$/)
  })
})
