// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

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

// B4: normalize drops a skill whose prompt is empty, so clearing the prompt in
// the drawer used to delete the skill silently — and sync spread the deletion.
// Clearing now keeps the stored text and says why; deleting takes a confirm.
// (setValue fires input and change, like a real edit followed by blur.)

function skill(id: string, prompt: string, isDefault = false): PromptSkill {
  return {
    id,
    name: `skill ${id}`,
    icon: 'advance',
    description: '',
    prompt,
    resumePrompt: '',
    maxTurns: 0,
    category: 'dev',
    enabled: true,
    isDefault,
  }
}

function seed(): void {
  store[PROMPT_SKILLS_SETTING_KEY] = [skill('a', 'do the thing', true), skill('b', 'other thing')]
  reloadPromptSkills()
}

function stored(): PromptSkill[] {
  return store[PROMPT_SKILLS_SETTING_KEY] as PromptSkill[]
}

async function openSkill(w: ReturnType<typeof mount>, id: string): Promise<void> {
  await w.get(`.prompt-card[data-skill-id="${id}"]`).trigger('click')
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key]
})

describe('Settings → Prompts – no silent delete', () => {
  it('keeps a skill whose prompt is cleared and says why', async () => {
    seed()
    const w = mount(PromptSkillsPane)
    await openSkill(w, 'b')
    const area = w.get('textarea.prompt-body')
    await area.setValue('   ')

    expect(stored().map((s) => s.id)).toEqual(['a', 'b'])
    expect(stored()[1].prompt).toBe('other thing')
    expect((area.element as HTMLTextAreaElement).value).toBe('other thing')
    expect(w.get('.drawer-error').text()).toBe('settings.prompts.prompt-empty')

    // A real edit clears the message.
    await area.setValue('new text')
    expect(stored()[1].prompt).toBe('new text')
    expect(w.find('.drawer-error').exists()).toBe(false)
  })

  it('keeps the default skill the default when its prompt is cleared', async () => {
    seed()
    const w = mount(PromptSkillsPane)
    await openSkill(w, 'a')
    await w.get('textarea.prompt-body').setValue('')

    expect(stored().find((s) => s.isDefault)?.id).toBe('a')
    expect(stored()[0].prompt).toBe('do the thing')
  })

  it('asks before deleting, and cancel keeps the skill', async () => {
    seed()
    const w = mount(PromptSkillsPane)
    await openSkill(w, 'b')
    await w.get('[data-action="delete"]').trigger('click')

    expect(stored().map((s) => s.id)).toEqual(['a', 'b'])
    expect(w.get('.drawer-confirm').text()).toContain('settings.prompts.delete-confirm')

    await w.get('[data-action="cancel-delete"]').trigger('click')
    expect(w.find('.drawer-confirm').exists()).toBe(false)
    expect(stored().map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('deletes once confirmed', async () => {
    seed()
    const w = mount(PromptSkillsPane)
    await openSkill(w, 'b')
    await w.get('[data-action="delete"]').trigger('click')
    await w.get('[data-action="confirm-delete"]').trigger('click')

    expect(stored().map((s) => s.id)).toEqual(['a'])
    expect(w.find('.prompts-drawer').exists()).toBe(false)
  })

  it('drops a pending confirm when another skill is opened', async () => {
    seed()
    const w = mount(PromptSkillsPane)
    await openSkill(w, 'b')
    await w.get('[data-action="delete"]').trigger('click')
    await openSkill(w, 'a')

    expect(w.find('.drawer-confirm').exists()).toBe(false)
  })
})
