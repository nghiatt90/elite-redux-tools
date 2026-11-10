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
  `buildParty.ts`). `BATTLE_TYPE_TRAINER` qualifies (`session.ts:238`); `BATTLE_TYPE_DOUBLE` does not, so the driver
  never runs a double battle regardless of a constant or a hand-built test state.
- `forcedDouble` additionally requires a production line outside `aiFlags.ts` that changes the number of active
  battlers. The engine only ORs `AI_FLAG_DOUBLE_BATTLE`; the codegen's `doubleBattle = TRUE`
  (`TrainerPartyGenerator.kt:207`) is unmodelled, so the fight stays singles.

Allowlisted units require an exact pinned C `file:line` whose line is quoted in the reason. The allowlist is not
empty: eight units are provably battle-inert (cosmetics, overworld weather, field-effect arguments, prizes).

1. **map-setup**: a flag/var/special/script command set by a map script before a battle.
   The scan covers all 515 `data/maps/*/scripts.pory` files; 22 contain at least one of
   `setweather` (substring), `setfieldeffectargument`, `FLAG_TOTEM_BATTLE`, `FLAG_SYS_INVERSE_BATTLE`,
   `VAR_BATTLE_FIELD_EFFECT_TYPE` or `VAR_MONOTYPE_BOOST`.
2. **battle-type**: a `BATTLE_TYPE_*` flag or `FLAG_TAG_BATTLE` set by a battle-start path.
3. **difficulty-flag**: a save-block difficulty/settings flag, or a C rule deriving level, IVs, EVs or party selection.
4. **trainer-flag**: a `trainers.json` field, or an `AI_FLAG_*` bit the codegen mints from one.
5. **battle-event**: one distinct `event` in `data/v2.65beta/encounters.json` `battleEvents`, with the C handler line.
6. **script-event**: a battle script label pushed by one of the scripted setups above.

`registerbattleevent` calls in map scripts are extracted into `encounters.json`, so they are represented by the
battle-event units rather than a separate script-command unit. The sim loads that table at `loadSimData.ts:108-109`.

## Summary

| Unit kind | Defined | Ported | Registered, untested | Unported | Unclassified | Allowlisted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `map-setup` | 22 | 0 | 0 | 16 | 0 | 6 |
| `battle-type` | 5 | 1 | 2 | 4 | 0 | 0 |
| `difficulty-flag` | 9 | 0 | 1 | 9 | 0 | 0 |
| `trainer-flag` | 14 | 7 | 3 | 5 | 0 | 2 |
| `battle-event` | 34 | 33 | 0 | 1 | 0 | 0 |
| `script-event` | 6 | 0 | 0 | 6 | 0 | 0 |
| **total** | **90** | **41** | **6** | **41** | **0** | **8** |

Trainers in `data/v2.65beta/trainers.json`: 932. `battleEvents` rows: 51 across 34 distinct events. Map scripts scanned: 515; maps with a setup token: 22.

## Unported Units by Kind

| Unit kind | Unported | Registered, untested |
| --- | ---: | ---: |
| `map-setup` | 16 | 0 |
| `battle-type` | 4 | 2 |
| `difficulty-flag` | 9 | 1 |
| `trainer-flag` | 5 | 3 |
| `battle-event` | 1 | 0 |
| `script-event` | 6 | 0 |

## Map-Setup Units

