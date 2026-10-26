export function moduleOf(file: string): string | null
export function importsOf(text: string, module: string, isPackage: boolean): Set<string>
export function selectTests(changed: string[], repo: { files: string[]; read(path: string): string }): string[]
export function parseArgs(argv: string[]):
  | { help: true }
  | { error: string }
  | { base: string; list: boolean; pytestArgs: string[] }
