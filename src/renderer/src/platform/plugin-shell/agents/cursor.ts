/** Cursor CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import { declared } from './_declared'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'cursor',
  // Label, command, flags and resume arguments: the launch declaration.
  //
  // Command: official docs and the install script both use `agent`;
  // `cursor-agent` is the legacy symlink the installer still creates. Users
  // can override the command. (Cursor is not installed locally — sourced from
  // https://cursor.com/docs/cli/reference/parameters and https://cursor.com/install.)
  //
  // Effort is encoded in the model id (`gpt-5.3-codex-high`), so there is no
  // separate flag and asking for one is refused. The bracket form
  // `model[effort=high]` that --help mentions has no official documentation
  // and is reported to fail; it is not offered here.
  //
  // Unattended: --force (official alias --yolo) auto-approves all commands.
  ...declared('cursor'),
  needsSessionMarker: true,
  // Executable is `agent` (the installer also creates the legacy
  // `cursor-agent`); accept both, `=` and space forms, so a command saved by
  // an older build still reads as a resume rather than a custom command.
  resumeCommandPattern: /^(?:cursor-)?agent\s+--resume(?:=|\s+)\S+/,
  supportsRebuild: true,
  hint: 'generalist',
  // Quota failover: cursor.py reports the plan "cycle" and, when enabled, an
  // "on-demand" pool that keeps requests flowing once the cycle is spent.
  quotaSemantics: { hard: ['cycle'], required: ['cycle'], alternate: ['on-demand'] },
} as const satisfies AgentSpec
