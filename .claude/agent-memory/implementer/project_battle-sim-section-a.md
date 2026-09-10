---
name: battle-sim-section-a
description: Trainer/encounter data pipeline work for the battle simulator plan (Section A) -- status and non-obvious findings
metadata:
  type: project
---

Section A of `~/.claude/plans/we-already-have-a-parsed-nova.md` (trainer + encounter
data emission) is complete as of 2026-09-11: `pipeline/src/erdata/trainers.py`,
`pipeline/src/erdata/encounters.py`, both wired into `emit.py`'s `build()`, types
mirrored in `web/src/lib/types.ts`, tests in `pipeline/tests/test_emit.py`,
`test_encounters.py`. 102 pipeline tests / 717 web tests green. Section C (battle
scripts / VM opcode reduction) is still parked pending separate review -- do not start
it without a fresh go-ahead.

**Why:** this was resumed work -- a prior instance was killed mid-batch by a spend
limit with trainers.py written but zero tests and trainers.json never actually
generated. Picking this back up required verifying nothing was silently broken before
building on it.

**How to apply:** if asked to continue this plan, Section A's data model
(`trainers.json`, `encounters.json`) is now the foundation the turn-loop/AI-port work
(Section... whichever covers the actual simulator) builds on. Read the trainers.py and
encounters.py module docstrings first -- they carry every non-obvious resolution rule
with file:line citations, cheaper than re-deriving them.

See also [[map-scripts-are-poryscript-not-inc]] for an environment-specific gotcha this
plan's own wording got wrong.
