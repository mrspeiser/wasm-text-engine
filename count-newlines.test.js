import assert from "node:assert/strict";
import { test } from "node:test";
import { countNewlines } from "./count-newlines.js";

function encode(text) {
  return new TextEncoder().encode(text);
}

test("empty input", () => {
  assert.equal(countNewlines(new Uint8Array()), 0);
});

test("no newlines", () => {
  assert.equal(countNewlines(encode("abc")), 0);
});

test("multiple newlines", () => {
  assert.equal(countNewlines(encode("a\n\nb\n")), 3);
});

test("carriage return is not a newline", () => {
  assert.equal(countNewlines(encode("a\r\nb\rc\n")), 2);
});

test("every byte can be a newline", () => {
  assert.equal(countNewlines(new Uint8Array(32).fill(0x0a)), 32);
});

test("chunk boundaries match a single pass", () => {
  const data = encode("alpha\nbeta\ngamma\n");
  const whole = countNewlines(data);

  for (let split = 0; split <= data.length; split += 1) {
    const left = countNewlines(data.subarray(0, split));
    const right = countNewlines(data.subarray(split));
    assert.equal(left + right, whole, `split at ${split}`);
  }
});

test("newline at either side of a boundary", () => {
  const left = countNewlines(encode("abc\n"));
  const right = countNewlines(encode("\ndef"));
  assert.equal(left + right, 2);
});

test("empty chunk between data", () => {
  const total =
    countNewlines(encode("ab\n")) +
    countNewlines(new Uint8Array()) +
    countNewlines(encode("\ncd"));
  assert.equal(total, 2);
});

test("repeated chunks accumulate", () => {
  const chunk = encode("x\n");
  let total = 0;
  for (let index = 0; index < 1000; index += 1) {
    total += countNewlines(chunk);
  }
  assert.equal(total, 1000);
});
