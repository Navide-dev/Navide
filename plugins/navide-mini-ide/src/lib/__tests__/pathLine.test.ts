import { describe, expect, it } from 'vitest'
import { parsePathLine, workspaceRelativePath } from '../pathLine'

describe('parsePathLine', () => {
  it.each([
    ['app/Services/OrderService.php:137-158', { path: 'app/Services/OrderService.php', line: 137, endLine: 158 }],
    ['src/a.ts:10', { path: 'src/a.ts', line: 10 }],
    ['src/a.ts:10:5', { path: 'src/a.ts', line: 10, column: 5 }],
    ['src/a.ts:10.5', { path: 'src/a.ts', line: 10, column: 5 }],
    ['src/a.ts(10)', { path: 'src/a.ts', line: 10 }],
    ['src/a.ts(10,3)', { path: 'src/a.ts', line: 10, column: 3 }],
    ['src/a.ts[10]', { path: 'src/a.ts', line: 10 }],
    ['src/a.ts#10', { path: 'src/a.ts', line: 10 }],
    ['src/a.ts#L10', { path: 'src/a.ts', line: 10 }],
    ['src/a.ts#L10-L20', { path: 'src/a.ts', line: 10, endLine: 20 }],
    ['src/a.ts#L10-20', { path: 'src/a.ts', line: 10, endLine: 20 }],
    ['src/a.ts#L10C5', { path: 'src/a.ts', line: 10, column: 5 }],
    ['C:\\work\\a.php:3', { path: 'C:\\work\\a.php', line: 3 }],
    ['  src/a.ts:10  ', { path: 'src/a.ts', line: 10 }],
  ])('reads %s', (raw, expected) => {
    expect(parsePathLine(raw)).toEqual(expected)
  })

  it.each(['src/a.ts', 'C:\\work\\a.php', 'src/a.ts:0', 'v1.2.3', 'a:b'])('leaves %s as a path', (raw) => {
    expect(parsePathLine(raw)).toEqual({ path: raw })
  })

  it('drops an end before its start', () => {
    expect(parsePathLine('src/a.ts:20-10')).toEqual({ path: 'src/a.ts', line: 20 })
  })
})

describe('workspaceRelativePath', () => {
  it.each([
    ['app/a.php', 'app/a.php'],
    ['./app/a.php', 'app/a.php'],
    ['/work/app/a.php', 'app/a.php'],
    ['app\\a.php', 'app/a.php'],
  ])('reads %s inside the workspace', (path, expected) => {
    expect(workspaceRelativePath(path, '/work/')).toBe(expected)
  })

  it.each(['/etc/passwd', '/workspace2/a.php', '~/a.php', 'C:\\a.php', '../a.php', 'a/../../b.php'])('refuses %s', (path) => {
    expect(workspaceRelativePath(path, '/work')).toBeNull()
  })
})
