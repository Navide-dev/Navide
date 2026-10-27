"""A pane that is not online: what its chat is told, in the Navide language, and the limits
on waking it back onto its own conversation from the chat (``/wake`` or the wake button)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

COOLDOWN_S = 300.0  # between two wakes of one binding
DAILY_MAX = 10  # wakes of one binding per local day
STASH_MAX = 20  # messages kept for the wake to deliver, per binding
STASH_TTL_S = 1800.0  # a kept message older than this is not delivered by a later wake
PREVIEW_CHARS = 40  # of a message the chat is told was not sent

STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "offline": "⚠️ pane 目前不在線上：它所在的 Navide 視窗沒有開著，或 pane 已關閉",
        "offline_wake": "⚠️ pane 目前不在線上。喚醒會接回原本的對話，這則訊息會在喚醒後或 pane 回到線上時自動送進去（最多暫存 {max} 則、{minutes} 分鐘內有效；Navide 重啟會清掉，沒送出的會再告訴你）",
        "not_sent_overflow": "⚠️ 暫存已滿 {max} 則，最舊的 {count} 則沒有送進去：{items}。請重送",
        "not_sent_expired": "⚠️ 這 {count} 則暫存超過 {minutes} 分鐘已失效，沒有送進去：{items}。請重送",
        "not_sent_restart": "⚠️ Navide 重啟了，暫存的這 {count} 則沒有送進去：{items}。請重送",
        "not_sent_queue_full": "⚠️ pane 的排隊已滿，暫存的這 {count} 則沒有送進去：{items}。請稍後重送",
        "open_elsewhere": "⚠️ 這段對話已經在另一個 pane 開著，沒有喚醒；請在電腦上那個 pane 繼續",
        "offline_wake_nothing_kept": "⚠️ pane 目前不在線上，沒有可以中斷的工作。喚醒會接回原本的對話",
        "no_window": "⚠️ pane 目前不在線上，而且電腦上沒有開著任何 Navide 視窗，無法喚醒。請先在電腦上打開 Navide",
        "waking": "⏳ 喚醒中…",
        "button": "▶️ 喚醒",
        "typed_hint": "可直接輸入：{commands}",
        "woke": "✅ 已喚醒，接回原本的對話",
        "woke_sent": "✅ 已喚醒，接回原本的對話；暫存的 {count} 則訊息已送進去",
        "already_online": "pane 已在線上，不需要喚醒",
        "busy": "⚠️ 另一個 pane 正在喚醒，請稍後再試",
        "cooldown": "⚠️ 剛喚醒過，請 {wait} 秒後再試",
        "daily": "⚠️ 這個聊天室今天已喚醒 {max} 次，已達上限，明天再試",
        "quota": "⚠️ {agent} 額度已用完，喚醒了也無法回應，所以沒有喚醒",
        "unresumable": "⚠️ 原本的對話接不回來（{reason}），沒有喚醒；Navide 不會改開新的對話",
        "failed": "⚠️ 喚醒失敗（{reason}），pane 仍不在線上",
        "reason_missing": "找不到這段對話的紀錄",
        "reason_no_resume": "這個 CLI 不支援接回對話",
        "reason_unavailable": "對話紀錄已不在電腦上",
        "reason_fresh": "Navide 的接續設定是重新開始，不接回舊對話",
        "reason_window": "Navide 視窗沒有回應",
        "reason_mismatch": "接回的不是原本那段對話",
        "reason_not_restored": "Navide 視窗沒有把這個 pane 帶回來",
        "reason_refused": "Navide 視窗拒絕重新開啟這個 pane",
        "reason_ask": "Navide 的接續設定為每次詢問，請到電腦上開啟",
    },
    "en-US": {
        "offline": "⚠️ The pane is not online: the Navide window it belongs to is not open, or the pane was closed",
        "offline_wake": "⚠️ The pane is not online. Waking it resumes its own conversation; this message is sent in once it is awake or back online (up to {max} messages are kept, for {minutes} minutes; a Navide restart clears them, and you are told which were not sent)",
        "not_sent_overflow": "⚠️ The keep list is full ({max}); the oldest {count} message(s) were not sent: {items}. Please resend",
        "not_sent_expired": "⚠️ These {count} kept message(s) are older than {minutes} minutes and were not sent: {items}. Please resend",
        "not_sent_restart": "⚠️ Navide restarted; these {count} kept message(s) were not sent: {items}. Please resend",
        "not_sent_queue_full": "⚠️ The pane's queue is full; these {count} kept message(s) were not sent: {items}. Please resend later",
        "open_elsewhere": "⚠️ This conversation is already open in another pane, so nothing was woken; continue in that pane on the computer",
        "offline_wake_nothing_kept": "⚠️ The pane is not online, so there is nothing to interrupt. Waking it resumes its own conversation",
        "no_window": "⚠️ The pane is not online and no Navide window is open on the computer, so it cannot be woken. Open Navide on the computer first",
        "waking": "⏳ Waking…",
        "button": "▶️ Wake",
        "typed_hint": "Type: {commands}",
        "woke": "✅ Awake, back on its own conversation",
        "woke_sent": "✅ Awake, back on its own conversation; the {count} kept message(s) were sent in",
        "already_online": "The pane is already online; there is nothing to wake",
        "busy": "⚠️ Another pane is being woken; try again shortly",
        "cooldown": "⚠️ Woken a moment ago; try again in {wait} s",
        "daily": "⚠️ This chat has woken its pane {max} times today, the daily limit; try again tomorrow",
        "quota": "⚠️ {agent} is out of quota and could not answer, so the pane was not woken",
        "unresumable": "⚠️ Its own conversation cannot be resumed ({reason}), so the pane was not woken; Navide never starts a new conversation instead",
        "failed": "⚠️ Waking failed ({reason}); the pane is still not online",
        "reason_missing": "no record of the conversation was found",
        "reason_no_resume": "this CLI cannot resume a conversation",
        "reason_unavailable": "the conversation is no longer on the computer",
        "reason_fresh": "Navide is set to start fresh instead of resuming",
        "reason_window": "the Navide window did not answer",
        "reason_mismatch": "the pane came back on a different conversation",
        "reason_not_restored": "the Navide window did not bring this pane back",
        "reason_refused": "the Navide window refused to reopen this pane",
        "reason_ask": "Navide is set to ask every time; open it on the computer",
    },
    "ja-JP": {
        "offline": "⚠️ pane は現在オフラインです：所属する Navide ウィンドウが開いていないか、pane が閉じられています",
        "offline_wake": "⚠️ pane は現在オフラインです。起動すると元の会話に戻り、このメッセージは起動後またはオンライン復帰時に自動で送られます（保留は最大 {max} 件、{minutes} 分間有効。Navide を再起動すると消え、送れなかったものはお知らせします）",
        "not_sent_overflow": "⚠️ 保留が上限の {max} 件に達したため、古い {count} 件は送られませんでした：{items}。もう一度送ってください",
        "not_sent_expired": "⚠️ 保留していた {count} 件は {minutes} 分を過ぎたため送られませんでした：{items}。もう一度送ってください",
        "not_sent_restart": "⚠️ Navide が再起動したため、保留していた {count} 件は送られませんでした：{items}。もう一度送ってください",
        "not_sent_queue_full": "⚠️ pane の待ち行列がいっぱいのため、保留していた {count} 件は送られませんでした：{items}。しばらくしてからもう一度送ってください",
        "open_elsewhere": "⚠️ この会話はすでに別の pane で開いているため、起動しませんでした。パソコンでその pane から続けてください",
        "offline_wake_nothing_kept": "⚠️ pane は現在オフラインのため、中断するものはありません。起動すると元の会話に戻ります",
        "no_window": "⚠️ pane はオフラインで、パソコンで Navide のウィンドウが一つも開いていないため起動できません。先にパソコンで Navide を開いてください",
        "waking": "⏳ 起動中…",
        "button": "▶️ 起動",
        "typed_hint": "次のように入力できます：{commands}",
        "woke": "✅ 起動しました。元の会話に戻っています",
        "woke_sent": "✅ 起動しました。元の会話に戻り、保留していた {count} 件のメッセージを送りました",
        "already_online": "pane はすでにオンラインです。起動は不要です",
        "busy": "⚠️ 別の pane を起動中です。しばらくしてからもう一度お試しください",
        "cooldown": "⚠️ 起動したばかりです。{wait} 秒後にもう一度お試しください",
        "daily": "⚠️ このチャットは今日すでに {max} 回起動しており、上限に達しました。明日もう一度お試しください",
        "quota": "⚠️ {agent} の利用枠を使い切っているため応答できず、起動しませんでした",
        "unresumable": "⚠️ 元の会話に戻れないため（{reason}）、起動しませんでした。Navide が代わりに新しい会話を始めることはありません",
        "failed": "⚠️ 起動に失敗しました（{reason}）。pane はまだオフラインです",
        "reason_missing": "この会話の記録が見つかりません",
        "reason_no_resume": "この CLI は会話の再開に対応していません",
        "reason_unavailable": "会話の記録がもうパソコンにありません",
        "reason_fresh": "Navide の設定が再開せずに新しく始める設定になっています",
        "reason_window": "Navide のウィンドウが応答しませんでした",
        "reason_mismatch": "別の会話で戻ってきました",
        "reason_not_restored": "Navide のウィンドウがこの pane を戻しませんでした",
        "reason_refused": "Navide のウィンドウがこの pane の再オープンを拒否しました",
        "reason_ask": "Navide の設定が毎回確認になっています。パソコンで開いてください",
    },
    "zh-CN": {
        "offline": "⚠️ pane 目前不在线：它所在的 Navide 窗口没有打开，或 pane 已关闭",
        "offline_wake": "⚠️ pane 目前不在线。唤醒会接回原本的对话，这条消息会在唤醒后或 pane 回到在线时自动送进去（最多暂存 {max} 条、{minutes} 分钟内有效；Navide 重启会清掉，没送出的会再告诉你）",
        "not_sent_overflow": "⚠️ 暂存已满 {max} 条，最旧的 {count} 条没有送进去：{items}。请重新发送",
        "not_sent_expired": "⚠️ 这 {count} 条暂存消息超过 {minutes} 分钟已失效，没有送进去：{items}。请重新发送",
        "not_sent_restart": "⚠️ Navide 重启了，暂存的这 {count} 条没有送进去：{items}。请重新发送",
        "not_sent_queue_full": "⚠️ pane 的队列已满，暂存的这 {count} 条没有送进去：{items}。请稍后重新发送",
        "open_elsewhere": "⚠️ 这段对话已经在另一个 pane 打开，没有唤醒；请在电脑上那个 pane 继续",
        "offline_wake_nothing_kept": "⚠️ pane 目前不在线，没有可以中断的工作。唤醒会接回原本的对话",
        "no_window": "⚠️ pane 目前不在线，而且电脑上没有打开任何 Navide 窗口，无法唤醒。请先在电脑上打开 Navide",
        "waking": "⏳ 唤醒中…",
        "button": "▶️ 唤醒",
        "typed_hint": "可直接输入：{commands}",
        "woke": "✅ 已唤醒，接回原本的对话",
        "woke_sent": "✅ 已唤醒，接回原本的对话；暂存的 {count} 条消息已送进去",
        "already_online": "pane 已在线，不需要唤醒",
        "busy": "⚠️ 另一个 pane 正在唤醒，请稍后再试",
        "cooldown": "⚠️ 刚唤醒过，请 {wait} 秒后再试",
        "daily": "⚠️ 这个聊天室今天已唤醒 {max} 次，已达上限，明天再试",
        "quota": "⚠️ {agent} 额度已用完，唤醒了也无法回应，所以没有唤醒",
        "unresumable": "⚠️ 原本的对话接不回来（{reason}），没有唤醒；Navide 不会改开新的对话",
        "failed": "⚠️ 唤醒失败（{reason}），pane 仍不在线",
        "reason_missing": "找不到这段对话的记录",
        "reason_no_resume": "这个 CLI 不支持接回对话",
        "reason_unavailable": "对话记录已不在电脑上",
        "reason_fresh": "Navide 的接续设置是重新开始，不接回旧对话",
        "reason_window": "Navide 窗口没有响应",
        "reason_mismatch": "接回的不是原本那段对话",
        "reason_not_restored": "Navide 窗口没有把这个 pane 带回来",
        "reason_refused": "Navide 窗口拒绝重新打开这个 pane",
        "reason_ask": "Navide 的接续设置为每次询问，请到电脑上打开",
    },
    "ko-KR": {
        "offline": "⚠️ pane이 온라인 상태가 아니에요. 이 pane이 속한 Navide 창이 열려 있지 않거나 pane이 닫혔어요",
        "offline_wake": "⚠️ pane이 온라인 상태가 아니에요. 깨우면 원래 대화로 돌아가며, 이 메시지는 깨어난 뒤나 pane이 다시 온라인이 되면 자동으로 들어가요(최대 {max}개까지 보관, {minutes}분 동안 유효. Navide를 다시 시작하면 지워지며, 보내지 못한 메시지는 알려 드려요)",
        "not_sent_overflow": "⚠️ 보관함이 가득 차서({max}개) 가장 오래된 {count}개는 보내지 못했어요: {items}. 다시 보내 주세요",
        "not_sent_expired": "⚠️ 보관한 메시지 {count}개가 {minutes}분이 지나 보내지 못했어요: {items}. 다시 보내 주세요",
        "not_sent_restart": "⚠️ Navide가 다시 시작되어 보관한 메시지 {count}개를 보내지 못했어요: {items}. 다시 보내 주세요",
        "not_sent_queue_full": "⚠️ pane의 대기열이 가득 차서 보관한 메시지 {count}개를 보내지 못했어요: {items}. 잠시 후 다시 보내 주세요",
        "open_elsewhere": "⚠️ 이 대화는 이미 다른 pane에서 열려 있어서 깨우지 않았어요. 컴퓨터의 그 pane에서 이어 가세요",
        "offline_wake_nothing_kept": "⚠️ pane이 온라인 상태가 아니라서 중단할 작업이 없어요. 깨우면 원래 대화로 돌아가요",
        "no_window": "⚠️ pane이 온라인 상태가 아니고 컴퓨터에 열린 Navide 창이 없어서 깨울 수 없어요. 먼저 컴퓨터에서 Navide를 여세요",
        "waking": "⏳ 깨우는 중…",
        "button": "▶️ 깨우기",
        "typed_hint": "입력: {commands}",
        "woke": "✅ 깨어나서 원래 대화로 돌아왔어요",
        "woke_sent": "✅ 깨어나서 원래 대화로 돌아왔어요. 보관한 메시지 {count}개를 보냈어요",
        "already_online": "pane이 이미 온라인이라 깨울 필요가 없어요",
        "busy": "⚠️ 다른 pane을 깨우는 중이에요. 잠시 후 다시 시도하세요",
        "cooldown": "⚠️ 방금 깨웠어요. {wait}초 후에 다시 시도하세요",
        "daily": "⚠️ 이 채팅은 오늘 이미 pane을 {max}번 깨워서 하루 한도에 도달했어요. 내일 다시 시도하세요",
        "quota": "⚠️ {agent}의 할당량을 다 써서 응답할 수 없으므로 pane을 깨우지 않았어요",
        "unresumable": "⚠️ 원래 대화를 재개할 수 없어서({reason}) pane을 깨우지 않았어요. Navide는 대신 새 대화를 시작하지 않아요",
        "failed": "⚠️ 깨우지 못했어요({reason}). pane은 여전히 온라인 상태가 아니에요",
        "reason_missing": "이 대화의 기록을 찾을 수 없어요",
        "reason_no_resume": "이 CLI는 대화 재개를 지원하지 않아요",
        "reason_unavailable": "대화 기록이 더 이상 컴퓨터에 없어요",
        "reason_fresh": "Navide가 재개하지 않고 새로 시작하도록 설정되어 있어요",
        "reason_window": "Navide 창이 응답하지 않았어요",
        "reason_mismatch": "pane이 다른 대화로 돌아왔어요",
        "reason_not_restored": "Navide 창이 이 pane을 다시 가져오지 않았어요",
        "reason_refused": "Navide 창이 이 pane을 다시 여는 것을 거부했어요",
        "reason_ask": "Navide가 매번 묻도록 설정되어 있어요. 컴퓨터에서 여세요",
    },
    "es-ES": {
        "offline": "⚠️ El pane no está en línea: la ventana de Navide a la que pertenece no está abierta, o el pane se cerró",
        "offline_wake": "⚠️ El pane no está en línea. Despertarlo retoma su propia conversación; este mensaje se enviará en cuanto esté despierto o vuelva a estar en línea (se guardan hasta {max} mensajes, durante {minutes} minutos; reiniciar Navide los borra, y se te avisa de cuáles no se enviaron)",
        "not_sent_overflow": "⚠️ La lista de espera está llena ({max}); no se enviaron los {count} mensajes más antiguos: {items}. Vuelve a enviarlos",
        "not_sent_expired": "⚠️ Estos {count} mensajes guardados tienen más de {minutes} minutos y no se enviaron: {items}. Vuelve a enviarlos",
        "not_sent_restart": "⚠️ Navide se reinició; estos {count} mensajes guardados no se enviaron: {items}. Vuelve a enviarlos",
        "not_sent_queue_full": "⚠️ La cola del pane está llena; estos {count} mensajes guardados no se enviaron: {items}. Vuelve a enviarlos más tarde",
        "open_elsewhere": "⚠️ Esta conversación ya está abierta en otro pane, así que no se despertó nada; continúa en ese pane en el ordenador",
        "offline_wake_nothing_kept": "⚠️ El pane no está en línea, así que no hay nada que interrumpir. Despertarlo retoma su propia conversación",
        "no_window": "⚠️ El pane no está en línea y no hay ninguna ventana de Navide abierta en el ordenador, así que no se puede despertar. Abre primero Navide en el ordenador",
        "waking": "⏳ Despertando…",
        "button": "▶️ Despertar",
        "typed_hint": "Escribe: {commands}",
        "woke": "✅ Despierto, de vuelta en su propia conversación",
        "woke_sent": "✅ Despierto, de vuelta en su propia conversación; se enviaron los {count} mensajes guardados",
        "already_online": "El pane ya está en línea; no hay nada que despertar",
        "busy": "⚠️ Se está despertando otro pane; inténtalo de nuevo en un momento",
        "cooldown": "⚠️ Se despertó hace un momento; inténtalo de nuevo dentro de {wait} s",
        "daily": "⚠️ Este chat ya ha despertado su pane {max} veces hoy, el límite diario; inténtalo de nuevo mañana",
        "quota": "⚠️ {agent} se ha quedado sin cuota y no podría responder, así que no se despertó el pane",
        "unresumable": "⚠️ No se puede retomar su propia conversación ({reason}), así que no se despertó el pane; Navide nunca abre una conversación nueva en su lugar",
        "failed": "⚠️ No se pudo despertar ({reason}); el pane sigue sin estar en línea",
        "reason_missing": "no se encontró ningún registro de la conversación",
        "reason_no_resume": "esta CLI no puede retomar una conversación",
        "reason_unavailable": "la conversación ya no está en el ordenador",
        "reason_fresh": "Navide está configurado para empezar de cero en lugar de retomar",
        "reason_window": "la ventana de Navide no respondió",
        "reason_mismatch": "el pane volvió con otra conversación",
        "reason_not_restored": "la ventana de Navide no recuperó este pane",
        "reason_refused": "la ventana de Navide se negó a reabrir este pane",
        "reason_ask": "Navide está configurado para preguntar cada vez; ábrelo en el ordenador",
    },
    "fr-FR": {
        "offline": "⚠️ Le pane n’est pas en ligne\u00a0: la fenêtre Navide à laquelle il appartient n’est pas ouverte, ou le pane a été fermé",
        "offline_wake": "⚠️ Le pane n’est pas en ligne. Le réveiller reprend sa propre conversation\u00a0; ce message y sera envoyé une fois qu’il sera réveillé ou de nouveau en ligne (jusqu’à {max} messages conservés, pendant {minutes} minutes\u00a0; un redémarrage de Navide les efface, et vous saurez lesquels n’ont pas été envoyés)",
        "not_sent_overflow": "⚠️ La liste d’attente est pleine ({max})\u00a0; les {count} message(s) les plus anciens n’ont pas été envoyés\u00a0: {items}. Veuillez les renvoyer",
        "not_sent_expired": "⚠️ Ces {count} message(s) conservés datent de plus de {minutes} minutes et n’ont pas été envoyés\u00a0: {items}. Veuillez les renvoyer",
        "not_sent_restart": "⚠️ Navide a redémarré\u00a0; ces {count} message(s) conservés n’ont pas été envoyés\u00a0: {items}. Veuillez les renvoyer",
        "not_sent_queue_full": "⚠️ La file d’attente du pane est pleine\u00a0; ces {count} message(s) conservés n’ont pas été envoyés\u00a0: {items}. Veuillez les renvoyer plus tard",
        "open_elsewhere": "⚠️ Cette conversation est déjà ouverte dans un autre pane, rien n’a donc été réveillé\u00a0; continuez dans ce pane sur l’ordinateur",
        "offline_wake_nothing_kept": "⚠️ Le pane n’est pas en ligne, il n’y a donc rien à interrompre. Le réveiller reprend sa propre conversation",
        "no_window": "⚠️ Le pane n’est pas en ligne et aucune fenêtre Navide n’est ouverte sur l’ordinateur, il ne peut donc pas être réveillé. Ouvrez d’abord Navide sur l’ordinateur",
        "waking": "⏳ Réveil en cours…",
        "button": "▶️ Réveiller",
        "typed_hint": "Tapez\u00a0: {commands}",
        "woke": "✅ Réveillé, de retour sur sa propre conversation",
        "woke_sent": "✅ Réveillé, de retour sur sa propre conversation\u00a0; les {count} message(s) conservés ont été envoyés",
        "already_online": "Le pane est déjà en ligne\u00a0; il n’y a rien à réveiller",
        "busy": "⚠️ Un autre pane est en cours de réveil\u00a0; réessayez dans un instant",
        "cooldown": "⚠️ Réveillé il y a un instant\u00a0; réessayez dans {wait} s",
        "daily": "⚠️ Ce chat a réveillé son pane {max} fois aujourd’hui, la limite quotidienne\u00a0; réessayez demain",
        "quota": "⚠️ Le quota de {agent} est épuisé et il ne pourrait pas répondre, le pane n’a donc pas été réveillé",
        "unresumable": "⚠️ Sa propre conversation ne peut pas être reprise ({reason}), le pane n’a donc pas été réveillé\u00a0; Navide n’ouvre jamais une nouvelle conversation à la place",
        "failed": "⚠️ Échec du réveil ({reason})\u00a0; le pane n’est toujours pas en ligne",
        "reason_missing": "aucune trace de la conversation n’a été trouvée",
        "reason_no_resume": "cette CLI ne peut pas reprendre une conversation",
        "reason_unavailable": "la conversation n’est plus sur l’ordinateur",
        "reason_fresh": "Navide est réglé pour repartir de zéro au lieu de reprendre",
        "reason_window": "la fenêtre Navide n’a pas répondu",
        "reason_mismatch": "le pane est revenu sur une autre conversation",
        "reason_not_restored": "la fenêtre Navide n’a pas rétabli ce pane",
        "reason_refused": "la fenêtre Navide a refusé de rouvrir ce pane",
        "reason_ask": "Navide est réglé pour demander à chaque fois\u00a0; ouvrez-le sur l’ordinateur",
    },
    "de-DE": {
        "offline": "⚠️ Das pane ist nicht online: Das Navide-Fenster, zu dem es gehört, ist nicht geöffnet, oder das pane wurde geschlossen",
        "offline_wake": "⚠️ Das pane ist nicht online. Beim Aufwecken wird seine eigene Unterhaltung fortgesetzt; diese Nachricht wird gesendet, sobald es wach oder wieder online ist (bis zu {max} Nachrichten werden {minutes} Minuten lang zwischengespeichert; ein Neustart von Navide löscht sie, und Sie erfahren, welche nicht gesendet wurden)",
        "not_sent_overflow": "⚠️ Der Zwischenspeicher ist voll ({max}); die ältesten {count} Nachricht(en) wurden nicht gesendet: {items}. Bitte erneut senden",
        "not_sent_expired": "⚠️ Diese {count} zwischengespeicherte(n) Nachricht(en) sind älter als {minutes} Minuten und wurden nicht gesendet: {items}. Bitte erneut senden",
        "not_sent_restart": "⚠️ Navide wurde neu gestartet; diese {count} zwischengespeicherte(n) Nachricht(en) wurden nicht gesendet: {items}. Bitte erneut senden",
        "not_sent_queue_full": "⚠️ Die Warteschlange des panes ist voll; diese {count} zwischengespeicherte(n) Nachricht(en) wurden nicht gesendet: {items}. Bitte später erneut senden",
        "open_elsewhere": "⚠️ Diese Unterhaltung ist bereits in einem anderen pane geöffnet, daher wurde nichts aufgeweckt; machen Sie in diesem pane am Computer weiter",
        "offline_wake_nothing_kept": "⚠️ Das pane ist nicht online, daher gibt es nichts zu unterbrechen. Beim Aufwecken wird seine eigene Unterhaltung fortgesetzt",
        "no_window": "⚠️ Das pane ist nicht online, und auf dem Computer ist kein Navide-Fenster geöffnet, daher kann es nicht aufgeweckt werden. Öffnen Sie zuerst Navide auf dem Computer",
        "waking": "⏳ Wird aufgeweckt…",
        "button": "▶️ Aufwecken",
        "typed_hint": "Eingeben: {commands}",
        "woke": "✅ Wach, zurück in seiner eigenen Unterhaltung",
        "woke_sent": "✅ Wach, zurück in seiner eigenen Unterhaltung; die {count} zwischengespeicherte(n) Nachricht(en) wurden gesendet",
        "already_online": "Das pane ist bereits online; es gibt nichts aufzuwecken",
        "busy": "⚠️ Ein anderes pane wird gerade aufgeweckt; versuchen Sie es gleich noch einmal",
        "cooldown": "⚠️ Gerade erst aufgeweckt; versuchen Sie es in {wait} s erneut",
        "daily": "⚠️ Dieser Chat hat sein pane heute {max}-mal aufgeweckt, das Tageslimit; versuchen Sie es morgen erneut",
        "quota": "⚠️ Das Kontingent von {agent} ist aufgebraucht und es könnte nicht antworten, daher wurde das pane nicht aufgeweckt",
        "unresumable": "⚠️ Seine eigene Unterhaltung kann nicht fortgesetzt werden ({reason}), daher wurde das pane nicht aufgeweckt; Navide startet nie stattdessen eine neue Unterhaltung",
        "failed": "⚠️ Aufwecken fehlgeschlagen ({reason}); das pane ist weiterhin nicht online",
        "reason_missing": "es wurde kein Eintrag zu der Unterhaltung gefunden",
        "reason_no_resume": "diese CLI kann keine Unterhaltung fortsetzen",
        "reason_unavailable": "die Unterhaltung ist nicht mehr auf dem Computer",
        "reason_fresh": "Navide ist so eingestellt, dass neu begonnen statt fortgesetzt wird",
        "reason_window": "das Navide-Fenster hat nicht geantwortet",
        "reason_mismatch": "das pane kam mit einer anderen Unterhaltung zurück",
        "reason_not_restored": "das Navide-Fenster hat dieses pane nicht wiederhergestellt",
        "reason_refused": "das Navide-Fenster hat es abgelehnt, dieses pane erneut zu öffnen",
        "reason_ask": "Navide ist so eingestellt, dass jedes Mal nachgefragt wird; öffnen Sie es am Computer",
    },
    "pt-BR": {
        "offline": "⚠️ O pane não está online: a janela do Navide a que ele pertence não está aberta, ou o pane foi fechado",
        "offline_wake": "⚠️ O pane não está online. Despertá-lo retoma a conversa dele; esta mensagem será enviada assim que ele despertar ou voltar a ficar online (até {max} mensagens ficam guardadas, por {minutes} minutos; reiniciar o Navide as apaga, e você é avisado de quais não foram enviadas)",
        "not_sent_overflow": "⚠️ A lista de espera está cheia ({max}); as {count} mensagens mais antigas não foram enviadas: {items}. Reenvie",
        "not_sent_expired": "⚠️ Estas {count} mensagens guardadas têm mais de {minutes} minutos e não foram enviadas: {items}. Reenvie",
        "not_sent_restart": "⚠️ O Navide foi reiniciado; estas {count} mensagens guardadas não foram enviadas: {items}. Reenvie",
        "not_sent_queue_full": "⚠️ A fila do pane está cheia; estas {count} mensagens guardadas não foram enviadas: {items}. Reenvie mais tarde",
        "open_elsewhere": "⚠️ Esta conversa já está aberta em outro pane, então nada foi despertado; continue nesse pane no computador",
        "offline_wake_nothing_kept": "⚠️ O pane não está online, então não há nada para interromper. Despertá-lo retoma a conversa dele",
        "no_window": "⚠️ O pane não está online e não há nenhuma janela do Navide aberta no computador, então não é possível despertá-lo. Abra primeiro o Navide no computador",
        "waking": "⏳ Despertando…",
        "button": "▶️ Despertar",
        "typed_hint": "Digite: {commands}",
        "woke": "✅ Desperto, de volta à conversa dele",
        "woke_sent": "✅ Desperto, de volta à conversa dele; as {count} mensagens guardadas foram enviadas",
        "already_online": "O pane já está online; não há nada para despertar",
        "busy": "⚠️ Outro pane está sendo despertado; tente de novo daqui a pouco",
        "cooldown": "⚠️ Despertado há pouco; tente de novo em {wait} s",
        "daily": "⚠️ Este chat já despertou o pane {max} vezes hoje, o limite diário; tente de novo amanhã",
        "quota": "⚠️ {agent} está sem cota e não conseguiria responder, então o pane não foi despertado",
        "unresumable": "⚠️ Não é possível retomar a conversa dele ({reason}), então o pane não foi despertado; o Navide nunca abre uma conversa nova no lugar",
        "failed": "⚠️ Falha ao despertar ({reason}); o pane continua offline",
        "reason_missing": "nenhum registro da conversa foi encontrado",
        "reason_no_resume": "esta CLI não consegue retomar uma conversa",
        "reason_unavailable": "a conversa não está mais no computador",
        "reason_fresh": "o Navide está configurado para começar do zero em vez de retomar",
        "reason_window": "a janela do Navide não respondeu",
        "reason_mismatch": "o pane voltou em outra conversa",
        "reason_not_restored": "a janela do Navide não trouxe este pane de volta",
        "reason_refused": "a janela do Navide se recusou a reabrir este pane",
        "reason_ask": "o Navide está configurado para perguntar toda vez; abra-o no computador",
    },
    "ru-RU": {
        "offline": "⚠️ Pane не в сети: окно Navide, к которому он относится, не открыто, или pane закрыт",
        "offline_wake": "⚠️ Pane не в сети. Пробуждение возобновит его собственный разговор; это сообщение будет отправлено, когда pane проснётся или снова появится в сети (хранится до {max} сообщений в течение {minutes} мин; перезапуск Navide их очищает, и вам сообщат, какие не были отправлены)",
        "not_sent_overflow": "⚠️ Список отложенных сообщений заполнен ({max}); самые старые сообщения не отправлены (количество: {count}): {items}. Отправьте их снова",
        "not_sent_expired": "⚠️ Эти отложенные сообщения старше {minutes} мин и не были отправлены (количество: {count}): {items}. Отправьте их снова",
        "not_sent_restart": "⚠️ Navide перезапустился; эти отложенные сообщения не были отправлены (количество: {count}): {items}. Отправьте их снова",
        "not_sent_queue_full": "⚠️ Очередь pane заполнена; эти отложенные сообщения не были отправлены (количество: {count}): {items}. Отправьте их позже",
        "open_elsewhere": "⚠️ Этот разговор уже открыт в другом pane, поэтому ничего не пробуждено; продолжайте в том pane на компьютере",
        "offline_wake_nothing_kept": "⚠️ Pane не в сети, поэтому прерывать нечего. Пробуждение возобновит его собственный разговор",
        "no_window": "⚠️ Pane не в сети, а на компьютере не открыто ни одного окна Navide, поэтому разбудить его нельзя. Сначала откройте Navide на компьютере",
        "waking": "⏳ Пробуждение…",
        "button": "▶️ Разбудить",
        "typed_hint": "Введите: {commands}",
        "woke": "✅ Pane проснулся и вернулся к своему разговору",
        "woke_sent": "✅ Pane проснулся и вернулся к своему разговору; отложенные сообщения отправлены (количество: {count})",
        "already_online": "Pane уже в сети, будить его не нужно",
        "busy": "⚠️ Сейчас пробуждается другой pane; попробуйте чуть позже",
        "cooldown": "⚠️ Pane только что разбудили; попробуйте снова через {wait} с",
        "daily": "⚠️ Этот чат сегодня уже будил свой pane {max} раз — это дневной лимит; попробуйте завтра",
        "quota": "⚠️ Квота {agent} исчерпана, и ответить он не смог бы, поэтому pane не разбудили",
        "unresumable": "⚠️ Его собственный разговор невозможно возобновить ({reason}), поэтому pane не разбудили; Navide никогда не начинает вместо него новый разговор",
        "failed": "⚠️ Не удалось разбудить pane ({reason}); он по-прежнему не в сети",
        "reason_missing": "запись разговора не найдена",
        "reason_no_resume": "эта CLI не умеет возобновлять разговор",
        "reason_unavailable": "разговора больше нет на компьютере",
        "reason_fresh": "в Navide задано начинать заново, а не возобновлять",
        "reason_window": "окно Navide не ответило",
        "reason_mismatch": "pane вернулся с другим разговором",
        "reason_not_restored": "окно Navide не вернуло этот pane",
        "reason_refused": "окно Navide отказалось снова открыть этот pane",
        "reason_ask": "в Navide задано спрашивать каждый раз; откройте его на компьютере",
    },
    "vi-VN": {
        "offline": "⚠️ Pane hiện không trực tuyến: cửa sổ Navide chứa nó chưa mở, hoặc pane đã bị đóng",
        "offline_wake": "⚠️ Pane hiện không trực tuyến. Đánh thức sẽ tiếp tục cuộc hội thoại vốn có của nó; tin nhắn này sẽ được gửi vào khi pane đã thức hoặc trực tuyến trở lại (giữ tối đa {max} tin nhắn, trong {minutes} phút; khởi động lại Navide sẽ xóa chúng, và bạn sẽ được báo tin nào chưa được gửi)",
        "not_sent_overflow": "⚠️ Danh sách tạm giữ đã đầy ({max}); {count} tin nhắn cũ nhất chưa được gửi: {items}. Vui lòng gửi lại",
        "not_sent_expired": "⚠️ {count} tin nhắn tạm giữ này đã quá {minutes} phút và chưa được gửi: {items}. Vui lòng gửi lại",
        "not_sent_restart": "⚠️ Navide đã khởi động lại; {count} tin nhắn tạm giữ này chưa được gửi: {items}. Vui lòng gửi lại",
        "not_sent_queue_full": "⚠️ Hàng đợi của pane đã đầy; {count} tin nhắn tạm giữ này chưa được gửi: {items}. Vui lòng gửi lại sau",
        "open_elsewhere": "⚠️ Cuộc hội thoại này đang mở trong một pane khác nên không có gì được đánh thức; hãy tiếp tục trong pane đó trên máy tính",
        "offline_wake_nothing_kept": "⚠️ Pane hiện không trực tuyến nên không có gì để ngắt. Đánh thức sẽ tiếp tục cuộc hội thoại vốn có của nó",
        "no_window": "⚠️ Pane hiện không trực tuyến và trên máy tính không có cửa sổ Navide nào đang mở, nên không thể đánh thức. Hãy mở Navide trên máy tính trước",
        "waking": "⏳ Đang đánh thức…",
        "button": "▶️ Đánh thức",
        "typed_hint": "Gõ: {commands}",
        "woke": "✅ Đã thức, quay lại cuộc hội thoại vốn có",
        "woke_sent": "✅ Đã thức, quay lại cuộc hội thoại vốn có; {count} tin nhắn tạm giữ đã được gửi vào",
        "already_online": "Pane đã trực tuyến; không cần đánh thức",
        "busy": "⚠️ Một pane khác đang được đánh thức; vui lòng thử lại sau giây lát",
        "cooldown": "⚠️ Vừa đánh thức xong; vui lòng thử lại sau {wait} giây",
        "daily": "⚠️ Hôm nay cuộc trò chuyện này đã đánh thức pane của nó {max} lần, đạt giới hạn mỗi ngày; hãy thử lại vào ngày mai",
        "quota": "⚠️ {agent} đã hết hạn mức và không thể trả lời, nên pane không được đánh thức",
        "unresumable": "⚠️ Không thể tiếp tục cuộc hội thoại vốn có của pane ({reason}), nên pane không được đánh thức; Navide không bao giờ mở cuộc hội thoại mới để thay thế",
        "failed": "⚠️ Đánh thức thất bại ({reason}); pane vẫn không trực tuyến",
        "reason_missing": "không tìm thấy bản ghi của cuộc hội thoại",
        "reason_no_resume": "CLI này không hỗ trợ tiếp tục cuộc hội thoại",
        "reason_unavailable": "cuộc hội thoại không còn trên máy tính",
        "reason_fresh": "Navide được đặt để bắt đầu mới thay vì tiếp tục",
        "reason_window": "cửa sổ Navide không phản hồi",
        "reason_mismatch": "pane quay lại với một cuộc hội thoại khác",
        "reason_not_restored": "cửa sổ Navide không đưa pane này trở lại",
        "reason_refused": "cửa sổ Navide từ chối mở lại pane này",
        "reason_ask": "Navide được đặt để hỏi mỗi lần; hãy mở nó trên máy tính",
    },
}
DEFAULT_LANGUAGE = "zh-TW"

# Why a resume cannot happen (wake seam codes) -> the reason shown; anything else is a failure.
UNRESUMABLE_REASONS = {
    "no-record": "reason_missing",
    "workspace-required": "reason_missing",
    "unknown-session-id": "reason_unavailable",
    "malformed-session-id": "reason_missing",
    "session-unavailable": "reason_unavailable",
    "resume-unavailable": "reason_unavailable",
    "no-session-support": "reason_no_resume",
    "fresh-refused": "reason_fresh",
    "session-mismatch": "reason_mismatch",
    "ask-refused": "reason_ask",
}
# A wake that failed for another known reason -> the reason shown.
FAILURE_REASONS = {"pane-not-restored": "reason_not_restored", "window-refused": "reason_refused",
                   "window-timeout": "reason_window"}


def text(lang: str, key: str, **kw: Any) -> str:
    return STRINGS.get(lang, STRINGS[DEFAULT_LANGUAGE])[key].format(**kw)


def outcome_text(lang: str, result: dict[str, Any]) -> str:
    """The chat's answer to a wake that did not bring the pane back."""
    code = str(result.get("code") or "")
    if code == "no-window":
        return text(lang, "no_window")
    if code == "session-open-elsewhere":
        return text(lang, "open_elsewhere")
    if code == "quota":
        return text(lang, "quota", agent=str(result.get("agent") or "CLI"))
    if code in UNRESUMABLE_REASONS:
        return text(lang, "unresumable", reason=text(lang, UNRESUMABLE_REASONS[code]))
    reason = text(lang, FAILURE_REASONS.get(code, "reason_window"))
    return text(lang, "failed", reason=reason)


