import { describe, expect, it } from 'vitest'
import { splitFilePickerCandidate } from '../../plugin-contracts/src/filePicker'
import { splitTerminalLinkSuffix } from './terminalLinkInteraction'

// Both parsers share one suffix grammar: the terminal link interaction and
// the Host picker must agree on what a pasted location means.
const cases: Array<[string, string, number | undefined, number | undefined]> = [
  ['app/Services/OrderService.php:137', 'app/Services/OrderService.php', 137, undefined],
  ['app/Services/OrderService.php:137-158', 'app/Services/OrderService.php', 137, 158],
  ['app/Services/OrderService.php:137:5', 'app/Services/OrderService.php', 137, undefined],
  ['src/a.ts(12)', 'src/a.ts', 12, undefined],
  ['src/a.ts#L4', 'src/a.ts#L4', undefined, undefined],
  ['src/a.ts:abc', 'src/a.ts:abc', undefined, undefined],
  ['src/a.ts:12-', 'src/a.ts:12-', undefined, undefined],
  ['src/a.ts', 'src/a.ts', undefined, undefined],
]

describe('location suffix parsing', () => {
  it.each(cases)('splitTerminalLinkSuffix(%s)', (raw, path, line, endLine) => {
    const parsed = splitTerminalLinkSuffix(raw)
    expect(parsed.filepath).toBe(path)
    expect(parsed.line).toBe(line)
    expect(parsed.endLine).toBe(endLine)
  })

  it.each(cases)('splitFilePickerCandidate(%s)', (raw, path, line, endLine) => {
    const parsed = splitFilePickerCandidate(raw)
    expect(parsed.path).toBe(path)
    expect(parsed.line).toBe(line)
    expect(parsed.endLine).toBe(endLine)
  })

  it('drops an end line that is before the start line', () => {
    expect(splitTerminalLinkSuffix('a.ts:20-3')).toEqual({ filepath: 'a.ts', line: 20 })
    expect(splitFilePickerCandidate('a.ts:20-3')).toEqual({ path: 'a.ts', line: 20 })
  })
})
