// Tests render with this plugin's own strings, as src/index.ts installs them.
import { i18n } from '@navide/plugin-ui/foundation'
import { installPlansMessages } from '../../src/plansI18n'

installPlansMessages((locale, messages) => i18n.global.mergeLocaleMessage(locale, messages))
