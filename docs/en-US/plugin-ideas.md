# Plugin ideas

Plugins Navide's own team would like to exist but has not built, with the
capabilities each one needs and what blocks it, if anything. A third party
who takes one up posts in the **Plugin ideas** category of
[GitHub Discussions](https://github.com/Navide-dev/Navide/discussions) so two
people do not build the same thing; a finished one goes to **Show and tell**.
Start from [Build for Navide](build-for-navide.md).

| Idea | What it does | Needs | Blocked by |
|---|---|---|---|
| Development map | A living map of a repository's modules and their status, written to a file in the workspace and shown as a panel; agents update it through a tool | `fs` with scopes, `ui`, a backend with one `write` agent tool | Nothing; a first version (`nerdtechnic.devmap`) exists as a reference |
| `navide.mail` | Read a mailbox (IMAP or a provider API) in a panel and let an agent draft replies | `permissions.network.hosts` for the provider, `ui`, `agents` for the draft hand-off | A backend that reaches the network ([TA-1](security/ta-1-backend-network.md)); until then the provider call runs in the view |
| Self-test | Run the repository's own tests from a panel, keep the history per workspace, and offer an agent a `read` tool for the last result | `permissions.shell` with `executables: ["npm", "pnpm", "uv", "pytest"]` (0.2.39), `fs`, `ui` | Nothing since 0.2.39 |
| Desktop read-only | Show the host machine's resource use, open ports and recent crashes without running anything | `permissions.shell` with `executables: ["lsof", "ps"]`, `ui` | Nothing since 0.2.39; Windows needs its own executables |
| Code locator search | Find a symbol, a string or a file across the workspace with ripgrep and jump to it in the editor | `permissions.shell` with `executables: ["rg"]`, `fs`, `ui.openFilePicker` | Nothing since 0.2.39 |
| n8n unmapped nodes | Provide the nodes an imported n8n workflow needs that Navide's pipeline has no counterpart for, as deterministic pipeline nodes | `contributes.pipelineNodes` | Nothing |
| LINE / WhatsApp channel | A chat-platform adapter so panes can be mirrored to and driven from LINE or WhatsApp | A channel adapter contribution point with Host-held bot tokens | [TA-4](security/ta-4-channel-adapter-contribution.md): assessment only this version |
| Issue tracker panels | Linear, Jira, GitLab issues beside the panes, with an agent tool to create or update an issue | `permissions.network.hosts` for the API, `ui`, a backend with agent tools | Nothing for the view side since 0.2.39; a backend call to the API waits for TA-1 |
| Pipeline run history | Browse past pipeline runs, their nodes and outputs, and re-run one | `permissions.agents.events` (pipeline node changes), `ui` | Nothing |

Add an idea by editing this file in a pull request or by opening a Discussion
in **Plugin ideas** with the same four columns.
