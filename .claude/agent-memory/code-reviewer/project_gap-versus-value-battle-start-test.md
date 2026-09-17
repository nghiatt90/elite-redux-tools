---
name: gap-versus-value-battle-start-test
description: The project standard for deciding whether a bridged field is a derived value or a gap — "can a real battle-start source set this?" — adopted by the team lead on 2026-09-17.
metadata:
  type: project
---

Standing rule for `web/src/engine/sim/bridge.ts` and anything that maps sim state into a
`DamageCalcScenario`: **a field present in the state model but never written by anything is
a gap, not a value.** Mapping one type-checks, reads as a modelled answer forever, and is
the most convincing of this project's silent-wrong-number failures because the field IS
there.

The discriminator that settles the hard cases, adopted as the project standard on
2026-09-17:

> **Can a real battle-start source set this?**

- **Yes → derived.** `encounters.json` sets weather and terrain; trainer parties set items,
  natures and abilities; `status1` persists on the party mon across switches, so a mon
  genuinely can enter battle burned. These are legitimately caller-supplied even though the
  sim does not update them; note the staleness and move on.
- **No → gap.** State that only ever arises from move and ability effects the loop does not
  run. `extraStatLevel`, `statuses3`/`statuses4` flags, `RoundState` fields.

Cases the earlier wording ("per-battler state arising from effects") left ambiguous and
this one settles:

- **`statStages` is a GAP.** `createBattlerState` overwrites whatever is passed with
  `defaultStatStages()`, nothing writes stages afterwards, and no battle-start source sets
  them. Structurally identical to `extraStatLevel`, which was already gapped. Three fields
  inherit it: `condition.speed`, `positiveStatStageCount`, `negativeStatStageCount`.
- **`moveSlotPp` is a GAP** (or needs an explicit staleness note): PP is caller-suppliable
  at full, but the loop never decrements it and Trump Card's power is entirely PP-derived.

**Why:** without a test, "arises from effects" and "caller-suppliable" both sound true of
the same field and the argument goes in circles.

**How to apply:** ask the question per field before accepting either classification, and
check that the gap list is asserted EXACTLY rather than by membership — `toContain` and
`expect.arrayContaining` pass just as well if a later batch deletes nothing. See
[[isgrounded-is-a-baseline-not-an-answer]] for the adjacent trap: a field whose contract is
narrower than its name.
