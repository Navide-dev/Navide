"""Persistent pipeline stage registry.

Pipelines live in the app-data navide.db (kv key "pipelines"; legacy
pipelines.json is imported once and retired). Each pipeline has a name, a
builtin flag, and an embedded list of stages.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from . import pipeline_graph as pg
from .applog import app_data_dir
from .db import DB_FILENAME, Database

log = logging.getLogger("agent_team_backend.stages")

PIPELINES_FILE = "pipelines.json"
STAGES_FILE = "stages.json"  # legacy — only used for migration detection
_KV_KEY = "pipelines"
# Pipeline keys that never leave this machine (settings bundle export).
LOCAL_ONLY_PIPELINE_KEYS = ("source", "credentials")

# Persisted-store schema version. Bumped when the on-disk shape changes in a way
# that needs a forward migration (see store_migrations.py). Distinct from the
# doc's own "version": 2 field, which gates the pipelines container format.
SCHEMA_VERSION = 1


@dataclass
class SlotDef:
    agent_key: str
    role_key: str
    label: str
    kickoff_body: str
    is_commander: bool = False


@dataclass
class StageDef:
    id: str
    title: str
    short_title: str
    question: str
    description: str
    recommended_roles: list[str]
    sentinel: str
    slots: list[SlotDef] = field(default_factory=list)
    allow_questions: bool = False
    doc_query: str = ""


@dataclass
class PipelineDef:
    id: str
    name: str
    builtin: bool = False
    stages: list[dict[str, Any]] = field(default_factory=list)


def _stage_to_dict(s: StageDef) -> dict[str, Any]:
    return asdict(s)


def default_stages() -> list[dict[str, Any]]:
    """Seed set — the default 5-stage SDLC pipeline."""
    stages = [
        StageDef(
            id="01",
            title="01 Requirement Analysis",
            short_title="Requirements",
            question="要做什麼 / 不做什麼？",
            description="透過訪談收斂專案邊界、產出 PRD，明確專案目標與預期效益，避免後續「這不是我要的功能」爭議。",
            recommended_roles=["pm", "qa", "backend"],
            allow_questions=True,
            doc_query="project requirements, user stories, acceptance criteria",
            sentinel="---SPEC-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="pm",
                    label="Requirements",
                    is_commander=True,
                    kickoff_body="""[Stage 01 · Requirement Analysis]
任務：{{task}}

請以資深規格分析者的身份，產出這份內部系統的 PRD 草稿，內容必須包含：
1. 目標使用者與營運痛點（具體場景）。
2. MVP 必做功能（3-5 項，每項列出 actor / trigger / input / output / status）。
3. 明確「不做項目」（avoid scope creep）。
4. 5 個可測試的使用者驗收情境（UAT scenarios），含預期結果。
5. 風險與相依（外部系統 / 法遵 / 資料來源）。

關鍵未知資訊就用 QUESTION 區塊問我，不要憑空假設。

sentinel 輸出規則：
錯誤：完成了 ---SPEC-DONE---
錯誤：```
---SPEC-DONE---
```
正確：最後一行只有 ---SPEC-DONE---

完成後，最後一行只輸出 ---SPEC-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="02",
            title="02 System Planning",
            short_title="Planning",
            question="系統怎麼撐起來？",
            description="依 PRD 產出技術藍圖：framework 選擇、資料庫、ERD、API surface、安全決策、phased delivery 切片。這是後續設計與實作的技術基礎。",
            recommended_roles=["pm", "backend"],
            allow_questions=True,
            doc_query="system architecture, database schema, REST API design, authentication patterns",
            sentinel="---PLAN-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="pm",
                    label="Planning",
                    kickoff_body="""[Stage 02 · System Planning]
任務脈絡：{{task}}

你是系統架構師。依前一階段的 PRD（前置階段產出已附在最前面，請先閱讀），產出技術藍圖：
1. 系統技術藍圖：framework 選擇、資料庫、伺服器部署模式、外部整合清單。
2. 核心 ERD（entities、欄位型別、relations）。
3. API surface 列表（method、path、request/response schema 摘要、purpose）。
4. 安全性決策：驗證機制、敏感資料加密、CORS 策略。
5. Phased delivery 切片（slice 1..N），每片含「deliverables + 可驗收標準」。

如果有技術決策需要使用者確認（如技術棧選擇、預算考量、特殊限制），用 QUESTION 區塊詢問。
其餘不確定事項根據 PRD 與業界常規自行決策並說明。

sentinel 輸出規則：最後一行只有 ---PLAN-DONE---
完成後，最後一行只輸出 ---PLAN-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="03",
            title="03 UI/UX Design",
            short_title="Design",
            question="使用者看到什麼、怎麼操作？",
            description="依 PRD 需求與 Stage 02 技術藍圖，產出完整的 UI/UX 設計：頁面清單、wireframe、使用者旅程、設計規範。設計需對齊 API surface，確保前後端介面一致。",
            recommended_roles=["frontend", "pm"],
            allow_questions=False,
            doc_query="UI components, responsive design, accessibility, user interaction patterns",
            sentinel="---DESIGN-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="frontend",
                    label="Design",
                    kickoff_body="""[Stage 03 · UI/UX Design]
任務脈絡：{{task}}

你是 UI/UX 設計師。依前兩階段的 PRD 與系統架構藍圖（前置階段產出已附在最前面，請先閱讀），產出：
1. 主要頁面清單（含頁面名稱、用途、主要 CTA）。
2. 每個頁面的 wireframe 大綱：sections 佈局、主要 UI 元件、操作動線。
3. 完整使用者旅程（User Journey Map）：從進站到完成核心任務的每一步。
4. 設計規範草稿：色調方向、字體階層、行動裝置優先（mobile-first）規則。
5. 對使用者體驗影響最大的 3-5 個設計決策，附理由（需對齊 Stage 02 的 API surface）。

遇到不確定事項，根據 PRD 與業界常規自行決策，並在輸出中簡短說明理由，不要停下來問問題。

