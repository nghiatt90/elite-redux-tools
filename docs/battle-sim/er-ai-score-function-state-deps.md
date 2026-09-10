# AI score-function state dependencies

_Verified — what battle state the ER AI score functions actually read, and why a damaging-moves-only turn loop cannot be driven against a real trainer party_

Verified 2026-09-11 against `pipeline/.upstream/eliteredux-source` at the pinned SHA.
Settles open item **B** of the battle-sim plan (vertical slice vs front-loaded state model).

## Which score functions are actually live

`TrainerPartyGenerator.kt:179-197` emits **every** trainer with, unconditionally:
`CHECK_BAD_MOVE | TRY_TO_FAINT | CHECK_VIABILITY | CHECK_FOE | SMART_SWITCHING | HP_AWARE |
WILL_SUICIDE`, plus `RISKY` / `STALL` / `PREFER_STATUS_MOVES` / `DISABLE_SWITCHING` when the
matching textproto bool is set. `SETUP_FIRST_TURN`, `PREFER_STRONGEST_MOVE` and
`PREFER_BATON_PASS` are **never emitted** for trainers. So the plan's "four live score
functions + AI_Risky" is right about the *table* (`battle_ai_main.c:60-93`; slots 12/13/15/16
are NULL), but the three always-on NULL-slot flags still change scores:
- `AI_FLAG_WILL_SUICIDE` read at `battle_ai_main.c:809, 2644`
- `AI_FLAG_SMART_SWITCHING` read at `battle_ai_main.c:2562, 2573, 3990`
- `AI_FLAG_CHECK_FOE` read at `battle_ai_util.c:1353`
`STALL` at `battle_ai_main.c:3302`, `battle_ai_util.c:2122, 2678`;
`PREFER_STATUS_MOVES` at `battle_ai_main.c:2552`.

## Measured branch dependence

Line counts: `AI_CheckBadMove` 488-2163 (1676), `AI_TryToFaint` 2165-2211 (47),
`AI_CheckViability` 2515-3984 (1470), `AI_Risky` 4094-4124 (31), `AI_HPAware` 4180-4340 (161).

Scanning branch conditions only (not helper bodies — this is a **lower bound**):

| function | branch conds | reading state a damaging-only loop lacks |
|---|---|---|
| AI_CheckBadMove | 721 | 259 (36%) |
| AI_CheckViability | 684 | 281 (41%) |
| AI_HPAware | 101 | 7 (7%) |
| AI_TryToFaint | 14 | 2 (14%) |
| AI_Risky | 21 | 0 |

Top groups: stat stages 116, status/volatile 121, item/hold-effect 101, revealed-move
history 122, weather+field 71, hazards/side 24, party/switch 20.

## Why "no switching" is not a legal simplification

`ShouldSwitch()` (`battle_ai_switch_items.c:602-697`) is reachable **from inside the score
functions**: `battle_ai_main.c:3017` (EFFECT_BATON_PASS) and via `ShouldPivot`
(`battle_ai_util.c:1876-1884`, used for U-turn/Volt Switch class moves). It reads the whole
reserve party through `GetMonData(&gEnemyParty[i], ...)`, hazards
(`PartyBattlerShouldAvoidHazards`, `battle_ai_util.c:1866`), `status2`, `gStatuses3/4`,
`gVolatileStructs`, and `gBattleStruct->monToSwitchIntoId`. Separately,
`ChooseMoveOrAction_Singles` (`battle_ai_main.c:300-318`) can return `AI_CHOICE_SWITCH`
whenever all four scores are <= 95 and HP >= half and base-stat total >= 310.

Two ROM quirks a faithful port must reproduce:
- `battle_ai_switch_items.c:611` tests `gBattleTypeFlags & AI_FLAG_DISABLE_SWITCHING`.
  `AI_FLAG_DISABLE_SWITCHING` is `1 << 17` (`constants/battle_ai.h:61`) and so is
  `BATTLE_TYPE_PALACE` (`constants/battle.h:66`). The trainer-level `noSwitching` flag is
  therefore **dead**; every trainer can switch.
- `battle_ai_main.c:200` memsets `gRoundStructs[gActiveBattler]` (preserving only
  `protectMove`) as a side effect of scoring.

## Movesets: 96% of ace parties contain a non-damaging move

From the committed `data/v2.65beta/trainers.json` + `moves.json`, 895 trainers have an ace
party, 3732 mons, 14700 move slots.

| metric | value |
|---|---|
| move slots with power 0 | 2962 of 14700 (20.1%) |
| mons whose 4 moves are all damaging and target SELECTED | 1166 of 3732 (31.2%) |
| ace parties where **every** mon qualifies | 36 of 895 (4.0%) |

Commonest zero-power effects: PROTECT 325, RESTORE_HP 181, SLEEP 132, ATTACK_UP_2 129,
ROOST 118, STEALTH_ROCK 110, TOXIC 107. The plan's "any Ace-tier trainer works" is false for
the slice. The 36 that do qualify include `TRAINER_MAGIKARP_GUY` (6 mons, 4 distinct move
effects) and `TRAINER_OLDPLAYER` (6 mons, 1 effect) — the only two full-size ones.

