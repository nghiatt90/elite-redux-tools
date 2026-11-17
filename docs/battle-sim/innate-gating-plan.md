# Plan: Elite level caps per fight and player innate gating (D5)

_Status: REVISED 2026-11-17; APPROVED by cold review round 3 (route/gym order, tier elite, Elite cap mode confirmed by Yoshi); six wording notes applied. Later the same day (Yoshi, v1 scope, not re-reviewed): seven easy rows are `deferred` (`story-route.md` "Deferred fights (add back later)"), handled like `excluded` rows by the lookup and the solver; the StageKey set is unchanged (10). Revision history: route steps 29-40 from Yoshi (no row awaits the route; Wally VR rows `excluded`; `levelCapForTrainer` defined, `scoreTeam` options object, `--ignore-cap` through `workerData`); earlier, non-gym rows from `story-route.md`, awaiting rows excluded from solver runs, the `--level` default/cap contradiction removed; first, Yoshi's correction (fixed route, gym-trainer loop). History: APPROVED by a cold Opus reviewer after 3 rounds (round 1: badge flag versus count, undefined fight key, contradictory API, no evolution mechanism; round 2: evolution check would reject legal teams, Elite-vs-Ace test confounded by the opponent party; round 3: APPROVED) on the skippable-gym premise; Yoshi then fixed the gym route (all 8 gyms required, in order), which rewrote the `getHighestBadge` note, decision 2, Step 1.1-1.3, Step 3.2's `--badge-scenario` flag (dropped) and the story-order risk. Not yet committed or executed. Vikunja task 63. Planning only: no sim code is changed by this document._

## Decisions pending Yoshi (2026-11-17)

Items 1, 2 and 5 are answered; 3 and 4 are open and this plan decides neither.
1. **Difficulty tier**: ANSWERED by Yoshi: `elite` (the data tiers are `ace` / `elite` / `hell`; `solverCli --tier` defaults to `elite`).
2. **Level-cap mode**: ANSWERED and verified: the menu's 'Elite' cap mode is `LEVEL_CAPS_ELITE`, which selects the table `levelCapsStrict = {16, 23, 36, 45, 50, 55, 60, 70, 80, 100}` (`src/pokemon.c:4649-4671`, comment '// Elite'). This plan calls it the 'Elite' table (the code name `levelCapsStrict` is mentioned only here).
3. **EVs**: Yoshi says `enableEvs` is ON and the solver must solve the EV distribution (252 per stat, 510 total: `include/constants/pokemon.h:326-327`); today `solver.ts:32` `EV_TEMPLATES` plus `:293-295` swap only a few fixed templates. DECIDED (Yoshi, 2026-11-17): version 1 searches only a small pre-defined set of EV distributions (the existing `EV_TEMPLATES` approach); the advanced point-by-point EV search is DEFERRED to a later version. Out of scope of D5.
4. **Compute budget for D4's full run** (`solver-v2-plan.md` decision 12): to be discussed with Yoshi; the EV search will multiply D4's cost, so do not decide it.
5. **D6 coverage dependency**: `@vitest/coverage-v8` ALLOWED by Yoshi.

## Goal

For each of the 40 fights, plus the one route fight outside the 40 that Yoshi's route contains (`TRAINER_WALLY_MAUVILLE`,
`docs/battle-sim/story-route.md`; parties from `data/v2.65beta/trainers.json`), except the rows flagged `excluded` (the two Wally Victory Road rows,
`story-route.md` step 35) and the rows flagged `deferred` (v1 scope, Yoshi 2026-11-17: May Route 103, the Sunhollow desert grunt, the Space Center 1F
stair grunt and Gym 8's four trainer rows; seven rows, 13 ids, `story-route.md` "Deferred fights (add back later)"), which have a row but are never run
(so v1 runs 32 of the 40 route steps, 34 of the 43 `fights.ts` rows), the sim builds the player's party under the game's real level rules: the player's levels are bounded by the
Elite level cap for the badges held at that point in the story, and the player's innates are gated by those levels (slot 2 off below 17,
slot 3 off below 24) while the AI keeps all three. The innate gate itself is already ported; what is missing is the per-fight cap and its use
by the party builder and the solver.

