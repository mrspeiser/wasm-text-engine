const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

const dom = {
  wasmStatus: document.querySelector("#wasm-status"),
  dropzone: document.querySelector("#dropzone"),
  chooseFile: document.querySelector("#choose-file"),
  fileInput: document.querySelector("#file-input"),
  fileMeta: document.querySelector("#file-meta"),
  fileName: document.querySelector("#file-name"),
  fileSize: document.querySelector("#file-size"),
  fileType: document.querySelector("#file-type"),
  chunkSize: document.querySelector("#chunk-size"),
  iterations: document.querySelector("#iterations"),
  runButton: document.querySelector("#run-button"),
  cancelButton: document.querySelector("#cancel-button"),
  runStatus: document.querySelector("#run-status"),
  progress: document.querySelector("#progress"),
  progressFill: document.querySelector("#progress-fill"),
  statBytes: document.querySelector("#stat-bytes"),
  statPercent: document.querySelector("#stat-percent"),
  statElapsed: document.querySelector("#stat-elapsed"),
  statThroughput: document.querySelector("#stat-throughput"),
  results: document.querySelector("#results"),
  comparison: document.querySelector("#comparison"),
  previewMeta: document.querySelector("#preview-meta"),
  previewText: document.querySelector("#preview-text"),
};

const state = {
  file: null,
  wasmReady: false,
  wasmFailed: false,
  running: false,
  runId: 0,
  previewId: 0,
  results: new Map(),
};

const ENGINE_ORDER = ["javascript", "wasm"];
const ENGINE_LABELS = {
  javascript: "JavaScript",
  wasm: "Rust / WebAssembly",
};

worker.addEventListener("message", onWorkerMessage);
worker.addEventListener("error", () => {
  state.wasmFailed = true;
  setWasmStatus("error", "Worker failed to start");
  setRunStatus(
    "The worker failed to start. Build with wasm-pack and open this page over HTTP, not as a file.",
  );
  renderControls();
});

dom.chooseFile.addEventListener("click", () => dom.fileInput.click());
dom.fileInput.addEventListener("change", () => {
  const file = dom.fileInput.files?.[0];
  if (file) {
    selectFile(file);
  }
});

dom.dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dom.dropzone.classList.add("dragover");
});
dom.dropzone.addEventListener("dragleave", () => {
  dom.dropzone.classList.remove("dragover");
});
dom.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dom.dropzone.classList.remove("dragover");
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    selectFile(file);
  }
});

dom.runButton.addEventListener("click", startRun);
dom.cancelButton.addEventListener("click", () => {
  worker.postMessage({ type: "cancel", runId: state.runId });
  setRunStatus("Cancelling…");
});

for (const input of document.querySelectorAll('input[name="engine"]')) {
  input.addEventListener("change", renderControls);
}

renderResults();
renderControls();

function onWorkerMessage(event) {
  const message = event.data;
  if (!message || typeof message.type !== "string") {
    return;
  }
  if (message.runId != null && message.runId !== state.runId) {
    return;
  }

  switch (message.type) {
    case "ready":
      state.wasmReady = true;
      state.wasmFailed = false;
      setWasmStatus("ready", "WebAssembly ready");
      renderControls();
      break;
    case "init-error":
      state.wasmFailed = true;
      setWasmStatus("error", "WebAssembly failed");
      setRunStatus(message.message);
      renderControls();
      break;
    case "preview":
      if (message.requestId === state.previewId) {
        renderPreview(message);
      }
      break;
    case "preview-error":
      if (message.requestId === state.previewId) {
        dom.previewText.textContent = message.message;
      }
      break;
    case "progress":
      renderProgress(message);
      break;
    case "result":
      state.results.set(message.result.engine, message.result);
      renderResults();
      break;
    case "comparison":
      renderComparison(message.comparison);
      break;
    case "done":
      state.running = false;
      setRunStatus("Benchmark finished.");
      renderControls();
      break;
    case "cancelled":
      state.running = false;
      setRunStatus("Cancelled. Results from engines that finished are still listed.");
      dom.progress.classList.remove("is-probe");
      renderControls();
      break;
    case "error":
      state.running = false;
      setRunStatus(message.message);
      dom.progress.classList.remove("is-probe");
      renderControls();
      break;
    default:
      break;
  }
}

function selectFile(file) {
  if (state.running) {
    setRunStatus("Wait for the current run to finish before choosing another file.");
    return;
  }

  state.file = file;
  state.results = new Map();
  dom.fileName.textContent = file.name;
  dom.fileSize.textContent = `${formatBytes(file.size)} (${formatInt(file.size)} bytes)`;
  dom.fileType.textContent = file.type || "Unknown";
  dom.fileMeta.classList.remove("hidden");
  resetProgress();
  setRunStatus("Ready to run.");
  renderResults();
  clearComparison();
  requestPreview(file);
  renderControls();
}

