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
  summarizeButton: document.querySelector("#summarize-button"),
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
  searchPattern: document.querySelector("#search-pattern"),
  searchButton: document.querySelector("#search-button"),
  searchMeta: document.querySelector("#search-meta"),
  searchHits: document.querySelector("#search-hits"),
  indexStatus: document.querySelector("#index-status"),
  lineNumber: document.querySelector("#line-number"),
  lineButton: document.querySelector("#line-button"),
  lineMeta: document.querySelector("#line-meta"),
  lineText: document.querySelector("#line-text"),
  viewerPrev: document.querySelector("#viewer-prev"),
  viewerNext: document.querySelector("#viewer-next"),
  viewerScroll: document.querySelector("#viewer-scroll"),
  viewerMeta: document.querySelector("#viewer-meta"),
  viewerLines: document.querySelector("#viewer-lines"),
  summary: {
    bytes: document.querySelector("#summary-bytes"),
    scalars: document.querySelector("#summary-scalars"),
    invalid: document.querySelector("#summary-invalid"),
    newlines: document.querySelector("#summary-newlines"),
    crlf: document.querySelector("#summary-crlf"),
    lines: document.querySelector("#summary-lines"),
    longestBytes: document.querySelector("#summary-longest-bytes"),
    longestScalars: document.querySelector("#summary-longest-scalars"),
  },
};

const state = {
  file: null,
  wasmReady: false,
  wasmFailed: false,
  running: false,
  runId: 0,
  previewId: 0,
  results: new Map(),
  fileId: 0,
  lineIndexReady: false,
  indexedLines: 0,
  viewerJump: null,
  viewerTarget: null,
  viewer: {
    firstLine: 1,
    lines: [],
    capped: false,
  },
};

const WINDOW_LINES = 40;
const ENGINE_ORDER = ["javascript", "wasm", "words"];
const ENGINE_LABELS = {
  javascript: "JavaScript",
  wasm: "Rust, one byte at a time",
  words: "Rust, 8 bytes at a time",
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
dom.summarizeButton.addEventListener("click", startSummary);
dom.searchButton.addEventListener("click", startSearch);
dom.lineButton.addEventListener("click", startLine);
dom.searchPattern.addEventListener("input", renderControls);
dom.searchPattern.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    startSearch();
  }
});
dom.lineNumber.addEventListener("input", renderControls);
dom.lineNumber.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    startLine();
  }
});
dom.viewerPrev.addEventListener("click", () => pageViewer(-1));
dom.viewerNext.addEventListener("click", () => pageViewer(1));
dom.viewerScroll.addEventListener("change", () => {
  const line = Number(dom.viewerScroll.value);
  if (Number.isSafeInteger(line)) {
    showWindow(line, line);
  }
});
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
    case "stats":
      state.lineIndexReady = true;
      state.indexedLines = message.summary.lineCount;
      renderSummary(message.summary);
      renderIndexStatus();
      break;
    case "search":
      renderSearch(message);
      break;
    case "line":
      renderLine(message);
      break;
    case "window":
      renderWindow(message);
      break;
    case "done":
      state.running = false;
      setRunStatus(finishedLabel(message.kind));
      renderControls();
      if (message.kind === "stats" && state.lineIndexReady && state.indexedLines > 0) {
        showWindow(1, null);
      } else if (message.kind === "line" && state.viewerJump != null) {
        const line = state.viewerJump;
        state.viewerJump = null;
        showWindow(line, line);
      }
      break;
    case "cancelled":
      state.running = false;
      state.viewerJump = null;
      setRunStatus(cancelledLabel(message.kind));
      dom.progress.classList.remove("is-probe");
      renderIndexStatus();
      renderControls();
      break;
    case "error":
      state.running = false;
      state.viewerJump = null;
      setRunStatus(message.message);
      dom.progress.classList.remove("is-probe");
      renderIndexStatus();
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
  state.fileId += 1;
  state.lineIndexReady = false;
  state.indexedLines = 0;
  state.results = new Map();
  dom.fileName.textContent = file.name;
  dom.fileSize.textContent = `${formatBytes(file.size)} (${formatInt(file.size)} bytes)`;
  dom.fileType.textContent = file.type || "Unknown";
  dom.fileMeta.classList.remove("hidden");
  resetProgress();
  clearSummary();
  clearSearch();
  clearLine();
  clearViewer();
  renderIndexStatus();
  setRunStatus("Ready to run.");
  renderResults();
  clearComparison();
  requestPreview(file);
  renderControls();
  worker.postMessage({ type: "drop-index" });
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

  const engines = selectedEngines();
  worker.postMessage({
    type: "benchmark",
    runId: state.runId,
    file: state.file,
    engines,
    chunkSize: Number(dom.chunkSize.value),
    iterations: Number(dom.iterations.value),
  });
}

