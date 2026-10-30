# Keyboard Shortcuts Reference

This Mini-IDE's keybindings align with VS Code / Cursor conventions.
All rules are defined in `packages/plugin-ui/src/shared/keybindings/defaults.ts` and resolved
via `useKeybindings` (capture-phase), with support for chord keys (e.g. `⌘K ⌘K`)
and when-clause conditions.

> **macOS symbols:** `⌘` Cmd · `⌥` Option/Alt · `⌃` Ctrl · `⇧` Shift · `↩` Enter
>
> On Windows and Linux, `⌥` reads as **Alt**. Menu items with accelerators (copy, paste, Settings, New Window, Open Workspace, Lock Now, close window) follow the platform and answer **Ctrl** there. The rules in the table below are written for macOS: their `⌘` resolves to the **Win/Super** key off macOS, not Ctrl, so Windows and Linux users should re-record the ones they need in **Settings → Shortcuts** — the recorder writes a plain `ctrl+…` rule.
>
> Two exceptions are bound for Windows and Linux out of the box. The main window's sidebar tabs answer **Ctrl+Alt+1–5** (Ctrl+1–9 already picks the CLI type for the next pane), and Settings answers **Ctrl+,**. Ctrl+Alt is AltGr on Windows: on a layout where AltGr+digit types a character (German `²` `³`, for example), that digit types the character and does not switch tabs.
>
> The built-in plugin windows are bound for Windows and Linux too: Open Plans answers **Ctrl+Shift+D**, the Git window **Ctrl+Shift+G** and Navide Browser **Ctrl+Shift+X**, the same letters as on macOS. The Mini IDE answers **Ctrl+Shift+M**, not Ctrl+Shift+I: off macOS Ctrl+Shift+I is the View menu's Toggle Developer Tools accelerator, which fires before any shortcut rule and keeps working as before, and Ctrl+Alt+I is not used because Ctrl+Alt is AltGr on Windows.

> While the App Lock screen is up, no shortcut runs: keys never reach the windows underneath, and every menu item is greyed out except Hide, Quit, the window controls and the editing keys the PIN box needs (paste, select all, undo). Toggle Developer Tools is greyed out too, so ⌥⌘I (Ctrl+Shift+I) does nothing; DevTools already open stays open. They all come back on unlock.

