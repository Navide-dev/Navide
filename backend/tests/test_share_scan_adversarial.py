"""share_scan against the formats and tricks the first review found leaking.

Each case here leaked or was rewritten wrongly by the first version: JSON and
quoted credential values, common provider tokens, a ``data:`` prefix used as a
shield, the Telegram ``/bot`` rule rewriting ordinary paths, and tokens split
by zero-width or full-width characters.
"""

from __future__ import annotations

import pytest

from agent_team_backend import share_scan

R = "Q7wZp3Lk9TfR2mXv8NcB4hJd6YsGe1Ua"  # 32 chars
R36 = R + "AbCd"
# Fake credentials are assembled from pieces so no complete one sits in the
# source for a secret scanner to flag.
_PEM_LABEL = "RSA PRIVATE" + " KEY"
PEM = "-----BEGIN " + _PEM_LABEL + "-----\nMIIE" + R + "\n-----END " + _PEM_LABEL + "-----"


def _masked(text: str, kind: str = "plan") -> str:
    return share_scan.scan(text, kind=kind).text


@pytest.mark.parametrize(
    "text",
    [
        "data:text/plain,sk-ant-api03-" + R,
        "data:image/png;base64,iVBORw0KGgo" + "sk-ant-api03-" + R,
        "metadata:sk-ant-api03-" + R + ",x",
        "data:x/y,A" + PEM,
    ],
)
def test_data_uri_does_not_shield_secrets(text: str) -> None:
    out = _masked(text)
    assert R not in out


@pytest.mark.parametrize(
    ("text", "secret"),
    [
        ('{"password": "hunter2-correct-horse"}', "hunter2-correct-horse"),
        ('{"apiKey": "' + R + '"}', R),
        ('{"client_secret": "' + R + '"}', R),
        ('{"token": "' + R + '"}', R),
        ('SECRET="abc def ghi"', "def ghi"),
        ("private_key: '" + R + "'", R),
    ],
)
def test_quoted_credential_values_are_masked_whole(text: str, secret: str) -> None:
    result = share_scan.scan(text, kind="plan")
    assert secret not in result.text
    assert result.findings and result.findings[0].action == share_scan.MASKED


@pytest.mark.parametrize(
    ("text", "category"),
    [
        ("glpat-" + R[:20], "gitlab-token"),
        ("ASIA" + "IOSFODNN7EXAMPLE", "aws-access-key"),
        ("AROA" + "IOSFODNN7EXAMPLE", "aws-access-key"),
        ("sk_live_" + R[:24], "stripe-key"),
        ("rk_test_" + R[:24], "stripe-key"),
        ("npm_" + R36, "npm-token"),
        ("hf_" + "abcdefghijklmnopqrstuvwxyzABCDEFGH", "huggingface-token"),
        ("AIza" + R + "abc", "google-api-key"),
        ("xapp-" + "1-A0123456789-1234567890123-" + R, "slack-app-token"),
        ("SG." + R[:22] + "." + R + R[:11], "sendgrid-key"),
        ("pypi-AgEIcHlwaS5vcmc" + R + R, "pypi-token"),
        ("TELEGRAM 123456789:AAH" + R, "telegram-bot-token"),
        ("MTA" + R[:21] + "." + R[:6] + "." + R[:27], "discord-bot-token"),
    ],
)
def test_common_provider_tokens_are_masked(text: str, category: str) -> None:
    result = share_scan.scan(text, kind="plan")
    assert result.text != text
    assert category in {f.category for f in result.findings}


def test_a_token_glued_to_a_word_character_is_not_matched_mid_word() -> None:
    # "task-management-dashboard" contains "sk-management…"; it is prose, not a key.
    text = "see the task-management-dashboard-overview page"
    assert _masked(text) == text


@pytest.mark.parametrize(
    "text",
    ['<a href="https://shop.test/bottles/list">x</a>', "<td>A/both</td><td>x/y</td>", "/bottom-sheet/"],
)
def test_bot_rule_leaves_ordinary_paths_alone(text: str) -> None:
    assert _masked(text) == text


def test_telegram_bot_url_is_masked() -> None:
    text = "https://api.telegram.org/bot123456789:AAH" + R + "/sendMessage"
    out = _masked(text)
    assert R not in out and out.endswith("/sendMessage")


@pytest.mark.parametrize(
    "text",
    [
        "sk-ant-​api03-" + R,
        "sk​-ant-api03-" + R,
        "ｓｋ-ant-api03-" + R,
        "gh‍p_" + R36,
    ],
)
def test_obfuscated_tokens_are_at_least_warned(text: str) -> None:
    assert share_scan.scan(text, kind="plan").findings