Even inside those 36, the move effects present include `EFFECT_HIT_ESCAPE` (→ ShouldPivot →
ShouldSwitch), `EFFECT_KNOCK_OFF`, `EFFECT_FAKE_OUT`, `EFFECT_FACADE`, `EFFECT_FLAIL`,
`EFFECT_SOLARBEAM`, `EFFECT_SEMI_INVULNERABLE`, `EFFECT_RECHARGE`, `EFFECT_RAPID_SPIN`,
`EFFECT_REMOVE_TERRAIN_NO_FAIL` and eight `*_HIT` status/stat secondaries. "Damaging" does
not mean "stateless".

## RNG call order is state-gated — the real killer

`AI_CheckViability` alone consumes RNG at ~35 sites (`AI_RandLessThan`,
`battle_ai_util.c:441`). Because of C short-circuit order, whether a draw happens depends on
state: e.g. `battle_ai_main.c:2726` `statStages[STAT_EVASION] > 9 && AI_RandLessThan(128)`,
2727 `status1 & STATUS1_POISON_ANY && ... && !AI_RandLessThan(80)`, 2728
`gStatuses3 & STATUS3_LEECHSEED && !AI_RandLessThan(70)`, 1638
`gVolatileStructs[battlerAtk].protectUses == 1 && Random() % 100 < 50`.
`gRngValue` is the single global stream shared with damage rolls, so omitted state does not
just perturb one score — it desynchronises every later roll in the battle.

Even the always-executed preamble of `AI_CheckViability` (2525-2592), which runs for plain
damaging moves, reads `statStages[STAT_EVASION]`/`[STAT_ACC]` (2531-2532),
`status1 & STATUS1_BURN`/`STATUS1_FROSTBITE` (2555-2578, can hard-set `score = 90`),
`AI_DATA->holdEffects` (2586), `CountUsablePartyMons` (2589) and a recursive
`AI_CheckBadMove` call (2589). `AI_CheckBadMove`'s own preamble reads
`gVolatileStructs[].disabledMove/disableTimer` (509) and Truant turn parity (511).

## CanTargetFaintAi — the plan understates this badly

`battle_ai_util.c:955-968` indexes `AI_DATA->simulatedDmg[battlerDef][battlerAtk][moves[i]]`
where `moves[i]` is a **move id**, not a 0-3 index. The plan's flat-index arithmetic is
correct: in singles that is flat `4 + moveId`, and `GetAiLogicData`
(`battle_ai_main.c:223-268`) fills only `[1][0][0..3]` = flat 16-19. So:

- moveId 12-15 (`MOVE_GUILLOTINE`, `MOVE_RAZOR_WIND`, `MOVE_SWORDS_DANCE`, `MOVE_CUT` per
  `er-config/MoveEnum.proto`) read the AI's own simulated damage.
- moveId <= 59 otherwise: reads a zeroed slot → FALSE.
- moveId ~60-76: reads `effectiveness[][][]` and `moveLimitations[]` reinterpreted as s32.
- moveId >= ~77: reads **past the end of `struct AiLogicData`** into the heap. `aiData` and
  `battleHistory` are separate `AllocZeroed` blocks (`battle_util2.c:29-30`).

The move list has 1032 entries, so roughly **92% of move ids fall in the out-of-struct
regime**. "Use the ROM only for the tail past the struct" describes the overwhelming majority
of cases, not a tail. This is also the one place where the plan's oracle gate can pass while
the port is wrong: a port that hardcodes `CanTargetFaintAi -> FALSE` will agree with the ROM
on most seeds and be wrong exactly when it matters, because the function feeds
`battle_ai_main.c:2203, 2539, 2581, 2584` and `ShouldPivot`.

## Verdict

Slice, but the following must be front-loaded into `BattleState` before turn one, or the port
is not comparable to the ROM at all:

1. `statStages[8]` per battler
2. `status1` (incl. ER's FROSTBITE/BLEED) and `status2`
3. `gStatuses3` / `gStatuses4` / `gVolatileStructs` (disableTimer, protectUses, fear,
   skyDropped, at minimum)
4. Reserve-party roster with HP/species, plus `monToSwitchIntoId` — required by `ShouldSwitch`
5. `gSideStatuses` / `gSideTimers` (hazards, screens, tailwind)
6. `gBattleWeather` + `gFieldStatuses` + `gFieldTimers`
7. Held item + `BATTLE_HISTORY->itemEffects` (drives `SetBattlerData` concealment)
8. `BATTLE_HISTORY->usedMoves` and `gLastMoves`
9. `gRngValue` threaded through the score functions in exact call order

That is essentially the whole state model. The honest framing is that the slice saves work on
**move behaviours** (~358 unported), not on **state**.

See [Party level is not symmetric](er-level-asymmetries.md).
