"""Chat attachments: where inbound files are kept and which files a pane may send.

Inbound files from an allowed sender go to ``<app data>/channels-media/<pane>/`` under
a random prefix and a name of safe characters only, and are pruned after
``RETENTION_S``. Outbound, a pane names a file on a ``---ATTACH--- <absolute path>``
line inside an MSG block addressed to the chat; ``resolve_outbound`` admits any
regular file on this machine, judged after symlinks are resolved, but never a
credential-shaped name, a system file or a second hard link. Where the file lives is
the pane's call (the user's, 2026-10-08): a hidden file, or one outside the pane's
workspace, goes as usual and the manager logs it.
"""

from __future__ import annotations

import fnmatch
import mimetypes
import os
import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import BinaryIO

MEDIA_DIRNAME = "channels-media"
# Telegram's getFile serves at most 20 MB, and the same cap keeps every platform alike.
INBOUND_MAX_BYTES = 20 * 1024 * 1024
RETENTION_S = 7 * 86400.0
PRUNE_EVERY_S = 3600.0
MAX_ATTACHMENTS_PER_REPLY = 10
NAME_MAX_CHARS = 100

ATTACH_MARKER = "---ATTACH---"
# Trailing whitespace, \r included, is dropped like the MSG markers' (CRLF output).
_ATTACH_RE = re.compile(r"^---ATTACH---[ \t]+(\S.*?)[ \t\r]*$")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_UNSAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")

# Names a pane may never send: matched (fnmatch, case-insensitive) against every segment
# of the path below the allowed folder, so a credentials/ or secrets/ folder counts too.
# Errs on the side of refusing: a refused file can still be shared by hand.
DENIED_NAMES = (
    # keys, certificates and keystores
    "*.pem", "*.key", "*.p12", "*.pfx", "*.p8", "*.pkcs12", "*.jks", "*.keystore", "*.ppk",
    "*.der", "*.gpg", "*.pgp", "*.asc", "*.kdbx", "*.ovpn", "*.keychain", "*.keychain-db",
    "keychains", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*",
    # credentials, tokens and environment files (prod.env, env.local ...)
    "credentials*", "*secret*", "*token*", "*password*", "*passwd*", "*.env", "env.*",
    # dotted credential files (Claude Code's, git's store) and the CLIs' login files
    # (codex, opencode, kilo keep their tokens in an auth.json)
    ".credentials*", ".git-credentials", "auth.json",
    "*.tfstate", "*.tfstate.*", "*.netrc", "*.npmrc", "*.pypirc",
    # browser and app databases (cookies, saved logins)
    "cookies", "cookies-journal", "login data", "login data-journal", "web data",
    "*.sqlite", "*.sqlite3", "*.db", "*.db-wal", "*.db-shm",
)
# "*token*" judges only the file's own name: on a folder it refused every file of a project
# whose name merely mentions tokens ("Token仲介平台", 2026-10-14). A folder counts when its
# name ends in token or tokens (api_tokens, github-token) or is a dotted one (.tokens).
_FILE_ONLY_NAMES = frozenset({"*token*"})
_DENIED_FOLDERS = ("*token", "*tokens", ".token*")

_KIND_DEFAULT_NAMES = {
    "photo": "photo.jpg", "voice": "voice.ogg", "video_note": "video_note.mp4",
    "video": "video.mp4", "animation": "animation.mp4", "audio": "audio",
}


def media_root(data_dir: Path) -> Path:
    return data_dir / MEDIA_DIRNAME


def safe_name(name: str, kind: str = "file", mime: str = "") -> str:
    """``name`` reduced to ``[A-Za-z0-9._-]`` (no leading dot), or a name made from
    ``kind`` and ``mime`` when nothing is left."""
    stem, ext = os.path.splitext(os.path.basename((name or "").replace("\\", "/")))
    stem = _UNSAFE_RE.sub("_", stem).strip("._")[:NAME_MAX_CHARS]
    ext = _UNSAFE_RE.sub("", ext)[:10]
    if stem and ext != ".":
        return stem + ext
    fallback = _KIND_DEFAULT_NAMES.get(kind, "file")
    if ext and ext != ".":
        return os.path.splitext(fallback)[0] + ext  # e.g. "報告.pdf" -> "file.pdf"
    if "." not in fallback:
        fallback += mimetypes.guess_extension(mime or "") or ".bin"
    return fallback


def pane_dir(root: Path, pane_id: str) -> Path:
    """One pane's folder under the media root. A pane may send only its own folder's
    files: another pane's came from another chat."""
    return root / (_UNSAFE_RE.sub("_", pane_id).strip("._") or "pane")