Every binding below can be changed in **Settings → Shortcuts**; see
[Customizing shortcuts](#customizing-shortcuts) for the file format and the
rules the editor writes.

---

## Workbench

### File Operations

| Shortcut | Action |
|----------|--------|
| `⌘S` | Save current file |
| `⌘⇧S` | Save all |
| `⌘W` | Close active editor; close the focused CLI pane in the main window (confirms first — a running pane always asks, an idle one asks unless the user ticked "don't show again", restorable under Settings → General); close the open modal while one is open |
| `⌘⇧W` | Close the current window |
| `⌘K ⌘W` | Close all editors |
| `⌘O` | Open file |
| `⌘N` | New file |
| `⌘⇧N` | New window |
| `⌘⇧T` | Reopen closed editor |

### Panels & Sidebar

| Shortcut | Action |
|----------|--------|
| `⌘B` | Toggle sidebar |
| `⌘⇧E` | Focus Explorer |
| `⌘⇧G` (Windows/Linux: `Ctrl+Shift+G`) | Open the Git window when Git is active; focus a Source Control view where a window owns one, such as the legacy Mini IDE editor window (when find is closed) |
| `⌘⇧I` (Windows/Linux: `Ctrl+Shift+M`) | Open the Mini IDE window |
| `⌘⇧D` (Windows/Linux: `Ctrl+Shift+D`) | Open Plans |
| `⌘⇧X` (Windows/Linux: `Ctrl+Shift+X`) | Open Navide Browser |
| `⌥⌘V` | Focus the right rail's Preview panel (main window) |
| `⌘J` | Toggle AI Terminal panel |
| `⌘⇧A` | Toggle AI Terminal panel |
| `` ⌃` `` | Toggle AI Terminal panel |
| `⌘⇧U` | Open Agent |
| `⌘R` / `⌘⇧B` | Rebuild the focused pane (resume) |
| `⌘⇧R` | Reload the window (Git window: refresh) |
| `⌘⇧L` | Open Debug (backend log, shell, AI) — outside the Mini IDE, where this chord belongs to the editor |
| `Escape` / `⌘W` | Close modal dialog (⌘W also works with focus in an embedded terminal, where Escape belongs to the CLI) |

### Voice Input

Only while **Settings → General → Voice input** is on (off by default); with it
off the chord is not consumed and reaches the focused terminal as before.

| Shortcut | Action |
|----------|--------|
| `⌃⌥M` (hold) | Dictate into the focused CLI pane (the recording mode in Settings decides hold, tap-to-lock or press-to-toggle). The words appear in the capsule as you speak; when the take ends this way, the text is typed into the pane's input box like a paste — it is **not** sent: review it and press Enter yourself. It goes straight to the pane, even while the CLI is busy. Releasing any key of the chord stops a held take. `⌘` chords only in the press-to-toggle mode: macOS drops the key-up of a key held with Cmd, so a held `⌘` chord could never be released |
| `Escape` | During a take only: cancel the recording or its transcription; nothing is typed in. Not a rule in the table — it is only listened for while a take records or transcribes |
| `Enter` | During a take only, with its pane focused: end it and **send** — once the final text is typed in, Enter is pressed for you (after the paste, as if you typed it). Works while the take is starting, recording or transcribing, and is handiest hands-free: speak, then Enter. Nothing is sent when nothing was heard or the pane cannot take the text; if the text went in but its Enter could not follow (the paste was not confirmed within a few seconds), the capsule says so and the text waits in the input box for your own Enter. An Enter that confirms an IME candidate, or one with a modifier, is left alone. Like Esc, not a rule in the table; once the take is over, Enter reaches the CLI as usual |

Once the capsule shows an error, Esc is left alone so it still interrupts the
CLI as usual; the error closes with its **✕** or by itself after a few seconds.
A pane that is asleep (not yet started) refuses dictation — open it first.

The chord can also be changed in **Settings → Voice Input → Shortcut**, which
edits the same rule as the Shortcuts tab. It takes one key combination, and a
single key works too:

| Accepted | Refused |
|----------|---------|
| A function key on its own (`F13`–`F19` are unused by macOS and ideal; `F1`–`F24` all work) | A key that types or edits — a letter, digit, space, punctuation, `Enter`, `Tab`, `Backspace`, `Delete`, `Escape` — with no `⌃`, `⌥` or `⌘` (`⇧` alone still types). Holding it would type into the CLI, and Enter / Esc already mean send / cancel |
| One modifier by itself, left or right side told apart: `Right ⌥`, `Left ⌃`, `Right ⇧`, `Left ⌘`, `Right ⌘`… (recorded by pressing and releasing it alone), in every mode | `⌘` in a combination while the recording mode is "Hold to talk" or "Hold, or tap to lock": macOS drops the key-up of a key held with Cmd, so the take could never be let go of |
| `fn` (🌐) by itself, on a Mac (recorded by pressing and releasing it alone; see below) | |
| Other non-printing keys (`Home`, `PageDown`, arrows…) and any combination with `⌃` or `⌥` | |
| A combination with `⌘` (`⌘⇧D`…), **only while the recording mode is "Press to start, press again to stop"**: that mode needs no key-up — the second press, a key-down, stops the take, and key repeat is ignored | A `⌘` combination another Navide command already has — the row names it. `⌘⇧D` is Open Plans by default: unbind that under Shortcuts first to use it here |
| | A chord macOS keeps for itself — `⌘Q`, `⌘W`, `⌘H`, `⌥⌘H`, `⌘M`, `⌘Tab`, `⌘Space`, `` ⌘` ``, `⌘,`, `⇧⌘Q`, `⌃⌘Q`, `⌥⌘Esc`, `⌃⌘F`, `⌥⌘D`, `⇧⌘3`/`4`/`5`… — named with what macOS does with it, and any key the application menu takes before Navide sees it |

When a key is refused, the row offers two or three free keys that do work in
the current recording mode — near the refused one first (its letter under other
modifiers; `⌘` ones only in toggle mode), then `F13`–`F19` and a lone right
modifier — none bound to any command, reserved by macOS or taken by the menu.
One click saves it.

The recording mode is checked live. Switching it from toggle to a hold mode
while the shortcut is a `⌘` chord does **not** change the binding: the row
warns that it will not stop a held take and offers **Reset to default** and
**Rebind** (or switch the mode back).

A lone modifier cannot tell on key-down whether it will be held alone or used
for a combination. A lone `⌥` or `⇧` starts the take at once, and drops it
quietly — nothing typed, no error — the moment another key goes down while it
is held (`Right ⌥` + `E` still types `é`). A lone `⌘` or `⌃` starts every
shortcut of its own (`⌘C`, `⌘S`, `⌘K ⌘S`, `⌃C`…), so it waits: the take (and
the mic) starts only once the modifier has been held **by itself for 300 ms**,
and letting go of it ends the take. Any other key pressed while it is down —
before or after those 300 ms — is left to its shortcut, untouched, and the
take is dropped quietly; nothing starts again until the modifier is let go.
Switching apps with `⌘Tab` while such a take runs cancels it. A quick tap of
it (let go within 350 ms, nothing else pressed) follows the recording mode:
"Hold, or tap to lock" locks a hands-free take, "Press to start, press again
to stop" starts or stops one, "Hold to talk" does nothing. Binding both sides
(two rules, `leftcmd` and `rightcmd`) makes either one work. In rule files a
lone modifier is written `leftctrl`, `rightctrl`, `leftalt`, `rightalt`,
`leftshift`, `rightshift`, `leftcmd`, `rightcmd`; it is recorded in the voice
row or on the hold-to-talk row of the Shortcuts tab. A key refused here can
still be written into `keybindings.json` or the Shortcuts tab; the voice row
then shows a warning.

#### The fn (🌐) key (macOS)

fn is an ordinary dictation key: record it in **Settings → Voice Input →
Shortcut → Change** (or on the hold-to-talk row of the Shortcuts tab) by
pressing and releasing fn by itself. It is saved as the rule key `fn`, shown
as `fn 🌐`, and behaves exactly like any other key: hold to talk, and a quick
tap follows the recording mode. It can sit next to another key (`⌃⌥M` and
`fn` both bound) or replace it.

The browser never receives fn, so Navide runs a small native helper
(`Contents/Resources/bin/navide-fn-key`) with a listen-only event tap — only
while voice input is on and hold-to-talk is bound to fn, and while a
hold-to-talk recorder is listening for a new key. Unbinding fn, turning voice
input off, or quitting stops it.

- Only a **lone** fn press counts: fn pressed with another key or modifier
  (fn+arrow, fn+Delete, ⌃fn…) drops the take and starts nothing. In the
  recorder the same press records the key fn produced (`Home`, `Delete`…),
  never fn.
- A press is taken only while a Navide window has focus and the rule's `when`
  holds (not while a dialog such as Settings is open, and never while a
  shortcut recorder is listening); fn's own release ends it (window blur does
  not). `fn` never matches a key event, so it cannot be a command key.
