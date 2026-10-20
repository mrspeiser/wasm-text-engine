# Wasm Text Engine

A local, browser-based benchmark that counts newline bytes in a text file with JavaScript and with Rust compiled to WebAssembly. The file is read in chunks. It is not uploaded, and it is not loaded into one string.

The scan counts every byte equal to `0x0A`. It does not parse CSV, JSON, or log formats. Those formats are accepted because they are text; format-specific parsing is later work.

## Why Rust and WebAssembly

The page needs to stay responsive while walking a file that may be gigabytes long. The heavy scan runs in a [Web Worker](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API). Rust is a reasonable language for that scan: the hot path is a tight loop over bytes, the running totals need a 64-bit counter, and the engine can be tested with `cargo test` without a browser.

WebAssembly does not automatically make the scan faster. `wasm-bindgen` copies each JavaScript `Uint8Array` into WebAssembly memory before Rust sees it. On a per-chunk API that copy can cost more than the count. This project measures the copy and the scan separately and shows the result either way. A slower WebAssembly number is a valid result.

## Architecture

```text
main thread                worker                         Rust / Wasm
-----------                ------                         -----------
file picker, drop zone     slice the File into chunks    TextProcessor
progress and results       JavaScript newline loop       append_chunk(&[u8])
64 KiB preview             WasmProcessor                 count of 0x0A
```

The main thread sends the `File` with `postMessage`. Structured clone hands the worker a file handle; it does not copy the body. The worker reads `file.slice(start, end).arrayBuffer()` in 1, 2, or 4 MiB chunks, then drops the chunk after counting it.

`TextProcessor` in [`src/processor.rs`](src/processor.rs) is ordinary Rust. It tracks `bytes_seen` and `newline_count` as `u64` values and can be reset. [`src/lib.rs`](src/lib.rs) is the `wasm-bindgen` adapter: `WasmProcessor` plus `probe_transfer`, a call that copies a chunk and returns its length so the benchmark can estimate transfer cost.

A newline is one byte, so a chunk boundary cannot split one. Carriage return (`0x0D`) is not counted. Tests split buffers at every offset and check that the total matches a single pass.

## Run locally

Install [Rust](https://rustup.rs/) and [`wasm-pack`](https://rustwasm.github.io/wasm-pack/installer/).

```bash
wasm-pack build --target web --release
python3 -m http.server 8080
```

Open [http://localhost:8080/web/](http://localhost:8080/web/). Use an HTTP server. Opening the HTML file directly will not load the worker or the WebAssembly module.

`pkg/` is generated and gitignored. Rebuild it after changing Rust.

## Run a benchmark

1. Generate a fixture, or choose a text file of your own. Fixtures are gitignored.

   ```bash
   python3 scripts/generate_test_file.py --size-mib 32
   ```

   Omit `--size-mib` to write a 1 GiB file at `test-data/benchmark.txt`. The generator repeats one log line and pads with `X` to the exact size. It prints the expected `0x0A` count.

2. Drop the file on the page, or use Choose file.
3. Pick an engine, a chunk size, and 1, 3, or 5 iterations.
4. Run the benchmark. Cancel stops between chunks.

There are no published timings in this README. The page is the measurement. Record a number only after a run you can reproduce, and say which browser, chunk size, iteration count, and file size produced it.

## What the timings mean

Both engines see the same chunks of the same file. One small warmup call runs before the clock starts. Each iteration reads the file again. With more than one iteration, the page reports the median.

| Measurement | What is included |
| --- | --- |
| Read time | `slice().arrayBuffer()` only |
| JavaScript scan time | the `Uint8Array` loop that counts `0x0A` |
| Wasm call time | `append_chunk`, including the `wasm-bindgen` copy and the Rust scan |
| End-to-end time | one iteration in the worker, from the first read through the last byte |
| Estimated transfer | about 10 `probe_transfer` calls, scaled by file size; not a full extra pass, and not included in the totals |
| Estimated Wasm scan | call time minus the transfer estimate; omitted when the difference is negative |

Processing throughput is file size divided by median scan time or median call time. End-to-end throughput uses median end-to-end time. 1 MiB is 1024 × 1024 bytes.

In a combined run, JavaScript finishes every iteration before WebAssembly starts. The operating system can cache the file after the first pass, so the second engine's read time and end-to-end time are often warmer. That is why read time is shown on its own. Use scan time and call time when comparing the processing work. The preview also reads the first 64 KiB before a run.

The two newline counts have to match, and the bytes seen have to equal the file size. If they do not, the page says the comparison is invalid.

## Tradeoffs

- Chunked reads keep memory to about one chunk, plus the WebAssembly copy of that chunk. A multi-gigabyte file is not turned into a JavaScript string.
- Smaller chunks make cancel and progress more responsive. They also make the per-call copy show up more in the Wasm call time. 4 MiB is the default.
- The Rust scan is a scalar loop. It is the same algorithm as the JavaScript loop. SIMD is future work, not something this comparison claims.
- `u64` counters are wide enough for multi-gigabyte input. Values that do not fit in `Number.MAX_SAFE_INTEGER` are rejected at the JavaScript boundary instead of being rounded. A real text file will not get there.
- `append_chunk` returns an error if a total would overflow `u64`, and it leaves the previous totals in place. That path is for correctness, not for files a browser can open.
- The transfer figure is an estimate from a sample. It is labeled that way. It is not subtracted from the published call time; the call time remains the direct measurement.

## Current features

- Drag-and-drop and a file picker, with name, size, and type.
- Chunked `0x0A` counts in JavaScript and Rust/WebAssembly.
- Progress, elapsed time, processing throughput, and cancel.
- Side-by-side medians, throughput, and a count check.
- A UTF-8 preview of the first 64 KiB.
- Host unit tests for the Rust counter and `node --test` for the JavaScript counter.

## Planned features

- A virtualized line viewer that does not render the whole file.
- Search over a large file.
- Format-specific parsing and filtering for CSV, JSON, and logs.
- A SIMD newline scan, measured against this scalar baseline.

## Tests

```bash
cargo test
node --test web/count-newlines.test.js
```

`cargo test` runs on the host and does not need the browser package. The Rust tests cover empty input, input without newlines, repeated newlines, a split at every offset, a newline on either side of a boundary, reset, many chunks, totals past `u32::MAX`, and overflow that does not change the previous totals.

## Layout

```text
src/processor.rs          chunked counter
src/lib.rs                wasm-bindgen adapter
web/                      page, worker, and JavaScript scan
scripts/generate_test_file.py
pkg/                      generated by wasm-pack, not committed
test-data/                generated fixtures, not committed
```
