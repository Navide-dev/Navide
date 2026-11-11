// Keyboard shortcuts as the Help pages show them: read from the live bindings
// (defaults for this platform plus the user's own rules), so a re-bound key or
// a Windows/Linux key shows what actually works instead of a hard-coded ⌘ glyph.
import { buildRows, formatKeySpec, getUserRules, isMacPlatform } from '@navide/plugin-ui/shared'

const usesMeta = (spec: string): boolean => /\b(cmd|meta)\b/.test(spec)

// A key bound to `command`, or '—' when the user has unbound it. `prefer`
// picks one of several bindings when the command still has it. Off macOS a
// `cmd` rule means the Win/Super key, which the OS keeps for itself, so a
// binding without it is preferred when the command has one.
export function helpKey(command: string, prefer?: string): string {
  const mac = isMacPlatform()
  const specs = buildRows(getUserRules())
    .filter((r) => r.command === command)
    .flatMap((r) => r.keys)
    // A key the user added is the one they will look for, so it comes first.
    .sort((a, b) => Number(b.source === 'user') - Number(a.source === 'user'))
    .map((k) => k.key)
  const spec = (prefer && specs.includes(prefer) && (mac || !usesMeta(prefer)) ? prefer : undefined)
    ?? (mac ? specs[0] : (specs.find((s) => !usesMeta(s)) ?? specs[0]))
  return spec ? formatKeySpec(spec) : '—'
}

// A fixed spec rendered for this platform. Use it for keys that are not
// rebindable rules — menu accelerators ('mod+o' reads ⌘O on macOS, Ctrl+O
// elsewhere) and keys the CLI or terminal owns.
export function helpKeySpec(spec: string): string {
  return formatKeySpec(spec)
}
