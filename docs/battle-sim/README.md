# Battle simulator research notes

Verified findings behind the battle simulator and team-build solver plan, produced by
the `plan-reviewer` agent and checked against the pinned upstream checkouts under
`pipeline/.upstream/` rather than against memory of vanilla Pokemon. Every claim is
cited by file and line at the SHAs in `sources.lock.json`; re-verify against the new
SHAs after a repin.

These settle the three open items the plan raised.

- [AI score-function state dependencies](er-ai-score-function-state-deps.md) — Verified — what battle state the ER AI score functions actually read, and why a damaging-moves-only turn loop cannot be driven against a real trainer party
- [Descriptive report viability](er-descriptive-report-viability.md) — Verified — worst-case survival thresholding is exact, not a heuristic, because the ER AI's own damage estimate is the max roll; plus the real state of Wonder/Inverse Room in the engine
- [Party level is not symmetric](er-level-asymmetries.md) — Verified — party level is NOT symmetric between player and AI in Elite Redux; innate gating, level caps and EV dilution all penalise the player at low level
- [Stat and damage formulas](er-stat-and-damage-formulas.md) — Verified — ER's CALC_STAT and core damage equations at the pinned SHA, with the worked derivation of why 252 EVs are worth less damage at low level
- [Plan corrections](battle-sim-plan-corrections.md) — Running list of claims in the battle-simulator plan that were checked against the pinned source — which held, which did not

## Review findings

Produced by the `code-reviewer` agent while repairing the trainer and encounter data
and the damage engine. Measurements marked settled were verified against the pinned
checkout and should not be re-derived; re-check them after a repin.

- [CalculateStat line map and the blend defects](calculatestat-line-map-and-speed-blend.md) — Settled line map for CalculateStat in battle_util.c at the pinned SHA, the STAT_SPEED same-stat blend branch, and the live stage-scaling divergence in the general cross-stat blend
- [Encounters guard-field semantics](encounters-guard-field-semantics.md) — Settled measurements of the Poryscript map corpus's else styles, and the open defect that encounters.json's `guard` field records the bare string "else" instead of the negated antecedent
- [Textproto versus codegen divergence](textproto-vs-codegen-divergence.md) — When reviewing pipeline emitters, check whether the Kotlin codegen drops or transforms the field before it reaches the ROM -- textproto truth is not always game truth; includes the settled trainer-ability resolution chain
- [Verifying cited numbers and corpus claims](verify-cited-numbers-and-corpus-claims.md) — Re-measure every count and every "held for every case in the corpus" claim an author writes in a comment; several have been wrong in this repo

- [Elite Redux data breaks React list keys](er-data-breaks-react-list-keys.md) — Measured -- ER trainer parties repeat species and movesets repeat move ids, so species id, move id and speciesId+level are all unsafe React keys
- [What the React layer's checks do and do not catch](react-layer-review-gates.md) — Run oxlint by hand on every React-layer review -- build and vitest cannot catch rules-of-hooks or any render-time defect in this repo
- [Verifying npm and shell behaviour on Windows](windows-npm-and-shell-verification.md) — Measured -- npm runs package.json scripts through cmd.exe on this machine, and plain `npm` fails in Windows PowerShell; use npm.cmd to verify a build
- [Trick Room, forced doubles and Double Battle Mode](trick-room-and-forced-double-facts.md) — Settled C facts for matchup-report field effects: Trick Room never touches damage, forced doubles are always doubles, Double Battle Mode doubles everyone; plus measured counts (78/74)

## Scope measurements

Sizing a planned section against real data rather than against an assumption. Re-measure
after a repin — every count here moves with the pinned SHAs and the engine's own coverage.

- [Boss-fight coverage: the 40 Elite-difficulty fights](boss-fight-coverage.md) — Measured — the solver's fixed opponent set is 55 trainer ids fielding 228 species / 402 moves / 361 abilities / 102 items; the damage engine covers nearly all of it, so Section D's real content is turn-loop work, doubles, and Mega Evolution (24.6% of the mons)
