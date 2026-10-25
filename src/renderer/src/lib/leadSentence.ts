/**
 * Splits a localized paragraph after its first sentence, so a long warning can
 * lead with that sentence in bold and keep every word of the rest: `lead +
 * separator + rest` is always the original text. A sentence ends at `.`, `!` or
 * `?` followed by whitespace, or at a full-width `。`, `！` or `？`. Text with a
 * single sentence comes back whole as the lead.
 */
export function leadSentence(text: string): { lead: string; separator: string; rest: string } {
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i]
    if ('。！？'.includes(ch)) {
      return { lead: text.slice(0, i + 1), separator: '', rest: text.slice(i + 1) }
    }
    if ('.!?'.includes(ch) && /\s/.test(text[i + 1])) {
      let end = i + 1
      while (end < text.length && /\s/.test(text[end])) end++
      if (end === text.length) break
      return { lead: text.slice(0, i + 1), separator: text.slice(i + 1, end), rest: text.slice(end) }
    }
  }
  return { lead: text, separator: '', rest: '' }
}