- It needs **Input Monitoring** (System Settings → Privacy & Security → Input
  Monitoring). Without it, both the recorder (as soon as it starts listening)
  and the fn status row below the shortcut say so and offer the settings pane
  and a re-check.
- If **System Settings → Keyboard → "Press 🌐 key to"** is anything but
  **Do Nothing**, macOS also switches the input source / opens Emoji /
  starts Dictation on every press; the fn status row points this out.
- Off macOS fn cannot be detected at all; the recorder says so.
- The helper is built by `pnpm build` and, in a source checkout, by `pnpm dev`
  (`node scripts/build-fn-key-helper.mjs --if-needed`: rebuilt when missing or
  older than `native/fn-key/`; a failed build only warns). A copy without the
  helper says the helper is missing instead of ignoring fn.
- The old **Use the fn (🌐) key** switch is gone. If it was on, fn counts as
  bound until Settings → Voice Input is next opened, which adds `fn` next to
  the current shortcut and turns the old setting off.

#### While recording a shortcut

Every key press while a recorder listens gets an answer: the key is recorded,
or a line under the recorder says why it was not — a key the dictation row
refuses (with the reason and free alternatives, at once rather than on Save),
an input method composing, a key with no usable name, a modifier still held
(add a key, or let go to use it alone where that is allowed), or a lone
modifier on a row that cannot take one. Keys the system keeps for itself
(`⌘Tab`, `⌘Space`…) never reach Navide; the recorder says that up front.

