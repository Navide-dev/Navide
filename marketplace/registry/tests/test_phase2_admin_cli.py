"""DNS verification, the admin blocklist and removed list, `navide-plugin
login`, and the Phase 2 migrations."""

from __future__ import annotations

import os
import sqlite3
import stat
import urllib.parse
import urllib.request

import pytest

from registry import cli
from registry.db import create_db_engine
from registry.dns_verify import record_host, record_value
from registry.migrations import MIGRATIONS, applied_migrations, run_migrations
from tests.phase2_helpers import (
    ADMIN_HEADERS,
    ADMIN_MEMBER,
    FakeDns,
    claim,
    cloud_settings,
    csrf_of,
    make_client,
    new_token,
    package_for,
    publish,
    queued_artifacts,
    register_official,
    sign_in,
)
from tests.test_migrations import HEAD_SCHEMA


@pytest.fixture()
def dns():
    return FakeDns()


@pytest.fixture()
def client(tmp_path, dns):
    client = make_client(cloud_settings(tmp_path), dns)
    sign_in(client)
    assert claim(client, "acme-tools").status_code == 303
    return client


# -- DNS TXT verification -------------------------------------------------------
def _add_domain(client, domain="acme.example"):
    csrf = csrf_of(client, "/publisher/acme-tools")
    return client.post("/publisher/acme-tools/domain", data={"domain": domain, "csrf": csrf})


def _check(client):
    return client.post("/publisher/acme-tools/domain/check", data={"csrf": csrf_of(client, "/publisher/acme-tools")})


def _token_on_page(client) -> str:
    html = client.get("/publisher/acme-tools").text
    return html.split("navide-verify=")[1].split("\n")[0].split("<")[0].strip()


def test_domain_verification_uses_the_injected_resolver(client, dns):
    assert _add_domain(client).status_code == 303
    page = client.get("/publisher/acme-tools").text
    assert "_navide-verify.acme.example" in page
    not_yet = _check(client)
    assert "not found yet" in not_yet.text
    assert dns.calls == ["_navide-verify.acme.example"]

    dns.records[record_host("acme.example")] = ['"unrelated"', f'"{record_value(_token_on_page(client))}"']
    assert _check(client).status_code == 303
    assert "✓ verified · acme.example" in client.get("/publisher/acme-tools").text

    # The badge shows on the public page once something is approved.
    token = new_token(client, "acme-tools")
    publish(client, token, package_for("acme-tools", "lint-guard"))
    client.post(
        "/api/admin/review/acme-tools/lint-guard/1.0.0/approve",
        json={"artifacts": queued_artifacts(client, "acme-tools", "lint-guard")},
        headers=ADMIN_HEADERS,
    )
    detail = client.get("/extensions/acme-tools/lint-guard").text
    assert "✓ verified · acme.example" in detail
    assert '<span class="badge badge-verified" title="Publisher proved control of acme.example (DNS)">' in detail


def test_changing_the_domain_resets_verification(client, dns):
    _add_domain(client)
    dns.records[record_host("acme.example")] = [record_value(_token_on_page(client))]
    _check(client)
    _add_domain(client, "other.example")
    page = client.get("/publisher/acme-tools").text
    assert "✓ verified" not in page
    assert "_navide-verify.other.example" in page


def test_resolver_failure_is_not_verified(tmp_path):
    def broken(_name):
        raise OSError("no network in tests")

    client = make_client(cloud_settings(tmp_path), broken)
    sign_in(client)
    claim(client, "acme-tools")
    _add_domain(client)
    assert "not found yet" in _check(client).text


@pytest.mark.parametrize("domain", ["not a domain", "http://acme.example", "localhost", "-bad.example"])
def test_invalid_domains_are_refused(client, domain):
    resp = _add_domain(client, domain)
    assert resp.status_code == 400
    assert "Enter a domain name" in resp.text


