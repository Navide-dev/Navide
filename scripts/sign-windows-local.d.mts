export interface SignOptions {
  repo: string
  tag?: string
  run?: string
  dir?: string
  storetype?: string
  keystore?: string
  alias?: string
  certfile?: string
  publisher?: string
  caFile: string
  keychainService?: string
  keychain?: string
  out?: string
  tsaurl: string[]
  apply: boolean
  mirror: boolean
  help?: boolean
}
export declare function parseArgs(argv: string[]): SignOptions
export declare function jsignArgs(opts: SignOptions, file: string): string[]
export declare function updateManifest(text: string, updates: Record<string, { sha512: string; size: number }>): string
export declare function manifestEntries(text: string): Record<string, { sha512?: string; size?: number }>
export declare function signerCommonName(output: string): string | null
