// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildMentionInsert,
  injectionChunks,
} from '../../platform/terminal/lib/cliContext'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. They lock the
// wiring of the pane context menu's "Send Message" item: it must insert the
// right-clicked pane's messaging handle into the focused pane's prompt WITHOUT
// submitting. Source assertions cannot prove the insert reaches a PTY; the
// insert string itself is covered by cliContext's buildMentionInsert tests.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)
const enLocale = JSON.parse(
  readFileSync(resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales/en-US.json'), 'utf8')
) as { action: Record<string, string> }
const zhLocale = JSON.parse(
  readFileSync(resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales/zh-TW.json'), 'utf8')
) as { action: Record<string, string> }

describe('pane context menu — Send message', () => {
  it('offers the item in the single-pane menu, next to Rename', () => {
    expect(appSource).toContain("@click=\"mentionPaneInFocusedPane(paneCtxMenu!.paneId)\"")
    expect(appSource).toContain("{{ $t('action.send-message') }}")
    // Inside the non-batch branch: the batch template ends at the separator
    // before `action.remove-selected`, and the item sits after Rename.
    const renameAt = appSource.indexOf("startRenamePane(paneCtxMenu!.paneId)")
    const itemAt = appSource.indexOf("mentionPaneInFocusedPane(paneCtxMenu!.paneId)")
    const batchAt = appSource.indexOf("action.remove-selected")
    expect(renameAt).toBeGreaterThan(-1)
    expect(itemAt).toBeGreaterThan(renameAt)
    expect(itemAt).toBeGreaterThan(batchAt)
  })

  it('greys the item out when there is no address to insert', () => {
    expect(appSource).toContain(':class="{ disabled: !ctxMentionAddress }"')
    // Three reasons there is nothing to insert, all in the computed.
    expect(appSource).toContain('const ctxMentionAddress = computed<string | null>(() => {')
    expect(appSource).toContain('if (!m || ctxIsBatch.value) return null')
    expect(appSource).toContain('if (!focusId || focusId === m.paneId) return null')
    expect(appSource).toContain('return panes.value.find((p) => p.id === m.paneId)?.messagingName ?? null')
  })

  it('inserts the handle into the focused pane without pressing Enter', () => {
    expect(appSource).toContain('async function mentionPaneInFocusedPane(paneId: string): Promise<void> {')
    // The target is the pane being typed in, not the right-clicked one.
    expect(appSource).toContain('const targetPaneId = effectiveFocusPaneId.value')
    // Same insert shape as the @-menu and the drop-on-"@" gesture.
    expect(appSource).toContain(
      'await pastePaneContext(targetPaneId, buildMentionInsert(lineBeforeCursor, address))'
    )
    // pastePaneContext sends no Enter; injectText would. Guard the difference.
    const body = appSource.slice(
      appSource.indexOf('async function mentionPaneInFocusedPane'),
      appSource.indexOf('function openPaneCtxMenu')
    )
    expect(body).not.toContain('injectText')
    expect(body).toContain('rememberMentionPick([address])')
  })

  // The whole point of the feature: the address lands in the prompt and the
  // user still presses Enter. These run the real insert path end to end — the
  // string builder plus the exact chunking pastePaneContext writes to the PTY —
  // so a stray CR anywhere in it fails here rather than in someone's session.
  it('writes the address to the PTY with no Enter in the bytes', () => {
    const insert = buildMentionInsert('\u5e6b\u6211\u770b\u4e00\u4e0b ', 'codex-1')
    expect(insert).toBe('@codex-1 ')
    const wire = injectionChunks(insert, 512, true).join('')
    expect(wire).toBe(`${BRACKETED_PASTE_START}@codex-1 ${BRACKETED_PASTE_END}`)
    expect(wire).not.toMatch(/[\r\n]/)
  })

  it('completes an "@" the user already typed instead of doubling it', () => {
    const wire = injectionChunks(buildMentionInsert('\u50b3\u7d66 @', 'claude-2'), 512, true).join('')
    expect(wire).toBe(`${BRACKETED_PASTE_START}claude-2 ${BRACKETED_PASTE_END}`)
    expect(wire).not.toMatch(/[\r\n]/)
  })

  it('is labelled in both locales', () => {
    expect(enLocale.action['send-message']).toBe('Send Message')
    expect(zhLocale.action['send-message']).toBe('傳送訊息')
    expect(enLocale.action['send-message-title']).toBeTruthy()
    expect(zhLocale.action['send-message-title']).toBeTruthy()
  })
})