# -- blocklist + removed list ---------------------------------------------------
def test_admin_blocklist_removes_hides_and_signs(client):
    official = register_official(client)
    publish(client, official, package_for("navide", "git"))
    publish(client, official, package_for("navide", "notes"))

    resp = client.post(
        "/api/admin/blocklist",
        json={"kind": "package", "value": "navide.notes", "reason": "Malware reported"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 201
    entry_id = resp.json()["id"]

    listed = [i["identity"] for i in client.get("/api/extensions").json()["items"]]
    assert listed == ["navide.git"]
    assert client.get("/api/extensions/navide/notes").status_code == 404
    assert publish(client, official, package_for("navide", "notes", "2.0.0")).json()["detail"] == "package is blocked"
    metadata = client.get("/api/extensions/navide/git").json()["trust_metadata"]
    assert {"packageId": "navide.notes"} in metadata["blockedPackages"]
    removed = client.get("/api/removed").json()["items"]
    assert removed[0]["id"] == "navide.notes" and removed[0]["reason"] == "Malware reported"
    assert "Malware reported" in client.get("/removed").text

    assert client.delete(f"/api/admin/blocklist/{entry_id}", headers=ADMIN_HEADERS).status_code == 204
    assert client.get("/api/extensions/navide/notes").status_code == 200


def test_blocklist_web_ui_is_admin_only(client):
    assert client.get("/admin/blocklist").status_code == 403
    sign_in(client, member_id=ADMIN_MEMBER, name="Admin")
    csrf = csrf_of(client, "/admin/blocklist")
    bad = client.post("/admin/blocklist", data={"kind": "package", "value": "NOT VALID", "reason": "x", "csrf": csrf})
    assert bad.status_code == 400
    ok = client.post("/admin/blocklist", data={"kind": "publisher", "value": "acme-tools", "reason": "Spam", "csrf": csrf})
    assert ok.status_code == 303
    assert "Spam" in client.get("/admin/blocklist").text
    assert client.post("/api/admin/blocklist", json={"kind": "x", "value": "y", "reason": "z"}).status_code == 401


def test_config_blocklist_appears_on_the_removed_list(tmp_path):
    client = make_client(cloud_settings(tmp_path, blocked_packages=("evil.pkg",)))
    items = client.get("/api/removed").json()["items"]
    assert items == [{"kind": "package", "id": "evil.pkg", "reason": None, "removed_at": None}]


# -- navide-plugin login ----------------------------------------------------------
class _Browser:
    """Plays the user's browser: authorize in the registry, follow the
    redirect to the CLI's loopback listener."""

    def __init__(self, client, namespace="acme-tools", tamper_state=False):
        self.client = client
        self.namespace = namespace
        self.tamper_state = tamper_state

    def __call__(self, url: str) -> None:
        parts = urllib.parse.urlsplit(url)
        page = self.client.get(f"{parts.path}?{parts.query}")
        assert page.status_code == 200, page.text
        params = dict(urllib.parse.parse_qsl(parts.query))
        csrf = page.text.split('name="csrf" value="')[1].split('"')[0]
        resp = self.client.post(
            "/cli/authorize",
            data={**params, "namespace": self.namespace, "csrf": csrf},
        )
        assert resp.status_code == 303, resp.text
        location = resp.headers["location"]
        assert location.startswith(f"http://127.0.0.1:{params['port']}/callback?")
        if self.tamper_state:
            location = location.replace("state=", "state=x")
        urllib.request.urlopen(location, timeout=5).read()  # loopback only


def _post_json(client):
    def post(url: str, payload: dict):
        resp = client.post(urllib.parse.urlsplit(url).path, json=payload)
        return resp.status_code, resp.json()

    return post


def test_cli_login_gets_a_publish_token_without_a_password(client, tmp_path, monkeypatch):
    monkeypatch.setenv(cli.CONFIG_DIR_ENV, str(tmp_path / "cfg"))
    entry = cli.run_login("https://testserver/", open_browser=_Browser(client), post_json=_post_json(client), timeout=10)
    assert entry["namespace"] == "acme-tools"
    assert publish(client, entry["token"], package_for("acme-tools", "cli-made")).status_code == 201

    path = cli.store_credentials("https://testserver/", entry)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert cli.stored_token("https://testserver") == entry["token"]
    assert "navide-plugin CLI" in client.get("/publisher/acme-tools").text


def test_cli_login_rejects_a_state_mismatch(client):
    with pytest.raises(cli.LoginError, match="state mismatch"):
        cli.run_login(
            "https://testserver", open_browser=_Browser(client, tamper_state=True), post_json=_post_json(client), timeout=10
        )


def test_cli_code_needs_the_pkce_verifier_and_is_single_use(client):
    challenge = cli.pkce_challenge("v" * 50)
    params = {"port": "5555", "state": "s" * 20, "code_challenge": challenge, "label": "t"}
    page = client.get("/cli/authorize", params=params)
    csrf = page.text.split('name="csrf" value="')[1].split('"')[0]
    resp = client.post("/cli/authorize", data={**params, "namespace": "acme-tools", "csrf": csrf})
    code = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(resp.headers["location"]).query))["code"]
    assert client.post("/api/cli/token", json={"code": code, "code_verifier": "w" * 50}).status_code == 400
    # A wrong verifier burns the code.
    assert client.post("/api/cli/token", json={"code": code, "code_verifier": "v" * 50}).status_code == 400


