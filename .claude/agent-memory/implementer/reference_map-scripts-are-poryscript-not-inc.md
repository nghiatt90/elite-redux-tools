---
name: map-scripts-are-poryscript-not-inc
description: eliteredux-source's data/maps/ holds .pory source, not compiled .inc bytecode -- a plan/doc that says "scripts.inc" is stale
metadata:
  type: reference
---

`pipeline/.upstream/eliteredux-source/data/maps/*/scripts.pory` (Poryscript source) is
what's actually on disk after fetching -- there is no `scripts.inc` anywhere under
`data/maps/`. `.inc` (compiled pokeemerald-assembly bytecode) would only exist after a
full ROM build step this pipeline never runs; only the `.pory` source is fetched, per
`sources.lock.json`'s `sparse_paths`.

**Why it matters:** at least one planning doc
(`~/.claude/plans/we-already-have-a-parsed-nova.md` line 148, as of 2026-09-11) tells an
implementer to scrape `data/maps/**/scripts.inc` -- a path that matches zero files.
Confirmed by `find`/`Glob` before writing any scraper against it.

**How to apply:** if a plan or doc names `.inc` map scripts, check the actual upstream
checkout first (`Glob` under `pipeline/.upstream/eliteredux-source/data/maps/`) rather
than trusting the extension. The corpus also mixes two authoring styles in the same
file -- legacy raw pokeemerald assembly inside `` raw `...` `` blocks (comma-separated
opcode args, no braces) and modern Poryscript (`script Name{ }`, paren-called opcodes,
C-like if/else/switch) -- see `MossdeepCity_Gym/scripts.pory`, which has both. Any
scraper over this corpus needs to handle both call syntaxes and must strip `//` and `@`
line comments before regex-matching opcodes: a commented-out example line in
`Route116/scripts.pory:571` (copy-pasted from Mossdeep) produced a real false positive
when comment-stripping was missing. See `pipeline/src/erdata/encounters.py`'s module
docstring for the full list of this scraper's known heuristic limitations.
