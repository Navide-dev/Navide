"""One worker thread for SQLite writes on the pipeline hot path.

A commit's fsync can take seconds on a slow disk (a VM measured 21.7s), and a
handler that commits on the event loop freezes every window for that long.
Handlers hand such writes here instead. A single worker keeps them in
submission order — a slot_spawn record never lands before the pipeline.start
that created its run — and a read that must see an earlier write goes through
the same queue. Database's RLock already lets its connection be shared across
threads, so the stores themselves are unchanged.
"""

from __future__ import annotations

import asyncio
import functools
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, TypeVar

T = TypeVar("T")

_DB_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="db-writes")


async def run_in_db_thread(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run ``fn`` on the db worker thread, after every earlier submission."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_DB_EXECUTOR, functools.partial(fn, *args, **kwargs))
