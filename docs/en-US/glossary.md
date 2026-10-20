# Glossary: plugins, extensions and assets

Navide sits on top of AI CLIs that have extension systems of their own, and
most of them use the same words Navide does: Claude Code, Codex, Copilot, Droid,
Grok, Cursor, opencode and others all ship "plugins" and "marketplaces". This
page sets one term per concept so that user-facing text never leaves the reader
guessing whose plugin is meant.

The rule behind every term: **name a thing by who owns its files.**

| Concept | zh-TW | en | ja | Covers |
|---|---|---|---|---|
| A package that extends Navide itself | Navide 外掛 | Navide plugin | Navide プラグイン | Manifest v1/v2 packages, the plugin SDK and `navide-plugin`, the plugin backend sandbox, the bundled `navide.git`, `navide.plans` and `navide.mini-ide` |
| Where Navide plugins are published | Navide 市集 | Navide Marketplace | Navide マーケットプレイス | `server.navide.dev/registry` |
| A bundle of Navide plugins | Navide 外掛組合 | Navide Plugin Pack | Navide プラグインパック | Packages that declare `extensionPack` |
| Content Navide owns and delivers to the CLIs | Agent 資產 | Agent Assets | エージェント資産 | Skills, MCP servers, prompts, memory. Not credentials: they never sync |
| An add-on that belongs to one AI CLI | CLI 擴充 | CLI extension | CLI 拡張 | That CLI's plugins, mods, extensions, hooks, agents, commands, themes |
| The kind of a CLI extension | vendor's own name, untranslated | vendor's own name | vendor's own name | Shown as a badge: "Claude plugin", "Claude mod", "Codex hook", "Pi extension", … |
| A CLI's marketplace | CLI 擴充來源 | CLI extension source | CLI 拡張のソース | Claude, Codex, Droid … marketplaces; only Navide's is called a marketplace in prose |

## Rules for user-facing text

- **Never use these words bare:** plugin, extension, marketplace, 外掛, 擴充,
  市集, プラグイン, 拡張, マーケット(プレイス). Prefix them with `Navide` or `CLI`,
  or name the vendor. `packages/plugin-ui/src/foundation/i18n/__tests__/glossary.test.ts`
  enforces this for every locale string.
- **One exception, the CLI extensions page.** The Settings page that lists
  CLI extensions is shown as **Extensions / 擴充 / 拡張機能** (the user's call,
  2026-10-11): its nav label, page title and search title, and prose that
  points at it ("Settings → Extensions", 「設定 → 擴充」, 「設定 → 拡張機能」).
  The guard test allows the bare name there and nowhere else. Navide's own
  packages are still always written Navide Plugins / Navide 外掛.
- **Never use** 插件, 外掛程式, 擴充功能, 拡張機能 or "extension pack" for
  Navide plugins; those were the old labels.
- **Keep vendor terms in the vendor's language.** "Claude plugin" stays
  English in every locale: users look it up in the vendor's docs, and
  translating it to 外掛 would collide with Navide plugins.
- **"File extension" is fine.** Write it in full in English
  (ja: 拡張子, zh: 副檔名) so it is never confused with either kind of package.
- Do not introduce "add-on" or "mod" as generic terms. "Claude mod" is a vendor
  term and stays as a type label.

### How the guard test encodes each locale

`glossary.test.ts` keeps one rule set per UI locale (`UI_LOCALES`): the terms
that need a qualifier, the banned words, phrases that are not about packages
("file extension") and the name of the CLI extensions page. A locale file with
no rule set fails the test. Each term also says where its qualifier goes:
**before** it (en, zh, ja, ko: "Navide plugin", "CLI 확장"), **after** it,
optionally through a connector word (es, fr, pt, ru, vi: "complemento de
Navide", "plugin Navide", "расширение CLI"), or **hyphen**-joined (de:
"Navide-Plug-in", "CLI-Erweiterung"). Matching is Unicode-aware: text and
patterns are NFC-normalized, word boundaries mean "no letter, digit or
underscore next to it" in any script, and Latin and Cyrillic terms match
case-insensitively. vi-VN strings must already be NFC, and fr-FR needs a
no-break space before `: ; ? !`.

## Capitalization (en-US)

