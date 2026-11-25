"""The website is script-free: every HTML page carries a Content-Security-Policy
without script-src, and no template can carry script."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from registry.app import create_app
from tests.fixtures import build_package, valid_manifest
from tests.phase2_helpers import cloud_settings, make_client, sign_in

TEMPLATES = Path(__file__).parents[1] / "registry" / "web_templates"


def _directives(policy: str) -> dict[str, str]:
    out = {}
    for part in policy.split(";"):
        name, _, value = part.strip().partition(" ")
        out[name] = value
    return out


def _publish(client: TestClient) -> None:
    resp = client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", build_package(manifest=valid_manifest()), "application/zip")},
    )
    assert resp.status_code == 201, resp.text


def test_html_pages_carry_a_script_free_policy(client: TestClient) -> None:
    _publish(client)
    for path in ("/", "/?q=hello", "/extensions/acme/hello", "/removed"):
        resp = client.get(path)
        assert resp.status_code == 200, path
        policy = _directives(resp.headers["content-security-policy"])
        assert policy["default-src"] == "'none'"
        assert "script-src" not in policy
        assert policy["style-src"] == "'self'"
        assert policy["img-src"] == "'self' data:"
        assert policy["frame-ancestors"] == "'none'"
        assert policy["base-uri"] == "'none'"
        assert policy["form-action"].split()[0] == "'self'"


def test_form_action_allows_the_cli_loopback_and_navide_auth(tmp_path) -> None:
    client = make_client(cloud_settings(tmp_path))
    sign_in(client)
    resp = client.get("/publisher/claim")
    form_action = _directives(resp.headers["content-security-policy"])["form-action"].split()
    assert form_action == ["'self'", "http://127.0.0.1:*", "https://auth.example.test"]


def test_json_api_and_package_assets_keep_their_own_headers(client: TestClient) -> None:
    _publish(client)
    assert "content-security-policy" not in client.get("/api/extensions").headers
    asset = client.get("/extensions/acme/hello/1.0.0/assets/icon.png")
    assert asset.headers.get("content-security-policy", "").startswith("default-src 'none'; sandbox")


def test_policy_is_added_under_a_root_path(tmp_path) -> None:
    from registry.config import VERIFIER_ACCEPTING, Settings

    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path,
                verifier_kind=VERIFIER_ACCEPTING,
                require_signature=False,
                require_auth=False,
                root_path="/registry",
            )
        )
    )
    assert "frame-ancestors 'none'" in client.get("/registry/").headers["content-security-policy"]


def test_templates_contain_no_script() -> None:
    inline_handler = re.compile(r"\son[a-z]+\s*=", re.IGNORECASE)
    for template in TEMPLATES.glob("*.html"):
        text = template.read_text(encoding="utf-8")
        assert "<script" not in text.lower(), template.name
        assert "javascript:" not in text.lower(), template.name
        assert not inline_handler.search(text), template.name
