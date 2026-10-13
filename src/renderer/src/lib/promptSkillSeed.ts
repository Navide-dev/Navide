// The builtin prompt skill a fresh install starts with. The backend reads the
// same file (backend/agent_team_backend/prompt_skills.py) so chat channels can
// offer it before the user ever saves the Prompts page — one source, no copy.
import seed from '../../../../backend/agent_team_backend/prompt_skill_seed.json'

type SeedLanguage = keyof typeof seed.name

export const PROMPT_SKILL_SEED = seed

/** The seed's name/description in `locale`, falling back like the i18n setup does. */
export function seedText(field: 'name' | 'description', locale: string): string {
  const texts = seed[field]
  return locale in texts ? texts[locale as SeedLanguage] : texts['zh-TW']
}
