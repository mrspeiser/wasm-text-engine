import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LINE_PREVIEW, splitWindowLines } from "./split-window.js";

function encode(text) {
  return new TextEncoder().encode(text);
}

function texts(bytes, options) {
  return splitWindowLines(bytes, options).map((line) => line.text);
}

test("consecutive lines keep their text", () => {
  assert.deepEqual(texts(encode("alpha\nbeta\ngamma")), ["alpha", "beta", "gamma"]);
});

test("a blank line is its own row", () => {
  assert.deepEqual(texts(encode("a\n\nb")), ["a", "", "b"]);
});

test("a final line with no newline is included", () => {
  assert.deepEqual(texts(encode("a\nb")), ["a", "b"]);
  assert.deepEqual(texts(encode("only")), ["only"]);
});

test("a window that starts past the first line does not include it", () => {
  // Lines 2 and 3 of "ab\ncd\nef". The slice begins at "cd".
  assert.deepEqual(texts(encode("cd\nef")), ["cd", "ef"]);
});

test("an empty line's slice keeps the newline that precedes it", () => {
  // Lines 1 and 2 of "a\n\nb" are the bytes "a\n".
  assert.deepEqual(texts(encode("a\n")), ["a", ""]);
  // Both lines of "\n\n" are the first byte.
  assert.deepEqual(texts(encode("\n")), ["", ""]);
});

test("an empty slice is one empty line", () => {
  const lines = splitWindowLines(new Uint8Array());
  assert.deepEqual(lines, [{ text: "", truncated: false }]);
});

test("a carriage return stays inside the line", () => {
  assert.deepEqual(texts(encode("a\rb\nc")), ["a\rb", "c"]);
});

test("a line past 8 KiB is marked truncated", () => {
  const bytes = new Uint8Array(MAX_LINE_PREVIEW + 10).fill(0x61);
  const lines = splitWindowLines(bytes);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].truncated, true);
  assert.equal(lines[0].text.length, MAX_LINE_PREVIEW);
});

test("a capped slice does not invent an empty line after a newline", () => {
  const lines = splitWindowLines(encode("alpha\nbeta\n"), { capped: true });
  assert.deepEqual(
    lines.map((line) => line.text),
    ["alpha", "beta"],
  );
  assert.equal(lines.every((line) => line.truncated === false), true);
});

test("a capped slice marks the unfinished last line", () => {
  const lines = splitWindowLines(encode("alpha\nbeta"), { capped: true });
  assert.equal(lines[0].text, "alpha");
  assert.equal(lines[0].truncated, false);
  assert.equal(lines[1].text, "beta");
  assert.equal(lines[1].truncated, true);
});
