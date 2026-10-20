#!/usr/bin/env python3
"""Write a UTF-8 fixture of repeated log lines for the newline benchmark.

The file is padded with ``X`` bytes so its size is exact. Padding contains
no ``0x0A`` bytes, so the newline count is the number of complete lines.
Output goes under ``test-data/``, which is gitignored.
"""

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINE = b"2026-10-12 INFO request processed successfully\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--size-mib",
        type=int,
        default=1024,
        help="target size in mebibytes (default: 1024)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "test-data" / "benchmark.txt",
        help="output path (default: test-data/benchmark.txt)",
    )
    args = parser.parse_args()
    if args.size_mib < 1:
        parser.error("--size-mib must be at least 1")

    target = args.size_mib * 1024 * 1024
    output = args.output
    output.parent.mkdir(parents=True, exist_ok=True)

    newlines = 0
    written = 0
    with output.open("wb") as file:
        while written + len(LINE) <= target:
            file.write(LINE)
            written += len(LINE)
            newlines += 1
        if written < target:
            file.write(b"X" * (target - written))
            written = target

    print(f"Generated {output}")
    print(f"Size: {written:,} bytes")
    print(f"Line length: {len(LINE)} bytes")
    print(f"Expected newlines: {newlines:,}")


if __name__ == "__main__":
    main()
