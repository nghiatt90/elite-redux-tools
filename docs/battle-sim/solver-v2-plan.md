# Plan: solver v2, team selection, minimal gym trainers beaten, honest win probability (D4)

_Status: REVISED 2026-11-17 (third revision: route steps 29-40 from Yoshi, so no row awaits the route and the Wally VR rows are `excluded`; cold review round 2 applied: the candidate space is the reachable defeated sets under an explicit tag-battle outcome, the Lavaridge by-id fallback is gone, Mossdeep's count is 0..6 by construction, layered enumeration, the full-set-`won` case, seed reuse); NOT yet re-reviewed. Second revision: fixed route, after cold review round 1. Not yet committed or executed. Round 1 of the fixed-route review (NEEDS WORK) rewrote decisions 2, 3, 5, 8, 10 and 12, Steps 0.5, 1.0 and 3.1-3.3: the defeated set is now chosen on tuning seeds and confirmed on report seeds, one tie-break rule, open-stage fights handled through `story-route.md`, StageKey drives Mega gating, and the real `fights.ts` format enum. History before that: REVISED 2026-11-17 after Yoshi correction (fixed route, gym-trainer loop). Earlier: the gym-subset version was APPROVED by a cold Opus reviewer after 3 rounds (round 3: APPROVED; its four non-blocking notes applied); Yoshi then corrected two premises (gyms are a fixed route, none skippable; the loop is over optional gym trainers, not gyms), which rewrote decisions 1, 2, 7, 8, 12, Steps 0.5, 1.0 and 3, the tests and the risks. Before that: DRAFT 3 (draft 2: StageKey data undefined; fixed with a progression table and an explicit subset-to-StageKey rule). Earlier: DRAFT 2 (draft 1 got NEEDS WORK: Mega availability keyed wrongly, no multi-fight objective, repeated-look interval, seed overlap with chains, no search log, widePool undecided, fight unit undefined, fragile test undefined; all reworked), not yet re-reviewed.
Vikunja task 62. This is the D4 design doc (the earlier driver plan `.omc/plans/driver-d6-d5-audits-d4.md` called it `solver-design.md`). Planning only: no code is changed by this document. Depends on
`innate-gating-plan.md` (D5), `chains-plan.md` (D3), `doubles-plan.md` (D1+D2) and, for Step 3 (queue item d4-4), the story-route table `docs/battle-sim/story-route.md` (written 2026-11-17: steps 1-40 from Yoshi's route; the two Wally Victory Road rows are `excluded`, decision 1); the statistics, report and sensitivity parts on singles fights can start first._

## Decisions pending Yoshi (2026-11-17)

Items 1, 2 and 5 are answered; 3 and 4 are open and this plan decides neither.
1. **Difficulty tier**: ANSWERED by Yoshi: `elite` (the data tiers are `ace` / `elite` / `hell`; `solverCli --tier` defaults to `elite`).
2. **Level-cap mode**: ANSWERED and verified: the menu's 'Elite' cap mode is `LEVEL_CAPS_ELITE`, which selects the table `levelCapsStrict = {16, 23, 36, 45, 50, 55, 60, 70, 80, 100}` (`src/pokemon.c:4649-4671`, comment '// Elite'); this plan calls it the 'Elite' table (see `innate-gating-plan.md` decision 3).
3. **EVs**: Yoshi says `enableEvs` is ON and the solver must solve the EV distribution (252 per stat, 510 total: `include/constants/pokemon.h:326-327`); today `solver.ts:32` `EV_TEMPLATES` plus `:293-295` swap only a few fixed templates (8 EV templates in the neighbours). EV distribution search: out of scope of D4/D5 as written; to be planned separately after discussion with Yoshi; do not implement.
4. **Compute budget for the full run** (decision 12: the gym-trainer search ceiling plus build tuning, versus lowering the per-set game cap from 400 to 200): to be discussed with Yoshi; the EV search will multiply D4's cost, so do not decide it.
5. **D6 coverage dependency**: `@vitest/coverage-v8` ALLOWED by Yoshi.

## Goal

Answer, for the boss fights (43 script-level fights over 55 trainer ids, `boss-fight-coverage.md:66`; STATE.md calls the same set "the 40 fights"), "does this team win this fight, and what should change", with an honest
win probability, and find the fewest optional gym trainers the player must beat before the gym leaders for a full clear. Decisions from Yoshi (2026-11-15, corrected 2026-11-17): the gyms are a **fixed route** (gym N requires gyms 1..N-1; all 8 are
required; none is skippable or reorderable), so every gym fight has exactly one story stage (non-gym fights whose stage gym order does not fix are handled by the open-stage rule of decision 1); the search loop is over **which optional gym trainers are beaten before each leader** (beating them removes battle events from the leader fight) and finds the
**fewest gym trainers beaten such that every mandatory fight is `won`**; a fight counts as **won when the lower end of the
95% interval is at least 0.90**, **lost when the upper end is below 0.50**, and **uncertain** otherwise (with a sample-size prompt); a bare point estimate is never a verdict (`plan.md:146-148`).

## Context (verified by a read-only survey and a cold review, 2026-11-15)

### Solver today
- `driver/solverCli.ts`: `--trainer` (one id) and `--team` (six species) required; `--level` (default 50, `:38`), `--tier` (elite), `--workers`, `--passes`, `--confirm`, `--screen`, `--out`, `--gym N`, `--map`, `--defeated`,
  `--stones` (`:44-48`). `--gym N`/`--stones` feed Mega availability (`stoneAvailability.ts`); `--map`/`--defeated` select battle events (gym puzzle guards depend on which trainers were beaten, so `defeated` is an input
  besides the cap). Output: console lines, `{trainerId, tier, fitness, fresh, team}` JSON (`:117`), "fresh seeds (40 games): win X score Y" (`:115`): a point win rate, no interval, no diff.
- Search: `defaultSet` (`solver.ts:197-239`) then coordinate ascent `improveTeam` (`:350-397`, returns only `{team, fitness}` and free-text `onProgress` strings: it keeps NO per-neighbour record) over single-attribute neighbours (Mega/base
  form `:241-254,278-284`, ability, one of 20 items `ITEM_POOL` `:55`, 9 natures `:43`, 8 EV templates `:32`, one move slot from `candidateMoves` up to 40 damaging plus 32 utility moves `:78`), capped at `maxNeighbours` 120 by a
  deterministic shuffle (`:334,:365`). Species is never changed. Screen 4 games per neighbour, top 3 confirmed on 16 games (`DEFAULT_SEARCH` `:328`), accept on a gain of at least 0.01, 2 passes.
- Scoring (`solver.ts:25-30, 409-429`): `fitness = winRate + 0.02 * meanScore`, one fixed fight per `FitnessEvaluator`/`scoreTeam`; the same seeds for every candidate (`seedOffset+1..games`); party built with
  `buildPlayerParty(team, level = max team level)`, `maxTurns` 60. The final check uses seeds 1001..1040 (`solverCli.ts:114`). Each worker is pinned to one trainer, tier and `battleEvents` (`solverWorker.ts:8-19`).
- Mega availability: no Mega exists until Norman hands over the Mega Bracelet in the Gym 5 script, and stones are gated by `megaBadgeRequirement` badge counts (`stoneAvailability.ts:5-13,31-50`). Today's signature is
  `stoneAvailability(item, gym)`: it computes `badges = gym - 1` and refuses every stone when `gym < 5` (`:31-36`), so the bracelet and the badge count are fused into one gym number. With the fixed route (decision 1) all three
  StageKey fields follow from the number of gyms cleared before the fight, but at 4 badges there are two StageKeys (`h4-n4-b0` and Norman's `h4-n4-b1`) and `gym = 5` gives both of them Mega, so the fused signature cannot tell them apart (Step 3.1 changes it).
- Play policy: depth-1 expectimax (`expectimax.ts:110`: depth 1, samples 6, innerSamples 2, switchMargin 0.05, statusTerms) against six sampled AI actions per option (`sampleOpponent` `:1070-1080`, which calls `chooseAiAction` for the
  policy's own model of the AI); replacement by the game's "most suitable mon" heuristic (`:1143`). About 1.3-1.4 s per game per fight single-threaded (`solver-evaluation.md:65-73`, noisy); depth 2 about 4x (`solver.md:24`).
  `solver.bench.test.ts:14` is a reduced single-threaded benchmark (screen 2, confirm 6, `maxNeighbours` 30, 1 pass), NOT solverCli with workers; no end-to-end solver time is documented.
- Seeds: mulberry32 (`rng.ts`); battle seed `seedOffset + g`; expectimax per-turn seed `seed*31 + turns` (`expectimax.ts:1191`). `chains-plan.md` decision 4 seeds stage `k` of game `g` as `seedOffset + g*1000 + k`.
- Known statistical limits: a team chosen on the tuning seeds is selection-biased (`solver.md:61-62`); the 24-battle check is about plus or minus 2 wins (`solver-evaluation.md:43,73`). `widePool` defaults to off and is "left to the solver
  design session (D4)" (`solver.md:54-55`, `solver-evaluation.md:86`, `.omc/plans/driver-d6-d5-audits-d4.md:108-109,130`).

### Gym trainers and the leader fight (read 2026-11-17)
`eventsForFight` (`driver/battleEventSetup.ts:17-51`) keeps a map's battle event when its guard is null or `!defeated(TRAINER_X)` with X not in `defeated` (`:32-40`); any other guard is dropped into `skippedGuards` (`:41-43`). `solverCli` takes `--map` and
`--defeated none|all|<ids>` (`solverCli.ts:45-58`). Rows come from `encounters.json` `battleEvents`. Per gym, from each gym's `CheckTrainers` script (called by the leader script before the battle):

| Gym | Guarded trainers (each `if (!defeated(X))` registers that trainer's events for the leader fight) | Choices |
|---|---|---|
| 1 Rustboro | MARC, TOMMY, JOSH (`RustboroCity_Gym/scripts.pory:498-517`; leader calls it at `:539`) | 2^3 = 8 |
| 2 Dewford | LAURA, TAKAO, CRISTIAN, JOCELYN, BRENDEN (`DewfordTown_Gym/scripts.pory:679-700`; `:698` comments "by entension TRAINER_LILITH too"). BRENDEN is the SECOND `starttagbattle` argument (`starttagbattle(TRAINER_LILITH, TRAINER_BRENDEN, ...)`, `:572`) | 5 battles, 2^5 = 32 |
| 3 Mauville | VIVIAN, KIRK, BEN, SHAWN (`MauvilleCity_Gym/scripts.pory:546-566`; `:563` comments ANGELO as covered by SHAWN). SHAWN is the FIRST argument (`starttagbattle(TRAINER_SHAWN, TRAINER_ANGELO, ...)`, `:522`) | 4 battles, 2^4 = 16 |
| 4 Lavaridge | JEFF, JACE, ELI, KEEGAN, COLE, GERALD, AXLE, DANIELLE (`LavaridgeTown_Gym_1F/scripts.pory:566-596`); COLE and KEEGAN are one tag battle, `starttagbattle(TRAINER_COLE, TRAINER_KEEGAN, ...)` (`:517`), and BOTH are guarded (KEEGAN, the second argument, at `:582`; COLE, the first, at `:585`) | 7 battles, 2^7 = 128 |
| 5 Petalburg | RANDALL, MARY, PARKER, ALEXIA, GEORGE, JODY, BERKE (`PetalburgCity_Gym/scripts.pory:1958-1986`) | 7 battles, 2^7 = 128 |
| 6 Fortree | JARED (comment: ASHLEY), FLINT (comment: EDWARDO), HUMBERTO, DARIUS (`FortreeCity_Gym/scripts.pory:485-503`, guards `:492`, `:495`). Both guarded tag ids are the SECOND argument: `starttagbattle(TRAINER_EDWARDO, TRAINER_FLINT, ...)` (`:410`), `starttagbattle(TRAINER_ASHLEY, TRAINER_JARED, ...)` (`:443`) | 4 battles, 2^4 = 16 |
| 7 Mossdeep | events depend only on a COUNT: `CalcDefeatedCount` (`MossdeepCity_Gym/scripts.pory:925-933`) calls `adddefeatedcount` on exactly ONE id per pair (`:926-931`), always the FIRST `starttagbattle` argument of that pair (SAMANTHA `:728`, MAURA `:761`, SYLVIA `:794`, KATHLEEN `:895`, MACEY `:861`, NATE `:827`; the partners BLAKE, PRESTON, HANNAH, NICHOLAS, CLIFFORD, VIRGIL appear only in comments), so the count is 0..6 whatever the macro does per call, provided each call adds at most one; `CheckTrainers` (`:935-966`) registers six events under `var(VAR_RESULT) < 1..6`. The sim drops these guards today (`battleEventSetup.ts:41-43`), so Tate and Liza currently get none of them | 7 counts (0..6) |
| 8 Sootopolis | no choice: `SootopolisCity_Gym_EventScript_CheckTrainers` (`SootopolisCity_Gym_1F/scripts.pory:477-499`) refuses the Juan fight unless all ten gym trainers are beaten; they are already mandatory rows (`boss-fight-coverage.md:165-172`), and no Sootopolis event has a `defeated` guard | 1 |

The leader's trainer id does not change with the count; the `adddefeatedcount`/`switch (var(VAR_RESULT))` blocks only pick intro text (e.g. `RustboroCity_Gym/scripts.pory:543-555`). Each map's events reach only that map's leader (`battleEventSetup.ts:30`),
so the seven gyms are independent searches. ESTABLISHED from the scripts: each commented partner is in the same `starttagbattle` as its guarded id (LILITH with BRENDEN `DewfordTown_Gym/scripts.pory:572`; ANGELO with SHAWN `MauvilleCity_Gym/scripts.pory:522`;
EDWARDO with FLINT `FortreeCity_Gym/scripts.pory:410`; ASHLEY with JARED `:443`; the six Mossdeep pairs `MossdeepCity_Gym/scripts.pory:728-895`), and in Lavaridge COLE and KEEGAN, BOTH guarded ids, are one tag battle (`LavaridgeTown_Gym_1F/scripts.pory:517`, reached from
both trainers' scripts `:496,508`). In four of the five gym tag battles a guarded id is the SECOND `starttagbattle` argument (Dewford BRENDEN, Fortree FLINT and JARED, Lavaridge KEEGAN); only Mauville's SHAWN is
first (Context table). Every gym's optional trainers are opt-in through `yesnobattle` (e.g. Lavaridge `:451-557`, Petalburg `:1854-1949`). NOT established (Step 0.5): the bodies of the `starttagbattle` and `adddefeatedcount`
macros (neither is in the sparse checkout), so (a) what `adddefeatedcount` does per call and (b) which of a tag battle's two ids it marks `defeated`: both, the first only, or the second only. Each trainer's own script checks its
own `defeated()` before re-offering the tag battle (`DewfordTown_Gym/scripts.pory:581` BRENDEN, `:593` LILITH; `LavaridgeTown_Gym_1F/scripts.pory:493` KEEGAN, `:505` COLE), which SUGGESTS both are set but is not proof.
Also not established: whether the gym layout forces the player into some trainers' sight lines despite the opt-in prompt (map layout, not script); and which side each event favours.
Separately, Juan's always-on `BATTLE_EVENT_TENSE_BATTLE` has guard `!(flag(FLAG_BADGE08_GET))` (`encounters.json`), which `eventsForFight` does not match and drops into `skippedGuards` (`battleEventSetup.ts:41-43`); it is true on the first Juan fight.

### Missing against the five acceptance items
| Item | Today | Building blocks |
|---|---|---|
| Species selection | none; species come from `--team` | `species.json` (`learnset`, `evolutions: [{level,to}]`, `megas`, `abilities`, `innates`, `baseStats`); `genericTeam.ts`; `matchupReport.ts` damage matrix |
| Minimal gym trainers beaten | none | `eventsForFight` and `solverCli --defeated` already select a leader's events from a defeated set; Mossdeep's count guards are dropped; `fights.ts`/`progression.ts` exist (d5-1/d5-1b) but still encode skippable gyms (`mayBefore`, `legalSubsets`) until d5-1c; `levelCapFor` unwired (D5) |
| Win probability with interval | bare `winRate` | `Fitness.games` (wins/games) |
| Sensitivity (fragile fights) | none | seeded RNG; `chooseAiAction` is the AI decision point |
| What-to-change | final team only | `PlayerMonSpec` field diff is possible; no search log exists |

### Data limits
- No species-availability-by-progression data in the COMMITTED data (`encounters.json` has only `battleEvents`, `fieldEffects`, `inverseBattles`, `tagBattles`, `trainerChains`), and no item availability data; `ITEM_POOL` is curated.
  Upstream wild tables are on disk (`pipeline/.upstream/eliteredux-source/src/data/wild_encounters.json`, e.g. wild Pidgeotto at levels 2-3 at `:2644-2661`) but are not extracted; availability stays unmodelled here.
- The fight list's badge state comes from the shared progression table (D5 Step 1, `fights.ts`); with the fixed route it is one value per gym fight; a non-gym fight gets one value, copied from `story-route.md` into `fights.ts` by d5-1c; `awaitingRoute` (none in the real table) and `excluded` rows are skipped (decision 1). TM and tutor availability is story-gated and not modelled.

## Design decisions

1. **StageKey is fixed per fight by the fixed route; the unit of evaluation is (fight, StageKey, defeated set).** A `StageKey = { highestBadge, badgeCount, braceletHeld }`: the cap depends on `highestBadge` (`GetLevelCap`, D5), Mega
   availability on the other two (gym 5 held, total badges), so `W` stays keyed by all three. **The route is fixed** (Yoshi, 2026-11-17): gym N requires gyms 1..N-1 cleared and all 8 are required. Badge 6 is required by the league door
   (`EverGrandeCity_PokemonLeague_1F/scripts.pory:56`, `goto_if_unset FLAG_BADGE06_GET, ..._NotAllBadges`); Norman requires badges 1-4 indirectly (the `case 3`-`case 5` badge checks at `PetalburgCity_Gym/scripts.pory:1719/1731/1743` gate the state change to the case-6 battle, `:1754-1763`); the order 2 -> 3 -> 4 is player-observed (Yoshi), not in the scripts at pin bdebcbbf, not a cited game
   fact. The comment at `EverGrandeCity_PokemonLeague_1F/scripts.pory:40` ("Winonas badge is the only one that can be skipped") and the one at `src/pokemon.c:4633` ("unless they skipped Winona") are stale leftovers and are evidence of nothing.
   **The progression table** (`progression.ts` + `fights.ts`, one table with two consumers, D5 Step 1; corrected by queue item d5-1c) has per fight `{ fightId, requiredBefore: gymNumber[], evidence }` with `mayBefore` empty for every gym row (non-gym rows: open-stage rule below),
   so there is no gym subset and no "cleared as early as possible" rule: a fight after gym k and before gym k+1 has `requiredBefore = [1..k]` and the single StageKey `highestBadge = k`, `badgeCount = k`, `braceletHeld = k >= 5` (the Mega
   Bracelet comes from Norman's Gym 5 script, `stoneAvailability.ts:5-13`). One exception already in the table: Norman's own fight has `holdsBracelet` (`fights.ts:133`) because the bracelet is handed over before that battle
   (`PetalburgCity_Gym/scripts.pory:1754-1763`), so it is `h4-n4-b1`. Giving `b0` to every OTHER fight between gym 4 and gym 5 is a modelling choice, not a game fact: the bracelet is handed over without a battle and the script ends
   (`:1754-1771`), so a player can take it, leave, and fight those trainers with it; the choice is stated in every report that contains such a fight. Hence at most 10 distinct StageKeys (`h0-n0-b0` .. `h4-n4-b0`, `h4-n4-b1`, `h5-n5-b1` .. `h8-n8-b1`); d5-1c reports the exact list from the corrected table and decision 12's
   cost scales with it. D5's cap reads the same single value (min = max).
   **Open-stage fights.** Gym order fixes the stage of every gym fight but not of every other fight: `fights.ts` still gives a non-empty `mayBefore` to rows such as `TRAINER_MAY_ROUTE_110_TORCHIC` (`:52-53`), `TRAINER_MATT` (`:227-228`), the Oceanic Museum chain
   (`:242-269`), `TRAINER_ARCHIE_MT_PYRE` (`:280-281`), `TRAINER_COURTNEY_METEOR_FALLS` (`:309-310`), `TRAINER_MAXIE_MT_CHIMNEY` (`:376-377`), `TRAINER_MAXIE_MAGMA_HIDEOUT` (`:388-389`) and `TRAINER_STEVEN_GRANITE_CAVE` (`:417-418`), among others. Their stages
   come from Yoshi's route (`docs/battle-sim/story-route.md`, steps 1-40), which d5-1c copies into `fights.ts`; **code reads only `fights.ts`** (`requiredBefore`, `awaitingRoute`, `excluded`) and never parses `story-route.md`.
   Every placed row has a single stage and uses it (its evidence label, `script` or `player-observed (Yoshi), not in the scripts at pin bdebcbbf`, is printed). A row with `awaitingRoute: true` (none in the real table after
   d5-1c) or `excluded` (the two Wally Victory Road rows, buggy in the pinned version, player-observed) is SKIPPED by the run and listed in the report with the D5 `levelCapForTrainer` text (`innate-gating-plan.md` Step 1.2).
   The route also adds one fight outside the 40 (`TRAINER_WALLY_MAUVILLE`, `story-route.md` step 10), evaluated like any other row. StageKeys of the non-excluded rows (steps 1-40), ten in all: `h0-n0-b0`, `h1-n1-b0`,
   `h2-n2-b0`, `h3-n3-b0`, `h4-n4-b0`, `h4-n4-b1` (Norman), `h5-n5-b1`, `h6-n6-b1`, `h7-n7-b1` (through Archie Seafloor Cavern, Gym 8's trainers and Juan), `h8-n8-b1` (Elite Four and Champion). Results are cached by (fight, StageKey, defeated set, build); the defeated set varies only for gym-leader fights 1-7 (decision 8) and is empty for every other fight.
2. **A fight list is built once, before anything else (new Step 1.0).** `fights.ts` has rows `{ fightId, trainerIds[], format ('single'|'double'|'tag'|'multi_2_vs_2', `fights.ts:15`), chainId?, gymNumber?, holdsBracelet?, mandatory, requiredBefore[], awaitingRoute?, excluded? }` (a chain is not a format: it is marked by `chainId`, on rows of any format) (`requiredBefore` from the progression table of decision 1; `mayBefore` is empty on every row after d5-1c; non-gym stages are copied from `story-route.md` into `fights.ts` by d5-1c, and code reads only `fights.ts`).
   `fightId` is the FIRST trainer id of the fight in script order (matching D5's trainer-id keys; no other id space). `format`/`chainId` come from `boss-fight-coverage.md`, `doubles-plan.md` and `chains-plan.md`; the StageKey is DERIVED from `requiredBefore` (decision 1), not a second source; `mandatory` is
   true for every fight a full clear must win and false for the optional ones the coverage doc lists (`boss-fight-coverage.md:480,491`: the optional Gym 8 two-on-one branches), recorded in a data file with the citation because no existing
   file records it. The step also lists, per gym-leader fight 1-7, the gym map and its guarded gym-trainer ids (the Context table above), which decision 8 searches over; no other fight has a defeated-set choice (Gym 8's ten trainers are all required, Context table).
3. **Fight evaluators come from D1-D3.** `evaluateFight(build, fight, stageKey)` dispatches FIRST on `chainId`: any row with a `chainId` goes to `scoreChain` (`chains-plan.md`), whatever its format; this includes Juan, whose row is
   `format: 'tag'` plus `chainId: 'sootopolis-gym-juan-wallace'` (`fights.ts:174-175`), and the `'single'` chains (Oceanic Museum, Space Center 2F, the Sootopolis groups; all script-derived, `chains-plan.md`; there is no Weather Institute chain). Rows without `chainId` dispatch on `format`: `'single'` to `scoreTeam`,
   `'double'`, `'tag'` and `'multi_2_vs_2'` to the `doubles-plan.md` evaluators. Until D1/D2/D3 land those
   fights return `unsupported` and are reported as excluded, never silently scored as singles. In `multi_2_vs_2` fights the player brings 3 of the 6 (`doubles-plan.md:131`): the solver evaluates all 20 three-mon subsets on a reduced sample
   (20 games each) on TUNING seeds, picks the best, and only then runs the full sampler on REPORT seeds (choosing the subset on report seeds would reintroduce selection bias).
4. **Win probability is a Wilson interval, sequentially sampled with a correction for repeated looks.** Games run in batches of 40 with at most 10 looks (400 games). Looking after every batch and stopping at the first decisive
   interval inflates the error of a nominal 95% interval, so each look uses a Bonferroni-corrected per-look level of 0.005 (two-sided z about 2.81), which keeps the OVERALL error at or below 5%; the report labels the interval
   "95% simultaneous over up to 10 looks" and states the per-look level. **What `won` effectively demands**: with z about 2.81, `won` needs at least 71 straight wins (80 in batches of 40), and at 400 games an observed 0.95 gives a corrected
   lower bound of only about 0.91, so `won` in practice needs a true win probability of roughly 0.94 or more and teams near 0.92 will always come out `uncertain`; this is the price of the "never a bare verdict" rule and is shown to Yoshi with the first report. A fight is `won` if the corrected lower end is at least 0.90, `lost` if the corrected upper end is below 0.50, else `uncertain` at 400 games. (At 40 straight wins
   the corrected lower bound is below 0.90, so a `won` verdict needs more than one batch, by design; Step 1.1 tests the numbers.) Games are independent draws of the stochastic pipeline even though the expectimax policy is itself sampled.
5. **Seeds are allocated by purpose so tuning and reporting can never overlap.** Every evaluator derives battle seeds from `seedOffset + g*1000 + k` (singles use `k = 0`; chain stage `k`, `chains-plan.md` decision 4), with the
   tuning offset 0 and the REPORT offset 10,000,000, valid for `g < 10,000` and `k < 1000` (so the two ranges are disjoint by construction). The Step 1.1 test enumerates the actual seeds each evaluator produces for the tuning
   and report purposes and asserts the sets are disjoint; the old 1001.. fresh set (`solverCli.ts:114`) is replaced by the report offset. Only report-seed results are ever reported, and report seeds are never used to CHOOSE anything:
   every choice (builds, the `multi_2_vs_2` subset of decision 3, the gym-trainer set `D_g` of decision 8, the what-to-change ranking of decision 6) is made on tuning seeds, and report seeds only confirm the chosen item. When decision 8
   confirms a second or third candidate after a failed confirmation, the next candidate is still picked from tuning results alone; the only report-seed information it uses is "the previous candidate was not confirmed". **"Fresh report seeds" means the report offset, not unused seeds**: every report-seed use (decision 8's confirmations
1, 2 and 3, decision 6's what-to-change re-scoring, decision 10's sensitivity runs, and the per-fight report) draws `g = 1, 2, ...` on the report offset from `g = 1`, so the same report seeds are REUSED across those uses.
That is allowed because every error statement in this plan is a union bound (decision 8: 3 x 5%; decision 10: 0.05/6 per comparison), which holds without independence between the tests; what stays forbidden is choosing anything
on report seeds. This changes the solver's singles seeds from `seedOffset + g` to `seedOffset + g*1000`, so solver OUTPUT numbers change;
    "no singles result changes" in Verification means sim mechanics, not solver outputs (no unit test pins solver numbers; only the two bench tests and `solverCli` call `scoreTeam`/`playExpectimaxBattle`).
6. **The search returns structured candidate records.** `improveTeam` is extended to return, per member and pass, `{ change, fitnessTuneByFight, games }` for every screened neighbour (today it keeps none); the PER-FIGHT fitness is recorded because the objective is a mean over a
   StageKey's fights and the top 3 for each not-`won` fight must be ranked on that fight alone. "What-to-change" (decision 9b)
   re-scores the top 3 neighbours for every not-`won` fight on the REPORT seeds with the sequential sampler (cost included in decision 12); the tuning-seed fitness is never shown as a probability.
7. **Stage builds, tuned against a fixed assignment of fights (no circularity).** One 6-species team for the whole run, with one build (moves, item, ability, nature, EVs, Mega choice) per StageKey. Fights are assigned to StageKeys
   BEFORE tuning from the progression table (each fight to its one StageKey, decision 1; an `awaitingRoute` or `excluded` row joins none), so the tuning objective does not depend on `W`. Gym-leader fights are tuned with the EMPTY defeated set (every guarded event active, the state
   decision 8 prefers); the build is not retuned per defeated set in v2 (decision 8 re-evaluates the same build). The objective at a StageKey is the MEAN fitness
   over its assigned fights, with the worst fight reported and the minimum used to break ties. Moves must be learnable at the stage's level (`learnableMoves`); a species whose evolution level exceeds the cap gets the D5 warning
   (printed, not enforced); a build with a move not learnable at the stage level is rejected for that stage and the stage's fights are `not-yet-legal`. Because the evaluator is no longer one fight, `FitnessEvaluator` takes a fight list and
   the worker protocol carries fight specs (below).
8. **Minimal gym trainers beaten (Yoshi, 2026-11-17).** A full clear is winning every `mandatory` fight through the Elite Four and Champion, all 8 gyms included. The search variable is, per gym 1-7, the set `D_g` of that gym's optional
   trainers beaten before its leader (the Context table; Gym 8 has no choice). Beating a trainer removes its guarded events from the leader fight (`battleEventSetup.ts:32-40`), so each `D_g` changes only gym g's leader fight and needs its
   own sample of that fight at its fixed StageKey; non-leader fights are evaluated once. Because the gyms are independent, the objective (fewest `|D_1| + ... + |D_7|` with every mandatory fight `won`) splits into seven searches.
   **The candidate space is the REACHABLE defeated sets, built battle by battle; `|D_g|` counts battles.** The choice units of a gym are its battles that can defeat a guarded id (Context table: Rustboro 3, Dewford 5, Mauville 4,
   Lavaridge 7, Petalburg 7, Fortree 4). A candidate is a set of such battles, and `D_g` (the ids passed to `eventsForFight`) is the union of the ids each chosen battle marks `defeated`. A single battle marks its one trainer. A tag battle
   `starttagbattle(A, B)` marks ids according to ONE of three explicit outcomes, which is a run-wide input printed in the report: **'both'** marks `{A, B}`; **'first only'** marks `{A}`; **'second only'** marks `{B}`. Under the
   chosen outcome each gym has exactly 2^(battles) candidate sets (8, 32, 16, 128, 128, 16), and NO set of trainer ids outside that space is ever enumerated (never every combination of ids). What each outcome means for the gyms:
   under 'both', every tag battle removes its guarded events (Lavaridge's COLE+KEEGAN battle removes both guards, `:582` and `:585`). Under 'first only', Mauville's SHAWN+ANGELO battle removes SHAWN's events, Lavaridge's battle
   removes only COLE's, and Dewford's LILITH+BRENDEN and Fortree's two tag battles remove NOTHING (their guarded id is the second argument, and re-talking to the unmarked trainer only re-runs the same tag battle, e.g.
   `DewfordTown_Gym/scripts.pory:581-584` -> `:567-576`), so those battles cost one and change no event and are never part of a minimal set. Under 'second only' the mirror holds: Dewford, Fortree and Lavaridge's KEEGAN guard
   are removable, Mauville's SHAWN guard and Lavaridge's COLE guard are not. Mossdeep counts the FIRST argument of each pair (Context table), so its count is the number of pair battles under 'both' or 'first only' and stays 0 under
   'second only'. **Until Step 0.5(b) settles the outcome, the solver runs with 'both' as the default and every report states "tag-battle outcome assumed: both ids set (not in the scripts at pin bdebcbbf)".** There is no by-id fallback
   for Lavaridge. Mossdeep's choice is a count 0..6 (7 values), not a set.
   **Choose on tuning seeds, confirm on report seeds** (decision 3/5: choosing on report seeds would reintroduce selection bias). (i) Candidate sets are run through the decision-4 sequential sampler on TUNING seeds, giving a tuning verdict and
   a tuning win rate, in LAYERS of increasing `|D_g|` (all sets of size 0, then all of size 1, ...); enumeration stops once the layer in which the cumulative number of tuning-`won` sets reaches 3 is complete, because the ordering rule
   below can then never prefer a larger set for any of the 3 confirmations. (ii) The tuning-`won` candidates are ordered by ONE rule: smallest `|D_g|`, then highest tuning win rate (wins/games; the sampler stops sets at different `n`, so corrected lower bounds are NEVER compared across sets), then
   lexicographic order of the sorted ids. (iii) The first candidate is confirmed once on REPORT seeds (decision 5) with the full sampler; if its report verdict is `won`, it is the answer. If not, the next candidate in the same order is confirmed,
   up to **at most 3 confirmations per gym**; if none is confirmed, the gym is reported `uncertain` with the candidates tried and their report intervals. **The answer is "fewest battles among tuning-`won` sets"**, not "fewest
   battles that win": a smaller set can be truly winning yet come out tuning-`uncertain`, so the report also lists every enumerated set smaller than the answer whose tuning verdict was `uncertain`, with its tuning win rate.
   If no candidate is tuning-`won` (every layer was enumerated), the full set is confirmed on report seeds: if that verdict is `won`, the full set is reported as the answer with the note "no smaller set was tuning-`won`; the smaller sets
   that came out `uncertain` are listed"; if `lost`, the leader is listed as a loser; if `uncertain`, the gym is reported `uncertain`.
   **Error rate, stated honestly.** Each reported answer rests on ONE report-seed confirmation at the decision-4 level (overall error at most 5% for that test). Because up to 3 candidates may be confirmed per gym, the chance that a gym's
   reported `won` is false is at most 3 x 5% = 15% in the worst case (union bound), and nothing controls the error jointly across the seven gyms; the report prints, per gym, the number of confirmations attempted so the reader can apply this.
   **Monotone shortcut.** If Step 0.5(d) shows every guarded event favours the leader, the full set is run first on tuning seeds; if it is NOT tuning-`won`, no smaller set is tried, and the full set is confirmed on report seeds and reported as
   above. That is all the shortcut licenses: a sampled verdict can be non-monotone across sets (sampling noise, and events interact), so when the full set IS `won` the layered enumeration of (i) runs from size 0 as usual (the full set's
   result is reused when its layer is reached); no other pruning by subset is done.
   All non-leader mandatory fights carry their own verdicts regardless. Beaten gym trainers are assumed beaten: their own battles are not simulated in v2 (stated in every report).
   Mossdeep (`forcedDouble`) and the Gym 8 tag fight return `unsupported` until D1/D2/D3 land; until the sim evaluates Mossdeep's count guards (they are dropped today, `battleEventSetup.ts:41-43`) its search is excluded and reported as such.
   The count-based selector (Step 3.2) must also fix the other guard `eventsForFight` drops: Juan's always-on `BATTLE_EVENT_TENSE_BATTLE` under `!(flag(FLAG_BADGE08_GET))` (Context), which holds on the first Juan fight and must be
   registered for it. That fix is checked by a unit test only: the Juan fight is a tag chain and returns `unsupported` until D1-D3 land, so no Juan verdict is produced in v2 before then.
9. **Reports.** (a) A field-by-field diff of the final builds against the starting builds. (b) For each not-`won` fight, the top 3 single-change neighbours with report-seed intervals and deltas (decision 6). (c) A loss anatomy from
   a small battle summary (which stage/mon the losing games ended on; first-faint turn histogram) that `playExpectimaxBattle` returns alongside `{outcome, turns, finalScore}` (`expectimax.ts:1171-1195`).
10. **Sensitivity ("fragile") is a defined perturbation experiment.** Only fights whose baseline verdict is `won` are tested. The perturbation acts on the OPPONENT's real action (the AI's chosen move in the turn step); the player's expectimax model of the
    AI (`sampleOpponent`) is NOT perturbed, because the player does not know the AI will deviate. At decision turn `t` in {1, 2, 3}, the AI's chosen MOVE is replaced by its `r`-th best-scoring legal move for `r` in {2, 3} (AI move scores from `chooseAiAction`;
    switch decisions are not perturbed; ties in AI score are ranked by move slot order, deterministically). The hook site is the REAL AI call in the turn step (`driver/session.ts:446-448`: `let opponentAction` at `:446`, the `fixedOpponentAction === undefined` test at `:447`, `chooseAiAction(state, 1, ...)` at `:448`; `stepTurn`, reached from the game loop's `stepTurn(session, ...)` call at `expectimax.ts:1193` with no fixed opponent action), not `sampleOpponent`. If the AI switches at turn `t`, or has fewer
    than `r` legal moves, the perturbation does not apply: the game stays in the sample as unperturbed and the report prints the fraction of games where it applied. That is 3 x 2 = 6 perturbations, each a fixed 100-game run on the report seeds. A fight is `fragile` if any perturbed run's win-rate interval, with the per-comparison level corrected by 6 looks (0.05/6), has an upper end
    below 0.90 (it is distinguishable from `won`). The turn window and ranks are Step 0.3 calibration outputs on known fights, not final constants.
11. **`widePool` stays OFF by default in v2.** A `--wide-pool` flag turns it on, with `maxNeighbours` 120 unchanged (it samples the larger pool deterministically). The reason: it adds every learnable status and utility move to the neighbour pool, which grows the search (the neighbour cap of 120 samples a larger pool, so improvement per neighbour falls) while the
    value terms for such moves (`statusTerms`, cycle 147) are recent and unmeasured in search; the verified-effect gate (`VERIFIED_MOVE_EFFECTS`, each entry mapped to a proving test, `solver.md:41-44`) already restricts WHICH status moves are eligible,
    so this is about cost and measured benefit, not correctness of the gate. Revisit trigger: Step 0 measures, on 3 fights, the win-rate gain and the time cost of `--wide-pool`; `solver.md` records the result. ("D6" in older notes means the finished
    move-pool work, STATE.md:58,86; the mutation plan `ported-by-mutation-plan.md` is a different item with the same label at STATE.md:291.)
12. **Cost budget (to be measured in Step 0).** Report-seed evaluation: about 1.4 s per game per singles fight single-threaded (chains about 3x, doubles unmeasured); 43 fights at an adaptive average of about 120 games is about 2 h single-threaded, about 15 min on 8 workers.
    TUNING dominates: roughly 120 neighbours x 4 screen games + 3 x 16 confirms per member, 6 members, 2 passes is about 6,000 games per fight-stage; with the mean-over-assigned-fights objective (about 4 fights per StageKey) that is about 24,000 games
    per StageKey, about 9 h single-threaded and about 1.2 h on 8 workers, times the number of distinct StageKeys (at most 10 under the fixed route, decision 1; d5-1c reports the exact count): up to about 12 h on 8 workers.
    The gym-trainer search (decision 8) adds, on top of that build-tuning budget, two parts. (a) The choice phase on TUNING seeds samples ONE fight per candidate set. Its ceiling is every reachable set of every gym
    (the layered stop of decision 8 (i) does not lower the worst case, which is fewer than 3 tuning-`won` sets so every layer runs): 8 + 32 + 16 + 128 + 128 + 16 + 7 = 335 sets x up to 400 games = 134,000 games, about 52 h single-threaded
    and about 6.5 h on 8 workers; the layered stop and the monotone shortcut cut this in practice, by an amount Step 0 measures. The count is the same under all three tag-battle outcomes (a battle that removes no event is still a unit).
    (The previous revision's 463 sets came from a Lavaridge by-id fallback of 256 sets, now removed.) (b) Confirmations on REPORT seeds: at most 3 per gym x 7 gyms x 400 games = 8,400 games, about 3.3 h single-threaded and
    25 min on 8 workers. Ceiling of the gym-trainer search: about 142,400 games, about 55 h single-threaded, about 6.9 h on 8 workers (was about 9.4 h). The plan therefore starts with reduced search options (smaller `maxNeighbours`, 1 pass) and measures before committing to defaults;
    the `solverWorker.ts` protocol carries a fight list, StageKey and build instead of one trainer, and one worker pool is reused across fights.

## Steps

### Step 0 - calibrate and verify (measure; no behaviour change)
0.1 Measure end-to-end time of `solverCli` itself (not `solver.bench.test.ts`, which is a reduced single-threaded benchmark) with 6 workers on one singles fight; record per-game time at depth 1 and the cost table of decision 12.
0.2 Build the sequential Wilson sampler on the existing `scoreTeam` for 3 known fights (an easy early fight, a hard mid fight, one the user considers borderline) and check the corrected-interval widths and stopping behavior against decision 4.
0.3 Prototype the AI perturbation (decision 10) on one fight; calibrate the turn window and ranks so a known-fragile and a known-stable fight separate; record the numbers.
0.4 Check that the matchup-matrix screen ranks species consistently with battle win rate on 3 fights (decision on species selection, Step 4).
0.5 Fact-check the gym-trainer search inputs (the route itself is fixed by Yoshi and is not re-litigated here): (a) what the `adddefeatedcount` macro does PER CALL (not in the sparse checkout). Which ids Mossdeep counts is already
    settled by the script: `CalcDefeatedCount` calls it on exactly one id per pair, the first `starttagbattle` argument (`MossdeepCity_Gym/scripts.pory:926-931`), so the count is 0..6 whatever the macro does, as long as each call adds
    0 or 1; only that per-call behaviour (and the first call's extra `1` argument, `:926`) is open. (b) Which of the three tag-battle outcomes of decision 8 holds ('both', 'first only', 'second only'): the commented partners sharing a
    battle with the guarded id is ESTABLISHED (each is in the same `starttagbattle`, Context), so the only open part is which ids the `starttagbattle` macro marks `defeated`. It is settled in one of two ways, recorded in the plan with
    its source: by reading the `starttagbattle` macro body (and its post-battle flag handling) from a copy of the upstream repo outside the pinned sparse checkout, labelled as such (unpinned, so it is evidence only if the
    macro file is unchanged since bdebcbbf, which the record states); or by a recorded observation from Yoshi (e.g. after beating LILITH+BRENDEN in Dewford, does talking to BRENDEN still offer the battle?), labelled
    `player-observed (Yoshi), not in the scripts at pin bdebcbbf`. The per-trainer `defeated()` checks (`DewfordTown_Gym/scripts.pory:581,593`, `LavaridgeTown_Gym_1F/scripts.pory:493,505`) suggest 'both' but are not proof.
    Until settled the solver runs with 'both' and reports that assumption (decision 8). (c) for each gym, which trainers the map layout forces the player to fight before
    reaching the leader, which become a floor on `D_g`: first check each gym's trainer scripts for opt-in `yesnobattle` (done for all seven: Rustboro `:458-488`, Dewford `:512-572`, Mauville `:457-522`, Lavaridge `:451-557`, Petalburg
    `:1854-1949`, Fortree `:375-455`, Mossdeep `:702-718`), then check whether any trainer's sight-line trigger or puzzle block bypasses that prompt (from `map.json`/layouts); (d) which side each guarded event acts for (`registerbattleevent` data and the event implementations), which decides whether the monotone shortcut of
    decision 8 is licensed; and that EVERY guarded event has a ported handler in the sim (an event with no handler makes its guard a no-op in the sim and must be listed). Record one known case: Mauville's Kirk guard
    registers `BATTLE_EVENT_STICKY_WEB` (`MauvilleCity_Gym/scripts.pory:557-559`, id 203 at `include/constants/battle_events.h:60`), and `src/battle_events.c` handles only `BATTLE_EVENT_PERMA_STICKY_WEB` (`:325`, `:475`;
    id 164, `battle_events.h:53`), so that event is a no-op in the C too and beating Kirk changes nothing; the sim must match (no-op), and the search still enumerates the Kirk battle as a unit. Anything not established is
    reported as an open item and that gym's search tries every reachable set.

### Step 1 - fight list, statistics and report (no D1-D3 dependency)
1.0 The progression table (decision 1) and `fights.ts` (decision 2), built jointly with D5 Step 1 (one table; the cap is derived from it). Built by d5-1/d5-1b on the skippable-gym premise; queue item d5-1c corrects it for the fixed route
    (`mayBefore` empty on gym fights, `requiredBefore` = all lower gyms for each gym fight, evidence strings citing map blocks or the literal label `player-observed (Yoshi), not in the scripts at pin bdebcbbf`, subset machinery removed). Tests: every id from `loadBossTrainerIds` appears in exactly one row;
    every row has a format from the `fights.ts:15` enum, a mandatory flag with a citation, `requiredBefore` with evidence; every row has an empty `mayBefore` (non-gym stages copied from `story-route.md` by d5-1c, decision 1); each gym N row has `requiredBefore = [1..N-1]`; `stageKeyFor` on a hand-built row; and a report of the distinct
    StageKeys of the real table (this number feeds decision 12). Add to the table, per gym-leader fight 1-7, its map name, guarded trainer ids and choice units (battles, decision 8; COLE+KEEGAN one unit), with a test that, for gyms 1-6,
    the ids match the `!defeated(...)` guards in `encounters.json` for that map. Gym 7 is EXEMPT from that test (Mossdeep's guards are `var(VAR_RESULT) < N` and its ids appear only in `CalcDefeatedCount`); it gets a separate check that
    `encounters.json` has exactly the six `var(VAR_RESULT) < 1..6` rows for `MossdeepCity_Gym` and that the table's twelve ids are the twelve in the `MossdeepCity_Gym` `tagBattles` rows.
1.1 `winProbability(wins, n, level)` Wilson interval, the corrected sequential sampler and verdict rule, the seed allocator (decision 5). Unit tests with hand-computed intervals (including the 40-wins case above and the 400-game half-width), boundary cases,
    and the seed-disjointness test over the seeds the singles and chain evaluators actually produce.
1.2 The report writer: JSON plus markdown with per-fight `p`, interval and level, `n`, verdict, `fragile`, assumptions (decision 13 below), what-to-change. It replaces the `{trainerId, tier, fitness, fresh, team}` JSON; no existing test reads that `--out` file
    (grep before changing), so no compatibility shim.

### Step 2 - search record, what-to-change and sensitivity (singles fights first)
2.1 `improveTeam` returns the candidate records (decision 6); the team diff; the report-seed re-scoring of the top 3 neighbours.
2.2 The battle summary return value and loss anatomy.
2.3 The AI perturbation wrapper (decision 10) and the `fragile` flag, calibrated per Step 0.3.

### Step 3 - stage builds and the gym-trainer loop (queue item d4-4; needs D5, d5-1c and Step 0.5; `awaitingRoute`/`excluded` rows are skipped, not waited for)
3.1 StageKey per fight from the corrected `fights.ts` only (decision 1: code never parses `story-route.md`; single stage used; `awaitingRoute` and `excluded` rows skipped and listed with the D5 `levelCapForTrainer` text); per-StageKey tuning with the mean objective (gym leaders at the empty defeated set), caps from D5, move legality, `not-yet-legal` handling; `FitnessEvaluator` and `solverWorker.ts` carry fight lists,
    StageKeys and a per-fight `defeated` set.
    **Mega gating from the StageKey.** Change `stoneAvailability(item, gym)` (`stoneAvailability.ts:33`) to `stoneAvailability(item, { badgeCount, braceletHeld })` and `availableStones` (`:63`) likewise: return unavailable when
    `!braceletHeld` (replacing `gym < BRACELET_GYM`, `:34`), and use `badges = badgeCount` (replacing `gym - 1`, `:36`) for `megaBadgeRequirement`; `nurseJoy` and `adoptionCenter` stones follow `braceletHeld` (both come with the bracelet,
    `PetalburgCity_Gym/scripts.pory:1760-1763`). `solverCli --gym N` maps to `{ badgeCount: N-1, braceletHeld: N >= 5 }`, which keeps today's behaviour for every existing call. Test: `h4-n4-b0` gives no Mega stone at all, `h4-n4-b1` gives
    the Nurse Joy stones, a stone with `megaBadgeRequirement` 5 is unavailable at `h4-n4-b1` and available at `h5-n5-b1`, and `--gym N` gives the same stone set as before for N = 1..8.
3.2 `W[fight][StageKey][defeated set]` builder over all supported fights (singles and chains first; doubles when D1/D2 land), cached by (fight, StageKey, defeated set, build) hash; non-leader fights have one entry each.
    A guard selector beside `eventsForFight` handles the two guard shapes it drops today (`battleEventSetup.ts:41-43`): Mossdeep's `var(VAR_RESULT) < N` guards, from the count once Step 0.5(a) settles it (until then gym 7's search is excluded,
    decision 8), and Juan's `!(flag(FLAG_BADGE08_GET))` `TENSE_BATTLE`, registered for the first Juan fight. Test: Tate and Liza at count `c` get exactly the `6 - c` events with `N > c`; Juan's first fight gets `TENSE_BATTLE`.
    The Juan part is a UNIT TEST of the selector only: the Juan fight itself (a tag chain) still returns `unsupported` until doubles (D1/D2) and D3 land.
3.3 The per-gym defeated-set search and reporter (decision 8): the reachable candidate sets under the run's tag-battle outcome (default 'both', printed), tuning-seed sampling in layers of increasing `|D_g|` with the layered stop,
    the single ordering rule, report-seed confirmation of at most 3 candidates; per gym the chosen `D_g` and `|D_g|` in battles, its report verdict and interval, the smaller tuning-`uncertain` sets, the number of confirmations
    attempted and the resulting worst-case error (decision 8), the total `sum |D_g|`, the non-leader verdicts, and the excluded-fights list.

### Step 4 - species selection
4.1 `--pool` input (user-supplied species ids; default every non-form species), the matchup-matrix screen against the union of the targeted fights' opponents, top K per slot, then `improveTeam` on the shortlist. Out of scope until Step 0.4 shows the screen is usable; until then species stay user-supplied.

### Step 5 - parallel driver
5.1 One worker pool reused across fights; results appended per fight so an interrupted run resumes.

### Step 6 - docs and queue
6.1 Rewrite `solver.md` (it still says doubles are out of scope, `:59-60`), update `plan.md` step 7, `solver-evaluation.md`, STATE.md D4. After approval each step becomes one or more queue lines in the driver's format, and those lines REPLACE the current d4-0..d4-5 lines in STATE.md (they are seeds written before this revision, not briefs) (`[feature]` with the `expect move_notes <= K, ability_gaps <= J` gate); briefs are written inline because workers cannot read `.omc/` (CLAUDE.md). That conversion is part of the follow-up, not of this document.

## Assumptions every report states (decision 13)
Tier elite; the fixed route (Yoshi, 2026-11-17) and the fight's StageKey with its evidence label (`script` or `player-observed (Yoshi), not in the scripts at pin bdebcbbf`, `story-route.md`) and level cap (D5); the Elite level-cap table, confirmed by Yoshi (D5 decision 3); no Mega Bracelet for non-Norman fights between gym 4 and gym 5 (a modelling choice, decision 1); the fights skipped (`awaitingRoute` or `excluded`: the two Wally Victory Road rows, buggy in the pinned version, player-observed); the tag-battle outcome assumed (default 'both ids set', decision 8, until Step 0.5(b) settles it); the pending Yoshi decisions at the top of this plan;
the number of report-seed confirmations per gym and its worst-case error (decision 8); the chosen gym trainers are assumed beaten (their battles are not simulated); no bag items (the policy never uses the bag); top-K caveat for two-mon player sides (`doubles-plan.md` decision 4); the Juan stage-2 full-HP caveat until D3 lands; TM/tutor and species/item availability not modelled; the policy is the
depth-1 expectimax; `widePool` state; battle-event `defeated` set per fight.

## Verification
- Statistics tests with hand-computed values; the seed-disjointness test; verdict boundaries (0.90 corrected lower bound, 0.50 corrected upper bound).
- A deterministic end-to-end test of the gym-trainer search on a tiny synthetic gym (hand-built map with a leader and three guarded trainers whose events are chosen so the known answer is a specific defeated set of size 1: the empty set is
  not `won`, that set is, a different size-1 set is not), asserting the search returns that set, that the choice phase draws only tuning seeds and the confirmation only report seeds (seed log), that a failed confirmation moves to the next
  candidate in the ordering rule and stops after 3, that a guarded event is present for every trainer outside it and absent for the trainer in it, and that the fight's StageKey (including a
  Mega-bracelet case: a leader at `h4-n4-b1` versus a fight at `h4-n4-b0`) is the single one the fixed-route table gives.
- A with/without test showing the what-to-change neighbours change the reported (report-seed) probability.
- Repo gates: `npx tsc -b web`, `npm --prefix web test -- --run`, `npm --prefix web run build`, both sim audits via `.omc/team-pilot/validate.sh`; no singles result changes.
- Per CLAUDE.md the solver output is not trusted until D1-D3 and the audits land; any real run is shown to Yoshi before its numbers are relied on (task 62's standing note).

## Risks / open questions
- **Progression structure**: the gym order is fixed by Yoshi (gyms 2 -> 3 -> 4 is his statement of the player route, not a cited game fact); the earlier tables cited the stale "Winona can be skipped" comment and are wrong until d5-1c
  lands. Non-gym fights that d5-1/d5-1b gave a `mayBefore` gym are not settled by the gym order alone; their stage comes from `story-route.md` (steps 1-40, all placed 2026-11-17), via `fights.ts`. The two Wally Victory Road
  rows are `excluded` (buggy in the pinned version, player-observed), which shrinks the claim to "every mandatory fight except Wally at Victory Road is `won`" until that fight is resolved (`boss-fight-coverage.md` Unresolved item 3).
- **Gym-trainer error rate**: up to 3 confirmations per gym give a worst-case 15% chance that a gym's reported `won` is false, with no joint control over the seven gyms (decision 8); the report prints the confirmations attempted.
- **"Fewest" is among tuning-`won` sets**: a smaller set that is truly winning but came out tuning-`uncertain` is not chosen; the report lists such sets (decision 8).
- **Gym-trainer facts not yet established** (Step 0.5): what `adddefeatedcount` does per call, which ids a tag battle marks `defeated` (run default 'both', reported), whether any sight line or puzzle block bypasses the opt-in `yesnobattle`, which side each event favours, and whether every guarded event has a ported handler. Until then the search
  enumerates every reachable set per gym under the 'both' outcome and Mossdeep is excluded.
- **Beaten gym trainers are not simulated**: a `D_g` assumes the player beats those trainers; a hard gym trainer could make a small `D_g` optimistic.
- **Build tuned at the empty defeated set**: a build is not retuned per `D_g`, so the reported minimum is for that build; a build tuned for a larger `D_g` might win with a different set.
- **Cost** is the main risk (decision 12): per-StageKey tuning is hours; reduced search options come first.
- **Mean-fitness stage objective** can trade a fight lost for several won; the worst fight is reported and breaks ties, and the per-fight verdicts are still decided on report seeds.
- **Species and item availability** are unmodelled; a suggested team may not be obtainable at the stage it is used.
- **Sensitivity** is an operationalisation of "one AI choice flips the answer"; its window and ranks are calibrated, not derived.
- **Policy dependence**: the depth-1 expectimax is not an optimal player; a `lost` verdict means this policy loses, and a `won` verdict means this policy wins against this AI model (statistical, not bit-exact, `plan.md:137-148`).
- **Scope**: boxed over-cap mons, Easy/More level caps, Double Battle Mode, Hell tier and bag healing items are out of scope.