function startSummary() {
  if (!state.file || state.running || !state.wasmReady) {
    return;
  }

  state.running = true;
  state.runId += 1;
  clearSummary();
  dom.indexStatus.textContent = "Building a line index…";
  resetProgress();
  setRunStatus("Summarizing…");
  renderControls();
  worker.postMessage({
    type: "stats",
    runId: state.runId,
    fileId: state.fileId,
    file: state.file,
    chunkSize: Number(dom.chunkSize.value),
  });
}

function startSearch() {
  if (!state.file || state.running || !state.wasmReady || !searchPattern()) {
    return;
  }

  state.running = true;
  state.runId += 1;
  clearSearch();
  resetProgress();
  setRunStatus("Searching…");
  renderControls();
  worker.postMessage({
    type: "search",
    runId: state.runId,
    fileId: state.fileId,
    file: state.file,
    chunkSize: Number(dom.chunkSize.value),
    pattern: dom.searchPattern.value,
  });
}

function startLine() {
  const line = selectedLine();
  if (!state.file || state.running || !state.wasmReady || !state.lineIndexReady || line == null) {
    return;
  }

  state.running = true;
  state.runId += 1;
  state.viewerJump = line;
  clearLine();
  setRunStatus("Reading line…");
  renderControls();
  worker.postMessage({
    type: "line",
    runId: state.runId,
    fileId: state.fileId,
    file: state.file,
    line,
  });
}

function searchPattern() {
  return dom.searchPattern.value.length > 0 ? dom.searchPattern.value : "";
}

