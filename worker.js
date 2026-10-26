/**
 * File scans run here so the page stays responsive.
 *
 * The main thread sends a File. This worker reads it with slice() in
 * fixed-size chunks and never asks the page to hold the whole body.
 *
 * Timers:
 * - Read time is only the await of slice().arrayBuffer().
 * - JavaScript processing time is only countNewlines().
 * - Wasm call time is only append_chunk(), which includes the wasm-bindgen
 *   copy into linear memory and the Rust scan.
 * - End-to-end time is one full iteration, including reads, scans, and loop
 *   overhead. It excludes the transfer probe and excludes UI rendering.
 * - The transfer probe runs after the timed iterations. It times
 *   probe_transfer() on about 10 chunks and scales the median per-byte cost
 *   to the file size. That estimate is not part of the totals above.
 */

import { countNewlines } from "./count-newlines.js";
import { splitWindowLines } from "./split-window.js";

const MIB = 1024 * 1024;
const ALLOWED_CHUNK_SIZES = new Set([1 * MIB, 2 * MIB, 4 * MIB]);
const ALLOWED_ITERATIONS = new Set([1, 3, 5]);
const PROBE_SAMPLES = 10;
const PROGRESS_INTERVAL_MS = 100;
const MAX_PATTERN_BYTES = 1024;
const CONTEXT_BYTES = 48;
const MAX_LINE_PREVIEW = 8 * 1024;
const WINDOW_LINES = 40;
const WINDOW_BYTE_CAP = 256 * 1024;

let wasmReady = null;
let activeRunId = null;
let tail = Promise.resolve();
let lineIndex = null;
let lineIndexFileId = null;

function post(message) {
  self.postMessage(message);
}

function enqueue(task) {
  tail = tail.then(task, task);
  return tail;
}

