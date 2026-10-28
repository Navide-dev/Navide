# UI verification: dev web mode screenshots

How an agent (or a developer) looks at a change to the main window without
touching anyone's real app or screen. Use it for any UI check: a layout fix, a
before/after pair for a PR, or a design review loop.

## Boundaries

- **Never** drive the user's screen or a running app: no cliclick,
  screencapture or AppleScript, and no CDP into a running Electron
  (ports 9223/9224).
- **Never** use `electron-vite dev --rendererOnly`. It still launches
  Electron, a real window on the dev data dir, after the renderer server.
- The one allowed path is **dev web mode** (#287): the renderer served to a
  browser against an **isolated** backend. It covers the main window, Settings
  included. Plugin windows (Git, Plans) are out of scope; hand the user manual
  steps for those.
- Dev web mode is dev-only. `node scripts/check-no-dev-web.mjs out` (also run
  by `release.sh` after `pnpm dist`) proves release builds contain none of it.

## 1. Prepare a worktree

Work from a worktree, not the shared checkout:

```bash
git worktree add -b <branch> <wt> origin/main
ln -s <repo>/node_modules <wt>/node_modules        # node_modules is gitignored
cp -c -R <repo>/backend/.venv <wt>/backend/.venv  # never uv sync / uv venv here
# point the copied editable install at the worktree's backend
echo "<wt>/backend" > <wt>/backend/.venv/lib/python3.*/site-packages/_editable_impl_agent_team_backend.pth
```

## 2. Start dev web mode and record its PID

The run dir must be a **0700** directory you own; otherwise startup fails with
`run dir is not private`.

```bash
mkdir -p <scratch>/devweb && chmod 700 <scratch>/devweb
cd <wt> && NAVIDE_DEV_WEB=1 NAVIDE_DEV_WEB_DIR=<scratch>/devweb \
  nohup node scripts/dev-web/serve.mjs > <scratch>/devweb.log 2>&1 &
echo $! > <scratch>/devweb.pid
```

- The renderer is served at `http://127.0.0.1:5274` (`NAVIDE_DEV_WEB_PORT`).
- An isolated backend runs on `127.0.0.1:8931` (`NAVIDE_DEV_WEB_BACKEND_PORT`).
  Its HOME, TMPDIR and data dir live under `NAVIDE_DEV_WEB_DIR`. A fake
  `security` comes first on PATH, and sandbox-exec denies `/usr/bin/security`,
  so keychain reads fail by design. Log lines such as `keychain read failed
  ... Operation not permitted` are expected.
- The backend dies with the server.
- The log prints a one-time login URL:
  `[navide-dev-web] one-time login: http://127.0.0.1:5274/__navide_dev_web/login?code=…`.
  Without that cookie every request is 403. Another way to log in is to
  `POST /__navide_dev_web/mint` with the header
  `x-electron-token: $(cat $TMPDIR/agent-team-dev-token)`, which returns
  `{loginPath}`.
- To get a CLI pane, put a fake executable in `<NAVIDE_DEV_WEB_DIR>/bin`. Never
  launch a real CLI or log in to one.

## 3. Drive it and take screenshots

Use **ego-browser** (read its skill first: `ego-browser skill`). Fall back to
headless Playwright from the worktree's `@playwright/test` only where
ego-browser is unavailable. Screenshots go to a scratch directory, never the
repo. Use one task space for the whole goal and resume it by id in later rounds.

```js
// ego-browser nodejs <<'EOF' … EOF
const task = await taskSpace("<goal name>")          // later rounds: taskSpace(<id>)
const page = task.page("p1")
await page.goto("http://127.0.0.1:5274/__navide_dev_web/login?code=<code>")
await page.goto("http://127.0.0.1:5274/?workspace_path=<abs scratch dir>")
// A fresh data dir opens the first-launch wizard: skip it once.
await page.evaluate(() => [...document.querySelectorAll('button')]
  .find((b) => /Skip for Now/.test(b.textContent))?.click())
// Set the width AFTER navigating: a navigation drops the override.
await page.cdp("Emulation.setDeviceMetricsOverride",
  { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false })
// Hide the dev web notice so it does not end up in the screenshot.
await page.evaluate(() => document.getElementById('navide-dev-web-notice')?.remove())
await page.click(".titlebar-gear", { label: "open settings" })
await page.waitForSelector(".s-modal")
await page.screenshot({ path: "<scratch>/shots/general--en-US--light--1280.png" })
EOF
```

- **Settings**: open it with `.titlebar-gear`. Switch tabs by clicking
  `.settings-nav-item` and `.settings-nav-subitem`. Select them by index or
  data attribute rather than label text, because the labels change with the
  language.
- **Language and theme**: change them through the UI (the Settings → Language
  buttons `.ap-lang-btn`, the Settings → Appearance theme cards `.ap-theme-card`),
  the same way a user would.
- **Bridge calls**: calls that exist only in the desktop app show a yellow
  "not supported in web mode" notice. The list is in
  `window.__navide_dev_web__.unsupported`. A screen that depends on one of
  those calls cannot be verified here; say so in the report.
- **Coverage for a UI change**: light and dark, a narrow (860) and a wide
  (1280) window, and at least en-US plus one long-string language (de-DE or
  ru-RU) and one CJK language (ja-JP).
- **Before/after**: shoot the base commit and the change from the same
  worktree. Reverse the change with `git diff > p && git apply -R p`, shoot,
  then `git apply p`. Never use stash.

## 4. Stop and clean up

```bash
kill $(cat <scratch>/devweb.pid)
lsof -nP -iTCP:5274 -iTCP:8931 -sTCP:LISTEN   # must print nothing
```

Kill only the PID you recorded, never with `pkill` or a pattern. Close the
ego-browser pages you opened (`task.finish()`), and run `ps` to confirm that
nothing you started is left running.
