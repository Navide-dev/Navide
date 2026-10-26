type WhatsNewJsonText = Record<string, string>
export interface WhatsNewJsonEntry {
  version: string
  date?: string
  major?: true
  title: WhatsNewJsonText
  highlights: WhatsNewJsonText[]
  note?: WhatsNewJsonText
}
export interface WhatsNewJson {
  schemaVersion: number
  version: string
  entries: WhatsNewJsonEntry[]
}
export declare const WHATS_NEW_SCHEMA_VERSION: number
export declare function changelogDates(changelog: string): Record<string, string>
export declare function buildWhatsNewJson(
  entries: ReadonlyArray<{ version: string; major?: boolean; title: object; highlights: object[]; note?: object }>,
  options: { version: string; dates?: Record<string, string> },
): WhatsNewJson
