# Story route: the order of the boss fights (steps 1-40)

_Status: 2026-11-17, steps 1-28 from Yoshi (he plays the game); revised the same day after his correction (the Weather Institute has no forced fight
except Shelly; the no-heal gauntlet he remembered is the Space Center 2F one; steps 19-28 replace the earlier steps 19-20). Third revision the same day:
steps 29-40 from Yoshi, so no row is awaiting the route any more; Wally at Victory Road (step 35) is EXCLUDED as buggy in the pinned version.
Fourth revision the same day (Yoshi, v1 scope): seven easy route steps are DEFERRED, kept in the table but not run in v1 (steps 1, 15, 26 and 30-33;
see "Deferred fights (add back later)"); v1 runs 32 of the 40 steps.
Consumed by `innate-gating-plan.md` (D5, badge value and level cap per fight), `chains-plan.md` (D3) and `solver-v2-plan.md` (D4, StageKey per fight).
Planning only: no code is changed by this document._

Pin: v2.65beta, `eliteredux-source` `bdebcbbff9760cdd41a02c425bea4857fa0eee26` (`sources.lock.json`). `maps/` below means
`pipeline/.upstream/eliteredux-source/data/maps/`; `src/` means `pipeline/.upstream/eliteredux-source/src/`.

## Authority and labels

Yoshi's route is used as truth. Every claim the pinned scripts do not show is labelled **player-observed (Yoshi), not in the scripts at pin bdebcbbf**;
it is never presented as a cited game fact. Claims the scripts do show carry a path:line citation and the label **script**. In the table the
`position` label says where the step's PLACE in the route comes from; the battle itself (trainer id, script line) is always script-cited.

Fixed rules this table relies on:
- Gym N needs gyms 1..N-1 and no gym is skippable: player-observed (Yoshi), not in the scripts at pin bdebcbbf, except two script facts. (1) Norman's
  gate is indirect: his intro is a `switch` on `VAR_PETALBURG_GYM_STATE`; the `case 3`, `case 4` and `case 5` branches check `FLAG_BADGE01_GET`..`FLAG_BADGE04_GET`
  (`maps/PetalburgCity_Gym/scripts.pory:1719`, `:1731`, `:1743`; `case 2`, `:1707`, does the same) and only then set the state to 6; the asm helper
  `Common_EventScript_ReadyPetalburgGymForBattle` (`data/event_scripts.s:686-704`) also sets state 6 only after badges 1-4 are set. The battle
  (`goto(PetalburgCity_Gym_EventScript_NormanBattle)`) and the bracelet hand-over are in the `case 6` branch (`:1754-1763`), so the state machine reaches the
  battle only after the badge 1-4 check. The `case 7`/`case 8`/`default` branch (`:1774-1781`) sets state 6 without a badge check, but is reached only once the
  state is above 6, and the state goes to 7 or 8 only after Norman (`:409` sets 7 immediately before his badge flag at `:410`; `PetalburgCity/scripts.pory:36`
  and `PetalburgCity_Gym/scripts.pory:68` are the other 7/8 setters). (2) The league door checks
  `FLAG_BADGE06_GET` (`maps/EverGrandeCity_PokemonLeague_1F/scripts.pory:56`). The comment at `:40-41` of that file ("Winonas badge is the only
  one that can be skipped") and the one at `src/pokemon.c:4633` are stale and are evidence of nothing.
- Badge flags are set after each leader battle: `maps/RustboroCity_Gym/scripts.pory:15`, `maps/DewfordTown_Gym/scripts.pory:161`,
  `maps/MauvilleCity_Gym/scripts.pory:69`, `maps/LavaridgeTown_Gym_1F/scripts.pory:73`, `maps/PetalburgCity_Gym/scripts.pory:410`,
  `maps/FortreeCity_Gym/scripts.pory:30`, `maps/MossdeepCity_Gym/scripts.pory:71`. Under the fixed route the highest flag held equals the number
  held, which is what `getHighestBadge` (`src/pokemon.c:4635-4647`) returns. Each fight's `requiredBefore` is exactly the gyms already beaten at its step.
- Default heal rule: the game heals the party at the START of every battle unless `FLAG_SYS_DISABLE_AUTOHEAL` is set
  (`src/battle_main.c:844`, again `src/pokemon.c:2120`). At the pin only five map scripts contain a `setflag` of `FLAG_SYS_DISABLE_AUTOHEAL`:
  `MossdeepCity_SpaceCenter_2F`, `SootopolisCity_Gym_1F`, `SkyPillar_Outside`, `SlateportCity_OceanicMuseum_2F`, `Route111` (grep of `data/` and `src/`
  for `FLAG_SYS_DISABLE_AUTOHEAL`, not for `setflag(...`: three files use the asm form `setflag FLAG_SYS_DISABLE_AUTOHEAL`, `MossdeepCity_SpaceCenter_2F:69`,
  `SlateportCity_OceanicMuseum_2F:13`, `Route111:296`, and two the call form, `SkyPillar_Outside:192`, `SootopolisCity_Gym_1F`; the only other files that mention
  the flag are `src/battle_main.c`, `src/overworld.c:1575` (a `FlagClear`) and `src/pokemon.c`, which read or clear it). "healed (script)" below means this default.
- Mega Bracelet: given by Norman's case-6 intro before his battle (`maps/PetalburgCity_Gym/scripts.pory:1755-1761`, `giveitem(ITEM_MEGA_BRACELET)`
  at `:1760`, `setflag(FLAG_SYS_RECEIVED_KEYSTONE)` at `:1761`). Mega is allowed in the Gym 5 fight and later, never before: a grep of the pinned
  `data/` and `src/` for `ITEM_MEGA_BRACELET` and `FLAG_SYS_RECEIVED_KEYSTONE` finds the grant only at `PetalburgCity_Gym/scripts.pory:1760-1761`;
  `maps/OldaleTown_Mart/scripts.pory:256` is only a `checkitem`, `src/battle_util.c:8134` and `src/pokemon.c:6019,6025` only read them, and
  `data/scripts/debug.inc:59-60` is the debug menu, not story.