def new_inbound_path(root: Path, pane_id: str, name: str) -> Path:
    """A fresh path for one inbound file: ``root/<pane>/<random>-<name>``."""
    folder = pane_dir(root, pane_id)
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    return folder / f"{secrets.token_hex(4)}-{name}"


def prune(root: Path, now: float | None = None, retention_s: float = RETENTION_S) -> int:
    """Delete files older than ``retention_s`` (and any symlink) under ``root``, then
    empty pane folders; returns how many files went. Never follows a symlink."""
    if not root.is_dir():
        return 0
    cutoff = (time.time() if now is None else now) - retention_s
    removed = 0
    for folder, dirs, files in os.walk(root, topdown=False, followlinks=False):
        for entry in files + [d for d in dirs if os.path.islink(os.path.join(folder, d))]:
            path = os.path.join(folder, entry)
            try:
                st = os.lstat(path)
                if os.path.islink(path) or st.st_mtime < cutoff:
                    os.unlink(path)
                    removed += 1
            except OSError:
                continue
        if folder != str(root):
            try:
                os.rmdir(folder)  # only succeeds when empty
            except OSError:
                pass
    return removed


def human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{int(size)} {unit}" if unit == "B" else f"{size:.1f}".removesuffix(".0") + f" {unit}"
        size /= 1024
    return f"{n} B"


def split_attachments(body: str) -> tuple[str, list[str]]:
    """(``body`` without its ``---ATTACH---`` lines, the paths they name). Lines inside a
    code fence are text, not attachments."""
    kept: list[str] = []
    paths: list[str] = []
    in_fence = False
    for line in body.split("\n"):
        if _FENCE_RE.match(line):
            in_fence = not in_fence
        elif not in_fence:
            m = _ATTACH_RE.match(line)
            if m:
                paths.append(m.group(1))
                continue
        kept.append(line)
    return "\n".join(kept).strip("\n"), paths


def _home() -> Path:
    return Path.home().resolve()


def _system_dirs() -> list[Path]:
    """The platform's system, program and credential folders (osplat), never sent from."""
    from .. import osplat

    return osplat.paths.system_dirs()


def _app_dirs() -> tuple[list[Path], list[Path]]:
    """Navide's own data folders (credential vault state, device keys, hook auth, the
    renderer's storage), never sent from, and the folders inside them that hold what a
    pane is meant to send: received attachments, converted PDFs and the copies of files
    the user dragged in (the renderer's dropped-files)."""
    from .. import osplat
    from ..applog import app_data_dir
    from .pdf import pdf_root

    data, user_data = app_data_dir(), osplat.paths.app_support_dir("Agent-Team")
    return [data, user_data], [media_root(data), pdf_root(data), user_data / "dropped-files"]


def _scope(real: Path) -> tuple[str, ...]:
    """The segments of ``real`` the name rules judge: everything below home (or below the
    anchor, outside home), so a workspace that itself sits in a secrets/ folder is
    caught, not only what lies below the workspace."""
    home = _home()
    return real.parts[len(home.parts):] if _inside(real, home) else real.parts[1:]


def _name_key(part: str) -> str:
    """A path segment as the name rules compare it. Windows drops trailing dots and spaces
    from every segment, so "id_rsa." and "key.pem ." open id_rsa and key.pem there."""
    from .. import osplat

    return part.lower().rstrip(". ") if osplat.platform_id == "win32" else part.lower()


def _folded(path: PurePath) -> tuple[str, ...]:
    return tuple(part.casefold() for part in path.parts)


def _inside(path: PurePath, folder: PurePath) -> bool:
    """``path`` is ``folder`` or below it, ignoring case: APFS and NTFS volumes are
    case-insensitive, so /Users/me/library/keychains is ~/Library/Keychains."""
    inner, outer = _folded(path), _folded(folder)
    return inner[: len(outer)] == outer


def resolve_outbound(raw: str) -> tuple[Path | None, str]:
    """(the real file, "") when a pane may send ``raw``, else (None, reason): one of
    not_absolute, parent_ref, missing, not_file, denied_name, system, hard_link."""
    real, _st, reason = _check(raw)
    return real, reason


def is_hidden(real: Path) -> bool:
    """A segment of ``real`` (below home, or below the anchor outside home) starts with a dot."""
    return any(part.startswith(".") for part in _scope(real))


def is_inside(real: Path, folders: list[str | Path]) -> bool:
    """``real`` lies in one of ``folders`` (resolved; "" entries are skipped)."""
    return any(folder and _within(real, Path(folder)) for folder in folders)


