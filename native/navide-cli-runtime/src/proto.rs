//! Protobuf wire format, read without a schema: the top-level fields of a
//! message, as main's readers scan undocumented blobs (antigravity's
//! `_pb_scan`). A field that does not parse ends the scan; nothing raises.

pub enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

fn varint(buf: &[u8], mut i: usize) -> (Option<u64>, usize) {
    let (mut shift, mut value) = (0u32, 0u64);
    while i < buf.len() {
        let byte = buf[i];
        i += 1;
        value |= u64::from(byte & 0x7f).checked_shl(shift).unwrap_or(0);
        if byte & 0x80 == 0 {
            return (Some(value), i);
        }
        shift += 7;
        if shift > 63 {
            return (None, i);
        }
    }
    (None, i)
}

/// `(field number, value)` of every top-level varint and length-delimited
/// field; fixed-width fields are skipped, groups end the scan.
pub fn scan(blob: &[u8]) -> Vec<(u64, Field<'_>)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < blob.len() {
        let (Some(key), next) = varint(blob, i) else { break };
        i = next;
        let (field, wire) = (key >> 3, key & 7);
        match wire {
            0 => {
                let (Some(value), next) = varint(blob, i) else { break };
                i = next;
                out.push((field, Field::Varint(value)));
            }
            2 => {
                let (Some(len), next) = varint(blob, i) else { break };
                let Some(end) = usize::try_from(len).ok().and_then(|len| next.checked_add(len)).filter(|end| *end <= blob.len()) else { break };
                out.push((field, Field::Bytes(&blob[next..end])));
                i = end;
            }
            5 => i += 4,
            1 => i += 8,
            _ => break,
        }
    }
    out
}

/// The first length-delimited field with this number ("" when none).
pub fn bytes(blob: &[u8], number: u64) -> &[u8] {
    scan(blob).into_iter().find_map(|(f, v)| match v {
        Field::Bytes(b) if f == number => Some(b),
        _ => None,
    }).unwrap_or_default()
}

/// The first varint field with this number.
pub fn varint_field(blob: &[u8], number: u64) -> Option<u64> {
    scan(blob).into_iter().find_map(|(f, v)| match v {
        Field::Varint(n) if f == number => Some(n),
        _ => None,
    })
}

/// The submessage at `path` (field numbers, first occurrence each); empty
/// when any step is missing.
pub fn at<'b>(blob: &'b [u8], path: &[u64]) -> &'b [u8] {
    path.iter().fold(blob, |node, field| bytes(node, *field))
}

/// The first of `fields` in `message` holding clean text (UTF-8 without
/// control characters but tab and newlines), stripped; "" when none does.
pub fn clean_text<'b>(message: &'b [u8], fields: &[u64]) -> &'b str {
    fn clean(b: &[u8]) -> Option<&str> {
        std::str::from_utf8(b).ok().filter(|t| !t.chars().any(|c| c < ' ' && !matches!(c, '\t' | '\n' | '\r')))
    }
    if message.is_empty() {
        return "";
    }
    let scanned = scan(message);
    fields
        .iter()
        .flat_map(|field| {
            scanned.iter().filter_map(move |(f, v)| match v {
                Field::Bytes(b) if f == field => Some(*b),
                _ => None,
            })
        })
        .filter_map(clean)
        .map(crate::expr::py_strip)
        .find(|t| !t.is_empty())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_like_mains_pb_scan() {
        // field 1 varint 150, field 2 bytes "hi", a fixed32, then a group (ends the scan).
        let blob = [0x08, 0x96, 0x01, 0x12, 0x02, b'h', b'i', 0x1d, 0, 0, 0, 0, 0x1b, 0x08, 0x01];
        let fields = scan(&blob);
        assert_eq!(fields.len(), 2);
        assert_eq!(varint_field(&blob, 1), Some(150));
        assert_eq!(bytes(&blob, 2), b"hi");
        // A length past the end stops the scan.
        assert!(scan(&[0x12, 0x05, b'a']).is_empty());
        // field 20 { field 1: "\x01bad", field 8: " ok " }: the first clean text wins.
        let nested = [0xa2, 0x01, 0x0c, 0x0a, 0x04, 0x01, b'b', b'a', b'd', 0x42, 0x04, b' ', b'o', b'k', b' '];
        assert_eq!(clean_text(at(&nested, &[20]), &[1, 8]), "ok");
        assert_eq!(clean_text(at(&nested, &[21]), &[1, 8]), "");
    }
}
