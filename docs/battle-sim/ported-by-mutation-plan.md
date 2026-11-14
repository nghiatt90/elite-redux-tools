# Plan: "ported" decided by mutation, not text matching (D6)

_Status: APPROVED by a cold Opus reviewer after 6 rounds (round 6: APPROVED; its three non-blocking notes applied). Not yet committed or executed. History: DRAFT 5 (draft 4: the bundled CLI could not read the scratch tree, fixed by a vitest-hosted dump; stale `verifiedStatus` wording fixed; `mutation:check` runs only in the reviewer pass or with the driver stopped, because it writes `docs/battle-sim/mutation-summary.md` into the main checkout). Earlier: (draft 3: Steps 3-4 contradicted the unpinned-counts decision, import filter excluded core effect tests; both fixed). Earlier drafts: (draft 1: scratch tree could not run the suite, circular kills, wrong coverage selection, incomplete operator, unresolved status rule, staleness; draft 2: behavioural filter too broad, "staleness never changes validate" was false, operator neutral values; all reworked), not yet re-reviewed.
Vikunja task 483 (subtask of 54). Planning only: no code is changed by this document._

## Goal

Every inventory unit (move effect, secondary effect, legacy script, held item, ability hook in the sim dispatchers, environment token) is marked `ported` only when neutralising that unit's guarded production code
in a scratch copy makes at least one BEHAVIOURAL test fail. Units whose code exists but survives are reported as registered-but-untested, and units with no mutable site are listed with a reason. This replaces
text-matching as the ground truth that the existing inventories lack.

## Context (verified by a read-only survey and a cold review, 2026-11-15)

- All four inventories decide status by regex over source plus a test-name match; none runs the sim. `driver/moveInventory.ts` (3475 lines): production evidence `buildConsumptionIndex` (`:639-701`), test evidence
  `buildTestEvidence` (`:2093`, `it(` blocks calling an entry point, `ENTRY_POINT_CALL_RE` `:172`), status rule `:2568-2606`, pinned `UNPORTED_PAIR_COUNT = 235` (`moveInventory.test.ts:100`).
  `driver/itemInventory.ts` (2761): `classifyToken` `:1521-1548`, site map `C_SITE_SIM_MAP` `:286-706`, AI sites kept apart (`aiProductionSource`, `:1921`). `driver/environmentInventory.ts` (2928): `classifyToken`
  `:992-1096`. `driver/abilityHookInventory.ts` (1765): `PORTED_*` sets built from `case`/`===` regexes (`:1241-1285`), test evidence is any `ABILITY_*` mention (`:1446`).
  `driver/verifiedMoveEffects.ts` is a hand-curated effect-to-test list trusted by `effectHasTestEvidence` (`moveInventory.ts:2564`).
- Evidence the text rules are unreliable (STATE.md): a reviewer's 21 scratch-copy mutations left 14 inventory results green (151b); stubbing 21 handlers with `=== 'HOLD_EFFECT_X' && false` kept the item
  inventory at 116 (152b); 16 documented-ported features disabled left the environment inventory green (153b).
- Handler shapes: `HANDLERS` is a module-private `Record` at `moveEffects.ts:11222` (~260 entries), read only through `getMoveEffectHandler` (`:11483-11486`); `CUSTOM_MOVE_DAMAGE` is in
  `web/src/engine/basePower.ts` (~`:105`); `SECONDARY_MOVE_EFFECT_MAP` `moveEffects.ts:11497`; everything else is inline `===` / `case` branches in `turn.ts`, `moveEnd.ts`, `switchIn.ts`, `endTurn.ts` and about 12
  ability dispatch files (`abilityHookInventory.ts:247-258`). Secondaries also dispatch on numeric identifier constants (`statusEffects.ts:956-962` `case MOVE_EFFECT_SLEEP:`, `:337` `moveEffect === MOVE_EFFECT_TOXIC`).
  Legacy scripts have no single function (`SCRIPT_OPCODE_HANDLERS` `:741-1670`). Data-driven units (Natural Gift, Fling, Mega stones, effect-less moves, `declarativeEffects`/`plainHitEffects` at
  `moveInventory.ts:2582,2586`, `BATTLE_TYPE_*` flags set at `session.ts:269`) have no handler.