### Quick Open

| Shortcut | Action |
|----------|--------|
| `⌘P` | Quick open file |
| `⌘⇧P` / `F1` | Command palette |
| `⌘⇧O` | Go to symbol in file |
| `⌘T` | Go to symbol in workspace (scans all open files) |
| `⌘L` / `⌃G` | Go to line |

### Settings

| Shortcut | Action |
|----------|--------|
| `⌘,` | Open settings |
| `⌘K ⌘S` | Open keyboard shortcuts |
| `⌘K ⌘T` | Select theme |
| `⌘K ⌘M` | Change language mode |

### Font Zoom

| Shortcut | Action |
|----------|--------|
| `⌘=` | Zoom in |
| `⌘-` | Zoom out |
| `⌘0` | Reset zoom |

### Interface Zoom

Scales the whole app chrome (Electron page zoom), not just a font. The shifted
forms of the font-zoom chords above.

| Shortcut | Action |
|----------|--------|
| `⌘⇧=` | Interface zoom in |
| `⌘⇧-` | Interface zoom out |
| `⌘⇧0` | Interface zoom reset |

---

## Editor Tabs

| Shortcut | Action |
|----------|--------|
| `⌃Tab` | Next editor |
| `⌃⇧Tab` | Previous editor |
| `⌘⇧]` | Move tab right |
| `⌘⇧[` | Move tab left |
| `⌘1` – `⌘9` | Jump to tab 1–9 |

---

## Navigation

| Shortcut | Action |
|----------|--------|
| `⌃-` | Navigate back |
| `⌃⇧-` | Navigate forward |
| `⌘K ⌘Q` | Go to last edit location |
| `F12` | Open imported file at cursor (go to definition) |
| `⇧F12` | Find all references |
| `F2` | Rename symbol (select all occurrences) |

---

## Search & Replace

| Shortcut | Action | Condition |
|----------|--------|-----------|
| `⌘F` | Open find | editor open |
| `⌘E` | Use selection as find term | editor open |
| `⌘H` | Open replace | editor open |
| `⌘⇧F` | Find in files | — |
| `⌘⇧H` | Find and replace in files | — |
| `⌘G` / `F3` | Next match | find open |
| `⌘⇧G` / `⇧F3` | Previous match | find open |

---

## Cursor Movement

### Basic Navigation

| Shortcut | Action |
|----------|--------|
| `⌘↑` | Go to file start |
| `⌘↓` | Go to file end |
| `Home` | Go to line start (smart: first non-whitespace, then col 0) |
| `End` | Go to line end |
| `⌃Home` | Go to file start (cross-platform alias for `⌘↑`) |
| `⌃End` | Go to file end (cross-platform alias for `⌘↓`) |
| `⌥←` | Move word left |
| `⌥→` | Move word right |
| `⌃↑` | Scroll view up one line (cursor stays) |
| `⌃↓` | Scroll view down one line (cursor stays) |
| `PageUp` | Page up |
| `PageDown` | Page down |

### Navigation with Selection

| Shortcut | Action |
|----------|--------|
| `⌘⇧↑` | Select to file start |
| `⌘⇧↓` | Select to file end |
| `⇧Home` | Select to line start |
| `⇧End` | Select to line end |
| `⌃⇧Home` | Select to file start (cross-platform) |
| `⌃⇧End` | Select to file end (cross-platform) |
| `⌃⇧←` | Select word left (Windows/Linux style) |
| `⌃⇧→` | Select word right (Windows/Linux style) |