function ensureActive(runId) {
  if (activeRunId !== runId) {
    const error = new Error("Cancelled");
    error.name = "CancelledError";
    throw error;
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function throughputMibPerSec(bytes, milliseconds) {
  if (!(milliseconds > 0) || !(bytes >= 0)) {
    return null;
  }
  return bytes / MIB / (milliseconds / 1000);
}

function toSafeNumber(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} exceeds Number.MAX_SAFE_INTEGER`);
    }
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`${label} is not a safe integer`);
}

function ratio(numerator, denominator) {
  if (typeof numerator !== "number" || typeof denominator !== "number") {
    return null;
  }
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0 ||
    numerator < 0
  ) {
    return null;
  }
  return numerator / denominator;
}

async function loadWasm() {
  const wasm = await import("./pkg/wasm_text_engine.js");
  await wasm.default();
  return wasm;
}

wasmReady = loadWasm()
  .then((wasm) => {
    post({ type: "ready" });
    return wasm;
  })
  .catch((error) => {
    post({
      type: "init-error",
      message:
        "WebAssembly failed to load. From the repository root, run `wasm-pack build --target web --release`, then serve the directory over HTTP.",
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });

// The rejection is reported as init-error. Mark it handled so a JavaScript-only
// run does not also surface an unhandled promise rejection.
wasmReady.catch(() => {});

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "cancel") {
    if (activeRunId === message.runId) {
      activeRunId = null;
    }
    return;
  }

  if (message.type === "preview") {
    enqueue(() => handlePreview(message));
    return;
  }

  if (message.type === "benchmark") {
    activeRunId = message.runId;
    enqueue(() => handleBenchmark(message));
    return;
  }

  if (message.type === "stats") {
    activeRunId = message.runId;
    enqueue(() => handleStats(message));
    return;
  }

  if (message.type === "search") {
    activeRunId = message.runId;
    enqueue(() => handleSearch(message));
    return;
  }

  if (message.type === "line") {
    activeRunId = message.runId;
    enqueue(() => handleLine(message));
    return;
  }

  if (message.type === "window") {
    activeRunId = message.runId;
    enqueue(() => handleWindow(message));
    return;
  }

  if (message.type === "drop-index") {
    enqueue(() => {
      dropLineIndex();
    });
  }
};

async function handlePreview(message) {
  try {
    const maxBytes = 64 * 1024;
    const file = message.file;
    const byteLength = Math.min(maxBytes, file.size);
    const buffer = await file.slice(0, byteLength).arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer, {
      stream: true,
    });
    post({
      type: "preview",
      requestId: message.requestId,
      text,
      byteLength,
      fileSize: file.size,
    });
  } catch (error) {
    post({
      type: "preview-error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleBenchmark(message) {
  const results = [];
  try {
    const { file, engines, chunkSize, iterations } = validate(message);
    ensureActive(message.runId);
    const wasm = engines.some((engine) => engine === "wasm" || engine === "words")
      ? await wasmReady
      : null;
    ensureActive(message.runId);
    const runStarted = performance.now();

    warmup(wasm, engines);
    ensureActive(message.runId);

    for (let engineIndex = 0; engineIndex < engines.length; engineIndex += 1) {
      const engine = engines[engineIndex];
      const samples = await collectSamples({
        wasm,
        file,
        engine,
        chunkSize,
        iterations,
        runId: message.runId,
        engineIndex,
        engineCount: engines.length,
        runStarted,
      });

      let transfer = null;
      if (engine === "wasm" || engine === "words") {
        try {
          post({
            type: "progress",
            runId: message.runId,
            phase: "probe",
            engine,
            percent: 100,
            bytesProcessed: file.size,
            fileSize: file.size,
            iteration: iterations,
            iterations,
            runElapsedMs: performance.now() - runStarted,
            processThroughputMibS: null,
          });
          transfer = await estimateTransfer(file, chunkSize, message.runId);
        } catch (error) {
          const partial = summarize({
            engine,
            file,
            chunkSize,
            samples,
            transfer: null,
          });
          results.push(partial);
          post({ type: "result", runId: message.runId, result: partial });
          throw error;
        }
      }

      const result = summarize({ engine, file, chunkSize, samples, transfer });
      results.push(result);
      post({ type: "result", runId: message.runId, result });
    }

    postComparison(message.runId, results, file.size);
    ensureActive(message.runId);
    post({ type: "done", runId: message.runId });
  } catch (error) {
    if (error.name === "CancelledError" || activeRunId !== message.runId) {
      postComparison(message.runId, results, message.file?.size);
      post({ type: "cancelled", runId: message.runId });
      return;
    }
    post({
      type: "error",
      runId: message.runId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (activeRunId === message.runId) {
      activeRunId = null;
    }
  }
}

async function handleStats(message) {
  let stats = null;
  let index = null;
  try {
    const { file, chunkSize } = requireFile(message);
    ensureActive(message.runId);
    const wasm = await wasmReady;
    ensureActive(message.runId);
    stats = new wasm.WasmTextStats();
    index = new wasm.WasmLineIndex();
    const runStarted = performance.now();
    let bytesProcessed = 0;
    let processMs = 0;
    let lastProgress = 0;

    if (file.size === 0) {
      postStatsProgress({
        runId: message.runId,
        bytesProcessed: 0,
        fileSize: 0,
        runStarted,
        processMs: 0,
      });
    }

    for (let offset = 0; offset < file.size; offset += chunkSize) {
      ensureActive(message.runId);
      const bytes = await readChunk(file, offset, chunkSize);
      const processStarted = performance.now();
      stats.push_chunk(bytes);
      index.push_chunk(bytes);
      processMs += performance.now() - processStarted;
      bytesProcessed += bytes.length;

      const now = performance.now();
      if (bytesProcessed === file.size || now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        postStatsProgress({
          runId: message.runId,
          bytesProcessed,
          fileSize: file.size,
          runStarted,
          processMs,
        });
      }
    }

    ensureActive(message.runId);
    stats.finish();
    const summary = readSummary(stats);
    const indexedBytes = toSafeNumber(index.bytes_seen(), "Indexed bytes");
    const indexedLines = toSafeNumber(index.line_count(), "Indexed lines");
    if (summary.bytes !== file.size || indexedBytes !== file.size) {
      throw new Error(`Summarized ${summary.bytes} bytes, but the file is ${file.size} bytes.`);
    }
    if (indexedLines !== summary.lineCount) {
      throw new Error(
        `Line index has ${indexedLines} lines, but the summary counted ${summary.lineCount}.`,
      );
    }
    retainLineIndex(index, message.fileId);
    index = null;
    post({ type: "stats", runId: message.runId, summary });
    ensureActive(message.runId);
    post({ type: "done", runId: message.runId, kind: "stats" });
  } catch (error) {
    if (error.name === "CancelledError" || activeRunId !== message.runId) {
      post({ type: "cancelled", runId: message.runId, kind: "stats" });
      return;
    }
    post({
      type: "error",
      runId: message.runId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    stats?.free();
    index?.free();
    if (activeRunId === message.runId) {
      activeRunId = null;
    }
  }
}

async function handleSearch(message) {
  let search = null;
  try {
    const { file, chunkSize } = requireFile(message);
    const pattern = patternBytes(message.pattern);
    ensureActive(message.runId);
    const wasm = await wasmReady;
    ensureActive(message.runId);
    search = new wasm.WasmSearch(pattern);
    const runStarted = performance.now();
    let bytesProcessed = 0;
    let processMs = 0;
    let lastProgress = 0;

    if (file.size === 0) {
      postPassProgress({
        runId: message.runId,
        phase: "search",
        bytesProcessed: 0,
        fileSize: 0,
        runStarted,
        processMs: 0,
      });
    }

    for (let offset = 0; offset < file.size; offset += chunkSize) {
      ensureActive(message.runId);
      const bytes = await readChunk(file, offset, chunkSize);
      const processStarted = performance.now();
      search.push_chunk(bytes);
      processMs += performance.now() - processStarted;
      bytesProcessed += bytes.length;

      const now = performance.now();
      if (bytesProcessed === file.size || now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        postPassProgress({
          runId: message.runId,
          phase: "search",
          bytesProcessed,
          fileSize: file.size,
          runStarted,
          processMs,
        });
      }
    }

    ensureActive(message.runId);
    const matchCount = toSafeNumber(search.match_count(), "Match count");
    const bytesSeen = toSafeNumber(search.bytes_seen(), "Bytes seen");
    if (bytesSeen !== file.size) {
      throw new Error(`Searched ${bytesSeen} bytes, but the file is ${file.size} bytes.`);
    }

    const hitCount = search.hit_count();
    const hits = [];
    if (hitCount > 0) {
      postPassProgress({
        runId: message.runId,
        phase: "search-windows",
        bytesProcessed: file.size,
        fileSize: file.size,
        runStarted,
        processMs,
      });
    }
    for (let index = 0; index < hitCount; index += 1) {
      ensureActive(message.runId);
      const offset = toSafeNumber(search.hit_offset(index), "Match offset");
      const line = toSafeNumber(search.hit_line(index), "Match line");
      const start = Math.max(0, offset - CONTEXT_BYTES);
      const end = Math.min(file.size, offset + pattern.length + CONTEXT_BYTES);
      const bytes = await readRange(file, start, end);
      const relative = offset - start;
      hits.push({
        offset,
        line,
        before: decodeText(bytes.subarray(0, relative)),
        match: decodeText(bytes.subarray(relative, relative + pattern.length)),
        after: decodeText(bytes.subarray(relative + pattern.length)),
      });
    }

    post({ type: "search", runId: message.runId, matchCount, hits });
    ensureActive(message.runId);
    post({ type: "done", runId: message.runId, kind: "search" });
  } catch (error) {
    if (error.name === "CancelledError" || activeRunId !== message.runId) {
      post({ type: "cancelled", runId: message.runId, kind: "search" });
      return;
    }
    post({
      type: "error",
      runId: message.runId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    search?.free();
    if (activeRunId === message.runId) {
      activeRunId = null;
    }
  }
}

async function handleLine(message) {
  try {
    const file = requireFileOnly(message);
    ensureActive(message.runId);
    if (!lineIndex || message.fileId !== lineIndexFileId) {
      throw new Error("Summarize this file before jumping to a line.");
    }
    if (!Number.isSafeInteger(message.line) || message.line < 1) {
      throw new Error("Enter a line number of 1 or more.");
    }
    const lineCount = toSafeNumber(lineIndex.line_count(), "Line count");
    if (message.line > lineCount) {
      throw new Error(
        lineCount === 0
          ? "This file has no lines."
          : `Line ${message.line} is past the end of the file (${lineCount} lines).`,
      );
    }
    const start = toSafeNumber(lineIndex.line_start(BigInt(message.line)), "Line start");
    const end = toSafeNumber(lineIndex.line_end(BigInt(message.line)), "Line end");
    if (end < start || start > file.size || end > file.size) {
      throw new Error("The line index points outside the file.");
    }
    const truncated = end - start > MAX_LINE_PREVIEW;
    const readEnd = truncated ? start + MAX_LINE_PREVIEW : end;
    ensureActive(message.runId);
    const bytes = await readRange(file, start, readEnd);
    post({
      type: "line",
      runId: message.runId,
      line: message.line,
      start,
      end,
      text: decodeText(bytes),
      truncated,
    });
    ensureActive(message.runId);
    post({ type: "done", runId: message.runId, kind: "line" });
  } catch (error) {
    if (error.name === "CancelledError" || activeRunId !== message.runId) {
      post({ type: "cancelled", runId: message.runId, kind: "line" });
      return;
    }
    post({
      type: "error",
      runId: message.runId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (activeRunId === message.runId) {
      activeRunId = null;
    }
  }
}

async function handleWindow(message) {
  try {
    const file = requireFileOnly(message);
    ensureActive(message.runId);
    if (!lineIndex || message.fileId !== lineIndexFileId) {
      throw new Error("Summarize this file before opening the viewer.");
    }
    const fileLineCount = toSafeNumber(lineIndex.line_count(), "Line count");
    if (fileLineCount === 0) {
      post({
        type: "window",
        runId: message.runId,
        firstLine: 1,
        fileLineCount: 0,
        lines: [],
        capped: false,
        targetLine: null,
      });
      ensureActive(message.runId);
      post({ type: "done", runId: message.runId, kind: "window" });
      return;
    }
    if (!Number.isSafeInteger(message.firstLine) || message.firstLine < 1 || message.firstLine > fileLineCount) {
      throw new Error(
        `Line ${message.firstLine} is past the end of the file (${fileLineCount} lines).`,
      );
    }
    const requested = Number.isSafeInteger(message.lineCount) && message.lineCount > 0
      ? Math.min(message.lineCount, WINDOW_LINES)
      : WINDOW_LINES;
    const lastLine = Math.min(fileLineCount, message.firstLine + requested - 1);
    const start = toSafeNumber(lineIndex.line_start(BigInt(message.firstLine)), "Line start");
    const end = toSafeNumber(lineIndex.line_end(BigInt(lastLine)), "Line end");
    if (end < start || start > file.size || end > file.size) {
      throw new Error("The line index points outside the file.");
    }
    const capped = end - start > WINDOW_BYTE_CAP;
    const readEnd = capped ? start + WINDOW_BYTE_CAP : end;
    ensureActive(message.runId);
    const bytes = await readRange(file, start, readEnd);
    const split = splitWindowLines(bytes, { capped, maxLineBytes: MAX_LINE_PREVIEW });
    const lines = split.map((line, index) => ({
      line: message.firstLine + index,
      text: line.text,
      truncated: line.truncated,
    }));
    const expected = lastLine - message.firstLine + 1;
    if (lines.length > expected || (!capped && lines.length !== expected)) {
      throw new Error(`Viewer split ${lines.length} lines, but the index covers ${expected}.`);
    }
    post({
      type: "window",
      runId: message.runId,
      firstLine: message.firstLine,
      fileLineCount,
      lines,
      capped,
      targetLine: Number.isSafeInteger(message.targetLine) ? message.targetLine : null,
    });
    ensureActive(message.runId);
    post({ type: "done", runId: message.runId, kind: "window" });
  } catch (error) {
    if (error.name === "CancelledError" || activeRunId !== message.runId) {
      post({ type: "cancelled", runId: message.runId, kind: "window" });
      return;
    }
    post({
      type: "error",
      runId: message.runId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (activeRunId === message.runId) {
      activeRunId = null;
    }
  }
}

function retainLineIndex(index, fileId) {
  if (lineIndex) {
    lineIndex.free();
  }
  lineIndex = index;
  lineIndexFileId = fileId;
}

function dropLineIndex() {
  if (lineIndex) {
    lineIndex.free();
  }
  lineIndex = null;
  lineIndexFileId = null;
}

function patternBytes(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("Enter a search pattern.");
  }
  const bytes = new TextEncoder().encode(pattern);
  if (bytes.length < 1 || bytes.length > MAX_PATTERN_BYTES) {
    throw new Error(`Search pattern must be between 1 and ${MAX_PATTERN_BYTES} bytes.`);
  }
  return bytes;
}

function decodeText(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function readRange(file, start, end) {
  const buffer = await file.slice(start, end).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length !== end - start) {
    throw new Error(`Short read at byte ${start}.`);
  }
  return bytes;
}

function postStatsProgress(progress) {
  postPassProgress({ ...progress, phase: "stats" });
}

function postPassProgress({ runId, phase, bytesProcessed, fileSize, runStarted, processMs }) {
  post({
    type: "progress",
    runId,
    phase,
    bytesProcessed,
    fileSize,
    percent: fileSize === 0 ? 100 : (bytesProcessed / fileSize) * 100,
    runElapsedMs: performance.now() - runStarted,
    processThroughputMibS: throughputMibPerSec(bytesProcessed, processMs),
  });
}

function readSummary(stats) {
  return {
    bytes: toSafeNumber(stats.bytes(), "Bytes"),
    scalars: toSafeNumber(stats.scalars(), "Scalars"),
    invalidSequences: toSafeNumber(stats.invalid_sequences(), "Invalid sequences"),
    newlineCount: toSafeNumber(stats.newline_count(), "Newline count"),
    crlfCount: toSafeNumber(stats.crlf_count(), "CRLF count"),
    lineCount: toSafeNumber(stats.line_count(), "Line count"),
    longestLineBytes: toSafeNumber(stats.longest_line_bytes(), "Longest line bytes"),
    longestLineScalars: toSafeNumber(stats.longest_line_scalars(), "Longest line scalars"),
  };
}

function requireFileOnly(message) {
  const file = message.file;
  if (!file || typeof file.size !== "number" || typeof file.slice !== "function") {
    throw new Error("Choose a file before running.");
  }
  return file;
}

function requireFile(message) {
  const file = requireFileOnly(message);
  if (!ALLOWED_CHUNK_SIZES.has(message.chunkSize)) {
    throw new Error("Chunk size must be 1, 2, or 4 MiB.");
  }
  return { file, chunkSize: message.chunkSize };
}

function validate(message) {
  const { file, chunkSize } = requireFile(message);

  const engines = message.engines;
  if (!Array.isArray(engines) || engines.length < 1 || engines.length > 3) {
    throw new Error("Choose JavaScript, a Rust scan, or several of them.");
  }
  const unique = new Set(engines);
  const known = [...unique].every(
    (engine) => engine === "javascript" || engine === "wasm" || engine === "words",
  );
  if (unique.size !== engines.length || !known) {
    throw new Error("Unknown engine selection.");
  }

  const iterations = message.iterations;
  if (!ALLOWED_ITERATIONS.has(iterations)) {
    throw new Error("Iterations must be 1, 3, or 5.");
  }

  return { file, engines, chunkSize, iterations };
}

function warmup(wasm, engines) {
  const sample = new Uint8Array([0x0a, 0x61, 0x0a]);
  if (engines.includes("javascript")) {
    countNewlines(sample);
  }
  if (engines.includes("wasm")) {
    const processor = new wasm.WasmProcessor();
    try {
      processor.append_chunk(sample);
      wasm.probe_transfer(sample);
    } finally {
      processor.free();
    }
  }
  if (engines.includes("words")) {
    const processor = new wasm.WasmWordProcessor();
    try {
      processor.append_chunk(sample);
      wasm.probe_transfer(sample);
    } finally {
      processor.free();
    }
  }
}

async function readChunk(file, offset, size) {
  const end = Math.min(offset + size, file.size);
  const buffer = await file.slice(offset, end).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length !== end - offset) {
    throw new Error(`Short read at byte ${offset}.`);
  }
  return bytes;
}

async function collectSamples({
  wasm,
  file,
  engine,
  chunkSize,
  iterations,
  runId,
  engineIndex,
  engineCount,
  runStarted,
}) {
  const samples = [];
  let expectedCount = null;

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    ensureActive(runId);
    const iterationStarted = performance.now();
    let readMs = 0;
    let processMs = 0;
    let bytesProcessed = 0;
    let jsCount = 0;
    let lastProgress = 0;
    const processor = createProcessor(wasm, engine);

    try {
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        ensureActive(runId);

        const readStarted = performance.now();
        const bytes = await readChunk(file, offset, chunkSize);
        readMs += performance.now() - readStarted;

        const processStarted = performance.now();
        if (engine === "javascript") {
          jsCount += countNewlines(bytes);
        } else {
          processor.append_chunk(bytes);
        }
        processMs += performance.now() - processStarted;
        bytesProcessed += bytes.length;

        const now = performance.now();
        const finished = bytesProcessed === file.size;
        if (finished || now - lastProgress >= PROGRESS_INTERVAL_MS) {
          lastProgress = now;
          postScanProgress({
            runId,
            engine,
            engineIndex,
            engineCount,
            iteration,
            iterations,
            bytesProcessed,
            fileSize: file.size,
            readMs,
            processMs,
            iterationStarted,
            runStarted,
          });
        }
      }

      if (file.size === 0) {
        postScanProgress({
          runId,
          engine,
          engineIndex,
          engineCount,
          iteration,
          iterations,
          bytesProcessed: 0,
          fileSize: 0,
          readMs,
          processMs,
          iterationStarted,
          runStarted,
        });
      }

      const newlineCount = processor
        ? toSafeNumber(processor.newline_count(), "Newline count")
        : jsCount;
      const bytesSeen = processor
        ? toSafeNumber(processor.bytes_seen(), "Bytes seen")
        : bytesProcessed;

      if (bytesSeen !== file.size) {
        throw new Error(`Processed ${bytesSeen} bytes, but the file is ${file.size} bytes.`);
      }
      if (expectedCount === null) {
        expectedCount = newlineCount;
      } else if (expectedCount !== newlineCount) {
        throw new Error("Newline count changed between iterations.");
      }

      samples.push({
        readMs,
        processMs,
        totalMs: performance.now() - iterationStarted,
        newlineCount,
        bytesSeen,
      });
    } finally {
      processor?.free();
    }
  }

  return samples;
}

function postScanProgress({
  runId,
  engine,
  engineIndex,
  engineCount,
  iteration,
  iterations,
  bytesProcessed,
  fileSize,
  readMs,
  processMs,
  iterationStarted,
  runStarted,
}) {
  const completedBefore = (engineIndex * iterations + (iteration - 1)) * fileSize;
  const total = engineCount * iterations * fileSize;
  const done = completedBefore + bytesProcessed;
  post({
    type: "progress",
    runId,
    phase: "scan",
    engine,
    iteration,
    iterations,
    bytesProcessed,
    fileSize,
    readMs,
    processMs,
    percent: total === 0 ? 100 : (done / total) * 100,
    iterationElapsedMs: performance.now() - iterationStarted,
    runElapsedMs: performance.now() - runStarted,
    processThroughputMibS: throughputMibPerSec(bytesProcessed, processMs),
  });
}

async function estimateTransfer(file, chunkSize, runId) {
  if (file.size === 0) {
    return {
      estimatedTransferMs: 0,
      sampleCount: 0,
      sampleChunkBytes: 0,
    };
  }

  const fullChunks = Math.floor(file.size / chunkSize);
  const sampleBytes = fullChunks > 0 ? chunkSize : file.size;
  const offsets = [];
  if (fullChunks > 0) {
    const uniqueChunks = Math.min(PROBE_SAMPLES, fullChunks);
    for (let index = 0; index < uniqueChunks; index += 1) {
      offsets.push(index * chunkSize);
    }
  } else {
    offsets.push(0);
  }

  const wasm = await wasmReady;
  const perByte = [];
  while (perByte.length < PROBE_SAMPLES) {
    for (const offset of offsets) {
      ensureActive(runId);
      const bytes = await readChunk(file, offset, sampleBytes);
      const started = performance.now();
      const reported = wasm.probe_transfer(bytes);
      const elapsed = performance.now() - started;
      if (reported !== bytes.length) {
        throw new Error(`Transfer probe reported ${reported} bytes, expected ${bytes.length}.`);
      }
      perByte.push(elapsed / bytes.length);
      if (perByte.length >= PROBE_SAMPLES) {
        break;
      }
    }
  }

  return {
    estimatedTransferMs: median(perByte) * file.size,
    sampleCount: perByte.length,
    sampleChunkBytes: sampleBytes,
  };
}

function summarize({ engine, file, chunkSize, samples, transfer }) {
  const readMedian = median(samples.map((sample) => sample.readMs));
  const processMedian = median(samples.map((sample) => sample.processMs));
  const totalMedian = median(samples.map((sample) => sample.totalMs));
  const estimatedScanMs =
    transfer === null ? null : processMedian - transfer.estimatedTransferMs;

  return {
    engine,
    fileSize: file.size,
    chunkSize,
    iterations: samples.length,
    newlineCount: samples[0].newlineCount,
    bytesSeen: samples[0].bytesSeen,
    readMs: { median: readMedian, samples: samples.map((sample) => sample.readMs) },
    processMs: {
      median: processMedian,
      samples: samples.map((sample) => sample.processMs),
    },
    totalMs: { median: totalMedian, samples: samples.map((sample) => sample.totalMs) },
    processThroughputMibS: throughputMibPerSec(file.size, processMedian),
    totalThroughputMibS: throughputMibPerSec(file.size, totalMedian),
    transfer:
      transfer === null
        ? null
        : {
            estimatedTransferMs: transfer.estimatedTransferMs,
            estimatedScanMs: estimatedScanMs !== null && estimatedScanMs >= 0 ? estimatedScanMs : null,
            sampleCount: transfer.sampleCount,
            sampleChunkBytes: transfer.sampleChunkBytes,
          },
  };
}

function createProcessor(wasm, engine) {
  if (engine === "wasm") {
    return new wasm.WasmProcessor();
  }
  if (engine === "words") {
    return new wasm.WasmWordProcessor();
  }
  return null;
}

function postComparison(runId, results, fileSize) {
  const javascript = results.find((result) => result.engine === "javascript");
  const wasm = results.find((result) => result.engine === "wasm");
  const words = results.find((result) => result.engine === "words");
  if (results.length < 2 || typeof fileSize !== "number") {
    return;
  }

  const countsMatch = results.every(
    (result) => result.newlineCount === results[0].newlineCount && result.bytesSeen === fileSize,
  );

  post({
    type: "comparison",
    runId,
    comparison: {
      countsMatch,
      javascriptNewlines: javascript?.newlineCount ?? null,
      wasmNewlines: wasm?.newlineCount ?? null,
      wordsNewlines: words?.newlineCount ?? null,
      endToEnd: javascript && wasm ? ratio(wasm.totalMs.median, javascript.totalMs.median) : null,
      callVsScan: javascript && wasm ? ratio(wasm.processMs.median, javascript.processMs.median) : null,
      estimatedScanVsJs:
        javascript && wasm ? ratio(wasm.transfer?.estimatedScanMs, javascript.processMs.median) : null,
      estimatedScanMs: wasm?.transfer?.estimatedScanMs ?? null,
      jsProcessMs: javascript?.processMs.median ?? null,
      wordsVsWasmCall: words && wasm ? ratio(words.processMs.median, wasm.processMs.median) : null,
      wordsVsWasmScan:
        words && wasm
          ? ratio(words.transfer?.estimatedScanMs, wasm.transfer?.estimatedScanMs)
          : null,
      wordsProcessMs: words?.processMs.median ?? null,
      wasmProcessMs: wasm?.processMs.median ?? null,
    },
  });
}