## Route, steps 1-40

| Step | Fight (trainer ids) | Map, script path:line | Badges held (count, highest flag) | Heal rule | Evidence label |
|---|---|---|---|---|---|
| 1 | **DEFERRED (v1 scope)** May 1: `TRAINER_MAY_ROUTE_103_TORCHIC` | `maps/Route103/scripts.pory:108` | 0, none | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 2 | Aqua Grunt, forest: `TRAINER_GRUNT_PETALBURG_WOODS` | `maps/PetalburgWoods/scripts.pory:33` (also `:69`) | 0, none | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 3 | Gym 1 Roxanne: `TRAINER_ROXANNE_1` | `maps/RustboroCity_Gym/scripts.pory:548/551/554` | 0, none | healed (script) | position: gym 1, fixed route (player-observed (Yoshi), not in the scripts at pin bdebcbbf) |
| 4 | Aqua Grunt, cave: `TRAINER_GRUNT_RUSTURF_TUNNEL` | `maps/RusturfTunnel/scripts.pory:322` | 1, `FLAG_BADGE01_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 5 | May 2: `TRAINER_MAY_RUSTBORO_TORCHIC` | `maps/RustboroCity/scripts.pory:900` or `maps/Route104/scripts.pory:183` | 1, `FLAG_BADGE01_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 6 | Steven: `TRAINER_STEVEN_GRANITE_CAVE` | `maps/GraniteCave_StevensRoom/scripts.pory:136` | 1, `FLAG_BADGE01_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 7 | Gym 2 Brawly: `TRAINER_BRAWLY_1` | `maps/DewfordTown_Gym/scripts.pory:719/722/725` | 1, `FLAG_BADGE01_GET` | healed (script) | position: fixed route (player-observed (Yoshi), not in the scripts at pin bdebcbbf) |
| 8 | Museum gauntlet: `TRAINER_GRUNT_MUSEUM_1`, `TRAINER_GRUNT_MUSEUM_2`, `TRAINER_ARCHIE_SLATEPORT` | `maps/SlateportCity_OceanicMuseum_2F/scripts.pory:43, 51, 70` | 2, `FLAG_BADGE02_GET` | healed before the first (`:14` `special HealPlayerParty`), no heal between: `FLAG_SYS_DISABLE_AUTOHEAL` set at `:13` (script; `trainerChains` `healFree: true`) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf; heal: script |
| 9 | May 3: `TRAINER_MAY_ROUTE_110_TORCHIC` | `maps/Route110/scripts.pory:445` | 2, `FLAG_BADGE02_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 10 | Wally: `TRAINER_WALLY_MAUVILLE` | `maps/MauvilleCity/scripts.pory:229` | 2, `FLAG_BADGE02_GET` | healed (script) | position and being mandatory: player-observed (Yoshi), not in the scripts at pin bdebcbbf (the script offers a decline, see Open questions) |
| 11 | Gym 3 Wattson: `TRAINER_WATTSON_1` | `maps/MauvilleCity_Gym/scripts.pory:586/589/592` | 2, `FLAG_BADGE02_GET` | healed (script) | position: fixed route (player-observed (Yoshi), not in the scripts at pin bdebcbbf) |
| 12 | Magma leaders, `multi_2_vs_2` with May: `TRAINER_COURTNEY_METEOR_FALLS` + `TRAINER_GRUNT_METEOR_FALLS` | `maps/MeteorFalls_1F_1R/scripts.pory:193-238` (six `multi_2_vs_2` lines, one per rival/starter; May's are `:193, :202, :211`) | 3, `FLAG_BADGE03_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 13 | Maxie 1: `TRAINER_MAXIE_MT_CHIMNEY` | `maps/MtChimney/scripts.pory:54` | 3, `FLAG_BADGE03_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 14 | Gym 4 Flannery: `TRAINER_FLANNERY_1` | `maps/LavaridgeTown_Gym_1F/scripts.pory:638/641/644` | 3, `FLAG_BADGE03_GET` | healed (script) | position: fixed route (player-observed (Yoshi), not in the scripts at pin bdebcbbf) |
| 15 | **DEFERRED (v1 scope)** Magma Grunt, desert: `TRAINER_GRUNT_SUNHOLLOW_1` | `maps/Route111_SunhollowRuins/scripts.pory:193` | 4, `FLAG_BADGE04_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 16 | Magma leader, pyramid: `TRAINER_COURTNEY_SUNHOLLOW` | `maps/Route111_SunhollowRuins_Museum/scripts.pory:693` | 4, `FLAG_BADGE04_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 17 | Gym 5 Norman: `TRAINER_NORMAN_1` | `maps/PetalburgCity_Gym/scripts.pory:2022/2025/2028` | 4, `FLAG_BADGE04_GET`, plus Mega Bracelet (`:1755-1761`) | healed (script) | position: script (indirect: the badge 1-4 checks at `:1719/:1731/:1743` gate the state change to case 6, where the battle is, `:1754-1763`); Mega from this fight on: script (`:1760`) |
| 18 | Steven 2: `TRAINER_STEVEN_ROUTE118` | `maps/Route118/scripts.pory:484` | 5, `FLAG_BADGE05_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 19 | Shelly, Weather Institute 2F: `TRAINER_SHELLY_WEATHER_INSTITUTE` (a plain single fight; the Weather Institute has no other forced fight) | `maps/Route119_WeatherInstitute_2F/scripts.pory:52` | 5, `FLAG_BADGE05_GET` | healed (script) | position, and "no other forced fight there": player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 20 | May 4: `TRAINER_MAY_ROUTE_119_TORCHIC` | `maps/Route119/scripts.pory:101` | 5, `FLAG_BADGE05_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 21 | Gym 6 Winona: `TRAINER_WINONA_1` | `maps/FortreeCity_Gym/scripts.pory:518/521/524` | 5, `FLAG_BADGE05_GET` | healed (script) | position: fixed route (player-observed (Yoshi), not in the scripts at pin bdebcbbf) |
| 22 | Archie, Mt Pyre summit: `TRAINER_ARCHIE_MT_PYRE` | `maps/MtPyre_Summit/scripts.pory:702` | 6, `FLAG_BADGE06_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 23 | Maxie 2, Magma Hideout: `TRAINER_MAXIE_MAGMA_HIDEOUT` | `maps/MagmaHideout_4F/scripts.pory:57` | 6, `FLAG_BADGE06_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 24 | Admin Matt, Aqua Hideout B2F (submarine escape): `TRAINER_MATT` | `maps/AquaHideout_B2F/scripts.pory:30` | 6, `FLAG_BADGE06_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 25 | Gym 7 Tate & Liza: `TRAINER_TATE_AND_LIZA_1` | `maps/MossdeepCity_Gym/scripts.pory:1009/1012/1015` | 6, `FLAG_BADGE06_GET` | healed (script) | position: fixed route (player-observed (Yoshi), not in the scripts at pin bdebcbbf) |
| 26 | **DEFERRED (v1 scope)** Space Center 1F stair grunt: `TRAINER_GRUNT_SPACE_CENTER_2` | `maps/MossdeepCity_SpaceCenter_1F/scripts.pory:246` (stair blocker by its post-battle `LOCALID_STAIR_GRUNT` movement, `:248-256`) | 7, `FLAG_BADGE07_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 27 | Space Center 2F gauntlet: `TRAINER_GRUNT_SPACE_CENTER_5`, `_6`, `_7` (one script) | `maps/MossdeepCity_SpaceCenter_2F/scripts.pory:72, 78, 84` | 7, `FLAG_BADGE07_GET` | healed before the first (`:70` `special HealPlayerParty`), NO heal between: `FLAG_SYS_DISABLE_AUTOHEAL` set at `:69`, cleared at `:87`; the start-of-battle heal is skipped while it is set (`src/battle_main.c:844`); `encounters.json` `trainerChains` records `healFree: true` (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf; heal: script |
| 28 | Maxie + Courtney, `multi_2_vs_2`, Steven as the player's partner: `TRAINER_MAXIE_MOSSDEEP` + `TRAINER_COURTNEY_MOSSDEEP` (partner `TRAINER_STEVEN_MOSSDEEP`) | `maps/MossdeepCity_SpaceCenter_2F/scripts.pory:274` | 7, `FLAG_BADGE07_GET` | healed (`:264` `special HealPlayerParty`; script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 29 | Archie 3, Seafloor Cavern: `TRAINER_ARCHIE` | `maps/SeafloorCavern_Room9/scripts.pory:72` | 7, `FLAG_BADGE07_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf (Dive, needed to reach it, requires `FLAG_BADGE07_GET`, `src/field_control_avatar.c:517`, the `FlagGet(FLAG_BADGE07_GET)` line of `TrySetupDiveDownScript`: script lower bound only) |
| 30-33 | **DEFERRED (v1 scope), all four rows** Gym 8's own trainers, four groups in any order (Yoshi: order irrelevant): Tiffany `TRAINER_TIFFANY`; bottom `TRAINER_BRIDGET`, `_CRISSY`, `_BETHANY`; middle `TRAINER_DAPHNE`, `_CONNIE`, `_ANDREA`; top `TRAINER_OLIVIA`, `_BRIANNA`, `_ANNIKA` (`boss-fight-coverage.md:165-172`) | `maps/SootopolisCity_Gym_B1F/scripts.pory:252`; `maps/SootopolisCity_Gym_1F/scripts.pory:528-564`, `:603-619`, `:652-668` | 7, `FLAG_BADGE07_GET` | each group: `multichoice2` case 1 is three fights with no heal between (`FLAG_SYS_DISABLE_AUTOHEAL` set/cleared at `:545-549`, `:603-607`, `:652-656`); cases 2-4 healed (this and "in any order" depend on the `starttagbattle` macro marking both partners defeated, unproven at the pin: Open question 4); Tiffany healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf; all ten before Juan: script (`maps/SootopolisCity_Gym_1F/scripts.pory:477-499`) |
| 34 | Gym 8 Juan + Wallace, two consecutive tag doubles: stage 1 `TRAINER_JUAN_1` + `TRAINER_WALLACE`, stage 2 `TRAINER_JUAN_5` + `TRAINER_WALLACE_5` (chain) | `maps/SootopolisCity_Gym_1F/scripts.pory:275-301` (stage 1 `:278`, stage 2 `:286-290`) | 7, `FLAG_BADGE07_GET` | healed before stage 1 (`:275`), no heal before stage 2 (flag set `:276`, cleared `:279`/`:301`) (script) | position: gym 8, fixed route (player-observed (Yoshi), not in the scripts at pin bdebcbbf); after the ten gym trainers: script (`:477-499`) |
| 35 | Wally 2, Victory Road: **EXCLUDED** (`TRAINER_WALLY_VR_1` / `TRAINER_WALLY_VR_2` not chosen between) | `VictoryRoadRework:100`, `:104` (`boss-fight-coverage.md:162-163`) | 8, `FLAG_BADGE08_GET` | healed (script; `trainerChains` `healFree: false`) | position and the exclusion: player-observed (Yoshi), not in the scripts at pin bdebcbbf. Yoshi: buggy in the pinned version (there is one Wally, but sometimes a Gym 8 leader with three mons appears instead); see `boss-fight-coverage.md` Unresolved item 3 (`:232-250`) |
| 36 | Sidney: `TRAINER_SIDNEY` | `maps/EverGrandeCity_SidneysRoom/scripts.pory:56` | 8, `FLAG_BADGE08_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf (the league door checks only `FLAG_BADGE06_GET`, `EverGrandeCity_PokemonLeague_1F/scripts.pory:56`) |
| 37 | Phoebe: `TRAINER_PHOEBE` | `maps/EverGrandeCity_PhoebesRoom/scripts.pory:49` | 8, `FLAG_BADGE08_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 38 | Glacia: `TRAINER_GLACIA` | `maps/EverGrandeCity_GlaciasRoom/scripts.pory:49` | 8, `FLAG_BADGE08_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 39 | Drake: `TRAINER_DRAKE` | `maps/EverGrandeCity_DrakesRoom/scripts.pory:50` | 8, `FLAG_BADGE08_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |
| 40 | Champion Steven: `TRAINER_STEVEN` | `maps/EverGrandeCity_ChampionsRoom/scripts.pory:325` | 8, `FLAG_BADGE08_GET` | healed (script) | position: player-observed (Yoshi), not in the scripts at pin bdebcbbf |

Party data: every trainer above, including `TRAINER_WALLY_MAUVILLE`, is in `data/v2.65beta/trainers.json` (checked by id). `TRAINER_WALLY_MAUVILLE` is the
only **route fight outside the 40** (`boss-fight-coverage.md` does not list it and `driver/fights.ts` has no row for it). The Weather Institute grunts
(`TRAINER_GRUNT_WEATHER_INST_1`..`_5`) are NOT on the route (Yoshi, 2026-11-17: an earlier route draft mixed the Weather Institute up with the Space Center).

## Disagreements with `fights.ts`

`web/src/engine/sim/driver/fights.ts` as of 2026-11-17 (written on the skippable-gym premise). New values follow this table; d5-1c applies them.
`mayBefore` becomes `[]` on every row.

| Row (fightId) | Old (`requiredBefore`, `mayBefore`) | New `requiredBefore` | Why |
|---|---|---|---|
| `TRAINER_STEVEN_GRANITE_CAVE` | `[1]`, `[2]` | `[1]` | step 6, before Brawly |
| `TRAINER_BRAWLY_1` | `[1]`, `[3, 4]` | `[1]` | gym 2, fixed route |
| `TRAINER_GRUNT_MUSEUM_1` / `_2` / `TRAINER_ARCHIE_SLATEPORT` | `[1]`, `[2]` | `[1, 2]` | step 8, after Brawly |
| `TRAINER_MAY_ROUTE_110_TORCHIC` | `[1]`, `[2]` | `[1, 2]` | step 9 |
| `TRAINER_WATTSON_1` | `[1]`, `[2, 4]` | `[1, 2]` | gym 3, fixed route |
| `TRAINER_COURTNEY_METEOR_FALLS` | `[1]`, `[2, 3]` | `[1, 2, 3]` | step 12, after Wattson |
| `TRAINER_MAXIE_MT_CHIMNEY` | `[1]`, `[2, 3]` | `[1, 2, 3]` | step 13 |
| `TRAINER_FLANNERY_1` | `[1]`, `[2, 3]` | `[1, 2, 3]` | gym 4, fixed route |
| `TRAINER_GRUNT_SUNHOLLOW_1`, `TRAINER_COURTNEY_SUNHOLLOW` | `[1, 4]`, `[2, 3]` | `[1, 2, 3, 4]` | steps 15-16 |
| `TRAINER_WINONA_1` | `[1..5]`, `[7, 8]` | `[1..5]` | step 21, gym 6, fixed route |
| `TRAINER_ARCHIE_MT_PYRE` | `[1..5]`, `[6]` | `[1..6]` | step 22, after Winona |
| `TRAINER_MAXIE_MAGMA_HIDEOUT` | `[1..5]`, `[6]` | `[1..6]` | step 23 |
| `TRAINER_MATT` | `[1..5]`, `[6]` | `[1..6]` | step 24 |
| `TRAINER_TATE_AND_LIZA_1` | `[1..5]`, `[6]` | `[1..6]` | step 25, gym 7, fixed route |
| `TRAINER_GRUNT_SPACE_CENTER_2` | `[1..5, 7]`, `[6]` | `[1..7]` | step 26 |
| `TRAINER_GRUNT_SPACE_CENTER_5` (`_5`, `_6`, `_7`; `chainId: 'mossdeep-space-center-2f-grunts'` kept) | `[1..5, 7]`, `[6]` | `[1..7]` | step 27 |
| `TRAINER_MAXIE_MOSSDEEP` (+ `TRAINER_COURTNEY_MOSSDEEP`) | `[1..5, 7]`, `[6]` | `[1..7]` | step 28 |
| `TRAINER_ARCHIE` (Seafloor Cavern) | `[1..5, 7]`, `[6]` | `[1..7]` | step 29 |
| `TRAINER_TIFFANY`, `TRAINER_BRIDGET`, `TRAINER_DAPHNE`, `TRAINER_OLIVIA` (Gym 8's four trainer rows; chains kept) | `[1..5, 7]`, `[6]` | `[1..7]` | steps 30-33 |
| `TRAINER_JUAN_1` (+ `WALLACE`, `JUAN_5`, `WALLACE_5`; `tag`, chain kept) | `[1..5, 7]`, `[6]` | `[1..7]` | step 34, gym 8, fixed route |
| `TRAINER_WALLY_VR_1`, `TRAINER_WALLY_VR_2` | `[1..5, 7, 8]`, `[6]` | `[1..8]` plus `excluded: 'buggy in pinned version (player-observed)'` on BOTH rows (neither id is chosen over the other) | step 35 |
| `TRAINER_SIDNEY`, `TRAINER_PHOEBE`, `TRAINER_GLACIA`, `TRAINER_DRAKE`, `TRAINER_STEVEN` | `[1..8]`, `[]` | `[1..8]` (value unchanged; the evidence string gains the route label) | steps 36-40 |
| (none) | no row | `TRAINER_WALLY_MAUVILLE`: `single`, `[1, 2]`, `mandatory: true` with the citation "player-observed (Yoshi), not in the scripts at pin bdebcbbf; the script has a decline path `maps/MauvilleCity/scripts.pory:122-130, 241-251`" | step 10 |
| `TRAINER_MAY_ROUTE_103_TORCHIC`, `TRAINER_GRUNT_SUNHOLLOW_1`, `TRAINER_GRUNT_SPACE_CENTER_2`, `TRAINER_TIFFANY`, `TRAINER_BRIDGET`, `TRAINER_DAPHNE`, `TRAINER_OLIVIA` (seven rows) | no `deferred` field | `requiredBefore` as above, plus `deferred: true` and `deferredReason: 'v1 scope (Yoshi 2026-11-17): easy battle, add back later'` (chains and every other field kept) | steps 1, 15, 26, 30-33; "Deferred fights (add back later)" |
| `TRAINER_MAY_RUSTBORO_TORCHIC` | `mandatory: false` (YES/NO prompt, `maps/RustboroCity/scripts.pory:853-855`) | unchanged; it is on Yoshi's route, but the route does not say he could not decline | step 5; Open question 2 |
| Evidence strings | Winona, Tate and Liza, Juan rows cite `EverGrandeCity_PokemonLeague_1F:40` as "badge 6 is the only badge that can be skipped"; Winona's `mandatoryCitation` cites the `:40-41` comment; Brawly/Wattson/Flannery rows imply gyms 2-4 are interchangeable | `:56` (the `FLAG_BADGE06_GET` check) for the league door; the literal label `player-observed (Yoshi), not in the scripts at pin bdebcbbf` for the gym order | stale comment |

Unchanged and agreeing (`mayBefore` already empty): `TRAINER_MAY_ROUTE_103_TORCHIC` `[]`, `TRAINER_GRUNT_PETALBURG_WOODS` `[]`, `TRAINER_ROXANNE_1` `[]`,
`TRAINER_GRUNT_RUSTURF_TUNNEL` `[1]`, `TRAINER_MAY_RUSTBORO_TORCHIC` `[1]`, `TRAINER_NORMAN_1` `[1..4]` with `holdsBracelet`, `TRAINER_STEVEN_ROUTE118` `[1..5]`,
`TRAINER_SHELLY_WEATHER_INSTITUTE` `[1..5]` (no `chainId`; stays a single fight), `TRAINER_MAY_ROUTE_119_TORCHIC` `[1..5]`.

## Excluded rows (no row is awaiting the route any more)

Yoshi supplied steps 29-40 on 2026-11-17, so the earlier "Awaiting Yoshi" list is gone: no `fights.ts` row carries `awaitingRoute: true` after d5-1c.
The `awaitingRoute` field and its handling stay in the D4/D5 plans for any row a later repin or correction leaves unplaced, but the real table has none.

| Row (fightId) | `requiredBefore` | Flag | Why |
|---|---|---|---|
| `TRAINER_WALLY_VR_1` | `[1..8]` | `excluded: 'buggy in pinned version (player-observed)'` | step 35; player-observed (Yoshi), not in the scripts at pin bdebcbbf: there is one Wally, but sometimes a Gym 8 leader with three mons appears instead. Which of `_VR_1` / `_VR_2` is the real fight is NOT decided here; both rows are excluded. Cross-reference: `boss-fight-coverage.md` Unresolved item 3 (`:232-250`), which records the same observation and that the data does not explain it |
| `TRAINER_WALLY_VR_2` | `[1..8]` | same | same |

An excluded row is never run by the solver: a direct `--trainer` run refuses (D5 `levelCapForTrainer`, `innate-gating-plan.md` Step 1.2) and batch runs list it (D4).

## Deferred fights (add back later)

Yoshi, 2026-11-17: the first version targets a reduced fight set. Seven easy route steps are DEFERRED. Unlike `excluded` (buggy, cause unknown), a
deferred row is correct and is meant to be re-enabled later. Each row stays in the route table above and in `fights.ts`, with every field it would
otherwise have, plus `deferred: true` and `deferredReason: 'v1 scope (Yoshi 2026-11-17): easy battle, add back later'`. Deferred rows are handled
like excluded rows: no solver run scores them, they are left out of every "N fights" count, a direct `--trainer` run refuses (`levelCapForTrainer`
returns the tagged `{ awaiting: 'deferred (v1 scope)', row }`, `innate-gating-plan.md` Step 1.2) and batch runs list them. They stay in every
coverage test (`loadBossTrainerIds` ids are still each in exactly one row).

| Step | Row (fightId) and ids | Script path:line | Why deferred | Re-enabling needs |
|---|---|---|---|---|
| 1 | `TRAINER_MAY_ROUTE_103_TORCHIC` | `maps/Route103/scripts.pory:108` | v1 scope (Yoshi 2026-11-17): easy battle, add back later | flip the flag; nothing else |
| 15 | `TRAINER_GRUNT_SUNHOLLOW_1` | `maps/Route111_SunhollowRuins/scripts.pory:193` | same | flip the flag (`TRAINER_COURTNEY_SUNHOLLOW`, step 16, is NOT deferred) |
| 26 | `TRAINER_GRUNT_SPACE_CENTER_2` (1F stair grunt) | `maps/MossdeepCity_SpaceCenter_1F/scripts.pory:246` | same | flip the flag. The Space Center chain is unaffected: it is the 2F gauntlet `TRAINER_GRUNT_SPACE_CENTER_5/6/7` (`encounters.json` `trainerChains`, `MossdeepCity_SpaceCenter_2F`; `_2` is in no chain), which stays, as does the Maxie + Courtney double (step 28) |
| 30-33 | `TRAINER_TIFFANY`; `TRAINER_BRIDGET` (+ `_CRISSY`, `_BETHANY`, chain `sootopolis-gym-bottom-group`); `TRAINER_DAPHNE` (+ `_CONNIE`, `_ANDREA`, chain `sootopolis-gym-middle-group`); `TRAINER_OLIVIA` (+ `_BRIANNA`, `_ANNIKA`, chain `sootopolis-gym-top-group`): four rows, ten ids | `maps/SootopolisCity_Gym_B1F/scripts.pory:252`; `maps/SootopolisCity_Gym_1F/scripts.pory:528-564`, `:603-619`, `:652-668` | same | flip the flag on the four rows, which brings back the three gym-8 chains of `chains-plan.md`; AND decide the tag-battle gate question (Open question 4: whether `starttagbattle` marks both partners `defeated`), which decides whether `multichoice2` cases 2-4 are valid branches |

Totals: 7 route steps, 7 `fights.ts` rows, 13 trainer ids (all 13 have parties in `data/v2.65beta/trainers.json`, checked by id). Of the 40 route
steps, v1 runs 32 (40 minus 7 deferred minus the excluded step 35); of the 43 `fights.ts` rows after d5-1c (42 today plus `TRAINER_WALLY_MAUVILLE`),
v1 runs 34 (43 minus 7 deferred minus 2 excluded).

Juan is not affected in the game: his `SootopolisCity_Gym_EventScript_CheckTrainers` gate (`maps/SootopolisCity_Gym_1F/scripts.pory:477-499`) still
requires all ten gym trainers `defeated`, and the player still has to beat them. Only the solver does not simulate those fights in v1; Juan's row
assumes they were beaten (his defeated set is all ten, as before, so battle-event guards that read `defeated(...)` behave as in the game).

## StageKeys of the placed rows

From the table above (fixed route: `highestBadge` = `badgeCount` = k, `braceletHeld` = k >= 5 or Norman's `holdsBracelet`), the non-excluded rows use TEN keys:
`h0-n0-b0` (steps 1-3), `h1-n1-b0` (4-7), `h2-n2-b0` (8-11), `h3-n3-b0` (12-14), `h4-n4-b0` (15-16), `h4-n4-b1` (17, Norman), `h5-n5-b1` (18-21),
`h6-n6-b1` (22-25), `h7-n7-b1` (26-34: Space Center, Archie Seafloor Cavern, Gym 8 trainers, Juan), `h8-n8-b1` (36-40, the League). The excluded
Wally VR rows would also be `h8-n8-b1`, so the whole table, excluded rows included, has the same ten keys.
**v1 (non-deferred, non-excluded rows only): still TEN keys, none disappears.** Every key a deferred row uses keeps another row: `h0-n0-b0` keeps
steps 2-3 (Petalburg Woods grunt, Roxanne), `h4-n4-b0` keeps step 16 (Courtney Sunhollow), `h7-n7-b1` keeps steps 27-29 and 34 (Space Center 2F
gauntlet, Maxie + Courtney, Archie Seafloor Cavern, Juan).

## Open questions (for Yoshi)

1. **Is Wally (Mauville) mandatory?** Yoshi says it is unavoidable: player-observed (Yoshi), not in the scripts at pin bdebcbbf. The script asks YES/NO
   (`maps/MauvilleCity/scripts.pory:122-130`); NO sets `FLAG_DECLINED_WALLY_BATTLE_MAUVILLE` and ends (`:241-245`), and talking again re-asks (`:247-251`).
   Beating him only sets `FLAG_DEFEATED_WALLY_MAUVILLE` (`:181`, read only by `maps/VerdanturfTown_WandasHouse/scripts.pory:46`) and enables a Pokenav
   call (`:183`). The scripts show no gate on the gym or the route; whatever forces the fight in play is not in them.
2. **May 2 (`TRAINER_MAY_RUSTBORO_TORCHIC`)** is on the route but `fights.ts` has it optional because of its YES/NO prompt
   (`maps/RustboroCity/scripts.pory:853-855`). Kept optional until Yoshi says otherwise.
3. **Wally at Victory Road** (step 35) is excluded, not resolved: see Excluded rows and `boss-fight-coverage.md` Unresolved item 3. Lifting the exclusion
   needs Yoshi (or the found mechanism) to say which id the playable fight is.
4. **Gym 8 tag-battle gate.** Juan's `SootopolisCity_Gym_EventScript_CheckTrainers` (`maps/SootopolisCity_Gym_1F/scripts.pory:477-499`) checks
   `defeated()` on each of the ten gym trainer ids before he fights. In each group, `multichoice2` cases 2-4 beat two of the three trainers through
   `starttagbattle` (bottom `:553, :557, :561`; middle `:611, :615, :619`; top `:660, :664, :668`). The `starttagbattle` macro body is not in the pinned
   sparse checkout (`asm/` is absent), so nothing at the pin shows that a tag branch marks BOTH partners `defeated`. Steps 30-33, which present the four
   groups "in any order, cases 2-4 healed", therefore depend on that unproven behaviour; if the macro marks only one partner, a tag-pair branch would
   leave a trainer undefeated and Juan would refuse. Same open macro question for gyms 2-7: `solver-v2-plan.md:64-66` and `:196-201` (Step 0.5 (b));
   `chains-plan.md` decision 5 (`:93`). Steps 30-33 are deferred in v1 ("Deferred fights"), so this question blocks only their re-enabling, not v1.
