import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Catalog = Record<string, unknown>

function merge(target: Catalog, source: Catalog): Catalog {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    target[key] = current && typeof current === 'object' && value && typeof value === 'object'
      ? merge({ ...(current as Catalog) }, value as Catalog)
      : value
  }
  return target
}

/**
 * Every string a Host window can render in `locale`: the @navide/plugin-ui
 * catalog with the Host's own merged over it, as hostMessages.ts does at runtime.
 */
export function hostCatalog(locale: string): Catalog {
  const read = (dir: string): Catalog =>
    JSON.parse(readFileSync(resolve(process.cwd(), dir, `${locale}.json`), 'utf8')) as Catalog
  return merge(read('packages/plugin-ui/src/foundation/i18n/locales'), read('src/renderer/src/i18n/locales'))
}
