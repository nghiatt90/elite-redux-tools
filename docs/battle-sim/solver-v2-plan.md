# Plan: solver v2, team selection, minimal gym subset, honest win probability (D4)

_Status: APPROVED by a cold Opus reviewer after 3 rounds (round 3: APPROVED; its four non-blocking notes applied). Not yet committed or executed. History: DRAFT 3 (draft 2: StageKey data undefined; fixed with a progression table and an explicit subset-to-StageKey rule). Earlier: DRAFT 2 (draft 1 got NEEDS WORK: Mega availability keyed wrongly, no multi-fight objective, repeated-look interval, seed overlap with chains, no search log, widePool undecided, fight unit undefined, fragile test undefined; all reworked), not yet re-reviewed.
Vikunja task 62. This is the D4 design doc (the earlier driver plan `.omc/plans/driver-d6-d5-audits-d4.md` called it `solver-design.md`). Planning only: no code is changed by this document. Depends on
`innate-gating-plan.md` (D5), `chains-plan.md` (D3) and `doubles-plan.md` (D1+D2); the statistics, report and sensitivity parts on singles fights can start first._

## Goal

Answer, for the boss fights (43 script-level fights over 55 trainer ids, `boss-fight-coverage.md:66`; STATE.md calls the same set "the 40 fights"), "does this team win this fight, and what should change", with an honest
win probability, and find the fewest gyms the player must clear for a full clear. Decisions from Yoshi (2026-11-15): the gym-subset loop finds the **fewest gyms for a full clear**; a fight counts as **won when the lower end of the
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
- Mega availability: no Mega exists until Norman hands over the Mega Bracelet in the Gym 5 script, and stones are gated by `megaBadgeRequirement` badge counts (`stoneAvailability.ts:5-13,31-50`), so it depends on WHICH gyms were
  cleared (gym 5 held, total badge count), not only on the highest badge.
