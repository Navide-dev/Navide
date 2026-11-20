"""Shipped Log batch 2: deploy commands seen by the PostToolUse hooks are
recorded as masked, unconfirmed hints — and nothing is ever blocked."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import app as app_module
from agent_team_backend import hook_auth
from agent_team_backend.db import WorkspaceDatabases
from agent_team_backend.plugins.builtin.navide_shipped_log import deploy_detect
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import ShipLogLedger


def _fake_npm_token() -> str:
    # Built at run time so no token-shaped literal is ever in the repository.
    return "np" + "m_" + "Qw7" * 12


@pytest.mark.parametrize("command, rule", [
    ("npm publish --access public", "package-publish"),
    ("cd web && NODE_ENV=production pnpm publish", "package-publish"),
    ("uv publish dist/*", "package-publish"),
    ("docker push registry.example/app:1.2", "container-push"),
    ("docker buildx build . -t app --push", "container-push"),
    ("kubectl apply -f k8s/", "kubernetes"),
    ("helm upgrade api ./chart", "kubernetes"),
    ("terraform apply -auto-approve", "infrastructure"),
    ("npx vercel --prod", "platform-deploy"),
    ("sudo -E fly deploy", "platform-deploy"),
    ("gcloud run deploy api --region asia-east1", "platform-deploy"),
    ("aws ecs update-service --cluster c --service s --force-new-deployment", "cloud-update"),
    ("gh release create v1.2.3 --notes x", "github-release"),
    ("git push origin main", "git-push-deploy-branch"),
    ("git push origin HEAD:production", "git-push-deploy-branch"),
    ("./scripts/deploy.sh prod", "deploy-script"),
    ("bash release.sh", "deploy-script"),
    ("make build deploy", "deploy-task"),
    ("pnpm run deploy:prod", "deploy-task"),
])
def test_deploy_commands_match(command: str, rule: str) -> None:
    found = deploy_detect.match(command)
    assert found is not None and found[0] == rule


@pytest.mark.parametrize("command", [
    "git push origin feat/shipped-log-full-0246",
    "git push",
    "npm install",
    "pnpm test:run",
    "docker build -t app .",
    "kubectl get pods",
    "terraform plan",
    "vercel dev",
    "cat deploy.log",
    "grep -n release CHANGELOG.md",
])
def test_ordinary_commands_do_not_match(command: str) -> None:
    assert deploy_detect.match(command) is None


def test_the_excerpt_is_masked() -> None:
    token = _fake_npm_token()
    masked = deploy_detect.mask(f"NPM_TOKEN={token} npm publish --otp 123456 --registry https://ops@example.com")
    assert token not in masked and "123456" not in masked and "ops@example.com" not in masked
    assert "NPM_TOKEN=***" in masked and "npm publish" in masked
    assert len(deploy_detect.mask("x " * 400)) == 160


def test_only_the_matching_command_is_kept(tmp_path: Path) -> None:
    book = ShipLogLedger(WorkspaceDatabases())
    payload = {"tool_name": "Bash", "tool_input": {"command": "echo secret-ish note && ./deploy.sh prod"}}
    row = deploy_detect.observe(str(tmp_path), pane="api", vendor="claude", ok=True, payload=payload, book=book, now=100)
    [found] = book.detections(str(tmp_path), 0)["detections"]
    assert row == found["id"] and found["excerpt"] == "./deploy.sh prod" and found["rule"] == "deploy-script"
    assert (found["pane"], found["vendor"], found["ok"], found["status"]) == ("api", "claude", True, "pending")


@pytest.mark.parametrize("payload", [
    {"tool_name": "Read", "tool_input": {"command": "npm publish"}},
    {"tool_name": "Bash", "tool_input": {"command": "npm test"}},
    {"tool_name": "Bash", "tool_input": "npm publish"},
    {"tool_name": "Bash"},
])
def test_nothing_else_is_recorded(tmp_path: Path, payload: dict) -> None:
    book = ShipLogLedger(WorkspaceDatabases())
    assert deploy_detect.observe(str(tmp_path), pane="p", vendor="claude", ok=True, payload=payload, book=book) is None
    assert not (tmp_path / ".agent-team" / "navide.db").exists()


# ── through the hook endpoint ───────────────────────────────────────────────


@pytest.fixture()
def hooked(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[TestClient, Path, ShipLogLedger]:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    book = ShipLogLedger(WorkspaceDatabases())
    monkeypatch.setattr(deploy_detect, "_default", book)
    monkeypatch.setattr(app_module.attribution, "pane_for_session",
                        lambda sid: ("pane-1", str(workspace), "") if sid == "s1" else ("", "", ""))
    monkeypatch.setattr(app_module, "host_disabled_plugins", lambda: frozenset())

    async def quiet(*_a: Any, **_k: Any) -> None:
        return None

    monkeypatch.setattr(app_module, "broadcast", quiet)
    client = TestClient(app_module.app, base_url="http://127.0.0.1")
    client.headers[hook_auth.HEADER] = hook_auth.token()
    return client, workspace, book


def _post(client: TestClient, kind: str, session: str, command: str) -> Any:
    return client.post("/hooks/claude", headers={"X-Agent-Team-Event": kind}, json={
        "session_id": session, "cwd": "/", "tool_name": "Bash", "tool_input": {"command": command},
        "tool_response": {"stdout": ""},
    })


def test_a_tool_result_records_the_deploy_and_answers_as_before(hooked: Any) -> None:
    client, workspace, book = hooked
    ok = _post(client, "post_tool_use", "s1", "npm publish")
    failed = _post(client, "post_tool_use_failure", "s1", "./deploy.sh")
    assert ok.status_code == failed.status_code == 200 and ok.json() == failed.json() == {"ok": True}
    rows = book.detections(str(workspace), 0)["detections"]
    assert [(r["rule"], r["ok"], r["pane"]) for r in rows] == [("package-publish", True, "pane-1"),
                                                               ("deploy-script", False, "pane-1")]


def test_nothing_is_recorded_without_a_pane_or_with_the_plugin_off(hooked: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client, workspace, book = hooked
    _post(client, "post_tool_use", "unknown-session", "npm publish")
    monkeypatch.setattr(app_module, "host_disabled_plugins", lambda: frozenset({"navide.shipped-log"}))
    _post(client, "post_tool_use", "s1", "npm publish")
    _post(client, "pre_tool_use", "s1", "npm publish")
    assert book.detections(str(workspace), 0)["detections"] == []


def test_a_failing_ledger_never_changes_the_answer(hooked: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _workspace, _book = hooked

    def broken(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("disk full")

    monkeypatch.setattr(deploy_detect, "observe", broken)
    answer = _post(client, "post_tool_use", "s1", "npm publish")
    assert answer.status_code == 200 and answer.json() == {"ok": True}
