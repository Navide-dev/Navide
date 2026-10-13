import { readdirSync, readFileSync, statSync } from 'node:fs'
import path, { join } from 'node:path'
import { expect, it } from 'vitest'

// Text cut off with an ellipsis must show its full text on hover: every element
// a `text-overflow: ellipsis` or `-webkit-line-clamp` rule styles carries
// `v-truncate` (packages/plugin-ui/src/foundation/truncate). A new rule without
// it fails here; a deliberate exception goes in EXEMPT with its reason.

const ROOT = join(__dirname, '..', '..')
const SCAN = ['src/renderer/src', 'plugins/navide-git/src', 'plugins/navide-mini-ide/src', 'plugins/navide-plans/src']
// Static illustrations in the help pages, not live UI.
const SKIP_DIRS = ['src/renderer/src/components/helpMocks']

/** `<file>|<class>` (or `<file>|<class>|<another class on the element>`) -> why
 *  it does not get the tooltip. */
const EXEMPT: Record<string, string> = {
  // The row clips, but its text sits in .cd-file-label, which carries v-truncate.
  'src/renderer/src/components/GitPane.vue|cd-file': 'text is in the v-truncate .cd-file-label child',
  'plugins/navide-git/src/components/GitPane.vue|cd-file': 'text is in the v-truncate .cd-file-label child',
  // The chip's wrapper already has a native title with the whole usage summary;
  // a second tooltip with just the name would cover it.
  'src/renderer/src/components/UsageBadge.vue|usage-badge-name-text': 'parent .usage-badge-name has the richer chipTooltip title',
  'src/renderer/src/components/sharing/SharingCloudSection.vue|sc-cell|sc-cell--check': 'holds only a checkbox',
}

/** Repo-relative path with `/` separators, whatever the platform's `path` gives. */
function relPath(root: string, file: string, p: typeof path = path): string {
  return p.relative(root, file).split(p.sep).join('/')
}

const FORM_TAGS = new Set(['input', 'textarea', 'select', 'option'])

function vueFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const rel = relPath(ROOT, path)
    if (name === 'node_modules' || name === '__tests__' || SKIP_DIRS.includes(rel)) continue
    if (statSync(path).isDirectory()) vueFiles(path, out)
    else if (name.endsWith('.vue')) out.push(path)
  }
  return out
}

/** Classes an ellipsis / line-clamp rule targets: the first class of each
 *  selector's last compound. */
function clippedClasses(style: string): Set<string> {
  const found = new Set<string>()
  const css = style.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = /([^{}]+)\{([^{}]*)\}/g
  for (let m = rule.exec(css); m; m = rule.exec(css)) {
    if (!/text-overflow\s*:\s*ellipsis|line-clamp\s*:/.test(m[2])) continue
    for (const selector of m[1].split(',')) {
      const last = selector.trim().split(/[\s>+~]+/).pop() ?? ''
      const cls = /\.([A-Za-z_][\w-]*)/.exec(last)?.[1]
      if (cls) found.add(cls)
    }
  }
  return found
}

/** Opening tags in the template whose static or bound class names `cls`. */
function openingTags(template: string, cls: string): string[] {
  const esc = cls.replace(/[-]/g, '\\-')
  const use = new RegExp(`\\bclass="[^"]*(?<![\\w-])${esc}(?![\\w-])|:class="[^"]*['\`]${esc}['\`]`, 'g')
  const tags: string[] = []
  for (let m = use.exec(template); m; m = use.exec(template)) {
    const start = template.lastIndexOf('<', m.index)
    let quote = ''
    let end = m.index
    for (; end < template.length; end++) {
      const ch = template[end]
      if (quote) { if (ch === quote) quote = '' } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
    }
    const tag = template.slice(start, end + 1)
    const name = /^<([\w-]+)/.exec(tag)?.[1] ?? ''
    // An element with no content (a self-closing or empty cell) has no text to cut.
    const empty = tag.endsWith('/>') || template.startsWith(`</${name}>`, end + 1)
    if (!empty) tags.push(tag)
  }
  return tags
}

/** Elements in one .vue file that a clipping rule styles without v-truncate. */
function missingIn(rel: string, raw: string): string[] {
  const missing: string[] = []
  const source = raw.replace(/\r\n/g, '\n')
  const styleAt = source.search(/<style[\s>]/)
  if (styleAt < 0) return missing
  const template = source.slice(0, styleAt).replace(/<!--[\s\S]*?-->/g, '')
  for (const cls of clippedClasses(source.slice(styleAt))) {
    if (EXEMPT[`${rel}|${cls}`]) continue
    for (const tag of openingTags(template, cls)) {
      const name = /^<([\w-]+)/.exec(tag)?.[1]?.toLowerCase() ?? ''
      if (FORM_TAGS.has(name) || /(^|\s)v-truncate(=|\s|>|\/)/.test(tag)) continue
      const extra = /class="([^"]*)"/.exec(tag)?.[1].split(/\s+/) ?? []
      if (extra.some((c) => EXEMPT[`${rel}|${cls}|${c}`])) continue
      missing.push(`${rel} .${cls}: ${tag.replace(/\s+/g, ' ').slice(0, 100)}`)
    }
  }
  return missing
}

it('every element a CSS rule cuts off with an ellipsis shows its full text on hover', () => {
  const missing: string[] = []
  for (const dir of SCAN) {
    for (const file of vueFiles(join(ROOT, dir))) {
      missing.push(...missingIn(relPath(ROOT, file), readFileSync(file, 'utf8')))
    }
  }
  expect(missing).toEqual([])
})

// Windows checkouts give `\` separators and, with autocrlf, CRLF line endings;
// the skip list and EXEMPT keys are written with `/`.
it('matches skip and exempt entries on Windows paths and CRLF sources', () => {
  const root = 'C:\\repo'
  expect(relPath(root, 'C:\\repo\\src\\renderer\\src\\components\\helpMocks', path.win32)).toBe(SKIP_DIRS[0])
  const rel = relPath(root, 'C:\\repo\\src\\renderer\\src\\components\\GitPane.vue', path.win32)
  const style = '<style scoped>\r\n.cd-file {\r\n  text-overflow: ellipsis;\r\n}\r\n.cd-name {\r\n  text-overflow: ellipsis;\r\n}\r\n</style>\r\n'
  const exempt = '<template>\r\n  <div class="cd-file">\r\n    x\r\n  </div>\r\n</template>\r\n'
  expect(missingIn(rel, exempt + style)).toEqual([])
  const bare = '<template>\r\n  <span\r\n    class="cd-name"\r\n  >x</span>\r\n</template>\r\n'
  expect(missingIn(rel, bare + style)).toHaveLength(1)
  const covered = '<template>\r\n  <span\r\n    v-truncate\r\n    class="cd-name"\r\n  >x</span>\r\n</template>\r\n'
  expect(missingIn(rel, covered + style)).toEqual([])
})
