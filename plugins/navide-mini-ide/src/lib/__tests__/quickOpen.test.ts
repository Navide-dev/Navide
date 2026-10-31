import { describe, expect, it } from 'vitest'
import { fileMatchScore, rankWorkspaceFiles } from '../quickOpen'

const row = (path: string) => ({ path, name: path.split('/').pop() ?? path })
const paths = (query: string, ...rows: string[]) => rankWorkspaceFiles(query, rows.map(row)).map((entry) => entry.path)

describe('rankWorkspaceFiles', () => {
  it('puts an exact file name ahead of a longer one and a directory hit', () => {
    expect(paths('foo.ts', 'foo.ts.orig', 'dir/foo.ts', 'foo.ts/readme.md')).toEqual(['dir/foo.ts', 'foo.ts.orig', 'foo.ts/readme.md'])
  })

  it('finds a pasted path ahead of files that only share its name', () => {
    expect(paths('app/Services/OrderService.php',
      'other/OrderService.php',
      'legacy/app/Services/OrderService.php',
      'app/Services/OrderService.php',
    )).toEqual(['app/Services/OrderService.php', 'legacy/app/Services/OrderService.php'])
  })

  it('prefers a name prefix, then a name hit, then a path hit, then a subsequence', () => {
    expect(paths('order', 'x/ReOrder.php', 'order/Other.php', 'x/OrderService.php', 'x/o-r-d-e-r.php'))
      .toEqual(['x/OrderService.php', 'x/ReOrder.php', 'order/Other.php', 'x/o-r-d-e-r.php'])
  })

  it('breaks a tie by the shorter path', () => {
    expect(paths('foo', 'long/er/foo.ts', 'b/foo.ts', 'a/foo.ts')).toEqual(['a/foo.ts', 'b/foo.ts', 'long/er/foo.ts'])
  })

  it('leaves out what does not match', () => {
    expect(paths('zzz', 'a.ts')).toEqual([])
    expect(fileMatchScore('', row('a.ts'))).toBe(0)
  })

  it('keeps every subsequence below every substring', () => {
    expect(fileMatchScore('ab', row('ab-long-name.ts'))).toBeGreaterThan(fileMatchScore('abc', row('abc'.split('').join('-'))))
    expect(fileMatchScore('abc', row('a-b-c'))).toBeLessThan(200)
  })
})
