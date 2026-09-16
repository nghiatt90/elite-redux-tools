# Boss-fight coverage: the 40 Elite-difficulty fights

_Measured — the solver's fixed opponent set resolves to 55 trainer ids fielding 227 species / 399 moves / 357 abilities / 100 items; the damage engine already covers almost all of it, and what is left is turn-loop work, not damage work_

Measured 2026-09-16 against the committed `data/v2.65beta` snapshot and the pinned
`eliteredux-source` / `er-config` checkouts in `pipeline/.upstream/` (SHAs in
`sources.lock.json`). **Every count and every list here must be re-measured after a
repin** — trainer parties, the ability census and the engine registry all move.

**The rival set was corrected on 2026-09-16, after the first measurement.** The player
does not count the Lilycove fight; their four rival battles are Route 103, Rustboro,
Route 110 and Route 119. Every number in this document was recomputed over the corrected
set. An earlier revision counted Lilycove instead of Route 103 and therefore reported
228 species / 402 moves / 361 abilities / 102 items over 289 party slots — those figures
are superseded, not mistaken measurements of the same thing.

This exists to turn the battle-simulator plan's Section D ("widen the engine to cover move
behaviours, ability hooks, accuracy and field effects") from an open-ended estimate into a
finite list. Section D was sized as "comparable to the simulator itself, i.e. months" on the
assumption that any trainer could turn up. The target is now fixed: 40 specific fights,
Elite difficulty only. Against a fixed opponent set the required coverage is countable.

## Read this before quoting any number below

**"Zero ability gaps" is a statement about damage, and only about damage.** The ability
registry under `web/src/engine/abilities/` deliberately holds only the abilities
`abilityHooks.json` marks `damageRelevant` — the ones that change a damage number. 217 of the
357 abilities these parties field are in it and ported. The other 140 are absent **because
the census says they do not affect damage**, not because they were missed. They are
Intimidate, Drizzle, Speed Boost, Moxie, Regenerator, Prankster, Gale Wings, Shadow Tag,
Serene Grace, Rough Skin, Static, Weak Armor and 128 more: entry effects, end-of-turn
effects, priority modifiers, accuracy modifiers, switch triggers, faint triggers. Every one
of them is **turn-loop work that has not started**. Nobody should read the ability section
below as "abilities are done".

The same applies to moves: 4 of 344 damaging moves are flagged gaps, but 55 of the 399 moves
are STATUS-split (Stealth Rock, Protect, Shell Smash, Recover, Toxic, Leech Seed, Tailwind,
…). The damage engine has nothing to say about any of them, and they are the substance of
what these trainers actually do on a turn.

