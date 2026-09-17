---
name: gate-evidence-and-ceilings
description: Two recurring defects in this repo's one-directional gates — quoting a number that cannot move as evidence a design is safe, and leaving a ceiling slack after the count is earned down.
metadata:
  type: project
---

Two patterns worth checking every time a batch cites a coverage gate.

**1. The number quoted is often not evidence for the claim it supports.**
`web/src/engine/abilities/coverage.test.ts:17-19` builds its population from
`abilityHooks.json`'s `damageRelevant` flag and never enumerates the registry, so its
logged `N/N` is a pure function of a committed data file. "The gate did not move after I
added registry entries" is therefore true whether or not the design is sound. The evidence
that actually bears on it is: is the added entry in the gate's population at all
(`damageRelevant`), and if it is, did it already have a non-unmodelled entry? Check those,
not the headline number.

**2. Ceilings get earned down but not tightened.** On 2026-09-16 the damage gate asserted
`toBeLessThanOrEqual(2)` while the measured count was 0 — two abilities could have lost
their ports with it still green. **Fixed in `d9bd93b`; it is now `toBe(0)`.** The same
shape still applies to `priorityCoverage.test.ts`'s
`expect(ported.length).toBeGreaterThanOrEqual(9)`, whose measured value is also 9.

**Why:** a one-directional counter only constrains anything while its bound equals the
measured value; slack accumulates silently and nobody notices because the test is green.

**How to apply:** when a batch cites a gate, re-derive the gate's population from its
source and check the bound against the current measured value. Flag slack even when the
batch did not introduce it — the batch quoting the gate is the moment someone is looking.
See [[verify-cited-numbers-and-corpus-claims]].
