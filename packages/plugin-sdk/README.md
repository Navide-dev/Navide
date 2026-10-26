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
`--registry`, `$NAVIDE_REGISTRY_URL`, or `https://server.navide.dev/registry`.
`dev-backend` runs a built backend under the same sandbox profile Navide uses
and answers every Host bridge request with `CAPABILITY_DENIED`. There is no
`dev` command.

At runtime a view uses the factories `createPluginCapabilityClient()`
(capability calls and events), `createPluginViewRuntimeClient()` (`ready()`,
open targets, window and detail composition) and `createPluginBackendClient()`
(the package's own backend). Each view must call `ready()` after mounting.
`definePlugin` only returns a frozen `{ activate }` object; Navide never calls
`activate`. See
[SDK interface](../../docs/en-US/plugin-development-v2.md#sdk-interface).
