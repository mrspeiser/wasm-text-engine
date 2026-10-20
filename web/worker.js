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

const MIB = 1024 * 1024;
const ALLOWED_CHUNK_SIZES = new Set([1 * MIB, 2 * MIB, 4 * MIB]);
const ALLOWED_ITERATIONS = new Set([1, 3, 5]);
const PROBE_SAMPLES = 10;
const PROGRESS_INTERVAL_MS = 100;

let wasmReady = null;
let activeRunId = null;
let tail = Promise.resolve();

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
  const wasm = await import("../pkg/wasm_text_engine.js");
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
    const wasm = engines.includes("wasm") ? await wasmReady : null;
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
      if (engine === "wasm") {
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
  try {
    const { file, chunkSize } = requireFile(message);
    ensureActive(message.runId);
    const wasm = await wasmReady;
    ensureActive(message.runId);
    stats = new wasm.WasmTextStats();
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
    if (summary.bytes !== file.size) {
      throw new Error(`Summarized ${summary.bytes} bytes, but the file is ${file.size} bytes.`);
    }
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
    if (activeRunId === message.runId) {
      activeRunId = null;
    }
  }
}

function postStatsProgress({ runId, bytesProcessed, fileSize, runStarted, processMs }) {
  post({
    type: "progress",
    runId,
    phase: "stats",
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

function requireFile(message) {
  const file = message.file;
  if (!file || typeof file.size !== "number" || typeof file.slice !== "function") {
    throw new Error("Choose a file before running.");
  }
  if (!ALLOWED_CHUNK_SIZES.has(message.chunkSize)) {
    throw new Error("Chunk size must be 1, 2, or 4 MiB.");
  }
  return { file, chunkSize: message.chunkSize };
}

function validate(message) {
  const { file, chunkSize } = requireFile(message);

  const engines = message.engines;
  if (!Array.isArray(engines) || engines.length < 1 || engines.length > 2) {
    throw new Error("Choose JavaScript, WebAssembly, or both.");
  }
  const unique = new Set(engines);
  const known = [...unique].every((engine) => engine === "javascript" || engine === "wasm");
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
    const processor = engine === "wasm" ? new wasm.WasmProcessor() : null;

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

      const newlineCount =
        engine === "wasm" ? toSafeNumber(processor.newline_count(), "Newline count") : jsCount;
      const bytesSeen =
        engine === "wasm" ? toSafeNumber(processor.bytes_seen(), "Bytes seen") : bytesProcessed;

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

function postComparison(runId, results, fileSize) {
  const javascript = results.find((result) => result.engine === "javascript");
  const wasm = results.find((result) => result.engine === "wasm");
  if (!javascript || !wasm || typeof fileSize !== "number") {
    return;
  }

  post({
    type: "comparison",
    runId,
    comparison: {
      countsMatch:
        javascript.newlineCount === wasm.newlineCount &&
        javascript.bytesSeen === wasm.bytesSeen &&
        javascript.bytesSeen === fileSize,
      javascriptNewlines: javascript.newlineCount,
      wasmNewlines: wasm.newlineCount,
      endToEnd: ratio(wasm.totalMs.median, javascript.totalMs.median),
      callVsScan: ratio(wasm.processMs.median, javascript.processMs.median),
      estimatedScanVsJs: ratio(wasm.transfer?.estimatedScanMs, javascript.processMs.median),
      estimatedScanMs: wasm.transfer?.estimatedScanMs ?? null,
      jsProcessMs: javascript.processMs.median,
    },
  });
}