---

## Selection

| Shortcut | Action |
|----------|--------|
| `⌘A` | Select all |
| `⌃L` | Select current line |
| `⌘⇧L` / `⌘F2` | Select all occurrences |
| `⌘D` | Add selection to next find match |
| `⌘K ⌘D` | Move selection to next find match (skip) |
| `⇧⌥←` | Shrink smart selection |
| `⇧⌥→` | Expand smart selection |
| `⌘⇧\|` | Jump to matching bracket |

### Multi-cursor

| Shortcut | Action |
|----------|--------|
| `⌘⌥↑` | Add cursor above |
| `⌘⌥↓` | Add cursor below |
| `⇧⌥I` | Add cursors to end of each selected line |

> Any arrow key, Home, End, PageUp/Down, or Undo clears all extra cursors.

---

## Editing

### Basic

| Shortcut | Action |
|----------|--------|
| `⌘Z` | Undo |
| `⌘⇧Z` / `⌘Y` | Redo |
| `⌘↩` | Insert line below |
| `⌘⇧↩` | Insert line above |
| `⌃T` | Transpose characters around cursor |

### Line Operations

| Shortcut | Action |
|----------|--------|
| `⌥↑` | Move line(s) up |
| `⌥↓` | Move line(s) down |
| `⇧⌥↑` | Copy line(s) up |
| `⇧⌥↓` | Copy line(s) down |
| `⌘⇧K` | Delete line |
| `⌃J` | Join next line onto current line |

### Indentation

| Shortcut | Action |
|----------|--------|
| `⌘]` | Indent line(s) |
| `⌘[` | Outdent line(s) |
| `Tab` (with selection) | Indent selected lines |
| `⇧Tab` (with selection) | Outdent selected lines |

### Deletion

| Shortcut | Action |
|----------|--------|
| `⌥Backspace` | Delete word left |
| `⌥Delete` | Delete word right |
| `⌘Backspace` | Delete to line start |
| `⌘Delete` | Delete to line end |

---

## Code Folding

| Shortcut | Action |
|----------|--------|
| `⌘⌥[` | Fold block at cursor |
| `⌘⌥]` | Unfold block at cursor |
| `⌘K ⌘[` | Fold recursively (fold cursor block and all children) |
| `⌘K ⌘]` | Unfold recursively |
| `⌘K ⌘0` | Fold all |
| `⌘K ⌘J` | Unfold all |
| `⌘K ⌘1` | Fold to level 1 |
| `⌘K ⌘2` | Fold to level 2 |
| `⌘K ⌘3` | Fold to level 3 |
| `⌘K ⌘4` | Fold to level 4 |
| `⌘K ⌘5` | Fold to level 5 |
| `⌘K ⌘6` | Fold to level 6 |
| `⌘K ⌘7` | Fold to level 7 |

> Fold ranges are detected by indentation. A foldable line has at least one following line with greater indentation. Folded blocks show `…` at the end of the fold-start line. Click the `▶/▼` gutter icon to toggle folding.

---

## Comments

| Shortcut | Action |
|----------|--------|
| `⌘/` | Toggle line comment |
| `⌘⌥/` / `⇧⌥A` | Toggle block comment (`/* ... */`) |
| `⌘K ⌘C` | Add line comment |
| `⌘K ⌘U` | Remove line comment |

---

## Formatting

| Shortcut | Action |
|----------|--------|
| `⇧⌥F` | Format document (JSON gets pretty-printed) |
| `⌘K ⌘F` | Format selection |
| `⌘K ⌘X` | Trim trailing whitespace |

---

## Editor Groups (Split Editor)

