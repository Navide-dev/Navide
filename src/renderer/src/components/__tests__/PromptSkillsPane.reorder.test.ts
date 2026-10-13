// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

// Settings → Prompts drag reordering. The ∞ picker casts by array position
// (digit keys too), so the saved array order IS the picker order — except the
// default skill, which the picker always pins first. The pane mirrors that pin.

const store = vi.hoisted(() => ({}) as Record<string, unknown>)
vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (key in store ? store[key] : fallback),
  settingsSet: (key: string, value: unknown) => {
    store[key] = value
  },
  onSettingsChanged: () => {},
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: () => ({
    install() {},
    global: { t: (key: string) => key, locale: { value: 'en-US' } },
  }),
}))

import PromptSkillsPane from '../PromptSkillsPane.vue'
import { PROMPT_SKILLS_SETTING_KEY, castablePromptSkills, type PromptSkill } from '../../lib/promptSkills'
import { reloadPromptSkills } from '../../composables/usePromptSkills'

function skill(id: string, isDefault = false, category = 'dev'): PromptSkill {
  return {
    id,
    name: `skill ${id}`,
    icon: 'edit',
    description: '',
    prompt: `prompt ${id}`,
    resumePrompt: '',
    maxTurns: 0,
    category,
    enabled: true,
    isDefault,
  }
}

function storedIds(): string[] {
  return (store[PROMPT_SKILLS_SETTING_KEY] as PromptSkill[]).map((s) => s.id)
}

function cardIds(w: VueWrapper): string[] {
  return w.findAll('.prompt-card').map((c) => c.attributes('data-skill-id')!)
}

async function drag(w: VueWrapper, from: string, to: string): Promise<void> {
  await w.get(`.prompt-card[data-skill-id="${from}"]`).trigger('dragstart')
  await w.get(`.prompt-card[data-skill-id="${to}"]`).trigger('dragover')
  await w.get(`.prompt-card[data-skill-id="${to}"]`).trigger('drop')
}

describe('PromptSkillsPane drag reordering', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    store[PROMPT_SKILLS_SETTING_KEY] = [skill('b'), skill('main', true), skill('c', false, 'ops'), skill('d')]
    reloadPromptSkills()
  })

  it('lists cards in picker order: default pinned first, then saved order', () => {
    const w = mount(PromptSkillsPane)
    expect(cardIds(w)).toEqual(['main', 'b', 'c', 'd'])
  })

  it('persists a drop so the picker order follows it', async () => {
    const w = mount(PromptSkillsPane)
    await drag(w, 'd', 'b')
    expect(cardIds(w)).toEqual(['main', 'd', 'b', 'c'])
    const saved = store[PROMPT_SKILLS_SETTING_KEY] as PromptSkill[]
    expect(castablePromptSkills(saved).map((s) => s.id)).toEqual(['main', 'd', 'b', 'c'])
  })

  it('keeps the default card pinned: not draggable and not a drop target', async () => {
    const w = mount(PromptSkillsPane)
    expect(w.get('.prompt-card[data-skill-id="main"]').attributes('draggable')).toBe('false')
    expect(w.get('.prompt-card[data-skill-id="b"]').attributes('draggable')).toBe('true')
    const before = storedIds()
    await drag(w, 'c', 'main')
    expect(storedIds()).toEqual(before)
  })

  it('disables reordering while a category filter or search is active', async () => {
    const w = mount(PromptSkillsPane)
    const before = storedIds()
    await w.get('.prompts-search').setValue('skill')
    expect(w.get('.prompt-card[data-skill-id="b"]').attributes('draggable')).toBe('false')
    await drag(w, 'd', 'b')
    expect(storedIds()).toEqual(before)
  })
})
