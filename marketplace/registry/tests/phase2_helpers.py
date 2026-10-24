"""Shared setup for the Phase 2 tests: a registry with Navide Cloud sign-in
enabled, and a stand-in for navide-auth that signs callbacks with the
registry client secret. Nothing here touches the network."""

from __future__ import annotations

import re
import time
import urllib.parse
from dataclasses import dataclass, field

from fastapi.testclient import TestClient
from sqlmodel import Session

from registry.app import create_app
from registry.cloud_auth import decode_payload, encode_payload, sign
from registry.config import VERIFIER_ACCEPTING, Settings
from registry.models import DeveloperQualification
from tests.fixtures import build_package, valid_manifest

AUTH_URL = "https://forum.example.test/navide-auth"
AUTH_SECRET = "registry-client-secret-for-tests-0123456789"
SESSION_SECRET = "registry-session-secret-for-tests-9876543210"
RETURN_URL = "https://testserver/auth/callback"
ADMIN_TOKEN = "phase2-admin-token"
ADMIN_MEMBER = "mem-admin"


def cloud_settings(tmp_path, **overrides) -> Settings:
    values = dict(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ACCEPTING,
        require_signature=False,
        require_auth=True,
        admin_token=ADMIN_TOKEN,
        auth_url=AUTH_URL,
        auth_secret=AUTH_SECRET,
        auth_return_url=RETURN_URL,
        session_secret=SESSION_SECRET,
        admin_member_ids=(ADMIN_MEMBER,),
    )
    values.update(overrides)
    return Settings(**values)


@dataclass
class FakeDns:
    records: dict[str, list[str]] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)

    def __call__(self, name: str) -> list[str]:
        self.calls.append(name)
        return list(self.records.get(name, []))


def make_client(settings: Settings, dns: FakeDns | None = None) -> TestClient:
    # https base URL: the session cookies are Secure and would not be sent back
    # over plain http.
    app = create_app(settings, txt_resolver=dns or FakeDns())
    return TestClient(app, base_url="https://testserver", follow_redirects=False)


def navide_auth_callback(
    nonce: str,
    *,
    member_id: str = "mem-1",
    name: str = "Neil",
    secret: str = AUTH_SECRET,
    client: str = "registry",
    email_verified: str = "true",
    issued_at_ms: int | None = None,
) -> dict[str, str]:
    """What navide-auth appends to the registry's return URL."""
    sso = encode_payload(
        {
            "nonce": nonce,
            "client": client,
            "external_id": member_id,
            "name": name,
            "email_verified": email_verified,
            "issued_at": str(issued_at_ms if issued_at_ms is not None else int(time.time() * 1000)),
        }
    )
    return {"sso": sso, "sig": sign(secret, sso)}


def start_login(client: TestClient, next_path: str = "/publisher") -> str:
    """GET /login; return the nonce navide-auth would receive."""
    resp = client.get("/login", params={"next": next_path})
    assert resp.status_code == 303, resp.text
    location = urllib.parse.urlsplit(resp.headers["location"])
    query = dict(urllib.parse.parse_qsl(location.query))
    return decode_payload(query["sso"])["nonce"]


def approve_developer(client: TestClient, member_id: str) -> None:
    """Record an approved developer qualification directly (the review flow
    itself is covered by test_developer_qualification.py)."""
    with Session(client.app.state.registry.engine) as session:
        if session.get(DeveloperQualification, member_id) is None:
            session.add(DeveloperQualification(navide_member_id=member_id, status="approved"))
            session.commit()


def sign_in(client: TestClient, member_id: str = "mem-1", name: str = "Neil", *, approved: bool = True) -> None:
    """Sign in through the navide-auth stand-in. `approved` (the default for
    tests that predate developer qualification) also approves the account."""
    if approved:
        approve_developer(client, member_id)
    nonce = start_login(client)
    resp = client.get("/auth/callback", params=navide_auth_callback(nonce, member_id=member_id, name=name))
    assert resp.status_code == 303, resp.text


def csrf_of(client: TestClient, path: str = "/publisher/claim") -> str:
    html = client.get(path).text
    match = re.search(r'name="csrf" value="([0-9a-f]+)"', html)
    assert match, html
    return match.group(1)


def claim(client: TestClient, namespace: str):
    return client.post("/publisher/claim", data={"namespace": namespace, "csrf": csrf_of(client)})


def new_token(client: TestClient, namespace: str, label: str = "ci") -> str:
    resp = client.post(
        f"/publisher/{namespace}/tokens",
        data={"label": label, "days": "30", "csrf": csrf_of(client, f"/publisher/{namespace}")},
    )
    assert resp.status_code == 200, resp.text
    match = re.search(r"(nvp_[A-Za-z0-9_-]+)", resp.text)
    assert match, resp.text
    return match.group(1)


def package_for(
    namespace: str,
    name: str,
    version: str = "1.0.0",
    extra_files: dict[str, bytes] | None = None,
    **manifest: object,
) -> bytes:
    return build_package(
        manifest=valid_manifest(id=f"{namespace}.{name}", version=version, publisher=namespace, **manifest),
        extra_files=extra_files,
    )


def publish(client: TestClient, token: str, data: bytes, target: str = "universal"):
    return client.post(
        "/api/publish",
        params={"target": target},
        files={"package": ("p.vsix", data, "application/zip")},
        headers={"Authorization": f"Bearer {token}"},
    )


ADMIN_HEADERS = {"X-Admin-Token": ADMIN_TOKEN}


def queued_artifacts(client: TestClient, namespace: str, name: str, version: str = "1.0.0") -> list[str]:
    """The package digests the review queue shows for a submission, which an
    approve or reject must carry back."""
    items = client.get("/api/admin/review", headers=ADMIN_HEADERS).json()["items"]
    for item in items:
        if (item["namespace"], item["name"], item["version"]) == (namespace, name, version):
            return item["artifacts"]
    return []


def register_official(client: TestClient, name: str = "navide", token: str = "official-token") -> str:
    resp = client.post(
        "/api/publishers",
        json={"name": name, "token": token},
        headers={"X-Admin-Token": ADMIN_TOKEN},
    )
    assert resp.status_code == 201, resp.text
    return token