# ---- review round 2 ---------------------------------------------------------------

S = "S3cretValue-9xQ2"


@pytest.mark.parametrize(
    "text",
    [
        '{\\"api_key\\": \\"' + S + '\\"}',  # inside a JSON string (plan-meta)
        "{&quot;api_key&quot;: &quot;" + S + "&quot;}",  # html.escape (visible todo)
        "{&#34;api_key&#34;: &#34;" + S + "&#34;}",
        "{&#x22;api_key&#x22;: &#x22;" + S + "&#x22;}",
        "api_key=&#x27;" + S + "&#x27;",
        "api_key=&apos;" + S + "&apos;",
        "api_key=\\'" + S + "\\'",
    ],
)
def test_escaped_quotes_still_delimit_a_credential(text: str) -> None:
    result = share_scan.scan(text, kind="plan")
    assert S not in result.text
    assert result.findings


def test_masking_keeps_an_escaped_quote_inside_the_value_valid_json() -> None:
    import json

    out = _masked('{"password": "a\\"b-c"}')
    assert json.loads(out) == {"password": "[redacted]"}


def test_a_real_plan_with_a_credential_in_a_todo_stays_a_valid_plan(tmp_path, set_home, monkeypatch) -> None:
    import json
    from html.parser import HTMLParser

    from agent_team_backend.plugins.builtin.navide_plans.plan_meta import parse_plan_meta
    from agent_team_backend.plugins.builtin.navide_plans.plan_tools import _create_plan_sync

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    home = set_home(tmp_path / "home")
    ws = home / "ws"
    ws.mkdir(parents=True)
    created = _create_plan_sync(
        str(ws), "Leak check", "A plan", ['Set config {"api_key": "' + S + '"}', 'Then {"password": "a\\"b"}']
    )
    original = (ws / created["rel_path"]).read_text(encoding="utf-8")
    assert original.count(S) == 2  # once in plan-meta, once in the visible todo

    result = share_scan.scan(original, kind="plan")
    assert S not in result.text and "a\\\\\\\"b" not in result.text
    assert len([f for f in result.findings if f.action == share_scan.MASKED]) >= 2

    meta = parse_plan_meta(result.text)
    assert meta is not None, "plan-meta no longer parses"
    assert "[redacted]" in json.dumps(meta["todos"])

    class Tags(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.seen: list[str] = []

        def handle_starttag(self, tag, attrs):
            self.seen.append(tag)

        def handle_endtag(self, tag):
            self.seen.append("/" + tag)

    def tags(html: str) -> list[str]:
        parser = Tags()
        parser.feed(html)
        return parser.seen

    assert tags(result.text) == tags(original)


@pytest.mark.parametrize(
    "text",
    [
        "SECRET_KEY='" + S + "'",
        "SECRET_KEY_BASE=" + S,
        '{"secretKey": "' + S + '"}',
        "passphrase: " + S,
        'signing_key = "' + S + '"',
        "ENCRYPTION_KEY=" + S,
    ],
)
def test_credential_keys_with_prefixes_and_suffixes(text: str) -> None:
    assert S not in _masked(text)


@pytest.mark.parametrize(
    ("text", "secret", "kept"),
    [
        ("redis://:" + S + "@cache.internal:6379/0", S, "@cache.internal:6379/0"),
        ("https://alice:p/" + S + "@example.com/x", S, "@example.com/x"),
        ("redis://:p@ss" + S + "@host", S, "@host"),
    ],
)
def test_url_credentials(text: str, secret: str, kept: str) -> None:
    out = _masked(text)
    assert secret not in out and "p@ss" not in out
    assert out.endswith(kept)


def test_a_bare_literal_after_a_credential_key_is_a_setting() -> None:
    text = "has_passphrase: false\nrequire_token: true\n"
    assert _masked(text) == text


def test_a_hyphenated_header_key_is_a_credential_key() -> None:
    assert R not in _masked("x-api-key: " + R)


# ---- review round 3 ---------------------------------------------------------------

Z = "Zx9QpL2mN7vB4kR8tY6wE3"


@pytest.mark.parametrize("segments", [40])
def test_an_unclosed_quote_before_a_long_backslash_path_is_linear(segments: int) -> None:
    """R1: the quoted value's two branches overlapped on a backslash, so an
    unclosed quote before C:\\d0\\d1… backtracked exponentially (14 segments
    took 3.4 s, 20 never finished)."""
    import json
    import time

    path = "C:" + "".join(f"\\d{i % 10}" for i in range(segments))
    for text in ('pwd: "' + path, json.dumps({"content": 'set password: "' + path}), 'password: "' + "\\" * 400 + "x"):
        started = time.perf_counter()
        share_scan.scan(text, kind="plan")
        assert time.perf_counter() - started < 1.0


def test_a_bare_credential_inside_a_json_string_keeps_the_json_valid() -> None:
    """R2: the bare value swallowed the backslash of the \\" that closes the
    surrounding JSON string."""
    import json

    text = json.dumps({"c": 'Add "API_KEY=' + Z + '" to .env'})
    out = _masked(text)
    assert Z not in out
    assert json.loads(out) == {"c": 'Add "API_KEY=[redacted]" to .env'}


@pytest.mark.parametrize("text", ['password: "' + Z, '  "content": "set password: \\"' + Z + ' and go",'])
def test_an_unclosed_quoted_value_is_still_masked(text: str) -> None:
    """R3: with no closing quote the value fell through unmasked."""
    assert Z not in _masked(text)


@pytest.mark.parametrize(
    "text",
    [
        '"tokenizer": "gpt2-fast"',
        "max_tokens: 4096",
        '"maxTokens": 4096',
        "passwordHash: bcrypt",
        '"passwordPolicy": "8 chars"',
        "tokens_used = 12345",
        "secret_name: prod-db-creds",
        "token_endpoint: https://oauth2.googleapis.com/token",
        "pwd: /Users/neil/project",
        "password: string",
        "token: required",
        "http://localhost:5173/@vite/client",
        "https://registry.npmjs.org:443/@types/node",
        "https://[::1]:8080/@scope",
        "https://h:8080/x?u=a@b.com",
    ],
)
def test_ordinary_text_is_not_masked(text: str) -> None:
    """R4: key suffixes, numbers, type names, ports and paths are not secrets."""
    assert _masked(text) == text


@pytest.mark.parametrize(
    ("text", "secret"),
    [
        ("SECRET_KEY_BASE=" + Z, Z),
        ('"accessKeyId": "' + Z + '"', Z),
        ("auth_token=" + Z, Z),
        ('"refreshToken": "' + Z + '"', Z),
        ("postgres://user:Pa/55word" + Z + "@db:5432/x", "Pa/55word"),
        ("amqp://u:" + Z + "@[::1]:5672/", Z),
    ],
)
def test_round_three_still_masks_real_credentials(text: str, secret: str) -> None:
    assert secret not in _masked(text)


def test_a_real_plan_with_a_bare_credential_in_quotes_stays_a_valid_plan(tmp_path, set_home, monkeypatch) -> None:
    from agent_team_backend.plugins.builtin.navide_plans.plan_meta import parse_plan_meta
    from agent_team_backend.plugins.builtin.navide_plans.plan_tools import _create_plan_sync

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    ws = set_home(tmp_path / "home") / "ws"
    ws.mkdir(parents=True)
    created = _create_plan_sync(
        str(ws), "Env check", "A plan", ['Add "API_KEY=' + Z + '" to .env', 'password: "' + Z, "keep me intact"]
    )
    original = (ws / created["rel_path"]).read_text(encoding="utf-8")
    out = share_scan.scan(original, kind="plan").text
    assert Z not in out
    meta = parse_plan_meta(out)
    assert meta is not None, "plan-meta no longer parses"
    assert [t["content"] for t in meta["todos"]][2] == "keep me intact"


# ---- review round 4 ---------------------------------------------------------------


@pytest.mark.parametrize(
    "template",
    [
        "password_hash_salt=%s",
        "tokenValue=%s",
        "OPENAI_API_KEY_PROD=%s",
        "client_secret_value=%s",
        "secretValue: %s",
        "access_token_value=%s",
        "api_key_v2=%s",
        "password1=%s",
        "token2=%s",
        "secret_access_key_id=%s",
        "apiKeySecret=%s",
        "token_secret=%s",
        "DJANGO_SECRET_KEY=%s",
    ],
)
def test_a_credential_key_with_any_other_suffix_is_masked(template: str) -> None:
    """B-F4: suffixes are masked by default; only known non-secret ones are not."""
    assert Z not in _masked(template % Z)


@pytest.mark.parametrize(
    "text",
    [
        "passwordless: enabled",
        "secretary: Alice",
        "secretsManager: aws",
        "token_type: bearer",
        "tokenTtl: 3600",
        "passwordReset: /reset",
        "secret_ref: vault://kv/app",
        "x_token_count: 12",
        "token_url: https://h/x",
        "password_min_length: 12",
        "tokenize = function(x)",
        "PWD=/Users/neil/repo",
        "pwd: ~/project",
        "api_key: 4096",
    ],
)
def test_known_non_secret_suffixes_and_values_are_left_alone(text: str) -> None:
    assert _masked(text) == text


@pytest.mark.parametrize(
    ("text", "secret"),
    [
        ("password: 12345678", "12345678"),
        ('"password": "12345678"', "12345678"),
        ("pin_password=00491234", "00491234"),
        ("token: 1234567890123456789012", "1234567890123456789012"),
        ("MYSQL_PWD=hunter2xyz", "hunter2xyz"),
        ("pwd=hunter2", "hunter2"),
        ("db_pwd: " + Z, Z),
        ("password: stringZ9q", "stringZ9q"),
    ],
)
def test_long_numbers_and_pwd_values_are_masked(text: str, secret: str) -> None:
    """B-F5: only numbers of up to 5 digits are settings. B-F6: pwd is a key
    again, except when its value is a path."""
    assert secret not in _masked(text)


@pytest.mark.parametrize(
    "text",
    [
        '{\\u0022api_key\\u0022: \\u0022' + Z + '\\u0022}',
        "api_key=\\u0022" + Z + "\\u0022",
        "api_key=\\&quot;" + Z + "\\&quot;",
    ],
)
def test_unicode_and_backslashed_entity_quotes_delimit_a_value(text: str) -> None:
    """B-F8."""
    assert Z not in _masked(text)


def test_url_password_stops_at_quotes_and_markup() -> None:
    """B-F1: the password part is bounded and never crosses " ' < > ,"""
    text = '<a href="https://u:' + Z + '@host/x">link</a>, "mailto:x@y.z"'
    out = _masked(text)
    assert Z not in out
    assert out.endswith('@host/x">link</a>, "mailto:x@y.z"')


_GENERATORS = {
    "many escaped keys": lambda n: 'token=\\"a\\\\' * n,
    "many entity keys": lambda n: "token=&quot;a " * n,
    "many bare keys": lambda n: "token=abcd " * n,
    "scheme repeats": lambda n: "://a:" * n,
    "BEGIN repeats": lambda n: ("-----BEGIN " + "PRIVATE" + " KEY-----") * n,
    "ey repeats": lambda n: "-ey" * n,
    "long unclosed value": lambda n: 'password: "' + "a" * (n * 10),
    "repeated key words": lambda n: "secret" * n + "z=abcd",
    "repeated suffixes": lambda n: "token" + "_key" * n + "z=abcd",
    "url at repeats": lambda n: "http://u:" + "a@" * n + "/",
    "unclosed keys": lambda n: 'password: "abc ' * n,
}


def test_span_lookups_do_not_walk_every_span() -> None:
    """R6-F5: _Spans answers by bisection; 100 000 spans and lookups stay fast."""
    import time

    spans = share_scan._Spans([(i * 10, i * 10 + 5) for i in range(100_000)])
    started = time.perf_counter()
    hits = sum(spans.overlaps(i * 10 + 2, i * 10 + 3) for i in range(100_000))
    misses = sum(spans.overlaps(i * 10 + 6, i * 10 + 9) for i in range(100_000))
    assert (hits, misses) == (100_000, 0)
    assert time.perf_counter() - started < 2.0


@pytest.mark.parametrize("name", sorted(_GENERATORS))
def test_scan_time_stays_near_linear(name: str) -> None:
    """B-F2/B-F3 and the round-4 ReDoS sweep: patterns are bounded, so a long
    adversarial line costs time proportional to its length. 20 000 repeats
    used to take seconds to minutes for several of these; 10 000 with a
    3 s budget leaves room for a loaded machine and none for a quadratic."""
    import time

    text = _GENERATORS[name](10_000)
    started = time.perf_counter()
    share_scan.scan(text, kind="plan")
    assert time.perf_counter() - started < 3.0, name


_BACKSLASH_RUNS = {
    "bare run": lambda n: "x " + "\\" * n,
    "quoted, never closed": lambda n: 'password: "' + "\\" * n + "x",
    "entity quote, never closed": lambda n: "password: &quot;" + "\\" * n,
    "unquoted value": lambda n: "token=" + "\\" * n,
}


def _best_of(runs: int, text: str) -> float:
    import time

    best = float("inf")
    for _ in range(runs):
        started = time.perf_counter()
        share_scan.scan(text, kind="plan")
        best = min(best, time.perf_counter() - started)
    return best


@pytest.mark.serial
@pytest.mark.parametrize("name", sorted(_BACKSLASH_RUNS))
def test_a_run_of_backslashes_scans_in_linear_time(name: str) -> None:
    """B7-1: the doubled-backslash quote branches (B5-1) could start at every
    backslash of a run, so a run alone scanned in quadratic time (10 000 took
    1.1 s, 100 000 over 20 s). Ten times the input must cost about ten times
    the time: a quadratic shows up as a hundredfold."""
    make = _BACKSLASH_RUNS[name]
    small = _best_of(3, make(10_000))
    large = _best_of(3, make(100_000))
    assert large / max(small, 1e-4) < 30, (name, small, large)


_ISLAND_RUNS = {
    "unclosed plan-meta openers": lambda n: '<script id="plan-meta">' * n,
    "closed islands between hits": lambda n: '<script id="plan-meta">{}</script> password=hunter2x\n' * n,
}


@pytest.mark.serial
@pytest.mark.parametrize("name", sorted(_ISLAND_RUNS))
def test_many_plan_meta_islands_scan_in_linear_time(name: str) -> None:
    """B8-1/B8-2: finding the plan-meta islands rescanned to the end of the
    text from every opener that never closes, and every hit outside an island
    was checked against every island. Ten times the input must cost about ten
    times the time."""
    make = _ISLAND_RUNS[name]
    small = _best_of(3, make(10_000))
    large = _best_of(3, make(100_000))
    assert large / max(small, 1e-4) < 30, (name, small, large)


@pytest.mark.parametrize(
    "text",
    [
        "secret: C:\\Users\\neil\\" + Z,
        'password: "C:\\d0\\d1\\d2' + Z,
    ],
)
def test_a_windows_path_value_is_masked_whole_and_json_stays_valid(text: str) -> None:
    """A value stops at a quote, not at every backslash: an escape pair is part
    of it, a backslashed quote is not."""
    import json

    assert Z not in _masked(text)
    wrapped = json.dumps({"c": text, "d": "keep"})
    out = _masked(wrapped)
    assert Z not in out
    assert json.loads(out)["d"] == "keep"


# ---- review round 5/6 ---------------------------------------------------------------


def test_a_doubly_escaped_quote_in_plan_meta_still_delimits_the_value(tmp_path, set_home, monkeypatch) -> None:
    """B5-1: a todo `password=\\"S\\"` is `password=\\\\\\"S\\\\\\"` inside plan-meta's JSON."""
    from agent_team_backend.plugins.builtin.navide_plans.plan_meta import parse_plan_meta
    from agent_team_backend.plugins.builtin.navide_plans.plan_tools import _create_plan_sync

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    ws = set_home(tmp_path / "home") / "ws"
    ws.mkdir(parents=True)
    todo = 'password=\\"' + Z + '\\"'
    created = _create_plan_sync(str(ws), "Escapes", "overview " + todo, [todo, "keep me intact"])
    original = (ws / created["rel_path"]).read_text(encoding="utf-8")
    assert original.count(Z) >= 3
    out = share_scan.scan(original, kind="plan").text
    assert Z not in out
    meta = parse_plan_meta(out)
    assert meta is not None and meta["todos"][1]["content"] == "keep me intact"


def test_a_json_newline_escape_ends_a_bare_value() -> None:
    """B5-2: `TOKEN=S\\nnext line` inside the plan-meta island keeps the next line."""
    import json

    island = json.dumps({"c": "TOKEN=" + Z + "\nnext line"})
    out = _masked('<script type="application/json" id="plan-meta">' + island + "</script>")
    body = out.split(">", 1)[1].rsplit("</script>", 1)[0]
    assert Z not in out and json.loads(body)["c"].endswith("\nnext line")


@pytest.mark.parametrize(
    "text",
    [
        "secret: C:\\Users\\neil\\" + Z,
        "token=C:\\tmp\\" + Z,
        "password=Ab\\n" + Z,
        "password=abcd\\r" + Z,
        "api_key=k3y\\t" + Z,
        "SECRET=\\n" + Z,
        'password: "C:\\new\\' + Z + '"',
        "<li>password=ab\\n" + Z + "</li>",
    ],
)
@pytest.mark.parametrize("kind", ["plan", "file"])
def test_backslash_n_r_t_outside_plan_meta_do_not_end_a_value(text: str, kind: str) -> None:
    """B7-2: only inside the plan-meta JSON island is backslash-n a line
    break; in prose and markup it is as likely a path or a literal, so the
    value goes on and is masked whole, as before B5-2."""
    assert Z not in share_scan.scan(text, kind=kind).text


@pytest.mark.parametrize("value", ["./build", "C:\\Users\\neil", "c:\\work"])
def test_a_pwd_that_is_a_relative_or_windows_path_is_a_directory(value: str) -> None:
    """B5-3."""
    text = "pwd: " + value
    assert _masked(text) == text
