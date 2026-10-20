"""Static scan rules for frontend JavaScript (contract 3.8).

Works on the tokens of ``js_tokens.tokenize``; never executes or parses the
code. Each rule records only what the contract allows: executable and
subcommand, host name, relative path, capability address and counts.
"""

from __future__ import annotations

import re
import shlex
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

from ..plugin_contract.disclosure_scan_contract import classify_shell_command
from .js_tokens import Token, iter_tokens
from .limits import NO_DEADLINE, Deadline

#: Capability namespaces whose addresses the comparison of contract 3.9 uses.
CAPABILITY_NAMESPACES = frozenset({"aiCli", "fs", "shell", "storage", "ui", "web", "workspace"})
CAPABILITY_ADDRESS_RE = _ADDRESS_RE = re.compile(r"^(aiCli|fs|shell|storage|ui|web|workspace)\.[a-z][A-Za-z0-9]{0,63}$")
FS_READ_ADDRESSES = frozenset({
    "fs.readFile", "fs.readImage", "fs.listDirectory", "fs.listFilesFlat", "fs.glob", "fs.stat", "fs.statPath",
})
FS_WRITE_ADDRESSES = frozenset({"fs.writeFile"})
#: Executables a string literal must start with to count as "reads as a command".
COMMAND_EXECUTABLES = frozenset({
    "git", "gh", "glab", "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "ftp",
    "bash", "sh", "zsh", "fish", "python", "python3", "node", "deno", "bun", "npm", "npx", "pnpm", "yarn",
    "pip", "pip3", "docker", "kubectl", "aws", "gcloud", "az", "osascript", "powershell", "pwsh", "cmd",
    "open", "xdg-open", "rm", "chmod", "sudo",
})
#: The contract's command charset (3.8): no dots, pluses or upper case.
_EXECUTABLE_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
#: Longer literals are not parsed as commands (shlex is linear but slow).
MAX_COMMAND_LENGTH = 4096
_URL_RE = re.compile(r"(?:https?|wss?|ssh|git|ftp)://(?:[^/\s'\"?#@]*@)?([A-Za-z0-9.-]+)")
_SCP_RE = re.compile(r"\bgit@([A-Za-z0-9.-]+):")
#: XML namespace names, which are identifiers that look like URLs and are in
#: almost every bundle; they are never fetched.
_XML_NAMESPACE_URLS = (
    "http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml", "http://www.w3.org/1999/xlink",
    "http://www.w3.org/XML/1998/namespace", "http://www.w3.org/2000/xmlns/", "http://www.w3.org/1998/Math/MathML",
)
_PATH_RE = re.compile(r"^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9._*/-]+$")
_HEX_IDENTIFIER_RE = re.compile(r"^_0x[0-9a-f]{4,}$")
_BASE64_RE = re.compile(r"^[A-Za-z0-9+/=_-]+$")
_PATH_LOOKAHEAD = 12
OBFUSCATION_THRESHOLDS = {"hexIdentifiers": 20, "hexEscapes": 200, "longBase64": 2000, "charCodeStrings": 20}


@dataclass
class ScriptFacts:
    """Facts of one script file, merged by the report builder."""

    calls: set[tuple[str, str | None, str, str]] = field(default_factory=set)
    """(executable, subcommand, category, evidence)"""
    dynamic: int = 0
    dynamic_files: int = 0
    """Merged reports only: files with a dynamic command."""
    hosts: dict[str, int] = field(default_factory=dict)
    capabilities: set[str] = field(default_factory=set)
    read_paths: set[str] = field(default_factory=set)
    write_paths: set[str] = field(default_factory=set)
    dynamic_paths: int = 0
    eval: int = 0
    new_function: int = 0
    dynamic_import: int = 0
    string_timers: int = 0
    obfuscation_signals: set[str] = field(default_factory=set)


def _static_value(token: Token) -> str | None:
    if token.kind == "str" or (token.kind == "tmpl" and not token.dynamic):
        return token.value
    return None


