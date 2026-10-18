"""Agent writes to Navide's plugin install root and trust stores are critical.

Navide's userData holds the plugin install root (`plugins/`, which also holds
the Developer Mode folder list, activation and grant stores), the local trust
records (`plugin-local-trust/`), the native backend consent store
(`plugin-native-backends/native-backends.json`) and the kept-source markers
and set-aside folders beside third-party backend data. A same-user process
that writes them can make Navide load code without the consent dialog (review
of #422, MED-1), so an agent tool call that writes, deletes, moves, links or
chmods them is graded critical. Reads keep their grading: agents may inspect
installed plugins. The userData names are the ones Electron derives from
package.json `name` (`agent-team`) and the dev overrides in
src/main/devUserData.ts (`-dev`, `-dev-plans-<profile>`, an explicit
NAVIDE_DEV_USER_DATA_DIR)."""

from __future__ import annotations

import importlib

import pytest

from agent_team_backend import guard_hooks
from agent_team_backend.guard import classify, evaluate
from agent_team_backend.guard.builtin_rules import FLOOR_RULES, RULES_BY_ID

HOME = "/home/tester"
WS = "/home/tester/proj"
RULE = "plugin-store-write"

MAC = "~/Library/Application Support/agent-team"
LINUX = "~/.config/agent-team"
WIN = "~/AppData/Roaming/agent-team"
MAC_ESC = r"~/Library/Application\ Support/agent-team"


@pytest.fixture(autouse=True)
def _fake_home(monkeypatch):
    monkeypatch.setenv("HOME", HOME)
    monkeypatch.setenv("USERPROFILE", HOME)
    for var in ("TMPDIR", "XDG_CONFIG_HOME", "APPDATA", "NAVIDE_DEV_USER_DATA_DIR"):
        monkeypatch.delenv(var, raising=False)


def sh(command, cwd=WS):
    return classify("Bash", {"command": command}, cwd=cwd, workspace=WS)


def tool(name, **inp):
    return classify(name, inp, cwd=WS, workspace=WS)


PROTECTED = [
    f"{MAC}/plugins/acme.demo/frontend/evil.js",
    f"{MAC}/plugins/.navide-plugin-developer-mode.json",
    f"{MAC}/plugins",
    f"{MAC}/plugin-local-trust/acme.demo.json",
    f"{MAC}/plugin-local-trust/acme.demo.candidate.json",
    f"{MAC}/plugin-native-backends/native-backends.json",
    f"{MAC}/plugin-native-backends/data/acme.demo@kept-source.json",
    f"{MAC}/plugin-native-backends/data/acme.demo@set-aside-marketplace-1700000000000",
    f"{MAC}/plugin-native-backends/data/acme.demo@set-aside-local-unsigned-1700000000000-2/state.db",
    f"{MAC}-dev/plugins/acme.demo/manifest.json",
    f"{MAC}-dev-plans-alpha/plugin-local-trust/acme.demo.json",
    f"{LINUX}/plugins/acme.demo/manifest.json",
    f"{LINUX}-dev/plugin-local-trust/acme.demo.json",
    f"{WIN}/plugins/acme.demo/manifest.json",
    f"{WIN}-dev/plugin-native-backends/native-backends.json",
]


# ---------------------------------------------------------------- file tools

@pytest.mark.parametrize("path", PROTECTED)
@pytest.mark.parametrize("name, key", [
    ("Write", "file_path"), ("Edit", "file_path"), ("MultiEdit", "file_path"),
    ("NotebookEdit", "notebook_path"), ("write_file", "path"), ("edit_file", "path"),
    ("replace", "path"), ("create", "path"), ("str_replace_editor", "path"),
])
def test_file_tool_writes_are_critical(name, key, path):
    v = tool(name, **{key: path})
    assert v.level == "critical" and RULE in v.rule_ids, v


@pytest.mark.parametrize("path", PROTECTED)
@pytest.mark.parametrize("name, key", [("Read", "file_path"), ("read_file", "absolute_path"), ("view", "path")])
def test_file_tool_reads_stay_normal(name, key, path):
    v = tool(name, **{key: path})
    assert v.level == "normal" and v.rule_ids == (), v


@pytest.mark.parametrize("inp", [
    {"pattern": "**/*.json", "path": f"{MAC}/plugins"},
    {"pattern": f"{MAC}/plugin-local-trust/*"},
])
def test_search_tools_stay_normal(inp):
    assert tool("Glob", **inp).level == "normal"
    assert tool("Grep", pattern="x", **({"path": inp["path"]} if "path" in inp else {"glob": inp["pattern"]})).level == "normal"


# ---------------------------------------------------------------- shell