function selectedLine() {
  const value = Number(dom.lineNumber.value);
  if (!Number.isSafeInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function selectedEngine() {
  return document.querySelector('input[name="engine"]:checked')?.value ?? "both";
}

function selectedEngines() {
  const engine = selectedEngine();
  if (engine === "both") {
    return ["javascript", "wasm"];
  }
  if (engine === "all") {
    return ["javascript", "wasm", "words"];
  }
  return [engine];
}

function canRun() {
  if (!state.file || state.running) {
    return false;
  }
  const engines = selectedEngines();
  if (engines.some((engine) => engine === "wasm" || engine === "words") && !state.wasmReady) {
    return false;
  }
  return true;
}

function renderControls() {
  const locked = state.running;
  dom.runButton.disabled = !canRun();
  dom.summarizeButton.disabled = locked || !state.file || !state.wasmReady;
  dom.searchButton.disabled = locked || !state.file || !state.wasmReady || !searchPattern();
  dom.lineButton.disabled =
    locked || !state.file || !state.wasmReady || !state.lineIndexReady || selectedLine() == null;
  dom.searchPattern.disabled = locked;
  dom.lineNumber.disabled = locked;
  dom.viewerPrev.disabled = locked || !canPageViewer(-1);
  dom.viewerNext.disabled = locked || !canPageViewer(1);
  dom.viewerScroll.disabled = locked || !state.lineIndexReady || state.indexedLines < 1;
  for (const button of document.querySelectorAll(".hit-jump")) {
    button.disabled = locked;
  }
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

  if (progress.phase === "stats") {
    setRunStatus("Summarizing…");
    dom.statBytes.textContent = `${formatBytes(progress.bytesProcessed)} / ${formatBytes(progress.fileSize)}`;
    dom.statPercent.textContent = formatPercent(percent);
    dom.statElapsed.textContent = formatMs(progress.runElapsedMs);
    dom.statThroughput.textContent = formatThroughput(progress.processThroughputMibS);
    return;
  }

  if (progress.phase === "search") {
    setRunStatus("Searching…");
    dom.statBytes.textContent = `${formatBytes(progress.bytesProcessed)} / ${formatBytes(progress.fileSize)}`;
    dom.statPercent.textContent = formatPercent(percent);
    dom.statElapsed.textContent = formatMs(progress.runElapsedMs);
    dom.statThroughput.textContent = formatThroughput(progress.processThroughputMibS);
    return;
  }

  if (progress.phase === "search-windows") {
    setRunStatus("Reading match windows…");
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
  const wasmCall = engine === "wasm" || engine === "words";
  const processLabel = wasmCall ? "Call time (copy + scan)" : "Scan time";
  const throughputLabel = wasmCall ? "Call throughput" : "Scan throughput";
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
    ? `Counts match: ${formatInt(shownNewlineCount(comparison))} newlines.`
    : countMismatch(comparison);
  dom.comparison.append(banner);

  const list = document.createElement("ul");
  if (comparison.javascriptNewlines != null && comparison.wasmNewlines != null) {
    list.append(
      item(`${timesAsLong("The one-byte Rust run", "the JavaScript run", comparison.endToEnd)} This is end-to-end time, including file reads.`),
      item(callComparison(comparison)),
      item(scanComparison(comparison)),
    );
  }
  if (comparison.wordsNewlines != null && comparison.wasmNewlines != null) {
    list.append(
      item(`${timesAsLong("The 8-byte Rust call", "the one-byte Rust call", comparison.wordsVsWasmCall)} Both calls include the copy into WebAssembly memory.`),
      item(wordsScanComparison(comparison)),
    );
  }
  dom.comparison.append(list);

  const cache = document.createElement("p");
  cache.className = "hint";
  cache.textContent = comparison.wordsNewlines == null
    ? "JavaScript runs first. The one-byte Rust scan may then read a warmer file cache, so a lower end-to-end time is not by itself evidence of a faster scan."
    : "JavaScript runs first, then the one-byte Rust scan, then the 8-byte scan. Later reads may see a warmer file cache, so a lower end-to-end time is not by itself evidence of a faster scan.";
  dom.comparison.append(cache);
}

function shownNewlineCount(comparison) {
  return comparison.javascriptNewlines ?? comparison.wasmNewlines ?? comparison.wordsNewlines;
}

function countMismatch(comparison) {
  const parts = [];
  if (comparison.javascriptNewlines != null) {
    parts.push(`JavaScript found ${formatInt(comparison.javascriptNewlines)}`);
  }
  if (comparison.wasmNewlines != null) {
    parts.push(`the one-byte Rust scan found ${formatInt(comparison.wasmNewlines)}`);
  }
  if (comparison.wordsNewlines != null) {
    parts.push(`the 8-byte Rust scan found ${formatInt(comparison.wordsNewlines)}`);
  }
  return `Counts differ. ${parts.join("; ")}. This comparison is not valid.`;
}

function wordsScanComparison(comparison) {
  if (comparison.wordsVsWasmScan != null) {
    return `${timesAsLong("The estimated 8-byte scan", "the estimated one-byte scan", comparison.wordsVsWasmScan)} Both estimates subtract the transfer sample from the call time.`;
  }
  if (!(comparison.wordsProcessMs > 0) || !(comparison.wasmProcessMs > 0)) {
    return "A call timer read zero, so the estimated 8-byte scan cannot be compared with the estimated one-byte scan.";
  }
  return "Estimated scan time is unavailable for one of the Rust calls. The transfer estimate was at least as large as that call, so the difference is inside the noise of the sample.";
}

function clearComparison() {
  dom.comparison.replaceChildren();
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "Run two or more engines to compare them on the same file.";
  dom.comparison.append(note);
}

function renderPreview(message) {
  const entire = message.byteLength === message.fileSize;
  dom.previewMeta.textContent = entire
    ? `Entire file (${formatBytes(message.fileSize)}), decoded as UTF-8. The benchmark counts bytes and does not decode text.`
    : `First ${formatBytes(message.byteLength)} of ${formatBytes(message.fileSize)}, decoded as UTF-8. The benchmark counts bytes and does not decode text.`;
  dom.previewText.textContent = message.text.length > 0 ? message.text : "(preview is empty)";
}

function renderSummary(summary) {
  dom.summary.bytes.textContent = formatInt(summary.bytes);
  dom.summary.scalars.textContent = formatInt(summary.scalars);
  dom.summary.invalid.textContent = formatInt(summary.invalidSequences);
  dom.summary.newlines.textContent = formatInt(summary.newlineCount);
  dom.summary.crlf.textContent = formatInt(summary.crlfCount);
  dom.summary.lines.textContent = formatInt(summary.lineCount);
  dom.summary.longestBytes.textContent = formatInt(summary.longestLineBytes);
  dom.summary.longestScalars.textContent = formatInt(summary.longestLineScalars);
}

function clearSummary() {
  for (const node of Object.values(dom.summary)) {
    node.textContent = "—";
  }
}

function renderSearch(message) {
  const shown = message.hits.length;
  if (message.matchCount === 0) {
    dom.searchMeta.textContent = "No matches.";
  } else if (shown < message.matchCount) {
    dom.searchMeta.textContent = `${formatInt(message.matchCount)} matches. Showing the first ${formatInt(shown)}.`;
  } else {
    dom.searchMeta.textContent = `${formatInt(message.matchCount)} ${message.matchCount === 1 ? "match" : "matches"}.`;
  }

  dom.searchHits.replaceChildren();
  for (const hit of message.hits) {
    const article = document.createElement("article");
    article.className = "hit";
    const title = document.createElement("button");
    title.type = "button";
    title.className = "hit-jump";
    title.textContent = `Line ${formatInt(hit.line)} · offset ${formatInt(hit.offset)}`;
    title.addEventListener("click", () => {
      if (!state.lineIndexReady) {
        setRunStatus("Summarize this file before opening the viewer.");
        return;
      }
      showWindow(hit.line, hit.line);
    });
    const sample = document.createElement("pre");
    sample.className = "preview hit-window";
    const before = document.createElement("span");
    before.textContent = hit.before;
    const mark = document.createElement("mark");
    mark.textContent = hit.match;
    const after = document.createElement("span");
    after.textContent = hit.after;
    sample.append(before, mark, after);
    article.append(title, sample);
    dom.searchHits.append(article);
  }
  renderControls();
}

function clearSearch() {
  dom.searchMeta.textContent = "";
  dom.searchHits.replaceChildren();
}

function renderLine(message) {
  const length = message.end - message.start;
  dom.lineMeta.textContent = message.truncated
    ? `Line ${formatInt(message.line)} is ${formatInt(length)} bytes. Showing the first ${formatBytes(8 * 1024)}.`
    : `Line ${formatInt(message.line)}, bytes ${formatInt(message.start)}–${formatInt(message.end)}.`;
  dom.lineText.textContent = message.text.length > 0 ? message.text : "(empty line)";
  dom.lineText.classList.remove("hidden");
}

function clearLine() {
  dom.lineMeta.textContent = "";
  dom.lineText.textContent = "";
  dom.lineText.classList.add("hidden");
}

function renderIndexStatus() {
  dom.indexStatus.textContent = state.lineIndexReady
    ? `Indexed ${formatInt(state.indexedLines)} ${state.indexedLines === 1 ? "line" : "lines"}.`
    : "No line index yet. Summarize the file to build one.";
}

function showWindow(firstLine, targetLine) {
  if (!state.file || state.running || !state.wasmReady || !state.lineIndexReady) {
    return;
  }
  if (state.indexedLines < 1) {
    clearViewer();
    dom.viewerMeta.textContent = "This file has no lines.";
    return;
  }
  const start = Math.min(Math.max(1, firstLine), state.indexedLines);
  state.viewerTarget = targetLine;
  state.running = true;
  state.runId += 1;
  setRunStatus("Reading lines…");
  renderControls();
  worker.postMessage({
    type: "window",
    runId: state.runId,
    fileId: state.fileId,
    file: state.file,
    firstLine: start,
    lineCount: WINDOW_LINES,
    targetLine,
  });
}

function pageViewer(direction) {
  if (!canPageViewer(direction)) {
    return;
  }
  if (direction < 0) {
    showWindow(state.viewer.firstLine - WINDOW_LINES, state.viewerTarget);
    return;
  }
  const last = state.viewer.lines[state.viewer.lines.length - 1].line;
  showWindow(last + 1, state.viewerTarget);
}

function canPageViewer(direction) {
  if (!state.lineIndexReady || state.indexedLines < 1 || state.viewer.lines.length === 0) {
    return false;
  }
  if (direction < 0) {
    return state.viewer.firstLine > 1;
  }
  const last = state.viewer.lines[state.viewer.lines.length - 1].line;
  return last < state.indexedLines;
}

function renderWindow(message) {
  state.viewer = {
    firstLine: message.firstLine,
    lines: message.lines,
    capped: message.capped,
  };
  state.viewerTarget = message.targetLine;
  dom.viewerLines.replaceChildren();
  if (message.fileLineCount === 0 || message.lines.length === 0) {
    dom.viewerMeta.textContent = "This file has no lines.";
    dom.viewerScroll.min = "1";
    dom.viewerScroll.max = "1";
    dom.viewerScroll.value = "1";
    return;
  }

  const last = message.lines[message.lines.length - 1].line;
  dom.viewerMeta.textContent = message.capped
    ? `Lines ${formatInt(message.firstLine)}–${formatInt(last)} of ${formatInt(message.fileLineCount)}. This page was cut at 256 KiB.`
    : `Lines ${formatInt(message.firstLine)}–${formatInt(last)} of ${formatInt(message.fileLineCount)}.`;
  dom.viewerScroll.min = "1";
  dom.viewerScroll.max = String(message.fileLineCount);
  dom.viewerScroll.value = String(message.firstLine);

  for (const line of message.lines) {
    const row = document.createElement("div");
    row.className = "viewer-row";
    if (line.line === message.targetLine) {
      row.classList.add("is-target");
    }
    const number = document.createElement("span");
    number.className = "viewer-number";
    number.textContent = formatInt(line.line);
    const text = document.createElement("span");
    text.className = "viewer-text";
    text.textContent = line.text.length > 0 ? line.text : "";
    if (line.truncated) {
      const note = document.createElement("span");
      note.className = "viewer-cut";
      note.textContent = " …";
      text.append(note);
    }
    row.append(number, text);
    dom.viewerLines.append(row);
  }
}

function clearViewer() {
  state.viewerJump = null;
  state.viewerTarget = null;
  state.viewer = { firstLine: 1, lines: [], capped: false };
  dom.viewerMeta.textContent = "Summarize the file to open the viewer.";
  dom.viewerLines.replaceChildren();
  dom.viewerScroll.min = "1";
  dom.viewerScroll.max = "1";
  dom.viewerScroll.value = "1";
}

function finishedLabel(kind) {
  if (kind === "stats") {
    return "Summary finished.";
  }
  if (kind === "search") {
    return "Search finished.";
  }
  if (kind === "line") {
    return "Line loaded.";
  }
  if (kind === "window") {
    return "Viewer updated.";
  }
  return "Benchmark finished.";
}

function cancelledLabel(kind) {
  if (kind === "stats") {
    return "Summary cancelled.";
  }
  if (kind === "search") {
    return "Search cancelled.";
  }
  if (kind === "line") {
    return "Line jump cancelled.";
  }
  if (kind === "window") {
    return "Viewer cancelled.";
  }
  return "Cancelled. Results from engines that finished are still listed.";
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
    return "The one-byte Rust call could not be compared with the JavaScript scan because a timer read zero. The call still includes the copy into WebAssembly memory.";
  }
  return `${timesAsLong("The one-byte Rust call", "the JavaScript scan", comparison.callVsScan)} The call includes the copy into WebAssembly memory.`;
}

function scanComparison(comparison) {
  if (comparison.estimatedScanVsJs != null) {
    return `${timesAsLong("The estimated one-byte Rust scan", "the JavaScript scan", comparison.estimatedScanVsJs)} This subtracts the transfer estimate from the call time.`;
  }
  if (!(comparison.jsProcessMs > 0)) {
    return "The JavaScript scan was below the timer resolution, so it cannot be compared with the estimated Wasm scan.";
  }
  if (typeof comparison.estimatedScanMs !== "number") {
    return "Estimated one-byte Rust scan time is unavailable. The transfer estimate was at least as large as the call time, so the difference is inside the noise of the sample.";
  }
  return "Estimated one-byte Rust scan time could not be compared with the JavaScript scan.";
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
