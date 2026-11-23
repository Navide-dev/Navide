# `navide-plugin-sdk`

The public Python surface a Navide plugin backend builds against: the path
guard, the staged write path and plan versions, standard library only. A
backend imports `navide_plugin_sdk` and never `agent_team_backend`.

```bash
pip install navide-plugin-sdk
```

`navide_plugin_sdk.API_VERSION` shares its major with `PLUGIN_API_VERSION` in
`@navide/plugin-contracts`. The SDK is bundled into each backend at build
time, so a Host update never reaches a published plugin. The compatibility
commitment is in
[Plugin development v2](https://github.com/Navide-dev/Navide/blob/main/docs/en-US/plugin-development-v2.md#compatibility-commitment-1x).
