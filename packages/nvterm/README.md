# nvterm

A terminal emulator component for the web, written from public
specifications: a VT500-style parser, a screen model with compressed
scrollback, Canvas2D and WebGL2 renderers, and an input layer (keyboard,
IME, mouse, selection).

Status: pre-alpha, developed on the long-lived `feat/nvterm` branch of
Navide. Nothing here ships in Navide until the stability gate in the nvterm
plan passes.

## Layout

| Path | What |
|---|---|
| `src/` | The package. No runtime dependencies, no imports from Navide. |
| `tools/fixtures/` | Synthetic byte streams that imitate what CLI TUIs print. No real CLI output, no recordings of signed-in sessions. |
| `tools/golden/` | Feeds a fixture to two terminal drivers and diffs their screens cell by cell. |
| `tools/bench/` | Renderer-side throughput benchmark (parse MB/s per dataset). |

Read `CLEAN_ROOM.md` before contributing.

## License

MIT
