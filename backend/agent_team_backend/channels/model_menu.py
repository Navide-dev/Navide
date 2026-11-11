"""/model in a chat: switch a bound pane's model with two presses (0.2.41).

Step 1 picks a pane (the bound pane and its children, the tree /status shows),
step 2 a model; an effort is a third, optional step, because only a restart
can apply one. The switch itself is cli_set_model's (mcp_server.pane_model_tool
.switch_pane_model): claude through its /model picker with `s`, codex with
`/model <id>`, anything else, or any effort, a restart onto `--model`. Only
this session changes; the CLI's saved default is left alone.

A Telegram client can send any callback data, so a button carries a random
token and nothing else. The token is looked up here and counts only from the
chat it was sent to and from the person who opened the menu. Every render
mints fresh tokens and kills the last ones, so a button works once, and a
menu dies after MENU_TTL_S or when its switch is sent.
"""

from __future__ import annotations

import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from . import quick_menu
from .. import prompt_skills

CALLBACK_PREFIX = "nv5:"
# The /status button: opens a fresh menu for whoever presses it (handled as a typed /model).
OPEN_CALLBACK = "nv5:open"
# The quick menu's alphabet: letters and digits that read unambiguously.
TOKEN_ALPHABET = quick_menu.TOKEN_ALPHABET
TOKEN_LENGTH = 10
MENU_TTL_S = 1800.0
MAX_MENUS = 200
_CALLBACK_RE = re.compile(rf"^nv5:([{TOKEN_ALPHABET}]{{{TOKEN_LENGTH}}})$")

# claude's /model picker rows, by the alias the picker matches to one row of each family.
# Mirrors claudePickerLabel's families in src/renderer/src/lib/liveModelSwitch.ts (a guard
# test keeps the two in step).
CLAUDE_MODELS: tuple[tuple[str, str], ...] = (
    ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku"), ("fable", "Fable"),
)
MODELS_PER_ROW = 2
EFFORTS_PER_ROW = 3
LABEL_MAX = 30

STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "open": "🧠 切換模型",
        "pick_pane": "🧠 切換模型：選分格",
        "pick_model": "🧠 {pane}（{agent}）目前：{current}\n選要切換的模型（只改這次對話）",
        "pick_effort": "⚙️ {pane} → {model}\n選強度：會重開分格，分格 id 會變",
        "default": "預設",
        "effort_button": "⚙️ 也調強度（會重開分格）",
        "back": "◀ 換分格",
        "cancel": "✖ 取消",
        "cancelled": "已取消切換模型。",
        "not_owner": "只有開這份選單的人能按。要切換請自己傳 /model。",
        "expired": "這份選單已過期或分格已變動，請重傳 /model。",
        "no_panes": "這個聊天室沒有可以切換模型的分格。",
        "no_models": "{pane}（{agent}）沒有可選的模型清單，請打字：/model {n} <模型 id>",
        "unsupported": "{pane}（{agent}）不能切換模型。",
        "switching": "⏳ 正在把 {pane} 切到 {model}…",
        "ok": "✅ {pane} 已切到 {model}（{method}）。",
        "restarted": "分格已重開，id：{old} → {new}",
        "fallback": "改用重開的原因：{reason}",
        "audited": "已寫入 Navide Guard 稽核。",
        "failed": "❌ {pane} 沒有切到 {model}：{error}",
        "busy": "⏳ {pane} 正在執行中，沒有中斷它。",
        "busy_awaiting": "它在等確認，可以先用 /pending 回答。",
        "wait_button": "⏳ 閒置後切換",
        "queued": "⏳ 等 {pane} 閒置後切到 {model}（最多等 {minutes} 分鐘）。",
        "replaced": "先前排隊要把 {pane} 切到 {model} 的請求，已由新的取代。",
        "timeout": "⌛ 等了 {minutes} 分鐘 {pane} 仍未閒置，沒有切到 {model}。",
        "list_hint": "回覆 /model <編號> <模型> 切換，例如：/model 1 sonnet",
    },
    "en-US": {
        "open": "🧠 Switch model",
        "pick_pane": "🧠 Switch model: pick a pane",
        "pick_model": "🧠 {pane} ({agent}) now on: {current}\nPick a model (this conversation only)",
        "pick_effort": "⚙️ {pane} → {model}\nPick an effort: the pane restarts and gets a new id",
        "default": "default",
        "effort_button": "⚙️ Also set effort (restarts)",
        "back": "◀ Other pane",
        "cancel": "✖ Cancel",
        "cancelled": "Model switch cancelled.",
        "not_owner": "Only the person who opened this menu can use it. Send /model to open your own.",
        "expired": "This menu expired or its panes changed. Send /model again.",
        "no_panes": "This chat has no pane whose model can be switched.",
        "no_models": "{pane} ({agent}) has no model list to pick from. Type: /model {n} <model id>",
        "unsupported": "{pane} ({agent}) cannot switch its model.",
        "switching": "⏳ Switching {pane} to {model}…",
        "ok": "✅ {pane} is now on {model} ({method}).",
        "restarted": "The pane restarted, id: {old} → {new}",
        "fallback": "Restarted because: {reason}",
        "audited": "Recorded in the Navide Guard audit log.",
        "failed": "❌ {pane} did not switch to {model}: {error}",
        "busy": "⏳ {pane} is working; it was not interrupted.",
        "busy_awaiting": "It is waiting for a confirmation; answer it with /pending first.",
        "wait_button": "⏳ Switch when idle",
        "queued": "⏳ {pane} switches to {model} once idle (waiting up to {minutes} minutes).",
        "replaced": "The queued switch of {pane} to {model} was replaced by a newer one.",
        "timeout": "⌛ {pane} was still busy after {minutes} minutes; it was not switched to {model}.",
        "list_hint": "Reply /model <number> <model> to switch, e.g. /model 1 sonnet",
    },
    "ja-JP": {
        "open": "🧠 モデル切替",
        "pick_pane": "🧠 モデル切替：ペインを選択",
        "pick_model": "🧠 {pane}（{agent}）現在：{current}\n切り替えるモデルを選択（この会話のみ）",
        "pick_effort": "⚙️ {pane} → {model}\n強度を選択：ペインが再起動し、id が変わります",
        "default": "既定",
        "effort_button": "⚙️ 強度も変更（再起動）",
        "back": "◀ 別のペイン",
        "cancel": "✖ キャンセル",
        "cancelled": "モデルの切り替えを取り消しました。",
        "not_owner": "このメニューを開いた人だけが押せます。切り替えるには自分で /model を送ってください。",
        "expired": "このメニューは期限切れか、ペインが変わりました。/model をもう一度送ってください。",
        "no_panes": "このチャットにはモデルを切り替えられるペインがありません。",
        "no_models": "{pane}（{agent}）には選べるモデル一覧がありません。入力してください：/model {n} <モデル id>",
        "unsupported": "{pane}（{agent}）はモデルを切り替えられません。",
        "switching": "⏳ {pane} を {model} に切り替え中…",
        "ok": "✅ {pane} を {model} に切り替えました（{method}）。",
        "restarted": "ペインが再起動しました。id：{old} → {new}",
        "fallback": "再起動した理由：{reason}",
        "audited": "Navide Guard の監査ログに記録しました。",
        "failed": "❌ {pane} を {model} に切り替えられませんでした：{error}",
        "busy": "⏳ {pane} は実行中です。中断はしていません。",
        "busy_awaiting": "確認待ちです。先に /pending で回答できます。",
        "wait_button": "⏳ 待機後に切替",
        "queued": "⏳ {pane} が待機状態になったら {model} に切り替えます（最大 {minutes} 分）。",
        "replaced": "{pane} を {model} に切り替える予約は、新しい予約に置き換えられました。",
        "timeout": "⌛ {minutes} 分待っても {pane} は待機状態にならず、{model} には切り替えていません。",
        "list_hint": "/model <番号> <モデル> で切り替え。例：/model 1 sonnet",
    },
    "zh-CN": {
        "open": "🧠 切换模型",
        "pick_pane": "🧠 切换模型：选分格",
        "pick_model": "🧠 {pane}（{agent}）当前：{current}\n选要切换的模型（只改这次对话）",
        "pick_effort": "⚙️ {pane} → {model}\n选强度：会重开分格，分格 id 会变",
        "default": "默认",
        "effort_button": "⚙️ 也调强度（会重开分格）",
        "back": "◀ 换分格",
        "cancel": "✖ 取消",
        "cancelled": "已取消切换模型。",
        "not_owner": "只有打开这份菜单的人能按。要切换请自己发 /model。",
        "expired": "这份菜单已过期或分格已变动，请重发 /model。",
        "no_panes": "这个聊天室没有可以切换模型的分格。",
        "no_models": "{pane}（{agent}）没有可选的模型列表，请输入：/model {n} <模型 id>",
        "unsupported": "{pane}（{agent}）不能切换模型。",
        "switching": "⏳ 正在把 {pane} 切到 {model}…",
        "ok": "✅ {pane} 已切到 {model}（{method}）。",
        "restarted": "分格已重开，id：{old} → {new}",
        "fallback": "改用重开的原因：{reason}",
        "audited": "已写入 Navide Guard 审计。",
        "failed": "❌ {pane} 没有切到 {model}：{error}",
        "busy": "⏳ {pane} 正在执行中，没有中断它。",
        "busy_awaiting": "它在等确认，可以先用 /pending 回答。",
        "wait_button": "⏳ 闲置后切换",
        "queued": "⏳ 等 {pane} 闲置后切到 {model}（最多等 {minutes} 分钟）。",
        "replaced": "先前排队要把 {pane} 切到 {model} 的请求，已由新的取代。",
        "timeout": "⌛ 等了 {minutes} 分钟 {pane} 仍未闲置，没有切到 {model}。",
        "list_hint": "回复 /model <编号> <模型> 切换，例如：/model 1 sonnet",
    },
    "ko-KR": {
        "open": "🧠 모델 전환",
        "pick_pane": "🧠 모델 전환: pane 선택",
        "pick_model": "🧠 {pane}({agent}) 현재: {current}\n전환할 모델을 고르세요(이 대화만)",
        "pick_effort": "⚙️ {pane} → {model}\n강도 선택: pane이 다시 시작되고 id가 바뀌어요",
        "default": "기본값",
        "effort_button": "⚙️ 강도도 설정(재시작)",
        "back": "◀ 다른 pane",
        "cancel": "✖ 취소",
        "cancelled": "모델 전환을 취소했어요.",
        "not_owner": "이 메뉴를 연 사람만 누를 수 있어요. 직접 /model을 보내 주세요.",
        "expired": "이 메뉴가 만료됐거나 pane이 바뀌었어요. /model을 다시 보내 주세요.",
        "no_panes": "이 채팅에는 모델을 바꿀 수 있는 pane이 없어요.",
        "no_models": "{pane}({agent})에는 고를 모델 목록이 없어요. 입력하세요: /model {n} <모델 id>",
        "unsupported": "{pane}({agent})은(는) 모델을 바꿀 수 없어요.",
        "switching": "⏳ {pane}을(를) {model}(으)로 전환하는 중…",
        "ok": "✅ {pane}이(가) {model}(으)로 전환됐어요({method}).",
        "restarted": "pane이 다시 시작됐어요. id: {old} → {new}",
        "fallback": "재시작한 이유: {reason}",
        "audited": "Navide Guard 감사 기록에 남겼어요.",
        "failed": "❌ {pane}을(를) {model}(으)로 전환하지 못했어요: {error}",
        "busy": "⏳ {pane}이(가) 작업 중이에요. 중단하지 않았어요.",
        "busy_awaiting": "확인을 기다리는 중이에요. 먼저 /pending으로 답할 수 있어요.",
        "wait_button": "⏳ 유휴 시 전환",
        "queued": "⏳ {pane}이(가) 유휴 상태가 되면 {model}(으)로 전환해요(최대 {minutes}분).",
        "replaced": "{pane}을(를) {model}(으)로 바꾸려던 대기 요청은 새 요청으로 대체됐어요.",
        "timeout": "⌛ {minutes}분을 기다려도 {pane}이(가) 유휴 상태가 아니어서 {model}(으)로 전환하지 않았어요.",
        "list_hint": "/model <번호> <모델>로 답하면 전환돼요. 예: /model 1 sonnet",
    },
    "es-ES": {
        "open": "🧠 Cambiar modelo",
        "pick_pane": "🧠 Cambiar modelo: elige un pane",
        "pick_model": "🧠 {pane} ({agent}) usa ahora: {current}\nElige un modelo (solo esta conversación)",
        "pick_effort": "⚙️ {pane} → {model}\nElige el esfuerzo: el pane se reinicia y cambia de id",
        "default": "predeterminado",
        "effort_button": "⚙️ Ajustar esfuerzo (reinicia)",
        "back": "◀ Otro pane",
        "cancel": "✖ Cancelar",
        "cancelled": "Cambio de modelo cancelado.",
        "not_owner": "Solo quien abrió este menú puede usarlo. Envía /model para abrir el tuyo.",
        "expired": "Este menú caducó o sus panes cambiaron. Envía /model de nuevo.",
        "no_panes": "Este chat no tiene ningún pane cuyo modelo se pueda cambiar.",
        "no_models": "{pane} ({agent}) no tiene lista de modelos. Escribe: /model {n} <id del modelo>",
        "unsupported": "{pane} ({agent}) no puede cambiar de modelo.",
        "switching": "⏳ Cambiando {pane} a {model}…",
        "ok": "✅ {pane} usa ahora {model} ({method}).",
        "restarted": "El pane se reinició, id: {old} → {new}",
        "fallback": "Se reinició porque: {reason}",
        "audited": "Registrado en la auditoría de Navide Guard.",
        "failed": "❌ {pane} no cambió a {model}: {error}",
        "busy": "⏳ {pane} está trabajando; no se interrumpió.",
        "busy_awaiting": "Espera una confirmación; respóndela primero con /pending.",
        "wait_button": "⏳ Cambiar al quedar libre",
        "queued": "⏳ {pane} cambiará a {model} cuando quede libre (espera hasta {minutes} minutos).",
        "replaced": "El cambio en cola de {pane} a {model} se sustituyó por uno más reciente.",
        "timeout": "⌛ {pane} seguía ocupado tras {minutes} minutos; no se cambió a {model}.",
        "list_hint": "Responde /model <número> <modelo> para cambiar, p. ej. /model 1 sonnet",
    },
    "fr-FR": {
        "open": "🧠 Changer de modèle",
        "pick_pane": "🧠 Changer de modèle : choisissez un pane",
        "pick_model": "🧠 {pane} ({agent}) utilise : {current}\nChoisissez un modèle (cette conversation seulement)",
        "pick_effort": "⚙️ {pane} → {model}\nChoisissez l’effort : le pane redémarre et change d’id",
        "default": "par défaut",
        "effort_button": "⚙️ Régler l’effort (redémarre)",
        "back": "◀ Autre pane",
        "cancel": "✖ Annuler",
        "cancelled": "Changement de modèle annulé.",
        "not_owner": "Seule la personne qui a ouvert ce menu peut s’en servir. Envoyez /model pour ouvrir le vôtre.",
        "expired": "Ce menu a expiré ou ses panes ont changé. Renvoyez /model.",
        "no_panes": "Ce chat n’a aucun pane dont on peut changer le modèle.",
        "no_models": "{pane} ({agent}) n’a pas de liste de modèles. Tapez : /model {n} <id du modèle>",
        "unsupported": "{pane} ({agent}) ne peut pas changer de modèle.",
        "switching": "⏳ Passage de {pane} à {model}…",
        "ok": "✅ {pane} utilise maintenant {model} ({method}).",
        "restarted": "Le pane a redémarré, id : {old} → {new}",
        "fallback": "Redémarré parce que : {reason}",
        "audited": "Consigné dans l’audit de Navide Guard.",
        "failed": "❌ {pane} n’est pas passé à {model} : {error}",
        "busy": "⏳ {pane} travaille ; il n’a pas été interrompu.",
        "busy_awaiting": "Il attend une confirmation ; répondez d’abord avec /pending.",
        "wait_button": "⏳ Changer une fois libre",
        "queued": "⏳ {pane} passera à {model} une fois libre (attente de {minutes} minutes au plus).",
        "replaced": "Le changement en attente de {pane} vers {model} a été remplacé par un plus récent.",
        "timeout": "⌛ {pane} était encore occupé après {minutes} minutes ; il n’est pas passé à {model}.",
        "list_hint": "Répondez /model <numéro> <modèle> pour changer, par ex. /model 1 sonnet",
    },
    "de-DE": {
        "open": "🧠 Modell wechseln",
        "pick_pane": "🧠 Modell wechseln: pane wählen",
        "pick_model": "🧠 {pane} ({agent}) läuft auf: {current}\nModell wählen (nur dieses Gespräch)",
        "pick_effort": "⚙️ {pane} → {model}\nAufwand wählen: das pane startet neu und bekommt eine neue id",
        "default": "Standard",
        "effort_button": "⚙️ Auch Aufwand (Neustart)",
        "back": "◀ Anderes pane",
        "cancel": "✖ Abbrechen",
        "cancelled": "Modellwechsel abgebrochen.",
        "not_owner": "Nur wer dieses Menü geöffnet hat, kann es benutzen. Sende /model für ein eigenes.",
        "expired": "Dieses Menü ist abgelaufen oder seine panes haben sich geändert. Sende /model erneut.",
        "no_panes": "Dieser Chat hat kein pane, dessen Modell sich wechseln lässt.",
        "no_models": "{pane} ({agent}) hat keine Modellliste. Tippe: /model {n} <Modell-id>",
        "unsupported": "{pane} ({agent}) kann sein Modell nicht wechseln.",
        "switching": "⏳ {pane} wechselt zu {model}…",
        "ok": "✅ {pane} läuft jetzt auf {model} ({method}).",
        "restarted": "Das pane wurde neu gestartet, id: {old} → {new}",
        "fallback": "Neu gestartet, weil: {reason}",
        "audited": "Im Navide-Guard-Audit festgehalten.",
        "failed": "❌ {pane} wurde nicht auf {model} umgestellt: {error}",
        "busy": "⏳ {pane} arbeitet gerade; es wurde nicht unterbrochen.",
        "busy_awaiting": "Es wartet auf eine Bestätigung; beantworte sie zuerst mit /pending.",
        "wait_button": "⏳ Wechseln, wenn frei",
        "queued": "⏳ {pane} wechselt zu {model}, sobald es frei ist (höchstens {minutes} Minuten).",
        "replaced": "Der wartende Wechsel von {pane} zu {model} wurde durch einen neueren ersetzt.",
        "timeout": "⌛ {pane} war nach {minutes} Minuten noch beschäftigt; es wurde nicht auf {model} umgestellt.",
        "list_hint": "Antworte /model <Nummer> <Modell> zum Wechseln, z. B. /model 1 sonnet",
    },
    "pt-BR": {
        "open": "🧠 Trocar modelo",
        "pick_pane": "🧠 Trocar modelo: escolha um pane",
        "pick_model": "🧠 {pane} ({agent}) usa agora: {current}\nEscolha um modelo (só esta conversa)",
        "pick_effort": "⚙️ {pane} → {model}\nEscolha o esforço: o pane reinicia e muda de id",
        "default": "padrão",
        "effort_button": "⚙️ Ajustar esforço (reinicia)",
        "back": "◀ Outro pane",
        "cancel": "✖ Cancelar",
        "cancelled": "Troca de modelo cancelada.",
        "not_owner": "Só quem abriu este menu pode usá-lo. Envie /model para abrir o seu.",
        "expired": "Este menu expirou ou os panes mudaram. Envie /model de novo.",
        "no_panes": "Este chat não tem pane cujo modelo possa ser trocado.",
        "no_models": "{pane} ({agent}) não tem lista de modelos. Digite: /model {n} <id do modelo>",
        "unsupported": "{pane} ({agent}) não pode trocar de modelo.",
        "switching": "⏳ Trocando {pane} para {model}…",
        "ok": "✅ {pane} agora usa {model} ({method}).",
        "restarted": "O pane reiniciou, id: {old} → {new}",
        "fallback": "Reiniciou porque: {reason}",
        "audited": "Registrado na auditoria do Navide Guard.",
        "failed": "❌ {pane} não trocou para {model}: {error}",
        "busy": "⏳ {pane} está trabalhando; não foi interrompido.",
        "busy_awaiting": "Ele espera uma confirmação; responda primeiro com /pending.",
        "wait_button": "⏳ Trocar quando livre",
        "queued": "⏳ {pane} troca para {model} quando ficar livre (espera de até {minutes} minutos).",
        "replaced": "A troca na fila de {pane} para {model} foi substituída por uma mais nova.",
        "timeout": "⌛ {pane} ainda estava ocupado após {minutes} minutos; não trocou para {model}.",
        "list_hint": "Responda /model <número> <modelo> para trocar, por ex. /model 1 sonnet",
    },
    "ru-RU": {
        "open": "🧠 Сменить модель",
        "pick_pane": "🧠 Смена модели: выберите pane",
        "pick_model": "🧠 {pane} ({agent}) сейчас: {current}\nВыберите модель (только для этого разговора)",
        "pick_effort": "⚙️ {pane} → {model}\nВыберите усилие: pane перезапустится и получит новый id",
        "default": "по умолчанию",
        "effort_button": "⚙️ Ещё и усилие (перезапуск)",
        "back": "◀ Другая pane",
        "cancel": "✖ Отмена",
        "cancelled": "Смена модели отменена.",
        "not_owner": "Пользоваться меню может только тот, кто его открыл. Отправьте /model, чтобы открыть своё.",
        "expired": "Меню устарело или его pane изменились. Отправьте /model ещё раз.",
        "no_panes": "В этом чате нет pane, у которой можно сменить модель.",
        "no_models": "У {pane} ({agent}) нет списка моделей. Введите: /model {n} <id модели>",
        "unsupported": "{pane} ({agent}) не может сменить модель.",
        "switching": "⏳ Переключаю {pane} на {model}…",
        "ok": "✅ {pane} теперь на {model} ({method}).",
        "restarted": "Pane перезапущена, id: {old} → {new}",
        "fallback": "Перезапущена, потому что: {reason}",
        "audited": "Записано в журнал аудита Navide Guard.",
        "failed": "❌ {pane} не переключена на {model}: {error}",
        "busy": "⏳ {pane} работает; её не прерывали.",
        "busy_awaiting": "Она ждёт подтверждения; сначала ответьте через /pending.",
        "wait_button": "⏳ Сменить, когда свободна",
        "queued": "⏳ {pane} переключится на {model}, когда освободится (ожидание до {minutes} минут).",
        "replaced": "Ожидавшая смена {pane} на {model} заменена более новой.",
        "timeout": "⌛ {pane} была занята и через {minutes} минут; на {model} не переключена.",
        "list_hint": "Ответьте /model <номер> <модель>, например /model 1 sonnet",
    },
    "vi-VN": {
        "open": "🧠 Đổi mô hình",
        "pick_pane": "🧠 Đổi mô hình: chọn pane",
        "pick_model": "🧠 {pane} ({agent}) đang dùng: {current}\nChọn mô hình (chỉ cuộc trò chuyện này)",
        "pick_effort": "⚙️ {pane} → {model}\nChọn mức nỗ lực: pane sẽ khởi động lại và đổi id",
        "default": "mặc định",
        "effort_button": "⚙️ Chỉnh cả nỗ lực (khởi động lại)",
        "back": "◀ Pane khác",
        "cancel": "✖ Hủy",
        "cancelled": "Đã hủy đổi mô hình.",
        "not_owner": "Chỉ người mở menu này mới bấm được. Hãy gửi /model để mở menu của bạn.",
        "expired": "Menu này đã hết hạn hoặc các pane đã thay đổi. Hãy gửi lại /model.",
        "no_panes": "Cuộc trò chuyện này không có pane nào đổi được mô hình.",
        "no_models": "{pane} ({agent}) không có danh sách mô hình. Hãy gõ: /model {n} <id mô hình>",
        "unsupported": "{pane} ({agent}) không đổi được mô hình.",
        "switching": "⏳ Đang đổi {pane} sang {model}…",
        "ok": "✅ {pane} đã chuyển sang {model} ({method}).",
        "restarted": "Pane đã khởi động lại, id: {old} → {new}",
        "fallback": "Khởi động lại vì: {reason}",
        "audited": "Đã ghi vào nhật ký kiểm tra Navide Guard.",
        "failed": "❌ {pane} chưa đổi sang {model}: {error}",
        "busy": "⏳ {pane} đang làm việc; không bị ngắt.",
        "busy_awaiting": "Pane đang chờ xác nhận; hãy trả lời bằng /pending trước.",
        "wait_button": "⏳ Đổi khi rảnh",
        "queued": "⏳ {pane} sẽ đổi sang {model} khi rảnh (chờ tối đa {minutes} phút).",
        "replaced": "Yêu cầu đổi {pane} sang {model} đang chờ đã được thay bằng yêu cầu mới.",
        "timeout": "⌛ Sau {minutes} phút {pane} vẫn bận; chưa đổi sang {model}.",
        "list_hint": "Trả lời /model <số> <mô hình> để đổi, ví dụ /model 1 sonnet",
    },
}