def _check(raw: str) -> tuple[Path | None, os.stat_result | None, str]:
    """``resolve_outbound`` plus the stat of the very inode that passed the rules."""
    path = Path(raw.strip())
    if not path.is_absolute():
        return None, None, "not_absolute"
    if ".." in path.parts:
        return None, None, "parent_ref"
    # "name:stream" opens an NTFS alternate data stream; no colon below the anchor anywhere.
    if any(":" in part for part in path.parts[1:]):
        return None, None, "denied_name"
    try:
        real = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return None, None, "missing"
    if not real.is_file():
        return None, None, "not_file"
    scope = _scope(real)
    # A colon can also arrive through a symlink, after the raw path passed.
    if _denied_rule(scope):
        return None, None, "denied_name"
    if any(_within(real, s) for s in _system_dirs()):
        return None, None, "system"
    private, outbound = _app_dirs()
    if any(_within(real, d) for d in private) and not any(_within(real, d) for d in outbound):
        return None, None, "system"
    try:
        st = real.stat()
    except OSError:
        return None, None, "changed"  # gone or unreadable since it resolved
    # A second name for the same inode may be a credential filed under a denied name.
    if st.st_nlink > 1:
        return None, None, "hard_link"
    return real, st, ""


def _denied_rule(scope: tuple[str, ...]) -> str:
    """The name rule a segment of ``scope`` breaks: ":" for a stream name, else the first
    matching pattern; "" when none does. The last segment is the file itself."""
    if any(":" in part for part in scope):
        return ":"
    for i, part in enumerate(scope):
        key, is_file = _name_key(part), i == len(scope) - 1
        for pat in DENIED_NAMES if is_file else DENIED_NAMES + _DENIED_FOLDERS:
            if (is_file or pat not in _FILE_ONLY_NAMES) and fnmatch.fnmatch(key, pat):
                return pat
    return ""


def denied_rule(raw: str) -> str:
    """The rule behind a ``denied_name`` refusal of ``raw``, for the chat notice; "" when
    no name rule refuses it (any more)."""
    path = Path(raw.strip())
    if any(":" in part for part in path.parts[1:]):
        return ":"
    try:
        real = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return ""
    return _denied_rule(_scope(real))


def _within(path: Path, folder: Path) -> bool:
    """``path`` is ``folder`` or inside it, after resolving the folder too (so /etc and
    /private/etc agree on macOS). Windows paths compare case-insensitively."""
    try:
        folder = folder.resolve()
    except (OSError, RuntimeError):
        pass
    return _inside(path, folder)


@dataclass
class Outbound:
    fh: BinaryIO  # the checked file, already open; the caller closes it
    path: Path
    size: int
    hidden: bool = False  # the path has a dot segment (logged, never refused)


