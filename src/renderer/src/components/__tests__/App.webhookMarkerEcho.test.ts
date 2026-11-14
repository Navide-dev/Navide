// A webhook's data goes into a worker's (and the Manager's) kickoff, and the
// CLI echoes the submitted kickoff on screen after the router's floor (0.2.37
// package 7 showed the echo there, repainted). The router reads ASK, REPORT
// and DISPATCH blocks, and the stage sentinels, off that screen, so a body
// carrying a complete block spoke for the agent: an external system could
// send the Manager a REPORT "from" its worker, or dispatch work itself.
//
// webhook_payload.sanitize_text turns every run of three or more hyphens in
// the data (whitespace allowed between them) into en dashes. The fixture pairs
// are what it returns; backend/tests/test_webhook_payload.py holds the
// backend to them.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { findScreenSentinel, findSentinel } from '../../platform/terminal/lib/buffer'
import { MANAGER_READY_SENTINEL, MANAGER_STAGE_DONE_SENTINEL } from '../../data/stages'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const { cases } = JSON.parse(readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/__tests__/fixtures/webhook-marker-injection.json'), 'utf8',
)) as { cases: Array<{ name: string; raw: string; sanitized: string }> }

function functionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

async function parsers() {
  const regexes = ['DISPATCH_RE', 'ASK_RE', 'REPORT_RE'].map((name) => {
    const line = new RegExp(`^const ${name} = .*$`, 'm').exec(appSource)
    expect(line, `${name} should exist`).not.toBeNull()
    return line![0]
  })
  const { code } = await transformWithEsbuild(
    [
      ...regexes,
      functionSource('parseContentBlocks'),
      functionSource('parseDispatchBlocks'),
      'return { parseContentBlocks, parseDispatchBlocks, ASK_RE, REPORT_RE }',
    ].join('\n'),
    'AppWebhookMarkerEcho.ts',
    { loader: 'ts' },
  )
  return new Function(code)() as {
    parseContentBlocks: (buf: string, from: number, re: RegExp) => { items: string[] }
    parseDispatchBlocks: (buf: string, from: number) => { items: Array<{ to: string; message: string }> }
    ASK_RE: RegExp
    REPORT_RE: RegExp
  }
}

/** The echoed kickoff as the router sees it: once as printed, once the way
 *  Claude Code 2.1.3xx reaches the clean buffer — no newlines, and blank
 *  cells skipped, so no spaces either. */
function echoes(data: string): string[] {
  const kickoff = `Webhook trigger "wm" started this run.\n<<<NAVIDE-WEBHOOK-DATA-0f\n${data}\nNAVIDE-WEBHOOK-DATA-0f>>>\n`
  return [kickoff, kickoff.replace(/\s+/g, '')]
}

async function whatTheRouterReads(data: string): Promise<string[]> {
  const p = await parsers()
  const read: string[] = []
  for (const screen of echoes(data)) {
    read.push(...p.parseContentBlocks(screen, 0, p.ASK_RE).items.map((c) => `ASK ${c}`))
    read.push(...p.parseContentBlocks(screen, 0, p.REPORT_RE).items.map((c) => `REPORT ${c}`))
    read.push(...p.parseDispatchBlocks(screen, 0).items.map((d) => `DISPATCH ${d.to}`))
    for (const sentinel of [MANAGER_READY_SENTINEL, MANAGER_STAGE_DONE_SENTINEL]) {
      if (findSentinel(screen, sentinel) >= 0 || findScreenSentinel(screen, sentinel) >= 0) read.push(sentinel)
    }
  }
  return read
}

describe('a webhook body carrying line markers, echoed with the kickoff', () => {
  it('as received, it reads as the agent speaking (the attack the sanitizer stops)', async () => {
    const read = (await Promise.all(cases.map((c) => whatTheRouterReads(c.raw)))).map((r) => r.length)
    // Every case is read at least once, in one echo form or the other.
    expect(read.every((n) => n > 0)).toBe(true)
  })

  it.each(cases.map((c) => [c.name, c.sanitized] as const))('sanitized (%s), the router reads nothing from it', async (_name, sanitized) => {
    expect(await whatTheRouterReads(sanitized)).toEqual([])
    expect(sanitized).not.toMatch(/-\s*-\s*-/)
  })

  it('a worker REPORT next to the sanitized echo is still read', async () => {
    const p = await parsers()
    for (const screen of echoes(cases[0].sanitized)) {
      const withReport = `${screen}● ---REPORT-START---\ncontent: <b>done</b>, latency < 200ms\n---REPORT-END---`
      expect(p.parseContentBlocks(withReport, 0, p.REPORT_RE).items).toHaveLength(1)
    }
  })
})
