//! Incremental byte statistics for a file that arrives one chunk at a time.
//!
//! The first statistic is a count of newline bytes (`0x0A`). A newline is a
//! single byte, so splitting the input between chunks does not change the
//! total. Totals are `u64` because a 32-bit counter would wrap on a
//! multi-gigabyte file of short lines.

use std::error::Error;
use std::fmt;

/// Running totals for bytes that have been fed to the processor.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TextProcessor {
    bytes_seen: u64,
    newline_count: u64,
}

/// `bytes_seen` or `newline_count` would have exceeded `u64::MAX`.
///
/// [`TextProcessor::append_chunk`] leaves the existing totals unchanged when
/// this happens. A real file cannot reach this limit; the check is what keeps
/// a wrapped counter from looking like a successful scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CounterOverflow;

impl fmt::Display for CounterOverflow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("text counter overflowed u64")
    }
}

impl Error for CounterOverflow {}

impl TextProcessor {
    /// Start with both totals at zero.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add one chunk to the running totals.
    ///
    /// Every byte is valid input. The only failure is a `u64` overflow, in
    /// which case `self` is not modified.
    pub fn append_chunk(&mut self, chunk: &[u8]) -> Result<(), CounterOverflow> {
        let bytes_seen = self
            .bytes_seen
            .checked_add(chunk.len() as u64)
            .ok_or(CounterOverflow)?;
        let newline_count = self
            .newline_count
            .checked_add(count_newlines(chunk))
            .ok_or(CounterOverflow)?;

        self.bytes_seen = bytes_seen;
        self.newline_count = newline_count;
        Ok(())
    }

    /// Bytes equal to `0x0A` seen since the last [`reset`](Self::reset).
    pub fn newline_count(&self) -> u64 {
        self.newline_count
    }

    /// Bytes accepted since the last [`reset`](Self::reset).
    pub fn bytes_seen(&self) -> u64 {
        self.bytes_seen
    }

    /// Clear both totals.
    pub fn reset(&mut self) {
        self.bytes_seen = 0;
        self.newline_count = 0;
    }

    /// Seed the counters. Tests use this to exercise `u64` width without
    /// scanning multi-gigabyte input.
    #[cfg(test)]
    fn with_totals(bytes_seen: u64, newline_count: u64) -> Self {
        Self {
            bytes_seen,
            newline_count,
        }
    }
}

