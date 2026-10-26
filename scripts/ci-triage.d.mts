export type TriageCategory = 'environment' | 'test-race' | 'needs-review' | 'product-defect'

export interface TriageEntry {
  test: string
  category: TriageCategory
  evidence: string
}

export interface TriageRun {
  run: number
  job: string
  pr: number
  at: string
}

export function classifyLog(text: string, options?: { knownRaces?: Set<string> }): TriageEntry[]
export function mergeIntoLedger(path: string, entries: TriageEntry[], run: TriageRun): unknown
export function splitJobLogs(text: string, job: string): { job: string, text: string }[]
