# `@navide/plugin-contracts`

Public Manifest v2 types, typed capability method/event maps, stable
`PluginError` codes, duplicate-key-safe manifest parsing, and the JSON Schema
exports consumed by third-party plugins and SDK tooling.

The package contains no Electron, Host, backend, or private feature-package
dependency.

## Install

```bash
npm install @navide/plugin-contracts
```

The JSON Schemas are exported as
`@navide/plugin-contracts/schemas/plugin-manifest-v2.schema.json`,
`@navide/plugin-contracts/schemas/capabilities-v1.json` and
`@navide/plugin-contracts/schemas/execution-policy-v1.schema.json`.
The 1.x compatibility commitment is in
[Plugin development v2](https://github.com/Navide-dev/Navide/blob/main/docs/en-US/plugin-development-v2.md#compatibility-commitment-1x).
