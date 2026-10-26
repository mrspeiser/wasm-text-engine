//! WebAssembly bindings for the text engine.
//!
//! [`WasmProcessor`] is the newline benchmark. It counts `0x0A` and nothing
//! else. [`WasmTextStats`] is a separate pass that also tracks UTF-8 scalars,
//! CRLF pairs, and the longest line. `wasm-bindgen` copies each chunk into
//! linear memory before either call, and the benchmark does not pay for the
//! statistics pass.

mod index;
mod processor;
mod search;
mod stats;
mod utf8;
mod words;

pub use index::{LineIndex, LineRange};
pub use processor::{CounterOverflow, TextProcessor, count_newlines};
pub use search::{ByteSearch, EmptyPattern, SearchHit, STORED_HIT_LIMIT};
pub use stats::TextStats;
pub use utf8::{DecodeStep, next_unit};
pub use words::{WordProcessor, count_newlines_words};

use wasm_bindgen::prelude::*;

/// Stateful newline counter exposed to JavaScript.
#[wasm_bindgen]
pub struct WasmProcessor {
    inner: TextProcessor,
}

#[wasm_bindgen]
impl WasmProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmProcessor {
        WasmProcessor {
            inner: TextProcessor::new(),
        }
    }

    /// Copy `chunk` into this counter.
    ///
    /// The copy performed by `wasm-bindgen` happens before this method, so it
    /// is included in any JavaScript timing of the call. Throws if a total
    /// would exceed `u64::MAX`; the previous totals are kept.
    pub fn append_chunk(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.inner
            .append_chunk(chunk)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn newline_count(&self) -> u64 {
        self.inner.newline_count()
    }

    pub fn bytes_seen(&self) -> u64 {
        self.inner.bytes_seen()
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }
}

/// Eight-byte newline counter exposed to JavaScript.
///
/// This is a separate benchmark column. [`WasmProcessor`] still counts one
/// byte at a time.
#[wasm_bindgen]
pub struct WasmWordProcessor {
    inner: WordProcessor,
}

#[wasm_bindgen]
impl WasmWordProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmWordProcessor {
        WasmWordProcessor {
            inner: WordProcessor::new(),
        }
    }

    pub fn append_chunk(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.inner
            .append_chunk(chunk)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn newline_count(&self) -> u64 {
        self.inner.newline_count()
    }

    pub fn bytes_seen(&self) -> u64 {
        self.inner.bytes_seen()
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }
}

/// Accept `chunk` and return its length.
///
/// This does not count newlines. Timing it estimates the `wasm-bindgen` copy
/// plus the cost of the call, which is the overhead
/// [`WasmProcessor::append_chunk`] pays before the scan.
#[wasm_bindgen]
pub fn probe_transfer(chunk: &[u8]) -> u32 {
    u32::try_from(chunk.len()).expect("chunk longer than u32::MAX")
}

/// Streaming text totals exposed to JavaScript.
///
/// This is not used by the newline benchmark. Call [`finish`](Self::finish)
/// after the last chunk before reading the getters.
#[wasm_bindgen]
pub struct WasmTextStats {
    inner: TextStats,
}

#[wasm_bindgen]
impl WasmTextStats {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmTextStats {
        WasmTextStats {
            inner: TextStats::new(),
        }
    }

    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.inner
            .push_chunk(chunk)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn finish(&mut self) -> Result<(), JsValue> {
        self.inner
            .finish()
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }

    pub fn bytes(&self) -> u64 {
        self.inner.bytes()
    }

    pub fn scalars(&self) -> u64 {
        self.inner.scalars()
    }

    pub fn invalid_sequences(&self) -> u64 {
        self.inner.invalid_sequences()
    }

    pub fn newline_count(&self) -> u64 {
        self.inner.newline_count()
    }

    pub fn crlf_count(&self) -> u64 {
        self.inner.crlf_count()
    }

    pub fn line_count(&self) -> u64 {
        self.inner.line_count()
    }

    pub fn longest_line_bytes(&self) -> u64 {
        self.inner.longest_line_bytes()
    }

    pub fn longest_line_scalars(&self) -> u64 {
        self.inner.longest_line_scalars()
    }
}

/// Exact byte search exposed to JavaScript.
///
/// The newline benchmark does not use this type. At most 100 hits are kept.
/// [`match_count`](Self::match_count) still counts the rest.
#[wasm_bindgen]
pub struct WasmSearch {
    inner: ByteSearch,
}

#[wasm_bindgen]
impl WasmSearch {
    #[wasm_bindgen(constructor)]
    pub fn new(pattern: &[u8]) -> Result<WasmSearch, JsValue> {
        ByteSearch::new(pattern)
            .map(|inner| WasmSearch { inner })
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.inner
            .push_chunk(chunk)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn bytes_seen(&self) -> u64 {
        self.inner.bytes_seen()
    }

    pub fn match_count(&self) -> u64 {
        self.inner.match_count()
    }

    pub fn hit_count(&self) -> u32 {
        u32::try_from(self.inner.hits().len()).expect("hit list longer than u32::MAX")
    }

    pub fn hit_offset(&self, index: u32) -> Result<u64, JsValue> {
        self.inner
            .hits()
            .get(index as usize)
            .map(|hit| hit.offset)
            .ok_or_else(|| JsValue::from_str("hit index out of range"))
    }

    pub fn hit_line(&self, index: u32) -> Result<u64, JsValue> {
        self.inner
            .hits()
            .get(index as usize)
            .map(|hit| hit.line)
            .ok_or_else(|| JsValue::from_str("hit index out of range"))
    }
}

/// Newline offset index exposed to JavaScript.
///
/// Built during Summarize. [`line_start`](Self::line_start) and
/// [`line_end`](Self::line_end) take a 1-based line number. `line_end` is the
/// offset of the newline, or the file length when the last line has none.
#[wasm_bindgen]
pub struct WasmLineIndex {
    inner: LineIndex,
}

#[wasm_bindgen]
impl WasmLineIndex {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmLineIndex {
        WasmLineIndex {
            inner: LineIndex::new(),
        }
    }

    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.inner
            .push_chunk(chunk)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn bytes_seen(&self) -> u64 {
        self.inner.bytes_seen()
    }

    pub fn newline_count(&self) -> u64 {
        self.inner.newline_count()
    }

    pub fn line_count(&self) -> u64 {
        self.inner.line_count()
    }

    pub fn line_start(&self, line: u64) -> Result<u64, JsValue> {
        self.inner
            .line_range(line)
            .map(|range| range.start)
            .ok_or_else(|| JsValue::from_str("line is out of range"))
    }

    pub fn line_end(&self, line: u64) -> Result<u64, JsValue> {
        self.inner
            .line_range(line)
            .map(|range| range.end)
            .ok_or_else(|| JsValue::from_str("line is out of range"))
    }
}
