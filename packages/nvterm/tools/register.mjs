// Lets Node run the tools straight from TypeScript source: relative imports
// without an extension resolve to the .ts file next to them.
// Usage: node --import ./packages/nvterm/tools/register.mjs packages/nvterm/tools/<tool>.ts
import { register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
    const candidate = new URL(specifier + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context)
  }
  return next(specifier, context)
}
`))
