//! Which JSON text main's readers (Python's `json.loads`) read and this
//! crate's parser (`serde_json`) does not, so that a record is never stepped
//! over when main would have read it.
//!
//! Python's decoder accepts, beyond the grammar `serde_json` implements:
//!
//! * a lone UTF-16 surrogate escape (`"\ud83d"`), which Node's
//!   `JSON.stringify` writes when it cuts a string inside a pair;
//! * the literals `NaN`, `Infinity` and `-Infinity`;
//! * a number beyond the range of a double (`1e999` is `inf`) and an integer
//!   of any length;
//! * nesting up to the interpreter's recursion limit (`serde_json` stops at
//!   128 levels).
//!
//! `parse` tells the three outcomes apart. `Rejected` must mean that Python
//! rejects the text too (a corrupt line, a plain-text cell): it is what lets
//! the caller treat the text as main does. When in doubt the answer is
//! `Python`, which only costs the call being read by the Python reader.
use serde_json::Value;

/// What a text is to the two parsers.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    /// Both read it.
    Value(Value),
    /// `serde_json` rejects it and Python's `json` may read it: the caller
    /// must not step over it.
    Python,
    /// Neither reads it.
    Rejected,
}

/// Where Python's own limit lies depends on its version and on the stack it
/// is called from (it raises `RecursionError`, which main does not catch). The
/// rewrite below does not follow a text deeper than this: whatever is nested
/// that far is Python's, to read or to raise on, as it is on main.
const PYTHON_DEPTH: usize = 900;

pub fn parse(text: &str) -> Parsed {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => Parsed::Value(value),
        Err(_) if python_may_read(text) => Parsed::Python,
        Err(_) => Parsed::Rejected,
    }
}

/// `parse` for bytes. `json.loads(bytes)` first detects the encoding
/// (`json.detect_encoding`): a UTF-8 or UTF-16 byte-order mark, or a NUL in the
/// first four bytes (UTF-16 or UTF-32 without a mark), means Python decodes
/// something this parser does not, so that is Python's to read. So is UTF-8
/// that holds an encoded surrogate (`22 ED A0 80 22`, `"\ud800"`): `json.loads`
/// decodes with `surrogatepass`. Any other bytes that are not UTF-8 (a protobuf
/// blob) are read by no one.
pub fn parse_bytes(bytes: &[u8]) -> Parsed {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) || bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) || bytes.iter().take(4).any(|&byte| byte == 0) {
        return Parsed::Python;
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => parse(text),
        Err(_) if utf8_but_for_surrogates(bytes) => Parsed::Python,
        Err(_) => Parsed::Rejected,
    }
}

/// Whether `bytes` are valid UTF-8 once encoded surrogates (`ED A0..BF 80..BF`,
/// which `surrogatepass` accepts) are let through.
fn utf8_but_for_surrogates(mut bytes: &[u8]) -> bool {
    loop {
        let Err(error) = std::str::from_utf8(bytes) else {
            return true;
        };
        let rest = &bytes[error.valid_up_to()..];
        match rest {
            [0xED, 0xA0..=0xBF, 0x80..=0xBF, ..] => bytes = &rest[3..],
            _ => return false,
        }
    }
}

/// Whether Python's `json` may accept `text`, which `serde_json` rejected:
/// the text with each of Python's extensions rewritten to plain JSON parses.
fn python_may_read(text: &str) -> bool {
    match rewrite(text) {
        None => true,
        Some(plain) => plain_value(&plain).is_some(),
    }
}

/// What Python's `json` reads `text` as, where `serde_json` rejects it, with
/// its extensions rewritten as `rewrite` does (a lone surrogate is U+FFFD, a
/// `NaN` is `0`): good for a field the text carries, such as a request's id,
/// never for the extensions' own values. None when nothing reads it.
pub fn lenient(text: &str) -> Option<Value> {
    plain_value(&rewrite(text)?)
}

fn plain_value(plain: &str) -> Option<Value> {
    let mut reader = serde_json::Deserializer::from_str(plain);
    reader.disable_recursion_limit();
    let value = <Value as serde::Deserialize>::deserialize(&mut reader).ok()?;
    reader.end().ok()?;
    // Dropping a deeply nested value is itself recursive: it stays within
    // `PYTHON_DEPTH` levels, which a worker thread's stack holds.
    Some(value)
}

/// `text` with Python's extensions rewritten to what `serde_json` reads; the
/// rewrite is wider than Python on purpose (an invalid number becomes `0`),
/// never narrower. `None`: nested beyond what Python reads, so Python decides.
fn rewrite(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut at, mut depth) = (0, 0usize);
    while at < bytes.len() {
        match bytes[at] {
            b'"' => at = string(text, at, &mut out),
            b'[' | b'{' => {
                depth += 1;
                if depth > PYTHON_DEPTH {
                    return None;
                }
                out.push(bytes[at] as char);
                at += 1;
            }
            b']' | b'}' => {
                depth = depth.saturating_sub(1);
                out.push(bytes[at] as char);
                at += 1;
            }
            b'N' | b'I' | b'-' | b'+' | b'.' | b'0'..=b'9' => at = scalar(text, at, &mut out),
            other => {
                // Whitespace, `,` `:` and `true` `false` `null` pass through.
                out.push(other as char);
                at += 1;
            }
        }
    }
    Some(out)
}