def text(lang: str, key: str, **kw: Any) -> str:
    table = STRINGS.get(lang) or STRINGS[prompt_skills.DEFAULT_LANGUAGE]
    template = table.get(key) or STRINGS[prompt_skills.DEFAULT_LANGUAGE][key]
    return template.format(**kw) if kw else template


@dataclass
class PaneRow:
    """One pane the menu offers, as read when the menu opened."""

    pane_id: str
    name: str
    agent_key: str
    model: str = ""
    efforts: tuple[str, ...] = ()
    models: tuple[tuple[str, str], ...] = ()  # (model id, label)
    supports_model: bool = True


def model_options(agent_key: str, current: str, known: list[str]) -> tuple[tuple[str, str], ...]:
    """What the model step offers: claude's picker families; for any other CLI, the
    models this workspace's panes of the same CLI were opened or switched on (no
    maintained per-vendor list — it would go stale). The current one is kept first."""
    if agent_key == "claude":
        return CLAUDE_MODELS
    seen: list[str] = []
    for m in [current, *known]:
        m = (m or "").strip()
        if m and m not in seen:
            seen.append(m)
    return tuple((m, m) for m in seen)


@dataclass
class Menu:
    id: str
    location_key: str
    sender_id: str
    lang: str
    root_pane_id: str
    panes: list[PaneRow]
    created: float
    step: str = "pane"  # pane | model | effort | busy
    pane_id: str = ""
    model: str = ""
    effort: str = ""
    with_effort: bool = False  # the model step's "also set effort" toggle
    message_id: str = ""
    tokens: list[str] = field(default_factory=list)

    def row(self) -> PaneRow | None:
        return next((p for p in self.panes if p.pane_id == self.pane_id), None)


