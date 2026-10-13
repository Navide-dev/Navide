"""Persistent role registry.

Roles live in a single JSON file under the macOS app-data dir so users can
edit them from the Role Manager window without recompiling the renderer.
Defaults are seeded on first load.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .applog import app_data_dir
from .db import DB_FILENAME, Database
from .pipeline_graph import validate_role_properties

log = logging.getLogger("agent_team_backend.roles")

ROLES_FILE = "roles.json"
_KV_KEY = "roles"

_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def default_roles() -> list[dict[str, Any]]:
    """Seed set — identical content to src/renderer/src/data/roles.ts.

    Kept in Python so that on first run we can populate roles.json without
    needing the renderer to push anything.
    """
    now = _now_iso()
    return [
        {
            "key": "pm",
            "label": "Product Manager",
            "one_line": "PRD、user stories、UAT、KPI、優先序",
            "system_prompt": _PM_PROMPT,
            "is_default": True,
            "created_at": now,
            "updated_at": now,
        },
        {
            "key": "backend",
            "label": "Backend Engineer",
            "one_line": "API、資料庫、業務邏輯、安全性",
            "system_prompt": _BACKEND_PROMPT,
            "is_default": True,
            "created_at": now,
            "updated_at": now,
        },
        {
            "key": "frontend",
            "label": "Frontend Engineer",
            "one_line": "Component / 狀態管理 / RWD / 效能",
            "system_prompt": _FRONTEND_PROMPT,
            "is_default": True,
            "created_at": now,
            "updated_at": now,
        },
        {
            "key": "mobile",
            "label": "Mobile App Engineer",
            "one_line": "iOS / Android / 跨平台 / 離線優先",
            "system_prompt": _MOBILE_PROMPT,
            "is_default": True,
            "created_at": now,
            "updated_at": now,
        },
        {
            "key": "qa",
            "label": "QA / Test Engineer",
            "one_line": "E2E、Edge cases、自動化測試矩陣",
            "system_prompt": _QA_PROMPT,
            "is_default": True,
            "created_at": now,
            "updated_at": now,
        },
    ]


class RolesStore:
    def __init__(self, path: Path | None = None, db: Database | None = None) -> None:
        self._path = path or (app_data_dir() / ROLES_FILE)
        self._db = db or Database(self._path.parent / DB_FILENAME)
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._db.path

    def _import_legacy(self, cur: Any, data: Any) -> None:
        if isinstance(data, list):
            self._db.kv_set(_KV_KEY, data, now=int(time.time()))

    def _read(self) -> list[dict[str, Any]]:
        data = self._db.kv_get(_KV_KEY)
        if data is None:
            self._db.import_json(_KV_KEY, self._path, self._import_legacy)
            data = self._db.kv_get(_KV_KEY)
        if data is None:
            seed = default_roles()
            self._write(seed)
            return seed
        if not isinstance(data, list):
            log.warning("stored roles document is not a list; regenerating defaults")
            seed = default_roles()
            self._write(seed)
            return seed
        return data

    def _write(self, roles: list[dict[str, Any]]) -> None:
        self._db.kv_set(_KV_KEY, roles, now=int(time.time()))

    # ---- public API ----

    def list(self) -> list[dict[str, Any]]:
        return self._read()

    def get(self, key: str) -> dict[str, Any] | None:
        for r in self._read():
            if r.get("key") == key:
                return r
        return None

    def upsert(
        self,
        *,
        key: str,
        label: str,
        one_line: str,
        system_prompt: str,
        properties: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """properties=None leaves a role's declarative properties as they are;
        [] clears them."""
        self._validate_key(key)
        if not label.strip():
            raise ValueError("label is required")
        if not system_prompt.strip():
            raise ValueError("system_prompt is required")
        extra: dict[str, Any] = {}
        if properties is not None:
            extra["properties"] = validate_role_properties(properties)

        with self._lock:
            roles = self._read()
            now = _now_iso()
            idx = next((i for i, r in enumerate(roles) if r.get("key") == key), -1)
            if idx >= 0:
                existing = roles[idx]
                updated = {
                    **existing,
                    "label": label,
                    "one_line": one_line,
                    "system_prompt": system_prompt,
                    **extra,
                    "updated_at": now,
                }
                roles[idx] = updated
                self._write(roles)
                return updated
            else:
                created = {
                    "key": key,
                    "label": label,
                    "one_line": one_line,
                    "system_prompt": system_prompt,
                    "is_default": False,
                    **extra,
                    "created_at": now,
                    "updated_at": now,
                }
                roles.append(created)
                self._write(roles)
                return created

    def delete(self, key: str) -> list[dict[str, Any]]:
        with self._lock:
            roles = self._read()
            new_roles = [r for r in roles if r.get("key") != key]
            if len(new_roles) == len(roles):
                raise KeyError(f"role not found: {key}")
            if not new_roles:
                raise ValueError("cannot delete the last remaining role")
            self._write(new_roles)
            return new_roles

    def reset(self) -> list[dict[str, Any]]:
        with self._lock:
            seed = default_roles()
            self._write(seed)
            return seed

    def replace_all(self, roles: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not roles:
            raise ValueError("roles cannot be empty")
        clean: list[dict[str, Any]] = []
        seen: set[str] = set()
        now = _now_iso()
        for entry in roles:
            key = str(entry.get("key", "")).strip()
            self._validate_key(key)
            if key in seen:
                raise ValueError(f"duplicate role key: {key}")
            label = str(entry.get("label", "")).strip()
            system_prompt = str(entry.get("system_prompt", ""))
            if not label:
                raise ValueError(f"label is required for role: {key}")
            if not system_prompt.strip():
                raise ValueError(f"system_prompt is required for role: {key}")
            seen.add(key)
            extra: dict[str, Any] = {}
            if entry.get("properties") is not None:
                extra["properties"] = validate_role_properties(entry["properties"])
            clean.append({
                "key": key,
                "label": label,
                "one_line": str(entry.get("one_line", "")).strip(),
                "system_prompt": system_prompt,
                "is_default": bool(entry.get("is_default", False)),
                **extra,
                "created_at": str(entry.get("created_at") or now),
                "updated_at": now,
            })
        with self._lock:
            self._write(clean)
        return clean

    def _validate_key(self, key: str) -> None:
        if not _KEY_RE.match(key):
            raise ValueError(
                "key must be lowercase letters/digits/underscore/dash, 1-32 chars"
            )


# ----- prompt blobs (kept in module scope so default_roles() stays tidy) -----
#
# Style convention shared by all 5 roles:
#   1. Identity (1-2 sentences)
#   2. Top Priorities (max 3, numbered)
#   3. Output Format (with word budget)
#   4. Handoff to Next Stage (concrete artifacts the next role needs)
#
# Pipeline control rules (QUESTION blocks, sentinel format) are intentionally
# NOT in roles — they live in INTERACTION_PROTOCOL / INTERACTION_PROTOCOL_AUTO
# in stages.ts, which is prepended to every stage kickoff. Keeping them
# separate avoids conflicts when a role is used in an auto-mode stage.

_PM_PROMPT = """# Role: Senior Product Manager
你是 Navide (Agent-Team) pipeline 裡的資深產品經理，負責把模糊需求收斂成可交給設計、後端、前端、QA 接續使用的產品文件。輸出要短、清楚、可驗收，不要寫成長篇顧問報告。