@pytest.mark.parametrize("command", [
    f"echo x > {MAC_ESC}/plugin-local-trust/acme.demo.json",
    f"echo x >> {MAC_ESC}/plugins/acme.demo/frontend/index.js",
    f"printf '%s' x | tee {MAC_ESC}/plugin-local-trust/acme.demo.json",
    f"tee -a {LINUX}/plugins/acme.demo/manifest.json < x.json",
    f"sed -i '' 's/a/b/' {MAC_ESC}/plugins/acme.demo/manifest.json",
    f"sed --in-place 's/a/b/' {LINUX}/plugins/acme.demo/manifest.json",
    f"cp evil.js {MAC_ESC}/plugins/acme.demo/frontend/",
    f"cp -R ./pkg {LINUX}/plugins/acme.demo",
    f"cp -t {LINUX}/plugin-local-trust forged.json",
    f"cp --target-directory={LINUX}/plugin-local-trust forged.json",
    f"install -m 600 forged.json {LINUX}/plugin-local-trust/acme.demo.json",
    f"rsync -a ./pkg/ {LINUX}/plugins/acme.demo/",
    f"mv /tmp/forged.json {MAC_ESC}/plugin-local-trust/acme.demo.json",
    f"mv {MAC_ESC}/plugins/acme.demo /tmp/x",
    f"ln -s /tmp/evil {MAC_ESC}/plugins/acme.demo",
    f"ln -s {LINUX}/plugins ./plugins-link",
    f"ln {LINUX}/plugin-local-trust/acme.demo.json hard.json",
    f"chmod 777 {LINUX}/plugin-native-backends/native-backends.json",
    f"chmod -R 777 {LINUX}/plug*",
    f"touch {LINUX}/plugin-native-backends/data/acme.demo@kept-source.json",
    f"truncate -s 0 {LINUX}/plugin-local-trust/acme.demo.json",
    f"rm {LINUX}/plugin-native-backends/data/acme.demo@kept-source.json",
    f"rm -rf {LINUX}/plugin-native-backends/data/acme.demo@set-aside-marketplace-1",
    f"rm -rf {LINUX}/plugins/acme.demo",
    f"rm {LINUX}/plugin-local-trust/*.json",
    f"find {LINUX}/plugins -name '*.js' -delete",
    f"cd {LINUX} && echo '{{}}' > plugin-local-trust/acme.demo.json",
    f"cp x.json {LINUX}/{{plugins,other}}/",
    f"mv /tmp/fake {LINUX}",
    f"bash -c 'echo x > {LINUX}/plugin-local-trust/a.json'",
    f"cp forged.json {LINUX}-dev-plans-beta/plugin-local-trust/a.json",
    f"chmod -R 777 ~/.config/agent*/plugins",
])
def test_shell_writes_are_critical(command):
    v = sh(command)
    assert v.level == "critical" and RULE in v.rule_ids, (command, v)


@pytest.mark.parametrize("command", [
    f"ls -la {MAC_ESC}/plugins",
    f"cat {MAC_ESC}/plugin-local-trust/acme.demo.json",
    f"cat {LINUX}/plugins/acme.demo/manifest.json > ./manifest-copy.json",
    f"cp {LINUX}/plugins/acme.demo/manifest.json ./manifest-copy.json",
    f"cp -R {LINUX}/plugins/acme.demo ./inspect",
    f"rsync -a {LINUX}/plugins/acme.demo/ ./inspect/",
    f"sed -n 1,5p {LINUX}/plugins/acme.demo/manifest.json",
    f"grep -r activate {LINUX}/plugins",
    f"find {LINUX}/plugins -name manifest.json",
    f"du -sh {LINUX}/plugin-native-backends/data",
    f"stat {LINUX}/plugin-native-backends/native-backends.json",
])
def test_shell_reads_stay_normal(command):
    v = sh(command)
    assert v.level == "normal" and RULE not in v.rule_ids, (command, v)


# ---------------------------------------------------------------- neighbours

@pytest.mark.parametrize("path", [
    # A plugin's own backend data folder stays out of scope.
    f"{LINUX}/plugin-native-backends/data/acme.demo/state.json",
    f"{LINUX}/plugin-native-backends/data/acme.demo/notes@kept-source.json",
    f"{LINUX}/plugin-native-backends/native-backends.json.bak/x",
    f"{LINUX}/open-windows.json",
    f"{LINUX}/plugin-storage-v2/x.json",
    f"{LINUX}/pluginsx/a.json",
    f"{LINUX}/plugin-local-trust-old/a.json",
    f"{LINUX}-other/plugins/a.json",
    "~/.config/other-app/plugins/a.json",
    "~/Library/Application Support/other-app/plugin-local-trust/a.json",
    "~/proj/plugins/acme.demo/manifest.json",
    "~/proj/agent-team/plugins/x.js",
    "/tmp/agent-team/plugins/x.js",
    "~/.config",
    "~/Library/Application Support",
])
def test_neighbour_writes_grade_as_on_main(path):
    v = tool("Write", file_path=path)
    assert RULE not in v.rule_ids, (path, v)