- Tooling facts: no `vi.mock`/`vi.spyOn`/`vi.stubEnv` under `web/src`; `web/vitest.config.ts` sets only `testTimeout: 60000` (the randomizer tests need it); vitest `^5.1.0`; no coverage dependency; no Stryker;
  `tsx`/`vite-node` are not installed. The full suite is about 7037 tests in 250 files (244 run, 6 skipped) and takes 245-300 s (`.omc/team-pilot/logs/cycle160..162/suite.log`; 89-91% is test execution), so one
  full-suite run per unit is infeasible.
- The suite resolves paths OUT of `web/src`: `REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))` at `moveInventory.ts:133`, `itemInventory.ts:717`, `abilityHookInventory.ts:244`,
  `environmentInventory.ts:298`; it reads `pipeline/.upstream/...` (`moveInventory.ts:138-145`, `environmentInventory.ts:299`), `sources.lock.json` (`abilityHookInventory.ts:245`), `data/v2.65beta/*.json`,
  `docs/battle-sim/*.md` and `.omc/solver/*.json`.
- The inventory and audit tests READ production source text (`readFileSync` from `REPO_ROOT` / `ENGINE_DIR`) and pin counts derived from it (`moveInventory.test.ts:100/170`, the `cycle150b/151b/152b...Inventory.test.ts`
  family, `abilityHookInventory.test.ts`, `abilities/coverage.test.ts`, `layering.test.ts`), so in a mutated copy they go red for a reason unrelated to behavior.

## Design decisions

1. **Mutate the guarded REGION with a SAFE neutral value, not the token.** For a unit, the AST pass finds each production site and its guarded region and neutralises it so the behavior cannot run, never renaming
   identifiers (renaming `MOVE_EFFECT_SLEEP` would only create a ReferenceError) and never substituting a value of the wrong type (a bare `return` from a handler that must return `ActionOutcome`, `moveEffects.ts:362`, would
   throw a TypeError in the caller). Site shapes handled, each with a fixture test: (a) `HANDLERS`/table entry `KEY: fn` -> the ENTRY is deleted, so `getMoveEffectHandler` returns `null` (`moveEffects.ts:11483-11486`) and
   the real fallback path runs; the handler body is left alone, so a handler shared by several keys (`handleWeatherRecovery` backs 4 keys, `handleProtect` 3, `handleHealHalf` 3; `moveEffects.ts:11222-11481`) is
   attributed per key; (b) `case 'T':` / `case CONST:` clause -> that label is split out as its own `case X: break;` (a label that shares a body with others, `statusEffects.ts:956-962`, is split, not emptied with the group);
   (c) `if (x === 'T' | CONST)` -> the consequent is emptied and the `else` kept; a compound condition `a === 'T' || b` rewrites only the `a === 'T'` operand to `false`; a ternary is replaced by its alternate;
   (d) BOOLEAN predicate calls `battlerHasAbility(..., 'ABILITY_X')` / `aiHoldEffectIs(..., 'HOLD_EFFECT_X', ...)` in positive position -> the call becomes `false`; predicates that return an index or state
   (`findAbilitySlot`, `getAbilityStateOf`) are `unrecognised-site`; (e) `Set`/`Map`/array membership -> the member is removed. A NEGATED or `!==` site is skipped and reported `negated-site` because neutralising it would
   enable behavior. Any other shape is `unrecognised-site`, never guessed. Because every neutral value is one of delete / `false` / empty / alternate / `break`, a test that then THROWS (TypeError from an absent
   handler result, an assertion) is a genuine behavioural kill; only ReferenceError/SyntaxError at import or module evaluation is `invalid-mutant`.
   AI sites (`web/src/engine/sim/ai/**`) are mutated separately from battle sites, as `itemInventory` already separates them, so a kill from changed AI move choice is not credited to the battle-side unit.