- Play policy: depth-1 expectimax (`expectimax.ts:110`: depth 1, samples 6, innerSamples 2, switchMargin 0.05, statusTerms) against six sampled AI actions per option (`sampleOpponent` `:1070-1080`, which calls `chooseAiAction` for the
  policy's own model of the AI); replacement by the game's "most suitable mon" heuristic (`:1143`). About 1.3-1.4 s per game per fight single-threaded (`solver-evaluation.md:65-73`, noisy); depth 2 about 4x (`solver.md:24`).
  `solver.bench.test.ts:14` is a reduced single-threaded benchmark (screen 2, confirm 6, `maxNeighbours` 30, 1 pass), NOT solverCli with workers; no end-to-end solver time is documented.
- Seeds: mulberry32 (`rng.ts`); battle seed `seedOffset + g`; expectimax per-turn seed `seed*31 + turns` (`expectimax.ts:1191`). `chains-plan.md` decision 4 seeds stage `k` of game `g` as `seedOffset + g*1000 + k`.
- Known statistical limits: a team chosen on the tuning seeds is selection-biased (`solver.md:61-62`); the 24-battle check is about plus or minus 2 wins (`solver-evaluation.md:43,73`). `widePool` defaults to off and is "left to the solver
  design session (D4)" (`solver.md:54-55`, `solver-evaluation.md:86`, `.omc/plans/driver-d6-d5-audits-d4.md:108-109,130`).

### Missing against the five acceptance items
| Item | Today | Building blocks |
|---|---|---|
| Species selection | none; species come from `--team` | `species.json` (`learnset`, `evolutions: [{level,to}]`, `megas`, `abilities`, `innates`, `baseStats`); `genericTeam.ts`; `matchupReport.ts` damage matrix |
| Minimal-gym-subset loop | none | `bossSet.ts:11-45` returns trainer ids only (no format, no gym number, no mandatory flag); `levelCapFor` unwired (D5) |
| Win probability with interval | bare `winRate` | `Fitness.games` (wins/games) |
| Sensitivity (fragile fights) | none | seeded RNG; `chooseAiAction` is the AI decision point |
| What-to-change | final team only | `PlayerMonSpec` field diff is possible; no search log exists |

### Data limits
- No species-availability-by-progression data in the COMMITTED data (`encounters.json` has only `battleEvents`, `fieldEffects`, `inverseBattles`, `tagBattles`, `trainerChains`), and no item availability data; `ITEM_POOL` is curated.
  Upstream wild tables are on disk (`pipeline/.upstream/eliteredux-source/src/data/wild_encounters.json`, e.g. wild Pidgeotto at levels 2-3 at `:2644-2661`) but are not extracted; availability stays unmodelled here.
- The fight list has no badge counts; D5 produces a per-trainer-id `highestBadge` range table from the map scripts. TM and tutor availability is story-gated and not modelled.

## Design decisions

1. **The unit of evaluation is a (fight, StageKey) pair.** A `StageKey = { highestBadge, badgeCount, braceletHeld }`: the cap depends on `highestBadge` (`GetLevelCap`, D5), but Mega availability depends on the other two
   (gym 5 held, total badges), so `W[fight][StageKey]` is keyed by all three. Results are cached by (fight, StageKey, build). **The progression table** (new, one table with two consumers, built in Step 1.0 jointly with D5 Step 1) has
   per fight `{ fightId, requiredBefore: gymNumber[], mayBefore: gymNumber[], evidence }`: the gyms that must already be cleared when the fight can occur, and the skippable gyms that may or may not be. **Rule turning a gym subset `S`
   into a fight's StageKey**: the gyms cleared before the fight are `requiredBefore ∪ (mayBefore ∩ S)` (the gyms of `S` are assumed cleared as early as the table allows, the best case for the player, stated in every report);
   `highestBadge` = the largest such gym number (0 if none), `badgeCount` = the set's size, `braceletHeld` = gym 5 in the set (the Mega Bracelet comes from Norman's Gym 5 script, `stoneAvailability.ts:5-13`). D5's `highestBadgeMin/Max` are
   derived from the same table (min over `requiredBefore`, max over `requiredBefore ∪ mayBefore`), not a second source. The distinct StageKeys are the output of enumerating all legal subsets over this table (Step 1.0 reports the number;
   decision 12's cost scales with it).
2. **A fight list is built once, before anything else (new Step 1.0).** `fights.ts` has rows `{ fightId, trainerIds[], format ('singles'|'double'|'tag'|'multi'|'chain'), chainId?, gymNumber?, mandatory, requiredBefore[], mayBefore[] }` (the last two from the progression table of decision 1).
   `fightId` is the FIRST trainer id of the fight in script order (matching D5's trainer-id keys; no other id space). `format`/`chainId` come from `boss-fight-coverage.md`, `doubles-plan.md` and `chains-plan.md`; the badge ranges are DERIVED from the progression table (decision 1), not a second source; `mandatory` is
   true for every fight a full clear must win and false for the optional ones the coverage doc lists (`boss-fight-coverage.md:480,491`: the optional Gym 8 two-on-one branches), recorded in a data file with the citation because no existing
   file records it. The step also lists, per fight, the map/`defeated` set that selects its battle events.
3. **Fight evaluators come from D1-D3.** `evaluateFight(build, fight, stageKey)` dispatches on `format`: singles (`scoreTeam`), double/tag/multi (`doubles-plan.md`), chain (`scoreChain`, `chains-plan.md`). Until D1/D2 land those
   fights return `unsupported` and are reported as excluded, never silently scored as singles. In multi fights the player brings 3 of the 6 (`doubles-plan.md:131`): the solver evaluates all 20 three-mon subsets on a reduced sample
   (20 games each) on TUNING seeds, picks the best, and only then runs the full sampler on REPORT seeds (choosing the subset on report seeds would reintroduce selection bias).
4. **Win probability is a Wilson interval, sequentially sampled with a correction for repeated looks.** Games run in batches of 40 with at most 10 looks (400 games). Looking after every batch and stopping at the first decisive
   interval inflates the error of a nominal 95% interval, so each look uses a Bonferroni-corrected per-look level of 0.005 (two-sided z about 2.81), which keeps the OVERALL error at or below 5%; the report labels the interval
   "95% simultaneous over up to 10 looks" and states the per-look level. **What `won` effectively demands**: with z about 2.81, `won` needs at least 71 straight wins (80 in batches of 40), and at 400 games an observed 0.95 gives a corrected
   lower bound of only about 0.91, so `won` in practice needs a true win probability of roughly 0.94 or more and teams near 0.92 will always come out `uncertain`; this is the price of the "never a bare verdict" rule and is shown to Yoshi with the first report. A fight is `won` if the corrected lower end is at least 0.90, `lost` if the corrected upper end is below 0.50, else `uncertain` at 400 games. (At 40 straight wins
   the corrected lower bound is below 0.90, so a `won` verdict needs more than one batch, by design; Step 1.1 tests the numbers.) Games are independent draws of the stochastic pipeline even though the expectimax policy is itself sampled.
5. **Seeds are allocated by purpose so tuning and reporting can never overlap.** Every evaluator derives battle seeds from `seedOffset + g*1000 + k` (singles use `k = 0`; chain stage `k`, `chains-plan.md` decision 4), with the
   tuning offset 0 and the REPORT offset 10,000,000, valid for `g < 10,000` and `k < 1000` (so the two ranges are disjoint by construction). The Step 1.1 test enumerates the actual seeds each evaluator produces for the tuning
   and report purposes and asserts the sets are disjoint; the old 1001.. fresh set (`solverCli.ts:114`) is replaced by the report offset. Only report-seed results are ever reported. This changes the solver's singles seeds from `seedOffset + g` to `seedOffset + g*1000`, so solver OUTPUT numbers change;
    "no singles result changes" in Verification means sim mechanics, not solver outputs (no unit test pins solver numbers; only the two bench tests and `solverCli` call `scoreTeam`/`playExpectimaxBattle`).
6. **The search returns structured candidate records.** `improveTeam` is extended to return, per member and pass, `{ change, fitnessTuneByFight, games }` for every screened neighbour (today it keeps none); the PER-FIGHT fitness is recorded because the objective is a mean over a
   StageKey's fights and the top 3 for each not-`won` fight must be ranked on that fight alone. "What-to-change" (decision 9b)
   re-scores the top 3 neighbours for every not-`won` fight on the REPORT seeds with the sequential sampler (cost included in decision 12); the tuning-seed fitness is never shown as a probability.
7. **Stage builds, tuned against a fixed assignment of fights (no circularity).** One 6-species team for the whole run, with one build (moves, item, ability, nature, EVs, Mega choice) per StageKey. Fights are assigned to StageKeys
   BEFORE tuning from the progression table (a fight is assigned to every StageKey the rule of decision 1 produces for it over all legal gym subsets), so the tuning objective does not depend on `W`. The objective at a StageKey is the MEAN fitness
   over its assigned fights, with the worst fight reported and the minimum used to break ties. Moves must be learnable at the stage's level (`learnableMoves`); a species whose evolution level exceeds the cap gets the D5 warning
   (printed, not enforced); a build with a move not learnable at the stage level is rejected for that stage and the stage's fights are `not-yet-legal`. Because the evaluator is no longer one fight, `FitnessEvaluator` takes a fight list and
   the worker protocol carries fight specs (below).
8. **Minimal gym subset = fewest gyms for a full clear (Yoshi).** A full clear is winning every `mandatory` fight through the Elite Four and Champion. The progression table (which `FLAG_BADGE0x_GET` flags each gate and fight requires, and which gyms
   are skippable) is built in Step 1.0 (jointly with D5 Step 1) from the map scripts, after Step 0.5 confirms the facts; the `pokemon.c:4633` comment only mentions skipping Winona, so general skippability is NOT assumed until Step 0.5 confirms it. A subset is
   ILLEGAL if it omits a gym listed in `requiredBefore` of any `mandatory` fight. Clearing the subset's gyms as early as the table allows is assumed to be the best case for the player because the cap is monotonic in badges (`er-level-asymmetries.md:38-39`,
   noting that opponent levels also scale with the player's highest level, so earlier is better only for the player's own strength, and the report says so). The loop enumerates legal subsets (at most 2^8)
   in increasing size and, for each, looks up `W[fight][StageKey-under-subset]`; the first subset whose mandatory fights are all `won` (and whose own gym fights are `won`) is the answer, ties broken by the larger minimum corrected lower bound. If no
   subset wins, the output is the subset with the fewest non-`won` mandatory fights, ties by the largest sum of corrected lower bounds, plus the list of losers. Skipped gyms are excluded fights.
9. **Reports.** (a) A field-by-field diff of the final builds against the starting builds. (b) For each not-`won` fight, the top 3 single-change neighbours with report-seed intervals and deltas (decision 6). (c) A loss anatomy from
   a small battle summary (which stage/mon the losing games ended on; first-faint turn histogram) that `playExpectimaxBattle` returns alongside `{outcome, turns, finalScore}` (`expectimax.ts:1171-1195`).
10. **Sensitivity ("fragile") is a defined perturbation experiment.** Only fights whose baseline verdict is `won` are tested. The perturbation acts on the OPPONENT's real action (the AI's chosen move in the turn step); the player's expectimax model of the
    AI (`sampleOpponent`) is NOT perturbed, because the player does not know the AI will deviate. At decision turn `t` in {1, 2, 3}, the AI's chosen MOVE is replaced by its `r`-th best-scoring legal move for `r` in {2, 3} (AI move scores from `chooseAiAction`;
    switch decisions are not perturbed; ties in AI score are ranked by move slot order, deterministically). The hook site is the REAL AI call in the turn step (`session.ts:436-437`, `stepTurn`), not `sampleOpponent`. If the AI switches at turn `t`, or has fewer
    than `r` legal moves, the perturbation does not apply: the game stays in the sample as unperturbed and the report prints the fraction of games where it applied. That is 3 x 2 = 6 perturbations, each a fixed 100-game run on the report seeds. A fight is `fragile` if any perturbed run's win-rate interval, with the per-comparison level corrected by 6 looks (0.05/6), has an upper end
    below 0.90 (it is distinguishable from `won`). The turn window and ranks are Step 0.3 calibration outputs on known fights, not final constants.
