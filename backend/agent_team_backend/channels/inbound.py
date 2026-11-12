"""Inbound chat messages between the platform and the pane: kept in ``channel_inbound`` until
settled, held while the pane's CLI reports an expired login, and the platform updates that
never reached Navide. What the chat is told about them, in the Navide language."""

from __future__ import annotations

import dataclasses
import hashlib
from typing import Any

from .base import InboundAttachment, InboundMessage

CLI_HELD_MAX = 20  # kept per pane while its CLI cannot take a prompt
CLI_PROBE_EVERY_S = 5.0  # how often a pane with kept messages is asked whether its CLI is back
CLI_PROBE_TIMEOUT_S = 2.0  # a window that does not answer in time never holds a message
REPLAY_MAX_AGE_S = 24 * 3600.0  # an unsettled message older than this is reported, not sent

STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "login_held": "📥 已收下（第 {n} 則）：這個 pane 的 {agent} 目前回報登入過期，訊息已排隊，恢復登入後會自動送進去",
        "login_full": "⚠️ 這個 pane 的 {agent} 回報登入過期，已排隊 {max} 則、沒有空位，這則沒有收下；請在電腦上重新登入後再傳",
        "sent": "↪ 登入已恢復，已補送：{items}",
        "gone": "⚠️ pane 已不在線上，等登入恢復時排隊的這 {count} 則沒有送出：{items}。請重送",
        "revoked": "⚠️ 這個聊天室已不再連接這個 pane，或傳送者已不在允許清單，排隊的這 {count} 則沒有送出：{items}",
        "updates_missed": "⚠️ 有 {count} 則訊息沒有經過 Navide 就被取走了，可能有另一個程式在用這個 bot 的 token，或 Navide 超過 24 小時沒有連線。剛才傳的訊息如果沒有回應，請重傳",
    },
    "en-US": {
        "login_held": "📥 Got it (#{n}): this pane's {agent} reports an expired login; the message is queued and sent in once it is signed in again",
        "login_full": "⚠️ This pane's {agent} reports an expired login and already queues {max} messages, so this one was not kept; sign in again on the computer, then resend",
        "sent": "↪ Signed in again; sent in now: {items}",
        "gone": "⚠️ The pane is no longer online; these {count} message(s) queued while its login was expired were not sent: {items}. Please resend",
        "revoked": "⚠️ This chat no longer drives the pane, or the sender is no longer allowed; these {count} queued message(s) were not sent: {items}",
        "updates_missed": "⚠️ {count} message(s) were taken from this bot without reaching Navide: another program may be using this bot's token, or Navide was offline for over 24 hours. If a message you just sent got no answer, please resend it",
    },
    "ja-JP": {
        "login_held": "📥 受け取りました（{n} 件目）：この pane の {agent} はログイン期限切れと報告しています。メッセージは待機列に入れ、再ログイン後に自動で送ります",
        "login_full": "⚠️ この pane の {agent} はログイン期限切れで、すでに {max} 件が待機中のため、このメッセージは預かれませんでした。パソコンで再ログインしてから送り直してください",
        "sent": "↪ 再ログインしたので送りました：{items}",
        "gone": "⚠️ pane がオフラインになったため、ログイン復旧待ちのこの {count} 件は送られませんでした：{items}。送り直してください",
        "revoked": "⚠️ このチャットはもうこの pane につながっていないか、送信者が許可リストから外れたため、待機中のこの {count} 件は送られませんでした：{items}",
        "updates_missed": "⚠️ {count} 件のメッセージが Navide を通らずに取られました。別のプログラムがこの bot のトークンを使っているか、Navide が 24 時間以上オフラインだった可能性があります。送ったメッセージに返事がなければ、送り直してください",
    },
    "zh-CN": {
        "login_held": "📥 已收下（第 {n} 条）：这个 pane 的 {agent} 目前报告登录已过期，消息已排队，重新登录后会自动发送",
        "login_full": "⚠️ 这个 pane 的 {agent} 报告登录已过期，已排队 {max} 条、没有空位，这条没有收下；请在电脑上重新登录后再发",
        "sent": "↪ 已重新登录，已补发：{items}",
        "gone": "⚠️ pane 已不在线，等待登录恢复时排队的这 {count} 条没有发送：{items}。请重发",
        "revoked": "⚠️ 这个聊天室已不再连接这个 pane，或发送者已不在允许列表，排队的这 {count} 条没有发送：{items}",
        "updates_missed": "⚠️ 有 {count} 条消息没有经过 Navide 就被取走了，可能有另一个程序在用这个 bot 的 token，或 Navide 超过 24 小时没有连线。刚才发的消息如果没有回应，请重发",
    },
    "ko-KR": {
        "login_held": "📥 받았어요({n}번째): 이 pane의 {agent}이(가) 로그인 만료를 알리고 있어요. 메시지는 대기열에 넣었고, 다시 로그인하면 자동으로 보낼게요",
        "login_full": "⚠️ 이 pane의 {agent}이(가) 로그인 만료 상태이고 이미 {max}개가 대기 중이라 이 메시지는 받지 못했어요. 컴퓨터에서 다시 로그인한 뒤 보내 주세요",
        "sent": "↪ 다시 로그인되어 지금 보냈어요: {items}",
        "gone": "⚠️ pane이 더 이상 온라인이 아니라서, 로그인 복구를 기다리며 대기한 {count}개는 보내지지 않았어요: {items}. 다시 보내 주세요",
        "revoked": "⚠️ 이 채팅은 더 이상 이 pane에 연결되어 있지 않거나 보낸 사람이 허용 목록에서 빠져서, 대기 중인 {count}개는 보내지지 않았어요: {items}",
        "updates_missed": "⚠️ 메시지 {count}개가 Navide를 거치지 않고 가져가졌어요. 다른 프로그램이 이 bot의 토큰을 쓰고 있거나 Navide가 24시간 넘게 오프라인이었을 수 있어요. 방금 보낸 메시지에 답이 없으면 다시 보내 주세요",
    },
    "es-ES": {
        "login_held": "📥 Recibido (n.º {n}): {agent} en este pane indica que su sesión caducó; el mensaje queda en cola y se enviará al volver a iniciar sesión",
        "login_full": "⚠️ {agent} en este pane indica que su sesión caducó y ya hay {max} mensajes en cola, así que este no se guardó; vuelve a iniciar sesión en el ordenador y reenvíalo",
        "sent": "↪ Sesión iniciada de nuevo; enviado ahora: {items}",
        "gone": "⚠️ El pane ya no está en línea; estos {count} mensajes en cola mientras la sesión estaba caducada no se enviaron: {items}. Vuelve a enviarlos",
        "revoked": "⚠️ Este chat ya no controla el pane, o el remitente ya no está permitido; estos {count} mensajes en cola no se enviaron: {items}",
        "updates_missed": "⚠️ {count} mensaje(s) se tomaron de este bot sin pasar por Navide: puede que otro programa use el token de este bot, o que Navide estuviera desconectado más de 24 horas. Si un mensaje que acabas de enviar no tuvo respuesta, vuelve a enviarlo",
    },
    "fr-FR": {
        "login_held": "📥 Reçu (n° {n}) : {agent} dans ce pane signale une session expirée ; le message est mis en file et sera envoyé une fois la connexion rétablie",
        "login_full": "⚠️ {agent} dans ce pane signale une session expirée et {max} messages sont déjà en file, celui-ci n’a donc pas été conservé ; reconnectez-vous sur l’ordinateur, puis renvoyez-le",
        "sent": "↪ Connexion rétablie ; envoyé maintenant : {items}",
        "gone": "⚠️ Le pane n’est plus en ligne ; ces {count} message(s) mis en file pendant la session expirée n’ont pas été envoyés : {items}. Renvoyez-les",
        "revoked": "⚠️ Ce chat ne pilote plus le pane, ou l’expéditeur n’est plus autorisé ; ces {count} message(s) en file n’ont pas été envoyés : {items}",
        "updates_missed": "⚠️ {count} message(s) ont été pris à ce bot sans passer par Navide : un autre programme utilise peut-être le token de ce bot, ou Navide était hors ligne depuis plus de 24 heures. Si un message que vous venez d’envoyer est resté sans réponse, renvoyez-le",
    },
    "de-DE": {
        "login_held": "📥 Erhalten (Nr. {n}): {agent} in diesem pane meldet eine abgelaufene Anmeldung; die Nachricht ist eingereiht und wird nach der erneuten Anmeldung gesendet",
        "login_full": "⚠️ {agent} in diesem pane meldet eine abgelaufene Anmeldung und hat bereits {max} Nachrichten eingereiht, daher wurde diese nicht angenommen; bitte am Computer neu anmelden und dann erneut senden",
        "sent": "↪ Wieder angemeldet; jetzt gesendet: {items}",
        "gone": "⚠️ Das pane ist nicht mehr online; diese {count} während der abgelaufenen Anmeldung eingereihten Nachricht(en) wurden nicht gesendet: {items}. Bitte erneut senden",
        "revoked": "⚠️ Dieser Chat steuert das pane nicht mehr, oder der Absender ist nicht mehr zugelassen; diese {count} eingereihten Nachricht(en) wurden nicht gesendet: {items}",
        "updates_missed": "⚠️ {count} Nachricht(en) wurden diesem Bot abgenommen, ohne Navide zu erreichen: Vielleicht nutzt ein anderes Programm das Token dieses Bots, oder Navide war über 24 Stunden offline. Wenn eine gerade gesendete Nachricht unbeantwortet blieb, sende sie bitte erneut",
    },
    "pt-BR": {
        "login_held": "📥 Recebido (nº {n}): o {agent} deste pane informa que o login expirou; a mensagem está na fila e será enviada assim que o login for refeito",
        "login_full": "⚠️ O {agent} deste pane informa que o login expirou e já há {max} mensagens na fila, então esta não foi guardada; faça login de novo no computador e reenvie",
        "sent": "↪ Login refeito; enviado agora: {items}",
        "gone": "⚠️ O pane não está mais online; estas {count} mensagem(ns) na fila durante o login expirado não foram enviadas: {items}. Envie de novo",
        "revoked": "⚠️ Este chat não controla mais o pane, ou o remetente não é mais permitido; estas {count} mensagem(ns) na fila não foram enviadas: {items}",
        "updates_missed": "⚠️ {count} mensagem(ns) foram tiradas deste bot sem passar pelo Navide: outro programa pode estar usando o token deste bot, ou o Navide ficou offline por mais de 24 horas. Se uma mensagem que você acabou de enviar ficou sem resposta, envie de novo",
    },
    "ru-RU": {
        "login_held": "📥 Получено (№ {n}): {agent} в этом pane сообщает, что вход истёк; сообщение в очереди и будет отправлено после повторного входа",
        "login_full": "⚠️ {agent} в этом pane сообщает, что вход истёк, и в очереди уже {max} сообщений, поэтому это не сохранено; войдите снова на компьютере и отправьте его ещё раз",
        "sent": "↪ Вход восстановлен; отправлено сейчас: {items}",
        "gone": "⚠️ Pane больше не в сети; эти {count} сообщ. из очереди, пока вход был истёкшим, не отправлены: {items}. Отправьте их снова",
        "revoked": "⚠️ Этот чат больше не управляет pane, или отправитель больше не разрешён; эти {count} сообщ. из очереди не отправлены: {items}",
        "updates_missed": "⚠️ {count} сообщ. были забраны у этого бота, не дойдя до Navide: возможно, токен этого бота использует другая программа, или Navide был офлайн больше 24 часов. Если на только что отправленное сообщение нет ответа, отправьте его снова",
    },
    "vi-VN": {
        "login_held": "📥 Đã nhận (tin thứ {n}): {agent} trong pane này báo phiên đăng nhập đã hết hạn; tin đã vào hàng đợi và sẽ tự gửi khi đăng nhập lại",
        "login_full": "⚠️ {agent} trong pane này báo phiên đăng nhập đã hết hạn và đã có {max} tin trong hàng đợi, nên tin này không được giữ; hãy đăng nhập lại trên máy tính rồi gửi lại",
        "sent": "↪ Đã đăng nhập lại; đã gửi bây giờ: {items}",
        "gone": "⚠️ Pane không còn trực tuyến; {count} tin xếp hàng trong lúc phiên đăng nhập hết hạn chưa được gửi: {items}. Hãy gửi lại",
        "revoked": "⚠️ Cuộc trò chuyện này không còn điều khiển pane, hoặc người gửi không còn được phép; {count} tin trong hàng đợi chưa được gửi: {items}",
        "updates_missed": "⚠️ {count} tin đã bị lấy khỏi bot này mà không qua Navide: có thể một chương trình khác đang dùng token của bot, hoặc Navide đã ngoại tuyến hơn 24 giờ. Nếu tin bạn vừa gửi chưa được trả lời, hãy gửi lại",
    },
}
DEFAULT_LANGUAGE = "zh-TW"


def text(lang: str, key: str, **kw: Any) -> str:
    return STRINGS.get(lang, STRINGS[DEFAULT_LANGUAGE])[key].format(**kw)


def chat_hash(value: str) -> str:
    """A log-safe stand-in for a chat or location id: never the id itself."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]


def to_payload(msg: InboundMessage) -> dict[str, Any]:
    data = dataclasses.asdict(msg)
    data.pop("inbound_ids", None)
    return data


def from_payload(data: dict[str, Any], row_id: int) -> InboundMessage:
    fields = {f.name for f in dataclasses.fields(InboundMessage)} - {"inbound_ids", "attachments"}
    kw = {k: v for k, v in data.items() if k in fields}
    attachments = [InboundAttachment(**a) for a in data.get("attachments") or []]
    return InboundMessage(**kw, attachments=attachments, inbound_ids=(row_id,))
