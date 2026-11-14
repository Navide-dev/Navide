"""The ordinary path of three pipeline.* handlers that had no test at all
(p3-cleanup): pipeline.fetch_docs, pipeline.auto_answer and
pipeline.slot_kickoff. Their failure paths are covered with the store error
mapping (test_ws_pipeline_store_errors.py)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from agent_team_backend import app as app_module
from agent_team_backend import ws_handlers


class _Session:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, message: dict[str, Any]) -> None:
        self.sent.append(message)


async def test_fetch_docs_answers_the_prefix_the_fetcher_built(monkeypatch) -> None:
    seen: dict[str, Any] = {}

    async def fetch(**kwargs: Any) -> str:
        seen.update(kwargs)
        return "## Docs\nuse the router"

    monkeypatch.setattr(app_module, "fetch_stage_docs", fetch, raising=False)
    monkeypatch.setattr(app_module, "mcp_manager", "mgr", raising=False)
    monkeypatch.setattr(app_module, "ANALYZER_DEFAULT_MODEL", "default-model", raising=False)
    session = _Session()

    await ws_handlers.pipeline_fetch_docs(
        session, "1", "pipeline.fetch_docs", {"task": "build a page", "doc_query": "vue router", "workspace_path": "/ws"}
    )

    assert session.sent[-1]["ok"] is True
    assert session.sent[-1]["payload"] == {"doc_prefix": "## Docs\nuse the router"}
    assert seen == {
        "task": "build a page", "doc_query": "vue router", "mcp_manager": "mgr",
        "workspace_path": "/ws", "analyzer_model": "default-model",
    }


async def test_fetch_docs_is_best_effort_and_answers_empty_on_any_error(monkeypatch) -> None:
    async def broken(**_kwargs: Any) -> str:
        raise RuntimeError("context7 unreachable")

    monkeypatch.setattr(app_module, "fetch_stage_docs", broken, raising=False)
    monkeypatch.setattr(app_module, "mcp_manager", None, raising=False)
    monkeypatch.setattr(app_module, "log", SimpleNamespace(warning=lambda *a, **k: None), raising=False)
    session = _Session()

    await ws_handlers.pipeline_fetch_docs(session, "1", "pipeline.fetch_docs", {"analyzer_model": "m"})

    assert session.sent[-1]["ok"] is True
    assert session.sent[-1]["payload"] == {"doc_prefix": ""}


async def test_auto_answer_passes_the_questions_on_and_records_the_tokens(monkeypatch) -> None:
    seen: dict[str, Any] = {}
    recorded: list[tuple[dict[str, Any], dict[str, Any]]] = []
    answer = {"answers": ["use postgres"], "eval_count": 12, "prompt_eval_count": 34}

    async def auto_answer(**kwargs: Any) -> dict[str, Any]:
        seen.update(kwargs)
        return answer

    monkeypatch.setattr(app_module, "analyzer_auto_answer", auto_answer, raising=False)
    monkeypatch.setattr(app_module, "ANALYZER_DEFAULT_MODEL", "default-model", raising=False)
    monkeypatch.setattr(app_module, "_record_analyzer_tokens", lambda r, p: recorded.append((r, p)), raising=False)
    payload = {"questions": ["which db?"], "task": "build", "stage_title": "Design", "workspace_path": "/ws"}
    session = _Session()

    await ws_handlers.pipeline_auto_answer(session, "1", "pipeline.auto_answer", payload)

    assert session.sent[-1]["ok"] is True
    assert session.sent[-1]["payload"] == answer
    assert seen == {"questions": ["which db?"], "task": "build", "stage_title": "Design", "model": "default-model"}
    assert recorded == [(answer, payload)]


async def test_auto_answer_uses_the_model_it_is_given(monkeypatch) -> None:
    seen: dict[str, Any] = {}

    async def auto_answer(**kwargs: Any) -> dict[str, Any]:
        seen.update(kwargs)
        return {}

    monkeypatch.setattr(app_module, "analyzer_auto_answer", auto_answer, raising=False)
    monkeypatch.setattr(app_module, "_record_analyzer_tokens", lambda r, p: None, raising=False)

    await ws_handlers.pipeline_auto_answer(_Session(), "1", "pipeline.auto_answer", {"model": "qwen"})

    assert seen["model"] == "qwen" and seen["questions"] == [] and seen["task"] == ""


async def test_slot_kickoff_marks_that_slot_and_defaults_to_sent(monkeypatch, tmp_path) -> None:
    from agent_team_backend.projects import ProjectStore

    ws = str(tmp_path)
    store = ProjectStore()
    store.start_pipeline(
        ws, task_description="t", total_stages=1,
        stage_blueprint=[{"stage_id": "01", "slots": [{"label": "a", "agent": "claude"}, {"label": "b", "agent": "codex"}]}],
    )
    store.record_slot_spawn(ws, stage_index=0, slot_label="a", pane_id="pa", agent="claude")
    store.record_slot_spawn(ws, stage_index=0, slot_label="b", pane_id="pb", agent="codex")
    monkeypatch.setattr(app_module, "project_store", store, raising=False)
    monkeypatch.setattr(app_module, "_project_payload", lambda p: {"state": p.state}, raising=False)
    session = _Session()

    await ws_handlers.pipeline_slot_kickoff(
        session, "1", "pipeline.slot_kickoff", {"workspace_path": ws, "stage_index": 0, "slot_label": "a"}
    )
    await ws_handlers.pipeline_slot_kickoff(
        session, "2", "pipeline.slot_kickoff",
        {"workspace_path": ws, "stage_index": "0", "slot_label": "b", "kickoff_status": "failed"},
    )

    assert [m["ok"] for m in session.sent] == [True, True]
    status = {p.pane_id: p.kickoff_status for p in store.peek(ws).panes}
    assert status["pa"] == "sent" and status["pb"] == "failed"
