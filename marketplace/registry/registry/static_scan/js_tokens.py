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
skipped one character at a time; it can only make the scan see less. Work
is bounded: every loop polls the scan's ``Deadline`` (``ScanTimeout``), and
template nesting beyond ``MAX_TEMPLATE_DEPTH`` or an unterminated template
raises ``TooComplex``. The report records either as an incomplete scan.
"""

from __future__ import annotations

import codecs
import re
from array import array
from bisect import bisect_left
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from itertools import chain

from .limits import NO_DEADLINE, Deadline, TooComplex

_IDENT_START = re.compile(r"[A-Za-z_$\u0080-\uffff]")
_IDENT = re.compile(r"[A-Za-z0-9_$\u0080-\uffff]*")
_NUMBER = re.compile(r"(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?")
_PUNCT = re.compile(r">>>=|\.\.\.|===|!==|\*\*=|<<=|>>=|>>>|\?\?=|&&=|\|\|=|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*=|/=|%=|&=|\|=|\^=|<<|>>|\*\*|[{}()\[\];,<>+\-*/%&|^!~?:=.@#]")
_WHITESPACE_CHARS = " \t\r\n\f\v\u00a0\ufeff\u2028\u2029"
_WHITESPACE = re.compile("[" + _WHITESPACE_CHARS + "]+")
_HEX2 = re.compile(r"[0-9a-fA-F]{2}")
_HEX4 = re.compile(r"[0-9a-fA-F]{4}")
_HEX_CODEPOINT = re.compile(r"[0-9a-fA-F]{1,6}")
_SINGLE_QUOTED = re.compile(r"'(?:[^'\\\n]|\\[\s\S])*'")
_DOUBLE_QUOTED = re.compile(r'"(?:[^"\\\n]|\\[\s\S])*"')
#: Templates nested inside ``${}`` deeper than this make the file ``tooComplex``.
MAX_TEMPLATE_DEPTH = 32
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
    start: int = field(default=0, compare=False)
    """Offset of the token's first character in the scanned text (scanner 1.2.0 sites)."""


def _decode_escape(text: str, index: int) -> tuple[str, int, bool]:
    """(decoded, next index, was a hex/unicode escape) for the escape at ``text[index] == '\\\\'``."""
    if index + 1 >= len(text):
        return "", index + 1, False
    char = text[index + 1]
    if char in _SIMPLE_ESCAPES:
        return _SIMPLE_ESCAPES[char], index + 2, False
    if char == "x":
        digits = text[index + 2:index + 4]
        if _HEX2.fullmatch(digits):
            return chr(int(digits, 16)), index + 4, True
    if char == "u":
        if text.startswith("{", index + 2):
            # Bounded look-ahead: at most six hex digits and the brace.
            end = text.find("}", index + 3, index + 10)
            digits = text[index + 3:end] if end != -1 else ""
            if end != -1 and _HEX_CODEPOINT.fullmatch(digits) and int(digits, 16) <= 0x10FFFF:
                return chr(int(digits, 16)), end + 1, True
        else:
            digits = text[index + 2:index + 6]
            if _HEX4.fullmatch(digits):
                return chr(int(digits, 16)), index + 6, True
    if char == "\r" and text.startswith("\n", index + 2):
        return "", index + 3, False
    if char in "\n\r\u2028\u2029":
        return "", index + 2, False
    return char, index + 2, False


def _decode(body: str) -> tuple[str, int]:
    """(decoded text, number of hex/unicode escapes) of a literal's body."""
    if "\\" not in body:
        return body, 0
    out: list[str] = []
    escapes = 0
    index = 0
    while index < len(body):
        next_escape = body.find("\\", index)
        if next_escape == -1:
            out.append(body[index:])
            break
        out.append(body[index:next_escape])
        decoded, index, hex_escape = _decode_escape(body, next_escape)
        out.append(decoded)
        escapes += hex_escape
    return "".join(out), escapes