## Context (verified facts)

### C
- `CanDisableInnates()` is `gameDifficulty >= P_DISABLE_FIRST_DIFFICULTY` (`src/pokemon.c:6235`), `P_DISABLE_FIRST_DIFFICULTY` is
  `DIFFICULTY_ELITE` (`include/constants/pokemon_config.h:22`), so Ace never gates. Thresholds (`pokemon_config.h:25-31`): Elite 1 / 17 / 24,
  Hell 10 / 17 / 24 (`getInnateDisableLevel`, `pokemon.c:6237-6263`).
- `GetInnateInSlot` (`src/battle_util.c:8799-8803`) takes `isPlayer` as a parameter and returns `ABILITY_NONE` when `isPlayer && CanDisableInnates() && level < getInnateDisableLevel(position)`.
  Callers decide it: the in-battle recomputes (`UpdateAbilityStateIndicesForNewSpecies` `:8807`, `RepopulateAbilities` `:9282`) use `GetBattlerSide(battler) == B_SIDE_PLAYER`; the player controller
  passes `TRUE` at battle start (`battle_controller_player.c:3502-3504`); the **partner controller passes `FALSE`** (`battle_controller_player_partner.c:678-680`), so an AI partner starts
  ungated and is gated only when a later recompute runs (see `doubles-plan.md` step 2.7, which this corrects).
- `GetLevelCap` (`src/pokemon.c:4649-4671`) indexes a table by `getHighestBadge()` (`:4635-4647`: badge flags 1..8 in order, `FLAG_SYS_GAME_CLEAR` -> 9,
  none -> 0). The Elite table (`LEVEL_CAPS_ELITE`) is `{16, 23, 36, 45, 50, 55, 60, 70, 80, 100}` (`:4656`). `levelCaps` is a save setting
  (constants `include/constants/global.h:145-148`, save field `include/global.h:590` `u16 levelCaps:3`); `OFF` falls into the Easy table (`default:` at `:4659`). The index is the HIGHEST
  badge flag held, not a count: `getHighestBadge` returns the highest `FLAG_BADGE0x_GET` that is set. With all 8 gyms required and cleared in a fixed order (Yoshi, 2026-11-17; badge 6 is required by the league door,
  `EverGrandeCity_PokemonLeague_1F/scripts.pory:56`), the highest flag held always equals the number of badges held. The comment at `:4633` ("unless they skipped Winona") and the one at
  `EverGrandeCity_PokemonLeague_1F/scripts.pory:40-41` are stale leftovers, not evidence that a gym can be skipped.
- The cap limits how high the player can LEVEL (exp gain `battle_script_commands.c:3511-3516`, candies `pokemon.c:2580-2599`); it does not stop a
  mon above the cap from being sent out. Enemy level = `GetHighestLevelInPlayerParty()` (`battle_main.c:1819-1827`).

### Sim
- `innateGate.ts` already has the thresholds, `innateSlotsFor`, `gateInnates`, the Elite table and `levelCapFor(badges)` (throws outside 0..9).
- `web/src/engine/sim/driver/session.ts:256-258` gates every player mon with `gateInnates(innates, level, tier)` (`:257`; tier defaults to `'elite'`, `:249`) and leaves the opponent untouched;
  the enemy level is the player party's maximum (`:260`, passed to `buildOpponentParty` at `:261`);
  `formChange.ts` re-gates after Mega. `cycle144InnateGate.test.ts` covers Elite 1/16/17/23/24 and Hell 9/10/16/17/23/24, Ace keeps all three, the AI keeps
  all three, Mega gating, and `levelCapFor`.