11. **`widePool` stays OFF by default in v2.** A `--wide-pool` flag turns it on, with `maxNeighbours` 120 unchanged (it samples the larger pool deterministically). The reason: it adds every learnable status and utility move to the neighbour pool, which grows the search (the neighbour cap of 120 samples a larger pool, so improvement per neighbour falls) while the
    value terms for such moves (`statusTerms`, cycle 147) are recent and unmeasured in search; the verified-effect gate (`VERIFIED_MOVE_EFFECTS`, each entry mapped to a proving test, `solver.md:41-44`) already restricts WHICH status moves are eligible,
    so this is about cost and measured benefit, not correctness of the gate. Revisit trigger: Step 0 measures, on 3 fights, the win-rate gain and the time cost of `--wide-pool`; `solver.md` records the result. ("D6" in older notes means the finished
    move-pool work, STATE.md:58,86; the mutation plan `ported-by-mutation-plan.md` is a different item with the same label at STATE.md:291.)
12. **Cost budget (to be measured in Step 0).** Report-seed evaluation: about 1.4 s per game per singles fight single-threaded (chains about 3x, doubles unmeasured); 43 fights at an adaptive average of about 120 games is about 2 h single-threaded, about 15 min on 8 workers.
    TUNING dominates: roughly 120 neighbours x 4 screen games + 3 x 16 confirms per member, 6 members, 2 passes is about 6,000 games per fight-stage; with the mean-over-assigned-fights objective (about 4 fights per StageKey) that is about 24,000 games
    per StageKey, about 9 h single-threaded and about 1.2 h on 8 workers, times the number of distinct StageKeys that Step 1.0 reports (not assumed here): hours to a day on 8 workers. The plan therefore starts with reduced search options (smaller `maxNeighbours`, 1 pass) and measures before committing to defaults;
    the `solverWorker.ts` protocol carries a fight list, StageKey and build instead of one trainer, and one worker pool is reused across fights.