# Top Priorities:
1. 切清 MVP 邊界：每個功能能被測試、被驗收、被工程拆工
2. 不憑空補商業規則：可以列「暫定假設」但要標 ⚠ 待確認
3. 技術細節只列候選方案 + 待 Tech Lead 確認，不替工程做不可逆決策

# Output Format:
依任務階段輸出精簡文件（整段敘述 ≤ 800 字）：
- Goal / Problem
- Users & Scenarios
- MVP Scope
- Out of Scope
- User Stories
- Acceptance Criteria
- Risks / Open Questions

# Handoff to Next Stage:
最後一節寫「Handoff Notes」：列出對 Backend / Frontend / Mobile / QA 各自最重要的 3 個交付點與待確認事項。"""

_BACKEND_PROMPT = """# Role: Senior Backend Engineer
你是 Navide (Agent-Team) pipeline 裡的資深後端工程師，負責把 PM 的需求與架構藍圖實作成可運行的 service。輸出聚焦於目前 slice，不要一次寫整個系統。

# Top Priorities:
1. 架構解耦：Service / Repository / Controller 分層清楚，符合 SOLID 與 Clean Architecture
2. 安全與韌性：不信任輸入、嚴謹 validation、處理錯誤、寫 logging、防 SQLi/XSS/CSRF
3. 可被測試：每個 service 給對應 unit test 範例，N+1 / Index / Idempotency 都要主動處理

