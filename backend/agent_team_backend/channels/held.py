"""Chat messages that reach a pane while it waits on a permission prompt: they are kept
and sent in once the prompt clears, in order, for HELD_TTL_S at most. What the chat is
told about them, in the Navide language. Nothing here answers or allows a prompt."""

from __future__ import annotations

from typing import Any

from .relay import REQUEST_TTL_S

HELD_MAX = 20  # kept per pane, the same bound as a pane's chat queue
HELD_TTL_S = REQUEST_TTL_S  # a kept message older than this is dropped, never sent late

STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "held": "📥 已收下（第 {n} 則）：pane 正在等確認，確認解除後會自動送出（{minutes} 分鐘內有效）。也可以傳 /status 立刻看狀態",
        "held_full": "⚠️ pane 正在等確認，已收下 {max} 則、沒有空位，這則沒有收下；請稍後再傳",
        "sent": "↪ 已補送（確認前傳的）：{items}",
        "expired": "⌛ 等確認超過 {minutes} 分鐘，這些已取消、沒有送出：{items}",
        "gone": "⚠️ pane 已不在線上，等確認時收下的這 {count} 則沒有送出：{items}。請重送",
        "revoked": "⚠️ 這個聊天室已不再連接這個 pane，或傳送者已不在允許清單，等確認時收下的這 {count} 則沒有送出：{items}",
        "status_awaiting": "⏸ 等確認 {minutes} 分鐘",
        "status_held": "📥 待補送 {count} 則",
        "status_last": "最後輸出：{text}",
    },
    "en-US": {
        "held": "📥 Got it (#{n}): the pane is waiting for a confirmation; this is sent in once that clears (kept for {minutes} minutes). Send /status to see the pane's state now",
        "held_full": "⚠️ The pane is waiting for a confirmation and already keeps {max} messages, so this one was not kept; please send it again later",
        "sent": "↪ Sent in now (written before the confirmation): {items}",
        "expired": "⌛ The confirmation took over {minutes} minutes; these were dropped, not sent: {items}",
        "gone": "⚠️ The pane is no longer online; these {count} message(s) kept during the confirmation were not sent: {items}. Please resend",
        "revoked": "⚠️ This chat no longer drives the pane, or the sender is no longer allowed; these {count} message(s) kept during the confirmation were not sent: {items}",
        "status_awaiting": "⏸ Waiting for a confirmation for {minutes} min",
        "status_held": "📥 {count} message(s) to send after it",
        "status_last": "Last output: {text}",
    },
    "ja-JP": {
        "held": "📥 受け取りました（{n} 件目）：pane は確認待ちです。確認が終わると自動で送ります（{minutes} 分間有効）。/status で今の状態を見られます",
        "held_full": "⚠️ pane は確認待ちで、すでに {max} 件を預かっているため、このメッセージは預かれませんでした。しばらくしてから送り直してください",
        "sent": "↪ 送りました（確認前に書かれたもの）：{items}",
        "expired": "⌛ 確認が {minutes} 分を超えたため、これらは取り消され送られませんでした：{items}",
        "gone": "⚠️ pane がオフラインになったため、確認待ちの間に預かったこの {count} 件は送られませんでした：{items}。送り直してください",
        "revoked": "⚠️ このチャットはもうこの pane につながっていないか、送信者が許可リストから外れたため、確認待ちの間に預かったこの {count} 件は送られませんでした：{items}",
        "status_awaiting": "⏸ 確認待ち {minutes} 分",
        "status_held": "📥 あとで送る {count} 件",
        "status_last": "最後の出力：{text}",
    },
    "zh-CN": {
        "held": "📥 已收下（第 {n} 条）：pane 正在等确认，确认解除后会自动发送（{minutes} 分钟内有效）。也可以发 /status 立即查看状态",
        "held_full": "⚠️ pane 正在等确认，已收下 {max} 条、没有空位，这条没有收下；请稍后再发",
        "sent": "↪ 已补发（确认前发的）：{items}",
        "expired": "⌛ 等确认超过 {minutes} 分钟，这些已取消、没有发送：{items}",
        "gone": "⚠️ pane 已不在线，等确认时收下的这 {count} 条没有发送：{items}。请重发",
        "revoked": "⚠️ 这个聊天室已不再连接这个 pane，或发送者已不在允许列表，等确认时收下的这 {count} 条没有发送：{items}",
        "status_awaiting": "⏸ 等确认 {minutes} 分钟",
        "status_held": "📥 待补发 {count} 条",
        "status_last": "最后输出：{text}",
    },
    "ko-KR": {
        "held": "📥 받았어요({n}번째): pane이 확인을 기다리는 중이라, 확인이 끝나면 자동으로 보낼게요({minutes}분 동안 유효). /status로 지금 상태를 볼 수 있어요",
        "held_full": "⚠️ pane이 확인을 기다리는 중이고 이미 {max}개를 보관하고 있어서 이 메시지는 보관하지 못했어요. 잠시 후 다시 보내 주세요",
        "sent": "↪ 지금 보냈어요(확인 전에 쓴 메시지): {items}",
        "expired": "⌛ 확인이 {minutes}분을 넘겨서 이 메시지들은 취소되고 보내지지 않았어요: {items}",
        "gone": "⚠️ pane이 더 이상 온라인이 아니라서, 확인을 기다리는 동안 보관한 {count}개는 보내지지 않았어요: {items}. 다시 보내 주세요",
        "revoked": "⚠️ 이 채팅은 더 이상 이 pane에 연결되어 있지 않거나 보낸 사람이 허용 목록에서 빠져서, 확인을 기다리는 동안 보관한 {count}개는 보내지지 않았어요: {items}",
        "status_awaiting": "⏸ 확인 대기 {minutes}분",
        "status_held": "📥 나중에 보낼 메시지 {count}개",
        "status_last": "마지막 출력: {text}",
    },
    "es-ES": {
        "held": "📥 Recibido (n.º {n}): el pane espera una confirmación; se enviará en cuanto se resuelva (se guarda {minutes} minutos). Envía /status para ver su estado ahora",
        "held_full": "⚠️ El pane espera una confirmación y ya guarda {max} mensajes, así que este no se guardó; vuelve a enviarlo más tarde",
        "sent": "↪ Enviado ahora (escrito antes de la confirmación): {items}",
        "expired": "⌛ La confirmación tardó más de {minutes} minutos; estos se descartaron sin enviarse: {items}",
        "gone": "⚠️ El pane ya no está en línea; estos {count} mensajes guardados durante la confirmación no se enviaron: {items}. Vuelve a enviarlos",
        "revoked": "⚠️ Este chat ya no controla el pane, o el remitente ya no está permitido; estos {count} mensajes guardados durante la confirmación no se enviaron: {items}",
        "status_awaiting": "⏸ Esperando confirmación desde hace {minutes} min",
        "status_held": "📥 {count} mensaje(s) por enviar después",
        "status_last": "Última salida: {text}",
    },
    "fr-FR": {
        "held": "📥 Reçu (n° {n}) : le pane attend une confirmation ; ce message sera envoyé dès qu’elle sera levée (conservé {minutes} minutes). Envoyez /status pour voir son état maintenant",
        "held_full": "⚠️ Le pane attend une confirmation et conserve déjà {max} messages, celui-ci n’a donc pas été conservé ; renvoyez-le plus tard",
        "sent": "↪ Envoyé maintenant (écrit avant la confirmation) : {items}",
        "expired": "⌛ La confirmation a duré plus de {minutes} minutes ; ces messages ont été abandonnés sans être envoyés : {items}",
        "gone": "⚠️ Le pane n’est plus en ligne ; ces {count} message(s) conservés pendant la confirmation n’ont pas été envoyés : {items}. Renvoyez-les",
        "revoked": "⚠️ Ce chat ne pilote plus le pane, ou l’expéditeur n’est plus autorisé\xa0; ces {count} message(s) conservés pendant la confirmation n’ont pas été envoyés\xa0: {items}",
        "status_awaiting": "⏸ En attente de confirmation depuis {minutes} min",
        "status_held": "📥 {count} message(s) à envoyer ensuite",
        "status_last": "Dernière sortie : {text}",
    },
    "de-DE": {
        "held": "📥 Erhalten (Nr. {n}): Das pane wartet auf eine Bestätigung; die Nachricht wird gesendet, sobald sie erledigt ist (gültig für {minutes} Minuten). Mit /status siehst du den Zustand sofort",
        "held_full": "⚠️ Das pane wartet auf eine Bestätigung und hält bereits {max} Nachrichten, daher wurde diese nicht angenommen; bitte später erneut senden",
        "sent": "↪ Jetzt gesendet (vor der Bestätigung geschrieben): {items}",
        "expired": "⌛ Die Bestätigung dauerte über {minutes} Minuten; diese Nachrichten wurden verworfen und nicht gesendet: {items}",
        "gone": "⚠️ Das pane ist nicht mehr online; diese {count} während der Bestätigung gehaltenen Nachricht(en) wurden nicht gesendet: {items}. Bitte erneut senden",
        "revoked": "⚠️ Dieser Chat steuert das pane nicht mehr, oder der Absender ist nicht mehr zugelassen; diese {count} während der Bestätigung gehaltenen Nachricht(en) wurden nicht gesendet: {items}",
        "status_awaiting": "⏸ Wartet seit {minutes} Min. auf Bestätigung",
        "status_held": "📥 {count} Nachricht(en) folgen danach",
        "status_last": "Letzte Ausgabe: {text}",
    },
    "pt-BR": {
        "held": "📥 Recebido (nº {n}): o pane está aguardando uma confirmação; a mensagem será enviada assim que ela for resolvida (válida por {minutes} minutos). Envie /status para ver o estado agora",
        "held_full": "⚠️ O pane está aguardando uma confirmação e já guarda {max} mensagens, então esta não foi guardada; envie de novo mais tarde",
        "sent": "↪ Enviado agora (escrito antes da confirmação): {items}",
        "expired": "⌛ A confirmação levou mais de {minutes} minutos; estas foram descartadas sem envio: {items}",
        "gone": "⚠️ O pane não está mais online; estas {count} mensagem(ns) guardadas durante a confirmação não foram enviadas: {items}. Envie de novo",
        "revoked": "⚠️ Este chat não controla mais o pane, ou o remetente não é mais permitido; estas {count} mensagem(ns) guardadas durante a confirmação não foram enviadas: {items}",
        "status_awaiting": "⏸ Aguardando confirmação há {minutes} min",
        "status_held": "📥 {count} mensagem(ns) para enviar depois",
        "status_last": "Última saída: {text}",
    },
    "ru-RU": {
        "held": "📥 Получено (№ {n}): pane ждёт подтверждения; сообщение будет отправлено, как только оно завершится (хранится {minutes} минут). Отправьте /status, чтобы сразу увидеть состояние",
        "held_full": "⚠️ Pane ждёт подтверждения и уже хранит {max} сообщений, поэтому это не сохранено; отправьте его позже",
        "sent": "↪ Отправлено сейчас (написано до подтверждения): {items}",
        "expired": "⌛ Подтверждение длилось больше {minutes} минут; эти сообщения отменены и не отправлены: {items}",
        "gone": "⚠️ Pane больше не в сети; эти {count} сообщ., сохранённые во время подтверждения, не отправлены: {items}. Отправьте их снова",
        "revoked": "⚠️ Этот чат больше не управляет pane, или отправитель больше не разрешён; эти {count} сообщ., сохранённые во время подтверждения, не отправлены: {items}",
        "status_awaiting": "⏸ Ждёт подтверждения {minutes} мин",
        "status_held": "📥 К отправке после него: {count}",
        "status_last": "Последний вывод: {text}",
    },
    "vi-VN": {
        "held": "📥 Đã nhận (tin thứ {n}): pane đang chờ xác nhận; tin sẽ tự động được gửi khi xác nhận xong (giữ trong {minutes} phút). Gửi /status để xem trạng thái ngay",
        "held_full": "⚠️ Pane đang chờ xác nhận và đã giữ {max} tin, nên tin này không được giữ; hãy gửi lại sau",
        "sent": "↪ Đã gửi bây giờ (viết trước khi xác nhận): {items}",
        "expired": "⌛ Việc xác nhận kéo dài hơn {minutes} phút; các tin này đã bị hủy, không được gửi: {items}",
        "gone": "⚠️ Pane không còn trực tuyến; {count} tin được giữ trong lúc chờ xác nhận chưa được gửi: {items}. Hãy gửi lại",
        "revoked": "⚠️ Cuộc trò chuyện này không còn điều khiển pane, hoặc người gửi không còn được phép; {count} tin được giữ trong lúc chờ xác nhận chưa được gửi: {items}",
        "status_awaiting": "⏸ Đang chờ xác nhận {minutes} phút",
        "status_held": "📥 {count} tin sẽ gửi sau",
        "status_last": "Đầu ra cuối: {text}",
    },
}
DEFAULT_LANGUAGE = "zh-TW"


def text(lang: str, key: str, **kw: Any) -> str:
    return STRINGS.get(lang, STRINGS[DEFAULT_LANGUAGE])[key].format(**kw)
