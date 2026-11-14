"""Permission / question relay (Phase F): answer a pane's awaiting prompt from chat.

Always on for every configured platform; Navide Guard screens each approval. A request id is 5
letters a-z without ``l`` (Claude Code channels format) and is single-use: it
expires when answered, when the pane leaves awaiting, or after 30 minutes.

Answers: ``yes <id>`` / ``no <id>`` (also ``y`` / ``n``) for a permission,
``<n> <id>`` for a question option, ``<n>,<m> <id>`` for the boxes of a
multi-select question, ``<n> <id> <text>`` for a free-text row ("Type
something", alone or among the boxes), or a button whose callback data is
``nv1:<id>:<choice>`` (choice ``y`` / ``n`` / ``1``..``9``, well under
Telegram's 64-byte limit). A multi-select question's buttons tick and untick its
boxes (``t1``..``t9``) on a platform that can redraw them, and ``s`` sends the
boxes ticked; the ticks live on the request, so they go with it. The text is typed into the pane's own text box and
nowhere else; the keys that do it are fixed (src/renderer/src/lib/paneAnswerKeys.ts).

A permanent-allow option ("don't ask again", "always allow", "for this session" …)
is never offered or accepted from chat: that choice is made at the computer.
"""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from .base import Location
from .quick_menu import strip_mention

ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz"
ID_LENGTH = 5
REQUEST_TTL_S = 1800.0
MAX_BUTTON_OPTIONS = 9
CALLBACK_PREFIX = "nv1:"

_CHOICE = r"yes|y|no|n|[1-9](?:\s*[,，、]\s*[1-9])*"
_TEXT_ANSWER_RE = re.compile(
    rf"^\s*({_CHOICE})\s+([{ID_ALPHABET}]{{{ID_LENGTH}}})(?:\s+(.+?))?\s*$", re.IGNORECASE | re.DOTALL)
_CALLBACK_RE = re.compile(rf"^nv1:([{ID_ALPHABET}]{{{ID_LENGTH}}}):(y|n|[1-9]|t[1-9]|s)$")
_BARE_ANSWER_RE = re.compile(rf"^\s*({_CHOICE})(?:\s+(.+?))?\s*$", re.IGNORECASE | re.DOTALL)

# Vendors whose prompts Navide can answer with keys. Keep in sync with MENU_VENDORS,
# LINE_PROMPT_VENDORS and HOTKEY_VENDORS in src/renderer/src/lib/paneAnswerKeys.ts.
ANSWERABLE_AGENTS = frozenset({"claude", "codex", "aider", "grok"})

# Vendors that ask only through a numbered menu, so a screen with no menu on it
# holds nothing to answer. Keep in sync with MENU_VENDORS in paneAnswerKeys.ts.
MENU_AGENTS = frozenset({"claude", "codex"})

# Vendors whose one answerable prompt grants for good: Grok Build keeps a
# trusted folder in its trust store, which grok.folder-trust shares with every
# Grok pane. Its "allow" is a permanent allow, only the user's to give (#442's
# rule); Navide's own acceptance of a pane's workspace at launch is separate.
# Keep in sync with PERMANENT_ALLOW_VENDORS in src/renderer/src/lib/paneAnswerKeys.ts.
PERMANENT_ALLOW_AGENTS = frozenset({"grok"})

# Keep in sync with PERMANENT_ALLOW in src/renderer/src/lib/paneAnswerKeys.ts.
_PERMANENT_ALLOW_RE = re.compile(
    r"\bdon['’]?t ask (?:me )?again\b|\bdo not ask (?:me )?again\b|\balways\b|\b(?:this|the) session\b"
    r"|\bauto[- ]?accept|\bauto mode\b|\ballow all\b|\bpermanent"
    r"|不再詢問|不再询问|一律允許|一律允许|自動核准|自动批准|總是允許|总是允许|始終允許|始终允许"
    r"|本次工作階段|此工作階段|本次会话|此会话"
    r"|今後|以降|常に許可|次回から|このセッション",
    re.IGNORECASE,
)