/// Count bytes equal to `0x0A`.
///
/// The accumulator is a `u64` on purpose. [`Iterator::count`] returns `usize`,
/// and `usize` is 32 bits on `wasm32`, so a long slice of newlines could wrap
/// it before the value ever reached [`TextProcessor`].
pub fn count_newlines(bytes: &[u8]) -> u64 {
    let mut count = 0u64;
    for byte in bytes {
        if *byte == b'\n' {
            count += 1;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input() {
        let mut processor = TextProcessor::new();
        processor.append_chunk(b"").unwrap();
        assert_eq!(processor.newline_count(), 0);
        assert_eq!(processor.bytes_seen(), 0);
        assert_eq!(count_newlines(b""), 0);
    }

    #[test]
    fn no_newlines() {
        let mut processor = TextProcessor::new();
        processor.append_chunk(b"abc").unwrap();
        assert_eq!(processor.newline_count(), 0);
        assert_eq!(processor.bytes_seen(), 3);
    }

    #[test]
    fn multiple_newlines() {
        let mut processor = TextProcessor::new();
        processor.append_chunk(b"a\n\nb\n").unwrap();
        assert_eq!(processor.newline_count(), 3);
        assert_eq!(processor.bytes_seen(), 5);
    }

    #[test]
    fn carriage_return_is_not_a_newline() {
        assert_eq!(count_newlines(b"a\r\nb\rc\n"), 2);
    }

    #[test]
    fn every_byte_can_be_a_newline() {
        let mut processor = TextProcessor::new();
        processor.append_chunk(&[b'\n'; 32]).unwrap();
        assert_eq!(processor.newline_count(), 32);
        assert_eq!(processor.bytes_seen(), 32);
    }

    #[test]
    fn chunk_boundaries_match_a_single_pass() {
        let data = b"alpha\nbeta\ngamma\n";
        let whole = count_newlines(data);

        for split in 0..=data.len() {
            let mut processor = TextProcessor::new();
            processor.append_chunk(&data[..split]).unwrap();
            processor.append_chunk(&data[split..]).unwrap();
            assert_eq!(processor.newline_count(), whole, "split at {split}");
            assert_eq!(processor.bytes_seen(), data.len() as u64);
        }
    }

    #[test]
    fn newline_at_either_side_of_a_boundary() {
        let mut processor = TextProcessor::new();
        processor.append_chunk(b"abc\n").unwrap();
        processor.append_chunk(b"\ndef").unwrap();
        assert_eq!(processor.newline_count(), 2);
        assert_eq!(processor.bytes_seen(), 8);
    }

    #[test]
    fn empty_chunk_between_data() {
        let mut processor = TextProcessor::new();
        processor.append_chunk(b"ab\n").unwrap();
        processor.append_chunk(b"").unwrap();
        processor.append_chunk(b"\ncd").unwrap();
        assert_eq!(processor.newline_count(), 2);
        assert_eq!(processor.bytes_seen(), 6);
    }

    #[test]
    fn repeated_processing_and_reset() {
        let mut processor = TextProcessor::new();
        processor.append_chunk(b"a\n").unwrap();
        processor.append_chunk(b"b\n").unwrap();
        assert_eq!(processor.newline_count(), 2);
        assert_eq!(processor.bytes_seen(), 4);

        processor.reset();
        assert_eq!(processor.newline_count(), 0);
        assert_eq!(processor.bytes_seen(), 0);

        processor.append_chunk(b"a\n").unwrap();
        assert_eq!(processor.newline_count(), 1);
        assert_eq!(processor.bytes_seen(), 2);
    }

    #[test]
    fn many_chunks_accumulate() {
        let mut processor = TextProcessor::new();
        for _ in 0..1_000 {
            processor.append_chunk(b"x\n").unwrap();
        }
        assert_eq!(processor.newline_count(), 1_000);
        assert_eq!(processor.bytes_seen(), 2_000);
    }

    #[test]
    fn large_cumulative_counts_use_u64() {
        let mut near_u32 = TextProcessor::with_totals(0, u64::from(u32::MAX) - 1);
        near_u32.append_chunk(b"\n\n\n").unwrap();
        assert_eq!(near_u32.newline_count(), u64::from(u32::MAX) + 2);
        assert_eq!(near_u32.bytes_seen(), 3);

        let mut near_u64 = TextProcessor::with_totals(u64::MAX - 10, u64::MAX - 2);
        near_u64.append_chunk(b"\nx").unwrap();
        assert_eq!(near_u64.newline_count(), u64::MAX - 1);
        assert_eq!(near_u64.bytes_seen(), u64::MAX - 8);
    }

    #[test]
    fn adding_zero_newlines_does_not_overflow_a_full_counter() {
        let mut processor = TextProcessor::with_totals(0, u64::MAX);
        processor.append_chunk(b"x").unwrap();
        assert_eq!(processor.newline_count(), u64::MAX);
        assert_eq!(processor.bytes_seen(), 1);
    }

    #[test]
    fn overflow_leaves_the_previous_totals_in_place() {
        let mut newlines = TextProcessor::with_totals(4, u64::MAX);
        assert_eq!(newlines.append_chunk(b"\n"), Err(CounterOverflow));
        assert_eq!(newlines.newline_count(), u64::MAX);
        assert_eq!(newlines.bytes_seen(), 4);

        let mut bytes = TextProcessor::with_totals(u64::MAX, 7);
        assert_eq!(bytes.append_chunk(b"x"), Err(CounterOverflow));
        assert_eq!(bytes.bytes_seen(), u64::MAX);
        assert_eq!(bytes.newline_count(), 7);
    }
}
