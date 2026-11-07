// Finding a bot among many: Settings → Channels and the pane chat button's menu
// both filter with these, so the same words find the same bot in either place.

import type { ChannelAccountState } from '../composables/useChannels'

/** Case, a leading "@" and whitespace never decide a match. */
export function normalizeChannelQuery(text: string): string {
  return text.toLowerCase().replace(/[@\s]/g, '')
}

/** Every text a bot can be found by: its names, handle, ids and where it is bound. */
export function channelBotSearchFields(state: ChannelAccountState): string[] {
  return [
    state.name,
    state.status.identity,
    state.status.display_name ?? '',
    state.account,
    state.bot_id ?? '',
    ...(state.bindings ?? []).flatMap((b) => [b.pane_name, b.workspace_name, b.workspace_path, b.chat_title]),
  ].filter(Boolean)
}

/** True when the query is empty or any field contains it. */
export function matchesChannelQuery(fields: readonly string[], query: string): boolean {
  const q = normalizeChannelQuery(query)
  return !q || fields.some((f) => normalizeChannelQuery(f).includes(q))
}

/**
 * The entries a query keeps. A pasted number is most likely a Telegram bot id, so
 * when some entry's bot id contains it, only those are kept.
 */
export function filterChannelEntries<T>(
  entries: readonly T[],
  query: string,
  fieldsOf: (entry: T) => readonly string[],
  botIdOf: (entry: T) => string,
): T[] {
  const q = normalizeChannelQuery(query)
  if (!q) return [...entries]
  if (/^\d+$/.test(q)) {
    const byId = entries.filter((e) => botIdOf(e).includes(q))
    if (byId.length) return byId
  }
  return entries.filter((e) => matchesChannelQuery(fieldsOf(e), q))
}

/** `text` cut around the first case-insensitive occurrence of the query, for a <mark>. */
export function highlightChannelMatch(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().replace(/^@/, '').toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1
  if (at < 0) return [{ text, hit: false }]
  return [
    { text: text.slice(0, at), hit: false },
    { text: text.slice(at, at + q.length), hit: true },
    { text: text.slice(at + q.length), hit: false },
  ].filter((p) => p.text)
}
