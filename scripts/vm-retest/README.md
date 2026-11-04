# VM re-test scripts

The packaged-build acceptance run for webhook triggers, pipelines, inter-CLI messaging and channels. Every
release runs the same list on a Linux arm64 and a Windows arm64 VM, plus the items that release fixed.

Nothing here talks to a real model, chat service or account:

- Claude Code in the guest is pointed at `guest/stub.py`, a local stand-in for the Messages API on
  `127.0.0.1:8951`. Its API key is a fake string built by concatenation.
- The Matrix channel tests use `guest/fakematrix.py`. It is a minimal homeserver on `127.0.0.1:48771` with a fake
  token.
- The guests hold no credentials. They only have test accounts that exist for this purpose.

## Layout

| Path | Runs on | What it is |
|---|---|---|
| `host/env.sh` | VM host | Settings: VM paths, snapshots, guest addresses, test accounts, ssh key, optional remote VM host |
| `host/vm.sh` | VM host | `start`, `stop` (clean guest shutdown), `revert` to the snapshot, `pause`, `unpause`, `ip`, `state` |
| `host/gsh.sh`, `host/gcp.sh` | VM host | Run a command in a guest; copy files in or out |
| `host/linux-up.sh`, `host/windows-up.sh` | VM host | Install the build under test and start the stub and the app |
| `host/run-full.sh` | VM host | Start one half (`pre` or `post`) of the full list, detached in the guest |
| `host/restart-app.sh` | VM host | Quit the app the way a person does, check nothing is left, start it again |
| `host/load-sampler.sh`, `host/load-supervisor.sh` | VM host | Record the host load; pause and resume the VM around load spikes |
| `host/collect.sh` | VM host | Copy the evidence out before the revert |
| `guest/` | guest (`~/wh`) | The test scripts. Python 3.12 standard library only, plus PowerShell on Windows |

The guest working folder is always `~/wh` (`%USERPROFILE%\wh` on Windows).

## Configuration

Every value in `host/env.sh` can be overridden from the environment, or from a file named by `VM_RETEST_ENV`:

```bash
VM_DIR="$HOME/Virtual Machines.localized"       # the .vmwarevm bundles
LINUX_VMX=... WINDOWS_VMX=...                     # default: the two bundles under VM_DIR
LINUX_SNAPSHOT=pre-navide-0.2.13                  # every round starts from, and is reverted to, these
WINDOWS_SNAPSHOT=installed-clean-updated
LINUX_GUEST= WINDOWS_GUEST=                       # empty: ask `vmrun getGuestIPAddress` (needs VMware Tools in the guest)
LINUX_USER=navide WINDOWS_USER=navide             # test accounts
SSH_KEY="$HOME/.ssh/navide_vm_ed25519"            # the key those accounts accept
VM_HOST=                                          # empty: VMware Fusion runs here
```

To run against VMs on another machine (for example a Mac mini), set `VM_HOST=user@host`. `vmrun` then runs there
over ssh, and the guests are reached with `ProxyJump` through it. The script that samples the host load also
samples that machine.

The scripts never create or change credentials, with one exception: the Windows auto-logon password. Windows
needs a password for the test account to log on to the desktop by itself, so `windows-up.sh` makes a new random one
for each round. It is generated on the host and sent only inside the encoded PowerShell command. It is not printed
and not written to any file, and the snapshot revert at the end throws it away.

## A round, step by step

One VM at a time. Start the load sampler first and keep it running for the whole round:

```bash
cd scripts/vm-retest/host
./load-sampler.sh ~/vm-round/host-load.txt        # prints its PID; end it by that PID at the end
```

### Linux

```bash
./vm.sh linux start &                              # leave it running in the background; do not kill this job
./linux-up.sh <dir with the .deb and the .AppImage>
./run-full.sh linux pre
./load-supervisor.sh linux ~/vm-round/host-load.txt ~/vm-round/pauses-linux.txt   # returns when the half ends
#   ... the items under "Run by hand", then a real restart:
./restart-app.sh linux
./run-full.sh linux post
./load-supervisor.sh linux ~/vm-round/host-load.txt ~/vm-round/pauses-linux.txt
./collect.sh linux ~/vm-round/linux
./vm.sh linux stop && ./vm.sh linux revert
```

