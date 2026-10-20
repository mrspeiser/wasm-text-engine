/**
 * Count bytes equal to 0x0A.
 *
 * This is the JavaScript half of the newline benchmark. It scans a
 * Uint8Array in place and does not decode text. Callers add the return
 * value across chunks; a newline is one byte, so a boundary cannot split it.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function countNewlines(bytes) {
  const length = bytes.length;
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    if (bytes[index] === 0x0a) {
      count += 1;
    }
  }
  return count;
}
