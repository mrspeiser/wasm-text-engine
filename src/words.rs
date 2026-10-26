//! Newline count that looks at eight bytes per step.
//!
//! [`count_newlines_words`] must return the same total as
//! [`crate::count_newlines`] for every input. The scalar function stays the
//! benchmark baseline. This one is a separate column.
//!
//! A newline is one byte, so a chunk boundary cannot split one. The tail
//! shorter than eight bytes is counted with the scalar loop.

use crate::processor::{CounterOverflow, count_newlines};

/// Running totals for the eight-byte newline scan.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WordProcessor {
    bytes_seen: u64,
    newline_count: u64,
}

impl WordProcessor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add one chunk. On overflow, `self` is left as it was.
    pub fn append_chunk(&mut self, chunk: &[u8]) -> Result<(), CounterOverflow> {
        let bytes_seen = self
            .bytes_seen
            .checked_add(chunk.len() as u64)
            .ok_or(CounterOverflow)?;
        let newline_count = self
            .newline_count
            .checked_add(count_newlines_words(chunk))
            .ok_or(CounterOverflow)?;

        self.bytes_seen = bytes_seen;
        self.newline_count = newline_count;
        Ok(())
    }

    pub fn newline_count(&self) -> u64 {
        self.newline_count
    }

    pub fn bytes_seen(&self) -> u64 {
        self.bytes_seen
    }

    pub fn reset(&mut self) {
        self.bytes_seen = 0;
        self.newline_count = 0;
    }

    #[cfg(test)]
    fn with_totals(bytes_seen: u64, newline_count: u64) -> Self {
        Self {
            bytes_seen,
            newline_count,
        }
    }
}

/// Count `0x0A` bytes eight at a time.
///
/// Each matching byte sets one high bit. Adding `0x7F` to the low seven bits
/// of a byte never carries into the next byte, so a match in one lane cannot
/// look like a match in the next.
pub fn count_newlines_words(bytes: &[u8]) -> u64 {
    let mut count = 0u64;
    let mut chunks = bytes.chunks_exact(8);
    for chunk in chunks.by_ref() {
        let word = u64::from_le_bytes(chunk.try_into().expect("chunk is 8 bytes"));
        count += newline_mask(word).count_ones() as u64;
    }
    count + count_newlines(chunks.remainder())
}

fn newline_mask(word: u64) -> u64 {
    let zeroed = word ^ 0x0A0A_0A0A_0A0A_0A0A;
    let low = (zeroed & 0x7F7F_7F7F_7F7F_7F7F).wrapping_add(0x7F7F_7F7F_7F7F_7F7F);
    !(low | zeroed | 0x7F7F_7F7F_7F7F_7F7F) & 0x8080_8080_8080_8080
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_short_tails_match_the_scalar_count() {
        for len in 0..8 {
            let bytes = vec![b'\n'; len];
            assert_eq!(count_newlines_words(&bytes), count_newlines(&bytes));
            let text = b"abc\nxyz".iter().take(len).copied().collect::<Vec<_>>();
            assert_eq!(count_newlines_words(&text), count_newlines(&text));
        }
    }

    #[test]
    fn every_byte_in_every_lane_matches_the_scalar_count() {
        let mut bytes = [0u8; 8];
        for lane in 0..8 {
            for value in 0u8..=255 {
                bytes[lane] = value;
                assert_eq!(
                    count_newlines_words(&bytes),
                    count_newlines(&bytes),
                    "lane {lane} value {value}"
                );
            }
            bytes[lane] = 0;
        }
    }

    #[test]
    fn a_zero_byte_does_not_create_a_false_match_beside_it() {
        let bytes = [0x00, 0x01, 0x0A, 0x80, 0xFF, 0x0A, 0x7F, 0x0A];
        assert_eq!(count_newlines_words(&bytes), 3);
        assert_eq!(count_newlines_words(&bytes), count_newlines(&bytes));
    }

    #[test]
    fn every_split_matches_one_pass_and_the_scalar_count() {
        let bytes: Vec<u8> = (0u16..300).map(|value| value as u8).collect();
        let once = count_newlines_words(&bytes);
        assert_eq!(once, count_newlines(&bytes));
        for size in 1..bytes.len() {
            let mut split = 0u64;
            for chunk in bytes.chunks(size) {
                split += count_newlines_words(chunk);
            }
            assert_eq!(split, once, "chunk size {size}");
        }
    }

    #[test]
    fn the_processor_matches_one_count_and_reset_clears_it() {
        let mut processor = WordProcessor::new();
        processor.append_chunk(b"a\nb").unwrap();
        processor.append_chunk(b"\n\n").unwrap();
        assert_eq!(processor.newline_count(), 3);
        assert_eq!(processor.bytes_seen(), 5);
        processor.reset();
        assert_eq!(processor.newline_count(), 0);
        assert_eq!(processor.bytes_seen(), 0);
    }

    #[test]
    fn overflow_leaves_the_previous_totals_in_place() {
        let mut processor = WordProcessor::with_totals(u64::MAX, 4);
        let before = processor.clone();
        assert!(processor.append_chunk(b"\n").is_err());
        assert_eq!(processor, before);
    }
}
