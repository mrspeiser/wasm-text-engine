from pathlib import Path

OUTPUT = Path("test-data/benchmark.txt")
TARGET_SIZE = 1024 * 1024 * 1024  # 1 GiB

LINE = b"2026-10-12 INFO request processed successfully\n"

OUTPUT.parent.mkdir(parents=True, exist_ok=True)

with OUTPUT.open("wb") as file:
    written = 0

    while written + len(LINE) <= TARGET_SIZE:
        file.write(LINE)
        written += len(LINE)

    file.write(b"X" * (TARGET_SIZE - written))

print(f"Generated {OUTPUT}")
print(f"Size: {OUTPUT.stat().st_size:,} bytes")
print(f"Expected newlines: {TARGET_SIZE // len(LINE):,}")