def parse_command(command: str) -> tuple[str, str | None, str] | None:
    """(executable, subcommand, category) of a literal command string, or None
    when it is not one Host-style invocation (empty, unbalanced quotes)."""
    if len(command) > MAX_COMMAND_LENGTH:
        return None
    try:
        words = shlex.split(command, posix=True)
    except ValueError:
        return None
    if not words:
        return None
    executable = words[0].rsplit("/", 1)[-1]
    if not _EXECUTABLE_RE.fullmatch(executable):
        return None
    subcommand, category = classify_shell_command(executable, words[1:])
    return executable, subcommand, category


def _command_like(value: str) -> tuple[str, str | None, str] | None:
    head = value.split(None, 1)
    if len(head) != 2 or head[0] not in COMMAND_EXECUTABLES:
        return None
    return parse_command(value)


def hosts_in(value: str) -> list[str]:
    """Host names of the URLs in ``value`` (never a path, query or credential)."""
    return _hosts(value)


def command_like(value: str) -> tuple[str, str | None, str] | None:
    """(executable, subcommand, category) when ``value`` reads as a command."""
    return _command_like(value)


def _hosts(value: str) -> list[str]:
    for namespace in _XML_NAMESPACE_URLS:
        value = value.replace(namespace, "")
    found = []
    for match in [*_URL_RE.finditer(value), *_SCP_RE.finditer(value)]:
        host = match.group(1).lower().strip(".")
        if len(host) > 253:
            continue
        if host == "localhost" or ("." in host and not host.replace(".", "").isdigit()):
            found.append(host)
        elif host.replace(".", "").isdigit() and host.count(".") == 3:
            found.append(host)  # an IPv4 address is a host too
    return found


def _path(value: str, maximum: int) -> str | None:
    if len(value) > maximum or not _PATH_RE.fullmatch(value):
        return None
    return value


class _Window:
    """Random access to a token stream within a small window around the
    current token, so a 20 MiB bundle is scanned in constant memory."""

    def __init__(self, tokens: Iterator[Token], keep_behind: int = 2) -> None:
        self._tokens = tokens
        self._buffer: list[Token] = []
        self._offset = 0  # absolute index of _buffer[0]
        self._keep = keep_behind
        self._done = False

    def at(self, index: int) -> Token | None:
        if index < self._offset:
            return None
        while not self._done and index >= self._offset + len(self._buffer):
            token = next(self._tokens, None)
            if token is None:
                self._done = True
            else:
                self._buffer.append(token)
        position = index - self._offset
        return self._buffer[position] if position < len(self._buffer) else None

    def release(self, index: int) -> None:
        """Forget tokens more than ``keep_behind`` before ``index``."""
        drop = index - self._keep - self._offset
        if drop > 256:
            del self._buffer[:drop]
            self._offset += drop


_SHELL_RUN_LITERAL = re.compile(r"""['"`]shell\.run['"`]""")


