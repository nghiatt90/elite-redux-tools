# Plan: trainer chains without healing (D3)

_Status: APPROVED by a cold Opus reviewer after 3 rounds (round 1: PP is refilled at battle end, Juan is not data-derivable; round 2: stale Goal/Verification wording; round 3: APPROVED). Not yet committed or executed. Vikunja task 61. Planning only: no code is changed by this document._

## Goal

Fights that the game forces back to back with no heal between them are evaluated as one chain: the player's HP, `status1` and fainted mons carry from each
fight into the next (PP and held items are restored by the game between battles, see Context), a chain is won only if every stage is won, and the five singles chains are derived from the game's own data
(`trainerChains`) while Juan's two-stage chain is a cited, hand-written table.

## Context (verified facts)

### Which chains are in scope
`data/v2.65beta/encounters.json` `trainerChains` has 8 entries (emitter `pipeline/src/erdata/encounters.py:980-1004` `_find_chains`; `healFree` is true iff
`FLAG_SYS_DISABLE_AUTOHEAL` is set at every member's call site except the first, `:996-1000`). Tag battles (`starttagbattle`) are deliberately excluded from it and go to
`tagBattles` (`:219-223`). In the 40 fights (`docs/battle-sim/boss-fight-coverage.md`):

| Chain | Source | Heal before first | No heal between | Notes |
|---|---|---|---|---|
| Archie, Oceanic Museum: `GRUNT_MUSEUM_1`, `GRUNT_MUSEUM_2`, `ARCHIE_SLATEPORT` | `trainerChains` | yes (`SlateportCity_OceanicMuseum_2F/scripts.pory:13-14`; the heal before Archie is commented out `:69`) | yes | `healFree: true` |
| Space Center 2F grunts: `GRUNT_SPACE_CENTER_5/6/7` | `trainerChains` | yes (`MossdeepCity_SpaceCenter_2F/scripts.pory:69-70`) | yes | `healFree: true`; the Maxie+Courtney multi fight (`multi_2_vs_2` at `:275`, heal at `:264`) is a separate fight (see `doubles-plan.md`) |
| Gym 8 groups (bottom/middle/top): `BRIDGET,CRISSY,BETHANY`, `DAPHNE,CONNIE,ANDREA`, `OLIVIA,BRIANNA,ANNIKA` | `trainerChains` | first fight healed, flag set after it (`SootopolisCity_Gym_1F/scripts.pory:545-549`, `:603-607`, `:652-656`) | fights 1->2->3 | only `multichoice2` case 1 is a chain; cases 2-4 are a solo fight then a two-on-one tag battle with auto-heal on (`:551-561`), so each is healed |
| Juan stage 1 -> stage 2: `JUAN_1`+`WALLACE`, `JUAN_5`+`WALLACE_5` | `tagBattles` (NOT `trainerChains`) | yes (`:275`) | yes: flag set `:276`, stage 2 starts from `Juan_Battle_2` (`:286-290`), cleared `:279`/`:301` | both stages are tag battles, so the chain needs the doubles work (M2 of `doubles-plan.md`) |

Not in scope: Winstrates (`Route111`) and Sky Pillar chains (not in the 40 fights); Wally (`VictoryRoadRework`, `healFree: false`: effectively healed, so two fresh fights).

### What carries between consecutive battles (C)
- The heal is a battle-START gate: `if (!FlagGet(FLAG_SYS_DISABLE_AUTOHEAL)) HealPlayerParty();` (`src/battle_main.c:844`, again `src/pokemon.c:2120`). `CB2_EndTrainerBattle`
  does no cleanup (`battle_setup.c:1298-1316`).
- Persisted through the party array: HP (0 = fainted stays fainted) and `status1` (written by `SetPlayerMonData`, `battle_controller_player.c:3802-3840`).
- **PP does NOT persist.** At the end of every battle `CalculateMonStats` runs on every party mon (`battle_main.c:4845-4852`, `B_RECALCULATE_STATS` is `GEN_7`,
  `battle_config.h:33`); `CalculateMonStats` is `CalculateMonStatsMaster(mon, TRUE, FALSE)` (`pokemon.c:965`), which sets every move's PP to base PP when `shouldRestorePP`
  (`:1012-1017`) and then calls `MonRestorePP` (`:1019`), restoring PP to the maximum including PP bonuses. So every chain stage starts with full PP; a PP-stall or
  Struggle-dependent line cannot carry over.
- HP after the end-of-battle recompute (`pokemon.c:1027-1043`): a fainted mon (HP 0, old max HP non-zero) returns early and stays at 0; any other mon gets
  `hp += newMaxHP - oldMaxHP`, floored at 1 (Shedinja is forced to 1). This only matters when a form revert changes max HP (Mega, primal, origin, HP-threshold forms).
- Reset at battle end: Mega evolution and form changes are undone for all slots (`battle_main.c:4829-4831`); stat stages, weather, terrain, screens, hazards and `status2` live in
  battle structs and are fresh each fight.
- Not carried but also not modelled: the battle-won revive at `battle_main.c:4675-4683` (a fainted active battler with a pending onRevive ability, Recurring Nightmare in fog or
  Backup Power on Electric Terrain at `abilities.cc:7896-7902`, `:10929-10935`, is set to max HP/4 in the party). The sim has no `HandleEndTurn_BattleWon` equivalent; `carryParty`
  lists it as an explicit exclusion unless a later cycle ports it.
- Held items are RESTORED after every trainer battle: `B_RESTORE_ALL_ITEMS` is `TRUE` (`include/constants/battle_config.h:189`, "including berries, even if not stolen"), and
  `TryRestoreStolenItems` (`battle_util.c:8478-8498`, called at `battle_main.c:4827` for trainer battles) sets each party mon's item back to `itemStolen[i].originalItem`,
  captured at battle start (`battle_main.c:2781`). So a consumed Sitrus Berry or Focus Sash is back for the next fight; HP is not.
- Lead selection for the next fight (singles): `SetBattlePartyIds` (`battle_controllers.c:615-675`) takes the first party slot passing `IsValidForBattle` (hp != 0), not the
  previous active mon.
- Whether the party ORDER changes during a fight is not verified here (Step 0.1).

### Sim today
- `driver/session.ts:238-300` `createSession` deep-copies the player party and starts from `playerParty[0]`; `toBattleMon` (`:75-97`) accepts a pre-damaged `SimPartyMon` (hp, pp, itemId,
  status1) and zeroes `statStages`/`status2`. `SimPartyMon` is `state.ts:442-480`.
- End-of-fight sync gaps: HP syncs continuously (`outcome.ts:41-46`); `status1`, `pp`, `itemId` are copied to the party slot only on switch-out (`turn.ts:1839-1853`), so the mon still
  active at the end must be read from `state.battlers[0].mon` for `status1`; a Mega or form-changed active mon has been written to its party slot (`formChange.ts:356-363` writes
  `speciesId`, `types`, `abilities`, `rawStats`, `maxHp`, `hp`), so the revert must overwrite those fields from `startParty`, not only from the live battler.
- `createSession` runs `gateInnates` on the cloned party (`session.ts:245-247`), so a carried party fed back in would be gated twice; the carry keeps `abilities` from `startParty` (ungated),
  so the gate is applied exactly once per stage.
- `driver/runBattle.ts:138` returns only an outcome; `driver/expectimax.ts:1175` `playExpectimaxBattle` returns `{outcome, turns, finalScore}` and builds its own session internally;
  neither exposes the final party. `driver/solver.ts:409-429` `scoreTeam` scores one team against one trainer (`FitnessEvaluator` at `:30`, `createLocalEvaluator` `:400`).
  `driver/battleEventSetup.ts` `eventsForFight(encounters, mapName, defeatedSet)` has no chain logic; battle-event guards read `defeated(...)`.

## Design decisions

1. **A chain is a list of fight specs plus start-heal rules.** `ChainSpec = { id, stages: FightSpec[] }` where stage 1 starts from a healed party and stages 2..n carry
   state. The five singles chains come from `trainerChains` (data-derived; filtered to the 40 fights by a boss-trainer-id set passed in as a PARAMETER, so `chains.ts` does not import
   `bossSet.ts`'s `node:fs` and stays drivable from a Web Worker per CLAUDE.md's layering rule). **Juan is not data-derived**: the emitter records the two Juan scripts as separate, unlinked
   `tagBattles` rows with no heal field (`pipeline/src/erdata/encounters.py:227-232`), and `TRAINER_JUAN_5 + TRAINER_WALLACE_5` also appears in the rematch script. Juan's two-stage list is
   therefore a small hand-written table citing `SootopolisCity_Gym_1F/scripts.pory:275-290` (heal `:275`, flag `:276`, stage 2 `Juan_Battle_2` `:286-290`, clear `:279`/`:301`), guarded by a test that
   fails if `encounters.json` `tagBattles` loses either row. (Extending the pipeline emitter to link continuations is a possible later change; it needs a `pipeline/` edit plus a data regeneration and
   is out of scope here.) Stage order for `trainerChains` is script order; a test asserts the `trainers` array order equals the call order in the script for every chain.
2. **`carryParty` is a pure function** `(startParty, endState) -> SimPartyMon[]` implementing exactly the C rules above: HP and `status1` from the live battler where one is active (else the party
   slot); fainted stay fainted; a Mega or form-changed mon is reverted by overwriting `speciesId`, `types`, `abilities`, `rawStats`, `maxHp` from `startParty`, with `hp += newMaxHP - oldMaxHP` floored at 1
   (fainted untouched, Shedinja 1) per `pokemon.c:1027-1043`; **PP reset to the maximum** (`MonRestorePP`; the sim does not model `ppBonuses`, `state.ts:45`, so the maximum is the `pp` in `startParty`, which is at maximum for stage 1 and stays there because every carry resets it; Step 0.4 confirms the build path yields maximum PP); the form-revert HP rule uses `oldMaxHP` = the end-state slot's `maxHp` and `newMaxHP` = `startParty[i].maxHp`; `itemId` restored from `startParty` (`TryRestoreStolenItems`); everything battle-scoped
   dropped. Explicit exclusion: the battle-won revive (`battle_main.c:4675-4683`).
3. **Lead is the first valid party slot** (HP > 0), matching `SetBattlePartyIds`. `createSession` gains a `leadIndex` (default 0 for singles so existing behavior is unchanged); the chain passes the
   first alive slot.
4. **Chain evaluation**: `scoreChain(data, chain, tier, team, games)`. Fixed choices: stage `k` of game `g` uses seed `seedOffset + g * 1000 + k` (independent streams per stage, same seeds for every candidate);
   a stage that ends in a loss, `DREW` or `MAX_TURNS` ends the game as a chain loss; a game's `meanScore` is the mean of the stage scores played with unplayed stages counted as -1 (the clamp floor used by
   `scoreTeam`); fitness is `winRate + 0.02 * meanScore`, the same form as `scoreTeam`, so the `FitnessEvaluator` type (`solver.ts:30`) is satisfied. `playExpectimaxBattle` and `runBattle` gain a
   `finalParty: SimPartyMon[]` field in their return value (the surviving party read from the final session); existing callers ignore it. The solver worker protocol is extended: `solverCli.ts:64` currently passes
   `workerData: { trainerId, tier, battleEvents }` (one trainer, one event set), so it carries a chain id and per-stage events for chain runs; `solverWorker.ts` is therefore part of Step 4.