def test_neighbour_shell_write_grades_as_on_main():
    assert sh(f"echo x > {LINUX}/plugin-native-backends/data/acme.demo/state.json").level == "normal"
    assert sh("echo x > plugins/acme.demo/manifest.json").level == "normal"
    assert sh("cp -R ./pkg ./plugins/acme.demo").level == "normal"


# ---------------------------------------------------------------- platforms

def test_xdg_config_home_is_honoured(monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", "/srv/cfg")
    assert tool("Write", file_path="/srv/cfg/agent-team/plugins/a/x.js").level == "critical"
    assert sh("rm -rf /srv/cfg/agent-team-dev/plugin-local-trust").level == "critical"


def test_explicit_dev_user_data_dir_is_honoured(monkeypatch):
    monkeypatch.setenv("NAVIDE_DEV_USER_DATA_DIR", "/srv/navide-dev-data")
    v = tool("Write", file_path="/srv/navide-dev-data/plugin-local-trust/a.json")
    assert v.level == "critical" and RULE in v.rule_ids
    assert tool("Write", file_path="/srv/navide-dev-data/notes.txt").level == "normal"
    # A relative value is ignored by Navide (devUserData.ts), so it is here too.
    monkeypatch.setenv("NAVIDE_DEV_USER_DATA_DIR", "rel/dir")
    assert tool("Write", file_path=f"{WS}/rel/dir/plugins/a.json").level == "normal"


@pytest.fixture()
def windows(monkeypatch):
    mod = importlib.import_module("agent_team_backend.guard.classify")
    monkeypatch.setattr(mod, "_WINDOWS", True)
    monkeypatch.setattr(mod, "_FOLD_CASE", True)
    monkeypatch.setattr(mod, "_home", lambda: mod._norm(r"C:\Users\alice"))
    monkeypatch.delenv("HOME", raising=False)


@pytest.mark.parametrize("name, inp", [
    ("Write", {"file_path": r"C:\Users\alice\AppData\Roaming\agent-team\plugins\acme.demo\x.js"}),
    ("Write", {"file_path": r"c:\users\ALICE\appdata\roaming\Agent-Team\Plugin-Local-Trust\a.json"}),
    ("Write", {"file_path": r"D:\Roam\agent-team-dev\plugin-local-trust\a.json"}),
    ("powershell", {"command": r"echo x > C:\Users\alice\AppData\Roaming\agent-team\plugin-local-trust\a.json"}),
    ("Bash", {"command": "cp x.json /c/Users/alice/AppData/Roaming/agent-team/plugin-local-trust/"}),
])
def test_windows_appdata(windows, monkeypatch, name, inp):
    monkeypatch.setenv("APPDATA", r"D:\Roam")
    ws = r"C:\Users\alice\proj"
    v = classify(name, inp, cwd=ws, workspace=ws)
    assert v.level == "critical" and RULE in v.rule_ids, v


def test_unmodelled_powershell_cmdlet_keeps_its_current_grading(windows):
    # Disclosed limit: cmdlets such as Set-Content are not modelled as writes.
    ws = r"C:\Users\alice\proj"
    v = classify("powershell", {"command": r"Set-Content C:\Users\alice\AppData\Roaming\agent-team\plugins\a.js x"},
                 cwd=ws, workspace=ws)
    assert RULE not in v.rule_ids


def test_windows_reads_stay_normal(windows):
    ws = r"C:\Users\alice\proj"
    v = classify("Read", {"file_path": r"C:\Users\alice\AppData\Roaming\agent-team\plugins\a\manifest.json"},
                 cwd=ws, workspace=ws)
    assert v.level == "normal"


def test_case_folds_where_the_filesystem_does(monkeypatch):
    mod = importlib.import_module("agent_team_backend.guard.classify")
    monkeypatch.setattr(mod, "_FOLD_CASE", True)
    assert tool("Write", file_path="~/LIBRARY/application support/Agent-Team/PLUGINS/a.js").level == "critical"
    monkeypatch.setattr(mod, "_FOLD_CASE", False)
    assert tool("Write", file_path="~/.config/Agent-Team/plugins/a.js").level == "normal"


# ---------------------------------------------------------------- hooks, table, policy

@pytest.mark.parametrize("vendor, payload", [
    ("codex", {"tool_name": "apply_patch", "tool_input": {"command":
        f"*** Begin Patch\n*** Add File: {LINUX}/plugin-local-trust/a.json\n*** End Patch"}}),
    ("codex", {"tool_name": "apply_patch", "tool_input": {"command":
        f"*** Begin Patch\n*** Update File: a.py\n*** Move to: {LINUX}/plugins/acme.demo/x.js\n*** End Patch"}}),
    ("qwen", {"tool_name": "write_file", "tool_input": {"file_path": f"{LINUX}/plugins/a/x.js"}}),
    ("qwen", {"tool_name": "run_shell_command", "tool_input": {"command": f"rm -rf {LINUX}/plugin-local-trust"}}),
    ("copilot", {"toolName": "create", "toolArgs": {"path": f"{MAC}/plugin-local-trust/a.json"}}),
    ("copilot", {"toolName": "edit", "toolArgs": {"path": f"{MAC}/plugins/a/x.js"}}),
    ("copilot", {"toolName": "bash", "toolArgs": {"command": f"echo x > {MAC_ESC}/plugins/a/x.js"}}),
])
def test_vendor_hook_payloads_reach_the_rule(vendor, payload):
    graded = [classify(t, i, cwd=WS, workspace=WS) for t, i in guard_hooks.normalise(vendor, payload)]
    assert any(v.level == "critical" and RULE in v.rule_ids for v in graded), graded


def test_rule_is_listed_as_a_critical_floor_rule():
    rule = RULES_BY_ID[RULE]
    assert (rule.group, rule.level) == ("critical", "critical")
    assert RULE in FLOOR_RULES


def test_guard_off_only_audits_a_plugin_store_write(guard_store):
    guard_store.set_enabled(False)
    d = evaluate(pane_id="p1", vendor="claude", tool="Write",
                 tool_input={"file_path": f"{LINUX}/plugin-local-trust/a.json"}, cwd=WS, workspace=WS)
    assert d.action == "allow" and d.reason.startswith("guard disabled; ")
    (entry,) = guard_store.audit_list()
    assert entry["level"] == "critical" and RULE in entry["rule_ids"]


def test_guard_on_asks_for_a_plugin_store_write(guard_store):
    d = evaluate(pane_id="p1", vendor="claude", tool="Write",
                 tool_input={"file_path": f"{LINUX}/plugin-local-trust/a.json"}, cwd=WS, workspace=WS)
    assert d.action != "allow"


# ---------------------------------------------------------------- Developer Mode file

# K4 keeps the Developer Mode switch and the consented folders in an unsigned
# JSON in pluginsRoot (src/main/plugins/pluginDeveloperModeStore.ts
# DEVELOPER_MODE_FILE, constructed with pluginsRoot() in src/main/index.ts):
# writing it turns Developer Mode on and loads folder plugins without a dialog.
DEV_FILE = ".navide-plugin-developer-mode.json"


@pytest.mark.parametrize("root", [MAC, f"{MAC}-dev", LINUX, WIN])
@pytest.mark.parametrize("name, inp", [
    ("Write", lambda p, e: {"file_path": p}),
    ("Edit", lambda p, e: {"file_path": p}),
    ("Bash", lambda p, e: {"command": f"echo '{{\"enabled\":true}}' > {e}"}),
    ("Bash", lambda p, e: {"command": f"echo x >> {e}"}),
    ("Bash", lambda p, e: {"command": f"printf x | tee {e}"}),
    ("Bash", lambda p, e: {"command": f"rm {e}"}),
    ("Bash", lambda p, e: {"command": f"mv {e} {e}.off"}),
    ("Bash", lambda p, e: {"command": f"mv /tmp/forged.json {e}"}),
    ("Bash", lambda p, e: {"command": f"ln -s /tmp/forged.json {e}"}),
    ("Bash", lambda p, e: {"command": f"cp /tmp/forged.json {e}"}),
])
def test_developer_mode_file_writes_are_critical(root, name, inp):
    path = f"{root}/plugins/{DEV_FILE}"
    v = tool(name, **inp(path, path.replace(" ", r"\ ")))
    assert v.level == "critical" and RULE in v.rule_ids, (name, v)


@pytest.mark.parametrize("root", [MAC, LINUX, WIN])
def test_developer_mode_file_reads_stay_normal(root):
    path = f"{root}/plugins/{DEV_FILE}"
    assert tool("Read", file_path=path).level == "normal"
    assert sh(f"cat {path.replace(' ', chr(92) + ' ')}").level == "normal"
    assert tool("Grep", pattern="enabled", path=path).level == "normal"
