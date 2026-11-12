"""/account in a chat: switch the CLI account the bound pane runs on (0.2.42).

Opened by /account, or by the "switch account" button a usage-limit notice
carries (OPEN_CALLBACK, handled as a typed /account, so whoever presses it
opens a menu of their own). One row per account of the bound pane's CLI with
its remaining quota, the active one ticked; a press switches at once. The
switch is the window's own (ui.accounts.switchFromChannel): the press is the
user's consent, and anything the window would still ask the person at it is
refused and sent there instead.

Reuse (e.g. a one-button "switch back" offer after an automatic switch): call
``AccountMenus.create`` with the rows and the active id, then ``render`` it, or
``render_single`` for one target; a press comes back through ``press`` and is
re-checked against the live active account before anything switches.

Only claude (a hot swap: nothing restarts) and only a direct chat may switch;
a group chat gets the list without buttons. A Telegram client can send any
callback data, so a button carries a random token and nothing else; it counts
only from the chat it was sent to and from the person who opened the menu.
Every render mints fresh tokens and kills the last ones, and a press freezes
the menu, so a button works once; a menu dies after MENU_TTL_S.
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

CALLBACK_PREFIX = "nv6:"
# The usage-limit notice's button: opens a fresh menu for whoever presses it.
OPEN_CALLBACK = "nv6:open"
TOKEN_ALPHABET = quick_menu.TOKEN_ALPHABET
TOKEN_LENGTH = 10
MENU_TTL_S = 600.0
MAX_MENUS = 200
LABEL_MAX = 34
BUTTON_MAX = 60
SWITCH_AGENT = "claude"
DEFAULT_ID = "__default__"
_CALLBACK_RE = re.compile(rf"^nv6:([{TOKEN_ALPHABET}]{{{TOKEN_LENGTH}}})$")
_EMAIL_RE = re.compile(r"([^\s@]{1,3})[^\s@]*@([^\s@]+)")

STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "open": "🔁 切換帳號",
        "title": "🔁 Claude 帳號（目前：{current}）\n按一下切換；每個分格下一次請求就會用新帳號",
        "title_group": "🔁 Claude 帳號（目前：{current}）\n群組聊天室不能切換，請私訊 bot 傳 /account",
        "fixed": "有 {count} 個分格固定在帳號自己的資料夾，切換後不會跟著換",
        "signed_out": "未登入",
        "no_reading": "—",
        "cancel": "✖ 取消",
        "cancelled": "已取消切換帳號。",
        "not_owner": "只有開這份選單的人能按。要切換請自己傳 /account。",
        "expired": "這份選單已過期，或目前帳號已經變了。請重傳 /account。",
        "unsupported": "這個分格的 CLI（{agent}）不能從聊天室切換帳號，請到 Navide 視窗操作。",
        "no_accounts": "Claude 只有一個帳號，沒有可以切換的。請到 Navide 視窗的「Add / Manage Accounts…」新增。",
        "no_window": "Navide 視窗沒有回應，沒有切換帳號。",
        "switching": "⏳ 正在把 Claude 切到 {to}…",
        "ok": "✅ Claude 已從 {from} 切到 {to}。",
        "ok_signed_out": "⚠️ Claude 已切到 {to}，但這個帳號沒有可用的登入，Navide 視窗已開始登入流程。",
        "needs_window": "這次切換需要在 Navide 視窗確認（{code}），沒有切換，請到視窗操作。",
        "failed": "❌ 沒有切換帳號：{error}",
        "audited": "已寫入 Navide Guard 稽核。",
        "list_hint": "回覆 /account <編號> 切換，例如：/account 2",
        "queued": "⏳ 已排入：等 {count} 個分格閒置後，Claude 會切到 {to}，完成後會再通知。",
        "superseded": "↪ 切到 {to} 的請求已被較新的切換取代，沒有執行。",
        "unavailable": "這個版本還沒接上從聊天室切換帳號，請到 Navide 視窗操作。",
        "needs_user": "這次切換需要你到 Navide 視窗處理（{code}），沒有切換。",
        "model_link": "🧠 切換模型",
        "failover_done": "🔄 額度用完，已自動接續：Claude 從 {from} 換到 {to}。",
        "failover_needs_login": "⚠️ 額度用完，Claude 已自動換到 {to}，但這個帳號沒有可用的登入，請到 Navide 視窗登入。",
        "switch_back": "↩ 改回 {to}",
    },
    "en-US": {
        "open": "🔁 Switch account",
        "title": "🔁 Claude accounts (now: {current})\nTap one to switch; every pane uses it from its next request",
        "title_group": "🔁 Claude accounts (now: {current})\nA group chat cannot switch; message the bot directly and send /account",
        "fixed": "{count} pane(s) are fixed to an account's own folder and stay put when you switch",
        "signed_out": "signed out",
        "no_reading": "—",
        "cancel": "✖ Cancel",
        "cancelled": "Account switch cancelled.",
        "not_owner": "Only the person who opened this menu can use it. Send /account to open your own.",
        "expired": "This menu expired or the active account changed. Send /account again.",
        "unsupported": "This pane's CLI ({agent}) cannot switch accounts from a chat; use the Navide window.",
        "no_accounts": "Claude has only one account, nothing to switch to. Add one under Add / Manage Accounts… in the Navide window.",
        "no_window": "The Navide window did not answer; no account was switched.",
        "switching": "⏳ Switching Claude to {to}…",
        "ok": "✅ Claude switched from {from} to {to}.",
        "ok_signed_out": "⚠️ Claude switched to {to}, but that account has no usable sign-in; the Navide window started one.",
        "needs_window": "This switch needs a confirmation in the Navide window ({code}); nothing was switched. Use the window.",
        "failed": "❌ No account was switched: {error}",
        "audited": "Recorded in the Navide Guard audit.",
        "list_hint": "Reply /account <number> to switch, e.g. /account 2",
        "queued": "⏳ Queued: Claude switches to {to} once {count} pane(s) go idle; you will be told when it is done.",
        "superseded": "↪ The switch to {to} was replaced by a newer switch and did not run.",
        "unavailable": "This version cannot switch accounts from a chat yet; use the Navide window.",
        "needs_user": "This switch needs you in the Navide window ({code}); nothing was switched.",
        "model_link": "🧠 Switch model",
        "failover_done": "🔄 Quota ran out, so Navide continued on another account: Claude switched from {from} to {to}.",
        "failover_needs_login": "⚠️ Quota ran out and Claude switched to {to}, but that account has no usable sign-in; sign in from the Navide window.",
        "switch_back": "↩ Switch back to {to}",
    },
    "ja-JP": {
        "open": "🔁 アカウント切替",
        "title": "🔁 Claude アカウント（現在：{current}）\nタップで切り替え。各ペインは次のリクエストから使います",
        "title_group": "🔁 Claude アカウント（現在：{current}）\nグループでは切り替えできません。bot に直接 /account を送ってください",
        "fixed": "{count} 個のペインはアカウント専用フォルダに固定されており、切り替えても移りません",
        "signed_out": "未ログイン",
        "no_reading": "—",
        "cancel": "✖ キャンセル",
        "cancelled": "アカウントの切り替えをキャンセルしました。",
        "not_owner": "このメニューを開いた人だけが押せます。自分で /account を送ってください。",
        "expired": "このメニューは期限切れか、現在のアカウントが変わりました。/account をもう一度送ってください。",
        "unsupported": "このペインの CLI（{agent}）はチャットからアカウントを切り替えられません。Navide のウィンドウで操作してください。",
        "no_accounts": "Claude のアカウントが 1 つしかなく、切り替え先がありません。Navide の「Add / Manage Accounts…」で追加してください。",
        "no_window": "Navide のウィンドウが応答しません。アカウントは切り替わっていません。",
        "switching": "⏳ Claude を {to} に切り替えています…",
        "ok": "✅ Claude を {from} から {to} に切り替えました。",
        "ok_signed_out": "⚠️ Claude を {to} に切り替えましたが、このアカウントは使えるログインがありません。Navide のウィンドウでログインを始めました。",
        "needs_window": "この切り替えは Navide のウィンドウでの確認が必要です（{code}）。切り替えていません。ウィンドウで操作してください。",
        "failed": "❌ アカウントを切り替えられませんでした：{error}",
        "audited": "Navide Guard の監査に記録しました。",
        "list_hint": "/account <番号> で切り替え。例：/account 2",
        "queued": "⏳ 予約しました：{count} 個のペインが待機状態になったら Claude を {to} に切り替え、完了したらお知らせします。",
        "superseded": "↪ {to} への切り替えは新しい切り替えに置き換えられ、実行されませんでした。",
        "unavailable": "このバージョンではまだチャットからアカウントを切り替えられません。Navide のウィンドウで操作してください。",
        "needs_user": "この切り替えは Navide のウィンドウでの操作が必要です（{code}）。切り替えていません。",
        "model_link": "🧠 モデル切替",
        "failover_done": "🔄 クォータが切れたため自動で継続しました：Claude を {from} から {to} に切り替えました。",
        "failover_needs_login": "⚠️ クォータが切れ、Claude は {to} に切り替わりましたが、このアカウントには使えるログインがありません。Navide のウィンドウでログインしてください。",
        "switch_back": "↩ {to} に戻す",
    },
    "zh-CN": {
        "open": "🔁 切换账号",
        "title": "🔁 Claude 账号（当前：{current}）\n点一下切换；每个分格下一次请求就会用新账号",
        "title_group": "🔁 Claude 账号（当前：{current}）\n群组聊天不能切换，请私聊 bot 发送 /account",
        "fixed": "有 {count} 个分格固定在账号自己的文件夹，切换后不会跟着换",
        "signed_out": "未登录",
        "no_reading": "—",
        "cancel": "✖ 取消",
        "cancelled": "已取消切换账号。",
        "not_owner": "只有打开这份菜单的人能按。要切换请自己发 /account。",
        "expired": "这份菜单已过期，或当前账号已经变了。请重新发送 /account。",
        "unsupported": "这个分格的 CLI（{agent}）不能从聊天切换账号，请到 Navide 窗口操作。",
        "no_accounts": "Claude 只有一个账号，没有可以切换的。请在 Navide 窗口的“Add / Manage Accounts…”添加。",
        "no_window": "Navide 窗口没有响应，没有切换账号。",
        "switching": "⏳ 正在把 Claude 切到 {to}…",
        "ok": "✅ Claude 已从 {from} 切到 {to}。",
        "ok_signed_out": "⚠️ Claude 已切到 {to}，但这个账号没有可用的登录，Navide 窗口已开始登录流程。",
        "needs_window": "这次切换需要在 Navide 窗口确认（{code}），没有切换，请到窗口操作。",
        "failed": "❌ 没有切换账号：{error}",
        "audited": "已写入 Navide Guard 审计。",
        "list_hint": "回复 /account <编号> 切换，例如：/account 2",
        "queued": "⏳ 已排入：等 {count} 个分格空闲后，Claude 会切到 {to}，完成后会再通知。",
        "superseded": "↪ 切到 {to} 的请求已被较新的切换取代，没有执行。",
        "unavailable": "这个版本还没接上从聊天切换账号，请到 Navide 窗口操作。",
        "needs_user": "这次切换需要你到 Navide 窗口处理（{code}），没有切换。",
        "model_link": "🧠 切换模型",
        "failover_done": "🔄 额度用完，已自动接续：Claude 从 {from} 换到 {to}。",
        "failover_needs_login": "⚠️ 额度用完，Claude 已自动换到 {to}，但这个账号没有可用的登录，请到 Navide 窗口登录。",
        "switch_back": "↩ 改回 {to}",
    },
    "ko-KR": {
        "open": "🔁 계정 전환",
        "title": "🔁 Claude 계정 (현재: {current})\n눌러서 전환하면 모든 창이 다음 요청부터 사용해요",
        "title_group": "🔁 Claude 계정 (현재: {current})\n그룹 채팅에서는 전환할 수 없어요. bot에게 직접 /account를 보내 주세요",
        "fixed": "{count}개 창은 계정 전용 폴더에 고정되어 있어 전환해도 그대로예요",
        "signed_out": "로그인 안 됨",
        "no_reading": "—",
        "cancel": "✖ 취소",
        "cancelled": "계정 전환을 취소했어요.",
        "not_owner": "이 메뉴를 연 사람만 누를 수 있어요. 직접 /account를 보내 주세요.",
        "expired": "메뉴가 만료되었거나 현재 계정이 바뀌었어요. /account를 다시 보내 주세요.",
        "unsupported": "이 창의 CLI({agent})는 채팅에서 계정을 전환할 수 없어요. Navide 창에서 해 주세요.",
        "no_accounts": "Claude 계정이 하나뿐이라 전환할 곳이 없어요. Navide 창의 Add / Manage Accounts…에서 추가하세요.",
        "no_window": "Navide 창이 응답하지 않아 계정을 전환하지 않았어요.",
        "switching": "⏳ Claude를 {to}(으)로 전환하는 중…",
        "ok": "✅ Claude를 {from}에서 {to}(으)로 전환했어요.",
        "ok_signed_out": "⚠️ Claude를 {to}(으)로 전환했지만 이 계정에 사용할 수 있는 로그인이 없어 Navide 창에서 로그인을 시작했어요.",
        "needs_window": "이 전환은 Navide 창에서 확인이 필요해요({code}). 전환하지 않았어요. 창에서 해 주세요.",
        "failed": "❌ 계정을 전환하지 못했어요: {error}",
        "audited": "Navide Guard 감사 기록에 남겼어요.",
        "list_hint": "/account <번호>로 답하면 전환돼요. 예: /account 2",
        "queued": "⏳ 예약됨: {count}개 창이 유휴 상태가 되면 Claude를 {to}(으)로 전환하고, 끝나면 알려 드려요.",
        "superseded": "↪ {to}(으)로의 전환은 더 새로운 전환으로 대체되어 실행되지 않았어요.",
        "unavailable": "이 버전은 아직 채팅에서 계정을 전환할 수 없어요. Navide 창에서 해 주세요.",
        "needs_user": "이 전환은 Navide 창에서 처리해야 해요({code}). 전환하지 않았어요.",
        "model_link": "🧠 모델 전환",
        "failover_done": "🔄 할당량이 소진되어 자동으로 이어갑니다: Claude를 {from}에서 {to}(으)로 전환했습니다.",
        "failover_needs_login": "⚠️ 할당량이 소진되어 Claude가 {to}(으)로 전환됐지만 이 계정에 사용할 수 있는 로그인이 없습니다. Navide 창에서 로그인하세요.",
        "switch_back": "↩ {to}(으)로 되돌리기",
    },
    "es-ES": {
        "open": "🔁 Cambiar cuenta",
        "title": "🔁 Cuentas de Claude (ahora: {current})\nToca una para cambiar; cada panel la usa desde su siguiente petición",
        "title_group": "🔁 Cuentas de Claude (ahora: {current})\nUn grupo no puede cambiar; escribe al bot en privado y envía /account",
        "fixed": "{count} panel(es) están fijados a la carpeta propia de una cuenta y no cambian",
        "signed_out": "sin sesión",
        "no_reading": "—",
        "cancel": "✖ Cancelar",
        "cancelled": "Cambio de cuenta cancelado.",
        "not_owner": "Solo quien abrió este menú puede usarlo. Envía /account para abrir el tuyo.",
        "expired": "Este menú caducó o la cuenta activa cambió. Envía /account de nuevo.",
        "unsupported": "La CLI de este panel ({agent}) no puede cambiar de cuenta desde un chat; usa la ventana de Navide.",
        "no_accounts": "Claude solo tiene una cuenta; no hay a cuál cambiar. Añade una en Add / Manage Accounts… en la ventana de Navide.",
        "no_window": "La ventana de Navide no respondió; no se cambió de cuenta.",
        "switching": "⏳ Cambiando Claude a {to}…",
        "ok": "✅ Claude cambió de {from} a {to}.",
        "ok_signed_out": "⚠️ Claude cambió a {to}, pero esa cuenta no tiene una sesión válida; la ventana de Navide inició una.",
        "needs_window": "Este cambio necesita confirmarse en la ventana de Navide ({code}); no se cambió nada. Usa la ventana.",
        "failed": "❌ No se cambió de cuenta: {error}",
        "audited": "Registrado en la auditoría de Navide Guard.",
        "list_hint": "Responde /account <número> para cambiar, p. ej. /account 2",
        "queued": "⏳ En cola: Claude cambiará a {to} cuando {count} panel(es) queden inactivos; te avisaremos al terminar.",
        "superseded": "↪ El cambio a {to} fue reemplazado por uno más reciente y no se hizo.",
        "unavailable": "Esta versión aún no puede cambiar de cuenta desde un chat; usa la ventana de Navide.",
        "needs_user": "Este cambio necesita que vayas a la ventana de Navide ({code}); no se cambió nada.",
        "model_link": "🧠 Cambiar modelo",
        "failover_done": "🔄 Se agotó la cuota y Navide siguió con otra cuenta: Claude cambió de {from} a {to}.",
        "failover_needs_login": "⚠️ Se agotó la cuota y Claude cambió a {to}, pero esa cuenta no tiene un inicio de sesión válido; inicia sesión en la ventana de Navide.",
        "switch_back": "↩ Volver a {to}",
    },
    "fr-FR": {
        "open": "🔁 Changer de compte",
        "title": "🔁 Comptes Claude (actuel : {current})\nTouchez-en un pour changer ; chaque panneau l’utilise dès sa prochaine requête",
        "title_group": "🔁 Comptes Claude (actuel : {current})\nUn groupe ne peut pas changer ; écrivez au bot en privé et envoyez /account",
        "fixed": "{count} panneau(x) fixé(s) au dossier propre d’un compte ne suivent pas le changement",
        "signed_out": "déconnecté",
        "no_reading": "—",
        "cancel": "✖ Annuler",
        "cancelled": "Changement de compte annulé.",
        "not_owner": "Seule la personne qui a ouvert ce menu peut s’en servir. Envoyez /account pour ouvrir le vôtre.",
        "expired": "Ce menu a expiré ou le compte actif a changé. Renvoyez /account.",
        "unsupported": "La CLI de ce panneau ({agent}) ne peut pas changer de compte depuis un chat ; utilisez la fenêtre Navide.",
        "no_accounts": "Claude n’a qu’un compte, rien vers quoi changer. Ajoutez-en un via Add / Manage Accounts… dans la fenêtre Navide.",
        "no_window": "La fenêtre Navide n’a pas répondu ; aucun compte n’a été changé.",
        "switching": "⏳ Passage de Claude à {to}…",
        "ok": "✅ Claude est passé de {from} à {to}.",
        "ok_signed_out": "⚠️ Claude est passé à {to}, mais ce compte n’a pas de connexion utilisable ; la fenêtre Navide en a lancé une.",
        "needs_window": "Ce changement doit être confirmé dans la fenêtre Navide ({code}) ; rien n’a été changé. Utilisez la fenêtre.",
        "failed": "❌ Aucun compte n’a été changé : {error}",
        "audited": "Consigné dans l’audit Navide Guard.",
        "list_hint": "Répondez /account <numéro> pour changer, par ex. /account 2",
        "queued": "⏳ En file : Claude passera à {to} quand {count} panneau(x) seront inactifs ; vous serez prévenu à la fin.",
        "superseded": "↪ Le passage à {to} a été remplacé par un changement plus récent et n’a pas eu lieu.",
        "unavailable": "Cette version ne peut pas encore changer de compte depuis un chat ; utilisez la fenêtre Navide.",
        "needs_user": "Ce changement demande votre intervention dans la fenêtre Navide ({code}) ; rien n’a été changé.",
        "model_link": "🧠 Changer de modèle",
        "failover_done": "🔄 Quota épuisé, Navide a continué sur un autre compte : Claude est passé de {from} à {to}.",
        "failover_needs_login": "⚠️ Quota épuisé et Claude est passé à {to}, mais ce compte n'a pas de connexion utilisable ; connectez-vous depuis la fenêtre Navide.",
        "switch_back": "↩ Revenir à {to}",
    },
    "de-DE": {
        "open": "🔁 Konto wechseln",
        "title": "🔁 Claude-Konten (aktuell: {current})\nTippe eines an, um zu wechseln; jeder Bereich nutzt es ab seiner nächsten Anfrage",
        "title_group": "🔁 Claude-Konten (aktuell: {current})\nIn einer Gruppe kann nicht gewechselt werden; schreib dem Bot direkt und sende /account",
        "fixed": "{count} Bereich(e) sind an den eigenen Ordner eines Kontos gebunden und wechseln nicht mit",
        "signed_out": "abgemeldet",
        "no_reading": "—",
        "cancel": "✖ Abbrechen",
        "cancelled": "Kontowechsel abgebrochen.",
        "not_owner": "Nur wer dieses Menü geöffnet hat, kann es benutzen. Sende /account für ein eigenes.",
        "expired": "Dieses Menü ist abgelaufen oder das aktive Konto hat sich geändert. Sende /account erneut.",
        "unsupported": "Die CLI dieses Bereichs ({agent}) kann das Konto nicht aus einem Chat wechseln; nutze das Navide-Fenster.",
        "no_accounts": "Claude hat nur ein Konto, es gibt nichts zu wechseln. Füge eines über Add / Manage Accounts… im Navide-Fenster hinzu.",
        "no_window": "Das Navide-Fenster hat nicht geantwortet; kein Konto wurde gewechselt.",
        "switching": "⏳ Claude wird zu {to} gewechselt…",
        "ok": "✅ Claude wurde von {from} zu {to} gewechselt.",
        "ok_signed_out": "⚠️ Claude wurde zu {to} gewechselt, aber dieses Konto hat keine nutzbare Anmeldung; das Navide-Fenster hat eine gestartet.",
        "needs_window": "Dieser Wechsel muss im Navide-Fenster bestätigt werden ({code}); nichts wurde gewechselt. Nutze das Fenster.",
        "failed": "❌ Kein Konto gewechselt: {error}",
        "audited": "Im Navide-Guard-Protokoll vermerkt.",
        "list_hint": "Antworte /account <Nummer> zum Wechseln, z. B. /account 2",
        "queued": "⏳ Eingereiht: Claude wechselt zu {to}, sobald {count} Bereich(e) untätig sind; du bekommst danach Bescheid.",
        "superseded": "↪ Der Wechsel zu {to} wurde durch einen neueren ersetzt und nicht ausgeführt.",
        "unavailable": "Diese Version kann das Konto noch nicht aus einem Chat wechseln; nutze das Navide-Fenster.",
        "needs_user": "Dieser Wechsel braucht dich im Navide-Fenster ({code}); nichts wurde gewechselt.",
        "model_link": "🧠 Modell wechseln",
        "failover_done": "🔄 Kontingent aufgebraucht, Navide macht mit einem anderen Konto weiter: Claude wechselte von {from} zu {to}.",
        "failover_needs_login": "⚠️ Kontingent aufgebraucht und Claude wechselte zu {to}, aber dieses Konto hat keine gültige Anmeldung; melde dich im Navide-Fenster an.",
        "switch_back": "↩ Zurück zu {to}",
    },
    "pt-BR": {
        "open": "🔁 Trocar conta",
        "title": "🔁 Contas do Claude (agora: {current})\nToque em uma para trocar; cada painel a usa a partir da próxima requisição",
        "title_group": "🔁 Contas do Claude (agora: {current})\nUm grupo não pode trocar; fale com o bot no privado e envie /account",
        "fixed": "{count} painel(is) estão fixos na pasta própria de uma conta e não trocam",
        "signed_out": "sem login",
        "no_reading": "—",
        "cancel": "✖ Cancelar",
        "cancelled": "Troca de conta cancelada.",
        "not_owner": "Só quem abriu este menu pode usá-lo. Envie /account para abrir o seu.",
        "expired": "Este menu expirou ou a conta ativa mudou. Envie /account de novo.",
        "unsupported": "A CLI deste painel ({agent}) não pode trocar de conta por um chat; use a janela do Navide.",
        "no_accounts": "O Claude só tem uma conta; não há para qual trocar. Adicione uma em Add / Manage Accounts… na janela do Navide.",
        "no_window": "A janela do Navide não respondeu; nenhuma conta foi trocada.",
        "switching": "⏳ Trocando o Claude para {to}…",
        "ok": "✅ O Claude trocou de {from} para {to}.",
        "ok_signed_out": "⚠️ O Claude trocou para {to}, mas essa conta não tem login utilizável; a janela do Navide iniciou um.",
        "needs_window": "Esta troca precisa de confirmação na janela do Navide ({code}); nada foi trocado. Use a janela.",
        "failed": "❌ Nenhuma conta foi trocada: {error}",
        "audited": "Registrado na auditoria do Navide Guard.",
        "list_hint": "Responda /account <número> para trocar, por exemplo /account 2",
        "queued": "⏳ Na fila: o Claude troca para {to} quando {count} painel(is) ficarem ociosos; você será avisado ao terminar.",
        "superseded": "↪ A troca para {to} foi substituída por uma mais recente e não aconteceu.",
        "unavailable": "Esta versão ainda não troca de conta por um chat; use a janela do Navide.",
        "needs_user": "Esta troca precisa de você na janela do Navide ({code}); nada foi trocado.",
        "model_link": "🧠 Trocar modelo",
        "failover_done": "🔄 A cota acabou e o Navide continuou em outra conta: o Claude trocou de {from} para {to}.",
        "failover_needs_login": "⚠️ A cota acabou e o Claude trocou para {to}, mas essa conta não tem um login válido; entre pela janela do Navide.",
        "switch_back": "↩ Voltar para {to}",
    },
    "ru-RU": {
        "open": "🔁 Сменить аккаунт",
        "title": "🔁 Аккаунты Claude (сейчас: {current})\nНажмите, чтобы переключить; каждая панель использует его со следующего запроса",
        "title_group": "🔁 Аккаунты Claude (сейчас: {current})\nВ группе переключать нельзя; напишите боту лично и отправьте /account",
        "fixed": "Панелей, закреплённых за папкой аккаунта: {count}; при переключении они не меняются",
        "signed_out": "не выполнен вход",
        "no_reading": "—",
        "cancel": "✖ Отмена",
        "cancelled": "Смена аккаунта отменена.",
        "not_owner": "Пользоваться меню может только тот, кто его открыл. Отправьте /account, чтобы открыть своё.",
        "expired": "Меню устарело или активный аккаунт сменился. Отправьте /account ещё раз.",
        "unsupported": "CLI этой панели ({agent}) не может сменить аккаунт из чата; используйте окно Navide.",
        "no_accounts": "У Claude только один аккаунт, переключаться не на что. Добавьте аккаунт через Add / Manage Accounts… в окне Navide.",
        "no_window": "Окно Navide не ответило; аккаунт не сменён.",
        "switching": "⏳ Переключаю Claude на {to}…",
        "ok": "✅ Claude переключён с {from} на {to}.",
        "ok_signed_out": "⚠️ Claude переключён на {to}, но у этого аккаунта нет рабочего входа; окно Navide начало вход.",
        "needs_window": "Это переключение нужно подтвердить в окне Navide ({code}); ничего не изменено. Используйте окно.",
        "failed": "❌ Аккаунт не сменён: {error}",
        "audited": "Записано в аудит Navide Guard.",
        "list_hint": "Ответьте /account <номер>, например /account 2",
        "queued": "⏳ В очереди: Claude переключится на {to}, когда освободятся панели ({count}); по завершении придёт уведомление.",
        "superseded": "↪ Переключение на {to} заменено более новым и не выполнено.",
        "unavailable": "Эта версия пока не умеет менять аккаунт из чата; используйте окно Navide.",
        "needs_user": "Для этого переключения нужно ваше действие в окне Navide ({code}); ничего не изменено.",
        "model_link": "🧠 Сменить модель",
        "failover_done": "🔄 Квота закончилась, Navide продолжил на другом аккаунте: Claude переключён с {from} на {to}.",
        "failover_needs_login": "⚠️ Квота закончилась, Claude переключён на {to}, но у этого аккаунта нет рабочего входа; войдите в окне Navide.",
        "switch_back": "↩ Вернуть {to}",
    },
    "vi-VN": {
        "open": "🔁 Đổi tài khoản",
        "title": "🔁 Tài khoản Claude (hiện tại: {current})\nBấm để đổi; mọi pane dùng nó từ yêu cầu kế tiếp",
        "title_group": "🔁 Tài khoản Claude (hiện tại: {current})\nNhóm không đổi được; hãy nhắn riêng cho bot và gửi /account",
        "fixed": "{count} pane được gắn vào thư mục riêng của một tài khoản và không đổi theo",
        "signed_out": "chưa đăng nhập",
        "no_reading": "—",
        "cancel": "✖ Hủy",
        "cancelled": "Đã hủy đổi tài khoản.",
        "not_owner": "Chỉ người mở menu này mới bấm được. Hãy gửi /account để mở menu của bạn.",
        "expired": "Menu đã hết hạn hoặc tài khoản đang dùng đã đổi. Hãy gửi lại /account.",
        "unsupported": "CLI của pane này ({agent}) không đổi tài khoản từ chat được; hãy dùng cửa sổ Navide.",
        "no_accounts": "Claude chỉ có một tài khoản, không có gì để đổi. Thêm tài khoản ở Add / Manage Accounts… trong cửa sổ Navide.",
        "no_window": "Cửa sổ Navide không phản hồi; chưa đổi tài khoản.",
        "switching": "⏳ Đang đổi Claude sang {to}…",
        "ok": "✅ Claude đã đổi từ {from} sang {to}.",
        "ok_signed_out": "⚠️ Claude đã đổi sang {to}, nhưng tài khoản này chưa có đăng nhập dùng được; cửa sổ Navide đã bắt đầu đăng nhập.",
        "needs_window": "Lần đổi này cần xác nhận trong cửa sổ Navide ({code}); chưa đổi gì. Hãy dùng cửa sổ.",
        "failed": "❌ Chưa đổi tài khoản: {error}",
        "audited": "Đã ghi vào nhật ký Navide Guard.",
        "list_hint": "Trả lời /account <số> để đổi, ví dụ /account 2",
        "queued": "⏳ Đã xếp hàng: Claude sẽ đổi sang {to} khi {count} pane rảnh; sẽ báo khi xong.",
        "superseded": "↪ Yêu cầu đổi sang {to} đã được thay bằng yêu cầu mới hơn và không chạy.",
        "unavailable": "Phiên bản này chưa đổi tài khoản từ chat được; hãy dùng cửa sổ Navide.",
        "needs_user": "Lần đổi này cần bạn xử lý trong cửa sổ Navide ({code}); chưa đổi gì.",
        "model_link": "🧠 Đổi mô hình",
        "failover_done": "🔄 Hết hạn mức, Navide đã tiếp tục bằng tài khoản khác: Claude đổi từ {from} sang {to}.",
        "failover_needs_login": "⚠️ Hết hạn mức và Claude đã đổi sang {to}, nhưng tài khoản này chưa có đăng nhập dùng được; hãy đăng nhập trong cửa sổ Navide.",
        "switch_back": "↩ Đổi lại {to}",
    },
}


def text(lang: str, key: str, **kw: Any) -> str:
    table = STRINGS.get(lang) or STRINGS[prompt_skills.DEFAULT_LANGUAGE]
    template = table.get(key) or STRINGS[prompt_skills.DEFAULT_LANGUAGE][key]
    return template.format(**kw) if kw else template


def mask_email(label: str) -> str:
    """An account Navide added on its own is named after its email: keep the first
    characters and the domain, enough to tell accounts apart in a chat."""
    return _EMAIL_RE.sub(lambda m: f"{m.group(1)}…@{m.group(2)}", label)


@dataclass
class AccountRow:
    """One account the menu offers, as the window read it when the menu opened."""

    id: str  # DEFAULT_ID for the built-in Default
    label: str
    remaining: float | None = None
    stale: bool = False
    signed_out: bool = False
    active: bool = False

    @classmethod
    def from_window(cls, raw: dict[str, Any]) -> AccountRow:
        rem = raw.get("remaining")
        return cls(
            id=str(raw.get("id") or DEFAULT_ID),
            label=mask_email(str(raw.get("label") or raw.get("id") or "")),
            remaining=float(rem) if isinstance(rem, (int, float)) and not isinstance(rem, bool) else None,
            stale=raw.get("stale") is True, signed_out=raw.get("signedOut") is True,
            active=raw.get("active") is True,
        )

    def shown(self, lang: str) -> str:
        if self.signed_out:
            figure = text(lang, "signed_out")
        elif self.remaining is None:
            figure = text(lang, "no_reading")
        else:
            figure = ("~" if self.stale else "") + f"{round(self.remaining)}%"
        return f"{'✓ ' if self.active else ''}{_label(self.label)} · {figure}"


def parse_callback(data: str) -> str | None:
    """The token of a menu button, or None (OPEN_CALLBACK is not a token)."""
    m = _CALLBACK_RE.match(data or "")
    return m.group(1) if m else None


def parse_command(body: str) -> int | None | bool:
    """``/account [n]`` (``body`` already stripped of an @mention): the 1-based row to
    switch to, None to open the menu, False when it is not /account."""
    parts = (body or "").strip().split()
    if not parts:
        return False
    head = parts[0].lower()
    if "@" in head:
        head = head.split("@", 1)[0]
    if head not in ("/account", "/accounts") or len(parts) > 2:
        return False
    if len(parts) == 1:
        return None
    return int(parts[1]) if parts[1].isdigit() else False


def _label(s: str) -> str:
    return s if len(s) <= LABEL_MAX else s[: LABEL_MAX - 1] + "…"


@dataclass
class Menu:
    id: str
    location_key: str
    sender_id: str
    lang: str
    agent_key: str
    active_id: str
    rows: list[AccountRow]
    created: float
    fixed_count: int = 0
    message_id: str = ""
    tokens: list[str] = field(default_factory=list)

    def current_label(self) -> str:
        return next((r.label for r in self.rows if r.id == self.active_id), self.active_id)


@dataclass
class Press:
    menu: Menu
    action: str  # switch | cancel
    value: str = ""  # the account id for "switch"


class AccountMenus:
    """The open /account menus and the tokens of their live buttons."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._menus: dict[str, Menu] = {}
        self._tokens: dict[str, tuple[str, str, str]] = {}  # token -> (menu id, action, value)

    def create(self, *, location_key: str, sender_id: str, lang: str, agent_key: str,
               active_id: str, rows: list[AccountRow], fixed_count: int = 0) -> Menu:
        self._prune()
        while len(self._menus) >= MAX_MENUS:
            self.close(next(iter(self._menus.values())))
        menu = Menu(id=secrets.token_hex(6), location_key=location_key, sender_id=sender_id, lang=lang,
                    agent_key=agent_key, active_id=active_id, rows=rows, created=self._clock(),
                    fixed_count=fixed_count)
        self._menus[menu.id] = menu
        return menu

    def press(self, token: str, location_key: str, sender_id: str) -> tuple[Press | None, str]:
        """(press, "") for a live button pressed by the menu's owner in its own chat, else
        (None, "expired" | "not_owner")."""
        self._prune()
        hit = self._tokens.get(token)
        menu = self._menus.get(hit[0]) if hit else None
        if hit is None or menu is None or menu.location_key != location_key:
            return None, "expired"
        if menu.sender_id != sender_id:
            return None, "not_owner"
        return Press(menu, hit[1], hit[2]), ""

    def freeze(self, menu: Menu) -> None:
        """Kill every button the menu shows."""
        for t in menu.tokens:
            self._tokens.pop(t, None)
        menu.tokens = []

    def close(self, menu: Menu) -> None:
        self.freeze(menu)
        self._menus.pop(menu.id, None)

    def body(self, menu: Menu, *, group: bool = False, numbered: bool = False) -> str:
        """The menu's text. A group chat gets the numbered list and no way to switch; a
        chat without buttons gets the numbered list and how to switch by typing."""
        lang = menu.lang
        lines = [text(lang, "title_group" if group else "title", current=_label(menu.current_label()))]
        if menu.fixed_count:
            lines.append(text(lang, "fixed", count=menu.fixed_count))
        if group or numbered:
            lines.extend(f"{i}. {r.shown(lang)}" for i, r in enumerate(menu.rows, 1))
        if numbered and not group:
            lines.append(text(lang, "list_hint"))
        return "\n".join(lines)

    def render(self, menu: Menu) -> tuple[str, list[list[tuple[str, str]]]]:
        """The menu's body and one button per account but the active one, on fresh tokens."""
        self.freeze(menu)
        rows = [[self._button(menu, r.shown(menu.lang), "switch", r.id)] for r in menu.rows if not r.active]
        return self.body(menu), [*rows, [self._button(menu, text(menu.lang, "cancel"), "cancel")]]

    def render_single(self, menu: Menu, target_id: str, label: str) -> list[list[tuple[str, str]]]:
        """One button switching to ``target_id`` plus cancel: for an offer such as
        "switch back" after an automatic switch."""
        self.freeze(menu)
        return [[self._button(menu, label, "switch", target_id)],
                [self._button(menu, text(menu.lang, "cancel"), "cancel")]]

    def _button(self, menu: Menu, label: str, action: str, value: str = "") -> tuple[str, str]:
        token = "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(TOKEN_LENGTH))
        self._tokens[token] = (menu.id, action, value)
        menu.tokens.append(token)
        return label[:BUTTON_MAX], f"{CALLBACK_PREFIX}{token}"

    def _prune(self) -> None:
        cutoff = self._clock() - MENU_TTL_S
        for menu in [m for m in self._menus.values() if m.created < cutoff]:
            self.close(menu)
