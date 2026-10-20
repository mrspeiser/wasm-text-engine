//! Streaming text totals.
//!
//! [`TextStats`] keeps two pieces of state between chunks: at most three
//! undecided UTF-8 bytes, and whether the previous byte was `\r`. A following
//! `\n` then counts as one CRLF line ending rather than a bare newline.
//!
//! The newline benchmark does not use this type. [`crate::TextProcessor`]
//! still counts `0x0A` and nothing else, so its timings stay comparable to the
//! JavaScript loop.

use crate::processor::CounterOverflow;
use crate::utf8::{DecodeStep, next_unit};

/// Totals for one file fed a chunk at a time.
///
/// Call [`finish`](Self::finish) after the last chunk. Until then a trailing
/// `\r` or a partial UTF-8 sequence is still undecided, and the longest-line
/// figures do not include the open line.
#[derive(Debug, Clone)]
pub struct TextStats {
    pending: [u8; 3],
    pending_len: usize,
    pending_cr: bool,
    bytes: u64,
    scalars: u64,
    invalid_sequences: u64,
    newline_count: u64,
    crlf_count: u64,
    closed_lines: u64,
    open_line_bytes: u64,
    open_line_scalars: u64,
    longest_line_bytes: u64,
    longest_line_scalars: u64,
}

impl Default for TextStats {
    fn default() -> Self {
        Self::new()
    }
}

impl TextStats {
    pub fn new() -> Self {
        Self {
            pending: [0; 3],
            pending_len: 0,
            pending_cr: false,
            bytes: 0,
            scalars: 0,
            invalid_sequences: 0,
            newline_count: 0,
            crlf_count: 0,
            closed_lines: 0,
            open_line_bytes: 0,
            open_line_scalars: 0,
            longest_line_bytes: 0,
            longest_line_scalars: 0,
        }
    }

