# Build for Navide

One page for a third party who wants to join: how a Navide plugin is made,
checked, loaded, published and kept up to date, and where to take part. It
holds the flow and the links; the four detailed documents stay the reference
([Plugin development v2](plugin-development-v2.md) is the contract,
[Publishing to the Navide Marketplace](marketplace-publishing.md) the
publisher's handbook, [Plugin development](plugin-development.md) the legacy
Manifest v1 notes, and the bundled `plugin-authoring` skill the short path an
agent reads). Where a detail here and a detail there disagree, this page is
the one that was checked last; open an issue and the other one is fixed.

The rule every decision follows is
[disclose, don't restrict](plugin-development-v2.md#design-principle-disclose-dont-restrict):
a plugin may ask for anything, the user sees exactly what it asked for and
what it did, and a published package is signed, scanned and reviewed before
anyone can install it.

## The whole path at a glance

From an empty folder to a listing, in order. Each step is a section below;
in Navide, Settings → Navide Marketplace → Developer shows the same steps and,
once you sign in, the one you are on.

| # | Step | Command or place | An agent in a pane can |
|---|---|---|---|
| 1 | Create the plugin from the template | `navide-plugin init` ([§1](#1-five-minutes-to-a-running-plugin)) | run the command |
| 2 | Load it into Navide without publishing | Settings → Navide Plugins → Developer Mode → Load from Folder… | open the switch (`plugins_developer_mode_open`); you turn it on |
| 3 | Validate and package it | `navide-plugin validate`, `navide-plugin scan`, `navide-plugin package` ([§3](#3-check-it-yourself-before-anyone-else-does)) | `plugins_validate_package`, `plugins_package` (same rules, nothing installed) |
| 4 | Apply as a developer, once | Settings → Navide Marketplace → Developer, or `developers.navide.dev/developer/apply` ([§4](#4-publishing-is-the-business-process)) | fill the draft (`marketplace_developer_application_fill`); you submit it |
| 5 | Claim a namespace, register a signing key | `developers.navide.dev/publisher/claim`, `navide-plugin keygen` | read the next step (`marketplace_developer_status`) |
| 6 | Sign and submit for review | `navide-plugin publish`, or Navide's publish form | fill the form (`marketplace_publish_fill`); you submit it |

Nothing in steps 1–3 leaves your machine. Steps 4–6 are sent only when you
press the button or run the command yourself. Every command in order, from a
copy of the template to a listing, is in
[From zero to a listing](#from-zero-to-a-listing).

## 1. Five minutes to a running plugin

You need Node.js 20 or later. The plugins the templates write run on Navide
0.2.39 or later; use the newest Navide for the Developer page and its publish
form.

The public packages (`@navide/plugin-contracts`, `@navide/plugin-sdk`,
`@navide/plugin-ui`) are distributed only as GitHub Release files, not through
npm or PyPI. Install them from the newest
[`plugin-packages-1.0.2`](https://github.com/Navide-dev/Navide/releases/tag/plugin-packages-1.0.2)
release, the same files Navide's own plugins build against (every
`plugin-packages-*` release is listed on the
[Releases page](https://github.com/Navide-dev/Navide/releases?q=plugin-packages)):

```bash
R=https://github.com/Navide-dev/Navide/releases/download/plugin-packages-1.0.2
npx --yes --package $R/navide-plugin-contracts-1.0.2.tgz --package $R/navide-plugin-sdk-1.0.2.tgz \
  navide-plugin init acme-hello --id acme.hello --template vue
cd acme-hello
npm install $R/navide-plugin-contracts-1.0.2.tgz $R/navide-plugin-sdk-1.0.2.tgz
npm install
npm run build        # writes dist/package, then npm run check validates it
```

The first `npm install` writes the two tarball addresses into `package.json`
(a template from SDK 1.0.1 or earlier names the 1.0.0 files; from 1.0.2 on,
the template names the release it came from). After that
`npx navide-plugin` and the `package.json` scripts use the local copy. The
release's SHA-256 sums, to compare with `shasum -a 256` on a downloaded file:

```text
4beea478ec24dd87be491ba9ed84e0375a27007f49e61df4dcc4a2cebde047f0  navide-plugin-contracts-1.0.2.tgz
c60737218c99614e7e1403e8dbe27bdc19f34f2e5d314d0b7def7d2374d1c818  navide-plugin-sdk-1.0.2.tgz
37e39c4e6a4cc69564a14bc2c99a5eaa2892fe1bf5b420dfd5359d1bdc797720  navide-plugin-ui-1.0.2.tgz
```

A Python backend needs no package: the `vue` template's backend uses only the
standard library. If you want the Python SDK (`navide_plugin_sdk`: the path
guard, the staged write path, plan versions), install its wheel from
[`plugin-packages-1.0.0`](https://github.com/Navide-dev/Navide/releases/tag/plugin-packages-1.0.0),
where it stays until its own version changes:
`pip install https://github.com/Navide-dev/Navide/releases/download/plugin-packages-1.0.0/navide_plugin_sdk-1.0.0-py3-none-any.whl`.

Want the smallest possible start? Leave out `--template vue`: the default
template is one HTML view and one script with no build step, and
`npm install && npm run check && npm run package` in its folder validates,
scans and packages it as written (its `package.json` only installs the CLI
from the same release and is never packaged). The same files are in the
repository as [`examples/hello-plugin`](../../examples/hello-plugin/), to
copy without running anything first.

`--id` is `<namespace>.<name>`; the namespace is the one you will claim on
the Marketplace later, and the id never changes once published. The `vue`
template is a complete, buildable plugin: a Vue 3 view in a workbench region,
a small native backend (Python, one executable per platform), one agent tool
that calls it, a test suite, and a `check` script that runs `validate` and
`scan`.

Load it into Navide without publishing:

1. Settings → Navide Plugins → turn on **Developer Mode** (only you can; an
   agent helping you asks you to).
2. **Load from folder…** → pick `dist/package` (or the scaffold's folder).
   The view opens with the permissions the manifest declares; a backend asks
   for your consent first, exactly as an installed package would.
3. Edit and save. A loaded folder reloads by itself when its files change
   (a build writes `.navide-build-complete` last, so a half-written build is
   never loaded). A changed `permissions` or `backend` waits for your consent
   again; nothing changes a grant behind your back.

An agent in a Navide pane can do steps 1–3 with you through the MCP tools
`plugins_developer_mode_open` and `plugins_install_file_fill`; you approve the
load in Navide's main window.

## 2. What a plugin can do

Everything a plugin may do is declared in `manifest.json`, shown to the user
before install with a risk level, and recorded when used (Settings → Navide
Plugins → Activity). The catalog of every method, its schema and the
permission it needs is `docs/plugin-contracts/capabilities-v1.json`; the
reference is [Plugin development v2](plugin-development-v2.md).

| You want | Declare | Risk shown | Reference |
|---|---|---|---|
| A panel beside the panes, a tab in the stage, a separate window | `contributes.views[]` with `location` `left`/`right`/`top`/`bottom`, `main`, or `window` | — | [Manifest field reference](plugin-development-v2.md#manifest-field-reference) |
| A command the user runs from the command list | `contributes.commands[]` | — | [Commands](plugin-development-v2.md#commands) |
| Read and write workspace files | `permissions.system: ["fs"]`; narrow with `permissions.scopes.fs` (disclosure only) | medium | [fs](plugin-development-v2.md#capabilities-and-permissions) |
| Show your own UI, open files in the editor, notifications | `permissions.system: ["ui"]` | low | [ui](plugin-development-v2.md#capabilities-and-permissions) |
| Start an AI CLI session and read its output | `permissions.system: ["aiCli"]` | high | [aiCli](plugin-development-v2.md#capabilities-and-permissions) |
| Open and browse real web pages (Navide's browser partition) | `permissions.system: ["web"]` | high | [web](plugin-development-v2.md#capabilities-and-permissions) |
| See the user's agent panes, lineage and message records; read message text | `permissions.system: ["agents"]`; `["agents", "agentMessages"]` for the text | medium / high | [agents](plugin-development-v2.md#capabilities-and-permissions) |
| Keep your own API keys and tokens (encrypted on the user's device, never synced or shown) | `permissions.system: ["secrets"]` (0.2.39); `createPluginSecretStore(context)` from the SDK | high | [Plugin secrets](plugin-development-v2.md#plugin-secrets-secrets) |
| Tell one of the user's agent panes that something happened (it reads as data, never an instruction) | `permissions.system: ["agentNotify"]` (0.2.40); the user also turns on Notify agent panes for the plugin | high | [agentNotify](plugin-development-v2.md#notifying-agent-panes-agentnotify) |
| Be told when panes, turns, plans, pipelines or schedules change | `permissions.agents.events: [...]` (0.2.39) | medium | [Events](plugin-development-v2.md#capabilities-and-permissions) |
| Run `git`, `gh`, `glab` in the workspace | `permissions.shell: "allowlist"` | high | [Shell](plugin-development-v2.md#declared-executables-permissionsshellexecutables) |
| Run other executables (`npm`, `terraform`, …) | `permissions.shell: { "mode": "allowlist", "executables": [...] }` (0.2.39) | high; highest for a name that runs any program | [Declared executables](plugin-development-v2.md#declared-executables-permissionsshellexecutables) |
| Let your views call network hosts (`fetch`, WebSocket) | `permissions.network: { "hosts": ["api.example.com"] }` (0.2.39). Every request is recorded; one to an undeclared host is marked as such, refused only when the user turns on "Only allow declared network hosts" for your package. A listing that declares hosts must declare the ones its code reaches | highest | [Network hosts](plugin-development-v2.md#network-hosts-permissionsnetwork) |
| Logic that outlives the view; one executable per platform, sandboxed | `backend` (Backend Wire v1) | high | [Third-party backends](plugin-development-v2.md#third-party-backends-sandbox-consent-and-publishing) |
| A tool agents can call | `backend.agentTools[]` with `risk` `read` or `write`; without a backend, `contributes.agentTools[]` served by one of your views through `onAgentToolCall` (0.2.39, so Windows too) | high for `write` | [Agent tools](plugin-development-v2.md#agent-tools-backendagenttools) |
| Remember settings or view state | `storage.*` through the SDK; no declaration | — | [Storage](plugin-development-v2.md#host-managed-storage-partitions) |

Not available yet, and tracked: a backend reaching the network directly
([TA-1](security/ta-1-backend-network.md)), third-party backends on Windows
([TA-3](security/ta-3-windows-unsandboxed-backend.md)), chat-channel adapters
([TA-4](security/ta-4-channel-adapter-contribution.md)), pipeline nodes and
plugin-to-plugin calls (0.2.39 batch 3).

## 3. Check it yourself before anyone else does

Run the same checks the Registry and the reviewer run, in this order:

```bash
navide-plugin validate dist/package          # manifest, files, entry points
navide-plugin scan dist/package              # the publish-time static scan, compared with your manifest
navide-plugin package dist/package           # a deterministic .vsix; one per target for a backend
```

- `validate` refuses what the Registry would refuse and names the field and
  the value that would pass.
- `scan` lists what your code does that the manifest does not declare (shown
  in red to users) and what you declared that it could not find. Fix the
  manifest or the code until the red list is empty.
- `package` writes `acme.hello-<version>-<target>.vsix`; packaging the same
  files again gives the same bytes.
- A backend: `navide-plugin dev-backend dist/package --workspace <dir>` runs
  it in Navide's sandbox and answers its Host bridge calls under Navide's own
  rules (declared `fs` in that directory, `--allow-writes` for changes,
  declared `shell` through the same command policy; undeclared is refused the
  way Navide refuses it), listing every request in `<data>/activity.jsonl`.
- Readiness: every view must call `ready()` (`createPluginViewRuntimeClient().ready()`
  from `@navide/plugin-sdk`, or `window.nav.ready()` in the no-build scaffold)
  within 10 seconds of loading, or the install and the folder load fail
  their check. The `vue` template calls it in `src/main.ts`; its test suite
  drives the backend over Backend Wire v1 the way the Host does.
- **Keys go in `secrets`, nowhere else.** An API key, token or password
  (yours, the user's or a service's) is stored only through the `secrets`
  capability, where the user pastes it once. Never write one into your code,
  manifest, `contributes.settings` or `storage.*` (plain JSON), tests or
  fixtures (build fake values at run time), a README, a screenshot, a log line,
  an agent tool result, or a commit: a key that reached git history is
  compromised even after you delete it. `scan` and the Registry's secret scan
  refuse a package that carries one.
- The author checklist the reviewer applies — signature, name similarity,
  secret scan, permissions, size — is in
  [Review](marketplace-publishing.md#5-review); run `scan` and keep secrets out
  of the package and you have covered the automatic part.

## 4. Publishing is the business process

Each step says who acts, what to expect, and where to look when it fails.
Everything here is in [Publishing to the Navide Marketplace](marketplace-publishing.md).

The Marketplace has three addresses. [marketplace.navide.dev](https://marketplace.navide.dev/)
is the storefront users browse and install from.
[developers.navide.dev](https://developers.navide.dev/developer) is your
console: the application, namespaces, signing key, tokens and review state;
its `/developer` page lists these steps and what to prepare, without signing
in. `server.navide.dev` is the API the Navide app and the `navide-plugin` CLI
talk to; it has no pages of its own.

| Step | You | Navide | How long | If it fails |
|---|---|---|---|---|
| Developer application | Sign in with a Navide Cloud account at `developers.navide.dev/developer/apply` (or from Navide's Settings → Developer) and apply once, real-name | A person reviews who is publishing and that you can be reached, never your permissions | A human review, target of 3 business days; the dashboard shows the state | A rejection carries a reason; apply again |
| Namespace | Claim one at `developers.navide.dev/publisher/claim`; it must equal the first segment of your plugin id | First come, first served; reserved words and look-alikes refused; three per account | Immediate | Pick another name |
| Signing key | `navide-plugin keygen`, paste the `.pub` on your namespace dashboard (`developers.navide.dev/publisher/<namespace>`); keep the private key out of Git | Verifies every upload against the registered key; Navide's own Settings sign-in never replaces a key you registered without asking | Immediate | `403 invalid package signature`: sign the exact file you upload with the registered key |
| Test build (optional) | `navide-plugin publish <file> --channel testplace`, then `testplace invite add` or `testplace code create --max-testers <n>` (or invite, create codes and send a build to review in Settings → Navide Marketplace → Developer → Testplace) | Automatic scan only; a public test code's first use gets a light human review; builds expire after 90 days | Minutes | A likely credential or a too-similar name refuses the build |
| Promote or publish | `navide-plugin testplace promote <id> <version>` (or **Send to review** on the Developer page's Testplace section), or `navide-plugin publish <file>` per target | Human review: signature, name similarity, secret scan, permissions, size | Target of **3 business days**; no automatic approval | `navide-plugin status <id>` shows `pending`, `approved` or `rejected` with the reason; fix and publish a new version (a version number is never reused) |
| Update | Publish the next version the same way | Users are offered the update; a version that adds a permission asks them again, and the card shows exactly what changed | Same review | Same as publish |
| Withdraw | A [yank](marketplace-publishing.md#8-yank-a-version) (Navide's yank form, or `navide-plugin yank <id>@<version> --yes`) takes a version down everywhere; a Testplace build can also be `revoke`d early | Users keep what they installed; Navide no longer installs it | Immediate; a yank cannot be undone | Publish a new version |

The MCP tools `marketplace_developer_application_*`, `marketplace_publish_*`,
`marketplace_testplace_invite_*` and `marketplace_publish_yank_*` let an agent
in a pane fill these forms for you; you approve each submission in Navide's
main window.

## From zero to a listing

Every step from an empty folder to a version on the Navide Marketplace, with
the smallest template. Replace `acme` with your namespace and `hello` with
your plugin's name. Steps 1–5 stay on your machine; 6–11 are the publishing
process of [§4](#4-publishing-is-the-business-process).

1. **Create the plugin.** Copy
   [`examples/hello-plugin`](../../examples/hello-plugin/), or write the same
   files with the CLI straight from the release:

   ```bash
   R=https://github.com/Navide-dev/Navide/releases/download/plugin-packages-1.0.2
   npx --yes --package $R/navide-plugin-contracts-1.0.2.tgz --package $R/navide-plugin-sdk-1.0.2.tgz \
     navide-plugin init acme-hello --id acme.hello
   cd acme-hello
   ```

2. **Install the CLI into the project.** `npm install` installs
   `@navide/plugin-contracts` and `@navide/plugin-sdk` from the release
   tarballs named in `package.json`. From here on run the CLI as
   `npx navide-plugin …` or through `npm run` inside this folder. Outside a
   folder that installed it, `npx navide-plugin` looks the name up on npm,
   where Navide publishes nothing. (`init` from SDK 1.0.1 or earlier writes
   no `package.json`; copy the one in `examples/hello-plugin` into the folder
   first.)
3. **Make it yours.** In `manifest.json` set `name`,
   `marketplace.description` and `marketplace.license`, and declare in
   `permissions` what the plugin calls ([§2](#2-what-a-plugin-can-do)).
   Every file the package holds is listed in `artifact-files.json`; add a
   file there when you add it to the plugin. `README.md` is your listing
   page.
4. **Load it into Navide.** Settings → Navide Plugins → turn on Developer
   Mode → Load from Folder… → the project folder. Saving a file reloads the
   view.
5. **Check and package.** `npm run check` runs `navide-plugin validate` and
   `navide-plugin scan`, the checks review runs; fix what they name until the
   scan reports that everything found is declared. `npm run package` writes
   `acme.hello-0.1.0-universal.vsix`.
6. **Apply as a developer, once.** Settings → Navide Marketplace →
   Developer, or `developers.navide.dev/developer/apply`, signed in with your
   Navide Cloud account. A person reviews the application (target: 3
   business days).
7. **Claim the namespace.** `developers.navide.dev/publisher/claim`; it must
   equal the first segment of your id (`acme`) and the manifest's
   `publisher`.
8. **Register a signing key.** `npx navide-plugin keygen --out-dir keys --name acme`,
   then paste `keys/acme.pub` into **Signing key** on
   `developers.navide.dev/publisher/acme`. `keys/acme.key` stays on your
   machine: the template's `.gitignore` already keeps `*.key` out of Git, and
   it is never listed in `artifact-files.json`.
9. **Sign in from the CLI.** `npx navide-plugin login` opens the browser;
   pick the namespace and press **Authorize**. `npx navide-plugin whoami`
   shows who you are signed in as.
10. **Sign and submit.**

    ```bash
    npx navide-plugin sign acme.hello-0.1.0-universal.vsix --key keys/acme.key
    npx navide-plugin publish acme.hello-0.1.0-universal.vsix \
      --signature acme.hello-0.1.0-universal.vsix.sig
    ```

    Or `npx navide-plugin publish acme.hello-0.1.0-universal.vsix --via-navide`
    to submit it from Navide's publish form, where you are already signed in.
    To let testers try it first, add `--channel testplace` and invite them
    (see [Testplace](marketplace-publishing.md#testplace)).
11. **Follow the review.** `npx navide-plugin status acme.hello` shows
    `pending`, `approved` or `rejected` with the reviewer's reason; so does
    Settings → Navide Marketplace → Developer. Once approved, the version is
    listed on [marketplace.navide.dev](https://marketplace.navide.dev/).

The next version follows steps 3, 5, 10 and 11 with a higher `version` in
`manifest.json`; a version number is never reused.

## 5. Take part

- **Plugins we would like to see:** [Plugin ideas](plugin-ideas.md) lists the
  gaps Navide's own team has named, with the capabilities each one needs.
  Claim one by opening a Discussion in **Plugin ideas**, or add your own.
- **Show what you built:** post it in **Show and tell** on
  [GitHub Discussions](https://github.com/Navide-dev/Navide/discussions);
  approved Marketplace plugins are listed in the release notes under "Navide
  Marketplace".
- **Something is wrong:** a bug in the SDK, the CLI, the Registry or these
  documents is an [issue](https://github.com/Navide-dev/Navide/issues/new?template=bug_report.yml);
  a question is a Discussion in **Q&A**; a security problem follows
  [SECURITY.md](../../SECURITY.md) (private report).
- **Change the platform:** the contract, the SDK and the capability catalog
  live in this repository; [CONTRIBUTING.md](../../CONTRIBUTING.md) says how a
  change to them is proposed and tested.