def open_outbound(raw: str) -> tuple[Outbound | None, str]:
    """Check ``raw``, open it, then check it again, so what is sent is what was checked.

    The recheck runs while the file is open, and an open file pins its inode: its number
    cannot be handed to another file until we close it. So the path naming the same
    (st_dev, st_ino) as the open file proves it is the same file,
    on any filesystem, inode reuse included; a mere stat-then-open could not tell a
    replacement that happened to get the old inode number. The last component is opened
    without following a symlink, and any difference is reason "changed" (or the
    recheck's own reason). A swap after the recheck
    no longer matters: the open file is the checked one.
    """
    real, _seen, reason = _check(raw)
    if real is None:
        return None, reason
    try:
        fd = os.open(real, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    except OSError:
        return None, "changed"
    try:
        st = os.fstat(fd)
        again, seen, reason = _check(raw)
        if again is None or seen is None:
            os.close(fd)
            return None, reason
        # Same inode: the recheck's rules (regular file, one link ...) hold for the open file.
        if (st.st_dev, st.st_ino) != (seen.st_dev, seen.st_ino):
            os.close(fd)
            return None, "changed"
    except OSError:
        os.close(fd)
        return None, "changed"
    return Outbound(os.fdopen(fd, "rb"), real, st.st_size, is_hidden(real)), ""


# Chat-side notices, in the languages quick_menu.STRINGS covers.
STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "long.title": "完整回覆",
        "long.attached": "📎 內容較長，完整內容見附件",
        "card.todos": "待辦 {done}/{total}",
        "card.pages": "{n} 頁",
        "card.pdf_failed": "⚠️ PDF 轉換失敗：{reason}，附上原始檔",
        "card.failure.no_host": "App 主視窗未連線",
        "card.failure.timeout": "逾時",
        "card.failure.not_pdf": "轉出的檔案不是 PDF",
        "card.failure.too_large": "PDF 超過這個平台的上限",
        "card.failure.budget": "這則回覆的轉檔時間已用完",
        "card.failure.source_too_large": "HTML 檔太大",
        "card.failure.error": "轉檔出錯",
        "unsupported": "此平台尚不支援媒體",
        "too_large": "⚠️ 檔案「{name}」超過 {limit} 上限，沒有收下",
        "download_failed": "⚠️ 檔案「{name}」下載失敗：{error}",
        "refused": "⚠️ 不傳送「{name}」：{reason}",
        "too_large_out": "⚠️ 不傳送「{name}」：{size} 超過這個平台 {limit} 的上限",
        "send_failed": "⚠️ 檔案「{name}」傳送失敗：{error}",
        "too_many": "⚠️ 一次最多傳 {max} 個檔案，其餘的沒有傳",
        "reason.not_absolute": "必須是絕對路徑",
        "reason.parent_ref": "路徑不可含 ..",
        "reason.missing": "找不到這個檔案",
        "reason.not_file": "不是一般檔案",
        "reason.denied_name": "路徑符合憑證規則「{rule}」",
        "reason.system": "不傳系統檔案",
        "reason.hard_link": "這個檔案有其他硬連結，可能是 workspace 外的檔案",
        "reason.changed": "檢查後檔案被更動或換成連結",
    },
    "en-US": {
        "long.title": "Full reply",
        "long.attached": "📎 This reply is long; the full text is attached",
        "card.todos": "todos {done}/{total}",
        "card.pages": "{n} pages",
        "card.pdf_failed": "⚠️ PDF conversion failed: {reason}; the original file is attached",
        "card.failure.no_host": "the app window is not connected",
        "card.failure.timeout": "timed out",
        "card.failure.not_pdf": "the output was not a PDF",
        "card.failure.too_large": "the PDF is over this platform's limit",
        "card.failure.budget": "this reply ran out of conversion time",
        "card.failure.source_too_large": "the HTML file is too large",
        "card.failure.error": "the conversion failed",
        "unsupported": "This platform does not support media yet",
        "too_large": "⚠️ \"{name}\" is over the {limit} limit, so it was not received",
        "download_failed": "⚠️ \"{name}\" could not be downloaded: {error}",
        "refused": "⚠️ Not sending \"{name}\": {reason}",
        "too_large_out": "⚠️ Not sending \"{name}\": {size} is over this platform's {limit} limit",
        "send_failed": "⚠️ \"{name}\" could not be sent: {error}",
        "too_many": "⚠️ At most {max} files go out at once; the rest were not sent",
        "reason.not_absolute": "it must be an absolute path",
        "reason.parent_ref": "the path may not contain ..",
        "reason.missing": "the file does not exist",
        "reason.not_file": "it is not a regular file",
        "reason.denied_name": "the path matches the credential pattern \"{rule}\"",
        "reason.system": "system files are not sent",
        "reason.hard_link": "the file has other hard links and may be a file from outside the workspace",
        "reason.changed": "the file changed or became a link after it was checked",
    },
    "ja-JP": {
        "long.title": "返信の全文",
        "long.attached": "📎 長い返信のため、全文を添付しました",
        "card.todos": "ToDo {done}/{total}",
        "card.pages": "{n} ページ",
        "card.pdf_failed": "⚠️ PDF 変換に失敗しました：{reason}。元のファイルを添付します",
        "card.failure.no_host": "アプリのウィンドウが接続されていません",
        "card.failure.timeout": "タイムアウト",
        "card.failure.not_pdf": "出力が PDF ではありません",
        "card.failure.too_large": "PDF がこのプラットフォームの上限を超えています",
        "card.failure.budget": "この返信の変換時間を使い切りました",
        "card.failure.source_too_large": "HTML ファイルが大きすぎます",
        "card.failure.error": "変換エラー",
        "unsupported": "このプラットフォームはまだメディアに対応していません",
        "too_large": "⚠️ ファイル「{name}」は上限 {limit} を超えているため、受け取りませんでした",
        "download_failed": "⚠️ ファイル「{name}」をダウンロードできませんでした：{error}",
        "refused": "⚠️「{name}」は送信しません：{reason}",
        "too_large_out": "⚠️「{name}」は送信しません：{size} はこのプラットフォームの上限 {limit} を超えています",
        "send_failed": "⚠️ ファイル「{name}」を送信できませんでした：{error}",
        "too_many": "⚠️ 一度に送れるファイルは {max} 個までです。残りは送信していません",
        "reason.not_absolute": "絶対パスで指定してください",
        "reason.parent_ref": "パスに .. は使えません",
        "reason.missing": "ファイルが見つかりません",
        "reason.not_file": "通常のファイルではありません",
        "reason.denied_name": "パスが認証情報のパターン「{rule}」に一致します",
        "reason.system": "システムファイルは送信しません",
        "reason.hard_link": "このファイルには別のハードリンクがあり、workspace 外のファイルの可能性があります",
        "reason.changed": "確認した後にファイルが変更されたか、リンクに置き換えられました",
    },
    "zh-CN": {
        "long.title": "完整回复",
        "long.attached": "📎 内容较长，完整内容见附件",
        "card.todos": "待办 {done}/{total}",
        "card.pages": "{n} 页",
        "card.pdf_failed": "⚠️ PDF 转换失败：{reason}，附上原始文件",
        "card.failure.no_host": "App 主窗口未连接",
        "card.failure.timeout": "超时",
        "card.failure.not_pdf": "转出的文件不是 PDF",
        "card.failure.too_large": "PDF 超过这个平台的上限",
        "card.failure.budget": "这条回复的转换时间已用完",
        "card.failure.source_too_large": "HTML 文件太大",
        "card.failure.error": "转换出错",
        "unsupported": "此平台尚不支持媒体",
        "too_large": "⚠️ 文件“{name}”超过 {limit} 上限，没有收下",
        "download_failed": "⚠️ 文件“{name}”下载失败：{error}",
        "refused": "⚠️ 不发送“{name}”：{reason}",
        "too_large_out": "⚠️ 不发送“{name}”：{size} 超过这个平台 {limit} 的上限",
        "send_failed": "⚠️ 文件“{name}”发送失败：{error}",
        "too_many": "⚠️ 一次最多发送 {max} 个文件，其余的没有发送",
        "reason.not_absolute": "必须是绝对路径",
        "reason.parent_ref": "路径不能包含 ..",
        "reason.missing": "找不到这个文件",
        "reason.not_file": "不是普通文件",
        "reason.denied_name": "路径符合凭据规则“{rule}”",
        "reason.system": "不发送系统文件",
        "reason.hard_link": "这个文件有其他硬链接，可能是工作区外的文件",
        "reason.changed": "检查后文件被修改或换成了链接",
    },
    "ko-KR": {
        "long.title": "전체 답변",
        "long.attached": "📎 답변이 길어서 전체 내용을 첨부했어요",
        "card.todos": "할 일 {done}/{total}",
        "card.pages": "{n}페이지",
        "card.pdf_failed": "⚠️ PDF 변환 실패: {reason}. 원본 파일을 첨부했어요",
        "card.failure.no_host": "앱 창이 연결되어 있지 않음",
        "card.failure.timeout": "시간 초과",
        "card.failure.not_pdf": "출력 파일이 PDF가 아님",
        "card.failure.too_large": "PDF가 이 플랫폼의 한도를 초과함",
        "card.failure.budget": "이 답변의 변환 시간을 다 씀",
        "card.failure.source_too_large": "HTML 파일이 너무 큼",
        "card.failure.error": "변환 실패",
        "unsupported": "이 플랫폼은 아직 미디어를 지원하지 않아요",
        "too_large": "⚠️ “{name}”이(가) {limit} 한도를 넘어서 받지 않았어요",
        "download_failed": "⚠️ “{name}”을(를) 다운로드하지 못했어요: {error}",
        "refused": "⚠️ “{name}”을(를) 보내지 않아요: {reason}",
        "too_large_out": "⚠️ “{name}”을(를) 보내지 않아요: {size}이(가) 이 플랫폼의 {limit} 한도를 넘어요",
        "send_failed": "⚠️ “{name}”을(를) 보내지 못했어요: {error}",
        "too_many": "⚠️ 한 번에 최대 {max}개 파일까지 보낼 수 있어서 나머지는 보내지 않았어요",
        "reason.not_absolute": "절대 경로여야 해요",
        "reason.parent_ref": "경로에 ..를 포함할 수 없어요",
        "reason.missing": "파일이 없어요",
        "reason.not_file": "일반 파일이 아니에요",
        "reason.denied_name": "경로가 자격 증명 패턴 “{rule}”과(와) 일치해요",
        "reason.system": "시스템 파일은 보내지 않아요",
        "reason.hard_link": "이 파일에 다른 하드 링크가 있어 작업 영역 밖의 파일일 수 있어요",
        "reason.changed": "확인한 뒤 파일이 바뀌었거나 링크로 바뀌었어요",
    },
    "es-ES": {
        "long.title": "Respuesta completa",
        "long.attached": "📎 Esta respuesta es larga; el texto completo va adjunto",
        "card.todos": "tareas {done}/{total}",
        "card.pages": "{n} páginas",
        "card.pdf_failed": "⚠️ No se pudo convertir a PDF: {reason}; se adjunta el archivo original",
        "card.failure.no_host": "la ventana de la app no está conectada",
        "card.failure.timeout": "tiempo agotado",
        "card.failure.not_pdf": "el resultado no era un PDF",
        "card.failure.too_large": "el PDF supera el límite de esta plataforma",
        "card.failure.budget": "esta respuesta se quedó sin tiempo de conversión",
        "card.failure.source_too_large": "el archivo HTML es demasiado grande",
        "card.failure.error": "la conversión falló",
        "unsupported": "Esta plataforma aún no admite archivos multimedia",
        "too_large": "⚠️ «{name}» supera el límite de {limit}, así que no se recibió",
        "download_failed": "⚠️ No se pudo descargar «{name}»: {error}",
        "refused": "⚠️ No se envía «{name}»: {reason}",
        "too_large_out": "⚠️ No se envía «{name}»: {size} supera el límite de {limit} de esta plataforma",
        "send_failed": "⚠️ No se pudo enviar «{name}»: {error}",
        "too_many": "⚠️ Se envían como máximo {max} archivos a la vez; el resto no se envió",
        "reason.not_absolute": "debe ser una ruta absoluta",
        "reason.parent_ref": "la ruta no puede contener ..",
        "reason.missing": "el archivo no existe",
        "reason.not_file": "no es un archivo normal",
        "reason.denied_name": "la ruta coincide con el patrón de credenciales «{rule}»",
        "reason.system": "los archivos del sistema no se envían",
        "reason.hard_link": "el archivo tiene otros enlaces físicos y puede ser un archivo de fuera del área de trabajo",
        "reason.changed": "el archivo cambió o se convirtió en un enlace después de comprobarlo",
    },
    "fr-FR": {
        "long.title": "Réponse complète",
        "long.attached": "📎 Cette réponse est longue\u00a0; le texte complet est joint",
        "card.todos": "tâches {done}/{total}",
        "card.pages": "{n} pages",
        "card.pdf_failed": "⚠️ Échec de la conversion en PDF\u00a0: {reason}\u00a0; le fichier d’origine est joint",
        "card.failure.no_host": "la fenêtre de l’app n’est pas connectée",
        "card.failure.timeout": "délai dépassé",
        "card.failure.not_pdf": "le résultat n’était pas un PDF",
        "card.failure.too_large": "le PDF dépasse la limite de cette plateforme",
        "card.failure.budget": "cette réponse a épuisé son temps de conversion",
        "card.failure.source_too_large": "le fichier HTML est trop volumineux",
        "card.failure.error": "la conversion a échoué",
        "unsupported": "Cette plateforme ne prend pas encore en charge les médias",
        "too_large": "⚠️ «\u00a0{name}\u00a0» dépasse la limite de {limit}, il n’a donc pas été reçu",
        "download_failed": "⚠️ Impossible de télécharger «\u00a0{name}\u00a0»\u00a0: {error}",
        "refused": "⚠️ «\u00a0{name}\u00a0» n’est pas envoyé\u00a0: {reason}",
        "too_large_out": "⚠️ «\u00a0{name}\u00a0» n’est pas envoyé\u00a0: {size} dépasse la limite de {limit} de cette plateforme",
        "send_failed": "⚠️ Impossible d’envoyer «\u00a0{name}\u00a0»\u00a0: {error}",
        "too_many": "⚠️ {max} fichiers au plus partent à la fois\u00a0; les autres n’ont pas été envoyés",
        "reason.not_absolute": "le chemin doit être absolu",
        "reason.parent_ref": "le chemin ne peut pas contenir ..",
        "reason.missing": "le fichier n’existe pas",
        "reason.not_file": "ce n’est pas un fichier ordinaire",
        "reason.denied_name": "le chemin correspond au motif d’identifiants «\u00a0{rule}\u00a0»",
        "reason.system": "les fichiers système ne sont pas envoyés",
        "reason.hard_link": "le fichier a d’autres liens physiques et peut provenir de l’extérieur de l’espace de travail",
        "reason.changed": "le fichier a changé ou est devenu un lien après la vérification",
    },
    "de-DE": {
        "long.title": "Vollständige Antwort",
        "long.attached": "📎 Diese Antwort ist lang; der vollständige Text ist angehängt",
        "card.todos": "Aufgaben {done}/{total}",
        "card.pages": "{n} Seiten",
        "card.pdf_failed": "⚠️ PDF-Konvertierung fehlgeschlagen: {reason}; die Originaldatei ist angehängt",
        "card.failure.no_host": "das App-Fenster ist nicht verbunden",
        "card.failure.timeout": "Zeitüberschreitung",
        "card.failure.not_pdf": "die Ausgabe war kein PDF",
        "card.failure.too_large": "das PDF überschreitet das Limit dieser Plattform",
        "card.failure.budget": "für diese Antwort ist die Konvertierungszeit aufgebraucht",
        "card.failure.source_too_large": "die HTML-Datei ist zu groß",
        "card.failure.error": "die Konvertierung ist fehlgeschlagen",
        "unsupported": "Diese Plattform unterstützt noch keine Medien",
        "too_large": "⚠️ „{name}“ überschreitet das Limit von {limit} und wurde daher nicht empfangen",
        "download_failed": "⚠️ „{name}“ konnte nicht heruntergeladen werden: {error}",
        "refused": "⚠️ „{name}“ wird nicht gesendet: {reason}",
        "too_large_out": "⚠️ „{name}“ wird nicht gesendet: {size} überschreitet das Limit dieser Plattform von {limit}",
        "send_failed": "⚠️ „{name}“ konnte nicht gesendet werden: {error}",
        "too_many": "⚠️ Höchstens {max} Dateien werden auf einmal gesendet; der Rest wurde nicht gesendet",
        "reason.not_absolute": "es muss ein absoluter Pfad sein",
        "reason.parent_ref": "der Pfad darf kein .. enthalten",
        "reason.missing": "die Datei existiert nicht",
        "reason.not_file": "es ist keine reguläre Datei",
        "reason.denied_name": "der Pfad entspricht dem Zugangsdaten-Muster „{rule}“",
        "reason.system": "Systemdateien werden nicht gesendet",
        "reason.hard_link": "die Datei hat weitere Hardlinks und könnte eine Datei von außerhalb des Arbeitsbereichs sein",
        "reason.changed": "die Datei wurde nach der Prüfung geändert oder durch einen Link ersetzt",
    },
    "pt-BR": {
        "long.title": "Resposta completa",
        "long.attached": "📎 Esta resposta é longa; o texto completo está anexado",
        "card.todos": "tarefas {done}/{total}",
        "card.pages": "{n} páginas",
        "card.pdf_failed": "⚠️ Falha na conversão para PDF: {reason}; o arquivo original está anexado",
        "card.failure.no_host": "a janela do app não está conectada",
        "card.failure.timeout": "tempo esgotado",
        "card.failure.not_pdf": "o resultado não era um PDF",
        "card.failure.too_large": "o PDF ultrapassa o limite desta plataforma",
        "card.failure.budget": "esta resposta ficou sem tempo de conversão",
        "card.failure.source_too_large": "o arquivo HTML é grande demais",
        "card.failure.error": "a conversão falhou",
        "unsupported": "Esta plataforma ainda não suporta mídia",
        "too_large": "⚠️ “{name}” ultrapassa o limite de {limit}, então não foi recebido",
        "download_failed": "⚠️ Não foi possível baixar “{name}”: {error}",
        "refused": "⚠️ “{name}” não será enviado: {reason}",
        "too_large_out": "⚠️ “{name}” não será enviado: {size} ultrapassa o limite de {limit} desta plataforma",
        "send_failed": "⚠️ Não foi possível enviar “{name}”: {error}",
        "too_many": "⚠️ No máximo {max} arquivos são enviados de uma vez; o restante não foi enviado",
        "reason.not_absolute": "precisa ser um caminho absoluto",
        "reason.parent_ref": "o caminho não pode conter ..",
        "reason.missing": "o arquivo não existe",
        "reason.not_file": "não é um arquivo comum",
        "reason.denied_name": "o caminho corresponde ao padrão de credenciais “{rule}”",
        "reason.system": "arquivos do sistema não são enviados",
        "reason.hard_link": "o arquivo tem outros hard links e pode ser um arquivo de fora do workspace",
        "reason.changed": "o arquivo mudou ou virou um link depois de ser verificado",
    },
    "ru-RU": {
        "long.title": "Полный ответ",
        "long.attached": "📎 Ответ длинный; полный текст во вложении",
        "card.todos": "задачи {done}/{total}",
        "card.pages": "страниц: {n}",
        "card.pdf_failed": "⚠️ Не удалось преобразовать в PDF: {reason}; исходный файл приложен",
        "card.failure.no_host": "окно приложения не подключено",
        "card.failure.timeout": "время ожидания истекло",
        "card.failure.not_pdf": "результат не является PDF",
        "card.failure.too_large": "PDF превышает лимит этой платформы",
        "card.failure.budget": "время на преобразование для этого ответа исчерпано",
        "card.failure.source_too_large": "HTML-файл слишком большой",
        "card.failure.error": "преобразование не удалось",
        "unsupported": "Эта платформа пока не поддерживает медиафайлы",
        "too_large": "⚠️ «{name}» превышает лимит {limit}, поэтому не принят",
        "download_failed": "⚠️ Не удалось скачать «{name}»: {error}",
        "refused": "⚠️ «{name}» не отправляется: {reason}",
        "too_large_out": "⚠️ «{name}» не отправляется: {size} превышает лимит этой платформы ({limit})",
        "send_failed": "⚠️ Не удалось отправить «{name}»: {error}",
        "too_many": "⚠️ За один раз отправляется не более {max} файлов; остальные не отправлены",
        "reason.not_absolute": "путь должен быть абсолютным",
        "reason.parent_ref": "путь не может содержать ..",
        "reason.missing": "файл не существует",
        "reason.not_file": "это не обычный файл",
        "reason.denied_name": "путь соответствует шаблону учётных данных «{rule}»",
        "reason.system": "системные файлы не отправляются",
        "reason.hard_link": "у файла есть другие жёсткие ссылки, и он может быть файлом вне рабочей области",
        "reason.changed": "файл изменился или стал ссылкой после проверки",
    },
    "vi-VN": {
        "long.title": "Toàn bộ câu trả lời",
        "long.attached": "📎 Câu trả lời này dài; toàn văn có trong tệp đính kèm",
        "card.todos": "việc cần làm {done}/{total}",
        "card.pages": "{n} trang",
        "card.pdf_failed": "⚠️ Chuyển sang PDF thất bại: {reason}; đã đính kèm tệp gốc",
        "card.failure.no_host": "cửa sổ ứng dụng chưa kết nối",
        "card.failure.timeout": "hết thời gian chờ",
        "card.failure.not_pdf": "tệp xuất ra không phải PDF",
        "card.failure.too_large": "PDF vượt giới hạn của nền tảng này",
        "card.failure.budget": "câu trả lời này đã hết thời gian chuyển đổi",
        "card.failure.source_too_large": "tệp HTML quá lớn",
        "card.failure.error": "chuyển đổi thất bại",
        "unsupported": "Nền tảng này chưa hỗ trợ tệp phương tiện",
        "too_large": "⚠️ “{name}” vượt giới hạn {limit}, nên không được nhận",
        "download_failed": "⚠️ Không tải xuống được “{name}”: {error}",
        "refused": "⚠️ Không gửi “{name}”: {reason}",
        "too_large_out": "⚠️ Không gửi “{name}”: {size} vượt giới hạn {limit} của nền tảng này",
        "send_failed": "⚠️ Không gửi được “{name}”: {error}",
        "too_many": "⚠️ Mỗi lần chỉ gửi tối đa {max} tệp; các tệp còn lại chưa được gửi",
        "reason.not_absolute": "phải là đường dẫn tuyệt đối",
        "reason.parent_ref": "đường dẫn không được chứa ..",
        "reason.missing": "tệp không tồn tại",
        "reason.not_file": "không phải tệp thông thường",
        "reason.denied_name": "đường dẫn khớp với mẫu thông tin xác thực “{rule}”",
        "reason.system": "không gửi tệp hệ thống",
        "reason.hard_link": "tệp có liên kết cứng khác và có thể là tệp nằm ngoài workspace",
        "reason.changed": "tệp đã thay đổi hoặc bị thay bằng liên kết sau khi kiểm tra",
    },
}
DEFAULT_LANGUAGE = "zh-TW"


def text(lang: str, key: str, **kw: object) -> str:
    return STRINGS.get(lang, STRINGS[DEFAULT_LANGUAGE])[key].format(**kw)


def attachment_line(kind: str, name: str, size: int, path: Path) -> str:
    """What the pane is told about one received file."""
    return f"[附件] {kind} {name} {human_size(size)} → {path}"
