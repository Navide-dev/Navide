export interface LockfileComparison {
  pnpmCount: number
  bunCount: number
  onlyPnpm: string[]
  onlyBun: string[]
  mismatched: string[]
}
export function pnpmPackages(text: string): Map<string, string>
export function parseBunLock(text: string): { packages?: Record<string, unknown[]> }
export function bunPackages(text: string): Map<string, string>
export function compareLockfiles(pnpmText: string, bunText: string): LockfileComparison
export function formatReport(result: LockfileComparison): string
