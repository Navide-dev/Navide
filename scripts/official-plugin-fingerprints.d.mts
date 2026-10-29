export interface FingerprintRecord {
  [pluginId: string]: { version: string; fingerprint: string }
}
export const RECORD_PATH: string
export const OFFICIAL_PLUGIN_SOURCES: Record<string, { directory: string; extra: string[] }>
export function fingerprint(root: string, pluginId: string): string
export function manifestVersion(root: string, pluginId: string): string
export function readRecord(root: string): FingerprintRecord
export function checkRecord(root: string, record?: FingerprintRecord): string[]
export function nextRecord(root: string, record?: FingerprintRecord): { record: FingerprintRecord; problems: string[] }
