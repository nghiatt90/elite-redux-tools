# Environment and Scripted-Condition Completeness Inventory

Static inventory of every environment, battle-start and scripted-condition unit that can change how a battle plays out,
against the battle simulator. It covers no species, move, ability or item data.

- **Source Commit (eliteredux-source)**: `bdebcbbff9760cdd41a02c425bea4857fa0eee26` (game version `v2.65beta`)
- **Source Commit (er-config)**: `1b8e2cc4a8096d7ec90616f87fbf771bfa732447`
- **Regeneration Command**: `SIM_INVENTORY_WRITE=1 npm --prefix web test -- --run src/engine/sim/driver/environmentInventory.test.ts`

## Unit Kinds and Classification Rules

A unit is **ported** only when its token appears in both a qualifying non-test engine source file and an engine
test file, after comments are stripped. Qualifying production files are all non-test files under `web/src/engine/`
except `sim/driver/`, plus the four loader files `session.ts`, `runBattle.ts`, `buildParty.ts` and `loadSimData.ts`.
`registered, untested` means production names the token but no qualifying test does; it is counted as unported. A
mention in a comment is not evidence, and neither is a name alone:

- `speedDown` requires a test that sets `speedDown: true` or `ironPill: true`. Every current fixture sets the flag to
  `false`, so production implements the C rule (`src/pokemon.c:994`, `if (speedDown) speedIV = 0;`) but no test asserts it.
- Battle-type units must have the flag assigned in the driver battle-start path (`session.ts`, `runBattle.ts`,
  `buildParty.ts`). `BATTLE_TYPE_TRAINER` qualifies (`session.ts:245`); `BATTLE_TYPE_DOUBLE` does not, so the driver
  never runs a double battle regardless of a constant or a hand-built test state.
- `forcedDouble` additionally requires a production line outside `aiFlags.ts` that changes the number of active
  battlers. The engine only ORs `AI_FLAG_DOUBLE_BATTLE`; the codegen's `doubleBattle = TRUE`
  (`TrainerPartyGenerator.kt:207`) is unmodelled, so the fight stays singles.
- `AI_FLAG_CHECK_FOE` is unported: the C reads it in `GetMovesArray` (`src/battle_ai_util.c:1353`) to choose the
  real moveset versus `battleHistory->usedMoves`. Every trainer carries the bit, so the sim hard-codes the
  `IsBattlerAIControlled(battler) || ... aiFlags & AI_FLAG_CHECK_FOE` TRUE branch and reads the real moveset
  unconditionally (`aiScorers.ts:136-138`, `aiCheckBadMove.ts:424-426`); there is no `hasFlag(..., AI_FLAG_CHECK_FOE)`
  read for a future port to replace.
- Per-trainer and always-on trainer-flag units also require the codegen's mint line in `aiFlags.ts`
  (`TrainerPartyGenerator.kt:180-194`, e.g. `if (trainer.risky) flags |= AI_FLAG_RISKY`). `aiFlags.ts` is excluded
  from qualifying production evidence, so deleting the mint line must break the port; a read site alone is not proof.
- `FLAG_SYS_INVERSE_BATTLE` requires production evidence in `session.ts` or `runBattle.ts` assigning `inverseBattle` from a non-literal value.
  The sim currently hardcodes `inverseBattle: false`, so it is unported.
- Battle-event units require a live switch case in `battleEvents.ts` and dispatch wiring in `session.ts` (`registerBattleEvent`).
  33 units qualify and are asserted in `battleEvents.test.ts`; `BATTLE_EVENT_STICKY_WEB` has no case label and is allowlisted (`src/battle_events.c:362`, the post-switch `return EXEC_BATTLE_EVENTS_ALL_CLEAR;`) as a safe no-op.

Allowlisted units require an exact pinned C `file:line` whose line is quoted in the reason. The allowlist is not
empty: 8 units are provably battle-inert (cosmetics, field-effect arguments, prizes).

1. **map-setup**: a flag/var/special/script command set by a map script before a battle, or map header weather.
   The scan covers all 515 `data/maps/*/scripts.pory` files; 22 contain at least one of
   `setweather` (substring), `setfieldeffectargument`, `FLAG_TOTEM_BATTLE`, `FLAG_SYS_INVERSE_BATTLE`,
   `VAR_BATTLE_FIELD_EFFECT_TYPE` or `VAR_MONOTYPE_BOOST`.
2. **battle-type**: a `BATTLE_TYPE_*` flag or `FLAG_TAG_BATTLE` set by a battle-start path.
3. **difficulty-flag**: a save-block difficulty/settings flag, or a C rule deriving level, IVs, EVs or party selection.
4. **trainer-flag**: a `trainers.json` field, or an `AI_FLAG_*` bit the codegen mints from one.
5. **hell-trainer-skill**: per-(trainer, skill) entries from `data/hell_trainer_skills.h` registered under Hell difficulty.
6. **battle-event**: one distinct `event` in `data/v2.65beta/encounters.json` `battleEvents`, with the C handler line.
7. **script-event**: a battle script label pushed by one of the scripted setups above.

`registerbattleevent` calls in map scripts are extracted into `encounters.json`, so they are represented by the
battle-event units rather than a separate script-command unit. The sim loads that table at `loadSimData.ts:108-109`.

## Summary

| Unit kind | Defined | Ported | Registered, untested | Unported | Unclassified | Allowlisted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `map-setup` | 57 | 0 | 0 | 52 | 0 | 5 |
| `battle-type` | 9 | 1 | 2 | 8 | 0 | 0 |
| `difficulty-flag` | 16 | 1 | 1 | 15 | 0 | 0 |
| `trainer-flag` | 14 | 9 | 0 | 3 | 0 | 2 |
| `hell-trainer-skill` | 29 | 0 | 0 | 29 | 0 | 0 |
| `battle-event` | 34 | 33 | 0 | 0 | 0 | 1 |
| `script-event` | 6 | 0 | 0 | 6 | 0 | 0 |
| **total** | **165** | **44** | **3** | **113** | **0** | **8** |

