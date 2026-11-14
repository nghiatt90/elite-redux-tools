# Plan: Strict level caps per fight and player innate gating (D5)

_Status: APPROVED by a cold Opus reviewer after 3 rounds (round 1: badge flag versus count, undefined fight key, contradictory API, no evolution mechanism; round 2: evolution check would reject legal teams, Elite-vs-Ace test confounded by the opponent party; round 3: APPROVED). Not yet committed or executed. Vikunja task 63. Planning only: no sim code is changed by this document._

## Goal

For each of the 40 fights the sim builds the player's party under the game's real level rules: the player's levels are bounded by the
Strict level cap for the badges held at that point in the story, and the player's innates are gated by those levels (slot 2 off below 17,
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
  none -> 0). The Strict table (`LEVEL_CAPS_ELITE`) is `{16, 23, 36, 45, 50, 55, 60, 70, 80, 100}` (`:4656`). `levelCaps` is a save setting
  (constants `include/constants/global.h:145-148`, save field `include/global.h:590` `u16 levelCaps:3`); `OFF` falls into the Easy table (`default:` at `:4659`). The index is the HIGHEST
  badge flag held, not a count: `getHighestBadge` returns the highest `FLAG_BADGE0x_GET` that is set (its comment at `:4633`: "unless they skipped Winona"), so holding badge 7 without badge 6 indexes 7.
- The cap limits how high the player can LEVEL (exp gain `battle_script_commands.c:3511-3516`, candies `pokemon.c:2580-2599`); it does not stop a
  mon above the cap from being sent out. Enemy level = `GetHighestLevelInPlayerParty()` (`battle_main.c:1819-1827`).

### Sim
- `innateGate.ts` already has the thresholds, `innateSlotsFor`, `gateInnates`, the Strict table and `levelCapFor(badges)` (throws outside 0..9).
- `driver/session.ts:239-250` gates every player mon with `gateInnates(innates, level, tier)` (tier defaults to `'elite'`) and leaves the opponent untouched;
  `formChange.ts` re-gates after Mega. `cycle144InnateGate.test.ts` covers Elite 1/16/17/23/24 and Hell 9/10/16/17/23/24, Ace keeps all three, the AI keeps
  all three, Mega gating, and `levelCapFor`.
- Gaps: `levelCapFor` has no caller outside tests; `buildPlayerParty` defaults every level to 50 (`driver/buildParty.ts:164,173`) and copies raw innates
  (gating happens later in `createSession`); `solver.ts:419` takes the team's max level (default 50) with no cap input and `scoreTeam` has no badge or cap
  parameter; the fight data has no badge field (`boss-fight-coverage.md` lists no badge counts; a prior handoff, `.omc/handoffs/2026-11-04-battle-sim-audit-completeness.md`, also records the badge count per fight as not in the repo).
- `docs/battle-sim/er-level-asymmetries.md:9-21` records the gate and the cap tables; its `:38-39` says lowering the party's maximum level is monotonically
  bad for the player, which is why the cap is the player's upper bound.

## Design decisions

1. **The cap is an upper bound, and the default player level in a fight is the cap.** The best the player can do is sit at the cap (monotonic per
   `er-level-asymmetries.md:38-39`), so the builder/solver default for a fight is `levelCapFor(badgesAt(fight))`; a caller may pass lower levels
   (they get gated accordingly) but never higher unless an explicit `ignoreCap` is passed (boxed over-cap mons are legal in the game, so the escape hatch exists
   but is off by default and reported when used).