2. **The scratch tree reproduces the repo layout.** It is a directory (under the session scratch dir) containing: a real copy of `web/src` and `web/vitest.config.ts`/`tsconfig*`/`package.json`; symlinks for
   `web/node_modules`, `data/`, `docs/`, `pipeline/` (so `.upstream` resolves), `sources.lock.json` and `.omc/solver`; mutations are applied only to the copied `web/src`. `import.meta.url` stays inside the scratch tree
   (the copied `web/src` is real, not a symlink), so `REPO_ROOT` resolves to the scratch root. The repo is never written: the runner clears `SIM_INVENTORY_WRITE` and `SIM_AUDIT` from the child environment (tests write through
   the `docs/` and `.omc/solver` links when they are set: `moveInventory.test.ts:571-572`, `itemInventory.test.ts:393-394`, `abilityHookInventory.test.ts:261`, `environmentInventory.test.ts:746`,
   `moveEffectAudit.test.ts:94-100`, `abilityAudit.test.ts:82-85`) and spawns vitest with cwd = `<scratch>/web` (`moveEffectAudit.test.ts:94` resolves `../.omc/solver` against `process.cwd()`).
   Type errors from a mutation do not matter (vitest transforms with esbuild).
3. **Only behavioural tests count, and they are found statically.** About 150 of the ~250 test files call `readFileSync`, nearly all to load data JSON (`turn.test.ts:465`, `moveEffects.test.ts:133`, `heldItems.test.ts:32`
   read `data/` files), so reading a file is NOT the criterion. A test file is NON-behavioural iff (i) it imports one of the modules that READ production source: the four loaders `driver/moveInventory`, `driver/itemInventory`, `driver/environmentInventory`,
   `driver/abilityHookInventory`, plus `moveEffectAudit`, `abilityAudit`, `abilities/coverage` or `layering` (NOT `driver/auditAllowlist.ts` or `driver/auditGate.ts`, which are pure data/logic with no fs read: behavioural effect
   tests import `findAllowance` from them, e.g. `cycle127ProtectionEffects.test.ts:10`, `cycle131UncategorisedEffects.test.ts:54`), or (ii) it reads PRODUCTION
   SOURCE: an fs read (`readFileSync`/`readdirSync`) whose path expression resolves under `web/src` or names a `.ts`/`.tsx` file (via `ENGINE_DIR`, `SRC_DIR`, a `web/src` join, or a `.ts` literal). Reads of `data/`,
   `docs/` and `.omc/` do not exclude. The classifier is an AST check with a fixture test that `turn.test.ts` is behavioural and `cycle127ProtectionEffects.test.ts` is behavioural, and `moveInventory.test.ts` is not; its full classification, including every file excluded under rule (i) (e.g. `cycle149bRecoilTypes.test.ts:16` and
   `cycle161TypeSpelling.test.ts:19`, which import `classifyPair` from `abilityHookInventory` and probably also hold behavioural scenarios), is printed with the results and listed in the Step 0 report so the undercount is visible.
   Exclusion is whole-file and therefore conservative: a mixed file (`cycle150bInventory.test.ts`: scenario tests plus text tests) loses its scenario kills, a known undercount of `killed`. The kill criterion
   considers failures from behavioural files only, which removes the circularity (count-pinning tests failing because the classifier's input text changed).
4. **Candidate tests are chosen by coverage of the guarded REGION's lines**, not the token's line. A handler's `KEY: fn` line runs at module load for almost every test, but the handler BODY runs only when invoked,
   so the region is the function body / clause / consequent from decision 1. A file is a candidate if its v8 coverage executes at least one line of the region. No candidate file -> `uncovered`, no run. The coverage map is
   built once per source hash by running each behavioural test file under `@vitest/coverage-v8` (a new dev dependency; Yoshi must approve before it is added) and storing, per file, the executed ranges. If one vitest
   process per file proves too slow, Step 0.2 compares it against a single `--coverage` run with a custom reporter that splits by test file.
5. **Verdict classes** and their mapping to inventory status:

   | Verdict | Meaning | Inventory status |
   |---|---|---|
   | `killed` | a behavioural candidate test fails (an assertion failure or any error thrown inside a test, including a TypeError from the missing handler; a timeout counts, flagged) | `verifiedStatus: ported` |
   | `survived-covered` | region executed by tests, no test noticed | the existing `registeredUntested` (production exists, untested) |
   | `uncovered` | no behavioural test executes the region | `registeredUntested` if the unit has a production site, else `unported` |
   | `invalid-mutant` | the only failures are ReferenceError/SyntaxError at import or module evaluation, or an esbuild error (matches decision 1) | not a kill; reported and re-derived, never `ported` |
   | `allowlisted` | a survivor listed in `driver/mutationAllowlist.ts` with a reason and a C citation (an equivalent mutant) | `verifiedStatus: allowlisted` (matches the existing inventory status of that name) |
   | `no-site` | the unit's token never appears in production source | `unported` (as today) |
   | mixed sites | some of a unit's sites are recognised and some are `negated-site` / `unrecognised-site` | the verdict comes from mutating ALL recognised sites together, flagged `partial-sites` in the result; a unit with NO recognised site is `not-mutable` with the reason `negated-site` or `unrecognised-site` |
   | `not-mutable` | data-driven unit with no region (Natural Gift, Fling, Mega stones, effect-less moves, `declarativeEffects`, `plainHitEffects`, `BATTLE_TYPE_*` flag wiring without a branch) | status unchanged from the text classifier, evidence `text`, with the reason listed |

   Environment tokens that are flag wiring get a small per-unit `mutationSpec` (e.g. force `BATTLE_TYPE_TRAINER` off at `session.ts:269`), cited, instead of an AST site. Equivalent mutants (a region that cannot
   change an observable) go in `driver/mutationAllowlist.ts`, shaped like `driver/auditAllowlist.ts` (unit id, reason, C `file:line` citation), never auto-accepted.
6. **Verdicts are a separate, reported column; the pinned counts stay on the text classifier.** `web/src/engine/sim/driver/mutationResults.json` keys each unit to `{verdict, killedBy[], regionHash, testsDigest, coverageDigest}`:
   `regionHash` covers only that unit's guarded region source, `testsDigest` the contents of the behavioural test files that cover the region, and `coverageDigest` the coverage map plus the behavioural-file set, so a NEW test that
   starts covering an `uncovered` unit, or a classification change, invalidates the entry. Each inventory keeps its current text-derived status and its pinned count (`moveInventory.test.ts:100` `UNPORTED_PAIR_COUNT`, the item,
   ability and environment counts), so a stale or missing verdict can never move a pinned count and `validate.sh:27` is unaffected. Fresh verdicts live ONLY in `mutationResults.json` (a map `unitId -> verdict`, joined to inventory units by id; `verifiedStatus` is NOT added to the inventory unit records, so no existing `toEqual` on a whole unit object
   changes) and in a separate report `docs/battle-sim/mutation-summary.md` (`killed / survived-covered / uncovered / not-mutable / allowlisted / stale` counts and per-unit lists) written only by `npm --prefix web run mutation:check`.
   The generated inventory docs are compared byte for byte by their tests (`moveInventory.test.ts:567-577`, `itemInventory.test.ts:~391-394`, `abilityHookInventory.test.ts:~261`, `environmentInventory.test.ts:~746`), so they contain
   NO verdicts and NO staleness, and no test compares `mutation-summary.md`; a stale verdict therefore cannot fail the suite or `validate.sh`. The summary is also copied into STATE.md; the survivors feed the cycle queue
   ("assert on it", "write a test"). Cost owner: `mutation --changed-only` (re-runs units whose hash changed) is run by the reviewer pass of any cycle that touches a handler region, and a full run precedes each
   docs update of the summary; none of it runs in `validate.sh`. `mutation:check` decides staleness from FRESH hashes: it spawns the same vitest-hosted dump (in the repo's `web/` or a fresh scratch tree, never reusing hashes left from the last mutation run) and compares `regionHash` and `testsDigest`
    cheaply; it does NOT recompute the coverage map (the expensive step), it only compares the behavioural-file set and test digests, and reports `stale` from those (a full coverage refresh is part of `mutation`, not `mutation:check`).
    The dump test is committed under `web/src` and normally skipped, so the suite's skipped count goes from 7 to 8 (nothing pins it; `validate.sh:37` only prints it, so the Step 0.1 baseline is not a regression) and decision 3 rule (i)
    excludes it from candidate sets automatically (it imports the inventory modules). `mutation:check` writes `docs/battle-sim/mutation-summary.md` into the MAIN checkout, so per CLAUDE.md ("keep the main checkout clean while the driver runs") it runs only in the reviewer pass or with the driver stopped, never from a worker. A later, separate decision (not part of D6) may promote `verifiedStatus` to the pinned status once the full run is stable.
7. **Runtime**: the CLI is built like the solver (`solver:build`, `web/dist-solver`): `npm --prefix web run mutation:build` then `node web/dist-mutation/mutationCli.mjs`, using the TypeScript compiler API (already a
   dev dependency) for the AST and spawning `vitest run <files>` in the scratch tree. No tsx/vite-node is introduced. Build plumbing mirrors `vite.solver.config.ts` (an `ssr: true` Node ESM build, so
   `typescript` stays external): a new `vite.mutation.config.ts` added to `tsconfig.node.json`'s `include` so `tsc -b` checks it, and a `web/dist-mutation` entry in `.gitignore` like `dist-solver`. The module is not claimed "pure": it copies trees and spawns processes, so it lives under
   `driver/mutation/` (Node-only, like `solverCli.ts`), outside the `lib/`/`engine/` purity rule.
8. **Scope**: sim dispatch for moves, secondary effects, legacy scripts, held items, ability hooks in the dispatcher files listed at `abilityHookInventory.ts:247-258`, and environment tokens. The damage-calculator
   ability registry (`web/src/engine/abilities/impl/NN-*.ts`) is OUT of scope (covered by `abilities/coverage.test.ts`).

## Steps

### Step 0 - spike (measure, no inventory changes)
0.1 Build the scratch tree (decision 2) by hand and run vitest in it once unchanged: it must reproduce the repo's pass/fail (7037 pass, 7 skipped) with the web `testTimeout` in force. Then run 20 move-effect units (10 `HANDLERS`
    entries, 10 inline branches) through the region operator; record candidate files, verdicts and wall time per unit and any site shape the operator could not handle.
0.2 Measure the coverage pass: the behavioural subset of the 244 files that run (decision 3 decides the subset; record its size) run separately under v8 coverage versus one `--coverage` run with a splitting reporter; record wall time, JSON size, and whether per-file runs differ from
    the full run (shared state). Decide the worker count and where the map is cached (`.omc/`).
0.3 Decision gate (report to Yoshi): measured cost per unit and a projected full-run time for ~900 units; adding `@vitest/coverage-v8`; whether the expected high `survived-covered` rate (14 of 21 in the 151b sample)
    warrants a triage queue.

### Step 1 - harness
1.1 `driver/mutation/`: unit enumeration and region hashing run INSIDE the scratch tree as a vitest-hosted dump: an env-gated, normally skipped test file (like the `SIM_AUDIT` audits) that the CLI spawns with cwd `<scratch>/web`, so `import.meta.url` is
    the copied source and `REPO_ROOT`/`ENGINE_DIR` (`moveInventory.ts:133`, `itemInventory.ts:717`, `abilityHookInventory.ts:243-244`, `environmentInventory.ts:298`) resolve to the scratch root. The CLI does NOT import the inventory
    modules itself: once bundled to `web/dist-mutation/mutationCli.mjs` those module-level constants would resolve five levels up from the bundle (above the repo), as `loadSimData.ts:93`'s `import.meta.dirname` default already
    breaks for the solver (`solverCli.ts:46,62` work around it with `ER_DATA_DIR`/cwd). The dump writes unit ids, sites, regions and hashes to a JSON file the CLI reads, so the unit lists, hashes and mutants all come from the same tree. The region operator (decision 1), scratch-tree builder (decision 2), behavioural-test filter (decision 3), coverage-map reader, verdict classifier,
    `mutationAllowlist.ts`. Tests on fabricated source strings for each site shape and each verdict class, including a handler whose only test is a name mention (`survived-covered`, not `ported`), a negated site
    (`negated-site`), and a mutant that only throws ReferenceError (`invalid-mutant`).
1.2 The CLI and build script with `--kind`, `--unit`, `--changed-only`, `--workers`; it writes `mutationResults.json` with hashes.

### Step 2 - move effects and secondary effects
2.1 Full run over move and secondary effects; triage into killed / survived-covered (queue items "assert on it") / uncovered (queue items "write a test") / not-mutable; record counts in STATE.md.
2.2 Verdicts are joined to move-effect and secondary-effect units by unit id inside `mutation:check` (decision 6); `moveInventory.ts` is NOT edited, and `UNPORTED_PAIR_COUNT` and the other pinned counts are NOT changed.

### Step 3 - items, abilities, environment
3.1 Items: apply the operator over the `C_SITE_SIM_MAP` files; verdicts are joined to item units by id in `mutation:check` (`itemInventory.ts`, its text classifier, whole-engine token-search fallback and pinned count are untouched). Units the
    fallback classifies are listed in the summary with their verdict, which is the evidence for the later promotion decision (152e item 1).
3.2 Abilities: operator over the dispatcher files; verdicts are joined to ability-hook units by id in `mutation:check` (`abilityHookInventory.ts`, the `ABILITY_*`-mention evidence and pinned count are untouched).
3.3 Environment: `mutationSpec` per unit; verdicts are joined to environment units by id in `mutation:check` (`environmentInventory.ts` is not edited).

### Step 4 - report, and defer retirement
4.1 The summary (`killed / survived-covered / uncovered / not-mutable / allowlisted / stale` per inventory) is written to `docs/battle-sim/mutation-summary.md` and STATE.md (NOT to the generated inventory docs), with the survivors turned into queue items. Nothing is deleted or re-pinned in D6.
4.2 Explicitly DEFERRED to a separate decision after a stable full run (so no D6 change can move a pinned count or make behavior depend on a stale artifact): promoting `verifiedStatus` to the pinned status (the pinned
    counts would then move with a per-unit delta); deleting `verifiedMoveEffects.ts` (read by `effectHasTestEvidence`, `moveInventory.ts:2564`, imported by about 25 test files including `cycle112WidePool.test.ts`,
    `cycle114`-`cycle135*Effects.test.ts` and `driver/evalScenarios.test.ts`) and replacing the solver's wide-pool gate in `driver/solver.ts` with a verdict; redefining `ported` as "killed" in the docs.

## Verification
- Harness tests as in step 1.1.
- Planted-defect check, re-plantable: for each of the 151b/152b/153b units, delete the covering test from the scratch copy (they have likely gained tests since) and show the unit is reported `survived-covered` or `uncovered`.
- Repeatability: two runs on the same hashes give identical verdicts (a difference means a flaky test and is reported).
- Circularity check: the set of excluded (source-reading) test files is printed, and a test asserts none of them is ever recorded in a `killedBy` list.
- Repo gates once code lands: `npx tsc -b web`, `npm --prefix web test -- --run`, `npm --prefix web run build`, the two sim audits via `.omc/team-pilot/validate.sh`; validate's runtime is unchanged.

## Risks / open questions
- **Cost** is unmeasured; Step 0 decides feasibility. Fallback: only changed units (hash cache) plus a periodic full run.
- **Site-shape coverage**: the operator handles five shapes; the rest are reported, not guessed. The share of units hit by `unrecognised-site` is a Step 0 output and may force more shapes.
- **Equivalent mutants and dead branches** survive and need cited allowlist entries; they are never auto-classified.
- **Shared-helper mutations** make unrelated behavioural tests red; `killed` then means "some behavioural test fails", the intended definition, and `killedBy` is recorded so a human can sanity-check suspicious kills.
- **New dev dependency** (`@vitest/coverage-v8`) needs Yoshi's approval before Step 0.2.
- **Scope**: D6 ADDS a verified column and a report; it changes no existing status, pinned count, gate or deletion (all deferred, step 4.2). Promotion later moves pinned counts and lands one inventory per change with the delta shown.
- **Attribution of kills**: deleting a `HANDLERS` entry also flips `isHandledMoveEffect` (`moveEffects.ts:11488-11489`), which AI or solver code may call, so a kill can come from changed AI choice rather than the effect
  itself. That fits the "some behavioural test fails" definition, and the `killedBy` triage looks for AI-driven kills.