| Shortcut | Action |
|----------|--------|
| `⌘\` | Split editor (opens current file in secondary group) |
| `⌘K ⌘←` | Focus previous editor group |
| `⌘K ⌘→` | Focus next editor group |

> Close all tabs in the secondary group to dismiss it. Click inside a group to make it active.

---

## Problems Panel

| Shortcut | Action |
|----------|--------|
| `⌘⇧M` | Show Problems panel |
| `F8` | Go to next problem |
| `⇧F8` | Go to previous problem |

> Diagnostics come from AI Code Review findings and JSON parse errors detected on format. Affected lines show `●` (error) or `▲` (warning) in the gutter.

---

## Code Intelligence

| Shortcut | Action |
|----------|--------|
| `⌘.` | Quick Fix — shows AI Fix options for the current line's diagnostics |

---

## Text Transforms (Command Palette only)

Run these via `⌘⇧P`. No default keybinding.

| Command | Action |
|---------|--------|
| Transform to Uppercase | UPPERCASE |
| Transform to Lowercase | lowercase |
| Transform to Title Case | Title Case |
| Transform to Snake Case | snake_case |
| Transform to Camel Case | camelCase |
| Transform to Kebab Case | kebab-case |
| Transform to Pascal Case | PascalCase |
| Transform to Base64 | Base64-encode selection |
| Transform from Base64 | Base64-decode selection |
| URL Encode Selection | Percent-encode selection |
| URL Decode Selection | Percent-decode selection |
| Sort Lines Ascending | Sort selected lines A → Z |
| Sort Lines Descending | Sort selected lines Z → A |
| Reverse Lines | Reverse order of selected lines |
| Remove Duplicate Lines | Remove duplicate lines in selection |
| Join Lines | Merge lines into one (same as `⌃J`) |

---

## Line Endings & Indentation (Command Palette only)

| Command | Action |
|---------|--------|
| Change End of Line to CRLF | Switch to Windows line endings |
| Change End of Line to LF | Switch to Unix/macOS line endings |
| Convert Indentation to Spaces | Replace tab indents with spaces |
| Convert Indentation to Tabs | Replace space indents with tabs |

> The current EOL and indentation settings are also shown in the status bar at the bottom of the editor — click to toggle.

---

## AI Features

| Shortcut | Action |
|----------|--------|
| `⌘I` / `⌃Space` | Trigger AI inline completion (Ghost Text) |
| `⌘K ⌘K` / `⌃⇧I` | AI inline rewrite (select code, then type instruction) |
| `⌘⇧A` / `⌘J` / `` ⌃` `` | Open / close AI Terminal panel |
| `⌘⇧L` | Add current selection or word to the AI Terminal prompt (when editor is open but text area is not focused) |
| `Tab` (Ghost Text visible) | Accept full AI suggestion |
| `→` (Ghost Text visible) | Accept one character of AI suggestion |
| `⌘→` / `⌥→` (Ghost Text visible) | Accept one word of AI suggestion |

---

## File Utilities

| Shortcut | Action |
|----------|--------|
| `⌘K ⌘P` | Copy absolute file path |
| `⌘⇧⌥C` | Copy relative file path |
| `⌘K ⌘R` | Reveal file in Explorer sidebar |
| `⇧⌥R` | Reveal file in Finder |
| `F12` | Open imported/required file at cursor |
| `⌘⌥↩` | Open URL under cursor in browser |
| `⌘K ⌘Z` | Toggle Zen Mode (hides sidebar and tab bar) |
| `⌘K ⌘L` | Toggle line numbers |
| `⌘K ⌘E` | Focus active editor |
| `⌘K ⌘O` | Open folder |

---

## Git Window

Only active in the standalone Git window (`gitWindow` context). Every shortcut
here yields to the window's AI terminal while it has focus, and stays inert
while an operation is running or the folder is not a repository — the same
condition that greys out the matching toolbar button.

| Shortcut | Action |
|----------|--------|
| `F5` / `⌘⇧R` | Refresh status, log, branches, remotes, tags, stashes, worktrees |
| `⌘↩` | Commit staged changes |
| `⌘⇧↩` | Amend the last commit |
| `⌘⇧M` | Generate the commit message with AI |
| `⌘⇧A` | Stage all changes |
| `⌘⇧U` | Unstage all staged files |
| `⌘⇧F` | Fetch |
| `⌘⇧L` | Pull |
| `⌘⇧P` | Push |
| `⌘⇧S` | Sync (pull then push) |
| `⌘L` | Open and focus the AI terminal dock |