| Unit key | Fights / maps | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `FLAG_ALPHA_CREATION` | 6 map(s), 18 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/pokemon.c:504` | allowlisted | none |
| `FLAG_SHINY_CREATION` | 4 map(s), 4 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route132 | `pipeline/.upstream/eliteredux-source/src/pokemon.c:499` | allowlisted | none |
| `FLAG_SYS_DISABLE_AUTOHEAL` | 5 map(s), 17 line(s): MossdeepCity_SpaceCenter_2F, Route111, SkyPillar_Outside, SlateportCity_OceanicMuseum_2F, SootopolisCity_Gym_1F | `pipeline/.upstream/eliteredux-source/src/battle_main.c:844` | unported | none |
| `FLAG_SYS_INVERSE_BATTLE` | 1 map(s), 8 line(s): MossdeepCity_Gym | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8028` | unported | none |
| `FLAG_TOTEM_BATTLE` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9144` | unported | none |
| `HealPlayerParty` | 31 map(s), 52 line(s): BattleFrontier_BattleArenaBattleRoom, BattleFrontier_BattleArenaLobby, BattleFrontier_BattleDomeBattleRoom, BattleFrontier_BattleDomeLobby, BattleFrontier_BattleDomePreBattleRoom, BattleFrontier_BattleFactoryBattleRoom, BattleFrontier_BattleFactoryPreBattleRoom, BattleFrontier_BattlePalaceBattleRoom, BattleFrontier_BattlePalaceLobby, BattleFrontier_BattlePikeLobby, BattleFrontier_BattlePikeRoomNormal, BattleFrontier_BattlePyramidFloor, BattleFrontier_BattlePyramidLobby, BattleFrontier_BattleTowerBattleRoom, BattleFrontier_BattleTowerLobby, BattleFrontier_BattleTowerMultiBattleRoom, BattleFrontier_BattleTowerMultiPartnerRoom, FallarborTown_BattleTentBattleRoom, MeteorFalls_1F_1R, MossdeepCity_House1, MossdeepCity_SpaceCenter_2F, Route101, Route111, SkyPillar_Outside, SlateportCity_BattleTentBattleRoom, SlateportCity_BattleTentCorridor, SlateportCity_OceanicMuseum_2F, SootopolisCity_Gym_1F, SootopolisCity_MysteryEventsHouse_B1F, TrainerHill_Entrance, VerdanturfTown_BattleTentBattleRoom | `pipeline/.upstream/eliteredux-source/src/battle_main.c:844` | unported | none |
| `VAR_BATTLE_FIELD_EFFECT_TYPE` | 3 map(s), 43 line(s): EverGrandeCity_ChampionsRoom, EvergrandeCity_MonoChampRoom_1, MossdeepCity_Gym | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4163` | unported | none |
| `VAR_BATTLE_FIELD_ID` | 3 map(s), 44 line(s): EverGrandeCity_ChampionsRoom, EvergrandeCity_MonoChampRoom_1, MossdeepCity_Gym | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4164` | unported | none |
| `VAR_MONOTYPE_BOOST` | 1 map(s), 40 line(s): EvergrandeCity_MonoChampRoom_1 | `pipeline/.upstream/eliteredux-source/src/field_specials.c:4943` | allowlisted | none |
| `VAR_TOTEM_MESSAGE` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9160` | unported | none |
| `VAR_TOTEM_POKEMON_ACCURACY_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9156` | unported | none |
| `VAR_TOTEM_POKEMON_ATK_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9151` | unported | none |
| `VAR_TOTEM_POKEMON_DEF_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9152` | unported | none |
| `VAR_TOTEM_POKEMON_EVASION_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9157` | unported | none |
| `VAR_TOTEM_POKEMON_SPEED_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9155` | unported | none |
| `VAR_TOTEM_POKEMON_SP_ATK_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9153` | unported | none |
| `VAR_TOTEM_POKEMON_SP_DEF_BOOST` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/battle_util.c:9154` | unported | none |
| `VAR_TRAINER_PRIZE_BP` | 1 map(s), 18 line(s): EvergrandeCity_MonoChampRoom_1 | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:5809` | allowlisted | none |
| `setfieldeffectargument` | 4 map(s), 7 line(s): BirthIsland_Exterior, LilycoveCity, Route120, Route128 | `pipeline/.upstream/eliteredux-source/include/field_effect.h:8` | allowlisted | none |
| `setweather` | 11 map(s), 22 line(s): AshenWoods, FarawayIsland_Entrance, JaggedPass, MtPyre_Exterior, NavelRock_Top, Route111, Route113, Route120, SeafloorCavern_Room9, SkyPillar_Outside, SootopolisCity | `pipeline/.upstream/eliteredux-source/src/scrcmd.c:724` | allowlisted | none |
| `setwildbattlewithcustommoves` | 6 map(s), 6 line(s): MeteorFalls_HaxorusRoom, PetalburgWoods_BreloomRoom, Route111, Route114, Route132, Seaspray_Cave_B1F | `pipeline/.upstream/eliteredux-source/src/scrcmd.c:2620` | unported | none |
| `starttagbattle` | 6 map(s), 26 line(s): DewfordTown_Gym, FortreeCity_Gym, LavaridgeTown_Gym_1F, MauvilleCity_Gym, MossdeepCity_Gym, SootopolisCity_Gym_1F | `pipeline/.upstream/eliteredux-source/src/battle_setup.c:1470` | unported | none |

