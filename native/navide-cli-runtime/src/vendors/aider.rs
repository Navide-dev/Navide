//! Aider. Its history is Markdown appended to `<git root>/.aider.chat.history.md`
//! (or a pane's own `.aider.chat.history.<token>.md`), one section per run,
//! headed `# aider chat started at <date> <time>`. Each `> Tokens: … sent, …
//! received` line is one model call and the only end-of-message signal; `#### `
//! lines are the prompt. The section's start, with the file's namespace, is the
//! session id, so the activity walk replays the file from the top every time
//! (main's walk does too) to know which section a new line is in.
use crate::decl::*;
use crate::expr::{py_space, Scope};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub struct V;

slots! {
    Namespace = "namespace",
    Cwd = "cwd",
    SessionId = "session_id",
    Section = "section",
    SectionTs = "section_ts",
    Pending = "pending",
    PrevPrompt = "prev_prompt",
    Emitted = "emitted",
}

/// What only aider's Markdown history needs: its lines are prose, not
/// records, so each is read with one of main's two patterns.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Slot: main's `history_namespace`: a per-pane file's token, else the
    /// first 8 hex digits of the MD5 of the file's resolved path, so two
    /// workspaces' shared files starting in the same second keep apart. A
    /// file-system lookup and a hash, which no record can carry.
    Namespace,
    /// Slot: the history file sits at the session's git root.
    Root,
    /// Test: a section header (main's `_SECTION_RE`).
    Header,
    /// Text: the header's slug stamp, `YYYYMMDD-HHMMSS`.
    Stamp,
    /// Text: the header's start as main's `_iso`, naive `YYYY-MM-DDTHH:MM:SS`.
    Iso,
    /// Test: a usage line (main's `_TOKENS_RE`).
    Tokens,
    /// Numbers: the usage line's two counts (main's `_parse_count`).
    Sent,
    Received,
    /// Text: a `#### ` prompt line without its marker.
    Prompt,
    /// Test: the line is past the walk's mark (a replayed line is not).
    Fresh,
}

fn line<'a>(scope: &Scope<'a, V>) -> &'a str {
    scope.get(&["line"]).and_then(Value::as_str).unwrap_or_default()
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = TextLog;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn text(ext: Ext, scope: &Scope<'_, Self>) -> String {
        let line = line(scope);
        match ext {
            Ext::Stamp => section(line).map(|[y, mo, d, h, mi, s]| format!("{y}{mo}{d}-{h}{mi}{s}")).unwrap_or_default(),
            Ext::Iso => section(line).map(|[y, mo, d, h, mi, s]| format!("{y}-{mo}-{d}T{h}:{mi}:{s}")).unwrap_or_default(),
            Ext::Prompt => line.strip_prefix("#### ").unwrap_or(line).to_owned(),
            _ => String::new(),
        }
    }

    fn num(ext: Ext, scope: &Scope<'_, Self>) -> Option<i64> {
        let (sent, received) = counts(line(scope))?;
        match ext {
            Ext::Sent => Some(sent),
            Ext::Received => Some(received),
            _ => None,
        }
    }

    fn pred(ext: Ext, scope: &Scope<'_, Self>) -> bool {
        match ext {
            Ext::Header => section(line(scope)).is_some(),
            Ext::Tokens => counts(line(scope)).is_some(),
            Ext::Fresh => scope.fresh,
            _ => false,
        }
    }

    fn init(ext: Ext, path: &std::path::Path) -> String {
        match ext {
            Ext::Namespace => namespace(&path.to_string_lossy()),
            Ext::Root => path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
            _ => String::new(),
        }
    }
}

/// main's `_SECTION_RE` (`^# aider chat started at (\d{4})-(\d{2})-(\d{2})
/// (\d{2}):(\d{2}):(\d{2})`): the six fields, or `None`.
fn section(line: &str) -> Option<[&str; 6]> {
    let rest = line.strip_prefix("# aider chat started at ")?;
    let digits = |at: usize, len: usize| rest.get(at..at + len).filter(|d| d.bytes().all(|b| b.is_ascii_digit()));
    let seps = [(4, b'-'), (7, b'-'), (10, b' '), (13, b':'), (16, b':')];
    if rest.len() < 19 || seps.iter().any(|(at, sep)| rest.as_bytes()[*at] != *sep) {
        return None;
    }
    Some([digits(0, 4)?, digits(5, 2)?, digits(8, 2)?, digits(11, 2)?, digits(14, 2)?, digits(17, 2)?])
}

