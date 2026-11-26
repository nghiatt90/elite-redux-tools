# Plan: solver v2, per-fight builds, minimal gym trainers beaten, honest win probability (D4)

_Status: REVISED 2026-11-24 (seventh revision: role policies replace expectimax; set pools built offline); ON HOLD; NOT yet re-reviewed (cold review deferred by Yoshi, 2026-11-24). Seventh revision, from Yoshi's decisions of 2026-11-24 (Decisions pending items 11-13): the player policy for every solver game is no longer depth-1 expectimax (one turn of lookahead scored by hand-weighted terms, which undervalues set-up, hazards, speed control and status) but cheap ROLE POLICIES tied to sets (attacker, set-up sweeper, staller, lead/hazard setter, pivot, support) plus a team layer for replacements and generous switching, with role parameters and team behaviour as GA genes (decision 14); games are capped at 200 turns because the game has no turn limit (decision 15); each species' about 5 viable role-tagged sets per badge stage come from a new offline pipeline step (synergy table, role fit, boss sets; decision 16), and the per-fight screen only chooses among them. A policy gate (Step 2.0: role policies against expectimax on Yoshi's winning teams, `role-policy-test-fights.json`) comes before everything else; the former screen gate is Step 2.6. Rewritten: Decisions pending items 10-13, decisions 7 (c1)-(c5), 10 (one sentence), 11, 12 (per-game cost), new 14-16, Steps 1.3, 2.0, 2.4-2.6, Assumptions, Verification, Risks. Previous status: REVISED 2026-11-24 (search over whole sets: damage-calc screen, per-species set pools, genetic algorithm); ON HOLD; NOT yet re-reviewed. Sixth revision, from Yoshi's decision of 2026-11-24 (Decisions pending item 10): single-attribute neighbours cannot reach a build that needs a full rebuild (about 40 single changes, while `UNIT_CAP` funds 4-9 accepted rounds) and are greedy (a stronger move of the same type is accepted before the coverage move the fight needs), so the per-unit search (decision 7 (c)) becomes a genetic algorithm whose genes are whole sets drawn from per-species pools built by a damage-calc screen with no simulated games, with a lead gene, a graded fitness, successive halving for game allocation and a log-based repair mutation. Amended the same day (Yoshi): the screen scores lead plans against the fixed opposing lead (KO, wall with a move for the switch-in the real AI code predicts, set up and sweep; one predicted replacement; no disable plans and no player double switch in v1), decision 7 (c1a); a set-up plan counts only when the real depth-1 policy picks the boost on the turn-1 state, and the policy's undervaluing of set-up is a deferred policy item. The satisficing outer loop is KEPT unchanged (starting build on report seeds, stop at the first tuning-`won` candidate confirmed on report seeds, at most 3 confirmations, `UNIT_CAP`; `satisficingSearch.ts`, Step 2.1). A go/no-go gate (Step 2.0) validates the screen before the GA is built. Rewritten: Decisions pending item 10, decisions 6, 7 (c), 11 (one sentence), 12 (`C` and the per-generation cost), Steps 2.0-2.5, Verification (satisficing and new GA/screen tests), Risks. Previous status: REVISED 2026-11-18 (satisficing search: reach `won` and stop); ON HOLD; NOT yet re-reviewed. Fifth revision, from Yoshi's decision of 2026-11-18: the solver needs a build that WORKS RELIABLY, not the best build, so every search is SATISFICING: per tuning unit, sample the starting build; if it is `won` (and not `fragile`), stop; otherwise run a feasibility search that stops at the first candidate that is tuning-`won` and confirmed on report seeds, under a hard per-unit cap. Coordinate ascent to a maximum (epsilon, passes, "best build", fitness as the objective) is gone; fitness survives only as the screening signal. The gym-trainer search stops at the first reliably-`won` defeated set in increasing `|D_g|`, with the leader build searched per candidate set only when needed. Decision 12 is now an expected cost (depends on Step 0 measurements) under a ceiling. Rewritten: Goal, decisions 4 (verdict use), 6, 7, 8, 9, 10, 12, Steps 0, 2, 3, Verification, Risks, Decisions pending. Previous status: REVISED 2026-11-17 (per-fight builds, chains as units, species supplied by the user); ON HOLD; NOT yet re-reviewed. Fourth revision, from Yoshi's design decisions of 2026-11-17: the tuning unit is the FIGHT (one build per ordinary fight) or the CHAIN (one build per no-heal gauntlet, scored with `scoreChain`), not the StageKey; the StageKey is only the state label that sets a fight's cap, innate gate and Mega availability; the six species are supplied by the user (`--team`) and never chosen, so team selection and the species screen are out of scope; v1 scores the 34 non-deferred, non-excluded rows. Rewritten: Goal, decisions 1, 3, 6, 7, 12, Steps 3-4, Verification, Risks, Decisions pending. Earlier history: REVISED 2026-11-17 (third revision: route steps 29-40 from Yoshi, so no row awaits the route and the Wally VR rows are `excluded`; cold review round 2 applied: the candidate space is the reachable defeated sets under an explicit tag-battle outcome, the Lavaridge by-id fallback is gone, Mossdeep's count is 0..6 by construction, layered enumeration, the full-set-`won` case, seed reuse); NOT yet re-reviewed. Second revision: fixed route, after cold review round 1. Not yet committed or executed. Round 1 of the fixed-route review (NEEDS WORK) rewrote decisions 2, 3, 5, 8, 10 and 12, Steps 0.5, 1.0 and 3.1-3.3: the defeated set is now chosen on tuning seeds and confirmed on report seeds, one tie-break rule, open-stage fights handled through `story-route.md`, StageKey drives Mega gating, and the real `fights.ts` format enum. History before that: REVISED 2026-11-17 after Yoshi correction (fixed route, gym-trainer loop). Earlier: the gym-subset version was APPROVED by a cold Opus reviewer after 3 rounds (round 3: APPROVED; its four non-blocking notes applied); Yoshi then corrected two premises (gyms are a fixed route, none skippable; the loop is over optional gym trainers, not gyms), which rewrote decisions 1, 2, 7, 8, 12, Steps 0.5, 1.0 and 3, the tests and the risks. Before that: DRAFT 3 (draft 2: StageKey data undefined; fixed with a progression table and an explicit subset-to-StageKey rule). Earlier: DRAFT 2 (draft 1 got NEEDS WORK: Mega availability keyed wrongly, no multi-fight objective, repeated-look interval, seed overlap with chains, no search log, widePool undecided, fight unit undefined, fragile test undefined; all reworked), not yet re-reviewed.
Vikunja task 62. This is the D4 design doc (the earlier driver plan `.omc/plans/driver-d6-d5-audits-d4.md` called it `solver-design.md`). Planning only: no code is changed by this document. Depends on
`innate-gating-plan.md` (D5), `chains-plan.md` (D3), `doubles-plan.md` (D1+D2) and, for Step 3 (queue item d4-4), the story-route table `docs/battle-sim/story-route.md` (written 2026-11-17: steps 1-40 from Yoshi's route; the two Wally Victory Road rows are `excluded`, decision 1); the statistics, report and sensitivity parts on singles fights can start first._

## Decisions pending Yoshi (2026-11-17, item 4 and 9 updated 2026-11-18)

Items 1-3 and 5-13 are answered; 4 is open and this plan does not decide it.
1. **Difficulty tier**: ANSWERED by Yoshi: `elite` (the data tiers are `ace` / `elite` / `hell`; `solverCli --tier` defaults to `elite`).
2. **Level-cap mode**: ANSWERED and verified: the menu's 'Elite' cap mode is `LEVEL_CAPS_ELITE`, which selects the table `levelCapsStrict = {16, 23, 36, 45, 50, 55, 60, 70, 80, 100}` (`src/pokemon.c:4649-4671`, comment '// Elite'); this plan calls it the 'Elite' table (see `innate-gating-plan.md` decision 3).
3. **EVs**: ANSWERED (Yoshi, 2026-11-17): templates only. `enableEvs` is ON (252 per stat, 510 total: `include/constants/pokemon.h:326-327`); version 1 picks each build's EVs from a small pre-defined set of distributions (the existing `EV_TEMPLATES`, `driver/solver.ts:32`, swapped as neighbours at `:293-295`, possibly with more templates); the point-by-point EV search is DEFERRED to a later version. Choosing which templates to include is part of the solver work (D4, ON HOLD).
4. **Compute budget for the full run** (decision 12): with the satisficing search the EXPECTED cost depends on two numbers Step 0 measures (how many of the 32 units the starting build already wins, and the search cost per unit to its first `won`), so the budget cannot be set until then; decision 12 gives the formula, a worked range (about 1.3 h to 9.8 h on 8 workers for 0 to 20 searched units, each searched unit at its cap) and the ceiling (about 22.5 h on 8 workers with the gym-trainer search). Open choices once Step 0 reports: the per-unit cap `UNIT_CAP`, the gym cap `GYM_CAP`, and whether to lower the per-set game cap from 400 to 200. A later EV search would multiply D4's cost, so do not decide it.
5. **D6 coverage dependency**: `@vitest/coverage-v8` ALLOWED by Yoshi.
6. **Species**: ANSWERED (Yoshi, 2026-11-17): the user SUPPLIES the six species (`solverCli --team`, already required, `driver/solverCli.ts:37`); the solver never chooses species, and the six are fixed for the whole run.
7. **Per-fight builds**: ANSWERED (Yoshi, 2026-11-17): every ordinary (non-gauntlet) fight gets its own build; one build per StageKey is rejected (decision 7).
8. **Chains as units**: ANSWERED (Yoshi, 2026-11-17): a no-heal gauntlet gets ONE build for all its members, tuned on the chain's win probability played in sequence (decision 7).
9. **Satisficing, not optimizing**: ANSWERED (Yoshi, 2026-11-18): the solver only needs a configuration that works reliably, not the best one. Per unit the goal is the verdict `won` (corrected 95% lower bound >= 0.90, decision 4), not `fragile`, reached with the cheapest search, then STOP (decision 7).
10. **Search method**: ANSWERED (Yoshi, 2026-11-24): a genetic algorithm over whole sets, not single-attribute local search. A team is one individual; its genes are, per member, an index into that species' pool of complete role-tagged sets (built offline, decision 16, since the seventh revision) with that role's parameters, plus team genes (lead, preserve, switching; decision 7 (c3)); the fitness is graded so losing teams still differ (decisions 6 and 7 (c)). Chosen over the cross-entropy method because slot-wise crossover keeps sets that work together (team synergy), which an independent per-slot distribution ignores. Linear programming was rejected for the battle itself (its outcome is not linear); the only optimisation that fits it, choosing one pool set per slot by threat coverage, is small enough to enumerate (decision 7 (c4)), so no solver is needed. Gates first (Steps 2.0 and 2.6), cold review later.
11. **Player policy**: ANSWERED (Yoshi, 2026-11-24): role policies tied to sets plus a team layer (decision 14), replacing depth-1 expectimax for every solver game. Rejected in discussion: expectimax with learned evaluation weights (still guesswork in the inputs), splitting the battle into 1v1 duels (misses team effects such as screens), per-decision rollouts (about 3-50x per game), and a per-fight search tree or table learner (cannot reach 50+ turn stall games, and greedy continuation cannot stall).
12. **Set pools**: ANSWERED (Yoshi, 2026-11-24): about 5 viable sets per species, tied to roles, precomputed offline for ALL species per badge stage from a synergy table, role fit and boss sets (decision 16); TMs and tutor moves are usable by any compatible mon at any time and only level-up moves are badge-gated (player-observed, Yoshi; not checked in the C).
13. **Turn cap**: ANSWERED (Yoshi, 2026-11-24): 200 turns (decision 15).

## Goal

For a team of six species SUPPLIED by the user (`--team`; the solver never chooses species, Decisions pending item 6), find for every v1 fight A build that reliably wins it (verdict `won` and not `fragile`; NOT the best build: the search is satisficing and stops at the first such build, Decisions pending item 9), and answer "does this team win this fight with that build, and if not, what should change", with an honest
win probability; and find the fewest optional gym trainers the player must beat before the gym leaders for a full clear. **v1 fight set**: the 34 `fights.ts` rows (after d5-1c) that are neither `deferred` nor `excluded` (`story-route.md` "Deferred fights" totals: 43 rows minus 7 deferred minus 2 excluded); deferred and excluded rows are listed, never scored. (The full table is 43 script-level fights over 55 trainer ids, `boss-fight-coverage.md:66`, plus `TRAINER_WALLY_MAUVILLE`.)
**Builds** (Yoshi, 2026-11-17): the 6 species are fixed for the run; between two ordinary (non-gauntlet) fights EVERYTHING else may change: moves, held item, ability, nature, EVs (from the pre-defined template set), Mega choice. Each ordinary fight is its own tuning unit with its own build; a no-heal gauntlet (chain) is one tuning unit with ONE build for all its members (decision 7). Decisions from Yoshi (2026-11-15, corrected 2026-11-17): the gyms are a **fixed route** (gym N requires gyms 1..N-1; all 8 are
required; none is skippable or reorderable), so every gym fight has exactly one story stage (non-gym fights whose stage gym order does not fix are handled by the open-stage rule of decision 1); the search loop is over **which optional gym trainers are beaten before each leader** (beating them removes battle events from the leader fight) and finds the
**fewest gym trainers beaten such that every mandatory fight is reliably `won`** (the first reliably-`won` set in increasing size, decision 8); a fight counts as **won when the lower end of the
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
| Species selection | OUT OF SCOPE (Yoshi, 2026-11-17): the user supplies the six species through `--team`, which is what the CLI already does | none needed |
| Per-fight / per-chain builds | one build for one fight per run | `defaultSet`, `neighbours` and the evaluators `improveTeam` uses (one fight per evaluator; its coordinate ascent is replaced by the satisficing search, decision 7); `scoreChain` (D3) for chains |
| Minimal gym trainers beaten | none | `eventsForFight` and `solverCli --defeated` already select a leader's events from a defeated set; Mossdeep's count guards are dropped; `fights.ts`/`progression.ts` exist (d5-1/d5-1b) but still encode skippable gyms (`mayBefore`, `legalSubsets`) until d5-1c; `levelCapFor` unwired (D5) |
| Win probability with interval | bare `winRate` | `Fitness.games` (wins/games) |
| Sensitivity (fragile fights) | none | seeded RNG; `chooseAiAction` is the AI decision point |
| What-to-change | final team only | `PlayerMonSpec` field diff is possible; no search log exists |

### Data limits
- No species-availability-by-progression data in the COMMITTED data (`encounters.json` has only `battleEvents`, `fieldEffects`, `inverseBattles`, `tagBattles`, `trainerChains`), and no item availability data; `ITEM_POOL` is curated.
  Upstream wild tables are on disk (`pipeline/.upstream/eliteredux-source/src/data/wild_encounters.json`, e.g. wild Pidgeotto at levels 2-3 at `:2644-2661`) but are not extracted; availability stays unmodelled here.
- The fight list's badge state comes from the shared progression table (D5 Step 1, `fights.ts`); with the fixed route it is one value per gym fight; a non-gym fight gets one value, copied from `story-route.md` into `fights.ts` by d5-1c; `awaitingRoute` (none in the real table) and `excluded` rows are skipped (decision 1). TM and tutor availability is story-gated and not modelled.

## Design decisions

1. **StageKey is fixed per fight by the fixed route and is only a state label; the unit of evaluation is (fight, defeated set, build).** A `StageKey = { highestBadge, badgeCount, braceletHeld }` sets three things for the fight it labels: the level cap
   (`highestBadge`, `GetLevelCap`, D5), the innate gate (D5) and Mega availability (`badgeCount` for `megaBadgeRequirement`, `braceletHeld`). It is NOT a tuning unit (decision 7): two fights with the same StageKey get separate builds.
   **On the fixed route `highestBadge` and `badgeCount` are always equal** (every gym below the current one is cleared, `story-route.md` "Fixed rules"), so the only extra state is `braceletHeld`, which differs only across the Norman fight (before:
   `b0`; Norman's own fight and after: `b1`). The three-field struct is KEPT for now because `progression.ts` (`StageKey`, `:3-6`; `stageKeyId`, `:93-94`) and d5-1c already implement it; the redundancy is noted, not removed. **The route is fixed** (Yoshi, 2026-11-17): gym N requires gyms 1..N-1 cleared and all 8 are required. Badge 6 is required by the league door
   (`EverGrandeCity_PokemonLeague_1F/scripts.pory:56`, `goto_if_unset FLAG_BADGE06_GET, ..._NotAllBadges`); Norman requires badges 1-4 indirectly (the `case 3`-`case 5` badge checks at `PetalburgCity_Gym/scripts.pory:1719/1731/1743` gate the state change to the case-6 battle, `:1754-1763`); the order 2 -> 3 -> 4 is player-observed (Yoshi), not in the scripts at pin bdebcbbf, not a cited game
   fact. The comment at `EverGrandeCity_PokemonLeague_1F/scripts.pory:40` ("Winonas badge is the only one that can be skipped") and the one at `src/pokemon.c:4633` ("unless they skipped Winona") are stale leftovers and are evidence of nothing.
   **The progression table** (`progression.ts` + `fights.ts`, one table with two consumers, D5 Step 1; corrected by queue item d5-1c) has per fight `{ fightId, requiredBefore: gymNumber[], evidence }` with `mayBefore` empty for every gym row (non-gym rows: open-stage rule below),
   so there is no gym subset and no "cleared as early as possible" rule: a fight after gym k and before gym k+1 has `requiredBefore = [1..k]` and the single StageKey `highestBadge = k`, `badgeCount = k`, `braceletHeld = k >= 5` (the Mega
   Bracelet comes from Norman's Gym 5 script, `stoneAvailability.ts:5-13`). One exception already in the table: Norman's own fight has `holdsBracelet` (`fights.ts:133`) because the bracelet is handed over before that battle
   (`PetalburgCity_Gym/scripts.pory:1754-1763`), so it is `h4-n4-b1`. Giving `b0` to every OTHER fight between gym 4 and gym 5 is a modelling choice, not a game fact: the bracelet is handed over without a battle and the script ends
   (`:1754-1771`), so a player can take it, leave, and fight those trainers with it; the choice is stated in every report that contains such a fight. Hence at most 10 distinct StageKeys (`h0-n0-b0` .. `h4-n4-b0`, `h4-n4-b1`, `h5-n5-b1` .. `h8-n8-b1`); d5-1c reports the exact list from the corrected table; decision 12's
   cost does NOT scale with it (it scales with the number of tuning units). D5's cap reads the same single value (min = max).
   **Open-stage fights.** Gym order fixes the stage of every gym fight but not of every other fight: `fights.ts` still gives a non-empty `mayBefore` to rows such as `TRAINER_MAY_ROUTE_110_TORCHIC` (`:52-53`), `TRAINER_MATT` (`:227-228`), the Oceanic Museum chain
   (`:242-269`), `TRAINER_ARCHIE_MT_PYRE` (`:280-281`), `TRAINER_COURTNEY_METEOR_FALLS` (`:309-310`), `TRAINER_MAXIE_MT_CHIMNEY` (`:376-377`), `TRAINER_MAXIE_MAGMA_HIDEOUT` (`:388-389`) and `TRAINER_STEVEN_GRANITE_CAVE` (`:417-418`), among others. Their stages
   come from Yoshi's route (`docs/battle-sim/story-route.md`, steps 1-40), which d5-1c copies into `fights.ts`; **code reads only `fights.ts`** (`requiredBefore`, `awaitingRoute`, `excluded`) and never parses `story-route.md`.
   Every placed row has a single stage and uses it (its evidence label, `script` or `player-observed (Yoshi), not in the scripts at pin bdebcbbf`, is printed). A row with `awaitingRoute: true` (none in the real table after
   d5-1c) or `excluded` (the two Wally Victory Road rows, buggy in the pinned version, player-observed) is SKIPPED by the run and listed in the report with the D5 `levelCapForTrainer` text (`innate-gating-plan.md` Step 1.2).
   Note (2026-11-17, v1 scope): rows flagged `deferred` (seven easy rows, `story-route.md` "Deferred fights (add back later)") are likewise not scored, only listed, and are not tuning units; the StageKey set is unchanged.
   The route also adds one fight outside the 40 (`TRAINER_WALLY_MAUVILLE`, `story-route.md` step 10), evaluated like any other row. StageKeys of the non-excluded rows (steps 1-40), ten in all: `h0-n0-b0`, `h1-n1-b0`,
   `h2-n2-b0`, `h3-n3-b0`, `h4-n4-b0`, `h4-n4-b1` (Norman), `h5-n5-b1`, `h6-n6-b1`, `h7-n7-b1` (through Archie Seafloor Cavern, Gym 8's trainers and Juan), `h8-n8-b1` (Elite Four and Champion). Results are cached by (fight, defeated set, build); the StageKey is a function of the fight, so it is not a separate key. The defeated set varies only for gym-leader fights 1-7 (decision 8) and is fixed for every other fight (empty, except Juan's, which is all ten Gym 8 trainers, `story-route.md` "Deferred fights").
2. **A fight list is built once, before anything else (new Step 1.0).** `fights.ts` has rows `{ fightId, trainerIds[], format ('single'|'double'|'tag'|'multi_2_vs_2', `fights.ts:15`), chainId?, gymNumber?, holdsBracelet?, mandatory, requiredBefore[], awaitingRoute?, excluded? }` (a chain is not a format: it is marked by `chainId`, on rows of any format) (`requiredBefore` from the progression table of decision 1; `mayBefore` is empty on every row after d5-1c; non-gym stages are copied from `story-route.md` into `fights.ts` by d5-1c, and code reads only `fights.ts`).
   `fightId` is the FIRST trainer id of the fight in script order (matching D5's trainer-id keys; no other id space). `format`/`chainId` come from `boss-fight-coverage.md`, `doubles-plan.md` and `chains-plan.md`; the StageKey is DERIVED from `requiredBefore` (decision 1), not a second source; `mandatory` is
   true for every fight a full clear must win and false for the optional ones the coverage doc lists (`boss-fight-coverage.md:480,491`: the optional Gym 8 two-on-one branches), recorded in a data file with the citation because no existing
   file records it. The step also lists, per gym-leader fight 1-7, the gym map and its guarded gym-trainer ids (the Context table above), which decision 8 searches over; no other fight has a defeated-set choice (Gym 8's ten trainers are all required, Context table).
3. **Fight evaluators come from D1-D3.** `evaluateFight(build, fight, stageKey)` dispatches FIRST on `chainId`: any row with a `chainId` goes to `scoreChain` (`chains-plan.md`), whatever its format; this includes Juan, whose row is
   `format: 'tag'` plus `chainId: 'sootopolis-gym-juan-wallace'` (`fights.ts:174-175`), and the `'single'` chains (Oceanic Museum, Space Center 2F, the Sootopolis groups; all script-derived, `chains-plan.md`; there is no Weather Institute chain). Rows without `chainId` dispatch on `format`: `'single'` to `scoreTeam`,
   `'double'`, `'tag'` and `'multi_2_vs_2'` to the `doubles-plan.md` evaluators. Until D1/D2/D3 land those
   fights return `unsupported` and are reported as excluded, never silently scored as singles. In `multi_2_vs_2` fights the player brings 3 of the 6 (`doubles-plan.md:131`): the solver evaluates all 20 three-mon subsets on a reduced sample
   (20 games each) on TUNING seeds, picks the best, and only then runs the full sampler on REPORT seeds (choosing the subset on report seeds would reintroduce selection bias). The subset choice is part of that fight's own tuning unit
   (decision 7): the subset is picked with the fight's starting build, then only the three brought mons' builds are tuned for that fight (the other three do not play it).
4. **Win probability is a Wilson interval, sequentially sampled with a correction for repeated looks.** Games run in batches of 40 with at most 10 looks (400 games). Looking after every batch and stopping at the first decisive
   interval inflates the error of a nominal 95% interval, so each look uses a Bonferroni-corrected per-look level of 0.005 (two-sided z about 2.81), which keeps the OVERALL error at or below 5%; the report labels the interval
   "95% simultaneous over up to 10 looks" and states the per-look level. **What `won` effectively demands**: with z about 2.81, `won` needs at least 71 straight wins (80 in batches of 40), and at 400 games an observed 0.95 gives a corrected
   lower bound of only about 0.91, so `won` in practice needs a true win probability of roughly 0.94 or more and teams near 0.92 will always come out `uncertain`; this is the price of the "never a bare verdict" rule and is shown to Yoshi with the first report. A fight is `won` if the corrected lower end is at least 0.90, `lost` if the corrected upper end is below 0.50, else `uncertain` at 400 games. (At 40 straight wins
   the corrected lower bound is below 0.90, so a `won` verdict needs more than one batch, by design; Step 1.1 tests the numbers.) Games are independent draws of the stochastic pipeline even though the expectimax policy is itself sampled.
   **The verdict is the search's stopping rule** (2026-11-18, satisficing): one sampler run costs 80 to 400 games for a `won` build (at least 2 batches) and as little as 40 for a clearly `lost` one, and the search for a unit stops at the first build that is `won` (decision 7); no sampler run is ever continued past a decisive verdict to separate two winning builds.
5. **Seeds are allocated by purpose so tuning and reporting can never overlap.** The allocator does not depend on StageKey groups or on tuning units: every unit (fight or chain) draws `g = 1, 2, ...` from the same offset of its purpose, which is
   allowed because different units are different fights and no statement compares them as one sample. Every evaluator derives battle seeds from `seedOffset + g*1000 + k` (singles use `k = 0`; chain stage `k`, `chains-plan.md` decision 4), with the
   tuning offset 0 and the REPORT offset 10,000,000, valid for `g < 10,000` and `k < 1000` (so the two ranges are disjoint by construction). The Step 1.1 test enumerates the actual seeds each evaluator produces for the tuning
   and report purposes and asserts the sets are disjoint; the old 1001.. fresh set (`solverCli.ts:114`) is replaced by the report offset. Only report-seed results are ever reported, and report seeds are never used to CHOOSE anything:
   every choice (builds, the `multi_2_vs_2` subset of decision 3, the gym-trainer set `D_g` of decision 8, the what-to-change ranking of decision 6) is made on tuning seeds, and report seeds only confirm the chosen item. When decision 8
   confirms a second or third candidate after a failed confirmation, the next candidate is still picked from tuning results alone; the only report-seed information it uses is "the previous candidate was not confirmed" (the same holds for a unit's build search after a failed or `fragile` confirmation, decision 7). **One exception, the starting build** (decision 7): it is fixed before any game of its unit is played (`defaultSet` or the previous unit's reliably-won build), so it carries no selection bias for this unit and is sampled DIRECTLY on report seeds; if it is `won` and not `fragile` that is the reported result, and if not, the search runs on tuning seeds and the starting build's report result is never used to rank candidates. **"Fresh report seeds" means the report offset, not unused seeds**: every report-seed use (decision 8's confirmations
1, 2 and 3, decision 6's what-to-change re-scoring, decision 10's sensitivity runs, and the per-fight report) draws `g = 1, 2, ...` on the report offset from `g = 1`, so the same report seeds are REUSED across those uses.
That is allowed because every error statement in this plan is a union bound (decision 8: 3 x 5%; decision 10: 0.05/6 per comparison), which holds without independence between the tests; what stays forbidden is choosing anything
on report seeds. This changes the solver's singles seeds from `seedOffset + g` to `seedOffset + g*1000`, so solver OUTPUT numbers change;
    "no singles result changes" in Verification means sim mechanics, not solver outputs (no unit test pins solver numbers; only the two bench tests and `solverCli` call `scoreTeam`/`playExpectimaxBattle`).
6. **The search returns structured candidate records, one record set per tuning unit.** The unit's feasibility search (decision 7; it replaces `improveTeam`'s coordinate ascent, `solver.ts:350-397`, which keeps no record) returns, per generation (the landed code's "round", `satisficingSearch.ts:50-55`), one record for every individual evaluated in it:
   `{ change, genome, origin, screenFitness, screenGames, tuneVerdict?, tuneWins?, tuneGames? }`. `genome` is the six pool indices with their role parameters plus the team genes (decision 7 (c3)); `origin` is `seed`, `elite`, `crossover`, `mutation:pool`, `mutation:param`, `mutation:lead`, `mutation:team` or
   `mutation:repair` (with the parent genomes, so the report can say where a winning set came from); `change` is `teamDiff` (decision 9a) against the unit's STARTING build (not a parent), matching members by species rather than by array index, plus the lead.
   **`screenFitness` is the graded fitness** (2026-11-24), the mean over that individual's tuning games of a per-game score `won + removed + 0.25 x kos / n`, where `won` is 1 for a win and 0 otherwise, `removed` is the fraction of
   the opponent side's total HP removed by the end of the game (0..1), `kos` the opponent mons fainted and `n` the opponent's party size. A won game scores 2.25 and any other game (lost, `DREW`, `MAX_TURNS`) at most 1.25, so one
   win outranks any loss; the weights are placeholders calibrated by Step 2.6b. It replaces `fitnessValue` (`solver.ts:31-33`, `winRate + 0.02 x meanScore`) as the screening signal
   because that term is weighted 0.02 and mixes the player's own HP with the opponent's (`positionScore`, `expectimax.ts:1037-1041`), so when no candidate wins (the Step 0.4 case: 0 of 26 starting builds won) it barely separates them.
   For a chain, `removed`, `kos` and `n` are summed over every member reached, so getting further into the chain scores higher. It needs the end-of-game opponent HP and faint counts from the battle summary (Step 2.2).
   It stays ONLY a screening signal for ordering candidates, never an objective and never shown as a probability; `tuneVerdict`/`tuneWins`/`tuneGames` are present for the candidates confirmed with the sequential sampler. For a chain the record also keeps, per member, the fraction of games that ended on that
   member, so the report can say WHICH member the change helps. "What-to-change" (decision 9b) applies only to units that end NOT reliably `won` (cap reached): it re-scores the 3 confirmed candidates with the highest tuning win rate (wins/games), taken from that unit's own records (each unit has its own build, so a neighbour changes only
   that unit), on the REPORT seeds with the sequential sampler (cost included in decision 12). For a chain the reported quantity is the chain's win probability; a chain member is never
   given its own verdict or its own what-to-change, because its build cannot change inside the chain.
7. **Per-fight builds; one build per chain (Yoshi, 2026-11-17).** The 6 species come from `--team` and are fixed for the whole run (the Mega choice is a build field: a Mega form replaces its base species in the build, `megaFormsFor`,
   `solver.ts:246`, so the six BASE species stay fixed). One build per StageKey is REJECTED: many fights need a specific build. **Tuning units**: every ordinary (non-gauntlet) v1 row is its own unit with its own build (moves, held item,
   ability, nature, EVs from the template set, Mega choice), tuned on that fight alone; every chain (consecutive fights with no heal between: the Oceanic Museum chain, Space Center 2F grunts 5/6/7, the Juan + Wallace stages, and the three
   Gym 8 group chains once they are re-enabled) is ONE unit with ONE build for all its members, because the player cannot re-build between members. **A chain's objective** is its win probability played as a sequence with HP, PP and
   status carried between members (`scoreChain`, `chains-plan.md` decisions 2 and 4), never a mean of its members played independently: **the sampling unit is one full chain game** (member 1 from a healed party, each later member from the carried party,
   stage `k` of game `g` seeded `seedOffset + g*1000 + k`), and a chain game is **won only if every member is won in sequence** (a member lost, `DREW` or `MAX_TURNS` ends the game as a chain loss, `chains-plan.md:89`). The chain's verdict
   (decision 4) is on that win/loss count. Units are independent: there is no objective across fights, no assignment of fights to groups and no tie-break between fights, and tuning one unit never changes another unit's build.
   Each unit is tuned at its fight's StageKey (cap, innate gate, Mega availability: decision 1; every member of a chain shares one StageKey on the route). A gym-leader unit is its gym's empty defeated set (every guarded event active), the first
   candidate of decision 8's search.
   **Satisficing per unit (Yoshi, 2026-11-18).** The goal per unit is ONE build that is reliably `won` (decision 4 verdict `won`, then not `fragile`, decision 10), found as cheaply as possible; nothing is optimized past that.
   (a) **Starting build.** The previous ordinary unit's (or chain's) reliably-`won` build on the route, re-levelled to this unit's cap (WARM START), when one exists; otherwise `defaultSet` (`solver.ts:197-239`, as `solverCli.ts:99` builds
   it: `defaultSet(data, species, level, allowedStones)`) at this unit's cap and stones. Why warm: consecutive route fights are close in level and stage, so a build that already wins the previous fight is the likeliest to win this one without
   any search, and it keeps the player's re-build between fights small (decision 9a). Levels only rise along the route and Mega availability only grows, so a warm build stays legal in practice; it is still re-checked (move legality below) and
   any illegal field falls back to `defaultSet`'s value for that mon. Everything stays free to change between non-gauntlet fights: the warm start is a starting point, not a constraint. Cost of warm starts: units run in ROUTE ORDER
   (parallelism is within a unit: sampler batches, neighbour screens); if Step 0.4 shows warm starts do not raise the share of units won at the start, the default becomes `defaultSet` for every unit and units run in parallel.
   (b) **Sample the starting build** with the decision-4 sampler on REPORT seeds (decision 5's starting-build exception). If `won`, run the decision-10 fragility check; if not `fragile`, the unit is DONE (cost: one sampler run, typically
   80-120 games, at most 400, plus the fragility runs). Only a unit that is not reliably `won` gets a search.
   (c) **Feasibility search: a genetic algorithm over whole sets (revised 2026-11-24; replaces the single-attribute neighbour rounds of the 2026-11-18 revision).** Why: a unit whose starting build loses needs, in the worst case,
   every member rebuilt (4 moves, item, ability, nature, EV template, Mega choice for each of 6 members: about 40 single changes), while one 2026-11-18 round screens the neighbours of all six members together (`satisficingSearch.ts:116-127,195-196`:
   up to 6 x 120 x 4 = 2,880 games) plus up to 3 sampler runs of 40-400 games, and accepts ONE single change, so `UNIT_CAP` funds about 2 rounds when every member has 120 neighbours and more only when the pools are smaller (the
   2026-11-24 discussion quoted 4-9; either way far short of 40); and single changes are greedy (a stronger move of a type the set already has screens better than the coverage move the fight needs, because neither wins yet).
   Everything below runs on TUNING seeds; nothing in (a), (b), (d) or the confirmation rule changes.
   **(c1) Set pools come from the offline step (decision 16; seventh revision, replaces the per-unit pool building of the sixth).** For each of the six species the unit's pool is the decision-16 pool for (species, the fight's badge
   stage): at most about 5 role-tagged sets (moves, ability, item, nature, EV template, role, Mega form where `stoneAvailability` allows it), plus the starting build's set as entry 0 with the role the decision-16 coherence rules give its
   moves (`attacker` when none fits). Pools are not rebuilt per fight; the fight only fixes which stage's pool applies (level-up moves up to the stage's cap, Mega availability by StageKey, decision 1).
   **(c2) Per-fight screen (no simulated games).** For the unit's opponent party (`trainers.json` at the run's tier, at the fight's level, `battle_main.c:1819-1827`) build a matchup table `M[set][opponent mon]` over the pool sets only, from
   the engine's damage path (`calculateMoveDamage`, all 16 rolls, abilities and items included, neutral field) and `kochance.ts` (`calcKoChances`, `guaranteedKoHits`, `minimumPossibleKoHits`): the set's best hits-to-KO on that opponent
   mon, that mon's best hits-to-KO on the set using its REAL moveset, who moves first (stats from nature, EV template, item and level), and whether the set resists or is immune to every damaging move that mon has. From one row a pair is
   classed as **answers** (the set KOs first, counting the speed order and both hits-to-KO), **walls** (survives that mon's best move at least twice and is not out-damaged) or neither. Status, hazards and set-up are not scored by this table:
   they are the roles' job (decision 14) and are judged by simulated games. Screen cost is CPU only, unmeasured (Step 2.6 records it).
   **(c2a) Lead plans (Yoshi, 2026-11-24).** The opponent's lead (its party slot 0) is the one matchup known before the battle, so every set that may lead is also scored by how it exploits that mon, under one of three plans:
   **KO** (moves first and KOs it in one hit, or in two when it cannot KO the set first; Focus Sash, Sturdy-type abilities, priority moves and speed-raising entry abilities on that mon count against it);
   **wall** (takes no meaningful damage from any of its moves); **set up and sweep** (a set-up sweeper or Baton Pass support whose role rule, decision 14, would boost on the turn-1 state, and which at the boosted stages, computed by the
   same damage path, outspeeds and KOs in one or two hits some of the remaining opponent mons). **Predicted switch.** For wall and set-up plans the screen calls the real AI (`chooseAiAction`, `chooseAiAction.ts:192`, which runs the
   ported switch decision and `getMostSuitableMonToSwitchInto`, `aiSwitching.ts:291`) on a turn-1 state of that set against the lead, over 3 seeds as the role policy does, and records the switch probability and the predicted switch-in.
   A wall plan scores only when the set also carries a move that answers the predicted switch-in (or the AI does not switch): the role policy's damage choice targets the predicted switch-in when the AI is predicted to switch
   (decision 14), so that is the line it plays. **Not in v1**: switching our own mon into the predicted switch-in (a double switch); the team layer's `counter` purpose judges the mon actually on the field. **Not in v1**: disable plans
   (Taunt, Encore); Encore triggers an AI switch rule (`aiShouldSwitch.ts`, `shouldSwitchIfEncored`). **Sweep scoring**: a sweep plan does not need to KO the whole remaining party; it marks the remaining opponent mons the boosted set
   handles, and the assembly (c4) requires teammates to answer the others. A sweep-stopper (priority, Haze, Roar/Whirlwind, an ability that ignores stat stages, a faster Choice Scarf user) cancels the sweep only against the mon that has
   it. **One predicted replacement**: under a KO plan the set is still active when the lead faints, so the screen calls the ported replacement choice (`createAiOpponentReplacement`, `aiSwitching.ts:394`) on that state and records the
   mon the AI sends next; the assembly requires the lead or a teammate to answer it. No further step is predicted, because each later step depends on who won the previous exchange.
   **(c3) Genome and decoding.** An individual is one team: per member (in `--team` order) one pool index, which fixes the set and its ROLE, plus that role's parameters (decision 14: at most 2, 3-4 values each); and team genes: the lead
   (which member is sent out first), `preserve` (one member, or none), the order of the six switch purposes (a permutation), an on/off flag per purpose, and the switch-in safety threshold. It decodes to a `Team` in `--team` order, a
   `leadIndex` passed to `createSession` (`session.ts:44,316-318`) and the policy configuration, so member order never changes and `teamDiff` stays a per-species comparison (it also reports role, parameter and team-gene changes).
   Two individuals with the same genome share one record and are never played twice.
   **(c4) Initial population** (size `P`, placeholder 20). With about 5 sets per species there are about 5^6 = 15,625 set assemblies, about 94,000 with the lead, so the screen scores EVERY one by table lookups: the number of opponent mons
   answered, then walled, then the summed set scores, with the lead slot scored by its lead plan (c2a) and the coverage count running over the opponent mons after the lead (the predicted switch-in, the predicted replacement and the mons a
   sweep plan marks handled count as answered only when the plan or a teammate answers them). The population is the starting build (genome all zeros, its lead, middle parameter values, default team genes), the next `P/2 - 1` best
   assemblies with middle parameter values and default team genes, and the rest drawn from the best 1,000 assemblies with random parameters and team genes.
   **(c5) One generation.** Selection: tournament of 3 on graded fitness (decision 6). Crossover (rate 0.9): uniform per slot, a slot's set and its role parameters moving together, so a child can keep one parent's answer to threat A
   and the other's answer to threat B; the lead, `preserve`, the flags and the safety threshold each from either parent with probability 1/2; the purpose order by order crossover (OX), which always yields a valid permutation.
   Mutation (one per child with probability 0.3, placeholder): `pool` (one slot's set replaced by another pool entry; if the role changes, that slot's parameters reset to the new role's middle values), `param` (one role parameter to an
   adjacent value), `lead` (another lead), `team` (`preserve`, the safety threshold, one purpose flag, or two purposes swapped in the order), or `repair` (needs the parent's battle summaries, Step 2.2: in the parent's lost tuning games,
   take the opponent mon that fainted the most player mons and a move the parent's member never used, or a member that fainted without dealing damage, and replace that move with the one the table says answers that threat best,
   keeping the set coherent with its role by the decision-16 rules; the new set is added to that species' pool, capped at 10 entries). Elitism: the best 2 by graded fitness pass unchanged and KEEP their game records, adding games instead
   of restarting, so the best teams are measured more precisely each generation.
   **(c6) Game allocation by successive halving** (replaces the 4-game screen of every neighbour). The 18 new individuals of a generation play 2 games each; the top 9 by graded fitness play 2 more (4 total), the top 4 play 4 more (8),
   the top 2 play 8 more (16); each elite plays 4 more. Game `g` of every individual uses the same tuning seed (`seedOffset + g x 1000`, decision 5), so individuals are compared on common seeds. That is `18 x 2 + 9 x 2 + 4 x 4 + 2 x 8 + 2 x 4 = 94`
   tuning games per generation before any sampler run. **Sampler finalists**: at most `finalists` (3) individuals per generation, among those with at least 16 tuning games and an observed win rate of at least 0.75 (placeholder; a
   team below that cannot be `won` and a sampler run on it would cost 40-400 games for nothing), in graded-fitness order, run the decision-4 sampler on tuning seeds; the search STOPS at the first whose tuning verdict is `won`. That candidate is confirmed
   ONCE on report seeds with the full sampler and, if `won`, checked for fragility; if it is reliably `won`, the unit is DONE with that build. A failed or `fragile` confirmation sends the search back to the next tuning-`won` candidate
   (from tuning results only, decision 5), **at most 3 report-seed confirmations per unit** (the same rule as decision 8). If a generation yields no tuning-`won` candidate, the next generation is bred from the current population (there
   is no single incumbent, no epsilon and no pass count). (d) **Hard cap** `UNIT_CAP`: placeholder 6,000 tuning games per unit (the previous revision's
   per-unit ESTIMATE of a full coordinate-ascent run, reused as a CAP, not an expected cost; unmeasured, Step 0 sets it; a chain game counts as one game here and costs about 3x, decision 12). When the cap is reached the unit is reported with the
   report-seed verdict of its best candidate (highest tuning win rate among the sampler-confirmed candidates, or the starting build if there are none; if it has no report-seed run yet, one is made, which reports and chooses nothing: `uncertain` or `lost`, or `won` but `fragile`) and what to change (decision 9b). The cap counts tuning games only; report-seed confirmations and fragility
   runs are bounded by the 3-confirmation rule. Moves must be learnable at the fight's level (`learnableMoves`); a species whose evolution level exceeds the cap gets the D5 warning (printed, not enforced); a build with a move not learnable at
   the fight's level is rejected and, if no legal build exists, the unit is `not-yet-legal`. `FitnessEvaluator` stays one unit per evaluator (a fight, or a chain through `scoreChain`), and the worker protocol carries that unit's spec (below).
8. **Minimal gym trainers beaten (Yoshi, 2026-11-17).** A full clear is winning every `mandatory` fight through the Elite Four and Champion, all 8 gyms included. The search variable is, per gym 1-7, the set `D_g` of that gym's optional
   trainers beaten before its leader (the Context table; Gym 8 has no choice). Beating a trainer removes its guarded events from the leader fight (`battleEventSetup.ts:32-40`), so each `D_g` changes only gym g's leader fight and needs its
   own sample of that fight at its fixed StageKey; non-leader fights are evaluated once. Because the gyms are independent, the goal (the fewest `|D_1| + ... + |D_7|` with every mandatory fight reliably `won`) splits into seven searches,
   each SATISFICING: the first reliably-`won` set in increasing `|D_g|` is the answer and the search stops there.
   **Interaction with per-fight builds (satisficing, 2026-11-18).** The leader fight is its own tuning unit (decision 7), and that unit IS the gym's first candidate, `D_g = {}`: it runs decision 7 in full (starting build, then the feasibility
   search up to `UNIT_CAP`). If it ends reliably `won`, the gym's answer is the empty set at zero extra cost. Otherwise each later candidate set is handled the same way, cheaper: the leader fight is FIRST sampled at that set (tuning seeds) with
   the CURRENT leader build (the build with the highest tuning win rate found so far for this gym, at any set), and the decision-7 feasibility search is run for that set ONLY if that sample is not tuning-`won`, with a per-set budget `SET_CAP`
   (placeholder 1,500 tuning games, unmeasured) inside a per-gym budget `GYM_CAP` (placeholder 12,000 tuning games beyond the empty-set unit, unmeasured); both are Step 0 outputs. When `GYM_CAP` is spent the gym is reported `uncertain`
   (or `lost`) with the best candidate set and build found, the smaller sets tried, and what to change. Every `W` entry is keyed by (set, build hash), so a sample made with one build is never reused for another. The answer is a (set, build)
   pair: the reported leader build is the one that won at the answer set, which may differ from the empty-set unit's best build.
   **Consequence for the frozen-build shortcut.** A set that is `won` with the current build WITHOUT a search reuses a build found at another set, which was never searched for this set and may win it only marginally. That is acceptable for a
   satisficing answer only because the reliability check runs on the exact (answer set, build) pair: its report-seed confirmation and its decision-10 fragility check are made at that set with that build; a `fragile` result counts as a failed
   confirmation (below). Nothing is claimed about that build at any other set, and the empty-set unit's verdict is reported separately. Non-leader units do not enter a gym's search: a gym trainer beaten is assumed beaten and not simulated
   (below), and the other fights' builds are tuned and reported independently.
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
   **Choose on tuning seeds, confirm on report seeds** (decision 3/5: choosing on report seeds would reintroduce selection bias; the empty-set unit's starting build is decision 5's starting-build exception). (i) Candidate sets are taken in ONE
   fixed order: increasing `|D_g|` (layers: size 0, then size 1, ...), and within a layer lexicographic order of the sorted ids. Each is handled as above (sample with the current build, budgeted search only if needed) on TUNING seeds, and
   enumeration STOPS at the first set that is tuning-`won` (with the build that won it). (ii) That (set, build) is confirmed ONCE on REPORT seeds (decision 5) with the full sampler and, if `won`, checked for fragility (decision 10); if it is
   reliably `won`, it is the answer and the gym's search ends. If not, enumeration RESUMES after that set in the same order to the next tuning-`won` set, up to **at most 3 confirmations per gym**; if none is reliably confirmed, the gym is
   reported `uncertain` with the candidates tried and their report intervals. There is no ranking by win rate across sets and corrected lower bounds are never compared across sets: the first tuning-`won` set in the order is the one confirmed.
   **The answer is "fewest battles among the sets the budgeted search made tuning-`won`"**, not "fewest battles that win": a smaller set can be truly winning yet come out tuning-`uncertain` (sampling noise, or a winning build the
   `SET_CAP` budget did not reach), so the report also lists every enumerated set smaller than the answer that was not tuning-`won`, with its tuning win rate and the games spent on it. A larger set later in the same layer is never tried once
   an earlier set of that layer is reliably `won`, so the answer is the lexicographically first winning set of its size, not the most robust one.
   If the enumeration ends (every reachable set tried, or `GYM_CAP` spent) with no confirmation, the gym is reported `uncertain` (or `lost` if every set tried came out tuning-`lost`) with the best (set, build) found, which gets one report-seed run that reports and chooses nothing.
   **Error rate, stated honestly.** Each reported answer rests on ONE report-seed confirmation at the decision-4 level (overall error at most 5% for that test). Because up to 3 candidates may be confirmed per gym, the chance that a gym's
   reported `won` is false is at most 3 x 5% = 15% in the worst case (union bound), and nothing controls the error jointly across the seven gyms; the report prints, per gym, the number of confirmations attempted so the reader can apply this.
   **Monotone shortcut.** If Step 0.5(d) shows every guarded event favours the leader, then after the empty-set unit (which always runs first) the full set is tried next, with its `SET_CAP` search; if it is NOT tuning-`won`, no other set
   is tried, and the gym is reported as above. That is all the shortcut licenses: a sampled verdict can be non-monotone across sets (sampling noise, budgeted searches, and events interact), so when the full set IS tuning-`won` the order of
   (i) resumes at size 1 as usual (the full set's (set, build) result is reused when its layer is reached); no other pruning by subset is done.
   All non-leader mandatory fights carry their own verdicts regardless. Beaten gym trainers are assumed beaten: their own battles are not simulated in v2 (stated in every report).
   Mossdeep (`forcedDouble`) and the Gym 8 tag fight return `unsupported` until D1/D2/D3 land; until the sim evaluates Mossdeep's count guards (they are dropped today, `battleEventSetup.ts:41-43`) its search is excluded and reported as such.
   The count-based selector (Step 3.2) must also fix the other guard `eventsForFight` drops: Juan's always-on `BATTLE_EVENT_TENSE_BATTLE` under `!(flag(FLAG_BADGE08_GET))` (Context), which holds on the first Juan fight and must be
   registered for it. That fix is checked by a unit test only: the Juan fight is a tag chain and returns `unsupported` until D1-D3 land, so no Juan verdict is produced in v2 before then.
9. **Reports.** (a) Per tuning unit, its starting build's source (warm start from which unit, or `defaultSet`), whether it was won without search, the games spent (starting run, tuning search, confirmations), and a field-by-field diff of its
   reported build against its starting build, plus, per consecutive pair of ordinary fights on the route, what changes between their builds (the re-build the player does between those fights). The reported build is A reliably-winning
   build, the first found, not the best one, and the report says so. (b) For each unit that ends NOT reliably `won` (cap reached), the 3 candidates of decision 6 with report-seed intervals and deltas. (c) A loss anatomy from
   a small battle summary (which stage/mon the losing games ended on; first-faint turn histogram) that `playExpectimaxBattle` returns alongside `{outcome, turns, finalScore}` (`expectimax.ts:1171-1195`).
10. **Sensitivity ("fragile") is a defined perturbation experiment, and part of "reliably `won`".** Only units (and gym (set, build) pairs) whose report-seed verdict is `won` are tested, each with its own build; a `won` result that is `fragile` is NOT reliable: inside a search it counts as a failed confirmation (decisions 7 and 8), and at the cap it is reported `won, fragile` (for a chain, each perturbation is applied at turn `t` of every member, so a chain still has 6 perturbed runs, scored as chain wins). The perturbation acts on the OPPONENT's real action (the AI's chosen move in the turn step); the player policy's
    predictions of the AI (the role policy's 3 `chooseAiAction` samples, decision 14; formerly expectimax's `sampleOpponent`) are NOT perturbed, because the player does not know the AI will deviate. At decision turn `t` in {1, 2, 3}, the AI's chosen MOVE is replaced by its `r`-th best-scoring legal move for `r` in {2, 3} (AI move scores from `chooseAiAction`;
    switch decisions are not perturbed; ties in AI score are ranked by move slot order, deterministically). The hook site is the REAL AI call in the turn step (`driver/session.ts:446-448`: `let opponentAction` at `:446`, the `fixedOpponentAction === undefined` test at `:447`, `chooseAiAction(state, 1, ...)` at `:448`; `stepTurn`, reached from the game loop's `stepTurn(session, ...)` call at `expectimax.ts:1193` with no fixed opponent action), not `sampleOpponent`. If the AI switches at turn `t`, or has fewer
    than `r` legal moves, the perturbation does not apply: the game stays in the sample as unperturbed and the report prints the fraction of games where it applied. That is 3 x 2 = 6 perturbations, each a fixed 100-game run on the report seeds. A fight is `fragile` if any perturbed run's win-rate interval, with the per-comparison level corrected by 6 looks (0.05/6), has an upper end
    below 0.90 (it is distinguishable from `won`). The turn window and ranks are Step 0.3 calibration outputs on known fights, not final constants.
11. **`widePool` stays OFF by default in v2.** (2026-11-24, seventh revision: SUPERSEDED for the solver. Pools now come from decision 16, whose role-coherence rules decide which status and utility moves a set carries, so there is no move-candidate pool for `widePool` to widen; the flag stays for `improveTeam` only until that is removed, Step 2.1. The text below is kept as history.) A `--wide-pool` flag turns it on, with `maxNeighbours` 120 unchanged (it samples the larger pool deterministically). The reason: it adds every learnable status and utility move to the neighbour pool, which grows the search (the neighbour cap of 120 samples a larger pool, so improvement per neighbour falls) while the
    value terms for such moves (`statusTerms`, cycle 147) are recent and unmeasured in search; the verified-effect gate (`VERIFIED_MOVE_EFFECTS`, each entry mapped to a proving test, `solver.md:41-44`) already restricts WHICH status moves are eligible,
    so this is about cost and measured benefit, not correctness of the gate. Revisit trigger: Step 0 measures, on 3 fights that the starting build does not win, whether `--wide-pool` reaches `won` in fewer tuning games (the satisficing measure; not a win-rate gain); `solver.md` records the result. ("D6" in older notes means the finished
    move-pool work, STATE.md:58,86; the mutation plan `ported-by-mutation-plan.md` is a different item with the same label at STATE.md:291.)
12. **Cost budget: expected cost (depends on Step 0 measurements) under a ceiling.** Every figure below is an UNMEASURED estimate; 8-worker figures assume perfect scaling. Per-game time: about 1.4 s per singles game single-threaded (`solver-evaluation.md:65-73`, noisy); a chain game
    about 3x (it plays up to three members); doubles and `multi_2_vs_2` games are unmeasured and costed at the singles figure.
    **Tuning units (v1), counted from `story-route.md`.** The v1 fight set is the 34 `fights.ts` rows that are neither `deferred` nor `excluded` (43 rows after d5-1c minus the 7 deferred rows of steps 1, 15, 26, 30-33 minus the 2 excluded
    Wally VR rows, `story-route.md` "Deferred fights" totals). Chains merge into one unit each: the Oceanic Museum chain is three rows (`TRAINER_GRUNT_MUSEUM_1`, `_2`, `TRAINER_ARCHIE_SLATEPORT`, `fights.ts:238-272`, step 8) and becomes one
    unit (34 - 2 = 32); the Space Center 2F chain (`TRAINER_GRUNT_SPACE_CENTER_5`, `fights.ts:354-361`, step 27) and Juan + Wallace (`TRAINER_JUAN_1`, `fights.ts:167-175`, step 34) are already one row each; the three Gym 8 group chains are
    deferred. So **32 tuning units: 29 ordinary fights + 3 chains**. The 29 ordinary fights (route step): Petalburg Woods grunt (2), Roxanne (3), Rusturf grunt (4), May 2 (5, `mandatory: false` but on the route and in the 34), Steven Granite
    Cave (6), Brawly (7), May 3 (9), Wally Mauville (10), Wattson (11), Courtney Meteor Falls (12, `multi_2_vs_2`), Maxie Mt Chimney (13), Flannery (14), Courtney Sunhollow (16), Norman (17), Steven Route 118 (18), Shelly (19), May 4 (20),
    Winona (21), Archie Mt Pyre (22), Maxie Magma Hideout (23), Matt (24), Tate and Liza (25, double), Maxie + Courtney Mossdeep (28, `multi_2_vs_2`), Archie Seafloor Cavern (29), Sidney, Phoebe, Glacia, Drake, Steven (36-40).
    Units that return `unsupported` until D1-D3 land (the doubles, the multi fights, Juan) are still counted, so this is the cost once they land.
    **Expected cost versus ceiling (satisficing, 2026-11-18).** Weights: `w = 1` for an ordinary unit, `w = 3` for a chain (a chain game costs about 3 singles games), so the 32 units weigh `29 + 3 x 3 = 38` singles-game equivalents per game.
    Per-unit terms, all UNMEASURED: `S` = one sampler run of the starting build on report seeds (80 to 400 games for a `won` build; typically about 120, the previous revision's adaptive average); `F` = one fragility check (decision 10:
    6 perturbations x 100 games = 600); `C` = the tuning games a searched unit spends until its first tuning-`won` candidate, at most `UNIT_CAP` (placeholder 6,000: the previous revision's per-unit coordinate-ascent ESTIMATE, 120
    neighbours x 4 screen games + 3 x 16 confirms = 528 per member per pass, x 6 members x 2 passes = 6,336, now used only as a CAP). **With the genetic algorithm (2026-11-24)** one generation costs 94 tuning games (decision 7 (c6))
    plus 0 to 3 sampler runs of 40-400 games each, so `UNIT_CAP` 6,000 is about 64 generations with no sampler run (6,000 / 94) and about 4-5 if every generation sends 3 finalists to 400-game runs (6,000 / 1,294); the realistic count depends on how often
    finalists qualify, unmeasured until Step 0.4(b) runs on the GA. The screen and pool building (c1-c2) play no games and are not in `C`; their CPU time is recorded by Step 2.6b (the offline pools of decision 16 cost nothing per run). The cap, and so every row below, is unchanged by this revision. **With role policies (seventh revision)** the per-game time changes in both directions and is UNMEASURED: a turn costs one simulated step, the AI's real action and 3 predicted
    `chooseAiAction` calls (decision 14), instead of expectimax's about 54 one-turn steps per decision, so a turn should be far cheaper; but games may run to 200 turns (decision 15) instead of 60, and stall games are long by design. Step 2.0b
    measures time per game on Yoshi's six fights, and every hour figure below (which assumes 1.4 s, or the measured 2.69 s of expectimax games) is to be redone from it; `R` = one report-seed confirmation (at most 400), at most 3 per unit, each followed by `F` when `won`.
    **Formula**: expected games = `sum over units won at the start of w x (S + F)` + `sum over searched units of w x (S + C + c x (R + F))`, with `c` <= 3 confirmations. A unit won at the start costs about `120 + 600 = 720`; a searched unit
    costs at most `400 + 6,000 + 3 x (400 + 600) = 9,400`. **How many units need a search is UNKNOWN until Step 0 measures it (Step 0.4), and so is `C`**; the worked range below puts every searched unit AT its cap (the upper end of each
    row) and counts searched units as ordinary (a searched chain counts 3 toward `k`); per-game 1.4 s single-threaded, the plan's unmeasured figure:

    | Searched (weighted) `k` of 38 | Games: `(38 - k) x 720 + k x 9,400` | Single-threaded | 8 workers |
    |---|---|---|---|
    | 0 | 27,360 | about 10.6 h | about 1.3 h |
    | 5 | 70,760 | about 27.5 h | about 3.4 h |
    | 10 | 114,160 | about 44.4 h | about 5.5 h |
    | 20 | 200,960 | about 78.2 h | about 9.8 h |
    | 38 (all 32 units, ceiling) | 357,200 | about 139 h | about 17.4 h |

    **Measured inputs (Step 0.4, cycle8).** `k`: **26 weighted**, because none of the 26 measured singles is won by its starting build (0 won, 19 lost, 7 open at 80; chains and the three non-single ordinary units unmeasured); 35 if the 3 chains are searched too, 38 = this table's ceiling row if the three unsupported ordinary units also need searches. Per-game time: **median 2.69 s** (1,360 games over the 26 units, 9 measurement processes on 8 cores, single run, contended), 1.9x the 1.4 s this table assumes. `UNIT_CAP`, `SET_CAP`, `GYM_CAP`: **no data — all three need the d4-2 feasibility search**, so the placeholders 6,000 / 1,500 / 12,000 stay; the only measured input for `GYM_CAP` is the 40-game (at most 80) cost of sampling one candidate set that needs no build search (Step 0.4 (c)).

    The fragility checks dominate the `k = 0` row (600 of 720 per unit); without them it would be 38 x 120 = 4,560 games, about 13 min on 8 workers. The ceiling row is the old fully-searched build-tuning figure (29 x 6,000 + 3 x 3 x 6,000 =
    228,000 singles-game equivalents, about 89 h single-threaded, 11 h on 8 workers) plus the starting runs, the 3 confirmations and the fragility checks the old figure did not count; it is an UPPER BOUND, not an expectation.
    The two `multi_2_vs_2` subset screens (decision 3) add 2 x 20 x 20 = 800 games, negligible.
    **Gym-trainer search (decision 8)**: a gym whose empty-set leader unit is reliably `won` costs nothing beyond that unit (already in the table). Each other gym costs at most `GYM_CAP` (placeholder 12,000 tuning games, covering the samples
    and `SET_CAP` searches of every later set) plus 3 x (400 + 600) report-seed games = 15,000 games, about 5.8 h single-threaded, about 44 min on 8 workers; for 7 gyms, a CEILING of 105,000 games, about 41 h single-threaded and 5.1 h on
    8 workers. `GYM_CAP` truncates the enumeration of the large gyms (Lavaridge and Petalburg have 128 sets each, 335 over gyms 1-7 under every tag-battle outcome): a gym that spends it is reported `uncertain`, so the cap is a choice, not a
    measured need, and the old enumerate-everything ceiling (335 sets x 400 games + 8,400 confirmations = 142,400 games) is no longer reachable.
    **Whole-run ceiling**: 357,200 + 105,000 + 800 = about 463,000 singles-game equivalents, about 180 h single-threaded, about 22.5 h on 8 workers (the previous revision's 375,000 / 18 h counted no fragility checks or starting runs). The
    expected cost is the table row Step 0 points to plus the gyms that need a search, and is likely far below the ceiling, but that is not measured. The plan therefore starts with reduced
    search options (smaller `maxNeighbours`) and measures before committing to defaults; the `solverWorker.ts` protocol (today one fixed `{ trainerId, tier, battleEvents }` per worker, `solverWorker.ts:8-12`) carries a per-message unit spec
    (a fight or chain, its StageKey, its `defeated` set) and build instead, and one worker pool is reused across units.
14. **The player policy is role policies plus a team layer (Yoshi, 2026-11-24); depth-1 expectimax is no longer the solver's policy.** Why: expectimax looks one turn ahead and scores the result with hand-weighted terms, every
    weight a MODEL CHOICE (a stat stage is worth 0.04 against an attack's HP fraction, `positionScore`, `expectimax.ts:1040`; screens 0.1 per turn, `:217`; one lost action 0.25, `:188`), so it undervalues set-up, hazards, speed control
    and status, the main tools of a hard game; deeper search or per-decision rollouts cost about 3-50x per game at 2.69 s per game (Step 0.4); splitting the battle into duels misses team effects such as screens; and a per-fight search
    tree or table learner cannot reach 50+ turn stall games (Decisions pending item 11). Instead every set carries a ROLE played by a cheap ordered rule list, and the GA searches roles and their parameters together with the sets
    (decision 7 (c3)), so the intelligence is in the search, not in a per-turn evaluation. Pure and headless (`web/src/engine/sim/driver/rolePolicy.ts`, no React), replacing `playExpectimaxBattle` in the solver's evaluators;
    expectimax stays only as Step 2.0's comparison baseline.
    **Shared inputs, every turn**: the damage calc against the target, speed order including priority, HP, status and field, and the **predicted AI action**: 3 samples of `chooseAiAction` (`chooseAiAction.ts:192`) on the current
    state. **Threatened** = any sample's move, at its highest roll, KOs us or removes more than the role's safety percentage of our HP; **safe** = no sample threatens, and a predicted AI switch counts as safe. When the samples predict a
    switch, damage choices target the predicted switch-in: the AI picks its move against our current active mon, so a mon we switch in faces the predicted move and judging a switch-in costs no extra AI calls. **KOs** = the lowest
    damage roll is at least the target's HP.
    **The six roles** (healer folded into staller; parameters are GA genes, at most 2 per role, 3-4 values each):
    - **attacker**: Fake Out on its first turn in when it works; else a move that KOs (a priority move when slower and threatened); else the best accuracy-weighted damage. No parameters.
    - **set-up sweeper**: boost while below the target stage, safe, and the opponent's party has no Haze, phazing move or stage-ignoring ability; else play as attacker. Parameters: target stage (+1, +2, +3, +6); safety (25, 50, 75%).
    - **staller**: status the target when it has none and our status move works on it; heal below the threshold (recovery moves, or Wish followed by Protect so the Wish lands); Protect when not used last turn (residual damage ticks);
      else residual or damaging moves. Parameter: heal threshold (33, 50, 66%).
    - **lead / hazard setter**: lay hazards while below the target layers and not threatened with a KO; then play its fallback role. Parameters: target layers; fallback role (attacker, staller).
    - **pivot**: on a bad matchup (threatened, or unable to damage the target) use its pivot move; else play as attacker. Parameter: what counts as a bad matchup.
    - **support**: set its effect when it is not up: screens, weather, terrain, Trick Room, or its OWN boosts to a target stage to pass with Baton Pass; then hand off with a pivot move if it has one (Baton Pass carries the boosts,
      because the sim does); without one, switch out when threatened and a teammate takes the predicted move better, else play its fallback role. Parameter: fallback role (attacker, staller). An effect is re-set only once it has completely expired. The sim rejects a re-cast of a live weather or terrain, a re-cast of a live Trick Room toggles it off, and a screen re-cast is accepted only with Screen Cleaner, so a refresh gene would add little.
      The support's own-boost step does NOT use the shared threatened/safe gate: it boosts only when the chance this turn's hit KOs us -- from the predicted moves and from every real-priority move in the opponent's slots -- is below 15% (`BATON_BOOST_KO_RISK`, fixed, not a gene), and a one-turn clone shows turn 2 is safe (we outspeed with no damaging priority move against us, or the two-hit cumulative KO chance is below 15%). Decided by Yoshi on 2026-11-26.
    **Pivot moves** are read from move effects in `moves.json`, not from a hand list: 12 moves today, `EFFECT_HIT_ESCAPE` (U-turn, Volt Switch, Flip Turn, Fluttering Leaf, Take Flight), `EFFECT_PARTING_SHOT`, `EFFECT_SWITCH_ARGUMENT`
    (Teleport, Safe Passage), `EFFECT_SEPTIC_SWITCH`, `EFFECT_CHILLY_RECEPTION`, `EFFECT_SHED_TAIL` and `EFFECT_BATON_PASS`; Step 1.3 also scans the battle scripts and abilities for other self-switches.
    **Team layer**, checked before the active mon's role rule. (1) **Replacement** after our mon faints: the living teammate with the best matchup against their active mon (a fresh 3-sample prediction against each candidate, its damage
    on them, speed), skipping the `preserve` member while another candidate is acceptable. (2) **Voluntary switching**: switching gives the opponent a free hit, so never switch when we can KO. Before purposes run, the **stay test** checks whether the active mon can KO the opposing active mon (KO probability times accuracy >= 0.5, `STAY_KO_CHANCE`). If some KO move outspeeds the predicted action, all purposes are skipped and we stay; if a KO move only survives (`!koThreat`), only `preserve` may run. We switch only for three reasons: keep a mon we cannot afford to lose; a negligible-loss switch-in that does something meaningful; sacrifice fodder. With no good reason to switch, damage or status is preferred. Six purposes, checked in the GENE order (a permutation), the first that fires decides, each with an
    on/off gene: **preserve** (the `preserve` member is threatened: switch it to the teammate that takes the predicted move best); **sacrifice** (fodder is a state, not a role: fires when the stay test is false, a good counter exists on the bench and none can enter safely. Active mon stays and attacks first; exception (a) active is the preserve member (the only "needed later" signal in v1), switching in the first-ranked bench fodder; exception (b) a bench mon is strictly less useful than the active mon by two lexicographic usefulness keys (can KO/set effect, and HP fraction times damage fraction) with slot tie-break (MODEL CHOICE); designated counter and preserve member are excluded from bench fodder; the ability exception -- the third exception -- is that a bench mon whose ability or innate has an `onDefender`, `onAbsorb`, `onDisguise` or `onRevive` hook in `data/v2.65beta/abilityHooks.json` is preferred as fodder when the sim's own run shows a gain, the predicted move driven through a cloned turn with that ability versus with it nulled over 32 seeds (their mon loses HP, a status bit, a stat stage, its item, its ability or its types, is forced out alive, or gains a disabling volatile; our side gains a stat stage, a hazard on their side or a field change; our HP only for `onAbsorb`; the `onRevive` single-use counter latches), so it ranks first within the fodder pool; the sim decides applicability, no condition is copied; the three `onDisguise` abilities (Disguise, Ice Face, Patchwork) and BackUp Power's `onRevive` are unported and reported as named gaps (4 pairs); Flame Body also fires at 20% without contact, not only on contact); **counter** (a teammate qualifies under the switch-in rule and threatens their mon,
    KO in two or fewer or outspeed with heavy damage, while our active mon does neither); **entry ability** (a teammate's switch-in ability from `abilityHooks.json` applies now, with an applicability check per ability, e.g. Intimidate
    against a predicted physical move, a weather or terrain setter when it is not up and our team benefits, and the teammate qualifies under the switch-in rule); **bring in support** (a support teammate's effect is not up and the teammate qualifies under the switch-in rule); **PP stall loop** (two of our mons both take little or nothing from every move their mon has: alternate them to drain its PP, indefinitely, stopping only when both sides switched every turn for 4 turns with no
    HP or PP change on either side). A switch candidate for counter, entry ability, or support qualifies only with negligible loss (predicted move costs at most `switchInSafety`% current HP, default 20: 10/20/30) and no other usable opponent move KOs it with probability >= `otherMoveKoRisk` (default 0.15: 0.05/0.15/0.30). A switch uses the active mon's pivot move when it has one (Safe Passage passing a Wish), else a hard switch. Team genes: purpose order, purpose flags, switch-in safety threshold (`switchInSafety`), other-move KO risk (`otherMoveKoRisk`), `preserve`.
    **Game facts the layer relies on**: Set battle style is forced (`new_game.c:105` and every difficulty choice in `main_menu.c:1661-1682` set `OPTIONS_BATTLE_STYLE_SET`, and `battle_script_commands.c` never reads the option), so there is
    no free switch when their mon faints. Megas: Yoshi plays Permanent Mega Mode; `GetFormChangeForMon` (`pokemon.c:6017-6022`) still needs the Mega Bracelet (Gym 5) and the stone held or in the bag, so a Mega's held-item slot is free,
    several Megas are allowed and all start Mega (`UndoMegaEvolution` returns early, `battle_util.c:8192`); already modelled (`stoneAvailability.ts:4-11`, `megaFormsFor` `solver.ts:252`). Choosing when to Mega evolve is deferred.
    **Not in v1**: a double switch into the predicted switch-in, disable plans (Taunt, Encore), Mega timing.
15. **Turn cap: 200 (Yoshi, 2026-11-24).** The game has no turn limit in trainer battles: `battleTurnCounter` stops counting at 255 (`battle_main.c:3512-3514`) and nothing ends a battle on it; the only limit is the Battle Arena's own
    counter (`:3531`), a facility format none of the fights use; the other reads of the counter (`battle_util.c:8674,8710`, `battle_events.c:81`, first-turn AI checks, Timer Ball) are turn-number conditions. The sim's `maxTurns` 60
    (`expectimax.ts:1467`) is therefore our own, and it made every stall line longer than 60 turns a loss. The cap becomes 200 for every policy, a guard against runaway games, not a rule (PP is finite and Struggle costs a quarter of max HP
    per use, so a battle ends). A game reaching it counts as NOT won for every verdict, and every report prints how many games reached it.
16. **Set pools are precomputed offline for all species, per badge stage (Yoshi, 2026-11-24): a pipeline step, Step 1.3.** In Yoshi's experience a mon has at most about 5 viable sets, and a set fixes its role (no point playing a
    staller with only attacking moves). The step writes committed data, `data/<version>/setPools.json`, read by the solver (decision 7 (c1)) and usable by the Pokedex as the build recommender (CLAUDE.md lists it as having no data
    source). Inputs, each computed once, before any fight:
    - **A pairwise synergy table** (only non-zero pairs stored) across abilities and innates, moves and held items. Ability-to-move synergy is read from the C of each ability hook in `abilityHooks.json` (the move flag, type or effect a hook
      tests: punching for Iron Fist, low power for Technician, secondary effects for Sheer Force, and so on); weather and terrain links (a setter to the moves and abilities that check that weather or terrain) the same way; plus a short
      hand list for combinations a flag test cannot show: Toxic with Protect, status with moves that punish status (Hex, Venoshock), set-up with attacks on the boosted stat, Trick Room with slow attackers, Toxic Orb with Poison Heal,
      Flame Orb with Guts, and Choice items and Assault Vest excluding status moves. Pairs miss some triples (Sheer Force with Life Orb and secondary-effect moves); summing pairs approximates them. The magnitudes are ranking guesses only.
    - **Role fit per species** from base stats, typing, abilities, innates and learnset.
    - **Role coherence**: a staller carries recovery or Wish or Protect plus status or residual damage; a set-up sweeper a boosting move matching its attacking stat; a support an effect (screens, weather, terrain, Trick Room, or boosts
      with Baton Pass); a pivot a pivot move (decision 14); a lead / hazard setter a hazard move.
    - **Candidate sets mined from boss trainers**: where the species appears in `trainers.json` (932 trainers, sets designed by the Elite Redux developers), those sets are candidates.
    - **Moves per badge stage**: level-up moves up to the stage's level cap (the Elite table, decision 1), plus every TM and tutor move the species can learn at every stage (player-observed, Yoshi 2026-11-24, not checked in the C).
    Output per (species, stage): the top about 5 role-tagged sets (moves, ability, item, nature, EV template, role), ranked by synergy and role fit, with at most two per role so the pool is not five versions of one idea. Simulated games
    judge them; nothing in this step decides a fight.

## Steps

### Step 0 - calibrate and verify (measure; no behaviour change)
0.1 Measure end-to-end time of `solverCli` itself (not `solver.bench.test.ts`, which is a reduced single-threaded benchmark) with 6 workers on one singles fight; record per-game time at depth 1 and the cost table of decision 12.
0.2 Build the sequential Wilson sampler on the existing `scoreTeam` for 3 known fights (an easy early fight, a hard mid fight, one the user considers borderline) and check the corrected-interval widths and stopping behavior against decision 4.
0.3 Prototype the AI perturbation (decision 10) on one fight; calibrate the turn window and ranks so a known-fragile and a known-stable fight separate; record the numbers.
0.4 (rewritten 2026-11-18 for the satisficing search; the 2026-11-17 species-screen check stays removed, species are user-supplied, Step 4) Measure the two unknowns of decision 12: (a) **how many units the starting build already wins**:
    sample the starting build (decision 7 (a)-(b), tuning seeds suffice here since nothing is reported) of every unit that is supported at that time (singles first), both as `defaultSet` and as the warm start from the previous unit, and record
    the count won at the start under each, which also decides decision 7's warm-start default; (b) **the per-unit search cost to the first `won`**: run the decision-7 feasibility search on at least 3 units that are not won at the start, record the
    tuning games to the first tuning-`won` candidate (or that `UNIT_CAP` was hit) and the number of rounds; (c) for one gym leader, the games per candidate set with and without a `SET_CAP` search. These give `k`, `C`, and proposals for
    `UNIT_CAP`, `SET_CAP` and `GYM_CAP`, entered in decision 12's table; the budget (Decisions pending item 4) is decided from them.

### Step 0.1-0.2 results (cycle7a)

Measured 2026-11-19 at `541d828` (cycle7a worktree). All figures are single-run and noisy.

Commands (from the repository root; `--reporter=verbose` is needed because vitest's default reporter swallows test `console.log` output):

- `SIM_MEASURE=1 npm --prefix web test -- --run --reporter=verbose src/engine/sim/driver/solverMeasure.test.ts -t 'Step 0.1'`
- the same for `-t 'Step 0.2: TRAINER_ROXANNE_1'`, `-t 'Step 0.2: TRAINER_WATTSON_1'` and `-t 'Step 0.2: TRAINER_NORMAN_1'`; the three 0.2 processes ran concurrently to stay inside the 40-minute wall-clock budget
- `npm --prefix web run solver:build`, then `node web/dist-solver/solverCli.mjs --trainer TRAINER_ROXANNE_1 --team SPECIES_SWAMPERT,SPECIES_GENGAR,SPECIES_TYRANITAR --workers 6 --passes 1`

**0.1 single-threaded depth-1 timing.** `TRAINER_ROXANNE_1`, tier `elite`, the `GENERIC_PLAYER_SPECS` team through `defaultSet(data, species, 50, new Set())`: **15 wins of 40, 123,577 ms, 3,089 ms per game**. The host had 8 cores and a load average of 1.74 when this run started (other users' processes), so the figure is contended but not by this cycle's own jobs. This is 2.2x decision 12's unmeasured 1.4 s/game, so every row of that table is optimistic by roughly that factor.

**0.1 end-to-end `solverCli`.** `npm run solver:build` succeeded and wrote `web/dist-solver/solverCli.mjs` and `solverWorker.mjs` as `vite.solver.config.ts` declares. The CLI run took **436 s (7.3 min) wall with 6 workers and `--passes 1`**. The team was reduced from the six-species `GENERIC_PLAYER_SPECS` to three species (Swampert, Gengar, Tyranitar) because the six-species search is 6 members x (4 + 120 x 4 + 3 x 16) = about 3,200 games, ~28 min at the measured per-game rate on its own; the 3-species run is 3 members x 532 = about 1,600 games. The CLI prints win rates (`start: win 0.00`, `fresh seeds (40 games): win 0.00`) but **no total games count**, so no per-game figure can be derived from it: only wall time is recorded. It also ran concurrently with the three 0.2 processes (load average peaked about 11), so 436 s is contended. It resolved the fight at level cap 16 at badge value 0.

**0.2 sequential Wilson sampler.** `scoreTeam` on the same Lv-50 default-set generic team, batches of 40, seeds 1..400 (`seedOffset = 40k`), cumulative `wilsonInterval(wins, n, 2.807)` after each look; `won` iff lower >= 0.90, `lost` iff upper < 0.50, else continue to 400.

| Fight | Look | Wins/n | p | Wilson interval (z = 2.807) | Stop |
|---|---|---|---|---|---|
| Roxanne 1 | 1 | 15/40 | 0.375 | [0.198, 0.593] | |
| Roxanne 1 | 2 | 29/80 | 0.362 | [0.230, 0.519] | |
| Roxanne 1 | 3 | 46/120 | 0.383 | [0.270, 0.511] | |
| Roxanne 1 | 4 | 68/160 | 0.425 | [0.321, 0.536] | |
| Roxanne 1 | 5 | 86/200 | 0.430 | [0.336, 0.529] | |
| Roxanne 1 | 6 | 103/240 | 0.429 | [0.343, 0.520] | |
| Roxanne 1 | 7 | 113/280 | 0.404 | [0.325, 0.487] | lost |
| Wattson 1 | 1 | 4/40 | 0.100 | [0.027, 0.304] | lost |
| Norman 1 | 1 | 14/40 | 0.350 | [0.180, 0.570] | |
| Norman 1 | 2 | 25/80 | 0.313 | [0.190, 0.469] | lost |

No fight reached `won`, so no fight was stopped early by the win rule and the designed "won needs more than one batch" path was not exercised on a real fight; the helper test covers it (40 straight wins gives a corrected lower bound of 0.835). All three fights came out `lost` against this baseline, including "easy early" Roxanne, which needed 280 games for its upper end to fall below 0.50. The Step 0.2 labels are route positions, not measured difficulty with this team, and this baseline wins a little over a third of the games. Consequence for Step 0.4: the starting build's win count will be low for these three, and the sampler's decisive-look costs are on the slow side (Roxanne 923 s under contention for 280 games, Wattson 94 s for 40, Norman 324 s for 80).

The interval helper is consistent with decision 4's own arithmetic (380/400 gives lower 0.910, "about 0.91"). One correction to the task's expected width: at 400 games and 200 wins, the Wilson half-width at z = 2.807 is **0.0695**, not 0.0644; 0.0644 is the normal-approximation half-width at z = 2.576 (or Wilson at z about 2.6). The plan's z = 2.807 is kept.

**Wall clock.** Step 0.1 took 124 s; the three 0.2 fights plus the CLI overlapped for about 19 min; the whole measurement session was under 25 min of wall time, inside the 40-minute budget, with no full-suite run.

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
    reported as an open item and that gym's search may try every reachable set (up to `GYM_CAP`).

### Step 0.5 results (cycle7b)

Read 2026-11-19 from the pinned checkout (`pipeline/.upstream/eliteredux-source`, SHA in `sources.lock.json`; nothing fetched). Step 0.4 was not done and stays d4-0c. (a) and (b) are OPEN, (c) is established for five gyms and open for Fortree and Mossdeep, (d) is established. No engine, sim or solver source changed; the only new file is the test in (d), so the expected queue gate `move_notes <= 0, ability_gaps <= 3` is unaffected.

**(a) `adddefeatedcount`: OPEN, macro body not in the pinned checkout.** Grepping `data/`, `src/` and `include/` for `adddefeatedcount` returns only the map `scripts.pory` files (the seven gyms plus Sootopolis), all call sites; there is no definition of the name anywhere in the checkout. Every call site, one block per gym, with the first call of each block carrying the extra `1`:

| Gym | Calls (arguments as written) |
|---|---|
| Rustboro | `RustboroCity_Gym/scripts.pory:543-545` `TRAINER_JOSH, 1`; `TRAINER_TOMMY`; `TRAINER_MARC` |
| Dewford | `DewfordTown_Gym/scripts.pory:712-716` `TRAINER_TAKAO, 1`; `TRAINER_JOCELYN`; `TRAINER_LAURA`; `TRAINER_BRENDEN` (comment `TRAINER_LILITH`); `TRAINER_CRISTIAN` |
| Mauville | `MauvilleCity_Gym/scripts.pory:580-583` `TRAINER_VIVIAN, 1`; `TRAINER_KIRK`; `TRAINER_SHAWN` (comment `TRAINER_ANGELO`); `TRAINER_BEN` |
| Lavaridge | `LavaridgeTown_Gym_1F/scripts.pory:629-635` `TRAINER_JEFF, 1`; `TRAINER_JACE`; `TRAINER_ELI` (comment `TRAINER_KEEGAN`); `TRAINER_COLE`; `TRAINER_GERALD`; `TRAINER_AXLE`; `TRAINER_DANIELLE` |
| Petalburg | `PetalburgCity_Gym/scripts.pory:2013-2019` `TRAINER_RANDALL, 1`; `TRAINER_MARY`; `TRAINER_PARKER`; `TRAINER_ALEXIA`; `TRAINER_GEORGE`; `TRAINER_JODY`; `TRAINER_BERKE` |
| Fortree | `FortreeCity_Gym/scripts.pory:512-515` `TRAINER_JARED, 1` (comment `TRAINER_ASHLEY`); `TRAINER_FLINT` (comment `TRAINER_EDWARDO`); `TRAINER_HUMBERTO`; `TRAINER_DARIUS` |
| Mossdeep | `MossdeepCity_Gym/scripts.pory:926-931` `TRAINER_SAMANTHA, 1` (comment `TRAINER_BLAKE`); `TRAINER_MAURA`; `TRAINER_SYLVIA`; `TRAINER_KATHLEEN`; `TRAINER_MACEY`; `TRAINER_NATE` |

Each block is immediately followed by a `switch (var(VAR_RESULT))` that picks the leader's intro text (e.g. Rustboro `:546-556`, Mossdeep's `GiveBattleText` at `:698-722`), so the count is 0..n only under the plan's unverified assumption that each call adds 0 or 1. Two facts worth recording: Lavaridge's block counts `TRAINER_ELI` (comment `TRAINER_KEEGAN`) and never counts `TRAINER_KEEGAN`, while KEEGAN (`:583`) and COLE (`:586`) are the guards, so the count block and the guard set are different id sets; and Mossdeep's first call `:926` is the extra-`1` one, as the plan said. What would settle (a): the Poryscript/macro expansion from a checkout outside the pin (unpinned, so evidence only if unchanged since the pin), or one player observation of the intro line after beating exactly one guarded trainer.

**(b) `starttagbattle` outcome: OPEN; 'both' stays the assumed default.** The same grep finds no definition of `starttagbattle` anywhere in the checkout; its only occurrences are the gym scripts (Dewford `:572`, Mauville `:522`, Lavaridge `:517`, Fortree `:410,443`, Mossdeep `:728,761,794,827,861,895`; Sootopolis has its own). The per-trainer `defeated()` checks the plan names, read exactly:

- `DewfordTown_Gym/scripts.pory:581`: `    if (defeated(TRAINER_BRENDEN)){`
- `DewfordTown_Gym/scripts.pory:593`: `    if (defeated(TRAINER_LILITH)){`
- `LavaridgeTown_Gym_1F/scripts.pory:493`: `	if (defeated(TRAINER_KEEGAN)){`
- `LavaridgeTown_Gym_1F/scripts.pory:505`: `	if (defeated(TRAINER_COLE)){`

Each trainer's script re-offers the shared tag battle only while its own flag is clear (`DewfordTown_Gym/scripts.pory:578-600`, `LavaridgeTown_Gym_1F/scripts.pory:490-519`). That SUGGESTS both ids are set but is not proof: it shows only that the script author expected each trainer to know the battle happened, not what the macro writes. The comments say the same and are equally not proof (`DewfordTown_Gym/scripts.pory:698` "by entension TRAINER_LILITH too", `:711` "brenden is a tag battle so you know the lillith flag throught it."; `MauvilleCity_Gym/scripts.pory:563`; `LavaridgeTown_Gym_1F/scripts.pory:631`; `FortreeCity_Gym/scripts.pory:492,495`). The solver keeps 'both' and the report keeps "tag-battle outcome assumed: both ids set (not in the scripts at pin ...)". What would settle (b): the macro body outside the pin, or one player observation: after beating LILITH+BRENDEN, talk to BRENDEN. If `TRAINER_BRENDEN` is set he shows the post-battle line (`:581-582`); if it is clear he re-runs the tag battle (`:584`).

**(c) opt-in prompt and sight lines.** The talk path is opt-in for every optional trainer in all seven gyms (`yesnobattle` call lines; shared scripts for the tag pairs):

| Gym | Trainers (prompt line) |
|---|---|
| Rustboro | Josh `:458`, Tommy `:473`, Marc `:488` |
| Dewford | Laura `:512`, Takao `:528`, Cristian `:543`, Jocelyn `:558`, Brenden+Lilith `:568` |
| Mauville | Vivian `:457`, Kirk `:472`, Ben `:487`, Shawn+Angelo `:520` |
| Lavaridge | Jeff `:451`, Jace `:466`, Eli `:481`, Cole+Keegan `:515`, Gerald `:527`, Axle `:542`, Danielle `:557` |
| Petalburg | Randall `:1854`, Mary `:1869`, Parker `:1885`, Alexia `:1901`, George `:1917`, Jody `:1933`, Berke `:1949` |
| Fortree | Humberto `:375`, Edwardo+Flint `:408`, Ashley+Jared `:441`, Darius `:455` |
| Mossdeep | all six pairs enter `GiveBattleText` (`:698-722`, `yesnobattle` at `:702,705,708,712,715,718`) |

The sight-line question comes from each map's `map.json` (on disk for all seven, as are the layouts: `data/layouts/<Gym>/map.bin`), `trainer_type` and `trainer_sight_or_berry_tree_id` per trainer object:

| Gym | Trainer objects in `map.json` | Sight trigger possible? |
|---|---|---|
| Rustboro | all five objects `TRAINER_TYPE_NONE` (Marc's range field is 1, unused) | no: `TRAINER_TYPE_NONE` is skipped (`src/trainer_see.c:224`) |
| Dewford | all eight objects `TRAINER_TYPE_NONE` (ranges 2-3, unused) | no, same line |
| Mauville | all seven objects `TRAINER_TYPE_NONE` (ranges 1-2, unused) | no, same line |
| Lavaridge | all eleven objects `TRAINER_TYPE_NONE` (ranges 0-1, unused) | no, same line |
| Petalburg | seven `TRAINER_TYPE_NORMAL`, range **0** each | no: a range of 0 yields distance 0 (`src/trainer_see.c:354-386`) |
| Fortree | six `TRAINER_TYPE_NORMAL`, ranges Jared 3, Flint 2, Ashley 1, Edwardo 2, Humberto 1, Darius 3 | **OPEN** |
| Mossdeep | twelve `TRAINER_TYPE_NORMAL`, range 1 each | **OPEN** |

For Fortree and Mossdeep the object data permits sight, and the C sight path does not run the object's script as a talk script: it parses the object script as a `trainerbattle` command and starts the battle directly (`src/trainer_see.c:258-261` -> `src/battle_setup.c:1140-1145` -> `data/scripts/trainer_battle.inc:1-7,127-137`), so a sight trigger would bypass the `yesnobattle` prompt. But ER's gym trainer scripts begin `lock`/`faceplayer` (`FortreeCity_Gym/scripts.pory:388-400`), not with a `trainerbattle` opcode, so the parse takes the `default:` branch (`src/battle_setup.c:1129-1136`) over bytes that are not the trainer's id, and the guard `GetTrainerFlagFromScriptPointer` reads offset 2 as a trainer id (`src/battle_setup.c:1159-1170`). Neither what such a trigger would start, nor whether any line reaches the player's walkable route to the leader, can be established here: the compiled map scripts are not in this tree and the layout binaries were not decoded. (c) is therefore OPEN for Fortree and Mossdeep, and the search must not treat their `D_g` sets as fully voluntary until it is settled; for the other five gyms, no trigger exists by the object data and `src/trainer_see.c:224` / `:354-386`.

**(d) guarded events: side and sim handlers.** The guarded `registerbattleevent` calls in the seven gyms (all under `pipeline/.upstream/eliteredux-source/data/maps/<Gym>/scripts.pory`; "sim" is the `case` line in `web/src/engine/sim/battleEvents.ts`). Sides are read from `src/battle_events.c`: `AffectNStatusOnTeamFromLastToFirst` writes `gPlayerParty` slots 1..n-1 (`:134-145`), `gSideStatuses[B_SIDE_PLAYER]` is the player's side, `gSideStatuses[B_SIDE_OPPONENT]` the leader's, and `SET_EXTRA_STATS_LEVEL` / its battle scripts target opponent-left (`:187-191`, `data/battle_scripts_1.s:12116-12121`).

| Gym | Line | Event (args) | Guarded by | Effect lands on | Sim |
|---|---|---|---|---|---|
| Rustboro | `:506` | LAST_STAND (5, 5) | MARC | leader (`:433-441`) | `:538` |
| Rustboro | `:509` | LAST_BLEED (2) | TOMMY | player (`:134-145`, `:270-273`) | `:346` |
| Rustboro | `:510` | STEALTH_ROCK | TOMMY | player (`:283-286`) | `:361` |
| Rustboro | `:513` | POSTURE_DEFENSE | JOSH | leader (`:209-216`) | `:293` |
| Rustboro | `:514` | STEADY_DEFENSE | JOSH | leader (`:383-385`) | `:457` |
| Dewford | `:687` | ONSTAY_FORESIGHT (1) | LAURA | player (`:415-419`, `gStatuses4[B_SIDE_PLAYER]`) | `:495` |
| Dewford | `:690` | LAST_PARALYZED (2) | TAKAO | player (`:254-257`) | `:326` |
| Dewford | `:693` | SPIKES (2) | CRISTIAN | player (`:291-294`) | `:373` |
| Dewford | `:696` | ONSWITCH_MAT_BLOCK (1) | JOCELYN | leader (`:402-414`, `:407`) | `:481` |
| Dewford | `:699` | POSTURE_OFFENSE | BRENDEN (2nd tag arg) | leader (`:201-208`) | `:287` |
| Mauville | `:555` | LAST_BURNED (3) | VIVIAN | player (`:258-261`) | `:331` |
| Mauville | `:558` | STICKY_WEB (203) | KIRK | **neither: no case** | **none** |
| Mauville | `:561` | STEADY_SPEED | BEN | leader (`:392-394`) | `:469` |
| Mauville | `:564` | ONSTAY_MAGNET_RISE (2) | SHAWN (1st tag arg) | leader (`:427-432`) | `:524` |
| Mauville | `:565` | POSTURE_SPDEF | SHAWN | leader (`:225-232`) | `:305` |
| Lavaridge | `:574` | STEADY_SPECIAL | JEFF | leader (`:386-388`) | `:461` |
| Lavaridge | `:577` | LAST_TOXIC (2) | JACE | player (`:278-281`) | `:356` |
| Lavaridge | `:580` | PERMA_HEAL_BLOCK | ELI | player (`:461-465`) | `:571` |
| Lavaridge | `:583` | STEADY_ACCURACY | KEEGAN (2nd tag arg) | leader (`:395-397`) | `:473` |
| Lavaridge | `:586` | LAST_BURNED (2) | COLE (1st tag arg) | player (`:258-261`) | `:331` |
| Lavaridge | `:589` | POSTURE_DEFENSE | GERALD | leader (`:209-216`) | `:293` |
| Lavaridge | `:592` | ONDS_COPY_STATS | AXLE | leader (`:480-484`, `battle_scripts_1.s:12299-12304`) | `:600` |
| Lavaridge | `:595` | POSTURE_SPECIAL | DANIELLE | leader (`:217-224`) | `:299` |
| Petalburg | `:1966` | POSTURE_SPEED | RANDALL | leader (`:233-240`) | `:311` |
| Petalburg | `:1969` | STEADY_ACCURACY | MARY | leader (`:395-397`) | `:473` |
| Petalburg | `:1970` | LAST_STAND (5, 5) | MARY | leader (`:433-441`) | `:538` |
| Petalburg | `:1973` | SPIKES (2) | PARKER | player (`:291-294`) | `:373` |
| Petalburg | `:1976` | POSTURE_DEFENSE | ALEXIA | leader (`:209-216`) | `:293` |
| Petalburg | `:1979` | ONSTAY_LEECH_SEED (3) | GEORGE | player (`:420-426`) | `:509` |
| Petalburg | `:1982` | POSTURE_OFFENSE | JODY | leader (`:201-208`) | `:287` |
| Petalburg | `:1985` | SUBSTITUTE (5) | BERKE | leader (`:455-459`, `gBattlerAttacker = B_SIDE_OPPONENT`) | `:565` |
| Fortree | `:493` | POSTURE_SPDEF | JARED (2nd tag arg) | leader (`:225-232`) | `:305` |
| Fortree | `:496` | LAST_FROSTBITE (4) | FLINT (2nd tag arg) | player (`:266-269`) | `:341` |
| Fortree | `:499` | EMBARGO (4) | HUMBERTO | player (`:295-303`) | `:379` |
| Fortree | `:502` | POSTURE_DEFENSE | DARIUS | leader (`:209-216`) | `:293` |
| Mossdeep | `:949` | LIGHTSCREEN (5) | count < 1 | leader (`:309-313`) | `:399` |
| Mossdeep | `:952` | REFLECT (5) | count < 2 | leader (`:304-308`) | `:393` |
| Mossdeep | `:955` | LUCKY_CHANT (5) | count < 3 | leader (`:314-318`) | `:405` |
| Mossdeep | `:958` | PERMA_WIDE_GUARD | count < 4 | leader (`:471-474`) | `:411` |
| Mossdeep | `:961` | LAST_SLEEP (1) | count < 5 | player (`:262-265`) | `:336` |
| Mossdeep | `:964` | NO_PROTECT | count < 6 | player (`:330-333` -> `:167-185`) | `:421` |

Every guarded event either lands on the leader as a buff or on the player as a debuff, so each one favours the leader; none favours the player, and only `BATTLE_EVENT_STICKY_WEB` is a no-op. That licenses decision 8's monotone shortcut, with the one qualification that beating Kirk removes a no-op rather than a leader penalty, so the Kirk battle can never be part of a minimal winning set on event grounds (the search still enumerates it as a unit). `BATTLE_EVENT_TENSE_BATTLE` is registered unguarded in each leader script (Rustboro `:540`, Dewford `:709`, Mauville `:578`, Lavaridge `:628`, Petalburg `:2012`, Fortree `:511`, Mossdeep `:996`), changes only music (`src/battle_events.c:485-495`), and is ported (`web/src/engine/sim/battleEvents.ts:426,617`); it is not part of `D_g`.

**Handler coverage and the Kirk citation.** All 32 distinct guarded event ids have a `case` in `web/src/engine/sim/battleEvents.ts` except `BATTLE_EVENT_STICKY_WEB` (203), which has none, matching the C. The plan's Kirk citations are all correct as written and were left unchanged: `MauvilleCity_Gym/scripts.pory:557` is `if (!defeated(TRAINER_KIRK)){`, `:558` is `registerbattleevent(BATTLE_EVENT_STICKY_WEB)`, `:559` closes the block; `include/constants/battle_events.h:60` is `#define BATTLE_EVENT_STICKY_WEB 203`; and `src/battle_events.c` has `case BATTLE_EVENT_PERMA_STICKY_WEB:` (id 164, `include/constants/battle_events.h:53`) at `:325` and `:475` but no `BATTLE_EVENT_STICKY_WEB` case in either switch. `web/src/engine/sim/cycle7bGuardedEvents.test.ts` asserts the table and the negative case (STICKY_WEB has no handler and leaves the player side untouched; PERMA_STICKY_WEB has one and sets `SIDE_STATUS_STICKY_WEB` on the player's side).

**Consequences.** The gym-trainer search inputs are unchanged except for the facts above: (a) and (b) stay open, so gym 7's count guard stays undecoded (Gym 7 is already excluded as `forcedDouble`/unsupported until D1-D3) and the tag-battle outcome stays 'both' and is printed in every report. (d) supports the monotone shortcut for gyms 1-6. (c) adds one caveat: Fortree and Mossdeep's object data does not rule out a sight-line battle, so their `D_g` sets cannot yet be claimed fully voluntary; the other five gyms are safe on the object data and `src/trainer_see.c:224`. Nothing here changes engine, sim or solver behaviour; the affected audits are unchanged.

### Step 0.4 results (cycle8)

Measured 2026-11-19 in the cycle8 worktree. **Sampler only**: (a) the starting build's wins per unit, run without any build search, and (c) the cost of sampling one candidate defeated set on one gym leader. Item (b) (per-unit search cost to the first `won`) and the with-`SET_CAP` half of (c) are NOT measurable yet: the decision-7 feasibility search is queue item d4-2 and does not exist (`improveTeam`, `solver.ts:356`, is a coordinate ascent, whose games-to-first-`won` would not answer the question), so both move to a new queue line **d4-0d**. No engine, sim or solver source changed; new files are `web/src/engine/sim/driver/measureUnits.ts` (`supportedSingleUnits()`) with its always-on test `web/src/engine/sim/cycle8Measure.test.ts`, and two new `it` blocks in the gated `web/src/engine/sim/driver/solverMeasure.test.ts` (Step 0.1-0.2 blocks untouched). All figures are single-run and noisy.

**The unit list is 26 rows.** `FIGHTS` has 43 rows; 7 are `deferred` and 2 `excluded`, leaving the plan's 34 v1 rows (29 ordinary fights + 5 chain rows, the museum chain's three). Of the 29 ordinary fights the sampler covers **26**, skipping the three non-single formats: `TRAINER_TATE_AND_LIZA_1` (double), `TRAINER_COURTNEY_METEOR_FALLS` and `TRAINER_MAXIE_MOSSDEEP` (`multi_2_vs_2`). All three chains are skipped too: the museum chain's `TRAINER_GRUNT_MUSEUM_1`, `_2` and `TRAINER_ARCHIE_SLATEPORT` and the Space Center's `TRAINER_GRUNT_SPACE_CENTER_5` (four single-format rows dropped by `chainId`) and Juan's tag row `TRAINER_JUAN_1`. `supportedSingleUnits()` = `format === 'single'`, no `chainId`, no `excluded`/`deferred`/`awaitingRoute`; the test asserts the count against an independent filter over `FIGHTS`, that `TRAINER_ROXANNE_1` is present, that the double/tag/multi/Museum units are absent, that a `deferred` row is absent, and that every returned row has a settled `levelCapForTrainer` cap.

**Method.** Per unit: level = `levelCapForTrainer(fightId).cap`, badges = `highestBadgeRange(row).min`, `allowedStones = availableStones(data, badges)` (empty before badge 5), team = `GENERIC_PLAYER_SPECS.map(s => defaultSet(data, s.species, level, allowedStones))`. Gym maps get `eventsForFight(data.battleEvents, mapName, new Set())` like `solverCli.ts:136-144`, with the map name from a module-relative copy of `solverCli.ts:42-50`'s `mapForTrainer` (not exported; it reads `docs/battle-sim/boss-fight-coverage.md`). `scoreTeam` is called with `{ levelCap: cap }` as its options argument. The sampler is the decision-4 one: at most 2 looks of `BATCH = 40` games (seeds `40k + 1..`), `wilsonInterval(wins, n, 2.807)`, `won` iff lower >= 0.90, `lost` iff upper < 0.50, else `open at 80`. **40 straight wins gives lower 0.835**, so a `won` can only be declared on the second look; 80/80 gives lower 0.910 and 79/80 only 0.889. Units were sharded over 8 processes (`SIM_SHARD=i/8`, index `% 8`), all nine measurement processes (8 shards plus (c)) ran concurrently on 8 cores.

**Table (a).** `events` is active/all registered map events; `ms` and `ms/game` are wall time in that process. Sort order is route order.

| # | unit | cap | badge | map | events | wins/n | interval | verdict | games | ms | ms/game |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | `TRAINER_MAY_RUSTBORO_TORCHIC` | 23 | 1 | Route104 | 0/0 | 2/40 | [0.009, 0.239] | lost | 40 | 155093 | 3877.3 |
| 1 | `TRAINER_MAY_ROUTE_110_TORCHIC` | 36 | 2 | Route110 | 0/0 | 1/40 | [0.003, 0.204] | lost | 40 | 159909 | 3997.7 |
| 2 | `TRAINER_MAY_ROUTE_119_TORCHIC` | 55 | 5 | Route119 | 0/0 | 73/80 | [0.783, 0.968] | open at 80 | 80 | 238040 | 2975.5 |
| 3 | `TRAINER_ROXANNE_1` | 16 | 0 | RustboroCity_Gym | 6/6 | 0/40 | [-0.000, 0.165] | lost | 40 | 106867 | 2671.7 |
| 4 | `TRAINER_BRAWLY_1` | 23 | 1 | DewfordTown_Gym | 6/6 | 0/40 | [-0.000, 0.165] | lost | 40 | 74396 | 1859.9 |
| 5 | `TRAINER_WATTSON_1` | 36 | 2 | MauvilleCity_Gym | 6/6 | 0/40 | [-0.000, 0.165] | lost | 40 | 97455 | 2436.4 |
| 6 | `TRAINER_FLANNERY_1` | 45 | 3 | LavaridgeTown_Gym_1F | 9/9 | 0/40 | [-0.000, 0.165] | lost | 40 | 99161 | 2479.0 |
| 7 | `TRAINER_NORMAN_1` | 50 | 4 | PetalburgCity_Gym | 9/9 | 0/40 | [-0.000, 0.165] | lost | 40 | 154376 | 3859.4 |
| 8 | `TRAINER_WINONA_1` | 55 | 5 | FortreeCity_Gym | 5/5 | 3/40 | [0.017, 0.273] | lost | 40 | 132677 | 3316.9 |
| 9 | `TRAINER_GRUNT_PETALBURG_WOODS` | 16 | 0 | PetalburgWoods | 0/0 | 44/80 | [0.396, 0.695] | open at 80 | 80 | 171791 | 2147.4 |
| 10 | `TRAINER_GRUNT_RUSTURF_TUNNEL` | 23 | 1 | RusturfTunnel | 0/0 | 1/40 | [0.003, 0.204] | lost | 40 | 113234 | 2830.9 |
| 11 | `TRAINER_SHELLY_WEATHER_INSTITUTE` | 55 | 5 | Route119_WeatherInstitute_2F | 0/0 | 4/40 | [0.027, 0.304] | lost | 40 | 133843 | 3346.1 |
| 12 | `TRAINER_MATT` | 60 | 6 | AquaHideout_B2F | 0/0 | 65/80 | [0.664, 0.905] | open at 80 | 80 | 222756 | 2784.4 |
| 13 | `TRAINER_ARCHIE_MT_PYRE` | 60 | 6 | MtPyre_Summit | 0/0 | 52/80 | [0.493, 0.780] | open at 80 | 80 | 271540 | 3394.3 |
| 14 | `TRAINER_ARCHIE` | 70 | 7 | SeafloorCavern_Room9 | 0/0 | 4/40 | [0.027, 0.304] | lost | 40 | 108512 | 2712.8 |
| 15 | `TRAINER_COURTNEY_SUNHOLLOW` | 50 | 4 | Route111_SunhollowRuins_Museum | 0/0 | 2/40 | [0.009, 0.239] | lost | 40 | 128252 | 3206.3 |
| 16 | `TRAINER_MAXIE_MT_CHIMNEY` | 45 | 3 | MtChimney | 0/0 | 4/40 | [0.027, 0.304] | lost | 40 | 102375 | 2559.4 |
| 17 | `TRAINER_MAXIE_MAGMA_HIDEOUT` | 60 | 6 | MagmaHideout_4F | 0/0 | 47/80 | [0.432, 0.727] | open at 80 | 80 | 202659 | 2533.2 |
| 18 | `TRAINER_STEVEN_GRANITE_CAVE` | 23 | 1 | GraniteCave_StevensRoom | 0/0 | 0/40 | [-0.000, 0.165] | lost | 40 | 82424 | 2060.6 |
| 19 | `TRAINER_STEVEN_ROUTE118` | 55 | 5 | Route118 | 0/0 | 77/80 | [0.851, 0.991] | open at 80 | 80 | 210245 | 2628.1 |
| 20 | `TRAINER_STEVEN` | 80 | 8 | EverGrandeCity_ChampionsRoom | 0/0 | 0/40 | [-0.000, 0.165] | lost | 40 | 124608 | 3115.2 |
| 21 | `TRAINER_WALLY_MAUVILLE` | 36 | 2 | (none) | 0/0 | 0/40 | [-0.000, 0.165] | lost | 40 | 91554 | 2288.8 |
| 22 | `TRAINER_SIDNEY` | 80 | 8 | EverGrandeCity_SidneysRoom | 0/0 | 52/80 | [0.493, 0.780] | open at 80 | 80 | 287700 | 3596.2 |
| 23 | `TRAINER_PHOEBE` | 80 | 8 | EverGrandeCity_PhoebesRoom | 0/0 | 18/80 | [0.122, 0.377] | lost | 80 | 195527 | 2444.1 |
| 24 | `TRAINER_GLACIA` | 80 | 8 | EverGrandeCity_GlaciasRoom | 0/0 | 0/40 | [-0.000, 0.165] | lost | 40 | 89245 | 2231.1 |
| 25 | `TRAINER_DRAKE` | 80 | 8 | EverGrandeCity_DrakesRoom | 0/0 | 0/40 | [-0.000, 0.165] | lost | 40 | 72151 | 1803.8 |

`TRAINER_WALLY_MAUVILLE` resolves to no map in the coverage doc (no `map:line` after its id) and has no battle events, so the empty event list is correct. The gym rows show every guarded event active (`events = n/n`): the empty defeated set is the candidate set a unit starts from.

**Counts at the start: 0 won, 19 lost, 7 open at 80.** No measured unit is won by the starting build. The seven open ones are `TRAINER_MAY_ROUTE_119_TORCHIC` (73/80), `TRAINER_STEVEN_ROUTE118` (77/80), `TRAINER_MATT` (65/80), `TRAINER_ARCHIE_MT_PYRE` (52/80), `TRAINER_MAXIE_MAGMA_HIDEOUT` (47/80), `TRAINER_SIDNEY` (52/80) and `TRAINER_GRUNT_PETALBURG_WOODS` (44/80); all are candidates for `won` with more games but the 2-look budget stops them. Roxanne is 0/40 here against 15/40 in Step 0.2 because the cap is 16, not the Step 0.2 bench's level 50. **k = 26 weighted over the measured singles** (none won, so every one needs a search). If the 3 chains are all searched too, k = 26 + 3 x 3 = **35**. The three non-single ordinary units cannot be sampled at all until D1-D3 land; if they also need searches they add 3, making k = **38**, the cost table's ceiling row. The measurement therefore rules out the table's `k = 0..20` rows and leaves the ceiling row in play.

**Warm starts: NOT compared.** Decision 7's warm start hands the next unit the previous unit's build; until the d4-2 search exists the only build a previous unit could hand on is its own `defaultSet`, which is exactly what this test already samples. Warm start versus `defaultSet` is therefore unmeasured and the question stays open; decision 7's default (line 158) is unchanged by this cycle.

**Per-game time.** 1,360 games over the 26 units: median **2,692 ms/game**, mean 2,814 ms/game, 3,826 s of CPU. The 8 shards plus the (c) process ran concurrently on 8 cores; load average was 0.63 before launch (20:25), peaked at 8.47 (20:33) and was 0.91 after all jobs finished (20:36). Wall clock for the whole session was about 10.5 min. The median is 1.9x decision 12's unmeasured 1.4 s/game; single run, contended, so treat it as an upper-ish reading for a run of this shape.

**Table (c): one gym leader, `TRAINER_ROXANNE_1` (`RustboroCity_Gym`, cap 16).** Same `defaultSet` team; two candidate defeated sets: the empty set (all 5 guarded events active) and every guarded trainer defeated (`defeatable` from the map's `!defeated(...)` guards, `solverCli.ts:137-142`; events 1/6, `BATTLE_EVENT_TENSE_BATTLE` only). Each candidate was sampled on tuning seeds (offset 0) and on report seeds (offset 10,000,000), 2-look sampler.

| Candidate set | Seeds | events active/all | guarded active | wins/n | interval | verdict | games | ms | ms/game |
|---|---|---|---|---|---|---|---|---|---|
| empty | tuning | 6/6 | 5/5 | 0/40 | [-0.000, 0.165] | lost | 40 | 101523 | 2538.1 |
| empty | report | 6/6 | 5/5 | 0/40 | [-0.000, 0.165] | lost | 40 | 97502 | 2437.6 |
| all-guarded | tuning | 1/6 | 0/5 | 0/40 | [-0.000, 0.165] | lost | 40 | 118111 | 2952.8 |
| all-guarded | report | 1/6 | 0/5 | 0/40 | [-0.000, 0.165] | lost | 40 | 113146 | 2828.7 |

A candidate set that needs no build search therefore costs **40 tuning games (97.5-118.1 s) when the sampler settles at the first look** and at most 80 games (two looks) when it does not; that is the `S`-like sample cost, not a search. The two candidate sets are indistinguishable with this team at this resolution (0/40 either way), so (c) says nothing about whether the events matter for a stronger build. The run took 431 s. **The with-`SET_CAP` search cost is not measurable**: no feasibility search exists, so there is no per-set search figure to report, and the same gap blocks item (b).

**Cap proposals (arithmetic from these numbers; no number invented).**

- `UNIT_CAP`: **no data: needs the d4-2 search.** No search ran, so there is no games-to-first-`won` figure; the placeholder 6,000 stays.
- `SET_CAP`: **no data: needs the d4-2 search.** Same reason; 1,500 stays.
- `GYM_CAP`: **no data: needs the d4-2 search.** 12,000 stays. The only measured input is the per-set sample cost above (40 games, up to 80): the plan's largest gyms have 128 candidate sets (Lavaridge, Petalburg), which would cost 5,120 games to sample once each at 40 and up to 10,240 at 80 *before* any per-set search, so 12,000 is a sampling budget for those gyms, not a search budget.
- Per-game time for the budget: use the measured **median 2.69 s**; at it, the `k = 26` interpolation of decision 12's formula is `(38 - 26) x 720 + 26 x 9,400 = 253,040` games, about 189 h single-threaded or 23.7 h on 8 workers at perfect scaling, and the `k = 38` ceiling is 357,200 games, about 267 h or 33.4 h on 8 workers. Both are above the plan's 22.5 h ceiling, which assumed 1.4 s/game; the budget decision must use the measured time.

**What is still missing (d4-0d).** Item (b) (per-unit feasibility-search cost to the first tuning-`won`, or `UNIT_CAP` hit, and the round count) and the with-`SET_CAP` half of (c) need the decision-7 satisficing search (Steps 2.1-2.2), which is not built. (2026-11-24: that search is now the GA, so d4-0d runs after Steps 2.0, 1.3, 2.2, 2.6 and 2.4 (seventh revision order), and item (b) also records the generation count and how many finalists qualified.) They move to a new queue line d4-0d, after d4-2; `UNIT_CAP`, `SET_CAP` and `GYM_CAP` stay at their placeholders until then.

### Step 1 - fight list, statistics and report (no D1-D3 dependency)
1.0 The progression table (decision 1) and `fights.ts` (decision 2), built jointly with D5 Step 1 (one table; the cap is derived from it). Built by d5-1/d5-1b on the skippable-gym premise; queue item d5-1c corrects it for the fixed route
    (`mayBefore` empty on gym fights, `requiredBefore` = all lower gyms for each gym fight, evidence strings citing map blocks or the literal label `player-observed (Yoshi), not in the scripts at pin bdebcbbf`, subset machinery removed). Tests: every id from `loadBossTrainerIds` appears in exactly one row;
    every row has a format from the `fights.ts:15` enum, a mandatory flag with a citation, `requiredBefore` with evidence; every row has an empty `mayBefore` (non-gym stages copied from `story-route.md` by d5-1c, decision 1); each gym N row has `requiredBefore = [1..N-1]`; `stageKeyFor` on a hand-built row; a report of the distinct
    StageKeys of the real table (a check on the route, no longer a cost input); and a report of the v1 tuning units (non-deferred, non-excluded rows with each `chainId` merged into one unit; 32 expected, decision 12), which feeds decision 12. Add to the table, per gym-leader fight 1-7, its map name, guarded trainer ids and choice units (battles, decision 8; COLE+KEEGAN one unit), with a test that, for gyms 1-6,
    the ids match the `!defeated(...)` guards in `encounters.json` for that map. Gym 7 is EXEMPT from that test (Mossdeep's guards are `var(VAR_RESULT) < N` and its ids appear only in `CalcDefeatedCount`); it gets a separate check that
    `encounters.json` has exactly the six `var(VAR_RESULT) < 1..6` rows for `MossdeepCity_Gym` and that the table's twelve ids are the twelve in the `MossdeepCity_Gym` `tagBattles` rows.
1.1 `winProbability(wins, n, level)` Wilson interval, the corrected sequential sampler and verdict rule, the seed allocator (decision 5). Unit tests with hand-computed intervals (including the 40-wins case above and the 400-game half-width), boundary cases,
    and the seed-disjointness test over the seeds the singles and chain evaluators actually produce.
1.2 The report writer: JSON plus markdown with per-fight `p`, interval and level, `n`, verdict, `fragile`, assumptions (decision 13 below), what-to-change. It replaces the `{trainerId, tier, fitness, fresh, team}` JSON; no existing test reads that `--out` file
    (grep before changing), so no compatibility shim.

1.3 **The offline set-pool step** (decision 16; seventh revision), in `pipeline/` (Python, `uv`), writing committed `data/<version>/setPools.json` and run by `python -m erdata.build` like the other outputs: the synergy table, role fit,
    role coherence, boss-set mining and the per-stage move lists, producing up to about 5 role-tagged sets per (species, badge stage) for every species. Tests (pytest): the synergy reader finds the known cases from the hooks' C
    (Iron Fist with punching moves, Technician with low-power moves, Strong Jaw with biting moves, a weather setter with a move that checks that weather), and lists the abilities whose hooks it could not classify; the pivot-move
    reader finds the 12 moves of decision 14 and reports any other self-switch it finds in the battle scripts or abilities; a stage's moves are the level-up moves at or below its cap plus every TM and tutor move; every output set
    passes its role's coherence rule; for a species that appears in `trainers.json`, at least one mined set reaches its pool or the report says why not. Report: per role, how many species get at least one set.

### Step 2 - search record, what-to-change and sensitivity (singles fights first)
Order (seventh revision, 2026-11-24): **2.0 (policy gate)** -> 1.3 (set pools) -> 2.2 (battle summary, needed by the graded fitness and the repair mutation) -> **2.6 (screen gate, formerly 2.0)** -> 2.4 -> 2.5; 2.1 is landed and
2.3 is independent. Nothing after 2.0 is built unless 2.0b passes, and nothing after 2.6 unless 2.6b passes.
2.0 **Policy gate: role policies against expectimax** (decisions 14 and 15). (a) Build `rolePolicy.ts` (all six roles, the shared inputs with 3 predicted AI samples, the team layer with the six switch purposes in a fixed order for this
    test) and a game loop that plays it at the 200-turn cap; expectimax plays at the same cap for the comparison. Tests on hand-built states: each role's rules fire in order (a sweeper below its target stage and safe boosts, and
    attacks when threatened; a staller below its heal threshold uses Wish, then Protect; a hazard lead lays its layers, then plays its fallback role; a support without a pivot move switches when threatened and a teammate takes the
    predicted move better, else plays its fallback; Mr. Mime-style support boosts to its target stage, then Baton Passes); an attacker uses Fake Out on its first turn in; damage choices target the predicted switch-in when the
    samples predict a switch; the team layer checks purposes in the configured order, skips the `preserve` member when another candidate is acceptable, switches through a pivot move when the active mon has one, and stops a PP loop
    after 4 turns of both sides switching with no HP or PP change; the pivot-move list read from `moves.json` has the 12 moves of decision 14; a game reaching 200 turns returns `MAX_TURNS` and counts as not won.
    (b) **Measure, then decide** on `docs/battle-sim/role-policy-test-fights.json` (Yoshi's teams that won in play: the rain team against Sidney, Phoebe, Glacia, Drake and Steven, and a stall team against Glacia; roles, leads and
    fallback roles given, so no pool and no screen is involved): the same team on the same seeds, 80 games per policy per fight. Record win rate, time per game, games reaching the cap, how often a boosting move was used when
    available and whether the mon attacked once boosted, how often the AI switched and what our policy did on that turn, and battle logs for Yoshi to read. **Pass**: on every informative fight the role policy wins at least as
    often as expectimax, clearly more on the stall fight and where Mr. Mime's boosts decide, and Yoshi judges that the logs play as he would; time per game is recorded, not gated. A fight where both policies win under about 20% of
    games is reported as uninformative, not a fail: these teams were won in play, possibly with a lot of luck (fixture `source`). **Fail** stops Steps 1.3 and 2.x: the role rules are corrected from the logs and 2.0b re-runs.
2.1 The satisficing unit search (decision 7 (a)-(d)): starting build (warm start or `defaultSet`), its report-seed sample, the feasibility search over `neighbours` (`solver.ts:263-307`) with screening by `fitnessValue`, stop at the first
    tuning-`won` candidate, at most 3 report-seed confirmations, `UNIT_CAP`; it replaces `improveTeam`'s coordinate ascent (no epsilon, no passes) and returns the candidate records (decision 6); the team diff; the report-seed re-scoring
    of 3 candidates for units that end not reliably `won`. The fragility check it calls is 2.3; until 2.3 lands, "reliably `won`" is `won` and the report says fragility was not checked.
    (2026-11-24) Its outer loop stays as landed; its candidate generation and screening (one round of single-change neighbours screened at `SCREEN_GAMES`, `satisficingSearch.ts:192-212`, and the incumbent move, `:248-250`) are
    replaced by one GA generation (Step 2.4), and `fitnessValue` by the graded fitness (decision 6). Its evaluator plays the role policy (decision 14), not `playExpectimaxBattle`.
2.2 The battle summary return value and loss anatomy. (2026-11-24) The summary also carries what the graded fitness and the repair mutation read: the opponent side's HP fraction removed and its fainted count at the end of the game,
    per player member the moves used (counts) and damage dealt, and per player faint the opponent mon that caused it.
2.3 The AI perturbation wrapper (decision 10) and the `fragile` flag, calibrated per Step 0.3.
2.4 The genetic algorithm generation (decision 7 (c3)-(c6)), pure and headless, evaluation injected like `searchUnit`'s: genome decoding (sets with roles, role parameters, `leadIndex`, team genes), the exhaustive screen of every
    assembly for the initial population, tournament selection, slot-wise uniform crossover with sets and parameters moving together, order crossover for the purpose order, the `pool`, `param`, `lead` and `team` mutations,
    elitism with record carry-over, genome de-duplication, successive halving, the finalist rule, and the decision-6 records with `origin` and parents. `teamDiff` matches members by species and reports the lead, roles, parameters and
    team genes. All randomness from one seeded mulberry32 stream (`rng.ts`), so a run is reproducible.
2.5 The `repair` mutation (decision 7 (c5)) from the Step 2.2 summary and the Step 2.6 table, keeping each new set coherent with its role (decision 16), with the pool growth cap of 10.
2.6 **Screen gate (formerly 2.0)** (decision 7 (c1)-(c2a), (c4)). (a) Build, pure and headless: reading the Step 1.3 pools for a fight's stage, the matchup table over pool sets, the lead plans and the exhaustive assembly scoring.
    Tests: a table entry equals what `calculateMoveDamage` + `calcKoChances` give for a hand-picked pair; the assembly scoring returns the same best team as a brute-force loop on 3 sets per species; the starting build's set is entry 0
    of every pool; the lead plans: a hand-built lead and set where the set KOs first is classed KO, a set immune to every move of the lead is classed wall, the predicted switch-in equals what `chooseAiAction` returns on that state for
    the same seed, the predicted replacement equals `createAiOpponentReplacement`'s choice, a sweep plan against a party with one priority user marks every mon handled except that one, and a set-up plan is kept exactly when the set's
    role rule boosts on that state. (b) **Measure, then decide** on at least 3 singles units the starting build loses (Step 0.4 found 19 lost of 26): play the screen's top assembled team (middle role parameters, default team genes) and the
    starting build with the role policy on the same tuning seeds (2 batches of 40); record both win rates, both graded fitnesses, the screen's CPU time per unit, and for the screen's lead how often its lead plan happened in those games
    (the predicted switch taken and to the predicted mon, the KO landed first, the boosted sweep reached). **Pass** if the screen's team has a higher graded fitness on every unit and a higher win rate on at least 2 of 3. **Fail** stops
    Step 2 and the result goes to Yoshi: the screen and the pools (answers/walls rules, lead plans, Step 1.3's ranking) are revisited before any GA code is written. The graded-fitness weights (decision 6) are checked on the same games:
    a weight is changed only if a lost game outscores a won one.

### Step 2.0b results (cycles20e)

#### Run 1 (before 946f, 946g, s20ccb, s20c2bb, s20eb, s20f1)

Run settings: 80 games per policy per fight, 200-turn cap, seed offset 0, measured at commit `ec651c9`, six processes in parallel on 8 cores (so ms/game is a contended figure; time is recorded, not gated).

| Fight | Policy | Wins/games | Rate | Wilson | ms/game | Capped | Boost available/used | Boosted / attacked boosted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 1/80 | 1.3% | [0.002, 0.067] | 983.2 | 0 | 155/0 | 9 / 9 |
| TRAINER_SIDNEY-attack | expectimax | 71/80 | 88.8% | [0.800, 0.940] | 2017.6 | 0 | 298/100 | 218 / 141 |
| TRAINER_PHOEBE-attack | role | 60/80 | 75.0% | [0.645, 0.832] | 1086.1 | 0 | 40/0 | 0 / 0 |
| TRAINER_PHOEBE-attack | expectimax | 15/80 | 18.8% | [0.117, 0.287] | 1575.5 | 0 | 276/4 | 10 / 10 |
| TRAINER_GLACIA-attack | role | 0/80 | 0.0% | [0.000, 0.046] | 1034.2 | 0 | 105/0 | 1 / 1 |
| TRAINER_GLACIA-attack | expectimax | 0/80 | 0.0% | [0.000, 0.046] | 1601.3 | 0 | 307/38 | 123 / 94 |
| TRAINER_DRAKE-attack | role | 2/80 | 2.5% | [0.007, 0.087] | 863.2 | 0 | 100/0 | 0 / 0 |
| TRAINER_DRAKE-attack | expectimax | 30/80 | 37.5% | [0.277, 0.485] | 2076.4 | 0 | 404/19 | 75 / 60 |
| TRAINER_STEVEN-attack | role | 0/80 | 0.0% | [0.000, 0.046] | 703.0 | 0 | 72/0 | 0 / 0 |
| TRAINER_STEVEN-attack | expectimax | 0/80 | 0.0% | [0.000, 0.046] | 1304.9 | 0 | 202/0 | 80 / 80 |
| TRAINER_GLACIA-stall | role | 3/80 | 3.8% | [0.013, 0.105] | 2544.7 | 0 | 304/0 | 224 / 224 |
| TRAINER_GLACIA-stall | expectimax | 5/80 | 6.3% | [0.027, 0.138] | 5742.4 | 0 | 452/0 | 185 / 92 |

Boosted / attacked boosted in this run count any positive stage in stats 1..5 (passive and Baton-Passed raises included); cycles20eb narrows the definition to the mon's own boosting from the next run.

AI voluntary switches (turn counts; what our policy did on those turns):

| Fight | Policy | AI switches | Our action on those turns |
| --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 0 | none |
| TRAINER_SIDNEY-attack | expectimax | 0 | none |
| TRAINER_PHOEBE-attack | role | 0 | none |
| TRAINER_PHOEBE-attack | expectimax | 0 | none |
| TRAINER_GLACIA-attack | role | 1 | MOVE_MOONBLAST=1 |
| TRAINER_GLACIA-attack | expectimax | 3 | MOVE_MOONBLAST=2, MOVE_SNIPE_SHOT=1 |
| TRAINER_DRAKE-attack | role | 2 | MOVE_SHOCKING_JAB=2 |
| TRAINER_DRAKE-attack | expectimax | 75 | MOVE_MOONBLAST=57, SWITCH=18 |
| TRAINER_STEVEN-attack | role | 0 | none |
| TRAINER_STEVEN-attack | expectimax | 0 | none |
| TRAINER_GLACIA-stall | role | 0 | none |
| TRAINER_GLACIA-stall | expectimax | 5 | MOVE_ASTEROID_DOWNFALL=4, MOVE_FIRE_BLAST=1 |

Per-fight verdict as the rule gives it (from `classifyWinRates`; `uninformative` is not a fail), with whether the two Wilson intervals overlap:

- `TRAINER_SIDNEY-attack`: `role<expectimax`; intervals do not overlap.
- `TRAINER_PHOEBE-attack`: `role>=expectimax`; intervals do not overlap.
- `TRAINER_GLACIA-attack`: `uninformative`; intervals overlap ([0.000, 0.046] both).
- `TRAINER_DRAKE-attack`: `role<expectimax`; intervals do not overlap.
- `TRAINER_STEVEN-attack`: `uninformative`; intervals overlap ([0.000, 0.046] both).
- `TRAINER_GLACIA-stall`: `uninformative`; intervals overlap ([0.013, 0.105] vs [0.027, 0.138]).

Battle logs: `docs/battle-sim/role-policy-logs/role-TRAINER_SIDNEY-attack.log`, `role-TRAINER_PHOEBE-attack.log`, `role-TRAINER_GLACIA-attack.log`, `role-TRAINER_DRAKE-attack.log`, `role-TRAINER_STEVEN-attack.log`, `role-TRAINER_GLACIA-stall.log` (role games 1 and 2 of each fight).

No overall pass or fail is declared here; Yoshi reads the logs and decides (a fail stops Steps 1.3 and 2.x). The measured policy does NOT include two known open fixes: 946f (staller and support status-move gates in `rolePolicy.ts` that let a failing move be chosen again every turn) and s20ccb (the counter purpose's bench-side speed check ignores move priority); both can affect these numbers.

#### Run 2 (cycles20f2)

Run settings: 80 games per policy per fight, 200-turn cap, seed offset 0, measured at commit `8bf1d39`, six processes in parallel on 8 cores (so ms/game is a contended figure; time is recorded, not gated).

| Fight | Policy | Run 2 wins/games | Run 1 wins/games | Rate | Wilson | ms/game | Capped | Boost available/used | Boosted / attacked boosted | Any positive stage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 1/80 | 1/80 | 1.3% | [0.002, 0.067] | 1091.4 | 0 | 155/0 | 0 / 0 | 9 |
| TRAINER_SIDNEY-attack | expectimax | 71/80 | 71/80 | 88.8% | [0.800, 0.940] | 2041.7 | 0 | 298/100 | 102 / 28 | 218 |
| TRAINER_PHOEBE-attack | role | 60/80 | 60/80 | 75.0% | [0.645, 0.832] | 1186.9 | 0 | 40/0 | 0 / 0 | 0 |
| TRAINER_PHOEBE-attack | expectimax | 15/80 | 15/80 | 18.8% | [0.117, 0.287] | 1588.9 | 0 | 276/4 | 10 / 10 | 10 |
| TRAINER_GLACIA-attack | role | 0/80 | 0/80 | 0.0% | [0.000, 0.046] | 1177.0 | 0 | 105/0 | 0 / 0 | 1 |
| TRAINER_GLACIA-attack | expectimax | 0/80 | 0/80 | 0.0% | [0.000, 0.046] | 1626.2 | 0 | 307/38 | 79 / 53 | 123 |
| TRAINER_DRAKE-attack | role | 1/80 | 2/80 | 1.3% | [0.002, 0.067] | 968.8 | 0 | 132/32 | 32 / 0 | 73 |
| TRAINER_DRAKE-attack | expectimax | 30/80 | 30/80 | 37.5% | [0.277, 0.485] | 2118.4 | 0 | 404/19 | 23 / 20 | 75 |
| TRAINER_STEVEN-attack | role | 0/80 | 0/80 | 0.0% | [0.000, 0.046] | 784.6 | 0 | 72/0 | 0 / 0 | 0 |
| TRAINER_STEVEN-attack | expectimax | 0/80 | 0/80 | 0.0% | [0.000, 0.046] | 1389.2 | 0 | 202/0 | 0 / 0 | 80 |
| TRAINER_GLACIA-stall | role | 3/80 | 3/80 | 3.8% | [0.013, 0.105] | 2648.7 | 0 | 304/0 | 0 / 0 | 224 |
| TRAINER_GLACIA-stall | expectimax | 5/80 | 5/80 | 6.3% | [0.027, 0.138] | 5739.2 | 0 | 452/0 | 0 / 0 | 185 |

`Boosted` / `attacked boosted` now count only a mon's own boosting since its current switch-in (cycles20eb), so they are not comparable with Run 1's columns.

AI voluntary switches (turn counts; what our policy did on those turns):

| Fight | Policy | AI switches | Our action on those turns |
| --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 0 | none |
| TRAINER_SIDNEY-attack | expectimax | 0 | none |
| TRAINER_PHOEBE-attack | role | 0 | none |
| TRAINER_PHOEBE-attack | expectimax | 0 | none |
| TRAINER_GLACIA-attack | role | 1 | MOVE_MOONBLAST=1 |
| TRAINER_GLACIA-attack | expectimax | 3 | MOVE_MOONBLAST=2, MOVE_SNIPE_SHOT=1 |
| TRAINER_DRAKE-attack | role | 2 | MOVE_SHOCKING_JAB=2 |
| TRAINER_DRAKE-attack | expectimax | 75 | MOVE_MOONBLAST=57, SWITCH=18 |
| TRAINER_STEVEN-attack | role | 0 | none |
| TRAINER_STEVEN-attack | expectimax | 0 | none |
| TRAINER_GLACIA-stall | role | 0 | none |
| TRAINER_GLACIA-stall | expectimax | 5 | MOVE_ASTEROID_DOWNFALL=4, MOVE_FIRE_BLAST=1 |

Per-fight verdict as the rule gives it (from `classifyWinRates`; `uninformative` is not a fail), with whether the two Wilson intervals overlap:

- `TRAINER_SIDNEY-attack`: `role<expectimax`; intervals do not overlap (role [0.002, 0.067], expectimax [0.800, 0.940]).
- `TRAINER_PHOEBE-attack`: `role>=expectimax`; intervals do not overlap (role [0.645, 0.832], expectimax [0.117, 0.287]).
- `TRAINER_GLACIA-attack`: `uninformative`; intervals overlap ([0.000, 0.046] both).
- `TRAINER_DRAKE-attack`: `role<expectimax`; intervals do not overlap (role [0.002, 0.067], expectimax [0.277, 0.485]).
- `TRAINER_STEVEN-attack`: `uninformative`; intervals overlap ([0.000, 0.046] both).
- `TRAINER_GLACIA-stall`: `uninformative`; intervals overlap (role [0.013, 0.105], expectimax [0.027, 0.138]).

The pass rule (plan Step 2.0b): on every informative fight the role policy wins at least as often as expectimax, clearly more on the stall fight and where Mr. Mime's boosts decide; a fail stops Steps 1.3 and 2.x. Informative fights that violate "at least as often" (the report's own section): `TRAINER_SIDNEY-attack` (role 1/80 vs expectimax 71/80) and `TRAINER_DRAKE-attack` (role 1/80 vs expectimax 30/80).

Battle logs: `docs/battle-sim/role-policy-logs/role-TRAINER_SIDNEY-attack.log`, `role-TRAINER_PHOEBE-attack.log`, `role-TRAINER_GLACIA-attack.log`, `role-TRAINER_DRAKE-attack.log`, `role-TRAINER_STEVEN-attack.log`, `role-TRAINER_GLACIA-stall.log` (role games 1 and 2 of each fight). Run 1's logs and per-fight JSON were overwritten (they are in git history at commit `0dafef3`; Run 1's report is `docs/battle-sim/role-policy-gate-report-run1.md`), so log paths and log line numbers cited for Run 1, including those in `docs/battle-sim/role-policy-diagnosis.md`, refer to the old files.

The measured policy does NOT include the known open fixes cycle946gb (Magic Bounce read from the ability bitfield), s20c2bc (PP-loop Toxic Spikes check) and s20c2bd (Hot Coals and Caltrops on switch-in), and none of the design questions in `docs/battle-sim/role-policy-diagnosis.md` has been implemented.

No overall pass or fail is declared here; Yoshi reads the logs and decides.

#### Run 3 (after s20g)

Run settings: 80 games per policy per fight, 200-turn cap, seed offset 0, measured at commit `786cb8c` plus this cycle's observer-only Baton Pass counters, six processes in parallel on 8 cores (so ms/game is a contended figure; time is recorded, not gated).

| Fight | Policy | Run 3 wins/games | Run 2 wins | Run 1 wins | Rate | Wilson | ms/game | Capped | Boost available/used | Boosted / attacked boosted | Any positive stage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 1/80 | 1/80 | 1/80 | 1.3% | [0.002, 0.067] | 1009.8 | 0 | 155/0 | 0 / 0 | 9 |
| TRAINER_SIDNEY-attack | expectimax | 71/80 | 71/80 | 71/80 | 88.8% | [0.800, 0.940] | 1973.3 | 0 | 298/100 | 102 / 28 | 218 |
| TRAINER_PHOEBE-attack | role | 60/80 | 60/80 | 60/80 | 75.0% | [0.645, 0.832] | 1102.1 | 0 | 40/0 | 0 / 0 | 0 |
| TRAINER_PHOEBE-attack | expectimax | 15/80 | 15/80 | 15/80 | 18.8% | [0.117, 0.287] | 1615.1 | 0 | 276/4 | 10 / 10 | 10 |
| TRAINER_GLACIA-attack | role | 0/80 | 0/80 | 0/80 | 0.0% | [0.000, 0.046] | 1115.7 | 0 | 105/0 | 0 / 0 | 1 |
| TRAINER_GLACIA-attack | expectimax | 0/80 | 0/80 | 0/80 | 0.0% | [0.000, 0.046] | 1659.8 | 0 | 307/38 | 79 / 53 | 123 |
| TRAINER_DRAKE-attack | role | 1/80 | 1/80 | 2/80 | 1.3% | [0.002, 0.067] | 904.1 | 0 | 132/32 | 32 / 0 | 73 |
| TRAINER_DRAKE-attack | expectimax | 30/80 | 30/80 | 30/80 | 37.5% | [0.277, 0.485] | 2045.9 | 0 | 404/19 | 23 / 20 | 75 |
| TRAINER_STEVEN-attack | role | 0/80 | 0/80 | 0/80 | 0.0% | [0.000, 0.046] | 712.9 | 0 | 72/0 | 0 / 0 | 0 |
| TRAINER_STEVEN-attack | expectimax | 0/80 | 0/80 | 0/80 | 0.0% | [0.000, 0.046] | 1318.7 | 0 | 202/0 | 0 / 0 | 80 |
| TRAINER_GLACIA-stall | role | 3/80 | 3/80 | 3/80 | 3.8% | [0.013, 0.105] | 2602.5 | 0 | 304/0 | 0 / 0 | 224 |
| TRAINER_GLACIA-stall | expectimax | 5/80 | 5/80 | 5/80 | 6.3% | [0.027, 0.138] | 5818.1 | 0 | 452/0 | 0 / 0 | 185 |

`Boosted` / `attacked boosted` use the cycles20eb own-boost definition, so they are comparable with Run 2, not with Run 1.

Baton Pass own boosts (Runs 1 and 2 did not measure these):

| Fight | Policy | Own-boost step fired | Boost passes | Boost received |
| --- | --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 0 | 0 | 0 |
| TRAINER_SIDNEY-attack | expectimax | - | 8 | 4 |
| TRAINER_PHOEBE-attack | role | 0 | 0 | 0 |
| TRAINER_PHOEBE-attack | expectimax | - | 0 | 0 |
| TRAINER_GLACIA-attack | role | 0 | 0 | 0 |
| TRAINER_GLACIA-attack | expectimax | - | 3 | 3 |
| TRAINER_DRAKE-attack | role | 32 | 16 | 16 |
| TRAINER_DRAKE-attack | expectimax | - | 0 | 0 |
| TRAINER_STEVEN-attack | role | 0 | 0 | 0 |
| TRAINER_STEVEN-attack | expectimax | - | 0 | 0 |
| TRAINER_GLACIA-stall | role | 0 | 0 | 0 |
| TRAINER_GLACIA-stall | expectimax | - | 0 | 0 |

All five attack fixture teams carry a `support` with Baton Pass (Mr. Mime, `MOVE_BATON_PASS`); the stall team has neither. `Own-boost step fired` is read from the role policy's trace, so the expectimax row is `-`.

AI voluntary switches (turn counts; what our policy did on those turns):

| Fight | Policy | AI switches | Our action on those turns |
| --- | --- | --- | --- |
| TRAINER_SIDNEY-attack | role | 0 | none |
| TRAINER_SIDNEY-attack | expectimax | 0 | none |
| TRAINER_PHOEBE-attack | role | 0 | none |
| TRAINER_PHOEBE-attack | expectimax | 0 | none |
| TRAINER_GLACIA-attack | role | 1 | MOVE_MOONBLAST=1 |
| TRAINER_GLACIA-attack | expectimax | 3 | MOVE_MOONBLAST=2, MOVE_SNIPE_SHOT=1 |
| TRAINER_DRAKE-attack | role | 2 | MOVE_SHOCKING_JAB=2 |
| TRAINER_DRAKE-attack | expectimax | 75 | MOVE_MOONBLAST=57, SWITCH=18 |
| TRAINER_STEVEN-attack | role | 0 | none |
| TRAINER_STEVEN-attack | expectimax | 0 | none |
| TRAINER_GLACIA-stall | role | 0 | none |
| TRAINER_GLACIA-stall | expectimax | 5 | MOVE_ASTEROID_DOWNFALL=4, MOVE_FIRE_BLAST=1 |

Per-fight verdict as the rule gives it (from `classifyWinRates`; `uninformative` is not a fail), with whether the two Wilson intervals overlap:

- `TRAINER_SIDNEY-attack`: `role<expectimax`; intervals do not overlap (role [0.002, 0.067], expectimax [0.800, 0.940]).
- `TRAINER_PHOEBE-attack`: `role>=expectimax`; intervals do not overlap (role [0.645, 0.832], expectimax [0.117, 0.287]).
- `TRAINER_GLACIA-attack`: `uninformative`; intervals overlap ([0.000, 0.046] both).
- `TRAINER_DRAKE-attack`: `role<expectimax`; intervals do not overlap (role [0.002, 0.067], expectimax [0.277, 0.485]).
- `TRAINER_STEVEN-attack`: `uninformative`; intervals overlap ([0.000, 0.046] both).
- `TRAINER_GLACIA-stall`: `uninformative`; intervals overlap (role [0.013, 0.105], expectimax [0.027, 0.138]).

The pass rule (plan Step 2.0b): on every informative fight the role policy wins at least as often as expectimax, clearly more on the stall fight and where Mr. Mime's boosts decide; a fail stops Steps 1.3 and 2.x. Informative fights that violate "at least as often" (the report's own section): `TRAINER_SIDNEY-attack` (role 1/80 vs expectimax 71/80) and `TRAINER_DRAKE-attack` (role 1/80 vs expectimax 30/80).

Battle logs: `docs/battle-sim/role-policy-logs/role-TRAINER_SIDNEY-attack.log`, `role-TRAINER_PHOEBE-attack.log`, `role-TRAINER_GLACIA-attack.log`, `role-TRAINER_DRAKE-attack.log`, `role-TRAINER_STEVEN-attack.log`, `role-TRAINER_GLACIA-stall.log` (role games 1 and 2 of each fight). Run 2's per-fight JSON and logs were overwritten (git history at commit `536f8c6`; Run 2's report is `docs/battle-sim/role-policy-gate-report-run2.md`); all six log files came out byte-identical to Run 2's, so no log changed.

This run includes 946gb, s20c2bc, s20c2bd, s20g and s20gb; design question 1 of `docs/battle-sim/role-policy-diagnosis.md` was answered by s20g, and questions 2 to 5 are not implemented.

No overall pass or fail is declared here; Yoshi reads the logs and decides.

### Step 2.1 results (cycle942)
Landed: `web/src/engine/sim/driver/satisficingSearch.ts` (pure, headless, one unit per evaluator, evaluation and neighbour generation injected), covering decision 7 (a)-(d): the start build sampled on report seeds and returning immediately when `won`, screening by `fitnessValue`, at most `FINALISTS` (3) tuning samples per round in screen order, at most 3 report-seed confirmations, `UNIT_CAP` (6000, placeholder) with a per-run overshoot, `noNeighbours`, the highest-tuning-rate incumbent move, and the report-seed re-scoring of up to 3 candidates for units that end not reliably `won`. Candidate records carry `change` (`teamDiff`, decision 9a), `screenFitness`, `tuneVerdict/Wins/Games` and `reportVerdict/Wins/Games`; results carry `fragilityChecked: false` and `whatToChange: []` when `won`. `solver.ts` only exports `shuffled`. Tests: `cycle942SatisficingSearch.test.ts` (9 tests, fake evaluator, hand-derived game counts and seeds).
Left: the Step 1.2 report writer (JSON + markdown), Step 2.2 (battle summary and loss anatomy), and wiring into `solverCli.ts`/`solverWorker.ts` with `improveTeam` removed. Fragility (2.3) is not modelled, so "reliably `won`" is verdict `won` only.
Superseded in part by the 2026-11-24 revision: the round body (neighbour screen, incumbent move) is replaced by a GA generation (Steps 2.4-2.6; the evaluator plays the role policy, Step 2.0); the start sample, confirmations, cap, finish and re-scoring stay, and so do
the existing tests of those parts.

### Step 2.2 results (cycle943)
Landed: `web/src/engine/sim/driver/lossAnatomy.ts` (pure, headless) with `BattleSummary` — `firstFaintTurn` (1-based loop turn of the player's first faint, or null), `faintedSlots` (player party slots down at the end), `endSlot` (`battlers[0].partyIndex` at the end) and `opponentRemaining` — and `lossAnatomy`, which folds many games' summaries into `games`, `losses`, `firstFaintHistogram` (non-WON games only; a null first faint counts under key `0`), `endSlotCounts` and `meanOpponentRemainingInLosses` (null without losses). `playExpectimaxBattle` returns the required `summary` field, collected after every `stepTurn` with a local `downSlots` helper that trusts the live battler HP for an active slot (the party slot is stale until switch-out) and `party[i].hp` otherwise; empty slots (`speciesId === null`) are ignored in both the player's `faintedSlots` and the opponent's remaining count. No behaviour change: outcome, turns, finalScore and finalParty are identical for every seed (tests pin two). Tests: `cycle943LossAnatomy.test.ts` (5 tests, hand-derived histogram plus two real fights).
Left (d4-2c): the Step 1.2 report writer (JSON + markdown) and wiring `lossAnatomy` into `solverCli.ts`/`solverWorker.ts` alongside `searchUnit`; the throwaway mock in `cycle9d41WinProbability.test.ts` now carries an empty `summary`. Nothing is wired into the CLI or worker yet.

### Step 3 - per-fight / per-chain build tuning and the gym-trainer loop (queue item d4-4; needs D5, d5-1c and Step 0.5; `awaitingRoute`/`excluded`/`deferred` rows are skipped, not waited for)
3.1 The tuning units from the corrected `fights.ts` only (decision 1: code never parses `story-route.md`): every non-`deferred`, non-`excluded`, non-`awaitingRoute` row, rows sharing a `chainId` merged into one unit; skipped rows listed with the D5
    `levelCapForTrainer` text. Each unit's StageKey (cap, innate gate, Mega availability) from its row. Per-unit satisficing search (decision 7, Step 2.1) in route order when warm starts are on: an ordinary fight searched on that fight alone through `scoreTeam` (a gym leader at the empty defeated set, which is
    the first candidate of its gym's search in Step 3.3); a chain searched as ONE build on its chain win probability through `scoreChain` (`chains-plan.md` decision 4; HP/PP/status carry; won only if every member is won). The six species are taken from `--team` for every
    unit and never changed (Mega form is a build field). Caps from D5, move legality, `not-yet-legal` handling. `FitnessEvaluator` stays one unit per evaluator; `solverWorker.ts` carries the unit spec (fight or chain, StageKey,
    `defeated` set) per message instead of a per-worker trainer.
    **Mega gating from the StageKey.** Change `stoneAvailability(item, gym)` (`stoneAvailability.ts:33`) to `stoneAvailability(item, { badgeCount, braceletHeld })` and `availableStones` (`:63`) likewise: return unavailable when
    `!braceletHeld` (replacing `gym < BRACELET_GYM`, `:34`), and use `badges = badgeCount` (replacing `gym - 1`, `:36`) for `megaBadgeRequirement`; `nurseJoy` and `adoptionCenter` stones follow `braceletHeld` (both come with the bracelet,
    `PetalburgCity_Gym/scripts.pory:1760-1763`). `solverCli --gym N` maps to `{ badgeCount: N-1, braceletHeld: N >= 5 }`, which keeps today's behaviour for every existing call. Test: `h4-n4-b0` gives no Mega stone at all, `h4-n4-b1` gives
    the Nurse Joy stones, a stone with `megaBadgeRequirement` 5 is unavailable at `h4-n4-b1` and available at `h5-n5-b1`, and `--gym N` gives the same stone set as before for N = 1..8.
3.2 `W[unit][defeated set][build hash]` cache over all supported units (singles and chains first; doubles when D1/D2 land), keyed by (unit, defeated set, build) hash (the StageKey follows from the unit); non-leader units have one entry each.
    A guard selector beside `eventsForFight` handles the two guard shapes it drops today (`battleEventSetup.ts:41-43`): Mossdeep's `var(VAR_RESULT) < N` guards, from the count once Step 0.5(a) settles it (until then gym 7's search is excluded,
    decision 8), and Juan's `!(flag(FLAG_BADGE08_GET))` `TENSE_BATTLE`, registered for the first Juan fight. Test: Tate and Liza at count `c` get exactly the `6 - c` events with `N > c`; Juan's first fight gets `TENSE_BATTLE`.
    The Juan part is a UNIT TEST of the selector only: the Juan fight itself (a tag chain) still returns `unsupported` until doubles (D1/D2) and D3 land.
3.3 The per-gym satisficing defeated-set search and reporter (decision 8), starting from the leader's empty-set unit of 3.1 (if it is reliably `won`, the answer is the empty set and nothing more runs): the reachable candidate sets under
    the run's tag-battle outcome (default 'both', printed) in the fixed order (increasing `|D_g|`, then lexicographic), each sampled with the current leader build and searched under `SET_CAP` only if not tuning-`won`, all under `GYM_CAP`;
    stop at the first tuning-`won` (set, build), confirm it on report seeds plus the fragility check, resume on failure, at most 3 confirmations; per gym the chosen `D_g` and `|D_g|` in battles, the leader build that won it, its report
    verdict and interval, the smaller sets that were not tuning-`won` with their games spent, the number of confirmations attempted and the resulting worst-case error (decision 8), whether `GYM_CAP` was hit, the total `sum |D_g|`, the
    non-leader verdicts, and the excluded-fights list.

### Step 4 - species selection: OUT OF SCOPE
4.1 REMOVED (Yoshi, 2026-11-17): the user supplies the six species through the required `--team` (`solverCli.ts:37`), and the solver does not choose species. There is no `--pool` input, no species screen and no outer search over species
    sets. Reason: Yoshi's design decision of 2026-11-17 makes the species an input, so the solver's search space is the builds only. (`matchupReport.ts` and `genericTeam.ts` are not inputs to D4.)

### Step 5 - parallel driver
5.1 One worker pool reused across units; results (each unit's build and verdict) appended per unit so an interrupted run resumes.

### Step 6 - docs and queue
6.1 Rewrite `solver.md` (it still says doubles are out of scope, `:59-60`; it must also say builds are per fight / per chain, species are user-supplied, the player policy is the role policies of decision 14 with a 200-turn cap, and pools come from `setPools.json`), update `plan.md` step 7, `solver-evaluation.md`, STATE.md D4. After approval each step becomes one or more queue lines in the driver's format, and those lines REPLACE the current d4-0..d4-5 lines in STATE.md (they are seeds written before this revision, not briefs) (`[feature]` with the `expect move_notes <= K, ability_gaps <= J` gate); briefs are written inline because workers cannot read `.omc/` (CLAUDE.md). That conversion is part of the follow-up, not of this document.

## Assumptions every report states (decision 13)
Tier elite; the six species supplied by the user (not chosen); one build per ordinary fight and one per chain (the build shown is the one for that fight or chain, and it is the FIRST reliably-winning build the satisficing search found, not the best; its starting build and the games spent are shown); `UNIT_CAP`, `SET_CAP` and `GYM_CAP` values and which units or gyms hit them; EVs from the pre-defined templates only; the fixed route (Yoshi, 2026-11-17) and the fight's StageKey with its evidence label (`script` or `player-observed (Yoshi), not in the scripts at pin bdebcbbf`, `story-route.md`) and level cap (D5); the Elite level-cap table, confirmed by Yoshi (D5 decision 3); no Mega Bracelet for non-Norman fights between gym 4 and gym 5 (a modelling choice, decision 1); the fights skipped (`awaitingRoute`, `deferred` (the seven v1-scope rows) or `excluded`: the two Wally Victory Road rows, buggy in the pinned version, player-observed); the tag-battle outcome assumed (default 'both ids set', decision 8, until Step 0.5(b) settles it); the pending Yoshi decisions at the top of this plan;
the number of report-seed confirmations per gym and its worst-case error (decision 8); the chosen gym trainers are assumed beaten (their battles are not simulated); no bag items (the policy never uses the bag); top-K caveat for two-mon player sides (`doubles-plan.md` decision 4); the Juan stage-2 full-HP caveat until D3 lands; species/item availability not modelled, TMs and tutor moves usable at every stage (player-observed, Yoshi), level-up moves gated by the stage's cap; the policy is the role policies plus team
layer (decision 14), with each mon's role, role parameters and the team genes shown; the 200-turn cap and how many games reached it (decision 15); Permanent Mega Mode (Megas need the bracelet and the stone in the bag, decision 14);
battle-event `defeated` set per fight.

## Verification
- Statistics tests with hand-computed values; the seed-disjointness test; verdict boundaries (0.90 corrected lower bound, 0.50 corrected upper bound).
- A deterministic end-to-end test of the gym-trainer search on a tiny synthetic gym (hand-built map with a leader and three guarded trainers whose events are chosen so the known answer is a specific defeated set of size 1: the empty set is
  not `won`, that set is, a different size-1 set is not, and a size-2 set is also `won`), asserting the search returns that set, that it STOPS there (the size-2 set and any later size-1 set are never sampled), that the choice phase draws only tuning seeds and the confirmation only report seeds (seed log), that a failed or `fragile` confirmation resumes the
  enumeration at the next set in the fixed order and stops after 3, that a set won by the current build triggers no build search while a set not won triggers one bounded by `SET_CAP`, that the empty set reliably `won` ends the gym's search with no other set sampled, that a guarded event is present for every trainer outside it and absent for the trainer in it, and that the fight's StageKey (including a
  Mega-bracelet case: a leader at `h4-n4-b1` versus a fight at `h4-n4-b0`) is the single one the fixed-route table gives.
- A with/without test showing the what-to-change neighbours change the reported (report-seed) probability.
- Per-unit tuning tests: (a) two ordinary fights at the SAME StageKey get separate builds (tuning one leaves the other's build and cache entries unchanged); (b) every unit's build keeps the six `--team` base species (a Mega form counts as
  its base species); (c) a hand-built two-member chain is tuned as ONE build scored by `scoreChain`, a game counts as won only when both members are won, and the chain unit's evaluator is called with chain games (not per-member games);
  (d) the unit list of the real table has 32 units (34 rows, the Museum chain's three rows merged), no `deferred` or `excluded` row among them; (e) every gym-trainer `W` entry is keyed by (set, build hash) and the reported leader build is the one sampled at the answer set.
- Satisficing tests on a synthetic evaluator with known win probabilities: (a) a starting build that is `won` and not `fragile` costs exactly one sampler run plus the fragility runs, and no neighbour is generated; (b) a not-`won` start is searched
  and the search stops at the FIRST tuning-`won` finalist in graded-fitness order even when a later candidate has a higher true win probability; (c) a candidate that fails confirmation, or is `fragile`, moves the search to the next tuning-`won`
  candidate, at most 3 confirmations; (d) `UNIT_CAP` is never exceeded in tuning games and a capped unit is reported with its best candidate and what to change; (e) the starting build is sampled on report seeds and every searched candidate
  first on tuning seeds (seed log); (f) the warm start takes the previous unit's reliably-won build re-levelled to this cap, and falls back to `defaultSet` when there is none.
- Genetic algorithm tests (Step 2.4-2.5), fake evaluator, hand-derived counts: (a) one generation with `P = 20` plays exactly 94 tuning games before sampler runs, and game `g` of every individual uses the same seed; (b) every child's
  set genes and lead gene each come from one of its two parents (before mutation); (c) the 2 elites keep their records and add 4 games each; (d) a duplicate genome is not played again and shares its record; (e) only individuals with
  at least 16 games and a win rate of at least 0.75 reach the sampler, at most 3 per generation; (f) the same seed gives the same run; (g) the starting build is in the initial population as genome all zeros; (h) on a synthetic
  battle summary where one opponent mon fainted most of the player's mons and a member never used one move, `repair` replaces that move with the one the table says answers that mon best and adds the new set to the pool; (i) a
  synthetic landscape that needs two coordinated slot changes (each alone scores no better than the start) is solved within the cap, which the single-change search fails (the reason for this revision).
- Screen tests are listed in Step 2.6a; the gate itself (2.6b) is a measurement recorded in this document, not a unit test.
- Role policy and team layer tests are listed in Step 2.0a, the set-pool tests in Step 1.3; the policy gate (2.0b) is a measurement recorded in this document. GA additions (seventh revision): (j) order crossover always yields a valid
  permutation of the six purposes; (k) a `pool` mutation that changes a slot's role resets that slot's parameters to the new role's middle values; (l) a genome decodes to the same policy configuration every time.
- Repo gates for Step 1.3: `uv run --directory pipeline pytest`, and a regenerated `data/<version>/setPools.json` reviewed as a diff before it is committed (CLAUDE.md: the snapshot is committed deliberately).
- Repo gates: `npx tsc -b web`, `npm --prefix web test -- --run`, `npm --prefix web run build`, both sim audits via `.omc/team-pilot/validate.sh`; no singles result changes.
- Per CLAUDE.md the solver output is not trusted until D1-D3 and the audits land; any real run is shown to Yoshi before its numbers are relied on (task 62's standing note).

## Risks / open questions
- **Progression structure**: the gym order is fixed by Yoshi (gyms 2 -> 3 -> 4 is his statement of the player route, not a cited game fact); the earlier tables cited the stale "Winona can be skipped" comment and are wrong until d5-1c
  lands. Non-gym fights that d5-1/d5-1b gave a `mayBefore` gym are not settled by the gym order alone; their stage comes from `story-route.md` (steps 1-40, all placed 2026-11-17), via `fights.ts`. The two Wally Victory Road
  rows are `excluded` (buggy in the pinned version, player-observed), which shrinks the claim to "every mandatory fight except Wally at Victory Road is `won`" until that fight is resolved (`boss-fight-coverage.md` Unresolved item 3).
- **Gym-trainer error rate**: up to 3 confirmations per gym give a worst-case 15% chance that a gym's reported `won` is false, with no joint control over the seven gyms (decision 8); the report prints the confirmations attempted.
- **"Fewest" is among the sets the budgeted search made tuning-`won`**: a smaller set that is truly winning but came out tuning-`uncertain`, or needed a build `SET_CAP` did not reach, is not chosen; the report lists such sets with the games spent (decision 8).
- **Satisficing returns A winning build, not the best one** (Yoshi, 2026-11-18): the reported build may be barely above the `won` threshold, and a different build could win with a wide margin; reliability rests on the corrected `won`
  verdict plus the fragility check, not on a margin. Each unit has up to 3 report-seed confirmations, so a unit's reported `won` is false with probability at most 15% in the worst case (union bound), like a gym's (decision 8).
- **The role rules are hand-written and cannot improvise** (seventh revision): each role is an ordered rule list, so a situation no rule handles is played badly, and the rules encode how Yoshi would play a role, not a proof. Mitigations:
  the GA tunes each role's parameters and the team genes per fight, Step 2.0 compares the rules with expectimax on Yoshi's teams and Yoshi reads the logs, and a `lost` verdict means THIS policy loses. If a known-winnable fight
  stays lost after tuning, per-turn search (MCTS or rollouts, with the role policies as their continuation rule) remains the upgrade path (Decisions pending item 11).
- **The test fights may be luck-heavy**: Yoshi won them in play without planning, possibly with a lot of RNG (fixture `source`), so Step 2.0's numbers are relative, a fight where both policies win under about 20% is uninformative, and
  Yoshi's reading of the logs carries more weight than the win rate there.
- **The pools may miss a viable set** (seventh revision): about 5 sets per species is Yoshi's experience, and the synergy table, role fit and boss sets that pick them are partly guesses (magnitudes, a hand list of combinations, pairs
  standing in for triples). A missed set can only come back through `repair`, which edits one move of an existing set. Step 1.3 reports per role how many species get a set, and Step 2.6 tests the pools on lost units.
- **The predicted AI calls are the policy's main cost**: 3 `chooseAiAction` samples per turn, plus one per candidate on a replacement, on games up to 200 turns. Step 2.0b measures it; fewer samples are the first lever if it is too slow.
- **The per-fight screen may misrank sets** (2026-11-24): it sees damage, speed and resistances, not the AI's switching, status, set-up, weather or abilities that act outside the damage path, and it scores pairs, not teams. It only
  orders candidates among the pool sets (simulated games still judge whole teams), and Step 2.6b tests it before anything is built on it; every pool set stays reachable through the GA.
- **Lead plans assume the policy plays them** (2026-11-24): a lead plan is worth something only if the role policy executes it; the wall plan relies on the damage choice targeting the predicted switch-in, and the set-up plan on
  the role rule boosting on the turn-1 state, both of which the screen checks with the role policy's own rules; the double switch was left out. The predicted switch and replacement come from the real AI code but at sampled seeds on a
  constructed turn-1 state, so they are probabilities, not facts, and Step 2.6b checks them against the sampled games.
- **The GA's settings are guesses** (2026-11-24): `P` 20, about 5 sets per species, crossover 0.9, mutation 0.3, the halving schedule, the 0.75 finalist bar, the role-parameter values and the fitness weights are placeholders. With
  2-16 games per individual the graded fitness is noisy; common seeds within a generation and elites that accumulate games reduce, not remove, that noise. A wrong setting shows up as units hitting `UNIT_CAP`, which d4-0d measures.
- **Caps are guesses**: `UNIT_CAP` (6,000), `SET_CAP` (1,500) and `GYM_CAP` (12,000) are placeholders, unmeasured; a unit or gym that hits its cap is reported `uncertain`/`lost`, which may only mean the cap was too low. Step 0.4 sets them.
- **Warm starts serialize units**: with warm starts units run in route order and a unit's result depends on the previous unit's build; parallelism is only within a unit. Step 0.4 decides whether warm starts are worth that.
- **The leader build at the answer set may be reused, not searched**: a set won by the current build skips the search; reliability then rests on that pair's report confirmation and fragility check only (decision 8, "Consequence for the frozen-build shortcut").
- **Gym-trainer facts not yet established** (Step 0.5): what `adddefeatedcount` does per call, which ids a tag battle marks `defeated` (run default 'both', reported), whether any sight line or puzzle block bypasses the opt-in `yesnobattle`, which side each event favours, and whether every guarded event has a ported handler. Until then the search
  may enumerate every reachable set per gym (up to `GYM_CAP`) under the 'both' outcome and Mossdeep is excluded.
- **Beaten gym trainers are not simulated**: a `D_g` assumes the player beats those trainers; a hard gym trainer could make a small `D_g` optimistic.
- **Cost** is the main risk (decision 12): the expected cost depends on how many units the starting build already wins and on the search cost to the first `won`, both unmeasured until Step 0.4; the worked range is about 1.3 h (no unit searched) to
  9.8 h (20 weighted units searched at the cap) on 8 workers, and the ceiling is about 22.5 h with the gym-trainer search; reduced search options come first.
- **Per-fight builds assume the player can re-build between every two ordinary fights** (moves, item, ability, nature, EVs, Mega choice; Yoshi, 2026-11-17). The plan does not check that each change is obtainable at that point
  (a move relearner, an ability change, an EV reset, a stone): TM/tutor and item availability are unmodelled, so the report's build-to-build diff (decision 9a) is what the player must check.
- **A chain build is a compromise across its members**: one build must win every member in sequence, so a chain can be `uncertain` or `lost` even when each member alone would be `won` with its own build; the report shows which member the losing chain games ended on.
- **Item availability** is unmodelled; a suggested build may need an item not obtainable at the stage it is used. The species are the user's, so species availability is the user's responsibility.
- **Sensitivity** is an operationalisation of "one AI choice flips the answer"; its window and ranks are calibrated, not derived.
- **Policy dependence**: the role policies (decision 14) are not an optimal player; a `lost` verdict means this policy loses, and a `won` verdict means this policy wins against this AI model (statistical, not bit-exact, `plan.md:137-148`).
- **Scope**: boxed over-cap mons, Easy/More level caps, Double Battle Mode, Hell tier and bag healing items are out of scope.
