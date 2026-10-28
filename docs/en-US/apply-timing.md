# What takes effect when

Most changes in Navide apply at once. A few are read by a CLI only when it
starts, and a few need a restart of Navide itself. This page lists each one,
what applying it costs, and what never reloads in place.

## At a glance

| You change | Takes effect | What an open pane keeps or loses |
|---|---|---|
| Most settings (appearance, notifications, shortcuts, prompts) | At once, in every window | Nothing |
| Settings marked **New panes only** (for example the test-runner worker cap, leftover-server tracking) | In panes opened after the change | Open panes keep the old value until rebuilt |
| A CLI's own MCP servers (`~/.claude.json`, `~/.codex/config.toml`, …) | When that CLI next starts | Open panes keep the old list; they show **Settings changed** until rebuilt |
| Skills delivered to a CLI (Settings → Skills) | When that CLI next starts, or when the CLI rereads its skills on its own | Open panes may keep the old set; they show **Settings changed** until rebuilt |
| Navide's own MCP servers (Settings → MCP, servers Navide connects to) | At once: Navide reconnects to them | Nothing; CLI panes never read this list |
| The account a pane runs on | When the pane is reopened | Open panes keep their account until reopened |
| A Navide plugin update, **Restart Plugin**, going **Back to** a version | At once | The plugin's open views reload and lose what they had not saved |
| A Developer Mode folder's files | At once, after the new version reports ready; a failed version leaves the running one in place | The plugin's open views reload; a view that stores its state through the SDK gets it back |
| A Developer Mode folder's declared permissions or backend | After you consent again | The folder stays unloaded until you do |
| The Python backend (crash restart, or **Restart backend** in Settings) | At once | Every CLI pane's process and any turn in progress |
| Navide itself (quit and relaunch) | At once | Every CLI pane's process; panes that were working resume automatically (up to six), without continuing on their own |
| Reloading a window (⇧⌘R) | At once | Nothing in the CLIs; their processes keep running and reattach |

## Panes started before a change

A CLI reads its MCP servers and its skills once, when it starts. When either
changes after a pane started, the pane's title bar shows **Settings changed**,
and the MCP and Skills pages list those panes under the change, each with a
**Rebuild** button. **Rebuild all idle** rebuilds only the panes that are not
in the middle of a turn; a running pane stays listed and untouched until you
rebuild it yourself.

Rebuilding is the same as ⌘R: the pane closes and reopens on the same
conversation (`--resume`). It interrupts a turn in progress and reprints the
conversation. Navide never rebuilds a pane on its own.

How it is detected: when a pane starts, Navide records a fingerprint of the
MCP section of that CLI's own config file and of the skills delivered to it.
The MCP fingerprint covers each server's name, command, arguments and URL
(with secret-looking parts masked) and the names of its environment variables
and headers, never their values. Nothing else in the file counts, so the
account details `~/.claude.json` also holds never mark a pane. Navide compares it with the current
state every 30 seconds, when the window regains focus, and after a skills
change. Navide only reads these files and never writes to them. A CLI with no
such config, or a file Navide cannot read, never marks a pane.

## What never reloads in place

- Navide's main process, its preload, signature verification, and the plugin
  trust and consent flows. Changing these takes a relaunch.
- Account, credential and quota changes on a pane that is already open.
- A pane that is running. Navide does not rebuild one automatically.
