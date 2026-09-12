# Verifying cited numbers and corpus claims

_Re-measure every count and every "held for every case in the corpus" claim an author writes in a comment; several have been wrong in this repo_

Treat a number or a coverage claim written in a code comment as unverified until
re-measured against the pinned checkout. Line *numbers* cited into `pipeline/.upstream/`
have been accurate here; the *filename* beside them has not, and counts and
corpus-coverage claims have not.

**Why:** in the 2026-09-11 batch review, three author-written claims failed:
`trainers.py`'s "504 leave elite empty / 534 leave hell empty" were 503/533 (the
placeholder trainer was counted before it was dropped); `encounters.py`'s claim that its
`} else {` guard tracker "held for every case this module was checked against" is false
for the dominant corpus style (207 own-line `else{` against 74 same-line), which silently
turns a real guard into `null`; and a reported pipeline test count contradicted itself.
Same-author tests do not catch these because they assert the same misreading.

**How to apply:** for a scraper, replicate its own tracker over the whole corpus in a
scratchpad script and check an invariant (e.g. brace depth returns to zero per file),
count the raw signal occurrences and compare against the emitted rows, and grep for the
syntactic variants the module says it handles. For a count in a comment, recompute it.
Report the delta even when it is off by one -- the cause is usually a real off-by-one in
what was counted. Open the cited file *at* the cited line and read it: a plausible line
number in the wrong file reads as verified until someone looks (the ability-resolution fix
cited `battle_util.c:5001-5002` for what is really `pokemon.c:2147-2156`). Check too that a
worked example in a comment or test actually exercises the regime it is offered as evidence
for. See [Textproto versus codegen divergence](textproto-vs-codegen-divergence.md).