### Windows

Windows uses the same steps, with `windows-up.sh <dir with the .exe>` in place of `linux-up.sh`.

On Windows, anything that has to outlive the ssh session runs as a scheduled task in the desktop session, at Normal
priority. A process started over ssh dies when the session closes. A plain `schtasks /Create` task runs at
BelowNormal, and then any Normal-priority load starves the app.

## Load rules

The host is shared, so a busy host can make results meaningless. The rules:

- `load-supervisor.sh` pauses the whole VM when the host's 1-minute load stays at 40 or above for 30 seconds.
- It resumes the VM once the load has stayed below 20 for 2 minutes.
- Each pause and resume is logged with the time, the load and the section in progress. Re-run the item that was in
  progress.
- If the total pause time passes one hour, the script exits so the run owner can report it.
- `HI` and `LO` override the two thresholds.

## What the full list checks (`guest/wfull.py`)

### `pre` half

| Section | What it verifies |
|---|---|
| DRIVER (`drv.py` phases) | Webhooks are off by default. The configured port is not bound while off, and the guard is on. Setup creates the triggers. Bearer, GitHub (signature) and form (CSRF, origin) triggers accept good requests and reject bad ones with the right status. Codex is reachable. A reset clears state. The trigger secret never appears in clear in the data folder. The command line never carries it. |
| 0s | With a stub that answers instantly, one-stage and two-stage runs still end `completed`. |
| CTRLU | ConPTY Ctrl-U on a multi-line paste, a 900-character typed line and a 120-line paste. Each is recorded and the screens are replayed on the host. The box must be empty after the first Ctrl-U. |
| m, ask, inj, dup, rep | Manager loops (`winloops.py`): the kickoff goes out, is never left unsubmitted, and gets exactly one REPORT. ASK leads to exactly one DISPATCH. Injected routing markers inside webhook data do not route. A REPORT that is already routed is not sent again. A REPORT survives repeated resizes (no repaint duplicates). |
| E1 | A test-only user-level Stop hook sleeps 20 s while `stub.log.slowstop` exists (`slowhook.py`). Its install and removal are logged, and the settings file is restored byte for byte. The kickoff must wait for `turn_complete`, and it must never be counted as never submitted. |
| C | The Manager is parked on a permission prompt. Nothing runs before the answer, and the REPORT is delivered once after it. |
| INJVAR | Router markers with invisible characters between the dashes (10 variants) are never routed, and plain data passes through intact. |
| SIB ×15 | The worker's role turn parks on a permission prompt, so the run fails. After that, nothing is typed into any pane (no kickoff, no Enter), and the other slot is interrupted at once (`⏹ interrupted … — the run failed`). Runs 6–10 make the worker fast, and 11–15 also make the stub instant, so the failure and the kickoff land in the same second. |
| A dup, D dup, restart-from | In a duplicate window: a Reload followed by Resume never types into a pane that is waiting on a prompt, abort followed by the next run uses a fresh conversation, and restart-from-node starts a new run on a new pane. |
| DIAG | Counts the kickoff and role diagnostic lines across all runs. |
| hold | Leaves one run running for the real restart. |

### `post` half (after the real restart)

| Section | What it verifies |
|---|---|
| restart | The held run comes back `interrupted`, its cards resume, and Resume continues it. |
| A normal ×6 | Reload, then Resume: the run must not type into a waiting prompt, and it completes once answered. |
| E card, E MCP | Abort from the card and from MCP. Each leaves Resume / Start Over, and the next run completes. |
| D normal | Abort, then the next run gets a new pane and a new conversation. |

## Run by hand (between the halves)

These need a window, a recording or a decision, so they are not part of `wfull.py`. Run them with
`gsh.sh <platform> 'python3 <script> ~/wh ...'` on Linux, or `gsh.sh windows 'py:python <script> %USERPROFILE%\wh ...'`
on Windows:

