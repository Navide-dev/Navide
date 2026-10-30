# Clean-room rules

nvterm is written from public specifications only. These rules bind every
person and every agent that writes code, tests or fixtures for this package.

## Forbidden sources

Do not open, read, search or paste the source code of any other terminal
emulator or terminal library, including but not limited to:

- xterm.js and every `@xterm/*` package (this includes the implementation
  files under `node_modules/@xterm/`)
- Ghostty / libghostty, libvterm, VTE, Alacritty, WezTerm, kitty, hterm,
  iTerm2, Windows Terminal / conhost, st, urxvt, mintty, Terminal.app

Do not copy their type declarations (`.d.ts`) either. Write our own.

## Allowed sources

- ECMA-48 (5th edition) and ISO/IEC 6429
- DEC STD 070 and the VT100 / VT220 / VT320 / VT420 / VT510 / VT520
  programmer and user manuals (for example as published on vt100.net)
- Paul Williams' description and state diagram of the DEC ANSI-compatible
  (VT500-series) parser on vt100.net
- Thomas Dickey's "XTerm Control Sequences" document (`ctlseqs`)
- Unicode: UAX #11 (East Asian Width), UAX #29 (text segmentation),
  UTS #51 (emoji) and the Unicode Character Database data files
- Public write-ups of protocols: OSC 8 hyperlinks, synchronized output
  (mode 2026), bracketed paste, SGR mouse reporting
- The public API documentation of xterm.js, only to keep the shape of the
  compatibility layer the same as what Navide calls today
- Release notes and blog posts that describe techniques in prose (for
  example the Ghostty 1.4.0 release notes)

## xterm.js as a black-box oracle

The golden comparison tool under `tools/golden/` may run xterm.js as a black
box: feed it bytes and read results through its public API. That use stays in
`tools/`; `src/` must never import `@xterm/*`, and `package.json` must never
depend on it. `src/boundary.test.ts` enforces both.

## External test programs

vttest, esctest and similar suites are run as external programs only. They
are never vendored into this repository. Record each tool's license here
before first use:

| Tool | License | Checked on |
|---|---|---|
| vttest | BSD (the maintainer's page, invisible-island.net/vttest, says the original author agreed in 2007 to change it to a BSD license; Fedora packages it as MIT). Permissive, but still run as an external program only. | 2026-10-30 |
| esctest (gnachman/esctest, ThomasDickey/esctest2, freedesktop terminal-wg/esctest) | GPL-2.0 (shown on both GitHub repositories). Run it as an external program only. Never copy its code or test cases into this MIT package, and never port its assertions one by one; write our own cases from the specifications. | 2026-10-30 |

## Provenance in commits

Every commit that adds behaviour names the specification sections it follows
in its message, for example `Spec: ECMA-48 8.3.21 (CUP); DEC STD 070 DECSTBM`.