# Output Format:
針對本 slice 輸出（敘述 ≤ 800 字，程式碼不限但只給本 slice）：
1. 架構設計理念（1-2 段）
2. 程式碼：migration / model / service / controller / route，含型別標註與註解
3. 對應 unit test 範例
4. 變更檔案清單

# Handoff to QA:
最後一節寫「Handoff for QA」：列出本 slice 的 API endpoints（method + path）、預期錯誤碼、需要被測試的 edge cases。"""

_FRONTEND_PROMPT = """# Role: Senior Frontend Web Engineer
你是 Navide (Agent-Team) pipeline 裡的資深前端工程師（React / Vue / TypeScript），負責把設計轉成可互動、可維護、效能良好的 UI。輸出聚焦於目前 component / page，不要一次寫整個 app。

# Top Priorities:
1. 模組化：Dumb Component 拆解、Smart Component / Hook 拿邏輯與 API；避免 prop drilling
2. 邊界狀態：Loading / Success / Error 都處理，給友善 UI 降級與重試
3. 型別嚴格：TypeScript 介面與後端 API 對齊，從 API response 到 UI props 全程靜態檢查

# Output Format:
針對本 component / page 輸出（敘述 ≤ 600 字，程式碼不限）：
1. 元件結構與 props 設計（介面定義）
2. 樣式（Tailwind / CSS Modules）與狀態邏輯
3. 三種邊界狀態的 UI 描述（Loading / Empty / Error）
4. 變更檔案清單

# Handoff to QA:
最後一節寫「Handoff for QA」：列出本 component 的可達狀態、互動點（click / input / hover）、預期錯誤呈現方式。"""

_MOBILE_PROMPT = """# Role: Senior Mobile App Engineer
你是 Navide (Agent-Team) pipeline 裡的資深行動端工程師（跨平台或原生皆可）。

# Top Priorities:
1. 生命週期與記憶體：正確處理前背景切換；dispose 所有 controller / stream / timer / observer，避免 memory leak
2. Offline-first：UI 優先讀本地 cache；離線操作進 Sync Queue，網路恢復自動同步；重要寫入給 optimistic update
3. 平台尊重：iOS 用 HIG（滑動返回、Cupertino）、Android 用 Material（系統返回鍵、Material motion）；不同螢幕 / 瀏海 / safe area / 鍵盤都要適配

# Output Format:
針對本 feature 輸出（敘述 ≤ 800 字，程式碼不限）：
1. 專案資料夾結構（依該框架慣例：feature-first / clean architecture / MVVM）
2. 狀態管理選擇與資料流方向（UI / Domain / Cache / Sync state 分離）
3. 本地持久化 + Sync Queue 設計（含 retry 上限與失敗保留）
4. iOS vs Android 差異化處理（手勢 / 元件 / 權限）
5. 對應的 widget / view test 或 unit test 範例

# Handoff to QA:
最後一節寫「Handoff for QA」：列出本 feature 的 UI 互動點、權限請求流程、離線情境、效能關注點（fps / memory / battery）。"""

_QA_PROMPT = """# Role: Senior QA Automation Engineer
你是 Navide (Agent-Team) pipeline 裡的資深 QA / 自動化測試工程師，具備強烈破壞性思維。負責把工程交付的 slice 變成可重複驗證的測試組與可交付的 UAT 清單。

# Top Priorities:
1. Happy + Unhappy：每個功能都要列極端值、非法字元輸入、邊界、空狀態、超長輸入
2. 自動化優先：E2E / API test 都要可重複，避免 flaky；rate-limited / 共享資源測試特別注意 isolation
3. 漏洞探索：race condition / double submit / token 過期 / 繞過前端驗證直接打 API / SQL injection 嘗試

# Output Format:
針對本 slice / feature 輸出（敘述 ≤ 800 字 + 測試矩陣表 + 範例腳本）：
1. Test Matrix 表格（功能 / Happy / Unhappy / 邊界 / 並發）
2. 1-2 個關鍵流程的 E2E / API 自動化腳本範例（Playwright / Cypress / Jest / Postman 任一）
3. 效能與壓力測試提案（QPS 目標、瓶頸假設、測試方式）
4. 可交給客戶逐項勾選的 UAT 清單

# 測試總結：
最後一節寫「測試總結」：列出阻擋交付的 BLOCKER bugs、必須修的 critical、可延後的 minor，以及驗收通過的功能清單。"""
