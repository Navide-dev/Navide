"""A small JavaScript tokenizer for the publish-time static scan (contract 3.8).

It does not parse JavaScript. It only splits source text into the tokens the
scan rules look at, so that a string literal, a template literal, a comment
or a regular expression literal is never mistaken for code and vice versa:

- ``str``: a quoted string; ``value`` is the decoded text
- ``tmpl``: a template literal; ``value`` is the text outside ``${}``,
  ``dynamic`` is True when it has a substitution
- ``ident``: an identifier or keyword
- ``num``, ``regex``, ``punct``

Anything it cannot read (an unterminated string, a stray backslash) is
skipped one character at a time, so hostile input never raises; it can only
make the scan see less, which the coverage then reports.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass

_IDENT_START = re.compile(r"[A-Za-z_$\u0080-\uffff]")
_IDENT = re.compile(r"[A-Za-z0-9_$\u0080-\uffff]*")
_NUMBER = re.compile(r"(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?")
_PUNCT = re.compile(r">>>=|\.\.\.|===|!==|\*\*=|<<=|>>=|>>>|\?\?=|&&=|\|\|=|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*=|/=|%=|&=|\|=|\^=|<<|>>|\*\*|[{}()\[\];,<>+\-*/%&|^!~?:=.@#]")
_WHITESPACE_CHARS = " \t\r\n\f\v\u00a0\ufeff\u2028\u2029"
_WHITESPACE = re.compile("[" + _WHITESPACE_CHARS + "]+")
_SIMPLE_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}
# After these the next "/" starts a regular expression, not a division.
_REGEX_AFTER_KEYWORDS = frozenset({
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case",
    "do", "else", "yield", "await",
})


@dataclass(frozen=True, slots=True)
class Token:
    kind: str
    value: str
    dynamic: bool = False
    escapes: int = 0
    """Number of ``\\x``/``\\u`` escapes in a string or template (an obfuscation signal)."""


def _decode_escape(text: str, index: int) -> tuple[str, int, bool]:
    """(decoded, next index, was a hex/unicode escape) for the escape at ``text[index] == '\\\\'``."""
    if index + 1 >= len(text):
        return "", index + 1, False
    char = text[index + 1]
    if char in _SIMPLE_ESCAPES:
        return _SIMPLE_ESCAPES[char], index + 2, False
    if char == "x":
        digits = text[index + 2:index + 4]
        if re.fullmatch(r"[0-9a-fA-F]{2}", digits):
            return chr(int(digits, 16)), index + 4, True
    if char == "u":
        if text.startswith("{", index + 2):
            end = text.find("}", index + 3)
            digits = text[index + 3:end] if end != -1 else ""
            if end != -1 and re.fullmatch(r"[0-9a-fA-F]{1,6}", digits) and int(digits, 16) <= 0x10FFFF:
                return chr(int(digits, 16)), end + 1, True
        else:
            digits = text[index + 2:index + 6]
            if re.fullmatch(r"[0-9a-fA-F]{4}", digits):
                return chr(int(digits, 16)), index + 6, True
    if char == "\r" and text.startswith("\n", index + 2):
        return "", index + 3, False
    if char in "\n\r\u2028\u2029":
        return "", index + 2, False
    return char, index + 2, False


def _read_string(text: str, start: int) -> tuple[Token | None, int]:
    quote = text[start]
    out: list[str] = []
    escapes = 0
    index = start + 1
    while index < len(text):
        char = text[index]
        if char == "\\":
            decoded, index, hex_escape = _decode_escape(text, index)
            out.append(decoded)
            escapes += hex_escape
        elif char == quote:
            return Token("str", "".join(out), escapes=escapes), index + 1
        elif char == "\n":
            return None, start + 1
        else:
            out.append(char)
            index += 1
    return None, start + 1


def _read_template(text: str, start: int) -> tuple[Token | None, int]:
    """A template literal, skipping nested code (and nested templates) inside ``${}``."""
    out: list[str] = []
    escapes = 0
    dynamic = False
    index = start + 1
    while index < len(text):
        char = text[index]
        if char == "\\":
            decoded, index, hex_escape = _decode_escape(text, index)
            out.append(decoded)
            escapes += hex_escape
        elif char == "`":
            return Token("tmpl", "".join(out), dynamic=dynamic, escapes=escapes), index + 1
        elif char == "$" and text.startswith("{", index + 1):
            dynamic = True
            end = _skip_substitution(text, index + 2)
            if end is None:
                return None, start + 1
            index = end
        else:
            out.append(char)
            index += 1
    return None, start + 1


def _skip_substitution(text: str, index: int) -> int | None:
    """Index just after the ``}`` that closes a ``${`` whose body starts at ``index``."""
    depth = 1
    while index < len(text):
        char = text[index]
        if char in "'\"":
            token, index = _read_string(text, index)
            continue
        if char == "`":
            token, after = _read_template(text, index)
            index = after
            continue
        if char == "/" and text.startswith("/", index + 1):
            end = text.find("\n", index)
            index = len(text) if end == -1 else end
            continue
        if char == "/" and text.startswith("*", index + 1):
            end = text.find("*/", index + 2)
            index = len(text) if end == -1 else end + 2
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return None


def _read_regex(text: str, start: int) -> tuple[Token | None, int]:
    index = start + 1
    in_class = False
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "\n":
            return None, start + 1
        if char == "[":
            in_class = True
        elif char == "]":
            in_class = False
        elif char == "/" and not in_class:
            flags = _IDENT.match(text, index + 1)
            end = flags.end() if flags else index + 1
            return Token("regex", text[start:end]), end
        index += 1
    return None, start + 1


def _regex_allowed(previous: Token | None) -> bool:
    if previous is None:
        return True
    if previous.kind in ("num", "str", "tmpl", "regex"):
        return False
    if previous.kind == "ident":
        return previous.value in _REGEX_AFTER_KEYWORDS
    return previous.value not in (")", "]", "}", "++", "--")


def tokenize(text: str) -> list[Token]:
    return list(iter_tokens(text))


def iter_tokens(text: str) -> Iterator[Token]:
    """The tokens of ``text``, one at a time (constant memory for large bundles)."""
    previous: Token | None = None
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char in _WHITESPACE_CHARS:
            index = _WHITESPACE.match(text, index).end()  # type: ignore[union-attr]
            continue
        if char == "/" and text.startswith("/", index + 1):
            end = text.find("\n", index)
            index = length if end == -1 else end
            continue
        if char == "/" and text.startswith("*", index + 1):
            end = text.find("*/", index + 2)
            index = length if end == -1 else end + 2
            continue
        token: Token | None
        if char in "'\"":
            token, index = _read_string(text, index)
        elif char == "`":
            token, index = _read_template(text, index)
        elif char == "/" and _regex_allowed(previous):
            token, after = _read_regex(text, index)
            if token is None:
                token, index = Token("punct", "/"), index + 1
            else:
                index = after
        elif char.isdigit() or (char == "." and index + 1 < length and text[index + 1].isdigit()):
            match = _NUMBER.match(text, index)
            end = match.end() if match and match.end() > index else index + 1
            token, index = Token("num", text[index:end]), end
        elif _IDENT_START.match(char):
            match = _IDENT.match(text, index + 1)
            end = match.end() if match else index + 1
            token, index = Token("ident", text[index:end]), end
        else:
            match = _PUNCT.match(text, index)
            if match:
                token, index = Token("punct", match.group()), match.end()
            else:
                token, index = None, index + 1
        if token is not None:
            yield token
            previous = token