## Battle-Type Units

| Unit key | Fights / maps | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `BATTLE_TYPE_DOUBLE` | not started by the driver: session.ts:238 sets BATTLE_TYPE_TRAINER only | `pipeline/.upstream/eliteredux-source/src/battle_setup.c:1240` | unported | `web/src/engine/sim/ai/aiFlags.test.ts` |
| `BATTLE_TYPE_INGAME_PARTNER` | Battle Tower multi with an in-game partner | `pipeline/.upstream/eliteredux-source/src/battle_tower.c:1526` | unported (registered, untested) | none |
| `BATTLE_TYPE_TRAINER` | all 932 trainer battles | `pipeline/.upstream/eliteredux-source/src/battle_setup.c:1242` | ported | `web/src/engine/sim/cycle145Abilities.test.ts` |
| `BATTLE_TYPE_TWO_OPPONENTS` | two approaching trainers | `pipeline/.upstream/eliteredux-source/src/battle_setup.c:1240` | unported (registered, untested) | none |
| `FLAG_TAG_BATTLE` | 26 starttagbattle calls in 6 maps | `pipeline/.upstream/eliteredux-source/src/battle_setup.c:1470` | unported | none |

## Difficulty-Flag Units

| Unit key | Fights / maps | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `GetHighestLevelInPlayerParty` | enemy level = player level + partyData.lvl + extraLevels | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1819` | unported | none |
| `GetLevelCap` | level-cap EXP stop | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3511` | unported | none |
| `HELL_MODE_0_IVS_FLAG` | hell difficulty zero IVs | `pipeline/.upstream/eliteredux-source/src/pokemon.c:989` | unported | none |
| `HELL_MODE_EXTRA_LEVELS_FLAG` | hell difficulty extra levels | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1805` | unported | none |
| `RegisterTrainerBattleEvents` | hell-mode extra trainer skills | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1773` | unported | none |
| `doubleBattleMode` | save-block double-battle mode toggle | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1757` | unported | none |
| `enableEvs` | save-block EV toggle | `pipeline/.upstream/eliteredux-source/src/pokemon.c:996` | unported | none |
| `gameDifficulty` | DIFFICULTY_EASY / DIFFICULTY_ACE / DIFFICULTY_ELITE / DIFFICULTY_HELL party selection | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1735` | unported | none |
| `speedDown` | iron-pill zero Speed IV | `pipeline/.upstream/eliteredux-source/src/pokemon.c:994` | unported (registered, untested) | none |

## Trainer-Flag Units

| Unit key | Fights / maps | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `AI_FLAG_CHECK_BAD_MOVE` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:187` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `AI_FLAG_CHECK_FOE` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:190` | unported (registered, untested) | none |
| `AI_FLAG_CHECK_VIABILITY` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:189` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `AI_FLAG_HP_AWARE` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:192` | unported (registered, untested) | none |
| `AI_FLAG_SMART_SWITCHING` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:191` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `AI_FLAG_TRY_TO_FAINT` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:188` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `AI_FLAG_WILL_SUICIDE` | all 932 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:193` | ported | `web/src/engine/sim/ai/aiCheckBadMove.test.ts` |
| `encounterMusic_gender` | trainer-mon gender bias | `pipeline/.upstream/eliteredux-source/src/battle_main.c:1794` | unported | none |
| `forcedDouble` | 78 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:207` | unported | `web/src/engine/sim/ai/aiFlags.test.ts` |
| `noSwitching` | 5 trainers | `pipeline/.upstream/eliteredux-source/src/battle_ai_switch_items.c:611` | allowlisted | `web/src/engine/sim/ai/aiFlags.test.ts` |
| `preferStall` | 1 trainer | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:182` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `preferStatus` | 6 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:183` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `risky` | 4 trainers | `pipeline/.upstream/eliteredux-source/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt:181` | unported (registered, untested) | none |
| `trainerClass` | 72 trainer classes | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:5794` | allowlisted | none |

## Battle-Event Units

| Unit key | Fights / maps | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `BATTLE_EVENT_EMBARGO` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:295` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_LAST_BLEED` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:270` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_LAST_BURNED` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:258` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_LAST_FROSTBITE` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:266` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_LAST_PARALYZED` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:254` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_LAST_SLEEP` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:262` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_LAST_STAND` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:433` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_LAST_TOXIC` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:278` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_LIGHTSCREEN` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:309` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_LUCKY_CHANT` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:314` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_NO_PROTECT` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:330` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_ONDS_COPY_STATS` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:480` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_ONSTAY_FORESIGHT` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:415` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_ONSTAY_LEECH_SEED` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:420` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_ONSTAY_MAGNET_RISE` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:427` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_ONSWITCH_MAT_BLOCK` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:402` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_PERMA_HEAL_BLOCK` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:461` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_PERMA_STICKY_WEB` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:325` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_PERMA_WIDE_GUARD` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:320` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_POSTURE_DEFENSE` | 4 encounter row(s), 4 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:209` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_POSTURE_OFFENSE` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:201` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_POSTURE_SPDEF` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:225` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_POSTURE_SPECIAL` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:217` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_POSTURE_SPEED` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:233` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_REFLECT` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:304` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_SPIKES` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:291` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_STEADY_ACCURACY` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:395` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_STEADY_DEFENSE` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:383` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_STEADY_SPECIAL` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:386` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_STEADY_SPEED` | 2 encounter row(s), 2 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:392` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_STEALTH_ROCK` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:283` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_STICKY_WEB` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/include/constants/battle_events.h:60` | unported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_SUBSTITUTE` | 1 encounter row(s), 1 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:455` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `BATTLE_EVENT_TENSE_BATTLE` | 8 encounter row(s), 8 map(s) | `pipeline/.upstream/eliteredux-source/src/battle_events.c:357` | ported | `web/src/engine/sim/battleEvents.test.ts` |

