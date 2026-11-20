"""The navide.browser package the Host pins agrees with the Host's own rules.

navide.browser is built in Navide-dev/navide-browser, whose suite tests its
backend sources. Its manifest for the pinned version is recorded in
tests/fixtures/navide-browser/manifest.json; the Host checks it here against
its agent-tools contract and its CDP allowlist (src/main/plugins/pluginWebViews.ts).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from agent_team_backend.plugins.agent_tools_contract import validate_agent_tools

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPOSITORY_ROOT / "tests" / "fixtures" / "navide-browser" / "manifest.json"


def _host_cdp_methods() -> list[str]:
    host = (REPOSITORY_ROOT / "src" / "main" / "plugins" / "pluginWebViews.ts").read_text(encoding="utf-8")
    block = host.split("const CDP_ALLOWED_METHODS", 1)[1].split("])", 1)[0]
    return sorted(line.strip().strip("',") for line in block.splitlines()[1:] if line.strip())


def test_the_pinned_manifest_lists_the_host_cdp_allowlist_and_passes_the_contract() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert validate_agent_tools(manifest) == []
    tools = {tool["name"]: tool for tool in manifest["backend"]["agentTools"]}
    assert {"browser_close", "browser_tabs", "browser_evaluate", "browser_wait", "browser_dialog", "browser_upload",
            "browser_take_over", "browser_cdp"} <= set(tools)
    assert tools["browser_wait"]["risk"] == "read"
    # The backend writes its HOST_CDP_METHODS into this sentence; it must be the
    # Host's allowlist, no more and no less.
    listed = re.search(r"Navide allows only these methods and refuses every other one with METHOD_NOT_ALLOWED: (.+?)\.(?:\s|$)", tools["browser_cdp"]["description"])
    assert listed, tools["browser_cdp"]["description"]
    assert sorted(method.strip() for method in listed.group(1).split(",")) == _host_cdp_methods()
