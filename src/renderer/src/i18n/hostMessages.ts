// The Host's own UI strings, merged into the shared @navide/plugin-ui i18n
// instance when this module is first imported. packages/plugin-ui keeps only
// the strings its own components use, so a Host-only string change touches
// no other package (see scripts/official-plugin-fingerprints.mjs).
import { i18n } from '@navide/plugin-ui/foundation'

const catalogs = import.meta.glob<Record<string, unknown>>('./locales/*.json', { eager: true, import: 'default' })

for (const [path, messages] of Object.entries(catalogs)) {
  i18n.global.mergeLocaleMessage(path.slice('./locales/'.length, -'.json'.length), messages)
}