| Script | What it verifies |
|---|---|
| `newtests.py setup`, then `intr2` and `ustop2` | Claude panes take messages mid-turn by design, so these stop the pane first, then send. After `cli_interrupt`, a queued message goes in within seconds. After a person's STOP (the pane's Interrupt menu item), the message stays queued (`hold not-ready`) and is never typed; cancel works. `untype.py` clears the STOP afterwards. |
| `newtests.py msgdelay 110` | Pads the sender's transcript past 100 MB, then sends an MSG block. The receiver gets it exactly once. The script also reports the `turn end for … log X s later` gap, if `backend.log` has one. |
| `newtests.py load 12` | 12 busy processes, each PID recorded and ended by that PID. Three webhook runs: none falsely "never submitted", and no run/agent mismatch. |
| `lineage.py <root> wl setup`, then `newtests.py late 110` | Channels, using `fakematrix.py`. A late reply after a 100 MB+ transcript reaches the room with no "will resend" notice. On Windows, start `lineage.py … setup` from a scheduled task so the fake homeserver outlives ssh. |
| `lineage.py … reopen`, `heldkids`, `wake A` | A channel wake reattaches the commander to its session, its children follow, and the tree nests them without a reload. Wait out the 15 s offline grace before `/wake`. |
| `lineage.py … closewake B1`; after the restart `wake B2` | Waking with the window closed, and after a real restart. |
| `rec.py`, `sibrep.py`, `sibinput.py` | Records one sibling failure, with an idle bystander pane (`byopen.py`). Every keystroke after the failure must be accounted for. |
| `n238.py stopagent`, `stopuser` | The STOP badge. After `cli_interrupt`, a turn started by a `cli_send` shows `running` and the menu's Interrupt is enabled. After a person's STOP, a turn Claude starts on its own (a background Bash job ends) clears the badge, but a `cli_send` stays queued until a person types. |
| `n238.py kick 12` | 12 busy processes and the window minimized, three external `cli_open_agent` calls with a task: the kickoff answer, the attempts in `backend.log`, and what is left in each input box. |
| `n238.py reclaim` | A child opened by a pane reports to it with `cli_send` while its turn runs, and once the child is idle the parent's `cli_reclaim_agent` succeeds. |
| `n238.py browser` | Navide Browser: `browser_snapshot` filter and root, `browser_act` diff, and a Space shared by two panes: one hands off, the other takes over and finishes, and the Space still shows the hand-off. |
| `fakecodex.py`, `WK_AGENT=codex y.py <root> setupm <ws>`, `winloops.py <root> m\|dup …` | A vendor with no turn text. `fakecodex.py`, installed as `codex` on the app's PATH, is a stand-in, not the real CLI: it echoes what is typed and prints a fixed REPORT. The worker slot runs it, and the router must keep its text-only dedupe. |
| `freeze.py <root> <ws>` | Run right after a start. Opens Explorer, right-clicks folder `sub` and opens "Open with" (the editor probe). The renderer heartbeat gap and the IPC round trip show any freeze. |
| `winhold.py hold <port>` / `release` (Windows), `holdport.py <port>` (Linux) | Hold the webhook port across an app start. The listener retries, and binds once the port is released; the next webhook completes. |
| `slowhook.py`, `quitapp.py`, `quitdlg.ps1`, `extcheck.ps1`, `obwalk.py`, `shot.py`, `evjs.py`, `rlog.py`, `stubq.py`, `ck.py`, `bystat.py` | Helpers used by the items above (see each file's header). |

`totals.py` (run by `collect.sh`) prints the round totals: results passed, CLI launches and how many used bypass,
watchdog stalls, kickoffs injected and never submitted, and webhook runs by final state.

## House rules for whoever runs it

- Only end processes whose PID you recorded. No `pkill` or `killall`, and no matching by name.
- Never touch the host's other jobs. One VM at a time. Revert the snapshot after every round.
- Do not change system or security settings inside the guest beyond what the scripts do. Ask the release owner first.
- Never pipe the output of `vmrun start`, and never stop its background job.
- Results go into the release plan's Delivery section. Include every pause and resume, and every test-only hook
  with its content and the times it was added and removed.