function requestPreview(file) {
  state.previewId += 1;
  dom.previewMeta.textContent = "Reading the first 64 KiB…";
  dom.previewText.textContent = "";
  worker.postMessage({
    type: "preview",
    requestId: state.previewId,
    file,
  });
}

function startRun() {
  if (!state.file || state.running || !canRun()) {
    return;
  }

  state.running = true;
  state.runId += 1;
  state.results = new Map();
  resetProgress();
  renderResults();
  clearComparison();
  setRunStatus("Starting…");
  renderControls();

  const engine = selectedEngine();
  const engines = engine === "both" ? ["javascript", "wasm"] : [engine];
  worker.postMessage({
    type: "benchmark",
    runId: state.runId,
    file: state.file,
    engines,
    chunkSize: Number(dom.chunkSize.value),
    iterations: Number(dom.iterations.value),
  });
}

function selectedEngine() {
  return document.querySelector('input[name="engine"]:checked')?.value ?? "both";
}

function canRun() {
  if (!state.file || state.running) {
    return false;
  }
  const engine = selectedEngine();
  if ((engine === "wasm" || engine === "both") && !state.wasmReady) {
    return false;
  }
  return true;
}

function renderControls() {
  const locked = state.running;
  dom.runButton.disabled = !canRun();
  dom.cancelButton.disabled = !locked;
  dom.chooseFile.disabled = locked;
  dom.fileInput.disabled = locked;
  dom.chunkSize.disabled = locked;
  dom.iterations.disabled = locked;
  for (const input of document.querySelectorAll('input[name="engine"]')) {
    input.disabled = locked;
  }
}

function renderProgress(progress) {
  const percent = Math.max(0, Math.min(100, progress.percent ?? 0));
  dom.progressFill.style.width = `${percent}%`;
  dom.progress.setAttribute("aria-valuenow", String(Math.round(percent)));
  dom.progress.classList.toggle("is-probe", progress.phase === "probe");

  if (progress.phase === "probe") {
    setRunStatus("Estimating WebAssembly copy overhead…");
    dom.statPercent.textContent = formatPercent(percent);
    dom.statElapsed.textContent = formatMs(progress.runElapsedMs);
    return;
  }

  const engine = ENGINE_LABELS[progress.engine] ?? progress.engine;
  setRunStatus(`${engine} · iteration ${progress.iteration} of ${progress.iterations}`);
  dom.statBytes.textContent = `${formatBytes(progress.bytesProcessed)} / ${formatBytes(progress.fileSize)}`;
  dom.statPercent.textContent = formatPercent(percent);
  dom.statElapsed.textContent = formatMs(progress.runElapsedMs);
  dom.statThroughput.textContent = formatThroughput(progress.processThroughputMibS);
}

function renderResults() {
  dom.results.replaceChildren();
  for (const engine of ENGINE_ORDER) {
    dom.results.append(renderCard(engine, state.results.get(engine)));
  }
}

function renderCard(engine, result) {
  const card = document.createElement("article");
  card.className = `card ${engine}`;
  card.id = `result-${engine}`;

  const title = document.createElement("h3");
  title.textContent = ENGINE_LABELS[engine];
  card.append(title);

  if (!result) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Not run.";
    card.append(empty);
    return card;
  }

  const list = document.createElement("dl");
  const processLabel = engine === "wasm" ? "Call time (copy + scan)" : "Scan time";
  const throughputLabel = engine === "wasm" ? "Call throughput" : "Scan throughput";
  const rows = [
    ["Newline count", formatInt(result.newlineCount)],
    ["Bytes seen", formatInt(result.bytesSeen)],
    ["Total time", formatMs(result.totalMs.median)],
    ["Read time", formatMs(result.readMs.median)],
    [processLabel, formatMs(result.processMs.median)],
  ];

  if (result.transfer) {
    rows.push(["Estimated transfer", formatMs(result.transfer.estimatedTransferMs)]);
    rows.push([
      "Estimated scan",
      result.transfer.estimatedScanMs == null
        ? "Unavailable"
        : formatMs(result.transfer.estimatedScanMs),
    ]);
  }

  rows.push(
    [throughputLabel, formatThroughput(result.processThroughputMibS)],
    ["End-to-end throughput", formatThroughput(result.totalThroughputMibS)],
    ["Chunk size", formatBytes(result.chunkSize)],
    ["Iterations", formatInt(result.iterations)],
  );

  for (const [term, value] of rows) {
    list.append(metricRow(term, value));
  }
  card.append(list);

  if (result.transfer) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = `Transfer estimate uses ${result.transfer.sampleCount} copies of ${formatBytes(result.transfer.sampleChunkBytes)} chunks, scaled to the file. It is not included in the times above.`;
    card.append(note);
  }

  if (result.iterations > 1) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "End-to-end time of each iteration";
    const items = document.createElement("ol");
    for (const sample of result.totalMs.samples) {
      const item = document.createElement("li");
      item.textContent = formatMs(sample);
      items.append(item);
    }
    details.append(summary, items);
    card.append(details);
  }

  return card;
}

