---
name: mega-primal-form-schema
description: How species.json/er-config record Mega/Primal/Origin/Crowned form triggers -- the reverse-lookup shape, and the one move-triggered exception
metadata:
  type: reference
---

The FORM's own species.json entry carries the trigger, not the base species. Each
mega/primal-form entry has a `megas`/`primals` array of `{from, item?, move?,
megaType/primalType}` -- `from` is the base species, `item` (or, for one mega only,
`move`) is the trigger. Multiple `from` entries can point at the same form id (e.g. all
of Pikachu's regional-cap variants -> `SPECIES_PIKACHU_PARTNER_MEGA`).

Schema citation: `pipeline/.upstream/er-config/SpeciesList.proto:50-80` --
`MegaEvolution` has `oneof evo_using { item | move }` (:62-65); `PrimalEvolution` has
`item` as a plain field, no oneof (:77-79) -- so every Primal/Origin/Crowned form is
item-triggered **by construction**, not just in this snapshot. Only
`SPECIES_RAYQUAZA_MEGA` uses the move branch (`MOVE_DRAGON_ASCENT`), confirmed by
scanning the full 1907-entry species.json: 270 species have non-empty `megas`, 17 have
non-empty `primals`, exactly one `megas[]` entry across all of them lacks `item`.
Pipeline side: `pipeline/src/erdata/emit.py:150-167` (`_megas`/`_primals`).

`(from, item)` pairs are unique across the whole species list (measured: 303 keys, 0
collisions) -- safe to key a reverse index on the pair. `ITEM_URSHIFITE` is the
concrete case that would break an item-only index: it resolves to
`SPECIES_URSHIFU_MEGA` from `SPECIES_URSHIFU` but
`SPECIES_URSHIFU_RAPID_STRIKE_STYLE_MEGA` from the Rapid Strike base.

Built `web/src/lib/formResolution.ts` (`buildFormIndex`/`resolveForm`) as the reverse
lookup, plus `formResolution.test.ts` driven from the boss-fight-coverage 55-trainer-id
list -- re-measured 55 ids / 285 slots / 70 held-transform-item slots / 59 distinct
forms, exactly matching `docs/battle-sim/boss-fight-coverage.md`. See
[Battle sim Section A status](project_battle-sim-section-a.md) for where this sits in
the plan (step 2, plan.md).

**Gotcha caught by the test, not by reasoning**: `TRAINER_DRAKE`'s Elite party (one of
the 55 target trainers) DOES field a base `SPECIES_RAYQUAZA` (holding Life Orb, no
mega). The coverage doc's "Rayquaza-Mega does not appear in these fights" claim is
about the MEGA FORM never being reached, not about the base species being absent --
don't conflate the two when writing a similar exclusion test.
