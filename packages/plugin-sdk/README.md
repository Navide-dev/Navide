# `@navide/plugin-sdk`

The public, framework-neutral SDK for Navide Plugin Platform v2 activation and
typed capability calls.

The package also provides `navide-plugin`, the plugin author CLI from
scaffold to Marketplace listing (walkthrough:
[`docs/en-US/marketplace-publishing.md`](../../docs/en-US/marketplace-publishing.md)):

```text
navide-plugin init <directory> --id <namespace.name> [--name <display name>]
navide-plugin validate <directory> [--target <target>]
navide-plugin scan <package.vsix | directory> [--target <target>] [--json]
navide-plugin package <directory> [--target <target>] [--out <file>]
navide-plugin keygen [--out-dir <directory>] [--name <name>]
navide-plugin sign <package> --key <private-key> [--out <signature>]
navide-plugin verify <package> --key <public-key> --signature <signature>
navide-plugin login [--registry <url>] [--label <label>] [--no-browser] [--insecure-http]
navide-plugin whoami [--registry <url>]
navide-plugin status [<namespace.name>[@<version>]] [--registry <url>] [--json]
navide-plugin logout [--registry <url>]
navide-plugin publish <package> [--registry <url>] [--target <target>] [--signature <file-or-value>] [--insecure-http]
navide-plugin publish <package.vsix> --via-navide [--target <target>] [--no-browser]
navide-plugin dev-backend <directory> [--call <method>] [--args <json>] [--subscribe <event,...>] [--data <directory>]
```

Packaging reads `artifact-files.json` from the staging directory; it contains
the complete explicit `files` list and is not included in the archive. A
frontend-only package uses the `universal` target. A backend or combined
package must use the build host's exact platform-architecture target and carry
one self-contained executable. Signing and verification cover the SHA-256
digest of the complete archive with a detached Ed25519 signature. `login`
signs in through the Registry in the browser and stores a publish token in
`~/.config/navide-plugin/credentials.json` (0600); `publish` uploads to
`--registry`, `$NAVIDE_REGISTRY_URL`, or `https://server.navide.dev/registry`
(the Registry API; the website is `https://marketplace.navide.dev`).
`dev-backend` runs a built backend under the same sandbox profile Navide uses
and serves the filesystem, shell and web ports the manifest declares, denies
the rest with `CAPABILITY_DENIED`, and answers `BACKEND_UNAVAILABLE` for ports
only Navide serves (agents, secrets). There is no `dev` command.

At runtime a view uses the factories `createPluginCapabilityClient()`
(capability calls and events), `createPluginViewRuntimeClient()` (`ready()`,
open targets, window and detail composition) and `createPluginBackendClient()`
(the package's own backend). Each view must call `ready()` after mounting.
`definePlugin` only returns a frozen `{ activate }` object; Navide never calls
`activate`. See
[SDK interface](../../docs/en-US/plugin-development-v2.md#sdk-interface).

## Testing without Navide

`@navide/plugin-sdk/testing` exports `createTestHost(options)`, an in-memory
Host for a plugin's own unit tests. It builds a `PluginContext` whose
`capabilities.invoke` answers from the handlers you pass and refuses an address
your test permissions do not declare with `CAPABILITY_DENIED`, judged from the
same capability catalog (`capabilities-v1.json`) Navide enforces. `emit()`
delivers Host events to the plugin's subscribers (an `agents.*` event only when
it is declared), and `calls` and `effects` record what the plugin did. It runs
no Host code and grants nothing real.

<!-- docs-typecheck: skip (test snippet; `plugin` and `expect` come from the reader's own test file) -->
```ts
import { createTestHost } from '@navide/plugin-sdk/testing'

const host = createTestHost({
  permissions: { system: ['fs'] },
  handlers: { 'fs.readFile': () => ({ content: '# Readme' }) },
})
await plugin.activate(host.context)
expect(host.calls.map((call) => call.outcome)).toEqual(['ok'])
```