Trainers in `data/v2.65beta/trainers.json`: 932. `battleEvents` rows: 51 across 34 distinct events. Map scripts scanned: 515; maps with a setup token: 22.

## Unported Units by Kind

| Unit kind | Unported | Registered, untested |
| --- | ---: | ---: |
| `map-setup` | 52 | 0 |
| `battle-type` | 8 | 2 |
| `difficulty-flag` | 15 | 1 |
| `trainer-flag` | 3 | 0 |
| `hell-trainer-skill` | 29 | 0 |
| `battle-event` | 0 | 0 |
| `script-event` | 6 | 0 |

## Map-Setup Units

| Unit key | Fights / maps | C citation | Status | Test file | Production evidence |
| --- | --- | --- | --- | --- | --- |
| `FLAG_ALPHA_CREATION` | 6 map(s), 18 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/pokemon.c:504` | allowlisted | none | none |
| `FLAG_SHINY_CREATION` | 4 map(s), 4 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route132 | `pipeline/.upstream/eliteredux-source/src/pokemon.c:499` | allowlisted | none | none |
| `FLAG_SYS_DISABLE_AUTOHEAL` | 5 map(s), 17 line(s): MossdeepCity_SpaceCenter_2F, Route111, SkyPillar_Outside, SlateportCity_OceanicMuseum_2F, SootopolisCity_Gym_1F | `pipeline/.upstream/eliteredux-source/src/battle_main.c:844` | unported | none | none |
| `FLAG_SYS_INVERSE_BATTLE` | 1 map(s), 8 line(s): MossdeepCity_Gym | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8028` | unported | none | none |
| `FLAG_TOTEM_BATTLE` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9144` | unported | none | none |
| `HealPlayerParty` | 31 map(s), 52 line(s): BattleFrontier_BattleArenaBattleRoom, BattleFrontier_BattleArenaLobby, BattleFrontier_BattleDomeBattleRoom, BattleFrontier_BattleDomeLobby, BattleFrontier_BattleDomePreBattleRoom, BattleFrontier_BattleFactoryBattleRoom, BattleFrontier_BattleFactoryPreBattleRoom, BattleFrontier_BattlePalaceBattleRoom, BattleFrontier_BattlePalaceLobby, BattleFrontier_BattlePikeLobby, BattleFrontier_BattlePikeRoomNormal, BattleFrontier_BattlePyramidFloor, BattleFrontier_BattlePyramidLobby, BattleFrontier_BattleTowerBattleRoom, BattleFrontier_BattleTowerLobby, BattleFrontier_BattleTowerMultiBattleRoom, BattleFrontier_BattleTowerMultiPartnerRoom, FallarborTown_BattleTentBattleRoom, MeteorFalls_1F_1R, MossdeepCity_House1, MossdeepCity_SpaceCenter_2F, Route101, Route111, SkyPillar_Outside, SlateportCity_BattleTentBattleRoom, SlateportCity_BattleTentCorridor, SlateportCity_OceanicMuseum_2F, SootopolisCity_Gym_1F, SootopolisCity_MysteryEventsHouse_B1F, TrainerHill_Entrance, VerdanturfTown_BattleTentBattleRoom | `pipeline/.upstream/eliteredux-source/src/battle_main.c:844` | unported | none | none |
| `VAR_BATTLE_FIELD_EFFECT_TYPE` | 3 map(s), 43 line(s): EverGrandeCity_ChampionsRoom, EvergrandeCity_MonoChampRoom_1, MossdeepCity_Gym | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4163` | unported | none | none |
| `VAR_BATTLE_FIELD_ID` | 3 map(s), 44 line(s): EverGrandeCity_ChampionsRoom, EvergrandeCity_MonoChampRoom_1, MossdeepCity_Gym | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4164` | unported | none | none |
| `VAR_MONOTYPE_BOOST` | 1 map(s), 40 line(s): EvergrandeCity_MonoChampRoom_1 | `pipeline/.upstream/eliteredux-source/src/field_specials.c:4943` | allowlisted | `web/src/engine/sim/cycle154bEnvironmentUnits.test.ts` | none |
| `VAR_TOTEM_MESSAGE` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9160` | unported | none | none |
| `VAR_TOTEM_POKEMON_ACCURACY_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9156` | unported | none | none |
| `VAR_TOTEM_POKEMON_ATK_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9151` | unported | none | none |
| `VAR_TOTEM_POKEMON_DEF_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9152` | unported | none | none |
| `VAR_TOTEM_POKEMON_EVASION_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9157` | unported | none | none |
| `VAR_TOTEM_POKEMON_SPEED_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9155` | unported | none | none |
| `VAR_TOTEM_POKEMON_SP_ATK_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9153` | unported | none | none |
| `VAR_TOTEM_POKEMON_SP_DEF_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9154` | unported | none | none |
| `VAR_TRAINER_PRIZE_BP` | 1 map(s), 18 line(s): EvergrandeCity_MonoChampRoom_1 | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:5809` | allowlisted | none | none |
| `map-weather:LavaridgeTown_Gym_1F:WEATHER_FOG_HORIZONTAL` | LavaridgeTown_Gym_1F (WEATHER_FOG_HORIZONTAL) | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4349` | unported | none | none |
| `map-weather:MtPyre_Summit:WEATHER_FOG_HORIZONTAL` | MtPyre_Summit (WEATHER_FOG_HORIZONTAL) | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4349` | unported | none | none |
| `map-weather:Route111_Desert:WEATHER_SANDSTORM` | Route111_Desert (WEATHER_SANDSTORM) | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4349` | unported | none | none |
| `map-weather:Route111_SunhollowRuins:WEATHER_SANDSTORM` | Route111_SunhollowRuins (WEATHER_SANDSTORM) | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4349` | unported | none | none |
| `monochamp:abilities.cc:5201` | [POISON] Toxic Spill's onEntry is skipped when the champion is Poison: `CHECK_NOT(getMonotypeChampType() == TYPE_POISON)`. Unmodelled (web/src/engine/sim/switchInAbility.ts:2303 skips the entry effect without the champion check). | `pipeline/.upstream/eliteredux-source/src/abilities.cc:5201` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:abilities.cc:5211` | [POISON] Toxic Spill's onEndTurn is skipped when the champion is Poison: `CHECK_NOT(getMonotypeChampType() == TYPE_POISON)`. Conditional port at web/src/engine/sim/endTurn.ts:1409; only the driver feed is missing. | `pipeline/.upstream/eliteredux-source/src/abilities.cc:5211` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:abilities.cc:5246` | [POISON] Toxic Spill's onExit is skipped when the champion is Poison: `CHECK_NOT(getMonotypeChampType() == TYPE_POISON)`. Unmodelled (web/src/engine/sim/turn.ts:1642 skips the exit effect without the champion check). | `pipeline/.upstream/eliteredux-source/src/abilities.cc:5246` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_main.c:4205` | [FLYING] the champion's side doubles its Speed: `GET_BATTLER_SIDE(battlerId) != B_SIDE_PLAYER && getMonotypeChampType() == TYPE_FLYING`. Conditional port at web/src/engine/sim/turnOrder.ts:331; only the driver feed is missing. | `pipeline/.upstream/eliteredux-source/src/battle_main.c:4205` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_main.c:5824` | [all types] the switch :5823-5870, called from battle_main.c:3029: Grass/Electric/Fairy/Psychic set their terrain permanently, Fire sets primal sun, Flying strong winds, Water primal rain plus `swampTimer = 1`, Ice hail, and Dark puts the player's team to sleep (`MakePlayerTeamAsleep`). Unmodelled. | `pipeline/.upstream/eliteredux-source/src/battle_main.c:5824` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_script_commands.c:8344` | [WATER] Court Change does not swap the swamp timer: `if (!(getMonotypeChampType() == TYPE_WATER)) SWAP(gSideTimers[0].swampTimer, gSideTimers[1].swampTimer, temp)`. Conditional port at web/src/engine/sim/moveEffects.ts:8773; only the driver feed is missing. | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8344` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_script_commands.c:8985` | [DRAGON] intimidate data uses `ABILITY_FEARMONGER` for the non-player attacker when `ability == ABILITY_NONE`: `getMonotypeChampType() == TYPE_DRAGON && GetBattlerSide(gBattlerAttacker) != B_SIDE_PLAYER && ability == ABILITY_NONE`. Unmodelled. | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8985` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_script_commands.c:979` | [STEEL] the Mold Breaker marker is set for the non-player side: `getMonotypeChampType() == TYPE_STEEL && GetBattlerSide(battler) != B_SIDE_PLAYER`. Unmodelled. | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:979` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:1431` | [FIGHTING] status moves are unusable on the player's side: `gBattleMoves[move].split == SPLIT_STATUS && getMonotypeChampType() == TYPE_FIGHTING && GetBattlerSide(gActiveBattler) == B_SIDE_PLAYER`. Unmodelled, conditional note at web/src/engine/sim/ai/aiMoveLimitations.ts:93. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:1431` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:1632` | [FIGHTING] the move filter repeats the status lock: `FILTER_NOT(... SPLIT_STATUS && ... TYPE_FIGHTING && GetBattlerSide(battlerId) == B_SIDE_PLAYER)`. Unmodelled, conditional note at web/src/engine/sim/ai/aiMoveLimitations.ts:93 (no limitation bit is set). | `pipeline/.upstream/eliteredux-source/src/battle_util.c:1632` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:2238` | [WATER] the swamp timer does not tick down for the player's side: `!(getMonotypeChampType() == TYPE_WATER && side == B_SIDE_PLAYER) && --gSideTimers[side].swampTimer == 0`. Conditional port at web/src/engine/sim/fieldEndTurn.ts:906; only the driver feed is missing. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:2238` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:2488` | [POISON] `ENDTURN_TOXIC_WASTE_DAMAGE` runs Toxic Spill's onEndTurn with `ABILITY_NONE` when `getMonotypeChampType() == TYPE_POISON && gActiveBattler == B_SIDE_PLAYER`. The ability hook's champion check is conditionally ported at web/src/engine/sim/endTurn.ts:1409; the battle_util dispatch itself is not run. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:2488` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:2635` | [ROCK] `ENDTURN_SALT_CURE` damages every player mon as if salt-cured: `(getMonotypeChampType() == TYPE_ROCK && GET_BATTLER_SIDE(gActiveBattler) == B_SIDE_PLAYER) || (gStatuses4[gActiveBattler] & STATUS4_SALT_CURE)`, 1/4 for Water or Steel else 1/8. Unmodelled (web/src/engine/sim/endTurn.ts:2039 notes the ROCK half has no port). | `pipeline/.upstream/eliteredux-source/src/battle_util.c:2635` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:2649` | [BUG] `ENDTURN_WRAP` Infestation damage on every player mon: `getMonotypeChampType() == TYPE_BUG && ... GET_BATTLER_SIDE(gActiveBattler) == B_SIDE_PLAYER`. Unmodelled (web/src/engine/sim/endTurn.ts:614 notes the Bug branch has no port). | `pipeline/.upstream/eliteredux-source/src/battle_util.c:2649` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:4850` | [FIGHTING] the player's side cannot switch out: the `return FALSE` branch `GetBattlerSide(battlerId) == B_SIDE_PLAYER && getMonotypeChampType() == TYPE_FIGHTING`. Conditional port at web/src/engine/sim/escape.ts:105; only the driver feed is missing. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4850` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:4971` | [DARK] the AI sleep clause is disabled for the player's side: `asleepmons != 0 && !(getMonotypeChampType() == TYPE_DARK && GetBattlerSide(battlerId) == B_SIDE_PLAYER)`. Unmodelled (web/src/engine/sim/ai/aiMoveLimitations.ts:89 notes the Dark exemption). | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4971` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:6656` | [GROUND] the player's side is grounded: `getMonotypeChampType() == TYPE_GROUND && GetBattlerSide(battlerId) == B_SIDE_PLAYER`. Conditional port at web/src/engine/sim/grounding.ts:50; only the driver feed is missing. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6656` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:7235` | [ICE] the attack uses Speed as the attack stat when the defender is on the player's side: `getMonotypeChampType() == TYPE_ICE && GetBattlerSide(battlerDef) == B_SIDE_PLAYER`. Unmodelled. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7235` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:7717` | [GRASS, PSYCHIC, ELECTRIC, POISON, STEEL, GROUND, FIGHTING] the switch at :7716-7756: 0.7 for Grass/Psychic/Electric against the champion side, 0.7 Poison and Steel for both sides, Ground 0.65 on super-effective hits vs the champion side, Fighting halves/quarters super-effective damage and multiplies Fighting moves by 1.5. Unmodelled note at web/src/engine/sim/ai/aiCalcDamage.ts:208-210. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7717` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:7861` | [FAIRY] Fairy moves hit Poison and Steel defenders super-effectively on the player's side: `moveType == TYPE_FAIRY && (defType == TYPE_POISON || defType == TYPE_STEEL) && GetBattlerSide(battlerDef) == B_SIDE_PLAYER && getMonotypeChampType() == TYPE_FAIRY`. Unmodelled note at web/src/engine/sim/ai/aiShouldSwitch.ts:219. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7861` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:7863` | [DRAGON] a 0x effectiveness becomes 1x on the player's side: `mod == UQ_4_12(0.0) && GetBattlerSide(battlerDef) == B_SIDE_PLAYER && getMonotypeChampType() == TYPE_DRAGON`. Unmodelled note at web/src/engine/sim/ai/aiShouldSwitch.ts:219. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7863` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:7865` | [ROCK] the `getMonotypeChampType() == TYPE_ROCK` branch (:7865-7869): Rock-on-Rock is super-effective on the player's side, and non-player-side Rock moves become immune. Unmodelled note at web/src/engine/sim/ai/aiShouldSwitch.ts:219. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7865` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:8672` | [FLYING] Trick Room is never active: `IsAbilityOnField(ABILITY_CLUELESS) || getMonotypeChampType() == TYPE_FLYING`. Conditional port at web/src/engine/sim/turn.ts:631; only the driver feed is missing. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8672` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:8674` | [NORMAL] Trick Room is active on odd battle turns: `getMonotypeChampType() == TYPE_NORMAL && gBattleResults.battleTurnCounter % 2 == 1`. Unmodelled (web/src/engine/sim/turnOrder.ts:186-191 documents the concept; no NORMAL-odd branch exists). | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8674` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:8710` | [NORMAL] Wonder Room is active on even battle turns: `getMonotypeChampType() == TYPE_NORMAL && gBattleResults.battleTurnCounter % 2 == 0`. Conditional port at web/src/engine/sim/bridge.ts:627; only the driver feed is missing. | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8710` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:8907` | [GHOST] `IsBattlerCursed` is true for the player's side: `getMonotypeChampType() == TYPE_GHOST && GetBattlerSide(battler) == B_SIDE_PLAYER`. Unmodelled (web/src/engine/sim/endTurn.ts:602 notes no port). | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8907` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `monochamp:battle_util.c:9132` | [DRAGON] a one-time Fearmonger entry on the player's side: `getMonotypeChampType() == TYPE_DRAGON && GetBattlerSide(battler) == B_SIDE_PLAYER && !gVolatileStructs[battler].usedMonotypeEntry`. Unmodelled (`usedMonotypeEntry` state exists in web/src/engine/sim/state.ts:217 but no logic reads it). | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9132` | unported | `web/src/engine/sim/absorb.test.ts` | none |
| `setfieldeffectargument` | 4 map(s), 7 line(s): BirthIsland_Exterior, LilycoveCity, Route120, Route128 | `pipeline/.upstream/eliteredux-source/include/field_effect.h:8` | allowlisted | none | none |
| `setweather` | overworld weather seeds battle weather | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4349` | unported | none | none |
| `setweather:WEATHER_DOWNPOUR` | SootopolisCity:139 (setweather WEATHER_DOWNPOUR) | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4349` | unported | none | none |
| `setweather:WEATHER_FOG_HORIZONTAL` | MtPyre_Exterior:17, MtPyre_Exterior:21 (setweather WEATHER_FOG_HORIZONTAL) | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4349` | unported | none | none |
| `setweather:WEATHER_RAIN` | Route120:100 (setweather WEATHER_RAIN) | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4349` | unported | none | none |
| `setweather:WEATHER_SANDSTORM` | Route111:92, Route111:279 (setweather WEATHER_SANDSTORM) | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4349` | unported | none | none |
| `setwildbattlewithcustommoves` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/scrcmd.c:2620` | unported | none | none |
| `starttagbattle` | 6 map(s), 26 line(s): DewfordTown_Gym, FortreeCity_Gym, LavaridgeTown_Gym_1F, MauvilleCity_Gym, MossdeepCity_Gym, SootopolisCity_Gym_1F | `pipeline/.upstream/eliteredux-source/src/battle_setup.c:1470` | unported | none | none |