# A checkbox row of a multi-select menu ("[ ] Lint", "[✔] Tests", "☐ Docs"), and a
# row that opens a free-text answer (after its box, in a multi-select menu).
# Keep in sync with CHECKBOX and FREE_TEXT in src/renderer/src/lib/paneAnswerKeys.ts.
_MULTI_SELECT_RE = re.compile(r"^\s*(?:\[[^\]]?\]|[☐☑☒□■◻◼✓✔✗])")
_CHECKED_RE = re.compile(r"^\s*(?:\[[^\s\]]\]|[☑☒■◼✓✔✗])")
_FREE_TEXT_RE = re.compile(
    r"^\s*(?:type something|type here|something else|other\b|自行輸入|自由輸入|其他)", re.IGNORECASE)
# What cli_answer_prompt says of a menu it cannot answer (the chat relay can).
COMPUTER_ONLY = "這題需要在電腦上操作（多選／自由輸入）"


def new_request_id() -> str:
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(ID_LENGTH))


@dataclass
class RelayRequest:
    id: str
    pane_id: str
    kind: str  # "permission" | "question"
    options: list[str]
    loc: Location
    created: float = field(default_factory=time.monotonic)
    # The prompt text the request was made for; an answer applies only to it.
    prompt: str = ""
    # The chat message carrying the request (its last chunk, where the buttons
    # are) and that message's text, so a request that lapses can settle it.
    message_id: str = ""
    message_text: str = ""
    # The 「正在等確認」 warnings that carried this request's buttons too: (message id, text).
    held: list[tuple[str, str]] = field(default_factory=list)
    # The pane's CLI, where the window reported it.
    agent_key: str = ""
    # A multi-select menu: several boxes are picked in one answer.
    multi: bool = False
    # The boxes ticked with the buttons so far (multi-select); starts as the screen shows them.
    ticked: set[int] = field(default_factory=set)
    # Navide Guard would refuse a chat approval of this prompt: only deny is offered.
    local_only: bool = False


@dataclass(frozen=True)
class RelayAnswer:
    request_id: str
    choice: str  # "y" | "n" | "1".."9" | "1,3" (multi-select)
    text: str = ""  # for a free-text row


def parse_answer(text: str, callback_data: str) -> RelayAnswer | None:
    """A relay answer in a chat message or button press, or None for ordinary text."""
    if callback_data:
        m = _CALLBACK_RE.match(callback_data)
        return RelayAnswer(m.group(1), m.group(2)) if m else None
    m = _TEXT_ANSWER_RE.match(text or "")
    choice = _choice(m, 3)
    if not choice:
        return None
    return RelayAnswer(m.group(2).lower(), choice, answer_text(m.group(3) or ""))


def parse_bare(text: str) -> tuple[str, str]:
    """The choice and free text in a bare ``yes`` / ``n`` / ``2`` / ``1,3`` / ``3 <text>``
    with no request id, else ("", "")."""
    m = _BARE_ANSWER_RE.match(text or "")
    choice = _choice(m, 2)
    return (choice, answer_text(m.group(2) or "")) if choice else ("", "")


def _choice(m: re.Match[str] | None, text_group: int) -> str:
    """The normalized choice; "" when there is none, or when text follows yes / no."""
    if not m:
        return ""
    word = m.group(1).lower()
    if word in ("yes", "y", "no", "n"):
        return "" if m.group(text_group) else word[0]
    return ",".join(re.split(r"\s*[,，、]\s*", word))


# Bidi controls and zero-width characters: invisible in the chat, they could make
# the typed text read differently from what lands in the pane.
# Keep in sync with INVISIBLE in src/renderer/src/lib/paneAnswerKeys.ts.
_INVISIBLE_RE = re.compile("[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")


