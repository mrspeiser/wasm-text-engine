//! WebAssembly bindings for the text engine.
//!
//! [`WasmProcessor`] is the newline benchmark. It counts `0x0A` and nothing
//! else. [`WasmTextStats`] is a separate pass that also tracks UTF-8 scalars,
//! CRLF pairs, and the longest line. `wasm-bindgen` copies each chunk into
//! linear memory before either call, and the benchmark does not pay for the
//! statistics pass.

mod processor;
mod stats;
mod utf8;

pub use processor::{CounterOverflow, TextProcessor, count_newlines};
pub use stats::TextStats;
pub use utf8::{DecodeStep, next_unit};

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
