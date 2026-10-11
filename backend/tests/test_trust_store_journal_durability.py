"""The journal survives power loss and is not redirected by a link (KC-8).

`secret_files.write_private` — shared with CLI account slots, so not changed
here — writes once with no fsync: a power cut could leave an empty journal,
which reads as "damaged" and costs the ledger. A single ``os.write`` can also
stop short. And a journal path that is a symlink was followed when read.
"""

from __future__ import annotations

import os
import stat
import sys

import pytest

from agent_team_backend import trust_store

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX writer; Windows uses DPAPI")


def _write_some() -> None:
    trust_store.load()
    trust_store.note_remote_command("dev-a", device_name="TKM5", workspace="w", pane_name="p")


def test_the_journal_is_fsynced_with_its_directory(monkeypatch):
    synced: list[str] = []
    real = os.fsync

    def spy(fd):
        synced.append(stat.S_IFMT(os.fstat(fd).st_mode) == stat.S_IFDIR and "dir" or "file")
        return real(fd)

    monkeypatch.setattr(os, "fsync", spy)
    _write_some()
    assert "file" in synced and "dir" in synced


def test_a_short_write_still_writes_everything(monkeypatch):
    real = os.write
    monkeypatch.setattr(os, "write", lambda fd, data: real(fd, bytes(data[:7])))
    _write_some()
    # Put back by hand: monkeypatch.undo() would also undo conftest's isolation.
    monkeypatch.setattr(os, "write", real)
    trust_store._state = None
    trust_store._forget_written()
    assert [n["kind"] for n in trust_store.notices()] == ["remote-command"]


def test_the_journal_directory_is_owner_only():
    _write_some()
    mode = stat.S_IMODE(os.stat(trust_store._journal_path().parent).st_mode)
    assert mode == 0o700


def test_a_journal_path_that_is_a_link_is_neither_followed_nor_written_through(tmp_path):
    trust_store.load()
    elsewhere = tmp_path / "someone-elses-file.json"
    elsewhere.write_text('{"notices": [], "seenMessages": {"planted": 1}}', encoding="utf-8")
    path = trust_store._journal_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    path.symlink_to(elsewhere)
    trust_store._state = None
    trust_store._forget_written()

    assert trust_store.has_seen_message("planted") is False
    trust_store.note_remote_command("dev-a", device_name="TKM5", workspace="w", pane_name="p")
    assert elsewhere.read_text(encoding="utf-8") == '{"notices": [], "seenMessages": {"planted": 1}}'
    assert not path.is_symlink()


@pytest.mark.skipif(sys.platform == "win32", reason="drives the Windows writer with DPAPI stubbed")
def test_the_windows_journal_writer_fsyncs_too(monkeypatch, tmp_path):
    """Review KC2R-8: on Windows the journal went through `_write_atomic`, one
    write and no fsync. That writer is shared with CLI account slots and stays
    as it is; the journal's own writer syncs before the rename."""
    from agent_team_backend.osplat import _windows

    monkeypatch.setattr(_windows, "_dpapi", lambda _fn, data: bytes(data))
    synced: list[int] = []
    real = os.fsync

    def spy(fd):
        synced.append(fd)
        return real(fd)

    monkeypatch.setattr(os, "fsync", spy)
    path = tmp_path / "device-trust" / "journal.json"
    _windows.durable_secret_files.write(path, b'{"v":1}')
    # Put back by hand: monkeypatch.undo() would also undo conftest's isolation.
    monkeypatch.setattr(os, "fsync", real)
    assert synced
    assert path.read_bytes() == _windows.DPAPI_MAGIC + b'{"v":1}'
    assert _windows.durable_secret_files.read(path) == b'{"v":1}'
