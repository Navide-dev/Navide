// Deterministic inputs for the renderer-side throughput benchmark. Each
// dataset is a byte stream of roughly `targetBytes`, built from one repeated
// pattern so runs are comparable across machines and implementations.
import { cha, cup, cuu, ed, el, sgr, syncBegin, syncEnd } from '../fixtures/seq'

export interface Dataset {
  id: string
  description: string
  bytes: Uint8Array
}

const encoder = new TextEncoder()

function repeatTo(targetBytes: number, unit: (i: number) => string): Uint8Array {
  const parts: string[] = []
  let size = 0
  for (let i = 0; size < targetBytes; i++) {
    const text = unit(i)
    parts.push(text)
    size += encoder.encode(text).length
  }
  return encoder.encode(parts.join(''))
}

export function datasets(targetBytes = 8 * 1024 * 1024): Dataset[] {
  return [
    {
      id: 'ascii',
      description: 'Plain ASCII lines (cat of a source file)',
      bytes: repeatTo(targetBytes, (i) => `${i.toString().padStart(6, '0')}  const value = compute(input, options) // plain ascii text\r\n`),
    },
    {
      id: 'cjk',
      description: 'CJK text mixed with ASCII',
      bytes: repeatTo(targetBytes, (i) => `${i} 中文輸出測試，日本語のテキスト、한국어 텍스트 mixed ascii 寬字元\r\n`),
    },
    {
      id: 'sgr',
      description: 'SGR-heavy coloured output (syntax-highlighted diff)',
      bytes: repeatTo(targetBytes, (i) => `${sgr(38, 2, i % 256, 100, 200)}+${sgr(1)}added${sgr(22)} ${sgr(38, 5, i % 256)}line ${i}${sgr(0)}${el(0)}\r\n`),
    },
    {
      id: 'tui',
      description: 'Full-screen TUI redraws inside synchronized output frames',
      bytes: repeatTo(targetBytes, (i) =>
        `${syncBegin}${cup(1, 1)}${ed(2)}` +
        Array.from({ length: 20 }, (_, r) => `${cup(r + 2, 1)}${sgr(r % 2 ? 7 : 0)}│ row ${r} frame ${i} ${'─'.repeat(40)}│${sgr(0)}`).join('') +
        `${cuu(3)}${cha(5)}${syncEnd}`),
    },
  ]
}
