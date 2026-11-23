# `@navide/plugin-ui`

Vue components, capability-backed controllers, shared presentation services,
and semantic token references for Navide plugin views. The package depends only
on public plugin contracts and peer UI runtimes; it never imports Electron or a
private Navide feature package.

## Install

```bash
npm install @navide/plugin-ui @navide/plugin-sdk @navide/plugin-contracts vue vue-i18n
```

`vue`, `vue-i18n` and `@navide/plugin-sdk` are peer dependencies; the optional
`monaco-editor` peer is needed only for `@navide/plugin-ui/editor`. Subpaths:
`@navide/plugin-ui/shared`, `/foundation`, `/file-picker`, `/editor` and
`/styles.css`, plus `/shared/testing`, the test-only resets of the shared
settings and keybinding state. The 1.x compatibility commitment is in
[Plugin development v2](https://github.com/Navide-dev/Navide/blob/main/docs/en-US/plugin-development-v2.md#compatibility-commitment-1x).