def answer_text(text: str) -> str:
    """Free text as it may be typed into a pane: one line (U+2028 / U+2029 too), no
    control or invisible characters. Never shortened: the pane gets all of it."""
    visible = _INVISIBLE_RE.sub("", text)
    return " ".join(re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", " ", visible).split())


def choice_numbers(choice: str) -> list[int]:
    """The option numbers in ``choice`` (ascending, once each), or [] for yes / no."""
    if not choice or not all(part.isdigit() for part in choice.split(",")):
        return []
    return sorted({int(part) for part in choice.split(",")})


def is_permanent_allow(option: str) -> bool:
    """True for an option that allows more than this one prompt."""
    return bool(_PERMANENT_ALLOW_RE.search(option or ""))


def is_multi_select(option: str) -> bool:
    return bool(_MULTI_SELECT_RE.match(option or ""))


def is_free_text(option: str) -> bool:
    return bool(_FREE_TEXT_RE.match(_MULTI_SELECT_RE.sub("", option or "", count=1)))


def refuses_permanent(request: RelayRequest, choice: str) -> bool:
    """``choice`` would press a permanent-allow option (``yes`` presses option 1)."""
    if request.kind == "permission":
        return choice == "y" and (
            request.agent_key in PERMANENT_ALLOW_AGENTS
            or (bool(request.options) and is_permanent_allow(request.options[0]))
        )
    return any(is_permanent_allow(request.options[n - 1])
               for n in choice_numbers(choice) if 1 <= n <= len(request.options))


_DENY_OPTION_RE = re.compile(r"^\s*(no|deny|reject|decline|cancel|abort|拒絕|取消|否)\b", re.IGNORECASE)


def is_deny(request: RelayRequest, answer: dict[str, Any]) -> bool:
    """The answer refuses: ``no``, or a question option that reads as a refusal."""
    if answer.get("kind") == "permission":
        return answer.get("choice") == "deny"
    n = int(answer.get("option") or 0)
    return 1 <= n <= len(request.options) and bool(_DENY_OPTION_RE.match(request.options[n - 1]))


def screen_approval(pane_id: str, prompt: str, workspace: str, *, record: bool = True) -> Any:
    """Navide Guard on an approval made away from the computer (chat, or an
    agent through MCP): the guard Decision, whose action is "allow" only when
    the prompt may be approved remotely. High/critical, unscreenable or empty
    prompts need someone at the computer. Deterministic, never an LLM.
    ``record=False`` previews it (which buttons to offer) without auditing it."""
    from .. import guard

    if not prompt.strip():
        # Nothing to screen: a remote approval fails closed.
        return guard.Decision("deny", "normal", (), "no prompt on screen to screen", False)
    return guard.evaluate(
        pane_id=pane_id, vendor="", tool="prompt", tool_input={"text": prompt},
        cwd=workspace, workspace=workspace, source="relay", record=record,
    )


def same_prompt(a: str, b: str) -> bool:
    """Equal up to whitespace (the probe re-renders the same screen)."""
    return " ".join((a or "").split()) == " ".join((b or "").split())


def same_options(a: list[str], b: list[str]) -> bool:
    """The same menu, row for row, up to whitespace (as the window's expected check)."""
    return len(a) == len(b) and all(same_prompt(x, y) for x, y in zip(a, b))


def _offered(request: RelayRequest) -> list[tuple[int, str]]:
    return [(i, opt) for i, opt in enumerate(request.options[:MAX_BUTTON_OPTIONS], 1)
            if not is_permanent_allow(opt) and (not request.multi or is_multi_select(opt))]


def _free_text_option(request: RelayRequest) -> int:
    """The number of the offered free-text row, or 0."""
    return next((i for i, opt in _offered(request) if is_free_text(opt)), 0)


def _allow_offered(request: RelayRequest) -> bool:
    return not request.local_only and not refuses_permanent(request, "y")


def answer_payload(request: RelayRequest, choice: str, text: str = "") -> dict[str, Any] | None:
    """The ``ui.pane.sendKeys`` answer for ``choice`` (and the free ``text`` its
    free-text row takes), or None if it does not fit the request."""
    if request.kind == "permission":
        if choice in ("y", "n") and not text:
            return {"kind": "permission", "choice": "allow" if choice == "y" else "deny"}
        return None
    numbers = choice_numbers(choice)
    if request.kind != "question" or not numbers:
        return None
    if request.options and numbers[-1] > len(request.options):
        return None
    free = _free_text_option(request)
    if free in numbers and not text or text and free not in numbers:
        return None  # a free-text row takes text, and only it does
    if request.multi:
        offered = {i for i, _ in _offered(request)}
        if not set(numbers) <= offered:
            return None
        return {"kind": "multi", "options": numbers, **({"text": text} if text else {})}
    if len(numbers) != 1:
        return None
    return {"kind": "question", "option": numbers[0], **({"text": text} if text else {})}


def describe_answer(answer: dict[str, Any]) -> str:
    if answer["kind"] == "permission":
        return "允許" if answer["choice"] == "allow" else "拒絕"
    if answer["kind"] == "multi":
        picked = "、".join(str(n) for n in answer["options"])
        return f"選項 {picked}" + ("（含自由輸入）" if answer.get("text") else "")
    return f"選項 {answer['option']}" + ("（自由輸入）" if answer.get("text") else "")


def invalid_reply(request: RelayRequest) -> str:
    """What a question answer that did not fit is told."""
    if request.multi or _free_text_option(request):
        return f"⚠️ 請回覆有效的選項編號：{answer_hint(request)}"
    return "⚠️ 請回覆有效的選項編號"


def prompt_text(request: RelayRequest, prompt: str) -> str:
    lines = [f"⏸ pane 需要確認（{request.kind}）"]
    if prompt.strip():
        lines.append(prompt.strip())
    if request.kind == "question":
        for i, opt in _offered(request):
            lines.append(f"{i}. {opt}")
        lines.append(answer_hint(request))
    elif _allow_offered(request):
        lines.append(f"回覆 yes {request.id} / no {request.id}")
    elif request.local_only:
        lines.append(f"回覆 no {request.id}（這個動作需要在電腦前允許）")
    else:
        lines.append(f"回覆 no {request.id}（允許會永久放行，請在電腦前操作）")
    return "\n".join(lines)


def answer_hint(request: RelayRequest) -> str:
    """How to answer ``request`` from chat, in one line."""
    if request.kind == "question":
        free = _free_text_option(request)
        if request.multi:
            boxes = [i for i, _ in _offered(request) if i != free]
            example = ",".join(str(i) for i in boxes[:2]) or "1"
            hint = f"可複選，回覆 <編號,編號> {request.id}（例如 {example} {request.id}）"
            if free:
                hint += f"；自由輸入：回覆 {free} {request.id} <你的文字>（可與其他編號並列，如 1,{free}）"
            return hint
        hint = f"回覆 <選項編號> {request.id}"
        if free:
            hint += f"；自由輸入：回覆 {free} {request.id} <你的文字>"
        return hint
    if _allow_offered(request):
        return f"回覆 yes {request.id} / no {request.id}"
    return f"回覆 no {request.id}（允許請在電腦前操作）"


def is_pending_command(body: str, identity: str = "") -> bool:
    """``/pending``, optionally ``@bot``-addressed or after a mention; one addressed to
    another bot is not ours."""
    rest = strip_mention(body, identity)
    if not rest.startswith("/") or " " in rest:
        return False
    head, _, bot = rest.partition("@")
    if bot and identity and bot.lower() != identity.lstrip("@").lower():
        return False
    return head.lower() == "/pending"


HELD_PROMPT_MAX = 300


def held_text(request: RelayRequest) -> str:
    """The prompt, its options and how to answer, for a warning that may be read
    long after the prompt message itself scrolled away."""
    prompt = request.prompt.strip()
    if len(prompt) > HELD_PROMPT_MAX:
        prompt = prompt[:HELD_PROMPT_MAX] + "…"
    lines = [prompt] if prompt else []
    if request.kind == "question":
        lines += [f"{i}. {opt}" for i, opt in _offered(request)]
    lines.append(answer_hint(request))
    return "\n".join(lines)


def buttons_for(request: RelayRequest) -> list[tuple[str, str]]:
    if request.kind == "permission":
        deny = ("拒絕", f"{CALLBACK_PREFIX}{request.id}:n")
        return [("允許", f"{CALLBACK_PREFIX}{request.id}:y"), deny] if _allow_offered(request) else [deny]
    if request.multi:
        return []  # without toggle_buttons, several boxes are picked with a typed list
    # A free-text row needs its text, which a button cannot carry.
    return [(f"{i}. {opt}"[:40], f"{CALLBACK_PREFIX}{request.id}:{i}") for i, opt in _offered(request)
            if not is_free_text(opt)]


def toggle_buttons(request: RelayRequest) -> list[tuple[str, str]]:
    """A multi-select question's buttons: one per box, ticked or not, then 送出.
    The free-text row needs its text, which a button cannot carry."""
    boxes = [(f"{'✓' if i in request.ticked else '☐'} {i}. {_MULTI_SELECT_RE.sub('', opt, count=1).strip()}"[:40],
              f"{CALLBACK_PREFIX}{request.id}:t{i}") for i, opt in _offered(request) if not is_free_text(opt)]
    return [*boxes, ("送出", f"{CALLBACK_PREFIX}{request.id}:s")]


def toggle(request: RelayRequest, n: int) -> bool:
    """Tick or untick box ``n``; False when it is not a box a button may tick."""
    if not request.multi or n not in {i for i, opt in _offered(request) if not is_free_text(opt)}:
        return False
    request.ticked ^= {n}
    return True


def ticked_choice(request: RelayRequest) -> str:
    """The ticked boxes as a choice ("1,3"), "" when none is."""
    return ",".join(str(n) for n in sorted(request.ticked))


class RelayTable:
    def __init__(self, *, clock=time.monotonic,
                 on_expired: Callable[[RelayRequest], None] | None = None) -> None:
        self._clock = clock
        self._by_id: dict[str, RelayRequest] = {}
        # Told of each request the TTL removed, so its chat prompt can be settled.
        self._on_expired = on_expired

    def create(
        self, pane_id: str, kind: str, options: list[str], loc: Location, prompt: str = "",
        agent_key: str = "", multi: bool = False,
    ) -> RelayRequest:
        self.prune()
        rid = new_request_id()
        while rid in self._by_id:
            rid = new_request_id()
        req = RelayRequest(rid, pane_id, kind, list(options), loc, self._clock(), prompt,
                           agent_key=agent_key, multi=multi)
        if multi:
            req.ticked = {i for i, opt in _offered(req) if not is_free_text(opt) and _CHECKED_RE.match(opt)}
        self._by_id[rid] = req
        return req

    def take(self, request_id: str) -> RelayRequest | None:
        """Single use: the request is gone once taken."""
        self.prune()
        return self._by_id.pop(request_id, None)

    def get(self, request_id: str) -> RelayRequest | None:
        """The live request, left answerable: an answer that is refused or not sent
        must not use it up."""
        self.prune()
        return self._by_id.get(request_id)

    def expire_pane(self, pane_id: str) -> list[RelayRequest]:
        """Drop the pane's requests; returns them so their chat messages can be settled."""
        gone = [req for req in self._by_id.values() if req.pane_id == pane_id]
        for req in gone:
            del self._by_id[req.id]
        return gone

    def prune(self) -> list[RelayRequest]:
        """Drop the requests older than REQUEST_TTL_S; returns them."""
        cutoff = self._clock() - REQUEST_TTL_S
        gone = [req for req in self._by_id.values() if req.created < cutoff]
        for req in gone:
            del self._by_id[req.id]
            if self._on_expired is not None:
                self._on_expired(req)
        return gone

    def for_location(self, location_key: str) -> list[RelayRequest]:
        self.prune()
        return [r for r in self._by_id.values() if r.loc.key() == location_key]

    def for_pane(self, pane_id: str) -> list[RelayRequest]:
        return [r for r in self._by_id.values() if r.pane_id == pane_id]