## Steps

### Step 0 - calibrate and verify (measure; no behaviour change)
0.1 Measure end-to-end time of `solverCli` itself (not `solver.bench.test.ts`, which is a reduced single-threaded benchmark) with 6 workers on one singles fight; record per-game time at depth 1 and the cost table of decision 12.
0.2 Build the sequential Wilson sampler on the existing `scoreTeam` for 3 known fights (an easy early fight, a hard mid fight, one the user considers borderline) and check the corrected-interval widths and stopping behavior against decision 4.
0.3 Prototype the AI perturbation (decision 10) on one fight; calibrate the turn window and ranks so a known-fragile and a known-stable fight separate; record the numbers.
0.4 Check that the matchup-matrix screen ranks species consistently with battle win rate on 3 fights (decision on species selection, Step 4).
0.5 Read the map scripts to confirm the facts the progression table needs (which gyms are actually skippable, the Mega Bracelet gate, which gym fights precede each boss fight); the table itself is built in Step 1.0.

### Step 1 - fight list, statistics and report (no D1-D3 dependency)
1.0 The progression table (decision 1) and `fights.ts` (decision 2), each with a data file, built jointly with D5 Step 1 (one table; `fightBadges` is derived from it). Tests: every id from `loadBossTrainerIds` appears in exactly one `fights.ts` row; every row has a
    format, a mandatory flag with a citation, and `requiredBefore`/`mayBefore` with evidence; a test of the subset-to-StageKey rule on a hand-built table; and a report of the number of distinct StageKeys over all legal subsets (this number feeds decision 12).
1.1 `winProbability(wins, n, level)` Wilson interval, the corrected sequential sampler and verdict rule, the seed allocator (decision 5). Unit tests with hand-computed intervals (including the 40-wins case above and the 400-game half-width), boundary cases,
    and the seed-disjointness test over the seeds the singles and chain evaluators actually produce.
