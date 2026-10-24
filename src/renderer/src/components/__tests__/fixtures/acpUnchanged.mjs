// Shared by App.tuiUnchanged.test.ts and its fixture regeneration.
//
// ACP is additive (user, 2026-10-23: the existing modes stay exactly as they
// are). Each existing App.vue function or template block ACP reaches gets
// added lines only. acp-unchanged-main.json holds main's text of each one and
// the exact lines ACP adds to it; the test removes those and requires main's
// text back, byte for byte.
//
// Regenerate after main itself changes one of these (keeps the hook lists):
//   node src/renderer/src/components/__tests__/fixtures/acpUnchanged.mjs <main commit>

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'acp-unchanged-main.json')

/** A top-level `function name(` / `async function name(` through its closing `}` line. */
function functionText(lines, name) {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`))
  if (start < 0) throw new Error(`no function ${name}`)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  return lines.slice(start, end + 1).join('\n')
}

/** From the line equal to `start` through its matching `</template>`. */
function blockText(lines, start) {
  const first = lines.indexOf(start)
  if (first < 0) throw new Error(`no line ${start}`)
  let depth = 0
  for (let i = first; i < lines.length; i++) {
    if (/<template[\s>]/.test(lines[i])) depth++
    if (lines[i].includes('</template>')) depth--
    if (depth === 0) return lines.slice(first, i + 1).join('\n')
  }
  throw new Error(`unclosed block ${start}`)
}

export function sectionText(source, entry) {
  const lines = source.split('\n')
  return entry.kind === 'block' ? blockText(lines, entry.start) : functionText(lines, entry.name)
}

/** `text` without each hook (one or more whole lines), each required exactly once. */
export function withoutHooks(text, hooks) {
  let out = `\n${text}\n`
  for (const hook of hooks) {
    const needle = `\n${hook}\n`
    const at = out.indexOf(needle)
    if (at < 0 || out.indexOf(needle, at + 1) >= 0) throw new Error(`hook must appear exactly once: ${hook}`)
    out = out.slice(0, at) + out.slice(at + needle.length - 1)
  }
  return out.slice(1, -1)
}

function regenerate(commit) {
  const entries = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const cache = new Map()
  for (const entry of entries) {
    if (!cache.has(entry.file)) {
      cache.set(entry.file, execFileSync('git', ['show', `${commit}:${entry.file}`], { encoding: 'utf8', maxBuffer: 64 << 20 }))
    }
    entry.main = sectionText(cache.get(entry.file), entry)
  }
  writeFileSync(FIXTURE, `${JSON.stringify(entries, null, 1)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) regenerate(process.argv[2])
