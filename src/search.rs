//! Chunk-safe search for an exact byte pattern.
//!
//! The searcher keeps the last `pattern.len() - 1` bytes of each chunk. A
//! match that starts in that tail and finishes in the next chunk is reported
//! once. A match cannot fit entirely inside the tail, so the next chunk does
//! not report it again.
//!
//! Line numbers follow [`crate::LineIndex`]: a `0x0A` ends a line, and the
//! line of a match is the line that contains the match's first byte. This
//! pass does not store the file. It keeps the pattern, the tail, and at most
//! [`STORED_HIT_LIMIT`] hits.

use crate::processor::CounterOverflow;

/// How many matches are kept, in file order. Later matches are still counted.
pub const STORED_HIT_LIMIT: usize = 100;

/// One match. `line` is 1-based.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchHit {
    pub offset: u64,
    pub line: u64,
}

/// The pattern passed to [`ByteSearch::new`] was empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyPattern;

impl std::fmt::Display for EmptyPattern {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("search pattern is empty")
    }
}

impl std::error::Error for EmptyPattern {}

/// Exact search over a file that arrives one chunk at a time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ByteSearch {
    pattern: Vec<u8>,
    pending: Vec<u8>,
    pending_offset: u64,
    newlines_before_pending: u64,
    bytes_seen: u64,
    match_count: u64,
    hits: Vec<SearchHit>,
}

impl ByteSearch {
    /// Search for `pattern`. An empty pattern is rejected.
    pub fn new(pattern: &[u8]) -> Result<Self, EmptyPattern> {
        if pattern.is_empty() {
            return Err(EmptyPattern);
        }
        Ok(Self {
            pattern: pattern.to_vec(),
            pending: Vec::with_capacity(pattern.len() - 1),
            pending_offset: 0,
            newlines_before_pending: 0,
            bytes_seen: 0,
            match_count: 0,
            hits: Vec::new(),
        })
    }