@pytest.mark.parametrize(
    "params",
    [
        {"port": "80", "state": "s" * 20, "code_challenge": "c" * 43},
        {"port": "5555", "state": "short", "code_challenge": "c" * 43},
        {"port": "5555", "state": "s" * 20, "code_challenge": "c" * 10},
        {"port": "5555", "state": "s" * 19 + "/", "code_challenge": "c" * 43},
    ],
)
def test_cli_authorize_validates_its_parameters(client, params):
    assert client.get("/cli/authorize", params=params).status_code == 400


def test_cli_authorize_refuses_a_namespace_you_do_not_own(client):
    params = {"port": "5555", "state": "s" * 20, "code_challenge": "c" * 43}
    csrf = csrf_of(client, "/cli/authorize?" + urllib.parse.urlencode(params))
    assert client.post("/cli/authorize", data={**params, "namespace": "navide", "csrf": csrf}).status_code == 404


# -- migrations -------------------------------------------------------------------
def test_phase2_migrations_upgrade_an_existing_registry(tmp_path):
    path = tmp_path / "registry.db"
    connection = sqlite3.connect(path)
    for ddl in HEAD_SCHEMA:
        connection.execute(ddl)
    connection.execute("INSERT INTO publisher VALUES (1, 'navide', NULL, NULL, NULL, '2026-01-01')")
    connection.execute(
        "INSERT INTO extension VALUES (1, 1, 'navide', 'git', 'navide.git', NULL, NULL, '[]', 0, 0, 0, 0, "
        "'2026-01-01', '2026-01-01')"
    )
    connection.execute(
        "INSERT INTO extension_version VALUES (1, 1, '1.0.0', '{}', 'd', 'k', NULL, 'universal', '{}', 'sig', "
        "'signed-verified', 0, 0, '2026-01-01')"
    )
    connection.commit()
    connection.close()

    engine = create_db_engine(path)
    applied = applied_migrations(engine)
    assert applied[4] == "publisher-cloud-identity" and applied[5] == "version-review-state"
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT review_status, review_report FROM extension_version").fetchone() == ("approved", "{}")
        assert db.execute("SELECT review_required, navide_member_id FROM publisher").fetchone() == (0, None)
    # Idempotent on a second start.
    create_db_engine(path)


def _schema(path) -> tuple[dict[str, set], set[str]]:
    """({table: {(column, declared type, not-null)}}, index names). Column
    order and SQL defaults are left out: ALTER TABLE appends columns and adds
    defaults that `create_all` never writes."""
    with sqlite3.connect(path) as db:
        tables = [
            row[0]
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        ]
        columns = {
            table: {(row[1], row[2].upper(), row[3]) for row in db.execute(f"PRAGMA table_info({table})")}
            for table in tables
        }
        indexes = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    return columns, indexes


def test_fresh_and_upgraded_databases_end_at_the_same_schema(tmp_path):
    """A fresh database and one upgraded from the pre-Phase-2 head schema must
    end at the same schema and the same recorded steps, 1..10 in order."""
    numbers = [number for number, _name, _step in MIGRATIONS]
    assert numbers == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

    fresh = tmp_path / "fresh.db"
    fresh_engine = create_db_engine(fresh)

    upgraded = tmp_path / "upgraded.db"
    connection = sqlite3.connect(upgraded)
    for ddl in HEAD_SCHEMA:
        connection.execute(ddl)
    connection.commit()
    connection.close()
    upgraded_engine = create_db_engine(upgraded)

    assert applied_migrations(fresh_engine) == applied_migrations(upgraded_engine)
    assert sorted(applied_migrations(fresh_engine)) == numbers
    fresh_columns, fresh_indexes = _schema(fresh)
    upgraded_columns, upgraded_indexes = _schema(upgraded)
    assert fresh_columns == upgraded_columns
    # Migration 6's legacy rating columns carry the same SQL default on both.
    for path in (fresh, upgraded):
        with sqlite3.connect(path) as db:
            defaults = {row[1]: row[4] for row in db.execute("PRAGMA table_info(extension)")}
        assert (defaults["legacy_rating_sum"], defaults["legacy_rating_count"]) == ("0", "0"), path
    # Only the indexes Phase 2 adds: HEAD_SCHEMA is a hand-written fixture
    # that already lacks some `create_all` indexes on the older tables.
    phase2_indexes = {"ix_publisher_navide_member_id", "ix_extension_version_review_status"}
    assert phase2_indexes <= fresh_indexes and phase2_indexes <= upgraded_indexes
    # A restart applies nothing on either.
    assert run_migrations(fresh_engine) == [] and run_migrations(upgraded_engine) == []