2. **The table stores the highest badge flag held, keyed by trainer id.** `fightBadges.ts` under `web/src/engine/sim/driver/` has rows `{ trainerIds: string[], highestBadgeMin, highestBadgeMax, evidence }`
   where the badge values are the `getHighestBadge()` return value (0..9; 9 = `FLAG_SYS_GAME_CLEAR`), NOT a count. The key is the trainer id because that is what the solver already takes (`--trainer`) and what
   `bossSet.ts` exports: `loadBossTrainerIds` returns 55 trainer ids for the 43 script-level fights (`boss-fight-coverage.md:66`; "40 fights" is STATE.md's target-set wording for the same set); multi-id fights
   (Juan + Wallace, Space Center 5/6/7) are one row listing all their ids. Gym 8's own ten ids (Tiffany plus three groups, `boss-fight-coverage.md:165-172`) share one row DELIBERATELY because they occur at the same badge
   state (before badge 8). There is no separate fight id. Each row cites the script lines or flag guards that fix the story position (e.g. `!(flag(FLAG_BADGE08_GET))` on the Juan rows in `encounters.json`
   `tagBattles`); rows that cannot be tied to a flag are marked `inferred` and listed for review; none is taken from the usual Hoenn order without a script check (this ROM hack reworks story order, e.g. `VictoryRoadRework`).
3. **Strict is the only table ported**, because `levelCapFor` takes only a badge index (`innateGate.ts:41`); no other table is selectable and no error path for one is added.
4. **Tier stays a parameter** (`ace|elite|hell`, default `elite`) so the existing behaviour is unchanged. For innates, Hell changes only slot 1 (level 10), below every cap. The badge table will also feed the
   badge-gated Hell flags (badge 2 damage reduction, badge 3 extra levels, badge 5 zero IVs, `docs/battle-sim/environment-inventory.md:169-176`); that is a follow-up, not part of D5.
5. **Evolution level is a WARNING, never a rejection.** The solver takes species straight from `--team` (`solverCli.ts:99`) and never checks evolution. From `species.json` `evolutions: [{level, to}]` (e.g.
   `{"level":16,"to":"SPECIES_IVYSAUR"}`) the inverse graph gives `evolveLevel(species)` = the largest evolution `level` along its chain (ER's `Evolution` message has only `to`/`level`/`gender`,
   `er-config/SpeciesList.proto:44-48`; a missing `level` is 0, so there is no "unknown stone" case). A team member whose `evolveLevel` exceeds the cap is REPORTED in the solver output ("needs level N, cap is M")
   but the run is not stopped, because the level is not the only way to obtain a species: the upstream wild tables list evolved species at low levels (`src/data/wild_encounters.json:2644-2661` has wild
   `SPECIES_PIDGEOTTO` at levels 2-3 although Pidgey evolves at 16), and gift or trade mons are not considered either. Using `wild_encounters.json` for real availability is a possible later extraction (it is on disk at
   the pinned SHA but not in the committed data) and is out of scope for D5. Level-up moves already follow level (`learnableMoves` `solver.ts:112-121`). TM and tutor availability is story-gated too and is OUT of scope:
   `learnableMoves` adds the full tutor list regardless of level, and this is stated in solver output.

## Steps

### Step 1 - fight-to-badges table (data, read-only research first)
1.1 For each fight row in `boss-fight-coverage.md` (`:71-190`) determine which `FLAG_BADGE0x_GET` flags can be set when it occurs, and from that the lowest and highest possible
    `getHighestBadge()` value, using the map scripts under `pipeline/.upstream/eliteredux-source/data/maps/` (flag guards, `FLAG_BADGE0x_GET` checks, `VAR_*` progression variables) and `encounters.json`
    guards. Work out WHICH flags are set (a skipped gym changes the index), not how many. Record `{trainerIds, highestBadgeMin, highestBadgeMax, evidence}`.
1.2 Where min != max (the player can do the fight at different points), the table stores the range and the solver treats the cap as a scenario parameter (default: the minimum, i.e. the tightest cap,
    reported with the badge assumption).
1.3 Add `fightBadges.ts` plus a test that every id returned by `loadBossTrainerIds` (`driver/bossSet.ts:11-45`) is in exactly one row and every row has non-empty evidence.

### Step 2 - apply the cap in the builder
2.1 `buildPlayerParty`'s signature is positional, `buildPlayerParty(specs, defaultLevel = 50, bundle)` (`driver/buildParty.ts:162-166`) with about 47 callers. Add a FOURTH optional parameter
    `options?: { levelCap?: number; ignoreCap?: boolean }`; nothing existing changes. Without `options` (or without `levelCap`) behavior is exactly today's (default level 50, no cap check). With `levelCap`:
    a spec with no level defaults to the cap, a spec level above the cap THROWS unless `ignoreCap` is set (there is no clamping), and `ignoreCap` use is reported by the solver.
2.2 `createSession` keeps gating at session build (`session.ts:239-250`). The existing `cycle144InnateGate.test.ts:75-147` already runs `buildPlayerParty` -> `createSession` at Hell 9/10/16/17/23/24 and Elite
    1/16/17/23/24, including Ace and the AI keeping all three, so no gate tests are duplicated; new tests cover only the cap behaviors (default-to-cap, throw above cap, `ignoreCap`).
2.3 `levelCapFor` gets its first production caller (`fightBadges` lookup).

### Step 3 - solver and CLI
3.1 `scoreTeam` takes the cap and passes it as `options.levelCap` to `buildPlayerParty` (`solver.ts:419-420`, which today takes the team's max level, default 50); the move pool filter
    `learnableMoves` (`solver.ts:112`) uses the capped level; the evolution-level warning of Design decision 5 is printed before the search starts. Solver specs always carry an explicit level (`defaultSet` sets `.level`, `solver.ts:232`), so in the solver the cap acts only
    through the throw-above-cap path and the CLI's `min(cap, --level)`; the default-to-cap path of Step 2.1 is reached only by direct `buildPlayerParty` callers.
3.2 `solverCli.ts` has an existing `--level` flag (default 50, `:3, :38`): when the fight is a boss fight with a table row, the cap comes from `fightBadges` and `--level` may only lower it (a value above the cap
    is an error unless `--ignore-cap`); with no table row (an arbitrary trainer id) `--level` behaves as today. New flags: `--badge-scenario min|max` and `--ignore-cap`. The cap reaches the worker
    threads because `solverCli.ts:64` builds the `workerData` object and `solverWorker.ts:8-18` calls `scoreTeam` with it; both carry the cap. The report states the cap, the badge assumption, and the out-of-scope
    TM/tutor note.

### Step 4 - tests (hand-derived from the C)
4.1 Cap behaviors only (the gate itself is already covered, see 2.2): a fight row's `highestBadge` -> `levelCapFor` -> `buildPlayerParty` default level; a spec above the cap throws; `ignoreCap` passes;
    the table test that every boss trainer id is covered.
4.2 A with/without comparison that isolates the gate: the same species at the SAME level (16) under tier Elite versus tier Ace (Ace never gates), same opponent, so the only difference is innate slots 2 and 3,
    and the result differs in an output number (the enemy level moves with the player's, `session.ts:249-250`, which is why level 16 versus 50 would not isolate it). Changing tier also changes the opponent party
    (`buildOpponentParty` picks `parties[tier]`, `driver/buildParty.ts:84-89`), so the opponent must be a trainer whose `ace` and `elite` parties are identical: the synthetic one in
    `cycle144InnateGate.test.ts:66-73`, or one of the three real ones listed at `boss-fight-coverage.md:68`; the test asserts the two parties are equal before comparing. The player species is chosen by a rule the test asserts, not by memory: a `species.json` entry whose innate slots 2 and 3 are both non-null
    and whose slot-3 ability changes the damage of a fixed move against that opponent (found by scanning `abilityHooks.json` for a damage-calculation hook on that ability and then checking the number
    differs between the gated and ungated builds before the test is committed); the test asserts both innate slots are non-null and that the compared damage values differ, so it cannot pass for an unrelated reason.
4.3 `levelCapFor(0..9)` table tests and the evolution-level warning on hand-built species (a species whose chain evolves at 36 yields a warning at cap 16 and the run continues; a species with no evolutions yields none).

### Step 5 - docs and inventory
5.1 Update `plan.md` (fixed inputs), `er-level-asymmetries.md` (the builder now applies the cap), the solver docs, and the STATE.md D5 line. Check `docs/battle-sim/environment-inventory.md` and
    `environmentInventory.test.ts` for a level-cap row that moves from unported to ported, and update the pinned counts in the same change.

## Verification
`npx tsc -b web`, `npm --prefix web test -- --run` (the full suite), `npm --prefix web run build`, and the two sim audits through `.omc/team-pilot/validate.sh` (there is no root `package.json`); singles smoke
unchanged when no cap is passed; plus the Step 4 tests.
The fight-to-badges table is verified by reading the cited script lines, not by counting.

## Risks / open questions
- **Story order**: the cap depends on badges held, and this hack's order is not guaranteed to match vanilla (`getHighestBadge`'s comment: "unless they skipped Winona",
  `pokemon.c:4633`). Fights outside the strict order get ranges, and the solver reports the assumption.
- **Boxed over-cap mons** are legal in the game; the default-off `ignoreCap` covers them but every use is reported.
- **Early fights dominate the effect**: only fights at 0 or 1 badges (caps 16 and 23) lose innate slots; from 2 badges (cap 36) nothing is gated at the cap. Step 1's table
  decides exactly which fights; the count in `er-level-asymmetries.md` is an estimate until then.
- **Difficulty**: assumes Elite (the default in `session.ts`); Ace never gates, so an Ace run would differ.
- **Out of scope**: Easy/More/OFF level-cap tables, EV rules (`er-level-asymmetries.md:22-33`), partner mons (covered by `doubles-plan.md` step 2.7).