- Gaps: `levelCapFor` has no caller outside tests; `buildPlayerParty` defaults every level to 50 (`web/src/engine/sim/driver/buildParty.ts:164,173`) and copies raw innates
  (gating happens later in `createSession`); `web/src/engine/sim/driver/solver.ts:419` takes the team's max level (default 50) with no cap input and `scoreTeam` (`:409`) has no badge or cap
  parameter; `web/src/engine/sim/driver/solverCli.ts:38` defaults `--level` to 50; the fight data has no badge field (`boss-fight-coverage.md` lists no badge counts; a prior handoff, `.omc/handoffs/2026-11-04-battle-sim-audit-completeness.md`, also records the badge count per fight as not in the repo).
- `docs/battle-sim/er-level-asymmetries.md:9-21` records the gate and the cap tables; its `:38-39` says lowering the party's maximum level is monotonically
  bad for the player, which is why the cap is the player's upper bound.

## Design decisions

1. **The cap is an upper bound, and the default player level in a fight is the cap.** The best the player can do is sit at the cap (monotonic per
   `er-level-asymmetries.md:38-39`), so the builder/solver default for a fight is `levelCapForTrainer(trainerId)` (Step 1.2); a caller may pass lower levels
   (they get gated accordingly) but never higher unless an explicit `ignoreCap` is passed (boxed over-cap mons are legal in the game, so the escape hatch exists
   but is off by default and reported when used).
2. **The table stores the highest badge flag held, keyed by trainer id.** `driver/fights.ts` (with `driver/progression.ts`) under `web/src/engine/sim/driver/` has rows
   `{ fightId, trainerIds: string[], format, chainId?, gymNumber?, holdsBracelet?, requiredBefore, mayBefore, evidence, mandatory, mandatoryCitation, awaitingRoute?, excluded?, deferred?, deferredReason? }`
   (`format` is the `fights.ts:15` enum `'single'|'double'|'tag'|'multi_2_vs_2'`; `chainId` marks a no-heal chain, `gymNumber` a gym leader row, `holdsBracelet` Norman's row; `awaitingRoute?: true`,
   `excluded?: string`, `deferred?: true` and `deferredReason?: string` are added by d5-1c; `deferred` marks a correct row left out of v1 to be re-enabled later, unlike `excluded`, which marks a buggy one), where the badge value is the `getHighestBadge()` return value (0..9; 9 = `FLAG_SYS_GAME_CLEAR`), i.e. the largest gym in `requiredBefore`; under the fixed route it equals the badge count, and `mayBefore` is empty for every row
   (queue item d5-1c), so each fight has ONE badge value, not a range. The key is the trainer id because that is what the solver already takes (`--trainer`) and what
   `web/src/engine/sim/driver/bossSet.ts` exports: `loadBossTrainerIds` returns 55 trainer ids for the 43 script-level fights (`boss-fight-coverage.md:66`; "40 fights" is STATE.md's target-set wording for the same set); multi-id fights
   (Juan + Wallace, Space Center 5/6/7, the Meteor Falls and Mossdeep `multi_2_vs_2` pairs) are one row listing all their ids. Gym 8's own ten ids are FOUR rows, all at the same badge state (`[1..7]`): Tiffany alone
   (`fights.ts:478`) and the three chained groups (`fights.ts:490, 503, 516`). The fight key is `fightId`, which equals `trainerIds[0]`, the first id in script order (`fights.ts:14`); there is no other id space.
   Each row's story position comes from ONE of: (i) script lines or flag guards that fix it (e.g. Norman's badge 1-4 checks, `PetalburgCity_Gym/scripts.pory:1719/1731/1743`, which gate the case-6 battle indirectly); (ii) the fixed gym order (Yoshi, labelled
   `player-observed (Yoshi), not in the scripts at pin bdebcbbf`); (iii) `docs/battle-sim/story-route.md`, Yoshi's route, whose rows the scripts do not place are labelled `player-observed (Yoshi), not in the scripts at pin bdebcbbf` and are
   copied with that label into the row's `evidence`. There are no `inferred` rows: route steps 1-40 place every row (steps 29-40 supplied 2026-11-17), so NO row carries `awaitingRoute` in the real table. The field stays defined for
   any row a later correction leaves unplaced (it would keep its `requiredBefore` as a lower bound, closed downward under the fixed gym order). The two Wally Victory Road rows (`TRAINER_WALLY_VR_1`, `TRAINER_WALLY_VR_2`, step 35) keep
   `requiredBefore [1..8]` and carry `excluded: 'buggy in pinned version (player-observed)'` (`story-route.md` "Excluded rows"; `boss-fight-coverage.md` Unresolved item 3); neither id is chosen over the other. Seven rows
   (`TRAINER_MAY_ROUTE_103_TORCHIC`, `TRAINER_GRUNT_SUNHOLLOW_1`, `TRAINER_GRUNT_SPACE_CENTER_2`, `TRAINER_TIFFANY`, `TRAINER_BRIDGET`, `TRAINER_DAPHNE`, `TRAINER_OLIVIA`) keep their `requiredBefore` and carry `deferred: true`,
   `deferredReason: 'v1 scope (Yoshi 2026-11-17): easy battle, add back later'` (`story-route.md` "Deferred fights (add back later)"). The route fight
   outside the 40 (`TRAINER_WALLY_MAUVILLE`) gets a row too, from `story-route.md`; it is not in
   `loadBossTrainerIds`, so the coverage test stays one-directional (every boss id is in a row) and a second test asserts the route-only rows are exactly those `story-route.md` lists.
   None is taken from the usual Hoenn order without a script or a Yoshi statement (this ROM hack reworks story order, e.g. `VictoryRoadRework`).