function renderComparison(comparison) {
  dom.comparison.replaceChildren();
  const banner = document.createElement("p");
  banner.className = comparison.countsMatch ? "banner ok" : "banner error";
  banner.textContent = comparison.countsMatch
    ? `Counts match: ${formatInt(comparison.javascriptNewlines)} newlines.`
    : `Counts differ. JavaScript found ${formatInt(comparison.javascriptNewlines)} newlines; Rust/WebAssembly found ${formatInt(comparison.wasmNewlines)}. This comparison is not valid.`;
  dom.comparison.append(banner);

  const list = document.createElement("ul");
  list.append(
    item(`${timesAsLong("The Rust/WebAssembly run", "the JavaScript run", comparison.endToEnd)} This is end-to-end time, including file reads.`),
    item(callComparison(comparison)),
    item(scanComparison(comparison)),
  );
  dom.comparison.append(list);

  const cache = document.createElement("p");
  cache.className = "hint";
  cache.textContent = "JavaScript runs first. WebAssembly may then read a warmer file cache, so a lower end-to-end time is not by itself evidence of a faster scan.";
  dom.comparison.append(cache);
}

function clearComparison() {
  dom.comparison.replaceChildren();
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "Run both engines to compare them on the same file.";
  dom.comparison.append(note);
}

function renderPreview(message) {
  const entire = message.byteLength === message.fileSize;
  dom.previewMeta.textContent = entire
    ? `Entire file (${formatBytes(message.fileSize)}), decoded as UTF-8. The benchmark counts bytes and does not decode text.`
    : `First ${formatBytes(message.byteLength)} of ${formatBytes(message.fileSize)}, decoded as UTF-8. The benchmark counts bytes and does not decode text.`;
  dom.previewText.textContent = message.text.length > 0 ? message.text : "(preview is empty)";
}

function resetProgress() {
  dom.progress.classList.remove("is-probe");
  dom.progressFill.style.width = "0";
  dom.progress.setAttribute("aria-valuenow", "0");
  dom.statBytes.textContent = "—";
  dom.statPercent.textContent = "—";
  dom.statElapsed.textContent = "—";
  dom.statThroughput.textContent = "—";
}

function setWasmStatus(status, text) {
  dom.wasmStatus.dataset.state = status;
  dom.wasmStatus.textContent = text;
}

function setRunStatus(text) {
  dom.runStatus.textContent = text;
}

function metricRow(term, value) {
  const row = document.createElement("div");
  row.className = "metric";
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  row.append(dt, dd);
  return row;
}

function item(text) {
  const node = document.createElement("li");
  node.textContent = text;
  return node;
}

function callComparison(comparison) {
  if (comparison.callVsScan == null) {
    return "The Wasm call could not be compared with the JavaScript scan because a timer read zero. The call still includes the copy into WebAssembly memory.";
  }
  return `${timesAsLong("The Wasm call", "the JavaScript scan", comparison.callVsScan)} The call includes the copy into WebAssembly memory.`;
}

function scanComparison(comparison) {
  if (comparison.estimatedScanVsJs != null) {
    return `${timesAsLong("The estimated Wasm scan", "the JavaScript scan", comparison.estimatedScanVsJs)} This subtracts the transfer estimate from the call time.`;
  }
  if (!(comparison.jsProcessMs > 0)) {
    return "The JavaScript scan was below the timer resolution, so it cannot be compared with the estimated Wasm scan.";
  }
  if (typeof comparison.estimatedScanMs !== "number") {
    return "Estimated Wasm scan time is unavailable. The transfer estimate was at least as large as the call time, so the difference is inside the noise of the sample.";
  }
  return "Estimated Wasm scan time could not be compared with the JavaScript scan.";
}

function timesAsLong(subject, baseline, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${subject} could not be compared with ${baseline}.`;
  }
  if (value > 0.98 && value < 1.02) {
    return `${subject} took about the same time as ${baseline}.`;
  }
  return `${subject} took ${value.toFixed(2)}× as long as ${baseline}.`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "—";
  }
  if (bytes < 1024) {
    return `${formatInt(bytes)} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatInt(value) {
  return Number(value).toLocaleString("en-US");
}

function formatMs(milliseconds) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) {
    return "—";
  }
  if (milliseconds > 0 && milliseconds < 0.01) {
    return "< 0.01 ms";
  }
  if (milliseconds < 10) {
    return `${milliseconds.toFixed(2)} ms`;
  }
  if (milliseconds < 1000) {
    return `${milliseconds.toFixed(1)} ms`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(2)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}m ${remainder.toFixed(1)}s`;
}

function formatPercent(percent) {
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return "—";
  }
  return `${percent.toFixed(1)}%`;
}

function formatThroughput(mibPerSec) {
  if (typeof mibPerSec !== "number" || !Number.isFinite(mibPerSec)) {
    return "—";
  }
  if (mibPerSec > 0 && mibPerSec < 0.1) {
    return "< 0.1 MiB/s";
  }
  return `${mibPerSec.toFixed(1)} MiB/s`;
}
