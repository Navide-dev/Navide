"""Upgrading registry databases created by earlier schemas."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from registry.app import create_app
from registry.config import VERIFIER_ACCEPTING, Settings
from registry.db import create_db_engine
from registry.migrations import MIGRATIONS, applied_migrations, run_migrations
from tests.test_multi_target import MACHO_ARM64, PE_X64, _backend_package

# Verbatim DDL that `create_all` produced before per-target artifacts.
_PUBLISHER = """CREATE TABLE publisher (
    id INTEGER NOT NULL, name VARCHAR NOT NULL, display_name VARCHAR,
    public_key VARCHAR, token_hash VARCHAR, created_at DATETIME NOT NULL,
    PRIMARY KEY (id))"""
_ASSET = """CREATE TABLE extension_asset (
    id INTEGER NOT NULL, version_id INTEGER NOT NULL, path VARCHAR NOT NULL,
    size INTEGER NOT NULL, content_type VARCHAR NOT NULL, PRIMARY KEY (id),
    FOREIGN KEY(version_id) REFERENCES extension_version (id))"""
HEAD_SCHEMA = [
    _PUBLISHER,
    """CREATE TABLE extension (
    id INTEGER NOT NULL, publisher_id INTEGER NOT NULL,
    namespace VARCHAR NOT NULL, name VARCHAR NOT NULL, identity VARCHAR NOT NULL,
    display_name VARCHAR, description VARCHAR, categories JSON,
    featured BOOLEAN NOT NULL, download_count INTEGER NOT NULL,
    rating_sum INTEGER NOT NULL, rating_count INTEGER NOT NULL,
    created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
    PRIMARY KEY (id), CONSTRAINT uq_extension_identity UNIQUE (namespace, name),
    FOREIGN KEY(publisher_id) REFERENCES publisher (id))""",
    """CREATE TABLE extension_version (
    id INTEGER NOT NULL, extension_id INTEGER NOT NULL, version VARCHAR NOT NULL,
    manifest JSON, package_digest VARCHAR NOT NULL, package_key VARCHAR NOT NULL,
    signature VARCHAR, target VARCHAR NOT NULL, registry_envelope JSON,
    registry_signature VARCHAR, trust_tier VARCHAR NOT NULL,
    download_count INTEGER NOT NULL, yanked BOOLEAN NOT NULL,
    published_at DATETIME NOT NULL, PRIMARY KEY (id),
    CONSTRAINT uq_version_identity UNIQUE (extension_id, version),
    FOREIGN KEY(extension_id) REFERENCES extension (id))""",
    "CREATE INDEX ix_extension_version_version ON extension_version (version)",
    "CREATE INDEX ix_extension_version_target ON extension_version (target)",
    _ASSET,
]
# An older registry that predates both the discovery counters and signing
# columns (the columns were added by hand ALTERs, which skipped the counters).
PRE_DISCOVERY_SCHEMA = [
    _PUBLISHER,
    """CREATE TABLE extension (
    id INTEGER NOT NULL, publisher_id INTEGER NOT NULL,
    namespace VARCHAR NOT NULL, name VARCHAR NOT NULL, identity VARCHAR NOT NULL,
    display_name VARCHAR, description VARCHAR, categories JSON,
    created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
    PRIMARY KEY (id), CONSTRAINT uq_extension_identity UNIQUE (namespace, name),
    FOREIGN KEY(publisher_id) REFERENCES publisher (id))""",
    """CREATE TABLE extension_version (
    id INTEGER NOT NULL, extension_id INTEGER NOT NULL, version VARCHAR NOT NULL,
    manifest JSON, package_digest VARCHAR NOT NULL, package_key VARCHAR NOT NULL,
    signature VARCHAR, trust_tier VARCHAR NOT NULL, yanked BOOLEAN NOT NULL,
    published_at DATETIME NOT NULL, PRIMARY KEY (id),
    CONSTRAINT uq_version_identity UNIQUE (extension_id, version),
    FOREIGN KEY(extension_id) REFERENCES extension (id))""",
    _ASSET,
]


def _create(path: Path, schema: list[str]) -> None:
    with sqlite3.connect(path) as db:
        for statement in schema:
            db.execute(statement)
        db.execute(
            "INSERT INTO publisher VALUES (1, 'navide', 'Navide', NULL, NULL, "
            "'2026-09-01 00:00:00')"
        )


def _seed_head(path: Path, blob_key: str) -> None:
    _create(path, HEAD_SCHEMA)
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO extension VALUES (1, 1, 'navide', 'skills', "
            "'navide.skills', 'Skills', 'desc', '[\"dev\"]', 1, 7, 9, 2, "
            "'2026-09-01 00:00:00', '2026-09-01 00:00:00')"
        )
        db.execute(
            "INSERT INTO extension_version VALUES (5, 1, '1.0.0', '{}', 'abc', ?, "
            "NULL, 'darwin-arm64', '{\"target\": \"darwin-arm64\"}', 'sig', "
            "'signed-verified', 7, 0, '2026-09-01 00:00:00')",
            (blob_key,),
        )
        db.execute(
            "INSERT INTO extension_asset VALUES (1, 5, 'README.md', 10, 'text/markdown')"
        )


def _unique_sets(path: Path) -> set[tuple[str, ...]]:
    with sqlite3.connect(path) as db:
        sets = set()
        for _seq, index, unique, origin, _partial in db.execute(
            "PRAGMA index_list(extension_version)"
        ):
            if unique and origin == "u":
                info = db.execute(f"PRAGMA index_info({index})").fetchall()
                sets.add(tuple(row[2] for row in sorted(info)))
        return sets


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ACCEPTING,
        require_signature=False,
        require_auth=False,
    )


def test_head_schema_upgrades_with_data_preserved(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    blob_key = "navide/skills/1.0.0/package.vsix"
    darwin = _backend_package(MACHO_ARM64)
    blob = settings.storage_root / blob_key
    blob.parent.mkdir(parents=True)
    blob.write_bytes(darwin)
    _seed_head(settings.db_path, blob_key)

    client = TestClient(create_app(settings))

    assert _unique_sets(settings.db_path) == {("extension_id", "version", "target")}
    with sqlite3.connect(settings.db_path) as db:
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute(
            "SELECT id, package_key, target, download_count, registry_signature "
            "FROM extension_version"
        ).fetchall() == [(5, blob_key, "darwin-arm64", 7, "sig")]
        assert db.execute("SELECT version_id FROM extension_asset").fetchall() == [(5,)]
        indexes = {
            row[1] for row in db.execute("PRAGMA index_list(extension_version)")
        }
    assert {"ix_extension_version_version", "ix_extension_version_target"} <= indexes

    detail = client.get("/api/extensions/navide/skills").json()
    assert detail["download_count"] == 7
    # Anonymous ratings left the public aggregate (migration 6) but are kept.
    assert detail["rating_count"] == 0
    with sqlite3.connect(settings.db_path) as db:
        assert db.execute(
            "SELECT legacy_rating_sum, legacy_rating_count FROM extension"
        ).fetchall() == [(9, 2)]
    assert [v["target"] for v in detail["versions"]] == ["darwin-arm64"]
    # The legacy blob key is read from the row, so the old artifact still serves.
    resp = client.get("/api/extensions/navide/skills/1.0.0/download")
    assert resp.content == darwin

    # The upgraded schema accepts a second target for the same version.
    windows = _backend_package(PE_X64)
    resp = client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", windows, "application/zip")},
        params={"target": "win32-x64"},
    )
    assert resp.status_code == 201, resp.text
    resp = client.get(
        "/api/extensions/navide/skills/1.0.0/download", params={"target": "win32-x64"}
    )
    assert resp.content == windows


def test_pre_discovery_schema_gains_counter_columns(tmp_path: Path) -> None:
    path = tmp_path / "registry.db"
    _create(path, PRE_DISCOVERY_SCHEMA)
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO extension VALUES (1, 1, 'navide', 'skills', "
            "'navide.skills', 'Skills', 'desc', '[]', "
            "'2026-09-01 00:00:00', '2026-09-01 00:00:00')"
        )
        db.execute(
            "INSERT INTO extension_version VALUES (1, 1, '1.0.0', '{}', 'abc', "
            "'k', NULL, 'unsigned', 0, '2026-09-01 00:00:00')"
        )

    engine = create_db_engine(path)

    assert sorted(applied_migrations(engine)) == [number for number, _, _ in MIGRATIONS]
    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT featured, download_count, rating_sum, rating_count FROM extension"
        ).fetchall() == [(0, 0, 0, 0)]
        assert db.execute(
            "SELECT target, registry_envelope, download_count FROM extension_version"
        ).fetchall() == [("universal", "{}", 0)]
    assert _unique_sets(path) == {("extension_id", "version", "target")}


def test_fresh_database_records_every_migration_and_reruns_are_noops(
    tmp_path: Path,
) -> None:
    engine = create_db_engine(tmp_path / "registry.db")
    assert sorted(applied_migrations(engine)) == [number for number, _, _ in MIGRATIONS]
    assert run_migrations(engine) == []
    assert _unique_sets(tmp_path / "registry.db") == {
        ("extension_id", "version", "target")
    }


def test_failed_migration_rolls_back_and_is_not_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "registry.db"
    _create(path, HEAD_SCHEMA)

    def broken(connection: sqlite3.Connection) -> None:
        connection.execute("CREATE TABLE half_done (id INTEGER)")
        raise RuntimeError("boom")

    import registry.migrations as migrations

    monkeypatch.setattr(
        migrations, "MIGRATIONS", (*MIGRATIONS[:2], (3, "artifact-per-target", broken))
    )
    with pytest.raises(RuntimeError, match="boom"):
        create_db_engine(path)
    with sqlite3.connect(path) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master")}
        recorded = [row[0] for row in db.execute("SELECT version FROM schema_migrations")]
    assert "half_done" not in tables
    assert recorded == [1, 2]
    assert _unique_sets(path) == {("extension_id", "version")}

    monkeypatch.undo()
    create_db_engine(path)
    assert _unique_sets(path) == {("extension_id", "version", "target")}


def test_migration_10_backfills_channel_from_semver(tmp_path: Path) -> None:
    path = tmp_path / "registry.db"
    _create(path, HEAD_SCHEMA)
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO extension VALUES (1, 1, 'navide', 'skills', "
            "'navide.skills', 'Skills', 'desc', '[]', 0, 0, 0, 0, "
            "'2026-09-01 00:00:00', '2026-09-01 00:00:00')"
        )
        for row_id, version in ((1, "1.0.0"), (2, "1.1.0-beta.1"), (3, "1.1.0+build.7")):
            db.execute(
                "INSERT INTO extension_version VALUES (?, 1, ?, '{}', 'abc', 'k', "
                "NULL, 'universal', '{}', NULL, 'unsigned', 0, 0, "
                "'2026-09-01 00:00:00')",
                (row_id, version),
            )

    engine = create_db_engine(path)

    assert applied_migrations(engine)[10] == "version-channel-expiry"
    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT version, channel, expires_at FROM extension_version ORDER BY id"
        ).fetchall() == [
            ("1.0.0", "stable", None),
            ("1.1.0-beta.1", "pre-release", None),
            ("1.1.0+build.7", "stable", None),
        ]
        indexes = {row[1] for row in db.execute("PRAGMA index_list(extension_version)")}
    assert "ix_extension_version_channel" in indexes

    # Running the step again (a half-recorded run) changes nothing.
    step = next(step for number, _, step in MIGRATIONS if number == 10)
    with sqlite3.connect(path) as db:
        step(db)
        assert db.execute(
            "SELECT channel FROM extension_version ORDER BY id"
        ).fetchall() == [("stable",), ("pre-release",), ("stable",)]
    assert run_migrations(engine) == []


def test_migration_10_on_a_fresh_database(tmp_path: Path) -> None:
    path = tmp_path / "registry.db"
    engine = create_db_engine(path)
    assert applied_migrations(engine)[10] == "version-channel-expiry"
    with sqlite3.connect(path) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(extension_version)")}
    assert {"channel", "expires_at"} <= columns
    assert run_migrations(engine) == []


def test_migration_11_on_an_old_database_backfills_key_history(tmp_path: Path) -> None:
    from registry.signing import generate_keypair, public_key_fingerprint

    _private, public_pem = generate_keypair()
    path = tmp_path / "registry.db"
    _create(path, HEAD_SCHEMA)
    with sqlite3.connect(path) as db:
        db.execute("UPDATE publisher SET public_key = ? WHERE id = 1", (public_pem,))
        db.execute(
            "INSERT INTO publisher VALUES (2, 'broken', NULL, 'not a key', NULL, "
            "'2026-09-01 00:00:00')"
        )

    engine = create_db_engine(path)

    assert applied_migrations(engine)[11] == "developer-qualification"
    with sqlite3.connect(path) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(publisher)")}
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        keys = db.execute("SELECT publisher_id, key_id, revoked_at FROM publisher_key").fetchall()
        qualifications = db.execute("SELECT COUNT(*) FROM developer_qualification").fetchone()
    assert {"frozen_at", "frozen_reason"} <= columns
    assert {
        "developer_qualification",
        "account_token",
        "account_auth_code",
        "publisher_key",
        "registry_audit",
    } <= tables
    # The unparsable key gets no history row; nobody is grandfathered.
    assert keys == [(1, public_key_fingerprint(public_pem), None)]
    assert qualifications == (0,)

    # Running the step again (a half-recorded run) changes nothing.
    step = next(step for number, _, step in MIGRATIONS if number == 11)
    with sqlite3.connect(path) as db:
        step(db)
        assert db.execute("SELECT COUNT(*) FROM publisher_key").fetchone() == (1,)
    assert run_migrations(engine) == []


def test_migration_11_on_a_fresh_database(tmp_path: Path) -> None:
    path = tmp_path / "registry.db"
    engine = create_db_engine(path)
    assert applied_migrations(engine)[11] == "developer-qualification"
    step = next(step for number, _, step in MIGRATIONS if number == 11)
    with sqlite3.connect(path) as db:
        step(db)
    assert run_migrations(engine) == []
