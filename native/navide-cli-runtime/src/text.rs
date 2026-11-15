//! Text helpers that follow a Python standard-library function, shared by the
//! core and by vendor extractions (one implementation each).

/// `urllib.parse.unquote`: `%XX` escapes are decoded within each ASCII run,
/// as UTF-8 with invalid bytes replaced; other characters pass through.
pub fn unquote(text: &str) -> String {
    if !text.contains('%') {
        return text.to_owned();
    }
    fn flush(ascii: &mut Vec<u8>, out: &mut String) {
        let hex = |b: u8| (b as char).to_digit(16);
        let mut bytes = Vec::with_capacity(ascii.len());
        let mut i = 0;
        while i < ascii.len() {
            match (ascii[i], ascii.get(i + 1).and_then(|b| hex(*b)), ascii.get(i + 2).and_then(|b| hex(*b))) {
                (b'%', Some(hi), Some(lo)) => {
                    bytes.push((hi * 16 + lo) as u8);
                    i += 3;
                }
                (b, _, _) => {
                    bytes.push(b);
                    i += 1;
                }
            }
        }
        out.push_str(&String::from_utf8_lossy(&bytes));
        ascii.clear();
    }
    let mut out = String::new();
    let mut ascii = Vec::new();
    for c in text.chars() {
        if c.is_ascii() {
            ascii.push(c as u8);
        } else {
            flush(&mut ascii, &mut out);
            out.push(c);
        }
    }
    flush(&mut ascii, &mut out);
    out
}

/// `str(PurePosixPath(path))`: empty and `.` parts dropped, a leading `//`
/// (exactly two) kept.
pub fn posix_normalise(path: &str) -> String {
    let root = if path.starts_with("//") && !path.starts_with("///") {
        "//"
    } else if path.starts_with('/') {
        "/"
    } else {
        ""
    };
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    let joined = format!("{root}{}", parts.join("/"));
    if joined.is_empty() { ".".to_owned() } else { joined }
}

/// Bytes decoded as UTF-8 with invalid sequences dropped (Python
/// `errors="ignore"`).
pub fn ignore_invalid(bytes: &[u8]) -> String {
    bytes.utf8_chunks().map(|chunk| chunk.valid()).collect()
}

/// The text between the first `open` that a `close` follows and that close.
pub fn enclosed<'t>(text: &'t str, open: &str, close: &str) -> Option<&'t str> {
    let mut from = 0;
    while let Some(found) = text[from..].find(open) {
        let start = from + found + open.len();
        if let Some(len) = text[start..].find(close) {
            return Some(&text[start..start + len]);
        }
        from = start;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquote_matches_urllib() {
        assert_eq!(unquote("%2FUsers%2Fme%2Fa%20b"), "/Users/me/a b");
        assert_eq!(unquote("100%"), "100%");
        assert_eq!(unquote("%zz%e4%b8%ad"), "%zz中");
        assert_eq!(unquote("é%20%41"), "é A");
        assert_eq!(unquote("%ff"), "\u{fffd}");
    }

    #[test]
    fn posix_paths_and_enclosures() {
        assert_eq!(posix_normalise("//a/./b//c"), "//a/b/c");
        assert_eq!(posix_normalise("///a/"), "/a");
        assert_eq!(posix_normalise(""), ".");
        assert_eq!(enclosed("a <q> one </q> <q>two</q>", "<q>", "</q>"), Some(" one "));
        assert_eq!(enclosed("<q> open only", "<q>", "</q>"), None);
        assert_eq!(ignore_invalid(b"a\xffb"), "ab");
    }
}