5. **Gym 8 group branch** is the player's choice (`multichoice2`). Case 1 is the chain; cases 2-4 are healed independent fights (a solo then a tag pair) that need the doubles work. Until M2 lands only case 1
   is evaluable; once it lands the solver reports each branch and the chain verdict is the player's best branch, with every branch shown. Reporting default: case 1 (the only no-heal shape; no claim is made that it
   is harder than the tag-pair branches).
6. **Player bag items are not modelled** (the solver policy never uses the bag), so a chain result assumes no in-battle healing items. Stated in solver output, not silently assumed.
7. **Battle events**: a stage's `defeatedSet` includes the trainers beaten earlier in the same chain so `eventsForFight` guards behave as in the game.

## Steps

### Step 0 - verify the unverified inputs (read-only)
0.1 In `battle_main.c` (end of battle, `:4827-4852`) and `battle_controller_player.c`, confirm the party array order is not changed by in-battle switching, and that a fainted mon's HP 0 and `status1`
    survive to the next battle; record the lines. If order changes, the lead rule in decision 3 changes.
0.2 Confirm, for each in-scope chain, that no `special` heal, script `healparty`, or flag clear occurs between members besides what the table lists (read the cited script ranges end to end, including `:87`, `:102` clears).
0.3 Confirm `status1` packs toxic/sleep counters in the sim and the C the same way (so carrying `status1` carries the counters).
0.4 Confirm `MonRestorePP` (`pokemon.c:4211-4222`) restores to max PP including bonuses and that `ppBonuses` is not modelled in the sim (PP max is base PP under the sim's own rule); record the lines.

### Step 1 - expose the end state and the lead
1.1 `playExpectimaxBattle`/`runBattle` return `finalParty` (decision 4); existing callers ignore the new field (no change to singles results, test asserts equality of outcome/turns/finalScore).
1.2 `createSession({ leadIndex })`; default behavior bit-identical.

### Step 2 - `carryParty` and tests
2.1 Implement per decision 2. Tests with hand-derived values from the C lines above: HP carried; fainted mon stays out and is skipped as lead; **PP used in fight 1 is back at maximum in fight 2**;
    `status1` carried; a Berry consumed in fight 1 is back at fight 2; an active Mega is reverted to the base species with the `hp += newMaxHP - oldMaxHP` rule (and a fainted Mega stays 0); stat
    stages/`status2` reset; a mon that was never active equals its `startParty` slot; carrying a gated party does not double-gate.
2.2 Negative/with-without test: the same two-stage chain run with heal-between versus carry-over gives a different stage-2 result for a hand-built party (proves carry changes an output number).

### Step 3 - chain definitions from data
3.1 `chains.ts`: build `ChainSpec[]` from `trainerChains` (the five singles chains), filtered by the boss-id set passed in as a parameter, `healFree` chains only, stage order from script order; add the Juan pair from the hand-written
    table of decision 1 (not from `tagBattles`), with a presence guard that `encounters.json` `tagBattles` still contains both Juan rows.
3.2 Tests: the derived set equals the five expected chains (Archie museum, Space Center grunts, three gym 8 groups) plus Juan; Winstrates and Sky Pillar are excluded by the 40-fight filter; Wally is not a chain.

### Step 4 - evaluator and driver
4.1 `scoreChain` and the `FitnessEvaluator` wrapper; `solverCli.ts` accepts `--chain <id>` (chosen, not optional), each stage's `battleEvents` set from `eventsForFight` with the accumulated `defeatedSet`;
    `solverWorker.ts` and the `workerData` built at `solverCli.ts:64` carry the chain id and per-stage events (decision 4).
4.2 Smoke: each singles-only chain (Archie, Space Center grunts, gym 8 case 1 groups) runs to a chain outcome on a fixed seed; per-stage outcomes and the carried HP are printed.
4.3 Juan chain is wired only after `doubles-plan.md` M2; until then it is listed as blocked, not faked as singles.

### Step 5 - docs
5.1 Update `plan.md`, `solver.md` (chains section), `boss-fight-coverage.md` (a note linking the chain table), STATE.md D3 line.

## Verification
`npx tsc -b web`, full vitest suite, `npm run build`, both sim audits; singles smoke unchanged (Step 1 equality test); the Step 2 tests; the Step 3 derivation test is the guard that the five singles chains match `trainerChains` and that the Juan table's two `tagBattles` rows still exist.

## Risks / open questions
- **Heal semantics are per-script**: the emitter's `healFree` rule ("flag set at every member except the first") matches the three scripts read here, but a direct heal between members is a documented blind spot (`encounters.py:201-214`); Step 0.2 re-checks it.
- **Gym 8 branches 2-4** need doubles; the reported gym 8 verdict depends on which branch the player picks.
- **Party order after a fight** (Step 0.1) and **item restore** (`B_RESTORE_ALL_ITEMS`) and the end-of-battle stat recompute (PP refill and the HP-after-revert rule, verified at `battle_main.c:4845-4852` and `pokemon.c:965,1012-1043`) are the three C behaviours the carry function leans on; the order point is not yet verified.
- **No bag healing** is assumed (decision 6); a real player may heal in the battle menu at a turn cost, so a chain loss in the sim is not proof the chain is unbeatable.
- **Cost**: a chain of three fights is roughly three times a single-fight evaluation per game (`solver-evaluation.md` measures ~1.3-1.4 s per game per fight); the solver's search budget is re-checked in `docs/battle-sim/solver-v2-plan.md` (the D4 plan).
- **Out of scope**: Winstrates, Sky Pillar, Wally, Double Battle Mode, experience/level changes between stages (the player sits at the level cap, `innate-gating-plan.md`).
