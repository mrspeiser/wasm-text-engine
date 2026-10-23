//! Newline offsets for seeking to a line without holding the file.
//!
//! The index stores the file offset of each `0x0A` and nothing else. Line
//! numbers match [`crate::TextStats`]: a newline ends a line, a final
//! non-empty line with no newline counts, and an empty file has zero lines.
//! A bare carriage return does not end a line.

use crate::processor::CounterOverflow;

/// Byte range of one line, excluding the terminating `0x0A`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineRange {
    pub start: u64,
    pub end: u64,
}

/// Offsets of every newline seen so far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineIndex {
    newlines: Vec<u64>,
    bytes_seen: u64,
    ends_with_newline: bool,
}

impl Default for LineIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl LineIndex {
    pub fn new() -> Self {
        Self {
            newlines: Vec::new(),
            bytes_seen: 0,
            ends_with_newline: false,
        }
    }

    /// Record newlines in one chunk. On overflow, `self` is left as it was.
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), CounterOverflow> {
        let base = self.bytes_seen;
        let new_bytes = base
            .checked_add(chunk.len() as u64)
            .ok_or(CounterOverflow)?;
        let mut ends_with_newline = self.ends_with_newline;
        for (index, byte) in chunk.iter().enumerate() {
            if *byte == b'\n' {
                self.newlines.push(base + index as u64);
                ends_with_newline = true;
            } else {
                ends_with_newline = false;
            }
        }
        self.bytes_seen = new_bytes;
        self.ends_with_newline = ends_with_newline;
        Ok(())
    }

    pub fn bytes_seen(&self) -> u64 {
        self.bytes_seen
    }

    pub fn newline_count(&self) -> u64 {
        self.newlines.len() as u64
    }

    /// Lines separated by `\n`, using the same rules as [`crate::TextStats`].
    pub fn line_count(&self) -> u64 {
        if self.bytes_seen == 0 {
            return 0;
        }
        if self.ends_with_newline {
            self.newlines.len() as u64
        } else {
            self.newlines.len() as u64 + 1
        }
    }

    /// Content range of a 1-based line. `end` is the newline's offset, or the
    /// file length when the last line has no newline.
    pub fn line_range(&self, line: u64) -> Option<LineRange> {
        if line == 0 || line > self.line_count() {
            return None;
        }
        let start = if line == 1 {
            0
        } else {
            self.newline_offset(line - 2)?.checked_add(1)?
        };
        let end = if line <= self.newline_count() {
            self.newline_offset(line - 1)?
        } else {
            self.bytes_seen
        };
        Some(LineRange { start, end })
    }

    fn newline_offset(&self, index: u64) -> Option<u64> {
        let index = usize::try_from(index).ok()?;
        self.newlines.get(index).copied()
    }

    #[cfg(test)]
    fn seed_bytes(bytes_seen: u64) -> Self {
        Self {
            newlines: Vec::new(),
            bytes_seen,
            ends_with_newline: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::TextStats;

    fn index_all(bytes: &[u8]) -> LineIndex {
        let mut index = LineIndex::new();
        index.push_chunk(bytes).unwrap();
        index
    }

    fn feed(bytes: &[u8], chunk_size: usize) -> LineIndex {
        let mut index = LineIndex::new();
        if chunk_size == 0 {
            index.push_chunk(bytes).unwrap();
            return index;
        }
        for chunk in bytes.chunks(chunk_size) {
            index.push_chunk(chunk).unwrap();
        }
        index
    }

    fn stats_line_count(bytes: &[u8]) -> u64 {
        let mut stats = TextStats::new();
        stats.push_chunk(bytes).unwrap();
        stats.finish().unwrap();
        stats.line_count()
    }

    #[test]
    fn empty_file_has_no_lines() {
        let index = index_all(b"");
        assert_eq!(index.line_count(), 0);
        assert_eq!(index.line_range(1), None);
    }

    #[test]
    fn ranges_exclude_the_newline() {
        let index = index_all(b"a\n\nb");
        assert_eq!(index.line_count(), 3);
        assert_eq!(index.line_range(1), Some(LineRange { start: 0, end: 1 }));
        assert_eq!(index.line_range(2), Some(LineRange { start: 2, end: 2 }));
        assert_eq!(index.line_range(3), Some(LineRange { start: 3, end: 4 }));
        assert_eq!(index.line_range(4), None);
    }

    #[test]
    fn a_trailing_newline_does_not_add_an_extra_line() {
        let index = index_all(b"ab\n");
        assert_eq!(index.line_count(), 1);
        assert_eq!(index.line_range(1), Some(LineRange { start: 0, end: 2 }));
    }

    #[test]
    fn a_lone_newline_is_one_empty_line() {
        let index = index_all(b"\n");
        assert_eq!(index.line_count(), 1);
        assert_eq!(index.line_range(1), Some(LineRange { start: 0, end: 0 }));
    }

    #[test]
    fn a_file_with_no_newline_is_one_line() {
        let index = index_all(b"abc");
        assert_eq!(index.line_count(), 1);
        assert_eq!(index.line_range(1), Some(LineRange { start: 0, end: 3 }));
    }

    #[test]
    fn carriage_return_does_not_end_a_line() {
        let index = index_all(b"a\rb\r\nc");
        assert_eq!(index.line_count(), 2);
        assert_eq!(index.line_range(1), Some(LineRange { start: 0, end: 4 }));
        assert_eq!(index.line_range(2), Some(LineRange { start: 5, end: 6 }));
    }

    #[test]
    fn every_split_matches_one_pass_and_text_stats() {
        let fixtures: [&[u8]; 8] = [
            b"",
            b"\n",
            b"\n\n",
            b"a",
            b"a\n",
            b"a\n\nb",
            b"a\r\nb\r\n",
            "a\n😀\n".as_bytes(),
        ];
        for bytes in fixtures {
            let once = index_all(bytes);
            assert_eq!(once.line_count(), stats_line_count(bytes), "{bytes:?}");
            let sizes = if bytes.is_empty() {
                vec![1]
            } else {
                (1..=bytes.len()).collect()
            };
            for size in sizes {
                let split = feed(bytes, size);
                assert_eq!(split, once, "chunk size {size} for {bytes:?}");
            }
        }
    }

    #[test]
    fn an_empty_chunk_does_not_move_the_index() {
        let mut index = LineIndex::new();
        index.push_chunk(b"a\n").unwrap();
        index.push_chunk(b"").unwrap();
        index.push_chunk(b"b").unwrap();
        assert_eq!(index, index_all(b"a\nb"));
    }

    #[test]
    fn overflow_leaves_the_previous_index_in_place() {
        let mut index = LineIndex::seed_bytes(u64::MAX);
        let before = index.clone();
        assert!(index.push_chunk(&[b'a']).is_err());
        assert_eq!(index, before);
    }
}