## Battle-Type Units

| Unit key | Fights / maps | C citation | Status | Test file | Production evidence |
| --- | --- | --- | --- | --- | --- |
| `BATTLE_TYPE_DOUBLE` | not started by the driver: session.ts:245 sets BATTLE_TYPE_TRAINER only | `pipeline/.upstream/eliteredux-source/src/battle_setup.c:1240` | unported | `web/src/engine/sim/ai/aiFlags.test.ts` | none |
| `BATTLE_TYPE_INGAME_PARTNER` | Battle Tower multi with an in-game partner | `pipeline/.upstream/eliteredux-source/src/battle_tower.c:1526` | unported (registered, untested) | none | none |
| `BATTLE_TYPE_TRAINER` | all 932 trainer battles | `pipeline/.upstream/eliteredux-source/src/battle_setup.c:1242` | ported | `web/src/engine/sim/cycle153cEnvironmentUnits.test.ts` | `web/src/engine/sim/driver/session.ts:245` |
| `BATTLE_TYPE_TWO_OPPONENTS` | two approaching trainers | `pipeline/.upstream/eliteredux-source/src/battle_setup.c:1240` | unported (registered, untested) | none | none |
| `FLAG_TAG_BATTLE` | 26 tagBattles rows across 6 maps in encounters.json (starttagbattle) | `pipeline/.upstream/eliteredux-source/src/battle_setup.c:1470` | unported | none | none |
| `multi_2_vs_2:MeteorFalls_1F_1R` | MeteorFalls_1F_1R: 6 multi_2_vs_2 calls (:193, :202, :211, :220, :229, :238), opponents Courtney + Grunt, partner May (MAY_TREECKO/TORCHIC/MUDKIP_METEOR_FALLS) or Brendan (BRENDAN_*_METEOR_FALLS); second opponent party at src/battle_main.c:614,622; macro not in tree, flags inferred from the C | `pipeline/.upstream/eliteredux-source/src/battle_tower.c:1647` | unported | none | none |
| `multi_2_vs_2:MossdeepCity_SpaceCenter_2F` | MossdeepCity_SpaceCenter_2F:274: 1 multi_2_vs_2 call, opponents Maxie + Courtney, partner TRAINER_STEVEN_MOSSDEEP; second opponent party at src/battle_main.c:614,622; macro not in tree, flags inferred from the C | `pipeline/.upstream/eliteredux-source/src/battle_tower.c:1647` | unported | none | none |
| `tagBattle:aiFlags` | tag battles (two opponents): the trainer aiFlags are replaced by AI_FLAG_CHECK_BAD_MOVE | AI_FLAG_TRY_TO_FAINT | AI_FLAG_CHECK_VIABILITY | AI_FLAG_CHECK_FOE (src/battle_ai_main.c:144-145); tag-to-flag inferred from src/battle_main.c:1778 + encounters.json | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:145` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` | none |
| `tagBattle:partyCap` | tag battles (two opponents): each opponent party is capped at 3 mons (src/battle_main.c:1778-1782); tag-to-flag inferred from src/battle_main.c:1778 + encounters.json | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1780` | unported | none | none |

## Difficulty-Flag Units

| Unit key | Fights / maps | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `GetHighestLevelInPlayerParty` | enemy level = player level + partyData.lvl + extraLevels | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1819` | unported | none |
| `GetLevelCap` | level-cap EXP stop | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3511` | unported | none |
| `HELL_MODE_0_IVS_FLAG` | FLAG_BADGE05_GET (pokemon_config.h:35): zeroes only the player side mons IVs, after the fifth badge; enemy mons keep MAX_IVS | `pipeline/.upstream/eliteredux-source/src/pokemon.c:989` | unported | none |
| `HELL_MODE_EXTRA_LEVELS_FLAG` | FLAG_BADGE03_GET (pokemon_config.h:34): extra levels switch on after the third badge | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1805` | unported | none |
| `RegisterTrainerBattleEvents` | data/hell_trainer_skills.h (29 rows across 24 trainers) | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1773` | unported | none |
| `doubleBattleMode` | save-block double-battle mode toggle | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1757` | unported | none |
| `enableEvs` | save-block EV toggle | `pipeline/.upstream/eliteredux-source/src/pokemon.c:996` | unported | none |
| `gameDifficulty` | DIFFICULTY_EASY / DIFFICULTY_ACE / DIFFICULTY_ELITE / DIFFICULTY_HELL party selection | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1735` | ported | `web/src/engine/sim/cycle154EnvironmentUnits.test.ts` |
| `hellDamageReduction` | Hell: defender not on the player side takes x0.9 after FLAG_BADGE02_GET, then x0.75 for both sides | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7516` | unported | none |
| `hellEvasionClause` | Hell trainer battles: player-side EFFECT_EVASION_UP and EFFECT_MINIMIZE are disabled | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4931` | unported | none |
| `hellNoEnemyFullParalysis` | Hell: enemy-side attackers never lose the 25% full-paralysis roll | `pipeline/.upstream/eliteredux-source/src/battle_util.c:3402` | unported | none |
| `hellPlayerFlinchFails` | Hell: a flinch secondary with baseChance < 100 always fails on the player side | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3076` | unported | none |
| `hellSleepMovePP` | Hell: player EFFECT_SLEEP_HIT / EFFECT_SLEEP / EFFECT_SNORE / EFFECT_REST / EFFECT_SLEEP_TALK have 2 PP; other player moves get base PP with no PP Up bonus | `pipeline/.upstream/eliteredux-source/src/pokemon.c:2239` | unported | none |
| `hellTypeEffectiveness` | Hell: 2.0x becomes 1.5x and 4.0x becomes 2.5x; GetSuperEffectiveMult returns 1.5x | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7934` | unported | none |
| `sleepClause` | every difficulty except EASY: EFFECT_SLEEP / EFFECT_YAWN disabled when IsSleepDisabled(target) or, in doubles, the partner chose a sleep move | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4977` | unported | none |
| `speedDown` | iron-pill zero Speed IV | `pipeline/.upstream/eliteredux-source/src/pokemon.c:994` | unported (registered, untested) | none |

