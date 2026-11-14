import type { UsageSnapshot } from '../../composables/useUsage'

/** Every kind of reading that is NOT a confirmed no-session account, crossed
 *  with every kind of limit sentence. Shared by the recorder and the pin. */
export const NOW = Date.parse('2026-11-01T08:00:00Z')

const session = (used: number) => ({ kind: 'session', label: 'Session (5h)', usedPercent: used, resetsAt: '2026-11-01T10:00:00Z' })
const weekly = (used: number) => ({ kind: 'weekly', label: 'Weekly (all models)', usedPercent: used, resetsAt: '2026-11-05T09:00:00Z' })
const model = (used: number) => ({ kind: 'weekly-model', label: 'Weekly (Opus)', usedPercent: used, resetsAt: '2026-11-05T09:00:00Z' })

const WINDOWS: Record<string, UsageSnapshot['windows']> = {
  none: [],
  'session-low': [session(30), weekly(40)],
  'session-spent': [session(100), weekly(40)],
  'weekly-spent': [session(30), weekly(100)],
  'session-expired': [{ ...session(100), expired: true }, weekly(40)],
  'session-no-reset': [{ ...session(30), resetsAt: null }, weekly(40)],
  'weekly-only-unconfirmed': [weekly(40)],
  'weekly-only-spent-unconfirmed': [weekly(100)],
  'model-spent': [session(30), weekly(40), model(100)],
}

/** The field can be there and still not confirm anything. */
const FIELD: Record<string, string[] | undefined> = {
  unset: undefined,
  empty: [],
  other: ['monthly'],
}

const STATES: Record<string, Partial<UsageSnapshot>> = {
  ok: {},
  stale: { stale: true },
  pending: { refreshPending: true },
}

export const MESSAGES: Record<string, string> = {
  nothing: 'all quiet',
  'session-clock': "You've hit your session limit · resets 4:30pm (Asia/Taipei)",
  'generic-clock': "You've hit your limit · resets 5pm (Asia/Taipei)",
  'weekly-clock': "You've hit your weekly limit · resets 5pm (Asia/Taipei)",
  'model-clock': "You've hit your weekly limit (Opus) · resets 5pm (Asia/Taipei)",
  dated: "You've hit your weekly limit · resets 2026-11-05 5pm (Asia/Taipei)",
  bare: "You've hit your usage limit",
}

export function cases(): Array<{ name: string; snapshot: Partial<UsageSnapshot>; message: string }> {
  const out: Array<{ name: string; snapshot: Partial<UsageSnapshot>; message: string }> = []
  for (const [w, windows] of Object.entries(WINDOWS)) {
    for (const [f, absentWindows] of Object.entries(FIELD)) {
      for (const [s, state] of Object.entries(STATES)) {
        for (const [m, message] of Object.entries(MESSAGES)) {
          out.push({
            name: `${w}/${f}/${s}/${m}`,
            snapshot: { windows, ...(absentWindows ? { absentWindows } : {}), ...state },
            message,
          })
        }
      }
    }
  }
  // The field names the session while the reading has one, or the read failed.
  for (const [w, windows] of Object.entries(WINDOWS)) {
    for (const [m, message] of Object.entries(MESSAGES)) {
      out.push({ name: `${w}/contradicted/${m}`, snapshot: windows.some((x) => x.kind === 'session') ? { windows, absentWindows: ['session'] } : { windows, absentWindows: ['session'], status: 'error' }, message })
    }
  }
  return out
}
