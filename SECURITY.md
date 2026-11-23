# Security Policy

## Supported versions

Navide is currently pre-1.0. Security fixes target the latest code on `main` and the newest published release when releases are available.

| Version | Supported |
|---|---|
| Latest `0.1.x` release | Yes |
| Older snapshots | No guaranteed fixes |

## Reporting a vulnerability

Do not open a public GitHub Issue for a suspected vulnerability.

Email **nt.nerdtechnic@gmail.com** with the subject:

```text
[Navide] Security Vulnerability
```

Include a description, reproduction steps, potential impact, affected versions or commits, and a suggested fix if available. Remove credentials, private source code, and unrelated personal data from the report.

The project aims to acknowledge reports within 48 hours and provide a status update within 7 days. These are response targets, not a guarantee of resolution within that period.

## Scope and safe harbour

In scope: this repository, the Navide desktop application, and the Navide Cloud relay at `server.navide.dev`. Out of scope: the external coding CLIs Navide launches (report those upstream), findings that require physical access to an unlocked machine, and findings that only apply with `contextIsolation`, `sandbox`, or code signing deliberately disabled.

Good-faith research that stays within that scope, avoids privacy violations and service disruption, and allows reasonable time for a fix before disclosure will not be met with legal action. Do not test against other people's accounts or devices on the production relay; the server can be run locally (see `Navide-Server/server/deploy/`).

## Security model

Navide's Electron application, Python backend, PTYs, orchestration state, and workspace data run on the user's machine. The backend listens on loopback and is not designed to be exposed as a remote service.

The attacker positions every security review is checked against, and the controls that answer each, are written down in [Security threat model](docs/en-US/security-threat-model.md).

Navide is local-first, not universally offline. External coding CLIs, cloud AI providers, Context7, search, Git hosts, MCP servers, and update checks can communicate with third parties when used. See [Privacy and Data Flows](docs/en-US/privacy.md).

### Credentials

- Coding-agent credentials remain in each external CLI's own configuration. The one exception is a **portable credential** you paste in Settings → Accounts on purpose: it is stored encrypted, reaches the CLI only through its pane's environment, and — only if you switch the Credentials sync section on — travels to your other devices as ciphertext under your account's sync key (see `docs/en-US/security-threat-model.md`).
- Cloud AI keys entered in Navide are stored locally in the application data directory with restrictive file permissions (`0600` on supported systems).
- Exported settings redact API keys and tokens.
- Local file permissions are not protection against malware, a compromised account, unrestricted agents, backups, or another process running with equivalent authority.

### Agent authority

- Agents normally execute with the current user's operating-system permissions.
- Navide does not currently provide a complete workspace sandbox.
- YOLO mode may pass flags that bypass an external CLI's confirmations or sandbox. Some CLIs may execute tools without a confirmation gate even when Navide does not pass such a flag.
- Full Auto can answer agent questions without another user response.
- Use automation only in trusted, version-controlled workspaces and review resulting commands and diffs.

### Git allowlist boundary

The Manifest v2 Git allowlist only confirms that the top-level executable is
`git`. It does not restrict Git subcommands or arguments and is not a process
sandbox. Git's pager, aliases, SSH command configuration, hooks, and similar
mechanisms may indirectly execute other programs. Therefore
`shell: "allowlist"` combined with Git remains a high-trust grant.

### Handoffs and logs

- Cross-agent and cross-stage handoffs can propagate task text, prior output, and accidental secrets.
- Complete secret scrubbing is not yet an enforceable security boundary.
- Run history, terminal logs, CLI logs, token metadata, Git history, and exported diagnostics may retain sensitive content.
- Never place credentials directly in prompts, plans, screenshots, issue reports, or files intended for handoff.

### External integrations

MCP servers and provider integrations execute according to their own configuration and trust model. Review commands, environment variables, endpoint URLs, and provider policies before enabling them.

## Known security limitations

- No complete cross-platform workspace sandbox
- No complete secret-redaction guarantee for handoffs and diagnostics
- External CLI permission semantics differ and may change between versions
- Locally persisted API keys are not stored in an operating-system secret vault
- Provider log readers depend on files or databases owned by external tools
- Automatic update security depends on signed, notarized release artifacts and GitHub Release metadata on macOS; Windows builds are not yet code-signed, so their updates install without signature verification

The [Product Roadmap](docs/en-US/roadmap.md) defines policy, isolation, and secret handling as a dedicated long-term horizon. Documentation must not claim those controls have shipped before they are implemented and verified.