3. **Elite is the only table ported: Elite cap mode, confirmed by Yoshi (the player's setting) and verified in pokemon.c.** `levelCaps` is a per-save option (`include/global.h:590` `u16 levelCaps:3`; values
   Easy/More/Elite/Off at `include/constants/global.h:145-148`), and `GetLevelCap` picks the table from it (`src/pokemon.c:4649-4671`; Off falls into the Easy table through `default:`). The sim uses the
   player's Elite choice (the Elite table), the strictest table and the one matching the Elite tier the sim defaults to. `levelCapFor` takes only a badge index
   (`web/src/engine/sim/innateGate.ts:41`), so no other table is selectable and no error path for one is added; every solver report prints "level caps: Elite (player's setting, confirmed by Yoshi)".
4. **Tier stays a parameter** (`ace|elite|hell`, default `elite`) so the existing behaviour is unchanged. For innates, Hell changes only slot 1 (level 10), below every cap. The badge table will also feed the
   badge-gated Hell flags (badge 2 damage reduction, badge 3 extra levels, badge 5 zero IVs, `docs/battle-sim/environment-inventory.md:169-176`); that is a follow-up, not part of D5.
5. **Evolution level is a WARNING, never a rejection.** The solver takes species straight from `--team` (`web/src/engine/sim/driver/solverCli.ts:99`) and never checks evolution. From `species.json` `evolutions: [{level, to}]` (e.g.
   `{"level":16,"to":"SPECIES_IVYSAUR"}`) the inverse graph gives `evolveLevel(species)` = the largest evolution `level` along its chain (ER's `Evolution` message has only `to`/`level`/`gender`,
   `er-config/SpeciesList.proto:44-48`; a missing `level` is 0, so there is no "unknown stone" case). A team member whose `evolveLevel` exceeds the cap is REPORTED in the solver output ("needs level N, cap is M")
   but the run is not stopped, because the level is not the only way to obtain a species: the upstream wild tables list evolved species at low levels (`src/data/wild_encounters.json:2644-2661` has wild
   `SPECIES_PIDGEOTTO` at levels 2-3 although Pidgey evolves at 16), and gift or trade mons are not considered either. Using `wild_encounters.json` for real availability is a possible later extraction (it is on disk at
   the pinned SHA but not in the committed data) and is out of scope for D5. Level-up moves already follow level (`learnableMoves` `web/src/engine/sim/driver/solver.ts:112-121`). TM and tutor availability is story-gated too and is OUT of scope:
   `learnableMoves` adds the full tutor list regardless of level, and this is stated in solver output.

## Steps