sentinel 輸出規則：最後一行只有 ---DESIGN-DONE---
完成後，最後一行只輸出 ---DESIGN-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="04",
            title="04 Development & Implementation",
            short_title="Build",
            question="怎麼把藍圖蓋出來？",
            description="Backend（codex）和 Frontend（claude）同時依 Stage 02/03 藍圖各自實作 slice 1，平行進行加速交付。",
            recommended_roles=["backend", "frontend", "mobile"],
            allow_questions=False,
            doc_query="API implementation, database queries, authentication, error handling, security best practices",
            sentinel="---BUILD-DONE---",
            slots=[
                SlotDef(
                    agent_key="codex",
                    role_key="backend",
                    label="Backend",
                    kickoff_body="""[Stage 04-A · 後端實作]
任務脈絡：{{task}}

你是後端工程師。依 Stage 02 的技術藍圖與 API surface（前置階段產出已附在最前面），實作 slice 1 後端：
1. 資料庫 schema / migration（含必要欄位、索引、外鍵）。
2. 核心 REST API 端點（至少完整實作 slice 1 主流程的 CRUD）。
3. 業務邏輯層：validations、error handling、status codes。
4. 環境設定與啟動說明（.env 範本、run 指令）。

遇到不確定事項，根據藍圖與業界常規自行決策並說明，不要停下來問問題。

完成後輸出「Handoff for QA」段：
- Endpoints 清單（method + path + 預期 response）
- 已知 edge cases / 潛在問題
- 給前端的 API 格式備注

sentinel 輸出規則：最後一行只有 ---BUILD-DONE---""",
                ),
                SlotDef(
                    agent_key="claude",
                    role_key="frontend",
                    label="Frontend",
                    kickoff_body="""[Stage 04-B · 前端實作]
任務脈絡：{{task}}

你是前端工程師。依 Stage 03 的 UI/UX wireframe 與 Stage 02 的 API surface（前置階段產出已附在最前面），實作 slice 1 前端：
1. 主要頁面骨架（components 結構、routing 設定）。
2. 與後端 API 的串接層（fetch/axios，含 loading / error state 處理）。
3. 表單驗證與使用者回饋（成功 toast、錯誤提示、空白狀態）。
4. Mobile-first RWD 基礎樣式。

遇到不確定事項，根據 wireframe 與 API surface 自行決策並說明，不要停下來問問題。

完成後輸出「Handoff for QA」段：
- UI 元件清單
- 已知視覺 edge cases / 待確認 API 格式
- 本地啟動說明

sentinel 輸出規則：最後一行只有 ---BUILD-DONE---""",
                ),
            ],
        ),
        StageDef(
            id="04.5",
            title="04.5 Security & Dead-Code Review",
            short_title="Review",
            question="程式碼有哪些安全疑慮？",
            description="靜態掃描 Stage 04 的實作成果：找出安全漏洞、死碼、跨 stage 協作斷層。",
            recommended_roles=["qa", "backend"],
            allow_questions=False,
            doc_query="security vulnerabilities, OWASP top 10, authentication bypass, input validation, common CVEs",
            sentinel="---REVIEW-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="qa",
                    label="Security Review",
                    kickoff_body="""[Stage 04.5 · Security & Dead-Code Review]
任務脈絡：{{task}}

你是資安審查員。依前置階段的實作成果（前置階段產出已附在最前面，請先閱讀），進行靜態掃描：

1. **安全漏洞掃描**（必查）：
   - 未保護的 admin / 管理後台路由（缺少 requireAdmin() 或 requireAuth()）
   - Open Redirect：`searchParams.from`、`query.redirect` 等未驗證就傳給 router.push / redirect
   - 弱 secret fallback：`?? "dev-secret"` 或 `|| "hardcoded-value"` 之類的 anti-pattern
   - Sensitive data leak：console.log / logger 輸出未 redact 的密碼、token、個人資料

2. **死碼掃描**：
   - 建立但從未被任何檔案 import 的模組（lib/、utils/、hooks/ 底下）
   - 重複定義的常數 / 型別（多處各自定義同一個 enum / interface）

3. **跨 stage 一致性**：
   - Stage 03 產出的設計規範檔案是否被 Stage 04 實際使用？
   - 如未使用，明確列出「哪個檔案應該被哪個模組 import」

輸出格式（嚴格遵守）：
## 🔴 嚴重問題（必須修復）
## 🟡 中度問題
## 🟢 輕微問題 / 建議
## ✅ 通過檢查項目

每個問題包含：位置（檔案:行號）、現象、修復建議。

遇到不確定的地方，根據常規安全最佳實踐自行判斷並說明理由。

sentinel 輸出規則：最後一行只有 ---REVIEW-DONE---
完成後，最後一行只輸出 ---REVIEW-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="05",
            title="05 Testing & Acceptance",
            short_title="Testing",
            question="上線前還會炸嗎？",
            description="單元測試、整合測試 + 客戶 UAT。確認系統在極端操作下不會崩潰，且符合需求規格。",
            recommended_roles=["qa", "backend", "frontend"],
            allow_questions=False,
            doc_query="unit testing, integration testing, E2E testing, test coverage, mocking",
            sentinel="---TEST-DONE---",
            slots=[
                SlotDef(
                    agent_key="codex",
                    role_key="qa",
                    label="Testing",
                    kickoff_body="""[Stage 05 · Testing]
任務脈絡：{{task}}

依 stage 04 交付的 slice 1，輸出測試矩陣 + 1-2 個關鍵流程的自動化腳本 + UAT 清單。
完成後在「測試總結」段列所有 BLOCKER bugs 與測試通過的功能清單，即視為本專案交付完成。

重要：請精簡輸出，完整報告不超過 3000 字。測試矩陣用表格呈現，避免冗長說明。

sentinel 輸出規則：最後一行只有 ---TEST-DONE---
完成後，最後一行只輸出 ---TEST-DONE---。""",
                ),
            ],
        ),
    ]
    return [_stage_to_dict(s) for s in stages]


def default_maintenance_stages() -> list[dict[str, Any]]:
    """Seed set — the 3-stage maintenance pipeline."""
    stages = [
        StageDef(
            id="m01",
            title="M01 重現 & 定位",
            short_title="定位",
            question="問題在哪？",
            description="確認問題可重現、找到根因（程式碼位置 / 邏輯錯誤 / 設定錯誤）。",
            recommended_roles=["qa", "backend"],
            allow_questions=True,
            doc_query="debugging, root cause analysis, reproduction steps, error logs",
            sentinel="---LOCATE-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="qa",
                    label="Locate",
                    is_commander=True,
                    kickoff_body="""[維護 M01 · 重現 & 定位]
任務：{{task}}

你是資深工程師，負責找出此次維護任務的根本原因。請：
1. 描述問題的可重現步驟（若資訊不足，用 QUESTION 向使用者確認）。
2. 分析可能的根因（程式碼、邏輯、設定、資料）。
3. 列出你找到的問題位置（檔案:行號 或模組名稱）。
4. 提出修復方向（不需實作，只需說明策略）。

sentinel 輸出規則：最後一行只有 ---LOCATE-DONE---
完成後，最後一行只輸出 ---LOCATE-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="m02",
            title="M02 修復",
            short_title="修復",
            question="怎麼改？",
            description="依 M01 定位結果，實作最小有效修復，不引入額外副作用。",
            recommended_roles=["backend", "frontend"],
            allow_questions=False,
            doc_query="bug fix, patch, minimal change, regression prevention",
            sentinel="---FIX-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="backend",
                    label="Fix",
                    kickoff_body="""[維護 M02 · 修復]
任務脈絡：{{task}}

依前一階段（M01）的定位結果（前置階段產出已附在最前面，請先閱讀），實作修復：
1. 最小有效 diff — 只動必要的程式碼。
2. 說明每個修改的理由（為什麼這樣改而不是別的方式）。
3. 列出可能的副作用與已採取的防護措施。

sentinel 輸出規則：最後一行只有 ---FIX-DONE---
完成後，最後一行只輸出 ---FIX-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="m03",
            title="M03 測試驗證",
            short_title="驗證",
            question="修好了嗎？",
            description="驗證修復有效、無回歸，輸出測試報告。",
            recommended_roles=["qa"],
            allow_questions=False,
            doc_query="regression testing, verification, unit tests, smoke tests",
            sentinel="---VERIFY-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="qa",
                    label="Verify",
                    kickoff_body="""[維護 M03 · 測試驗證]
任務脈絡：{{task}}

依前兩階段的定位與修復成果（前置階段產出已附在最前面，請先閱讀），驗證：
1. 修復有效（問題不再重現的步驟說明）。
2. 沒有引入新的 regression（需列出已測試的相關功能）。
3. 輸出簡潔的測試報告（通過 / 失敗 / 待確認）。

sentinel 輸出規則：最後一行只有 ---VERIFY-DONE---
完成後，最後一行只輸出 ---VERIFY-DONE---。""",
                ),
            ],
        ),
    ]
    return [_stage_to_dict(s) for s in stages]


#: The "proposal landing" built-in (evolve S3): implement → read-only review →
#: CI check → the user's gate. A definition only; nothing starts it.
EVOLVE_LANDING_ID = "evolve-landing"
EVOLVE_LANDING_NAME = "提案落地流程"
#: Built-ins added to a document after it was first written. Each is added
#: once and recorded under this key, so one the user deleted stays deleted.
_SEEDED_KEY = "seeded_builtins"
_LATER_BUILTINS = (EVOLVE_LANDING_ID,)


def default_evolve_landing_pipeline() -> dict[str, Any]:
    """Seed set of the proposal-landing pipeline: its stages and its graph,
    which ends at a gate only the user passes."""
    stages = [
        StageDef(
            id="e01",
            title="E01 實作",
            short_title="實作",
            question="照落地路徑做了嗎？",
            description="照已核准提案 plan 的「落地路徑」實作；只建立、不啟用。",
            recommended_roles=["backend", "frontend"],
            allow_questions=True,
            doc_query="implementation, failing test first, draft pull request",
            sentinel="---LAND-IMPL-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="backend",
                    label="Implement",
                    is_commander=True,
                    kickoff_body="""[提案落地 E01 · 實作]
任務：{{task}}

這是使用者已核准的 evolve 提案。先讀它的 plan，照「落地路徑」那一段做：
1. 程式修正：開 worktree → 先寫會紅的測試 → 修到綠 → 推分支、開 draft PR。
2. 外掛、skill、Prompt、pipeline、角色、排程：只建立定義或送出核准請求，不載入、不啟用、不啟動。
3. 規則／記憶：只把 diff 寫進 plan，不改 Navide 資料夾以外的檔案。
不要合併、不要上架、不要發版。

sentinel 輸出規則：最後一行只有 ---LAND-IMPL-DONE---
完成後，最後一行只輸出 ---LAND-IMPL-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="e02",
            title="E02 唯讀審查",
            short_title="審查",
            question="改得對嗎？",
            description="另一個 pane 唯讀審查實作，只回報，不修改。",
            recommended_roles=["qa"],
            allow_questions=False,
            doc_query="code review, regression risk, deleted functions, credential paths",
            sentinel="---LAND-REVIEW-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="qa",
                    label="Review",
                    kickoff_body="""[提案落地 E02 · 唯讀審查]
任務脈絡：{{task}}

你是唯讀審查者（前置階段產出已附在最前面，請先閱讀）。只讀、不改任何檔案、不 commit、不 push。
1. 對照 plan 的落地路徑，檢查實作有沒有做到、有沒有超出範圍。
2. 檢查有沒有刪掉函式、改了既有簽名、動到憑證或額度相關檔案。
3. 列出問題與建議，標明嚴重度。

sentinel 輸出規則：最後一行只有 ---LAND-REVIEW-DONE---
完成後，最後一行只輸出 ---LAND-REVIEW-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="e03",
            title="E03 CI 檢查",
            short_title="CI",
            question="CI 全綠嗎？",
            description="用 gh 唯讀查 CI，只回報結果。",
            recommended_roles=["qa"],
            allow_questions=False,
            doc_query="continuous integration, workflow run, job conclusions",
            sentinel="---LAND-CI-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="qa",
                    label="CI check",
                    kickoff_body="""[提案落地 E03 · CI 檢查]
任務脈絡：{{task}}

用 gh 唯讀查這個 draft PR 最新 head 的 CI：整個 workflow run 要 completed，而且每個 job 都 success，才算全綠。
只看 gh pr checks 不算數，要逐一列出各 job 的結果。有紅的或被取消的，查出原因後回報。
不要 rerun。不要合併。
沒有 PR 的落地類型（外掛、skill、Prompt、pipeline、角色、排程、規則／記憶），回報「這一類沒有 CI」。

sentinel 輸出規則：最後一行只有 ---LAND-CI-DONE---
完成後，最後一行只輸出 ---LAND-CI-DONE---。""",
                ),
            ],
        ),
    ]
    stage_dicts = [_stage_to_dict(s) for s in stages]
    graph = pg.derive_graph_from_stages(stage_dicts)
    last = graph["nodes"][-1]["id"]
    graph["nodes"].append({
        "id": "gate-user",
        "kind": "gate",
        "label": "使用者核准",
        "position": {"x": (len(stage_dicts) + 1) * pg._LAYER_DX, "y": 0},
        "gate": {"prompt": "合併、載入、上架或啟用都由使用者決定；這個 pipeline 不做任何一項。"},
    })
    graph["edges"].append({"id": pg.edge_id(last, "gate-user"), "from": last, "to": "gate-user", "kind": "main"})
    return {"stages": stage_dicts, "graph": graph}


def _evolve_landing_entry() -> dict[str, Any]:
    seed = default_evolve_landing_pipeline()
    return {"id": EVOLVE_LANDING_ID, "name": EVOLVE_LANDING_NAME, "builtin": True, **seed}


def _step_count(pipeline: dict[str, Any]) -> int:
    """Steps as the editor counts them: every graph node but the trigger, or
    every slot when the pipeline has no stored graph (its derived graph has
    one node per slot). A stage is a layer and can hold several steps."""
    graph = pipeline.get("graph")
    if isinstance(graph, dict):
        return sum(1 for n in graph.get("nodes", []) if n.get("kind") != "trigger")
    return sum(len(s.get("slots") or []) for s in pipeline.get("stages", []))


class StagesStore:
    # Pattern for safe stage IDs: alphanumeric, hyphens, underscores, dots.
    _ID_RE = re.compile(r"^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,62})?$")

    def __init__(self, path: Path | None = None, db: Database | None = None) -> None:
        self._path = path or (app_data_dir() / PIPELINES_FILE)
        self._db = db or Database(self._path.parent / DB_FILENAME)
        # Reentrant: _read_doc takes it to add a later built-in, and most
        # writers already hold it when they call _read_doc.
        self._lock = threading.RLock()

    @property
    def path(self) -> Path:
        return self._db.path

    def _legacy_path(self) -> Path:
        return self._path.parent / STAGES_FILE

    def _import_legacy_pipelines(self, cur: Any, data: Any) -> None:
        if isinstance(data, list):
            # File was somehow written as a flat list — wrap it.
            doc = self._seed_doc()
            if data:
                migrated = [_migrate(s) for s in data]
                for p in doc["pipelines"]:
                    if p["id"] == "default":
                        p["stages"] = migrated
                        break
            self._write_doc(doc)
        elif isinstance(data, dict):
            # Format/version validation happens on read.
            self._write_doc(data)

    def _import_legacy_stages(self, cur: Any, data: Any) -> None:
        """One-time merge of the ancient flat stages.json into a seed doc."""
        doc = self._seed_doc()
        if isinstance(data, list) and data:
            migrated = [_migrate(s) for s in data]
            for p in doc["pipelines"]:
                if p["id"] == "default":
                    p["stages"] = migrated
                    break
            log.info(
                "Migrated %d stages from legacy stages.json into default pipeline",
                len(data),
            )
        self._write_doc(doc)

    def _read_doc(self) -> dict[str, Any]:
        """Read the pipelines document, importing legacy JSON files if needed."""
        data = self._db.kv_get(_KV_KEY)
        if data is None:
            self._db.import_json(_KV_KEY, self._path, self._import_legacy_pipelines)
            data = self._db.kv_get(_KV_KEY)
        if data is None and self._legacy_path().exists():
            self._db.import_json(
                _KV_KEY + "-legacy-stages",
                self._legacy_path(),
                self._import_legacy_stages,
            )
            data = self._db.kv_get(_KV_KEY)
        if data is None:
            doc = self._seed_doc()
            self._write_doc(doc)
            return doc
        if isinstance(data, dict) and data.get("version") == 2:
            schema = data.get("schemaVersion", SCHEMA_VERSION)
            try:
                schema = int(schema)
            except (TypeError, ValueError):
                schema = SCHEMA_VERSION
            if schema > SCHEMA_VERSION:
                # Written by a newer app version. Load as-is and do NOT
                # regenerate/overwrite — avoid truncating forward data.
                log.warning(
                    "pipelines document schemaVersion %s is newer than supported "
                    "%s; loading as-is without rewriting",
                    schema,
                    SCHEMA_VERSION,
                )
                return data
            return self._add_later_builtins(data)
        log.warning("pipelines document has unknown format; regenerating defaults")
        doc = self._seed_doc()
        self._write_doc(doc)
        return doc

    def _seed_doc(self) -> dict[str, Any]:
        return {
            "version": 2,
            "schemaVersion": SCHEMA_VERSION,
            "active_pipeline_id": "default",
            "pipelines": [
                {
                    "id": "default",
                    "name": "預設流程",
                    "builtin": True,
                    "stages": default_stages(),
                },
                {
                    "id": "maintenance",
                    "name": "維護流程",
                    "builtin": True,
                    "stages": default_maintenance_stages(),
                },
                _evolve_landing_entry(),
            ],
            _SEEDED_KEY: list(_LATER_BUILTINS),
        }

    def _add_later_builtins(self, doc: dict[str, Any]) -> dict[str, Any]:
        """Add a built-in this document has never had, once. Writes only when
        one is missing from the seeded record, and changes nothing else."""
        seeded = doc.get(_SEEDED_KEY)
        seeded = [s for s in seeded if isinstance(s, str)] if isinstance(seeded, list) else []
        missing = [b for b in _LATER_BUILTINS if b not in seeded]
        if not missing:
            return doc
        with self._lock:
            fresh = self._db.kv_get(_KV_KEY)
            if isinstance(fresh, dict) and fresh is not doc and fresh != doc:
                return self._read_doc()
            ids = {p.get("id") for p in doc.get("pipelines", []) if isinstance(p, dict)}
            if EVOLVE_LANDING_ID in missing and EVOLVE_LANDING_ID not in ids:
                doc.setdefault("pipelines", []).append(_evolve_landing_entry())
            doc[_SEEDED_KEY] = seeded + missing
            self._write_doc(doc)
        return doc

    def _write_doc(self, doc: dict[str, Any]) -> None:
        self._db.kv_set(_KV_KEY, doc, now=int(time.time()))

    def _get_pipeline(
        self, doc: dict[str, Any], pipeline_id: str | None = None
    ) -> dict[str, Any]:
        """Return the pipeline dict for the given id, or the active pipeline."""
        if not pipeline_id:
            pipeline_id = doc.get("active_pipeline_id", "default")
        pipeline = next(
            (p for p in doc.get("pipelines", []) if p["id"] == pipeline_id), None
        )
        if not pipeline:
            raise StoreNotFound("pipeline", str(pipeline_id), f"pipeline not found: {pipeline_id}")
        return pipeline

    # ── Pipeline CRUD ──────────────────────────────────────────────────────────

    def list_pipelines(self) -> list[dict[str, Any]]:
        doc = self._read_doc()
        return [
            {
                "id": p["id"],
                "name": p["name"],
                "builtin": p.get("builtin", False),
                "stage_count": len(p.get("stages", [])),
                "step_count": _step_count(p),
                "has_graph": "graph" in p,
                **({"imported_from": p["importedFrom"]} if isinstance(p.get("importedFrom"), dict) else {}),
            }
            for p in doc.get("pipelines", [])
        ]

    def get_active_pipeline_id(self) -> str:
        doc = self._read_doc()
        return doc.get("active_pipeline_id", "default")

    def export_document(self, *, include_local: bool = False) -> dict[str, Any]:
        """The document for the settings bundle file, without the keys that
        stay on this machine (an import's source JSON and credential list)
        unless `include_local`."""
        doc = self._read_doc()
        if include_local:
            return doc
        return {
            **doc,
            "pipelines": [
                {k: v for k, v in p.items() if k not in LOCAL_ONLY_PIPELINE_KEYS} for p in doc.get("pipelines", [])
            ],
        }

    def imported_from(self, pipeline_id: str | None) -> dict[str, Any] | None:
        """The import record of a pipeline ({kind, importedAt, workflow}), or
        None for one made in Navide or not found."""
        doc = self._read_doc()
        try:
            record = self._get_pipeline(doc, pipeline_id).get("importedFrom")
        except KeyError:
            return None
        return record if isinstance(record, dict) else None

    def replace_document(self, incoming: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(incoming, dict):
            raise ValueError("pipelines document must be an object")
        pipelines = incoming.get("pipelines")
        if not isinstance(pipelines, list) or not pipelines:
            raise ValueError("pipelines document must contain at least one pipeline")
        active_pipeline_id = str(incoming.get("active_pipeline_id") or pipelines[0].get("id") or "default")
        clean_pipelines: list[dict[str, Any]] = []
        seen: set[str] = set()
        for raw in pipelines:
            if not isinstance(raw, dict):
                raise ValueError("pipeline entries must be objects")
            pid = str(raw.get("id", "")).strip()
            if not pid or pid in seen:
                raise ValueError(f"invalid or duplicate pipeline id: {pid}")
            stages = raw.get("stages", [])
            if not isinstance(stages, list):
                raise ValueError(f"pipeline stages must be a list: {pid}")
            migrated_stages = [_migrate(s) for s in stages]
            for stage in migrated_stages:
                sid = str(stage.get("id", ""))
                if not self._ID_RE.match(sid):
                    raise ValueError(f"invalid stage id {sid!r}: use alphanumeric, hyphen, underscore, dot only")
                if not stage.get("slots"):
                    raise ValueError(f"stage must have at least one slot: {sid}")
            seen.add(pid)
            clean: dict[str, Any] = {
                "id": pid,
                "name": str(raw.get("name") or pid),
                "builtin": bool(raw.get("builtin", False)),
                "stages": migrated_stages,
            }
            if isinstance(raw.get("importedFrom"), dict):
                clean["importedFrom"] = raw["importedFrom"]
            graph = raw.get("graph")
            if graph is not None:
                errors = pg.validate_graph(graph)
                if errors:
                    raise ValueError(f"invalid graph in pipeline {pid}: {'; '.join(errors)}")
                clean["graph"] = graph
                # The graph is authoritative; re-derive so the two cannot disagree.
                clean["stages"] = pg.derive_stages_from_graph(graph, migrated_stages)
            clean_pipelines.append(clean)
        if active_pipeline_id not in seen:
            active_pipeline_id = clean_pipelines[0]["id"]
        doc = {
            "version": 2,
            "schemaVersion": SCHEMA_VERSION,
            "active_pipeline_id": active_pipeline_id,
            "pipelines": clean_pipelines,
        }
        seeded = incoming.get(_SEEDED_KEY)
        if isinstance(seeded, list):
            # Built-ins the source already had (or had deleted) stay that way here.
            doc[_SEEDED_KEY] = [s for s in seeded if isinstance(s, str)]
        with self._lock:
            self._write_doc(doc)
        return doc

    def create_imported_pipeline(
        self,
        name: str,
        graph: dict[str, Any],
        imported_from: dict[str, Any],
        source: dict[str, Any],
        credentials: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """A new pipeline holding an imported graph; never overwrites one. A
        name already in use gets " (2)", " (3)"…. `source` and `credentials`
        stay on this machine (export_document leaves them out)."""
        errors = pg.validate_graph(graph)
        if errors:
            raise pg.GraphError(errors)
        base = name.strip() or "新流程"
        with self._lock:
            doc = self._read_doc()
            taken = {p.get("name") for p in doc["pipelines"]}
            unique, n = base, 2
            while unique in taken:
                unique, n = f"{base} ({n})", n + 1
            ids = {p.get("id") for p in doc["pipelines"]}
            pid = uuid.uuid4().hex[:8]
            while pid in ids:
                pid = uuid.uuid4().hex[:8]
            pipeline: dict[str, Any] = {
                "id": pid,
                "name": unique,
                "builtin": False,
                "stages": [],
                "importedFrom": dict(imported_from),
                "source": source,
                "credentials": list(credentials),
            }
            self._store_graph(doc, pipeline, graph, write=False)
            doc["pipelines"].append(pipeline)
            self._write_doc(doc)
        return {
            "id": pid,
            "name": unique,
            "builtin": False,
            "stage_count": len(pipeline["stages"]),
            "imported_from": pipeline["importedFrom"],
        }

    def create_pipeline(self, name: str) -> dict[str, Any]:
        pid = uuid.uuid4().hex[:8]
        new_pipeline: dict[str, Any] = {
            "id": pid,
            "name": name.strip() or "新流程",
            "builtin": False,
            "stages": [],
        }
        with self._lock:
            doc = self._read_doc()
            doc["pipelines"].append(new_pipeline)
            self._write_doc(doc)
        return {
            "id": new_pipeline["id"],
            "name": new_pipeline["name"],
            "builtin": new_pipeline["builtin"],
            "stage_count": 0,
        }

    def rename_pipeline(self, pipeline_id: str, name: str) -> dict[str, Any]:
        # A blank id means "the active pipeline" to _get_pipeline, which for the
        # stage CRUD is the point but here would rename whatever happens to be
        # active instead of what the caller asked for.
        if not pipeline_id:
            raise StoreNotFound("pipeline", "", "pipeline id is required")
        with self._lock:
            doc = self._read_doc()
            pipeline = self._get_pipeline(doc, pipeline_id)
            pipeline["name"] = name.strip() or pipeline["name"]
            self._write_doc(doc)
        return {
            "id": pipeline["id"],
            "name": pipeline["name"],
            "builtin": pipeline.get("builtin", False),
            "stage_count": len(pipeline.get("stages", [])),
        }

    def delete_pipeline(self, pipeline_id: str) -> list[dict[str, Any]]:
        # Without this a blank id passes the _get_pipeline check (it resolves to
        # the active pipeline) and then matches nothing to remove, so the caller
        # is told the delete succeeded while nothing was deleted.
        if not pipeline_id:
            raise StoreNotFound("pipeline", "", "pipeline id is required")
        with self._lock:
            doc = self._read_doc()
            self._get_pipeline(doc, pipeline_id)  # raises KeyError if not found
            if len(doc.get("pipelines", [])) <= 1:
                raise StoreRefused("last-pipeline", "cannot delete the last remaining pipeline")
            doc["pipelines"] = [p for p in doc["pipelines"] if p["id"] != pipeline_id]
            # Fallback active_pipeline_id if the deleted one was active
            if doc.get("active_pipeline_id") == pipeline_id:
                fallback = next(
                    (p["id"] for p in doc["pipelines"] if p["id"] == "default"), None
                )
                if not fallback and doc["pipelines"]:
                    fallback = doc["pipelines"][0]["id"]
                doc["active_pipeline_id"] = fallback or "default"
            self._write_doc(doc)
        return self.list_pipelines()

    def set_active_pipeline(self, pipeline_id: str) -> str:
        with self._lock:
            doc = self._read_doc()
            if not any(p["id"] == pipeline_id for p in doc.get("pipelines", [])):
                raise StoreNotFound("pipeline", pipeline_id, f"pipeline not found: {pipeline_id}")
            doc["active_pipeline_id"] = pipeline_id
            self._write_doc(doc)
        return pipeline_id

    def reset_builtin(self, pipeline_id: str) -> dict[str, Any]:
        with self._lock:
            doc = self._read_doc()
            pipeline = self._get_pipeline(doc, pipeline_id)
            if not pipeline.get("builtin"):
                raise StoreRefused("not-builtin", f"pipeline is not builtin: {pipeline_id!r}")
            # Matched against the requested id, not the resolved pipeline: a
            # blank id resolves to the active pipeline in _get_pipeline above but
            # matches neither seed here, so it lands in the else and writes
            # nothing. Quoting the id is what makes that visible in the message.
            if pipeline_id == "default":
                pipeline["stages"] = default_stages()
            elif pipeline_id == "maintenance":
                pipeline["stages"] = default_maintenance_stages()
            elif pipeline_id == EVOLVE_LANDING_ID:
                pipeline.update(default_evolve_landing_pipeline())
            else:
                raise StoreRefused("no-seed", f"no seed data for builtin pipeline: {pipeline_id!r}")
            # Restoring the seed restores its shape too: the seeds are linear,
            # except the landing pipeline's, whose seed carries its graph.
            if pipeline_id != EVOLVE_LANDING_ID:
                pipeline.pop("graph", None)
            self._write_doc(doc)
        return {
            "id": pipeline["id"],
            "name": pipeline["name"],
            "builtin": pipeline.get("builtin", False),
            "stage_count": len(pipeline.get("stages", [])),
        }

    # ── Role references ───────────────────────────────────────────────────────

    def find_role_usages(self, role_key: str) -> list[dict[str, Any]]:
        """Every stage slot naming this role, across all pipelines.

        Deleting a role that a slot still names leaves that slot pointing at
        nothing, which the renderer can only report as a failed pane, so
        roles.delete asks first and refuses.
        """
        if not role_key:
            return []
        doc = self._read_doc()
        usages: list[dict[str, Any]] = []
        for pipeline in doc.get("pipelines", []):
            for stage in pipeline.get("stages", []):
                for slot in stage.get("slots") or []:
                    if slot.get("role_key") != role_key:
                        continue
                    usages.append({
                        "pipeline_id": pipeline.get("id", ""),
                        "pipeline_name": pipeline.get("name", ""),
                        "stage_id": stage.get("id", ""),
                        "stage_title": stage.get("title", ""),
                        "slot_label": slot.get("label", ""),
                    })
        return usages

    def repoint_role_references(self, old_key: str, new_key: str) -> list[str]:
        """Move every slot naming old_key onto new_key; return changed pipeline ids.

        Renaming a role is add-then-remove underneath, and the remove is refused
        while a slot still names the old key, so the references have to move in
        between. Same lock shape as clear_missing_role_references: this store's
        lock only, never held across a call into the roles store.
        """
        if not old_key or old_key == new_key:
            return []
        touched: list[str] = []
        with self._lock:
            doc = self._read_doc()
            for pipeline in doc.get("pipelines", []):
                changed = False
                for stage in pipeline.get("stages", []):
                    for slot in stage.get("slots") or []:
                        if slot.get("role_key") == old_key:
                            slot["role_key"] = new_key
                            changed = True
                for node in _graph_slot_configs(pipeline):
                    if node.get("roleKey") == old_key:
                        node["roleKey"] = new_key
                        changed = True
                if changed:
                    touched.append(pipeline.get("id", ""))
            if touched:
                self._write_doc(doc)
        return touched

    def clear_missing_role_references(
        self, valid_role_keys: set[str]
    ) -> list[str]:
        """Blank every slot role_key outside valid_role_keys; return the ids of
        the pipelines that changed.

        For the role removals that cannot be refused (roles.reset, a settings
        bundle import). An empty role_key is a state the renderer handles —
        role injection is skipped and the kickoff still goes out — while a key
        naming a role that is gone strands the pane. The caller passes the keys
        rather than the store reading them, so no roles lock is ever held while
        this one is taken.
        """
        touched: list[str] = []
        with self._lock:
            doc = self._read_doc()
            for pipeline in doc.get("pipelines", []):
                changed = False
                for stage in pipeline.get("stages", []):
                    for slot in stage.get("slots") or []:
                        key = slot.get("role_key") or ""
                        if key and key not in valid_role_keys:
                            slot["role_key"] = ""
                            changed = True
                for node in _graph_slot_configs(pipeline):
                    key = node.get("roleKey") or ""
                    if key and key not in valid_role_keys:
                        node["roleKey"] = ""
                        changed = True
                if changed:
                    touched.append(pipeline.get("id", ""))
            if touched:
                self._write_doc(doc)
        return touched

    # ── Stage CRUD (pipeline-scoped) ──────────────────────────────────────────

    def list(self, pipeline_id: str | None = None) -> list[dict[str, Any]]:
        doc = self._read_doc()
        pipeline = self._get_pipeline(doc, pipeline_id)
        return [_migrate(s) for s in pipeline.get("stages", [])]

    def upsert(
        self, data: dict[str, Any], pipeline_id: str | None = None
    ) -> dict[str, Any]:
        sid = data.get("id") or ""
        if not sid:
            raise StoreRefused("stage-id-required", "stage id is required")
        if not self._ID_RE.match(sid):
            raise StoreRefused("stage-id-invalid", f"invalid stage id {sid!r}: use alphanumeric, hyphen, underscore, dot only")
        if not data.get("slots"):
            raise StoreRefused("stage-needs-slot", "stage must have at least one slot")
        with self._lock:
            doc = self._read_doc()
            pipeline = self._get_pipeline(doc, pipeline_id)
            stages: list[dict[str, Any]] = pipeline.setdefault("stages", [])
            idx = next((i for i, s in enumerate(stages) if s.get("id") == sid), -1)
            self._require_stage_editable(pipeline)
            if idx >= 0:
                updated = {**stages[idx], **data}
                stages[idx] = updated
                _resync_linear_graph(pipeline)
                self._write_doc(doc)
                return updated
            stages.append(data)
            _resync_linear_graph(pipeline)
            self._write_doc(doc)
            return data

    def reorder(
        self, ids: list[str], pipeline_id: str | None = None
    ) -> list[dict[str, Any]]:
        with self._lock:
            doc = self._read_doc()
            pipeline = self._get_pipeline(doc, pipeline_id)
            stages: list[dict[str, Any]] = pipeline.get("stages", [])
            by_id = {s["id"]: s for s in stages}
            # An id listed twice must not produce two copies of the same stage.
            mentioned: set[str] = set()
            reordered: list[dict[str, Any]] = []
            for sid in ids:
                if sid in by_id and sid not in mentioned:
                    mentioned.add(sid)
                    reordered.append(by_id[sid])
            for s in stages:
                if s["id"] not in mentioned:
                    reordered.append(s)
            self._require_stage_editable(pipeline)
            pipeline["stages"] = reordered
            _resync_linear_graph(pipeline)
            self._write_doc(doc)
            return reordered

    def delete(self, id: str, pipeline_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            doc = self._read_doc()
            pipeline = self._get_pipeline(doc, pipeline_id)
            stages: list[dict[str, Any]] = pipeline.get("stages", [])
            new_stages = [s for s in stages if s.get("id") != id]
            if len(new_stages) == len(stages):
                raise StoreNotFound("stage", id, f"stage not found: {id}")
            if not new_stages:
                raise StoreRefused("last-stage", "cannot delete the last remaining stage")
            self._require_stage_editable(pipeline)
            pipeline["stages"] = new_stages
            _resync_linear_graph(pipeline)
            self._write_doc(doc)
            return new_stages

    def reset(self, pipeline_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            doc = self._read_doc()
            pipeline = self._get_pipeline(doc, pipeline_id)
            pid = pipeline.get("id", "")
            if pid == "default":
                pipeline["stages"] = default_stages()
            elif pid == "maintenance":
                pipeline["stages"] = default_maintenance_stages()
            else:
                pipeline["stages"] = []
            pipeline.pop("graph", None)
            self._write_doc(doc)
            return pipeline["stages"]

    # ── Graph (optional, authoritative when present) ──────────────────────────

    @staticmethod
    def _require_stage_editable(pipeline: dict[str, Any]) -> None:
        graph = pipeline.get("graph")
        if graph is not None and not pg.is_linear_graph(graph):
            raise GraphNonLinearError(
                "this pipeline has gates, reject loops or cross-layer edges; "
                "edit it with pipeline_graph / pipelines.graph.* instead of stage tools"
            )

    def get_graph(self, pipeline_id: str | None = None) -> dict[str, Any]:
        """{pipeline_id, graph, derived, stages}. derived=True means the
        pipeline has no stored graph and this one was synthesised from its
        stages; nothing is written."""
        doc = self._read_doc()
        pipeline = self._get_pipeline(doc, pipeline_id)
        stages = [_migrate(s) for s in pipeline.get("stages", [])]
        graph = pipeline.get("graph")
        derived = graph is None
        if derived:
            graph = pg.derive_graph_from_stages(stages)
        return {"pipeline_id": pipeline["id"], "graph": graph, "derived": derived, "stages": stages}

    def set_graph(self, pipeline_id: str | None, graph: Any) -> dict[str, Any]:
        """Validate and store a graph; stages are re-derived from it."""
        errors = pg.validate_graph(graph)
        if errors:
            raise pg.GraphError(errors)
        with self._lock:
            doc = self._read_doc()
            pipeline = self._get_pipeline(doc, pipeline_id)
            return self._store_graph(doc, pipeline, graph)

    def apply_graph_ops(self, pipeline_id: str | None, ops: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply ops to the stored graph (or the derived one); all or none."""
        with self._lock:
            doc = self._read_doc()
            pipeline = self._get_pipeline(doc, pipeline_id)
            base = pipeline.get("graph")
            if base is None:
                base = pg.derive_graph_from_stages([_migrate(s) for s in pipeline.get("stages", [])])
            graph = pg.apply_graph_ops(base, ops)
            errors = pg.validate_graph(graph)
            if errors:
                raise pg.GraphError(errors)
            meta_ops = [op for op in ops if op.get("op") == "set_stage_meta"]
            if not meta_ops:
                return self._store_graph(doc, pipeline, graph)
            # Derive first so a layer's new L<n> stage exists to receive its
            # metadata, then patch and store.
            self._store_graph(doc, pipeline, graph, write=False)
            for op in meta_ops:
                stage = next((s for s in pipeline["stages"] if s.get("id") == op.get("stageId")), None)
                if stage is None:
                    raise pg.GraphError([f"stage not found: {op.get('stageId')}"], "stage-not-found")
                for field, key in pg.STAGE_META_FIELDS.items():
                    if field in op:
                        stage[key] = op[field]
            self._write_doc(doc)
            return {"pipeline_id": pipeline["id"], "graph": pipeline["graph"], "stages": pipeline["stages"]}

    def _store_graph(
        self, doc: dict[str, Any], pipeline: dict[str, Any], graph: dict[str, Any], *, write: bool = True
    ) -> dict[str, Any]:
        graph = {**graph, "nodes": [dict(n) for n in graph["nodes"]]}
        if any(n.get("kind") == "subpipeline" for n in graph["nodes"]):
            # Sub-pipeline references are checked across every pipeline: a
            # write may close a loop through pipelines it does not touch.
            graphs = {
                str(p["id"]): p["graph"] for p in doc.get("pipelines", [])
                if isinstance(p.get("graph"), dict) and p is not pipeline
            }
            for p in doc.get("pipelines", []):
                graphs.setdefault(str(p["id"]), {"nodes": [], "edges": []})
            graphs[str(pipeline["id"])] = graph
            errors = pg.subpipeline_cycle_errors(graphs)
            if errors:
                raise pg.GraphError(errors, "subpipeline-links")
        stages = pg.derive_stages_from_graph(graph, [_migrate(s) for s in pipeline.get("stages", [])], stamp=True)
        for stage in stages:
            if not self._ID_RE.match(str(stage.get("id", ""))):
                raise pg.GraphError([f"invalid stage id {stage.get('id')!r} on a slot node's stageId"])
        clean = {"version": pg.GRAPH_VERSION, "nodes": graph["nodes"], "edges": graph["edges"]}
        pipeline["graph"] = clean
        pipeline["stages"] = stages
        if write:
            self._write_doc(doc)
        return {"pipeline_id": pipeline["id"], "graph": clean, "stages": stages}


class GraphNonLinearError(ValueError):
    """A stage-level edit on a pipeline whose graph stages cannot express."""


class StoreRefused(ValueError):
    """A refusal of the caller's request (not a fault): `reason` is a stable
    code a window translates; the message stays the English sentence."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


class StoreNotFound(KeyError):
    """No pipeline or stage with that id. `what` is "pipeline" or "stage";
    `ident` is the id asked for ("" when none was given)."""

    def __init__(self, what: str, ident: str, message: str) -> None:
        super().__init__(message)
        self.what = what
        self.ident = ident


def _graph_slot_configs(pipeline: dict[str, Any]) -> list[dict[str, Any]]:
    graph = pipeline.get("graph")
    if not isinstance(graph, dict):
        return []
    return [n["slot"] for n in graph.get("nodes", []) if isinstance(n.get("slot"), dict)]


def _resync_linear_graph(pipeline: dict[str, Any]) -> None:
    """After a stage edit on a pipeline with a (linear) graph, rebuild the
    graph from the new stages, keeping each surviving node's id, position and
    pin (matched by stage id + slot label) so the canvas does not jump."""
    old = pipeline.get("graph")
    if old is None:
        return
    keep: dict[tuple[str, str], dict[str, Any]] = {}
    trigger = None
    for n in old.get("nodes", []):
        if n.get("kind") == "slot" and isinstance(n.get("slot"), dict):
            keep.setdefault((str(n.get("stageId", "")), str(n["slot"].get("label", ""))), n)
        elif n.get("kind") == "trigger" and trigger is None:
            trigger = n
    fresh = pg.derive_graph_from_stages([_migrate(s) for s in pipeline.get("stages", [])])
    rename: dict[str, str] = {}
    taken = {n["id"] for n in fresh["nodes"]}
    for n in fresh["nodes"]:
        if n["kind"] == "trigger" and trigger is not None:
            n["position"] = trigger.get("position", n["position"])
            continue
        prev = keep.get((str(n.get("stageId", "")), str(n.get("label", ""))))
        if prev is None:
            continue
        if prev["id"] != n["id"] and prev["id"] not in taken:
            rename[n["id"]] = prev["id"]
            taken.add(prev["id"])
        n["position"] = prev.get("position", n["position"])
        if prev.get("pinned"):
            n["pinned"] = True
    for n in fresh["nodes"]:
        n["id"] = rename.get(n["id"], n["id"])
    for e in fresh["edges"]:
        e["from"] = rename.get(e["from"], e["from"])
        e["to"] = rename.get(e["to"], e["to"])
        e["id"] = pg.edge_id(e["from"], e["to"])
    pipeline["graph"] = fresh


def _migrate(raw: dict[str, Any]) -> dict[str, Any]:
    """Strip legacy fields and migrate to is_commander format."""
    _LEGACY_STAGE_MANAGER = (
        "manager_enabled", "manager_agent_key", "manager_role_key",
        "manager_tick_seconds", "manager_max_ticks", "manager_prompt_body",
    )
    _LEGACY = ("default_agent", "default_role", "kickoff_prompt", *_LEGACY_STAGE_MANAGER)
    cleaned = {k: v for k, v in raw.items() if k not in _LEGACY}
    slots = cleaned.get("slots") or []
    if not slots and raw.get("default_agent"):
        # Old single-agent format → wrap into one slot
        cleaned["slots"] = [{
            "agent_key": raw["default_agent"],
            "role_key": raw.get("default_role", ""),
            "label": raw.get("short_title", "Agent"),
            "kickoff_body": raw.get("kickoff_prompt", ""),
            "is_commander": False,
        }]
        log.info("Migrated stage '%s' from legacy format to slots", raw.get("id"))
    else:
        for s in cleaned.get("slots") or []:
            # Migrate old is_manager → is_commander
            if "is_manager" in s:
                s.setdefault("is_commander", s.pop("is_manager"))
            else:
                s.setdefault("is_commander", False)
    return cleaned
