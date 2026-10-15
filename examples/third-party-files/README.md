# Third-party Files Example

This example is intentionally outside Navide's package workspace boundary. It
uses only the public `@navide/plugin-contracts`, `@navide/plugin-sdk`, and
`@navide/plugin-ui` packages.

The manifest declares `fs`, so activation may call `fs.readFile`. It does not
declare `shell`, so the same activation deliberately calls `shell.run` and
records the Host's `CAPABILITY_DENIED` response.

Before the public packages are published to npm, run the external workspace
smoke test from the Navide repository root:

```text
pnpm test:run src/main/plugins/pluginExternalWorkspace.test.ts
```

The smoke test copies this example into a temporary project outside the Navide
workspace and replaces only the three unpublished public packages with local
tarballs. It installs those package tarballs from the repository's populated
pnpm store with `pnpm install --offline`, supplies the Host's already-installed
Vue peer runtime, then uses the repository's TypeScript and Vite CLI entries to
typecheck and build the external project. The smoke test does not install
TypeScript, Vite, Vue, or vue-i18n tarballs offline.

After the public packages are published, run the workflow from this directory:

```text
pnpm install
pnpm run typecheck
pnpm run build
pnpm run check
pnpm run package
```
