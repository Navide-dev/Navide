//! BLAKE2b (RFC 7693), unkeyed, any digest length up to 64 bytes.
//!
//! A checkpoint's `anchor` is `hashlib.blake2b(bytes, digest_size=8)` in hex
//! (main's contract). Reused from the evaluation crate, where it was checked
//! against Python's own output.
const IV: [u64; 8] = [
    0x6a09e667f3bcc908,
    0xbb67ae8584caa73b,
    0x3c6ef372fe94f82b,
    0xa54ff53a5f1d36f1,
    0x510e527fade682d1,
    0x9b05688c2b3e6c1f,
    0x1f83d9abfb41bd6b,
    0x5be0cd19137e2179,
];

const SIGMA: [[usize; 16]; 10] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

fn compress(h: &mut [u64; 8], block: &[u8], counter: u128, last: bool) {
    let mut m = [0u64; 16];
    for (word, bytes) in m.iter_mut().zip(block.chunks_exact(8)) {
        *word = u64::from_le_bytes(bytes.try_into().expect("8 bytes"));
    }
    let mut v = [0u64; 16];
    v[..8].copy_from_slice(h);
    v[8..].copy_from_slice(&IV);
    v[12] ^= counter as u64;
    v[13] ^= (counter >> 64) as u64;
    if last {
        v[14] = !v[14];
    }
    for round in 0..12 {
        let s = &SIGMA[round % 10];
        let mut mix = |a: usize, b: usize, c: usize, d: usize, x: u64, y: u64| {
            v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
            v[d] = (v[d] ^ v[a]).rotate_right(32);
            v[c] = v[c].wrapping_add(v[d]);
            v[b] = (v[b] ^ v[c]).rotate_right(24);
            v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
            v[d] = (v[d] ^ v[a]).rotate_right(16);
            v[c] = v[c].wrapping_add(v[d]);
            v[b] = (v[b] ^ v[c]).rotate_right(63);
        };
        mix(0, 4, 8, 12, m[s[0]], m[s[1]]);
        mix(1, 5, 9, 13, m[s[2]], m[s[3]]);
        mix(2, 6, 10, 14, m[s[4]], m[s[5]]);
        mix(3, 7, 11, 15, m[s[6]], m[s[7]]);
        mix(0, 5, 10, 15, m[s[8]], m[s[9]]);
        mix(1, 6, 11, 12, m[s[10]], m[s[11]]);
        mix(2, 7, 8, 13, m[s[12]], m[s[13]]);
        mix(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for i in 0..8 {
        h[i] ^= v[i] ^ v[i + 8];
    }
}

/// The digest of `data`, `digest_len` bytes long (1..=64), as lower-case hex.
pub fn hex_digest(data: &[u8], digest_len: usize) -> String {
    assert!((1..=64).contains(&digest_len));
    let mut h = IV;
    h[0] ^= 0x0101_0000 ^ digest_len as u64;
    let mut blocks = data.chunks(128).peekable();
    let mut counter = 0u128;
    if blocks.peek().is_none() {
        compress(&mut h, &[0; 128], 0, true);
    }
    while let Some(block) = blocks.next() {
        counter += block.len() as u128;
        let mut padded = [0u8; 128];
        padded[..block.len()].copy_from_slice(block);
        compress(&mut h, &padded, counter, blocks.peek().is_none());
    }
    h.iter().flat_map(|word| word.to_le_bytes()).take(digest_len).map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::hex_digest;

    /// `hashlib.blake2b(data, digest_size=8)` reference vectors (empty, `abc`,
    /// and the bytes 0..=255 three times).
    #[test]
    fn the_8_byte_anchor_digest_matches_the_python_reference_vectors() {
        let three_runs: Vec<u8> = (0..768u32).map(|n| (n % 256) as u8).collect();
        assert_eq!(hex_digest(b"", 8), "e4a6a0577479b2b4");
        assert_eq!(hex_digest(b"abc", 8), "d8bb14d833d59559");
        assert_eq!(hex_digest(&three_runs, 8), "6cdb98d18e1d1970");
    }
}
