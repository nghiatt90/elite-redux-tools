---
name: map-script-battle-macros-and-engine-introspection
description: Indexing map-script battles needs starttagbattle/multi_2_vs_2 as well as trainerbattle*, and web/node_modules/.bin/jiti loads the TS engine registry from a scratchpad script
metadata:
  type: reference
---

Two things that cost time during the 2026-09-16 boss-fight coverage measurement.

**`trainerbattle*` is NOT the whole battle-macro set in `data/maps/*/scripts.pory`.**
Indexing only `\btrainerbattle\w*\b` finds 777 call sites across 122 maps and misses
entire fights. The full set also includes:
- `starttagbattle(TRAINER_A, TRAINER_B, TAG_TEAM_*, 0, ...)` — the player alone versus
  TWO opponents (both `gTrainerBattleOpponent_A` and `_B` set, `FLAG_TAG_BATTLE`,
  `src/battle_setup.c:1470`; the TAG_TEAM_* ids are `include/constants/battle.h:559+`).
  Every gym's paired trainers use it, and so does the **gym 8 leader fight** —
  `SootopolisCity_Gym_1F:278` is Juan **and Wallace** together, chaining on victory into
  a second tag battle at `:288` (JUAN_5 + WALLACE_5). Grepping for `TRAINER_JUAN_1` in a
  `trainerbattle`-only index returns nothing at all.
- `multi_2_vs_2 OPP_A, textA, OPP_B, textB, PARTNER, BACK_PIC` — the player plus an AI
  partner versus two opponents. Used by the Meteor Falls Magma fight
  (`MeteorFalls_1F_1R:193`) and the Mossdeep Space Center Maxie fight
  (`MossdeepCity_SpaceCenter_2F:274`). The partner argument is an ordinary trainer id
  from `TrainerEnum.proto` (some are spelled without the `TRAINER_` prefix, e.g.
  `MAY_TORCHIC_METEOR_FALLS = 70`), so the partner's party is in `trainers.json` too.

Adding both macros: 810 sites, 123 maps, 681 distinct trainers (vs 646).

**`web/node_modules/.bin/jiti` runs a TypeScript file directly**, which is how to
introspect the engine from a scratchpad script without adding a file to the repo or
running vitest. There is no `tsx` and no `vite-node` in `web/node_modules/.bin` — the
bin dir holds `jiti`, `oxlint`, `rolldown`, `tsc`, `vite`, `vitest`. A script at the
scratchpad root reaches the repo with seven `..` segments
(`../../../../../../../Desktop/Yoshi/Pokemon Elite Redux/elite-redux-tools/web/src/...`);
spaces in the path are fine inside an import string.

**Why it matters:** static-grepping `id: 'ABILITY_X'` out of
`web/src/engine/abilities/impl/*.ts` finds **558** entries, but the live registry holds
**591** — 33 are registered through macros/generators with no literal `id:` string, and
the 11 that looked like coverage-gate violations (the "-ate" family, Fluffy, Steelworker,
Fight Spirit) were all really present. Load the registry, do not grep it.

See [[reference_unmodelled-base-power-sweep-method]] for the same lesson applied to
move base power, and `docs/battle-sim/verify-cited-numbers-and-corpus-claims.md`.
