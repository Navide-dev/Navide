"""Keep token-bearing query parameters out of every log line.

uvicorn logs each WebSocket handshake through ``uvicorn.error`` at INFO with
the full path and query — ``"WebSocket /ws?t=<token>" [accepted]`` — so with
access_log off the ws credential still reached stdout on every launch. The
backend's credentials travel as ``t=`` (/ws, /fs/raw, /plan-mcp); ``token=``
is covered too so a renamed param does not reopen this.

The filter goes on the loggers and on their handlers: a logger's filters only
see records logged on that logger, while a handler's see everything that
propagates to it, which is what covers ``uvicorn.error`` (no handler of its
own) and any library logging under the root.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping

_PARAM = r"([?&](?:t|token)=)"
_VALUE = r"[^&#\s\"']+"
_TOKEN_PARAM = re.compile(_PARAM + _VALUE)
# For a format string with args: leave ``t=%s`` alone so the arg still has a
# placeholder to fill; the rendered message is checked afterwards.
_TOKEN_PARAM_NOT_PLACEHOLDER = re.compile(_PARAM + r"(?!%[-#0 +]*[\d.]*[sdrifxXeEgGc(])" + _VALUE)


def redact(text: str) -> str:
    return _TOKEN_PARAM.sub(r"\1***", text)


def _redact_arg(value: object) -> object:
    return redact(value) if isinstance(value, str) else value


class TokenRedactionFilter(logging.Filter):
    """Rewrites token values to ``***`` in ``record.msg`` and ``record.args``.

    Never drops a record and never touches its level. The args stay a tuple
    where possible: uvicorn's access formatter unpacks them.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(record.msg, str):
            pattern = _TOKEN_PARAM_NOT_PLACEHOLDER if args else _TOKEN_PARAM
            record.msg = pattern.sub(r"\1***", record.msg)
        if not args:
            return True
        if isinstance(args, Mapping):
            record.args = {k: _redact_arg(v) for k, v in args.items()}
        elif isinstance(args, tuple):
            record.args = tuple(_redact_arg(a) for a in args)
        # ``"?t=%s", token``: the param name and its value only meet once
        # formatted, so redact the formatted message instead.
        try:
            rendered = record.getMessage()
        except Exception:
            return True
        if redact(rendered) != rendered:
            record.msg, record.args = redact(rendered), None
        return True


_FILTER = TokenRedactionFilter()
_LOGGERS = ("", "uvicorn", "uvicorn.error", "uvicorn.access", "uvicorn.asgi", "agent_team_backend")


def install() -> None:
    """Attach the filter to the backend's and uvicorn's loggers and handlers.

    Call after ``uvicorn.Config`` is built: its dictConfig replaces the
    uvicorn handlers, dropping any filter put on them earlier.
    """
    for name in _LOGGERS:
        logger = logging.getLogger(name)
        for target in (logger, *logger.handlers):
            if _FILTER not in target.filters:
                target.addFilter(_FILTER)
