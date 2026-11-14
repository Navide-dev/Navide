import { i18n } from '@navide/plugin-ui/foundation'
import table from './builtinPipelineText.json'

// The builtin pipelines' stage text — titles, short titles, questions,
// descriptions, kickoff prompts and the landing pipeline's gate — is stored as
// its Chinese seed (backend/agent_team_backend/stages_store.py). The stored
// rows stay as they are; a string that still equals its seed is shown and sent
// in English under a non-Chinese UI. Once the user edits it, what they typed is
// used. backend/tests/test_builtin_pipeline_text_sync.py keeps the table keyed
// by the exact seed text.
const SEED_TO_ENGLISH: Record<string, string> = table

export function localizeBuiltinText(text: string, locale: string): string {
  if (locale.startsWith('zh') || !Object.hasOwn(SEED_TO_ENGLISH, text)) return text
  return SEED_TO_ENGLISH[text]
}

/** localizeBuiltinText in the current UI language (reactive inside a render). */
export function builtinTextForUi(text: string): string {
  return localizeBuiltinText(text, String(i18n.global.locale.value))
}