**The largest single item is Mega Evolution, and it is a scope finding rather than a bug.**
70 of the 285 party slots in these fights (24.6%) hold a Mega Stone or a Primal/Origin Orb
and change form during the battle. Nothing in `web/src/` models that change. This is
*disclosed*, not silent: the matchup report lists "No Mega Evolution and no on-switch-in
('entry') abilities" as one of its turn-one caveats (`web/src/lib/matchupReport.ts:38`,
rendered on the page), and hardcodes `isMegaEvolved: false` accordingly
(`matchupReport.ts:182`) — which is *correct* for turn one, since the AI has not
mega-evolved yet when the first hit lands. The damage calculator is not affected at all: it
is species-driven, and derives `isMegaEvolved` from whichever species the user picked
(`web/src/features/damageCalc/scenario.ts:228`), so someone who wants Mega Swampert selects
`SPECIES_SWAMPERT_MEGA` and gets it. What makes this the biggest Section D item is that a
*simulator* runs past turn one, and for a quarter of these mons the real fight is against a
form with different stats, types and abilities. See
[Mega Evolution and primal forms](#mega-evolution-and-primalorigin-forms) — the data needed
to resolve every one of them is already in `species.json`.

## The fights, resolved to trainer ids

Resolution is **by call site, never by name**. Names collide badly in this data: 94
name-and-class pairs are shared by 487 of the 932 trainers, the deepest being 30 trainers
all called "Grunt" in `TRAINER_CLASS_TEAM_MAGMA`; and each gym leader has five same-named
entries of which only the `_1` is the first-visit fight.
Citations are `Map:line` in
`pipeline/.upstream/eliteredux-source/data/maps/<Map>/scripts.pory`.

43 script-level fights, **55 distinct trainer ids**, 285 party slots. All 55 exist in
`trainers.json`. **No Elite party is empty**, so the usual fall-back-to-Ace case never fires
here; three have an Elite party identical to Ace (`TRAINER_MAY_ROUTE_103_TORCHIC`,
`TRAINER_GRUNT_MUSEUM_1`, `TRAINER_WALLY_VR_2`).

### Rival — 4 fights

| Fight | Trainer id | Mons | Evidence |
|---|---|---|---|
| May, Route 103 | `TRAINER_MAY_ROUTE_103_TORCHIC` | 2 | `Route103:108`, from the `switch VAR_STARTER_MON` at `:44-47` inside `Route103_EventScript_RivalMay` (`:33` branches away once `FLAG_SYS_GAME_CLEAR` is set) |
| May, Route 104 / Rustboro | `TRAINER_MAY_RUSTBORO_TORCHIC` | 6 | `Route104:183` and `RustboroCity:900` |
| May, Route 110 | `TRAINER_MAY_ROUTE_110_TORCHIC` | 6 | `Route110:445` |
| May, Route 119 | `TRAINER_MAY_ROUTE_119_TORCHIC` | 6 | `Route119:101` |

The player's own four, confirmed 2026-09-16. `TRAINER_MAY_LILYCOVE_TORCHIC` — the fifth
story May id, reused by the Route 103 daily rematch at `Route103:142` — is **not** counted;
see [Unresolved](#unresolved) for what excluding it costs. The `_TORCHIC` suffix names the
*player's* starter, so this is the Mudkip-line May: the Route 103 party is Mudkip + Goomy.

### Gym leaders — 8 fights, 11 trainer ids

| Fight | Trainer id | Mons | Evidence |
|---|---|---|---|
| Gym 1 Roxanne | `TRAINER_ROXANNE_1` | 6 | `RustboroCity_Gym:548/551/554` |
| Gym 2 Brawly | `TRAINER_BRAWLY_1` | 6 | `DewfordTown_Gym:719/722/725` |
| Gym 3 Wattson | `TRAINER_WATTSON_1` | 6 | `MauvilleCity_Gym:586/589/592` |
| Gym 4 Flannery | `TRAINER_FLANNERY_1` | 6 | `LavaridgeTown_Gym_1F:638/641/644` |
| Gym 5 Norman | `TRAINER_NORMAN_1` | 6 | `PetalburgCity_Gym:2022/2025/2028` |
| Gym 6 Winona | `TRAINER_WINONA_1` | 6 | `FortreeCity_Gym:518/521/524` |
| Gym 7 Tate & Liza | `TRAINER_TATE_AND_LIZA_1` | 6 | `MossdeepCity_Gym:1009/1012/1015`, `trainerbattle_double*`; `forcedDouble: true` |
| Gym 8 Juan, stage 1 | `TRAINER_JUAN_1` + `TRAINER_WALLACE` | 3 + 3 | `SootopolisCity_Gym_1F:278` |
| Gym 8 Juan, stage 2 | `TRAINER_JUAN_5` + `TRAINER_WALLACE_5` | 3 + 3 | `SootopolisCity_Gym_1F:288` |

Each leader's three-line cluster is three intro-text variants of **one** id, not three
fights.

**Gym 8's leader fight is not one trainer and not one battle.**
`SootopolisCity_Gym_1F:278` is
`starttagbattle(TRAINER_JUAN_1, TRAINER_WALLACE, TAG_TEAM_WALLACE_JUAN, ...)` — the player
alone against Juan *and* Wallace (both `gTrainerBattleOpponent_A` and `_B` are set; see
`FLAG_TAG_BATTLE` at `src/battle_setup.c:1470` and the `TAG_TEAM_*` ids at
`include/constants/battle.h:559`). Its post-battle script argument chains straight into a
second tag battle at `:288` against `TRAINER_JUAN_5 + TRAINER_WALLACE_5`.
`FLAG_SYS_DISABLE_AUTOHEAL` is set at `:276` and cleared at `:279`. Gym 8 is therefore four
trainer ids and twelve Pokemon, fought as two consecutive two-on-one doubles. Any plan text
treating it as one trainer with one party is wrong by a factor of four.

### Team Aqua — 4 fights

| Fight | Trainer id | Mons | Evidence |
|---|---|---|---|
| Petalburg Woods grunt | `TRAINER_GRUNT_PETALBURG_WOODS` | 6 | `PetalburgWoods:33` and `:69` (two approach directions, one id) |
| Rusturf Tunnel grunt | `TRAINER_GRUNT_RUSTURF_TUNNEL` | 6 | `RusturfTunnel:322` |
| Admin Shelly, Weather Institute | `TRAINER_SHELLY_WEATHER_INSTITUTE` | 6 | `Route119_WeatherInstitute_2F:52` |
| Admin Matt, Aqua Hideout B2F | `TRAINER_MATT` | 6 | `AquaHideout_B2F:30`; its post-battle script is `AquaHideout_B2F_EventScript_SubmarineEscape`, which is what sends you to search the sea |

### Archie — 3 fights, plus the 2 grunts before the first

| Fight | Trainer id | Mons | Evidence |
|---|---|---|---|
| Museum grunt 1 | `TRAINER_GRUNT_MUSEUM_1` | 2 | `SlateportCity_OceanicMuseum_2F:43` |
| Museum grunt 2 | `TRAINER_GRUNT_MUSEUM_2` | 2 | `SlateportCity_OceanicMuseum_2F:51`, same script |
| Archie, Oceanic Museum | `TRAINER_ARCHIE_SLATEPORT` | 6 | `SlateportCity_OceanicMuseum_2F:70`; the `special HealPlayerParty` immediately before it is commented out at `:69`, so all three are fought without a heal |
| Archie, Mt Pyre summit | `TRAINER_ARCHIE_MT_PYRE` | 6 | `MtPyre_Summit:702` |
| Archie, Seafloor Cavern | `TRAINER_ARCHIE` | 6 | `SeafloorCavern_Room9:72` |

### Team Magma — 5 fights, 7 trainer ids

| Fight | Trainer id | Mons | Evidence |
|---|---|---|---|
| Meteor Falls | `TRAINER_COURTNEY_METEOR_FALLS` + `TRAINER_GRUNT_METEOR_FALLS` | 3 + 3 | `MeteorFalls_1F_1R:193`, `multi_2_vs_2`; one line per `VAR_STARTER_MON` case (`:193/202/211`), opponent pair identical in all |
| Sunhollow Ruins entrance, alongside Norman | `TRAINER_GRUNT_SUNHOLLOW_1` | 6 | `Route111_SunhollowRuins:193`; Norman is an NPC tagging in, not a battle partner |
| Admin Courtney, Sunhollow Ruins Museum | `TRAINER_COURTNEY_SUNHOLLOW` | 6 | `Route111_SunhollowRuins_Museum:693` |
| Space Center 1F, stair grunt | `TRAINER_GRUNT_SPACE_CENTER_2` | 6 | `MossdeepCity_SpaceCenter_1F:246`; confirmed as the stair blocker by its post-battle `LOCALID_STAIR_GRUNT` movement, `:248-256` |
| Space Center 2F, 3 consecutive | `TRAINER_GRUNT_SPACE_CENTER_5/6/7` | 3 + 3 + 3 | `MossdeepCity_SpaceCenter_2F:72/78/84`, one script; `encounters.json`'s `trainerChains` records `healFree: true` |

### Maxie — 3 fights, 4 trainer ids

| Fight | Trainer id | Mons | Evidence |
|---|---|---|---|
| Maxie, Mt Chimney | `TRAINER_MAXIE_MT_CHIMNEY` | 6 | `MtChimney:54` |
| Maxie, Magma Hideout | `TRAINER_MAXIE_MAGMA_HIDEOUT` | 6 | `MagmaHideout_4F:57` |
| Maxie + Courtney, Space Center 2F | `TRAINER_MAXIE_MOSSDEEP` + `TRAINER_COURTNEY_MOSSDEEP` | 3 + 3 | `MossdeepCity_SpaceCenter_2F:274`, `multi_2_vs_2`, with `TRAINER_STEVEN_MOSSDEEP` as the player's AI partner |

### Steven — 3 fights

| Fight | Trainer id | Mons | Evidence |
|---|---|---|---|
| Steven, Granite Cave | `TRAINER_STEVEN_GRANITE_CAVE` | 6 | `GraniteCave_StevensRoom:136` |
| Steven, Route 118 | `TRAINER_STEVEN_ROUTE118` | 6 | `Route118:484` |
| Steven, Champion | `TRAINER_STEVEN` | 6 | `EverGrandeCity_ChampionsRoom:325`, the `!FLAG_SYS_GAME_CLEAR` branch. The `VAR_ELITE_4_MODE` switch above it (`:300-322`, selecting `_LEGENDS` / `_DOUBLES` / `_DOUBLES_LEGENDS`) is post-game rematch only |

### Wally — 2 fights

| Fight | Trainer id | Mons | Evidence |
|---|---|---|---|
| Wally, Victory Road entrance | `TRAINER_WALLY_VR_1` | 6 | `VictoryRoadRework:100`; `VictoryRoad_1F:48` is the same id on the legacy map |
| Wally, immediate rematch | `TRAINER_WALLY_VR_2` | 6 | `VictoryRoadRework:104`, `trainerbattle_rematch`; `gRematchTable[REMATCH_WALLY_3] = {WALLY_VR_2, _3, _4, _5}` at `src/battle_setup.c:311`. **The player's observation of this fight contradicts the data — see [Unresolved](#unresolved)** |

### Gym 8's own trainers — 10 trainer ids

| Fight | Trainer ids | Evidence |
|---|---|---|
| Tiffany (individual) | `TRAINER_TIFFANY` | `SootopolisCity_Gym_B1F:252` |
| Bottom group | `TRAINER_BRIDGET`, `TRAINER_CRISSY`, `TRAINER_BETHANY` | `SootopolisCity_Gym_1F:528-564` |
| Middle group | `TRAINER_DAPHNE`, `TRAINER_CONNIE`, `TRAINER_ANDREA` | `SootopolisCity_Gym_1F:603-619` |
| Top group | `TRAINER_OLIVIA`, `TRAINER_BRIANNA`, `TRAINER_ANNIKA` | `SootopolisCity_Gym_1F:652-668` |

Each group offers a `multichoice2`: case 1 is three consecutive one-on-ones under
`FLAG_SYS_DISABLE_AUTOHEAL`; cases 2-4 are one one-on-one followed by a two-on-one
`starttagbattle` against the remaining pair. **The trainer set is identical either way**, so
the union is branch-independent — only the battle shape and the healing differ.

### Elite Four — 4 fights

| Fight | Trainer id | Mons | Evidence |
|---|---|---|---|
| Sidney | `TRAINER_SIDNEY` | 6 | `EverGrandeCity_SidneysRoom:56` |
| Phoebe | `TRAINER_PHOEBE` | 6 | `EverGrandeCity_PhoebesRoom:49` |
| Glacia | `TRAINER_GLACIA` | 6 | `EverGrandeCity_GlaciasRoom:49` |
| Drake | `TRAINER_DRAKE` | 6 | `EverGrandeCity_DrakesRoom:50` |

All four are the base ids from the pre-`FLAG_SYS_GAME_CLEAR` path. The `_2` / `_3` / `_4`
variants in each room are post-game `VAR_ELITE_4_MODE` rematches
(singles / singles-legends / doubles / doubles-legends).

## Unresolved

Three cases where the script evidence alone does not pin the answer. Two are now settled by
the player; the third is a discrepancy that stands unexplained. They are stated rather than
guessed, because a wrong id silently yields the wrong party.

**1. Which starter suffix — settled: `_TORCHIC`.** Every rival battle dispatches on
`switch VAR_STARTER_MON` with `case 0/1/2` reaching `...Treecko/Torchic/Mudkip`
(`Route103:44-47` for the first fight, `:78-81` for the daily rematch), so the suffix names
the **player's** starter and May fields the counter-starter. Verified against the 2-mon
Route 103 parties: `_TREECKO` = Torchic + Goomy, `_TORCHIC` = Mudkip + Goomy, `_MUDKIP` =
Treecko + Goomy. So "May had the Mudkip line" and "the player chose Treecko" describe
different saves and cannot both be true. The player confirmed Torchic on 2026-09-16, so
`_TORCHIC` (the Mudkip-line May) is used throughout and is not an assumption. Kept only as a
re-measure hook: under `_TREECKO` the union would instead be 228 species / 404 moves /
358 abilities / 101 items — 6 species, 10 moves, 3 abilities and 2 items appear that are not
in the lists below, and 5, 5, 2 and 1 respectively drop out.

Note that the Meteor Falls **partner** ids invert the convention:
`MAY_TREECKO_METEOR_FALLS` (reached from the same `case 0`) fields Sceptile, i.e. the ally
May carries the player's own starter line. Upstream inconsistency; do not generalise one
rule to both.

**2. Which four rival fights — settled on 2026-09-16: Route 103, Rustboro, Route 110,
Route 119.** Five distinct story May ids exist: `ROUTE_103`, `RUSTBORO`, `ROUTE_110`,
`ROUTE_119`, `LILYCOVE`. The first measurement of this document guessed wrong, excluding
`ROUTE_103` as the most likely non-boss and counting `LILYCOVE`; the player has since said
they do not count the Lilycove fight. Adding `TRAINER_MAY_LILYCOVE_TORCHIC` back would add
3 species, 5 moves, 5 abilities and 2 items over 6 more party slots.

Lilycove is worth more than its six slots suggest, because its party is unlike every other
May party: Smeargle, Phantowl, Gyarados, Hisuian Goodra, Pikachu Pop Star and Swampert,
against the Swellow / Empoleon Redux / Swampert / Tsareena / Goodra / Golurk line the
Rustboro, Route 110 and Route 119 parties share. Excluding it is what drops Smeargle,
Phantowl and Pikachu Pop Star from the species list, Tinted Lens, Moon Spirit, Pixie Power,
Own Tempo and Subdue from the ability list, Electroweb, Giga Impact, Lunar Dance, Mist Ball
and Moonlight from the move list, and Dragon Gem and Kasib Berry from the item list.
Smeargle's Simple and Swampert's Swampertite survive the cut because other trainers in the
set carry them.

**3. Wally's second fight — a known discrepancy, unexplained.** The player reports this
fight as bugged, fielding Juan's three Pokemon as a double battle, and is certain of the
observation. The data does not account for it: the script and rematch-table chain resolve
unambiguously to `TRAINER_WALLY_VR_2/3/4/5`, which are four copies of the same six-Pokemon
singles party in `trainers.json` (`forcedDouble: false`). No mechanism producing the
reported symptom was found; the trainer enum values are not adjacent either
(`TRAINER_WALLY_VR_2 = 657`, `TRAINER_JUAN_5 = 801`, `er-config/TrainerEnum.proto`). The
closest match in the whole dataset to "Juan's three Pokemon as a double" is
`TRAINER_JUAN_5` itself — 3 Elite mons, `forcedDouble: true`.

**The observation stands; the data does not explain it.** That is recorded deliberately
rather than resolved toward `trainers.json`, because `trainers.json` is textproto truth and
not necessarily ROM truth: the Kotlin codegen sits between the two and is already documented
to drop a field the textproto sets (see
[Textproto versus codegen divergence](textproto-vs-codegen-divergence.md)). That makes the
codegen a likelier place for the cause than the textproto. Until someone finds the
mechanism, treat the `TRAINER_WALLY_VR_2` row in the table above as the best available id
and not as a confirmed one, and treat this fight's contribution to the union counts below
as provisional.

## The union (Elite tier, 55 trainers, 285 party slots)

- **227 distinct species**
- **399 distinct moves** — 344 damaging, 55 STATUS split
- **357 distinct abilities** — 161 distinct chosen `.ability` values, 289 distinct species
  innates, 93 appearing as both
- **100 distinct held items**

Abilities are counted as "chosen ability plus all three species innates", since innates are
fixed per species and always active for the AI (`docs/battle-sim/er-level-asymmetries.md` —
the level gating on innates is player-only).

## Gap 1 — abilities: 217 of 357 ported, 0 stubs, 0 gate holes

Measured against the live registry (`web/src/engine/abilities/registry.ts` with
`impl/index.ts` loaded), not against a grep of the source. The live registry holds **591**
entries; grepping `id: 'ABILITY_…'` out of `impl/*.ts` finds only 558, because 33 are
registered through macros and generators with no literal id string.

- **217 ported.** Real implementations, not stubs.
- **0 explicit `UNMODELLED` stubs** among these 357.
- **0 abilities that are damage-relevant but missing from the registry** — i.e. the coverage
  gate in `abilities/coverage.test.ts` is not hiding anything for this opponent set.
- **140 with no registry entry, all of them marked not damage-relevant** by
  `data/v2.65beta/abilityHooks.json`.

Those 140, grouped by the hook they declare. **This is the turn-loop backlog**, and it is
the honest measure of what Section D still owes for these fights.

| Hook | Count | Abilities |
|---|---|---|
| `onEntry` | 43 | Air Blower, Air Lock, As One (Ice Rider), Berserk DNA, Change of Heart, Cheap Tactics, Coil Up, Cutthroat, Dauntless Shield, Download, Drizzle, Drought, Electric Surge, Fearmonger, Foamy Web, Furnace, Grassy Surge, Greater Spirit, Intimidate, Intrepid Sword, Let's Roll, Low Visibility, Majestic Moth, Misty Surge, Monster Mash, North Wind, On the Prowl, Phantom Thief, Pressure, Psychic Surge, Rapid Response, Sand Stream, Scare, Schooling, Screen Cleaner, Sea Guardian, Showdown Mode, Snow Warning, Spider Lair, Sun Worship, Toxic Spill, Violent Rush, White Smoke |
| `onDefender` | 25 | Anger Point, Berserk, Cute Charm, Damp, Double Iron Barbs, Furnace, Gooey, Guilt Trip, Haunted Spirit, Ill Will, Inflatable, Iron Barbs, Itchy Defense, Loose Quills, Poison Point, Poison Touch, Rough Skin, Sand Spit, Scrapyard, Seed Sower, Stamina, Static, Toxic Debris, Weak Armor, Wind Power |
| `onAttacker` | 22 | Absorbant, Aftershock, Blade Dance, Cute Charm, Damp, Elemental Charge, Envenom, Fearmonger, Flaming Jaws, Grip Pincer, Growing Tooth, High Tide, Illuminate, Loud Bang, Poison Point, Poison Touch, Purple Haze, Static, Stench, Temporal Rupture, Tentalock, Volcano Rage |
| `onBattlerFaints` | 15 | As One (Ice Rider), Beast Boost, Chokehold, Entrance, Hubris, Jaws of Carnage, Looter, Moxie, Neurotoxin, Predator, Pretentious, Rampage, Scavenger, Soul Eater, Soul-Heart |
| `onEndTurn` | 13 | Bad Dreams, Chokehold, Hydration, Ice Body, Rain Dish, Schooling, Self-Repair, Self-Sufficient, Shed Skin, Speed Boost, Sun's Bounty, Tentalock, Toxic Spill |
| `onPriority` | 8 | Blitz Boxer, Flaming Soul, Gale Wings, Opportunist, Prankster, Temporal Rupture, Volt Rush, Water Gale Wings |
| `onAccuracy` | 7 | Artillery, Compound Eyes, Grip Pincer, Illuminate, Lullaby, No Guard, Olé |
| `onReactive` | 4 | Chokehold, Egoist, Entrance, Neurotoxin |
| `onExit` | 4 | Natural Cure, Regenerator, Self-Repair, Toxic Spill |
| `onStatLowered` | 2 | Competitive, Defiant |
| `onTrap` | 2 | Magnet Pull, Shadow Tag |
| `onModifyEffectChance` | 2 | Pyromancy, Serene Grace |
| `onModifyTargetFlag` | 1 | Artillery |
| `onBlockStatDrops` | 1 | Full Metal Body |
| `onRevive` | 1 | Recurring Nightmare |
| none | 11 | Accelerate, Eject Pack, Gluttony, Grappler, Nosferatu, Pickpocket, Poison Heal, Ripen, Simple, Unseen Fist, Weather Double Boost |

(Abilities with two hooks appear on both rows, so the column sums to more than 140.)

Of the eleven with no hook: four carry a bitfield the census records but no lambda
(`Eject Pack` → `persistent`, `Grappler` → `grappler`, `Poison Heal` →
`toxicTerrainImmune`, `Ripen` → `ripen`) and the other seven
(Accelerate, Gluttony, Nosferatu, Pickpocket, Simple, Unseen Fist, Weather Double
Boost) are **absent from `abilityHooks.json` entirely** — the scraper found no
`src/abilities.cc` definition for them. Whether that is a scraper gap or genuinely
unimplemented upstream abilities was not investigated here and is worth a look before
anyone relies on them being inert.

## Gap 2 — moves: 4 of 344 damaging moves flagged, 55 status moves untouched

Four moves in the union hit an existing warning set in `web/src/engine/basePower.ts`. All
four are already documented there and are warning-only:

| Move | Effect | Why |
|---|---|---|
| Final Gambit | `EFFECT_FINAL_GAMBIT` | `UNMODELLED_BASE_POWER_EFFECTS` — real damage exists but the ordinary formula cannot produce it |
| Night Shade | `EFFECT_LEVEL_DAMAGE` | same |
| Ruination | `EFFECT_SUPER_FANG_HAZE` | same |
| Super Fang | `EFFECT_SUPER_FANG` | same |

Nothing in the union reaches an unported `CustomMoveDamage`, an unported
`CustomMoveCondition`, or a `customFrom` modifier. Nothing hits
`ZERO_DAMAGE_BASE_POWER_EFFECTS` / `_MOVE_IDS` (no Squall Hammer, Fetch or Airborne Slam)
or `UNMODELLED_BASE_POWER_MOVE_IDS` (no Seismic Toss).

The 399 moves use **150 distinct MoveBehavior effects**, 111 of which are legacy-script-only
(a `legacyConfig` battle script, no structured `attack` block). The damage path does not
need those 111 — but a turn loop needs whatever each script does besides damage.

**The 55 STATUS-split moves**, which the damage engine models not at all:

Amnesia, Baneful Bunker, Barrier, Belly Drum, Bulk Up, Burning Bulwark, Calm Mind, Cotton
Guard, Curse, Dark Void, Destiny Bond, Dragon Cheer, Dragon Dance, Eerie Fog, Gear Up,
Growth, Helping Hand, Hypnosis, Iron Defense, Karma, King's Shield, Leech Seed, Life Dew,
Light Screen, Morning Sun, Mystic Dance, Nasty Plot, Pain Split, Protect, Quiver Dance,
Rain Dance, Recover, Recycle, Reflect, Rock Polish, Roost, Sharpen, Shell Smash, Shelter,
Shore Up, Slack Off, Sleep Powder, Spiky Shield, Stealth Rock, Strength Sap, Sunny Day,
Swagger, Swords Dance, Tailwind, Tail Glow, Toxic, Toxic Spikes, Victory Dance,
Will-O-Wisp, Yawn.

That list is a fair summary of the turn loop's job: hazards, screens, protection, setup,
recovery, status infliction, weather, speed control.

## Gap 3 — items: 20 of 100 read by the damage path

The 100 items resolve to 40 distinct hold effects. The engine references 30 `HOLD_EFFECT_*`
constants anywhere under `web/src/engine/`; 16 of those 40 are among them, covering 20 of
the 100 items. The other 24 hold effects, covering 80 items, are never mentioned.

**Covered (20):** Air Balloon, Assault Vest, Choice Band, Choice Specs, Eviolite, Fire /
Normal / Rock / Water Gem, Life Orb, Light Ball, Loaded Dice, Muscle Band, Punching Glove,
Occa Berry, Scope Lens, Swirly Glasses, Tactical Vest, Charcoal, Soft Sand.

**Not covered (80):**

- **51 Mega Stones** and **7 Primal/Origin Orbs** (Adamant Orb, Blue Orb, Griseous Orb,
  Lustrous Orb, Red Orb, Rusted Shield, Rusted Sword) — the form-change case, treated
  separately below.
- **22 others**, each a turn-loop or non-damage effect rather than a damage-formula gap:
  Black Sludge, Booster Energy, Bright Powder, Choice Scarf, Clear Amulet, Flame Orb, Focus
  Sash, Frost Orb, Heavy-Duty Boots, Iapapa Berry, King's Rock, Leftovers, Light Clay, Lum
  Berry, Psychic Seed, Salac Berry, Shell Bell, Sitrus Berry, Toxic Orb, Weakness Policy,
  White Herb, Wide Lens.

Choice Scarf is the clearest illustration of why the raw ratio misleads: it is "not covered"
because it only changes Speed, which the damage formula never reads. It is nonetheless
essential to a turn loop.

## Mega Evolution and primal/origin forms

**70 of 285 party slots (24.6%) hold a Mega Stone or a Primal Orb**, resolving to **59
distinct post-change forms**. Zero are unresolvable: every `(species, item)` pair has a
matching species in `species.json` whose `megas[].from`/`.item` or `primals[].from`/`.item`
names it. (The one mega in the whole dataset keyed by move rather than item,
`SPECIES_RAYQUAZA_MEGA` via Dragon Ascent, does not appear in these fights.) So the fix is a
reverse lookup over data that is already emitted, not a pipeline change.

If those forms were resolved, the union would gain **59 species** and **75 abilities**, of
which 46 are already ported and **29 are not**: Balloon Bomber, Clueless, Cold Rebound,
Crowned Shield, Crowned Sword, Desolate Land, Early Grave, Electromorphosis, Flame Body,
Flame Coat, Frost Burn, Funeral Pyre, Hardened Sheath, Haunting Frenzy, Loose Rocks,
Malodor, Natural Recovery, Permanence, Primordial Sea, Pure Love, Soul Linker, Surprise,
Tag, Tangling Hair, Thermomancy, Tipping Point, Triage, Watch Your Step, Winter Throne.

Two of those are load-bearing well beyond this list: **Desolate Land** and **Primordial
Sea**, which suppress opposing Water and Fire moves outright. Both are *innates* of the
primal forms (`SPECIES_GROUDON_PRIMAL` innates: Molten Down, Primal Armor, Desolate Land;
`SPECIES_KYOGRE_PRIMAL` innates: Swift Swim, Primal Armor, Primordial Sea), so they are
always on, not a one-in-three slot choice. Groudon appears in `TRAINER_MAXIE_MAGMA_HIDEOUT`
and `TRAINER_MAXIE_MOSSDEEP`, Kyogre in `TRAINER_ARCHIE` and `TRAINER_WALLACE_5` — four of
these fights contain a mon that zeroes an entire damage type the moment it changes form.

Every one of the 70 slots, for reference:

| Trainer | Base species | Item | Becomes |
|---|---|---|---|
| `TRAINER_ANDREA` | Inteleon | Inteleonite | Inteleon Mega |
| `TRAINER_ANNIKA` | Gengar | Gengarite | Gengar Mega |
| `TRAINER_ARCHIE` | Garchomp Redux | Garchompite R | Garchomp Mega Redux |
| `TRAINER_ARCHIE` | Kyogre | Blue Orb | **Kyogre Primal** |
| `TRAINER_ARCHIE` | Sharpedo | Sharpedonite | Sharpedo Mega |
| `TRAINER_ARCHIE_MT_PYRE` | Garchomp Redux | Garchompite R | Garchomp Mega Redux |
| `TRAINER_ARCHIE_MT_PYRE` | Sharpedo | Sharpedonite | Sharpedo Mega |
| `TRAINER_BETHANY` | Relicanth | Relicanthite | Relicanth Mega |
| `TRAINER_BRIANNA` | Quagsire | Quagsirenite | Quagsire Mega |
| `TRAINER_BRIDGET` | Drednaw | Drednawite | Drednaw Mega |
| `TRAINER_CONNIE` | Gyarados | Gyaradosite Y | Gyarados Mega Y |
| `TRAINER_COURTNEY_MOSSDEEP` | Charizard | Charizardite Y | Charizard Mega Y |
| `TRAINER_COURTNEY_SUNHOLLOW` | Arcanine | Arcanite | Arcanine Mega |
| `TRAINER_COURTNEY_SUNHOLLOW` | Houndoom Redux | Houndoominite R | Houndoom Mega Redux |
| `TRAINER_CRISSY` | Blastoise | Blastoisinite | Blastoise Mega |
| `TRAINER_DAPHNE` | Lapras | Laprasite X | Lapras Mega X |
| `TRAINER_DRAKE` | Dialga | Adamant Orb | Dialga Origin |
| `TRAINER_DRAKE` | Scizor Redux | Scizorite R | Scizor Redux Mega |
| `TRAINER_FLANNERY_1` | Charizard | Charizardite Y | Charizard Mega Y |
| `TRAINER_FLANNERY_1` | Wigglytuff | Wigglytuffite | Wigglytuff Mega |
| `TRAINER_GLACIA` | Articuno EX | Articunite | Articuno EX Mega |
| `TRAINER_GLACIA` | Dewgong | Dewgongite | Dewgong Mega |
| `TRAINER_GLACIA` | Lapras | Laprasite Y | Lapras Mega |
| `TRAINER_GRUNT_SPACE_CENTER_2` | Sandslash | Sandslashite | Sandslash Mega |
| `TRAINER_GRUNT_SPACE_CENTER_5` | Centiskorch | Centiskite | Centiskorch Mega |
| `TRAINER_GRUNT_SPACE_CENTER_6` | Sandaconda | Sandacondite | Sandaconda Mega |
| `TRAINER_GRUNT_SPACE_CENTER_7` | Garbodor | Garbodorite | Garbodor Mega |
| `TRAINER_JUAN_1` | Urshifu Rapid Strike | Urshifite | Urshifu Rapid Strike Mega |
| `TRAINER_JUAN_5` | Garchomp Redux | Garchompite R | Garchomp Mega Redux |
| `TRAINER_JUAN_5` | Palkia | Lustrous Orb | Palkia Origin |
| `TRAINER_MATT` | Blastoise | Blastoisinite X | Blastoise Mega X |
| `TRAINER_MATT` | Gallade Redux | Galladite R | Gallade Redux Mega |
| `TRAINER_MAXIE_MAGMA_HIDEOUT` | Camerupt | Cameruptite | Camerupt Mega |
| `TRAINER_MAXIE_MAGMA_HIDEOUT` | Groudon | Red Orb | **Groudon Primal** |
| `TRAINER_MAXIE_MAGMA_HIDEOUT` | Skarmory Redux | Skarmorite R | Skarmory Mega Redux |
| `TRAINER_MAXIE_MOSSDEEP` | Groudon | Red Orb | **Groudon Primal** |
| `TRAINER_MAXIE_MOSSDEEP` | Skarmory Redux | Skarmorite R | Skarmory Mega Redux |
| `TRAINER_MAXIE_MT_CHIMNEY` | Camerupt | Cameruptite | Camerupt Mega |
| `TRAINER_MAXIE_MT_CHIMNEY` | Meganium | Meganiumite | Meganium Mega |
| `TRAINER_MAY_ROUTE_119_TORCHIC` | Empoleon Redux | Empoleonite R | Empoleon Redux Mega |
| `TRAINER_MAY_ROUTE_119_TORCHIC` | Swampert | Swampertite | Swampert Mega |
| `TRAINER_NORMAN_1` | Banette | Banettite | Banette Mega |
| `TRAINER_NORMAN_1` | Ursaluna | Ursalunite | Ursaluna Mega |
| `TRAINER_OLIVIA` | Milotic | Miloticite | Milotic Mega |
| `TRAINER_PHOEBE` | Giratina | Griseous Orb | Giratina Origin |
| `TRAINER_PHOEBE` | Gyaradeath | Gyaradeathite X | Gyaradeath Mega X |
| `TRAINER_PHOEBE` | Houndoom Redux | Houndoominite R | Houndoom Mega Redux |
| `TRAINER_SHELLY_WEATHER_INSTITUTE` | Absol | Absolite | Absol Mega |
| `TRAINER_SHELLY_WEATHER_INSTITUTE` | Gardevoir Redux | Gardevoirite R | Gardevoir Redux Mega |
| `TRAINER_SIDNEY` | Alakazam Redux | Alakazite R | Alakazam Mega Redux |
| `TRAINER_SIDNEY` | Greninja | Greninjite | Greninja Mega |
| `TRAINER_SIDNEY` | Urshifu | Urshifite | Urshifu Mega |
| `TRAINER_STEVEN` | Metagross | Metagrossite | Metagross Mega |
| `TRAINER_STEVEN` | Mewtwo | Mewtwonite Y | Mewtwo Mega Y |
| `TRAINER_STEVEN` | Zacian | Rusted Sword | Zacian Crowned Sword |
| `TRAINER_STEVEN` | Zamazenta | Rusted Shield | Zamazenta Crowned Shield |
| `TRAINER_STEVEN_ROUTE118` | Aggron | Aggronite | Aggron Mega |
| `TRAINER_TATE_AND_LIZA_1` | Slowbro | Slowbronite | Slowbro Mega |
| `TRAINER_TATE_AND_LIZA_1` | Slowking | Slowkingite | Slowking Mega |
| `TRAINER_TIFFANY` | Kingler | Kinglerite | Kingler Mega |
| `TRAINER_TIFFANY` | Magnezone | Magnezonite | Magnezone Mega |
| `TRAINER_WALLACE` | Greninja | Greninjite | Greninja Mega |
| `TRAINER_WALLACE_5` | Kyogre | Blue Orb | **Kyogre Primal** |
| `TRAINER_WALLACE_5` | Swampert | Swampertite | Swampert Mega |
| `TRAINER_WALLY_VR_1` | Arcanine Hisuian | Arcanite H | Arcanine Hisuian Mega |
| `TRAINER_WALLY_VR_1` | Latios | Latiosite | Latios Mega |
| `TRAINER_WALLY_VR_2` | Gallade | Galladite | Gallade Mega |
| `TRAINER_WATTSON_1` | Eelektross | Eelektrossite | Eelektross Mega |
| `TRAINER_WINONA_1` | Aerodactyl | Aerodactylite | Aerodactyl Mega |
| `TRAINER_WINONA_1` | Mienshao | Mienshaoite | Mienshao Mega |

Note that `ITEM_URSHIFITE` maps to two different forms depending on the base species, so a
reverse index must key on `(species, item)`, not on the item alone.

One latent inaccuracy found while checking this, not relevant to these 40 fights:
`matchupReport.ts:182` hardcodes `isMegaEvolved: false` even for a party mon whose species
*is already* a mega or primal form and needs no evolution. Across all 932 trainers' Elite
parties there are 4 such slots; **none is in these 40 fights**, so nothing here is affected.

## Doubles and multi battles

At least **five of these fights are not one-on-one**, plus three optional ones. The
plan's assumption that doubles are a rare exception does not hold for this target set, and
the engine excludes doubles by type.

| Fight | Shape |
|---|---|
| Gym 7 Tate & Liza | `forcedDouble: true`; one trainer, double battle |
| Gym 8 Juan stage 1 | two-on-one: Juan + Wallace |
| Gym 8 Juan stage 2 | two-on-one: Juan_5 + Wallace_5 |
| Meteor Falls | `multi_2_vs_2`: player + May vs Courtney + Grunt |
| Space Center 2F Maxie | `multi_2_vs_2`: player + Steven vs Maxie + Courtney |
| Gym 8 bottom / middle / top groups | optional two-on-one branch in each group's `multichoice` |

The two `multi_2_vs_2` fights are harder than a plain double: the player's side has an
AI-controlled ally with its own party, and the player brings only a chosen subset
(`choose_mons`). Those partner parties are ordinary trainer entries — some spelled without
the `TRAINER_` prefix, e.g. `MAY_TORCHIC_METEOR_FALLS = 70` in `TrainerEnum.proto` — so
`trainers.json` already has them. Together (`MAY_TORCHIC_METEOR_FALLS` +
`TRAINER_STEVEN_MOSSDEEP`, 6 mons) they add 3 species, 6 moves and 4 abilities beyond the
opponent union, and 0 items.

Double-only damage terms the engine would need: the 0.75x spread multiplier
(`battle_util.c:7498`), partner Friend Guard / Caretaker / Food Lovers at 0.5x (`:7638-7640`)
and screens at 0.66 instead of 0.5 (`:7625`) — see
[Trick Room, forced doubles and Double Battle Mode](trick-room-and-forced-double-facts.md).
**34 of the 344 damaging moves in the union are spread moves** and would take the 0.75x:
Acid, Air Cutter, Avalanche, Bleakwind Storm, Blizzard, Boomburst, Dazzling Gleam, Double
Lariat, Dragon Energy, Earthquake, Eruption, Explosion, Fissure, Glacial Lance, Heat Wave,
Hyper Voice, Icy Wind, Make It Rain, Muddy Water, Ominous Wind, Origin Pulse, Outburst,
Parabolic Charge, Precipice Blades, Rock Slide, Searing Shot, Sludge Wave, Snarl,
Sparkling Aria, Splishy Splash, Surf, Synchronoise, Water Spout, Wildbolt Storm.

## Caveats

- **This counts what the parties field, not what a battle needs.** Accuracy, hazards,
  switching, item consumption, the turn loop, RNG call order and the whole AI are untouched
  by all four union counts.
- **Elite tier throughout.** No trainer in this set has an empty Elite party, so the usual
  "falls back to Ace" case never fires. Three have Elite identical to Ace.
- **Double Battle Mode is assumed off.** If the save option is on, every trainer with two or
  more Pokemon fights as a double regardless of `forcedDouble`
  (`option_plus_menu.c:1038`, `battle_main.c:1757`), which would put every fight in this
  document into the doubles column.
- **Levels are derived, not parsed** — enemy level is the player's highest party level
  (`battle_main.c:1819-1827`), so nothing here depends on a level field.
- **The rival set was corrected on 2026-09-16** — Route 103 in, Lilycove out. The starter is
  confirmed as Torchic, so the `_TORCHIC` suffix is settled too. See
  [Unresolved](#unresolved) for the deltas either choice is worth.
- **The Wally #2 fight is a known unexplained discrepancy.** The player observes Juan's
  three Pokemon as a double; the scripts and `trainers.json` give a six-Pokemon singles
  party. The id used above may be wrong.
- The three gym-8 group fights each have four branches; the union is branch-independent but
  the healing and battle shape are not.

## How this was measured

Reproducible from the pinned checkout:

1. **Index the battle call sites.** Scan all 515 `data/maps/*/scripts.pory` files for
   `trainerbattle*`, `starttagbattle` and `multi_*` — 810 call sites, 123 maps, 681 distinct
   trainers. Indexing only `trainerbattle*` finds 777 sites and **silently misses gym 8's
   leader fight and the Meteor Falls Magma fight entirely**, because both use the other two
   macros.
2. **Resolve each named fight to its call site**, reading the enclosing script for branch
   conditions (`VAR_STARTER_MON`, `FLAG_SYS_GAME_CLEAR`, `VAR_ELITE_4_MODE`,
   `FLAG_SYS_DISABLE_AUTOHEAL`). Never match by trainer name.
3. **Union the Elite parties**, taking each mon's `species`, `moves`, `item` and `ability`
   plus that species' three `innates`.
4. **Intersect against the engine.** Abilities against the *live* registry loaded through
   `web/node_modules/.bin/jiti` (a grep undercounts by 33); moves against
   `basePower.ts`'s four warning sets plus the `CustomMoveDamage` / `CustomMoveCondition`
   tables; items against every `HOLD_EFFECT_*` constant referenced anywhere under
   `web/src/engine/`.

Cross-check: `npm --prefix web test` was green at the time of measurement (63 files, 795
tests), which is consistent with the "0 gate holes" result — a missing damage-relevant
ability would have failed `abilities/coverage.test.ts` instead.

See [Verifying cited numbers and corpus claims](verify-cited-numbers-and-corpus-claims.md)
for why every count here was computed rather than reasoned, and
[Textproto versus codegen divergence](textproto-vs-codegen-divergence.md) for why
`trainers.json` is textproto truth and not necessarily ROM truth.