def scan_script(text: str, *, max_path_length: int, deadline: Deadline = NO_DEADLINE) -> ScriptFacts:
    """Facts of one script. Raises ``ScanTimeout`` or ``TooComplex`` (from
    the tokenizer) when the file cannot be scanned within the bounds."""
    window = _Window(iter_tokens(text, deadline))
    at = window.at
    facts = ScriptFacts()
    has_shell_run = _SHELL_RUN_LITERAL.search(text) is not None
    escapes = 0
    hex_identifiers = 0
    char_codes = 0
    index = 0
    while (token := at(index)) is not None:
        window.release(index)
        nxt = at(index + 1)
        value = _static_value(token)
        if token.kind in ("str", "tmpl"):
            escapes += token.escapes
            for host in _hosts(token.value):
                facts.hosts[host] = facts.hosts.get(host, 0) + 1
            if (
                token.kind == "str" and len(token.value) >= OBFUSCATION_THRESHOLDS["longBase64"]
                and not token.value.startswith("data:") and _BASE64_RE.fullmatch(token.value)
            ):
                facts.obfuscation_signals.add("longBase64")
        if value is not None:
            if _ADDRESS_RE.fullmatch(value):
                facts.capabilities.add(value)
                if value in FS_READ_ADDRESSES or value in FS_WRITE_ADDRESSES:
                    _collect_path(at, index, value in FS_WRITE_ADDRESSES, facts, max_path_length)
                if value == "shell.run" and nxt is not None and nxt.value == ",":
                    after = at(index + 2)
                    if after is not None and after.value != "{":
                        facts.dynamic += 1
            parsed = _command_like(value)
            if parsed is not None:
                facts.calls.add((*parsed, "commandLikeString"))
        elif token.kind == "tmpl" and token.dynamic and has_shell_run:
            head = token.value.split(None, 1)
            if head and head[0] in COMMAND_EXECUTABLES:
                facts.dynamic += 1
        if token.kind == "ident":
            if _HEX_IDENTIFIER_RE.fullmatch(token.value):
                hex_identifiers += 1
            elif token.value == "fromCharCode":
                char_codes += 1
            previous = at(index - 1)
            called = nxt is not None and nxt.value == "("
            member = previous is not None and previous.value in (".", "?.")
            if token.value == "eval" and called and not member:
                facts.eval += 1
            elif token.value == "Function" and called and not member:
                # Both `new Function(...)` and `Function(...)` compile a string.
                facts.new_function += 1
            elif token.value == "import" and called:
                argument = at(index + 2)
                if argument is None or _static_value(argument) is None:
                    facts.dynamic_import += 1
            elif token.value in ("setTimeout", "setInterval") and called and not member:
                argument = at(index + 2)
                if argument is not None and argument.kind in ("str", "tmpl"):
                    facts.string_timers += 1
        if has_shell_run and _is_key(at, index, "command"):
            _collect_command(at, index, facts)
        index += 1
    # A literal used as a call site's command is not repeated as a mere string.
    sites = {(call[0], call[1]) for call in facts.calls if call[3] == "callSite"}
    facts.calls = {call for call in facts.calls if call[3] == "callSite" or (call[0], call[1]) not in sites}
    if hex_identifiers >= OBFUSCATION_THRESHOLDS["hexIdentifiers"]:
        facts.obfuscation_signals.add("hexIdentifiers")
    if escapes >= OBFUSCATION_THRESHOLDS["hexEscapes"]:
        facts.obfuscation_signals.add("hexEscapes")
    if char_codes >= OBFUSCATION_THRESHOLDS["charCodeStrings"]:
        facts.obfuscation_signals.add("charCodeStrings")
    return facts


_At = Callable[[int], "Token | None"]


def _is_key(at: _At, index: int, name: str) -> bool:
    """``name`` used as an object key: ``name:``, ``"name":`` or shorthand ``{name}``."""
    token = at(index)
    if token is None or not ((token.kind == "ident" or token.kind == "str") and token.value == name):
        return False
    previous = at(index - 1)
    nxt = at(index + 1)
    if previous is None or previous.value not in ("{", ","):
        return False
    return nxt is not None and nxt.value in (":", ",", "}")


def _collect_command(at: _At, index: int, facts: ScriptFacts) -> None:
    separator = at(index + 1)
    if separator is None or separator.value != ":":
        facts.dynamic += 1  # shorthand {command}
        return
    value_token = at(index + 2)
    end_token = at(index + 3)
    value = _static_value(value_token) if value_token is not None else None
    if value is None or end_token is None or end_token.value not in (",", "}"):
        facts.dynamic += 1
        return
    parsed = parse_command(value)
    if parsed is None:
        facts.dynamic += 1
        return
    facts.calls.add((*parsed, "callSite"))


def _collect_path(at: _At, index: int, write: bool, facts: ScriptFacts, maximum: int) -> None:
    for offset in range(1, _PATH_LOOKAHEAD + 1):
        position = index + offset
        if at(position + 2) is None:
            break
        if _is_key(at, position, "path") or _is_key(at, position, "pattern"):
            separator = at(position + 1)
            if separator is None or separator.value != ":":
                break
            value = _static_value(at(position + 2))  # type: ignore[arg-type]
            path = _path(value, maximum) if value is not None else None
            if path is None:
                break
            (facts.write_paths if write else facts.read_paths).add(path)
            return
    facts.dynamic_paths += 1
