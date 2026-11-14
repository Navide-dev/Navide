# Security assessments

Threat assessments written before a trust boundary moves. Each one follows
[the security threat model](../security-threat-model.md): the same four
attacker positions, STRIDE as the checklist, and a closing "did we do enough"
section that the implementing pull request has to satisfy. An assessment is
not a design document: it says what can go wrong, which options close it,
what the user has to decide, and what the implementation must prove.

The design principle every option is measured against is
["disclose, don't restrict"](../plugin-development-v2.md#design-principle-disclose-dont-restrict):
a plugin may ask for anything, the user sees exactly what it asked for and
what it did, and a security fix removes an exploitable path without shrinking
a feature the user already has.

| Assessment | Boundary it covers | Status (0.2.39) |
|---|---|---|
| [TA-1 Backend sandbox network](ta-1-backend-network.md) | Letting a sandboxed third-party backend reach declared network hosts | Assessment only for the backend; the view-side `permissions.network` (CSP) is implemented |
| [TA-2 Declared shell executables](ta-2-declared-executables.md) | `permissions.shell.executables`: a plugin names the executables its `shell.run` may start | Implemented (option A: any name, graded disclosure; Windows batch-shim arguments refused) |
| [TA-3 Windows backend without a sandbox](ta-3-windows-unsandboxed-backend.md) | Running third-party backends on Windows, where no sandbox exists yet | Assessment only; no implementation this version |
| [TA-4 Channel adapter contribution point](ta-4-channel-adapter-contribution.md) | A plugin providing a chat-platform adapter, with the bot token kept by the Host | Assessment only; no implementation this version |