### Step 1 - fight-to-badges table (data, read-only research first)
1.1 For each fight row in `boss-fight-coverage.md` (`:71-190`) determine which `FLAG_BADGE0x_GET` flags are set when it occurs, using the map scripts under `pipeline/.upstream/eliteredux-source/data/maps/` (flag guards,
    `FLAG_BADGE0x_GET` checks, `VAR_*` progression variables), `encounters.json` guards, the fixed gym route (Yoshi, 2026-11-17: gym N requires gyms 1..N-1, all 8 required), and, for every non-gym fight the
    scripts do not place, `docs/battle-sim/story-route.md` (Yoshi's route, steps 1-40; disagreements with the old rows are listed there). Record `{trainerIds, requiredBefore, evidence}` (with
    `mayBefore` empty) in `web/src/engine/sim/driver/fights.ts` built on `web/src/engine/sim/driver/progression.ts`. Done by d5-1/d5-1b on the skippable-gym premise; queue item d5-1c corrects the rows and evidence.
1.2 Every fight has ONE `getHighestBadge()` value, the largest gym in its `requiredBefore`; there is no min/max range and no earliest-versus-latest default. Rows of route steps 1-40 are exact.
    **The lookup.** `web/src/engine/sim/driver/fights.ts` exports
    `levelCapForTrainer(trainerId): { cap: number; row: FightRow; evidence: string } | { awaiting: string; row: FightRow } | undefined`. It finds the row whose `trainerIds` contains `trainerId` (ANY member, not only
    `fightId`, so `--trainer TRAINER_WALLACE` finds Juan's row). A placed row returns `{ cap: levelCapFor(highestBadge), row, evidence }`. A row with `awaitingRoute: true`, `excluded` or `deferred` returns the tagged
    `{ awaiting, row }`, where `awaiting` is the `excluded` text, `'awaitingRoute'`, or exactly `'deferred (v1 scope)'` for a deferred row. A trainer id in no row returns `undefined`.
    **The three outcomes, used identically by Step 2.3, Step 3 and d4-4.** (a) Placed row: the cap applies (Step 3's level rule). (b) Tagged `{ awaiting }`: the solver CLI REFUSES and exits non-zero with exactly
    `refused: <trainerId> is in fights.ts row <fightId> (<awaiting>); no level cap is trusted for it`; batch runs (d4-4) do not refuse but skip the row and list it with the same text. (c) `undefined`: `--level` behaves as today
    (default 50, no cap). In the real table after d5-1c, (b) is reached only by the two Wally VR rows (`excluded`) and the seven `deferred` rows; no row is `awaitingRoute`. If a later correction leaves a row unplaced it gets `awaitingRoute: true` with its
    `requiredBefore` as a lower bound, and placing it later is a data edit only.
1.3 `web/src/engine/sim/driver/fights.ts` with a test that every id returned by `loadBossTrainerIds` (`web/src/engine/sim/driver/bossSet.ts:11-45`) is in exactly one row and every row has non-empty evidence (exists since d5-1b; d5-1c adds
    the fixed-route assertions, the route-only rows of Decision 2, the assertion that no row is `awaitingRoute`, and the assertion that the `excluded` rows are exactly `TRAINER_WALLY_VR_1` and `TRAINER_WALLY_VR_2`,
    `story-route.md` "Excluded rows", and that the `deferred` rows are exactly the seven of `story-route.md` "Deferred fights (add back later)"; plus `levelCapForTrainer` tests: a non-first member id finds its row, an excluded id returns `{ awaiting }`,
    a deferred id (including a non-first member such as `TRAINER_CRISSY`) returns `{ awaiting: 'deferred (v1 scope)' }`, an unknown id returns `undefined`).
    Distinct StageKeys under the fixed route: a fight after gym k and before gym k+1 has `requiredBefore = [1..k]`, so `highestBadge = k` (highest flag), `badgeCount = k` (all lower gyms are held) and `braceletHeld = k >= 5`, giving the nine
    keys `h0-n0-b0`, `h1-n1-b0`, `h2-n2-b0`, `h3-n3-b0`, `h4-n4-b0`, `h5-n5-b1`, `h6-n6-b1`, `h7-n7-b1`, `h8-n8-b1`, plus `h4-n4-b1` for Norman's own fight, whose row has `holdsBracelet` (`fights.ts:133`) because the bracelet is handed
    over before that battle (`PetalburgCity_Gym/scripts.pory:1754-1763`): at most 10. `h4-n4-b0` exists only if some non-Norman fight falls between gyms 4 and 5 (the Sunhollow rows, steps 15-16 of `story-route.md`, `requiredBefore [1..4]`); d5-1c reports the exact
    list from the corrected table. Under the route of steps 1-40 the non-excluded rows use TEN keys: `h0-n0-b0` (steps 1-3), `h1-n1-b0` (4-7), `h2-n2-b0` (8-11), `h3-n3-b0` (12-14), `h4-n4-b0` (15-16),
    `h4-n4-b1` (17, Norman), `h5-n5-b1` (18-21), `h6-n6-b1` (22-25), `h7-n7-b1` (26-34: Space Center, Archie Seafloor Cavern, Gym 8's four trainer rows, Juan), `h8-n8-b1` (36-40, Elite Four and Champion); the excluded
    Wally VR rows (`[1..8]`) add no key, so the whole table also has ten. Re-derived from the non-deferred, non-excluded rows only (the v1 set): still TEN, no key disappears, because each key a
    deferred row uses keeps another row (`h0-n0-b0`: Petalburg Woods grunt and Roxanne, steps 2-3; `h4-n4-b0`: Courtney Sunhollow, step 16; `h7-n7-b1`: Space Center 2F gauntlet, Maxie + Courtney, Archie Seafloor
    Cavern and Juan, steps 27-29 and 34). (The earlier 12-key list, with `h4-n3-b0` and `h8-n7-b1`, came from skippable-gym subsets and no longer applies.)

### Step 2 - apply the cap in the builder
2.1 `buildPlayerParty`'s signature is positional, `buildPlayerParty(specs, defaultLevel = 50, bundle)` (`web/src/engine/sim/driver/buildParty.ts:162-166`) with about 47 callers. Add a FOURTH optional parameter
    `options?: { levelCap?: number; ignoreCap?: boolean }`; nothing existing changes. Without `options` (or without `levelCap`) behavior is exactly today's (default level 50, no cap check). With `levelCap`:
    a spec with no level defaults to the cap, a spec level above the cap THROWS unless `ignoreCap` is set (there is no clamping), and `ignoreCap` use is reported by the solver.
2.2 `createSession` keeps gating at session build (`web/src/engine/sim/driver/session.ts:256-258`). The existing `cycle144InnateGate.test.ts:75-147` already runs `buildPlayerParty` -> `createSession` at Hell 9/10/16/17/23/24 and Elite
    1/16/17/23/24, including Ace and the AI keeping all three, so no gate tests are duplicated; new tests cover only the cap behaviors (default-to-cap, throw above cap, `ignoreCap`).
2.3 `levelCapFor` gets its first production caller, `levelCapForTrainer` in `web/src/engine/sim/driver/fights.ts` (Step 1.2); an `awaitingRoute`, `excluded` or `deferred` row has no trusted cap and the lookup returns the tagged
    `{ awaiting }` result instead, which the CLI turns into the Step 1.2 refusal. `buildPlayerParty` itself never reads the table; it takes the cap only through `options.levelCap`.

### Step 3 - solver and CLI
One rule for the solver's level, used by 3.1 and 3.2 alike, keyed on the three outcomes of `levelCapForTrainer` (Step 1.2). (a) Placed row: `--level` omitted means level = the fight's cap; `--level` below the cap
lowers the level to that value; `--level` above the cap is an ERROR unless `--ignore-cap` is passed (then the given level is used and reported). There is no clamping. (b) `{ awaiting }` (an `awaitingRoute`, `excluded` or `deferred`
row): refused with the Step 1.2 message. (c) `undefined` (no row): `--level` behaves as today (default 50, no cap).
3.1 `scoreTeam`'s signature (`web/src/engine/sim/driver/solver.ts:409-418`, today eight parameters ending in `battleEvents`) gains a NINTH optional parameter `options?: { levelCap?: number; ignoreCap?: boolean }`, passed
    straight to `buildPlayerParty`'s Step 2.1 `options` (`solver.ts:419-420`, which today takes the team's max level, default 50). Its callers: `createLocalEvaluator` (`solver.ts:400-406`; its only other caller is `solver.bench.test.ts:11`) gains a FIFTH optional `options` parameter (after `expectimax`) and passes it through, and
    `web/src/engine/sim/driver/solverWorker.ts:18` passes `{ levelCap, ignoreCap }` read from `workerData`; existing calls without the parameter behave as today. The move pool filter
    `learnableMoves` (`solver.ts:112`) uses the resolved level (the level the rule above resolves, which equals the cap only when `--level` is omitted); the evolution-level warning of Design decision 5 is printed before the search starts. Solver specs always carry an explicit level (`defaultSet` sets `.level`,
    `solver.ts:232`), set from the resolved level, so in the solver the cap acts through that resolution and the throw-above-cap path of Step 2.1; the default-to-cap path of Step 2.1 is reached only by direct `buildPlayerParty` callers.
3.2 `web/src/engine/sim/driver/solverCli.ts` has an existing `--level` flag (default 50, `:3, :38`): the default changes from 50 to "the fight's cap when absent" for placed rows only, per the rule above; the cap
    comes from `levelCapForTrainer`. New flag: `--ignore-cap` (the earlier `--badge-scenario min|max` is dropped: under the fixed route each fight has one badge value, Step 1.2). BOTH values reach the worker
    threads: `solverCli.ts:64` builds `workerData` (today `{ trainerId, tier, battleEvents }`) and gains `levelCap` and `ignoreCap`; `solverWorker.ts:8-12` destructures them and `:18` passes them to `scoreTeam` as its ninth parameter.
    The existing `--gym N` flag (`solverCli.ts:43`, feeding `availableStones(data0, gym)` at `:47`) is independent of the row: if it disagrees with the row's StageKey (N - 1 != the row's badge count) the CLI prints a WARNING
    and keeps the `--gym` value for Mega stones; D5 does not change that, and D4 Step 3.1 owns the fix (Mega gating from the StageKey).
    The report states: the cap and the badge value; the row's evidence label, printed as the literal `script` or `player-observed (Yoshi), not in the scripts at pin bdebcbbf` (gym rows 1-4 and 6-8 print the latter, because their
    position is the fixed gym order; Norman's row prints `script`, Decision 2 (i)); the Elite cap mode (Decision 3); any `--ignore-cap` use; the excluded rows (by trainer id, with their `excluded` text) and the deferred rows (by trainer id, `deferred (v1 scope)`); and the out-of-scope TM/tutor note.
    **How the label is derived.** The label is `player-observed (Yoshi), not in the scripts at pin bdebcbbf` if the row's `evidence` string contains that literal, else `script`. d5-1c must therefore keep Norman's
    evidence free of that literal (it states his position through the script checks at `PetalburgCity_Gym/scripts.pory:1719/1731/1743` only). A single-trainer run (`--trainer`) lists ALL excluded and deferred rows of the table, not only the requested row.

### Step 4 - tests (hand-derived from the C)
4.1 Cap behaviors only (the gate itself is already covered, see 2.2): a fight row's `highestBadge` -> `levelCapFor` -> `buildPlayerParty` default level; a spec above the cap throws; `ignoreCap` passes;
    the table test that every boss trainer id is covered.
4.2 A with/without comparison that isolates the gate: the same species at the SAME level (16) under tier Elite versus tier Ace (Ace never gates), same opponent, so the only difference is innate slots 2 and 3,
    and the result differs in an output number (the enemy level moves with the player's, `web/src/engine/sim/driver/session.ts:260-261`, which is why level 16 versus 50 would not isolate it). Changing tier also changes the opponent party
    (`buildOpponentParty` picks `parties[tier]`, `driver/buildParty.ts:84-89`), so the opponent must be a trainer whose `ace` and `elite` parties are identical: the synthetic one in
    `cycle144InnateGate.test.ts:66-73`, or one of the three real ones listed at `boss-fight-coverage.md:68` (`TRAINER_MAY_ROUTE_103_TORCHIC` is deferred and `TRAINER_WALLY_VR_2` excluded from solver runs, but a unit test may still use their parties; `TRAINER_GRUNT_MUSEUM_1` is neither); the test asserts the two parties are equal before comparing. The player species is chosen by a rule the test asserts, not by memory: a `species.json` entry whose innate slots 2 and 3 are both non-null
    and whose slot-3 ability changes the damage of a fixed move against that opponent (found by scanning `abilityHooks.json` for a damage-calculation hook on that ability and then checking the number
    differs between the gated and ungated builds before the test is committed); the test asserts both innate slots are non-null and that the compared damage values differ, so it cannot pass for an unrelated reason.
4.3 `levelCapFor(0..9)` table tests and the evolution-level warning on hand-built species (a species whose chain evolves at 36 yields a warning at cap 16 and the run continues; a species with no evolutions yields none).

### Step 5 - docs and inventory
5.1 Update `plan.md` (fixed inputs), `er-level-asymmetries.md` (the builder now applies the cap), the solver docs, and the STATE.md D5 line. Check `docs/battle-sim/environment-inventory.md` and
    `web/src/engine/sim/driver/environmentInventory.test.ts` for a level-cap row that moves from unported to ported, and update the pinned counts in the same change.

## Verification
`npx tsc -b web`, `npm --prefix web test -- --run` (the full suite), `npm --prefix web run build`, and the two sim audits through `.omc/team-pilot/validate.sh` (there is no root `package.json`); singles smoke
unchanged when no cap is passed; plus the Step 4 tests.
The fight-to-badges table is verified by reading the cited script lines, not by counting.

## Risks / open questions
- **Story order**: the gym order is a fixed route (Yoshi, 2026-11-17; badge 6 required at `EverGrandeCity_PokemonLeague_1F/scripts.pory:56`; the order 2 -> 3 -> 4 is player-observed (Yoshi), not in the scripts at pin bdebcbbf),
  so gym fights have no range. Non-gym fights of route steps 1-40 are placed by `story-route.md` (Yoshi's route, labelled player-observed where the scripts do not show it). The risk left is the two Wally Victory Road
  rows, `excluded` as buggy in the pinned version (Step 1.2 refusal), and the open items of `story-route.md` (whether Wally Mauville is mandatory; May 2 kept optional).
  The solver reports the badge value it used and its evidence label.
- **Stale citations to replace in d5-1c**: the evidence strings of the Winona, Tate and Liza and Juan rows citing `EverGrandeCity_PokemonLeague_1F:40` as "badge 6 is the only badge that can be skipped", and
  **Winona's `mandatoryCitation`** (`fights.ts:151`), which rests on the `:40-41` comment ("Its assumed the player has the remaining badges"); the replacement is the `FLAG_BADGE06_GET` check at `:56` plus the literal label `player-observed (Yoshi), not in the scripts at pin bdebcbbf`.
- **Boxed over-cap mons** are legal in the game; the default-off `ignoreCap` covers them but every use is reported.
- **Early fights dominate the effect**: only fights at 0 or 1 badges (caps 16 and 23) lose innate slots; from 2 badges (cap 36) nothing is gated at the cap. Step 1's table
  decides exactly which fights; the count in `er-level-asymmetries.md` is an estimate until then.
- **Difficulty**: assumes Elite (the default in `session.ts:249`); Ace never gates, so an Ace run would differ.
- **Level-cap setting**: uses the Elite table, confirmed by Yoshi (Decision 3); a player on Easy, More or Off would have higher caps, so the report prints the setting.
- **Out of scope**: Easy/More/OFF level-cap tables, EV rules (`er-level-asymmetries.md:22-33`), partner mons (covered by `doubles-plan.md` step 2.7).