---

## Chord Key Reference (`⌘K …`)

`⌘K` is a chord prefix. In editor text focus, pressing `⌘K` enters chord mode (300 ms timeout); the next key completes the command.

| Prefix | Second Key | Action |
|--------|-----------|--------|
| `⌘K` | `⌘K` | AI inline rewrite |
| `⌘K` | `⌘C` | Add line comment |
| `⌘K` | `⌘U` | Remove line comment |
| `⌘K` | `⌘X` | Trim trailing whitespace |
| `⌘K` | `⌘F` | Format selection |
| `⌘K` | `⌘M` | Change language mode |
| `⌘K` | `⌘P` | Copy absolute path |
| `⌘K` | `⌘R` | Reveal in Explorer |
| `⌘K` | `⌘S` | Keyboard shortcuts settings |
| `⌘K` | `⌘T` | Select theme |
| `⌘K` | `⌘Z` | Toggle Zen Mode |
| `⌘K` | `⌘O` | Open folder |
| `⌘K` | `⌘E` | Focus editor |
| `⌘K` | `⌘L` | Toggle line numbers |
| `⌘K` | `⌘Q` | Go to last edit location |
| `⌘K` | `⌘D` | Move to next find match (skip) |
| `⌘K` | `⌘W` | Close all editors |
| `⌘K` | `⌘[` | Fold recursively |
| `⌘K` | `⌘]` | Unfold recursively |
| `⌘K` | `⌘0` | Fold all |
| `⌘K` | `⌘J` | Unfold all |
| `⌘K` | `⌘1`–`⌘7` | Fold to indentation level 1–7 |

---

## When-Clause Conditions

Keybindings can be gated by context conditions. These nine are the whole set —
every condition any rule tests, and every one any window publishes.

**Window identity.** No window ever sets two of these, which is what lets the
same key mean different things in different windows (`⌘⇧G` is `openGitWindow` in
the main window and `focusSourceControl` in a window that owns a Source Control
view, such as the legacy Mini IDE editor window). Settings' conflict
detection relies on it: without knowing the two can never meet, almost every
shared key would report as broken.

| Condition | Set by | True in |
|-----------|--------|---------|
| `paneStage` | main window | The workspace window with the CLI panes |
| `editorOpen` | Mini IDE | At least one editor tab is open — also how a rule says "the Mini IDE" |
| `gitWindow` | Git window | The standalone Git window |
| `planWindow` | Plan window | The standalone plan review window |

**Transient state.** Unlike the identities, these come and go while a window
stays open, so a rule that waits on one is not dead — it just waits.

| Condition | Description |
|-----------|-------------|
| `editorTextFocus` | The editor text area has keyboard focus |
| `findOpen` | The find widget is currently open |
| `modalOpen` | A modal dialog is currently open |
| `terminalFocus` | A terminal has focus — ESC and friends belong to the PTY |
| `voiceInput` | Voice input is switched on in Settings (main window only) |

Conditions support `&&` (and), `||` (or), `!` (not); `!editorTextFocus` reads as
"the editor is there but the text area does not have focus". There are no
parentheses and no comparisons — `&&` simply binds tighter than `||`, and an
unknown identifier evaluates to `false`, so a typo silently disables the rule
rather than reporting anything. The Settings editor therefore shows `when`
read-only; to write a new condition, edit `keybindings.json` by hand.

---

## Customizing shortcuts

**Settings → Shortcuts** (also reachable with `⌘K ⌘S`) lists every command as
one row per (command, `when`) pair. Click a key cap to record a replacement, `+` to add a
second binding, `✕` to remove one, and `↺` to restore that row's defaults.
Overrides are written to `keybindings.json` in the Electron `userData`
directory and broadcast to every open window, so they apply without a restart.

