import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ignoredDirectories = new Set(['node_modules', 'dist', 'out', 'coverage', '.git'])
const modulePath = (file: string): string => file.replaceAll('\\', '/')

/** Independent filesystem inventory: adding a test directory must not silently drop it. */
export function repositoryTestFiles(root: string): string[] {
  const files: string[] = []
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) walk(path)
      else if (entry.isFile() && /\.(test|spec)\.ts$/.test(entry.name)) files.push(resolve(path))
    }
  }
  for (const directory of ['src', 'packages', 'tests']) walk(join(root, directory))
  for (const entry of readdirSync(root)) {
    if (/^vitest\..*\.(test|spec)\.ts$/.test(entry)) files.push(resolve(root, entry))
  }
  return files.map(modulePath).sort()
}

export function assertTestOwnership(
  files: string[],
  specifications: Array<{ file: string; project: string }>,
): void {
  const expected = new Set(files.map(modulePath))
  const owners = new Map<string, string[]>()
  for (const { file, project } of specifications) {
    const path = modulePath(file)
    owners.set(path, [...(owners.get(path) ?? []), project])
  }
  const errors: string[] = []
  for (const file of expected) if (!owners.has(file)) errors.push(`Uncollected: ${file}`)
  for (const [file, projects] of owners) {
    if (!expected.has(file)) errors.push(`Unexpected: ${file}`)
    if (projects.length !== 1) errors.push(`Multiple projects: ${file}: ${projects.join(', ')}`)
  }
  if (errors.length) throw new Error(errors.join('\n'))
}
