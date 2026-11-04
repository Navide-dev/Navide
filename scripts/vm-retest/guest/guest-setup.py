# guest-setup.py <root>: point the test account's Claude Code at the local stub (fake key built by concatenation),
#   mark the test workspaces trusted, skip onboarding. Touches only the test account's own files.
import json, os, pathlib, sys
root = pathlib.Path(sys.argv[1]); home = pathlib.Path.home()
key = "stub-" + "key-for-local-test"
c = home / ".claude.json"; d = json.loads(c.read_text()) if c.exists() else {}
d.update(hasCompletedOnboarding=True, theme="dark", autoUpdates=False, customApiKeyResponses={"approved": [key[-20:]], "rejected": []})
p = d.setdefault("projects", {})
for w in ("wa", "wg", "wf"):
    (root / w).mkdir(parents=True, exist_ok=True)
    p[str(root / w).replace("\\", "/")] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}
c.write_text(json.dumps(d))
s = home / ".claude" / "settings.json"; s.parent.mkdir(exist_ok=True); sd = json.loads(s.read_text()) if s.exists() else {}
sd.setdefault("env", {}).update(ANTHROPIC_BASE_URL="http://127.0.0.1:8951", ANTHROPIC_API_KEY=key, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", DISABLE_AUTOUPDATER="1")
sd["skipDangerousModePermissionPrompt"] = True; s.write_text(json.dumps(sd)); print("ok")