Commands and menus use Title Case; everything else uses sentence case (the
user's call, 2026-10-21). Other locales never copy English Title Case.

**Title Case:** command names (keybindings list, command picker), menu-bar,
context-menu and overflow-menu items that run an action (checkable items
too), every button that runs an action (dialog buttons including Cancel,
toolbar and inline buttons), the tooltip of an icon-only button when that
tooltip is just the command name (verb first, six words or fewer, no closing
period), **tab titles** ("Source Control", "Voice Input"), and **dialog
titles**, which repeat the name of the command that opens them ("Delete
Completed Plans").

**Sentence case:** pane, panel and window titles; section headings;
settings, field, checkbox, radio and toggle labels; option values in a
dropdown; placeholders; descriptive tooltips; status text and badges; toasts;
errors; empty states; inline links; help prose. Help prose quotes an
on-screen label exactly as the label is written.

**Feature names are proper nouns** and keep their capitals everywhere, in
any of the above: Turn Stats, Navide Cloud, Navide Marketplace, Navide Plugin
Pack, Agent Assets, Pipeline Manager, Resource Manager, Execution Policy,
Auto Commit, Developer Mode, Navide Guard, Navide Browser, Loop.

**Title Case mechanics (Apple Style Guide):** capitalize the first and last
word and every noun, pronoun, verb, adjective and adverb; lowercase a, an,
the, and, but, or, nor, for, yet, so, to, as, and prepositions of four
letters or fewer (at, by, for, from, in, into, of, off, on, onto, out, over,
up, with, via, per, vs.) unless first or last. Capitalize the particle of a
phrasal verb (Sign In, Set Up, Turn On). Capitalize both parts of a
hyphenated compound (To-Do) except Built-in and Plug-in; keep a prefix's
second part lowercase (Re-detect). A placeholder counts as a word: "Merge
Current Branch into {branch}". Never change product names, acronyms or
identifiers (Navide, GitHub, macOS, CLI, MCP, `git push`); "API key" becomes
"API Key" in Title Case.

## Terms in Chinese and Japanese UI text

Follow the wording the existing zh-TW and ja-JP files already use most
(the user's call, 2026-10-21: "按照現有的習慣為主"). Translators do not coin
new renderings; a term written two ways is unified to its majority form.
New locales have no existing usage and follow the per-locale research, but a
term kept in English here stays English in zh-CN too.

**Kept in English in zh-TW and zh-CN:** AI, agent, CLI, MCP, MCP server, Git,
PR, API, JSON, SSH, OAuth, LLM, token, session, hook, bot, stash, Loop, Guard,
pane, pipeline, worktree, repo, URL, plus product and vendor names. Common
nouns are lowercase even at the start of a string (agent, token, session,
hook, bot, pane, pipeline, worktree, repo); acronyms and feature names keep
their form. Put a half-width space between the English word and Chinese
text. 面板 is reserved for "panel" and never means a pane.

**zh-TW renderings:** workspace 工作區, plan 計畫, commit 提交, branch 分支,
diff 差異, skill 技能, terminal 終端機, tab 分頁, quota 額度, Settings 設定,
merge 合併, role 角色, model 模型, server 伺服器, push 推送, pull 拉取,
shortcut 快捷鍵, process 程序, memory 記憶, log 紀錄, template 範本,
open 開啟, save 儲存, refresh 重新整理, run 執行. Not used: 打開, 保存, 刷新,
日誌, 運行, 進程, 模板, a bare 終端.

**ja-JP renderings:** pane ペイン, agent エージェント, workspace
ワークスペース, plan プラン (not 計画), quota 利用枠 (not クォータ), default
既定 (not デフォルト), folder フォルダー, category カテゴリー, interface
インターフェース, memory メモリ; hook and bot stay English. Long-vowel rule
(Microsoft): words ending in -er/-or/-ar take ー (フォルダー, エディター,
ブラウザー). Quote with 「」, not ASCII double quotes; use a full-width colon
after Japanese text.

## What stays as it is

Identifiers are contracts, not prose, and keep their names: the Settings tab ids
`extensions` and `marketplace`, the i18n keys under `settings.extensions.*`, the
manifest field `extensionPack`, the registry category `extension-packs`,
`packages/plugin-sdk` and the `navide-plugin` CLI. The file
`cli-extension-guide.md` keeps its name for existing links; its title is
"CLI Integration Records", because it records how Navide integrates each CLI,
not CLI extensions.

New code and MCP tools about CLI extensions should say so in their names
(`cli_extensions_*`), never `plugins_*` or `mods_*`.