/// main's `_TOKENS_RE` (`^>\s*Tokens:\s*([\d.,]+k?)\s+sent,\s*([\d.,]+k?)\s+received`,
/// case-insensitive) and `_parse_count` (`1,234`, `12k`, `8.5k`).
fn counts(line: &str) -> Option<(i64, i64)> {
    fn word<'a>(text: &'a str, word: &str) -> Option<&'a str> {
        let head = text.get(..word.len())?;
        head.eq_ignore_ascii_case(word).then(|| &text[word.len()..])
    }
    /// `([\d.,]+k?)` then `\s+`.
    fn count(text: &str) -> Option<(i64, &str)> {
        let end = text.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == ',')).unwrap_or(text.len());
        if end == 0 {
            return None;
        }
        let (number, mut rest) = text.split_at(end);
        let mut mult = 1.0;
        if let Some(after) = word(rest, "k") {
            (mult, rest) = (1000.0, after);
        }
        let spaced = rest.trim_start_matches(py_space);
        if spaced.len() == rest.len() {
            return None;
        }
        // `max(0, int(float(s) * mult))`, 0 where `float` raises.
        let value = number.replace(',', "").parse::<f64>().map_or(0, |f| ((f * mult) as i64).max(0));
        Some((value, spaced))
    }
    let rest = word(line.strip_prefix('>')?.trim_start_matches(py_space), "tokens:")?;
    let (sent, rest) = count(rest.trim_start_matches(py_space))?;
    let rest = word(rest, "sent,")?;
    let (received, rest) = count(rest.trim_start_matches(py_space))?;
    word(rest, "received")?;
    Some((sent, received))
}

fn namespace(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or_default();
    if let Some(token) = name.strip_prefix(".aider.chat.history.").and_then(|r| r.strip_suffix(".md")) {
        if token.len() == 8 && token.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return token.to_owned();
        }
    }
    let resolved = std::fs::canonicalize(path).map_or_else(|_| path.to_owned(), |p| p.to_string_lossy().into_owned());
    crate::md5::hex_digest(resolved.as_bytes())[..8].to_owned()
}

const LINE: Text<V> = Text::Py(&["line"]);
const HEADER: Pred<V> = Pred::Ext(Ext::Header);
const TOKENS: Pred<V> = Pred::Ext(Ext::Tokens);
const FRESH: Pred<V> = Pred::Ext(Ext::Fresh);
const SECTION: Text<V> = Text::Concat(&[Text::Lit("aider-"), Text::Slot(Slot::Namespace), Text::Lit("-"), Text::Ext(Ext::Stamp)]);
/// main's `_PENDING_TEXT_MAX_CHARS`: the reply text kept between walks.
const PENDING_MAX: usize = 32_000;

const ACT: Text<V> = Text::Concat(&[Text::Lit("act:"), Text::Line]);
const TURN: Text<V> = Text::Concat(&[Text::Lit("turn:"), Text::Line]);
/// aider's lines carry no time.
const NO_TIME: Text<V> = Text::Lit("");

pub static CLI: Cli = Cli {
    key: "aider",
    label: "Aider",
    kind: Kind::Cli,
    order: Order { menu: 120, registry: 10 },
    // Any model string goes straight to litellm, so a wrong one cannot be caught.
    launch: Launch { yolo_args: &["--yes-always"], env_strip: &["AIDER_CHAT_HISTORY_FILE", "AIDER_INPUT_HISTORY_FILE"], ..Launch::of("aider") },
    // Only a lossy `--restore-chat-history`, which names no session.
    resume: Resume::NONE,
    interrupt: b"\x03",
};

