"""``/shipped [今天|昨天|7d|ISO 時間]`` in a bound chat: the Shipped Log of the bound
pane's workspace, answered by the backend without waking the pane.

The report is the ``navide.shipped-log`` plugin's; this module is the Host's
half, because a Navide plugin cannot register a chat command. What leaves for
the chat is masked here: sensitive items are only counted (the plugin's
``for_chat`` rendering), high-confidence secrets are cut by ``share_scan``,
email addresses are shortened and registered secrets are redacted.
"""

from __future__ import annotations

from .. import share_scan
from . import quick_menu, redact

COMMAND = "/shipped"
DEFAULT_WINDOW = "今天"


def parse_command(body: str, identity: str = "") -> str | None:
    """The window argument (``""`` for a bare ``/shipped``), optionally ``@bot``-addressed;
    None for anything else or for a command addressed to another bot."""
    rest = quick_menu._MENTION_RE.sub("", (body or "").strip()).strip()
    if not rest.startswith("/"):
        return None
    head, _, tail = rest.partition(" ")
    head, _, bot = head.partition("@")
    if head.lower() != COMMAND or (bot and identity and bot.lower() != identity.lstrip("@").lower()):
        return None
    return tail.strip()


def mask(text: str) -> str:
    """Everything a pushed list must not carry, removed."""
    masked = share_scan.scan(text, kind="text").text
    return redact.redact_text(redact.mask_emails(masked))


async def answer(workspace_path: str, arg: str, lang: str) -> str:
    """The masked reply for ``/shipped <arg>`` in ``workspace_path``."""
    from ..plugins.builtin.navide_shipped_log import messages, report

    if not workspace_path:
        return messages.text(lang, "no_workspace")
    window = arg or DEFAULT_WINDOW
    try:
        start, end = report.parse_window(window)
    except report.WindowError:
        return messages.text(lang, "usage")
    try:
        built = await report.build_report(workspace_path, start, end)
    except Exception as exc:  # noqa: BLE001 - the chat gets a line, never a traceback
        return mask(messages.text(lang, "failed", error=type(exc).__name__))
    return mask(report.render_text(built, lang, for_chat=True))
