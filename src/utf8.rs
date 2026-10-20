//! One UTF-8 unit at a time, using the same cuts as [`std::str::from_utf8`].
//!
//! A unit is a Unicode scalar, a maximal ill-formed subsequence, or a prefix
//! that might still become a scalar if more bytes arrive. Callers keep at most
//! three prefix bytes and try again with the next chunk.

/// The next UTF-8 unit at the front of `input`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeStep {
    /// One Unicode scalar occupying `len` bytes.
    Scalar { len: usize },
    /// One maximal ill-formed subsequence occupying `len` bytes.
    ///
    /// `len` is [`std::str::Utf8Error::error_len`] for that subsequence.
    Invalid { len: usize },
    /// `input` is a prefix of a scalar and needs more bytes.
    Incomplete,
}

impl DecodeStep {
    pub(crate) fn unit_len(self) -> Option<usize> {
        match self {
            DecodeStep::Scalar { len } | DecodeStep::Invalid { len } => Some(len),
            DecodeStep::Incomplete => None,
        }
    }
}

/// Classify the first unit in `input`.
///
/// Only the first four bytes are inspected. A longer slice is not consumed
/// past the first scalar or invalid subsequence.
pub fn next_unit(input: &[u8]) -> DecodeStep {
    if input.is_empty() {
        return DecodeStep::Incomplete;
    }

    let window = &input[..input.len().min(4)];
    match std::str::from_utf8(window) {
        Ok(text) => DecodeStep::Scalar {
            len: first_char_len(text),
        },
        Err(error) if error.valid_up_to() > 0 => {
            let valid = &window[..error.valid_up_to()];
            let text = std::str::from_utf8(valid).expect("valid_up_to marks valid UTF-8");
            DecodeStep::Scalar {
                len: first_char_len(text),
            }
        }
        Err(error) => match error.error_len() {
            Some(len) => DecodeStep::Invalid { len },
            None if input.len() > window.len() => DecodeStep::Invalid { len: 1 },
            None => DecodeStep::Incomplete,
        },
    }
}

fn first_char_len(text: &str) -> usize {
    text.chars()
        .next()
        .expect("non-empty UTF-8 has a scalar")
        .len_utf8()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn walk(input: &[u8]) -> (u64, u64) {
        let mut index = 0;
        let mut scalars = 0u64;
        let mut invalid = 0u64;
        while index < input.len() {
            match next_unit(&input[index..]) {
                DecodeStep::Incomplete => {
                    scalars += 1;
                    invalid += 1;
                    break;
                }
                DecodeStep::Scalar { len } | DecodeStep::Invalid { len } => {
                    assert!(len > 0, "a unit must consume a byte");
                    if matches!(next_unit(&input[index..]), DecodeStep::Invalid { .. }) {
                        invalid += 1;
                    }
                    scalars += 1;
                    index += len;
                }
            }
        }
        (scalars, invalid)
    }

    #[test]
    fn empty_input_is_incomplete() {
        assert_eq!(next_unit(b""), DecodeStep::Incomplete);
    }

    #[test]
    fn ascii_consumes_one_byte_even_when_more_follow() {
        assert_eq!(next_unit(b"ab"), DecodeStep::Scalar { len: 1 });
    }

    #[test]
    fn multibyte_scalar_and_its_prefixes() {
        let e_acute = "é".as_bytes();
        assert_eq!(e_acute, &[0xC3, 0xA9]);
        assert_eq!(next_unit(e_acute), DecodeStep::Scalar { len: 2 });
        assert_eq!(next_unit(&e_acute[..1]), DecodeStep::Incomplete);

        let emoji = "😀".as_bytes();
        assert_eq!(emoji.len(), 4);
        assert_eq!(next_unit(emoji), DecodeStep::Scalar { len: 4 });
        assert_eq!(next_unit(&emoji[..1]), DecodeStep::Incomplete);
        assert_eq!(next_unit(&emoji[..2]), DecodeStep::Incomplete);
        assert_eq!(next_unit(&emoji[..3]), DecodeStep::Incomplete);
    }

    #[test]
    fn invalid_lead_is_one_byte() {
        assert_eq!(next_unit(&[0xFF, b'A']), DecodeStep::Invalid { len: 1 });
    }

    #[test]
    fn walk_matches_chars_and_lossy_replacements() {
        let inputs: [&[u8]; 5] = [
            "hello".as_bytes(),
            "héllo 😀".as_bytes(),
            b"a\xFF b\xC3\xA9",
            b"\xC3",
            b"\xE0\x80\x80\xF5\x80",
        ];
        for input in inputs {
            let (scalars, invalid) = walk(input);
            let lossy = String::from_utf8_lossy(input);
            assert_eq!(scalars, lossy.chars().count() as u64, "{input:?}");
            let replacements = lossy.chars().filter(|ch| *ch == '\u{FFFD}').count() as u64;
            assert_eq!(invalid, replacements, "{input:?}");
        }
    }
}