def preview(body: str) -> str:
    """A short single-line quote of a message, for telling the chat it was not sent."""
    line = " ".join((body or "").split())
    return line if len(line) <= PREVIEW_CHARS else line[:PREVIEW_CHARS - 1] + "…"


def quoted(previews: list[str]) -> str:
    return "、".join(f"「{p}」" for p in previews)


@dataclass
class WakeLimits:
    """One wake at a time; per binding (its chat location) a cooldown and a daily cap.

    Only a wake that got as far as opening something counts: one refused up front (no
    window, out of quota, a conversation that cannot be resumed) leaves the limits alone."""

    clock: Callable[[], float] = time.monotonic
    today: Callable[[], str] = lambda: time.strftime("%Y-%m-%d")
    waking: str = ""  # the location being woken now
    _last: dict[str, float] = field(default_factory=dict)
    _count: dict[str, tuple[str, int]] = field(default_factory=dict)  # location -> (day, wakes)

    def refusal(self, key: str, lang: str) -> str:
        """Why ``key`` may not wake now, or ""."""
        if self.waking:
            return text(lang, "busy")
        day, count = self._count.get(key, ("", 0))
        if day == self.today() and count >= DAILY_MAX:
            return text(lang, "daily", max=DAILY_MAX)
        last = self._last.get(key)
        if last is not None and self.clock() - last < COOLDOWN_S:
            return text(lang, "cooldown", wait=int(COOLDOWN_S - (self.clock() - last)) + 1)
        return ""

    def begin(self, key: str) -> None:
        self.waking = key

    def end(self, key: str, *, counted: bool) -> None:
        self.waking = ""
        if not counted:
            return
        self._last[key] = self.clock()
        day, count = self._count.get(key, ("", 0))
        today = self.today()
        self._count[key] = (today, count + 1 if day == today else 1)