    /// Search one chunk. On overflow, `self` is left as it was.
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), CounterOverflow> {
        let mut next = self.clone();
        next.push_chunk_mutating(chunk)?;
        *self = next;
        Ok(())
    }

    pub fn bytes_seen(&self) -> u64 {
        self.bytes_seen
    }

    /// Every match, including ones past [`STORED_HIT_LIMIT`].
    pub fn match_count(&self) -> u64 {
        self.match_count
    }

    /// The first matches, in increasing offset order.
    pub fn hits(&self) -> &[SearchHit] {
        &self.hits
    }

    fn push_chunk_mutating(&mut self, chunk: &[u8]) -> Result<(), CounterOverflow> {
        let chunk_offset = self.bytes_seen;
        let new_bytes = self
            .bytes_seen
            .checked_add(chunk.len() as u64)
            .ok_or(CounterOverflow)?;
        let combined_offset = if self.pending.is_empty() {
            chunk_offset
        } else {
            self.pending_offset
        };

        let mut combined = Vec::with_capacity(self.pending.len() + chunk.len());
        combined.extend_from_slice(&self.pending);
        combined.extend_from_slice(chunk);

        let pattern_len = self.pattern.len();
        let mut newlines_before_cursor = self.newlines_before_pending;
        if combined.len() >= pattern_len {
            let last = combined.len() - pattern_len;
            for start in 0..=last {
                if combined[start..start + pattern_len] == self.pattern[..] {
                    let offset = combined_offset
                        .checked_add(start as u64)
                        .ok_or(CounterOverflow)?;
                    let line = newlines_before_cursor
                        .checked_add(1)
                        .ok_or(CounterOverflow)?;
                    self.match_count = self.match_count.checked_add(1).ok_or(CounterOverflow)?;
                    if self.hits.len() < STORED_HIT_LIMIT {
                        self.hits.push(SearchHit { offset, line });
                    }
                }
                if combined[start] == b'\n' {
                    newlines_before_cursor = newlines_before_cursor
                        .checked_add(1)
                        .ok_or(CounterOverflow)?;
                }
            }
        }

        let keep = pattern_len.saturating_sub(1).min(combined.len());
        let discard = combined.len() - keep;
        self.pending.clear();
        self.pending.extend_from_slice(&combined[discard..]);
        self.pending_offset = combined_offset
            .checked_add(discard as u64)
            .ok_or(CounterOverflow)?;
        self.newlines_before_pending = newlines_before_cursor;
        self.bytes_seen = new_bytes;
        Ok(())
    }

    #[cfg(test)]
    fn with_match_count(pattern: &[u8], match_count: u64) -> Self {
        let mut search = Self::new(pattern).expect("pattern is not empty");
        search.match_count = match_count;
        search
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::LineIndex;

    fn search_all(pattern: &[u8], bytes: &[u8]) -> ByteSearch {
        let mut search = ByteSearch::new(pattern).unwrap();
        search.push_chunk(bytes).unwrap();
        search
    }

    fn feed(pattern: &[u8], bytes: &[u8], chunk_size: usize) -> ByteSearch {
        let mut search = ByteSearch::new(pattern).unwrap();
        if chunk_size == 0 {
            search.push_chunk(bytes).unwrap();
            return search;
        }
        for chunk in bytes.chunks(chunk_size) {
            search.push_chunk(chunk).unwrap();
        }
        search
    }

    #[test]
    fn empty_pattern_is_rejected() {
        assert!(ByteSearch::new(b"").is_err());
    }

    #[test]
    fn no_match_counts_the_bytes() {
        let search = search_all(b"zz", b"abc");
        assert_eq!(search.match_count(), 0);
        assert!(search.hits().is_empty());
        assert_eq!(search.bytes_seen(), 3);
    }

    #[test]
    fn match_at_start_middle_and_end() {
        let search = search_all(b"ab", b"abxxabxxab");
        assert_eq!(search.match_count(), 3);
        assert_eq!(
            search.hits(),
            &[
                SearchHit { offset: 0, line: 1 },
                SearchHit { offset: 4, line: 1 },
                SearchHit { offset: 8, line: 1 },
            ]
        );
    }

    #[test]
    fn overlapping_matches_are_all_counted() {
        let search = search_all(b"aa", b"aaaa");
        assert_eq!(search.match_count(), 3);
        assert_eq!(
            search
                .hits()
                .iter()
                .map(|hit| hit.offset)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn every_split_matches_one_pass() {
        let bytes = b"xxERRORyy\nERROR\nzzzERROR";
        let pattern = b"ERROR";
        let once = search_all(pattern, bytes);
        for size in 1..=bytes.len() {
            let split = feed(pattern, bytes, size);
            assert_eq!(split.match_count(), once.match_count(), "chunk size {size}");
            assert_eq!(split.hits(), once.hits(), "chunk size {size}");
            assert_eq!(split.bytes_seen(), once.bytes_seen());
        }
    }

    #[test]
    fn pattern_longer_than_a_chunk_still_matches() {
        let search = feed(b"abcdef", b"xxabcdefyy", 2);
        assert_eq!(search.match_count(), 1);
        assert_eq!(search.hits(), &[SearchHit { offset: 2, line: 1 }]);
    }

    #[test]
    fn utf8_pattern_split_at_every_byte() {
        let bytes = "before é after".as_bytes();
        let pattern = "é".as_bytes();
        let once = search_all(pattern, bytes);
        assert_eq!(once.match_count(), 1);
        for size in 1..=bytes.len() {
            assert_eq!(feed(pattern, bytes, size).hits(), once.hits());
        }
    }

    #[test]
    fn line_numbers_follow_newlines_only() {
        let bytes = b"a\r\nbb\nc";
        let search = search_all(b"bb", bytes);
        assert_eq!(search.hits(), &[SearchHit { offset: 3, line: 2 }]);
        let on_last = search_all(b"c", bytes);
        assert_eq!(on_last.hits(), &[SearchHit { offset: 6, line: 3 }]);
        let bare_cr = search_all(b"b", b"a\rb");
        assert_eq!(bare_cr.hits(), &[SearchHit { offset: 2, line: 1 }]);
    }

    #[test]
    fn a_match_on_the_newline_belongs_to_the_line_it_ends() {
        let search = search_all(b"\n", b"a\nb\n");
        assert_eq!(
            search.hits(),
            &[
                SearchHit { offset: 1, line: 1 },
                SearchHit { offset: 3, line: 2 },
            ]
        );
    }

    #[test]
    fn hits_agree_with_the_line_index() {
        let fixtures: [&[u8]; 4] = [b"a\nbb\nccc", b"\nERROR", b"a\r\nb\n", b"no-newline"];
        for bytes in fixtures {
            let mut index = LineIndex::new();
            index.push_chunk(bytes).unwrap();
            for pattern in [b"a".as_slice(), b"b", b"\n", b"ERROR", b"no"] {
                if pattern.is_empty() {
                    continue;
                }
                let search = search_all(pattern, bytes);
                for hit in search.hits() {
                    let range = index.line_range(hit.line).unwrap_or_else(|| {
                        panic!("line {} missing in {bytes:?}", hit.line);
                    });
                    if bytes.get(hit.offset as usize) == Some(&b'\n') {
                        assert_eq!(hit.offset, range.end);
                    } else {
                        assert!(hit.offset >= range.start && hit.offset < range.end);
                    }
                }
            }
        }
    }

    #[test]
    fn empty_chunk_does_not_invent_a_match() {
        let mut search = ByteSearch::new(b"ab").unwrap();
        search.push_chunk(b"a").unwrap();
        search.push_chunk(b"").unwrap();
        search.push_chunk(b"b").unwrap();
        assert_eq!(search.hits(), &[SearchHit { offset: 0, line: 1 }]);
    }

    #[test]
    fn stored_hits_stop_at_the_limit_and_the_count_does_not() {
        let bytes = vec![b'a'; STORED_HIT_LIMIT + 50];
        let search = search_all(b"a", &bytes);
        assert_eq!(search.match_count(), (STORED_HIT_LIMIT + 50) as u64);
        assert_eq!(search.hits().len(), STORED_HIT_LIMIT);
        assert_eq!(search.hits()[0].offset, 0);
        assert_eq!(
            search.hits().last().unwrap().offset,
            (STORED_HIT_LIMIT - 1) as u64
        );
    }

    #[test]
    fn overflow_leaves_the_previous_search_in_place() {
        let mut search = ByteSearch::with_match_count(b"a", u64::MAX);
        let before = search.clone();
        assert!(search.push_chunk(b"a").is_err());
        assert_eq!(search, before);
    }
}