static OBSERVE: Observe<V> = Observe {
    file_name: None,
    other_files: OtherFiles::Empty,
    slots: &[Seed { slot: Slot::Namespace, init: SlotInit::Ext(Ext::Namespace) }, Seed { slot: Slot::Cwd, init: SlotInit::Ext(Ext::Root) }],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: TextRecords {
        kind: "aider-md",
        usage: Some(FileUsage {
            persist: &[Slot::Section, Slot::SectionTs],
            ..FileUsage::per_record(
                &[
                    UsageRule {
                        when: HEADER,
                        effects: &[Effect::Set(Slot::Section, SECTION), Effect::Set(Slot::SectionTs, Text::Ext(Ext::Iso))],
                        reading: None,
                    },
                    // A usage line before any header (its section precedes the checkpoint) is skipped.
                    UsageRule {
                        when: Pred::All(&[TOKENS, Pred::SlotSet(Slot::Section)]),
                        effects: &[],
                        reading: Some(Reading {
                            timestamp: Text::Slot(Slot::SectionTs),
                            cwd: Text::Slot(Slot::Cwd),
                            session_id: Text::Slot(Slot::Section),
                            ..Reading::of(
                                Num::Ext(Ext::Sent),
                                Num::Ext(Ext::Received),
                                Text::Concat(&[Text::Lit("aider::"), Text::Slot(Slot::Section), Text::Lit("::@"), Text::Offset]),
                            )
                        }),
                    },
                ],
                0,
            )
        }),
    },
    activity: Activity {
        kept: &[Kept { slot: Slot::Pending, prefix: "aider_text::", form: KeptForm::Text }],
        ..Activity::rules(&[
            // A header names the section even when already walked.
            Rule {
                when: HEADER,
                effects: &[
                    Effect::Set(Slot::SessionId, SECTION),
                    Effect::When(&FRESH, &[Effect::Set(Slot::Pending, Text::Lit(""))]),
                    Effect::Set(Slot::PrevPrompt, Text::Lit("")),
                    Effect::Stop,
                ],
            },
            Rule { when: Pred::Not(&Pred::Text(Text::Strip(&LINE), StrTest::NonEmpty)), effects: &[Effect::Stop] },
            // A multi-line prompt is one event, named from its first line.
            Rule {
                when: Pred::Text(LINE, StrTest::StartsWith("#### ")),
                effects: &[
                    Effect::When(
                        &FRESH,
                        &[
                            Effect::Set(Slot::Pending, Text::Lit("")),
                            Effect::When(
                                &Pred::Not(&Pred::SlotSet(Slot::PrevPrompt)),
                                &[Emit::active(ACT, Text::Lit("prompt"), Text::UserPrompt(&Text::Ext(Ext::Prompt)), NO_TIME).effect()],
                            ),
                        ],
                    ),
                    Effect::Set(Slot::PrevPrompt, Text::Lit("1")),
                    Effect::Stop,
                ],
            },
            Rule { when: Pred::True, effects: &[Effect::Set(Slot::PrevPrompt, Text::Lit(""))] },
            // One usage line per finished assistant message: it carries the message's text.
            Rule {
                when: TOKENS,
                effects: &[
                    Effect::When(
                        &FRESH,
                        &[
                            Emit::done(TURN, Text::Lit("usage"), Text::Cap(&Text::Slot(Slot::Pending), PENDING_MAX), NO_TIME).effect(),
                            Effect::Set(Slot::Pending, Text::Lit("")),
                        ],
                    ),
                    Effect::Stop,
                ],
            },
            // Other output: its text is kept (not `>` tool lines); one event per walk.
            Rule {
                when: FRESH,
                effects: &[
                    Effect::When(
                        &Pred::Not(&Pred::Text(LINE, StrTest::StartsWith(">"))),
                        &[Effect::Append(Slot::Pending, Text::Concat(&[LINE, Text::Lit("\n")]), PENDING_MAX)],
                    ),
                    Effect::When(
                        &Pred::Not(&Pred::SlotSet(Slot::Emitted)),
                        &[Emit::active(ACT, Text::Lit("output"), Text::Lit(""), NO_TIME).effect(), Effect::Set(Slot::Emitted, Text::Lit("1"))],
                    ),
                ],
            },
        ])
    },
    // main's base reader: usage cut on turn_complete timestamps (aider's carry none).
    turns: Turns::Inferred,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_and_token_lines_follow_main() {
        assert_eq!(section("# aider chat started at 2025-01-02 03:04:05 extra"), Some(["2025", "01", "02", "03", "04", "05"]));
        assert_eq!(section("# aider chat started at 2025-1-02 03:04:05"), None);
        assert_eq!(counts("> Tokens: 1,234 sent, 8.5k received. Cost: $0.01"), Some((1234, 8500)));
        assert_eq!(counts(">tokens:12K SENT, 567 Received"), Some((12000, 567)));
        assert_eq!(counts("> Tokens: 12k sent, 567received"), None, "`\\s+` before `received`");
        assert_eq!(counts(">  TOKENS: 12K  SENT,567 received"), Some((12000, 567)));
        assert_eq!(counts("> Tokens: 1.2.3 sent, ,, received"), Some((0, 0)));
        assert_eq!(counts("> Tokens: k sent, 1 received"), None);
        assert_eq!(namespace("/w/.aider.chat.history.0a1b2c3d.md"), "0a1b2c3d");
        assert_eq!(namespace("/no/such/.aider.chat.history.md"), crate::md5::hex_digest(b"/no/such/.aider.chat.history.md")[..8]);
    }
}