## Script-Event Units

| Unit key | Fights / maps | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `BattleScript_HaxorusTotemBoostActivated` | MeteorFalls_HaxorusRoom | `pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:11723` | unported | none |
| `BattleScript_LegendaryPokemonBallBlock` | 6 totem wild battles | `pipeline/.upstream/eliteredux-source/data/battle_scripts_2.s:270` | unported | none |
| `BattleScript_SetGravityFromScript` | EverGrandeCity_ChampionsRoom Steven doubles (VAR_BATTLE_FIELD_ID = STATUS_FIELD_GRAVITY) | `pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:9827` | unported | none |
| `BattleScript_SetMonotypeEffect_Normal` | EvergrandeCity_MonoChampRoom_1 (18 type variants) | `pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:9682` | unported | none |
| `BattleScript_SetTrickRoomFromScript` | MossdeepCity_Gym course (VAR_BATTLE_FIELD_ID = STATUS_FIELD_TRICK_ROOM) | `pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:9670` | unported | none |
| `BattleScript_WildTotemBoostActivated` | 5 totem maps (all but Haxorus) | `pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:11710` | unported | none |

## Unresolved Terms

- **`starttagbattle`**: the asm macro expansion is not in the fetched tree. Only the `FLAG_TAG_BATTLE` readers
  (`src/battle_setup.c:1470`, `:1480`) and the `BATTLE_TYPE_*` assignments in `src/battle_setup.c:1240-1242` were read;
  the exact flag set by the command is inferred, not read.
- **`setfieldeffectargument`**: the macro body is not fetched. `gFieldEffectArguments` is declared at
  `include/field_effect.h:8`; every reader found is field-effect, party-menu or overworld code, so the unit is
  allowlisted as inert for battle.
- **Hell-mode trainer skills**: `src/battle_events.c:502` includes `data/hell_trainer_skills.h`, which is absent from
  the pinned tree. The events registered by `RegisterTrainerBattleEvents` therefore cannot be enumerated; the unit is
  reported unported rather than guessed.
- **`setwildbattlewithcustommoves`**: implementation read at `src/scrcmd.c:2620` (species, level, item, four moves,
  ability, nature, six EV arguments). The sim takes the resulting party from its caller; the command itself is
  not simulated.
- **`setweather`**: `ScrCmd_setweather` (`src/scrcmd.c:720-726`) only calls `SetSav1Weather`; `gBattleWeather` is
  zeroed at `src/battle_main.c:2721`, so overworld weather cannot enter a battle.
- **Link/multi battles**: `BATTLE_TYPE_MULTI` is only set by `src/battle_tower.c:1526` (Battle Tower), which no scanned
  story map starts, so it is not defined as a unit here.