    /// Add one chunk. On overflow, `self` is left as it was.
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), CounterOverflow> {
        let mut next = self.clone();
        next.push_chunk_mutating(chunk)?;
        *self = next;
        Ok(())
    }

    /// Resolve a trailing partial character and include the open line.
    ///
    /// A second call is a no-op when nothing is pending. On overflow, `self`
    /// is left as it was.
    pub fn finish(&mut self) -> Result<(), CounterOverflow> {
        let mut next = self.clone();
        if next.pending_len > 0 {
            let len = next.pending_len;
            next.pending_len = 0;
            next.scalars = next.scalars.checked_add(1).ok_or(CounterOverflow)?;
            next.invalid_sequences = next
                .invalid_sequences
                .checked_add(1)
                .ok_or(CounterOverflow)?;
            next.push_content(len)?;
        }
        next.pending_cr = false;
        next.note_longest();
        *self = next;
        Ok(())
    }

    /// Drop totals and any carry from the previous file.
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    /// Unicode scalars, with one replacement per invalid subsequence.
    pub fn scalars(&self) -> u64 {
        self.scalars
    }

    pub fn invalid_sequences(&self) -> u64 {
        self.invalid_sequences
    }

    /// Bytes equal to `0x0A`. This matches the newline benchmark.
    pub fn newline_count(&self) -> u64 {
        self.newline_count
    }

    /// Newlines that were the second byte of a CRLF pair.
    pub fn crlf_count(&self) -> u64 {
        self.crlf_count
    }

    /// Lines separated by `\n`.
    ///
    /// A final non-empty line with no newline counts. An empty file has zero
    /// lines. A bare `\r` does not end a line. Read this after [`finish`](Self::finish).
    pub fn line_count(&self) -> u64 {
        if self.bytes == 0 {
            return 0;
        }
        if self.open_line_bytes == 0 && self.open_line_scalars == 0 {
            return self.closed_lines;
        }
        self.closed_lines.saturating_add(1)
    }

    /// Longest line in bytes, excluding `\n` and the `\r` of a CRLF pair.
    pub fn longest_line_bytes(&self) -> u64 {
        self.longest_line_bytes
    }

    /// Longest line in scalars, using the same exclusion as
    /// [`longest_line_bytes`](Self::longest_line_bytes).
    pub fn longest_line_scalars(&self) -> u64 {
        self.longest_line_scalars
    }

    fn push_chunk_mutating(&mut self, chunk: &[u8]) -> Result<(), CounterOverflow> {
        self.bytes = self
            .bytes
            .checked_add(chunk.len() as u64)
            .ok_or(CounterOverflow)?;

        let mut index = self.consume_pending(chunk)?;
        while index < chunk.len() {
            match next_unit(&chunk[index..]) {
                DecodeStep::Incomplete => {
                    let rest = &chunk[index..];
                    if rest.len() > self.pending.len() {
                        self.emit_invalid_byte(chunk[index])?;
                        index += 1;
                        continue;
                    }
                    self.pending[..rest.len()].copy_from_slice(rest);
                    self.pending_len = rest.len();
                    break;
                }
                step => {
                    let len = step
                        .unit_len()
                        .expect("scalar and invalid steps have a length");
                    self.emit(&chunk[index..index + len], step)?;
                    index += len;
                }
            }
        }
        Ok(())
    }

    /// Resolve saved prefix bytes against the front of `chunk`.
    ///
    /// Returns how many bytes of `chunk` were consumed.
    fn consume_pending(&mut self, chunk: &[u8]) -> Result<usize, CounterOverflow> {
        while self.pending_len > 0 {
            let mut buffer = [0u8; 4];
            let pending_len = self.pending_len;
            buffer[..pending_len].copy_from_slice(&self.pending[..pending_len]);
            let take = (buffer.len() - pending_len).min(chunk.len());
            buffer[pending_len..pending_len + take].copy_from_slice(&chunk[..take]);
            let available = pending_len + take;

            match next_unit(&buffer[..available]) {
                DecodeStep::Incomplete if available >= 4 => {
                    self.emit_invalid_byte(buffer[0])?;
                    self.shift_pending(1);
                }
                DecodeStep::Incomplete => {
                    self.pending[..available].copy_from_slice(&buffer[..available]);
                    self.pending_len = available;
                    return Ok(chunk.len());
                }
                step => {
                    let len = step
                        .unit_len()
                        .expect("scalar and invalid steps have a length");
                    if len <= pending_len {
                        self.emit(&buffer[..len], step)?;
                        self.shift_pending(len);
                    } else {
                        self.emit(&buffer[..len], step)?;
                        self.pending_len = 0;
                        return Ok(len - pending_len);
                    }
                }
            }
        }
        Ok(0)
    }

    fn shift_pending(&mut self, consumed: usize) {
        let rest = self.pending_len - consumed;
        self.pending.copy_within(consumed..self.pending_len, 0);
        self.pending_len = rest;
    }

    fn emit_invalid_byte(&mut self, byte: u8) -> Result<(), CounterOverflow> {
        self.emit(&[byte], DecodeStep::Invalid { len: 1 })
    }

    fn emit(&mut self, bytes: &[u8], step: DecodeStep) -> Result<(), CounterOverflow> {
        self.scalars = self.scalars.checked_add(1).ok_or(CounterOverflow)?;
        match step {
            DecodeStep::Invalid { .. } => {
                self.invalid_sequences = self
                    .invalid_sequences
                    .checked_add(1)
                    .ok_or(CounterOverflow)?;
                self.push_content(bytes.len())?;
            }
            DecodeStep::Scalar { .. } if bytes == b"\n" => self.push_newline()?,
            DecodeStep::Scalar { .. } if bytes == b"\r" => self.push_cr()?,
            DecodeStep::Scalar { .. } => self.push_content(bytes.len())?,
            DecodeStep::Incomplete => unreachable!("incomplete input is saved, not emitted"),
        }
        Ok(())
    }

    fn push_content(&mut self, nbytes: usize) -> Result<(), CounterOverflow> {
        self.pending_cr = false;
        self.open_line_bytes = self
            .open_line_bytes
            .checked_add(nbytes as u64)
            .ok_or(CounterOverflow)?;
        self.open_line_scalars = self
            .open_line_scalars
            .checked_add(1)
            .ok_or(CounterOverflow)?;
        Ok(())
    }

    fn push_cr(&mut self) -> Result<(), CounterOverflow> {
        self.pending_cr = true;
        self.open_line_bytes = self.open_line_bytes.checked_add(1).ok_or(CounterOverflow)?;
        self.open_line_scalars = self
            .open_line_scalars
            .checked_add(1)
            .ok_or(CounterOverflow)?;
        Ok(())
    }

    fn push_newline(&mut self) -> Result<(), CounterOverflow> {
        if self.pending_cr {
            self.open_line_bytes = self.open_line_bytes.checked_sub(1).ok_or(CounterOverflow)?;
            self.open_line_scalars = self
                .open_line_scalars
                .checked_sub(1)
                .ok_or(CounterOverflow)?;
            self.crlf_count = self.crlf_count.checked_add(1).ok_or(CounterOverflow)?;
        }
        self.note_longest();
        self.open_line_bytes = 0;
        self.open_line_scalars = 0;
        self.closed_lines = self.closed_lines.checked_add(1).ok_or(CounterOverflow)?;
        self.newline_count = self.newline_count.checked_add(1).ok_or(CounterOverflow)?;
        self.pending_cr = false;
        Ok(())
    }

    fn note_longest(&mut self) {
        self.longest_line_bytes = self.longest_line_bytes.max(self.open_line_bytes);
        self.longest_line_scalars = self.longest_line_scalars.max(self.open_line_scalars);
    }

    #[cfg(test)]
    fn with_bytes(bytes: u64) -> Self {
        Self {
            bytes,
            ..Self::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processor::count_newlines;

    #[derive(Debug, PartialEq, Eq)]
    struct Snapshot {
        bytes: u64,
        scalars: u64,
        invalid_sequences: u64,
        newline_count: u64,
        crlf_count: u64,
        line_count: u64,
        longest_line_bytes: u64,
        longest_line_scalars: u64,
    }

    fn summarize(input: &[u8]) -> Snapshot {
        let mut stats = TextStats::new();
        stats.push_chunk(input).unwrap();
        stats.finish().unwrap();
        snapshot(&stats)
    }

    fn snapshot(stats: &TextStats) -> Snapshot {
        Snapshot {
            bytes: stats.bytes(),
            scalars: stats.scalars(),
            invalid_sequences: stats.invalid_sequences(),
            newline_count: stats.newline_count(),
            crlf_count: stats.crlf_count(),
            line_count: stats.line_count(),
            longest_line_bytes: stats.longest_line_bytes(),
            longest_line_scalars: stats.longest_line_scalars(),
        }
    }

    fn assert_splits_match(input: &[u8]) {
        let whole = summarize(input);
        for split in 0..=input.len() {
            let mut stats = TextStats::new();
            stats.push_chunk(&input[..split]).unwrap();
            stats.push_chunk(&input[split..]).unwrap();
            stats.finish().unwrap();
            assert_eq!(snapshot(&stats), whole, "split at {split} of {input:?}");
        }
        assert_eq!(whole.newline_count, count_newlines(input));
        assert_eq!(whole.bytes, input.len() as u64);
    }

    #[test]
    fn empty_file() {
        let stats = summarize(b"");
        assert_eq!(
            stats,
            Snapshot {
                bytes: 0,
                scalars: 0,
                invalid_sequences: 0,
                newline_count: 0,
                crlf_count: 0,
                line_count: 0,
                longest_line_bytes: 0,
                longest_line_scalars: 0,
            }
        );
    }

    #[test]
    fn line_endings_and_the_final_open_line() {
        assert_eq!(summarize(b"a").line_count, 1);
        assert_eq!(summarize(b"a\n").line_count, 1);
        assert_eq!(summarize(b"a\n\n").line_count, 2);
        assert_eq!(summarize(b"\n").line_count, 1);
        assert_eq!(summarize(b"a\nb").line_count, 2);

        let crlf = summarize(b"a\r\nb");
        assert_eq!(crlf.newline_count, 1);
        assert_eq!(crlf.crlf_count, 1);
        assert_eq!(crlf.line_count, 2);
        assert_eq!(crlf.longest_line_bytes, 1);
        assert_eq!(crlf.scalars, 4);

        let bare_cr = summarize(b"a\rb");
        assert_eq!(bare_cr.newline_count, 0);
        assert_eq!(bare_cr.crlf_count, 0);
        assert_eq!(bare_cr.line_count, 1);
        assert_eq!(bare_cr.longest_line_bytes, 3);
    }

    #[test]
    fn longest_line_excludes_the_terminator() {
        let stats = summarize("é\n😀".as_bytes());
        assert_eq!(stats.longest_line_bytes, 4);
        assert_eq!(stats.longest_line_scalars, 1);
        assert_eq!(stats.line_count, 2);
        assert_eq!(stats.scalars, 3);
    }

    #[test]
    fn crlf_split_across_chunks() {
        let mut stats = TextStats::new();
        stats.push_chunk(b"a\r").unwrap();
        stats.push_chunk(b"\nb").unwrap();
        stats.finish().unwrap();
        assert_eq!(stats.crlf_count(), 1);
        assert_eq!(stats.newline_count(), 1);
        assert_eq!(stats.line_count(), 2);
        assert_eq!(stats.longest_line_bytes(), 1);
    }

    #[test]
    fn bare_cr_at_a_boundary_stays_inside_the_line() {
        let mut stats = TextStats::new();
        stats.push_chunk(b"a\r").unwrap();
        stats.push_chunk(b"b").unwrap();
        stats.finish().unwrap();
        assert_eq!(stats.crlf_count(), 0);
        assert_eq!(stats.line_count(), 1);
        assert_eq!(stats.longest_line_bytes(), 3);
    }

    #[test]
    fn longest_line_can_cross_a_boundary() {
        let mut stats = TextStats::new();
        stats.push_chunk(b"abcd").unwrap();
        stats.push_chunk(b"ef\n").unwrap();
        stats.finish().unwrap();
        assert_eq!(stats.longest_line_bytes(), 6);
        assert_eq!(stats.line_count(), 1);
    }

    #[test]
    fn partial_character_is_completed_by_the_next_chunk() {
        let emoji = "😀".as_bytes();
        let mut stats = TextStats::new();
        stats.push_chunk(&emoji[..1]).unwrap();
        stats.push_chunk(&emoji[1..]).unwrap();
        stats.finish().unwrap();
        assert_eq!(stats.scalars(), 1);
        assert_eq!(stats.invalid_sequences(), 0);
        assert_eq!(stats.longest_line_bytes(), 4);
        assert_eq!(stats.longest_line_scalars(), 1);
    }

    #[test]
    fn finish_counts_a_truncated_character() {
        let mut stats = TextStats::new();
        stats.push_chunk(&[0xC3]).unwrap();
        stats.finish().unwrap();
        assert_eq!(stats.bytes(), 1);
        assert_eq!(stats.scalars(), 1);
        assert_eq!(stats.invalid_sequences(), 1);
        assert_eq!(stats.line_count(), 1);
        assert_eq!(stats.longest_line_bytes(), 1);
    }

    #[test]
    fn reset_drops_a_partial_character() {
        let mut stats = TextStats::new();
        stats.push_chunk(&[0xC3]).unwrap();
        stats.reset();
        stats.push_chunk(b"A").unwrap();
        stats.finish().unwrap();
        assert_eq!(stats.bytes(), 1);
        assert_eq!(stats.scalars(), 1);
        assert_eq!(stats.invalid_sequences(), 0);
        assert_eq!(stats.newline_count(), 0);
    }

    #[test]
    fn splits_match_a_single_pass() {
        let inputs: [&[u8]; 8] = [
            b"",
            b"a",
            b"a\r\nb",
            b"abcd\nef\n",
            b"\r\n\r",
            "héllo\n😀".as_bytes(),
            b"a\xFF\n\xC3",
            b"\n\n",
        ];
        for input in inputs {
            assert_splits_match(input);
        }
    }

    #[test]
    fn empty_chunk_between_data() {
        let mut stats = TextStats::new();
        stats.push_chunk(b"ab\n").unwrap();
        stats.push_chunk(b"").unwrap();
        stats.push_chunk(b"c").unwrap();
        stats.finish().unwrap();
        assert_eq!(snapshot(&stats), summarize(b"ab\nc"));
    }

    #[test]
    fn overflow_leaves_the_previous_totals_in_place() {
        let mut stats = TextStats::with_bytes(u64::MAX);
        assert_eq!(stats.push_chunk(b"x"), Err(CounterOverflow));
        assert_eq!(stats.bytes(), u64::MAX);
        assert_eq!(stats.scalars(), 0);
    }

    #[test]
    fn scalars_match_lossy_utf8() {
        let input = b"ok\xFF\xC3\xA9\xC3";
        let stats = summarize(input);
        let lossy = String::from_utf8_lossy(input);
        assert_eq!(stats.scalars, lossy.chars().count() as u64);
        assert_eq!(
            stats.invalid_sequences,
            lossy.chars().filter(|ch| *ch == '\u{FFFD}').count() as u64
        );
    }
}
