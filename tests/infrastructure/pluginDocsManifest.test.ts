import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The Plugin Developer Spec v2 restates parts of the manifest schema and the
// capability catalog in tables. Each table is found by its exact header row
// and compared with the source of truth, so a value added or removed on either
// side fails CI.

const repoRoot = resolve(__dirname, '../..')
const docPath = 'docs/en-US/plugin-development-v2.md'
const schemaPath = 'packages/plugin-contracts/src/schemas/plugin-manifest-v2.schema.json'
const catalogPath = 'packages/plugin-contracts/src/schemas/capabilities-v1.json'

type JsonSchema = {
  required?: string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema | { $ref: string }
  enum?: unknown[]
  const?: unknown
  $ref?: string
  $defs?: Record<string, JsonSchema>
}
type CatalogEntry = { address: string; permission: { id: string; access?: string; scope?: string } }
type Catalog = { methods: CatalogEntry[]; events: CatalogEntry[]; errors: string[] }

const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as T
const backticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1])

/** Rows (cells split on unescaped pipes) of the one table whose header row is exactly `header`. */
function tableRows(markdown: string, header: string): string[][] {
  const lines = markdown.split(/\r?\n/)
  const starts = lines.flatMap((line, index) => (line.trim() === header ? [index] : []))
  if (starts.length !== 1) throw new Error(`${docPath}: expected exactly one table with header "${header}", found ${starts.length}`)
  const rows: string[][] = []
  for (let index = starts[0] + 2; index < lines.length && lines[index].trim().startsWith('|'); index++) {
    rows.push(lines[index].trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
  }
  return rows
}

function resolveRef(schema: JsonSchema, node: JsonSchema): JsonSchema {
  return node.$ref ? schema.$defs![node.$ref.replace('#/$defs/', '')] : node
}

/** Field path → { required, values } for the levels the reference table documents. */
function schemaFields(schema: JsonSchema): Map<string, { required: boolean; values: string[] | null }> {
  const fields = new Map<string, { required: boolean; values: string[] | null }>()
  const add = (prefix: string, objectSchema: JsonSchema) => {
    const object = resolveRef(schema, objectSchema)
    for (const [name, raw] of Object.entries(object.properties ?? {})) {
      const property = resolveRef(schema, raw)
      const items = property.items ? resolveRef(schema, property.items as JsonSchema) : undefined
      const allowed = property.enum ?? (property.const !== undefined ? [property.const] : items?.enum)
      fields.set(`${prefix}${name}`, {
        required: object.required?.includes(name) ?? false,
        values: allowed ? allowed.map(String).sort() : null,
      })
    }
  }
  add('', schema)
  add('permissions.', schema.properties!.permissions)
  add('contributes.views[].', schema.$defs!.view)
  add('backend.', schema.$defs!.backend)
  return fields
}

describe('plugin developer docs match the manifest schema and capability catalog', () => {
  const markdown = readFileSync(join(repoRoot, docPath), 'utf8')
  const schema = readJson<JsonSchema>(schemaPath)
  const catalog = readJson<Catalog>(catalogPath)

  it('lists every manifest field, its required flag and its fixed values', () => {
    const documented = new Map(tableRows(markdown, '| Field | Required | Allowed values | Notes |').map((cells) => {
      const [field, required, values] = cells
      const name = backticked(field)
      if (name.length !== 1 || !/^(yes|no)$/.test(required)) throw new Error(`${docPath}: malformed field reference row "| ${cells.join(' | ')} |"`)
      const listed = backticked(values)
      return [name[0], { required: required === 'yes', values: listed.length ? listed.sort() : null }] as const
    }))
    const expected = Object.fromEntries([...schemaFields(schema)].sort())
    expect(Object.fromEntries([...documented].sort())).toEqual(expected)
  })

  it('documents every view location in the placement table', () => {
    const view = schema.$defs!.view.properties!
    const documented = tableRows(markdown, '| Value | Placement |').map(([value]) => backticked(value)[0]).sort()
    expect(documented).toEqual(view.location.enum!.map(String).sort())
  })

  it('documents every public error code', () => {
    const documented = tableRows(markdown, '| Code | Meaning | Author response |').map(([code]) => backticked(code)[0]).sort()
    expect(documented).toEqual([...catalog.errors].sort())
  })

  it('lists capability entries that exist in the catalog under the stated permission and scope', () => {
    const entries = new Map([...catalog.methods, ...catalog.events].map((entry) => [entry.address, entry]))
    const rows = tableRows(markdown, '| Namespace/address | Catalog methods/events | Scope |')
    const system = schema.properties!.permissions.properties!.system
    const permissionAddresses = [...(resolveRef(schema, system.items as JsonSchema).enum!.map((access) => `system:${access}`)), 'shell']
    expect([...new Set(rows.map(([address]) => backticked(address)[0]))].sort()).toEqual(permissionAddresses.sort())

    const problems: string[] = []
    for (const [addressCell, namesCell, scopeCell] of rows) {
      const address = backticked(addressCell)[0]
      const scope = backticked(scopeCell)[0]
      let namespace = ''
      for (const name of backticked(namesCell)) {
        // A bare name continues the namespace of the previous dotted name: `aiCli.listProfiles`, `startSession`.
        if (name.includes('.')) namespace = name.slice(0, name.indexOf('.'))
        const fullName = name.includes('.') ? name : `${namespace}.${name}`
        const entry = entries.get(fullName)
        const actual = entry ? (entry.permission.access ? `${entry.permission.id}:${entry.permission.access}` : entry.permission.id) : undefined
        if (!entry) problems.push(`${fullName}: not in ${catalogPath}`)
        else if (actual !== address) problems.push(`${fullName}: documented under ${address}, catalog permission is ${actual}`)
        else if (entry.permission.scope !== scope) problems.push(`${fullName}: documented scope ${scope}, catalog scope is ${entry.permission.scope}`)
      }
    }
    expect(problems).toEqual([])
  })
})
