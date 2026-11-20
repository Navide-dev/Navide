import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  flattenDiagnosticMessageText,
  forEachChild,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  parseJsonText,
  type Diagnostic,
  type Node
} from 'typescript'
import { describe, expect, it } from 'vitest'

// plugin-ui holds only the strings its own components use; the Host merges its
// own catalog into the same i18n instance. The first-party plugins, built in
// their own repositories, check theirs there.
const UI_DIR = 'packages/plugin-ui/src/foundation/i18n/locales'
const HOST_DIR = 'src/renderer/src/i18n/locales'
const localeDirs = [UI_DIR, HOST_DIR]
const filesIn = (dir: string): string[] =>
  readdirSync(resolve(dir)).filter((fileName) => fileName.endsWith('.json')).sort()
const read = (dir: string, fileName: string): unknown => JSON.parse(readFileSync(resolve(dir, fileName), 'utf8'))

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key)
  )
}

describe.each(localeDirs)('locale JSON files in %s', (localesDir) => {
  const localeFiles = filesIn(localesDir)

  it.each(localeFiles)('%s contains no duplicate object keys', (fileName) => {
    const sourceFile = parseJsonText(fileName, readFileSync(resolve(localesDir, fileName), 'utf8'))
    const parseDiagnostics = (sourceFile as typeof sourceFile & {
      parseDiagnostics: readonly Diagnostic[]
    }).parseDiagnostics
    const parseErrors = parseDiagnostics.map((diagnostic) =>
      flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    )
    expect(parseErrors, `${fileName} contains invalid JSON`).toEqual([])

    const duplicates: string[] = []
    const visit = (node: Node): void => {
      if (isObjectLiteralExpression(node)) {
        const keys = new Set<string>()
        for (const property of node.properties) {
          if (!isPropertyAssignment(property) || !isStringLiteral(property.name)) continue
          const key = property.name.text
          if (keys.has(key)) {
            const position = sourceFile.getLineAndCharacterOfPosition(property.name.getStart(sourceFile))
            duplicates.push(`${fileName}:${position.line + 1}:${position.character + 1} duplicate key "${key}"`)
          }
          keys.add(key)
        }
      }
      forEachChild(node, visit)
    }

    visit(sourceFile)
    expect(duplicates, duplicates.join('\n')).toEqual([])
  })

  it('keeps every locale key set in parity', () => {
    // Against en-US, the source every translation is made from; the first file
    // by name stopped being en-US once de-DE.json and es-ES.json exist.
    const baseFile = 'en-US.json'
    const otherFiles = localeFiles.filter((fileName) => fileName !== baseFile)
    const base = leafKeys(read(localesDir, baseFile)).sort()
    for (const fileName of otherFiles) {
      const keys = leafKeys(read(localesDir, fileName)).sort()
      expect(keys, `${fileName} keys differ from ${baseFile}`).toEqual(base)
    }
  })
})

describe('catalogs merged into one i18n instance', () => {
  // A key defined twice resolves to whichever catalog merged last, so the
  // copies drift apart unseen.
  it.each([HOST_DIR])('%s defines no key plugin-ui already has', (dir) => {
    const shared = new Set(leafKeys(read(UI_DIR, 'en-US.json')))
    const overlap = leafKeys(read(dir, 'en-US.json')).filter((key) => shared.has(key))
    expect(overlap, overlap.join('\n')).toEqual([])
  })
})
