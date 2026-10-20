//! WebAssembly bindings for the text engine.
//!
//! [`WasmProcessor`] holds a [`TextProcessor`] and accepts one JavaScript
//! `Uint8Array` at a time. `wasm-bindgen` copies each array into
//! WebAssembly linear memory before [`WasmProcessor::append_chunk`] or
//! [`probe_transfer`] runs. That copy is part of the call's cost; the
//! benchmark measures it instead of hiding it.

mod processor;

pub use processor::{CounterOverflow, TextProcessor, count_newlines};

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