# -- screenshot-review fixes ------------------------------------------------------
def test_cli_authorize_shows_the_requesting_cli_escaped(client):
    params = {"port": "5555", "state": "s" * 20, "code_challenge": "c" * 43, "label": "<script>x</script> ci"}
    html = client.get("/cli/authorize", params=params).text
    assert "&lt;script&gt;x&lt;/script&gt; ci" in html
    assert "<script>x</script>" not in html
    assert "http://127.0.0.1:5555/callback" in html
    assert 'action="/cli/deny"' in html


def test_cli_cancel_denies_and_the_cli_stops_waiting(client):
    params = {"port": "5555", "state": "s" * 20, "code_challenge": "c" * 43}
    assert client.post("/cli/deny", data={**params, "csrf": "x"}).status_code == 403
    csrf = csrf_of(client, "/cli/authorize?" + urllib.parse.urlencode(params))
    resp = client.post("/cli/deny", data={**params, "csrf": csrf})
    assert resp.status_code == 303
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(resp.headers["location"]).query))
    assert query == {"error": "access_denied", "state": "s" * 20}
    assert resp.headers["location"].startswith("http://127.0.0.1:5555/callback?")


class _CancellingBrowser(_Browser):
    def __call__(self, url: str) -> None:
        parts = urllib.parse.urlsplit(url)
        page = self.client.get(f"{parts.path}?{parts.query}")
        params = dict(urllib.parse.parse_qsl(parts.query))
        csrf = page.text.split('name="csrf" value="')[1].split('"')[0]
        resp = self.client.post("/cli/deny", data={**params, "csrf": csrf})
        urllib.request.urlopen(resp.headers["location"], timeout=5).read()  # loopback only


def test_cli_login_reports_a_cancelled_request(client):
    with pytest.raises(cli.LoginError, match="cancelled"):
        cli.run_login("https://testserver", open_browser=_CancellingBrowser(client), post_json=_post_json(client), timeout=10)


def test_links_and_danger_badges_use_theme_tokens():
    from pathlib import Path

    css = (Path(cli.__file__).parent / "web_static" / "style.css").read_text()
    assert "\na { color: var(--accent); }" in css
    assert "a:visited" not in css  # would out-rank .install-button's white text
    assert ".badge-danger { background: var(--danger-bg); color: var(--danger-fg); }" in css
    dark = css[css.rindex("prefers-color-scheme: dark") :]
    assert "--danger-fg" in dark


def test_migration_runner_tolerates_numbering_gaps(tmp_path, monkeypatch):
    """Synthetic steps 1, 2 and 9: the runner applies them in order, records
    each once, and a later-added step fills its number without replaying."""
    from sqlalchemy import create_engine

    from registry import migrations

    def add(table):
        return lambda connection: connection.execute(f"CREATE TABLE {table} (id INTEGER)")

    engine = create_engine(f"sqlite:///{tmp_path / 'gaps.db'}")
    monkeypatch.setattr(migrations, "MIGRATIONS", ((1, "a", add("t1")), (2, "b", add("t2")), (9, "c", add("t9"))))
    assert run_migrations(engine) == [1, 2, 9]
    assert run_migrations(engine) == []
    monkeypatch.setattr(
        migrations,
        "MIGRATIONS",
        ((1, "a", add("t1")), (2, "b", add("t2")), (5, "d", add("t5")), (9, "c", add("t9"))),
    )
    assert run_migrations(engine) == [5]
    assert applied_migrations(engine) == {1: "a", 2: "b", 5: "d", 9: "c"}
