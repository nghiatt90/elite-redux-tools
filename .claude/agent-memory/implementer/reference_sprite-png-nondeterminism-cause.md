---
name: sprite-png-nondeterminism-cause
description: Root cause of the "erdata.build regenerates sprite PNGs with spurious diffs" trap -- confirmed cross-environment Pillow/zlib encoder drift, not a real content change
metadata:
  type: reference
---

`uv run --directory pipeline python -m erdata.build` regenerating `data/<version>/sprites/**/*.png`
with thousands of byte-level diffs, even when nothing sprite-related changed, is caused
by **Pillow/zlib PNG-encoder version drift across environments**, not non-determinism
within a single run.

**How this was confirmed** (2026-09-11, pipeline/src/erdata/sprites.py at the time):
- Running `build_sprites()` twice in the same process hash-matched every one of 7628
  PNGs byte-for-byte -- so encoding is deterministic *within* one Pillow/zlib build.
- Decoding a byte-different old-vs-new PNG (`Image.open(...).convert("RGBA")` pixel
  comparison) showed **identical pixels**. Only the DEFLATE-compressed bytes differ.
- `pipeline/pyproject.toml` pins `pillow>=11.0` (a floor, not an exact version);
  `uv.lock` resolved 12.3.0 at the time. Whatever environment produced the currently-
  committed sprites likely resolved a different Pillow (bundling a different zlib),
  which compresses the same pixels to different bytes.

**How to apply:** when `erdata.build` is run for any reason (even an unrelated data
change, e.g. [[inverse-type-chart-emission]] wasn't sprite-related at all), expect
`git status` to show every sprite PNG as modified. Before committing, diff-and-revert
`data/<version>/sprites/` unless sprites were deliberately regenerated (verify with a
pixel decode, not just eyeballing file sizes, before assuming it's the same trap) --
`git checkout -- data/<version>/sprites` is enough once confirmed. This has already
cost at least two prior agent sessions extra investigation per the battle-sim task
brief that flagged it; this file is what "record it somewhere" was asking for.

A real fix (pinning an exact Pillow version, or normalizing PNG output with a fixed
compression strategy) would need the project owner's sign-off since it changes
`pyproject.toml`/`uv.lock` -- not something to do unprompted as a side effect of an
unrelated data-pipeline batch.