/// A string literal from the quote at `at`; returns the index after it. A lone
/// surrogate escape becomes U+FFFD; everything else is copied.
fn string(text: &str, at: usize, out: &mut String) -> usize {
    let bytes = text.as_bytes();
    out.push('"');
    let mut i = at + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                out.push('"');
                return i + 1;
            }
            b'\\' if bytes.get(i + 1) == Some(&b'u') => match (hex4(bytes, i + 2), bytes.get(i + 6), bytes.get(i + 7)) {
                (Some(0xD800..=0xDBFF), Some(b'\\'), Some(b'u')) if matches!(hex4(bytes, i + 8), Some(0xDC00..=0xDFFF)) => {
                    // A valid pair: kept.
                    out.push_str(&text[i..i + 12]);
                    i += 12;
                }
                (Some(0xD800..=0xDFFF), _, _) => {
                    out.push_str("\\ufffd");
                    i += 6;
                }
                _ => {
                    // Any other escape: copied as it is, and the parser judges it.
                    out.push('\\');
                    out.push('u');
                    i += 2;
                }
            },
            b'\\' => {
                // A two-character escape: what follows the backslash is not a quote or a backslash of its own.
                out.push('\\');
                i += 1;
                if let Some(next) = text[i..].chars().next() {
                    out.push(next);
                    i += next.len_utf8();
                }
            }
            _ => {
                // Copy one whole character.
                let width = text[i..].chars().next().map_or(1, char::len_utf8);
                out.push_str(&text[i..i + width]);
                i += width;
            }
        }
    }
    // Unterminated: the parser rejects it, whatever follows.
    i
}

/// Four hex digits at `at`.
fn hex4(bytes: &[u8], at: usize) -> Option<u32> {
    let digits = bytes.get(at..at + 4)?;
    digits.iter().try_fold(0u32, |acc, d| Some(acc << 4 | char::from(*d).to_digit(16)?))
}

/// A bare token outside strings: `NaN`, `Infinity`, `-Infinity` or a number.
/// Those and any number that may overflow become `0`; returns the index after
/// the token. Anything else is copied one character at a time.
fn scalar(text: &str, at: usize, out: &mut String) -> usize {
    let bytes = text.as_bytes();
    let rest = &text[at..];
    for word in ["NaN", "Infinity", "-Infinity"] {
        if rest.starts_with(word) {
            out.push('0');
            return at + word.len();
        }
    }
    let end = at + bytes[at..].iter().take_while(|b| matches!(**b, b'+' | b'-' | b'.' | b'e' | b'E' | b'0'..=b'9')).count();
    if end == at {
        out.push(bytes[at] as char);
        return at + 1;
    }
    let token = &text[at..end];
    // A long number (more digits than a double holds) or one with an
    // exponent may be out of range for `serde_json` and a value to Python.
    if token.len() > 17 || token.contains(['e', 'E']) {
        out.push('0');
    } else {
        out.push_str(token);
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases in `tests/json_dialect.json`, each with what Python's
    /// `json.loads` does with it (`backend/tests/test_cli_runtime_json.py`
    /// holds that half to Python itself).
    #[test]
    fn the_recorded_dialect_cases_are_told_apart_as_python_does() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../tests/json_dialect.json")).unwrap();
        assert!(cases.len() > 30);
        let mut wrong = Vec::new();
        for case in &cases {
            let (text, parsed) = match case["hex"].as_str() {
                Some(hex) => {
                    let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap()).collect();
                    (hex, parse_bytes(&bytes))
                }
                None => {
                    let text = case["text"].as_str().unwrap();
                    (text, parse(text))
                }
            };
            let got = match parsed {
                Parsed::Value(_) => "rust",
                Parsed::Python => "python",
                Parsed::Rejected => "rejected",
            };
            if got != case["expect"].as_str().unwrap() {
                wrong.push(format!("{text:?}: {got}, expected {}", case["expect"]));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    /// Nesting is built here and in `backend/tests/test_cli_runtime_json.py`,
    /// not typed into the cases file.
    #[test]
    fn nesting_past_serde_jsons_limit_is_left_to_python() {
        let nested = |depth: usize| format!("{{\"n\":{}{}}}", "[".repeat(depth), "]".repeat(depth));
        assert!(matches!(parse(&nested(100)), Parsed::Value(_)));
        assert_eq!(parse(&nested(200)), Parsed::Python, "past 128 levels, within Python's");
        assert_eq!(parse(&nested(5000)), Parsed::Python, "past 900 levels the text is Python's, to read or to raise on");
        assert_eq!(parse(&format!("{}{}", "[".repeat(200), "]".repeat(199))), Parsed::Rejected, "unbalanced is corrupt at any depth");
    }

    #[test]
    fn bytes_that_are_not_utf8_are_python_s_only_for_encoded_surrogates() {
        assert_eq!(parse_bytes(b"\x12\xff file"), Parsed::Rejected);
        assert_eq!(parse_bytes(b"\"\xed\xa0\x80\""), Parsed::Python, "an encoded surrogate, which `surrogatepass` reads");
        assert_eq!(parse_bytes(b"\"\xed\xa0\""), Parsed::Rejected, "a surrogate cut short is not read");
        assert_eq!(parse_bytes(b"\"\xed\xa0\x80\xff\""), Parsed::Rejected, "a surrogate beside a byte nothing reads");
        assert_eq!(parse_bytes(b"\"\xed\xa0\x80\xed\xb0\x80\""), Parsed::Python, "two surrogates");
        assert_eq!(parse_bytes(b"{\"a\":NaN}"), Parsed::Python);
        assert!(matches!(parse_bytes(b"[1]"), Parsed::Value(_)));
    }
}