### File format

The file is a flat array of the same `KeybindingRule` shape `defaults.ts` uses.
Later rules win over earlier ones, and user rules are appended after the
defaults:

```jsonc
[
  // cancel the shipped binding…
  { "key": "cmd+s", "command": "-editor.action.save", "when": "editorOpen && !terminalFocus" },
  // …and put the command somewhere else
  { "key": "cmd+alt+s", "command": "editor.action.save", "when": "editorOpen && !terminalFocus" }
]
```

A command prefixed with `-` is a **removal**: it cancels the rule that binds
that same key to that same command. Removal is deliberately narrow rather than
"blank the key", because several keys carry more than one command separated
only by their `when` clause — `⌘⇧G` is `focusSourceControl` in the legacy Mini
IDE editor window and `openGitWindow` in the main window, and unbinding one must
not take the other down with it. Removals are matched on the canonical form of
the key, so
`shift+cmd+p` and `cmd+shift+p` refer to the same binding.

A malformed entry is skipped rather than discarding the whole file.

### Commands with no default key

The list is generated from a static command manifest (`COMMAND_IDS` in
`commandCatalog.ts`) joined with `defaults.ts`, not from `defaults.ts` alone —
about a quarter of the app's commands ship with no key, and those are exactly
the ones worth binding. They appear as `unassigned` and can be given a key like
any other row. `commandManifest.test.ts` scans the source and fails if the
manifest and the `registerCommand` calls drift apart.

### Import / export

**Export** writes the current overrides to a file you choose. **Import**
replaces them wholesale, after checking every entry: a rule whose key is
malformed, whose chord has three segments, or whose command this build does not
have is listed as rejected rather than dropped quietly.

### Protected shortcuts

`workbench.action.openSettings` and `workbench.action.openKeyboardShortcuts`
must keep at least one binding — removing the last one would hide the only
screen that could undo it. They can still be rebound freely; the editor shows a
lock instead of the remove button on the final key, and a hand-edit that would
strand them is ignored on load.

### What cannot be rebound here

Both of these are listed read-only at the bottom of the Shortcuts page, since
that page replaced the old reference:

- **Terminal keys** (`⇧↩`, `⌘←`, `⌥⌫`, …) are intercepted by `useTerminal` and
  turned into control sequences before the rule table is consulted.
- **Electron menu accelerators** (`⌥⌘I`, `⌘Q`, `⌃⌘F`, `⌘C`/`⌘V`/`⌘Z`/`⌘A`, …)
  fire in the main process ahead of the renderer. They also fire while the
  Settings recorder is capturing, so those combinations cannot be recorded as
  shortcuts. `⌘R`, `⇧⌘R` and `⌘W` are **not** on this list: their menu roles
  were dropped precisely so the rule table could have them.

---

## Implementation Architecture

```
KeybindingRule (defaults.ts)  +  user overrides (keybindings.json)
    ↓  merged, later rules win; '-command' rules cancel their target
    ↓  resolved by KeyResolver
useKeybindings — window.addEventListener('keydown', handler, { capture: true })
    ↓  match found → stopPropagation
executeCommand (useKeybindings.ts)
    ↓
registerCommand handlers
    ↓
EditorWindowApp → activeEditor() → EditorPane → EditorView
```

- **Capture phase** — interception happens before the event reaches any target element, allowing chords to override native browser/OS behaviour.
- **Command registry** — commands are decoupled from UI; the palette and keybindings share the same `registerCommand` registry.
- **No-op safety** — unregistered commands return `false` without calling `stopPropagation`, so native element behaviour falls through unaffected.
- **Per-window resolvers** — each renderer window builds its own `KeyResolver`, so a write to `keybindings.json` is broadcast from the main process (`keybindings:changed`) and re-applied everywhere.
- **Recording** — while the Settings recorder is reading raw keystrokes it calls `setKeyCaptureActive(true)`, which suspends the dispatcher; the dispatcher's listener is installed first and window capture-phase listeners run in registration order, so the recorder cannot outrank it any other way.
