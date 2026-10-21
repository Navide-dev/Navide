# Contributing to Navide

Thank you for your interest in contributing!
<!-- 感謝你對 Navide 的貢獻興趣！ -->

---

## Table of Contents

- [Asking Questions](#asking-questions)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Development Setup](#development-setup)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Code Style](#code-style)
- [Commit Format](#commit-format)

---

## Asking Questions / 提問

Usage questions and open-ended ideas belong in [GitHub Discussions](https://github.com/Navide-dev/Navide/discussions) — use **Q&A** for help and **Ideas** for early proposals. Issues are reserved for confirmed bugs and concrete feature requests.

> 使用問題與尚未成形的想法請到 [GitHub Discussions](https://github.com/Navide-dev/Navide/discussions)（Q&A 提問、Ideas 討論構想）；Issue 保留給已確認的 bug 與具體的功能需求。

---

## Reporting Bugs / 回報 Bug

Please open a [GitHub Issue](https://github.com/Navide-dev/Navide/issues/new?template=bug_report.yml) using the bug report template.
Include a clear description, steps to reproduce, and any relevant logs or screenshots.

> 請開 [GitHub Issue](https://github.com/Navide-dev/Navide/issues/new?template=bug_report.yml) 並填寫 bug 回報模板，包含重現步驟與相關 log。

---

## Requesting Features / 功能建議

Open a [GitHub Issue](https://github.com/Navide-dev/Navide/issues/new?template=feature_request.yml) with the feature request template.
Describe the problem you are trying to solve and the solution you have in mind.

> 請開 [GitHub Issue](https://github.com/Navide-dev/Navide/issues/new?template=feature_request.yml) 並描述你想解決的問題與建議的解法。

---

## Development Setup / 開發環境設定

**Requirements:** Bun (the version pinned in `.bun-version`; `packageManager` in
`package.json` names the same one), Python 3.12+, uv 0.11+, Go 1.27.x
for the packaged Plans fixture, and macOS 13+ on Apple silicon, Linux x64, or Windows x64

```bash
git clone https://github.com/Navide-dev/Navide.git
cd Navide

bun install
uv --project backend sync

bun run dev
```

Daily development — install, `bun run dev`, typecheck, tests and builds — needs
only Bun: no Node.js and no pnpm. `bun install` also runs this project's
`postinstall`, which downloads the Electron binary once (Electron 44 fetches it
lazily, so without it `bun run dev` fails in electron-vite with `Electron uninstall`); it is a
no-op afterwards. Node.js 22 is only needed by `./build.sh` and `./release.sh`,
which call a plain `node`. Do not mix `bun install` and `pnpm install` in one
`node_modules`; if you did, delete `node_modules` and reinstall with Bun.

The `bun run dev` command starts Electron, Vite dev server, and the Python FastAPI backend together.

The first development start packages the production Plans backend with
`uv`/PyInstaller. Later starts reuse it when the Python sources, build script,
dependency files, resolved interpreter, platform, architecture, and executable
contents are unchanged. Missing or changed output is rebuilt automatically.
`bun run build:plans:backend` always rebuilds it explicitly; production and CI
builds remain unconditional — only `bun run dev` passes `--if-needed`, and the
build script honours the opt-out below on that invocation alone.

Without `uv`/PyInstaller that build fails and `bun run dev` stops before Electron
starts. To work on anything else in the meantime, skip it:

```bash
NAVIDE_SKIP_PLANS_BACKEND_BUILD=1 bun run dev
```

The app then starts without the packaged Plans backend: the Host finds no
backend entry on disk, so the Plans v2 package is not registered and Plans runs
through its legacy recovery window instead. Every other surface — terminals,
Git, the editor — is unaffected. Never set this for a production or CI build:
invoked without `--if-needed` (`bun run build`, `bun run dist`, the CI gates) the
script fails with a message naming the variable rather than shipping a release
with no packaged Plans backend.

> 沒有 `uv`/PyInstaller 時用 `NAVIDE_SKIP_PLANS_BACKEND_BUILD=1 bun run dev` 跳過打包，
> Plans 會以 legacy recovery 視窗運作，其他功能不受影響。

> `bun run dev` 會同時啟動 Electron、Vite dev server 和 Python FastAPI backend。

### Git hooks

Point Git at the tracked hooks once per clone:

```bash
git config core.hooksPath .githooks
```

`.githooks/pre-commit` refuses a commit whose staged `.ts`/`.vue`/`.py` files
import a relative module that is not in the index. Several sessions share one
working tree here, so a commit can carry a file that references a sibling still
unstaged or untracked; the local typecheck passes because the file is on disk,
and only CI fails. Stage the missing file too or drop the import; `--no-verify`
bypasses the check when you know what you are doing.

Both `.githooks/pre-commit` (staged changes) and `.githooks/pre-push` (every
commit about to be pushed) also run the secret scan CI runs, gitleaks with
`.gitleaks.toml`, so a finding stops you locally instead of failing the
`Secret scan` workflow after the push. Install it with `brew install gitleaks`;
without it the hooks print a warning and skip the scan. Record a false positive
by adding its fingerprint to `.gitleaksignore`, which CI reads as well.

> 每個 clone 執行一次 `git config core.hooksPath .githooks`。pre-commit 會擋下
> 「staged 的檔 import 了還沒進 index 的相對模組」——本機 typecheck 看得到工作樹的檔所以會過，
> 只有 CI 會紅。pre-commit 與 pre-push 也會跑和 CI 相同的 gitleaks 密鑰掃描；誤判請把
> fingerprint 加進 `.gitleaksignore`。

---

## Submitting a Pull Request / 提交 PR

1. Fork the repository and create a feature branch:
   ```bash
   git checkout -b feat/your-feature
   ```
2. Make your changes.
3. Run the test suite:
   ```bash
   bun run test:run
   uv --project backend run pytest backend/tests
   ```
   > **`bun test` is not `bun run test:run`.** Bare `bun test` starts Bun's own
   > test runner, not Vitest, and ignores `vitest.config.ts` (projects, aliases,
   > global setup), so its results mean nothing. Always use `bun run test:run`;
   > never `bun run test` either, which starts Vitest in watch mode and hangs.
   >
   > `src/main/plugins/pluginExternalWorkspace.test.ts` plays an external plugin
   > author who uses pnpm, so it needs a real `pnpm` (10.x) on `PATH`. It is not
   > skipped without one: it fails with `Executable not found in $PATH: "pnpm"`.
   > CI and releases install pnpm for that one test only.
   While iterating, run only what your change can affect, then the full suites
   above before you push (CI and the release gates always run them in full):
   ```bash
   bun run vitest run --changed origin/main        # tests importing changed files
   node scripts/changed-backend-tests.mjs           # backend tests for changed files
   node scripts/changed-backend-tests.mjs --list    # just print the selection
   scripts/isolated-pytest.sh backend/tests --lf    # re-run last failures
   ```
   `changed-backend-tests.mjs` compares against `origin/main` (pass another
   base as its first argument; pytest arguments go after `--`) and runs
   pytest through `scripts/isolated-pytest.sh`, the release gate's isolation:
   a throwaway HOME, no reach to the real keychain, and `uv run --no-sync`
   (macOS and Linux). It selects
   changed test files, the tests that import or patch a changed backend
   module directly, and the tests that name a changed non-backend file; a
   change to conftest, test helpers, `pyproject.toml` or the lock runs the
   whole suite. It does not follow indirect imports, so it can miss a
   breakage the full suite catches.
4. Run type checks:
   ```bash
   bun run typecheck
   ```
5. If you touched the cross-device path (`server_link.py`, `remote_roster.py`,
   `trust_store.py`, or the Navide-Server wire protocol), run the end-to-end
   check against a local server. The in-process tests use a fake server, so they
   agree with whatever this repository believes the contract is — including
   where it is wrong. This one talks to the real thing:
   ```bash
   NAVIDE_WS=ws://localhost:8787/ws \
     uv --project backend run python backend/scripts/verify_server_link.py
   ```

   > 動到跨裝置那條路徑時必跑。in-process 測試用的是假 server，會照著我們對契約
   > 的理解回應——包含理解錯的地方；這一支打的是真的對端。
6. Commit your changes following the [commit format](#commit-format) below.
7. Push and open a pull request against `main`.

Please fill in the pull request template — include a summary of changes and how you tested them.

CI retains complete frontend and backend suites on macOS, Linux and Windows.
Static checks run once, while application builds and artifact integration tests
run separately from ordinary frontend tests. The `Lint and test` status requires
the test/build matrices, packaged Plans, marketplace contracts, deterministic
speech sidecar tests and dependency audit to succeed. On a pull request, a
change confined to the renderer, preload or e2e (frontend-only) skips the backend
jobs, and a change confined to `backend/tests/` skips the frontend and build
jobs; `scripts/ci-changed-scopes.mjs` holds the rules, runs everything when
unsure, and pushes to `main` always run everything. CI does not run Electron
UI automation; test UI changes manually. To reproduce the build check locally,
run `bun run build`. See [CI and CLI regression infrastructure](docs/en-US/ci-and-cli-regression.md)
for suite ownership, provider isolation, contract coverage and diagnostics.

CI, releases and local development all install, typecheck, test and build on Bun (`bun install --frozen-lockfile`, version pinned in `.bun-version`); `bun.lock` is the only lockfile. When you change a dependency, run `bun install` and commit the updated `bun.lock`; CI fails on a stale one. A few steps still run on Node.js on purpose: the plain `node scripts/...` and `node -p` steps in the release workflow, and electron-builder on Windows (it hangs under Bun there). `pnpm` is installed in CI and releases for `pluginExternalWorkspace.test.ts` only.

> Fork 後建立 feature branch，跑測試與型別檢查無誤後，依照下方 commit 格式提交，並開 PR 至 `main`。
>
> CI、發佈與本機開發都以 Bun 安裝、型別檢查、測試與建置（`bun install --frozen-lockfile`，版本固定於 `.bun-version`）；`bun.lock` 是唯一的 lockfile。變更依賴時請執行 `bun install` 並提交更新後的 `bun.lock`；`bun.lock` 過期時 CI 會失敗。少數步驟仍刻意使用 Node.js：release workflow 中的 `node scripts/...` 與 `node -p`，以及 Windows 上的 electron-builder（它在 Windows 的 Bun 下會卡住）。CI 與發佈只為 `pluginExternalWorkspace.test.ts` 這一個測試安裝 `pnpm`。
>
> **`bun test` 不等於 `bun run test:run`。** 直接執行 `bun test` 會啟動 Bun 自己的測試執行器而不是 Vitest，並忽略 `vitest.config.ts`，結果沒有意義；請一律使用 `bun run test:run`，也不要用 `bun run test`（會以 watch 模式啟動 Vitest 而卡住）。`pluginExternalWorkspace.test.ts` 模擬使用 pnpm 的外部外掛開發者，本機需要在 `PATH` 上有真正的 `pnpm`（10.x）；沒有時它不會被略過，而是以 `Executable not found in $PATH: "pnpm"` 失敗。

---

## Code Style / 程式碼風格

**TypeScript / Vue**
- Match existing style and patterns in the codebase.
- No new dependencies without prior discussion in an Issue.

**Python**
- Follow PEP 8.
- Run `uv --project backend run pytest backend/tests` before committing.

**UI text and docs**
- Follow the [glossary](docs/en-US/glossary.md): "Navide plugin" and "Navide
  Marketplace" for Navide's own packages, "CLI extension" for an AI CLI's own,
  "Agent Assets" for skills, MCP, prompts and memory. Never write plugin,
  extension or marketplace bare; a locale test fails the build if you do.

**Adding a CLI agent**
- Follow [`docs/adding-a-cli-vendor.md`](docs/adding-a-cli-vendor.md). An
  integration is two vendor spec files plus registration — never an
  `if agent_key == "<yours>"` branch in a shared module.

**Tests that have to pass on macOS, Linux and Windows**

CI runs both suites on all three. Most tests that fail on only one platform
are correct code plus a test that answered a platform question itself instead
of asking the seam the code under test asks. Two rules keep that out:

- *Do not build a platform-dependent value by a different route than the
  module under test.* If the module gets a path from `join()`, a PATH from
  `os.pathsep`, a shell from `osplat.paths.shell_command()`, or kills through
  `osplat.process_tree.kill()`, the test uses the same call — never a
  `'/tmp/…'` literal as a fake-fs key, a `.split(":")`, a bare `/bin/sh`, or a
  stub of `os.kill` under that module. The two spellings agree on the platform
  you wrote the test on and disagree on exactly one other; and a stub that
  lands under the seam does something worse than fail there — on Windows
  `os.kill` is never reached, the real call raises an equivalent error, and
  the test passes while executing none of what it claims. Stub the seam for
  *which* pids are signalled; only a test about *how* (the signal itself) may
  stub `os.kill`, gated on the capability (`skipif(not hasattr(signal,
  "SIGKILL"))` — say what you need, not which OS you think you are on). A
  literal that is a spec constant (`STATUS_CONTROL_C_EXIT`) or a value the test
  itself set is fine to assert; a value the current platform decides (an OS
  error message) is not. `backend/tests/test_cross_platform_test_hygiene.py`
  and `src/main/crossPlatformTestHygiene.test.ts` ratchet the shapes that can be
  matched statically; the rest is this paragraph.
- *Take the platform as an input; do not ask the host.* Code that computes
  another platform's paths should take the platform as a parameter and pick
  `path.win32`/`path.posix` (or the osplat layout class) from it, the way
  `resolveBackendDataDir` in `src/main/ui-settings-bootstrap.ts` does. Then a
  test can assert all three answers on any runner — the fastest one, minutes
  before the Windows job reports. `src/main/backend-ws-token-parity.test.ts`
  does exactly this: the macOS runner asserts the Linux answer by driving
  `_linux.LinuxLayout` directly and comparing with the Python side.

**Running the backend suite as Windows before pushing**

The Windows CI job takes 20+ minutes round-trip, and most of what it catches
is the first rule above. `backend/tests/osplat_win_swap.py` catches that class
on this machine in minutes: it swaps `osplat.paths` (optionally
`osplat.platform_id`) for the Windows implementation before anything imports
the feature code, so every `home_env_var()` / `config_home()` /
`shell_command()` caller computes the Windows answer and every seam-keyed
skip falls the way it falls on Windows.

```sh
# the files you touched — seconds
OSPLAT_SWAP=paths uv --project backend run pytest backend/tests/test_host_shell.py -p tests.osplat_win_swap
# the whole suite — a couple of minutes
OSPLAT_SWAP=paths,platform_id uv --project backend run pytest backend/tests -p tests.osplat_win_swap
```

The swapped run has about 300 extra skips — the tests that drive a real
`git`/`gh` through the seam,
which the Windows resolver (`PATHEXT`: `git.exe`, never `git`) cannot find
on a POSIX host. The CLI coverage gate also rejects skipped required cases;
a swapped full run can therefore fail that gate and does not qualify as a
native-platform result. Prefer focused files for this diagnostic. A new
assertion failure here can indicate a test that answered a platform question
by a different route than the code under test — fix the test the way the
rule above says, not by gating it on `sys.platform`. A test that needs a
real program says so through the seam too:
`skipif(osplat.paths.resolve_program("git") is None)` for a binary,
`osplat.paths.executable_candidates("gh") != ["gh"]` for a `#!/bin/sh` fake
found by bare name. (The run also writes
`backend/agent_team_backend/git_askpass_helper.cmd`, as Windows does; it is
gitignored.) The swapped run finishes sooner only because those skipped
tests are the subprocess-heavy ones — every `git_service` test spawns real
git several times — not because anything runs faster; it runs fewer tests,
so it is a second pass before pushing, never a replacement for the normal
run.

What it verifies: path and environment arithmetic (`APPDATA`, `USERPROFILE`,
`PATHEXT` candidate lists, `cmd.exe` argv shapes), seam-keyed skips, and the
feature code that branches on `platform_id`. What it cannot verify requires a
real Windows host (CI, or a VM): a real DPAPI round-trip (`CryptProtectData`),
real `icacls` ACLs, the `ctypes.WinDLL` prototype bindings and `_win_error`,
real `CommandLineToArgvW` parsing, Job Object kill-on-close semantics,
ConPTY I/O / EOF / resize, the `WinError 1314` symlink branch, psutil's
Windows-only `private` / `peak_wset` fields, whether the rendered PowerShell
hook scripts actually run, and the win-only `sys.platform` arms inside the
`test_osplat.py` allowlist. Do not swap `secret_files`, `terminal_backend`,
`process_tree` or `resource_probe` to get at those: their Windows
implementations reach `WinDLL`, `winpty` and `icacls` at call time, so on a
POSIX host every caller fails on the missing binding, not on anything the
test asserts (the plugin refuses them for that reason).

The native Windows suite does exercise real ConPTY output, EOF and process-tree
cleanup in `backend/tests/test_windows_conpty_real.py`; its basic resize test
checks that resizing succeeds. Those guarantees come from the Windows run,
not the swapped-platform run, and do not certify a frozen release's bundled
console host.

> 請與現有程式碼風格保持一致。Python 提交前請執行完整 backend tests。
> 新增 CLI 整合請依 `docs/adding-a-cli-vendor.md`，一家一檔，不要在共用模組加分支。
> 測試要在三個平台都過：不要繞過被測程式用的 seam 自己造路徑／平台答案
> （`join()`、`os.pathsep`、`osplat.*`——被測程式怎麼拿，測試就怎麼拿；stub 停在 seam，
> 不停在 seam 底下的 `os.kill`）；算別的平台的路徑時把 platform 當參數傳、不要問 host，
> 這樣三個平台的答案在任何 runner 都能斷言。
> 推 CI 前先用 `-p tests.osplat_win_swap` 把後端 suite 當 Windows 跑一次（改到的檔案幾秒、全套約十分鐘）；
> 它只換 `osplat.paths`／`platform_id`，換不到 DPAPI／ConPTY／Job Object 那些真實行為——那些只有 Windows CI 或 VM 驗得到。

---

## Commit Format / Commit 格式

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

Examples:
feat: add manager coordination mode
fix(analyzer): handle empty ollama response
docs: update quick start instructions
refactor(terminal): simplify PTY write path
test: add tests for sentinel detection
chore: update electron to v44
```

| Type | Use for |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | No behavior change |
| `test` | Tests only |
| `chore` | Build / tooling / dependencies |

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
By participating you agree to abide by its terms.

> 本專案遵循 [Contributor Covenant 行為準則](CODE_OF_CONDUCT.md)，參與即表示同意遵守。

## Documentation

User-facing behavior changes must update the relevant canonical document under [`docs/en-US/`](docs/en-US/README.md), synchronize an existing localized counterpart in the same change, and add an entry under `CHANGELOG.md`'s Unreleased section. Avoid describing configurable registries with fixed counts, document any new external data flow in `docs/en-US/privacy.md`, and keep future vision distinct from shipped capability claims.

A PR that changes the plugin API (`packages/plugin-sdk`, `packages/plugin-contracts`), the manifest schema (`plugin-manifest-v2.schema.json`) or the capability catalog (`capabilities-v1.json`) must update `docs/en-US/plugin-development*.md` in the same PR. Two tests enforce part of this: `tests/infrastructure/pluginDocsExamples.test.ts` typechecks every TypeScript/JavaScript example in the plugin docs against the SDK source (mark a block that cannot compile with `<!-- docs-typecheck: skip (reason) -->` on the line before its fence) and rejects `definePlugin` as an activation path, and `tests/infrastructure/pluginDocsManifest.test.ts` compares the Spec v2 manifest field, view location, error code and capability tables with the schema and catalog. Prose they cannot parse is still yours to keep current.

A release announces itself in the app: add the version's What's New entry — its highlights and, optionally, a guided tour — as described in [Release announcements](docs/en-US/release-announcements.md). `./release.sh` prints a warning when the version being released has no entry.