def _read_string(text: str, start: int, deadline: Deadline = NO_DEADLINE) -> tuple[Token | None, int]:
    match = (_SINGLE_QUOTED if text[start] == "'" else _DOUBLE_QUOTED).match(text, start)
    if match is None:
        # Unterminated on its line: skip the quote. A failed match costs up to a
        # line, so the clock is read every time (a long line full of stray
        # quotes cannot outrun the budget).
        deadline.check()
        return None, start + 1
    value, escapes = _decode(match.group()[1:-1])
    return Token("str", value, escapes=escapes), match.end()


def _read_template(text: str, start: int, deadline: Deadline = NO_DEADLINE) -> tuple[Token | None, int]:
    """A template literal, skipping the code inside ``${}`` (and any templates
    nested in it) with an explicit stack: no recursion, and nesting deeper
    than ``MAX_TEMPLATE_DEPTH`` raises ``TooComplex``.

    An unterminated template also raises ``TooComplex``: valid code cannot
    contain one, and rescanning the rest of the file from every later
    backtick would be quadratic."""
    out: list[str] = []
    escapes = 0
    dynamic = False
    # Each entry is 0 for a template, or the open-brace depth of a ``${}`` body.
    stack: list[int] = [0]
    index = start + 1
    length = len(text)
    while index < length:
        deadline.tick()
        char = text[index]
        if stack[-1] == 0:  # inside a template's text
            if char == "\\":
                if len(stack) == 1:
                    decoded, index, hex_escape = _decode_escape(text, index)
                    out.append(decoded)
                    escapes += hex_escape
                else:
                    index += 2
                continue
            if char == "`":
                stack.pop()
                index += 1
                if not stack:
                    return Token("tmpl", "".join(out), dynamic=dynamic, escapes=escapes), index
                continue
            if char == "$" and text.startswith("{", index + 1):
                if len(stack) == 1:
                    dynamic = True
                stack.append(1)
                index += 2
                continue
            if len(stack) == 1:
                out.append(char)
            index += 1
            continue
        # inside a ``${}`` body
        if char in "'\"":
            match = (_SINGLE_QUOTED if char == "'" else _DOUBLE_QUOTED).match(text, index)
            index = match.end() if match else index + 1
            continue
        if char == "`":
            if len(stack) >= MAX_TEMPLATE_DEPTH:
                raise TooComplex("template nesting")
            stack.append(0)
            index += 1
            continue
        if char == "/" and text.startswith("/", index + 1):
            end = text.find("\n", index)
            index = length if end == -1 else end
            continue
        if char == "/" and text.startswith("*", index + 1):
            end = text.find("*/", index + 2)
            index = length if end == -1 else end + 2
            continue
        if char == "{":
            stack[-1] += 1
        elif char == "}":
            stack[-1] -= 1
            if stack[-1] == 0:
                stack.pop()
        index += 1
    raise TooComplex("unterminated template")


def _read_regex(text: str, start: int, deadline: Deadline = NO_DEADLINE) -> tuple[Token | None, int]:
    index = start + 1
    in_class = False
    while index < len(text):
        deadline.tick()
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


_ASTRAL = re.compile("[\U00010000-\U0010ffff]")
ASTRAL_PLACEHOLDER = "\x01"
"""Stands in for a character above U+FFFF in a narrowed script. Like such a
character it is no identifier, digit, whitespace, quote or punctuator
character, so every token boundary and offset stays where it was."""


MAX_ASTRAL_SHARE = 8
"""Narrowing gives up when more than one character in this many is above
U+FFFF: at 12 bytes per recorded character it would then cost more than
the 4-byte-per-character text it avoids (a hostile script of emoji). The
first ``ASTRAL_FREE`` characters' worth is always recorded, so a bundle
that opens with a few emoji is narrowed too."""
ASTRAL_FREE = 64 * 1024


