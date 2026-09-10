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
