"""Codex startup identity is scoped to one launch, never just a cwd."""
from __future__ import annotations

import json
import os

from agent_team_backend import codex_session_hooks as hooks

SID = '12345678-1234-1234-1234-123456789abc'


def test_session_hook_is_stable_additive_and_keeps_user_files_untouched(tmp_path):
    path = tmp_path / 'hooks.json'
    path.write_text('{"user":true}')
    env, metadata = {}, {}
    result = hooks.wire('codex', env, metadata, tmp_path, tmp_path / 'port', tmp_path / 'auth')
    second = hooks.wire('codex', {}, {}, tmp_path, tmp_path / 'port', tmp_path / 'auth')
    assert result == second
    assert metadata['codex_launch_token'] == env[hooks.LAUNCH_ENV]
    assert env[hooks.LAUNCH_ENV] not in result
    assert 'hooks.SessionStart' in result
    assert 'bypass' not in result
    assert path.read_text() == '{"user":true}'


def test_custom_session_start_override_is_left_alone(tmp_path):
    command = 'codex -c hooks.SessionStart=[]'
    env, metadata = {}, {}
    assert hooks.wire(command, env, metadata, tmp_path, tmp_path / 'port', tmp_path / 'auth') == command
    assert env == {} and metadata == {}


def test_pending_start_waits_for_meta_rejects_subagent_and_stale_launch(tmp_path):
    pending = hooks.PendingStarts()
    token = 'current-token'
    pending.add(token, {'hook_event_name':'SessionStart','session_id': SID, 'source': 'startup', 'cwd': str(tmp_path)})
    path = tmp_path / f'rollout-{SID}.jsonl'
    path.write_text('')
    assert pending.match(path, {token: ('pane-a', str(tmp_path))}) is None
    path.write_text(json.dumps({'type':'session_meta','payload':{'id':SID,'cwd':str(tmp_path),'thread_source':'subagent'}})+'\n')
    assert pending.match(path, {token: ('pane-a', str(tmp_path))}) is None
    path.write_text(json.dumps({'type':'session_meta','payload':{'id':SID,'cwd':str(tmp_path)}})+'\n')
    assert pending.match(path, {'new-token': ('pane-a', str(tmp_path))}) is None
    assert pending.match(path, {token: ('pane-a', str(tmp_path))}) is None


def test_same_cwd_different_panes_bind_only_corresponding_uuid(tmp_path):
    pending = hooks.PendingStarts()
    other = '87654321-1234-1234-1234-123456789abc'
    pending.add('a', {'hook_event_name':'SessionStart','session_id':SID,'source':'startup','cwd':str(tmp_path)})
    pending.add('b', {'hook_event_name':'SessionStart','session_id':other,'source':'startup','cwd':str(tmp_path)})
    live = {'a': ('pane-a', str(tmp_path)), 'b': ('pane-b', str(tmp_path))}
    for sid, pane in [(other,'pane-b'),(SID,'pane-a')]:
        path = tmp_path / f'rollout-{sid}.jsonl'
        path.write_text(json.dumps({'type':'session_meta','payload':{'id':sid,'cwd':str(tmp_path)}})+'\n')
        assert pending.match(path, live) == ('a' if pane == 'pane-a' else 'b', pane, sid)
        pending.consume('a' if pane == 'pane-a' else 'b', sid)
        assert pending.match(path, live) is None


def test_resume_claim_uses_repaired_uuid_not_name_or_option():
    assert hooks.resume_identity(SID) == SID
    assert hooks.resume_identity('--last') == ''
    assert hooks.resume_identity('my-session') == ''


def test_official_subagent_metadata_and_malformed_payload_are_rejected(tmp_path):
    pending = hooks.PendingStarts()
    base = {'hook_event_name':'SessionStart','session_id':SID,'source':'startup','cwd':str(tmp_path)}
    assert not pending.add('a', {**base, 'cwd': []})
    assert not pending.add('a', {**base, 'transcript_path': {}})
    assert not pending.add('a', {**base, 'hook_event_name':'SubagentStart'})
    assert pending.add('a', base)
    path = tmp_path / f'rollout-{SID}.jsonl'
    for extra in [{'source':{'subagent':{'thread_spawn':{'parent_thread_id':'parent'}}}}, {'parent_thread_id':'parent'}]:
        path.write_text(json.dumps({'type':'session_meta','payload':{'id':SID,'cwd':str(tmp_path),**extra}})+'\n')
        assert pending.match(path, {'a':('pane-a',str(tmp_path))}) is None


