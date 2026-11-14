// Reusable "What's New" announcements.
//
// When the app starts running a version that has an entry here — and the user
// hasn't seen that version's announcement yet — App.vue shows WhatsNewModal
// once. To announce a future release (a rename, a headline feature, a migration
// note, …), just add an entry: the modal machinery handles showing it a single
// time, keyed on the app version. Prepend a NEW entry — retitling the one on
// top loses the release it belonged to (v0.1.78 was lost that way), which the
// no-gaps test in whatsNew.test.ts now catches.
//
// An entry may also carry a guided tour (`tour`): steps that point at the UI
// the release added, offered as "Take the tour" wherever the announcement
// appears. How to write one: docs/en-US/release-announcements.md.
//
// Content lives here (not in the i18n JSON) so an announcement is one self
// contained edit. Each field carries zh-TW and en-US, and may carry ja-JP or
// any later UI language; pickText falls back to en-US for a later language
// and to the default locale (zh-TW) for anything else missing.

import { isBetaUiLocale } from '@navide/plugin-ui/foundation'
import type { TourStep } from './tours'

export type WhatsNewText = {
  'zh-TW': string
  'en-US': string
  'ja-JP'?: string
  'zh-CN'?: string
  'ko-KR'?: string
  'es-ES'?: string
  'fr-FR'?: string
  'de-DE'?: string
  'pt-BR'?: string
  'ru-RU'?: string
  'vi-VN'?: string
}

/**
 * A headline feature given its own panel above the bullet list.
 *
 * Reserved for a release that introduces something a person did not have
 * before — not a better version of a thing they already used. A spotlight on
 * every release is a spotlight on nothing, so this stays empty unless the
 * release is also marked `major`.
 */
export interface WhatsNewSpotlight {
  /** Product name, shown as-is in both locales (e.g. 'Navide Cloud'). */
  name: string
  /** One line saying what it is, not what changed. */
  tagline: WhatsNewText
  /** What it lets somebody do. Three or four, each a capability. */
  points: WhatsNewText[]
}

export interface WhatsNewEntry {
  /** App version this announcement belongs to, e.g. '0.1.65'. */
  version: string
  title: WhatsNewText
  /** Bullet highlights shown in order. */
  highlights: WhatsNewText[]
  /** Optional footer note, e.g. an action the user should take. */
  note?: WhatsNewText
  /**
   * Marks a release worth stopping for: the modal takes on celebratory chrome
   * and says so in words. Every release matters to whoever shipped it, so the
   * bar here is the user's, not ours — a new surface, or something that
   * changes how the app is used.
   */
  major?: boolean
  /** The one feature this release is remembered for. Requires `major`. */
  spotlight?: WhatsNewSpotlight
  /**
   * Headline features drawn as side-by-side cards above the bullet list — for
   * a release with more than one thing worth stopping for, where a single
   * spotlight would have to pick one.
   */
  features?: WhatsNewFeature[]
  /**
   * A guided tour of this release (engine: lib/tours.ts, GuidedTour.vue).
   * When present, the post-update popup, Help → What's New… and the
   * announcement centre all offer "Take the tour". Step text is i18n keys under
   * tourI18nNamespace(version), e.g. `tour.v0_2_10.*`.
   */
  tour?: TourStep[]
}

/** One headline-feature card in the What's New modal. */
export interface WhatsNewFeature {
  /** A single glyph drawn in the card's badge. */
  icon: string
  name: WhatsNewText
  /** One or two lines saying what it lets somebody do. */
  tagline: WhatsNewText
  /** Where to find it, e.g. "Settings → Channels". */
  where: WhatsNewText
}

// Chrome labels (header + dismiss button), kept here so the whole announcement
// is editable in one place without touching the i18n JSON.
export const WHATS_NEW_CHROME = {
  header: { 'zh-TW': '新版更新', 'en-US': 'What’s New', 'ja-JP': '新機能' } as WhatsNewText,
  dismiss: { 'zh-TW': '知道了', 'en-US': 'Got It', 'ja-JP': 'OK' } as WhatsNewText,
  /** Replaces `header` on a release marked `major`. */
  majorHeader: { 'zh-TW': '重大更新', 'en-US': 'Major Update', 'ja-JP': 'メジャーアップデート' } as WhatsNewText,
  /** Heading over the bullet list once a spotlight sits above it. */
  alsoIn: { 'zh-TW': '這一版還有', 'en-US': 'Also in this release', 'ja-JP': 'このリリースのその他の変更' } as WhatsNewText,
  /** Label above the spotlight panel. */
  introducing: { 'zh-TW': '隆重介紹', 'en-US': 'Introducing', 'ja-JP': '新登場' } as WhatsNewText,
  /** Heading over the bullet list once feature cards sit above it. */
  details: { 'zh-TW': '細節', 'en-US': 'The details', 'ja-JP': '詳細' } as WhatsNewText,
  /** Buttons on an entry that carries a tour. */
  takeTour: { 'zh-TW': '帶我看一遍', 'en-US': 'Take the Tour', 'ja-JP': 'ツアーを見る' } as WhatsNewText,
  retakeTour: { 'zh-TW': '再看一次導覽', 'en-US': 'Replay the Tour', 'ja-JP': 'ツアーをもう一度' } as WhatsNewText,
  notNow: { 'zh-TW': '先不用', 'en-US': 'Not Now', 'ja-JP': '今はしない' } as WhatsNewText,
  /** Footer hint beside the buttons: where "Not now" leaves the way back. */
  reopenHint: {
    'zh-TW': '之後可從選單列「輔助說明（Help）→ 新版更新…」再打開',
    'en-US': 'Reopen it any time from Help → What’s New…',
    'ja-JP': '「ヘルプ → 新機能…」からいつでも開けます',
  } as WhatsNewText,
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '0.2.43',
    title: {
      'zh-TW': 'Navide 工具連線更穩、開發者免重複登入，以及 Guard 加強',
      'en-US': 'Steadier Navide Tool Connections, One Sign-In for Developers and a Stronger Guard',
      'ja-JP': 'Navide ツールの接続が安定、開発者のサインインは一度だけ、Guard を強化',
      'zh-CN': 'Navide 工具连接更稳、开发者免重复登录，以及 Guard 加强',
      'ko-KR': '더 안정적인 Navide 도구 연결, 개발자 로그인 한 번으로, 더 강해진 Guard',
      'es-ES': 'Conexión más estable a las herramientas de Navide, un solo inicio de sesión para desarrolladores y un Guard más sólido',
      'fr-FR': 'Connexion plus stable aux outils Navide, une seule connexion pour les développeurs et un Guard renforcé',
      'de-DE': 'Stabilere Verbindung zu den Navide-Tools, eine Anmeldung für Entwickler und ein stärkerer Guard',
      'pt-BR': 'Conexão mais estável com as ferramentas do Navide, um só login para desenvolvedores e um Guard mais forte',
      'ru-RU': 'Стабильнее подключение к инструментам Navide, один вход для разработчиков и усиленный Guard',
      'vi-VN': 'Kết nối công cụ Navide ổn định hơn, nhà phát triển chỉ đăng nhập một lần và Guard mạnh hơn',
    },
    highlights: [
      {
        'zh-TW': 'Navide 工具連線：一次重開很多分格時，Navide 會分批啟動（一次最多 4 個），Claude 分格的連線等待也從 30 秒放寬到 120 秒，不再有分格一直連不上、要手動打 /mcp。如果某個分格 3 分鐘後還沒連上，標題列會出現徽章並跳出通知（已綁定的 Telegram 對話也會收到），按「重連」就會在同一段對話上重建分格；分格忙碌時不會重建。',
        'en-US': 'Navide tools: when many panes reopen at once, Navide starts them in batches (at most 4 at a time), and Claude panes get 120 seconds instead of 30 to connect, so panes no longer stay without Navide tools until you run /mcp. A pane still not connected after 3 minutes gets a title-bar badge and a notification (bound Telegram chats are told too); Reconnect rebuilds it on the same conversation. A busy pane is not rebuilt.',
        'ja-JP': 'Navide ツール：多数のペインを一度に開き直すとき、Navide は分割して起動し（同時に最大 4 つ）、Claude ペインの接続待ちも 30 秒から 120 秒に延びたため、/mcp を手で実行するまで Navide ツールがつながらないペインはなくなります。3 分たってもつながらないペインにはタイトルバーにバッジと通知が出て（連携中の Telegram チャットにも届きます）、「再接続」で同じ会話のままペインを作り直せます。作業中のペインは作り直しません。',
        'zh-CN': 'Navide 工具连接：一次重开很多分格时，Navide 会分批启动（一次最多 4 个），Claude 分格的连接等待也从 30 秒放宽到 120 秒，不再有分格一直连不上、要手动输入 /mcp。如果某个分格 3 分钟后还没连上，标题栏会出现徽章并弹出通知（已绑定的 Telegram 对话也会收到），点“重连”就会在同一段对话上重建分格；分格忙碌时不会重建。',
        'ko-KR': 'Navide 도구: 여러 패널을 한꺼번에 다시 열 때 Navide가 나눠서 시작하고(한 번에 최대 4개), Claude 패널의 연결 대기 시간도 30초에서 120초로 늘어 /mcp를 직접 실행할 때까지 Navide 도구 없이 남는 패널이 더 이상 생기지 않습니다. 3분이 지나도 연결되지 않은 패널에는 제목 표시줄 배지와 알림이 표시되며(연결된 Telegram 대화에도 알림), "다시 연결"을 누르면 같은 대화로 패널을 다시 만듭니다. 작업 중인 패널은 다시 만들지 않습니다.',
        'es-ES': 'Herramientas de Navide: al reabrir muchos paneles a la vez, Navide los inicia por tandas (como máximo 4 a la vez) y los paneles de Claude tienen 120 segundos en vez de 30 para conectarse, así que ningún panel se queda sin las herramientas de Navide hasta que ejecutas /mcp. Un panel que sigue sin conectarse a los 3 minutos muestra una insignia en la barra de título y una notificación (también se avisa a los chats de Telegram vinculados); Reconectar lo reconstruye en la misma conversación. Un panel ocupado no se reconstruye.',
        'fr-FR': 'Outils Navide : quand de nombreux panneaux se rouvrent en même temps, Navide les démarre par lots (4 au plus à la fois) et les panneaux Claude ont 120 secondes au lieu de 30 pour se connecter : plus aucun panneau ne reste sans les outils Navide jusqu’à ce que vous lanciez /mcp. Un panneau toujours pas connecté au bout de 3 minutes affiche un badge dans sa barre de titre et une notification (les discussions Telegram liées sont aussi prévenues) ; Reconnecter le reconstruit sur la même conversation. Un panneau occupé n’est pas reconstruit.',
        'de-DE': 'Navide-Tools: Öffnen sich viele Bereiche gleichzeitig, startet Navide sie in Gruppen (höchstens 4 auf einmal), und Claude-Bereiche haben 120 statt 30 Sekunden zum Verbinden. So bleibt kein Bereich mehr ohne Navide-Tools, bis Sie /mcp ausführen. Ist ein Bereich nach 3 Minuten noch nicht verbunden, zeigt er ein Abzeichen in der Titelleiste und eine Benachrichtigung (verknüpfte Telegram-Chats erfahren es auch); Neu verbinden baut ihn in derselben Unterhaltung neu auf. Ein beschäftigter Bereich wird nicht neu aufgebaut.',
        'pt-BR': 'Ferramentas do Navide: quando muitos painéis reabrem ao mesmo tempo, o Navide os inicia em lotes (no máximo 4 por vez), e os painéis do Claude têm 120 segundos em vez de 30 para conectar, então nenhum painel fica sem as ferramentas do Navide até você rodar /mcp. Um painel ainda sem conexão após 3 minutos mostra um selo na barra de título e uma notificação (os chats do Telegram vinculados também são avisados); Reconectar o reconstrói na mesma conversa. Um painel ocupado não é reconstruído.',
        'ru-RU': 'Инструменты Navide: когда много панелей открываются заново одновременно, Navide запускает их партиями (не больше 4 сразу), а панелям Claude на подключение даётся 120 секунд вместо 30, так что панели больше не остаются без инструментов Navide до ручного /mcp. Если панель не подключилась и через 3 минуты, в её заголовке появляется значок и уведомление (привязанные чаты Telegram тоже получают сообщение); «Переподключить» пересоздаёт панель в том же разговоре. Занятая панель не пересоздаётся.',
        'vi-VN': 'Công cụ Navide: khi mở lại nhiều khung cùng lúc, Navide khởi động theo từng đợt (tối đa 4 khung mỗi lần) và khung Claude có 120 giây thay vì 30 giây để kết nối, nên không còn khung nào thiếu công cụ Navide cho đến khi bạn chạy /mcp. Khung vẫn chưa kết nối sau 3 phút sẽ có huy hiệu trên thanh tiêu đề và thông báo (các cuộc trò chuyện Telegram đã liên kết cũng được báo); Kết nối lại sẽ dựng lại khung trên cùng cuộc trò chuyện. Khung đang bận sẽ không bị dựng lại.',
      },
      {
        'zh-TW': '分格之間傳訊息：訊息送到還沒打開的分格時，會明確回報「還沒送達、正在等待」；等超過 10 分鐘，持有那個分格的視窗會提醒你，並讓你決定要不要打開它。分格不會自己打開。',
        'en-US': 'Messages between panes: a message sent to a pane that has not been opened yet now says plainly that it is waiting, not delivered. After 10 minutes the window holding that pane reminds you and offers to open it; the pane never opens by itself.',
        'ja-JP': 'ペイン間のメッセージ：まだ開いていないペインに送ったメッセージは、「未配信で待機中」とはっきり返すようになりました。10 分たつと、そのペインを持つウィンドウが知らせて、開くかどうかを選べます。ペインが勝手に開くことはありません。',
        'zh-CN': '分格之间传消息：消息发到还没打开的分格时，会明确回报“还没送达、正在等待”；等超过 10 分钟，持有那个分格的窗口会提醒你，并让你决定要不要打开它。分格不会自己打开。',
        'ko-KR': '패널 간 메시지: 아직 열지 않은 패널로 보낸 메시지는 이제 "전달되지 않고 대기 중"이라고 분명히 알려 줍니다. 10분이 지나면 그 패널이 있는 창이 알려 주고 열지 묻습니다. 패널이 저절로 열리지는 않습니다.',
        'es-ES': 'Mensajes entre paneles: un mensaje enviado a un panel que aún no se ha abierto indica claramente que está esperando y no se ha entregado. A los 10 minutos, la ventana que tiene ese panel te avisa y ofrece abrirlo; el panel nunca se abre solo.',
        'fr-FR': 'Messages entre panneaux : un message envoyé à un panneau pas encore ouvert indique clairement qu’il attend et n’a pas été remis. Au bout de 10 minutes, la fenêtre qui contient ce panneau vous prévient et propose de l’ouvrir ; le panneau ne s’ouvre jamais tout seul.',
        'de-DE': 'Nachrichten zwischen Bereichen: Eine Nachricht an einen Bereich, der noch nicht geöffnet ist, sagt jetzt klar, dass sie wartet und nicht zugestellt ist. Nach 10 Minuten erinnert Sie das Fenster mit diesem Bereich und bietet an, ihn zu öffnen; der Bereich öffnet sich nie von selbst.',
        'pt-BR': 'Mensagens entre painéis: uma mensagem enviada a um painel que ainda não foi aberto agora diz claramente que está aguardando, não entregue. Após 10 minutos, a janela que contém esse painel avisa você e oferece abri-lo; o painel nunca abre sozinho.',
        'ru-RU': 'Сообщения между панелями: сообщение, отправленное в ещё не открытую панель, теперь прямо сообщает, что оно ждёт и не доставлено. Через 10 минут окно с этой панелью напомнит об этом и предложит её открыть; сама панель не открывается.',
        'vi-VN': 'Tin nhắn giữa các khung: tin nhắn gửi tới khung chưa được mở giờ báo rõ là đang chờ, chưa được giao. Sau 10 phút, cửa sổ chứa khung đó sẽ nhắc bạn và đề nghị mở nó; khung không bao giờ tự mở.',
      },
      {
        'zh-TW': 'Marketplace 開發者：已登入 Navide Cloud 時，開發者頁會直接沿用同一個帳號，不用再開瀏覽器登入一次；要取得發佈權限前，Navide 會先跳出自己的確認視窗請你同意。這項要等伺服器端更新上線才會生效，在那之前（或沒有登入 Cloud 時）仍照舊走瀏覽器登入。',
        'en-US': 'Marketplace developers: signed in to Navide Cloud, the Developer page reuses that account instead of asking you to sign in again in the browser, and Navide asks in its own confirmation dialog before it takes publishing rights. This takes effect once the server update goes live; until then, or without a Cloud sign-in, the browser sign-in is used as before.',
        'ja-JP': 'Marketplace の開発者：Navide Cloud にサインインしていれば、開発者ページは同じアカウントをそのまま使い、ブラウザーでもう一度サインインする必要はありません。公開の権限を得る前には、Navide 自身の確認ダイアログで同意を求めます。この機能はサーバー側の更新が公開されてから有効になり、それまで（または Cloud にサインインしていないとき）は従来どおりブラウザーでサインインします。',
        'zh-CN': 'Marketplace 开发者：已登录 Navide Cloud 时，开发者页面会直接沿用同一个账号，不用再打开浏览器登录一次；要取得发布权限前，Navide 会先弹出自己的确认窗口请你同意。这项要等服务器端更新上线才会生效，在那之前（或没有登录 Cloud 时）仍照旧走浏览器登录。',
        'ko-KR': 'Marketplace 개발자: Navide Cloud에 로그인되어 있으면 개발자 페이지가 같은 계정을 그대로 사용하므로 브라우저에서 다시 로그인할 필요가 없고, 게시 권한을 받기 전에는 Navide 자체 확인 창에서 동의를 묻습니다. 이 기능은 서버 업데이트가 적용된 뒤에 동작하며, 그전까지(또는 Cloud에 로그인하지 않은 경우)는 이전처럼 브라우저로 로그인합니다.',
        'es-ES': 'Desarrolladores de Marketplace: con la sesión de Navide Cloud iniciada, la página de Desarrollador usa esa misma cuenta en lugar de pedirte que inicies sesión otra vez en el navegador, y Navide te pide confirmación en su propio cuadro de diálogo antes de obtener permisos de publicación. Esto funciona cuando se publique la actualización del servidor; hasta entonces, o sin sesión en Cloud, se usa el inicio de sesión en el navegador como antes.',
        'fr-FR': 'Développeurs Marketplace : connecté à Navide Cloud, la page Développeur reprend ce compte au lieu de vous demander de vous reconnecter dans le navigateur, et Navide vous demande confirmation dans sa propre boîte de dialogue avant d’obtenir les droits de publication. Cela fonctionnera une fois la mise à jour du serveur en ligne ; d’ici là, ou sans connexion à Cloud, la connexion dans le navigateur reste utilisée.',
        'de-DE': 'Marketplace-Entwickler: Sind Sie bei Navide Cloud angemeldet, verwendet die Entwicklerseite dieses Konto, statt Sie erneut im Browser anmelden zu lassen, und Navide fragt in einem eigenen Bestätigungsdialog, bevor es Veröffentlichungsrechte erhält. Das greift, sobald das Server-Update live ist; bis dahin, oder ohne Cloud-Anmeldung, wird wie bisher die Anmeldung im Browser verwendet.',
        'pt-BR': 'Desenvolvedores do Marketplace: com login no Navide Cloud, a página de Desenvolvedor usa essa mesma conta em vez de pedir um novo login no navegador, e o Navide pede confirmação na própria caixa de diálogo antes de obter permissão de publicação. Isso passa a valer quando a atualização do servidor entrar no ar; até lá, ou sem login no Cloud, o login pelo navegador continua sendo usado.',
        'ru-RU': 'Разработчики Marketplace: если вы вошли в Navide Cloud, страница разработчика использует этот же аккаунт и не просит снова входить в браузере, а перед получением прав на публикацию Navide спрашивает подтверждение в собственном диалоге. Это заработает после выхода обновления сервера; до тех пор, а также без входа в Cloud, используется вход через браузер, как раньше.',
        'vi-VN': 'Nhà phát triển Marketplace: khi đã đăng nhập Navide Cloud, trang Nhà phát triển dùng luôn tài khoản đó thay vì bắt bạn đăng nhập lại trên trình duyệt, và Navide hỏi bạn trong hộp thoại xác nhận của chính nó trước khi nhận quyền phát hành. Tính năng này có hiệu lực khi bản cập nhật máy chủ được triển khai; trước đó, hoặc khi chưa đăng nhập Cloud, vẫn đăng nhập qua trình duyệt như cũ.',
      },
      {
        'zh-TW': 'Navide Guard：用超長、Guard 追不到內容的變數來讀檔或上傳時，會先停下來問你（新規則「動態路徑讀檔」）；Windows 與 PowerShell 路徑裡的反斜線填充（例如 \\.\\.\\）會先收合再判讀；PowerShell 用 curl.exe 或 Invoke-WebRequest 從標準輸入上傳憑證，會標成「上傳憑證」。',
        'en-US': 'Navide Guard: reading or uploading a file through a variable too long for Guard to follow now asks first (the new rule dynamic-path-read); backslash padding in Windows and PowerShell paths (such as \\.\\.\\) is folded before matching; and in PowerShell, sending credentials from standard input with curl.exe or Invoke-WebRequest is marked as a credential upload.',
        'ja-JP': 'Navide Guard：Guard が中身を追えないほど長い変数でファイルを読んだりアップロードしたりすると、先に確認を求めます（新しいルール dynamic-path-read）。Windows と PowerShell のパスに入ったバックスラッシュの水増し（\\.\\.\\ など）はまとめてから判定し、PowerShell で curl.exe や Invoke-WebRequest を使って標準入力から認証情報を送ると「認証情報の送信」として扱います。',
        'zh-CN': 'Navide Guard：用超长、Guard 追不到内容的变量来读文件或上传时，会先停下来问你（新规则“动态路径读文件”）；Windows 与 PowerShell 路径里的反斜杠填充（例如 \\.\\.\\）会先合并再判断；PowerShell 用 curl.exe 或 Invoke-WebRequest 从标准输入上传凭据，会标为“上传凭据”。',
        'ko-KR': 'Navide Guard: Guard가 내용을 따라갈 수 없을 만큼 긴 변수로 파일을 읽거나 업로드하면 먼저 묻습니다(새 규칙 dynamic-path-read). Windows와 PowerShell 경로의 백슬래시 채우기(예: \\.\\.\\)는 정리한 뒤 판정하고, PowerShell에서 curl.exe나 Invoke-WebRequest로 표준 입력의 자격 증명을 보내면 자격 증명 업로드로 표시합니다.',
        'es-ES': 'Navide Guard: leer o subir un archivo mediante una variable demasiado larga para que Guard la siga ahora pregunta primero (la nueva regla dynamic-path-read); el relleno con barras invertidas en rutas de Windows y PowerShell (como \\.\\.\\) se simplifica antes de comprobarlo; y en PowerShell, enviar credenciales desde la entrada estándar con curl.exe o Invoke-WebRequest se marca como subida de credenciales.',
        'fr-FR': 'Navide Guard : lire ou envoyer un fichier via une variable trop longue pour que Guard la suive demande désormais d’abord (nouvelle règle dynamic-path-read) ; le remplissage par barres obliques inverses dans les chemins Windows et PowerShell (comme \\.\\.\\) est replié avant l’analyse ; et dans PowerShell, envoyer des identifiants depuis l’entrée standard avec curl.exe ou Invoke-WebRequest est signalé comme un envoi d’identifiants.',
        'de-DE': 'Navide Guard: Eine Datei über eine Variable zu lesen oder hochzuladen, die zu lang ist, als dass Guard ihr folgen kann, fragt jetzt zuerst (neue Regel dynamic-path-read); Backslash-Auffüllung in Windows- und PowerShell-Pfaden (etwa \\.\\.\\) wird vor der Prüfung zusammengefasst; und in PowerShell wird das Senden von Zugangsdaten über die Standardeingabe mit curl.exe oder Invoke-WebRequest als Hochladen von Zugangsdaten markiert.',
        'pt-BR': 'Navide Guard: ler ou enviar um arquivo por meio de uma variável longa demais para o Guard acompanhar agora pergunta antes (a nova regra dynamic-path-read); o preenchimento com barras invertidas em caminhos do Windows e do PowerShell (como \\.\\.\\) é simplificado antes da verificação; e no PowerShell, enviar credenciais pela entrada padrão com curl.exe ou Invoke-WebRequest é marcado como envio de credenciais.',
        'ru-RU': 'Navide Guard: чтение или отправка файла через переменную, слишком длинную, чтобы Guard мог её отследить, теперь сначала требует подтверждения (новое правило dynamic-path-read); заполнение путей обратными косыми чертами в Windows и PowerShell (например, \\.\\.\\) сворачивается перед проверкой; а отправка учётных данных из стандартного ввода через curl.exe или Invoke-WebRequest в PowerShell отмечается как выгрузка учётных данных.',
        'vi-VN': 'Navide Guard: đọc hoặc tải tệp lên qua một biến quá dài để Guard theo dõi giờ sẽ hỏi trước (quy tắc mới dynamic-path-read); phần đệm dấu gạch chéo ngược trong đường dẫn Windows và PowerShell (như \\.\\.\\) được thu gọn trước khi kiểm tra; và trong PowerShell, gửi thông tin xác thực từ đầu vào chuẩn bằng curl.exe hoặc Invoke-WebRequest được đánh dấu là tải thông tin xác thực lên.',
      },
      {
        'zh-TW': '修正：重開工作區不再多出一個空的「Default 0/0」分頁；新增、改名或刪除帳號後馬上關掉視窗，其他視窗的帳號清單與額度徽章也會更新；工作區資料夾很深（常見於中文路徑）時，Grok 分格也接得回對話。',
        'en-US': 'Fixes: reopening a workspace no longer adds an empty "Default 0/0" tab; adding, renaming or removing an account and closing the window right away now updates other windows\' account lists and quota badges; and Grok panes in deeply nested workspace folders (common with CJK paths) resume their conversations.',
        'ja-JP': '修正：ワークスペースを開き直しても、空の「Default 0/0」タブが増えなくなりました。アカウントを追加・名前変更・削除してすぐウィンドウを閉じても、ほかのウィンドウのアカウント一覧と利用枠バッジが更新されます。ワークスペースのフォルダーが深い場合（日本語や中国語のパスでよくあります）も、Grok ペインが会話を再開できます。',
        'zh-CN': '修复：重开工作区不再多出一个空的“Default 0/0”标签页；新增、改名或删除账号后马上关掉窗口，其他窗口的账号列表与额度徽章也会更新；工作区文件夹很深（常见于中文路径）时，Grok 分格也接得回对话。',
        'ko-KR': '수정: 작업 공간을 다시 열어도 빈 "Default 0/0" 탭이 더 생기지 않습니다. 계정을 추가·이름 변경·삭제한 뒤 바로 창을 닫아도 다른 창의 계정 목록과 사용량 배지가 갱신됩니다. 작업 공간 폴더가 깊은 경우(한중일 문자 경로에서 흔함)에도 Grok 패널이 대화를 이어갑니다.',
        'es-ES': 'Correcciones: reabrir un espacio de trabajo ya no añade una pestaña vacía «Default 0/0»; añadir, renombrar o quitar una cuenta y cerrar la ventana enseguida ahora actualiza las listas de cuentas y las insignias de cuota de las demás ventanas; y los paneles de Grok en carpetas de espacio de trabajo muy anidadas (habitual con rutas en chino, japonés o coreano) reanudan sus conversaciones.',
        'fr-FR': 'Corrections : rouvrir un espace de travail n’ajoute plus d’onglet vide « Default 0/0 » ; ajouter, renommer ou supprimer un compte puis fermer aussitôt la fenêtre met désormais à jour les listes de comptes et les badges de quota des autres fenêtres ; et les panneaux Grok dans des dossiers d’espace de travail très imbriqués (fréquent avec des chemins en chinois, japonais ou coréen) reprennent leurs conversations.',
        'de-DE': 'Korrekturen: Beim erneuten Öffnen eines Arbeitsbereichs erscheint kein leerer Tab „Default 0/0“ mehr; wer ein Konto hinzufügt, umbenennt oder entfernt und das Fenster sofort schließt, sieht die Kontolisten und Kontingentabzeichen der anderen Fenster jetzt aktualisiert; und Grok-Bereiche in tief verschachtelten Arbeitsbereichsordnern (häufig bei chinesischen, japanischen oder koreanischen Pfaden) setzen ihre Unterhaltungen fort.',
        'pt-BR': 'Correções: reabrir um espaço de trabalho não adiciona mais uma aba vazia "Default 0/0"; adicionar, renomear ou remover uma conta e fechar a janela logo em seguida agora atualiza as listas de contas e os selos de cota das outras janelas; e painéis do Grok em pastas de espaço de trabalho muito aninhadas (comum com caminhos em chinês, japonês ou coreano) retomam suas conversas.',
        'ru-RU': 'Исправления: при повторном открытии рабочей области больше не появляется пустая вкладка «Default 0/0»; если добавить, переименовать или удалить аккаунт и сразу закрыть окно, списки аккаунтов и значки лимитов в других окнах теперь обновляются; панели Grok в глубоко вложенных папках рабочей области (часто с путями на китайском, японском или корейском) снова продолжают разговоры.',
        'vi-VN': 'Sửa lỗi: mở lại một không gian làm việc không còn thêm thẻ trống "Default 0/0"; thêm, đổi tên hoặc xóa tài khoản rồi đóng cửa sổ ngay giờ vẫn cập nhật danh sách tài khoản và huy hiệu hạn mức ở các cửa sổ khác; và khung Grok trong thư mục không gian làm việc lồng sâu (thường gặp với đường dẫn tiếng Trung, Nhật, Hàn) tiếp tục được cuộc trò chuyện.',
      },
      {
        'zh-TW': '安全性：後端的 opentelemetry-api 升到 1.45.2，修正 CVE-2026-126360（特製的 traceparent 值會讓解析耗用大量 CPU）。Navide 不會走到這段程式，這次是預防性更新；另外有 9 個套件小版本更新。',
        'en-US': 'Security: the backend\'s opentelemetry-api is now 1.45.2, which fixes CVE-2026-126360 (a crafted traceparent value could make parsing use a lot of CPU). Navide does not reach that code, so this is a precautionary update. Nine other packages got patch updates.',
        'ja-JP': 'セキュリティ：バックエンドの opentelemetry-api を 1.45.2 に更新し、CVE-2026-126360（細工した traceparent 値で解析が CPU を大量に消費する問題）を修正しました。Navide はこのコードを通らないため予防的な更新です。ほかに 9 つのパッケージを小さく更新しました。',
        'zh-CN': '安全：后端的 opentelemetry-api 升到 1.45.2，修复 CVE-2026-126360（特制的 traceparent 值会让解析占用大量 CPU）。Navide 不会走到这段代码，这次是预防性更新；另外有 9 个软件包小版本更新。',
        'ko-KR': '보안: 백엔드의 opentelemetry-api를 1.45.2로 올려 CVE-2026-126360(조작된 traceparent 값이 파싱에 CPU를 과도하게 쓰게 하는 문제)을 수정했습니다. Navide는 이 코드를 거치지 않으므로 예방 차원의 업데이트입니다. 다른 패키지 9개도 패치 업데이트되었습니다.',
        'es-ES': 'Seguridad: el opentelemetry-api del backend pasa a la 1.45.2, que corrige CVE-2026-126360 (un valor traceparent manipulado podía hacer que el análisis consumiera mucha CPU). Navide no llega a ese código, así que es una actualización preventiva. Otros nueve paquetes recibieron actualizaciones menores.',
        'fr-FR': 'Sécurité : l’opentelemetry-api du backend passe en 1.45.2, qui corrige CVE-2026-126360 (une valeur traceparent forgée pouvait faire consommer beaucoup de CPU à l’analyse). Navide n’atteint pas ce code : c’est une mise à jour préventive. Neuf autres paquets ont reçu des mises à jour correctives.',
        'de-DE': 'Sicherheit: opentelemetry-api im Backend ist jetzt 1.45.2 und behebt CVE-2026-126360 (ein präparierter traceparent-Wert konnte beim Parsen viel CPU verbrauchen). Navide erreicht diesen Code nicht, es ist also ein vorsorgliches Update. Neun weitere Pakete erhielten Patch-Updates.',
        'pt-BR': 'Segurança: o opentelemetry-api do backend agora é 1.45.2, que corrige a CVE-2026-126360 (um valor traceparent forjado podia fazer a análise consumir muita CPU). O Navide não chega a esse código, então é uma atualização preventiva. Outros nove pacotes receberam atualizações de correção.',
        'ru-RU': 'Безопасность: opentelemetry-api в бэкенде обновлён до 1.45.2, где исправлена CVE-2026-126360 (специально составленное значение traceparent могло заставить разбор тратить много CPU). Navide не доходит до этого кода, поэтому обновление профилактическое. Ещё девять пакетов получили патч-обновления.',
        'vi-VN': 'Bảo mật: opentelemetry-api của backend được nâng lên 1.45.2, sửa CVE-2026-126360 (một giá trị traceparent được tạo đặc biệt có thể khiến việc phân tích tốn nhiều CPU). Navide không đi tới đoạn mã này nên đây là bản cập nhật phòng ngừa. Chín gói khác cũng được cập nhật bản vá.',
      },
    ],
  },
  {
    version: '0.2.42',
    title: {
      'zh-TW': '在 Telegram 切換模型、看得懂的額度條，以及重新打開關閉的視窗',
      'en-US': 'Switch Models from Telegram, Clearer Quota Bars and Reopen Closed Windows',
      'ja-JP': 'Telegram からモデル切り替え、わかりやすい利用枠バー、閉じたウィンドウの再表示',
      'zh-CN': '在 Telegram 切换模型、看得懂的额度条，以及重新打开关闭的窗口',
      'ko-KR': 'Telegram에서 모델 전환, 알아보기 쉬운 사용량 막대, 닫은 창 다시 열기',
      'es-ES': 'Cambia de modelo desde Telegram, barras de cuota más claras y reabre ventanas cerradas',
      'fr-FR': 'Changer de modèle depuis Telegram, des barres de quota plus claires et la réouverture des fenêtres fermées',
      'de-DE': 'Modellwechsel über Telegram, klarere Kontingentbalken und geschlossene Fenster wieder öffnen',
      'pt-BR': 'Troque de modelo pelo Telegram, barras de cota mais claras e reabra janelas fechadas',
      'ru-RU': 'Смена модели из Telegram, понятные полосы лимитов и повторное открытие закрытых окон',
      'vi-VN': 'Đổi mô hình từ Telegram, thanh hạn mức dễ hiểu hơn và mở lại cửa sổ đã đóng',
    },
    highlights: [
      {
        'zh-TW': '切換模型：在 Telegram 用 `/model` 或 `/status` 下方的按鈕切換分格的模型，先選分格、再選模型。只改這次對話；分格忙碌時，會等它閒下來再換。在較高的 Linux 視窗裡，`cli_set_model` 現在會直接切換 Claude，不再重開分格；模型選單開著的時候，訊息會先等一下，不會打進選單。',
        'en-US': 'Model switching: switch a pane’s model from Telegram with `/model` or the button under `/status`: pick the pane, then the model. Only this conversation changes, and a busy pane switches once it is idle. In a tall Linux window `cli_set_model` now switches Claude in place instead of restarting the pane, and messages wait while the model picker is open.',
        'ja-JP': 'モデル切り替え：Telegram で `/model` または `/status` の下のボタンから、ペインのモデルを切り替えられます。ペインを選び、次にモデルを選びます。変わるのはこの会話だけで、作業中のペインはアイドルになってから切り替わります。縦に長い Linux のウィンドウでも、`cli_set_model` は Claude をその場で切り替え、ペインを再起動しなくなりました。モデル選択メニューが開いている間、メッセージは待機し、メニューに入力されません。',
        'zh-CN': '切换模型：在 Telegram 用 `/model` 或 `/status` 下方的按钮切换分格的模型，先选分格、再选模型。只改这次对话；分格忙碌时，会等它空闲下来再换。在较高的 Linux 窗口里，`cli_set_model` 现在会直接切换 Claude，不再重开分格；模型菜单打开时，消息会先等一下，不会打进菜单。',
        'ko-KR': '모델 전환: Telegram에서 `/model` 또는 `/status` 아래 버튼으로 패널의 모델을 바꿀 수 있습니다. 패널을 고른 다음 모델을 고릅니다. 이번 대화만 바뀌며, 작업 중인 패널은 유휴 상태가 되면 바뀝니다. 세로로 긴 Linux 창에서도 이제 `cli_set_model`이 패널을 다시 시작하지 않고 Claude를 그 자리에서 전환하며, 모델 선택기가 열려 있는 동안 메시지는 기다렸다가 전달되어 선택기에 입력되지 않습니다.',
        'es-ES': 'Cambio de modelo: cambia el modelo de un panel desde Telegram con `/model` o con el botón bajo `/status`: elige el panel y luego el modelo. Solo cambia esta conversación, y un panel ocupado cambia cuando queda inactivo. En una ventana alta de Linux, `cli_set_model` ahora cambia Claude en el sitio en lugar de reiniciar el panel, y los mensajes esperan mientras el selector de modelos está abierto.',
        'fr-FR': 'Changement de modèle : changez le modèle d’un panneau depuis Telegram avec `/model` ou le bouton sous `/status` : choisissez le panneau, puis le modèle. Seule cette conversation change, et un panneau occupé change dès qu’il est inactif. Dans une fenêtre Linux haute, `cli_set_model` change désormais Claude sur place au lieu de redémarrer le panneau, et les messages attendent pendant que le sélecteur de modèle est ouvert.',
        'de-DE': 'Modellwechsel: Das Modell eines Bereichs lässt sich jetzt über Telegram mit `/model` oder der Schaltfläche unter `/status` wechseln: erst den Bereich wählen, dann das Modell. Nur dieses Gespräch ändert sich, und ein beschäftigter Bereich wechselt, sobald er untätig ist. In einem hohen Linux-Fenster wechselt `cli_set_model` Claude jetzt direkt, statt den Bereich neu zu starten, und Nachrichten warten, solange die Modellauswahl offen ist.',
        'pt-BR': 'Troca de modelo: troque o modelo de um painel pelo Telegram com `/model` ou o botão abaixo de `/status`: escolha o painel e depois o modelo. Só esta conversa muda, e um painel ocupado troca quando fica ocioso. Numa janela alta do Linux, `cli_set_model` agora troca o Claude no lugar, sem reiniciar o painel, e as mensagens esperam enquanto o seletor de modelo está aberto.',
        'ru-RU': 'Смена модели: модель панели можно сменить из Telegram командой `/model` или кнопкой под `/status`: сначала выберите панель, затем модель. Меняется только этот разговор, а занятая панель переключится, когда освободится. В высоком окне Linux `cli_set_model` теперь переключает Claude на месте, не перезапуская панель, а сообщения ждут, пока открыт выбор модели.',
        'vi-VN': 'Đổi mô hình: đổi mô hình của một khung từ Telegram bằng `/model` hoặc nút bên dưới `/status`: chọn khung, rồi chọn mô hình. Chỉ cuộc trò chuyện này thay đổi, và khung đang bận sẽ đổi khi rảnh. Trong cửa sổ Linux cao, `cli_set_model` giờ đổi Claude ngay tại chỗ thay vì khởi động lại khung, và tin nhắn sẽ chờ trong lúc bộ chọn mô hình đang mở.',
      },
      {
        'zh-TW': '帳號：帳號卡上每條額度條都會標出名稱、還剩多少和何時重置（當地時間並附倒數）。資料過期時，卡片會提示並把數字變灰。已登入的第二個 Claude 帳號可以設成「新分格用這個帳號的資料夾」，不必切換 live 登入；切換後若新帳號登不進去，Navide 會提示你在任一分格 `/login` 一次，「登入過期」徽章也會在恢復後自動清掉。',
        'en-US': 'Accounts: each quota bar on an account card now says which one it is, how much is left and when it resets, in your local time with a countdown. When the reading is out of date, the card says so and greys the figures. A second signed-in Claude account can Open New Panes in Its Folder instead of switching the live login; after a switch Navide tells you if the new account needs `/login` once in any pane, and the login-expired badge clears itself once the pane is signed in again.',
        'ja-JP': 'アカウント：アカウントカードの利用枠バーごとに、名前、残り、リセット時刻（現地時刻とカウントダウン）が表示されます。データが古いときはカードがそう示し、数値をグレーにします。サインイン済みの 2 つ目の Claude アカウントは、ライブのログインを切り替えずに「新しいペインをこのアカウントのフォルダーで開く」に設定できます。切り替え後に新しいアカウントでサインインできないときは、どれか 1 つのペインで `/login` を 1 回実行するよう Navide が知らせ、ログイン期限切れのバッジもサインインし直すと自動で消えます。',
        'zh-CN': '账号：账号卡上每条额度条都会标出名称、还剩多少和何时重置（当地时间并附倒计时）。数据过期时，卡片会提示并把数字变灰。已登录的第二个 Claude 账号可以设为“新分格用这个账号的文件夹”，不必切换 live 登录；切换后如果新账号登录不了，Navide 会提示你在任一分格 `/login` 一次，“登录过期”徽章也会在恢复后自动清除。',
        'ko-KR': '계정: 계정 카드의 사용량 막대마다 이름, 남은 양, 초기화 시각(현지 시간과 카운트다운)이 표시됩니다. 데이터가 오래되면 카드가 이를 알리고 숫자를 회색으로 표시합니다. 로그인된 두 번째 Claude 계정은 라이브 로그인을 바꾸지 않고 "새 창을 이 계정 폴더에서 열기"로 설정할 수 있습니다. 전환 후 새 계정으로 로그인할 수 없으면 Navide가 아무 패널에서나 `/login`을 한 번 실행하라고 알려 주며, 로그인 만료 배지는 다시 로그인되면 저절로 사라집니다.',
        'es-ES': 'Cuentas: cada barra de cuota de una tarjeta de cuenta indica cuál es, cuánto queda y cuándo se restablece, en tu hora local y con cuenta atrás. Si los datos están desactualizados, la tarjeta lo indica y atenúa las cifras. Una segunda cuenta de Claude con la sesión iniciada puede usar Abrir paneles nuevos en su carpeta en lugar de cambiar el inicio de sesión activo; tras un cambio, Navide avisa si la nueva cuenta necesita `/login` una vez en cualquier panel, y la insignia de sesión caducada se quita sola cuando el panel vuelve a tener sesión.',
        'fr-FR': 'Comptes : chaque barre de quota d’une carte de compte indique de quel quota il s’agit, ce qui reste et quand il se réinitialise, à l’heure locale avec un compte à rebours. Quand les données ne sont plus à jour, la carte le signale et grise les chiffres. Un deuxième compte Claude connecté peut utiliser Ouvrir les nouveaux panneaux dans son dossier au lieu de changer la connexion active ; après un changement, Navide signale si le nouveau compte demande un `/login` dans un panneau, et le badge de connexion expirée disparaît seul une fois le panneau reconnecté.',
        'de-DE': 'Konten: Jeder Kontingentbalken auf einer Kontokarte zeigt, welches Kontingent er ist, was noch übrig ist und wann es zurückgesetzt wird, in Ortszeit mit Countdown. Sind die Daten veraltet, weist die Karte darauf hin und graut die Zahlen aus. Ein zweites angemeldetes Claude-Konto kann Neue Bereiche in seinem Ordner öffnen, statt die aktive Anmeldung zu wechseln; nach einem Wechsel meldet Navide, wenn das neue Konto einmal `/login` in einem beliebigen Bereich braucht, und das Abzeichen für abgelaufene Anmeldung verschwindet von selbst, sobald der Bereich wieder angemeldet ist.',
        'pt-BR': 'Contas: cada barra de cota num cartão de conta mostra qual é, quanto resta e quando é renovada, no seu horário local e com contagem regressiva. Quando os dados estão desatualizados, o cartão avisa e deixa os números em cinza. Uma segunda conta do Claude com sessão iniciada pode usar Abrir novos painéis na pasta dela em vez de trocar o login ativo; depois de uma troca, o Navide avisa se a nova conta precisa de `/login` uma vez em qualquer painel, e o selo de login expirado some sozinho quando o painel volta a estar conectado.',
        'ru-RU': 'Аккаунты: у каждой полосы лимита на карточке аккаунта указано, что это за лимит, сколько осталось и когда он сбросится — по местному времени, с обратным отсчётом. Если данные устарели, карточка сообщает об этом и делает цифры серыми. Для второго аккаунта Claude, в который выполнен вход, можно выбрать «Открывать новые панели в его папке» вместо смены активного входа; после переключения Navide сообщит, если новому аккаунту нужен один `/login` в любой панели, а значок истёкшего входа исчезает сам, когда панель снова вошла в систему.',
        'vi-VN': 'Tài khoản: mỗi thanh hạn mức trên thẻ tài khoản ghi rõ đó là hạn mức nào, phần còn lại và thời điểm đặt lại, theo giờ địa phương kèm đếm ngược. Khi dữ liệu đã cũ, thẻ sẽ báo và làm mờ các con số. Tài khoản Claude thứ hai đã đăng nhập có thể dùng Mở khung mới trong thư mục của tài khoản này thay vì chuyển đăng nhập đang dùng; sau khi chuyển, Navide báo nếu tài khoản mới cần chạy `/login` một lần ở bất kỳ khung nào, và huy hiệu đăng nhập hết hạn tự tắt khi khung đã đăng nhập lại.',
      },
      {
        'zh-TW': '視窗：「視窗」→「重新打開剛關閉的視窗」（macOS 為 ⇧⌘T）可以把關掉的視窗連同裡面所有工作區一起開回來，歡迎畫面也會列出「最近關閉的視窗」。Navide 會保留最近 10 個，重新啟動後也還在。',
        'en-US': 'Windows: Window → Reopen Closed Window (⇧⌘T on macOS) brings back a closed window with all its workspaces, and the welcome screen lists Recently Closed Windows. Navide keeps the last 10, even after a relaunch.',
        'ja-JP': 'ウィンドウ：「ウィンドウ」→「閉じたウィンドウを開き直す」（macOS では ⇧⌘T）で、閉じたウィンドウを中のワークスペースごと開き直せます。ウェルカム画面にも「最近閉じたウィンドウ」が表示されます。直近 10 件を、再起動後も保持します。',
        'zh-CN': '窗口：“窗口”→“重新打开刚关闭的窗口”（macOS 为 ⇧⌘T）可以把关掉的窗口连同里面所有工作区一起打开，欢迎页面也会列出“最近关闭的窗口”。Navide 会保留最近 10 个，重新启动后也还在。',
        'ko-KR': '창: "창" → "닫은 창 다시 열기"(macOS에서는 ⇧⌘T)로 닫은 창을 그 안의 모든 작업 공간과 함께 다시 열 수 있고, 시작 화면에도 "최근에 닫은 창"이 표시됩니다. 최근 10개를 다시 실행한 뒤에도 보관합니다.',
        'es-ES': 'Ventanas: Ventana → Reabrir ventana cerrada (⇧⌘T en macOS) recupera una ventana cerrada con todos sus espacios de trabajo, y la pantalla de bienvenida muestra Ventanas cerradas recientemente. Navide guarda las 10 últimas, incluso tras reiniciar.',
        'fr-FR': 'Fenêtres : Fenêtre → Rouvrir la fenêtre fermée (⇧⌘T sous macOS) rouvre une fenêtre fermée avec tous ses espaces de travail, et l’écran d’accueil affiche Fenêtres récemment fermées. Navide garde les 10 dernières, même après un redémarrage.',
        'de-DE': 'Fenster: Fenster → Geschlossenes Fenster wieder öffnen (⇧⌘T unter macOS) holt ein geschlossenes Fenster mit allen seinen Arbeitsbereichen zurück, und der Startbildschirm listet Zuletzt geschlossene Fenster. Navide behält die letzten 10, auch nach einem Neustart.',
        'pt-BR': 'Janelas: Janela → Reabrir janela fechada (⇧⌘T no macOS) traz de volta uma janela fechada com todos os seus espaços de trabalho, e a tela de boas-vindas mostra Janelas fechadas recentemente. O Navide guarda as 10 últimas, mesmo depois de reiniciar.',
        'ru-RU': 'Окна: Окно → Открыть закрытое окно снова (⇧⌘T в macOS) возвращает закрытое окно со всеми его рабочими пространствами, а на экране приветствия есть список «Недавно закрытые окна». Navide хранит последние 10 даже после перезапуска.',
        'vi-VN': 'Cửa sổ: Cửa sổ → Mở lại cửa sổ vừa đóng (⇧⌘T trên macOS) mở lại cửa sổ đã đóng cùng mọi không gian làm việc trong đó, và màn hình chào mừng có danh sách Cửa sổ đã đóng gần đây. Navide giữ 10 cửa sổ gần nhất, kể cả sau khi khởi động lại.',
      },
      {
        'zh-TW': '模型擂台（Beta，預設關閉）：到「設定 → 一般 → 實驗功能」打開，再用「發起模型擂台」把同一個任務交給 2 到 4 個模型，各自在自己的 worktree 裡做。並排比較它們的改動，再合併其中一個，或從幾個裡挑檔案組合。每個模型會同時用掉各自的額度。',
        'en-US': 'Model Arena (Beta, off by default): turn it on in Settings → General → Experimental features, then Start Model Arena gives one task to 2 to 4 models, each in its own worktree. Compare their changes side by side, then merge one, or mix files from several. Every model uses its own quota at the same time.',
        'ja-JP': 'モデルアリーナ（Beta、既定でオフ）：「設定 → 一般 → 実験的な機能」でオンにし、「モデルアリーナを開始」で同じタスクを 2〜4 個のモデルに渡します。各モデルはそれぞれの worktree で作業します。変更を並べて比べ、1 つをマージするか、複数からファイルを選んで組み合わせます。各モデルはそれぞれの利用枠を同時に使います。',
        'zh-CN': '模型擂台（Beta，默认关闭）：到“设置 → 一般 → 实验功能”打开，再用“发起模型擂台”把同一个任务交给 2 到 4 个模型，各自在自己的 worktree 里做。并排比较它们的改动，再合并其中一个，或从几个里挑文件组合。每个模型会同时用掉各自的额度。',
        'ko-KR': '모델 아레나(Beta, 기본값 꺼짐): "설정 → 일반 → 실험 기능"에서 켜고 "모델 아레나 시작"으로 같은 작업을 2~4개 모델에 맡깁니다. 각 모델은 자기 worktree에서 작업합니다. 변경 사항을 나란히 비교한 뒤 하나를 병합하거나 여러 결과에서 파일을 골라 합칠 수 있습니다. 각 모델은 자기 사용량을 동시에 씁니다.',
        'es-ES': 'Arena de modelos (Beta, desactivada por defecto): actívala en Ajustes → General → Funciones experimentales y usa Iniciar arena de modelos para dar una misma tarea a entre 2 y 4 modelos, cada uno en su propio worktree. Compara sus cambios lado a lado y fusiona uno, o combina archivos de varios. Cada modelo usa su propia cuota a la vez.',
        'fr-FR': 'Arène de modèles (Beta, désactivée par défaut) : activez-la dans Paramètres → Général → Fonctions expérimentales, puis Lancer l’arène de modèles confie une même tâche à 2 à 4 modèles, chacun dans son propre worktree. Comparez leurs modifications côte à côte, puis fusionnez-en une ou combinez des fichiers de plusieurs. Chaque modèle consomme son propre quota en même temps.',
        'de-DE': 'Modell-Arena (Beta, standardmäßig aus): In Einstellungen → Allgemein → Experimentelle Funktionen einschalten, dann gibt Modell-Arena starten eine Aufgabe an 2 bis 4 Modelle, jedes in seinem eigenen Worktree. Die Änderungen lassen sich nebeneinander vergleichen; danach wird eines gemergt oder Dateien aus mehreren kombiniert. Jedes Modell verbraucht gleichzeitig sein eigenes Kontingent.',
        'pt-BR': 'Arena de modelos (Beta, desativada por padrão): ative em Configurações → Geral → Recursos experimentais e use Iniciar arena de modelos para dar a mesma tarefa a 2 a 4 modelos, cada um no próprio worktree. Compare as mudanças lado a lado e faça merge de uma ou combine arquivos de várias. Cada modelo usa a própria cota ao mesmo tempo.',
        'ru-RU': 'Арена моделей (Beta, по умолчанию выключена): включите её в Настройки → Общие → Экспериментальные функции, затем «Запустить арену моделей» даст одну задачу 2–4 моделям, каждой в своём worktree. Сравните изменения рядом и слейте одно из них или соберите файлы из нескольких. Каждая модель одновременно расходует свой лимит.',
        'vi-VN': 'Đấu trường mô hình (Beta, mặc định tắt): bật trong Cài đặt → Chung → Tính năng thử nghiệm, rồi dùng Bắt đầu đấu trường mô hình để giao cùng một việc cho 2 đến 4 mô hình, mỗi mô hình trong worktree riêng. So sánh thay đổi của chúng cạnh nhau, rồi merge một bản hoặc ghép tệp từ nhiều bản. Mỗi mô hình dùng hạn mức riêng cùng lúc.',
      },
      {
        'zh-TW': 'CLI：Codex 啟動時的更新選單不會再被誤按成更新；Codex 有新版時 Navide 會提示，等所有 Codex 分格都閒置時再更新。新增 Kiro CLI（AWS）分格的最小可用版，尚未用真實的 Kiro 帳號驗證。',
        'en-US': 'CLI agents: Codex’s startup update menu is no longer accepted by mistake, and Navide says when a Codex update is available and updates it once every Codex pane is idle. Kiro CLI (AWS) panes arrive in a minimum version; they have not yet been tried with a real Kiro account.',
        'ja-JP': 'CLI：Codex の起動時の更新メニューが誤って実行されなくなりました。Codex の新バージョンがあると Navide が知らせ、すべての Codex ペインがアイドルのときに更新します。Kiro CLI（AWS）ペインを最小構成で追加しました。実際の Kiro アカウントでの確認はまだです。',
        'zh-CN': 'CLI：Codex 启动时的更新菜单不会再被误按成更新；Codex 有新版本时 Navide 会提示，等所有 Codex 分格都空闲时再更新。新增 Kiro CLI（AWS）分格的最小可用版，尚未用真实的 Kiro 账号验证。',
        'ko-KR': 'CLI: Codex 시작 시 뜨는 업데이트 메뉴가 더 이상 실수로 실행되지 않습니다. Codex 새 버전이 있으면 Navide가 알려 주고, 모든 Codex 패널이 유휴 상태일 때 업데이트합니다. Kiro CLI(AWS) 패널을 최소 기능으로 추가했으며, 실제 Kiro 계정으로는 아직 확인하지 않았습니다.',
        'es-ES': 'CLI: el menú de actualización que Codex muestra al iniciarse ya no se acepta por error, y Navide avisa cuando hay una actualización de Codex y la instala cuando todos los paneles de Codex están inactivos. Llegan los paneles de Kiro CLI (AWS) en una versión mínima; aún no se han probado con una cuenta real de Kiro.',
        'fr-FR': 'CLI : le menu de mise à jour que Codex affiche au démarrage n’est plus accepté par erreur, et Navide signale qu’une mise à jour de Codex est disponible et l’installe quand tous les panneaux Codex sont inactifs. Les panneaux Kiro CLI (AWS) arrivent dans une version minimale ; ils n’ont pas encore été essayés avec un vrai compte Kiro.',
        'de-DE': 'CLI: Das Update-Menü, das Codex beim Start zeigt, wird nicht mehr versehentlich bestätigt. Navide meldet, wenn ein Codex-Update verfügbar ist, und installiert es, sobald alle Codex-Bereiche untätig sind. Kiro CLI (AWS) gibt es als Bereich in einer Minimalversion; mit einem echten Kiro-Konto wurde sie noch nicht ausprobiert.',
        'pt-BR': 'CLI: o menu de atualização que o Codex mostra ao iniciar não é mais aceito por engano, e o Navide avisa quando há uma atualização do Codex e a instala quando todos os painéis do Codex estão ociosos. Chegam os painéis do Kiro CLI (AWS) numa versão mínima; ainda não foram testados com uma conta real do Kiro.',
        'ru-RU': 'CLI: меню обновления, которое Codex показывает при запуске, больше не подтверждается по ошибке; Navide сообщает о доступном обновлении Codex и устанавливает его, когда все панели Codex простаивают. Появились панели Kiro CLI (AWS) в минимальной версии; с настоящим аккаунтом Kiro они ещё не проверены.',
        'vi-VN': 'CLI: menu cập nhật mà Codex hiện lúc khởi động không còn bị chấp nhận nhầm; Navide báo khi có bản cập nhật Codex và cài khi mọi khung Codex đều rảnh. Có khung Kiro CLI (AWS) ở bản tối thiểu; chưa được thử với tài khoản Kiro thật.',
      },
      {
        'zh-TW': '修正：Git 視窗讀不到 repo 狀態時會顯示原因，不再顯示「Not a Git repository」。分格很多時，後端比較不吃 CPU，背景流量也變少。macOS 選單顯示 Navide，內建 pipeline 跟著介面語言，排程存檔後 Agent 控制面板會馬上更新。Telegram 訊息會一直保留到送進分格為止，重新啟動也不會遺失；分格的 CLI 需要重新登入時，訊息最多等 10 分鐘並告知聊天室；bot 的訊息被別的程式取走時，Navide 也會告訴你。',
        'en-US': 'Fixes: the Git window shows why it cannot read a repository instead of "Not a Git repository". The backend uses less CPU and sends less traffic with many panes open. The macOS menu says Navide, built-in pipelines follow the UI language, and a saved schedule shows in the agent control panel at once. Telegram messages are kept until they reach their pane, even across a restart; while a pane’s CLI needs to sign in they wait up to 10 minutes and the chat is told, and Navide tells you when another program took a bot’s messages.',
        'ja-JP': '修正：Git ウィンドウでリポジトリの状態を読めないとき、「Not a Git repository」ではなく理由を表示します。ペインが多いときのバックエンドの CPU 使用率と通信量が減りました。macOS のメニューは Navide と表示され、組み込みパイプラインは UI の言語に従い、保存したスケジュールはエージェントのコントロールパネルにすぐ反映されます。Telegram のメッセージはペインに届くまで保持され、再起動しても失われません。ペインの CLI がサインインし直す必要があるときは最大 10 分待ち、チャットにそのことを伝えます。別のプログラムがボットのメッセージを取得した場合も Navide が知らせます。',
        'zh-CN': '修复：Git 窗口读不到仓库状态时会显示原因，不再显示“Not a Git repository”。分格很多时，后端占用的 CPU 更少，后台流量也更少。macOS 菜单显示 Navide，内置 pipeline 跟随界面语言，计划任务保存后 Agent 控制面板会马上更新。Telegram 消息会一直保留到送进分格为止，重启也不会丢失；分格的 CLI 需要重新登录时，消息最多等 10 分钟并告知聊天；bot 的消息被别的程序取走时，Navide 也会告诉你。',
        'ko-KR': '수정: Git 창이 저장소 상태를 읽지 못하면 "Not a Git repository" 대신 이유를 보여 줍니다. 패널이 많을 때 백엔드의 CPU 사용량과 통신량이 줄었습니다. macOS 메뉴에 Navide가 표시되고, 기본 제공 파이프라인은 UI 언어를 따르며, 저장한 일정은 에이전트 제어판에 바로 나타납니다. Telegram 메시지는 패널에 전달될 때까지 보관되어 다시 시작해도 사라지지 않습니다. 패널의 CLI가 다시 로그인해야 하면 최대 10분 기다리며 채팅에 이를 알리고, 다른 프로그램이 봇의 메시지를 가져가면 Navide가 알려 줍니다.',
        'es-ES': 'Correcciones: la ventana de Git muestra por qué no puede leer un repositorio en lugar de "Not a Git repository". El backend usa menos CPU y genera menos tráfico con muchos paneles abiertos. El menú de macOS dice Navide, los pipelines integrados siguen el idioma de la interfaz y una programación guardada aparece al instante en el panel de control del agente. Los mensajes de Telegram se guardan hasta llegar a su panel, incluso tras un reinicio; si el CLI de un panel necesita iniciar sesión, esperan hasta 10 minutos y se avisa al chat, y Navide te avisa cuando otro programa se llevó los mensajes de un bot.',
        'fr-FR': 'Corrections : la fenêtre Git indique pourquoi elle ne peut pas lire un dépôt au lieu d’afficher « Not a Git repository ». Le backend consomme moins de CPU et génère moins de trafic avec de nombreux panneaux ouverts. Le menu macOS affiche Navide, les pipelines intégrés suivent la langue de l’interface et une planification enregistrée apparaît aussitôt dans le panneau de contrôle de l’agent. Les messages Telegram sont conservés jusqu’à leur panneau, même après un redémarrage ; quand le CLI d’un panneau doit se reconnecter, ils attendent jusqu’à 10 minutes et le chat est prévenu, et Navide vous signale quand un autre programme a récupéré les messages d’un bot.',
        'de-DE': 'Korrekturen: Das Git-Fenster zeigt, warum es ein Repository nicht lesen kann, statt „Not a Git repository“. Das Backend braucht bei vielen offenen Bereichen weniger CPU und erzeugt weniger Datenverkehr. Das macOS-Menü zeigt Navide, eingebaute Pipelines folgen der UI-Sprache, und ein gespeicherter Zeitplan erscheint sofort im Steuerbereich des Agenten. Telegram-Nachrichten bleiben erhalten, bis sie ihren Bereich erreichen, auch über einen Neustart hinweg; muss sich die CLI eines Bereichs neu anmelden, warten sie bis zu 10 Minuten und der Chat wird informiert, und Navide meldet, wenn ein anderes Programm die Nachrichten eines Bots abgeholt hat.',
        'pt-BR': 'Correções: a janela do Git mostra por que não consegue ler um repositório em vez de "Not a Git repository". O backend usa menos CPU e gera menos tráfego com muitos painéis abertos. O menu do macOS mostra Navide, os pipelines integrados seguem o idioma da interface e um agendamento salvo aparece na hora no painel de controle do agente. As mensagens do Telegram são guardadas até chegarem ao painel, mesmo após reiniciar; quando a CLI de um painel precisa entrar de novo, elas esperam até 10 minutos e o chat é avisado, e o Navide avisa quando outro programa pegou as mensagens de um bot.',
        'ru-RU': 'Исправления: окно Git показывает, почему не может прочитать репозиторий, вместо «Not a Git repository». При большом числе панелей бэкенд меньше нагружает CPU и создаёт меньше трафика. Меню macOS называется Navide, встроенные конвейеры следуют языку интерфейса, а сохранённое расписание сразу появляется в панели управления агента. Сообщения Telegram хранятся, пока не дойдут до своей панели, даже после перезапуска; если CLI панели нужно войти заново, они ждут до 10 минут, а чат получает уведомление, и Navide сообщает, когда сообщения бота забрала другая программа.',
        'vi-VN': 'Sửa lỗi: cửa sổ Git cho biết vì sao không đọc được repository thay vì hiện "Not a Git repository". Backend dùng ít CPU hơn và tạo ít lưu lượng hơn khi mở nhiều khung. Menu macOS hiện Navide, các pipeline có sẵn theo ngôn ngữ giao diện, và lịch đã lưu hiện ngay trong bảng điều khiển của agent. Tin nhắn Telegram được giữ cho đến khi tới khung của nó, kể cả sau khi khởi động lại; khi CLI của khung cần đăng nhập lại, tin nhắn chờ tối đa 10 phút và cuộc trò chuyện được báo, và Navide báo cho bạn khi một chương trình khác đã lấy tin nhắn của bot.',
      },
    ],
  },
  {
    version: '0.2.41',
    title: {
      'zh-TW': 'macOS 與 Linux 上的 Git 功能恢復正常',
      'en-US': 'Git Works Again on macOS and Linux',
      'ja-JP': 'macOS と Linux で Git 機能が元どおり動くように',
      'zh-CN': 'macOS 与 Linux 上的 Git 功能恢复正常',
      'ko-KR': 'macOS와 Linux에서 Git 기능이 다시 정상 작동',
      'es-ES': 'Git vuelve a funcionar en macOS y Linux',
      'fr-FR': 'Git fonctionne de nouveau sous macOS et Linux',
      'de-DE': 'Git funktioniert unter macOS und Linux wieder',
      'pt-BR': 'O Git volta a funcionar no macOS e no Linux',
      'ru-RU': 'Git снова работает на macOS и Linux',
      'vi-VN': 'Git hoạt động trở lại trên macOS và Linux',
    },
    highlights: [
      {
        'zh-TW': '修正：從 0.2.32 起，macOS 和 Linux 版會把正常的 repo 顯示成「Not a Git repository」，Git 外掛、git 監看、commit 訊息、gh／glab 和 shell 指令都會失敗。現在這些功能都恢復正常；Windows 不受影響。',
        'en-US': 'Fix: since 0.2.32, the macOS and Linux versions showed a real repository as "Not a Git repository", and the Git plugin, Git watching, commit messages, gh/glab and shell commands all failed. They all work again; Windows was not affected.',
        'ja-JP': '修正：0.2.32 以降、macOS 版と Linux 版では正常なリポジトリが「Not a Git repository」と表示され、Git プラグイン、Git の監視、コミットメッセージ、gh／glab とシェルコマンドがすべて失敗していました。これらはすべて元どおり動きます。Windows には影響ありません。',
        'zh-CN': '修复：从 0.2.32 起，macOS 和 Linux 版会把正常的仓库显示成“Not a Git repository”，Git 插件、Git 监视、commit 信息、gh/glab 和 shell 命令都会失败。现在这些功能都恢复正常；Windows 不受影响。',
        'ko-KR': '수정: 0.2.32부터 macOS와 Linux 버전에서 정상 저장소가 "Not a Git repository"로 표시되고, Git 플러그인, Git 감시, 커밋 메시지, gh/glab과 셸 명령이 모두 실패했습니다. 이제 모두 다시 정상 작동하며, Windows는 영향을 받지 않았습니다.',
        'es-ES': 'Corrección: desde la 0.2.32, las versiones de macOS y Linux mostraban un repositorio real como "Not a Git repository", y fallaban el complemento Git, la vigilancia de Git, los mensajes de commit, gh/glab y los comandos de shell. Todo vuelve a funcionar; Windows no se vio afectado.',
        'fr-FR': 'Correction : depuis la 0.2.32, les versions macOS et Linux affichaient un vrai dépôt comme « Not a Git repository », et le plugin Git, la surveillance Git, les messages de commit, gh/glab et les commandes shell échouaient tous. Tout fonctionne de nouveau ; Windows n’était pas concerné.',
        'de-DE': 'Korrektur: Seit 0.2.32 zeigten die macOS- und Linux-Versionen ein echtes Repository als „Not a Git repository“ an, und das Git-Plug-in, die Git-Überwachung, Commit-Nachrichten, gh/glab und Shell-Befehle schlugen alle fehl. Alles funktioniert wieder; Windows war nicht betroffen.',
        'pt-BR': 'Correção: desde a 0.2.32, as versões para macOS e Linux mostravam um repositório real como "Not a Git repository", e o plug-in Git, o monitoramento do Git, as mensagens de commit, gh/glab e os comandos de shell falhavam. Tudo volta a funcionar; o Windows não foi afetado.',
        'ru-RU': 'Исправление: начиная с 0.2.32 версии для macOS и Linux показывали настоящий репозиторий как «Not a Git repository», а плагин Git, отслеживание Git, сообщения коммитов, gh/glab и команды оболочки не работали. Теперь всё снова работает; Windows это не затронуло.',
        'vi-VN': 'Sửa lỗi: từ 0.2.32, bản macOS và Linux hiển thị một repository bình thường là "Not a Git repository", và plugin Git, theo dõi Git, thông điệp commit, gh/glab cùng các lệnh shell đều thất bại. Nay tất cả đã hoạt động trở lại; Windows không bị ảnh hưởng.',
      },
    ],
  },
  {
    version: '0.2.40',
    title: {
      'zh-TW': 'Hermes 與 OpenClaw 的 Agent 分格、Navide 外掛控管，以及用 MCP 切換模型',
      'en-US': 'Agent Panes for Hermes and OpenClaw, Plugin Controls and Model Switching over MCP',
      'ja-JP': 'Hermes と OpenClaw のエージェントペイン、Navide プラグインの管理、MCP からのモデル切り替え',
      'zh-CN': 'Hermes 与 OpenClaw 的 Agent 分格、Navide 插件管控，以及通过 MCP 切换模型',
      'ko-KR': 'Hermes와 OpenClaw의 Agent 패널, Navide 플러그인 관리, MCP로 모델 전환',
      'es-ES': 'Paneles de agente para Hermes y OpenClaw, control de complementos y cambio de modelo por MCP',
      'fr-FR': 'Panneaux d’agent pour Hermes et OpenClaw, contrôle des plugins et changement de modèle par MCP',
      'de-DE': 'Agent-Bereiche für Hermes und OpenClaw, Kontrolle über Plug-ins und Modellwechsel per MCP',
      'pt-BR': 'Painéis de agente para Hermes e OpenClaw, controle de plug-ins e troca de modelo via MCP',
      'ru-RU': 'Панели агентов для Hermes и OpenClaw, управление плагинами и смена модели через MCP',
      'vi-VN': 'Khung agent cho Hermes và OpenClaw, kiểm soát plugin và đổi mô hình qua MCP',
    },
    highlights: [
      {
        'zh-TW': 'Agent 分格：Hermes Agent 和 OpenClaw 分格重新開啟時會接續原本的對話，也會回報回合結束；Hermes 分格還會統計 token。它們有自己的標題列和控制面板，顯示狀態、綁定的聊天室、指向這個 Agent 的排程，以及最近的記憶檔案。「設定 → Agent」列出每個 Agent 的聊天室、排程和記憶資料夾。目前兩者都還不能指定模型開啟，也還不讀待辦。',
        'en-US': 'Agent panes: Hermes Agent and OpenClaw panes now resume their conversation when reopened and report when a turn ends, and Hermes panes count tokens. They get their own header and a control panel with the status, the bound channel, the schedules that target the agent and its latest memory files. Settings → Agents lists every agent with its channel, schedules and memory folder. Neither can be opened with a model yet, and todos are not read yet.',
        'ja-JP': 'エージェントペイン：Hermes Agent と OpenClaw のペインは、開き直すと元の会話を再開し、ターンの終了を報告するようになりました。Hermes のペインはトークンも集計します。専用のヘッダーとコントロールパネルがあり、状態、紐づいたチャット、そのエージェント宛てのスケジュール、最近のメモリファイルを表示します。「設定 → エージェント」には、各エージェントのチャット、スケジュール、メモリフォルダーが一覧表示されます。どちらもまだモデルを指定して開くことはできず、ToDo もまだ読み込みません。',
        'zh-CN': 'Agent 分格：Hermes Agent 和 OpenClaw 分格重新打开时会接续原来的对话，也会报告回合结束；Hermes 分格还会统计 token。它们有自己的标题栏和控制面板，显示状态、绑定的聊天室、指向这个 Agent 的计划任务，以及最近的记忆文件。“设置 → Agent”列出每个 Agent 的聊天室、计划任务和记忆文件夹。目前两者都还不能指定模型打开，也还不读取待办。',
        'ko-KR': 'Agent 패널: Hermes Agent와 OpenClaw 패널은 다시 열면 이전 대화를 이어 가고 턴이 끝나면 알려 줍니다. Hermes 패널은 토큰도 집계합니다. 전용 헤더와 제어판이 있어 상태, 연결된 채널, 이 에이전트를 대상으로 하는 일정, 최근 메모리 파일을 보여 줍니다. 설정 → Agent에는 각 에이전트의 채널, 일정, 메모리 폴더가 나열됩니다. 아직 둘 다 모델을 지정해 열 수 없고, 할 일도 아직 읽지 않습니다.',
        'es-ES': 'Paneles de agente: los paneles de Hermes Agent y OpenClaw ahora retoman su conversación al reabrirse e informan cuando termina un turno, y los de Hermes cuentan tokens. Tienen su propia cabecera y un panel de control con el estado, el canal vinculado, las programaciones dirigidas al agente y sus archivos de memoria más recientes. Ajustes → Agentes lista cada agente con su canal, programaciones y carpeta de memoria. Ninguno puede abrirse todavía con un modelo, y las tareas pendientes aún no se leen.',
        'fr-FR': 'Panneaux d’agent : les panneaux Hermes Agent et OpenClaw reprennent désormais leur conversation à la réouverture et signalent la fin de chaque tour, et ceux d’Hermes comptent les tokens. Ils ont leur propre en-tête et un panneau de contrôle avec l’état, le canal lié, les planifications qui visent l’agent et ses derniers fichiers de mémoire. Paramètres → Agents IA liste chaque agent avec son canal, ses planifications et son dossier de mémoire. Aucun des deux ne s’ouvre encore avec un modèle choisi, et les tâches ne sont pas encore lues.',
        'de-DE': 'Agent-Bereiche: Hermes-Agent- und OpenClaw-Bereiche setzen beim erneuten Öffnen ihr Gespräch fort und melden das Ende eines Durchgangs; Hermes-Bereiche zählen außerdem Tokens. Sie haben eine eigene Kopfzeile und ein Bedienfeld mit Status, verbundenem Kanal, den Zeitplänen für den Agenten und seinen neuesten Speicherdateien. Einstellungen → Agenten listet jeden Agenten mit Kanal, Zeitplänen und Speicherordner. Beide lassen sich noch nicht mit einem Modell öffnen, und Aufgaben werden noch nicht gelesen.',
        'pt-BR': 'Painéis de agente: os painéis do Hermes Agent e do OpenClaw agora retomam a conversa ao serem reabertos e avisam quando um turno termina, e os do Hermes contam tokens. Eles têm cabeçalho próprio e um painel de controle com o status, o canal vinculado, os agendamentos que miram o agente e seus arquivos de memória mais recentes. Configurações → Agentes lista cada agente com canal, agendamentos e pasta de memória. Nenhum dos dois pode ser aberto com um modelo ainda, e as tarefas ainda não são lidas.',
        'ru-RU': 'Панели агентов: панели Hermes Agent и OpenClaw теперь продолжают разговор при повторном открытии и сообщают о завершении хода, а панели Hermes ещё и считают токены. У них свой заголовок и панель управления со статусом, привязанным каналом, расписаниями для агента и последними файлами памяти. В разделе «Настройки → Агенты» перечислены все агенты с их каналом, расписаниями и папкой памяти. Пока ни один из них нельзя открыть с выбранной моделью, и задачи ещё не читаются.',
        'vi-VN': 'Khung agent: khung Hermes Agent và OpenClaw nay tiếp tục cuộc trò chuyện khi mở lại và báo khi một lượt kết thúc; khung Hermes còn đếm token. Chúng có thanh tiêu đề riêng và bảng điều khiển hiển thị trạng thái, kênh đã liên kết, lịch hẹn nhắm tới agent và các tệp bộ nhớ gần nhất. Cài đặt → Agent liệt kê từng agent cùng kênh, lịch hẹn và thư mục bộ nhớ. Cả hai chưa mở được với mô hình chỉ định, và danh sách việc cần làm chưa được đọc.',
      },
      {
        'zh-TW': 'Navide 外掛：「設定 → Navide 外掛 → 已安裝」開頭多了 Activity 總覽，列出每個外掛的呼叫、連線的網路主機和失敗次數。你可以從 Activity 總覽、狀態列、綁定的聊天室或 Agent 停止某個第三方外掛，也能一次全部停止；外掛的檔案和資料都會保留。第三方外掛行為異常時，Navide 也會自動暫停它並告訴你原因。自動暫停預設開啟，可在 Activity 總覽關閉。',
        'en-US': 'Navide plugins: Settings → Navide Plugins → Installed opens with an Activity monitor showing every plugin’s calls, network hosts and failures. You can stop a third-party plugin, or all of them at once, from the monitor, the status bar, a bound chat or an agent; its files and data stay. Navide also pauses a third-party plugin on its own when it behaves unusually, and tells you why. Automatic pauses are on by default and can be turned off on the monitor.',
        'ja-JP': 'Navide プラグイン：「設定 → Navide プラグイン → インストール済み」の冒頭に Activity 一覧が加わり、各プラグインの呼び出し、接続したネットワークホスト、失敗回数を表示します。サードパーティのプラグインは、Activity 一覧、ステータスバー、紐づいたチャット、エージェントのいずれからでも個別に、または一括で停止でき、ファイルとデータは残ります。サードパーティのプラグインの動作がおかしいときは、Navide が自動で一時停止し、理由を知らせます。自動一時停止は既定でオンで、Activity 一覧でオフにできます。',
        'zh-CN': 'Navide 插件：“设置 → Navide 插件 → 已安装”开头新增 Activity 总览，列出每个插件的调用、连接的网络主机和失败次数。你可以从 Activity 总览、状态栏、绑定的聊天室或 Agent 停止某个第三方插件，也能一次全部停止；插件的文件和数据都会保留。第三方插件行为异常时，Navide 也会自动暂停它并告诉你原因。自动暂停默认开启，可在 Activity 总览中关闭。',
        'ko-KR': 'Navide 플러그인: 설정 → Navide 플러그인 → 설치됨 맨 위에 Activity 개요가 생겨 각 플러그인의 호출, 연결한 네트워크 호스트, 실패 횟수를 보여 줍니다. 서드파티 플러그인은 Activity 개요, 상태 표시줄, 연결된 채팅, 에이전트 어디서든 하나씩 또는 한꺼번에 중지할 수 있으며 파일과 데이터는 그대로 남습니다. 서드파티 플러그인이 이상하게 동작하면 Navide가 스스로 일시 중지하고 이유를 알려 줍니다. 자동 일시 중지는 기본적으로 켜져 있으며 Activity 개요에서 끌 수 있습니다.',
        'es-ES': 'Complementos de Navide: Ajustes → Complementos de Navide → Instalados se abre con el Resumen de Activity, que muestra las llamadas, los hosts de red y los fallos de cada complemento. Puedes detener un complemento de terceros, o todos a la vez, desde el Resumen de Activity, la barra de estado, un chat vinculado o un agente; sus archivos y datos se conservan. Navide también pausa por su cuenta un complemento de terceros que se comporta de forma anómala y te dice por qué. Las pausas automáticas vienen activadas y se pueden desactivar en el Resumen de Activity.',
        'fr-FR': 'Plugins Navide : Paramètres → Plugins Navide → Installés s’ouvre sur la Vue d’ensemble de l’Activity, qui montre les appels, les hôtes réseau et les échecs de chaque plugin. Vous pouvez arrêter un plugin tiers, ou tous à la fois, depuis la Vue d’ensemble de l’Activity, la barre d’état, un chat lié ou un agent ; ses fichiers et ses données restent. Navide met aussi en pause de lui-même un plugin tiers au comportement inhabituel et vous dit pourquoi. Les pauses automatiques sont activées par défaut et se désactivent dans la Vue d’ensemble de l’Activity.',
        'de-DE': 'Navide-Plug-ins: Einstellungen → Navide-Plug-ins → Installiert beginnt mit der Activity-Übersicht, die Aufrufe, Netzwerk-Hosts und Fehler jedes Plug-ins zeigt. Ein Drittanbieter-Plug-in, oder alle auf einmal, lässt sich über die Activity-Übersicht, die Statusleiste, einen verbundenen Chat oder einen Agenten stoppen; Dateien und Daten bleiben erhalten. Verhält sich ein Drittanbieter-Plug-in auffällig, pausiert Navide es selbst und nennt den Grund. Automatische Pausen sind standardmäßig an und lassen sich in der Activity-Übersicht ausschalten.',
        'pt-BR': 'Plug-ins do Navide: Configurações → Plug-ins do Navide → Instalados abre com a Visão geral da Activity, que mostra chamadas, hosts de rede e falhas de cada plug-in. Você pode parar um plug-in de terceiros, ou todos de uma vez, pela Visão geral da Activity, pela barra de status, por um chat vinculado ou por um agente; os arquivos e dados dele ficam. O Navide também pausa sozinho um plug-in de terceiros que se comporta de forma incomum e diz o motivo. As pausas automáticas vêm ligadas e podem ser desligadas na Visão geral da Activity.',
        'ru-RU': 'Плагины Navide: раздел «Настройки → Плагины Navide → Установленные» открывается разделом «Обзор Activity», где видны вызовы, сетевые хосты и сбои каждого плагина. Сторонний плагин, или все сразу, можно остановить из раздела «Обзор Activity», строки состояния, привязанного чата или агентом; его файлы и данные сохраняются. Navide также сам приостанавливает сторонний плагин, который ведёт себя необычно, и объясняет причину. Автоматические паузы включены по умолчанию и отключаются в разделе «Обзор Activity».',
        'vi-VN': 'Plugin Navide: Cài đặt → Plugin Navide → Đã cài nay mở đầu bằng Tổng quan Activity, hiển thị lệnh gọi, máy chủ mạng và số lần lỗi của từng plugin. Bạn có thể dừng một plugin bên thứ ba, hoặc tất cả cùng lúc, từ Tổng quan Activity, thanh trạng thái, cuộc trò chuyện đã liên kết hoặc agent; tệp và dữ liệu của plugin vẫn được giữ. Navide cũng tự tạm dừng plugin bên thứ ba khi nó hoạt động bất thường và cho bạn biết lý do. Tự động tạm dừng mặc định bật và có thể tắt trong Tổng quan Activity.',
      },
      {
        'zh-TW': 'MCP：`cli_set_model` 可以切換閒置 CLI 分格的模型。Claude Code 和 Codex 在執行中的工作階段直接切換，對話不中斷；其他 CLI 會以新模型重新啟動並接續同一段對話。`cli_rename_pane` 可以替分格改名，其他分格馬上就能用新名字找到它。在較高的 Linux 視窗裡，Claude 切換模型仍可能重啟分格一次，修正排在 0.2.42。',
        'en-US': 'MCP: `cli_set_model` switches the model of an idle CLI pane. Claude Code and Codex switch inside the running session and keep the conversation; other CLIs restart on the new model and resume the same conversation. `cli_rename_pane` renames a pane, and other panes reach it by the new name at once. In a tall Linux window a Claude switch can still restart the pane once; a fix is planned for 0.2.42.',
        'ja-JP': 'MCP：`cli_set_model` でアイドル中の CLI ペインのモデルを切り替えられます。Claude Code と Codex は実行中のセッション内で切り替わり、会話は途切れません。ほかの CLI は新しいモデルで再起動し、同じ会話を再開します。`cli_rename_pane` でペインの名前を変えると、ほかのペインはすぐに新しい名前で届くようになります。縦に長い Linux のウィンドウでは、Claude の切り替えでペインが一度再起動することがあり、0.2.42 で修正予定です。',
        'zh-CN': 'MCP：`cli_set_model` 可以切换空闲 CLI 分格的模型。Claude Code 和 Codex 在运行中的会话里直接切换，对话不中断；其他 CLI 会用新模型重新启动并接续同一段对话。`cli_rename_pane` 可以给分格改名，其他分格马上就能用新名字找到它。在较高的 Linux 窗口里，Claude 切换模型仍可能重启分格一次，修复计划在 0.2.42。',
        'ko-KR': 'MCP: `cli_set_model`로 유휴 상태인 CLI 패널의 모델을 바꿀 수 있습니다. Claude Code와 Codex는 실행 중인 세션 안에서 바뀌어 대화가 이어지고, 다른 CLI는 새 모델로 다시 시작해 같은 대화를 이어 갑니다. `cli_rename_pane`으로 패널 이름을 바꾸면 다른 패널이 곧바로 새 이름으로 찾을 수 있습니다. 세로로 긴 Linux 창에서는 Claude 모델 전환 시 패널이 한 번 다시 시작될 수 있으며, 0.2.42에서 고칠 예정입니다.',
        'es-ES': 'MCP: `cli_set_model` cambia el modelo de un panel de CLI inactivo. Claude Code y Codex cambian dentro de la sesión en curso y conservan la conversación; las demás CLI se reinician con el nuevo modelo y retoman la misma conversación. `cli_rename_pane` renombra un panel, y los demás lo encuentran por el nuevo nombre al instante. En una ventana alta de Linux, un cambio de Claude todavía puede reiniciar el panel una vez; la corrección está prevista para 0.2.42.',
        'fr-FR': 'MCP : `cli_set_model` change le modèle d’un panneau CLI inactif. Claude Code et Codex changent dans la session en cours et gardent la conversation ; les autres CLI redémarrent sur le nouveau modèle et reprennent la même conversation. `cli_rename_pane` renomme un panneau, et les autres panneaux le joignent aussitôt sous son nouveau nom. Dans une fenêtre Linux haute, un changement de Claude peut encore redémarrer le panneau une fois ; un correctif est prévu pour 0.2.42.',
        'de-DE': 'MCP: `cli_set_model` wechselt das Modell eines untätigen CLI-Bereichs. Claude Code und Codex wechseln in der laufenden Sitzung und behalten das Gespräch; andere CLIs starten mit dem neuen Modell neu und setzen dasselbe Gespräch fort. `cli_rename_pane` benennt einen Bereich um, und andere Bereiche erreichen ihn sofort unter dem neuen Namen. In einem hohen Linux-Fenster kann ein Claude-Wechsel den Bereich noch einmal neu starten; die Korrektur ist für 0.2.42 geplant.',
        'pt-BR': 'MCP: `cli_set_model` troca o modelo de um painel de CLI ocioso. O Claude Code e o Codex trocam dentro da sessão em andamento e mantêm a conversa; as outras CLIs reiniciam com o novo modelo e retomam a mesma conversa. `cli_rename_pane` renomeia um painel, e os outros painéis o encontram pelo novo nome na hora. Numa janela alta do Linux, uma troca do Claude ainda pode reiniciar o painel uma vez; a correção está prevista para a 0.2.42.',
        'ru-RU': 'MCP: `cli_set_model` меняет модель простаивающей панели CLI. Claude Code и Codex переключаются внутри текущего сеанса и сохраняют разговор; другие CLI перезапускаются с новой моделью и продолжают тот же разговор. `cli_rename_pane` переименовывает панель, и другие панели сразу находят её по новому имени. В высоком окне Linux переключение Claude пока может один раз перезапустить панель; исправление запланировано на 0.2.42.',
        'vi-VN': 'MCP: `cli_set_model` đổi mô hình của khung CLI đang rảnh. Claude Code và Codex đổi ngay trong phiên đang chạy và giữ nguyên cuộc trò chuyện; các CLI khác khởi động lại với mô hình mới và tiếp tục cùng cuộc trò chuyện. `cli_rename_pane` đổi tên khung, và các khung khác tìm thấy nó bằng tên mới ngay lập tức. Trong cửa sổ Linux cao, việc đổi mô hình Claude vẫn có thể khởi động lại khung một lần; bản sửa dự kiến có trong 0.2.42.',
      },
      {
        'zh-TW': '聊天室：從 Telegram 等聊天室傳給正在等權限提示的分格的訊息，不會再被拒絕，而是先保留（每個分格最多 20 則、30 分鐘），等提示回答後依序送進去；用 `/cancel` 可以撤回。聊天室仍然不能替你核准提示。`/status` 也會顯示分格已經等了多久。',
        'en-US': 'Chat channels: a message sent from Telegram or another chat to a pane waiting on a permission prompt is no longer refused. It is kept, up to 20 per pane for 30 minutes, and goes in, in order, once the prompt is answered; `/cancel` withdraws it. A chat still cannot approve the prompt. `/status` also says how long the pane has been waiting.',
        'ja-JP': 'チャット連携：Telegram などのチャットから、権限の確認待ちのペインに送ったメッセージは拒否されなくなりました。ペインごとに最大 20 件、30 分間保持され、確認に答えたあとで順に送られます。`/cancel` で取り消せます。チャットから確認を承認することは引き続きできません。`/status` では、ペインがどれだけ待っているかも表示されます。',
        'zh-CN': '聊天室：从 Telegram 等聊天室发给正在等待权限提示的分格的消息，不会再被拒绝，而是先保留（每个分格最多 20 条、30 分钟），等提示回答后按顺序送入；用 `/cancel` 可以撤回。聊天室仍然不能替你批准提示。`/status` 也会显示分格已经等了多久。',
        'ko-KR': '채널: Telegram 등 채팅에서 권한 확인을 기다리는 패널로 보낸 메시지가 더 이상 거부되지 않습니다. 패널마다 최대 20개를 30분 동안 보관했다가 확인에 답하면 순서대로 보냅니다. `/cancel`로 취소할 수 있습니다. 채팅에서 확인을 승인할 수는 여전히 없습니다. `/status`는 패널이 얼마나 기다렸는지도 알려 줍니다.',
        'es-ES': 'Canales de chat: un mensaje enviado desde Telegram u otro chat a un panel que espera una solicitud de permiso ya no se rechaza. Se guarda, hasta 20 por panel durante 30 minutos, y entra en orden cuando se responde la solicitud; `/cancel` lo retira. Un chat sigue sin poder aprobar la solicitud. `/status` también indica cuánto tiempo lleva esperando el panel.',
        'fr-FR': 'Canaux de discussion : un message envoyé depuis Telegram ou un autre chat à un panneau qui attend une demande d’autorisation n’est plus refusé. Il est conservé, jusqu’à 20 par panneau pendant 30 minutes, et part dans l’ordre une fois la demande traitée ; `/cancel` le retire. Un chat ne peut toujours pas approuver la demande. `/status` indique aussi depuis combien de temps le panneau attend.',
        'de-DE': 'Chat-Kanäle: Eine Nachricht aus Telegram oder einem anderen Chat an einen Bereich, der auf eine Berechtigungsabfrage wartet, wird nicht mehr abgelehnt. Sie wird aufbewahrt, bis zu 20 pro Bereich für 30 Minuten, und geht der Reihe nach hinein, sobald die Abfrage beantwortet ist; `/cancel` zieht sie zurück. Ein Chat kann die Abfrage weiterhin nicht genehmigen. `/status` sagt außerdem, wie lange der Bereich schon wartet.',
        'pt-BR': 'Canais de chat: uma mensagem enviada do Telegram ou de outro chat para um painel que espera uma solicitação de permissão não é mais recusada. Ela fica guardada, até 20 por painel por 30 minutos, e entra em ordem assim que a solicitação é respondida; `/cancel` a retira. Um chat continua sem poder aprovar a solicitação. `/status` também diz há quanto tempo o painel está esperando.',
        'ru-RU': 'Каналы чатов: сообщение из Telegram или другого чата в панель, которая ждёт запроса разрешения, больше не отклоняется. Оно сохраняется, до 20 на панель на 30 минут, и уходит по порядку, когда на запрос ответят; `/cancel` отзывает его. Одобрить запрос из чата по-прежнему нельзя. `/status` теперь также показывает, сколько панель уже ждёт.',
        'vi-VN': 'Kênh trò chuyện: tin nhắn gửi từ Telegram hoặc kênh khác tới khung đang chờ lời nhắc cấp quyền không còn bị từ chối. Tin nhắn được giữ lại, tối đa 20 tin mỗi khung trong 30 phút, và được gửi vào theo thứ tự khi lời nhắc đã được trả lời; `/cancel` để rút lại. Kênh trò chuyện vẫn không thể phê duyệt lời nhắc. `/status` cũng cho biết khung đã chờ bao lâu.',
      },
      {
        'zh-TW': 'Guard：把 `~/.ssh` 裡的檔案用管線傳給網路工具，預設仍然拒絕，但現在可以在「設定 → 安全 → 終端機指令防護 → 豁免：讀取憑證再上傳」把某一整行指令設成豁免。新增豁免要在主視窗確認，所以 Agent 不能自己加；每一行被放行的指令都會記進 Guard 紀錄。',
        'en-US': 'Guard: piping a file from `~/.ssh` into a network tool is still refused by default, but you can now exempt one exact command line in Settings → Security → Terminal command protection → Exemptions: reading a credential and uploading it. Adding one needs your confirmation in the main window, so an agent cannot add it, and every exempted line is written to the Guard log.',
        'ja-JP': 'Guard：`~/.ssh` のファイルをパイプでネットワークツールに渡すコマンドは既定で引き続き拒否されますが、「設定 → セキュリティ → ターミナルコマンド保護 → 除外：認証情報を読み取ってアップロード」で、特定のコマンド行を丸ごと除外できるようになりました。除外の追加にはメインウィンドウでの確認が必要なので、エージェントが自分で追加することはできません。除外で通った行はすべて Guard のログに記録されます。',
        'zh-CN': 'Guard：把 `~/.ssh` 里的文件通过管道传给网络工具，默认仍然拒绝，但现在可以在“设置 → 安全 → 终端指令防护 → 豁免：读取凭据再上传”把某一整行命令设为豁免。添加豁免需要在主窗口确认，所以 Agent 不能自己添加；每一行被放行的命令都会记入 Guard 日志。',
        'ko-KR': 'Guard: `~/.ssh`의 파일을 파이프로 네트워크 도구에 넘기는 명령은 기본적으로 계속 거부되지만, 이제 설정 → 보안 → 터미널 명령 보호 → 예외: 자격 증명을 읽어 업로드에서 정확한 명령 한 줄을 예외로 둘 수 있습니다. 예외를 추가하려면 메인 창에서 확인해야 하므로 에이전트가 직접 추가할 수 없고, 예외로 통과한 모든 줄은 Guard 로그에 기록됩니다.',
        'es-ES': 'Guard: canalizar un archivo de `~/.ssh` hacia una herramienta de red sigue rechazándose de forma predeterminada, pero ahora puedes eximir una línea de comando exacta en Ajustes → Seguridad → Protección de comandos del terminal → Exenciones: leer una credencial y subirla. Añadir una requiere tu confirmación en la ventana principal, así que un agente no puede añadirla, y cada línea eximida queda registrada en el registro de Guard.',
        'fr-FR': 'Guard : envoyer par un tube un fichier de `~/.ssh` vers un outil réseau reste refusé par défaut, mais vous pouvez désormais exempter une ligne de commande exacte dans Paramètres → Sécurité → Protection des commandes du terminal → Exemptions : lire un identifiant puis l’envoyer. En ajouter une demande votre confirmation dans la fenêtre principale, un agent ne peut donc pas le faire, et chaque ligne exemptée est inscrite au journal de Guard.',
        'de-DE': 'Guard: Eine Datei aus `~/.ssh` per Pipe an ein Netzwerkwerkzeug zu geben, wird standardmäßig weiter abgelehnt, doch jetzt lässt sich eine genaue Befehlszeile freigeben: Einstellungen → Sicherheit → Schutz vor Terminalbefehlen → Ausnahmen – Anmeldeinformationen lesen und hochladen. Eine Ausnahme hinzuzufügen erfordert deine Bestätigung im Hauptfenster, ein Agent kann es also nicht, und jede freigegebene Zeile wird im Guard-Protokoll festgehalten.',
        'pt-BR': 'Guard: canalizar um arquivo de `~/.ssh` para uma ferramenta de rede continua recusado por padrão, mas agora você pode isentar uma linha de comando exata em Configurações → Segurança → Proteção de comandos do terminal → Isenções: ler uma credencial e enviá-la. Adicionar uma exige sua confirmação na janela principal, então um agente não consegue adicioná-la, e cada linha isenta fica registrada no log do Guard.',
        'ru-RU': 'Guard: передача файла из `~/.ssh` по конвейеру в сетевой инструмент по-прежнему запрещена по умолчанию, но теперь точную командную строку можно сделать исключением в разделе «Настройки → Безопасность → Защита команд терминала → Исключения: чтение учётных данных и их отправка». Добавление требует вашего подтверждения в главном окне, поэтому агент не может сделать это сам, а каждая пропущенная строка записывается в журнал Guard.',
        'vi-VN': 'Guard: chuyển tệp trong `~/.ssh` qua đường ống tới công cụ mạng vẫn bị từ chối theo mặc định, nhưng nay bạn có thể miễn trừ cho đúng một dòng lệnh trong Cài đặt → Bảo mật → Bảo vệ lệnh terminal → Miễn trừ: đọc thông tin xác thực rồi tải lên. Thêm miễn trừ cần bạn xác nhận trong cửa sổ chính, nên agent không thể tự thêm, và mọi dòng được cho qua đều được ghi vào nhật ký Guard.',
      },
      {
        'zh-TW': '修正：Agent 和終端機分格拿回你自己的暫存目錄（`TMPDIR`，Windows 上還有 `TMP`／`TEMP`），不再沿用 Navide 後端那個路徑含空格的資料夾。後端改成以資料夾形式安裝，系統的暫存清理不會再讓連續執行好幾天的 Navide 的 MCP 工作階段失效；macOS 上的 App 因此大了約 60 MB。磁碟很慢時啟動 Pipeline 不會再讓 Navide 卡住；Claude 或 Codex 分格沒有理會的 STOP 現在會顯示「STOP 未生效」。',
        'en-US': 'Fixes: agent and terminal panes get your own temp directory back (`TMPDIR`, and `TMP`/`TEMP` on Windows) instead of Navide’s backend folder, whose path has a space in it. The backend is now installed as a folder of files, so the system’s temp cleaner can no longer break MCP sessions on a Navide that has run for days; the app is about 60 MB larger on macOS. Starting a pipeline no longer freezes Navide when the disk is slow. A STOP that did not interrupt a Claude or Codex pane now shows “STOP not applied”.',
        'ja-JP': '修正：エージェントとターミナルのペインに、あなた自身の一時ディレクトリ（`TMPDIR`、Windows では `TMP`／`TEMP` も）が戻りました。パスに空白を含む Navide のバックエンド用フォルダーは使わなくなります。バックエンドはフォルダー形式でインストールされるようになり、何日も動かしている Navide で、システムの一時ファイル掃除によって MCP セッションが壊れることはなくなりました。そのぶん macOS では App が約 60 MB 大きくなります。ディスクが遅いときにパイプラインを開始しても Navide が固まらなくなり、Claude や Codex のペインが反応しなかった STOP には「STOP 未反映」と表示されます。',
        'zh-CN': '修复：Agent 和终端分格拿回你自己的临时目录（`TMPDIR`，Windows 上还有 `TMP`/`TEMP`），不再沿用 Navide 后端那个路径含空格的文件夹。后端改为以文件夹形式安装，系统的临时文件清理不会再让连续运行好几天的 Navide 的 MCP 会话失效；macOS 上的 App 因此大了约 60 MB。磁盘很慢时启动 Pipeline 不会再让 Navide 卡住；Claude 或 Codex 分格没有响应的 STOP 现在会显示“STOP 未生效”。',
        'ko-KR': '수정: 에이전트와 터미널 패널이 Navide 백엔드 폴더(경로에 공백이 있음) 대신 사용자 자신의 임시 디렉터리(`TMPDIR`, Windows에서는 `TMP`/`TEMP`도)를 다시 받습니다. 백엔드는 이제 폴더 형태로 설치되어, 며칠씩 켜 둔 Navide에서 시스템의 임시 파일 정리가 MCP 세션을 망가뜨리지 않습니다. 그 대신 macOS에서 앱이 약 60MB 커집니다. 디스크가 느릴 때 파이프라인을 시작해도 Navide가 멈추지 않으며, Claude 또는 Codex 패널이 반응하지 않은 STOP에는 “STOP 미적용”이 표시됩니다.',
        'es-ES': 'Correcciones: los paneles de agente y de terminal recuperan tu propio directorio temporal (`TMPDIR`, y `TMP`/`TEMP` en Windows) en lugar de la carpeta del backend de Navide, cuya ruta tiene un espacio. El backend ahora se instala como una carpeta de archivos, así que el limpiador de temporales del sistema ya no puede romper las sesiones MCP de un Navide que lleva días abierto; la aplicación ocupa unos 60 MB más en macOS. Iniciar un pipeline ya no congela Navide cuando el disco va lento, y un STOP que no interrumpió un panel de Claude o Codex ahora muestra «STOP sin efecto».',
        'fr-FR': 'Corrections : les panneaux d’agent et de terminal retrouvent votre propre dossier temporaire (`TMPDIR`, et `TMP`/`TEMP` sous Windows) au lieu du dossier du backend de Navide, dont le chemin contient une espace. Le backend s’installe désormais sous forme de dossier, si bien que le nettoyage des fichiers temporaires du système ne peut plus casser les sessions MCP d’un Navide ouvert depuis des jours ; l’application pèse environ 60 Mo de plus sous macOS. Lancer un pipeline ne fige plus Navide quand le disque est lent, et un STOP qui n’a pas interrompu un panneau Claude ou Codex affiche désormais « STOP sans effet ».',
        'de-DE': 'Korrekturen: Agent- und Terminal-Bereiche bekommen wieder dein eigenes Temp-Verzeichnis (`TMPDIR`, unter Windows auch `TMP`/`TEMP`) statt des Backend-Ordners von Navide, dessen Pfad ein Leerzeichen enthält. Das Backend wird jetzt als Ordner installiert, sodass die Temp-Bereinigung des Systems die MCP-Sitzungen eines seit Tagen laufenden Navide nicht mehr beschädigen kann; die App ist unter macOS dafür etwa 60 MB größer. Ein Pipeline-Start friert Navide bei langsamer Festplatte nicht mehr ein, und ein STOP, das einen Claude- oder Codex-Bereich nicht unterbrochen hat, zeigt jetzt „STOP nicht wirksam“.',
        'pt-BR': 'Correções: os painéis de agente e de terminal voltam a usar o seu próprio diretório temporário (`TMPDIR`, e `TMP`/`TEMP` no Windows) em vez da pasta do backend do Navide, cujo caminho tem um espaço. O backend agora é instalado como uma pasta de arquivos, então a limpeza de temporários do sistema não consegue mais quebrar as sessões MCP de um Navide aberto há dias; o app fica cerca de 60 MB maior no macOS. Iniciar um pipeline não trava mais o Navide quando o disco está lento, e um STOP que não interrompeu um painel do Claude ou do Codex agora mostra “STOP sem efeito”.',
        'ru-RU': 'Исправления: панели агентов и терминалов снова получают ваш собственный временный каталог (`TMPDIR`, а в Windows также `TMP`/`TEMP`) вместо папки бэкенда Navide, в пути которой есть пробел. Бэкенд теперь устанавливается папкой с файлами, поэтому системная очистка временных файлов больше не ломает сеансы MCP у Navide, работающего несколько дней; на macOS приложение стало примерно на 60 МБ больше. Запуск пайплайна больше не замораживает Navide при медленном диске, а STOP, который не прервал панель Claude или Codex, теперь показывает «STOP не сработал».',
        'vi-VN': 'Sửa lỗi: khung agent và terminal được trả lại thư mục tạm của chính bạn (`TMPDIR`, và `TMP`/`TEMP` trên Windows) thay vì thư mục backend của Navide có dấu cách trong đường dẫn. Backend nay được cài dưới dạng thư mục tệp, nên trình dọn tệp tạm của hệ thống không còn làm hỏng phiên MCP của Navide đã chạy nhiều ngày; ứng dụng trên macOS lớn hơn khoảng 60 MB. Bắt đầu pipeline không còn làm Navide đứng khi ổ đĩa chậm, và lệnh STOP không ngắt được khung Claude hoặc Codex nay hiển thị “STOP chưa có hiệu lực”.',
      },
    ],
  },
  {
    version: '0.2.39',
    title: {
      'zh-TW': 'Navide 外掛能做更多事、依模型與帳號看花費，Agent 也能管理聊天室',
      'en-US': 'More for Navide Plugins, Costs by Model and Account, and Agents That Manage Channels',
      'ja-JP': 'Navide プラグインの機能拡充、モデル別・アカウント別の費用、チャット連携を扱えるエージェント',
      'zh-CN': 'Navide 插件能做更多事、按模型与账号查看费用，Agent 也能管理聊天室',
      'ko-KR': '더 많은 일을 하는 Navide 플러그인, 모델별·계정별 비용, 채널을 다루는 에이전트',
      'es-ES': 'Más posibilidades para los complementos de Navide, costes por modelo y cuenta, y agentes que gestionan Channels',
      'fr-FR': 'Plus de possibilités pour les plugins Navide, coûts par modèle et par compte, et des agents qui gèrent les canaux',
      'de-DE': 'Mehr für Navide-Plug-ins, Kosten nach Modell und Konto und Agenten, die Kanäle verwalten',
      'pt-BR': 'Mais recursos para plug-ins do Navide, custos por modelo e conta, e agentes que gerenciam canais',
      'ru-RU': 'Больше возможностей для плагинов Navide, расходы по моделям и аккаунтам и агенты, управляющие каналами',
      'vi-VN': 'Plugin Navide làm được nhiều hơn, chi phí theo mô hình và tài khoản, và agent quản lý kênh',
    },
    highlights: [
      {
        'zh-TW': 'Navide 外掛：外掛現在可以把自己的 API key 存在這台電腦（加密保存、不同步、不會回傳給 Agent），宣告會用到的網路主機和程式，訂閱 Navide 事件，在狀態列和右鍵選單加項目，當作 Pipeline 節點，也能互相呼叫。安裝前的說明卡會逐項列出。外掛畫面發出的每個網路請求都記在「活動」裡；每個外掛都有開關，可以只允許它宣告過的主機。',
        'en-US': 'Navide plugins: a plugin can now keep its own API keys on this computer (encrypted, never synced and never returned to an agent), declare the network hosts and programs it uses, subscribe to Navide events, add items to the status bar and right-click menus, run as a pipeline node and call other plugins. The install card lists each of these before you install. Activity records every network request a plugin view makes, and a switch per plugin limits it to the hosts it declared.',
        'ja-JP': 'Navide プラグイン：プラグインは自分の API キーをこのコンピューターに保存できるようになりました（暗号化され、同期されず、エージェントに返されることもありません）。さらに、使うネットワークホストやプログラムの宣言、Navide のイベントの購読、ステータスバーや右クリックメニューへの項目追加、パイプラインのノードとしての実行、ほかのプラグインの呼び出しができます。インストール前のカードにはそれぞれが一覧表示されます。プラグインのビューが行うネットワーク要求はすべて「アクティビティ」に記録され、プラグインごとのスイッチで宣言済みのホストだけに制限できます。',
        'zh-CN': 'Navide 插件：插件现在可以把自己的 API 密钥存在这台电脑上（加密保存、不同步、不会返回给 Agent），声明会用到的网络主机和程序，订阅 Navide 事件，在状态栏和右键菜单添加项目，作为 Pipeline 节点运行，也能相互调用。安装前的说明卡会逐项列出。插件界面发出的每个网络请求都记录在“活动”里；每个插件都有开关，可以只允许它声明过的主机。',
        'ko-KR': 'Navide 플러그인: 이제 플러그인은 자신의 API 키를 이 컴퓨터에 보관할 수 있고(암호화되며 동기화되지 않고 에이전트에게 반환되지 않음), 사용하는 네트워크 호스트와 프로그램을 선언하고, Navide 이벤트를 구독하고, 상태 표시줄과 오른쪽 클릭 메뉴에 항목을 추가하고, 파이프라인 노드로 실행되고, 다른 플러그인을 호출할 수 있습니다. 설치 전 카드에 각각이 표시됩니다. 플러그인 화면이 보내는 모든 네트워크 요청은 활동에 기록되며, 플러그인별 스위치로 선언한 호스트만 허용할 수 있습니다.',
        'es-ES': 'Complementos de Navide: un complemento ahora puede guardar sus propias claves de API en este ordenador (cifradas, nunca sincronizadas y nunca devueltas a un agente), declarar los hosts de red y los programas que usa, suscribirse a eventos de Navide, añadir elementos a la barra de estado y a los menús contextuales, funcionar como nodo de pipeline y llamar a otros complementos. La tarjeta de instalación enumera cada uno antes de instalar. Actividad registra cada petición de red que hace la vista de un complemento, y un interruptor por complemento la limita a los hosts declarados.',
        'fr-FR': 'Plugins Navide : un plugin peut désormais garder ses propres clés API sur cet ordinateur (chiffrées, jamais synchronisées et jamais renvoyées à un agent), déclarer les hôtes réseau et les programmes qu’il utilise, s’abonner aux événements de Navide, ajouter des éléments à la barre d’état et aux menus contextuels, servir de nœud de pipeline et appeler d’autres plugins. La carte d’installation liste chacun de ces points avant l’installation. Activité enregistre chaque requête réseau d’une vue de plugin, et un interrupteur par plugin la limite aux hôtes déclarés.',
        'de-DE': 'Navide-Plug-ins: Ein Plug-in kann jetzt eigene API-Schlüssel auf diesem Computer ablegen (verschlüsselt, nie synchronisiert und nie an einen Agenten zurückgegeben), die genutzten Netzwerk-Hosts und Programme deklarieren, Navide-Ereignisse abonnieren, Einträge in Statusleiste und Kontextmenüs ergänzen, als Pipeline-Knoten laufen und andere Plug-ins aufrufen. Die Installationskarte listet all das vor der Installation auf. Aktivität verzeichnet jede Netzwerkanfrage einer Plug-in-Ansicht, und ein Schalter pro Plug-in beschränkt sie auf die deklarierten Hosts.',
        'pt-BR': 'Plug-ins do Navide: um plug-in agora pode guardar as próprias chaves de API neste computador (criptografadas, nunca sincronizadas e nunca devolvidas a um agente), declarar os hosts de rede e os programas que usa, assinar eventos do Navide, adicionar itens à barra de status e aos menus de clique direito, rodar como nó de pipeline e chamar outros plug-ins. O cartão de instalação lista cada item antes de instalar. Atividade registra cada requisição de rede de uma view de plug-in, e uma chave por plug-in a limita aos hosts declarados.',
        'ru-RU': 'Плагины Navide: плагин теперь может хранить собственные API-ключи на этом компьютере (в зашифрованном виде, без синхронизации и без передачи агенту), объявлять используемые сетевые хосты и программы, подписываться на события Navide, добавлять пункты в строку состояния и контекстные меню, работать как узел пайплайна и вызывать другие плагины. Карточка установки перечисляет всё это до установки. «Активность» фиксирует каждый сетевой запрос представления плагина, а переключатель для каждого плагина ограничивает его объявленными хостами.',
        'vi-VN': 'Plugin Navide: plugin nay có thể lưu khóa API của riêng nó trên máy tính này (được mã hóa, không bao giờ đồng bộ và không bao giờ trả về cho agent), khai báo máy chủ mạng và chương trình nó dùng, đăng ký sự kiện của Navide, thêm mục vào thanh trạng thái và menu chuột phải, chạy như một nút pipeline và gọi plugin khác. Thẻ cài đặt liệt kê từng mục trước khi bạn cài. Hoạt động ghi lại mọi yêu cầu mạng của giao diện plugin, và mỗi plugin có công tắc để chỉ cho phép các máy chủ đã khai báo.',
      },
      {
        'zh-TW': 'Token 面板：Tokens 分頁多了「日／週」切換和兩個新檢視。「依模型」顯示這個工作區每個模型的 token 和花費；「依帳號額度」顯示每個帳號的額度用量、每週重置時間和 7 天趨勢。Agent 用 `cli_token_stats` 加 `cost_by` 也能取得同樣的花費。沒有價格的模型顯示「—」，不會算成零。',
        'en-US': 'Token panel: the Tokens tab has a Day / Week switch and two new views. By model shows this workspace’s tokens and dollars per model; By account quota shows each account’s quota use, its weekly reset and a 7-day trend. Agents get the same costs from `cli_token_stats` with `cost_by`. A model without a price shows a dash, not zero.',
        'ja-JP': 'トークンパネル：「トークン」タブに日／週の切り替えと 2 つの新しいビューが加わりました。「モデル別」は、このワークスペースのモデルごとのトークン数と金額を表示し、「アカウントのクォータ別」は、各アカウントのクォータ使用量、週次のリセット時刻、7 日間の推移を表示します。エージェントは `cli_token_stats` に `cost_by` を付けると同じ費用を取得できます。価格のないモデルはゼロではなく「—」と表示されます。',
        'zh-CN': 'Token 面板：Tokens 标签页新增“日/周”切换和两个新视图。“按模型”显示这个工作区每个模型的 token 和费用；“按账号额度”显示每个账号的额度用量、每周重置时间和 7 天趋势。Agent 用 `cli_token_stats` 加 `cost_by` 也能获取同样的费用。没有价格的模型显示“—”，不会算作零。',
        'ko-KR': '토큰 패널: Token 탭에 일/주 전환과 새 보기 두 가지가 생겼습니다. 모델별은 이 워크스페이스의 모델별 토큰과 금액을, 계정 할당량별은 각 계정의 할당량 사용, 주간 초기화 시각, 7일 추이를 보여 줍니다. 에이전트는 `cli_token_stats`에 `cost_by`를 붙여 같은 비용을 받을 수 있습니다. 가격이 없는 모델은 0이 아니라 대시로 표시됩니다.',
        'es-ES': 'Panel de tokens: la pestaña Tokens tiene un selector Día / Semana y dos vistas nuevas. Por modelo muestra los tokens y dólares de este espacio de trabajo por modelo; Por cuota de cuenta muestra el uso de cuota de cada cuenta, su reinicio semanal y la tendencia de 7 días. Los agentes obtienen los mismos costes con `cli_token_stats` y `cost_by`. Un modelo sin precio muestra un guion, no cero.',
        'fr-FR': 'Panneau des tokens : l’onglet Tokens a un sélecteur Jour / Semaine et deux nouvelles vues. Par modèle montre les tokens et les dollars de cet espace de travail par modèle ; Par quota de compte montre l’usage du quota de chaque compte, sa réinitialisation hebdomadaire et la tendance sur 7 jours. Les agents obtiennent les mêmes coûts avec `cli_token_stats` et `cost_by`. Un modèle sans prix affiche un tiret, pas zéro.',
        'de-DE': 'Token-Panel: Der Tab Tokens hat einen Tag/Woche-Schalter und zwei neue Ansichten. Nach Modell zeigt Tokens und Dollar dieses Arbeitsbereichs pro Modell; Nach Kontokontingent zeigt die Kontingentnutzung jedes Kontos, die wöchentliche Zurücksetzung und den Verlauf über 7 Tage. Agenten erhalten dieselben Kosten über `cli_token_stats` mit `cost_by`. Ein Modell ohne Preis zeigt einen Strich, nicht null.',
        'pt-BR': 'Painel de tokens: a aba Tokens tem um seletor Dia / Semana e duas visões novas. Por modelo mostra os tokens e dólares deste ambiente de trabalho por modelo; Por cota da conta mostra o uso da cota de cada conta, o reinício semanal e a tendência de 7 dias. Os agentes obtêm os mesmos custos com `cli_token_stats` e `cost_by`. Um modelo sem preço mostra um traço, não zero.',
        'ru-RU': 'Панель токенов: на вкладке «Токены» появились переключатель «День / Неделя» и два новых вида. «По моделям» показывает токены и доллары этой рабочей области для каждой модели; «По квоте аккаунта» показывает расход квоты каждого аккаунта, его недельный сброс и динамику за 7 дней. Агенты получают те же расходы через `cli_token_stats` с `cost_by`. Модель без цены показывается прочерком, а не нулём.',
        'vi-VN': 'Bảng token: thẻ Token có công tắc Ngày / Tuần và hai chế độ xem mới. Theo mô hình hiển thị token và số tiền của không gian làm việc này cho từng mô hình; Theo hạn mức tài khoản hiển thị mức dùng hạn mức của từng tài khoản, thời điểm đặt lại hằng tuần và xu hướng 7 ngày. Agent lấy cùng chi phí qua `cli_token_stats` với `cost_by`. Mô hình chưa có giá hiển thị dấu gạch, không phải số không.',
      },
      {
        'zh-TW': 'Agent 與聊天室：OpenClaw、Hermes Agent 和 Devin 加入 ＋ 選單，選單也分成 CLI 和 Agent 兩區；這三者尚未在裝有它們的電腦上實測。Agent 可以透過 17 個新的 `channels_*` 工具操作聊天室：讀取直接回應，新增機器人、核准配對和多數綁定則要等你在「設定 → 聊天室」決定。機器人有 6 個以上時，「設定 → 聊天室」會出現搜尋框，每個機器人也會顯示狀態標記。',
        'en-US': 'Agents and Channels: OpenClaw, Hermes Agent and Devin are in the ＋ menu, now split into CLI and Agents; none of the three was tested on a machine that has it installed. Agents can work with Channels through 17 new `channels_*` tools: reads answer directly, while adding a bot, approving a pairing and most binds wait for your decision in Settings → Channels. With six or more bots, Settings → Channels has a search box and a status badge on each bot.',
        'ja-JP': 'エージェントとチャット連携：OpenClaw、Hermes Agent、Devin が ＋ メニューに加わり、メニューは CLI とエージェントの 2 つに分かれました。この 3 つは、インストール済みのマシンではまだ検証していません。エージェントは 17 個の新しい `channels_*` ツールでチャット連携を扱えます。読み取りはそのまま答えますが、ボットの追加、ペアリングの承認、ほとんどの紐づけは「設定 → チャット連携」であなたが決めるまで待ちます。ボットが 6 個以上あると、「設定 → チャット連携」に検索ボックスが表示され、各ボットに状態バッジが付きます。',
        'zh-CN': 'Agent 与聊天室：OpenClaw、Hermes Agent 和 Devin 加入 ＋ 菜单，菜单也分为 CLI 和 Agent 两区；这三者尚未在装有它们的电脑上实测。Agent 可以通过 17 个新的 `channels_*` 工具操作聊天室：读取直接响应，添加机器人、批准配对和多数绑定则要等你在“设置 → 聊天室”决定。机器人有 6 个以上时，“设置 → 聊天室”会出现搜索框，每个机器人也会显示状态标记。',
        'ko-KR': '에이전트와 채널: OpenClaw, Hermes Agent, Devin이 ＋ 메뉴에 추가되었고 메뉴는 CLI와 Agent로 나뉩니다. 세 가지 모두 설치된 컴퓨터에서 아직 검증하지 않았습니다. 에이전트는 새 `channels_*` 도구 17개로 채널을 다룰 수 있습니다. 읽기는 바로 응답하지만, 봇 추가, 페어링 승인, 대부분의 연결은 설정 → 채널에서 사용자가 결정할 때까지 기다립니다. 봇이 6개 이상이면 설정 → 채널에 검색 상자가 나타나고 각 봇에 상태 배지가 붙습니다.',
        'es-ES': 'Agentes y Channels: OpenClaw, Hermes Agent y Devin están en el menú ＋, ahora dividido en CLI y Agentes; ninguno de los tres se ha probado en un equipo que lo tenga instalado. Los agentes pueden trabajar con Channels mediante 17 herramientas `channels_*` nuevas: las lecturas responden al momento, mientras que añadir un bot, aprobar un emparejamiento y la mayoría de las vinculaciones esperan tu decisión en Ajustes → Channels. Con seis bots o más, Ajustes → Channels tiene un cuadro de búsqueda y una insignia de estado en cada bot.',
        'fr-FR': 'Agents et canaux : OpenClaw, Hermes Agent et Devin sont dans le menu ＋, désormais séparé en CLI et Agents ; aucun des trois n’a été testé sur une machine où il est installé. Les agents peuvent gérer les canaux avec 17 nouveaux outils `channels_*` : les lectures répondent directement, tandis qu’ajouter un bot, approuver un appairage et la plupart des liaisons attendent votre décision dans Réglages → Canaux. À partir de six bots, Réglages → Canaux propose une zone de recherche et un badge d’état sur chaque bot.',
        'de-DE': 'Agenten und Kanäle: OpenClaw, Hermes Agent und Devin stehen im ＋-Menü, das jetzt in CLI und Agenten geteilt ist; keiner der drei wurde auf einem Rechner getestet, auf dem er installiert ist. Agenten können Kanäle über 17 neue `channels_*`-Werkzeuge bedienen: Lesezugriffe antworten direkt, während das Hinzufügen eines Bots, das Genehmigen einer Kopplung und die meisten Verknüpfungen auf deine Entscheidung unter Einstellungen → Kanäle warten. Ab sechs Bots hat Einstellungen → Kanäle ein Suchfeld und an jedem Bot ein Status-Abzeichen.',
        'pt-BR': 'Agentes e canais: OpenClaw, Hermes Agent e Devin estão no menu ＋, agora dividido em CLI e Agentes; nenhum dos três foi testado num computador que o tenha instalado. Os agentes podem trabalhar com canais por meio de 17 novas ferramentas `channels_*`: leituras respondem na hora, enquanto adicionar um bot, aprovar um pareamento e a maioria das vinculações esperam sua decisão em Configurações → Canais. Com seis bots ou mais, Configurações → Canais ganha uma caixa de busca e um selo de status em cada bot.',
        'ru-RU': 'Агенты и каналы: OpenClaw, Hermes Agent и Devin появились в меню ＋, которое теперь разделено на CLI и агентов; ни один из трёх не проверялся на компьютере, где он установлен. Агенты могут работать с каналами через 17 новых инструментов `channels_*`: чтение отвечает сразу, а добавление бота, одобрение сопряжения и большинство привязок ждут вашего решения в разделе «Настройки → Каналы». Если ботов шесть или больше, в разделе «Настройки → Каналы» появляется поле поиска, а у каждого бота — значок состояния.',
        'vi-VN': 'Agent và kênh: OpenClaw, Hermes Agent và Devin có trong menu ＋, nay chia thành CLI và Agent; cả ba chưa được kiểm thử trên máy đã cài chúng. Agent có thể làm việc với kênh qua 17 công cụ `channels_*` mới: thao tác đọc trả lời ngay, còn thêm bot, phê duyệt ghép nối và phần lớn thao tác liên kết phải chờ bạn quyết định trong Cài đặt → Kênh. Khi có từ sáu bot trở lên, Cài đặt → Kênh có ô tìm kiếm và mỗi bot có huy hiệu trạng thái.',
      },
      {
        'zh-TW': '終端機分格：`cli_send` 和 `cli_open_agent` 支援 `submit: false`，會把指令填到 shell 的命令列但不按 Enter，由你檢查後自己執行。只讀取公鑰（例如 `~/.ssh/id_ed25519.pub`）不再被當成碰觸憑證；私鑰仍受保護。',
        'en-US': 'Terminal panes: `cli_send` and `cli_open_agent` take `submit: false`, which puts a command on the shell’s command line without pressing Enter, so you check it and run it yourself. Only reading a public key such as `~/.ssh/id_ed25519.pub` no longer counts as touching a credential; private keys are still protected.',
        'ja-JP': 'ターミナルペイン：`cli_send` と `cli_open_agent` が `submit: false` に対応しました。コマンドをシェルのコマンドラインに入れるだけで Enter は押さないので、内容を確認してから自分で実行できます。`~/.ssh/id_ed25519.pub` のような公開鍵を読むだけなら、認証情報に触れたとは見なされなくなりました。秘密鍵は引き続き保護されます。',
        'zh-CN': '终端分格：`cli_send` 和 `cli_open_agent` 支持 `submit: false`，会把命令填到 shell 的命令行但不按 Enter，由你检查后自己运行。只读取公钥（例如 `~/.ssh/id_ed25519.pub`）不再被视为触碰凭据；私钥仍受保护。',
        'ko-KR': '터미널 패널: `cli_send`와 `cli_open_agent`가 `submit: false`를 받습니다. 명령을 셸의 명령줄에 넣기만 하고 Enter는 누르지 않으므로, 직접 확인하고 실행하면 됩니다. `~/.ssh/id_ed25519.pub` 같은 공개 키를 읽기만 하는 것은 더 이상 자격 증명을 건드린 것으로 보지 않으며, 개인 키는 계속 보호됩니다.',
        'es-ES': 'Paneles de terminal: `cli_send` y `cli_open_agent` aceptan `submit: false`, que deja un comando en la línea de órdenes del shell sin pulsar Intro, para que lo revises y lo ejecutes tú. Solo leer una clave pública como `~/.ssh/id_ed25519.pub` ya no cuenta como tocar una credencial; las claves privadas siguen protegidas.',
        'fr-FR': 'Panneaux de terminal : `cli_send` et `cli_open_agent` acceptent `submit: false`, qui place une commande sur la ligne de commande du shell sans appuyer sur Entrée, pour que vous la vérifiiez et la lanciez vous-même. Lire seulement une clé publique comme `~/.ssh/id_ed25519.pub` ne compte plus comme toucher un identifiant ; les clés privées restent protégées.',
        'de-DE': 'Terminal-Bereiche: `cli_send` und `cli_open_agent` nehmen `submit: false` an, das einen Befehl in die Befehlszeile der Shell setzt, ohne Enter zu drücken, damit du ihn prüfst und selbst ausführst. Das bloße Lesen eines öffentlichen Schlüssels wie `~/.ssh/id_ed25519.pub` gilt nicht mehr als Zugriff auf Zugangsdaten; private Schlüssel bleiben geschützt.',
        'pt-BR': 'Painéis de terminal: `cli_send` e `cli_open_agent` aceitam `submit: false`, que coloca um comando na linha de comando do shell sem apertar Enter, para você conferir e executar. Apenas ler uma chave pública como `~/.ssh/id_ed25519.pub` não conta mais como mexer em uma credencial; as chaves privadas continuam protegidas.',
        'ru-RU': 'Панели терминала: `cli_send` и `cli_open_agent` принимают `submit: false`, который помещает команду в командную строку оболочки без нажатия Enter, чтобы вы проверили и запустили её сами. Простое чтение открытого ключа, например `~/.ssh/id_ed25519.pub`, больше не считается обращением к учётным данным; закрытые ключи по-прежнему защищены.',
        'vi-VN': 'Khung terminal: `cli_send` và `cli_open_agent` nhận `submit: false`, đặt lệnh lên dòng lệnh của shell mà không nhấn Enter, để bạn kiểm tra rồi tự chạy. Chỉ đọc khóa công khai như `~/.ssh/id_ed25519.pub` không còn bị coi là chạm vào thông tin xác thực; khóa riêng vẫn được bảo vệ.',
      },
      {
        'zh-TW': 'Navide Marketplace 搬到 marketplace.navide.dev，發佈與開發者後台搬到 developers.navide.dev。App 連線的 Registry 位址不變，已安裝的外掛簽章照常有效。外掛開發者在 App 和開發者網站都有一份入門步驟清單。',
        'en-US': 'Navide Marketplace moved to marketplace.navide.dev, and publishing and the developer dashboard to developers.navide.dev. The App talks to the same Registry address as before, and installed plugins keep their signatures. Plugin developers get a getting-started checklist in the App and on the developer site.',
        'ja-JP': 'Navide マーケットプレイスは marketplace.navide.dev に、公開と開発者ダッシュボードは developers.navide.dev に移転しました。App が接続する Registry のアドレスは変わらず、インストール済みプラグインの署名もそのまま有効です。プラグイン開発者向けに、App と開発者サイトの両方に入門手順のチェックリストを用意しました。',
        'zh-CN': 'Navide Marketplace 迁移到 marketplace.navide.dev，发布与开发者后台迁移到 developers.navide.dev。App 连接的 Registry 地址不变，已安装插件的签名照常有效。插件开发者在 App 和开发者网站都有一份入门步骤清单。',
        'ko-KR': 'Navide Marketplace는 marketplace.navide.dev로, 게시와 개발자 대시보드는 developers.navide.dev로 옮겼습니다. 앱은 이전과 같은 Registry 주소에 연결하며, 설치된 플러그인의 서명도 그대로 유효합니다. 플러그인 개발자는 앱과 개발자 사이트에서 시작 단계 체크리스트를 볼 수 있습니다.',
        'es-ES': 'Navide Marketplace se mudó a marketplace.navide.dev, y la publicación y el panel de desarrolladores a developers.navide.dev. La aplicación sigue usando la misma dirección del Registry, y los complementos instalados conservan sus firmas. Los desarrolladores de complementos tienen una lista de primeros pasos en la aplicación y en el sitio para desarrolladores.',
        'fr-FR': 'Navide Marketplace a déménagé sur marketplace.navide.dev, et la publication ainsi que le tableau de bord développeur sur developers.navide.dev. L’application utilise la même adresse de Registry qu’avant, et les plugins installés gardent leurs signatures. Les développeurs de plugins disposent d’une liste de premiers pas dans l’application et sur le site développeur.',
        'de-DE': 'Navide Marketplace ist nach marketplace.navide.dev umgezogen, Veröffentlichen und das Entwickler-Dashboard nach developers.navide.dev. Die App nutzt dieselbe Registry-Adresse wie zuvor, und installierte Plug-ins behalten ihre Signaturen. Plug-in-Entwickler finden eine Checkliste für den Einstieg in der App und auf der Entwicklerseite.',
        'pt-BR': 'O Navide Marketplace mudou para marketplace.navide.dev, e a publicação e o painel do desenvolvedor para developers.navide.dev. O app usa o mesmo endereço do Registry de antes, e os plug-ins instalados mantêm suas assinaturas. Desenvolvedores de plug-ins ganham uma lista de primeiros passos no app e no site de desenvolvedores.',
        'ru-RU': 'Navide Marketplace переехал на marketplace.navide.dev, а публикация и панель разработчика — на developers.navide.dev. Приложение обращается к тому же адресу Registry, что и раньше, и установленные плагины сохраняют подписи. Разработчики плагинов получают список первых шагов в приложении и на сайте для разработчиков.',
        'vi-VN': 'Navide Marketplace đã chuyển sang marketplace.navide.dev, còn phát hành và bảng điều khiển nhà phát triển chuyển sang developers.navide.dev. Ứng dụng vẫn dùng cùng địa chỉ Registry như trước, và plugin đã cài vẫn giữ chữ ký. Nhà phát triển plugin có danh sách các bước bắt đầu trong ứng dụng và trên trang dành cho nhà phát triển.',
      },
      {
        'zh-TW': '修正：連續執行好幾天的 Navide，後端檔案不會再被系統的暫存清理刪掉（之前會讓新的 MCP 工作階段一直失敗，直到重新啟動）。CPU 全滿時 Pipeline 也能可靠開跑；資料夾中文名稱字數相同的兩個工作區，不會再互相算到對方的 Claude 用量；中文介面一律把 pane 稱為「分格」。',
        'en-US': 'Fixes: a Navide left running for days no longer loses parts of its backend to the system’s temp cleaner, which had made every new MCP session fail until a restart. Pipelines start reliably on a fully busy computer, two workspaces whose Chinese folder names have the same length no longer count each other’s Claude usage, and the Chinese interface calls a pane 分格 everywhere.',
        'ja-JP': '修正：何日も動かしている Navide で、バックエンドのファイルがシステムの一時ファイル掃除に消されることはなくなりました（以前は再起動するまで新しい MCP セッションがすべて失敗していました）。CPU が埋まっていてもパイプラインが確実に始まり、中国語のフォルダー名の文字数が同じ 2 つのワークスペースが互いの Claude の使用量を数えることもなくなりました。中国語の画面では、ペインを一貫して「分格」と呼びます。',
        'zh-CN': '修复：连续运行好几天的 Navide，后端文件不会再被系统的临时文件清理删掉（之前会让新的 MCP 会话一直失败，直到重新启动）。CPU 全满时 Pipeline 也能可靠启动；文件夹中文名称字数相同的两个工作区，不会再互相算到对方的 Claude 用量；中文界面一律把 pane 称为“分格”。',
        'ko-KR': '수정: 며칠씩 켜 둔 Navide에서 백엔드 파일 일부가 시스템의 임시 파일 정리로 지워지는 일이 없어졌습니다(이전에는 다시 시작할 때까지 새 MCP 세션이 모두 실패했습니다). CPU가 꽉 찬 컴퓨터에서도 파이프라인이 안정적으로 시작되고, 중국어 폴더 이름의 글자 수가 같은 두 워크스페이스가 서로의 Claude 사용량을 세지 않으며, 중국어 화면은 패널을 모두 「分格」로 부릅니다.',
        'es-ES': 'Correcciones: un Navide que lleva días abierto ya no pierde partes de su backend por el limpiador de temporales del sistema, que hacía fallar cada nueva sesión MCP hasta reiniciar. Los pipelines arrancan con fiabilidad en un equipo totalmente ocupado, dos espacios de trabajo cuyas carpetas tienen nombres chinos de la misma longitud ya no cuentan el uso de Claude del otro, y la interfaz en chino llama 分格 al panel en todas partes.',
        'fr-FR': 'Corrections : un Navide ouvert depuis des jours ne perd plus de morceaux de son backend à cause du nettoyage des fichiers temporaires du système, qui faisait échouer toute nouvelle session MCP jusqu’au redémarrage. Les pipelines démarrent de façon fiable sur un ordinateur saturé, deux espaces de travail dont les dossiers ont des noms chinois de même longueur ne comptent plus l’usage Claude de l’autre, et l’interface chinoise appelle partout un panneau 分格.',
        'de-DE': 'Korrekturen: Ein seit Tagen laufendes Navide verliert keine Teile seines Backends mehr an die Temp-Bereinigung des Systems, die bis zum Neustart jede neue MCP-Sitzung scheitern ließ. Pipelines starten zuverlässig auf einem voll ausgelasteten Rechner, zwei Arbeitsbereiche, deren chinesische Ordnernamen gleich lang sind, zählen nicht mehr gegenseitig ihre Claude-Nutzung, und die chinesische Oberfläche nennt einen Bereich überall 分格.',
        'pt-BR': 'Correções: um Navide aberto há dias não perde mais partes do backend para a limpeza de temporários do sistema, que fazia toda nova sessão MCP falhar até reiniciar. Os pipelines iniciam de forma confiável num computador totalmente ocupado, dois ambientes de trabalho cujas pastas têm nomes chineses do mesmo tamanho não contam mais o uso de Claude um do outro, e a interface em chinês chama o painel de 分格 em todo lugar.',
        'ru-RU': 'Исправления: Navide, работающий несколько дней, больше не теряет части бэкенда из-за системной очистки временных файлов, из-за которой каждый новый сеанс MCP не запускался до перезапуска. Пайплайны надёжно стартуют на полностью загруженном компьютере, две рабочие области с китайскими именами папок одинаковой длины больше не считают чужое использование Claude, а китайский интерфейс везде называет панель 分格.',
        'vi-VN': 'Sửa lỗi: Navide chạy nhiều ngày không còn bị trình dọn tệp tạm của hệ thống xóa mất một phần backend, điều từng khiến mọi phiên MCP mới thất bại cho đến khi khởi động lại. Pipeline khởi chạy ổn định trên máy bận hết CPU, hai không gian làm việc có tên thư mục tiếng Trung cùng độ dài không còn đếm lượng dùng Claude của nhau, và giao diện tiếng Trung thống nhất gọi khung là 分格.',
      },
    ],
  },
  {
    version: '0.2.38',
    title: {
      'zh-TW': 'Agent 讀網頁更省 token、Git 程序大幅減少，Telegram 回覆更快',
      'en-US': 'Lighter Browser Snapshots for Agents, Far Fewer Git Processes and Faster Telegram Replies',
      'ja-JP': 'エージェントのページ読み取りがより軽く、Git プロセスが大幅に減り、Telegram の返信がより速く',
      'zh-CN': 'Agent 读网页更省 token、Git 进程大幅减少，Telegram 回复更快',
      'ko-KR': '에이전트의 더 가벼운 브라우저 스냅샷, 크게 줄어든 Git 프로세스, 더 빠른 Telegram 답장',
      'es-ES': 'Instantáneas del navegador más ligeras para los agentes, muchos menos procesos de Git y respuestas de Telegram más rápidas',
      'fr-FR': 'Des instantanés de navigateur plus légers pour les agents, bien moins de processus Git et des réponses Telegram plus rapides',
      'de-DE': 'Schlankere Browser-Snapshots für Agenten, weit weniger Git-Prozesse und schnellere Telegram-Antworten',
      'pt-BR': 'Snapshots do navegador mais leves para agentes, muito menos processos do Git e respostas do Telegram mais rápidas',
      'ru-RU': 'Более лёгкие снимки страниц для агентов, гораздо меньше процессов Git и более быстрые ответы в Telegram',
      'vi-VN': 'Ảnh chụp trang nhẹ hơn cho agent, ít tiến trình Git hơn hẳn và trả lời Telegram nhanh hơn',
    },
    highlights: [
      {
        'zh-TW': 'Navide Browser：`browser_snapshot` 加上 `filter: "interactive"` 只列出控制項、標題和頁面區塊，`root` 可以只展開某一個元素。`browser_act` 加上 `diff: true` 只回傳動作後有變化的部分。在 Wikipedia、MDN、GitHub 和 Hacker News 上，快照小了 65–87%。不用這些新選項時，回應和以前完全相同。Navide Browser 1.1.0。',
        'en-US': 'Navide Browser: `browser_snapshot` with `filter: "interactive"` lists only controls, headings and landmarks, and `root` expands a single element. `browser_act` with `diff: true` returns only what changed after the action. On Wikipedia, MDN, GitHub and Hacker News, snapshots shrank by 65–87%. Without the new options every answer is the same as before. Navide Browser 1.1.0.',
        'ja-JP': 'Navide Browser：`browser_snapshot` に `filter: "interactive"` を付けると、操作できる要素、見出し、ランドマークだけを一覧にし、`root` で 1 つの要素だけを展開できます。`browser_act` に `diff: true` を付けると、操作後に変わった部分だけを返します。Wikipedia、MDN、GitHub、Hacker News では、スナップショットが 65～87% 小さくなりました。新しいオプションを使わなければ、応答は以前とまったく同じです。Navide Browser 1.1.0。',
        'zh-CN': 'Navide Browser：`browser_snapshot` 加上 `filter: "interactive"` 只列出控件、标题和页面区块，`root` 可以只展开某一个元素。`browser_act` 加上 `diff: true` 只返回操作后有变化的部分。在 Wikipedia、MDN、GitHub 和 Hacker News 上，快照小了 65–87%。不用这些新选项时，响应和以前完全相同。Navide Browser 1.1.0。',
        'ko-KR': 'Navide Browser: `browser_snapshot`에 `filter: "interactive"`를 주면 컨트롤, 제목, 랜드마크만 나열하고, `root`로 요소 하나만 펼칠 수 있습니다. `browser_act`에 `diff: true`를 주면 동작 후 바뀐 부분만 돌려줍니다. Wikipedia, MDN, GitHub, Hacker News에서 스냅샷이 65–87% 줄었습니다. 새 옵션을 쓰지 않으면 모든 응답은 이전과 같습니다. Navide Browser 1.1.0.',
        'es-ES': 'Navide Browser: `browser_snapshot` con `filter: "interactive"` lista solo controles, encabezados y regiones, y `root` expande un solo elemento. `browser_act` con `diff: true` devuelve solo lo que cambió tras la acción. En Wikipedia, MDN, GitHub y Hacker News, las instantáneas se redujeron entre un 65 y un 87 %. Sin las opciones nuevas, todas las respuestas son iguales que antes. Navide Browser 1.1.0.',
        'fr-FR': 'Navide Browser : `browser_snapshot` avec `filter: "interactive"` ne liste que les contrôles, les titres et les repères, et `root` déplie un seul élément. `browser_act` avec `diff: true` ne renvoie que ce qui a changé après l’action. Sur Wikipedia, MDN, GitHub et Hacker News, les instantanés ont diminué de 65 à 87 %. Sans les nouvelles options, chaque réponse est identique à avant. Navide Browser 1.1.0.',
        'de-DE': 'Navide Browser: `browser_snapshot` mit `filter: "interactive"` listet nur Bedienelemente, Überschriften und Landmarks, und `root` klappt ein einzelnes Element auf. `browser_act` mit `diff: true` liefert nur, was sich nach der Aktion geändert hat. Auf Wikipedia, MDN, GitHub und Hacker News wurden Snapshots um 65–87 % kleiner. Ohne die neuen Optionen ist jede Antwort wie bisher. Navide Browser 1.1.0.',
        'pt-BR': 'Navide Browser: `browser_snapshot` com `filter: "interactive"` lista só controles, títulos e regiões, e `root` expande um único elemento. `browser_act` com `diff: true` devolve só o que mudou após a ação. Na Wikipedia, MDN, GitHub e Hacker News, os snapshots encolheram de 65 a 87%. Sem as novas opções, toda resposta é igual a antes. Navide Browser 1.1.0.',
        'ru-RU': 'Navide Browser: `browser_snapshot` с `filter: "interactive"` перечисляет только элементы управления, заголовки и ориентиры, а `root` раскрывает один элемент. `browser_act` с `diff: true` возвращает только то, что изменилось после действия. На Wikipedia, MDN, GitHub и Hacker News снимки уменьшились на 65–87 %. Без новых параметров все ответы такие же, как раньше. Navide Browser 1.1.0.',
        'vi-VN': 'Navide Browser: `browser_snapshot` với `filter: "interactive"` chỉ liệt kê các điều khiển, tiêu đề và vùng mốc, còn `root` mở rộng một phần tử duy nhất. `browser_act` với `diff: true` chỉ trả về phần thay đổi sau thao tác. Trên Wikipedia, MDN, GitHub và Hacker News, ảnh chụp nhỏ đi 65–87%. Không dùng các tùy chọn mới thì mọi câu trả lời vẫn như trước. Navide Browser 1.1.0.',
      },
      {
        'zh-TW': 'Git：工作區設在家目錄時，不會再引發一大串 git 程序。在 Windows 上，不是 repository 的資料夾不會再讓 Navide 每分鐘跑約 1,000 個 git 程序；Navide 監看 repository 時，git 指令也不會再讓系統記憶體一直增加。舊版已經吃掉的記憶體要重新啟動 Windows 才會釋放。',
        'en-US': 'Git: a workspace set to your home folder no longer sets off a storm of git processes. On Windows, a folder that is not a repository no longer makes Navide run about 1,000 git processes a minute, and git commands no longer make the system’s memory grow while Navide watches a repository. Memory an earlier version already took is released only when Windows restarts.',
        'ja-JP': 'Git：ワークスペースをホームフォルダーにしても、大量の git プロセスが起動しなくなりました。Windows では、リポジトリではないフォルダーで Navide が毎分約 1,000 個の git プロセスを動かすことはなくなり、Navide がリポジトリを監視している間に git コマンドでシステムのメモリが増え続けることもなくなりました。以前のバージョンですでに使われたメモリは、Windows を再起動するまで解放されません。',
        'zh-CN': 'Git：工作区设在主目录时，不会再引发一大串 git 进程。在 Windows 上，不是 repository 的文件夹不会再让 Navide 每分钟运行约 1,000 个 git 进程；Navide 监视 repository 时，git 命令也不会再让系统内存持续增加。旧版已经占用的内存要重启 Windows 才会释放。',
        'ko-KR': 'Git: 워크스페이스를 홈 폴더로 지정해도 git 프로세스가 폭주하지 않습니다. Windows에서 저장소가 아닌 폴더 때문에 Navide가 분당 약 1,000개의 git 프로세스를 실행하는 일이 없어졌고, Navide가 저장소를 지켜보는 동안 git 명령 때문에 시스템 메모리가 계속 늘지도 않습니다. 이전 버전이 이미 차지한 메모리는 Windows를 다시 시작해야 해제됩니다.',
        'es-ES': 'Git: un espacio de trabajo en tu carpeta personal ya no desata una avalancha de procesos de git. En Windows, una carpeta que no es un repositorio ya no hace que Navide ejecute unos 1.000 procesos de git por minuto, y los comandos de git ya no hacen crecer la memoria del sistema mientras Navide vigila un repositorio. La memoria que una versión anterior ya ocupó solo se libera al reiniciar Windows.',
        'fr-FR': 'Git : un espace de travail placé sur votre dossier personnel ne déclenche plus une avalanche de processus git. Sous Windows, un dossier qui n’est pas un dépôt ne fait plus lancer à Navide environ 1 000 processus git par minute, et les commandes git ne font plus grossir la mémoire du système pendant que Navide surveille un dépôt. La mémoire déjà prise par une version précédente n’est libérée qu’au redémarrage de Windows.',
        'de-DE': 'Git: Ein Arbeitsbereich im Home-Ordner löst keine Flut von Git-Prozessen mehr aus. Unter Windows lässt ein Ordner, der kein Repository ist, Navide nicht mehr etwa 1.000 Git-Prozesse pro Minute starten, und Git-Befehle lassen den Systemspeicher nicht mehr wachsen, während Navide ein Repository beobachtet. Speicher, den eine frühere Version schon belegt hat, wird erst mit einem Windows-Neustart frei.',
        'pt-BR': 'Git: um ambiente de trabalho na sua pasta pessoal não dispara mais uma enxurrada de processos do git. No Windows, uma pasta que não é repositório não faz mais o Navide rodar cerca de 1.000 processos do git por minuto, e os comandos do git não fazem mais a memória do sistema crescer enquanto o Navide observa um repositório. A memória que uma versão anterior já ocupou só é liberada ao reiniciar o Windows.',
        'ru-RU': 'Git: рабочая область в домашней папке больше не вызывает лавину процессов git. В Windows папка, которая не является репозиторием, больше не заставляет Navide запускать около 1000 процессов git в минуту, а команды git больше не увеличивают системную память, пока Navide следит за репозиторием. Память, уже занятую предыдущей версией, освобождает только перезагрузка Windows.',
        'vi-VN': 'Git: không gian làm việc đặt ở thư mục chính không còn gây ra hàng loạt tiến trình git. Trên Windows, thư mục không phải kho mã không còn khiến Navide chạy khoảng 1.000 tiến trình git mỗi phút, và lệnh git không còn làm bộ nhớ hệ thống tăng dần khi Navide theo dõi một kho mã. Bộ nhớ mà phiên bản cũ đã chiếm chỉ được giải phóng khi khởi động lại Windows.',
      },
      {
        'zh-TW': 'Telegram：Claude Code 分格的回覆會在回合結束的當下送出，不必等對話紀錄讀完；在負載重的電腦上，那一段等待曾經長達好幾分鐘，有時回覆還會遺失。喚醒一個視窗已經關掉的分格，現在會把它重新開啟。',
        'en-US': 'Telegram: a reply from a Claude Code pane is posted the moment its turn ends, instead of waiting for the conversation log to be read, which on a loaded computer took minutes and sometimes lost the reply. Waking a pane whose window had closed now opens it again.',
        'ja-JP': 'Telegram：Claude Code ペインの返信は、会話ログの読み取りを待たずに、ターンが終わった時点で送られるようになりました。負荷の高いコンピューターでは、この待ちが数分に及び、返信が失われることもありました。ウィンドウが閉じたペインを起こすと、ペインを開き直すようになりました。',
        'zh-CN': 'Telegram：Claude Code 分格的回复会在回合结束的当下发出，不必等对话记录读完；在负载重的电脑上，那段等待曾经长达好几分钟，有时回复还会丢失。唤醒一个窗口已经关闭的分格，现在会把它重新打开。',
        'ko-KR': 'Telegram: Claude Code 패널의 답장은 대화 기록을 읽을 때까지 기다리지 않고 턴이 끝나는 즉시 게시됩니다. 부하가 큰 컴퓨터에서는 이 대기가 몇 분씩 걸리고 답장이 사라지기도 했습니다. 창이 닫힌 패널을 깨우면 이제 다시 엽니다.',
        'es-ES': 'Telegram: la respuesta de un panel de Claude Code se publica en cuanto termina su turno, sin esperar a que se lea el registro de la conversación, algo que en un equipo cargado tardaba minutos y a veces perdía la respuesta. Despertar un panel cuya ventana se cerró ahora lo vuelve a abrir.',
        'fr-FR': 'Telegram : la réponse d’un panneau Claude Code est publiée dès la fin de son tour, sans attendre la lecture du journal de conversation, qui sur un ordinateur chargé prenait des minutes et perdait parfois la réponse. Réveiller un panneau dont la fenêtre a été fermée le rouvre désormais.',
        'de-DE': 'Telegram: Die Antwort eines Claude-Code-Bereichs wird gepostet, sobald sein Durchgang endet, statt auf das Lesen des Gesprächsprotokolls zu warten, was auf einem ausgelasteten Rechner Minuten dauerte und die Antwort manchmal verlor. Einen Bereich aufzuwecken, dessen Fenster geschlossen wurde, öffnet ihn jetzt wieder.',
        'pt-BR': 'Telegram: a resposta de um painel do Claude Code é publicada assim que o turno termina, sem esperar a leitura do registro da conversa, que num computador sobrecarregado levava minutos e às vezes perdia a resposta. Acordar um painel cuja janela foi fechada agora o abre de novo.',
        'ru-RU': 'Telegram: ответ панели Claude Code отправляется сразу по окончании хода, не дожидаясь чтения журнала разговора, которое на загруженном компьютере занимало минуты и иногда теряло ответ. Пробуждение панели, окно которой закрыто, теперь снова её открывает.',
        'vi-VN': 'Telegram: câu trả lời từ khung Claude Code được gửi ngay khi lượt kết thúc, thay vì chờ đọc nhật ký hội thoại, việc mà trên máy tải nặng từng mất vài phút và đôi khi làm mất câu trả lời. Đánh thức khung có cửa sổ đã đóng nay sẽ mở lại nó.',
      },
      {
        'zh-TW': 'Token：Codex 的用量不再把快取輸入和推理輸出重複計算。新的用量只算一次；更新前記下的總數不會重算，所以仍然偏高。',
        'en-US': 'Tokens: Codex usage no longer counts cached input and reasoning output twice. New usage is counted once; totals recorded before the update are not recalculated, so they stay too high.',
        'ja-JP': 'トークン：Codex の使用量で、キャッシュされた入力と推論の出力を二重に数えなくなりました。新しい使用量は 1 回だけ数えます。更新前に記録された合計は再計算されないため、高いままです。',
        'zh-CN': 'Token：Codex 的用量不再把缓存输入和推理输出重复计算。新的用量只算一次；更新前记录的总数不会重算，所以仍然偏高。',
        'ko-KR': '토큰: Codex 사용량에서 캐시된 입력과 추론 출력을 두 번 세지 않습니다. 새 사용량은 한 번만 셉니다. 업데이트 전에 기록된 합계는 다시 계산하지 않으므로 여전히 높게 나옵니다.',
        'es-ES': 'Tokens: el uso de Codex ya no cuenta dos veces la entrada en caché ni la salida de razonamiento. El uso nuevo se cuenta una vez; los totales registrados antes de la actualización no se recalculan, así que siguen siendo demasiado altos.',
        'fr-FR': 'Tokens : l’usage de Codex ne compte plus deux fois l’entrée en cache et la sortie de raisonnement. Le nouvel usage est compté une fois ; les totaux enregistrés avant la mise à jour ne sont pas recalculés et restent donc trop élevés.',
        'de-DE': 'Tokens: Die Codex-Nutzung zählt zwischengespeicherte Eingaben und Reasoning-Ausgaben nicht mehr doppelt. Neue Nutzung wird einmal gezählt; vor dem Update erfasste Summen werden nicht neu berechnet und bleiben daher zu hoch.',
        'pt-BR': 'Tokens: o uso do Codex não conta mais duas vezes a entrada em cache e a saída de raciocínio. O uso novo é contado uma vez; os totais registrados antes da atualização não são recalculados e continuam altos demais.',
        'ru-RU': 'Токены: использование Codex больше не учитывает дважды кэшированный ввод и вывод рассуждений. Новое использование считается один раз; итоги, записанные до обновления, не пересчитываются и остаются завышенными.',
        'vi-VN': 'Token: mức dùng Codex không còn tính hai lần đầu vào đã lưu đệm và đầu ra suy luận. Mức dùng mới chỉ được tính một lần; tổng đã ghi trước khi cập nhật không được tính lại nên vẫn cao hơn thực tế.',
      },
      {
        'zh-TW': '修正：在 Windows 上，使用者名稱無法用系統字碼頁表示時（例如英文版 Windows 上的中文名稱），Navide 現在能正常啟動。Agent 自己開始新回合時，STOP 標記會消失；Navide 放棄輸入的訊息不會再殘留在輸入框；任務晚幾秒才出現時，`cli_open_agent` 不會再誤報失敗。',
        'en-US': 'Fixes: on Windows, Navide now starts for a user whose name the system’s code page cannot write, such as a Chinese name on an English Windows. The STOP badge clears when the agent starts its next turn on its own, a message Navide gives up typing no longer leaves part of itself in the input box, and `cli_open_agent` no longer reports a task as failed when it showed up a few seconds late.',
        'ja-JP': '修正：Windows で、ユーザー名をシステムのコードページで表せない場合（英語版 Windows で中国語の名前など）でも Navide が起動するようになりました。エージェントが自分で次のターンを始めると STOP バッジが消え、Navide が入力をあきらめたメッセージが入力欄に残ることもなくなりました。タスクの表示が数秒遅れても、`cli_open_agent` が失敗と報告することはなくなりました。',
        'zh-CN': '修复：在 Windows 上，用户名无法用系统代码页表示时（例如英文版 Windows 上的中文名称），Navide 现在能正常启动。Agent 自己开始新回合时，STOP 标记会消失；Navide 放弃输入的消息不会再残留在输入框；任务晚几秒才出现时，`cli_open_agent` 不会再误报失败。',
        'ko-KR': '수정: Windows에서 시스템 코드 페이지로 쓸 수 없는 사용자 이름(영어판 Windows의 중국어 이름 등)이어도 Navide가 시작됩니다. 에이전트가 스스로 다음 턴을 시작하면 STOP 배지가 사라지고, Navide가 입력을 포기한 메시지가 입력란에 남지 않으며, 작업이 몇 초 늦게 나타나도 `cli_open_agent`가 실패로 보고하지 않습니다.',
        'es-ES': 'Correcciones: en Windows, Navide ahora arranca para un usuario cuyo nombre no puede escribir la página de códigos del sistema, como un nombre chino en un Windows en inglés. La insignia STOP desaparece cuando el agente empieza solo su siguiente turno, un mensaje que Navide deja de escribir ya no deja restos en el cuadro de entrada, y `cli_open_agent` ya no da por fallida una tarea que apareció unos segundos tarde.',
        'fr-FR': 'Corrections : sous Windows, Navide démarre désormais pour un utilisateur dont le nom ne s’écrit pas dans la page de codes du système, comme un nom chinois sur un Windows anglais. Le badge STOP disparaît quand l’agent commence seul son tour suivant, un message que Navide renonce à taper ne laisse plus de reste dans la zone de saisie, et `cli_open_agent` ne signale plus en échec une tâche apparue quelques secondes plus tard.',
        'de-DE': 'Korrekturen: Unter Windows startet Navide jetzt für einen Benutzer, dessen Name die Codepage des Systems nicht darstellen kann, etwa ein chinesischer Name auf einem englischen Windows. Das STOP-Abzeichen verschwindet, wenn der Agent von sich aus den nächsten Durchgang beginnt, eine Nachricht, deren Eingabe Navide aufgibt, hinterlässt keine Reste mehr im Eingabefeld, und `cli_open_agent` meldet eine Aufgabe nicht mehr als fehlgeschlagen, wenn sie ein paar Sekunden später erscheint.',
        'pt-BR': 'Correções: no Windows, o Navide agora inicia para um usuário cujo nome a página de código do sistema não consegue escrever, como um nome chinês num Windows em inglês. O selo STOP some quando o agente começa sozinho o próximo turno, uma mensagem que o Navide desiste de digitar não deixa mais restos na caixa de entrada, e `cli_open_agent` não informa mais como falha uma tarefa que apareceu alguns segundos depois.',
        'ru-RU': 'Исправления: в Windows Navide теперь запускается у пользователя, чьё имя нельзя записать в системной кодовой странице, например китайское имя в английской Windows. Значок STOP исчезает, когда агент сам начинает следующий ход, сообщение, которое Navide перестал вводить, больше не оставляет хвост в поле ввода, а `cli_open_agent` больше не сообщает о сбое задачи, появившейся на несколько секунд позже.',
        'vi-VN': 'Sửa lỗi: trên Windows, Navide nay khởi động được với người dùng có tên mà bảng mã của hệ thống không viết được, như tên tiếng Trung trên Windows tiếng Anh. Huy hiệu STOP biến mất khi agent tự bắt đầu lượt tiếp theo, tin nhắn mà Navide bỏ dở không còn để lại phần thừa trong ô nhập, và `cli_open_agent` không còn báo thất bại khi tác vụ xuất hiện trễ vài giây.',
      },
    ],
  },
  {
    version: '0.2.37',
    title: {
      'zh-TW': 'Webhook 可以啟動 Pipeline、聊天室設定改成兩欄，Pipeline 執行更穩定',
      'en-US': 'Webhooks Start Pipelines, a Two-Column Channels Page and Steadier Pipeline Runs',
      'ja-JP': 'Webhook でパイプラインを開始、2 列になったチャット連携の設定、より安定したパイプライン実行',
      'zh-CN': 'Webhook 可以启动 Pipeline、聊天室设置改为两栏，Pipeline 运行更稳定',
      'ko-KR': 'Webhook으로 파이프라인 시작, 두 칸으로 바뀐 채널 설정, 더 안정적인 파이프라인 실행',
      'es-ES': 'Los webhooks inician pipelines, una página de Channels a dos columnas y ejecuciones más estables',
      'fr-FR': 'Les webhooks lancent des pipelines, une page Canaux en deux colonnes et des exécutions plus stables',
      'de-DE': 'Webhooks starten Pipelines, eine zweispaltige Kanäle-Seite und stabilere Pipeline-Läufe',
      'pt-BR': 'Webhooks iniciam pipelines, uma página de Canais em duas colunas e execuções mais estáveis',
      'ru-RU': 'Вебхуки запускают пайплайны, страница каналов в две колонки и более стабильные запуски',
      'vi-VN': 'Webhook khởi chạy pipeline, trang Kênh hai cột và pipeline chạy ổn định hơn',
    },
    highlights: [
      {
        'zh-TW': 'Webhook：Webhook 可以啟動 Pipeline，來源可以是有簽章的 GitHub 事件，或你設定的表單頁。預設關閉，要在「設定 → Webhook」開啟，那裡也會顯示每個觸發器的活動。表單預設只有這台電腦連得到，勾選公開才對外。Webhook 執行的分格每次呼叫工具前都會先問你，除非你替該觸發器開啟無人值守；App 上鎖時不會開始執行。這一版 Webhook 只支援 Claude Code。',
        'en-US': 'Webhooks: a webhook can start a pipeline, from a signed GitHub delivery or from a form page you set up. It is off by default; turn it on in Settings → Webhooks, which also shows each trigger’s activity. A form is reachable from this computer only unless you make it public. A webhook run’s panes ask before every tool call unless you turn on unattended for that trigger, and no run starts while App Lock is on. Webhook runs use Claude Code only in this version.',
        'ja-JP': 'Webhook：署名付きの GitHub イベントや、自分で用意したフォームページから、Webhook でパイプラインを開始できるようになりました。既定ではオフで、「設定 → Webhook」でオンにします。各トリガーのアクティビティもそこに表示されます。フォームは公開にしない限り、このコンピューターからしか開けません。Webhook の実行で開くペインは、そのトリガーで無人実行をオンにしない限り、ツールを呼び出すたびに確認します。App Lock 中は実行が始まりません。このバージョンの Webhook は Claude Code のみに対応しています。',
        'zh-CN': 'Webhook：Webhook 可以启动 Pipeline，来源可以是带签名的 GitHub 事件，或你设置的表单页。默认关闭，需在“设置 → Webhook”开启，那里也会显示每个触发器的活动。表单默认只有这台电脑能访问，勾选公开才对外开放。Webhook 运行的分格每次调用工具前都会先询问你，除非你为该触发器开启无人值守；App 上锁时不会开始运行。这一版 Webhook 只支持 Claude Code。',
        'ko-KR': 'Webhook: 서명된 GitHub 이벤트나 직접 만든 양식 페이지로 Webhook이 파이프라인을 시작할 수 있습니다. 기본값은 꺼짐이며 설정 → Webhook에서 켜고, 각 트리거의 활동도 그곳에서 볼 수 있습니다. 양식은 공개로 설정하지 않으면 이 컴퓨터에서만 열립니다. Webhook 실행의 패널은 해당 트리거에서 무인 실행을 켜지 않는 한 도구를 호출할 때마다 먼저 묻고, App Lock이 켜져 있으면 실행이 시작되지 않습니다. 이번 버전의 Webhook 실행은 Claude Code만 사용합니다.',
        'es-ES': 'Webhooks: un webhook puede iniciar un pipeline, desde una entrega firmada de GitHub o desde una página de formulario que configures. Viene desactivado; actívalo en Ajustes → Webhooks, donde también ves la actividad de cada disparador. Un formulario solo es accesible desde este ordenador salvo que lo hagas público. Los paneles de una ejecución por webhook preguntan antes de cada llamada a herramienta salvo que actives el modo desatendido para ese disparador, y ninguna ejecución empieza con App Lock activado. En esta versión, las ejecuciones por webhook solo usan Claude Code.',
        'fr-FR': 'Webhooks : un webhook peut lancer un pipeline, depuis une livraison GitHub signée ou une page de formulaire que vous configurez. C’est désactivé par défaut ; activez-le dans Réglages → Webhooks, qui montre aussi l’activité de chaque déclencheur. Un formulaire n’est joignable que depuis cet ordinateur, sauf si vous le rendez public. Les panneaux d’une exécution par webhook demandent avant chaque appel d’outil, sauf si vous activez le mode sans surveillance pour ce déclencheur, et aucune exécution ne démarre quand App Lock est actif. Dans cette version, les exécutions par webhook n’utilisent que Claude Code.',
        'de-DE': 'Webhooks: Ein Webhook kann eine Pipeline starten, über eine signierte GitHub-Zustellung oder eine Formularseite, die du einrichtest. Standardmäßig aus; einschalten unter Einstellungen → Webhooks, wo auch die Aktivität jedes Auslösers steht. Ein Formular ist nur von diesem Computer aus erreichbar, außer du machst es öffentlich. Die Bereiche eines Webhook-Laufs fragen vor jedem Werkzeugaufruf, außer du schaltest für diesen Auslöser den unbeaufsichtigten Modus ein, und bei aktivem App Lock startet kein Lauf. Webhook-Läufe nutzen in dieser Version nur Claude Code.',
        'pt-BR': 'Webhooks: um webhook pode iniciar um pipeline, a partir de uma entrega assinada do GitHub ou de uma página de formulário que você configura. Vem desligado; ligue em Configurações → Webhooks, que também mostra a atividade de cada gatilho. Um formulário só é acessível deste computador, a menos que você o torne público. Os painéis de uma execução por webhook perguntam antes de cada chamada de ferramenta, a menos que você ligue o modo sem supervisão para esse gatilho, e nenhuma execução começa com o App Lock ativo. Nesta versão, execuções por webhook usam apenas o Claude Code.',
        'ru-RU': 'Вебхуки: вебхук может запустить пайплайн по подписанному событию GitHub или из страницы с формой, которую вы настроите. По умолчанию выключено; включите в разделе «Настройки → Вебхуки», где также видна активность каждого триггера. Форма доступна только с этого компьютера, если не сделать её публичной. Панели запуска по вебхуку спрашивают перед каждым вызовом инструмента, если для этого триггера не включён режим без присмотра, а при включённом App Lock запуск не начинается. В этой версии запуски по вебхуку используют только Claude Code.',
        'vi-VN': 'Webhook: webhook có thể khởi chạy pipeline, từ sự kiện GitHub có chữ ký hoặc từ trang biểu mẫu do bạn thiết lập. Mặc định tắt; bật trong Cài đặt → Webhook, nơi cũng hiển thị hoạt động của từng trình kích hoạt. Biểu mẫu chỉ truy cập được từ máy tính này trừ khi bạn đặt công khai. Các khung của lần chạy bằng webhook hỏi trước mỗi lần gọi công cụ, trừ khi bạn bật chế độ không giám sát cho trình kích hoạt đó, và không lần chạy nào bắt đầu khi App Lock đang bật. Ở phiên bản này, lần chạy bằng webhook chỉ dùng Claude Code.',
      },
      {
        'zh-TW': 'Pipeline：電腦很忙時 CLI 其實已經收到的開工指令，不會再被判定為沒送出。某個位置讓整次執行失敗時，其他位置會一起停下。「繼續」不會再把字打進正在等權限提示的分格，也就不會替你回答提示；第二次執行也不會再把任務送到第一次執行的分格。從 n8n 匯入的 Pipeline 現在會收到你輸入的任務。',
        'en-US': 'Pipelines: a kickoff the CLI took on a busy computer is no longer failed as never submitted. When one slot fails a run, the other slots stop with it. Resume no longer types into a pane waiting on a permission prompt, so it can no longer answer the prompt for you, and a second run no longer sends its task to the first run’s panes. Pipelines imported from n8n now receive the task you type.',
        'ja-JP': 'パイプライン：コンピューターが忙しいときに CLI が実際には受け取っていたキックオフが、未送信として失敗扱いされることはなくなりました。1 つのスロットが実行を失敗させると、ほかのスロットも一緒に止まります。「再開」が権限の確認待ちのペインに入力することはなくなり、あなたの代わりに確認に答えてしまうこともありません。2 回目の実行が 1 回目の実行のペインにタスクを送ることもなくなりました。n8n からインポートしたパイプラインに、入力したタスクが届くようになりました。',
        'zh-CN': 'Pipeline：电脑很忙时 CLI 其实已经收到的开工指令，不会再被判定为未发出。某个位置让整次运行失败时，其他位置会一起停下。“继续”不会再把字输入正在等待权限提示的分格，也就不会替你回答提示；第二次运行也不会再把任务发到第一次运行的分格。从 n8n 导入的 Pipeline 现在会收到你输入的任务。',
        'ko-KR': '파이프라인: 컴퓨터가 바쁠 때 CLI가 실제로 받은 시작 지시를 전송되지 않은 것으로 보고 실패 처리하지 않습니다. 한 슬롯이 실행을 실패시키면 다른 슬롯도 함께 멈춥니다. 재개가 권한 확인을 기다리는 패널에 입력하지 않으므로 사용자 대신 확인에 답하는 일이 없고, 두 번째 실행이 첫 번째 실행의 패널로 작업을 보내지도 않습니다. n8n에서 가져온 파이프라인은 이제 입력한 작업을 받습니다.',
        'es-ES': 'Pipelines: un arranque que la CLI recibió con el equipo ocupado ya no se da por fallido como no enviado. Cuando una ranura hace fallar una ejecución, las demás se detienen con ella. Reanudar ya no escribe en un panel que espera una solicitud de permiso, así que ya no puede responderla por ti, y una segunda ejecución ya no envía su tarea a los paneles de la primera. Los pipelines importados de n8n ahora reciben la tarea que escribes.',
        'fr-FR': 'Pipelines : un lancement que la CLI a bien reçu sur un ordinateur chargé n’est plus mis en échec comme jamais envoyé. Quand un emplacement fait échouer une exécution, les autres s’arrêtent avec lui. Reprendre ne tape plus dans un panneau qui attend une demande d’autorisation, et ne peut donc plus y répondre à votre place, et une deuxième exécution n’envoie plus sa tâche aux panneaux de la première. Les pipelines importés de n8n reçoivent maintenant la tâche que vous saisissez.',
        'de-DE': 'Pipelines: Ein Kickoff, den die CLI auf einem ausgelasteten Rechner angenommen hat, scheitert nicht mehr als nie abgeschickt. Lässt ein Slot einen Lauf scheitern, halten die anderen Slots mit an. Fortsetzen tippt nicht mehr in einen Bereich, der auf eine Berechtigungsabfrage wartet, und kann sie daher nicht mehr für dich beantworten, und ein zweiter Lauf schickt seine Aufgabe nicht mehr an die Bereiche des ersten. Aus n8n importierte Pipelines erhalten jetzt die Aufgabe, die du eingibst.',
        'pt-BR': 'Pipelines: um kickoff que a CLI recebeu com o computador ocupado não é mais dado como falho por nunca ter sido enviado. Quando um slot faz uma execução falhar, os outros param junto. Retomar não digita mais num painel que espera uma solicitação de permissão, então não consegue mais respondê-la por você, e uma segunda execução não envia mais a tarefa para os painéis da primeira. Pipelines importados do n8n agora recebem a tarefa que você digita.',
        'ru-RU': 'Пайплайны: стартовое задание, которое CLI принял на загруженном компьютере, больше не считается неотправленным. Когда один слот проваливает запуск, остальные останавливаются вместе с ним. «Продолжить» больше не печатает в панель, ожидающую запроса разрешения, и поэтому не может ответить на него за вас, а второй запуск больше не отправляет задание в панели первого. Пайплайны, импортированные из n8n, теперь получают задание, которое вы вводите.',
        'vi-VN': 'Pipeline: lệnh khởi đầu mà CLI đã nhận khi máy bận không còn bị coi là chưa gửi và thất bại. Khi một vị trí làm lần chạy thất bại, các vị trí khác dừng theo. Tiếp tục không còn gõ vào khung đang chờ lời nhắc cấp quyền, nên không thể trả lời lời nhắc thay bạn, và lần chạy thứ hai không còn gửi tác vụ tới các khung của lần chạy đầu. Pipeline nhập từ n8n nay nhận được tác vụ bạn nhập.',
      },
      {
        'zh-TW': '「設定 → 聊天室」改成兩欄：左邊列出每個機器人，右邊顯示選中的機器人，包括等待核准的請求、可以對話的人，以及它的聊天和分格。視窗較窄時兩欄會輪流顯示。',
        'en-US': 'Settings → Channels is now two columns: every bot on the left, and the chosen bot on the right with its requests waiting for approval, the people who can talk to it and its chats and panes. In a narrow window the two take turns.',
        'ja-JP': '「設定 → チャット連携」が 2 列になりました。左にすべてのボット、右に選んだボットが表示され、承認待ちのリクエスト、話しかけられる人、チャットとペインが並びます。ウィンドウが狭いときは 2 つが交互に表示されます。',
        'zh-CN': '“设置 → 聊天室”改为两栏：左边列出每个机器人，右边显示选中的机器人，包括等待批准的请求、可以对话的人，以及它的聊天和分格。窗口较窄时两栏会轮流显示。',
        'ko-KR': '설정 → 채널이 두 칸으로 바뀌었습니다. 왼쪽에 모든 봇이, 오른쪽에 선택한 봇이 승인 대기 중인 요청, 대화할 수 있는 사람, 채팅과 패널과 함께 표시됩니다. 창이 좁으면 두 칸이 번갈아 나타납니다.',
        'es-ES': 'Ajustes → Channels ahora tiene dos columnas: todos los bots a la izquierda y, a la derecha, el bot elegido con sus solicitudes pendientes de aprobación, las personas que pueden hablarle y sus chats y paneles. En una ventana estrecha, ambas se turnan.',
        'fr-FR': 'Réglages → Canaux passe en deux colonnes : tous les bots à gauche, et à droite le bot choisi avec ses demandes en attente d’approbation, les personnes qui peuvent lui parler, ses chats et ses panneaux. Dans une fenêtre étroite, les deux s’affichent tour à tour.',
        'de-DE': 'Einstellungen → Kanäle hat jetzt zwei Spalten: links alle Bots, rechts der gewählte Bot mit seinen Anfragen, die auf Genehmigung warten, den Personen, die mit ihm sprechen dürfen, sowie seinen Chats und Bereichen. In einem schmalen Fenster wechseln sich beide ab.',
        'pt-BR': 'Configurações → Canais agora tem duas colunas: todos os bots à esquerda e, à direita, o bot escolhido com as solicitações aguardando aprovação, as pessoas que podem falar com ele e seus chats e painéis. Numa janela estreita, as duas se alternam.',
        'ru-RU': 'Раздел «Настройки → Каналы» теперь в две колонки: слева все боты, справа выбранный бот с запросами, ожидающими одобрения, людьми, которые могут с ним общаться, а также его чатами и панелями. В узком окне колонки показываются по очереди.',
        'vi-VN': 'Cài đặt → Kênh nay có hai cột: mọi bot ở bên trái, bot đã chọn ở bên phải cùng các yêu cầu chờ phê duyệt, những người có thể trò chuyện với nó, các cuộc trò chuyện và khung của nó. Trong cửa sổ hẹp, hai cột hiển thị luân phiên.',
      },
      {
        'zh-TW': '帳號：沒有 5 小時窗口的帳號（例如 Claude Ultra）不再顯示「沒有額度資料」，改以每週剩餘額度排序。Claude 目前登入的帳號額度用完、且設定由 API key 接手時，若有只在自己資料夾登入、仍有額度的訂閱帳號，會先切到它。',
        'en-US': 'Accounts: an account with no 5-hour window, such as Claude Ultra, no longer reads as having no quota data; it ranks by its weekly headroom. When the live Claude login runs out and an API key is set to take over, a subscription account signed in in its own folder with quota left now comes before the key.',
        'ja-JP': 'アカウント：5 時間枠のないアカウント（Claude Ultra など）が「クォータのデータなし」と表示されなくなり、週の残りクォータで順位が付くようになりました。Claude の現在のログインのクォータが尽き、API キーが引き継ぐよう設定されているときは、専用フォルダーでサインインしていてクォータが残っているサブスクリプションアカウントが、キーより先に選ばれます。',
        'zh-CN': '账号：没有 5 小时窗口的账号（例如 Claude Ultra）不再显示“没有额度数据”，改为按每周剩余额度排序。Claude 当前登录的账号额度用完、且设置由 API 密钥接手时，若有只在自己文件夹登录、仍有额度的订阅账号，会先切换到它。',
        'ko-KR': '계정: 5시간 창이 없는 계정(Claude Ultra 등)이 더 이상 할당량 데이터 없음으로 표시되지 않고, 주간 남은 할당량으로 순위가 매겨집니다. 현재 Claude 로그인의 할당량이 소진되고 API 키가 이어받도록 설정되어 있을 때, 자체 폴더에서 로그인해 할당량이 남은 구독 계정이 키보다 먼저 선택됩니다.',
        'es-ES': 'Cuentas: una cuenta sin ventana de 5 horas, como Claude Ultra, ya no aparece como sin datos de cuota; se ordena por su margen semanal. Cuando el inicio de sesión activo de Claude se agota y hay una clave de API configurada para tomar el relevo, una cuenta de suscripción iniciada en su propia carpeta y con cuota disponible ahora va antes que la clave.',
        'fr-FR': 'Comptes : un compte sans fenêtre de 5 heures, comme Claude Ultra, n’apparaît plus sans données de quota ; il est classé selon sa marge hebdomadaire. Quand la connexion Claude active est épuisée et qu’une clé API doit prendre le relais, un compte d’abonnement connecté dans son propre dossier et à qui il reste du quota passe désormais avant la clé.',
        'de-DE': 'Konten: Ein Konto ohne 5-Stunden-Fenster, etwa Claude Ultra, erscheint nicht mehr als Konto ohne Kontingentdaten; es wird nach seinem wöchentlichen Spielraum eingeordnet. Ist die aktive Claude-Anmeldung aufgebraucht und soll ein API-Schlüssel übernehmen, kommt jetzt zuerst ein Abo-Konto, das in seinem eigenen Ordner angemeldet ist und noch Kontingent hat.',
        'pt-BR': 'Contas: uma conta sem janela de 5 horas, como a Claude Ultra, não aparece mais como sem dados de cota; ela é ordenada pela folga semanal. Quando o login ativo do Claude esgota e uma chave de API está configurada para assumir, uma conta de assinatura conectada na própria pasta e com cota restante agora vem antes da chave.',
        'ru-RU': 'Аккаунты: аккаунт без 5-часового окна, например Claude Ultra, больше не показывается как аккаунт без данных о квоте; он ранжируется по недельному запасу. Когда квота текущего входа в Claude исчерпана и замену должен взять API-ключ, теперь сначала выбирается аккаунт с подпиской, вошедший в своей папке и с оставшейся квотой.',
        'vi-VN': 'Tài khoản: tài khoản không có khung 5 giờ, như Claude Ultra, không còn hiển thị là không có dữ liệu hạn mức; nó được xếp theo phần hạn mức còn lại trong tuần. Khi đăng nhập Claude hiện tại hết hạn mức và khóa API được đặt để thay thế, tài khoản gói đăng ký đăng nhập trong thư mục riêng và còn hạn mức nay được chọn trước khóa.',
      },
      {
        'zh-TW': '回覆更快與其他修正：Navide 讀很長的 Claude 對話紀錄時只從上次停下的地方往下讀，並優先讀剛結束的 Claude 回合，所以在 Telegram 等回覆的人，不必再排在其他分格後面等好幾分鐘。設定精靈不再把它會幫你安裝的工具顯示成紅色錯誤；Electron 44.10.1 帶來 Node.js 10 月 21 日的安全更新。',
        'en-US': 'Faster replies and other fixes: Navide reads long Claude transcripts only from where it stopped and reads a just-finished Claude turn first, so a reply someone waits for in Telegram no longer waits minutes behind other panes. The setup wizard no longer shows tools it will install for you as red errors, and Electron 44.10.1 brings the Node.js security release of October 21.',
        'ja-JP': '返信の高速化とその他の修正：Navide は長い Claude の会話ログを前回止まったところから読むようになり、終わったばかりの Claude のターンを優先して読みます。そのため、Telegram で返信を待っている人が、ほかのペインの後ろで何分も待たされることはなくなりました。セットアップウィザードは、代わりにインストールするツールを赤いエラーとして表示しなくなりました。Electron 44.10.1 で、10 月 21 日の Node.js セキュリティリリースを取り込みました。',
        'zh-CN': '回复更快与其他修复：Navide 读很长的 Claude 对话记录时只从上次停下的地方往下读，并优先读刚结束的 Claude 回合，所以在 Telegram 等回复的人，不必再排在其他分格后面等好几分钟。设置向导不再把它会帮你安装的工具显示为红色错误；Electron 44.10.1 带来 Node.js 10 月 21 日的安全更新。',
        'ko-KR': '더 빠른 답장과 기타 수정: Navide는 긴 Claude 대화 기록을 마지막으로 멈춘 곳부터 읽고 방금 끝난 Claude 턴을 먼저 읽으므로, Telegram에서 답장을 기다리는 사람이 다른 패널 뒤에서 몇 분씩 기다리지 않습니다. 설정 마법사는 대신 설치해 줄 도구를 빨간 오류로 표시하지 않으며, Electron 44.10.1에 10월 21일 Node.js 보안 릴리스가 포함되었습니다.',
        'es-ES': 'Respuestas más rápidas y otras correcciones: Navide lee las transcripciones largas de Claude solo desde donde se detuvo y lee primero un turno de Claude recién terminado, así que una respuesta que alguien espera en Telegram ya no espera minutos detrás de otros paneles. El asistente de configuración ya no muestra como errores en rojo las herramientas que instalará por ti, y Electron 44.10.1 incorpora la versión de seguridad de Node.js del 21 de octubre.',
        'fr-FR': 'Réponses plus rapides et autres corrections : Navide ne lit plus les longues transcriptions Claude qu’à partir de là où il s’était arrêté et lit en premier un tour Claude tout juste terminé, si bien qu’une réponse attendue dans Telegram n’attend plus des minutes derrière d’autres panneaux. L’assistant de configuration n’affiche plus en rouge les outils qu’il installera pour vous, et Electron 44.10.1 apporte la version de sécurité de Node.js du 21 octobre.',
        'de-DE': 'Schnellere Antworten und weitere Korrekturen: Navide liest lange Claude-Transkripte nur ab der Stelle, an der es aufgehört hat, und liest einen gerade beendeten Claude-Durchgang zuerst, sodass eine Antwort, auf die jemand in Telegram wartet, nicht mehr minutenlang hinter anderen Bereichen wartet. Der Einrichtungsassistent zeigt Werkzeuge, die er für dich installiert, nicht mehr als rote Fehler, und Electron 44.10.1 bringt das Node.js-Sicherheitsrelease vom 21. Oktober.',
        'pt-BR': 'Respostas mais rápidas e outras correções: o Navide lê transcrições longas do Claude só a partir de onde parou e lê primeiro um turno do Claude recém-terminado, então uma resposta que alguém espera no Telegram não espera mais minutos atrás de outros painéis. O assistente de configuração não mostra mais como erros em vermelho as ferramentas que ele vai instalar para você, e o Electron 44.10.1 traz a versão de segurança do Node.js de 21 de outubro.',
        'ru-RU': 'Более быстрые ответы и другие исправления: Navide читает длинные журналы Claude только с места, где остановился, и в первую очередь читает только что завершённый ход Claude, поэтому ответ, которого ждут в Telegram, больше не ждёт минутами за другими панелями. Мастер настройки больше не показывает красными ошибками инструменты, которые он сам установит, а Electron 44.10.1 включает выпуск безопасности Node.js от 21 октября.',
        'vi-VN': 'Trả lời nhanh hơn và các sửa lỗi khác: Navide chỉ đọc bản ghi Claude dài từ chỗ đã dừng và ưu tiên đọc lượt Claude vừa kết thúc, nên câu trả lời mà ai đó đang chờ trên Telegram không còn phải chờ vài phút sau các khung khác. Trình hướng dẫn thiết lập không còn hiển thị các công cụ nó sẽ cài giúp bạn như lỗi màu đỏ, và Electron 44.10.1 mang theo bản phát hành bảo mật Node.js ngày 21 tháng 10.',
      },
    ],
  },
  {
    version: '0.2.36',
    title: {
      'zh-TW': 'API key 帳號、可自訂的工作台，以及 Navide 外掛快捷鍵',
      'en-US': 'API Key Accounts, a Workbench You Can Shape and Shortcuts for Navide Plugins',
      'ja-JP': 'API キーアカウント、カスタマイズできるワークベンチ、Navide プラグインのショートカット',
      'zh-CN': 'API 密钥账号、可自定义的工作台，以及 Navide 插件快捷键',
      'ko-KR': 'API 키 계정, 직접 꾸미는 워크벤치, Navide 플러그인 단축키',
      'es-ES': 'Cuentas con clave de API, un espacio de trabajo a tu medida y atajos para plugins de Navide',
      'fr-FR': 'Comptes à clé API, un espace de travail personnalisable et des raccourcis pour les plugins Navide',
      'de-DE': 'API-Schlüssel-Konten, eine anpassbare Arbeitsfläche und Tastenkürzel für Navide-Plugins',
      'pt-BR': 'Contas com chave de API, um ambiente de trabalho sob medida e atalhos para plugins do Navide',
      'ru-RU': 'Аккаунты с API-ключом, настраиваемая рабочая область и горячие клавиши для плагинов Navide',
      'vi-VN': 'Tài khoản khóa API, bàn làm việc tùy chỉnh và phím tắt cho plugin Navide',
    },
    highlights: [
      {
        'zh-TW': 'API key 帳號：Claude Code 和 Codex 現在可以用 API key 按用量計費，在「設定 → 帳號」按「+ 新增帳號」即可加入。額度用完時自動切過去的功能預設關閉，要逐帳號開啟。訂閱額度恢復時只會提示，不會自動切回。',
        'en-US': 'API key accounts: Claude Code and Codex can now run on an API key, billed by usage. Add one with + Add account in Settings → Accounts. Switching to it automatically when quota runs out is off by default and turned on per account. When subscription quota comes back, Navide only tells you; it does not switch back on its own.',
        'ja-JP': 'API キーアカウント：Claude Code と Codex は API キーでも動かせるようになりました。料金は従量課金です。「設定 → アカウント」の「+ アカウントを追加」から追加できます。クォータを使い切ったときの自動切り替えは既定でオフで、アカウントごとにオンにします。サブスクリプションのクォータが戻っても通知するだけで、自動では戻しません。',
        'zh-CN': 'API 密钥账号：Claude Code 和 Codex 现在可以使用 API 密钥，按用量计费。在“设置 → 账号”点“+ 添加账号”即可加入。额度用完时自动切换到它的功能默认关闭，需逐个账号开启。订阅额度恢复时只会提示，不会自动切回。',
        'ko-KR': 'API 키 계정: 이제 Claude Code와 Codex를 API 키로 실행할 수 있으며, 요금은 사용량 기준입니다. 설정 → 계정의 + 계정 추가에서 추가합니다. 할당량이 소진될 때 자동으로 전환하는 기능은 기본적으로 꺼져 있고 계정별로 켭니다. 구독 할당량이 돌아와도 알려 주기만 하고 자동으로 되돌리지 않습니다.',
        'es-ES': 'Cuentas con clave de API: Claude Code y Codex ahora pueden funcionar con una clave de API, con facturación por uso. Añádela con + Añadir cuenta en Ajustes → Cuentas. El cambio automático cuando se agota la cuota viene desactivado y se activa cuenta por cuenta. Cuando vuelve la cuota de la suscripción, Navide solo te avisa; no vuelve atrás por su cuenta.',
        'fr-FR': 'Comptes à clé API : Claude Code et Codex peuvent désormais fonctionner avec une clé API, facturée à l’usage. Ajoutez-la avec + Ajouter un compte dans Réglages → Comptes. Le basculement automatique à l’épuisement du quota est désactivé par défaut et s’active compte par compte. Quand le quota de l’abonnement revient, Navide vous prévient seulement ; il ne rebascule pas de lui-même.',
        'de-DE': 'API-Schlüssel-Konten: Claude Code und Codex laufen jetzt auch mit einem API-Schlüssel, abgerechnet nach Nutzung. Hinzufügen unter Einstellungen → Konten mit + Konto hinzufügen. Der automatische Wechsel bei aufgebrauchtem Kontingent ist standardmäßig aus und wird pro Konto eingeschaltet. Kommt das Abo-Kontingent zurück, weist Navide nur darauf hin und wechselt nicht von selbst zurück.',
        'pt-BR': 'Contas com chave de API: o Claude Code e o Codex agora podem usar uma chave de API, com cobrança por uso. Adicione em Configurações → Contas, com + Adicionar conta. A troca automática quando a cota acaba vem desligada e é ativada conta a conta. Quando a cota da assinatura volta, o Navide apenas avisa; ele não volta sozinho.',
        'ru-RU': 'Аккаунты с API-ключом: Claude Code и Codex теперь могут работать по API-ключу с оплатой по использованию. Добавить его можно через «+ Добавить аккаунт» в разделе «Настройки → Аккаунты». Автоматическое переключение при исчерпании квоты по умолчанию выключено и включается для каждого аккаунта отдельно. Когда квота подписки восстанавливается, Navide только сообщает об этом и сам обратно не переключает.',
        'vi-VN': 'Tài khoản khóa API: Claude Code và Codex nay có thể chạy bằng khóa API, tính phí theo mức dùng. Thêm bằng + Thêm tài khoản trong Cài đặt → Tài khoản. Tự động chuyển khi hết hạn mức mặc định tắt và được bật theo từng tài khoản. Khi hạn mức gói đăng ký trở lại, Navide chỉ thông báo, không tự chuyển về.',
      },
      {
        'zh-TW': 'API key 只存本機，不經 Navide Cloud。金鑰只會送到發行它的廠商：CLI 呼叫時，以及你按「測試金鑰」時。存放位置和分格裡的程式能否取得金鑰，隱私文件有完整說明。',
        'en-US': 'Your API key is stored only on this computer and does not go through Navide Cloud. It goes only to the vendor that issued it: when the CLI makes a call, and when you press Test key. The privacy document says exactly where it is kept and how programs in a pane can reach it.',
        'ja-JP': 'API キーはこのコンピューターにのみ保存され、Navide Cloud を経由しません。キーが送られるのは発行元のベンダーだけで、CLI が呼び出すときと「キーをテスト」を押したときです。保存場所と、ペイン内のプログラムがキーを取得できる点は、プライバシー文書に詳しく記載しています。',
        'zh-CN': 'API 密钥只保存在本机，不经过 Navide Cloud。密钥只会发送给签发它的厂商：CLI 调用时，以及你点击“测试密钥”时。存放位置以及分格中的程序如何取得密钥，隐私文档有完整说明。',
        'ko-KR': 'API 키는 이 컴퓨터에만 저장되며 Navide Cloud를 거치지 않습니다. 키는 발급한 공급업체로만 전송됩니다. CLI가 호출할 때와 키 테스트를 누를 때입니다. 저장 위치와 패널 안의 프로그램이 키에 접근하는 방식은 개인정보 문서에 자세히 나와 있습니다.',
        'es-ES': 'Tu clave de API se guarda solo en este ordenador y no pasa por Navide Cloud. Solo se envía al proveedor que la emitió: cuando la CLI hace una llamada y cuando pulsas Probar clave. El documento de privacidad detalla dónde se guarda y cómo pueden llegar a ella los programas de un panel.',
        'fr-FR': 'Votre clé API est stockée uniquement sur cet ordinateur et ne passe pas par Navide Cloud. Elle n’est envoyée qu’au fournisseur qui l’a émise : quand la CLI effectue un appel et quand vous appuyez sur Tester la clé. Le document de confidentialité précise où elle est conservée et comment les programmes d’un panneau peuvent y accéder.',
        'de-DE': 'Der API-Schlüssel wird nur auf diesem Computer gespeichert und läuft nicht über Navide Cloud. Er geht nur an den Anbieter, der ihn ausgestellt hat: bei Aufrufen der CLI und wenn du Schlüssel testen drückst. Die Datenschutzdokumentation beschreibt genau, wo er liegt und wie Programme in einem Bereich an ihn gelangen.',
        'pt-BR': 'Sua chave de API fica guardada só neste computador e não passa pelo Navide Cloud. Ela vai apenas para o fornecedor que a emitiu: quando a CLI faz uma chamada e quando você aperta Testar chave. O documento de privacidade detalha onde ela fica e como os programas de um painel podem chegar até ela.',
        'ru-RU': 'API-ключ хранится только на этом компьютере и не проходит через Navide Cloud. Он отправляется только поставщику, который его выдал: при вызовах CLI и при нажатии «Проверить ключ». Где он хранится и как программы в панели могут его получить, подробно описано в документе о конфиденциальности.',
        'vi-VN': 'Khóa API chỉ lưu trên máy tính này và không đi qua Navide Cloud. Khóa chỉ được gửi tới nhà cung cấp đã cấp nó: khi CLI thực hiện lệnh gọi và khi bạn nhấn Kiểm tra khóa. Tài liệu quyền riêng tư nêu rõ nơi lưu khóa và cách các chương trình trong khung có thể lấy khóa.',
      },
      {
        'zh-TW': '花費：Agent 不能自己選 API key 帳號，但你把新分格設成 API key 後，Agent 開的分格會跟隨這個預設，子分格也會繼承。花費的真正上限是官方後台的設定。Navide 的每月預算備註不是硬上限，這一版也只會記下金額，不會統計花費或發出通知，建議先在後台設好上限。',
        'en-US': 'Spending: agents cannot pick an API key account themselves, but once you set new panes to an API key, the panes agents open follow that default, and so do their child panes. The real spending limit is the one you set in the vendor’s console. Navide’s monthly budget note is not a hard limit, and in this version it only saves the amount: it does not track spending or alert you. Set a limit in the console first.',
        'ja-JP': '費用：Agent が自分で API キーアカウントを選ぶことはできません。ただし、新しいペインを API キーに設定すると、Agent が開くペインはその既定に従い、子ペインも引き継ぎます。費用の本当の上限はベンダーの管理画面の設定です。Navide の毎月の予算メモは厳密な上限ではなく、このバージョンでは金額を保存するだけで、費用の集計も通知も行いません。先に管理画面で上限を設定することをおすすめします。',
        'zh-CN': '费用：Agent 不能自行选择 API 密钥账号，但你把新分格设为 API 密钥后，Agent 打开的分格会跟随这个默认设置，子分格也会继承。费用的真正上限是厂商后台的设置。Navide 的每月预算备注不是硬性上限，这一版也只会记下金额，不会统计费用或发出通知，建议先在后台设好上限。',
        'ko-KR': '비용: 에이전트가 API 키 계정을 직접 고를 수는 없지만, 새 패널을 API 키로 설정하면 에이전트가 여는 패널도 그 기본값을 따르고 하위 패널도 이어받습니다. 실제 지출 한도는 공급업체 콘솔의 설정입니다. Navide의 월간 예산 메모는 강제 한도가 아니며, 이번 버전에서는 금액만 저장할 뿐 지출을 집계하거나 알리지 않습니다. 콘솔에서 먼저 한도를 설정하세요.',
        'es-ES': 'Gasto: los agentes no pueden elegir por sí mismos una cuenta con clave de API, pero si configuras los paneles nuevos con una clave, los paneles que abran los agentes siguen ese valor predeterminado, y también sus paneles hijos. El límite real de gasto es el que fijes en la consola del proveedor. La nota de presupuesto mensual de Navide no es un límite estricto y, en esta versión, solo guarda el importe: no mide el gasto ni avisa. Fija primero un límite en la consola.',
        'fr-FR': 'Dépenses : les agents ne peuvent pas choisir eux-mêmes un compte à clé API, mais dès que vous réglez les nouveaux panneaux sur une clé, les panneaux ouverts par les agents suivent ce réglage, tout comme leurs panneaux enfants. La vraie limite de dépense est celle que vous fixez dans la console du fournisseur. La note de budget mensuel de Navide n’est pas une limite stricte et, dans cette version, elle enregistre seulement le montant : il ne suit pas les dépenses et n’envoie aucune alerte. Fixez d’abord une limite dans la console.',
        'de-DE': 'Kosten: Agents können ein API-Schlüssel-Konto nicht selbst wählen. Stellst du neue Bereiche aber auf einen API-Schlüssel um, folgen die von Agents geöffneten Bereiche dieser Vorgabe, ebenso deren Unterbereiche. Die echte Ausgabengrenze ist die in der Konsole des Anbieters. Die monatliche Budgetnotiz von Navide ist keine harte Grenze und speichert in dieser Version nur den Betrag: Sie erfasst keine Ausgaben und warnt nicht. Lege zuerst in der Konsole eine Grenze fest.',
        'pt-BR': 'Gastos: os agentes não podem escolher sozinhos uma conta com chave de API, mas, se você definir os novos painéis com uma chave, os painéis que eles abrirem seguem esse padrão, assim como os painéis filhos. O limite real de gastos é o que você define no console do fornecedor. A nota de orçamento mensal do Navide não é um limite rígido e, nesta versão, apenas guarda o valor: não acompanha gastos nem avisa. Defina primeiro um limite no console.',
        'ru-RU': 'Расходы: агенты не могут сами выбрать аккаунт с API-ключом, но если вы назначите API-ключ для новых панелей, панели, открытые агентами, будут следовать этому значению, как и их дочерние панели. Настоящий предел расходов задаётся в консоли поставщика. Заметка о месячном бюджете в Navide не является жёстким пределом, а в этой версии только сохраняет сумму: расходы не считаются, уведомлений нет. Сначала задайте предел в консоли.',
        'vi-VN': 'Chi phí: agent không thể tự chọn tài khoản khóa API, nhưng khi bạn đặt khung mới dùng khóa API, các khung do agent mở sẽ theo mặc định đó, và khung con cũng kế thừa. Giới hạn chi tiêu thực sự là thiết lập trong bảng điều khiển của nhà cung cấp. Ghi chú ngân sách hằng tháng của Navide không phải giới hạn cứng, và ở phiên bản này chỉ lưu số tiền: không theo dõi chi tiêu cũng không cảnh báo. Hãy đặt giới hạn trong bảng điều khiển trước.',
      },
      {
        'zh-TW': '已知限制：Claude API key 帳號第一版不支援 Windows。Codex API key 帳號尚未經真 key 實測，歡迎回報問題。使用中的帳號額度不足時，只在自己資料夾登入的訂閱帳號不算候選，所以即使它還有額度，仍可能切到 API key。降回舊版時，點 API key 帳號會清掉目前的登入，切回原帳號可以恢復；建議降版前先刪除 API key 帳號。',
        'en-US': 'Known limits: Claude API key accounts do not support Windows in this first version. Codex API key accounts have not been tested with a real key yet, so please report any problems. When the account in use runs short, a subscription account signed in only in its own folder does not count as a candidate, even with quota left, so Navide may still switch to an API key. After downgrading, clicking an API key account clears the current login; switching back to your original account restores it. Delete API key accounts before you downgrade.',
        'ja-JP': '既知の制限：Claude の API キーアカウントは、最初のバージョンでは Windows に対応していません。Codex の API キーアカウントは実際のキーでの検証がまだなので、問題があればお知らせください。使用中のアカウントのクォータが足りないとき、専用フォルダーでのみサインインしているサブスクリプションアカウントは、クォータが残っていても候補にならないため、API キーに切り替わることがあります。旧バージョンに戻した場合、API キーアカウントをクリックすると現在のログインが消去されます。元のアカウントに切り替えると復元できます。ダウングレードの前に API キーアカウントを削除することをおすすめします。',
        'zh-CN': '已知限制：Claude API 密钥账号第一版不支持 Windows。Codex API 密钥账号尚未使用真实密钥实测，欢迎反馈问题。使用中的账号额度不足时，只在自己文件夹登录的订阅账号不算候选，即使还有额度，也可能切换到 API 密钥。降回旧版后，点击 API 密钥账号会清除当前登录，切回原账号即可恢复；建议降级前先删除 API 密钥账号。',
        'ko-KR': '알려진 제한: Claude API 키 계정은 첫 버전에서 Windows를 지원하지 않습니다. Codex API 키 계정은 아직 실제 키로 검증되지 않았으니 문제가 있으면 알려 주세요. 사용 중인 계정의 할당량이 부족할 때, 자체 폴더에서만 로그인한 구독 계정은 할당량이 남아 있어도 후보가 아니므로 API 키로 전환될 수 있습니다. 이전 버전으로 되돌린 뒤 API 키 계정을 클릭하면 현재 로그인이 지워지며, 원래 계정으로 전환하면 복구됩니다. 다운그레이드 전에 API 키 계정을 삭제하세요.',
        'es-ES': 'Límites conocidos: las cuentas con clave de API de Claude no admiten Windows en esta primera versión. Las cuentas con clave de API de Codex aún no se han probado con una clave real, así que avísanos de cualquier problema. Cuando la cuenta en uso se queda corta, una cuenta de suscripción iniciada solo en su propia carpeta no cuenta como candidata, aunque le quede cuota, y Navide aún puede cambiar a una clave de API. Tras volver a una versión anterior, hacer clic en una cuenta con clave de API borra el inicio de sesión actual; al volver a tu cuenta original se recupera. Elimina las cuentas con clave de API antes de volver atrás.',
        'fr-FR': 'Limites connues : les comptes à clé API Claude ne prennent pas en charge Windows dans cette première version. Les comptes à clé API Codex n’ont pas encore été testés avec une vraie clé, signalez-nous tout problème. Quand le compte utilisé arrive à court, un compte d’abonnement connecté uniquement dans son propre dossier ne compte pas comme candidat, même s’il lui reste du quota, et Navide peut quand même basculer vers une clé API. Après un retour à une ancienne version, cliquer sur un compte à clé API efface la connexion actuelle ; revenir à votre compte d’origine la restaure. Supprimez les comptes à clé API avant de revenir en arrière.',
        'de-DE': 'Bekannte Einschränkungen: Claude-API-Schlüssel-Konten unterstützen Windows in dieser ersten Version nicht. Codex-API-Schlüssel-Konten wurden noch nicht mit einem echten Schlüssel getestet, melde Probleme also gern. Wird das Kontingent des aktiven Kontos knapp, zählt ein Abo-Konto, das nur in seinem eigenen Ordner angemeldet ist, nicht als Kandidat, auch wenn es noch Kontingent hat; Navide kann also trotzdem zu einem API-Schlüssel wechseln. Nach einem Downgrade löscht ein Klick auf ein API-Schlüssel-Konto die aktuelle Anmeldung; der Wechsel zurück zum ursprünglichen Konto stellt sie wieder her. Lösche API-Schlüssel-Konten vor einem Downgrade.',
        'pt-BR': 'Limites conhecidos: as contas com chave de API do Claude não têm suporte a Windows nesta primeira versão. As contas com chave de API do Codex ainda não foram testadas com uma chave real, então avise se encontrar problemas. Quando a conta em uso fica sem cota suficiente, uma conta de assinatura conectada apenas na própria pasta não conta como candidata, mesmo com cota restante, e o Navide ainda pode trocar para uma chave de API. Depois de voltar a uma versão anterior, clicar em uma conta com chave de API apaga o login atual; voltar à conta original o restaura. Exclua as contas com chave de API antes de voltar de versão.',
        'ru-RU': 'Известные ограничения: аккаунты Claude с API-ключом в этой первой версии не поддерживают Windows. Аккаунты Codex с API-ключом ещё не проверены на настоящем ключе, поэтому сообщайте о проблемах. Когда квоты текущего аккаунта не хватает, аккаунт с подпиской, вошедший только в своей папке, не считается кандидатом, даже если квота у него есть, поэтому Navide всё равно может переключиться на API-ключ. После возврата на старую версию нажатие на аккаунт с API-ключом сбрасывает текущий вход; переключение на исходный аккаунт восстанавливает его. Перед откатом удалите аккаунты с API-ключом.',
        'vi-VN': 'Giới hạn đã biết: tài khoản khóa API của Claude chưa hỗ trợ Windows ở phiên bản đầu tiên. Tài khoản khóa API của Codex chưa được kiểm thử bằng khóa thật, hãy báo lại nếu gặp sự cố. Khi tài khoản đang dùng không đủ hạn mức, tài khoản gói đăng ký chỉ đăng nhập trong thư mục riêng không được tính là ứng viên, dù vẫn còn hạn mức, nên Navide vẫn có thể chuyển sang khóa API. Sau khi hạ phiên bản, nhấp vào tài khoản khóa API sẽ xóa đăng nhập hiện tại; chuyển lại tài khoản ban đầu sẽ khôi phục. Hãy xóa tài khoản khóa API trước khi hạ phiên bản.',
      },
      {
        'zh-TW': '工作台：「設定 → 版面」可以新增動作按鈕，放在舞台分頁列右端，一次執行一個或依序執行多個動作。專案也能用 `.navide/workbench.json` 建議按鈕、版面和 Navide 外掛；你看過並接受那份內容後才會生效，檔案之後有變動就要重新審閱。沒有按鈕也沒有這個檔案時，一切照舊。',
        'en-US': 'Workbench: Settings → Layout adds action buttons at the right end of the stage tabs, each running one action or several in order. A project can suggest buttons, a layout and Navide plugins in `.navide/workbench.json`; nothing applies until you review and accept that exact content, and any later change needs a new review. With no buttons and no file, nothing changes.',
        'ja-JP': 'ワークベンチ：「設定 → レイアウト」でアクションボタンを追加できます。ボタンはステージタブの右端に並び、1 つのアクション、または複数のアクションを順に実行します。プロジェクトは `.navide/workbench.json` でボタン、レイアウト、Navide プラグインを提案できますが、内容を確認して受け入れるまでは適用されず、ファイルが変わると確認し直しになります。ボタンもファイルもなければ、何も変わりません。',
        'zh-CN': '工作台：“设置 → 版面”可以添加操作按钮，显示在舞台标签栏右端，一次执行一个或按顺序执行多个操作。项目也能用 `.navide/workbench.json` 建议按钮、版面和 Navide 插件；你查看并接受该内容后才会生效，文件之后有改动就要重新审阅。没有按钮也没有这个文件时，一切照旧。',
        'ko-KR': '워크벤치: 설정 → 레이아웃에서 스테이지 탭 오른쪽 끝에 작업 버튼을 추가할 수 있으며, 버튼 하나로 작업 하나 또는 여러 작업을 순서대로 실행합니다. 프로젝트는 `.navide/workbench.json`으로 버튼, 레이아웃, Navide 플러그인을 제안할 수 있지만 그 내용을 검토하고 수락하기 전에는 적용되지 않으며, 파일이 바뀌면 다시 검토해야 합니다. 버튼도 파일도 없으면 아무것도 바뀌지 않습니다.',
        'es-ES': 'Espacio de trabajo: Ajustes → Disposición añade botones de acción al final de las pestañas de etapa, que ejecutan una acción o varias en orden. Un proyecto puede sugerir botones, una disposición y plugins de Navide en `.navide/workbench.json`; nada se aplica hasta que revises y aceptes ese contenido exacto, y cualquier cambio posterior exige una nueva revisión. Sin botones ni archivo, nada cambia.',
        'fr-FR': 'Espace de travail : Réglages → Disposition ajoute des boutons d’action au bout des onglets d’étape, chacun lançant une action ou plusieurs à la suite. Un projet peut suggérer des boutons, une disposition et des plugins Navide dans `.navide/workbench.json` ; rien ne s’applique avant que vous ayez examiné et accepté ce contenu exact, et toute modification ultérieure demande un nouvel examen. Sans bouton ni fichier, rien ne change.',
        'de-DE': 'Arbeitsfläche: Unter Einstellungen → Layout lassen sich Aktionsschaltflächen am rechten Ende der Stage-Tabs hinzufügen, die eine Aktion oder mehrere nacheinander ausführen. Ein Projekt kann in `.navide/workbench.json` Schaltflächen, ein Layout und Navide-Plugins vorschlagen; nichts davon gilt, bevor du genau diesen Inhalt geprüft und akzeptiert hast, und jede spätere Änderung braucht eine neue Prüfung. Ohne Schaltflächen und ohne Datei ändert sich nichts.',
        'pt-BR': 'Ambiente de trabalho: Configurações → Layout adiciona botões de ação no fim das abas de estágio, que executam uma ação ou várias em ordem. Um projeto pode sugerir botões, um layout e plugins do Navide em `.navide/workbench.json`; nada é aplicado até você revisar e aceitar exatamente esse conteúdo, e qualquer mudança posterior exige nova revisão. Sem botões e sem arquivo, nada muda.',
        'ru-RU': 'Рабочая область: в разделе «Настройки → Макет» можно добавить кнопки действий в правом конце вкладок этапов; кнопка запускает одно действие или несколько по порядку. Проект может предложить кнопки, макет и плагины Navide в файле `.navide/workbench.json`; ничего не применяется, пока вы не проверите и не примете именно это содержимое, а любое изменение потребует новой проверки. Без кнопок и файла ничего не меняется.',
        'vi-VN': 'Bàn làm việc: Cài đặt → Bố cục thêm nút hành động ở cuối hàng tab giai đoạn, mỗi nút chạy một hành động hoặc nhiều hành động theo thứ tự. Dự án có thể đề xuất nút, bố cục và plugin Navide trong `.navide/workbench.json`; không gì được áp dụng cho đến khi bạn xem xét và chấp nhận đúng nội dung đó, và mọi thay đổi sau này cần xem xét lại. Không có nút và không có tệp thì không có gì thay đổi.',
      },
      {
        'zh-TW': 'Navide 外掛：外掛可以宣告指令，由你在「設定 → 快捷鍵」綁定按鍵，Agent 不能執行這些指令。Mini-IDE 的快速開啟和 AI CLI 終端機的 ⌘ 點擊，現在能辨識 `OrderService.php:137-158` 和 `#L10-L20`，直接開到該行。',
        'en-US': 'Navide plugins: a plugin can declare commands you bind to keys in Settings → Shortcuts; agents cannot run them. Mini-IDE Quick Open and ⌘-click in the AI CLI terminal now understand `OrderService.php:137-158` and `#L10-L20` and open at that line.',
        'ja-JP': 'Navide プラグイン：プラグインはコマンドを宣言でき、「設定 → ショートカット」でキーに割り当てられます。agent はこれらのコマンドを実行できません。Mini-IDE のクイックオープンと AI CLI ターミナルの ⌘ クリックは、`OrderService.php:137-158` や `#L10-L20` を認識し、その行を直接開きます。',
        'zh-CN': 'Navide 插件：插件可以声明命令，由你在“设置 → 快捷键”绑定按键，Agent 不能执行这些命令。Mini-IDE 的快速打开和 AI CLI 终端的 ⌘ 点击，现在能识别 `OrderService.php:137-158` 和 `#L10-L20`，直接打开到该行。',
        'ko-KR': 'Navide 플러그인: 플러그인이 명령을 선언하면 설정 → 단축키에서 키에 연결할 수 있습니다. 에이전트는 이 명령을 실행할 수 없습니다. Mini-IDE 빠른 열기와 AI CLI 터미널의 ⌘ 클릭은 이제 `OrderService.php:137-158`과 `#L10-L20`을 인식해 해당 줄을 엽니다.',
        'es-ES': 'Plugins de Navide: un plugin puede declarar comandos que asignas a teclas en Ajustes → Atajos; los agentes no pueden ejecutarlos. Apertura rápida de Mini-IDE y ⌘-clic en la terminal de la CLI de IA ahora entienden `OrderService.php:137-158` y `#L10-L20`, y abren en esa línea.',
        'fr-FR': 'Plugins Navide : un plugin peut déclarer des commandes que vous associez à des touches dans Réglages → Raccourcis ; les agents ne peuvent pas les exécuter. L’ouverture rapide de Mini-IDE et le ⌘-clic dans le terminal de la CLI IA comprennent désormais `OrderService.php:137-158` et `#L10-L20`, et ouvrent à cette ligne.',
        'de-DE': 'Navide-Plugins: Ein Plugin kann Befehle deklarieren, die du unter Einstellungen → Tastenkombinationen belegst; Agents können sie nicht ausführen. Quick Open in Mini-IDE und ⌘-Klick im AI-CLI-Terminal verstehen jetzt `OrderService.php:137-158` und `#L10-L20` und öffnen an dieser Zeile.',
        'pt-BR': 'Plugins do Navide: um plugin pode declarar comandos que você associa a teclas em Configurações → Atalhos; os agentes não podem executá-los. A Abertura Rápida do Mini-IDE e o ⌘-clique no terminal da CLI de IA agora entendem `OrderService.php:137-158` e `#L10-L20` e abrem nessa linha.',
        'ru-RU': 'Плагины Navide: плагин может объявлять команды, которые вы назначаете на клавиши в разделе «Настройки → Сочетания клавиш»; агенты не могут их запускать. Быстрое открытие в Mini-IDE и ⌘-клик в терминале AI CLI теперь понимают `OrderService.php:137-158` и `#L10-L20` и открывают файл на этой строке.',
        'vi-VN': 'Plugin Navide: plugin có thể khai báo lệnh để bạn gán phím trong Cài đặt → Phím tắt; agent không thể chạy các lệnh này. Mở nhanh của Mini-IDE và ⌘-nhấp trong terminal AI CLI nay hiểu `OrderService.php:137-158` và `#L10-L20`, rồi mở tới đúng dòng.',
      },
      {
        'zh-TW': 'Pipeline：n8n 匯入現在會照實處理有多個輸出、但不是 IF 或 Switch 的節點（例如 Compare Datasets）。小範圍會折成一個步驟，太大的範圍會標成待審查。',
        'en-US': 'Pipelines: n8n import is now honest about nodes with several outputs that are neither IF nor Switch, such as Compare Datasets. A small region folds into one step, and one too large to fold is marked for review.',
        'ja-JP': 'パイプライン：n8n のインポートで、IF でも Switch でもない複数出力のノード（Compare Datasets など）を正確に扱うようになりました。小さな範囲は 1 つのステップにまとめ、大きすぎる範囲は要レビューとして示します。',
        'zh-CN': 'Pipeline：n8n 导入现在会如实处理有多个输出、但不是 IF 或 Switch 的节点（例如 Compare Datasets）。小范围会合并成一个步骤，过大的范围会标记为待审查。',
        'ko-KR': '파이프라인: n8n 가져오기가 이제 IF나 Switch가 아니면서 출력이 여러 개인 노드(Compare Datasets 등)를 정확히 다룹니다. 작은 영역은 한 단계로 묶고, 묶기에 너무 큰 영역은 검토 필요로 표시합니다.',
        'es-ES': 'Pipelines: la importación de n8n ahora trata con exactitud los nodos con varias salidas que no son IF ni Switch, como Compare Datasets. Una región pequeña se pliega en un paso, y una demasiado grande se marca para revisión.',
        'fr-FR': 'Pipelines : l’import n8n traite désormais fidèlement les nœuds à plusieurs sorties qui ne sont ni IF ni Switch, comme Compare Datasets. Une petite région est repliée en une étape, et une région trop grande est marquée à examiner.',
        'de-DE': 'Pipelines: Der n8n-Import behandelt Knoten mit mehreren Ausgängen, die weder IF noch Switch sind, etwa Compare Datasets, jetzt korrekt. Ein kleiner Bereich wird zu einem Schritt zusammengefasst, ein zu großer zur Prüfung markiert.',
        'pt-BR': 'Pipelines: a importação do n8n agora trata com precisão nós com várias saídas que não são IF nem Switch, como Compare Datasets. Uma região pequena vira uma etapa, e uma grande demais é marcada para revisão.',
        'ru-RU': 'Пайплайны: импорт из n8n теперь честно обрабатывает узлы с несколькими выходами, которые не являются IF или Switch, например Compare Datasets. Небольшая область сворачивается в один шаг, а слишком большая помечается для проверки.',
        'vi-VN': 'Pipeline: nhập n8n nay xử lý đúng các nút có nhiều đầu ra nhưng không phải IF hay Switch, như Compare Datasets. Vùng nhỏ được gộp thành một bước, vùng quá lớn được đánh dấu cần xem xét.',
      },
    ],
  },
  {
    version: '0.2.35',
    title: {
      'zh-TW': 'Navide Browser 隨 App 內建，Plans 可以直接編輯，App 上鎖支援 Windows Hello，Telegram 更安全',
      'en-US': 'Navide Browser Built In, Plans You Can Edit, Windows Hello for App Lock and Safer Telegram',
      'ja-JP': 'Navide Browser を標準搭載、プランを直接編集、App Lock は Windows Hello に対応、Telegram はより安全に',
    },
    highlights: [
      {
        'zh-TW': 'Navide Browser：現在隨 App 內建並預設啟用，不必再到 Navide Marketplace 安裝，按 ⌘⇧X（Windows 和 Linux 是 Ctrl+Shift+X）就能開啟。Space 現在有分頁，可以「並排顯示」最多 9 個 Space，或「一次一個」全尺寸顯示；每個 Space 會顯示開啟中的對話框和 agent 上傳過的每個檔案。agent 多了 8 個工具，包括分頁、等待、回應對話框和上傳工作區內的檔案。agent 工具由「設定 → Navide 外掛」的「允許 agent 呼叫官方 Navide 外掛的工具」控制，預設開啟；整個 Navide Browser 也可以在同一頁停用。',
        'en-US': 'Navide Browser: it now ships with the App and is on by default, with no Navide Marketplace install, and ⌘⇧X (Ctrl+Shift+X on Windows and Linux) opens it. Spaces have tabs and can run Side by Side, up to 9 at once, or One at a Time at full size; each Space shows an open dialog and every file the agent uploaded. Agents gain 8 tools, including tabs, waiting, answering dialogs and uploading files from the workspace. Let agents call tools from first-party Navide plugins, on by default in Settings → Navide Plugins, controls those tools, and Navide Browser can be disabled on the same page.',
        'ja-JP': 'Navide Browser：App に標準搭載され、既定で有効になりました。Navide Marketplace からのインストールは不要で、⌘⇧X（Windows と Linux では Ctrl+Shift+X）で開けます。Space にタブが付き、最大 9 個を「並べて表示」するか、「1 つずつ表示」で全画面に表示できます。各 Space には、開いているダイアログと agent がアップロードしたすべてのファイルが表示されます。agent のツールは 8 つ増え、タブ操作、待機、ダイアログへの応答、ワークスペース内のファイルのアップロードなどができます。これらのツールは「設定 → Navide プラグイン」の「エージェントに純正 Navide プラグインのツール呼び出しを許可」で切り替えられ、既定でオンです。Navide Browser 自体も同じページで無効にできます。',
      },
      {
        'zh-TW': 'Plans：在 Plan 視圖按 HTML 計畫上方的「編輯文件」，就能直接修改整份文件，變更會自動存檔。agent 改到你正在編輯的段落時，會跳出對話框讓你選要保留哪一版，不會互相覆蓋。每次變更都會留下版本：「歷史」列出修改者（你、哪個 agent 分格，或 Plans 以外的修改）和原因，可以看「差異」或「還原」。還原只換內文，階段、核准狀態、待辦和審查留言都維持現在的樣子。已核准的計畫內文被改過時會顯示「核准後已修改」，點一下就能比對。',
        'en-US': 'Plans: Edit document above an HTML plan in the Plan view makes the whole document editable, and changes save by themselves. If an agent changes the section you are editing, a dialog lets you choose which version to keep, so neither overwrites the other. Every change now keeps a version: History shows who made it (you, a named agent pane, or a change outside Plans) and why, with Diff and Restore. Restore brings back the text only and keeps the stage, approval, todos and review notes. An approved plan whose text changed shows Changed since approval; click it to compare.',
        'ja-JP': 'プラン：Plan ビューで HTML プランの上にある「ドキュメントを編集」を押すと、ドキュメント全体を直接編集でき、変更は自動で保存されます。編集中のセクションを agent が変更したときは、ダイアログでどちらの版を残すかを選べるので、互いに上書きされることはありません。変更のたびに版が残ります。「履歴」には、変更した人（あなた、どの agent pane か、または Plans の外での変更）と理由が表示され、「差分」と「復元」が使えます。復元で戻るのは本文だけで、ステージ、承認、ToDo、レビューノートは現在のまま残ります。承認済みのプランの本文が変更されると「承認後に変更あり」と表示され、クリックすると比較できます。',
      },
      {
        'zh-TW': 'App 上鎖：Windows 11 現在可以用 Windows Hello 解鎖，PIN 仍可當備用，忘記 PIN 時可以在通過 Windows Hello 後重設。Windows 10 和 Linux 只能用 PIN 解鎖，「設定 → App Lock」會直接說明。鎖定畫面顯示時，應用程式選單會變灰，只留下隱藏、結束、視窗控制和輸入 PIN 需要的編輯鍵，快捷鍵也碰不到畫面後方的 App；agent、終端機和排程仍照常執行。',
        'en-US': 'App Lock: Windows 11 now unlocks with Windows Hello, with the PIN as the fallback, and a forgotten PIN can be reset after Windows Hello. Windows 10 and Linux unlock with the PIN only, and Settings → App Lock says so. While the lock screen is up, the application menu is greyed out except for Hide, Quit, the window controls and the editing keys the PIN box needs, and shortcuts cannot reach the App behind it. Agents, terminals and schedules keep running.',
        'ja-JP': 'App Lock：Windows 11 で Windows Hello による解除ができるようになりました。PIN は予備として使え、忘れた PIN は Windows Hello のあとでリセットできます。Windows 10 と Linux は PIN でのみ解除し、「設定 → App Lock」にもそう表示されます。ロック画面の表示中は、アプリケーションメニューのうち、隠す、終了、ウィンドウ操作、PIN 入力に必要な編集キー以外はグレーアウトし、ショートカットも背後の App に届きません。agent、ターミナル、スケジュールはそのまま動き続けます。',
      },
      {
        'zh-TW': 'Telegram：用連結代碼不會再直接加入允許名單，還沒獲准的人要先由你在「設定 → 聊天室」核准。Telegram 的共用 ID（例如匿名管理員）一律拒絕，舊的名單列會標上警告，由你決定是否移除。允許名單會顯示每個人怎麼加入、何時加入。分格綁定到發送者還沒獲准的聊天時，聊天裡和「設定 → 聊天室」都會提醒，不再看起來已連線卻只收到配對回覆。',
        'en-US': 'Telegram: redeeming a link code no longer adds someone straight to the allowed list; a new sender waits for your approval in Settings → Channels. Telegram’s shared IDs, such as anonymous admins, are always refused, and an older row holding one gets a warning for you to remove. The allowed list shows how and when each sender was added. A pane bound to a chat whose sender is not allowed now says so, in the chat and in Settings → Channels, instead of looking connected while the chat only gets pairing replies.',
        'ja-JP': 'Telegram：リンクコードを使っても、すぐには許可リストに追加されなくなりました。まだ許可されていない人は、「設定 → チャット連携」であなたの承認を待ちます。匿名管理者などの Telegram の共有 ID は常に拒否され、それを含む既存の行には警告が付くので、削除するかどうかを判断できます。許可リストには、各送信者が追加された方法と日時が表示されます。送信者が許可されていないチャットに pane を紐づけると、接続済みに見えるのにペアリングの返信しか届かない状態にはならず、チャットと「設定 → チャット連携」で知らせます。',
      },
      {
        'zh-TW': '快捷鍵與 Windows：在 Windows 和 Linux 上，開啟 Plans、Git 視窗和 Mini IDE 有能用的預設快捷鍵（Ctrl+Shift+D、Ctrl+Shift+G、Ctrl+Shift+M）。在開著 Defender 的 Windows 11 arm64 電腦上，每次 hook 不再多等約 23 秒。',
        'en-US': 'Shortcuts and Windows: on Windows and Linux, Open Plans, the Git window and the Mini IDE have working default keys (Ctrl+Shift+D, Ctrl+Shift+G and Ctrl+Shift+M). On a Windows 11 arm64 machine with Defender on, a hook run no longer waits about 23 seconds.',
        'ja-JP': 'ショートカットと Windows：Windows と Linux で、プランを開く、Git ウィンドウ、Mini IDE に使える既定のショートカット（Ctrl+Shift+D、Ctrl+Shift+G、Ctrl+Shift+M）が付きました。Defender が有効な Windows 11 arm64 のマシンでは、hook の実行ごとに約 23 秒待たなくなりました。',
      },
    ],
  },
  {
    version: '0.2.34',
    title: {
      'zh-TW': 'App 上鎖遮住畫面保護隱私，Pipeline 可以從 n8n 匯入',
      'en-US': 'App Lock Covers Your Screen, and Pipelines Import from n8n',
      'ja-JP': 'App Lock で画面を隠してプライバシーを守り、パイプラインは n8n からインポート可能に',
    },
    highlights: [
      {
        'zh-TW': 'App 上鎖：「設定 → App Lock」可以用一張鎖定畫面蓋住所有 Navide 視窗，在 Mac 上用 Touch ID 或 4～12 位數 PIN 解鎖。它只遮住畫面、不限制任何功能：agent、終端機、聊天頻道、MCP 工具和排程都照常執行。可以用「立即鎖定」（⌘⌥L）手動上鎖，也可以設定閒置 1～60 分鐘、螢幕鎖定或電腦睡眠時自動上鎖；啟動時上鎖預設關閉。Windows 和 Linux 目前只能用 PIN 解鎖。',
        'en-US': 'App Lock: Settings → App Lock puts a lock screen over every Navide window, unlocked with Touch ID on a Mac or a 4-to-12-digit PIN. It only covers the screen and stops nothing: agents, terminals, chat channels, MCP tools and schedules keep running. Lock with Lock Now (⌘⌥L), or automatically after 1 to 60 idle minutes, when the screen locks or when the computer sleeps; locking at start is off by default. Windows and Linux unlock with the PIN only, for now.',
        'ja-JP': 'App Lock：「設定 → App Lock」で、すべての Navide ウィンドウをロック画面で覆い、Mac では Touch ID または 4〜12 桁の PIN で解除できます。画面を隠すだけで、機能は何も止めません。agent、ターミナル、チャットチャンネル、MCP ツール、スケジュールはそのまま動き続けます。「今すぐロック」（⌘⌥L）で手動でロックできるほか、1〜60 分操作がないとき、画面がロックされたとき、コンピューターがスリープしたときに自動でロックできます。起動時のロックは既定でオフです。Windows と Linux では、今のところ PIN でのみ解除します。',
      },
      {
        'zh-TW': 'Pipeline：「流程管理」新增「從 n8n 匯入」。貼上 n8n 匯出的工作流程或選擇檔案，匯入前會先預覽每個步驟轉成什麼、需要在這台電腦設定哪些憑證；IF、Switch、錯誤輸出、失敗重試和 Execute Workflow 都會轉成對應的分支、錯誤連線、重試和子流程。匯入一律建立新的 Pipeline，原始 JSON 和憑證清單只留在這台電腦。',
        'en-US': 'Pipelines: Pipeline Manager gains Import from n8n. Paste an exported n8n workflow or choose its file and preview, before anything is written, how each step converts and which credentials to set up on this machine. IF, Switch, error outputs, Retry On Fail and Execute Workflow become branches, error links, retries and sub-pipelines. An import always creates a new pipeline, and the source JSON and credential list stay on this machine.',
        'ja-JP': 'パイプライン：「パイプライン管理」に「n8n からインポート」が加わりました。n8n からエクスポートしたワークフローを貼り付けるかファイルを選ぶと、書き込む前に、各ステップが何に変換されるか、このマシンで設定が必要な認証情報は何かをプレビューできます。IF、Switch、エラー出力、Retry On Fail、Execute Workflow は、分岐、エラーリンク、リトライ、サブパイプラインになります。インポートは常に新しいパイプラインを作り、元の JSON と認証情報の一覧はこのマシンにだけ残ります。',
      },
      {
        'zh-TW': 'Pipeline：步驟可以依 agent 的回報走不同分支、失敗時改走錯誤連線、自動重試，也可以呼叫另一個 Pipeline 並等它完成；排程可以啟動 Pipeline。編輯器的工具列整理進「⋯」選單，「重試此步驟」、「從這裡重跑」等收進「復原」選單，停用時會說明原因；錯誤訊息改用介面語言，並有「詳細」按鈕。',
        'en-US': 'Pipelines: a step can take a branch by what its agent reports, follow an error link when it fails, retry on its own, or call another pipeline and wait for it, and a schedule can start a pipeline. The editor’s toolbar moves into a ⋯ menu, Retry This Step, Rerun from Here and the rest sit in one Recover menu that says why an action is off, and errors are in the interface language with a Details button.',
        'ja-JP': 'パイプライン：ステップは agent の報告に応じて分岐し、失敗したときはエラーリンクに進み、自動でリトライし、別のパイプラインを呼び出して終わるのを待てるようになりました。スケジュールからパイプラインを開始することもできます。エディターのツールバーは「⋯」メニューにまとまり、「このステップをリトライ」や「ここから再実行」などは「復旧」メニューに入り、使えないときは理由を表示します。エラーは表示言語で表示され、「詳細」ボタンがあります。',
      },
      {
        'zh-TW': '帳號：agent 用 MCP 開出的 Claude 分格，預設沿用開它的那個分格的帳號，不再一律用目前登入的帳號；agent 也可以指定某個帳號。agent 還可以請求只把某一個分格換到別的帳號（由你在切換對話框確認），並查到每個分格用的是哪個帳號。',
        'en-US': 'Accounts: a Claude pane an agent opens through MCP now runs on the same account as the pane that opened it, instead of always the current login, or on an account the agent names. An agent can also ask to move a single pane to another account, which you confirm in the switch dialog, and see which account each pane runs on.',
        'ja-JP': 'アカウント：agent が MCP で開いた Claude の pane は、常に今のログインを使うのではなく、開いた pane と同じアカウントで動くようになりました。agent がアカウントを指定することもできます。agent は 1 つの pane だけを別のアカウントに移すよう求めることもでき（切り替えダイアログであなたが確認します）、各 pane がどのアカウントで動いているかも確認できます。',
      },
      {
        'zh-TW': '自我優化：面板新增「重複手動的事」和「你的糾正」兩種回顧，以及「回收前回顧」和同一個錯誤短時間大量出現時的「提早執行」（後兩項預設關閉）。被採納的提案會記錄落地方式，7 天後自動檢查有沒有效；程式碼只會以 draft PR 交給你決定。',
        'en-US': 'Self-evolution: the panel adds two retrospectives, Repeated manual work and Your corrections, plus Retrospective at reclaim and Early run when one error bursts (both off by default). Adopted proposals record how they land and are checked for effect after 7 days; code only ever arrives as a draft pull request for you to decide on.',
        'ja-JP': '自己改善：パネルに「繰り返しの手作業」と「あなたの指摘」の 2 つの振り返りと、「回収前の振り返り」、同じエラーが短時間に多発したときの「早めの実行」が加わりました（後の 2 つは既定でオフ）。採用された提案はどう反映するかを記録し、7 日後に効果を自動で確認します。コードは必ず draft pull request として届き、判断はあなたに任されます。',
      },
      {
        'zh-TW': '分格：MCP 伺服器或技能變更後，之前就啟動的分格標題列會顯示「設定已更新」，點一下就能「重建」。後端重新啟動後，除了畫面上的分格，也會接回最多六個在畫面外工作的分格，並在通知裡列出哪些接回了、哪些沒有。',
        'en-US': 'Panes: a pane that started before its MCP servers or skills changed now shows Settings changed in its title bar, with Rebuild one click away. After the backend restarts, up to six panes working off screen come back too, besides the ones on screen, and the announcements list which came back and which did not.',
        'ja-JP': 'pane：MCP サーバーやスキルが変わる前に起動した pane は、タイトルバーに「設定が変更されました」と表示し、クリックひとつで「再構築」できます。バックエンドが再起動したあと、画面上の pane に加えて、画面外で作業していた pane も最大 6 つまで戻り、お知らせにはどれが戻ってどれが戻らなかったかが表示されます。',
      },
      {
        'zh-TW': '安全與頻道：Navide Guard 會用和內建 shell 相同的規則檢查第三方 MCP 的 shell、檔案、登錄檔和結束程序工具，「設定 → MCP」會標示能執行指令的伺服器。在分格裡回答完 Claude 的提問後，Telegram 等聊天不會再多收到一則只有輸入框的假確認訊息。',
        'en-US': 'Security and channels: Navide Guard grades third-party MCP shell, file, registry and process tools by the same rules as the built-in shell, and Settings → MCP marks servers that can run commands. After you answer a Claude question in the pane, Telegram and other chats no longer get a stray confirmation that shows only the input box.',
        'ja-JP': 'セキュリティとチャンネル：Navide Guard は、サードパーティ MCP のシェル、ファイル、レジストリ、プロセス終了のツールを、組み込みのシェルと同じルールで判定します。「設定 → MCP」では、コマンドを実行できるサーバーに印が付きます。pane で Claude の質問に答えたあと、Telegram などのチャットに入力欄だけの確認メッセージが余分に届くことはなくなりました。',
      },
      {
        'zh-TW': '設定：各頁的清單和空白狀態寫法一致，文字最小 12px、鍵盤操作有焦點框，狀態改用文字標示；俄文和德文介面的分格等 Navide 名詞改為譯名。',
        'en-US': 'Settings: lists and empty states read the same on every page, text is at least 12px, keyboard focus is visible and status is spelled out in words; the Russian and German interfaces translate pane and other Navide terms.',
        'ja-JP': '設定：どのページでも一覧と空の状態の書き方がそろい、文字は 12px 以上、キーボード操作ではフォーカス枠が見え、状態は文字で表示されるようになりました。ロシア語とドイツ語の表示では、pane などの Navide の用語を翻訳しました。',
      },
    ],
  },
  {
    version: '0.2.33',
    title: {
      'zh-TW': '從聊天喚醒分格會接回原本的對話，聊天文字支援 11 種語言',
      'en-US': 'Waking a Pane from Chat Brings Back Its Conversation, in All 11 Languages',
      'ja-JP': 'チャットから pane を起こすと元の会話に戻り、チャットの文字は 11 言語に対応',
    },
    highlights: [
      {
        'zh-TW': '頻道：在 Telegram 等聊天軟體喚醒離線的分格時，Navide 會直接把分格開回原本的對話，不再等 30 秒後回報「喚醒失敗」；八個聊天平台都適用。聊天裡的文字（喚醒按鈕與提示、快速選單、檔案通知、Telegram 的指令選單）現在跟著 Navide 的介面語言，11 種語言都有；Prompt 技能和技能的名稱也和設定頁一致。Mattermost 上直接輸入 wake 就能喚醒。',
        'en-US': 'Channels: waking an offline pane from Telegram or another chat app now opens the pane onto its conversation, instead of waiting 30 seconds and answering that the wake failed, on all eight chat platforms. Chat text (the wake button and hint, the quick menu, file notices and Telegram’s command menu) now follows Navide’s interface language, in all 11 languages, and names Prompts and Skills as the Settings pages do. On Mattermost, typing wake wakes the pane.',
        'ja-JP': 'チャンネル：Telegram などのチャットアプリからオフラインの pane を起こすと、30 秒待って「起こせませんでした」と返すのではなく、pane を元の会話のまま開くようになりました。8 つのチャットプラットフォームすべてで同じです。チャットの文字（起こすボタンと案内、クイックメニュー、ファイルのお知らせ、Telegram のコマンドメニュー）は Navide の表示言語に合わせて 11 言語で表示され、プロンプトとスキルの名前も設定ページと同じになりました。Mattermost では wake と入力するだけで起こせます。',
      },
      {
        'zh-TW': '頻道：轉到聊天的權限確認，不會再因為 Claude Code 自動拒絕的倒數秒數而每秒重送一次，導致回覆 yes 也核准不了。Navide Guard 一定會擋下的確認，聊天裡只提供「拒絕」，並說明這個動作要在電腦前允許。',
        'en-US': 'Channels: a permission prompt relayed to chat is no longer sent again every second as Claude Code’s auto-deny countdown ticks, which kept a yes reply from approving it. A prompt Navide Guard will always refuse from chat now offers only 拒絕 (Deny) and says it must be allowed at the computer.',
        'ja-JP': 'チャンネル：チャットに転送した権限の確認が、Claude Code の自動拒否のカウントダウンで毎秒送り直され、yes と返信しても承認できなくなることはなくなりました。Navide Guard が必ず拒否する確認は、チャットでは「拒絕」（拒否）だけを表示し、パソコンで許可する必要があることを伝えます。',
      },
      {
        'zh-TW': '第一次啟動：設定精靈拿掉了「環境」步驟（Homebrew、Node、pnpm、Python、uv），在 Linux 上也能直接進入 App。安裝 CLI 時會先說明並依序裝好它需要的東西。Ollama 的安裝、啟動和選第一個模型移到「設定 → Analyzer」；需要 Node.js 的 MCP 伺服器會標示「需要 Node.js」，並有「安裝 Node.js」按鈕。',
        'en-US': 'First run: the setup wizard no longer has its Environment step (Homebrew, Node, pnpm, Python, uv), so you can open the app on Linux too. Installing a CLI says what it installs first and installs it in order. Installing Ollama, starting it and picking a first model move to Settings → Analyzer, and an MCP server that runs on Node.js is marked Needs Node.js, with an Install Node.js button.',
        'ja-JP': '初回起動：セットアップウィザードから「環境」のステップ（Homebrew、Node、pnpm、Python、uv）をなくし、Linux でもそのままアプリを開けるようになりました。CLI をインストールするときは、先に必要なものを案内して順番にインストールします。Ollama のインストール、起動、最初のモデルの選択は「設定 → Analyzer」に移りました。Node.js で動く MCP サーバーには「Node.js が必要」と表示され、「Node.js をインストール」ボタンがあります。',
      },
      {
        'zh-TW': 'Pipeline：停在閘門等你核准的執行，側欄的執行卡會顯示正在哪個閘門等待，並提供「核准並繼續」和「退回修改」；等待時「下一步」會停用並說明原因。在 Pipeline 編輯器輸入任務，就能按「▶ 執行流程」直接執行；「執行紀錄」對已結束的執行多了「重設」。',
        'en-US': 'Pipelines: a run waiting at a gate for your approval now says so on the sidebar’s run card, naming the gate, with Approve and Continue and Send Back; Next is disabled while it waits and says why. In the pipeline editor, type a task and press ▶ Run Pipeline to run it there, and Executions offers Reset for a finished run.',
        'ja-JP': 'パイプライン：ゲートで承認を待っている実行は、サイドバーの実行カードにどのゲートで待っているかを表示し、「承認して続行」と「差し戻す」を出すようになりました。待っている間は「次へ」が無効になり、理由を表示します。パイプラインエディターでタスクを入力して「▶ パイプラインを実行」を押せばその場で実行でき、「実行履歴」では終わった実行を「リセット」できます。',
      },
      {
        'zh-TW': '帳號：「設定 → CLI 帳號」的第一張卡改名為「原始登入」（你在 Navide 外原本的登入），正在使用的帳號標示「生效中」，「設為預設」改為「切換到此帳號」。原始登入是空的時，不再提供會清掉目前登入的切換按鈕；按「登入」之前會先說明會發生什麼。',
        'en-US': 'Accounts: the first card in Settings → CLI Accounts is now named Original login (the login you had outside Navide), the account in use is marked Active, and Set as Default reads Switch to This Account. While Original login is empty, it no longer offers a switch that would clear your current login, and Sign In says what happens before it goes ahead.',
        'ja-JP': 'アカウント：「設定 → CLI アカウント」の最初のカードは「元のログイン」（Navide の外で使っていたログイン）という名前になり、使用中のアカウントには「有効」と表示され、「既定に設定」は「このアカウントに切り替え」になりました。元のログインが空のときは、今のログインを消してしまう切り替えボタンを表示せず、「ログイン」を押すと先に何が起きるかを説明します。',
      },
      {
        'zh-TW': '檔案選擇器：把 agent 給的位置（例如 app/Services/OrderService.php:137-158）貼進來，現在找得到檔案並開在第 137 行，不再顯示「No files found」。含資料夾的搜尋也找得到，完全符合的排在前面；@file 自動完成也一樣。',
        'en-US': 'File picker: pasting a location an agent gave you, such as app/Services/OrderService.php:137-158, now finds the file and opens it at line 137 instead of showing No files found. A search that includes folders finds the file too, with exact matches first, and so does @file autocomplete.',
        'ja-JP': 'ファイルピッカー：agent が示した場所（app/Services/OrderService.php:137-158 など）を貼り付けると、「No files found」ではなく、ファイルを見つけて 137 行目で開くようになりました。フォルダーを含めて検索しても見つかり、完全に一致するものが先に並びます。@file の補完も同じです。',
      },
    ],
  },
  {
    version: '0.2.32',
    title: {
      'zh-TW': '金鑰只留在本機：MCP 同步只同步安裝，Agent 資產的修改都能復原',
      'en-US': 'Secrets Stay on This Machine: MCP Sync Carries Only What Is Installed, and Agent Asset Edits Can Be Undone',
      'ja-JP': 'シークレットはこのマシンだけに：MCP の同期はインストール内容だけ、エージェント資産の変更は元に戻せます',
    },
    highlights: [
      {
        'zh-TW': 'MCP 同步只同步「裝了哪些伺服器」：名稱、連線方式、指令與參數、網址、開關，以及環境變數和 header 的名稱。它們的值不會離開這台電腦，網址和參數裡的帳密與 token（例如 user:password@、?api_key=、ghp_…、--token 後面的值）也一樣。從別台裝置同步過來的伺服器，只有在指令與參數或網址都沒變時，才會沿用這台電腦自己填過的值；改了要執行的東西，或這台電腦還沒有的值，都會留空，即使你核准了這個變更也一樣，「設定 → MCP」會標「需要設定」並提醒你在這台電腦填入，你的 token 不會被交給另一個程式或網址。只改值不再觸發同步，其他裝置也不會再為此要你核准。舊版已上傳的值仍留在伺服器上，這一版不會刪除；還沒更新的裝置照舊同步，不會收到被清空的設定。',
        'en-US': 'MCP sync now carries only which servers are installed: name, transport, command and arguments, URL, on/off, and the names of environment variables and headers. Their values never leave this machine, and neither do credentials inside a URL or the arguments (such as user:password@, ?api_key=, ghp_… or the value after --token). A server that arrives from another device keeps the values this machine already has only if it still runs the same command and arguments, or the same URL; if it changed what it runs, or this machine has no value yet, the field is left empty, even after you approve the change, and Settings → MCP marks the server Needs setup and asks you to fill it in here, so your token is never handed to a different program or address. Changing only a value no longer syncs or asks for approval on your other devices. Values older versions uploaded stay on the server and are not deleted by this release, and devices not yet updated keep syncing as before, without being sent servers with their values emptied.',
        'ja-JP': 'MCP の同期は「どのサーバーをインストールしているか」だけになりました：名前、接続方式、コマンドと引数、URL、オン／オフ、環境変数とヘッダーの名前です。それらの値はこのマシンから出ません。URL や引数に含まれる認証情報やトークン（user:password@、?api_key=、ghp_…、--token の後の値など）も同じです。ほかのデバイスから届いたサーバーがこのマシンにすでにある値を使うのは、コマンドと引数、または URL が変わっていない場合だけです。実行するものが変わった場合や、このマシンにまだ値がない場合は、変更を承認しても空欄のままで、「設定 → MCP」に「要設定」と表示され、このマシンで入力するよう案内します。トークンが別のプログラムやアドレスに渡されることはありません。値だけを変えても同期されず、ほかのデバイスで承認を求められることもなくなりました。旧バージョンがアップロードした値はサーバーに残り、このリリースでは削除しません。まだ更新していないデバイスはこれまでどおり同期し、値が空になったサーバーを受け取ることはありません。',
      },
      {
        'zh-TW': '「設定 → 帳號」裡的「貼入憑證」已移除：Navide 不再把貼入的憑證（例如 claude setup-token 產生的）交給新開的分格。用過這個功能的裝置，更新時會清除存在本機的憑證、加密它的金鑰，以及舊版從雲端拉下來的副本，並在第一次啟動時通知一次；沒用過的裝置什麼都不會動。新的 Claude 分格改用 Claude 自己的登入，可能是另一個帳號，並扣用那個帳號的額度。已經開著的分格會沿用原本的憑證，直到關閉或重新啟動。',
        'en-US': 'Paste Credential is gone from Settings → Accounts: Navide no longer hands pasted credentials (such as one from claude setup-token) to new panes. On a device that used it, the update erases the stored credentials, the key that encrypted them and the copies older versions pulled from the cloud, and says so once at the first launch; a device that never used it is not touched. New Claude panes now use Claude’s own sign-in, which may be a different account and draws on that account’s quota. Panes already open keep their credential until they are closed or restarted.',
        'ja-JP': '「設定 → アカウント」の「認証情報を貼り付け」を廃止しました。Navide は貼り付けた認証情報（claude setup-token で作ったものなど）を新しい pane に渡さなくなります。この機能を使ったデバイスでは、更新時に保存されていた認証情報、それを暗号化していた鍵、旧バージョンがクラウドから取得したコピーを消去し、初回起動時に一度だけお知らせします。使っていないデバイスには何もしません。新しい Claude pane は Claude 自身のサインインを使うため、別のアカウントになり、そのアカウントの使用量枠が消費されることがあります。すでに開いている pane は、閉じるか再起動するまで元の認証情報を使い続けます。',
      },
      {
        'zh-TW': '「設定 → Agent 資產 → 記憶」：沒存的草稿不會再被默默丟掉，取消、關閉、切到別的檔案或關掉設定之前都會先問你。每次存檔都會把被取代的版本留一份在 Navide 自己的資料夾，按「還原上一版」就能救回來；編輯器新建的檔案也能「復原建立」，移到系統垃圾桶，不會直接刪除。這一頁也開始列出 Claude Code 自己寫的專案自動記憶（MEMORY.md 和各主題檔），可以打開、編輯和還原，並標明是 Claude 寫的、之後可能被它改寫。',
        'en-US': 'Settings → Agent Assets → Memory: an unsaved draft is no longer thrown away without asking; Cancel, closing, opening another file and closing Settings ask first. Each save keeps the version it replaced in Navide’s own folder, and Restore Previous Version brings it back; a file the editor created can be undone with Undo Create, which moves it to the system Trash instead of deleting it. The page now also lists the auto-memory Claude Code writes about the project by itself (MEMORY.md and one file per topic), which you can open, edit and restore; it is marked as written by Claude, which may rewrite it later.',
        'ja-JP': '「設定 → エージェント資産 → メモリ」：保存していない下書きが確認なしに破棄されることはなくなりました。キャンセル、閉じる、別のファイルを開く、設定を閉じる前に確認します。保存するたびに置き換えられた版を Navide 自身のフォルダーに 1 つ残し、「前のバージョンに戻す」で元に戻せます。エディターで新しく作ったファイルは「作成を取り消す」でシステムのゴミ箱に移せ、直接削除はしません。このページには、Claude Code がプロジェクトについて自分で書く自動メモリ（MEMORY.md とトピックごとのファイル）も表示されるようになり、開く・編集する・元に戻すことができます。Claude が書いたもので、後で Claude が書き換えることがあると表示されます。',
      },
      {
        'zh-TW': '「設定 → Agent 資產 → Prompt 技能」：把內容清空不會再把整個 Prompt 技能刪掉（以前連同步的其他電腦也會跟著刪），原本的文字會保留，並提示要刪除請按「刪除」；按「刪除」也會先確認，並說明同步的電腦也會一起移除。Prompt 技能在分格裡啟動循環失敗時，會跳出錯誤通知。',
        'en-US': 'Settings → Agent Assets → Prompts: clearing a prompt’s text no longer deletes the prompt (on your synced machines too); the previous text is kept, with a note to use Delete to remove it. Delete now asks first and says your synced machines will remove it too. When a prompt’s loop fails to start in a pane, an error notice says so.',
        'ja-JP': '「設定 → エージェント資産 → プロンプト」：内容を空にしてもプロンプト自体が削除されることはなくなりました（以前は同期しているほかのマシンでも削除されていました）。元のテキストは残り、削除するには「削除」を使うよう案内します。「削除」も先に確認し、同期しているマシンからも削除されることを伝えます。pane でプロンプトのループを開始できなかったときは、エラーの通知が表示されます。',
      },
      {
        'zh-TW': '「設定 → Agent 資產 → MCP」遮蔽得更完整：除了看名稱，也會看值，網址裡的帳密、token 樣式的值和參數都會遮起來，agent 用 mcp_list 讀到的也一樣。匯入舊版設定包時，只有名稱和連線位置（指令與參數，或網址）都相同的伺服器，才會補回這台電腦的金鑰；同名但指向別處的不會拿到，沒有可補的就留空並列在匯入結果裡。列不出工具的伺服器會顯示原因，不再看起來像是沒有工具。',
        'en-US': 'Settings → Agent Assets → MCP masks more: values are checked as well as names, so a user:password@ in a URL and token-shaped values and arguments are masked, including what agents read through mcp_list. Importing an older settings bundle puts this machine’s secret back only for a server whose name and endpoint (command and arguments, or URL) both match; a same-named server pointing elsewhere no longer gets it, and anything left empty is listed in the import summary. A server whose tools cannot be listed says why instead of looking like it has none.',
        'ja-JP': '「設定 → エージェント資産 → MCP」のマスクがより確実になりました。名前だけでなく値も確認し、URL 内のユーザー名とパスワード、トークンの形をした値や引数をマスクします。agent が mcp_list で読む内容も同じです。古い設定バンドルをインポートしたとき、このマシンのシークレットを戻すのは、名前と接続先（コマンドと引数、または URL）の両方が一致するサーバーだけです。同じ名前でも別の場所を指すサーバーには戻さず、空欄のままのものはインポート結果に一覧表示します。ツールを一覧できないサーバーは、ツールがないように見えるのではなく、その理由を表示します。',
      },
      {
        'zh-TW': 'Skills：agent 想把技能送到更多 CLI，或打開停用中的共用技能時，要先在主視窗經你核准，和安裝一樣；縮小範圍則照舊直接生效。Navide 也內建了一個教 agent 寫 Navide 外掛的技能（navide:plugin-authoring），同樣要你核准才會安裝。技能接到分格失敗時，分格啟動時會印出來，不再只寫進紀錄。',
        'en-US': 'Skills: when an agent asks to deliver a skill to more CLIs, or to turn a disabled shared skill on, you now approve it in the main window, as with an install; narrowing still applies at once. Navide also ships a skill that teaches an agent to write Navide plugins (navide:plugin-authoring), installed only once you approve it. When wiring skills into a pane fails, the pane prints it at startup instead of only logging it.',
        'ja-JP': 'Skills：agent がスキルを配信する CLI を増やしたり、無効になっている共有スキルをオンにしたりするときは、インストールと同じようにメインウィンドウでの承認が必要になりました。範囲を狭める変更はこれまでどおりすぐに反映されます。agent に Navide プラグインの作り方を教えるスキル（navide:plugin-authoring）も同梱しました。承認したときだけインストールされます。pane へのスキルの接続に失敗したときは、ログに書くだけでなく pane の起動時に表示します。',
      },
      {
        'zh-TW': '「設定 → Agent 資產 → 擴充」開始列出 Gemini CLI 的擴充和 hooks。讀不到某個 CLI 的開關設定檔時，會顯示「狀態不明」和原因，不再一律顯示成已啟用。Agent 資產各頁的名稱也統一成設定側欄上的名字；以前指向「擴充」的 Navide 外掛提示，改成指向「設定 → Navide 外掛」。',
        'en-US': 'Settings → Agent Assets → Extensions now lists Gemini CLI’s extensions and hooks. When a CLI’s on/off settings file cannot be read, its entries show State unknown with the reason instead of all showing as on. Agent Assets pages are now named everywhere as in the Settings sidebar, and messages about Navide plugins that pointed to Extensions now point to Settings → Navide Plugins.',
        'ja-JP': '「設定 → エージェント資産 → 拡張機能」に Gemini CLI の拡張機能と hooks が表示されるようになりました。CLI のオン／オフの設定ファイルを読めないときは、すべてオンと表示するのではなく、「状態不明」と理由を表示します。エージェント資産の各ページの名前は、どこでも設定のサイドバーと同じになりました。Navide プラグインについて「拡張機能」を案内していたメッセージは、「設定 → Navide プラグイン」を案内します。',
      },
      {
        'zh-TW': 'Navide 外掛：在開發者模式重新載入資料夾時，新版本要先準備好才會換下正在跑的版本；新版本有問題就保留舊版本，卡片上會說明原因。第三方外掛在視窗關掉後仍在背景執行的 AI CLI，會列在「設定 → Navide 外掛」該外掛的卡片上，每一個都可以按「結束」；這些 session 也改成依外掛版本分開保存。',
        'en-US': 'Navide plugins: reloading a Developer Mode folder now readies the new version before the running one is unloaded; if the new version is broken, the running one stays and its card says why. AI CLI sessions a third-party plugin keeps running in the background after its window closes are listed on that plugin’s card in Settings → Navide Plugins, each with an End button, and they are now stored separately for each plugin version.',
        'ja-JP': 'Navide プラグイン：開発者モードでフォルダーを再読み込みするとき、新しいバージョンの準備ができてから実行中のバージョンを入れ替えるようになりました。新しいバージョンに問題があれば実行中のバージョンを残し、カードに理由を表示します。サードパーティ製プラグインがウィンドウを閉じた後もバックグラウンドで動かしている AI CLI は、「設定 → Navide プラグイン」のそのプラグインのカードに一覧表示され、それぞれ「終了」できます。これらの session はプラグインのバージョンごとに分けて保存されるようになりました。',
      },
      {
        'zh-TW': 'Navide 外掛：0.2.31 以前安裝的第三方外掛，原生後端啟動前不會再每次都問；在詢問對話框按「不允許」會記住，不再每次啟動都跳出來。工具很多的外掛，詢問對話框不會再高過螢幕、按不到按鈕。開發者模式提醒按「知道了」之後，所有工作區視窗都會關掉。關閉第三方原生後端時如果設定存不下來，會自動重試，仍失敗就在開關下方一直顯示提示和「再試一次」。開發者資料夾的卡片會說明：改資料夾裡的檔案（包括原生後端程式）不會再問你，改宣告的權限或後端才會。從檔案安裝核准失敗時，如果檔案仍然備妥，可以直接再核准一次，不必重選檔案。視窗少了原生後端、安裝核准失敗、更新時宣告的檔案範圍，這些提示都改得更清楚。',
        'en-US': 'Navide plugins: a third-party plugin installed before 0.2.31 no longer asks at every start before its native backend runs, and answering Don’t allow in that dialog is remembered instead of coming back at every launch. For a plugin with many tools, the dialog no longer grows taller than the screen and hides its buttons. Got It on the Developer Mode reminder closes it in every workspace window. If turning third-party native backends off cannot be saved, Navide retries, and if it still fails, a notice stays under the switch with Try Again. A developer folder’s card says that changing the folder’s files, its native backend program included, does not ask again, while changing its declared permissions or backend does. When approving an install from a file fails and the file is still ready, you can approve it again without choosing the file again. The messages for a window without its native backend, a failed install approval and a declared file scope in an update are clearer.',
        'ja-JP': 'Navide プラグイン：0.2.31 より前にインストールしたサードパーティ製プラグインが、ネイティブバックエンドの起動前に毎回確認することはなくなりました。確認のダイアログで「許可しない」を選ぶと記憶され、起動のたびに表示されることもなくなりました。ツールが多いプラグインでも、ダイアログが画面より高くなってボタンが押せなくなることはありません。開発者モードのお知らせで「了解」を押すと、すべてのワークスペースのウィンドウで閉じます。サードパーティのネイティブバックエンドをオフにした設定を保存できなかったときは自動で再試行し、それでも失敗した場合はスイッチの下にお知らせと「もう一度試す」を表示し続けます。開発者フォルダーのカードには、フォルダー内のファイル（ネイティブバックエンドのプログラムを含む）を変更しても再確認されず、宣言した権限やバックエンドを変更したときは再確認されることが表示されます。ファイルからのインストールの承認に失敗しても、ファイルがまだ準備できていれば、ファイルを選び直さずにもう一度承認できます。ネイティブバックエンドなしで開いたウィンドウ、インストールの承認の失敗、更新で宣言されたファイルの範囲についてのメッセージがわかりやすくなりました。',
      },
      {
        'zh-TW': 'Plans 視窗：計畫文件不會再被擠成一條窄欄、旁邊空出一大塊。收起來的 AI CLI 側欄現在只佔它自己的寬度，寬度也和 Git 視窗分開記。',
        'en-US': 'Plans window: plan documents are no longer squeezed into a narrow column beside a blank strip. The AI CLI side panel now takes only its own width when collapsed, and its width is remembered separately from the Git window’s.',
        'ja-JP': 'Plans ウィンドウ：プランのドキュメントが細い列に押し込まれ、横に大きな空白ができることはなくなりました。折りたたんだ AI CLI のサイドパネルは自分の幅だけを使い、幅は Git ウィンドウとは別に記憶します。',
      },
      {
        'zh-TW': '帳號：在關閉「跟隨帳號切換」的 Claude 分格上選別的帳號，現在只會移動這個分格：它會在那個帳號裡重新開啟並接續原本的對話，預設帳號和其他分格都不受影響。開著「跟隨」時照舊。',
        'en-US': 'Accounts: on a Claude pane with Follow account switch off, choosing another account in its menu now moves only that pane: it reopens in that account with its conversation resumed, and the default account and every other pane stay as they are. With Follow on, nothing changes.',
        'ja-JP': 'アカウント：「アカウント切り替えに追従」をオフにした Claude pane でメニューから別のアカウントを選ぶと、その pane だけが移るようになりました。そのアカウントで開き直し、会話を再開します。既定のアカウントとほかの pane はそのままです。「追従」がオンのときは変わりません。',
      },
      {
        'zh-TW': '更穩定：Git 面板和 issue 檢視執行的指令逾時時，連同它啟動的所有程式都會一起結束（macOS、Linux 和 Windows），不再留下佔住 Git 的程式。同步過來、等待核准的大型技能，不會再一直卡在「等待空間下載檔案」。',
        'en-US': 'Steadier: when a command the Git panel or the issue views run times out, everything it started ends with it, on macOS, Linux and Windows, instead of leaving a program behind that keeps Git busy. A synced large skill waiting for approval no longer stays stuck at waiting for space to download its files.',
        'ja-JP': '安定性の向上：Git パネルや issue の表示が実行したコマンドがタイムアウトしたとき、そのコマンドが起動したプログラムもすべて一緒に終了するようになりました（macOS、Linux、Windows）。Git を使ったまま残るプログラムはなくなります。同期された大きなスキルが承認を待っている間、「ファイルをダウンロードする空き容量を待っています」のまま止まることもなくなりました。',
      },
    ],
  },
  {
    version: '0.2.31',
    title: {
      'zh-TW': 'Linux 不再越用越慢：修正後端記憶體每分鐘增加約 90 MB',
      'en-US': 'Linux No Longer Slows Down Over Time: Backend Memory Growth of About 90 MB a Minute Fixed',
      'ja-JP': 'Linux で使うほど重くなる問題を修正：バックエンドのメモリが毎分約 90 MB 増える不具合',
    },
    highlights: [
      {
        'zh-TW': 'Linux：開啟分格之後，後端記憶體不再每分鐘增加約 90 MB，event loop 不再越卡越久，分格的輸入和捲動也不再延遲。原因是 Git 監看器連 inotify 的「讀取」事件也會反應，agent 在工作區每讀一個檔案就多排一批事件；現在只對檔案新增、刪除、修改和搬移反應，一連串變更也只喚醒 event loop 一次。macOS 和 Windows 不受影響。感謝 @emissionspectrum-creator 在 #622 回報。',
        'en-US': 'Linux: once a pane is open, the backend\'s memory no longer grows by about 90 MB a minute, the event loop no longer stalls for longer and longer, and pane input and scrolling no longer lag. The Git watcher reacted to inotify\'s read events, so every file an agent read in the workspace queued more events; it now reacts only to files being created, deleted, modified or moved, and a burst of changes wakes the event loop once. macOS and Windows were not affected. Thanks to @emissionspectrum-creator for reporting it in #622.',
        'ja-JP': 'Linux：pane を開いた後、バックエンドのメモリが毎分約 90 MB ずつ増えることはなくなり、event loop の停止がだんだん長くなることも、pane の入力やスクロールが遅れることもなくなりました。原因は Git の監視が inotify の「読み取り」イベントにも反応していたことで、agent がワークスペースのファイルを読むたびにイベントが溜まっていました。現在はファイルの作成・削除・変更・移動にだけ反応し、まとまった変更でも event loop を起こすのは 1 回だけです。macOS と Windows には影響ありません。#622 で報告してくださった @emissionspectrum-creator さんに感謝します。',
      },
      {
        'zh-TW': '「設定 → Navide 外掛」分成四個子頁，列在側欄的「Navide 外掛」底下：Navide 外掛、執行政策、開發者與原生程式碼、揭露總覽。不用打開子頁也看得到狀態：執行政策頁有警告時，側欄那一列會顯示 ⚠；開發者模式或任何原生後端開關開著時，「開發者與原生程式碼」會顯示「已開啟」。視窗寬度在 720px 以下時，改用頁面上方的分頁列切換。每個外掛的列不用點開就看得到風險等級和「⚠ N」。揭露的文字沒有更動。',
        'en-US': 'Settings → Navide Plugins is split into four pages, listed in the sidebar under Navide Plugins: Navide plugins, Execution Policy, Developer and native code, and Disclosure overview. You can see their state without opening them: Execution Policy shows ⚠ in the sidebar while that page shows a warning, and Developer and native code shows On while Developer Mode or any native-backend switch is on. At 720px wide or less, a tab strip at the top of the page switches between them. Each plugin row shows its risk level and ⚠ N without a click. Disclosure text is unchanged.',
        'ja-JP': '「設定 → Navide プラグイン」を 4 つのページに分け、サイドバーの「Navide プラグイン」の下に並べました：Navide プラグイン、実行ポリシー、開発者とネイティブコード、開示の一覧。ページを開かなくても状態がわかります：実行ポリシーのページに警告があるときはサイドバーの行に ⚠ が、開発者モードやネイティブバックエンドのスイッチがどれかオンのときは「開発者とネイティブコード」に「オン」が表示されます。ウィンドウの幅が 720px 以下のときは、ページ上部のタブで切り替えます。各プラグインの行には、クリックしなくてもリスクレベルと「⚠ N」が表示されます。開示の文言は変わっていません。',
      },
      {
        'zh-TW': '安裝了會在主畫面加入 view 的外掛之後，主畫面不會再被整個蓋住，點擊也不會穿透到底下的終端機：外掛的畫面變成舞台上的一個分頁，排在既有分頁後面，標籤是 view 的標題，前面有 Navide 畫的 ◇ 標記；滑鼠移上去會顯示外掛 ID、發行者和來源。安裝時不會自動切過去，點回其他分頁、按「+」或從側欄打開分格，就會回到分格格線。這是 0.1.93 起就有的問題，內建外掛都沒有用到這個位置。',
        'en-US': 'Installing a plugin that adds a view to the main area no longer covers the whole stage, and clicks no longer fall through to the terminals underneath: the plugin\'s view is now a stage tab after the existing tabs, labelled with the view\'s title and marked ◇ by Navide; hover it for the plugin\'s id, publisher and source. Installing it does not switch to it, and picking another tab, pressing + or opening a pane from the sidebar brings the pane grid back. This had been the case since 0.1.93; no bundled plugin uses that area.',
        'ja-JP': 'メイン領域に view を追加するプラグインをインストールしても、ステージ全体が覆われることはなくなり、クリックが下のターミナルに抜けることもなくなりました：プラグインの画面はステージのタブの 1 つになり、既存のタブの後ろに view のタイトルで表示され、Navide が付ける ◇ マークが付きます。ポインターを合わせるとプラグインの ID、発行者、ソースが表示されます。インストールしても自動では切り替わらず、ほかのタブを選ぶか、「+」を押すか、サイドバーから pane を開くと pane のグリッドに戻ります。0.1.93 から続いていた問題で、同梱のプラグインはこの領域を使っていません。',
      },
      {
        'zh-TW': '外掛的原生後端被拒絕或無法啟動時，外掛的視窗仍然會開啟，只是需要後端的功能不能用。開啟時會跳出通知說明原因，並指向「設定 → Navide 外掛 → 開發者與原生程式碼」；在那裡允許之後，要把已經開著的視窗關掉再開，才會接上後端。',
        'en-US': 'A plugin window now opens even when its native backend is refused or cannot start; the parts that need the backend do not work. A notice says why and points to Settings → Navide Plugins → Developer and native code. After you allow the backend there, close the open window and open it again to connect it.',
        'ja-JP': 'プラグインのネイティブバックエンドが拒否されたり起動できなかったりしても、プラグインのウィンドウは開くようになりました。バックエンドが必要な機能は使えません。開くときに理由を示す通知が表示され、「設定 → Navide プラグイン → 開発者とネイティブコード」へ案内します。そこで許可した後は、開いているウィンドウを閉じて開き直すとバックエンドにつながります。',
      },
      {
        'zh-TW': '安裝第三方外掛就等於允許它的原生後端執行：安裝對話框會說明這一點，之後只有程式或權限改變時才會再問你。0.2.30 以前裝的套件，以及沒有經過安裝對話框的版本（例如 agent 發起的更新或回滾），第一次執行前會先問一次。這個開關現在預設開啟：如果你在 0.2.30 從沒改過原生後端的設定（例如切換這個開關，或允許、停用原生後端），開關現在是開著的；你之前儲存過的值會保留，存成關閉的就維持關閉。原生後端只在作業系統的沙盒裡執行，本身不能連網（macOS 用 Seatbelt、Linux 用 bubblewrap）；沒有沙盒的地方一律不執行，目前包括 Windows。你可以在「設定 → Navide 外掛 → 開發者與原生程式碼」關閉。',
        'en-US': 'Installing a third-party plugin now allows its native backend to run: the install dialog says so, and Navide asks again only when the program or its permissions change. Packages installed before 0.2.31, and versions no install dialog showed (such as an update or rollback an agent started), are asked once before they first run. The switch is now on by default: if you never changed native-backend settings in 0.2.30 (for example the switch itself, or allowing or disabling a native backend), the switch is now on; a value you saved earlier is kept, so a switch you saved as off stays off. Native backends run only inside an operating-system sandbox with no network of their own (Seatbelt on macOS, bubblewrap on Linux), and do not run where there is no sandbox, including Windows for now. You can turn them off in Settings → Navide Plugins → Developer and native code.',
        'ja-JP': 'サードパーティ製プラグインをインストールすると、そのネイティブバックエンドの実行を許可したことになります。インストールのダイアログにそう表示され、その後はプログラムや権限が変わったときだけ改めて確認します。0.2.30 以前にインストールしたパッケージと、インストールのダイアログを通っていないバージョン（agent が始めた更新やロールバックなど）は、初めて実行する前に一度確認します。このスイッチは既定でオンになりました。0.2.30 でネイティブバックエンドの設定（このスイッチの切り替えや、ネイティブバックエンドの許可・無効化など）を一度も変更していない場合、スイッチは現在オンです。以前に保存した値は保たれ、オフで保存したものはオフのままです。ネイティブバックエンドは OS のサンドボックス内でだけ動き、それ自体はネットワークに接続できません（macOS は Seatbelt、Linux は bubblewrap）。サンドボックスがない環境では動かず、現在は Windows も含まれます。「設定 → Navide プラグイン → 開発者とネイティブコード」でオフにできます。',
      },
      {
        'zh-TW': '外掛現在可以申請讀取同一個工作區的 agent 資訊（分格清單、哪個分格開了哪個、不含內容的訊息傳送紀錄、session 清單），這是中風險權限；訊息內容要另外申請高風險權限，安裝時會再確認一次，而且 agent 要讀到訊息內容，執行政策必須明確寫入。對話紀錄、帳號和額度資料都不開放。內建外掛都沒有申請這兩種權限。',
        'en-US': 'Plugins can now ask to read agent information in their own workspace (the pane list, which pane opened which, message delivery records without their text, and the session list), a medium-risk permission. Message text needs a separate high-risk permission, confirmed a second time at install, and an agent gets it only from an Execution Policy that names it. Conversation transcripts, account and quota data are never available. None of the bundled plugins asks for either.',
        'ja-JP': 'プラグインが、同じワークスペースの agent の情報（pane の一覧、どの pane がどの pane を開いたか、本文を含まないメッセージの配信記録、session の一覧）の読み取りを申請できるようになりました。これは中リスクの権限です。メッセージの本文には別の高リスクの権限が必要で、インストール時にもう一度確認され、agent が本文を読めるのは実行ポリシーに明記されている場合だけです。会話の記録、アカウントや使用量のデータは公開されません。同梱のプラグインはどちらも申請していません。',
      },
      {
        'zh-TW': '因為電腦時鐘不準而無法檢查 Registry 外掛時，訊息會說明時鐘似乎慢了或快了，請你改正日期與時間後再試。已安裝的外掛因此停止時，「設定 → Navide 外掛」的「Navide 外掛」頁會顯示橫幅說明，Navide 會在 15 分鐘內及啟動時再檢查一次。',
        'en-US': 'When a Registry plugin cannot be checked because this computer\'s clock is off, the message now says the clock appears to be behind or ahead, and to correct the date and time and try again. An installed plugin stopped for this reason shows a banner on the Navide plugins page of Settings → Navide Plugins; Navide checks again within 15 minutes and when it starts.',
        'ja-JP': 'コンピューターの時計がずれているために Registry のプラグインを確認できないとき、時計が遅れているか進んでいるようだと伝え、日付と時刻を直してからやり直すよう案内するようになりました。インストール済みのプラグインがこの理由で停止した場合は「設定 → Navide プラグイン」の「Navide プラグイン」ページにバナーが表示され、Navide は 15 分以内と起動時にもう一度確認します。',
      },
      {
        'zh-TW': '標題列和側欄裡沒有圖示的外掛按鈕，不再全都顯示同一個 ◇，而是顯示外掛標題的第一個字；Mini-IDE 也有了自己的圖示。這些按鈕的提示會寫出是哪個外掛：它的 id、發佈者（或「自稱」）和來源。',
        'en-US': 'Plugin buttons without an icon in the title bar and the sidebar no longer all show the same ◇; they show the first character of the plugin\'s title, and Mini-IDE has its own icon. Their tooltip says which plugin it is: its id, its publisher (or "Self-declared") and its source.',
        'ja-JP': 'タイトルバーとサイドバーにあるアイコンのないプラグインのボタンは、すべて同じ ◇ ではなく、プラグインのタイトルの最初の 1 文字を表示するようになりました。Mini-IDE には専用のアイコンが付きました。これらのボタンのツールチップには、どのプラグインか（id、発行者または「自称」、ソース）が表示されます。',
      },
      {
        'zh-TW': '用 Anthropic 自動產生 commit 訊息不再每次都失敗。',
        'en-US': 'Generating a commit message with Anthropic no longer fails every time.',
        'ja-JP': 'Anthropic での commit メッセージの自動生成が、毎回失敗することはなくなりました。',
      },
      {
        'zh-TW': 'Navide 不會把你 CLI 帳號的憑證與金鑰集中保存在雲端，以後也不會：CLI 帳號的憑證與金鑰只存在你的電腦上。0.2.28 起，同步設定已移除「Credentials 與金鑰」選項；這個選項在介面上一直是停用的，從來無法開啟。MCP 設定裡的 token 會先在你的裝置上加密才同步；伺服器無法解密。MCP 同步可隨時在「設定 → Navide Cloud → 同步 → MCP」關閉。',
        'en-US': 'Navide does not store your CLI account credentials and keys centrally in the cloud, and it never will: your CLI account credentials and keys live only on your own machine. Since 0.2.28 the "Credentials & keys" option is gone from the sync settings; it was always disabled in the interface and could never be turned on. Tokens in your MCP settings are encrypted on your device before they sync; the server cannot decrypt them. You can turn MCP sync off at any time in Settings → Navide Cloud → Sync → MCP.',
        'ja-JP': 'Navide は CLI アカウントの認証情報やキーをクラウドにまとめて保存せず、今後も保存しません。CLI アカウントの認証情報とキーは、お使いのコンピューターにのみ保存されます。0.2.28 以降、同期設定から「認証情報とキー」の項目は削除されています。この項目は画面上で常に無効になっていて、オンにすることはできませんでした。MCP 設定内のトークンは、同期の前にお使いのデバイス上で暗号化され、サーバーは復号できません。MCP の同期は「設定 → Navide Cloud → 同期 → MCP」でいつでもオフにできます。',
      },
    ],
    note: {
      'zh-TW': '完整說明：https://navide.dev/posts/credentials-stay-on-your-machine-zh-hant/',
      'en-US': 'Full announcement: https://navide.dev/posts/credentials-stay-on-your-machine/',
      'ja-JP': '詳しいお知らせ：https://navide.dev/posts/credentials-stay-on-your-machine-ja/',
    },
  },
  {
    version: '0.2.30',
    title: {
      'zh-TW': '「Navide 外掛」設定頁改版：風險和警告直接標在清單上，Pipeline 也不再默默卡住',
      'en-US': 'A Reworked Navide Plugins Page With Risk and Warnings Marked in the List, and Pipelines That No Longer Stall Silently',
      'ja-JP': '「Navide プラグイン」設定ページを刷新：リスクと警告を一覧に表示し、Pipeline も黙って止まらなくなりました',
    },
    highlights: [
      {
        'zh-TW': '「設定 → Navide 外掛」改版。頁面先顯示目前生效的執行政策摘要（來源和模式），按「編輯政策」展開編輯器；有 Repository 建議時，摘要會標「不受信任」並列出它的模式。有需要你處理的事時，編輯器會自動展開而且收不起來，包括兩種高風險警告：你正在設定的政策是高風險，或有效的 Repository 建議是高風險。內建和已安裝的外掛合成一份清單，旁邊顯示選中外掛的詳細資料。已安裝外掛的列會同時顯示「已停用」和風險等級（中以上），不是從 Navide Marketplace 安裝的（Testplace 或預先發行版、本機檔案、開發者資料夾）會有來源圖示；每一列有警告時都會顯示「⚠ N」，N 是詳細資料裡的警告數。滑鼠移到標記、圖示或被截斷的名稱上會顯示完整文字；警告的完整內容要選中外掛後在詳細資料裡看。揭露總覽裡，每個外掛的風險等級、來源和「掃描到但未宣告」標示一直顯示，完整的揭露卡在下方展開，內容沒有刪減。',
        'en-US': 'Settings → Navide Plugins is reworked. The page opens on a summary of the execution policy in effect (its source and Mode), and Edit Policy opens the editor; a repository recommendation is shown there as Untrusted, with its mode. While something needs your attention, the editor opens by itself and cannot be collapsed; that includes both high-risk warnings, for a high-risk policy you are setting and for a valid high-risk repository recommendation. Bundled and installed plugins share one list, with the selected plugin\'s details beside it. An installed plugin\'s row shows Disabled together with its risk level (Medium and above), and an icon when it did not come from the Navide Marketplace (Testplace or pre-release, a local file, a developer folder). Any row with warnings shows ⚠ N, N being the number of warnings in its details. Hover a marker, an icon or a cut-off name to read it in full; the warnings themselves are in the details once you select the plugin. In the Disclosure overview, each plugin\'s risk level, source and any "Found by the scan but not declared" flag stay in view, and the full Disclosure opens below them, unshortened.',
        'ja-JP': '「設定 → Navide プラグイン」を刷新しました。ページの最初に現在有効な実行ポリシーの概要（ソースとモード）を表示し、「ポリシーを編集」でエディターを開きます。リポジトリの推奨設定がある場合は、概要に「未信頼」と表示し、そのモードも示します。対応が必要なことがあるときは、エディターが自動で開き、閉じることはできません。2 つの高リスク警告（設定中のポリシーが高リスクの場合と、有効なリポジトリの推奨設定が高リスクの場合）もこれに含まれます。同梱とインストール済みのプラグインは 1 つの一覧にまとまり、その横に選択したプラグインの詳細を表示します。インストール済みのプラグインの行には「無効」とリスクレベル（中以上）が並んで表示され、Navide Marketplace 以外から入れたもの（Testplace またはプレリリース、ローカルファイル、開発者フォルダー）にはソースのアイコンが付きます。警告がある行には「⚠ N」が表示され、N は詳細にある警告の数です。マークやアイコン、途中で切れた名前にポインターを合わせると全文が表示されます。警告の全文は、プラグインを選択して詳細で確認できます。開示の一覧では、各プラグインのリスクレベル、ソース、「スキャンで見つかったが宣言されていないもの」の表示が常に見え、完全な開示はその下で開けます。内容は省略していません。',
      },
      {
        'zh-TW': '「設定 → Navide 外掛」又可以捲動了，執行政策、外掛清單和揭露總覽也不會再被擠成三欄窄條。這是 0.2.27 起的問題。',
        'en-US': 'Settings → Navide Plugins scrolls again, and its execution policy, plugin list and Disclosure overview are no longer squeezed into three narrow columns. This had been broken since 0.2.27.',
        'ja-JP': '「設定 → Navide プラグイン」が再びスクロールできるようになり、実行ポリシー、プラグイン一覧、開示の一覧が 3 列の細い枠に押し込まれることもなくなりました。0.2.27 から続いていた問題です。',
      },
      {
        'zh-TW': 'Pipeline 的 Manager 模式不會再因為 Manager 沒有印出 ---MANAGER-READY--- 而默默卡住：Navide 會先提醒它一次；如果它閒置 180 秒、而且有 worker 的訊息在等它，Navide 會告訴它這是逾時後的替代處理，並把等著的訊息交給它。執行紀錄會記下這件事。',
        'en-US': 'A Manager-mode pipeline stage no longer stalls silently when its Manager never prints ---MANAGER-READY---: Navide reminds it once, and if it then sits idle for 180 seconds while workers\' messages wait for it, tells it this is a timeout fallback and hands it those messages. The run log records the fallback.',
        'ja-JP': 'Pipeline の Manager モードで、Manager が ---MANAGER-READY--- を出力しないまま黙って止まることはなくなりました：Navide はまず一度だけ促し、その後 180 秒アイドルのままで worker のメッセージが待っている場合は、タイムアウト時の代替処理であることを伝えて、待っていたメッセージを渡します。実行ログにも記録されます。',
      },
      {
        'zh-TW': 'Pipeline 某個 slot 的 role 提示沒有送到 agent 時，run 會明確失敗，不再在沒有 role 的情況下照樣開工：節點會顯示「role prompt never reached the agent」，錯誤通知會指出是哪個階段和 slot，分格會保留，之後可以接續執行。',
        'en-US': 'When a pipeline slot\'s role prompt never reaches its agent, the run now fails with the reason instead of starting the slot without its role: the node shows "role prompt never reached the agent", an error toast names the stage and slot, and the panes stay open so the run can be resumed.',
        'ja-JP': 'Pipeline の slot の role プロンプトが agent に届かなかった場合、role なしのまま作業を始めることはなくなり、run は理由を示して失敗します：ノードに「role prompt never reached the agent」と表示され、エラー通知がどのステージのどの slot かを示し、pane はそのまま残るので run を再開できます。',
      },
      {
        'zh-TW': '本機（stdio）MCP 伺服器在啟動途中結束或連線出錯時，「設定 → MCP」會說出真正的原因（例如伺服器的結束代碼，或連線失敗的錯誤），不再當成啟動被取消，也不會顯示錯誤的結束代碼。',
        'en-US': 'When a local (stdio) MCP server exits or its connection fails partway through starting, Settings → MCP gives the real reason (the server\'s exit code, or the connection error) instead of calling it a cancelled start or showing the wrong exit code.',
        'ja-JP': 'ローカル（stdio）の MCP サーバーが起動の途中で終了したり接続に失敗したりした場合、「設定 → MCP」は本当の理由（サーバーの終了コードや接続エラー）を表示し、起動がキャンセルされたと扱ったり、誤った終了コードを表示したりすることはなくなりました。',
      },
      {
        'zh-TW': '更穩定：關掉的分格不會在下次還原專案時又冒出來；Navide 內建的 Plan MCP 服務在內部中斷後會正常重新開始；同時更改版面、主題或語言時，不會蓋掉剛存好的其他變更。',
        'en-US': 'Steadier: a closed pane no longer comes back the next time the project is restored, Navide\'s built-in Plan MCP service starts again cleanly after an internal interruption, and changing the layout, theme or language no longer overwrites another change saved at the same moment.',
        'ja-JP': '安定性の向上：閉じた pane が次にプロジェクトを復元したときに戻ってくることはなくなりました。Navide 内蔵の Plan MCP サービスは内部で中断しても正常に再開し、レイアウト・テーマ・言語の変更が同じタイミングで保存された別の変更を上書きすることもなくなりました。',
      },
      {
        'zh-TW': '安全更新：Electron 升級到 44.9.1，修補安全公告 GHSA-jr5w-w6x2-84p9，不再信任已遭入侵的 eMudhra 中繼憑證。這個版本內建的 Node.js 仍是 24.22.0，還不含 Node.js 官方 10 月 21 日的安全修補（24.x 線修補在 24.22.1）；Electron 推出內含這批修補的版本後，我們會在新版跟上。',
        'en-US': 'Security: Electron is updated to 44.9.1 for advisory GHSA-jr5w-w6x2-84p9; it stops trusting the compromised eMudhra intermediate certificates. Its built-in Node.js is still 24.22.0, without the Node.js security fixes of October 21 (24.22.1 on the 24 line); we will follow in a new Navide release once Electron ships a version that includes them.',
        'ja-JP': 'セキュリティ更新：Electron を 44.9.1 に更新し、アドバイザリ GHSA-jr5w-w6x2-84p9 に対応しました。侵害された eMudhra の中間証明書を信頼しなくなります。内蔵の Node.js は 24.22.0 のままで、Node.js が 10 月 21 日に公開したセキュリティ修正（24 系では 24.22.1）はまだ含まれていません。Electron がこの修正を含むバージョンを公開したら、Navide の新しいバージョンで対応します。',
      },
    ],
  },
  {
    version: '0.2.29',
    title: {
      'zh-TW': 'Navide 會說六種新語言：德、西、法、葡、俄、越文介面（Beta）',
      'en-US': 'Navide Speaks Six More Languages: German, Spanish, French, Brazilian Portuguese, Russian and Vietnamese (Beta)',
      'ja-JP': 'Navide が 6 つの新しい言語に対応：ドイツ語・スペイン語・フランス語・ポルトガル語（ブラジル）・ロシア語・ベトナム語（ベータ）',
    },
    highlights: [
      {
        'zh-TW': '10 月 22 日我們把 Navide 伺服器（server.navide.dev）的 Node.js 從 22.23.3 升到 22.23.4。Node.js 官方 10 月 21 日的安全更新修補了 10 個漏洞，其中 7 個影響伺服器使用的 Node.js 22，包括 3 個高風險：TLS 憑證主機名稱驗證可被繞過（CVE-2026-106069）、Brotli 解碼越界寫入可能導致遠端執行程式碼（CVE-2026-111497），以及 dns.resolve 處理含 NUL 字元的名稱時會截斷（CVE-2026-105482）。伺服器的程式碼與資料都沒有變動，你不需要做任何事。',
        'en-US': 'On October 22 we upgraded Node.js on the Navide server (server.navide.dev) from 22.23.3 to 22.23.4. The Node.js security release of October 21 fixes 10 vulnerabilities, 7 of which affect Node.js 22, the line the server runs. Three are rated high: a bypass of TLS certificate hostname verification (CVE-2026-106069), an out-of-bounds write in Brotli decoding that could allow remote code execution (CVE-2026-111497), and truncation in dns.resolve of names containing a NUL character (CVE-2026-105482). The server\'s code and data are unchanged, and you do not need to do anything.',
        'ja-JP': '10 月 22 日、Navide サーバー（server.navide.dev）の Node.js を 22.23.3 から 22.23.4 に更新しました。Node.js が 10 月 21 日に公開したセキュリティリリースは 10 件の脆弱性を修正しており、そのうち 7 件がサーバーで使っている Node.js 22 に影響します。高リスクは 3 件です：TLS 証明書のホスト名検証の回避（CVE-2026-106069）、Brotli のデコードでの範囲外書き込みによるリモートコード実行の可能性（CVE-2026-111497）、NUL 文字を含む名前を dns.resolve が切り詰める問題（CVE-2026-105482）。サーバーのコードとデータは変わっておらず、お客様の操作は必要ありません。',
      },
      {
        'zh-TW': '桌面版內建的 Node.js 來自 Electron。Electron 官方還沒推出含這次修補的版本，推出後我們會在新版跟上。',
        'en-US': 'The Node.js built into the desktop app comes from Electron. Electron has not yet released a version with these fixes; we will follow in a new Navide release once it does.',
        'ja-JP': 'デスクトップ版に組み込まれている Node.js は Electron に由来します。Electron はまだ今回の修正を含むバージョンを公開していません。公開され次第、Navide の新しいバージョンで対応します。',
      },
      {
        'zh-TW': '介面多了六種語言（Beta）：德文、西班牙文、法文、巴西葡萄牙文、俄文和越南文。翻譯由 AI 分格完成、另一個 AI 分格審稿，還沒有母語者校對；法文介面把 AI 寫成 IA。到「設定 → 外觀」或第一次啟動時選擇。',
        'en-US': 'Six more interface languages (Beta): German, Spanish, French, Brazilian Portuguese, Russian and Vietnamese. AI panes translated them and a separate AI pane reviewed them; no native speaker has checked them yet. The French interface writes AI as IA. Pick one in Settings → Appearance, or at the first start.',
        'ja-JP': '表示言語が 6 つ増えました（ベータ）：ドイツ語、スペイン語、フランス語、ポルトガル語（ブラジル）、ロシア語、ベトナム語。AI pane が翻訳し、別の AI pane がレビューしましたが、ネイティブスピーカーによる確認はまだです。フランス語の表示では AI を IA と書きます。「設定 → 外観」または初回起動時に選べます。',
      },
      {
        'zh-TW': '聊天頻道（Telegram 等）不會再在電腦忙的時候收到「沒有文字輸出」或上一回合的回覆：Navide 會等讀到這一回合的文字再回。10 秒後狀態會顯示「正在讀取回覆」，超過 120 秒會先告訴你回覆稍後補送，讀到後就補上。',
        'en-US': 'Chat channels (Telegram and others) no longer get "no text output" or the previous turn\'s reply when the computer is busy: Navide waits until it has read this turn\'s text. After 10 seconds the status says the reply is being read; after 120 seconds the chat is told the reply will follow, and it does once read.',
        'ja-JP': 'チャンネル（Telegram など）で、コンピューターが混んでいるときに「テキスト出力なし」や前のターンの返信が届くことはなくなりました：Navide はこのターンのテキストを読み取ってから返信します。10 秒たつと「返信を読み取り中」と表示し、120 秒を過ぎると返信は後から届くと伝え、読み取れた時点で送ります。',
      },
      {
        'zh-TW': '本機（stdio）MCP 伺服器第一次啟動、npx 或 uvx 還在下載套件時，不會在 15 秒後就失敗：Navide 會一直等到它啟動完成或程序結束（最多 300 秒）。「設定 → MCP」會顯示啟動中，15 秒後說明第一次可能正在下載，失敗時顯示原因。',
        'en-US': 'A local (stdio) MCP server no longer fails after 15 seconds while npx or uvx downloads its package on the first start: Navide waits until it is up or its process exits (up to 300 seconds). Settings → MCP shows it as starting, explains after 15 seconds that a first run may be downloading, and shows why if it fails.',
        'ja-JP': 'ローカル（stdio）の MCP サーバーが初回起動で npx や uvx がパッケージをダウンロードしている間に、15 秒で失敗することはなくなりました：Navide は起動が完了するかプロセスが終了するまで（最大 300 秒）待ちます。「設定 → MCP」には起動中と表示され、15 秒後に初回はダウンロード中の可能性があると説明し、失敗した場合は理由を表示します。',
      },
      {
        'zh-TW': 'Windows 上的 Git 檢視不會再一直停在「git.status 逾時」：背景啟動的 git 和其他工具不會再在啟動時卡住，萬一某次 git 真的逾時，也會在兩秒內結束，不會拖住後面的操作。',
        'en-US': 'On Windows, the Git view no longer stays stuck on a git.status timeout: git and the other tools Navide starts in the background no longer hang at launch, and a git run that does time out ends within two seconds instead of holding up the ones after it.',
        'ja-JP': 'Windows で Git ビューが「git.status のタイムアウト」のまま止まることはなくなりました：Navide がバックグラウンドで起動する git などのツールは起動時に止まらなくなり、git が本当にタイムアウトした場合も 2 秒以内に終了し、後続の処理を妨げません。',
      },
      {
        'zh-TW': '每個版本的新版說明，現在也會同步發布到 Navide 官網的公告頁（navide.dev/news）。',
        'en-US': 'Each release\'s What\'s New is now also published on the Navide website\'s announcements page (navide.dev/news).',
        'ja-JP': '各バージョンの新機能のお知らせは、Navide のウェブサイトのお知らせページ（navide.dev/news）にも掲載されるようになりました。',
      },
      {
        'zh-TW': '電腦時鐘比 Registry 慢 5 分鐘以內時，Registry 的安裝和更新不會再全部被拒絕；差距更大時，會請你檢查電腦的日期和時間。',
        'en-US': 'A computer clock up to 5 minutes behind the Registry\'s no longer refuses every Registry install and update; a larger gap asks you to check the computer\'s date and time.',
        'ja-JP': 'コンピューターの時計が Registry より 5 分以内の遅れであれば、Registry からのインストールと更新がすべて拒否されることはなくなりました。それ以上ずれている場合は、コンピューターの日付と時刻を確認するよう案内します。',
      },
      {
        'zh-TW': 'Windows 新安裝後第一次啟動時，等待後端的時間從 45 秒延長到 120 秒（和 Linux 一樣），Microsoft Defender 掃描新檔案時，還在啟動的後端不會再被判定為啟動失敗；啟動畫面也會一直顯示到等待結束。',
        'en-US': 'On Windows, the first launch after a fresh install waits up to 120 seconds for the backend (was 45), as on Linux, so a backend still starting while Microsoft Defender scans the new files is no longer reported as failed to start; the startup screen stays up for the whole wait.',
        'ja-JP': 'Windows で新しくインストールした後の初回起動では、バックエンドを待つ時間が 45 秒から 120 秒に延びました（Linux と同じ）。Microsoft Defender が新しいファイルをスキャンしている間に、まだ起動中のバックエンドが起動失敗と判定されることはなくなり、起動画面も待っている間ずっと表示されます。',
      },
      {
        'zh-TW': '開很多 CLI 分格時，資源面板的風險檢查不會再讓後端凍結好幾秒，檢查結果不變。',
        'en-US': 'With many CLI panes open, the resource panel\'s risk check no longer freezes the backend for seconds at a time; its results are unchanged.',
        'ja-JP': 'CLI pane をたくさん開いていても、リソースパネルのリスクチェックでバックエンドが数秒止まることはなくなりました。チェックの結果は変わりません。',
      },
      {
        'zh-TW': 'Codex 分格的子 agent 結束時，不會再連帶結束父分格的這一回合；子 agent 的回覆不會被當成分格的回覆，也不會拿它的任務來為分格命名。',
        'en-US': 'In a Codex pane, a sub-agent finishing no longer ends the parent pane\'s turn; its reply is not taken as the pane\'s, and its task is not used to name the pane.',
        'ja-JP': 'Codex pane でサブ agent が終了しても、親 pane のターンが一緒に終わることはなくなりました。サブ agent の返信は pane の返信として扱われず、そのタスクで pane に名前が付くこともありません。',
      },
      {
        'zh-TW': '安全更新：Mermaid 圖表和 Monaco 編輯器用來清理 HTML 的 DOMPurify 升級到 3.4.17，修補已公開的安全公告（GHSA-cg2g-xh64-v4q7、GHSA-mrv2-3pqr-j5jr、GHSA-c6gr-qvv4-5v3f）。',
        'en-US': 'Security: DOMPurify, which Mermaid diagrams and the Monaco editor use to sanitize HTML, is updated to 3.4.17 for the published advisories GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr and GHSA-c6gr-qvv4-5v3f.',
        'ja-JP': 'セキュリティ更新：Mermaid の図と Monaco エディターが HTML のサニタイズに使う DOMPurify を 3.4.17 に更新し、公開されたアドバイザリ（GHSA-cg2g-xh64-v4q7、GHSA-mrv2-3pqr-j5jr、GHSA-c6gr-qvv4-5v3f）に対応しました。',
      },
    ],
    note: {
      'zh-TW': 'Node.js 官方公告：https://nodejs.org/en/blog/vulnerability/october-2026-security-releases',
      'en-US': 'Node.js announcement: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases',
      'ja-JP': 'Node.js の公式発表：https://nodejs.org/en/blog/vulnerability/october-2026-security-releases',
    },
  },
  {
    version: '0.2.28',
    title: {
      'zh-TW': '核准就生效：Navide 外掛不用重新啟動，agent 也能幫你整理視窗',
      'en-US': 'Approve and It Is Live: No Restart for Navide Plugins, and Agents Can Arrange Your Windows',
      'ja-JP': '承認すればすぐ有効：Navide プラグインは再起動不要、agent はウィンドウも整理できます',
    },
    highlights: [
      {
        'zh-TW': '核准的 Navide 外掛安裝和更新會立即生效，不用按「重新啟動」或重開 Navide。核准前對話框會說明這個外掛開著的畫面會重新載入；每次切換都記在公告中心，附「退回」上一版的按鈕。從檔案更新時會保留被取代的版本，退回它需要重新同意。',
        'en-US': 'Navide plugin installs and updates you approve take effect at once, without Restart or relaunching Navide. The dialog says beforehand that the plugin\'s open views reload; every switch is recorded in the announcements with Back to the previous version. A file update keeps the version it replaced, and going back to it asks for your consent again.',
        'ja-JP': '承認した Navide プラグインのインストールと更新はすぐに有効になり、再起動も Navide の再起動も不要です。承認の前に、そのプラグインの開いている画面が再読み込みされることをダイアログが説明します。切り替えはすべてお知らせに記録され、前のバージョンに戻すボタンが付きます。ファイルから更新した場合は置き換えたバージョンを保持し、そこへ戻すには改めて同意が必要です。',
      },
      {
        'zh-TW': 'agent 可以管理 Navide 視窗：列出所有視窗並切到前景、把某個分格或整個專案移到另一個視窗，以及關掉別的視窗或專案（不會關自己的，也不會結束 CLI）。每個動作都會顯示是哪個分格做的，並留下紀錄。',
        'en-US': 'Agents can arrange Navide windows: list them and bring one to the front, move a pane or a whole project to another window, and close another window or project (never their own, and no CLI ends). Every action shows which pane did it and is recorded.',
        'ja-JP': 'agent が Navide のウィンドウを整理できます：ウィンドウの一覧と前面への切り替え、pane やプロジェクト全体の別ウィンドウへの移動、ほかのウィンドウやプロジェクトのクローズ（自分自身は閉じず、CLI も終了しません）。どの操作も、どの pane が行ったかが表示され、記録されます。',
      },
      {
        'zh-TW': 'agent 用 cli_open_agent 開子分格時可以開在另一個專案裡，子分格仍然向開它的分格回報。',
        'en-US': 'An agent can open a child pane in another project with cli_open_agent; the child still reports back to the pane that opened it.',
        'ja-JP': 'agent は cli_open_agent で別のプロジェクトに子 pane を開けます。子 pane は開いた pane に引き続き報告します。',
      },
      {
        'zh-TW': '從本機資料夾載入的 Navide 外掛標示為「本機資料夾」，點開可以看到資料夾路徑、上次載入的時間和方式、是誰載入的，以及當時內容的指紋。',
        'en-US': 'A Navide plugin loaded from a folder is labelled Local folder; open it to see the folder path, when and how it last loaded, who loaded it and a fingerprint of its content at that load.',
        'ja-JP': 'フォルダーから読み込んだ Navide プラグインには「ローカルフォルダー」と表示されます。開くと、フォルダーのパス、前回の読み込み日時と方法、誰が読み込んだか、そのときの内容のフィンガープリントを確認できます。',
      },
      {
        'zh-TW': '行為改變：開發者模式設定被 Navide 以外的程式改過時不再算數，開關維持關閉、資料夾不會載入，直到你重新開啟或重新同意。0.2.27 有在用開發者模式的人，升級後要重新開啟一次，每個本機資料夾也要再同意一次。',
        'en-US': 'Behaviour change: Developer Mode settings changed by a program other than Navide no longer count; the switch stays off and the folder is not loaded until you turn it on or consent again. If you used Developer Mode in 0.2.27, turn it on once more after upgrading and consent to each local folder again.',
        'ja-JP': '動作の変更：Navide 以外のプログラムが変更した開発者モードの設定は無効になり、もう一度オンにするか同意し直すまで、スイッチはオフのまま、フォルダーも読み込まれません。0.2.27 で開発者モードを使っていた場合は、アップグレード後にもう一度オンにし、ローカルフォルダーごとに同意し直してください。',
      },
      {
        'zh-TW': '行為改變：被開發者或 Navide 撤回的 Testplace 測試版不再自動停用，而是標示「測試版已撤回」並問你一次要怎麼處理；離線或沒登入 Navide Cloud 的測試者也會收到通知。',
        'en-US': 'Behaviour change: a Testplace build withdrawn by its developer or by Navide is no longer disabled automatically; it is labelled Test build withdrawn and you are asked once what to do. Testers who are offline or signed out of Navide Cloud are told too.',
        'ja-JP': '動作の変更：開発者または Navide が取り下げた Testplace のテストビルドは自動で無効にならなくなり、「テストビルドは取り下げ済み」と表示して、どうするかを一度だけ尋ねます。オフラインの、または Navide Cloud にログインしていないテスターにも通知されます。',
      },
      {
        'zh-TW': '介面語言的預設值改了：系統語言不在 Navide 支援的清單裡時，介面改用英文（以前是繁體中文）。你在設定裡自己選過的語言不受影響。',
        'en-US': 'The default UI language has changed: when your system language is not one Navide supports, the interface now uses English (it used to be Traditional Chinese). A language you picked in Settings is not affected.',
        'ja-JP': '既定の表示言語が変わりました：システムの言語が Navide の対応言語にない場合、表示は英語になります（以前は繁体字中国語でした）。設定で選んだ言語はそのままです。',
      },
    ],
  },
  {
    version: '0.2.27',
    title: {
      'zh-TW': 'Navide 瀏覽器：agent 在自己的 Space 上網，你的分頁不會被搶走',
      'en-US': 'Navide Browser: Agents Browse in Their Own Spaces, Yours Stay Yours',
      'ja-JP': 'Navide ブラウザー：agent は自分の Space でブラウズし、あなたのタブは奪われません',
    },
    highlights: [
      {
        'zh-TW': 'Navide 瀏覽器：在 Navide 裡開真正的網頁，從 Navide 市集安裝（不隨 App 內建）。每個 agent 分格在自己的背景 Space 工作，你的 Space 有釘選標記，agent 預設碰不到；總覽卡片顯示縮圖和狀態（執行中、需要你處理、完成）。',
        'en-US': 'Navide Browser opens real web pages inside Navide. Install it from the Navide Marketplace; it does not ship with the App. Each agent pane works in its own background Space; your own Spaces are pinned and off limits to agents unless you let them in. The overview shows every Space with a thumbnail and its state (Running, Need your action, Done).',
        'ja-JP': 'Navide ブラウザーで Navide の中に本物の Web ページを開けます。Navide マーケットプレイスからインストールします（App には同梱されません）。agent の pane はそれぞれ自分のバックグラウンド Space で作業し、あなたの Space はピン留めされ、許可しない限り agent は使えません。一覧では各 Space のサムネイルと状態（実行中・対応が必要・完了）が表示されます。',
      },
      {
        'zh-TW': '人機交接：agent 需要你登入、過驗證碼或付款時會把 Space 交給你；你也可以隨時按「接手」。交還前 agent 的操作一律被擋下。',
        'en-US': 'Hand-offs: an agent hands you its Space when it needs you to sign in, solve a captcha or pay, and you can take over any time; its commands are refused until you hand the Space back.',
        'ja-JP': '受け渡し：ログインや CAPTCHA、支払いが必要になると agent が Space をあなたに渡します。いつでも操作を引き継ぐこともでき、戻すまで agent の操作はすべて拒否されます。',
      },
      {
        'zh-TW': '所有 Space 共用同一份登入資料，保存在這台電腦上；可在 Navide 瀏覽器的設定裡一鍵清除。',
        'en-US': 'All Spaces share one set of sign-ins kept on this computer; clear them from the Navide Browser settings.',
        'ja-JP': 'すべての Space は同じログイン情報を共有し、このコンピューターに保存されます。Navide ブラウザーの設定から消去できます。',
      },
      {
        'zh-TW': '從 .vsix 檔案安裝的 Navide 外掛，每次啟動和每次更新信任清單時都會再檢查一次。Navide 因安全問題下架的會被停用，只能移除；因其他原因被封鎖的會問你一次要繼續使用、停用或移除；開發者撤回的只會標示。「設定 → Navide 外掛」會一直標示它被封鎖的原因。',
        'en-US': 'A Navide plugin installed from a .vsix file is checked again at every start and every trust refresh. One Navide took down for a security reason is disabled and can only be removed; one blocked for another reason asks you once whether to keep using, disable or remove it; one its developer withdrew is only labelled. Settings → Navide Plugins keeps showing why it is blocked.',
        'ja-JP': '.vsix ファイルからインストールした Navide プラグインは、起動するたびと信頼リストを更新するたびに再確認されます。Navide がセキュリティ上の理由で取り下げたものは無効になり、削除だけができます。ほかの理由でブロックされたものは、使い続けるか、無効にするか、削除するかを一度だけ尋ねます。開発者が取り下げたものは表示だけです。「設定 → Navide プラグイン」には、ブロックされた理由が表示され続けます。',
      },
      {
        'zh-TW': '行為改變：從檔案安裝的 Navide 外掛現在會記下安裝檔的 digest。降回 0.2.26 時，記有 digest 或開發者簽章的本機安裝會被隔離，不會載入；回到 0.2.27 或之後的版本就會恢復。',
        'en-US': 'Behaviour change: a Navide plugin installed from a file now records the digest of its file. If you go back to 0.2.26, local installs that carry a digest or a developer signature are quarantined and not loaded; they come back on 0.2.27 or later.',
        'ja-JP': '動作の変更：ファイルからインストールした Navide プラグインは、インストール元ファイルのダイジェストを記録するようになりました。0.2.26 に戻すと、ダイジェストや開発者の署名が記録されたローカルインストールは隔離され、読み込まれません。0.2.27 以降に戻すと元に戻ります。',
      },
    ],
  },
  {
    version: '0.2.26',
    title: {
      'zh-TW': '從聊天室喚醒分格、只接回上次開著的分格、從檔案或資料夾安裝 Navide 外掛（清楚標示來源）',
      'en-US': 'Wake a Pane From Its Chat, Resume Only What Was Running, and Install Navide Plugins From a File or Folder — With Their Source Shown',
      'ja-JP': 'チャットから pane を起動、前回動いていた pane だけを再開、ファイルやフォルダーから Navide プラグインをインストール（提供元を明示）',
    },
    features: [
      {
        icon: '▶️',
        name: { 'zh-TW': '從聊天室喚醒', 'en-US': 'Wake from chat', 'ja-JP': 'チャットから起動' },
        tagline: {
          'zh-TW': '分格不在線上時，按「▶️ 喚醒」把它接回原本的對話；離線時傳的訊息會依序送進去。',
          'en-US': 'When a pane is offline, press ▶️ 喚醒 to bring it back on its own conversation; what you sent meanwhile goes in, in order.',
          'ja-JP': 'pane がオフラインのとき「▶️ 喚醒」を押すと元の会話に戻り、その間に送ったメッセージが順番に届きます。',
        },
        where: { 'zh-TW': '聊天室 → 分格離線時的回覆', 'en-US': 'Chat → the offline reply', 'ja-JP': 'チャット → オフライン時の返信' },
      },
      {
        icon: '🔁',
        name: { 'zh-TW': '接續範圍「自動」', 'en-US': 'Resume scope Auto', 'ja-JP': '再開する範囲「自動」' },
        tagline: {
          'zh-TW': '只接回上次關閉 Navide 時還在執行的分格。',
          'en-US': 'Bring back only the panes still running when Navide last closed.',
          'ja-JP': '前回 Navide を閉じたときに動いていた pane だけを再開します。',
        },
        where: { 'zh-TW': '設定 → 一般 → 恢復範圍', 'en-US': 'Settings → General → Resume scope', 'ja-JP': '設定 → 一般 → 再開する範囲' },
      },
      {
        icon: '📦',
        name: { 'zh-TW': '從檔案或資料夾安裝', 'en-US': 'Install from a file or folder', 'ja-JP': 'ファイルやフォルダーからインストール' },
        tagline: {
          'zh-TW': '從 .vsix 檔案安裝 Navide 外掛，或在開發者模式從資料夾載入；兩者都未經 Navide 審核，畫面會標明。',
          'en-US': 'Install a Navide plugin from a .vsix file, or load one from a folder in Developer Mode; neither is reviewed by Navide, and it says so.',
          'ja-JP': '.vsix ファイルから Navide プラグインをインストール、または開発者モードでフォルダーから読み込めます。どちらも Navide の審査を受けておらず、画面に明示されます。',
        },
        where: { 'zh-TW': '設定 → Navide 外掛', 'en-US': 'Settings → Navide Plugins', 'ja-JP': '設定 → Navide プラグイン' },
      },
    ],
    highlights: [
      {
        'zh-TW': '喚醒：分格不在線上時，聊天室可以按「▶️ 喚醒」接回原本的對話；離線期間的訊息最多暫存 20 則、30 分鐘，喚醒後依序送進去。絕不會開新對話。',
        'en-US': 'Wake: a chat can wake an offline pane back onto its own conversation; up to 20 messages from the last 30 minutes are kept and sent in order. It never starts a new conversation.',
        'ja-JP': '起動：pane がオフラインのとき、チャットから「▶️ 喚醒」で元の会話に戻せます。オフラインの間のメッセージは最大 20 件・30 分まで保留され、起動後に順番に送られます。新しい会話は決して始めません。',
      },
      {
        'zh-TW': '接續範圍「自動」：只接回上次關閉 Navide 時還在執行的分格。',
        'en-US': 'Resume scope Auto brings back only the panes still running when Navide last closed.',
        'ja-JP': '再開する範囲「自動」：前回 Navide を閉じたときにまだ動いていた pane だけを再開します。',
      },
      {
        'zh-TW': '從 .vsix 檔案安裝、開發者模式從資料夾載入；兩者都未經 Navide 審核，對話框會標明，必須勾選了解風險才能同意。自架 Registry 只在開發者模式開著時使用。',
        'en-US': 'Install a Navide plugin from a .vsix file, or load one from a folder in Developer Mode; neither is reviewed by Navide, the dialog says so, and you must acknowledge the risk. A self-hosted Registry is used only in Developer Mode.',
        'ja-JP': '.vsix ファイルからのインストールと、開発者モードでのフォルダーからの読み込み。どちらも Navide の審査を受けておらず、ダイアログに明示され、リスクを理解したことを確認しないと同意できません。自前の Registry は開発者モードがオンのときだけ使われます。',
      },
      {
        'zh-TW': '來源標記：每個 Navide 外掛都標示來源與審核狀態；本機或測試套件在 Navide 自己的介面上也有標記。揭露卡也會寫明 Navide 外掛的畫面可以連網。',
        'en-US': 'Every Navide plugin shows its source and review; local and test packages are also marked in Navide’s own chrome. The disclosure card also says that a Navide plugin’s views can reach the network.',
        'ja-JP': '提供元の表示：すべての Navide プラグインに提供元と審査の状態が表示され、ローカルやテスト用のパッケージは Navide 自身の画面にも印が付きます。開示カードには、Navide プラグインのビューがネットワークに接続できることも記載されます。',
      },
      {
        'zh-TW': '行為改變：送出後無法確認 CLI 有收到的訊息，會標成「未確認」，不再當成已送達；排程把它記成錯誤。',
        'en-US': 'Behaviour change: a message Navide cannot confirm the CLI took is reported as unconfirmed, not delivered; a scheduled run records it as an error.',
        'ja-JP': '動作の変更：CLI が受け取ったことを確認できないメッセージは「未確認」と表示され、送信済みとして扱われなくなりました。スケジュール実行ではエラーとして記録されます。',
      },
      {
        'zh-TW': '揭露總覽移到 設定 → Navide 外掛 頁面最下方。',
        'en-US': 'The Disclosure overview moved to the bottom of Settings → Navide Plugins.',
        'ja-JP': '開示の一覧は「設定 → Navide プラグイン」ページの一番下に移りました。',
      },
      {
        'zh-TW': '修正：大結果處理完後 helper 不再一直佔用約 339 MiB；pipeline 中止後可以重新開始；Linux 正式版的 `LD_LIBRARY_PATH` 不再傳給子程序。',
        'en-US': 'Fixed: the result helper no longer holds ~339 MiB when idle; a pipeline can start again after an abort; the Linux build’s `LD_LIBRARY_PATH` no longer leaks into spawned processes.',
        'ja-JP': '修正：大きな結果の処理後、helper が約 339 MiB を使い続けなくなりました。中断した pipeline を再び開始できます。Linux 製品版の `LD_LIBRARY_PATH` が子プロセスに渡らなくなりました。',
      },
    ],
  },
  {
    version: '0.2.25',
    major: true,
    title: {
      'zh-TW': 'Agent 可以使用 Navide 外掛的工具（每一步都由你同意）、Guard 更周全也更安靜、Telegram 選單改版、介面縮放重開後會保留',
      'en-US': 'Agents Can Use Navide Plugin Tools (With Your Consent), a More Thorough and Quieter Guard, a New Telegram Menu, and Interface Scale That Survives a Restart',
      'ja-JP': 'エージェントが Navide プラグインのツールを使えるように（すべてあなたの同意のうえで）、Guard がより確実に、より静かに、Telegram のメニューを刷新、表示倍率が再起動後も保たれるように',
    },
    features: [
      {
        icon: '🧩',
        name: { 'zh-TW': 'Agent 使用外掛工具', 'en-US': 'Plugin tools for agents', 'ja-JP': 'エージェント向けプラグインツール' },
        tagline: {
          'zh-TW': '第三方 Navide 外掛可以提供工具給 agent 呼叫。預設關閉，打開後也只有你同意過的外掛和工具才會出現。',
          'en-US': 'Third-party Navide plugins can offer tools for agents to call. Off by default, and once on, only plugins and tools you agreed to appear.',
          'ja-JP': 'サードパーティ製 Navide プラグインがエージェント向けのツールを提供できます。初期設定はオフで、オンにしても同意したプラグインとツールだけが使われます。',
        },
        where: {
          'zh-TW': '設定 → Navide 外掛 → 原生後端',
          'en-US': 'Settings → Navide Plugins → Native backends',
          'ja-JP': '設定 → Navide プラグイン → ネイティブバックエンド',
        },
      },
      {
        icon: '✅',
        name: { 'zh-TW': '核准卡', 'en-US': 'Approval card', 'ja-JP': '承認カード' },
        tagline: {
          'zh-TW': 'Agent 申請安裝、更新、移除 Navide 外掛，或重新啟用你停用的外掛時，一定要你在核准卡上按下核准才會執行。',
          'en-US': 'When an agent asks to install, update or remove a Navide plugin, or to re-enable one you disabled, nothing happens until you approve it on the card.',
          'ja-JP': 'エージェントが Navide プラグインのインストール、更新、削除、またはあなたが無効にしたプラグインの再有効化を求めたときは、承認カードであなたが承認するまで何も実行されません。',
        },
        where: { 'zh-TW': '主視窗會跳出', 'en-US': 'Pops up in the main window', 'ja-JP': 'メインウィンドウに表示されます' },
      },
      {
        icon: '🔍',
        name: { 'zh-TW': '活動與揭露', 'en-US': 'Activity and disclosure', 'ja-JP': 'アクティビティと開示' },
        tagline: {
          'zh-TW': '安裝前先看外掛會做什麼、風險多高；安裝後看它實際做了什麼，包括沒宣告就使用的部分。',
          'en-US': 'Before installing, see what a plugin does and how risky it is; afterwards, see what it actually did, including anything it did not declare.',
          'ja-JP': 'インストール前にプラグインが何をするか、リスクがどれくらいかを確認でき、インストール後は宣言していない操作も含めて実際に何をしたかを確認できます。',
        },
        where: {
          'zh-TW': '設定 → Navide 外掛 → 揭露總覽',
          'en-US': 'Settings → Navide Plugins → Disclosure overview',
          'ja-JP': '設定 → Navide プラグイン → 開示の一覧',
        },
      },
    ],
    highlights: [
      {
        'zh-TW': 'Navide 外掛平台：在「設定 → Navide 外掛 → 原生後端」打開開關後，agent 就能呼叫第三方 Navide 外掛提供的工具；只有你同意過的外掛和工具才會出現，外掛一更新、工具一改變，就會再問你一次。Agent 也可以申請安裝、更新、移除 Navide 外掛，或重新啟用你停用的外掛，但一定要你在主視窗的核准卡上按下核准才會執行，按拒絕就什麼都不變。每個外掛在 Navide 市集都有揭露卡，安裝前就看得到風險等級、宣告的權限，以及掃描發現但沒有宣告的項目。安裝後，「權限、授予與活動」會列出外掛實際讀了哪些檔案、跑了哪些指令、agent 對它做了什麼，沒宣告就使用的部分會用紅字標出。外掛的背景程式用太多資源時，Navide 會通知你，由你決定「停止」或「繼續執行」，不再自動關掉。',
        'en-US': 'The Navide plugin platform: turn on the switch in Settings → Navide Plugins → Native backends and agents can call tools that third-party Navide plugins provide. Only plugins and tools you agreed to appear, and you are asked again whenever a plugin updates or a tool changes. Agents can also ask to install, update or remove a Navide plugin, or to re-enable one you disabled, but nothing happens until you press Approve on the card in the main window; Reject changes nothing. Every plugin in the Navide Marketplace has a disclosure card, so before installing you can see its risk level, its declared permissions and anything the scan found that it did not declare. After installing, “Permissions, grants and activity” lists which files the plugin read, which commands it ran and what agents did to it, with anything used without being declared marked in red. When a plugin’s background process uses too many resources, Navide tells you and you choose Stop or Keep running, instead of it being shut down on its own.',
        'ja-JP': 'Navide プラグインのプラットフォーム：「設定 → Navide プラグイン → ネイティブバックエンド」でスイッチをオンにすると、エージェントがサードパーティ製 Navide プラグインのツールを呼び出せるようになります。同意したプラグインとツールだけが使われ、プラグインが更新されたりツールが変わったりすると、もう一度確認します。エージェントは Navide プラグインのインストール、更新、削除、またはあなたが無効にしたプラグインの再有効化を求めることもできますが、メインウィンドウの承認カードであなたが承認するまで何も実行されず、拒否すれば何も変わりません。Navide マーケットプレイスの各プラグインには開示カードがあり、インストール前にリスクの度合い、宣言された権限、スキャンで見つかったのに宣言されていない項目を確認できます。インストール後は「権限・付与・アクティビティ」に、プラグインが実際に読んだファイル、実行したコマンド、エージェントがそのプラグインに行った操作が表示され、宣言せずに使ったものは赤で示されます。プラグインのバックグラウンドプロセスがリソースを使いすぎたときは、自動で止めずに通知し、「停止」か「実行を続ける」かをあなたが選べます。',
      },
      {
        'zh-TW': 'Navide Guard：搜尋碰到憑證位置（例如 ~/.ssh、~/.aws）也會被檢查，Claude 的 Grep、Glob，以及 Qwen Code、Copilot CLI 的搜尋都算在內，同時給了好幾個搜尋路徑時每一個都會檢查。在設定把 Guard 關掉後，就不會再跳出 Guard 的通知或要你確認，不再打擾你。',
        'en-US': 'Navide Guard: searches that touch a credential location (such as ~/.ssh or ~/.aws) are checked too, including Claude’s Grep and Glob and the searches of Qwen Code and Copilot CLI, and every search path is checked when several are given. With Guard switched off in Settings, Guard no longer shows notices or asks you to confirm, so it stays out of your way.',
        'ja-JP': 'Navide Guard：認証情報の場所（~/.ssh や ~/.aws など）に触れる検索もチェックするようになりました。Claude の Grep と Glob、Qwen Code と Copilot CLI の検索も対象で、検索パスが複数あるときはすべてをチェックします。設定で Guard をオフにすると、Guard の通知や確認は表示されなくなり、作業の邪魔をしません。',
      },
      {
        'zh-TW': 'Telegram：原本的 /menu 改成三個指令，/prompts 開 Prompt、/skills 開技能、/mcp 列出 MCP 伺服器（只能查看）。傳 /menu 會提示你改用這三個指令，並附上對應的按鈕。',
        'en-US': 'Telegram: the old /menu becomes three commands: /prompts opens your Prompts, /skills your skills, and /mcp lists your MCP servers (view only). Sending /menu points you to these three, with a button for each.',
        'ja-JP': 'Telegram：これまでの /menu は 3 つのコマンドに分かれました。/prompts でプロンプト、/skills でスキルを開き、/mcp で MCP サーバーを一覧します（閲覧のみ）。/menu を送ると、この 3 つを使うよう案内し、それぞれのボタンを表示します。',
      },
      {
        'zh-TW': '介面縮放：在「設定 → 外觀」調好的介面縮放，重開 Navide 後會保留，不會再回到 100%。',
        'en-US': 'Interface scale: the scale you set in Settings → Appearance is kept when you restart Navide, instead of going back to 100%.',
        'ja-JP': '表示倍率：「設定 → 外観」で設定した表示倍率が、Navide を再起動しても 100% に戻らず保たれるようになりました。',
      },
      {
        'zh-TW': '其他修正與注意：Loop：evolve 超過預算時會自動中斷，Loop 也會停下來。~/.claude/secrets 的保護不只用在搜尋，直接讀取時也會要求確認。在 Telegram 送出 stop 之後，按「繼續」不會重開 Loop，要回到桌面重開。另外，明確中斷分格時 Loop 也會一起停；存了好幾個 MCP 登入的 Claude 帳號現在可以正常切換；在 Windows 上，外掛工具可以用 C:\\ 這類磁碟代號的工作區路徑；外掛名稱和路徑裡看不見的字元會被顯示出來，避免被偽裝成別的外掛。',
        'en-US': 'Other fixes and notes: Loop: when an evolve run goes over its budget it is interrupted automatically, and its Loop stops too. The protection for ~/.claude/secrets covers reading it directly, not just searching it, so a direct read also asks you to confirm. After sending stop from Telegram, pressing Continue does not restart the Loop; restart it on the desktop. Also, explicitly interrupting a pane stops its Loop as well; Claude accounts holding several MCP logins can now be switched; on Windows, Navide plugin tools accept a drive-letter workspace path such as C:\\…; and invisible characters in Navide plugin names and paths are spelled out, so one plugin cannot pass itself off as another.',
        'ja-JP': 'そのほかの修正と注意：Loop：evolve が予算を超えると自動で中断され、Loop も止まります。~/.claude/secrets の保護は検索だけでなく直接の読み取りにも及び、直接読み取るときも確認を求めます。Telegram から stop を送ったあとに「続行」を押しても Loop は再開しないため、デスクトップで再開してください。また、ペインを明示的に中断すると Loop も止まります。複数の MCP ログインを保存した Claude アカウントも切り替えられるようになりました。Windows では、Navide プラグインのツールが C:\\… のようなドライブ文字のワークスペースパスを受け付けます。Navide プラグインの名前やパスに含まれる見えない文字は表示されるようになり、別のプラグインになりすませなくなりました。',
      },
    ],
  },
  {
    version: '0.2.24',
    title: {
      'zh-TW': 'Telegram 待確認提示更好回覆、聊天訊息不再被誤擋、Linux 語音朗讀會出聲',
      'en-US': 'Telegram Prompts That Are Easier to Answer, Chat Messages No Longer Refused, and Read Aloud on Linux',
      'ja-JP': 'Telegram の確認待ちに答えやすく、チャットのメッセージが誤って拒否されなくなり、Linux で読み上げが鳴るようになりました',
    },
    highlights: [
      {
        'zh-TW': 'Telegram 待確認提示：在聊天輸入 /pending，就會把這個聊天裡所有還在等確認的提示重新列出，附上分格名稱、等了幾分鐘、選項和按鈕。分格在等確認時你傳訊息過去，收到的警告現在也會附上提示內容、選項和按鈕，並引用原本那則提示。畫面上的確認如果已經換了，你的回覆不會送出，聊天會收到最新的確認讓你重新選。Navide 只會補上 bot 指令選單缺少的項目，不會覆蓋你原本的指令。傳錯訊息時，/cancel 會撤回還沒送進分格的訊息；「已收到，等分格空檔」的回覆也附上「撤回」和「中斷」按鈕。用 stop 中斷後，回覆會寫出分格名稱和還在排隊的則數，按「▶️ 繼續」、傳 /resume，或直接傳下一則訊息，就能讓分格繼續。',
        'en-US': 'Telegram prompts waiting for an answer: type /pending in a chat to list every prompt still waiting there again, with the pane name, how long it has waited, its options and buttons. The warning you get when you write to a waiting pane now carries the prompt, its options and buttons, and quotes the original prompt. If the prompt on screen has changed, your answer is not sent, and the chat gets the current prompt to choose again. Navide only adds the bot commands it needs that are missing; your own commands are never replaced. Sent something by mistake? /cancel withdraws messages that have not reached the pane yet, and the “received, waiting for the pane” reply has Withdraw and Interrupt buttons. After stop, the reply names the pane and how many messages are still queued, and ▶️ Continue, /resume or simply your next message lets the pane carry on.',
        'ja-JP': 'Telegram の確認待ち：チャットで /pending と送ると、そのチャットでまだ回答を待っている確認がすべて、ペイン名、待ち時間、選択肢、ボタン付きで改めて表示されます。確認待ちのペインにメッセージを送ったときの警告にも、確認の内容、選択肢、ボタンが付き、元の確認メッセージを引用するようになりました。画面の確認が変わっていた場合、回答は送られず、最新の確認がチャットに届くので選び直せます。Navide は bot のコマンド一覧に足りない項目だけを追加し、既存のコマンドを上書きしません。間違えて送ったときは、/cancel でまだペインに届いていないメッセージを取り消せます。「受け取りました、ペインの空きを待っています」の返信にも「取り消し」と「中断」のボタンが付きます。stop で中断すると、返信にペイン名とまだ待っている件数が表示され、「▶️ 続行」、/resume、または次のメッセージを送るだけでペインが再開します。',
      },
      {
        'zh-TW': '頻道聊天訊息不再被當成 agent 而擋下：之前一分鐘內傳第六則就會收到「訊息沒有送進分格（rate-limit）」，連重送也被擋。現在人傳的聊天訊息上限是每個分格每分鐘 30 則，超過時會告訴你幾秒後可以重送。從聊天頻道送進來的訊息也有專屬的通知樣式：紅色標題列寫著「外部頻道 · 平台 · 傳送者」。頻道標籤現在一律顯示 bot 的名字（平台 · bot），不再顯示聊天對象，完整資訊放在提示框。Claude 讀取圖片時的說明不會再以「你：[Image: …]」轉到聊天；貼了圖片的訊息會轉送你打的文字加上「🖼 圖片 ×N」。「工作中」的狀態也不會再卡住、等不到 ✅。',
        'en-US': 'Chat messages are no longer limited like an agent’s: a sixth message within a minute used to get “message not delivered to pane (rate-limit)”, and resends were refused too. A person’s chat messages now have a cap of 30 per minute per pane, and past it the chat is told how many seconds to wait before resending. Deliveries from a chat channel also get their own toast, with a red header reading “External channel · platform · sender”. Channel labels now name the bot (platform · bot) instead of the person you chat with, with the full detail in the tooltip. Claude’s notes about an image it read are no longer forwarded as “You: [Image: …]”; a message with pasted images forwards your typed text plus “🖼 Image ×N”. The “working” status no longer gets stuck before ✅.',
        'ja-JP': 'チャンネルのチャットのメッセージが、エージェントと同じ制限で拒否されなくなりました。以前は 1 分間に 6 通目を送ると「メッセージがペインに届きませんでした（rate-limit）」となり、再送も拒否されていました。人が送るチャットのメッセージは、ペインごとに 1 分間 30 通までになり、超えたときは何秒後に再送できるかを伝えます。チャットのチャンネルから届いたメッセージには専用の通知も加わり、赤い見出しに「外部チャンネル · プラットフォーム · 送信者」と表示されます。チャンネルのラベルは、チャットの相手ではなく bot の名前（プラットフォーム · bot）を表示するようになり、詳しい情報はツールチップに出ます。Claude が画像を読んだときのメモは「あなた：[Image: …]」としてチャットに転送されなくなり、画像を貼り付けたメッセージは入力した文字に「🖼 画像 ×N」を添えて転送します。「作業中」の表示が ✅ にならないまま残ることもなくなりました。',
      },
      {
        'zh-TW': 'Linux 上的語音朗讀現在真的會出聲。Windows 的語音設定提示改成指向「設定 › 時間與語言 › 語音」，不再是 macOS 的路徑。',
        'en-US': 'Read aloud now speaks on Linux. On Windows, the voice settings hint points at Settings › Time & language › Speech instead of a macOS path.',
        'ja-JP': 'Linux でも読み上げの音声が出るようになりました。Windows の音声設定の案内は、macOS のパスではなく「設定 › 時刻と言語 › 音声認識」を示すようになりました。',
      },
      {
        'zh-TW': '其他修正：Git 監看剛好大量寫入時結束 Navide，後端不會再卡住或多等。排程工作的擁有者會跟著續接的對話走，原本的分格關掉或重建後，接手同一段對話的分格仍能修改它。用 navide-plugin init 建立的外掛現在可以安裝。外掛開發文件已更正，並會在與 SDK 不一致時讓 CI 失敗；外掛後端的錯誤訊息也會完整保留。',
        'en-US': 'Also fixed: quitting Navide while the Git watcher is recording a burst no longer hangs or delays the backend. A scheduled job’s owner follows a resumed conversation, so the pane that takes over the conversation can still change the job after the original pane is closed or rebuilt. A plugin created with navide-plugin init now installs. The plugin developer docs are corrected, and CI now fails when they drift from the SDK; plugin backend error messages are kept in full.',
        'ja-JP': 'そのほかの修正：Git の監視が大量に記録している最中に Navide を終了しても、バックエンドが止まったり待たされたりしなくなりました。スケジュールしたジョブの所有者は再開した会話に引き継がれるため、元のペインを閉じたり作り直したりしても、その会話を引き継いだペインからジョブを変更できます。navide-plugin init で作成したプラグインがインストールできるようになりました。プラグイン開発者向けドキュメントを修正し、SDK と食い違うと CI が失敗するようにしました。プラグインのバックエンドのエラーメッセージも省かれずに残ります。',
      },
    ],
  },
  {
    version: '0.2.23',
    title: {
      'zh-TW': '解除綁定的頻道聊天不再收到分格的回覆、狀態列通知鈴鐺、Windows 與 Linux 的快速鍵和視窗修正、安全性加強',
      'en-US': 'Unbound Channel Chats Stay Unbound, a Notifications Bell, Windows and Linux Shortcut and Window Fixes, and Security Hardening',
      'ja-JP': '紐づけを解除したチャットにペインの返信が届かなくなりました、ステータスバーの通知ベル、Windows と Linux のショートカットとウィンドウの修正、セキュリティの強化',
    },
    highlights: [
      {
        'zh-TW': 'Telegram 等頻道聊天：分格的回合結束時沒有文字，Navide 會先保留這則請求，最多等 120 秒讓文字送到。在 0.2.22 裡，如果在這段等待中解除綁定（或分格關掉了），分格的下一則回覆，連你在鍵盤上打的那一則，都可能被送到已解除綁定的聊天。現在解除綁定會一併丟掉保留的請求，不會再有任何內容送到那個聊天。「Channel 連線監控」的每一列現在會同時顯示連線的兩端：分格（已關閉的會標上「已關閉」）以及平台、bot 和聊天名稱。',
        'en-US': 'Telegram and other channel chats: when a pane’s turn ends without text, Navide holds the chat request for up to 120 s for that text. In 0.2.22, if the chat was unbound (or the pane went away) during that wait, the pane’s next reply, even one typed at the keyboard, could be sent to the unbound chat. Unbinding now drops the held request, so nothing more is sent to that chat. Each row in Channel connections now shows both ends of its link: the pane (marked “Closed” when it is gone) and the platform, bot and chat name.',
        'ja-JP': 'Telegram などのチャンネルのチャット：ペインのターンがテキストなしで終わると、Navide はそのテキストを最大 120 秒待つあいだリクエストを保留します。0.2.22 では、この待ち時間中にチャットの紐づけを解除する（またはペインがなくなる）と、ペインの次の返信が、キーボードから入力したものも含めて、紐づけを解除したチャットに送られることがありました。紐づけを解除すると保留中のリクエストも破棄されるようになり、そのチャットには何も送られなくなりました。「チャンネル接続」の各行には接続の両端が表示されるようになりました。ペイン（なくなったものは「閉じています」と表示）と、プラットフォーム、bot、チャット名です。',
      },
      {
        'zh-TW': 'Windows 與 Linux 快速鍵改變：主視窗側欄分頁改成 Ctrl+Alt+1–5，設定改成 Ctrl+,。這些按鍵不會再傳給終端機分格裡的 CLI。Ctrl+1–9 仍然是選擇 CLI 類型。在 AltGr+數字會打出字元的鍵盤配置上（例如德文的 ² 和 ³），那個數字鍵照樣打出字元，不會切換分頁。macOS 不變。',
        'en-US': 'Windows and Linux shortcuts change: the main window’s sidebar tabs are now Ctrl+Alt+1–5 and Settings is Ctrl+,. Those keys no longer reach the CLI in a terminal pane. Ctrl+1–9 still selects the CLI type. On keyboard layouts where AltGr+digit types a character (German ² and ³, for example), that digit keeps typing the character and does not switch tabs. macOS is unchanged.',
        'ja-JP': 'Windows と Linux のショートカットが変わりました：メインウィンドウのサイドバーのタブは Ctrl+Alt+1〜5、設定は Ctrl+, になりました。これらのキーはターミナルのペインの CLI には送られなくなります。Ctrl+1〜9 は引き続き CLI の種類を選びます。AltGr+数字で文字が入力されるキーボード配列（たとえばドイツ語の ² と ³）では、その数字キーはこれまでどおり文字を入力し、タブは切り替わりません。macOS は変わりません。',
      },
      {
        'zh-TW': '狀態列新增通知鈴鐺：一眼就能看出系統通知和提示音是否開著，系統拒絕通知權限時會顯示警示點。點一下就能直接切換「系統通知」和「提示音」，也能看到通知權限狀態，或前往通知設定。',
        'en-US': 'A notifications bell in the status bar shows at a glance whether system notifications and the notification sound are on, with a warning dot when the system has denied notifications. Click it to switch “System notifications” and “Notification sound” on the spot, see the permission status, or go to Notification settings.',
        'ja-JP': 'ステータスバーに通知ベルが加わりました。システム通知と通知音がオンかどうかがひと目でわかり、システムが通知を許可していないときは警告の点が付きます。クリックすると「システム通知」と「通知音」をその場で切り替えられ、通知の許可状態の確認や通知の設定への移動もできます。',
      },
      {
        'zh-TW': '更容易看出分格出了問題：agent CLI 以非 0 代碼結束時，標題列會顯示「⚠ 已結束（代碼 N）」；回合進行中超過 20 分鐘沒有任何紀錄或輸出時，會顯示「⏳ 超過 20 分鐘沒有動靜」，只是提醒，不會中斷任何東西。Git 面板讀不到歷史或某個 commit 時，會顯示「讀取失敗：原因」，不再看起來像沒有新 commit。',
        'en-US': 'Easier to see when a pane is in trouble: an agent CLI that ends with a non-zero code shows “⚠ Exited (code N)” in its title bar, and a turn with no log activity and no output for 20 minutes shows “⏳ No activity 20+ min”, as a reminder only; nothing is interrupted. When the Git panel cannot read the history or a commit, it says “Read failed: <reason>” instead of looking like there are no new commits.',
        'ja-JP': 'ペインの問題に気づきやすくなりました：エージェントの CLI が 0 以外のコードで終了すると、タイトルバーに「⚠ 終了（コード N）」と表示されます。ターンの途中で 20 分以上ログにも画面にも動きがないと「⏳ 20 分以上動きなし」と表示されますが、通知だけで何も中断しません。Git パネルが履歴やコミットを読み込めないときは、新しいコミットがないように見えるのではなく「読み込みに失敗しました：理由」と表示します。',
      },
      {
        'zh-TW': '沒有分格的工作區分頁只顯示一句說明、一個「開啟 Agent」按鈕（打開側欄的 Agents 分頁），以及「或執行流程 ▶」連結。歡迎視窗的最近清單中，狀態標籤、時間和「找不到資料夾」提示都會依介面語言顯示，主要按鈕改用強調色。',
        'en-US': 'A workspace tab with no panes shows one sentence, an “Open Agent” button that opens the sidebar’s Agents tab, and an “or run the pipeline ▶” link. In the Welcome window, the recent list’s state badges, times and “Folder not found” tooltip are translated, and the primary button uses the accent colour.',
        'ja-JP': 'ペインのないワークスペースのタブには、一文の説明と、サイドバーの「エージェント」タブを開く「エージェントを開く」ボタン、「またはパイプラインを実行 ▶」のリンクだけが表示されます。ようこそ画面の最近使用した項目では、状態の表示、時刻、「フォルダが見つかりません」の表示が日本語になり、主ボタンはアクセントカラーになりました。',
      },
      {
        'zh-TW': '設定：Navide Cloud 移到原本的「Navide 外掛」群組，群組改名為「Navide 支援」。Navide Cloud › 同步依照側欄「Agent 資產」的順序和名稱，每一頁列一列；MCP、技能和 Prompt 技能可以打開，記憶、憑證與金鑰和擴充呈灰色，標示「尚未支援同步」。',
        'en-US': 'Settings: Navide Cloud moves into the group formerly called “Navide Plugins”, now “Navide Services”. Navide Cloud › Sync lists one row per Agent Assets page, in the sidebar’s order and under its names: MCP, Skills and Prompts can be turned on, while Memory, Credentials & keys and Extensions are greyed out as “not syncable yet”.',
        'ja-JP': '設定：Navide Cloud は、以前「Navide プラグイン」だったグループに移り、グループ名は「Navide サービス」になりました。Navide Cloud › 同期には、サイドバーの「エージェント資産」と同じ順序と名前で 1 ページ 1 行が並びます。MCP、スキル、プロンプトはオンにでき、メモリ、認証情報とキー、拡張機能はグレーで「まだ同期できません」と表示されます。',
      },
      {
        'zh-TW': 'Navide 外掛更可靠：連不上 Registry 時，之前找到的外掛更新不會再消失，每個套件都會保留最後一次找到的更新。在「Navide 外掛」和「Navide 市集」裡，移除外掛、重新讀取已安裝清單或切換「接收預覽版」失敗時，現在會顯示錯誤，不會再默默失敗。',
        'en-US': 'More reliable Navide plugins: when the Registry cannot be reached, updates found earlier no longer disappear; each package keeps its last known update. In Navide Plugins and Navide Marketplace, a failed plugin removal, installed-list reload or “Get pre-releases” switch now shows an error instead of failing silently.',
        'ja-JP': 'Navide プラグインの信頼性を改善：Registry に接続できないときも、以前見つかったプラグインの更新が消えなくなり、各パッケージは最後に見つかった更新を保持します。「Navide プラグイン」と「Navide マーケットプレイス」で、プラグインの削除、インストール済み一覧の再読み込み、「プレリリースを受け取る」の切り替えに失敗したときは、黙って失敗せずにエラーを表示するようになりました。',
      },
      {
        'zh-TW': '切換版面（從格線改成側欄、聚焦或全螢幕）後，終端機分格的欄寬可能被鎖得比分格窄。這時在分格的右鍵選單選「填滿分格寬度」，就能改用分格的完整寬度；這個選項只在欄寬被鎖住時出現，上方較早的輸出可能會有幾行重新換行。',
        'en-US': 'After switching the layout from Grid to sidebar, spotlight or fullscreen, a terminal pane’s columns can stay locked narrower than the pane. Its right-click menu now offers “Fit to pane width” to use the full width; it appears only while the pane is capped, and older output above may re-wrap a few lines.',
        'ja-JP': 'レイアウトをグリッドからサイドバー、スポットライト、フルスクリーンに切り替えたあと、ターミナルのペインの桁数がペインより狭く固定されることがあります。そのときはペインの右クリックメニューの「ペイン幅に合わせる」でペインの全幅を使えます。この項目は桁数が固定されているときだけ表示され、上の古い出力は数行折り返し直される場合があります。',
      },
      {
        'zh-TW': '通知更好分辨：從其他裝置（透過 Navide Cloud）或聊天頻道（Telegram、LINE 等）送來的訊息，改用專屬的紅色「外部」通知，顯示 8 秒，取代原本誤標成「來自其他工作區」的那則。Navide Guard 的通知加上紅框，其他本機工作區的通知改成靛藍色，其餘通知不變。通知文字也都依介面語言顯示，更新提示改稱「Navide」而不是「Agent-Team」，閒置回收的通知也改正為請你點分格上的「點擊以續接」卡片。',
        'en-US': 'Toasts that tell you where they come from: messages from another device through Navide Cloud, or from a chat channel (Telegram, LINE and others), get a dedicated red “external” toast for 8 s, in place of the mislabeled “other workspace” one. Navide Guard toasts get a red frame, toasts from another local workspace are indigo, and every other toast is unchanged. Toast text is translated throughout, update prompts say “Navide” instead of “Agent-Team”, and the idle-reclaim toast now points at the pane’s “Click to resume” card.',
        'ja-JP': '通知の出どころがわかりやすくなりました：Navide Cloud を通じた別のデバイスや、チャットのチャンネル（Telegram、LINE など）からのメッセージは、誤って「別のワークスペース」と表示されていた通知の代わりに、専用の赤い「外部」通知で 8 秒表示されます。Navide Guard の通知には赤い枠が付き、ローカルの別のワークスペースからの通知は藍色になり、それ以外の通知は変わりません。通知の文言も日本語で表示されるようになり、アップデートの確認は「Agent-Team」ではなく「Navide」と表示し、アイドル回収の通知はペインの「クリックして再開」カードを案内するようになりました。',
      },
      {
        'zh-TW': 'Windows 與 Linux 修正：在終端機按住 Ctrl 點檔案路徑就能開啟（macOS 仍是 Cmd），也認得 C:\\ 這類 Windows 路徑。可以拖曳標題列上的工作區名稱來移動視窗。外掛視圖在最大化、還原或全螢幕後會跟著視窗大小。結束確認視窗的標題是「Navide」，不再是「agent-team」；Linux 上的最大化按鈕也不會再停在「還原」。在 Windows 上，以反斜線路徑開啟 Plan 會開到正確的 Plan。',
        'en-US': 'Windows and Linux fixes: Ctrl+click on a file path in the terminal opens it (Cmd+click on macOS), and Windows paths such as C:\\… are recognised. The window can be dragged by the workspace name in the title bar. Plugin views keep the window’s size after maximize, restore or full screen. The quit prompts are titled “Navide” instead of “agent-team”, and on Linux the maximize button no longer gets stuck on “Restore”. On Windows, a plan opened by a backslash path opens the right plan.',
        'ja-JP': 'Windows と Linux の修正：ターミナルでファイルのパスを Ctrl+クリックすると開けるようになり（macOS は Cmd+クリック）、C:\\… のような Windows のパスも認識します。タイトルバーのワークスペース名をドラッグしてウィンドウを動かせます。プラグインのビューは、最大化、元に戻す、フルスクリーンのあともウィンドウの大きさに合わせます。終了の確認の題名は「agent-team」ではなく「Navide」になり、Linux では最大化ボタンが「元に戻す」のまま残らなくなりました。Windows では、バックスラッシュのパスで開いた Plan が正しく開きます。',
      },
      {
        'zh-TW': '安全性加強：分格連到 Navide MCP 的憑證不再出現在命令列（`ps` 對這台電腦上的每個帳號都看得到），改放在只有你能讀的檔案或環境變數裡。在規則編輯器封鎖的裝置，伺服器停止提供規則時仍然會被拒絕。跨裝置訊息要先通過簽章驗證才會記入防重送紀錄，訊息通道也不再接受配對訊息；配對只能在帳號視窗完成。已使用時間簽章（sig2）的裝置，若訊息缺少或附上無效的時間簽章，改為拒收（不再退回舊版簽章）；從未使用時間簽章的裝置照舊。若是兩台機器時鐘差距過大，帳號視窗會說明對方那台快或慢了幾分鐘。',
        'en-US': 'Security hardening: a pane’s credential for Navide’s MCP server is no longer in its command line, where ps shows it to every account on the computer; it is in a file only you can read, or in the environment. A device blocked in the policy editor stays refused when the server stops serving the policy. A cross-device message goes into the replay record only after its signature verifies, and the message channel no longer carries pairing; pairing is done only in the account window. A device that signs with the time signature (sig2) now has messages without a usable one refused instead of falling back to the older signature; devices that have never used it behave as before. When the cause is clock skew, the account window says whether the other machine is ahead or behind, and by how many minutes.',
        'ja-JP': 'セキュリティの強化：ペインが Navide の MCP サーバーに接続するための認証情報はコマンドラインに含まれなくなりました（コマンドラインは ps でこのコンピューターのすべてのアカウントから見えます）。代わりに本人だけが読めるファイルか環境変数に入ります。ルールの編集画面でブロックしたデバイスは、サーバーがルールを提供しなくなっても拒否されたままです。デバイス間のメッセージは署名を確認してから再送防止の記録に入り、メッセージのチャンネルではペアリングを扱わなくなりました。ペアリングはアカウント画面でのみ行えます。時刻署名（sig2）を使っているデバイスから、時刻署名がないか無効なメッセージが届いた場合は、旧形式の署名に戻さずに受信を拒否するようになりました。時刻署名を使ったことのないデバイスはこれまでどおりです。原因が時刻のずれの場合は、相手のマシンが何分進んでいるか遅れているかをアカウント画面で説明します。',
      },
      {
        'zh-TW': 'Plan：Plan 視圖現在也會算出太大、無法放進一頁清單的 Plan 中「待你」的待辦。Agent 的 plan_list 和 plan_read 遇到 Navide 回應逾時會自動重試一次；Navide 沒有開啟時，錯誤訊息會請 agent 先開啟 Navide 再重試。Agent 現在可以用 plan_add_todo 在既有的 Plan 文件新增待辦，畫面同步顯示。',
        'en-US': 'Plans: the Plans view now counts “for you” todos for a plan too big for one page of the list. An agent’s plan_list and plan_read retry once when Navide’s answer times out, and when Navide is not open the error tells the agent to open it and retry. Agents can now add todos to an existing plan with plan_add_todo; the new row appears in the Plan view.',
        'ja-JP': 'Plan：一覧の 1 ページに収まらない大きな Plan でも、Plan ビューが「あなたの対応待ち」の ToDo を数えるようになりました。エージェントの plan_list と plan_read は、Navide の応答がタイムアウトしたときに一度だけ再試行し、Navide が開いていないときは、Navide を開いてから再試行するようエラーで伝えます。エージェントは plan_add_todo で既存の Plan に ToDo を追加できるようになり、追加した行は Plan ビューにすぐ表示されます。',
      },
    ],
  },
  {
    version: '0.2.22',
    title: {
      'zh-TW': '設定頁全面整理、語音朗讀通知、頻道聊天不再卡在「仍在執行」',
      'en-US': 'A Tidier Settings Window, Spoken Notices, and Channel Chats No Longer Stuck on “Still Running”',
      'ja-JP': '設定画面を全面的に整理、音声による通知の読み上げ、チャンネルのチャットが「実行中」で止まらなくなりました',
    },
    highlights: [
      {
        'zh-TW': '設定頁全面整理：狀態徽章、鍵盤快速鍵和分析頁面中，停用的按鈕文字清楚可讀，鍵盤快速鍵改用圖示並附上看得到的說明，每頁只留一個主要按鈕，日文的文字也不會再被截斷。版面、CLI agent 和 CLI 擴充頁面也一併整理：圖示一致、控制項對齊，停用的控制項看得出來，推送標籤改成「推送開啟／推送已關／無推送通道」，分頁名稱縮短為「Navide 做的修改」，分析頁面的按鈕對比更清楚，日文也不會再有單獨掉到下一行的字。帳號、憑證和安全性頁面也重新排版：支援多帳號的 CLI 排在前面並顯示完整 email，較長的說明收進「詳細說明」，憑證頁用分段切換在發現與清單之間切換，安全性頁的 CLI 分兩欄列出，範圍列標成「適用範圍」，每個 CLI 的縮寫也不再重複，側欄的「CLI Agents」改為「CLI 代理」。',
        'en-US': 'A tidier Settings window: on the status badges, keyboard shortcuts and analyzer pages, disabled buttons stay readable, keyboard shortcuts use icons with a visible legend instead of emoji, each page has one primary button, and Japanese text is no longer cut off. The layout, CLI agents and CLI extensions pages are tidied up as well: consistent icons and aligned controls, disabled controls you can see, push badges that read “Push on / Push off / No push channel”, a shorter “What Navide changes” tab, better contrast on the analyzer buttons, and Japanese lines that no longer leave a lone character on the next line. The accounts, credentials and security pages are laid out again too: CLIs with several accounts come first with full email addresses, long explanations fold under “Details”, Credentials switches between findings and inventory with a segmented control, Security lists the CLIs in two columns with scope rows labelled “Applies to”, and every CLI has its own distinct initials.',
        'ja-JP': '設定画面を全面的に整理：ステータスバッジ、キーボードショートカット、分析のページでは、無効なボタンの文字も読みやすくなり、キーボードショートカットは絵文字の代わりにアイコンと見える凡例で表示し、各ページの主ボタンは一つになり、日本語の文字が切れることもなくなりました。レイアウト、CLI エージェント、CLI 拡張機能のページも整えました。アイコンをそろえて操作部品の位置を合わせ、無効な操作部品も見分けられるようにし、プッシュの表示を「プッシュ有効／プッシュ無効／プッシュ非対応」に、タブ名を「Navide による変更」に短くし、分析ページのボタンのコントラストを改善し、日本語で一文字だけ次の行に送られることもなくなりました。アカウント、認証情報、セキュリティのページも整理しました。複数アカウントに対応した CLI を先頭に完全なメールアドレスで表示し、長い説明は「詳細」に折りたたみ、認証情報ではセグメント切り替えで検出結果と一覧を切り替え、セキュリティでは CLI を 2 列に並べて「適用範囲」の行を見出し付きにし、CLI の略称も重複しなくなりました。日本語の改行位置もさらに自然になりました。',
      },
      {
        'zh-TW': '語音朗讀：標上 🔊 的分格完成時，Navide 會用系統聲音念出「<分格> 完成了」，需要你回答時念「<分格> 需要你回答」。在分格標題列點 🔊 就能標記；按 Esc 或語音輸入快速鍵會立刻停止。預設關閉，到設定 › 語音輸入 › 語音朗讀開啟「朗讀回覆」。「語音模型」一列會顯示建議的聲音（中文是美佳（Premium））是否已安裝，按「下載」會打開 macOS 系統設定的「輔助使用 › 朗讀內容」下載。',
        'en-US': 'Read aloud: when a pane marked 🔊 finishes or needs your answer, Navide speaks a short notice in the system voice — “<pane> is done” or “<pane> needs your answer”. Click 🔊 in a pane’s title bar to mark it; Esc or the voice input shortcut stops speech at once. It is off by default: turn on “Read replies aloud” in Settings › Voice Input › Read aloud. The “Voice model” row shows whether the recommended voice (Ava (Premium) for English) is installed, and Download opens Accessibility › Spoken Content in macOS System Settings to get it.',
        'ja-JP': '読み上げ：🔊 を付けたペインが完了したり回答を求めたりすると、Navide がシステムの音声で「<pane> が完了しました」「<pane> があなたの回答を待っています」と短く読み上げます。ペインのタイトルバーの 🔊 をクリックして付け、Esc か音声入力のショートカットですぐに止められます。既定ではオフなので、設定 › 音声入力 › 読み上げ で「返信を読み上げる」をオンにしてください。「音声モデル」の行で推奨の音声（日本語は Kyoko (Enhanced)）がインストール済みかを確認でき、「ダウンロード」を押すと macOS のシステム設定の「アクセシビリティ › 読み上げコンテンツ」が開きます。',
      },
      {
        'zh-TW': 'Telegram 等頻道聊天：Claude 在閒置時自動壓縮對話後，聊天不會再一直停在「⏳ 仍在執行」。綁定頻道的分格用完 Claude 額度時，聊天會收到一次通知並附上重置時間；這則請求會先保留，重置後的回覆照樣會送到聊天。Claude 把一則回覆拆成兩行紀錄時，聊天也不會再多收到一則空白的「（分格回合結束，沒有文字輸出）」。資料夾名稱含有 token 字樣（例如「Token仲介平台」）的檔案，現在可以當附件傳到聊天，不會再被誤判成金鑰。',
        'en-US': 'Telegram and other channel chats: a chat no longer stays on “⏳ still running” after Claude compacts an idle conversation. When a pane bound to a chat hits its Claude usage limit, the chat is told once, with the reset time; the request stays open, so the reply after the reset still arrives there. When Claude splits one reply into two transcript lines, the chat no longer gets an extra empty “pane turn ended with no text output” reply. A file in a folder whose name mentions “token” can now be sent as a chat attachment instead of being refused as a secret.',
        'ja-JP': 'Telegram などのチャンネルのチャット：Claude がアイドル中の会話を自動で圧縮したあとも、チャットが「⏳ 実行中」のまま止まらなくなりました。チャットに紐づいたペインが Claude の使用量の上限に達すると、チャットにリセット時刻つきで一度だけ通知します。リクエストは保留されたままなので、リセット後の返信もそのチャットに届きます。Claude が一つの返信を記録の二行に分けたときに、空の「ペインのターンが終了、テキスト出力なし」という返信が余分に届くこともなくなりました。フォルダー名に token を含むファイルも、秘密情報と誤判定されずにチャットへ添付できるようになりました。',
      },
      {
        'zh-TW': '帳號清單的「全部改為跟隨」和切換帳號，現在也能找到在問題開著時被重建的分格，不會再把它當成不見了。每個分格的「跟隨帳號切換」開關移到帳號彈出視窗的最上方；分格標頭的 🔗 按鈕已移除，只有固定帳號的分格會在標頭顯示 📌。',
        'en-US': '“Make all follow” and account switching in the account list now find a pane that was rebuilt while the question was open, instead of reporting it missing. Each pane’s “Follow account switch” toggle now sits at the top of the account popover; the 🔗 button in the pane header is gone, and the header shows 📌 only when a pane is pinned.',
        'ja-JP': 'アカウント一覧の「すべて追従にする」とアカウントの切り替えは、確認を開いている間に作り直されたペインも見つけられるようになり、見つからないと報告しなくなりました。ペインごとの「アカウント切り替えに追従」のスイッチはアカウントのポップオーバーの一番上に移りました。ペインのヘッダーの 🔗 ボタンはなくなり、📌 は固定したペインのヘッダーにだけ表示されます。',
      },
      {
        'zh-TW': 'CLI 安裝提示的「不要再詢問」勾選框現在一定會出現並記住你的選擇，Codex 的安裝提示不會再一直跳出來。偵測結果不確定時也不會再當成沒安裝，所以用 nvm 或 shell 啟動較慢時，已經裝好的 CLI 不會再跳出安裝提示。',
        'en-US': 'The “Stop asking” box on the CLI install prompt now always shows up and is saved, so the Codex install prompt stops coming back. An uncertain detection result no longer counts as “not installed”, so a CLI that is already installed — common with nvm or a slow shell — no longer gets the install prompt.',
        'ja-JP': 'CLI のインストール確認にある「今後確認しない」のチェックボックスが必ず表示され、選択が保存されるようになりました。Codex のインストール確認が何度も出ることはなくなります。検出結果がはっきりしないときに「未インストール」と扱うこともなくなったため、nvm を使っていたりシェルの起動が遅かったりしても、インストール済みの CLI でインストールの確認が出ることはなくなりました。',
      },
      {
        'zh-TW': '狀態列的後端彈出視窗（標題、連線狀態、重新啟動／啟動／停止）和流程進度標籤（階段 N / M、已完成／已中止）現在會依介面語言顯示，不再出現英文。',
        'en-US': 'The status bar’s backend popover (title, connection state, Restart/Start/Stop) and pipeline pill (Stage N / M, completed/aborted) are now translated in Traditional Chinese and Japanese.',
        'ja-JP': 'ステータスバーのバックエンドのポップオーバー（タイトル、接続状態、再起動／開始／停止）とパイプラインの進行状況（ステージ N / M、完了／中止）が日本語で表示されるようになり、英語のままにならなくなりました。',
      },
      {
        'zh-TW': '分格在儲存庫的子資料夾裡工作時，Plan 和 pipeline 也能正常運作。',
        'en-US': 'Plans and pipelines work correctly when a pane works in a subfolder of a repository.',
        'ja-JP': 'ペインがリポジトリのサブフォルダーで作業しているときも、Plan とパイプラインが正しく動作するようになりました。',
      },
    ],
  },
  {
    version: '0.2.21',
    title: {
      'zh-TW': '點一下就切換所有分格的帳號、Guard 可放行信任的指令、配對失敗會說原因',
      'en-US': 'One Click Switches Every Pane’s Account, Trusted Commands in Navide Guard, and Pairing Failures That Say Why',
      'ja-JP': 'ワンクリックで全ペインのアカウントを切り替え、Navide Guard で信頼するコマンドを許可、ペアリング失敗の理由を表示',
    },
    highlights: [
      {
        'zh-TW': '點一下就切換帳號：在分格帳號徽章的帳號清單點另一個 Claude 帳號，所有跟隨中的分格下一回合就改用新帳號，不用重開，每個帳號也只要登入一次。新開的分格預設跟隨；想讓某個分格留在原帳號，按帳號徽章旁的圖釘把它固定（會在該帳號的資料夾重開一次並接續對話），再按一次就改回跟隨。0.2.20 的「切換 Claude 帳號時，固定帳號的分格一起換」照舊只管固定的分格：開啟時，切換後會列出這些分格讓你選要不要一起換；跟隨中的分格不用這個設定就會跟著換。升級前就在帳號資料夾裡執行的分格會維持固定，在帳號清單按「全部改為跟隨」就會跟著切換（每個分格重開一次並接續對話，正在執行的會先問你）。',
        'en-US': 'One click switches accounts: click another Claude account in a pane’s account badge list, and every following pane uses it from its next turn — no restart, and one sign-in per account. New panes follow by default. To keep a pane on its account, fix it with the pin beside its account badge (it reopens once in that account’s own folder and picks up its conversation); click again to make it follow. 0.2.20’s “Move pinned panes along when switching Claude accounts” still covers only fixed panes: when on, a switch lists them so you can choose which move too; following panes move without it. Panes that were already running in an account folder before the update stay fixed until you choose “Make all follow” in the account list (each reopens once and picks up its conversation; one that is working is asked about first).',
        'ja-JP': 'ワンクリックでアカウントを切り替え：ペインのアカウントバッジの一覧で別の Claude アカウントをクリックすると、追従中のペインはすべて次のターンから新しいアカウントを使います。再起動は不要で、サインインもアカウントごとに一度だけです。新しいペインは既定で追従します。ペインを元のアカウントのままにしたいときは、アカウントバッジの横のピンで固定します（そのアカウントの専用フォルダーで一度開き直し、会話を続けます）。もう一度押すと追従に戻ります。0.2.20 の「Claude アカウントの切り替え時に、固定したペインも一緒に切り替える」はこれまでどおり固定したペインだけが対象で、オンにすると切り替え後にそれらのペインが一覧に並び、一緒に切り替えるかを選べます。追従中のペインはこの設定がなくても切り替わります。アップデート前からアカウントのフォルダーで動いていたペインは固定のままなので、アカウント一覧の「すべて追従にする」を選ぶと切り替えに追従します（各ペインは一度開き直して会話を続け、実行中のペインは先に確認します）。',
      },
      {
        'zh-TW': 'Navide Guard：在收過外部內容的分格，你可以用比對整條指令的萬用字元樣式（例如 python3 -c *）放行信任的指令，不必每次確認。Guard 看不懂的特殊寫法一律交給你確認；因此在這類分格上，find -exec … \\; 這類寫法可能會多問你一次。',
        'en-US': 'Navide Guard: on a pane that has received external content, an allow pattern that matches the whole command with wildcards (for example python3 -c *) now lets a command you trust run without asking each time. Anything written in a way Guard cannot read is always left for you to confirm, so on such a pane a command like find -exec … \\; may ask you once more.',
        'ja-JP': 'Navide Guard：外部の内容を受け取ったペインでも、コマンド全体に一致するワイルドカードの許可パターン（例：python3 -c *）で、信頼するコマンドを毎回確認せずに実行できるようになりました。Guard が読み取れない特殊な書き方は必ずあなたの確認に回すため、そのようなペインでは find -exec … \\; のような書き方で一度多く確認されることがあります。',
      },
      {
        'zh-TW': '跨裝置配對被拒時會馬上結束，並說明原因和下一步，不會再一直顯示「等待回應」到逾時。等待中的配對可以按「取消請求」；配對還在進行時再按「配對」，會告訴你大約還要等幾分鐘。',
        'en-US': 'A refused cross-device pairing now ends at once and says why and what to do next, instead of showing “waiting” until it times out. A pairing that is waiting can be cancelled with “Cancel request”, and pressing Pair while one is still in progress tells you about how many minutes are left.',
        'ja-JP': 'デバイス間ペアリングが拒否されると、タイムアウトまで「応答待ち」のままになることはなくなり、すぐに終了して理由と次にすることを表示します。待機中のペアリングは「リクエストを取り消す」で取り消せます。ペアリングの進行中にもう一度「ペアリング」を押すと、あと何分ほどかかるかを表示します。',
      },
      {
        'zh-TW': 'Windows 與 Linux：在 Windows 的終端機可以用 Ctrl+V 貼上，Windows 與 Linux 也可以用 Ctrl+Shift+V。在 Claude Code 這類自己處理滑鼠的程式裡按右鍵，不會再貼上兩次；要開 Navide 的複製／貼上選單，請按 Shift＋右鍵。設定 → 鍵盤快速鍵裡的應用程式選單按鍵，也改成顯示 Windows 與 Linux 實際使用的 Ctrl 組合鍵。',
        'en-US': 'Windows and Linux: Ctrl+V pastes in the terminal on Windows, and Ctrl+Shift+V pastes on Windows and Linux. Right-clicking inside a program that handles the mouse itself, such as Claude Code, no longer pastes twice; Shift+right-click opens Navide’s Copy/Paste menu. Settings → Keyboard Shortcuts now lists the application menu with the Ctrl keys Windows and Linux actually use.',
        'ja-JP': 'Windows と Linux：Windows のターミナルで Ctrl+V で貼り付けられるようになり、Windows と Linux では Ctrl+Shift+V でも貼り付けられます。Claude Code のようにマウスを自分で扱うプログラムで右クリックしても、二重に貼り付けられることはなくなりました。Navide のコピー／貼り付けメニューは Shift＋右クリックで開きます。設定 → キーボードショートカットのアプリケーションメニューも、Windows と Linux で実際に使う Ctrl の組み合わせで表示されます。',
      },
      {
        'zh-TW': '其他修正：開著多個工作區視窗時，結束到一半被取消，下次啟動不會少開視窗；原本在已拔除螢幕上的視窗會回到主螢幕。Git 面板和檔案總管的右鍵子選單靠近邊緣時會改往左或往下開，不再被切掉。分格標頭的頻道選單會把已連到其他視窗分格的聊天標成「已連接」，不能重複選。Navide 關閉期間到期的單次排程，重新啟動補跑時不會送出兩次。切換帳號的對話框在狀態文字很長時不再超出畫面，額度用完的帳號改用灰色顯示。設定的狀態徽章、鍵盤快速鍵和分析頁面的版面也整理過。',
        'en-US': 'Also fixed: with several workspace windows open, a quit that was cancelled part-way no longer leaves windows out of the next launch, and a window saved on a display that is no longer connected comes back on the main display. Right-click submenus in the Git panel and the file explorer open to the left or below near an edge instead of being cut off. The channel menu in a pane header marks a chat connected to a pane in another window as connected, so it cannot be picked twice. A one-time schedule that came due while Navide was closed is no longer sent twice when it is caught up after a restart. The account switch dialog no longer runs off screen when a status is long, and out-of-quota accounts are shown in grey. The status badges, keyboard shortcuts and analyzer pages in Settings are tidied up too.',
        'ja-JP': 'その他の修正：複数のワークスペースウィンドウを開いているときに終了が途中で取り消されても、次回の起動でウィンドウが欠けなくなりました。接続されていないディスプレイに保存されていたウィンドウはメインディスプレイに戻ります。Git パネルとファイルエクスプローラーの右クリックのサブメニューは、端に近いと左または下に開き、切れなくなりました。ペインのヘッダーのチャンネルメニューでは、別のウィンドウのペインに接続しているチャットが「接続中」と表示され、重ねて選べなくなりました。Navide を閉じている間に期限が来た一回限りのスケジュールが、再起動後の追い上げで二度送られることはなくなりました。アカウント切り替えのダイアログは長い状態表示で画面からはみ出さなくなり、使用量を使い切ったアカウントは灰色で表示されます。設定のステータスバッジ、キーボードショートカット、分析のページのレイアウトも整えました。',
      },
    ],
  },
  {
    version: '0.2.20',
    title: {
      'zh-TW': '看得見的便利功能、帳號登入自動修復、更可靠的跨裝置配對',
      'en-US': 'Convenience Features You Can See, Sign-in Auto-Repair, and Sturdier Cross-Device Pairing',
      'ja-JP': '見える便利機能、ログイン自動修復、より確かなデバイス間ペアリング',
    },
    highlights: [
      {
        'zh-TW': '新增「便利功能與 Navide 對你電腦的修改」（設定 → Agent 資產 → 擴充）：Navide 只在你允許的便利功能需要時，才會寫入自己資料夾以外的地方，例如 ~/.claude 或 ~/.codex。每次寫入都會在公告面板通知你，並在總覽留下紀錄與備份位置。每一項都能個別關閉，關閉時會先備份、再移除 Navide 加上去的內容；你自己刪掉的項目，Navide 不會再自動加回去，想要時按「重新允許」即可。升級前已經在用的功能維持開啟。',
        'en-US': 'New “Convenience features and what Navide changes on your computer” (Settings → Agent Assets → Extensions): Navide writes outside its own folder, such as ~/.claude or ~/.codex, only when a convenience feature you allowed needs it. Every write is announced in the Announcements panel and logged in the overview with where its backup is. Each feature can be turned off on its own; turning one off backs up first, then removes what Navide added. Anything you delete yourself is not added back — choose “Allow again” when you want it. Features you were already using stay on after the update.',
        'ja-JP': '「便利機能と Navide があなたのコンピューターに加えた変更」を追加しました（設定 → エージェント資産 → 拡張機能）。Navide は、許可された便利機能が必要とするときにだけ、~/.claude や ~/.codex など Navide のフォルダー外に書き込みます。書き込みは毎回お知らせパネルで通知され、一覧に記録とバックアップの場所が残ります。機能ごとにオフにでき、オフにするとバックアップを取ってから Navide が追加した内容を取り除きます。自分で削除したものは再び自動で追加されません。必要になったら「再度許可」を選んでください。アップデート前から使っていた機能はオンのままです。',
      },
      {
        'zh-TW': 'Navide 的 hook 改由分格自己帶著：Claude、Codex、Copilot 分格啟動時各自帶入 Navide 的 hook，不再寫進 ~/.claude/settings.json、~/.codex/config.toml 這類共用設定檔。舊版寫進去的項目，會在啟動時備份後收回並通知你，不會跑兩次。也因此，在 Navide 外直接開的 Claude 不再帶有 Navide 的 hook（包含 Navide Guard）。',
        'en-US': 'Navide’s hooks now travel with each pane: Claude, Codex and Copilot panes bring Navide’s hooks along when they start, instead of Navide writing them into shared files such as ~/.claude/settings.json or ~/.codex/config.toml. Entries an older version wrote there are backed up and taken back at startup, with a notice, so nothing runs twice. As a result, Claude started outside Navide no longer carries Navide’s hooks, Navide Guard included.',
        'ja-JP': 'Navide の hook はペインが持ち運ぶようになりました。Claude、Codex、Copilot のペインは起動時にそれぞれ Navide の hook を読み込み、~/.claude/settings.json や ~/.codex/config.toml などの共有設定ファイルには書き込みません。旧バージョンが書き込んだ項目は、起動時にバックアップしてから取り除き、お知らせで伝えるので、二重に動くことはありません。そのため、Navide の外で起動した Claude には Navide の hook（Navide Guard を含む）は付きません。',
      },
      {
        'zh-TW': '「帳號登入自動修復」預設開啟：切換帳號後如果 CLI 目前的登入不見了，Navide 會還原你選的帳號，避免分格啟動時變成未登入。如果你是在 Navide 外換成另一個帳號，Navide 不會蓋掉它，而是問你要「保留目前的登入」還是切回原帳號；在 Navide 外登出，Navide 只會告訴你，不會自動幫你登回。這一項可在便利功能總覽關閉，關閉後 Navide 完全不碰 CLI 目前的登入。另外，你在分格內完成的 Codex 登入，如果這台電腦還沒有 Codex 登入，會成為整台電腦的 Codex 登入（同樣可關閉）。',
        'en-US': '“Account sign-in auto-repair” is on by default: when a CLI’s live sign-in goes missing after an account switch, Navide restores the account you chose so panes do not start signed out. If you switched to another account outside Navide, Navide does not overwrite it — it asks whether to keep the current sign-in or switch back; if you signed out outside Navide, it tells you and does not sign you back in. Turn it off in the convenience overview and Navide leaves the CLI’s live sign-in alone entirely. Also, a Codex sign-in you make inside a pane becomes this computer’s Codex sign-in when there is none yet (this can be turned off too).',
        'ja-JP': '「アカウントのログイン自動修復」は既定でオンです。アカウント切り替え後に CLI の現在のログインが失われた場合、選んだアカウントを Navide が復元し、ペインが未ログインで起動しないようにします。Navide の外で別のアカウントに切り替えていた場合は上書きせず、今のログインを残すか元に戻すかを尋ねます。Navide の外でログアウトした場合は知らせるだけで、自動でログインし直すことはしません。便利機能の一覧でオフにすると、Navide は CLI の現在のログインに一切触れません。また、このコンピューターにまだ Codex のログインがない場合、ペイン内で行った Codex のログインがコンピューター全体の Codex のログインになります（これもオフにできます）。',
      },
      {
        'zh-TW': '新增「切換 Claude 帳號時，固定帳號的分格一起換」（設定 → 一般，預設關閉）：開啟後，切換 Claude 帳號時會列出還在用原帳號的分格，勾選的分格會改用新帳號重新開啟並接續原本的對話。原帳號和額度用完的分格會預先勾好，忙碌中的分格會等它做完，不會被打斷；額度用完的分格旁邊也會出現「換帳號 ›」按鈕。',
        'en-US': 'New “Move pinned panes along when switching Claude accounts” (Settings → General, off by default): when on, switching Claude accounts lists the panes still on their own account, and the ones you tick reopen on the new account and pick up their conversation. Panes on the old account and panes out of quota come pre-ticked, a busy pane is waited for rather than interrupted, and a pane out of quota gets a “Switch account ›” button.',
        'ja-JP': '「Claude アカウントの切り替え時に、固定したペインも一緒に切り替える」を追加しました（設定 → 一般、既定はオフ）。オンにすると、Claude アカウントを切り替えるときに元のアカウントのままのペインが一覧に並び、チェックしたペインは新しいアカウントで開き直して会話を再開します。元のアカウントのペインと使用量を使い切ったペインはあらかじめチェックされ、作業中のペインは中断せず終わるまで待ちます。使用量を使い切ったペインには「アカウントを切り替え ›」ボタンが表示されます。',
      },
      {
        'zh-TW': '跨裝置配對更可靠：配對紀錄改存成這台電腦上的加密檔，不再受 macOS 鑰匙圈長度限制，重新啟動後也不會再壞掉，可配對的裝置數也不再只有十幾台。從 0.2.19 升級時會自動搬過去，配對都保留，不需要在每台電腦重建或重新配對。只有少數 Mac 的紀錄在 0.2.19 已經存壞：如果帳號視窗的「需要你處理」出現「從受損的配對紀錄中救回」，比對指紋後按「核准」就好；如果顯示「Navide Cloud 已停止」、配對資料損毀，請按「重新開始」→「確定，清除並重新開始」，再從兩端重新配對其他裝置。',
        'en-US': 'Sturdier cross-device pairing: the pairing record is now an encrypted file on this computer, so it no longer outgrows the macOS Keychain, no longer breaks after a restart, and is no longer capped at a dozen or so devices. Updating from 0.2.19 moves it over automatically with every pairing kept — there is nothing to rebuild or re-pair on each computer. Only a few Macs whose record 0.2.19 had already saved cut off need a step: if “Needs you” in the account window shows a device “recovered from a damaged pairing record”, compare the fingerprint and choose Approve; if it says Navide Cloud is stopped because the pairing record is damaged, choose “Start over” → “Yes, erase and start over”, then pair each other device again from both ends.',
        'ja-JP': 'デバイス間ペアリングがより確かになりました。ペアリング記録はこのコンピューター上の暗号化ファイルになり、macOS のキーチェーンの長さ制限を超えたり再起動後に壊れたりすることはなくなり、ペアリングできるデバイス数の十数台という上限もなくなりました。0.2.19 からのアップデートでは自動で移行され、ペアリングはすべて残るので、各コンピューターで作り直したりペアリングし直したりする必要はありません。0.2.19 の時点ですでに記録が途中で切れて保存されていた一部の Mac だけ操作が必要です。アカウント画面の「確認が必要」に「破損したペアリング記録から復元しました」と出たら、フィンガープリントを照合して「承認」を選んでください。ペアリング記録が破損して Navide Cloud が止まっていると表示された場合は、「最初からやり直す」→「はい、消去してやり直す」を選び、ほかのデバイスと両側からペアリングし直してください。',
      },
      {
        'zh-TW': 'Navide Cloud：伺服器支援時，「設定 → Navide Cloud」會分成「同步／分享／裝置」，你可以在 Plans 按「分享連結」把計畫或報告分享成唯讀連結（在這台電腦加密，金鑰只在連結裡），並在「分享」分頁複製、延長、換新或撤銷；伺服器還不支援時，畫面和 0.2.19 一樣。同步多了「版本記錄」，可以還原到上一版。登出時會一併撤銷這台裝置在伺服器上的登入；被其他裝置撤銷或密碼變更時，會告訴你原因。',
        'en-US': 'Navide Cloud: when the server supports it, Settings → Navide Cloud splits into Sync / Share / Devices, the Plans view’s “Share link” turns a plan or report into a read-only link (encrypted on this computer, with the key only in the link), and the Share tab lets you copy, extend, renew or revoke links; until then the page is the same as in 0.2.19. Sync gains a Version history that can restore the previous version. Signing out also revokes this device’s sign-in on the server, and a session ended from another device or by a password change tells you why.',
        'ja-JP': 'Navide Cloud：サーバーが対応している場合、「設定 → Navide Cloud」が「同期／共有／デバイス」に分かれます。Plans の「共有リンク」で計画やレポートを読み取り専用のリンクにでき（このコンピューターで暗号化し、鍵はリンクの中だけ）、「共有」タブでコピー・延長・新しいリンクへの切り替え・取り消しができます。サーバーがまだ対応していないときは 0.2.19 と同じ画面です。同期には「バージョン履歴」が加わり、前のバージョンに戻せます。ログアウトするとサーバー上のこのデバイスのログインも取り消され、別のデバイスからの取り消しやパスワード変更でセッションが終わったときは理由が表示されます。',
      },
      {
        'zh-TW': '傳給剛接續對話的分格的訊息，會等 CLI 真的啟動後才送，不會再被吃掉或誤報已送達；送出但無法確認的訊息會標成「未確認」，不提供重送，以免同一件事做兩次。設定側欄也重新整理：「憑證與金鑰」和「擴充」移到「Agent 資產」，「Navide 外掛」與「Navide 市集」有了自己的分組。',
        'en-US': 'Messages to a pane that is just resuming its conversation now wait until the CLI has really started, so they are no longer lost or reported delivered when they were not; one that went out but could not be confirmed is marked unconfirmed, without Resend, so the work does not run twice. The Settings sidebar is regrouped too: Credentials & keys and Extensions move under Agent Assets, and Navide Plugins and Navide Marketplace get their own group.',
        'ja-JP': '会話を再開したばかりのペインへのメッセージは、CLI が実際に起動するまで待ってから送るようになり、消えたり、届いていないのに配信済みと表示されたりしなくなりました。送信したものの確認できなかったメッセージは「未確認」と表示され、同じ作業が二重に走らないよう再送ボタンは出ません。設定のサイドバーも整理し、「認証情報とキー」と「拡張機能」は「エージェント資産」へ移り、「Navide プラグイン」と「Navide マーケットプレイス」は独自のグループになりました。',
      },
    ],
  },
  {
    version: '0.2.19',
    title: {
      'zh-TW': 'CLI 擴充一覽、不再遺失的最近工作區、資源限制',
      'en-US': 'CLI Extensions at a Glance, a Recent List That Keeps Everything, and Resource Limits',
      'ja-JP': 'CLI 拡張の一覧、消えなくなった最近のワークスペース、リソース制限',
    },
    highlights: [
      {
        'zh-TW': '新增「設定 → CLI 擴充」：列出每個 AI CLI 自己安裝的 CLI 擴充——Claude plugin 與 Claude mod、Codex plugin 與 hook，還有 Copilot、Droid、Cursor、Qwen、opencode、Kilo、Pi 等——以及每一項的執行等級（文字資產、子程序，或在 CLI 程序內執行的程式碼）、能碰到什麼（執行指令、連網、攔截工具呼叫……），還有 CLI 執行前會不會先詢問。Navide 自己裝的 hook 會特別標出。這一頁只讀，不會安裝、啟用或修改任何東西；agent 也能用 cli_extensions_list 查詢名稱與中繼資料。',
        'en-US': 'New Settings → CLI Extensions lists the CLI extensions each AI CLI installed for itself — Claude plugins and mods, Codex plugins and hooks, plus Copilot, Droid, Cursor, Qwen, opencode, Kilo, Pi and more — with each one’s execution tier (text assets, a subprocess, or code running inside the CLI’s own process), what it can reach (running commands, the network, intercepting tool calls…), and whether the CLI asks before running it. Hooks Navide installed are marked. The page only reads: it never installs, enables or changes anything. Agents can query the names and metadata with cli_extensions_list.',
        'ja-JP': '「設定 → CLI 拡張」を追加しました。各 AI CLI が自分でインストールした CLI 拡張（Claude の plugin と mod、Codex の plugin と hook、さらに Copilot、Droid、Cursor、Qwen、opencode、Kilo、Pi など）を一覧にし、それぞれの実行レベル（テキスト資産、サブプロセス、CLI のプロセス内で動くコード）、触れられる範囲（コマンド実行、ネットワーク、ツール呼び出しへの介入など）、CLI が実行前に確認するかどうかを示します。Navide がインストールした hook には印が付きます。このページは読み取るだけで、インストール・有効化・変更は行いません。エージェントも cli_extensions_list で名前とメタデータを照会できます。',
      },
      {
        'zh-TW': '名稱整理：Navide 自己的外掛一律叫「Navide 外掛」，上架的地方叫「Navide 市集」，跟各家 CLI 自己的 CLI 擴充分開。設定側欄的「整合」改名為「Agent 資產」（MCP、技能、Prompt 技能、記憶），「憑證與金鑰」移到「帳號與代理」，「Navide 外掛」與「Navide 市集」移到「系統」。用舊名稱搜尋設定也找得到。',
        'en-US': 'Clearer names: Navide’s own plugins are now always “Navide plugins”, published in the “Navide Marketplace”, and kept apart from each AI CLI’s own CLI extensions. In the Settings sidebar, Integrations is now Agent Assets (MCP, skills, prompts, memory), Credentials & keys moved to Accounts & Agents, and Navide Plugins and Navide Marketplace moved to System. Searching Settings by the old names still finds them.',
        'ja-JP': '名称を整理しました。Navide 自身のプラグインは「Navide プラグイン」、公開の場は「Navide マーケットプレイス」に統一し、各 AI CLI の CLI 拡張と区別します。設定のサイドバーでは「連携」が「エージェント資産」（MCP、スキル、プロンプト、メモリ）になり、「認証情報とキー」は「アカウントとエージェント」へ、「Navide プラグイン」と「Navide マーケットプレイス」は「システム」へ移りました。旧名称で設定を検索しても見つかります。',
      },
      {
        'zh-TW': '「最近」的工作區會一直保留到你自己移除，不會再只留 20 筆、把天天在用的專案擠掉。已開啟與已釘選的排在最上面，其他每次顯示 10 筆、按「顯示更多」看下去，搜尋框會找遍全部紀錄；找不到的資料夾會標示出來但不會消失。保留上限在「設定 → 一般」調整，預設 1000 筆，也可以不設上限，已開啟與已釘選的永遠不會被移除。',
        'en-US': 'Recent now keeps every workspace until you remove it, instead of keeping 20 and pushing out the projects you use every day. Open and pinned workspaces sit on top, the rest show ten at a time with "show more", and the search box looks through the whole history; folders that are missing are marked, not dropped. Set the limit in Settings → General: 1000 by default, or none, and open or pinned workspaces are never removed.',
        'ja-JP': '「最近」のワークスペースは、自分で削除するまで残るようになりました。20 件までしか残らず、毎日使うプロジェクトが押し出されることはもうありません。開いているものとピン留めしたものが上にまとまり、残りは 10 件ずつ「さらに表示」で見られ、検索ボックスは全履歴を探します。見つからないフォルダーは印が付くだけで消えません。上限は「設定 → 一般」で変更でき、既定は 1000 件、上限なしも選べます。開いているものとピン留めしたものは削除されません。',
      },
      {
        'zh-TW': '新增「設定 → 一般 → 資源限制」，每一項在你調整前都維持原本的行為：限制新分格跑測試時的 worker 數、列出已關閉的分格留下還在跑的伺服器並一鍵停止、讓聚焦中但好幾小時沒動的分格也被回收（點一下就能接續）、自我優化逾時後過一段時間收掉它的分格；macOS 上還能直接打開 Spotlight 的隱私權設定，把建置輸出排除在索引外。',
        'en-US': 'New Settings → General → Resource limits, each leaving things as they were until you change it: cap the test workers new panes use, list servers that closed panes left running and stop one with a click, let a focused pane untouched for hours be reclaimed too (one click resumes it), and reclaim a timed-out self-evolution run’s pane after a grace period. On macOS a button opens Spotlight’s privacy settings so you can keep build output out of the index.',
        'ja-JP': '「設定 → 一般 → リソース制限」を追加しました。どの項目も変更するまでは従来どおりです。新しいペインのテスト worker 数の上限、閉じたペインが残したまま動いているサーバーの一覧とワンクリック停止、フォーカス中でも何時間も操作のないペインの回収（クリックで再開）、タイムアウトした自己改善のペインを猶予後に回収。macOS では Spotlight のプライバシー設定を開くボタンから、ビルド出力をインデックスの対象外にできます。',
      },
      {
        'zh-TW': '關掉的分格不會再留下還在跑的 CLI 程序：結束失敗會被察覺並補清，重新接回的分格也找得到原本的程序，關閉 Navide 時讓 Claude 有時間正常結束，逾時的指令會連同子程序一起停止；App 關閉期間錯過的排程，補跑時不會再重複執行兩次。分格上的聊天室標籤改顯示綁定的聊天室名稱；工作區標題上的 ✦ 徽章只顯示狀態，設定改從標題的「⋯」選單或右鍵選單打開。',
        'en-US': 'Closed panes no longer leave CLI processes running: a failed kill is noticed and cleaned up, a reattached pane’s processes are still found, quitting Navide gives Claude time to shut down cleanly, and a timed-out command stops along with its children; a schedule that missed runs while the app was closed no longer fires twice when it catches up. The chat chip on a pane now shows the bound chat’s name, and the ✦ badge on a workspace heading only shows status; open its settings from the heading’s ⋯ menu or right-click menu.',
        'ja-JP': '閉じたペインが CLI のプロセスを残さなくなりました。終了の失敗を検知して後片付けし、再接続したペインのプロセスも見つけ、Navide の終了時は Claude が正常に終了する時間を確保し、タイムアウトしたコマンドは子プロセスごと止めます。アプリを閉じている間に実行されなかったスケジュールが、後から追いつくときに 2 回実行されることもなくなりました。ペインのチャットのラベルには紐づいたチャットの名前が表示されます。ワークスペース見出しの ✦ バッジは状態の表示だけになり、設定は見出しの「⋯」メニューか右クリックメニューから開きます。',
      },
      {
        'zh-TW': '更安全：Navide 不會再覆寫讀不懂的 Claude settings.json、不會再把檔案搬進你的家目錄、不會再讓 Codex 的 config.toml 越長越大、不會把你自己的 Cursor 技能藏起來不讓 git 看到、搬移舊資料時會保留真正的對話紀錄檔，也補上 Cursor 技能清單的路徑漏洞；從分格裡啟動 Navide 時，也不會再把你的家目錄誤當成專案（技能與 MCP 設定都已修正）。',
        'en-US': 'Safer: Navide no longer overwrites a Claude settings.json it cannot read, no longer moves files into your home folder, stops growing Codex’s config.toml, no longer hides your own Cursor skills from git, keeps the real session file when migrating old data, and closes a path issue in the Cursor skills manifest. When Navide is started from inside a pane, it no longer mistakes your home folder for a project (fixed in skills and MCP wiring).',
        'ja-JP': 'より安全に：Navide は読み取れない Claude の settings.json を上書きしなくなり、ホームフォルダーにファイルを移動しなくなり、Codex の config.toml が増え続けることもなくなりました。自分の Cursor スキルを git から隠すこともなく、古いデータの移行時は本来のセッションファイルを残し、Cursor スキルの一覧ファイルのパスの問題も修正しました。ペインの中から Navide を起動しても、ホームフォルダーをプロジェクトと取り違えなくなりました（スキルと MCP の設定の両方を修正）。',
      },
      {
        'zh-TW': 'Navide 的程式碼庫搬到 GitHub 的 Navide-dev/Navide，更新的備援來源與「說明」選單的連結都已指向新位置，更新仍優先走下載鏡像。Plans 的圖表改用 mermaid 12，版面與配色維持原樣；Electron、fastapi、anthropic、websockets 等相依套件也一併更新。',
        'en-US': 'Navide’s repository moved to Navide-dev/Navide on GitHub; the update fallback and the Help menu’s links point there, and updates still come from the download mirror first. Plans diagrams now use mermaid 12 with the same layout and colours, and Electron, fastapi, anthropic, websockets and other dependencies are updated.',
        'ja-JP': 'Navide のリポジトリは GitHub の Navide-dev/Navide に移りました。アップデートの予備の取得先と「ヘルプ」メニューのリンクは新しい場所を指し、アップデートは引き続きダウンロードミラーを優先します。Plans の図は mermaid 12 になり、レイアウトと配色はそのままです。Electron、fastapi、anthropic、websockets などの依存関係も更新しました。',
      },
    ],
  },
  {
    version: '0.2.18',
    title: {
      'zh-TW': '雲端同步先經你核准、聊天室報告卡與 PDF、Windows 修正',
      'en-US': 'Cloud Sync You Approve, Report Cards and PDFs in Chats, and Windows Fixes',
      'ja-JP': 'クラウド同期は承認してから反映、チャットのレポートカードと PDF、Windows の修正',
    },
    highlights: [
      {
        'zh-TW': '其他裝置同步過來、會在這台電腦執行的內容——新的或有變更的 MCP server、skill、prompt——會先暫停，在「設定 → 同步」列出完整內容（指令、參數、檔案、哪些可執行、改了什麼），你核准後才寫入；大型 skill 會先下載到隔離區給你檢視。匯入設定包的預覽也會完整顯示每一項。',
        'en-US': 'What another device syncs that would run on this computer — a new or changed MCP server, skill or prompt — now waits in Settings → Sync, shown in full (command, args, files, which are executable, what changed), and lands only once you approve it. A large skill is downloaded into a holding area for you to review first. A settings-bundle import previews every item in full too.',
        'ja-JP': '別のデバイスから同期され、このコンピューターで実行される内容（新規または変更された MCP サーバー・スキル・プロンプト）は、いったん保留され、「設定 → 同期」に全内容（コマンド、引数、ファイル、実行可能なもの、変更点）が表示されます。承認してはじめて反映されます。大きなスキルは先に隔離領域へダウンロードして確認できます。設定パックの取り込みプレビューも各項目を全文表示します。',
      },
      {
        'zh-TW': '同步更安全：舊版紀錄被重送時不會把項目倒回舊版；prompt 與 MCP 參數看起來含有密鑰時會告訴你在哪裡（不顯示內容、不阻擋）；同步區會顯示正在同步的帳號，「立即同步」後列出每一類的結果，存檔後也會自動上傳。記憶（CLAUDE.md 等指示檔）不再雲端同步，本機與雲端既有的檔案都不會被動到。',
        'en-US': 'Safer sync: a replayed older record can no longer roll an item back; prompts and MCP args that look like they hold a secret are flagged with where, never what, and nothing is blocked; the Sync section names the account it syncs with, lists each scope’s result after Sync now, and sends a save up shortly after you make it. Memory (CLAUDE.md and other instruction files) is no longer synced; local files and copies already in the cloud are left as they are.',
        'ja-JP': '同期がより安全に：古い記録が再送されても項目が古い版に戻らなくなりました。プロンプトや MCP の引数に秘密情報らしきものがあると、場所だけを知らせます（内容は表示せず、ブロックもしません）。同期セクションには同期先のアカウントが表示され、「今すぐ同期」の後に種類ごとの結果が並び、保存した変更も自動でアップロードされます。メモリ（CLAUDE.md などの指示ファイル）はクラウド同期の対象外になりました。ローカルのファイルとクラウド上の既存のコピーはそのまま残ります。',
      },
      {
        'zh-TW': '新增「設定 → 憑證與金鑰」：掃描這台電腦的 git 憑證來源、gh／glab 帳號、SSH 金鑰與鑰匙圈項目，標出 remote URL 內含 token、金鑰沒有 passphrase、token 以明文存放這類風險。它不顯示任何值，也不修改任何東西；在安全的情況下會附上可複製的修正指令。agent 也能透過 MCP 查詢名稱與發現項目。',
        'en-US': 'New Settings → Credentials & keys scans this computer’s git credential sources, gh and glab accounts, SSH keys and keychain items, and flags risks such as a token inside a remote URL, a key without a passphrase, or a token kept in plain text. It never shows a value and never changes anything; where it is safe, a finding comes with a fix command you can copy. Agents can query the names and findings over MCP.',
        'ja-JP': '「設定 → 認証情報とキー」を追加しました。このコンピューターの git 認証情報の取得元、gh／glab のアカウント、SSH キー、キーチェーンの項目をスキャンし、remote URL に含まれたトークン、パスフレーズのないキー、平文で保存されたトークンといったリスクを示します。値は一切表示せず、何も変更しません。安全な場合は、コピーして使える修正コマンドを添えます。エージェントも MCP で名前と検出項目を照会できます。',
      },
      {
        'zh-TW': '聊天室：分格傳出的 HTML 檔會轉成 A4 PDF，每個附件都附上一張報告卡（標題與一句摘要），你回覆報告卡時分格會知道你指的是哪份報告；很長的回覆改成一則預覽加上完整內容的 Markdown 檔。「設定 → Channels」會列出每個 bot 的聊天室與綁定的分格，可以跳過去、多選解除綁定、清掉分格已不存在的綁定。',
        'en-US': 'Chats: an HTML file a pane sends arrives as an A4 PDF, every attachment comes with a report card (a title and a one-line summary), and replying to a card tells the pane which report you mean. A very long reply arrives as one preview plus the whole text as a Markdown file. Settings → Channels lists each bot’s chats and bound panes, so you can jump to a pane, unbind several at once, and clear bindings whose pane is gone.',
        'ja-JP': 'チャット：ペインが送る HTML ファイルは A4 の PDF になり、すべての添付にレポートカード（タイトルと一行の要約）が付きます。カードに返信すると、どのレポートの話かがペインに伝わります。長い返信は 1 件のプレビューと全文の Markdown ファイルで届きます。「設定 → Channels」では bot ごとにチャットと紐づいたペインが一覧でき、ペインへの移動、まとめての紐づけ解除、ペインがなくなった紐づけの削除ができます。',
      },
      {
        'zh-TW': '分格現在可以把工作區外的檔案、隱藏檔，以及你拖進 Navide 的檔案傳回聊天室；但 ~/.ssh、~/.aws、GitHub CLI、GnuPG、Kubernetes、Docker、鑰匙圈、各 CLI 的登入檔與 Navide 自己的資料，在每個平台上都一律不傳。',
        'en-US': 'A pane can now send files from outside its workspace, hidden files, and files you dragged into Navide; ~/.ssh, ~/.aws, the GitHub CLI, GnuPG, Kubernetes, Docker, keyrings, the CLIs’ sign-in files and Navide’s own data are still never sent, on every platform.',
        'ja-JP': 'ペインはワークスペース外のファイル、隠しファイル、Navide にドラッグしたファイルもチャットへ送れるようになりました。ただし ~/.ssh、~/.aws、GitHub CLI、GnuPG、Kubernetes、Docker、キーリング、各 CLI のログインファイル、Navide 自身のデータは、どのプラットフォームでも送りません。',
      },
      {
        'zh-TW': '給 agent：開啟工作區會等新視窗準備好再回報，視窗還沒好時開分格會立刻告知而不是卡住，「~/」路徑也會展開；新增 cli_reclaim_agent 收掉已完成的分格。排程執行的自我優化不會再停下來問問題，閒置太久會被提醒並一定回報。開分格時的記憶體提醒只計算真的在執行的分格。分格一輪結束後，cli_get_status 會正確回報已完成，不會再停在進行中；排隊的訊息也不會因此多等最多 2 分鐘。',
        'en-US': 'For agents: opening a workspace waits until its window is ready, opening a pane before then says so at once instead of hanging, and a "~/" path is expanded; cli_reclaim_agent releases a finished pane. Scheduled self-evolution runs no longer stop to ask a question, are nudged when idle too long and always report back. The memory advisory when opening a pane counts only panes that are actually running. Once a pane finishes a turn, cli_get_status now reports it as finished instead of leaving it in progress, and queued messages no longer wait up to 2 minutes extra because of it.',
        'ja-JP': 'エージェント向け：ワークスペースを開くとウィンドウの準備ができるまで待ってから応答し、準備前にペインを開こうとするとすぐにそう伝えて止まらなくなりました。「~/」のパスも展開されます。完了したペインを片付ける cli_reclaim_agent を追加しました。スケジュール実行の自己改善は質問で止まらなくなり、長く停止すると促され、必ず報告します。ペインを開くときのメモリの注意は、実際に動いているペインだけを数えます。ペインのターンが終わると cli_get_status は正しく完了と報告し、実行中のままにならなくなりました。そのせいでキュー内のメッセージが最大 2 分余計に待つこともなくなりました。',
      },
      {
        'zh-TW': '被「…」截斷的文字，滑鼠移上去就能看到完整內容。Windows：同步來的 skill 不能再透過磁碟機路徑、替代資料流或裝置名稱把檔案寫到 skill 以外的地方，「~」開頭的工作區路徑也能正確對應。',
        'en-US': 'Text cut off with "…" shows in full on hover. Windows: a synced skill can no longer place files outside itself through drive paths, alternate data streams or device names, and a workspace path starting with "~" now matches the same folder.',
        'ja-JP': '「…」で切れた文字は、マウスを重ねると全文が表示されます。Windows：同期されたスキルが、ドライブパス・代替データストリーム・デバイス名を使ってスキル外にファイルを書き込めなくなりました。「~」で始まるワークスペースのパスも正しく同じフォルダーを指します。',
      },
    ],
  },
  {
    version: '0.2.17',
    title: {
      'zh-TW': '修正後端自行停止、畫面卡在「connecting…」',
      'en-US': 'Fixes for a Backend That Stopped Itself and a Window Stuck on "connecting…"',
      'ja-JP': 'バックエンドが自ら停止し、画面が「connecting…」のまま止まる問題を修正',
    },
    highlights: [
      {
        'zh-TW': '電腦很忙、分格很多時，後端偶爾會誤以為 Navide 已經關閉而自行停止，畫面就一直停在「connecting…」。現在查不到 Navide 時只會略過這一次檢查，不會再自行停止。',
        'en-US': 'With a busy machine and many panes, the backend could mistake a momentary lookup failure for Navide having quit and stop itself, leaving the window on "connecting…". A failed lookup is now skipped, never taken as Navide being gone.',
        'ja-JP': 'マシンが混雑しペインが多いとき、バックエンドが一時的な確認の失敗を Navide の終了と取り違えて自ら停止し、画面が「connecting…」のままになることがありました。確認に失敗しても今回は見送るだけになり、停止しなくなりました。',
      },
      {
        'zh-TW': '後端關閉時最多等 3 秒，不會再被分格掛著的連線卡住；視窗連續重連 3 次失敗後，會向 Navide 確認後端是否換了位置並改連過去。',
        'en-US': 'The backend now waits at most 3 seconds to shut down, so connections held open by panes can no longer keep it hanging, and after 3 failed reconnects the window asks Navide where the backend is now and follows it.',
        'ja-JP': 'バックエンドの終了待ちは最大 3 秒になり、ペインが保持する接続で止まらなくなりました。再接続に 3 回失敗すると、ウィンドウが Navide にバックエンドの現在の場所を確認して接続し直します。',
      },
      {
        'zh-TW': '後端的啟動、當掉、自動重啟都會寫進 main.log，方便追查；側欄工作區標題上的自我優化徽章縮小成只顯示 ✦，狀態用顏色區分，滑鼠移上去看說明。',
        'en-US': 'Backend start, crash and automatic restarts are now written to main.log for troubleshooting, and the self-evolution badge on a sidebar workspace heading is just ✦, coloured by state, with the details on hover.',
        'ja-JP': 'バックエンドの起動・クラッシュ・自動再起動が main.log に記録されるようになりました。サイドバーのワークスペース見出しにある自己進化バッジは ✦ だけになり、状態は色で示し、詳細はマウスを重ねると表示されます。',
      },
    ],
  },
  {
    version: '0.2.16',
    title: {
      'zh-TW': 'Pipeline 畫布編輯器、在聊天室收發檔案、重開後自動接回工作中的分格',
      'en-US': 'A Pipeline Canvas Editor, Files in Chats, and Panes That Pick Up Where They Left Off',
      'ja-JP': 'Pipeline キャンバスエディター、チャットでのファイル送受信、再起動後に作業中のペインを自動で再開',
    },
    highlights: [
      {
        'zh-TW': 'Pipeline Manager 改成整個視窗的工作區，每條 pipeline 都能用泳道或自由畫布編輯：把角色拖進同一欄並行、拖到新欄接續，加入核准關卡、設定退回重做的迴圈與次數上限，釘住某一步沿用上次的產出，或從任一步重跑。執行中每個檢視都會顯示進度，有關卡在等你核准時會提示，按「前往核准」直接過去。角色分頁也能編輯這個角色在步驟裡顯示的設定欄位。',
        'en-US': 'The Pipeline Manager is now a full-window workspace where every pipeline can be edited as swimlanes or on a free canvas: drag roles into a column to run them side by side or into a new one to follow on, add approval gates, set a reject loop and how many times it may retry, pin a step to reuse its last output, or rerun from any step. A running pipeline shows its progress in every view, and a gate waiting on you is flagged with a direct Review. The Roles tab can now edit the settings fields a role shows in a step.',
        'ja-JP': 'Pipeline Manager がウィンドウ全体のワークスペースになり、各パイプラインをスイムレーンまたは自由なキャンバスで編集できます。ロールを同じ列にドラッグすると並列に、新しい列にドラッグすると順番に実行され、承認ゲートの追加、差し戻しループと再試行回数の設定、ステップを固定して前回の出力を再利用、任意のステップからの再実行ができます。実行中はどの表示でも進捗が見え、承認待ちのゲートがあると知らせて「確認する」で直接移動できます。ロールタブでは、ステップに表示される設定項目も編集できます。',
      },
      {
        'zh-TW': '聊天室可以傳檔案了：在 Telegram、Discord、Slack 傳給分格的檔案與圖片會先下載，分格會知道檔案放在哪裡；分格回覆時也能把檔案傳回聊天室，但只限工作區內或剛收到的檔案，不會送出隱藏檔與金鑰。單檔上限 20 MB；其他平台會回覆「此平台尚不支援媒體」，文字照常送達。在 Telegram、Discord 用「回覆」某則訊息時，分格也會看到被回覆的原文（只引用你信任的發言者）。',
        'en-US': 'Chats can carry files: files and pictures sent to a pane from Telegram, Discord or Slack are downloaded first and the pane is told where they are, and a pane can send files back in its reply, limited to its workspace or the files it just received, never hidden files or keys. Each file can be up to 20 MB; other platforms reply that media is not supported yet and still deliver the text. Replying to a message in Telegram or Discord now shows the pane the message you replied to, quoted only from senders you trust.',
        'ja-JP': 'チャットでファイルを送受信できるようになりました。Telegram・Discord・Slack からペインに送ったファイルや画像は先にダウンロードされ、保存場所がペインに伝わります。ペインも返信でファイルを送り返せますが、ワークスペース内のファイルか受け取ったファイルに限られ、隠しファイルや鍵は送りません。1 ファイル 20 MB まで。その他のプラットフォームでは「このプラットフォームはまだメディアに対応していません」と返し、テキストは通常どおり届きます。Telegram と Discord で特定のメッセージに「返信」すると、返信元の原文もペインに届きます（信頼する送信者のみ引用）。',
      },
      {
        'zh-TW': '重開 Navide 後，原本正在跑回合、或停在權限詢問與提問上的分格，以及等它們回報的母分格，會自動接回（最多 6 個）。接回後不會自己繼續，要按「繼續」或由母分格下令；母分格會收到哪些子分格被中斷的通知。沒接回的會標示「重開時工作中」，點一下就能接回。不想要可以在「設定 → 一般」關閉。',
        'en-US': 'After Navide restarts, panes that were running a turn or waiting on a permission prompt or a question, plus the parent panes waiting on their reports, come back by themselves (up to 6). None of them continues on its own: press Continue or let the parent say so, and each parent is told which of its panes were interrupted. Panes left closed are marked "Working at restart" and resume with a click. Turn this off in Settings → General.',
        'ja-JP': 'Navide を再起動すると、ターンの実行中や権限の確認・質問で待っていたペインと、その報告を待つ親ペインが自動で戻ります（最大 6 個）。戻ったペインが勝手に続きを始めることはなく、「続行」を押すか親ペインの指示で再開します。親ペインには、どの子ペインが中断されたかが通知されます。戻らなかったペインには「再起動時に作業中」と表示され、クリックで再開できます。「設定 → 一般」でオフにできます。',
      },
      {
        'zh-TW': 'Claude 帳號可以各自在自己的設定資料夾登入一次，不同分格就能同時用不同帳號：從額度徽章選新分格要用的帳號，或按「繼續」把單一個分格換到另一個帳號接著對話，其他分格不受影響；這些帳號的額度也能各自讀取。登入過期時新分格會改用目前的帳號並提示重新登入；刪除帳號會一併清掉它的登入，還有分格在用時會先擋下並告訴你幾個。',
        'en-US': 'Each Claude account can sign in once inside its own settings folder, so different panes can run on different accounts at the same time: pick the account new panes start on from the quota badge, or press Continue to move one pane onto another account and carry on its conversation, leaving the rest alone. These accounts each get their own quota reading. When such a login expires, new panes fall back to the current account and you are offered to sign in again; deleting an account removes its login too, and is held back, with a count, while panes still use it.',
        'ja-JP': 'Claude アカウントごとに専用の設定フォルダーで一度ログインしておくと、ペインごとに別のアカウントを同時に使えます。クォータバッジで新しいペインが使うアカウントを選ぶか、「続行」で 1 つのペインだけを別のアカウントに移して会話を続けられ、ほかのペインには影響しません。これらのアカウントはそれぞれのクォータも読み取れます。ログインが期限切れになると新しいペインは現在のアカウントに戻り、再ログインを案内します。アカウントを削除するとそのログインも消え、まだ使っているペインがある間は件数を示して削除を止めます。',
      },
      {
        'zh-TW': '新增工作區「自我優化」（預設關閉）：從側欄工作區標題的徽章開啟面板並啟用後，Navide 每天依你設定的時間開一個分格檢查這個 repo，在獨立的 worktree 修正小錯誤、逐一 commit 回本機主分支（不會 push），新功能與取捨則寫成提案；每天次數、時間與 token 預算都有上限，每一步都會通知你。',
        'en-US': 'New per-workspace Self-evolution, off by default: open its panel from the badge on the workspace heading in the sidebar and turn it on, and at the time you choose each day Navide opens a pane that checks the repository, fixes small bugs in a separate worktree and commits each fix to the local main branch (never pushing), and writes new features and trade-offs up as proposals instead. Runs per day, time and token budget are all capped, and you are told about every step.',
        'ja-JP': 'ワークスペースごとの「自己改善」を追加しました（既定はオフ）。サイドバーのワークスペース見出しのバッジからパネルを開いて有効にすると、毎日指定した時刻に Navide がペインを開いてリポジトリを確認し、小さなバグを別の worktree で修正して 1 件ずつローカルのメインブランチにコミットします（push はしません）。新機能や判断が必要なものは提案として残します。1 日の回数・時間・トークン予算には上限があり、各ステップは通知されます。',
      },
      {
        'zh-TW': '給 agent 的新能力：agent 可以替其他分格回答權限詢問與選單（高風險的仍由 Navide Guard 擋下，每次回答都會記錄）、在工作完成後收掉子分格，從 agent 開啟工作區也不再逾時。',
        'en-US': 'For agents: an agent can now answer another pane’s permission prompt or menu (Navide Guard still blocks high-risk ones, and every answer is recorded), release its finished child panes, and opening a workspace from an agent no longer times out.',
        'ja-JP': 'エージェント向け：エージェントがほかのペインの権限確認やメニューに回答できるようになりました（高リスクのものは引き続き Navide Guard がブロックし、回答はすべて記録されます）。作業が終わった子ペインの片付けもでき、エージェントからワークスペースを開いてもタイムアウトしなくなりました。',
      },
      {
        'zh-TW': '其他：主視窗畫面意外掛掉時會自動重新載入並接回分格，不再留下一片空白、分格最後被清掉；分頁標籤顯示「執行中／總數」；重開不再把其他工作區的分頁群組塞進目前的工作區；「設定 → Prompt 技能」可以拖曳排序 skill；送到另一台裝置的訊息一定會回報結果，不再一直停在排隊中；Windows 上不再重建已經正確的共用連結。',
        'en-US': 'Also: a main window whose page crashes reloads itself and reconnects its panes, instead of staying blank until the panes are cleared; stage tabs show running / total panes; a restart no longer files other workspaces’ tab groups into the one on screen; skills can be dragged into order in Settings → Prompts; a message sent to another device always reports how it ended instead of sitting on queued; and Windows no longer rebuilds shared links that are already correct.',
        'ja-JP': 'そのほか：メインウィンドウの画面が予期せず落ちても自動で再読み込みしてペインに再接続し、真っ白なままペインが消えることはなくなりました。タブに「実行中 / 合計」のペイン数を表示します。再起動時にほかのワークスペースのタブグループが表示中のワークスペースに入り込まなくなりました。「設定 → プロンプト」でスキルをドラッグして並べ替えられます。別のデバイスに送ったメッセージは必ず結果が返り、「待機中」のまま止まらなくなりました。Windows で正しく張られている共有リンクを作り直さなくなりました。',
      },
    ],
  },
  {
    version: '0.2.15',
    title: {
      'zh-TW': '首次使用導覽、一鍵建立 Telegram bot、內嵌 AI 面板成為正式分格',
      'en-US': 'A First-Run Tour, One-Step Telegram Bots, and Embedded AI Panels That Act Like Panes',
      'ja-JP': 'はじめてのツアー、Telegram ボットのワンステップ作成、内蔵 AI パネルがペインと同じように',
    },
    highlights: [
      {
        'zh-TW': '首次安裝後，導覽會用一個小提示框指著真正的按鈕，一次只請你做一件事：在 Welcome 挑工作區資料夾、按 + 開出第一個 Agent、在分格裡下第一個指令。導覽期間其他地方會蓋上灰色遮罩，誤點不會中斷導覽；提示框會一直留著，等你做完，或按「下一個」跳過這一步。',
        'en-US': 'After a fresh install, a small bubble points at the real control and asks for one thing at a time: pick a workspace folder on Welcome, press + to open your first agent, and give it a first instruction in its pane. A grey mask covers the rest of the window so a stray click cannot end the tour, and each bubble stays until you have done its step or press Next to skip it.',
        'ja-JP': '初回インストール後、小さな吹き出しが実際のボタンを指し、一度に 1 つだけ操作をお願いします。Welcome でワークスペースのフォルダーを選び、+ で最初のエージェントを開き、ペインで最初の指示を出します。ツアー中はほかの部分がグレーのマスクで覆われ、誤ってクリックしてもツアーは終わりません。吹き出しは、その手順を終えるか「次へ」でスキップするまで表示されたままです。',
      },
      {
        'zh-TW': '接著陪你試一次讓 agent 互相合作：打 @ 選另一個分格叫它做事，或把一個分格拖進另一個帶入對話脈絡。最後一步一定會出現：把滑鼠停在額度徽章上看帳號與剩餘額度，需要時直接切換帳號；徽章還沒出現時，提示框會指著它之後出現的位置，按「完成」才結束。',
        'en-US': 'Then it has you try agents working together: type @ to pick another pane and hand it a task, or drag one pane into another to bring its conversation along. The last step always comes: rest the pointer on the quota badge to see the account and what is left, with a switch right there. Before the badge appears, the bubble points at where it will show, and the tour ends only when you press Done.',
        'ja-JP': '続いて、エージェント同士の連携を試します。@ でほかのペインを選んで作業を頼むか、ペインを別のペインにドラッグして会話の文脈を渡します。最後の手順は必ず表示されます。クォータバッジにマウスを重ねるとアカウントと残量が表示され、その場で切り替えられます。バッジがまだ表示されていないときは、表示される位置を吹き出しが指し、「完了」を押すまでツアーは終わりません。',
      },
      {
        'zh-TW': '「設定 → Channels」新增 bot 一步完成：驗證憑證、啟動、開啟綁定引導，憑證被平台接受才會保留。已開啟 Bot Management Mode 的 Telegram bot 還能直接「建立新 bot」，在 Telegram 按下建立後 Navide 自動加入。',
        'en-US': 'Adding a bot in Settings → Channels now checks its credential, starts it and opens its link guide in one go, keeping it only once the platform accepts it. A Telegram bot with Bot Management Mode on can also "Create a new bot": confirm it in Telegram and Navide adds it for you.',
        'ja-JP': '「設定 → Channels」でのボット追加が一度で完了します。認証情報を確認して起動し、リンクガイドを開き、プラットフォームが受け入れた場合のみ保存します。Bot Management Mode を有効にした Telegram ボットからは「新しいボットを作成」もでき、Telegram で作成すると Navide が自動で追加します。',
      },
      {
        'zh-TW': 'Pipeline Manager、Plan、Git、Editor 視窗裡的 AI 面板會記錄歷史、可以收其他分格的訊息，並標示自己在哪個視窗；關閉視窗會一併結束面板，重開 Navide 後會接續原本的對話。',
        'en-US': 'The AI panel in the Pipeline Manager, Plan, Git and Editor windows keeps its history, can receive messages from other panes, and shows which window it lives in. Closing the window ends its panel, and it picks up its session again after Navide restarts.',
        'ja-JP': 'Pipeline Manager・Plan・Git・Editor ウィンドウの AI パネルが履歴を記録し、他のペインからメッセージを受け取れ、どのウィンドウにあるかを表示します。ウィンドウを閉じるとパネルも終了し、Navide を再起動すると元のセッションを再開します。',
      },
      {
        'zh-TW': 'Plans 直接讀寫計畫檔，大型計畫庫載入更快；每次存取仍由 Navide 授權，Execution Policy 照常生效。「設定 → 擴充套件」會列出 Plans，並揭露每個擴充套件宣告會讀寫的檔案範圍。',
        'en-US': 'Plans reads and writes plan files directly, so large libraries load faster, while Navide still authorizes every access and Execution Policy keeps applying. Settings → Extensions now lists Plans and shows the files each extension declares it reads and writes.',
        'ja-JP': 'Plans が計画ファイルを直接読み書きするようになり、大きなライブラリの読み込みが速くなりました。各アクセスは引き続き Navide が承認し、Execution Policy も適用されます。「設定 → 拡張機能」に Plans が表示され、各拡張機能が読み書きを宣言したファイル範囲も確認できます。',
      },
      {
        'zh-TW': '聊天室：在已綁定的 Telegram、Discord、Slack 聊天室輸入 /menu，就能用按鈕把這個分格的提示詞與 skill 送給它；斷線 5 秒就重連（原本 30 秒）；確認按鈕在電腦上回答、被新提問取代、回合結束或逾時後會標示原因並收起，不會再按出「這個確認已失效」。',
        'en-US': 'Chats: type /menu in a bound Telegram, Discord or Slack chat to send the pane one of its prompts or skills with a button. A dropped connection retries after 5 s instead of 30 s, and a confirmation answered at the computer, replaced by a newer one, outlived by its turn or timed out says why and drops its buttons, instead of answering "this confirmation has expired".',
        'ja-JP': 'チャット：バインド済みの Telegram・Discord・Slack のチャットで /menu と入力すると、そのペインのプロンプトやスキルをボタンで送れます。切断後 5 秒で再接続します（以前は 30 秒）。コンピューターで回答された、新しい確認に置き換えられた、ターンが終わった、または期限切れになった確認は理由を表示してボタンを外し、「この確認は無効です」と返すことはなくなりました。',
      },
      {
        'zh-TW': '其他：排程會跟著重建的分格走，目標一直不在會自動停用並通知你；某個工作區的 Plans 後端停止時會跳出通知並說明怎麼恢復；結束 Navide 時若被取消，後端與插件會自動回復；結束 Navide 時關閉終端機不再卡住、CPU 飆到 100%；CLI 自行結束時，它啟動的子行程（例如 MCP server）會一併清掉；Windows 傳給 Claude 分格的中文與多行訊息不再亂碼（#147）；Git 狀態讀取失敗或被截斷時不再假裝乾淨（#144）；修補多個相依套件的安全性弱點。',
        'en-US': 'Also: schedules follow a rebuilt pane and turn off with a notice when their target stays gone; you are told when a workspace’s Plans backend stops, and how to bring it back; a quit that gets cancelled brings the backend and extensions back; quitting no longer hangs at 100% CPU while closing terminals; a CLI that exits on its own no longer leaves its child processes, such as MCP servers, running; on Windows, Chinese and multi-line messages reach Claude panes intact (#147); Git no longer shows a failed or truncated status as clean (#144); and several dependency security advisories are patched.',
        'ja-JP': 'そのほか：スケジュールは再構築されたペインに追従し、対象が見つからない状態が続くと通知して停止します。ワークスペースの Plans バックエンドが停止すると、通知で復旧方法をお知らせします。終了がキャンセルされた場合は、バックエンドと拡張機能が自動で元に戻ります。終了時にターミナルを閉じる処理で止まって CPU が 100% になることはなくなりました。CLI が自分で終了したとき、起動した子プロセス（MCP サーバーなど）も片付けられます。Windows で Claude ペインに送る中国語や複数行のメッセージが文字化けしなくなり（#147）、Git の状態読み取りが失敗または打ち切られてもクリーンと表示しなくなりました（#144）。依存パッケージのセキュリティ勧告にも対応しました。',
      },
    ],
    note: {
      'zh-TW': '已經用過 Navide 的人不會自動看到導覽，只有全新安裝才會出現；隨時可以按「略過導覽」整段結束。想再看一次（Welcome 畫面也可以）：輔助說明 → 首次使用導覽…',
      'en-US': 'Existing installs never get the tour on their own — only a fresh install does — and Skip tour ends it at any point. To see it again, even from Welcome: Help → First-Run Tour…',
      'ja-JP': 'すでに Navide を使っている環境では自動で表示されず、新規インストール時のみ表示されます。「ツアーをスキップ」でいつでも終了できます。もう一度見るには（Welcome 画面からも可）：ヘルプ → はじめてのツアー…',
    },
  },
  {
    version: '0.2.14',
    title: {
      'zh-TW': '擴充套件自帶後端（沙盒）、更安全的 Windows Guard、綁定前先確認',
      'en-US': 'Sandboxed Extension Backends, a Safer Guard on Windows, and Binding That Asks First',
      'ja-JP': 'サンドボックス化された拡張機能バックエンド、Windows の Guard 強化、バインド前の確認',
    },
    highlights: [
      {
        'zh-TW': '擴充套件可以自帶後端程式，預設關閉。要在「設定 → 擴充套件」開啟並同意該版本後才會執行，且在沒有網路、只能寫自己資料夾的沙盒中運作；檔案一變動就會重新詢問。',
        'en-US': 'Extensions can ship their own backend, off by default. It runs only after you enable it in Settings → Extensions and approve that version, inside a sandbox with no network that can write only its own folder; any changed file asks again.',
        'ja-JP': '拡張機能が独自のバックエンドを同梱できるようになりました（既定ではオフ）。「設定 → 拡張機能」で有効にし、そのバージョンを承認した場合のみ、ネットワークなし・自分のフォルダーにのみ書き込めるサンドボックス内で実行されます。ファイルが変わると再度確認します。',
      },
      {
        'zh-TW': 'Windows 上的 Navide Guard 不再經過 PowerShell 啟動，被拒絕的指令不會因為逾時而被放行。',
        'en-US': 'Navide Guard on Windows no longer starts PowerShell, so a denied command can no longer slip through on a slow start.',
        'ja-JP': 'Windows の Navide Guard は PowerShell を起動しなくなり、起動が遅くても拒否したコマンドが実行されることはなくなりました。',
      },
      {
        'zh-TW': '綁定聊天室時先選聊天室，再確認要送出的內容並按「連線」；目前的選擇會清楚標示。',
        'en-US': 'Binding a chat now asks first: pick the chat, confirm what it receives, then Connect. The current choice is clearly marked.',
        'ja-JP': 'チャットのバインド時は、チャットを選んでから送信内容を確認し「接続」を押します。現在の選択がはっきり表示されます。',
      },
      {
        'zh-TW': '同一個平台可以設定多個 bot：每個 bot 有自己的白名單與配對，綁定時依 bot 分組選擇聊天室；原本的 bot 自動成為主要 bot，不用重新登入。在聊天室回答 CLI 的提問也不再卡住：答錯可以再答、下一題會接著推，直接回「1」或「yes」也算數。',
        'en-US': 'Run several bots on one platform: each bot has its own allowlist and pairing, and the bind menu groups chats by bot. Your existing bot becomes the main bot without signing in again. Answering CLI questions from a chat no longer gets stuck: a wrong answer can be retried, the next question follows, and a bare "1" or "yes" counts.',
        'ja-JP': '1 つのプラットフォームで複数のボットを使えるようになりました。ボットごとに許可リストとペアリングを持ち、バインド時はボットごとにチャットを選べます。既存のボットはメインボットとして引き継がれ、再ログインは不要です。チャットから CLI の質問に答えても止まらなくなりました。間違えても答え直せ、次の質問も続けて届き、「1」や「yes」だけでも回答になります。',
      },
      {
        'zh-TW': '其他：Marketplace 評分與檢舉、Windows 存檔與大量檔案變動不再卡住、超大專案的 Git 狀態不再卡住、Keychain 讀取更正確、中文使用者資料夾的 Windows hook 恢復正常。',
        'en-US': 'Also: Marketplace ratings and reports, no more stalls on Windows saves or file bursts, Git status no longer stalls in huge projects, Keychain reads are exact, and Windows hooks work under a non-ASCII user folder.',
        'ja-JP': 'そのほか：マーケットプレイスの評価と報告、Windows の保存や大量のファイル変更で止まらなくなりました。巨大なプロジェクトでも Git の状態表示が止まらず、キーチェーンの読み取りも正確になり、ASCII 以外の文字を含むユーザーフォルダーでも Windows のフックが動作します。',
      },
    ],
  },
  {
    version: '0.2.13',
    title: {
      'zh-TW': '擴充套件市集、Channels 雙向同步與連線監控、大型 Plan',
      'en-US': 'An Extension Marketplace, Two-Way Channels with a Monitor, and Large Plans',
      'ja-JP': '拡張機能マーケットプレイス、Channels の双方向同期と接続モニター、大きな Plan',
    },
    highlights: [
      {
        'zh-TW': '擴充套件市集上線：可以瀏覽、安裝第三方擴充套件與擴充套件包，也能為個別擴充套件開啟預覽版。開發者可以自行登入、驗證網域並發布，上架前會經過審核與密鑰掃描。navide:// 連結會在 App 內開啟擴充套件頁面，安裝一定要你確認。',
        'en-US': 'The extension Marketplace is here: browse and install third-party extensions and extension packs, and opt into pre-releases per extension. Publishers sign in, verify their domain and publish themselves, and every release is reviewed and scanned for secrets before it is listed. navide:// links open an extension\'s page in the app, and installing always asks you first.',
        'ja-JP': '拡張機能マーケットプレイスを公開しました。サードパーティの拡張機能や拡張機能パックを閲覧・インストールでき、拡張機能ごとにプレリリースも選べます。公開者は自分でサインインし、ドメインを検証して公開でき、掲載前に審査とシークレットスキャンが行われます。navide:// リンクはアプリ内で拡張機能のページを開き、インストールには必ず確認が必要です。',
      },
      {
        'zh-TW': '標題列新增 Channels 連線監控：一眼看到哪些分格綁定了聊天室，可以直接跳過去或中斷連線。',
        'en-US': 'A Channels monitor in the titlebar shows which panes are bound to a chat, and lets you jump to one or disconnect it.',
        'ja-JP': 'タイトルバーに Channels の接続モニターを追加しました。どのペインがチャットにバインドされているかを確認し、ペインへの移動や切断ができます。',
      },
      {
        'zh-TW': 'Channels 可以把綁定分格的活動同步到聊天室，聊天室的回覆也會回到分格。綁定時先選擇聊天室會收到什麼，預設「只回覆聊天室」，本機輸入不會送出；之後可隨時在分格的連接選單更改。',
        'en-US': 'Channels can mirror a bound pane\'s activity to its chat and bring replies back. When you bind, you choose what the chat receives; the default, “Chat replies only”, sends nothing typed locally. You can change it any time from the pane\'s channel menu.',
        'ja-JP': 'Channels でバインドしたペインのアクティビティをチャットに同期し、返信をペインに戻せます。バインド時にチャットが受け取る内容を選べ、既定の「チャットへの返信のみ」ではローカル入力は送信されません。ペインのチャンネルメニューからいつでも変更できます。',
      },
      {
        'zh-TW': 'Plans 可以開啟並儲存任何大小的文件，包含大量中文的 plan。',
        'en-US': 'Plans opens and saves documents of any size, including plans with a lot of CJK text.',
        'ja-JP': 'Plans で任意のサイズのドキュメントを開いて保存できます。CJK 文字の多い plan も含みます。',
      },
      {
        'zh-TW': '語音輸入在連線與模型下載完成時先暖機，第一次說話就有即時字幕；設定頁分開顯示模型與引擎狀態。',
        'en-US': 'Voice input warms up on connect and after the model downloads, so the first take shows live text; Settings shows the model and the engine as separate rows.',
        'ja-JP': '音声入力は接続時とモデルのダウンロード後に準備されるため、最初の発話からリアルタイムに文字が表示されます。設定ではモデルとエンジンの状態を分けて表示します。',
      },
      {
        'zh-TW': '修正：Git 遠端操作不再提早逾時或在輸入密碼時關閉視窗；終端機與 mini-IDE 開檔失敗會提示；分格內 Ctrl+C 恢復作用；Windows 上關閉 App 後後端會立即結束。',
        'en-US': 'Fixes: Git remote operations no longer time out early or close the password prompt; opening a file from the terminal or the mini-IDE says so when it fails; Ctrl+C works in panes again; on Windows the backend exits promptly when the app closes.',
        'ja-JP': '修正：Git のリモート操作が早すぎるタイムアウトやパスワード入力中のダイアログ終了を起こさなくなりました。ターミナルと mini-IDE でのファイルオープン失敗が通知されます。ペイン内の Ctrl+C が再び機能します。Windows でアプリ終了時にバックエンドがすぐ終了します。',
      },
    ],
  },
  {
    version: '0.2.12',
    title: {
      'zh-TW': 'Channels 一鍵連結、側欄 Free 模式、擴充套件可回滾',
      'en-US': 'One-Click Channel Linking, a Free Sidebar Mode and Extension Rollback',
      'ja-JP': 'Channels のワンクリック連携、サイドバーの Free モード、拡張機能のロールバック',
    },
    highlights: [
      {
        'zh-TW': 'Channels 連上 bot 之後，按一下就能連結你自己的聊天帳號：Telegram 私訊、加進群組或伺服器、Slack 私訊，或取得一次性代碼傳給 bot，不必再核准配對碼。代碼過期或連結失敗時，畫面會直接說明並讓你重新取得。',
        'en-US': 'Once a Channels bot is connected, link your own chat account in one click — a Telegram DM, adding the bot to a group or server, a Slack DM, or a one-time code sent to the bot — with no pairing code to approve. If the code expires or the link fails, the guide says so and lets you get a new one.',
        'ja-JP': 'Channels でボットを接続したら、ワンクリックで自分のチャットアカウントを連携できます。Telegram の DM、グループやサーバーへの追加、Slack の DM、またはボットに送るワンタイムコードに対応し、ペアリングコードの承認は不要です。コードの期限切れや連携失敗時は画面に理由が表示され、新しいコードを取得できます。',
      },
      {
        'zh-TW': '側欄新增 Workspace／Free 兩種模式：Workspace 照工作區分組，Free 把所有 agent 列成一張清單，每個 agent 自成一張線框卡片並標出所屬工作區，主區顯示全部分格。選擇會記住，已開的視窗也會即時跟著切換。',
        'en-US': 'The sidebar has two modes: Workspace groups agents by workspace, and Free lists every agent in one flat list — each in its own outlined card, labelled with its workspace — with every pane on the stage. The choice is remembered, and windows that are already open follow it live.',
        'ja-JP': 'サイドバーに Workspace／Free の 2 つのモードを追加しました。Workspace はワークスペースごとにグループ化し、Free はすべてのエージェントを 1 つのリストにまとめ、各エージェントを所属ワークスペース付きの枠線カードで表示し、すべてのペインを表示します。選択は保存され、開いている他のウィンドウにもすぐ反映されます。',
      },
      {
        'zh-TW': '「設定 → 擴充套件」可以把已安裝的擴充套件回滾到它取代的版本，失敗時會說明原因並還原畫面。',
        'en-US': 'Settings → Extensions can roll an installed extension back to the package it replaced; a failed rollback explains why and restores the view.',
        'ja-JP': '「設定 → 拡張機能」で、インストールした拡張機能を置き換え前のパッケージにロールバックできます。失敗した場合は理由が表示され、表示も元に戻ります。',
      },
      {
        'zh-TW': 'Pipeline 執行時最多只保留兩個階段的 CLI，減少記憶體占用；更新視窗的版本說明改為可讀的文字；Windows 上關閉分格更快。',
        'en-US': 'A pipeline run keeps at most two stages of CLIs alive, using less memory; the updater shows release notes as readable text; and closing a pane is faster on Windows.',
        'ja-JP': 'パイプライン実行中に保持する CLI は最大 2 ステージ分になり、メモリ使用量が減りました。アップデーターのリリースノートは読みやすいテキストで表示され、Windows ではペインを閉じる処理が速くなりました。',
      },
    ],
  },
  {
    version: '0.2.11',
    title: {
      'zh-TW': 'Channels 在安裝版可以正常使用',
      'en-US': 'Channels Works in the Installed App',
      'ja-JP': 'インストール版で Channels が使えるようになりました',
    },
    highlights: [
      {
        'zh-TW': '0.2.10 的安裝版漏掉了所有聊天平台的連接元件，設定任何聊天都會失敗；現在已補齊。',
        'en-US': 'The 0.2.10 installed app left out every chat platform’s adapter, so setting up any chat failed; they are now included.',
        'ja-JP': '0.2.10 のインストール版ではすべてのチャットプラットフォームのアダプターが欠けていたため、チャットの設定が失敗していました。現在は含まれています。',
      },
    ],
  },
  {
    version: '0.2.10',
    major: true,
    tour: [
      {
        id: 'welcome',
        prepare: { kind: 'close-settings' },
        titleKey: 'tour.v0_2_10.welcome.title',
        bodyKey: 'tour.v0_2_10.welcome.body',
      },
      {
        id: 'channels-settings',
        prepare: { kind: 'settings', tab: 'channels' },
        anchor: '[data-settings-section="channels"]',
        titleKey: 'tour.v0_2_10.channelsSettings.title',
        bodyKey: 'tour.v0_2_10.channelsSettings.body',
        missingKey: 'tour.v0_2_10.channelsSettings.missing',
      },
      {
        id: 'channels-pane',
        prepare: { kind: 'close-settings' },
        anchor: '[data-testid="channel-connect"], [data-testid="channel-chip"]',
        titleKey: 'tour.v0_2_10.channelsPane.title',
        bodyKey: 'tour.v0_2_10.channelsPane.body',
        missingKey: 'tour.v0_2_10.channelsPane.missing',
      },
      {
        id: 'voice-settings',
        prepare: { kind: 'settings', tab: 'voice' },
        anchor: '[data-settings-section="voice"]',
        titleKey: 'tour.v0_2_10.voiceSettings.title',
        bodyKey: 'tour.v0_2_10.voiceSettings.body',
        missingKey: 'tour.v0_2_10.voiceSettings.missing',
      },
      {
        id: 'voice-dictate',
        prepare: { kind: 'close-settings' },
        anchor: '.xterm-host[data-pane-id]',
        titleKey: 'tour.v0_2_10.voiceDictate.title',
        bodyKey: 'tour.v0_2_10.voiceDictate.body',
        missingKey: 'tour.v0_2_10.voiceDictate.missing',
      },
      {
        id: 'done',
        titleKey: 'tour.v0_2_10.done.title',
        bodyKey: 'tour.v0_2_10.done.body',
      },
    ],
    title: {
      'zh-TW': '從聊天軟體指揮 CLI，還能直接用說的',
      'en-US': 'Drive Your CLIs from a Chat App — or Just Talk to Them',
      'ja-JP': 'チャットアプリから CLI を操作、そして声でも',
    },
    features: [
      {
        icon: '💬',
        name: { 'zh-TW': 'Channels 聊天頻道', 'en-US': 'Channels', 'ja-JP': 'チャンネル' },
        tagline: {
          'zh-TW': '把 Telegram、Discord、Slack、飛書、釘釘、Matrix、Mattermost 或 iMessage 接到分格：在聊天室下指令，回合結束時結果回到同一個對話。',
          'en-US': 'Connect Telegram, Discord, Slack, Feishu/Lark, DingTalk, Matrix, Mattermost or iMessage to a pane: send instructions from the chat, and the answer comes back to the same conversation when the turn ends.',
          'ja-JP': 'Telegram、Discord、Slack、Feishu/Lark、DingTalk、Matrix、Mattermost、iMessage をペインにつなぎ、チャットから指示を送ると、ターン終了時に同じ会話へ結果が返ります。',
        },
        where: {
          'zh-TW': '設定 → Channels，再按分格標題列的聊天按鈕',
          'en-US': 'Settings → Channels, then the chat button in a pane header',
          'ja-JP': '設定 → チャンネル、次にペインヘッダーのチャットボタン',
        },
      },
      {
        icon: '🎙',
        name: { 'zh-TW': '語音輸入', 'en-US': 'Voice Input', 'ja-JP': '音声入力' },
        tagline: {
          'zh-TW': '按住快捷鍵說話，放開後文字就打進目前的分格。辨識完全在本機進行，語音不會離開這台電腦。',
          'en-US': 'Hold a key and speak; let go and the words are typed into the focused pane. Transcription runs entirely on this machine — your voice never leaves it.',
          'ja-JP': 'キーを押しながら話し、離すとフォーカス中のペインに文字が入力されます。文字起こしはすべてこのマシン上で行われ、音声は外に出ません。',
        },
        where: {
          'zh-TW': '設定 → 語音輸入（預設關閉）',
          'en-US': 'Settings → Voice Input (off by default)',
          'ja-JP': '設定 → 音声入力（初期状態はオフ）',
        },
      },
    ],
    highlights: [
      {
        'zh-TW': 'Channels：平台在「設定 → Channels」設定一次，之後每個分格都能從標題列的聊天按鈕綁到一個聊天位置（Telegram 論壇主題、Discord/Slack 討論串…）。只有配對過的傳送者能下指令；CLI 要求權限時，會把選項送到聊天室讓你回答，但永遠不會代按「永久允許」。',
        'en-US': 'Channels: set a platform up once in Settings → Channels, then bind any pane to one chat location (a Telegram forum topic, a Discord or Slack thread, …) from the chat button in its header. Only paired senders can give instructions; when a CLI asks for permission the options are relayed to the chat for you to answer, and a permanent-allow option is never pressed from chat.',
        'ja-JP': 'チャンネル：プラットフォームは「設定 → チャンネル」で一度設定すれば、各ペインをヘッダーのチャットボタンから 1 つのチャット位置（Telegram フォーラムのトピック、Discord/Slack のスレッドなど）に結び付けられます。指示できるのはペアリング済みの送信者だけです。CLI が許可を求めると選択肢がチャットに届き、そこで回答できますが、「常に許可」がチャットから押されることはありません。',
      },
      {
        'zh-TW': '語音輸入：在「設定 → 語音輸入」打開並下載辨識模型後，按住快捷鍵（預設 Ctrl+Alt+M，也可以改成 fn 🌐、單獨的 ⌘ 或任一單鍵）說話。說話時就會即時顯示文字；只輸入、不送出，錄音中按 Enter 則結束並送出。中文預設轉成台灣繁體。',
        'en-US': 'Voice Input: turn it on in Settings → Voice Input and download the speech model, then hold the shortcut (Ctrl+Alt+M by default — or fn 🌐, a lone ⌘, or any single key) and speak. Words appear as you talk; they are typed, never sent — press Enter during a take to end it and send. Chinese comes out in Traditional (Taiwan) by default.',
        'ja-JP': '音声入力：「設定 → 音声入力」でオンにして音声モデルをダウンロードし、ショートカット（既定は Ctrl+Alt+M。fn 🌐、単独の ⌘、任意の単一キーにも変更可）を押しながら話します。話しながら文字が表示され、入力されるだけで送信はされません。録音中に Enter を押すと終了して送信します。',
      },
    ],
  },
  {
    version: '0.2.9',
    title: {
      'zh-TW': '排程工作、帳號命名、額度用完自動切帳號、日文介面',
      'en-US': 'Scheduled Work, Named Accounts, Quota Failover and a Japanese Interface',
      'ja-JP': 'スケジュール実行、アカウント名、クォータ切れ時の切り替え、日本語 UI',
    },
    highlights: [
      {
        'zh-TW': '「排程」分頁可以替 CLI 分格排工作：指定時間跑一次，或每 N 分鐘、每天、每週重複，時間到了就喚醒該分格並送出指令。',
        'en-US': 'Schedule work for a CLI pane from the Schedule tab: once at a set time, or every N minutes, daily or weekly — when due it wakes the pane and sends it the instruction.',
        'ja-JP': '「スケジュール」タブから CLI ペインの作業を予約できます。指定時刻に 1 回、または N 分ごと・毎日・毎週に繰り返し、時刻になるとペインを起こして指示を送ります。',
      },
      {
        'zh-TW': '每個 CLI 帳號都能命名，名稱會出現在分格標題列的額度徽章、帳號清單與切換通知。',
        'en-US': 'Name every CLI account; the name leads in the pane header’s quota badge, the account list and switch notices.',
        'ja-JP': 'CLI アカウントごとに名前を付けられ、ペインヘッダーのクォータバッジ、アカウント一覧、切り替え通知に表示されます。',
      },
      {
        'zh-TW': '帳號額度用完時，可以選擇關閉、只通知，或自動切到另一個帳號並接續對話。',
        'en-US': 'When an account runs out of quota, choose Off, Notify, or Auto — which switches to another account and resumes the conversation.',
        'ja-JP': 'アカウントのクォータが尽きたとき、オフ・通知のみ・自動（別のアカウントに切り替えて会話を再開）から選べます。',
      },
      {
        'zh-TW': '新增日文介面，可在「設定 → 語言」切換。',
        'en-US': 'A Japanese interface, chosen from Settings → Language.',
        'ja-JP': '日本語インターフェースを追加しました。「設定 → 言語」で切り替えられます。',
      },
    ],
  },
  {
    version: '0.2.8',
    title: {
      'zh-TW': '摺疊群組、整個專案一次回收、Claude 往上滑的先前提示回來了',
      'en-US': 'Fold a Group, Reclaim a Whole Project, and Claude\u2019s Scroll-Back Row Returns',
    },
    highlights: [
      {
        'zh-TW': '群組可以整個摺疊起來，側欄與專案標題都能操作。摺疊後拖曳那一列，被藏起來的子代會跟著走——以前只有父列會動，孩子留在原地。多選時只有你抓的那一列會展開成子樹，其他摺疊列仍單獨移動。',
        'en-US': 'A group folds up everything under it, from the sidebar or the workspace heading. Drag a folded row and the hidden descendants travel with it — before, the parent moved alone and left its children behind. In a multi-selection only the row you grabbed expands into its subtree.',
      },
      {
        'zh-TW': 'Claude Code 全螢幕時往上滑會顯示先前提示的那一列深色橫幅，之前會莫名消失。原因是 Navide 關分格時直接強制終止，claude 來不及跑自己的退出處理，在設定檔留下殘跡；累積兩次它就自己把全螢幕關掉。現在 macOS 與 Linux 會先送 SIGTERM 並等它收尾。**Windows 尚未支援**，追蹤於 #120。',
        'en-US': 'Claude Code\u2019s dim row of previous prompts — the one that appears when you scroll up in fullscreen — stopped showing for some people. Navide was terminating the pane outright, so claude never ran its own exit handler and left a trace behind; two of those and it turns fullscreen off itself. macOS and Linux now send SIGTERM and wait. **Not on Windows yet** — tracked in #120.',
      },
      {
        'zh-TW': '側欄可以一次回收整個專案的 CLI，每個分格變成點一下就能接續的佔位。正在使用的、等你回答的、有未送出文字的、還有無法接續的，都不會被收走。',
        'en-US': 'Reclaim a whole project\u2019s CLIs from the sidebar; each pane becomes a click-to-resume placeholder. The focused pane, one awaiting your answer, one holding unsent text and one that cannot be resumed are left alone.',
      },
      {
        'zh-TW': '在一個視窗裡開多個專案時，切換途中開的分格會被歸到「正要離開的那個專案」的群組底下，嚴重時還會把一個專案的群組記錄蓋掉另一個。這版修好了。**如果你在 0.2.7 已經遇到，舊資料要手動清**：關掉 Navide 後執行 scripts/repair-run-group-ids.py（預設乾跑、寫入前自動備份）。',
        'en-US': 'With two workspaces in one window, a pane opened mid-switch filed itself under the workspace being left, and saving could write one workspace\u2019s groups over another\u2019s. Fixed. **If 0.2.7 already mixed your rows**, the fix only stops new ones — close Navide and run scripts/repair-run-group-ids.py to clean up (dry-runs by default, backs up first).',
      },
      {
        'zh-TW': 'Navide Cloud 的分格清單改成依裝置 → 狀態 → 專案分層，可摺疊、可搜尋，不再是一長串。Welcome 的「New…」現在可以直接命名新資料夾，不必再靠系統對話框改名。',
        'en-US': 'The Navide Cloud pane list nests by device, state and workspace, foldable and searchable, instead of one flat run of rows. Welcome\u2019s New… now asks for a name rather than leaving you to rename in the file picker.',
      },
    ],
  },
  {
    version: '0.2.7',
    title: {
      'zh-TW': 'Codex 分格不再誤判失敗、更新改走自家載點',
      'en-US': 'Codex Panes Stop Failing, Updates Come From Our Own Mirror',
    },
    highlights: [
      {
        'zh-TW': 'Codex 分格開起來約 30 秒後被判「失敗」、但 Codex 自己明明還停在提示字元——這個已修。原因是建立終端機時要先掃完該廠商的整棵 session 樹（Codex 會逐一打開每個 rollout 檔讀檔頭），樹一大就超過前端 30 秒的等待上限。現在 PTY 一起來就先回報成功，掃描在背後跑。',
        'en-US': 'A Codex pane that reported failed about 30 seconds after starting — while Codex itself sat at its prompt — is fixed. Creating a terminal waited for a scan that opens every rollout file in the vendor\u2019s session tree; on a large tree it ran past the renderer\u2019s 30-second deadline. The pane now reports success as soon as its PTY is up, and the scan runs behind it.',
      },
      {
        'zh-TW': 'Codex CLI 0.155 改了日誌格式，分格命名因此空白、每呼叫一次工具就誤報回合結束——已跟上新格式，命名恢復，回合以 task_complete 為準。',
        'en-US': 'Codex CLI 0.155 changed its rollout log, leaving pane names blank and reporting a turn finished on every tool call. The reader now follows the new format: names come back, and a turn ends at task_complete.',
      },
      {
        'zh-TW': 'App 內自動更新改成優先向 dl.navide.dev 取得，和官網下載按鈕同一個載點，連不上時才退回 GitHub。GitHub 的檔案主機在部分網路下只有數十 KB/s，200 MB 的安裝檔常常下不完。',
        'en-US': 'In-app updates now come from dl.navide.dev first — the same host the website\u2019s download buttons use — and fall back to GitHub only when the mirror cannot be reached. GitHub\u2019s asset host runs at tens of KB/s on some networks, too slow to finish a 200 MB installer.',
      },
      {
        'zh-TW': '「設定」側欄的「外掛程式」群組併入「整合」：擴充功能與市集移到記憶體之後；「通知」從冗長的一般頁獨立成自己的分頁，排在版面之後。搜尋設定仍然找得到每一列。',
        'en-US': 'The Settings sidebar folds its Plugins group into Integrations — Extensions and Marketplace now sit after Memory — and Notifications leaves the long General page for a tab of its own after Layout. Searching Settings still finds every row.',
      },
      {
        'zh-TW': '從專案標題的 ＋ 選單點另一個 CLI，現在只是「開這一次」，不會把它改成預設。要換預設請用 Ctrl+1～9 或設定。',
        'en-US': 'Picking another CLI from a workspace heading\u2019s ＋ menu now opens it once instead of changing the default. Ctrl+1\u20269 and Settings still set the default.',
      },
    ],
  },
  {
    version: '0.2.6',
    title: {
      'zh-TW': 'Marketplace 獨立分頁、原生選單跟隨語言、用量徽章不再誤亮',
      'en-US': 'Marketplace Page, Localized Native Menu, Usage Badge That Stays Honest',
    },
    highlights: [
      {
        'zh-TW': '「設定 → 外掛程式」現在是兩頁：搜尋與安裝擴充功能請到新的「市集」；「擴充功能」頁只剩已安裝清單，而原本獨立的「執行政策」分頁變成這一頁最上方的區塊，沒有消失。「Navide Cloud」也從「一般」群組搬到「帳號與代理」。',
        'en-US': 'Settings → Extensions is now two pages: search and install on the new Marketplace page; Extensions keeps what is installed, with the former Execution Policy tab folded into a block at its top. Navide Cloud moves from General to Accounts & Agents.',
      },
      {
        'zh-TW': 'Electron 原生選單（檔案／編輯／檢視／視窗）跟隨介面語言，切換語言時即時重建。專案標題的 ⋯ 選單收進了原本只有右鍵才有的動作（在 Finder 開啟、複製路徑、重新命名、獨立視窗、關閉工作區）。',
        'en-US': 'The native application menu follows the UI language and rebuilds when you switch. A workspace\u2019s ⋯ menu gains the actions that used to need a right-click: reveal in Finder, copy path, rename, open in its own window, close.',
      },
      {
        'zh-TW': '用量上限徽章改以帳號的 /usage 讀數為準：終端裡出現的「已達上限」句子若與新讀數矛盾會被否決，不再因為重播歷史或討論額度而誤亮好幾個小時；反過來帳號真的用完時即使 CLI 沒印任何字也會亮。',
        'en-US': 'The usage-limit badge now trusts the account\u2019s /usage reading: a limit sentence in the terminal that contradicts a fresh reading is overruled, so a replayed transcript or a conversation about quotas no longer lights it for hours; and it lights from the reading alone when the account really is spent.',
      },
      {
        'zh-TW': '裝了 xAI grok 的機器不會再把它當成 Cursor CLI（同名的 agent 執行檔）；從「設定 → 帳號」登入現用 Claude／Kilo 帳號時分格不再秒退；Copilot 與 Muse 的登入按鈕現在直接執行各自的 login 指令。',
        'en-US': 'grok is no longer detected or launched as Cursor CLI (same `agent` binary name); signing in to the current Claude or Kilo account from Settings → Accounts no longer kills the pane; Copilot and Muse sign in with their own login commands.',
      },
      {
        'zh-TW': 'Codex 若每次開分格都跳「Hooks need review」，看過一次後這台機器就不再注入該 hook——session 綁定改走 log 偵測，功能不缺但目前沒有 UI 可以重新開啟。',
        'en-US': 'If Codex asks "Hooks need review" on every pane, seeing it once now stops the hook being injected on this machine; session binding falls back to log detection, and there is no UI yet to turn it back on.',
      },
      {
        'zh-TW': '說明中心新增「Windows、Linux 與跨裝置」主題與「用量」章節，介面標籤改由產品自身的翻譯鍵引用，修正了二十處寫錯的說明。側欄拖曳已折疊的父列會連同隱藏的子樹一起搬。',
        'en-US': 'Help gains a Windows, Linux & cross-device topic and a Usage section; interface labels in help text now come from the same keys the UI renders, correcting twenty descriptions. Dragging a folded pane row carries its hidden subtree along.',
      },
    ],
  },
  {
    version: '0.2.5',
    title: {
      'zh-TW': '每個 CLI 的啟動設定、一次關掉整組面板',
      'en-US': 'Per-CLI Launch Settings, Closing a Whole Branch at Once',
    },
    highlights: [
      {
        'zh-TW': '「設定 → CLI Agents」現在把每個 CLI 的東西收在同一頁：預設模型與 reasoning effort、自訂啟動指令、額外環境變數、權限略過、推送通道、安裝引導。手動開分格的對話框也多了 Model 與 Effort 欄位。注意：填了自訂啟動指令就等於完全接管命令列，Navide 不會再往上加任何參數（包含預設模型與權限略過）。',
        'en-US': 'Settings → CLI Agents now holds everything about a CLI in one place: a default model and reasoning effort, a custom launch command, extra environment variables, permission bypass, push channels and guided install. The manual spawn dialog gains Model and Effort fields. Note: a custom launch command takes the command line over completely — Navide adds nothing to it, including the default model and the permission-bypass flag.',
      },
      {
        'zh-TW': '分格右鍵選單新增「一次關掉這個與它衍生的全部代理」，不必再看著子代理重新掛到別的父節點上。',
        'en-US': 'A pane\u2019s context menu can now close it together with every agent it spawned, instead of leaving the children to reattach to another parent.',
      },
      {
        'zh-TW': '額度用盡的 ⛔ 徽章可以點掉了（會先確認），正在等額度的 loop 會立刻續跑；也修好了「關掉一次之後，隔天或切回該帳號再次撞到額度卻完全沒有提示」的問題。',
        'en-US': 'The out-of-quota badge can be dismissed (with a confirmation), and a loop waiting on quota resumes at once. It also no longer swallows the next real limit the following day, or when you switch back to the account that ran out.',
      },
      {
        'zh-TW': '修好用 npm -g／nvm／volta／pnpm／bun 安裝的 CLI 從 Finder 啟動時開不了分格（「在終端機跑得動、在 Navide 開不起來」），安裝引導也改成 shell 真的回報找不到指令才提示。',
        'en-US': 'Fixed panes refusing to open for a CLI installed through npm -g, nvm, volta, pnpm or bun when Navide was started from Finder — the "works in Terminal, will not open in Navide" case. Guided install now waits until the shell actually reports the command is missing.',
      },
      {
        'zh-TW': 'macOS 上 nvm 的路徑順序改了：你用 nvm use 選的 node 版本不會再被換掉。若你原本（無意間）依賴 Navide 把 nvm 的 node 排到最前面，現在拿到的會是你自己 shell PATH 裡的那一個。',
        'en-US': 'On macOS the nvm directories now come after your own PATH, so the node you selected with nvm use is no longer replaced. If you were relying on Navide putting an nvm node first, you will now get the one your shell would.',
      },
      {
        'zh-TW': 'Pipeline 的「繼續執行」修好了——原本每個開出來的分格都會以「cwd does not exist」失敗；連點兩次也不會再重複開。',
        'en-US': 'Resuming a pipeline stage works again — every pane it opened used to fail with "cwd does not exist" — and pressing Resume twice no longer spawns the stage twice.',
      },
    ],
  },
  {
    version: '0.2.4',
    title: {
      'zh-TW': 'Token Monitor 與額度週期、下載鏡像',
      'en-US': 'Token Monitor & Quota Cycles, Download Mirror',
    },
    highlights: [
      {
        'zh-TW': '新增「視窗 → Token Monitor」獨立視窗：每輪 token 用量與模型分佈、5 小時／月／年額度週期彙總，以及 14／30／90 天的平均與中位數。額度觀測只讀既有輪詢資料，不會多送任何請求。',
        'en-US': 'New Window → Token Monitor: per-turn token usage and model mix, 5-hour / monthly / yearly quota cycles, and 14/30/90-day averages and medians. Quota observations reuse existing polls and send no extra provider requests.',
      },
      {
        'zh-TW': '更正：原本預告的「設定 → Sharing」分頁在 0.2.4 出貨前已移除、等待重新設計。匯出／匯入設定全集仍可在「設定 → General → 設定管理」使用；雲端分享碼與已配對裝置清單尚未推出。',
        'en-US': 'Correction: the Settings → Sharing page announced for this release was removed before 0.2.4 shipped and is awaiting a redesign. Exporting and importing the settings bundle is still available under Settings → General → Settings Management; the cloud share code and paired-device list did not ship.',
      },
      {
        'zh-TW': '關閉工作區時可選擇保留 CLI 繼續在背景執行：右鍵選單分成「關閉工作區」與「關閉工作區與其中的分格」，關掉畫面不再等於砍掉正在跑的 agent。',
        'en-US': 'Closing a workspace can now leave its CLI panes running: the context menu separates "close workspace" from "close workspace and its CLI panes", so putting a project away no longer kills the agents working in it.',
      },
      {
        'zh-TW': '下載改走鏡像 dl.navide.dev：GitHub 載點連不上或太慢時，官網會自動改用鏡像，App 內更新也會在 GitHub 失敗後改走鏡像重試一次。',
        'en-US': 'Downloads now have a mirror at dl.navide.dev: the website switches to it automatically when GitHub is unreachable or slow, and the in-app updater retries there after a network failure on GitHub.',
      },
      {
        'zh-TW': '終端機輸入在 CLI 大量輸出時不再卡住；工作區側邊欄支援子樹摺疊；Codex 分格重啟後能正確接回原本的對話。',
        'en-US': 'Terminal input no longer stalls while a CLI floods the pane with output; the workspace sidebar folds subtrees; and Codex panes reconnect to their original conversation after a restart.',
      },
    ],
  },
  {
    version: '0.2.3',
    title: {
      'zh-TW': '四平台同一版本、Windows ARM64 原生版',
      'en-US': 'One Build for Four Platforms, Native Windows ARM64',
    },
    highlights: [
      {
        'zh-TW': 'macOS、Windows x64、Windows ARM64 與 Linux x64 首次由同一個 commit 出貨；Windows on Arm 有了原生安裝檔，不再靠模擬執行。',
        'en-US': 'macOS, Windows x64, Windows ARM64 and Linux x64 ship from one commit for the first time, and Windows on Arm gets a native installer instead of running emulated.',
      },
      {
        'zh-TW': '修正終端機分格在分析器輪詢期間逾時的問題（外連 TLS 內容改為只建一次且不佔用事件迴圈）。',
        'en-US': 'Fixed terminal panes timing out while the analyzer polled: the outbound TLS context is now built once, off the event loop.',
      },
      {
        'zh-TW': 'MCP 分格可接續既有的 CLI 對話；側邊欄拖放會建立分格血緣關係。',
        'en-US': 'MCP panes can resume an existing CLI conversation, and sidebar drag-and-drop assigns pane lineage.',
      },
    ],
  },
  {
    version: '0.2.2',
    title: {
      'zh-TW': 'Windows 與 Linux 跨平台支援、Prompt Skills 自訂圖示與工作區別名',
      'en-US': 'Windows & Linux Multi-Platform Support, Custom Prompt Skill Icons & Workspace Aliases',
    },
    highlights: [
      {
        'zh-TW': 'Windows 與 Linux 正式支援：新增 Windows NSIS 安裝包、ConPTY 終端機與 DPAPI 安全加密；Linux 支援 AppImage（內建靜態 FUSE3 執行期）與桌面整合。',
        'en-US': 'Windows & Linux support: Official Windows NSIS installer, ConPTY terminal, and DPAPI encryption; Linux AppImage with static FUSE3 runtime and desktop integration.',
      },
      {
        'zh-TW': 'Prompt Skills 升級：支援自訂 Emoji/單字元圖示與 24 款內建向量圖示；非預設技能支援一鍵單次呼叫（One-shot Cast），不再強制循環。',
        'en-US': 'Prompt Skills enhancements: Support for custom single-character emoji icons and 24 builtin vector icons, plus one-shot casting for non-default skills without loop lock.',
      },
      {
        'zh-TW': '工作區別名與階層狀態：支援設定工作區顯示名稱別名；側邊欄整合子 Agent 樹狀狀態標籤（Subtree Status）、Token 消耗分組與長路徑清晰展示。',
        'en-US': 'Workspace aliases & hierarchy status: Custom workspace display names, sidebar subtree status badges, token attribution by run group, and clear path hierarchy.',
      },
      {
        'zh-TW': 'Plans 穩定性加固：實作單一飛行（Single-flight）併發掃描合併與防抖機制，支援目錄搬移即時追蹤與重試復原。',
        'en-US': 'Plans performance & hardening: Single-flight concurrent scan coalescing, debounced watcher events, directory move tracking, and recovery retries.',
      },
      {
        'zh-TW': 'MCP 與訊息協議加強：支援喚醒冷啟動分格、Ack-only 確認訊息不佔用終端輸入、以及多裝置連線感知。',
        'en-US': 'MCP & messaging extensions: Wake cold-restored agent panes, ack-only receipt messages, and multi-device presence hints.',
      },
    ],
  },
  {
    version: '0.2.1',
    title: {
      'zh-TW': '外掛架構升級：打包 Plans 執行期與執行策略（Execution Policy）設定',
      'en-US': 'Plugin Runtime Upgrade: Packaged Plans & Execution Policy',
    },
    highlights: [
      {
        'zh-TW': 'Plans 外掛化：計畫文件遷移至獨立打包的 navide.plans 外掛執行期，支援離線執行、沙盒隔離與容錯復原。',
        'en-US': 'Packaged Plans runtime: Plans migrated to the isolated navide.plans plugin runtime with fallback recovery.',
      },
      {
        'zh-TW': '執行策略（Execution Policy）加固：新增設定介面與黑白名單防護，加強 Agent 執行命令與檔案系統權限控制。',
        'en-US': 'Execution Policy hardening: New settings pane with allowlist/denylist modes to tightly govern agent authority.',
      },
      {
        'zh-TW': '外部 MCP 控制協議擴充：支援 Pipeline 啟動與重啟、階段與角色定義、工作區與用量資源讀取。',
        'en-US': 'Expanded MCP control: Pipeline management, stage/role definitions, and workspace/usage resources.',
      },
      {
        'zh-TW': '外掛後端健康監控優化：提高冷啟動逾時時間，避免重載環境下誤入復原模式。',
        'en-US': 'Plugin backend supervisor: Longer cold boot timeout budget to prevent spurious recovery fallback.',
      },
    ],
  },
  {
    version: '0.2.0',
    major: true,
    title: {
      'zh-TW': 'Navide Cloud 上線：你的裝置，連成一個 agent 網路',
      'en-US': 'Navide Cloud is here: your devices, joined into one agent network',
    },
    spotlight: {
      name: 'Navide Cloud',
      tagline: {
        'zh-TW': '一個帳號，把你所有裝置上的 agent 串成一個私有網路。',
        'en-US': 'One account joins the agents on every device you own into one private network.',
      },
      points: [
        {
          'zh-TW':
            '看得到你的裝置：登入同一個帳號，就能看到哪些機器在線、各自開了哪些 agent、在忙什麼。',
          'en-US':
            'See your machines: sign in on each one and you can tell which are online, which agents they are running, and what those agents are doing.',
        },
        {
          'zh-TW':
            '跨裝置派工：這台的 agent 可以直接對另一台的 agent 下指令、等它回話，就像它們在同一台機器上。',
          'en-US':
            'Hand work across devices: an agent here can instruct an agent there and wait for its answer, as if they shared a machine.',
        },
        {
          'zh-TW':
            '六位數確認才算數：配對時兩台機器各自算出同一組六位數，兩邊都按「一致」才建立信任——中間人做不出這組數字。',
          'en-US':
            'Six digits, confirmed at both ends: pairing shows the same six digits on both machines and trusts neither until both people say they match — a relay cannot produce them.',
        },
        {
          'zh-TW':
            '內容只有你們讀得到：跨裝置訊息端對端加密後才離開本機，伺服器只搬密文；私鑰、絕對路徑與終端機畫面從不上傳。',
          'en-US':
            'Only the two ends can read it: cross-device messages are encrypted before they leave your machine and the server only relays ciphertext. Private keys, absolute paths and terminal output never leave.',
        },
        {
          'zh-TW':
            '預設誰都不准：外來訊息一律拒收，除非你寫下規則放行；封鎖優先於一切規則，連你自己的裝置也擋。',
          'en-US':
            'Nothing is allowed by default: messages from other devices are refused until a rule of yours allows them, and a block outranks every rule — including one for your own machines.',
        },
      ],
    },
    highlights: [
      {
        'zh-TW':
          'MCP 新增四個工具：cli_interrupt（中止對方正在跑的回合）、cli_whoami（問自己是誰）、cli_read_incoming（讀收件匣）、cli_cancel_message（收回還沒送達的訊息）。cli_open_agent 現在也能指定模型與推理強度。',
        'en-US':
          'Four new MCP tools: cli_interrupt (stop a turn in progress), cli_whoami, cli_read_incoming, and cli_cancel_message (take back a message that has not landed). cli_open_agent can now pick the model and reasoning effort.',
      },
      {
        'zh-TW':
          '側欄血緣導軌：分格依「誰開出誰」畫出連續的分支軌，滑過會整條亮起；執行群組列改為黏頂區段標題，附自己的 ＋ 按鈕。',
        'en-US':
          'Sidebar lineage rails: panes are drawn on continuous branch rails showing which opened which, with the whole trunk highlighting on hover. Run-group rows became sticky section headers with their own ＋.',
      },
      {
        'zh-TW':
          '關閉分格前先提醒：還在跑的回合、排隊中的訊息、以及會一起消失的子分格，會在你按下關閉前列出來。',
        'en-US':
          'Advice before you close a pane: an active turn, queued messages, and child panes that would go with it are listed before the pane closes.',
      },
      {
        'zh-TW':
          '終端機拿回控制終端：PTY 子行程現在有自己的 controlling terminal，sudo 密碼提示、Ctrl+C 與視窗縮放通知都恢復正常。',
        'en-US':
          'Panes get a controlling terminal: PTY children now own one, which restores sudo password prompts, Ctrl+C, and resize notifications.',
      },
      {
        'zh-TW':
          '狀態徽章可自訂：Settings 新增徽章分頁，色盤與文字都能改；分頁狀態圓點改為方形，與側欄群組記號一致。',
        'en-US':
          'Customizable status badges: a new settings pane for badge palettes and labels, and the tab status dot is now square to match the sidebar group key.',
      },
      {
        'zh-TW':
          '關閉 App 有畫面了：退出流程會顯示進度覆蓋層，讓你看到它正在收尾而不是卡住。',
        'en-US':
          'Quitting shows its work: a shutdown overlay reports the teardown sequence instead of leaving the window looking frozen.',
      },
      {
        'zh-TW':
          '本機攻擊面收斂：CLI hook 端點、HTTP 檔案路由與 MCP 伺服器清單全部改為需要驗證，並封掉兩條路徑穿越與非 loopback 的 Host 標頭。',
        'en-US':
          'A smaller local attack surface: CLI hook endpoints, HTTP file routes and the MCP server list all require authentication now, and two path-traversal bypasses plus non-loopback Host headers are refused.',
      },
      {
        'zh-TW':
          '啟動與重繪更省：活動掃描只看有分格在跑的工作區、分格檢視不再重複重繪、WebGL 游標閃爍計時器不再洩漏，較重的對話框改為閒置時預先載入。',
        'en-US':
          'Lighter startup and redraw: activity scanning is scoped to workspaces with live panes, unchanged pane views skip re-render, the WebGL cursor-blink timer no longer leaks, and heavy modals prewarm while idle.',
      },
      {
        'zh-TW':
          '計畫文件可封存：新增 plan_archive 工具、封存區段與批次封存，完成的計畫不再擠在清單裡。',
        'en-US':
          'Plans can be archived: a plan_archive tool, an archived section, and batch archiving keep finished plans out of the list.',
      },
    ],
    note: {
      'zh-TW':
        '要開始使用 Navide Cloud：點標題列右上角的雲朵圖示登入，在另一台裝置登入同一個帳號，然後在兩邊按「配對」並核對那六位數。沒有登入的話，這一版的其他功能完全不受影響。',
      'en-US':
        'To start using Navide Cloud: click the cloud mark in the titlebar and sign in, sign in to the same account on another device, then press Pair on both and check the six digits match. Everything else in this release works exactly the same if you never sign in.',
    },
  },
  {
    version: '0.1.93',
    title: {
      'zh-TW': 'Git 插件 Manifest v2 遷移、MCP 核心模組化、插件主題即時同步與 UI 控制增強',
      'en-US': 'Git Plugin Manifest v2 Runtime, Modular MCP Core, Plugin Theme Sync & UI Control',
    },
    highlights: [
      {
        'zh-TW':
          'Git 插件 Manifest v2 架構遷移：全面切換至 Manifest v2 插件沙盒運行時，支援持久化儲存分區與獨立 Host/Plugin 傳輸適配層。',
        'en-US':
          'Git Plugin Manifest v2 Migration: fully cut over to Manifest v2 isolated sandbox runtime with durable storage partitioning and decoupled transport adapters.',
      },
      {
        'zh-TW':
          'MCP 核心伺服器模組化解耦：將 MCP 伺服器核心抽離至獨立模組，計畫（Plan）工具改由插件透過標準擴充點註冊。',
        'en-US':
          'Modular MCP Server Architecture: decoupled the core MCP server into dedicated modules with plan tools registered cleanly via plugin extension points.',
      },
      {
        'zh-TW':
          '插件 WebView 即時主題同步：主進程在 Guest WebView 附加時自動同步 Host 主題與外觀變更，徹底解耦 Preload 全局橋接。',
        'en-US':
          'Plugin WebView Theme Synchronization: main process automatically syncs host theme states and switch events to guest webviews upon attachment.',
      },
      {
        'zh-TW':
          '外部 MCP UI 快照與目標工作區過濾：ui_snapshot 與 ui_diagnostics 工具支援精準指定目標工作區路徑，強化多視窗自動化控制。',
        'en-US':
          'Target Workspace Filtering for UI MCP: ui_snapshot and ui_diagnostics tools now support targeting specific workspace paths across multi-window setups.',
      },
      {
        'zh-TW':
          '側邊欄工作區拖曳與層級縮排優化：完善多工作區拖曳分離為獨立視窗的手勢反饋，並修復子分格折疊導軌與縮排對齊。',
        'en-US':
          'Sidebar Workspace Drag-Out & Lineage Rails: enhanced gestures for dragging workspaces into standalone windows and resolved lineage rail indentation alignment.',
      },
      {
        'zh-TW':
          'Git 左側面板佈局與剪貼簿路徑安全修復：修復左側面板 Flex 容器排版防止區塊裁切，並淨化拖放檔案名稱避免輸入重試遺失。',
        'en-US':
          'Git Panel Flex Layout & Drag-Drop Path Sanitization: fixed column flex layout preventing clipped panel sections and sanitized dropped file paths.',
      },
    ],
  },
  {
    version: '0.1.92',
    title: {
      'zh-TW': '終端 @ 提及選單、原生 MCP/Memory 管理、Prompt Skills 與縮放重排優化',
      'en-US': 'Terminal @-Mention Menu, Native MCP & Memory Panes, Prompt Skills & Resize Reflow Fixes',
    },
    highlights: [
      {
        'zh-TW':
          '終端 @ 提及選單與冷還原修復：在終端輸入 @ 即時彈出跨分格與上下文候選選單，並修復冷還原分格註冊 handle 與深淺主題固定色盤適配。',
        'en-US':
          'Terminal @-Mention Menu & Lazy Restore Fix: popup mention menu for panes and context autocomplete on @, with lazy restore handle registration and terminal palette styling.',
      },
      {
        'zh-TW':
          '原生 MCP 伺服器與 Native Memory 管理分格：獨立視覺化分格支援 MCP 伺服器健康檢查、工具調用診斷與系統進程記憶體即時採樣分析。',
        'en-US':
          'Native MCP & Memory Management: dedicated visual panes for MCP server health diagnostics, tool inspection, and kernel-level memory monitoring.',
      },
      {
        'zh-TW':
          'Prompt Skills 懸浮技能選取器：終端頂部新增技能快捷輪播選單，支援懸浮預覽與一鍵施放常用 Prompt 技能。',
        'en-US':
          'Prompt Skills Hover Picker: quick carousel menu for invoking and previewing reusable prompt skills directly from the terminal.',
      },
      {
        'zh-TW':
          '終端寬度縮放雙層競態修復：引入 Ack Barrier 與 Generation Guard，徹底消除視窗縮放與 TUI 寬度重排時的畫面殘留問題。',
        'en-US':
          'Terminal Resize Reflow Dual-Race Fix: incorporates ack barrier and generation guard to prevent resize race conditions and frame residue.',
      },
      {
        'zh-TW':
          'Droid (Factory) CLI 正式整合：新增 Droid 官方支援，支援參數自訂、日誌串流與獨立進程生命週期管理。',
        'en-US':
          'Droid (Factory) CLI Vendor: official Droid integration with tailored settings, log streaming, and lifecycle management.',
      },
      {
        'zh-TW':
          'Preview 預覽面板日誌與 MCP 遠端讀取：環形緩衝區自動捕獲 Console 與 Network 請求，並提供 MCP 診斷工具。',
        'en-US':
          'Preview Console/Network Ingestion & MCP Tools: ring-buffer log capture for preview panels with remote MCP inspection tools.',
      },
    ],
  },
  {
    version: '0.1.91',
    title: {
      'zh-TW': '全新資源管理器、背景子代理追蹤、Loop 迴圈等待退避與日誌防護',
      'en-US': 'Resource Manager, Background Subagent Tracking, Loop Wait Backoff & Log Stability',
    },
    highlights: [
      {
        'zh-TW':
          '全新資源管理器 (Resource Manager)：整合 CPU 佔用、記憶體與 Token 消耗即時監控，支援全局分格跳轉與閒置回收。',
        'en-US':
          'Unified Resource Manager: real-time CPU, memory, and token monitoring with cross-window pane jumping and idle reclaim.',
      },
      {
        'zh-TW':
          '背景子代理追蹤與 Loop 等待退避：支援 <<LOOP_WAIT>> 標記與階梯式退避，精準識別子代理執行狀態，防止迴圈空轉。',
        'en-US':
          'Subagent Tracking & Loop Wait Backoff: supports <<LOOP_WAIT>> markers and tiered backoff to prevent loops from spinning on background tasks.',
      },
      {
        'zh-TW':
          '工作區多視窗拖曳交接：側邊欄工作區標題支援拖曳至獨立新視窗，無縫移交運作中的 Agent 會話。',
        'en-US':
          'Workspace Detach Gesture: drag workspace headers out to their own windows without interrupting active agent processes.',
      },
      {
        'zh-TW':
          '日誌讀取與回合結束訊號防護：修復未完成行導致 High-Water Mark 提前推進的問題，確保回合結束訊號不遺失。',
        'en-US':
          'Log Ingestion & Turn-End Protection: prevents half-written log lines from prematurely advancing watermarks and dropping turn ends.',
      },
      {
        'zh-TW':
          'Claude 配額直接查詢：改採 Print 模式直接非同步執行獲取額度與原因，消除終端模擬輸入的延遲與誤報。',
        'en-US':
          'Claude Quota Direct Probing: fetches Claude quotas directly via print mode, eliminating PTY input lag and false errors.',
      },
    ],
  },
  {
    version: '0.1.90',
    title: {
      'zh-TW': '終端 PTY 二進位幀串流傳輸與後端日誌探索效能優化',
      'en-US': 'Terminal PTY Binary Frame Streaming & Background Rescan Performance',
    },
    highlights: [
      {
        'zh-TW':
          '終端 PTY 二進位幀傳輸：終端輸出全面改採 WebSocket Binary Frame 串流，避免 JSON 字串編碼與轉義負擔，巨量輸出更加極速流暢。',
        'en-US':
          'PTY Binary Frame Streaming: terminal outputs now stream over WebSocket binary frames, eliminating JSON escaping overhead for high-speed terminal throughput.',
      },
      {
        'zh-TW':
          '後端檔案探索非同步化：日誌監控（LogWatcher）磁碟檔案探索全面移至背景執行緒，徹底杜絕大型專案下的主事件循環延遲。',
        'en-US':
          'Non-blocking Rescan Discovery: moves disk session discovery into background threads, keeping the main asyncio event loop completely responsive.',
      },
    ],
  },
  {
    version: '0.1.89',
    title: {
      'zh-TW': '官方 Brand 視覺升級、Git 多倉庫選擇器、靜音閒置回收與品質守衛',
      'en-US': 'Official Brand Assets, Git Multi-Repo Selector, Quiet Idle Sweep & Quality Gates',
    },
    highlights: [
      {
        'zh-TW':
          '官方 Brand Assets 視覺升級：全新深淺色 Logo、向量 SVG、macOS Canvas 規範應用程式圖標與多尺寸 Web Favicon。',
        'en-US':
          'Official Brand Assets: new light/dark logos, vector SVGs, macOS canvas icons, and multi-size web favicons.',
      },
      {
        'zh-TW':
          'Git 多倉庫選擇器：工作區包含多個 Git 倉庫時，Git 面板支援下拉快速切換當前焦點儲存庫。',
        'en-US':
          'Git Multi-Repo Selector: easily switch between repositories in multi-repository workspaces directly within the Git pane.',
      },
      {
        'zh-TW':
          '定時閒置回收靜音：背景定時掃描並回收長時間閒置的 CLI 終端時僅記錄於日誌，不再彈出打擾 Toast 提示。',
        'en-US':
          'Quiet Idle Sweep: background timed idle sweeps log quietly without popping up disruptive toast notifications.',
      },
      {
        'zh-TW':
          'WebSocket 指數退避重連：WebSocket 連線中斷時自動依指數退避策略重試連線（1.5s 至 30s）。',
        'en-US':
          'WebSocket Exponential Reconnect: automatic reconnection with exponential backoff on dropped WebSocket connections.',
      },
      {
        'zh-TW':
          'Ruff 靜態分析與發布守衛：發布流程正式引入 Ruff ASYNC 與 F821 規則檢查，嚴防未定義變數與 Event Loop 阻塞。',
        'en-US':
          'Release Quality Gates: integrates Ruff ASYNC and F821 checks into release gates to guard against unhandled imports and loop stalls.',
      },
    ],
  },
  {
    version: '0.1.88',
    title: {
      'zh-TW': '後端 Event Loop 延遲監控、視窗最小尺寸防護與 Kimi 延遲優化',
      'en-US': 'Event-Loop Latency Watchdog, Window Minimum Dimensions & Kimi TUI Optimization',
    },
    highlights: [
      {
        'zh-TW':
          'Event Loop 延遲監控看門狗：每秒探測後端排程延遲，及時發現並記錄潛在的長耗時操作。',
        'en-US':
          'Event-Loop Latency Watchdog: monitors and logs backend scheduling latency to catch blocking operations early.',
      },
      {
        'zh-TW':
          '視窗最小尺寸限制：為桌面視窗設定合理的最小寬高防護，避免過度縮小導致介面擠壓。',
        'en-US':
          'Window Minimum Dimensions: enforces minimum window bounds to prevent layout distortion when resized small.',
      },
      {
        'zh-TW':
          'Kimi CLI 退出鍵瞬間響應：預設配置 escape sequence 延遲時間，消除 Kimi TUI 介面下的選單切換延遲。',
        'en-US':
          'Kimi TUI Esc Sequence Fix: configures escape timeouts so menu and navigation keys respond immediately.',
      },
      {
        'zh-TW':
          'Git 倉庫受限掃描時間：大型或網路檔案系統上的倉庫探索加入時間預算，不阻塞後端事件循環。',
        'en-US':
          'Bounded Git Discovery: bounds filesystem repository discovery scans with a timeout budget to keep the backend responsive.',
      },
    ],
  },
  {
    version: '0.1.87',
    title: {
      'zh-TW': '工作區 Slot 佈局、檔案預覽面板、Process 記憶體探針與閒置回收',
      'en-US': 'Workbench Layout Model, File Previews, Process Memory Probes & Idle Reclaim',
    },
    highlights: [
      {
        'zh-TW':
          '工作區 Slot 自訂佈局：支援左/右/底側欄自訂槽位與快捷鍵折疊切換。',
        'en-US':
          'Workbench Layout Model: custom slot containers across left, right, and bottom panels with collapse shortcuts.',
      },
      {
        'zh-TW':
          '檔案與產物預覽面板：支援 Markdown、HTML 與程式碼片段即時預覽，以及 Diff 唯讀檢視。',
        'en-US':
          'File & Artifact Previews: inline rendering for Markdown, HTML, code snippets, and Diff views.',
      },
      {
        'zh-TW':
          '後端 Process 記憶體探針：狀態列即時顯示後端與終端記憶體佔用與 Token 詳細統計。',
        'en-US':
          'Process Memory Telemetry: status bar popovers with real-time memory usage and token usage breakdowns.',
      },
      {
        'zh-TW':
          '終端長時間閒置回收：自動回收長時間無操作的 CLI 分格釋放系統記憶體，支援點擊一鍵恢復。',
        'en-US':
          'Terminal Idle Reclaim: automatically reclaims memory from long-idle CLI processes with one-click restore.',
      },
    ],
  },
  {
    version: '0.1.86',
    title: {
      'zh-TW': '階段分頁狀態燈號、⌘W 彈窗關閉優化、剪貼簿貼上防禦與 Dev 正式版隔離',
      'en-US': 'Stage Tab Status Dots, ⌘W Modal Close, Paste Timeout Defense & Dev/Prod Isolation',
    },
    highlights: [
      {
        'zh-TW':
          'StageTabBar 狀態燈號：頂部階段標籤新增彩色動態狀態燈號與 Tooltip，即時匯總該階段所有 Agent 的運行、提問等待或錯誤狀態。',
        'en-US':
          'Stage Tab Status Dots: stage tabs show live color status dots and tooltips summarizing running, awaiting question, or error states across all agents in that stage.',
      },
      {
        'zh-TW':
          '⌘W 彈窗關閉與防誤觸確認：按 ⌘W 優先關閉最上層 Modal 彈窗；關閉閒置 CLI 分格前新增防誤觸確認與「不再詢問」選項。',
        'en-US':
          '⌘W Modal Close & Pane Protection: ⌘W prioritizes closing open modals; closing idle panes includes a confirmation dialog with a "Don\'t ask again" option.',
      },
      {
        'zh-TW':
          '剪貼簿貼上防禦與逾時延長：延長 Paste ACK 逾時至 60 秒，避免 Agent 高負載輸出時誤報貼上遺失，精準區分逾時與真實傳輸中斷。',
        'en-US':
          'Paste Timeout Defense: extends paste ACK timeout to 60s to prevent false paste failure warnings during heavy terminal bursts.',
      },
      {
        'zh-TW':
          'Dev 與正式版全域隔離：Dev 模式主動保護正式版全域 Hooks 與日誌流，避免多實例搶佔端口與背景卡死。',
        'en-US':
          'Dev & Production Isolation: dev mode preserves production hooks and bounds startup scans so dev and production can run side-by-side without interference.',
      },
      {
        'zh-TW':
          'Manifest v2 外掛架構升級：支援 Combined 前後端外掛規範、發布者信任驗證、Shell Broker 與能力授權機制。',
        'en-US':
          'Manifest v2 Plugin Architecture: full support for combined frontend/backend plugins, publisher trust validation, and Shell Broker capability grants.',
      },
    ],
  },
  {
    version: '0.1.85',
    title: {
      'zh-TW': '外掛平台 Manifest v2 升級、發布者信任驗證與 Shell Broker 安全授權',
      'en-US': 'Manifest v2 Plugin Platform, Publisher Trust & Shell Broker Capability Grants',
    },
    highlights: [
      {
        'zh-TW':
          'Manifest v2 外掛架構：支援前後端組合（Combined）與後端專用外掛規範，外掛與主程式版本嚴格解耦。',
        'en-US':
          'Manifest v2 Plugin Platform: supports combined frontend/backend plugins and backend-only manifests decoupled from core versions.',
      },
      {
        'zh-TW':
          '發布者信任與能力授權：引進外掛發布者金鑰簽署與 Shell Broker 權限授權，確保外掛環境執行安全。',
        'en-US':
          'Publisher Trust & Capability Grants: introduces publisher signature checks and Shell Broker capability grants for hermetic plugin execution.',
      },
    ],
  },
  {
    version: '0.1.84',
    title: {
      'zh-TW': 'CLI 互傳訊息：投遞失敗回報、Claude Stop hook 直送、打字時暫緩投遞',
      'en-US': 'Inter-CLI Messaging: Delivery-Failure Notices, Claude Stop-Hook Hand-Over & Typing Hold',
    },
    highlights: [
      {
        'zh-TW':
          '投遞失敗回報：訊息送不到時，寄件分格會收到一則 `[Navide MSG] delivery failed` 系統通知，說明目標與原因。',
        'en-US':
          'Delivery-failure notices: when a message cannot be delivered, the sending pane receives a `[Navide MSG] delivery failed` notice naming the target and the reason.',
      },
      {
        'zh-TW':
          'Claude Stop hook 直送：Claude 分格回合結束時若有訊息在等，會直接經由 Stop hook 交給 agent 當下一步指令，完全不經過輸入框。',
        'en-US':
          'Claude Stop-hook hand-over: a message waiting for a Claude pane is handed to the agent as its next instruction when its turn ends, without ever touching the input box.',
      },
      {
        'zh-TW':
          '打字時暫緩投遞與整段貼上：目標分格有人在輸入時訊息會顯示為「輸入中」暫緩，注入一律以 bracketed paste 整段送入，不再打斷你打到一半的提示。',
        'en-US':
          'Typing hold & whole-paste injection: delivery waits while someone is typing in the target pane, and injections land as a single bracketed paste so a half-written prompt is never submitted with them.',
      },
      {
        'zh-TW':
          '訊息種類持久化與系統通知標章：訊息記錄面板會記住每則訊息的種類，系統通知重新載入後仍顯示「系統通知」標章。',
        'en-US':
          'Kind persistence & system-notice badge: the message log remembers each message\'s kind, so system notices keep their "system notice" badge across reloads.',
      },
    ],
  },
  {
    version: '0.1.83',
    title: {
      'zh-TW': '自訂快捷鍵編輯器、多面板批量拖曳與 CLI 提問狀態提示',
      'en-US': 'Custom Keybindings Editor, Multi-Pane Batch Dragging & QUESTION Status Badge',
    },
    highlights: [
      {
        'zh-TW':
          '自訂快捷鍵編輯器：重構全域快捷鍵系統並提供 Keybindings 編輯器，支援按鍵錄製、衝突偵測與一鍵恢復預設值。',
        'en-US':
          'Custom Keybindings Editor: overhauled keybinding engine with an interactive editor supporting live key recording, conflict detection, and default resets.',
      },
      {
        'zh-TW':
          '多分格批量拖曳與 Drop 貼上：支援 Shift 多選分格批量拖曳與 Ghost 懸浮圖示，可一次性拖入終端機貼上批量 @mention 標籤。',
        'en-US':
          'Multi-pane batch dragging & dropping: Shift-select multiple agent panes to drag with a ghost image and drop all @mention tags into terminals at once.',
      },
      {
        'zh-TW':
          'CLI 提問 QUESTION 標章與通訊優化：Agent 在終端等待提問回答時自動切換為橙色 QUESTION 標章，並優化 Agent 跨工作區通訊與訊息日誌持久化。',
        'en-US':
          'QUESTION badge & agent messaging: displays an orange QUESTION badge when an agent awaits input, with persistent agent message logging across workspaces.',
      },
    ],
  },
  {
    version: '0.1.82',
    title: {
      'zh-TW': 'Agents 側邊欄分頁獨立、未註冊帳號自動歸併與 Git Unstage 容錯優化',
      'en-US': 'Dedicated Agents sidebar tab, automatic account registration/deduplication & resilient Git unstage',
    },
    highlights: [
      {
        'zh-TW':
          'Agents 側邊欄分頁獨立：將代理人列表獨立為標籤分頁（⌘1 Agents、⌘2 Pipeline、⌘3 Explorer、⌘4 Git、⌘5 Plans），享有全高度獨佔捲動空間。',
        'en-US':
          'Dedicated Agents sidebar tab: split the agents list into its own tab (⌘1 Agents, ⌘2 Pipeline, ⌘3 Explorer, ⌘4 Git, ⌘5 Plans) with full-height scrollable space.',
      },
      {
        'zh-TW':
          '帳號自動註冊與重複去重：偵測到本機外部 CLI 登入自動建立 Profile 進行管理，並對同信箱多重登入自動去重歸併，保持選單簡潔。',
        'en-US':
          'Automatic account registration & deduplication: automatically creates profiles for new CLI logins and folds duplicate same-email credentials into single profiles.',
      },
      {
        'zh-TW':
          'Plan MCP 鑑權與 Git Unstage 容錯：Plan MCP 服務加入 Token 安全鑑權；Git 面板取消暫存（Unstage）自動過濾過期路徑並進行容錯重試。',
        'en-US':
          'Plan MCP auth & resilient Git unstage: added token security for Plan MCP server and auto-filtered stale pathspec retries on Git unstage actions.',
      },
    ],
  },
  {
    version: '0.1.81',
    title: {
      'zh-TW': '外部 CLI 憑證自動監控同步、Terminal 滾動無痕狀態與 Meta Muse Code Agent 支援',
      'en-US': 'Automatic credential sync watcher, smooth terminal scroll activity & Meta Muse Code CLI support',
    },
    highlights: [
      {
        'zh-TW':
          '外部 CLI 憑證自動監控同步：新增背景 Credential Watcher 服務，本機外部 CLI 登入或 Token 變更時自動同步寫入 Vault 快取與帳號切換面板。',
        'en-US':
          'Automatic credential sync watcher: added a background Credential Watcher service that syncs external CLI login changes into the profile vault and account switcher instantly.',
      },
      {
        'zh-TW':
          'Terminal 滾動活動時間繼承：優化終端機滾動狀態，長滾動期間活動時間戳記自動繼承，防止查看歷史紀錄時 RUNNING 狀態標籤誤閃為 IDLE。',
        'en-US':
          'Smooth terminal scroll activity: activity timestamps carry forward during sustained scrolling, preventing the RUNNING badge from flickering to IDLE while browsing history.',
      },
      {
        'zh-TW':
          'Meta Muse Code Agent 支援：新增對 Meta Muse Code CLI Agent 的選單支援、啟動與安裝檢測，並完備 CLI Vendor 開發手冊。',
        'en-US':
          'Meta Muse Code Agent support: added menu options, spawn detection, and installer checks for the Meta Muse Code CLI agent.',
      },
    ],
  },
  {
    version: '0.1.80',
    title: {
      'zh-TW': 'LLM 智慧分格命名、Copilot/Qwen Hooks 路由與 WebGL 終端加速',
      'en-US': 'LLM-assisted Pane Naming, Copilot/Qwen Hooks & WebGL Terminal Acceleration',
    },
    highlights: [
      {
        'zh-TW':
          'LLM 智慧標題命名與平滑升級：首回合對話完成後自動請求本地模型生成高適配性分格標題，並在不干擾使用者自訂命名的前提下平滑升級分格名稱。',
        'en-US':
          'LLM-assisted pane naming: automatically generates relevant pane titles using local models after the first turn and smoothly upgrades panel labels without overwriting custom renames.',
      },
      {
        'zh-TW':
          'Copilot / Qwen Hooks 路由與 Plan MCP 隔離：新增 Copilot 與 Qwen CLI 專屬 Hook 路由 Endpoint；Plan MCP Server 支援獨立目錄隔離與權限保護。',
        'en-US':
          'Copilot/Qwen CLI hooks & Plan MCP isolation: added dedicated hook endpoint routes for Copilot and Qwen CLI; isolated Plan MCP server homes with permission security.',
      },
      {
        'zh-TW':
          'WebGL 終端渲染加速與輸入緩衝：Terminal 支援 WebGL 硬體加速渲染，並新增 prepareGate 輸入緩衝防護，防止啟動準備階段丟失輸入按鍵。',
        'en-US':
          'WebGL terminal acceleration & input buffering: enabled WebGL hardware-accelerated rendering in Terminal with prepareGate input buffering during pane startup.',
      },
    ],
  },
  {
    version: '0.1.79',
    title: {
      'zh-TW': '剪貼簿圖片貼上轉檔、拖曳路徑轉義優化與 Agent 總覽詳情面板',
      'en-US': 'Clipboard image-to-file paste, escaped drop paths & Agent Overview panel',
    },
    highlights: [
      {
        'zh-TW':
          '剪貼簿截圖與拖曳路徑轉義：⌘V 貼上剪貼簿截圖自動寫入實體檔（`userData/dropped-files/`）；拖曳檔案自動使用斜線轉義格式，便於 CLI Agent 直接掃描識別。',
        'en-US':
          'Clipboard screenshot paste & escaped drop paths: ⌘V pasting a screenshot saves a real image file under `userData/dropped-files/`; dragged paths use backslash escaping for instant CLI agent scanning.',
      },
      {
        'zh-TW':
          'Agent 狀態總覽與狀態列面板互斥：新增 Agent 總覽面板 (`AgentOverviewPanel`) 與時間詳情面板 (`ClockPanel`)，狀態列 Popover 具備互斥開啟機制，且 UsageBadge 支援 Esc/Blur 自動關閉防護。',
        'en-US':
          'Agent Overview & status-bar popover management: added AgentOverviewPanel and ClockPanel, mutually exclusive status-bar popovers, and Esc/blur auto-dismissal for UsageBadge.',
      },
      {
        'zh-TW':
          '對話記錄保護與重連 Session 標題繼承：修復從 Claude/Grok 環境啟動 Navide 時對話紀錄遺失問題，並在恢復舊 Session 時自動繼承面板 `auto_name` 標籤。',
        'en-US':
          'Transcript protection & session auto-name inheritance: fixed transcript loss when launching inside Claude/Grok environments, and carried `auto_name` labels on session resumes.',
      },
    ],
  },
  {
    version: '0.1.78',
    title: {
      'zh-TW': '對話記錄遺失修復、跨工作區訊息持久化與 CLI 後端一家一檔重構',
      'en-US': 'Transcript-loss fix, cross-workspace message persistence & per-vendor CLI backend',
    },
    highlights: [
      {
        'zh-TW':
          '修復無聲對話遺失：從 Claude Code 環境裡啟動 Navide 時，分格會繼承子 session 標記而靜默停寫對話記錄，重啟後分格變空白。後端現於啟動時剝除該標記（並防禦 Grok 同型標記），對話記錄保證落盤。',
        'en-US':
          'Fixed silent transcript loss: launching Navide from inside a Claude Code environment made panes inherit a child-session marker and silently stop writing transcripts (blank panes after restart). The backend now strips the marker at startup (plus Grok’s equivalents), so transcripts always persist.',
      },
      {
        'zh-TW':
          '跨工作區 CLI 訊息升級：訊息紀錄改用 SQLite v2 結構持久化、跨工作區外送追蹤與重連補水，並新增狀態列公告面板與版本/時鐘顯示。',
        'en-US':
          'Cross-workspace CLI messaging upgrade: message logs persist in a SQLite v2 schema with outbound tracking and reconnect hydration, plus a new status-bar announcements panel and version/clock chips.',
      },
      {
        'zh-TW':
          '終端效能與架構整併：PTY 生命週期改用獨立執行緒池並一次汲取讀取緩衝（長輸出更順）；後端 CLI 程式碼完成「一家一檔」重構（12 家各自獨立模組 + 統一 registry），新增 CLI 支援從此只需一個檔案。',
        'en-US':
          'Terminal performance & architecture: PTY lifecycle moved to an isolated thread pool with drained reads (smoother long outputs); the CLI backend finished its one-file-per-vendor refactor (12 self-contained vendor modules + a single registry), so adding a CLI now takes one file.',
      },
    ],
  },
  {
    version: '0.1.77',
    title: {
      'zh-TW': '三方 Git 衝突解決面板、預設外部編輯器路由與 DebugModal 診斷視窗',
      'en-US': '3-way Git conflict resolution pane, default external editor routing & DebugModal diagnostics',
    },
    highlights: [
      {
        'zh-TW':
          '三方 Git 衝突視覺化解決與外掛相容：新增 ConflictPane 能直接讀取 Git Index 三方 Merge Stages，高亮標記衝突解決與即時切換，並完全對映給外掛與獨立編輯器視窗。',
        'en-US':
          '3-way Git conflict resolution & plugin compatibility: added ConflictPane with direct Git Index merge stages reading, highlight resolve actions, and full mapping to plugins and standalone windows.',
      },
      {
        'zh-TW':
          '預設外部編輯器與快速鍵操作提升：可選擇 VS Code / Cursor 等為預設外部編輯器並支援開啟專案資料夾；新增 Ctrl+Tab 分格切換與 ⌘⇧L 系統診斷工具 DebugModal。',
        'en-US':
          'Default external editor & keybindings overhaul: choose VS Code or Cursor as your default editor with Open Folder support; added Ctrl+Tab pane cycling and ⌘⇧L DebugModal diagnostics.',
      },
      {
        'zh-TW':
          'CLI 訊息傳遞擴充與自動退避防禦：補齊 Grok、Kimi、Pi、Qwen 的訊息轉發與 Copilot/OpenCode/Kilo 的 Plan MCP 自動掛載，並新增 CLI 停滯 (Stall) 退避與帳號切換快取保護。',
        'en-US':
          'Expanded CLI messaging & stall protection: added turn-text messaging for Grok, Kimi, Pi, Qwen and Plan MCP wiring for Copilot/OpenCode/Kilo, plus CLI stall backoff and parked account cache preservation.',
      },
    ],
  },
  {
    version: '0.1.76',
    title: {
      'zh-TW': 'Claude CLI 用量讀取優化、自動更新 Pipeline 與安穩關機保護',
      'en-US': 'Claude CLI usage panel integration, update pipeline UI & robust app shutdown',
    },
    highlights: [
      {
        'zh-TW':
          'Claude CLI 直接面板讀取與帳號容錯：改由直接驅動 Claude CLI 內建用量面板讀取額度，徹底避免輪詢時 Token 旋轉問題，並能自動偵測被本機清空的失效憑證。',
        'en-US':
          'Claude CLI panel scraping & credential resilience: directly reads usage from Claude CLI without rotating OAuth refresh tokens, with automatic detection of wiped credentials.',
      },
      {
        'zh-TW':
          '自動更新 Pipeline 視覺化與確認還原：新增「檢查 ➔ 下載 ➔ 安裝」三階段進度條，並在更新安裝異常或逾時時自動復原使用者設定的「關閉 App 確認」視窗。',
        'en-US':
          'Visual update pipeline & quit confirmation recovery: added 3-stage update pipeline indicators and restored quit confirmation dialogs when an install fails or times out.',
      },
      {
        'zh-TW':
          '依賴安裝連鎖鏈與 Terminal IME 輸入優化：CLI 安裝對話框支援自動接續連鎖安裝步驟，並優化 Terminal 在輸入法 (IME) 及視窗切換時的 Focus 清除與狀態復原。',
        'en-US':
          'Sequential dependency installer & Terminal IME focus fixes: automated multi-step CLI dependency installation and resolved focus/IME state leakage during terminal pane disposal.',
      },
    ],
  },
  {
    version: '0.1.75',
    title: {
      'zh-TW': '跨工作區 Agent 通訊與定址系統',
      'en-US': 'Cross-workspace Agent addressing & inter-agent messaging',
    },
    highlights: [
      {
        'zh-TW':
          '跨工作區 CLI 定址與 MCP 工具：發布跨工作區通訊註冊表，將 CLI 訊息傳送包裝為 MCP 工具，實現跨視窗、跨工作區 Agent 之間的無縫對話。',
        'en-US':
          'Cross-workspace CLI addressing & MCP tools: introduced a global addressing registry exposing inter-agent messaging as MCP tools for cross-window collaboration.',
      },
      {
        'zh-TW':
          '拖曳分格 @ 定址輸入：支援將遠端視窗或頁籤分格直接拖曳至 "@" 提及輸入框，自動帶入其全區目標位址。',
        'en-US':
          'Drag-to-mention @ addressing: drag any remote pane onto the "@" mention box to automatically insert its fully qualified address.',
      },
      {
        'zh-TW':
          '環境初始化與 Plan 加載強化：改善全新安裝時的依賴安裝順序與錯誤呈現，並優化 Plan 文件讀取的後端等待流程。',
        'en-US':
          'Onboarding & Plan loading fixes: refined dependency bootstrap ordering and plan document loading readiness.',
      },
    ],
  },
  {
    version: '0.1.74',
    title: {
      'zh-TW': 'Tasker 排程引擎與人性化 Cron 表達式文字',
      'en-US': 'Tasker scheduling engine & human-readable cron descriptions',
    },
    highlights: [
      {
        'zh-TW':
          'Cron 定時與循環任務：後端排程服務升級，支援 Cron 表達式定時觸發、單次與循環 Timer、以及 Max Iterations 最大執行次數限制。',
        'en-US':
          'Cron scheduling & recurring tasks: backend execution engine now supports cron expressions, one-shot/recurring timers, and max iteration bounds.',
      },
      {
        'zh-TW':
          'Tasker 控制介面：Tasker 面板新增直覺的 Cron 排程輸入框，動態顯示人性化中文/英文時間描述（例如「每 5 分鐘」）。',
        'en-US':
          'Tasker schedule UI: added intuitive cron controls with real-time human-readable time descriptions (e.g. "Every 5 minutes").',
      },
      {
        'zh-TW':
          '背景 Timer 邊界保護：強化背景排程 Timer 綁定與早期終止機制，確保逾時排程不佔用背景資源。',
        'en-US':
          'Protected background timers: hardened background timer binding and early termination to ensure idle schedules do not leak resources.',
      },
    ],
  },
  {
    version: '0.1.73',
    title: {
      'zh-TW': '模組化 CLI Agent 面板與互動能力全面升級',
      'en-US': 'Modular CLI Agent panel & interactive PTY capabilities',
    },
    highlights: [
      {
        'zh-TW':
          '全新 AiCliDock 面板：全面替換原本純文字 Chat 介面，為 mini-IDE、Git 與 Plans 外掛視窗帶入完全互動式、功能齊全的 CLI Agent 面板。',
        'en-US':
          'New AiCliDock panel: replaces legacy plain-text chat with a fully interactive CLI agent panel across mini-IDE, Git, and Plans windows.',
      },
      {
        'zh-TW':
          '外掛 PTY 互動能力管道：允許外掛視窗順暢呼叫互動式 PTY 能力，享受同主視窗級別的 Agent 互動與終端呈現。',
        'en-US':
          'Plugin PTY capability broker: pipes interactive PTY capabilities through the broker to grant plugin windows full main-window agent power.',
      },
      {
        'zh-TW':
          '後端架構輕量化：完全移除舊版 AI Chat 後端介面，專注於高效能、高穩定的原生 CLI Agent Engine。',
        'en-US':
          'Lightweight backend architecture: retired legacy AI chat backend surfaces to focus on high-performance native CLI agent engines.',
      },
    ],
  },
  {
    version: '0.1.72',
    title: {
      'zh-TW': '獨立視窗 AI 面板整合與極速終端回應',
      'en-US': 'Embedded AI chat in standalone windows & ultra-fast terminal response',
    },
    highlights: [
      {
        'zh-TW':
          '獨立視窗內建 AI Chat 面板：Git 與 Plan 獨立視窗全新整合 AI Chat 右側面板，並支援直接拖曳（Drag & Drop）Git 變更檔案列至終端機。',
        'en-US':
          'Embedded AI Chat in standalone windows: Git & Plan windows now feature an embedded AI Chat panel and support dragging file rows to terminals.',
      },
      {
        'zh-TW':
          'Git 視窗 Editorial Calm 介面重構：採用雜誌感簡潔視覺設計與折疊卡片排版，大幅提升工作區狀態與 Diff 閱讀舒適度。',
        'en-US':
          'Git window Editorial Calm redesign: fresh magazine-style layout and collapsible cards for cleaner working tree and diff reading.',
      },
      {
        'zh-TW':
          '終端機打字延遲大幅降低：優化 CLI 高速輸出時的輸入快取機制，打字回應與動態渲染更加順暢無卡頓。',
        'en-US':
          'Reduced typing latency: optimized input caching during heavy CLI streaming for smoother typing and dynamic rendering.',
      },
    ],
  },
  {
    version: '0.1.71',
    title: {
      'zh-TW': '終端隱藏頁籤渲染優化與 AI Chat CLI 引擎',
      'en-US': 'Hidden terminal tab rendering & CLI-driven AI chat',
    },
    highlights: [
      {
        'zh-TW':
          '隱藏頁籤終端尺寸快取：快取並持久化 Terminal 最佳行列尺寸，解決背景或開機還原時啟動 PTY 輸出繪製過窄且無法拉寬的問題。',
        'en-US':
          'Hidden terminal dimension caching: persists terminal dimensions so background PTYs start at realistic layout widths instead of narrow defaults.',
      },
      {
        'zh-TW':
          'AI Chat 改由 CLI 驅動：AI 聊天視窗改由底層 CLI Engine 驅動，大幅提升回應速度、並能自動回收僵死或孤兒 subprocess。',
        'en-US':
          'CLI-driven AI Chat: AI chat frontend now runs on the native CLI engine for higher stability, automatic orphan cleanup, and better resilience.',
      },
      {
        'zh-TW':
          'Git 獨立視窗與體驗改善：重構 Git 獨立視窗側邊欄為折疊卡片介面，修復 Cmd+C 終端複製、右鍵選取菜單與 Mouse-tracking 拖曳選取。',
        'en-US':
          'Git window & terminal UX: reworked Git window sidebar into collapsible cards, fixed Cmd+C terminal copying, context menu, and mouse text selection.',
      },
    ],
  },
  {
    version: '0.1.70',
    title: {
      'zh-TW': '多帳號憑證管理與系統穩定度提升',
      'en-US': 'Multi-account credentials & stability improvements',
    },
    highlights: [
      {
        'zh-TW':
          '多帳號憑證整合：CLI 憑證統一保管於真實 Home 目錄，支援帳號快速 Swap 切換，Codex 登入憑證自動提升至全域共享。',
        'en-US':
          'Unified multi-account credentials: CLI auth files now live in your real home directory with instant swap switching, and Codex logins auto-promote to shared auth.',
      },
      {
        'zh-TW':
          'CLI 重建安全防護：針對執行中的 CLI 按下 Rebuild/重構時增加二次確認彈窗，防止誤觸致使工作中 Task 中斷。',
        'en-US':
          'Safer CLI rebuilds: a confirmation dialog now protects running CLIs from accidental rebuilds while tasks are active.',
      },
      {
        'zh-TW':
          '獨立 Git 視窗與新手安裝優化：修復獨立 Git 視窗追蹤細節，並確保全新安裝時環境依賴檢測與自動安裝順暢完成。',
        'en-US':
          'Git window & onboarding fixes: refined follow-up interactions in standalone Git windows and hardened onboarding dependency setup.',
      },
    ],
  },
  {
    version: '0.1.69',
    title: {
      'zh-TW': '更新檢查更即時、滾輪捲動不再誤鎖 RUNNING 狀態',
      'en-US': 'More responsive update checks & scroll no longer latches the RUNNING badge',
    },
    highlights: [
      {
        'zh-TW':
          '自動更新檢查間隔由較長週期縮短為 30 分鐘，且開啟「自動檢查」時立刻重新檢查一次，不必等下一輪。',
        'en-US':
          'Background update checks now run every 30 minutes, and enabling auto-check re-checks immediately instead of waiting for the next cycle.',
      },
      {
        'zh-TW': '終端轉發的滾輪捲動不再被當成活動訊號，瀏覽歷史時 RUNNING 標籤不會被鎖住。',
        'en-US':
          'Wheel scrolls forwarded to the terminal no longer count as activity, so browsing history keeps the RUNNING badge from latching on.',
      },
      {
        'zh-TW': 'Agent 歷史載入時，對已無對應分格的項目補上移除時間戳，時間欄位不再空白。',
        'en-US':
          'Agent History stamps a removal time on load for entries with no live pane, so their timestamp column is no longer blank.',
      },
    ],
  },
  {
    version: '0.1.68',
    title: {
      'zh-TW': '儲存架構升級：更快、更可靠',
      'en-US': 'Storage upgrade: faster and more reliable',
    },
    highlights: [
      {
        'zh-TW':
          '你的設定、token 用量與工作區資料已自動搬入資料庫（SQLite）。搬移在首次啟動時自動完成，所有資料原樣保留，無需任何操作。',
        'en-US':
          'Your settings, token usage and workspace data now live in a database (SQLite). The move happens automatically on first launch — everything is preserved, nothing to do.',
      },
      {
        'zh-TW':
          '大幅降低磁碟寫入：token 記帳從每 10 秒重寫一份大檔，改為只寫入變動的部分（約 30 倍減少）。',
        'en-US':
          'Far less disk churn: token accounting now writes only what changed instead of rewriting a large file every 10 seconds (~30x less I/O).',
      },
      {
        'zh-TW':
          '舊的 JSON 檔案會保留為 *.migrated-v1 備份，不會被刪除。',
        'en-US':
          'Your old JSON files are kept as *.migrated-v1 backups — nothing is deleted.',
      },
    ],
    note: {
      'zh-TW':
        '注意：若你之後改回安裝舊版本，App 會像全新安裝一樣看不到既有資料（資料並未消失——把 *.migrated-v1 檔案改回原名即可還原）。',
      'en-US':
        'Note: if you later downgrade to an older version, the app will look freshly installed (your data is not lost — rename the *.migrated-v1 files back to restore it).',
    },
  },
  {
    version: '0.1.67',
    title: {
      'zh-TW': '儲存空間監控與安全清理、Claude 憑證跨目錄複製修復與終端效能調校',
      'en-US': 'Storage monitor with guarded cleanup, Claude credential fix & terminal performance',
    },
    highlights: [
      {
        'zh-TW':
          '設定新增 Storage 分頁：檢視各項資料佔用的空間並進行清理，清理只會動它能證明無人使用的資料（Codex 分格 home 等），live 資料受保護。',
        'en-US':
          'New Storage tab in Settings: see what is using disk and reclaim it. Cleanup only offers data it can prove no pane still references (stale Codex pane homes and the like) — live data is protected.',
      },
      {
        'zh-TW':
          '憑證修復：停止跨 config 目錄複製 Claude token（切帳號後舊分格顯示 Login expired 的根因），改由該 Profile 自己的 home 讀取登入狀態；aider 每個分格也有各自的對話歷史檔。',
        'en-US':
          'Credential fixes: stopped copying Claude tokens across config dirs (the root cause of “Login expired” on older panes after an account switch) and read a managed profile’s login from its own home; aider panes now get their own chat-history file.',
      },
      {
        'zh-TW':
          '終端與效能：修復 RUNNING 標籤中途誤閃 idle、localStorage 滿時靜默丟失 scrollback、--resume 產生的重複 PTY；PTY 每次喚醒改讀整個 viewport，token 匯入改為五分鐘合併並只追加變動日誌。',
        'en-US':
          'Terminal & performance: fixed the RUNNING badge flickering to idle mid-task, scrollback silently dropped when localStorage is full, and the duplicate PTY a --resume spawn left behind; PTY wakeups now repaint a whole viewport and token ingestion coalesces into a five-minute window with an append-only delta log.',
      },
    ],
  },
  {
    version: '0.1.66',
    title: {
      'zh-TW': '多家 CLI 額度偵測、帳號切換器餘額顯示與 Agent SPAWN 開面板',
      'en-US': 'Quota detection for more CLIs, per-account remaining quota & agent SPAWN blocks',
    },
    highlights: [
      {
        'zh-TW':
          '額度偵測擴充至 opencode、qwen、kilo、pi、copilot、cursor 等供應商，帳號切換器直接顯示每個帳號的剩餘額度。',
        'en-US':
          'Quota fetchers added for opencode, qwen, kilo, pi, copilot and cursor, with each account’s remaining quota shown right in the account switcher.',
      },
      {
        'zh-TW': 'CLI Agent 可用 SPAWN 區塊直接開出新的 CLI 分格，把工作交給另一個 agent。',
        'en-US':
          'CLI agents can open new CLI panes themselves via SPAWN blocks, handing work off to another agent.',
      },
      {
        'zh-TW':
          'CLI 還原可設定為延遲載入（開啟時才起 CLI）；Claude Profile Home 改以執行中狀態優先播種，避免舊快照覆蓋剛刷新的 token。',
        'en-US':
          'CLI restore can be configured to load lazily (a CLI starts when you open it), and Claude profile homes seed runtime-first so an old snapshot can no longer overwrite a freshly refreshed token.',
      },
    ],
  },
  {
    version: '0.1.65',
    title: {
      'zh-TW': '我們更名為「Navide」',
      'en-US': 'We’re now “Navide”',
    },
    highlights: [
      {
        'zh-TW':
          '應用程式已從「Navide (Agent-Team)」更名為「Navide」。這是同一個 App，你的資料與設定都不受影響。',
        'en-US':
          'The app was renamed from “Navide (Agent-Team)” to “Navide”. It’s the same app — your data and settings are untouched.',
      },
      {
        'zh-TW': 'macOS 自動更新已修復（先前一個打包問題會讓更新失敗）。',
        'en-US':
          'macOS auto-update now installs correctly — a packaging issue that broke updates has been fixed.',
      },
    ],
    note: {
      'zh-TW':
        '若這次更新後 App 沒有自動重新開啟，請從「應用程式」再開一次即可；之後的更新會自動重啟。',
      'en-US':
        'If the app didn’t reopen by itself after this update, just launch it again from Applications — future updates relaunch automatically.',
    },
  },
]

/** The announcement authored for a specific version, if any. */
export function whatsNewFor(version: string): WhatsNewEntry | undefined {
  return WHATS_NEW.find((entry) => entry.version === version)
}

/** Compare two X.Y.Z versions. An empty/blank string sorts as the oldest. */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < 3; i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * The announcement to show on startup: the newest entry the user hasn't seen
 * yet whose version has actually shipped (i.e. seenVersion < entry.version <=
 * currentVersion). This lets an announcement be authored under the version the
 * change happened in — it still fires for anyone whose update jumps past it,
 * even though the module itself only ships from the next release on. Returns
 * null when there is nothing to show.
 */
export function pickWhatsNew(
  currentVersion: string,
  seenVersion: string,
): WhatsNewEntry | null {
  if (!currentVersion) return null
  const unseen = WHATS_NEW.filter(
    (entry) =>
      cmpSemver(entry.version, seenVersion) > 0 &&
      cmpSemver(entry.version, currentVersion) <= 0,
  )
  if (unseen.length === 0) return null
  return unseen.reduce((newest, entry) =>
    cmpSemver(entry.version, newest.version) > 0 ? entry : newest,
  )
}

/**
 * The entry Help → What's New reopens. A shipped build reopens the newest one
 * it is running (seen or not); a dev build runs the last released version
 * from package.json while the notes for the next one are being written, so
 * it reopens the newest entry authored — that is the one being tried out.
 */
export function pickWhatsNewOnDemand(currentVersion: string, dev: boolean): WhatsNewEntry | null {
  if (dev) return pickWhatsNew('999999.0.0', '')
  return pickWhatsNew(currentVersion, '')
}

/** Resolve localized text. A later UI language falls back to en-US; every
 *  other locale falls back to the default locale (zh-TW) then en-US. */
export function pickText(text: WhatsNewText, locale: string): string {
  const own = (text as Record<string, string | undefined>)[locale]
  if (own !== undefined) return own
  if (isBetaUiLocale(locale)) return text['en-US'] ?? text['zh-TW'] ?? ''
  return text['zh-TW'] ?? text['en-US'] ?? ''
}