@dataclass(slots=True)
class AstralChars:
    """The characters above U+FFFF that ``narrow_script`` replaced: their
    offsets and code points, stored compactly."""

    offsets: array = field(default_factory=lambda: array("q"))
    chars: array = field(default_factory=lambda: array("I"))

    def within(self, start: int, end: int) -> bool:
        at = bisect_left(self.offsets, start)
        return at < len(self.offsets) and self.offsets[at] < end

    def restore(self, text: str, start: int, end: int) -> str:
        """``text[start:end]`` with the replaced characters put back."""
        end = min(end, len(text))
        at = bisect_left(self.offsets, start)
        parts: list[str] = []
        while at < len(self.offsets) and self.offsets[at] < end:
            parts.append(text[start:self.offsets[at]])
            parts.append(chr(self.chars[at]))
            start = self.offsets[at] + 1
            at += 1
        parts.append(text[start:end])
        return "".join(parts)


def narrow_script(chunks: Iterable[bytes]) -> tuple[str, AstralChars] | None:
    """The UTF-8 script in ``chunks`` decoded like ``bytes.decode("utf-8",
    "replace")``, with each character above U+FFFF replaced by
    ``ASTRAL_PLACEHOLDER``, and those characters.

    One emoji in a bundle otherwise makes the whole text 4 bytes per
    character, and decoding it at once peaks at about six times its size.
    A placeholder already in the script stays as it is: only the recorded
    offsets are restored. None when a character above U+FFFF is a digit,
    which the tokenizer reads differently from the placeholder, or when
    such characters are too many to record cheaply (``MAX_ASTRAL_SHARE``)."""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    pieces: list[str] = []
    astral = AstralChars()
    length = 0
    for chunk in chain(chunks, (None,)):
        piece = decoder.decode(chunk or b"", final=chunk is None)
        if _ASTRAL.search(piece):
            for match in _ASTRAL.finditer(piece):
                if match.group().isdigit():
                    return None
                astral.offsets.append(length + match.start())
                astral.chars.append(ord(match.group()))
            piece = _ASTRAL.sub(ASTRAL_PLACEHOLDER, piece)
        pieces.append(piece)
        length += len(piece)
        if len(astral.offsets) * MAX_ASTRAL_SHARE > max(length, ASTRAL_FREE):
            return None
    return "".join(pieces), astral


def _reread(token: Token, source: str, deadline: Deadline) -> Token | None:
    """``token`` read again from its exact source text (narrowed scripts)."""
    reader = {"str": _read_string, "tmpl": _read_template, "regex": _read_regex}[token.kind]
    return reader(source, 0, deadline)[0]


def tokenize(text: str, deadline: Deadline = NO_DEADLINE) -> list[Token]:
    return list(iter_tokens(text, deadline))


def iter_tokens(
    text: str, deadline: Deadline = NO_DEADLINE, astral: AstralChars | None = None
) -> Iterator[Token]:
    """The tokens of ``text``, one at a time (constant memory for large bundles).

    For a script narrowed by ``narrow_script`` pass its ``astral``: a literal
    that held a replaced character is read again from its original text, so
    every token equals that of the unnarrowed script.

    Raises ``ScanTimeout`` when ``deadline`` passes and ``TooComplex`` for a
    structure beyond the ceilings; both end the scan of this file only."""
    previous: Token | None = None
    index = 0
    length = len(text)
    while index < length:
        deadline.tick()
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
        begin = index
        if char in "'\"":
            token, index = _read_string(text, index, deadline)
        elif char == "`":
            token, index = _read_template(text, index, deadline)
        elif char == "/" and _regex_allowed(previous):
            token, after = _read_regex(text, index, deadline)
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
        if (
            token is not None and astral is not None and token.kind in ("str", "tmpl", "regex")
            and astral.within(begin, index)
        ):
            token = _reread(token, astral.restore(text, begin, index), deadline)
        if token is not None:
            object.__setattr__(token, "start", begin)
            yield token
            previous = token