def test_clear_is_left_to_log_detection_and_cannot_replay_initial_identity(tmp_path):
    pending = hooks.PendingStarts()
    base = {'hook_event_name':'SessionStart','session_id':SID,'source':'startup','cwd':str(tmp_path)}
    assert pending.add('a', base)
    other = '87654321-1234-1234-1234-123456789abc'
    assert not pending.add('a', {**base, 'session_id': other})
    assert not pending.add('a', {**base, 'source':'clear', 'session_id':other})
    pending.consume('a', SID)
    assert not pending.add('a', base)


def test_endpoint_defers_before_registration_and_rejects_old_launch(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from fastapi.testclient import TestClient
    from agent_team_backend import app, hook_auth
    from agent_team_backend.log_readers.attribution import Attribution
    from agent_team_backend.cli_vendors.codex import CodexLogReader
    import asyncio

    reader = CodexLogReader()
    monkeypatch.setattr(reader, 'session_files_for_workspace', lambda _: [])
    attr = Attribution([reader])
    monkeypatch.setattr(app, 'attribution', attr)
    monkeypatch.setattr(app, '_readers', [reader])
    monkeypatch.setattr(app, '_codex_pending_starts', hooks.PendingStarts())
    term = SimpleNamespace(pane_id='pane-a', agent_key='codex', closed=False, cwd=str(tmp_path),
                           metadata={'codex_launch_token':'current','codex_session_home':str(tmp_path)})
    owner = SimpleNamespace(terminals=SimpleNamespace(get=lambda _:term))
    monkeypatch.setattr(app, '_PTY_OWNERS', {'pty':owner})
    monkeypatch.setattr(app, 'track_live_session', lambda **_:None)
    events = []
    async def broadcast(event): events.append(event)
    monkeypatch.setattr(app, 'broadcast', broadcast)
    client = TestClient(app.app, base_url="http://127.0.0.1")
    path = tmp_path / 'sessions' / f'rollout-{SID}.jsonl'
    path.parent.mkdir()
    payload = {'hook_event_name':'SessionStart','session_id':SID,'source':'startup','cwd':str(tmp_path),'transcript_path':str(path)}
    headers = {hook_auth.HEADER:hook_auth.token(), hooks.LAUNCH_HEADER:'current'}
    # SessionStart may precede a transcript file and the async pane baseline.
    assert client.post('/hooks/codex/session-start', headers=headers, json=payload).status_code == 200
    assert events == []
    path.write_text(json.dumps({'type':'session_meta','payload':{'id':SID,'cwd':str(tmp_path),'source':'cli'}})+'\n')
    attr.register_pane('pane-a',vendor='codex',cwd=str(tmp_path))
    asyncio.run(app._retry_codex_session_start('current'))
    detected = [e['payload'] for e in events if e['type']=='session.detected']
    assert detected == [{'vendor':'codex','pane_id':'pane-a','session_id':SID,'workspace_path':str(tmp_path),'session_file':str(path)}]
    assert attr.pane_for_session(SID)[0] == 'pane-a'
    assert attr.pane_for_session(path.stem)[0] == 'pane-a'
    # A log-driven /clear wins over an initial callback delivered late.
    newer = '87654321-1234-1234-1234-123456789abc'
    term.metadata['codex_current_session_id'] = newer
    monkeypatch.setattr(app, '_codex_pending_starts', hooks.PendingStarts())
    assert client.post('/hooks/codex/session-start', headers=headers, json=payload).status_code == 200
    assert term.metadata['codex_current_session_id'] == newer
    assert len(events) == 1
    # A callback for an already announced fallback consumes its pending item
    # and establishes the UUID alias without broadcasting twice.
    term.metadata.pop('codex_current_session_id')
    monkeypatch.setattr(app, '_codex_pending_starts', hooks.PendingStarts())
    assert client.post('/hooks/codex/session-start', headers=headers, json=payload).status_code == 200
    assert not app._codex_pending_starts.has_pending()
    assert len(events) == 1
    term.metadata['codex_launch_token'] = 'replacement'
    assert client.post('/hooks/codex/session-start', headers=headers, json=payload).status_code == 403
    assert len(events) == 1


def test_hook_preserves_all_custom_session_hook_override_shapes(tmp_path):
    for override in ["-c 'hooks={SessionStart=[]}'", "-c 'hooks.\"SessionStart\"=[]'", '--config=hooks.SessionStart=[]', '-chooks.SessionStart=[]']:
        command = 'codex ' + override
        assert hooks.wire(command, {}, {}, tmp_path, tmp_path/'port', tmp_path/'auth') == command


def test_windows_hook_script_keeps_unicode_stdin(monkeypatch):
    import base64
    monkeypatch.setattr(hooks.osplat, 'platform_id', 'win32')
    command=hooks.hook_command()
    script=base64.b64decode(command.rsplit(' ',1)[1]).decode('utf-16-le')
    assert '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)' in script
    assert '$OutputEncoding = [Text.UTF8Encoding]::new($false)' in script
    assert script.index('$OutputEncoding') < script.index('$body | & ($env:SystemRoot')


def test_native_hook_posts_unicode_payload_and_launch_header(tmp_path, monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import pytest
    from tests import hook_shell
    from tests.test_claude_hooks import _run_to_completion

    if hooks.osplat.paths.resolve_program('curl') is None:
        pytest.skip('curl is unavailable for the Codex hook')
    # Launched the way Codex launches a hook: its command runner hands the
    # text to %COMSPEC% /C on Windows (codex-rs/hooks command_runner.rs,
    # build_command). Wrapping it in `powershell -Command` instead started
    # PowerShell twice, and two cold starts overran the budget on the arm64
    # release runner.
    if hooks.osplat.platform_id == 'win32':
        argv = [os.environ.get('COMSPEC') or 'cmd.exe', '/C', hooks.hook_command()]
    else:
        argv = hook_shell.shell_argv({'command':hooks.hook_command()})
    received = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append((json.loads(self.rfile.read(int(self.headers['Content-Length']))), self.headers[hooks.LAUNCH_HEADER]))
            self.send_response(200)
            self.end_headers()
        def log_message(self, *_): pass
    server = HTTPServer(('127.0.0.1',0),Handler)
    # Room for powershell.exe to cold-start on a busy Windows arm64 release
    # runner (45 s overran there on 2026-11-13, run 43455435235); a passing run
    # returns long before it, so the budget asserts nothing about speed. Kept
    # under the suite's 120 s pytest-timeout so a hang still reports here.
    server.timeout = 90
    port = tmp_path/'backend.port'
    port.write_text(str(server.server_address[1]))
    auth = tmp_path/'auth'
    auth.write_text('X-Agent-Team-Hook: test-secret\n')
    monkeypatch.setenv(hooks.LAUNCH_ENV,'test-launch')
    monkeypatch.setenv('NAVIDE_CODEX_PORT_FILE',str(port))
    monkeypatch.setenv('NAVIDE_CODEX_AUTH_FILE',str(auth))
    payload = {'hook_event_name':'SessionStart','session_id':SID,'source':'startup','cwd':str(tmp_path/'中文工作區')}
    thread=threading.Thread(target=server.handle_request,daemon=True)
    thread.start()
    try:
        result = _run_to_completion(argv,json.dumps(payload,ensure_ascii=False),timeout=90)
        thread.join(timeout=91)
    finally:
        server.server_close()
    assert result.returncode == 0
    assert result.stdout == ''
    assert received == [(payload,'test-launch')]


def test_fallback_reader_rejects_subagent_when_optional_thread_source_is_absent():
    from agent_team_backend.cli_vendors.codex import _session_meta_resume_id
    for shape in [{'source': {'subagent': {'thread_spawn': {}}}}, {'parent_thread_id':'parent'}]:
        text = json.dumps({'type':'session_meta','payload':{'id':SID,'cwd':'/ws',**shape}})
        assert _session_meta_resume_id(text) == ''


# ── trust-gate fallback ──────────────────────────────────────────────────────
#
# Whether a Codex build hides a command-line hook behind its trust screen is
# not something a version number answers: 0.155 runs the same injection without
# asking, while 0.154 was reported asking on every pane. So it is observed and
# remembered rather than predicted, and the fallback touches only Navide's own
# behaviour — never the user's Codex config, and never the bypass flag, which
# would exempt the user's own hooks too.


import pytest


@pytest.fixture(autouse=True)
def _clear_trust_gate():
    """The verdict lives in the shared kv, so leaving it set would leak."""
    hooks.set_trust_gate_blocked(False)
    yield
    hooks.set_trust_gate_blocked(False)


def _wire(tmp_path):
    env, metadata = {}, {}
    command = hooks.wire('codex --foo', env, metadata, tmp_path, tmp_path / 'port', tmp_path / 'auth')
    return command, env, metadata


def test_the_hook_is_injected_until_the_trust_screen_is_reported(tmp_path):
    assert hooks.trust_gate_blocks_injection() is False
    command, env, metadata = _wire(tmp_path)
    assert 'hooks.SessionStart' in command
    assert env[hooks.LAUNCH_ENV] and metadata['codex_launch_token']


def test_a_reported_trust_screen_stops_the_injection_entirely(tmp_path):
    hooks.set_trust_gate_blocked(True)
    command, env, metadata = _wire(tmp_path)

    # Not a disabled hook — no hook, and no launch identity to go with it.
    assert command == 'codex --foo'
    assert env == {} and metadata == {}


def test_the_verdict_is_idempotent_and_reversible(tmp_path):
    assert hooks.set_trust_gate_blocked(True) is True
    assert hooks.set_trust_gate_blocked(True) is False  # already recorded
    assert hooks.trust_gate_blocks_injection() is True

    assert hooks.set_trust_gate_blocked(False) is True
    assert hooks.set_trust_gate_blocked(False) is False
    assert 'hooks.SessionStart' in _wire(tmp_path)[0]


def test_the_fallback_never_asks_codex_to_bypass_its_own_trust(tmp_path):
    """--dangerously-bypass-hook-trust would exempt the user's hooks.json too,
    so it stays out of the command in both states."""
    for blocked in (False, True):
        hooks.set_trust_gate_blocked(blocked)
        assert 'bypass-hook-trust' not in _wire(tmp_path)[0]


def test_an_unreadable_store_leaves_the_hook_injected(tmp_path, monkeypatch):
    """A kv failure must not silently switch the feature off for everyone."""
    monkeypatch.setattr(hooks, '_hooks_state', lambda: (_ for _ in ()).throw(RuntimeError('db gone')))
    with pytest.raises(RuntimeError):
        hooks._hooks_state()
    monkeypatch.setattr(hooks, '_hooks_state', lambda: {})
    assert hooks.trust_gate_blocks_injection() is False
    assert 'hooks.SessionStart' in _wire(tmp_path)[0]


def test_windows_hooks_are_powershell_on_the_real_platform_id(monkeypatch):
    # osplat.platform_id is "win32" on Windows, never "windows"; a branch on the
    # latter is dead code and ships the sh script to PowerShell.
    monkeypatch.setattr(hooks.osplat, 'platform_id', 'win32')
    assert hooks.hook_command().startswith('powershell.exe ')
    # The guard hook is cmd text: Codex already runs it under %COMSPEC% /C.
    assert 'powershell' not in hooks.guard_hook_command().lower()
    assert hooks.guard_hook_command().endswith('& exit 0')


def test_windows_hook_overrides_are_toml_literal_strings(tmp_path, monkeypatch):
    """The `-c` text runs under `cmd.exe /d /s /c`, where a backslash is not
    an escape. The old override was a TOML basic string (`matcher="…"`,
    `type="command"`, `json.dumps(command)`), so `list2cmdline` rendered every
    `"` as `\"`, the quote closed early and the `|` in the SessionStart
    matcher reached cmd as a pipe. TOML literal strings carry the value with
    no `"` at all, so nothing needs escaping."""
    import re
    import tomllib
    from agent_team_backend.osplat import _windows

    monkeypatch.setattr(hooks.osplat, 'platform_id', 'win32')
    monkeypatch.setattr(hooks.osplat, 'paths', _windows.paths)

    wired = hooks.wire('codex', {}, {}, tmp_path, tmp_path / 'port', tmp_path / 'auth')

    # SessionStart is the override whose matcher carries the `|`; its raw `-c`
    # argument must contain no backslash-escaped quote. The structural TOML
    # quotes must be gone from the whole command line.
    session_raw = wired[:wired.index('hooks.PreToolUse')]
    assert '\\"' not in session_raw
    assert 'matcher="' not in wired
    assert 'type="command"' not in wired

    # Codex reads each `-c` value as TOML, so both overrides must parse back to
    # the exact hook commands the vendor would otherwise run.
    found: dict[str, list] = {}
    for match in re.finditer(r'-c\s+"((?:[^"\\]|\\.)*)"', wired):
        arg = re.sub(r'\\(.)', r'\1', match.group(1))
        key, _, value = arg.partition('=')
        found[key] = tomllib.loads(f'{key} = {value}')['hooks'][key.rsplit('.', 1)[1]]
    assert sorted(found) == ['hooks.PreToolUse', 'hooks.SessionStart']
    session = found['hooks.SessionStart'][0]['hooks'][0]
    assert session['type'] == 'command' and session['command'] == hooks.hook_command()
    guard = found['hooks.PreToolUse'][0]['hooks'][0]
    assert guard['type'] == 'command' and guard['command'] == hooks.guard_hook_command()
