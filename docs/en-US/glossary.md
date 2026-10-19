# Glossary: plugins, extensions and assets

Navide sits on top of AI CLIs that have extension systems of their own, and
most of them use the same words Navide does: Claude Code, Codex, Copilot, Droid,
Grok, Cursor, opencode and others all ship "plugins" and "marketplaces". This
page sets one term per concept so that user-facing text never leaves the reader
guessing whose plugin is meant.

The rule behind every term: **name a thing by who owns its files.**

| Concept | zh-TW | en | ja | Covers |
|---|---|---|---|---|
| A package that extends Navide itself | Navide 外掛 | Navide plugin | Navide プラグイン | Manifest v1/v2 packages, the plugin SDK and `navide-plugin`, the plugin backend sandbox, the bundled `navide.git`, `navide.plans`, `navide.mini-ide` and `navide.browser` |
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
