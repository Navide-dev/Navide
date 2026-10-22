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

const localesDir = resolve('packages/plugin-ui/src/foundation/i18n/locales')
const localeFiles = readdirSync(localesDir).filter((fileName) => fileName.endsWith('.json')).sort()

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key)
  )
}

describe('locale JSON files', () => {
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
    const base = leafKeys(JSON.parse(readFileSync(resolve(localesDir, baseFile), 'utf8'))).sort()
    for (const fileName of otherFiles) {
      const keys = leafKeys(JSON.parse(readFileSync(resolve(localesDir, fileName), 'utf8'))).sort()
      expect(keys, `${fileName} keys differ from ${baseFile}`).toEqual(base)
    }
  })
})
