/**
 * Split one viewer slice into lines.
 *
 * The slice runs from the start of the first visible line through the end of
 * the last, excluding that last line's newline. Newlines between those lines
 * stay in the slice, so a split on 0x0A recovers each line. A final empty
 * line is a trailing 0x0A. When the slice was cut short by the byte cap, that
 * trailing 0x0A is not a confirmed empty line.
 */

export const MAX_LINE_PREVIEW = 8 * 1024;

export function splitWindowLines(bytes, options = {}) {
  const capped = options.capped === true;
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_PREVIEW;
  const parts = [];
  let start = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      parts.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }

  const endsWithNewline = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a;
  if (!(capped && endsWithNewline)) {
    parts.push(bytes.subarray(start));
  }

  return parts.map((part, index) => {
    const cutByCap = capped && index === parts.length - 1 && !endsWithNewline;
    const truncated = cutByCap || part.length > maxLineBytes;
    const shown = part.subarray(0, maxLineBytes);
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(shown),
      truncated,
    };
  });
}