## Trainer-Flag Units

| Unit key | Fights / maps | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `AI_FLAG_CHECK_BAD_MOVE` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:187` | ported | `web/src/engine/sim/cycle153gTrainerFlags.test.ts` |
| `AI_FLAG_CHECK_FOE` | all 932 trainers (sim hard-codes the flag-on moveset branch) | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:190` | unported | `web/src/engine/sim/cycle153gTrainerFlags.test.ts` |
| `AI_FLAG_CHECK_VIABILITY` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:189` | ported | `web/src/engine/sim/cycle153gTrainerFlags.test.ts` |
| `AI_FLAG_HP_AWARE` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:192` | ported | `web/src/engine/sim/cycle153gTrainerFlags.test.ts` |
| `AI_FLAG_SMART_SWITCHING` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:191` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `AI_FLAG_TRY_TO_FAINT` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:188` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `AI_FLAG_WILL_SUICIDE` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:193` | ported | `web/src/engine/sim/ai/aiCheckBadMove.test.ts` |
| `encounterMusic_gender` | trainer-mon gender bias | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1794` | unported | none |
| `forcedDouble` | 78 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:207` | unported | `web/src/engine/sim/ai/aiFlags.test.ts` |
| `noSwitching` | 5 trainers | `pipeline/.upstream/eliteredux-source/src/battle_ai_switch_items.c:611` | allowlisted | `web/src/engine/sim/ai/aiFlags.test.ts` |
| `preferStall` | 1 trainer | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:182` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `preferStatus` | 6 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:183` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `risky` | 4 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:181` | ported | `web/src/engine/sim/cycle153gTrainerFlags.test.ts` |
| `trainerClass` | 72 trainer classes | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:5794` | allowlisted | none |

## Hell-Trainer-Skill Units

| Unit key | Fights / maps | C citation | Status | Test file | Production evidence |
| --- | --- | --- | --- | --- | --- |
| `TRAINER_ALLEN#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_SPIKES` | TRAINER_ALLEN (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:27` | unported | `web/src/engine/sim/battleEvents.test.ts` | none |
| `TRAINER_BILLY#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_BILLY (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:30` | unported | none | none |
| `TRAINER_BRENDAN_ROUTE_103_MUDKIP#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EVIOLITE` | TRAINER_BRENDAN_ROUTE_103_MUDKIP (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:4` | unported | none | none |
| `TRAINER_BRENDAN_ROUTE_103_TORCHIC#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EVIOLITE` | TRAINER_BRENDAN_ROUTE_103_TORCHIC (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:7` | unported | none | none |
| `TRAINER_BRENDAN_ROUTE_103_TREECKO#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EVIOLITE` | TRAINER_BRENDAN_ROUTE_103_TREECKO (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:10` | unported | none | none |
| `TRAINER_CALVIN_1#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_NO_PROTECT` | TRAINER_CALVIN_1 (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:22` | unported | `web/src/engine/sim/battleEvents.test.ts` | none |
| `TRAINER_CALVIN_1#HELL_MODE_TRAINER_SKILL_2:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_CALVIN_1 (HELL_MODE_TRAINER_SKILL_2) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:23` | unported | none | none |
| `TRAINER_CALVIN_1#HELL_MODE_TRAINER_SKILL_3:BATTLE_EVENT_LAST_STAND_STAGES` | TRAINER_CALVIN_1 (HELL_MODE_TRAINER_SKILL_3) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:24` | unported | `web/src/engine/sim/battleEvents.test.ts` | none |
| `TRAINER_CINDY_1#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_CINDY_1 (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:36` | unported | none | none |
| `TRAINER_DARIAN#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_DARIAN (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:33` | unported | none | none |
| `TRAINER_GINA_AND_MIA_1#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_GINA_AND_MIA_1 (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:70` | unported | none | none |
| `TRAINER_GRUNT_PETALBURG_WOODS#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_GRUNT_PETALBURG_WOODS (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:57` | unported | none | none |
| `TRAINER_HALEY_1#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_HALEY_1 (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:51` | unported | none | none |
| `TRAINER_IVAN#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_IVAN (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:54` | unported | none | none |
| `TRAINER_JAMES_1#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_TOXIC_SPIKES` | TRAINER_JAMES_1 (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:48` | unported | `web/src/engine/sim/battleEvents.test.ts` | none |
| `TRAINER_JOSH#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_POSTURE_DEFENSE` | TRAINER_JOSH (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:63` | unported | `web/src/engine/sim/battleEvents.test.ts` | none |
| `TRAINER_LYLE#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_LYLE (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:42` | unported | none | none |
| `TRAINER_MARC#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_LAST_STAND_STAGES` | TRAINER_MARC (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:73` | unported | `web/src/engine/sim/battleEvents.test.ts` | none |
| `TRAINER_MAY_ROUTE_103_MUDKIP#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EVIOLITE` | TRAINER_MAY_ROUTE_103_MUDKIP (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:13` | unported | none | none |
| `TRAINER_MAY_ROUTE_103_TORCHIC#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EVIOLITE` | TRAINER_MAY_ROUTE_103_TORCHIC (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:16` | unported | none | none |
| `TRAINER_MAY_ROUTE_103_TREECKO#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EVIOLITE` | TRAINER_MAY_ROUTE_103_TREECKO (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:19` | unported | none | none |
| `TRAINER_RICK#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_PERMA_STICKY_WEB` | TRAINER_RICK (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:39` | unported | `web/src/engine/sim/battleEvents.test.ts` | none |
| `TRAINER_ROXANNE_1#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_ROXANNE_1 (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:76` | unported | none | none |
| `TRAINER_ROXANNE_1#HELL_MODE_TRAINER_SKILL_2:BATTLE_EVENT_EXTRA_ABILITIES_2` | TRAINER_ROXANNE_1 (HELL_MODE_TRAINER_SKILL_2) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:77` | unported | none | none |
| `TRAINER_ROXANNE_1#HELL_MODE_TRAINER_SKILL_3:BATTLE_EVENT_EXTRA_ABILITIES_3` | TRAINER_ROXANNE_1 (HELL_MODE_TRAINER_SKILL_3) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:78` | unported | none | none |
| `TRAINER_TIANA#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_ONSTAY_LEECH_SEED` | TRAINER_TIANA (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:60` | unported | `web/src/engine/sim/battleEvents.test.ts` | none |
| `TRAINER_TOMMY#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_STEALTH_ROCK` | TRAINER_TOMMY (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:66` | unported | `web/src/engine/sim/battleEvents.test.ts` | none |
| `TRAINER_TOMMY#HELL_MODE_TRAINER_SKILL_2:BATTLE_EVENT_LAST_BLEED` | TRAINER_TOMMY (HELL_MODE_TRAINER_SKILL_2) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:67` | unported | `web/src/engine/sim/battleEvents.test.ts` | none |
| `TRAINER_WINSTON_1#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_EXTRA_ABILITIES_1` | TRAINER_WINSTON_1 (HELL_MODE_TRAINER_SKILL_1) | `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:45` | unported | none | none |

## Battle-Event Units

| Unit key | Fights / maps | C citation | Status | Test file | Production evidence |
| --- | --- | --- | --- | --- | --- |
| `BATTLE_EVENT_EMBARGO` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:295` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:379` |
| `BATTLE_EVENT_LAST_BLEED` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:270` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:346` |
| `BATTLE_EVENT_LAST_BURNED` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:258` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:331` |
| `BATTLE_EVENT_LAST_FROSTBITE` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:266` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:341` |
| `BATTLE_EVENT_LAST_PARALYZED` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:254` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:326` |
| `BATTLE_EVENT_LAST_SLEEP` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:262` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:336` |
| `BATTLE_EVENT_LAST_STAND` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:433` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:538` |
| `BATTLE_EVENT_LAST_TOXIC` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:278` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:356` |
| `BATTLE_EVENT_LIGHTSCREEN` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:309` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:399` |
| `BATTLE_EVENT_LUCKY_CHANT` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:314` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:405` |
| `BATTLE_EVENT_NO_PROTECT` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:330` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:421` |
| `BATTLE_EVENT_ONDS_COPY_STATS` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:480` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:600` |
| `BATTLE_EVENT_ONSTAY_FORESIGHT` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:415` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:495` |
| `BATTLE_EVENT_ONSTAY_LEECH_SEED` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:420` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:509` |
| `BATTLE_EVENT_ONSTAY_MAGNET_RISE` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:427` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:524` |
| `BATTLE_EVENT_ONSWITCH_MAT_BLOCK` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:402` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:481` |
| `BATTLE_EVENT_PERMA_HEAL_BLOCK` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:461` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:571` |
| `BATTLE_EVENT_PERMA_STICKY_WEB` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:325` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:416` |
| `BATTLE_EVENT_PERMA_WIDE_GUARD` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:320` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:411` |
| `BATTLE_EVENT_POSTURE_DEFENSE` | 4 encounter row(s), 4 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:209` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:293` |
| `BATTLE_EVENT_POSTURE_OFFENSE` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:201` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:287` |
| `BATTLE_EVENT_POSTURE_SPDEF` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:225` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:305` |
| `BATTLE_EVENT_POSTURE_SPECIAL` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:217` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:299` |
| `BATTLE_EVENT_POSTURE_SPEED` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:233` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:311` |
| `BATTLE_EVENT_REFLECT` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:304` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:393` |
| `BATTLE_EVENT_SPIKES` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:291` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:373` |
| `BATTLE_EVENT_STEADY_ACCURACY` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:395` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:473` |
| `BATTLE_EVENT_STEADY_DEFENSE` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:383` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:457` |
| `BATTLE_EVENT_STEADY_SPECIAL` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:386` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:461` |
| `BATTLE_EVENT_STEADY_SPEED` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:392` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:469` |
| `BATTLE_EVENT_STEALTH_ROCK` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:283` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:361` |
| `BATTLE_EVENT_STICKY_WEB` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:362` | allowlisted | `web/src/engine/sim/battleEvents.test.ts` | none |
| `BATTLE_EVENT_SUBSTITUTE` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:455` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:565` |
| `BATTLE_EVENT_TENSE_BATTLE` | 8 encounter row(s), 8 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:357` | ported | `web/src/engine/sim/battleEvents.test.ts` | `web/src/engine/sim/battleEvents.ts:426` |

## Script-Event Units

| Unit key | Fights / maps | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `BattleScript_HaxorusTotemBoostActivated` | MeteorFalls_HaxorusRoom | `pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:11723` | unported | none |
| `BattleScript_LegendaryPokemonBallBlock` | 6 totem wild battles | `pipeline/.upstream/eliteredux-source/data/battle_scripts_2.s:270` | unported | none |
| `BattleScript_SetGravityFromScript` | EverGrandeCity_ChampionsRoom Steven doubles (VAR_BATTLE_FIELD_ID = STATUS_FIELD_GRAVITY) | `pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:9827` | unported | none |
| `BattleScript_SetMonotypeEffect_Normal` | EvergrandeCity_MonoChampRoom_1 (18 type variants) | `pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:9682` | unported | `web/src/engine/sim/cycle154bEnvironmentUnits.test.ts` |
| `BattleScript_SetTrickRoomFromScript` | MossdeepCity_Gym course (VAR_BATTLE_FIELD_ID = STATUS_FIELD_TRICK_ROOM) | `pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:9670` | unported | none |
| `BattleScript_WildTotemBoostActivated` | 5 totem maps (all but Haxorus) | `pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:11710` | unported | none |

## Unresolved Terms

- **`starttagbattle`**: the asm macro expansion is not in the fetched tree. Only the `FLAG_TAG_BATTLE` readers
  (`src/battle_setup.c:1470`, `:1480`) and the `BATTLE_TYPE_*` assignments in `src/battle_setup.c:1240-1242` were read;
  the exact flag set by the command is inferred, not read.
- **`setfieldeffectargument`**: the macro body is not fetched. `gFieldEffectArguments` is declared at
  `include/field_effect.h:8`; every reader found is field-effect, party-menu or overworld code, so the unit is
  allowlisted as inert for battle.
- **Hell-mode trainer skills**: `data/hell_trainer_skills.h` (`src/battle_events.c:502`) defines 29 skill rows across 24 trainers.
  `RegisterTrainerBattleEvents` (`src/battle_events.c:504-525`) registers these for Hell tier (`src/battle_main.c:1773`).
  Events not in `encounters.json` `battleEvents`: `BATTLE_EVENT_EVIOLITE`, `BATTLE_EVENT_EXTRA_ABILITIES_1`,
  `BATTLE_EVENT_EXTRA_ABILITIES_2`, `BATTLE_EVENT_EXTRA_ABILITIES_3`, `BATTLE_EVENT_LAST_STAND_STAGES`, `BATTLE_EVENT_TOXIC_SPIKES`.
  In `battleEvents.ts`, cases exist for `TOXIC_SPIKES` (:367) and `LAST_STAND_STAGES` (:548) (case exists, never registered for hell);
  `EVIOLITE` and `EXTRA_ABILITIES_1/2/3` have no case (C: `src/battle_util.c:7441-7445` and `src/pokemon.c:6369-6390, 6406-6432`).
  Other table events (`NO_PROTECT`, `SPIKES`, `PERMA_STICKY_WEB`, `ONSTAY_LEECH_SEED`, `POSTURE_DEFENSE`, `STEALTH_ROCK`, `LAST_BLEED`)
  have cases in `battleEvents.ts`, but are never registered for hell because `session.ts` does not read `sTrainerSkillList`.
- **`setwildbattlewithcustommoves`**: implementation read at `src/scrcmd.c:2620` (species, level, item, four moves,
  ability, nature, six EV arguments). The sim takes the resulting party from its caller; the command itself is
  not simulated.
- **`setweather` and map weather**: `ScrCmd_setweather` (`src/scrcmd.c:720-726`) only calls `SetSav1Weather`. Overworld weather
  enters battles via `TryDoEventsBeforeFirstTurn` calling `AbilityBattleEffects(ABILITYEFFECT_SWITCH_IN_WEATHER)` once
  (`src/battle_main.c:3333-3336`, `src/battle_util.c:4349-4389`). RAIN, RAIN_THUNDERSTORM and DOWNPOUR set permanent+temporary
  rain, SANDSTORM sets sandstorm, DROUGHT sets sun, and FOG_HORIZONTAL sets `WEATHER_FOG_PERMANENT` (FOG_DIAGONAL is commented out
  at `:4375` and does not trigger). `WEATHER_RAIN_THUNDERSTORM` additionally sets permanent Electric Terrain (`src/battle_util.c:4316-4322`).
  Because the sim does not seed battle weather from map data, `setweather` and map-weather units are reported unported rather than allowlisted.
- **Multi battles**: `BATTLE_TYPE_MULTI` is not Battle-Tower-only. 7 `multi_2_vs_2` calls in
  `data/maps/MeteorFalls_1F_1R/scripts.pory` (:193, :202, :211, :220, :229, :238) and `data/maps/MossdeepCity_SpaceCenter_2F/scripts.pory` (:274)
  are story fights with an in-game partner. The macro body is not fetched (the upstream `asm/` tree is not in `sparse_paths`),
  so the flags are inferred from the C that starts the same shape: `src/battle_tower.c:1647` assigns
  `BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS | BATTLE_TYPE_MULTI | BATTLE_TYPE_INGAME_PARTNER`;
  `src/battle_main.c:537-540`/`:602-606` read MULTI/INGAME_PARTNER and `:614`/`:622` create the second opponent party.
  The driver never sets those bits, so the 2 `multi_2_vs_2:*` units are unported.
- **Tag battles**: `encounters.json` `tagBattles` has 26 two-opponent rows across 6 maps.
  The C replaces the trainer AI flags under `BATTLE_TYPE_TWO_OPPONENTS` (`src/battle_ai_main.c:144-145`) and caps each
  opponent party at three mons (`src/battle_main.c:1778-1782`); the lose-text branch is the `FLAG_TAG_BATTLE` unit
  (`src/battle_setup.c:1470`). The `starttagbattle` macro expansion is not in the tree, so the tag-to-`BATTLE_TYPE_TWO_OPPONENTS`
  link is inferred from `src/battle_main.c:1778` and `encounters.json`, not read from a macro.

