export interface HelpUploadPlan {
  id: string
  locale: string
  file: string
  fileName: string
  contentType: string
  key: string
}
export interface HelpManifest {
  schemaVersion: number
  shots: Record<string, Record<string, string>>
}
export declare const DEFAULT_BUCKET: string
export declare const HELP_PREFIX: string
export declare const CACHE_CONTROL: string
export declare function assertHelpKey(key: string): string
export declare function planUploads(dir: string): HelpUploadPlan[]
export declare function putObjectArgs(plan: HelpUploadPlan, bucket?: string): string[]
export declare function mergeManifest(manifest: HelpManifest, plans: HelpUploadPlan[]): HelpManifest
