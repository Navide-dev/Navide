/** The By Group rows of the token panel, as structure only.
 *
 *  One row per sidebar run group in sidebar order, then a synthetic row for
 *  ungrouped usage, then one row folding together every bucket whose group
 *  record no longer exists. Groups that spent nothing still get a zero row —
 *  the sidebar lists them, so the panel does too; the two synthetic rows
 *  only appear when they have something to say.
 */

import type { TokenBucket } from '../composables/useTokens'
import { groupLabel } from './stageTabs'

export interface TokenGroupLike {
  id: string
  name: string
}

export interface TokenGroupRow {
  key: string
  label: string
  bucket: TokenBucket
}

const EMPTY: TokenBucket = { input: 0, output: 0, calls: 0 }

function isZero(b: TokenBucket): boolean {
  return b.input === 0 && b.output === 0 && b.calls === 0
}

export function buildTokenGroupRows(
  groups: readonly TokenGroupLike[],
  byGroup: Record<string, TokenBucket>,
  labels: { manual: string; orphan: string; default: string },
): TokenGroupRow[] {
  const rows: TokenGroupRow[] = groups.map((g) => ({
    key: g.id,
    label: groupLabel(g, labels.default),
    bucket: byGroup[g.id] ?? EMPTY,
  }))

  const manual = byGroup['']
  if (manual && !isZero(manual)) {
    rows.push({ key: 'manual', label: labels.manual, bucket: manual })
  }

  const known = new Set(groups.map((g) => g.id))
  const orphan: TokenBucket = { input: 0, output: 0, calls: 0 }
  for (const [id, b] of Object.entries(byGroup)) {
    if (id === '' || known.has(id)) continue
    orphan.input += b.input
    orphan.output += b.output
    orphan.calls += b.calls
  }
  if (!isZero(orphan)) {
    rows.push({ key: 'orphan', label: labels.orphan, bucket: orphan })
  }

  return rows
}
