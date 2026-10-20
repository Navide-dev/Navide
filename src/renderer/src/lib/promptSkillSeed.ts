// The builtin prompt skill a fresh install starts with. The backend reads the
// same file (backend/agent_team_backend/prompt_skills.py) so chat channels can
// offer it before the user ever saves the Prompts page — one source, no copy.
import { isUiLocale } from '@navide/plugin-ui/foundation'
import seed from '../../../../backend/agent_team_backend/prompt_skill_seed.json'

type SeedLanguage = keyof typeof seed.name

export const PROMPT_SKILL_SEED = seed

/** The seed's name/description in `locale`, falling back like the i18n setup
 *  does: a UI locale the seed has no text for gets en-US, anything else zh-TW. */
export function seedText(field: 'name' | 'description', locale: string): string {
  const texts = seed[field]
  if (locale in texts) return texts[locale as SeedLanguage]
  return isUiLocale(locale) ? texts['en-US'] : texts['zh-TW']
}