@dataclass
class Press:
    menu: Menu
    action: str  # pane | model | effort-step (toggle) | effort | back | cancel | wait
    value: str = ""


def parse_callback(data: str) -> str | None:
    """The token of a menu button, or None (OPEN_CALLBACK is not a token)."""
    m = _CALLBACK_RE.match(data or "")
    return m.group(1) if m else None


def parse_command(body: str) -> tuple[int | None, str, str] | None:
    """``/model [n] [model] [effort]`` (``body`` already stripped of an @mention) as
    (1-based pane number or None, model, effort); None when it is not /model."""
    parts = (body or "").strip().split()
    if not parts:
        return None
    head = parts[0].lower()
    if "@" in head:
        head = head.split("@", 1)[0]
    if head != "/model" or len(parts) > 4:
        return None
    rest = parts[1:]
    index: int | None = None
    if rest and rest[0].isdigit():
        index = int(rest[0])
        rest = rest[1:]
    if len(rest) > 2:
        return None
    return index, (rest[0] if rest else ""), (rest[1] if len(rest) > 1 else "")


def _label(s: str) -> str:
    return s if len(s) <= LABEL_MAX else s[: LABEL_MAX - 1] + "…"


class ModelMenus:
    """The open /model menus and the tokens of their live buttons."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._menus: dict[str, Menu] = {}
        self._tokens: dict[str, tuple[str, str, str]] = {}  # token -> (menu id, action, value)

    def create(self, *, location_key: str, sender_id: str, lang: str, root_pane_id: str,
               panes: list[PaneRow]) -> Menu:
        self._prune()
        while len(self._menus) >= MAX_MENUS:
            self.close(next(iter(self._menus.values())))
        menu = Menu(id=secrets.token_hex(6), location_key=location_key, sender_id=sender_id,
                    lang=lang, root_pane_id=root_pane_id, panes=panes, created=self._clock())
        if len(panes) == 1:
            menu.step, menu.pane_id = "model", panes[0].pane_id
        self._menus[menu.id] = menu
        return menu

    def press(self, token: str, location_key: str, sender_id: str) -> tuple[Press | None, str]:
        """(press, "") for a live button pressed by the menu's owner in its own chat, else
        (None, "expired" | "not_owner"). A press does not spend the token: the next render
        does, so a press refused further on can be retried until then."""
        self._prune()
        hit = self._tokens.get(token)
        menu = self._menus.get(hit[0]) if hit else None
        if hit is None or menu is None or menu.location_key != location_key:
            return None, "expired"
        if menu.sender_id != sender_id:
            return None, "not_owner"
        return Press(menu, hit[1], hit[2]), ""

    def freeze(self, menu: Menu) -> None:
        """Kill every button the menu shows, keeping the menu for a later render."""
        for t in menu.tokens:
            self._tokens.pop(t, None)
        menu.tokens = []

    def close(self, menu: Menu) -> None:
        """Kill the menu and every button it still shows."""
        self.freeze(menu)
        self._menus.pop(menu.id, None)

    def render(self, menu: Menu) -> tuple[str, list[list[tuple[str, str]]]]:
        """The menu's body and button rows for its current step, on fresh tokens."""
        self.freeze(menu)
        lang = menu.lang

        def button(label: str, action: str, value: str = "") -> tuple[str, str]:
            token = "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(TOKEN_LENGTH))
            self._tokens[token] = (menu.id, action, value)
            menu.tokens.append(token)
            return _label(label), f"{CALLBACK_PREFIX}{token}"

        def chunk(items: list[tuple[str, str]], n: int) -> list[list[tuple[str, str]]]:
            return [items[i:i + n] for i in range(0, len(items), n)]

        cancel = button(text(lang, "cancel"), "cancel")
        row = menu.row()
        if menu.step == "pane" or row is None:
            rows = [[button(f"{p.name} · {p.agent_key} · {p.model or text(lang, 'default')}", "pane", p.pane_id)]
                    for p in menu.panes]
            return text(lang, "pick_pane"), [*rows, [cancel]]
        nav = [button(text(lang, "back"), "back"), cancel] if len(menu.panes) > 1 else [cancel]
        if menu.step == "busy":
            return "", [[button(text(lang, "wait_button"), "wait")], [cancel]]
        if menu.step == "effort":
            efforts = [button(e, "effort", e) for e in row.efforts]
            body = text(lang, "pick_effort", pane=row.name, model=menu.model)
            return body, [*chunk(efforts, EFFORTS_PER_ROW), nav]
        models = [button(("✓ " if m == row.model else "") + label, "model", m) for m, label in row.models]
        rows = chunk(models, MODELS_PER_ROW)
        if row.efforts:
            on = "✓ " if menu.with_effort else ""
            rows.append([button(on + text(lang, "effort_button"), "effort-step")])
        body = text(lang, "pick_model", pane=row.name, agent=row.agent_key,
                    current=row.model or text(lang, "default"))
        if not row.models:
            n = menu.panes.index(row) + 1
            body += "\n" + text(lang, "no_models", pane=row.name, agent=row.agent_key, n=n)
        return body, [*rows, nav]

    def _prune(self) -> None:
        cutoff = self._clock() - MENU_TTL_S
        for menu in [m for m in self._menus.values() if m.created < cutoff]:
            self.close(menu)