1.2 The report writer: JSON plus markdown with per-fight `p`, interval and level, `n`, verdict, `fragile`, assumptions (decision 13 below), what-to-change. It replaces the `{trainerId, tier, fitness, fresh, team}` JSON; no existing test reads that `--out` file
    (grep before changing), so no compatibility shim.

### Step 2 - search record, what-to-change and sensitivity (singles fights first)
2.1 `improveTeam` returns the candidate records (decision 6); the team diff; the report-seed re-scoring of the top 3 neighbours.
2.2 The battle summary return value and loss anatomy.
2.3 The AI perturbation wrapper (decision 10) and the `fragile` flag, calibrated per Step 0.3.

### Step 3 - stage builds and the gym-subset loop (needs D5 and Step 0.5)
3.1 StageKey, the fight-to-StageKey assignment, per-StageKey tuning with the mean objective, caps from D5, move legality, `not-yet-legal` handling; `FitnessEvaluator` and `solverWorker.ts` carry fight lists and StageKeys; `stoneAvailability` inputs derive from the StageKey.
3.2 `W[fight][StageKey]` table builder over all supported fights (singles and chains first; doubles when D1/D2 land), cached by (fight, StageKey, build) hash.
3.3 The subset enumerator and reporter (decision 8) with the excluded-fights list.

### Step 4 - species selection
4.1 `--pool` input (user-supplied species ids; default every non-form species), the matchup-matrix screen against the union of the targeted fights' opponents, top K per slot, then `improveTeam` on the shortlist. Out of scope until Step 0.4 shows the screen is usable; until then species stay user-supplied.

### Step 5 - parallel driver
5.1 One worker pool reused across fights; results appended per fight so an interrupted run resumes.

### Step 6 - docs and queue
6.1 Rewrite `solver.md` (it still says doubles are out of scope, `:59-60`), update `plan.md` step 7, `solver-evaluation.md`, STATE.md D4. After approval each step becomes one or more queue lines in the driver's format (`[feature]` with the `expect move_notes <= K, ability_gaps <= J` gate); briefs are written inline because workers cannot read `.omc/` (CLAUDE.md). That conversion is part of the follow-up, not of this document.

## Assumptions every report states (decision 13)
Tier elite; level cap and badge scenario (D5); no bag items (the policy never uses the bag); top-K caveat for two-mon player sides (`doubles-plan.md` decision 4); the Juan stage-2 full-HP caveat until D3 lands; TM/tutor and species/item availability not modelled; the policy is the
depth-1 expectimax; `widePool` state; battle-event `defeated` set per fight.

## Verification
- Statistics tests with hand-computed values; the seed-disjointness test; verdict boundaries (0.90 corrected lower bound, 0.50 corrected upper bound).
- A deterministic end-to-end test on a tiny synthetic fight set (hand-built so the winning subset and the StageKey effects, including a Mega-bracelet case, are known) for the subset loop.
- A with/without test showing the what-to-change neighbours change the reported (report-seed) probability.
- Repo gates: `npx tsc -b web`, `npm --prefix web test -- --run`, `npm --prefix web run build`, both sim audits via `.omc/team-pilot/validate.sh`; no singles result changes.
- Per CLAUDE.md the solver output is not trusted until D1-D3 and the audits land; any real run is shown to Yoshi before its numbers are relied on (task 62's standing note).

## Risks / open questions
- **Progression structure** (which gyms are skippable, which fights need which badges) is derived from scripts in Step 1.0 (jointly with D5 Step 1) after Step 0.5 confirms the facts; a wrong table gives a wrong "fewest gyms" answer, so every row carries evidence.
- **Cost** is the main risk (decision 12): per-StageKey tuning is hours; reduced search options come first.
- **Mean-fitness stage objective** can trade a fight lost for several won; the worst fight is reported and breaks ties, and the per-fight verdicts are still decided on report seeds.
- **Species and item availability** are unmodelled; a suggested team may not be obtainable at the stage it is used.
- **Sensitivity** is an operationalisation of "one AI choice flips the answer"; its window and ranks are calibrated, not derived.
- **Policy dependence**: the depth-1 expectimax is not an optimal player; a `lost` verdict means this policy loses, and a `won` verdict means this policy wins against this AI model (statistical, not bit-exact, `plan.md:137-148`).
- **Scope**: boxed over-cap mons, Easy/More level caps, Double Battle Mode, Hell tier and bag healing items are out of scope.
