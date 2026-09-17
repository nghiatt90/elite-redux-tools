---
name: registry-population-footgun
description: The ability registry is populated by side-effect import; this was a real silent-failure hazard until d9bd93b (2026-09-17), which closed it in BOTH dispatchers. Re-verify against the current tree before ever raising it again.
metadata:
  type: project
---

`web/src/engine/abilities/registry.ts` is populated only by side-effect import of
`./impl/index`. An unpopulated registry does not error — every ability flag reads false,
so Levitate mons become grounded and every damage hook contributes nothing.

**This hazard is CLOSED as of `d9bd93b` (2026-09-17).** Both `dispatchCalc.ts` (line 26)
and `dispatchPriority.ts` now import `./impl/index` themselves, so anything reaching the
registry through either dispatcher is safe regardless of who called it. `registry.ts`
cannot self-populate — `impl/index.ts` imports `registerAbilities` from it, so that
direction is a cycle; importing from the dispatchers is the available fix and it is
acyclic (no production `impl/*.ts` imports `../dispatch*`).

Historic instances, both fixed: `lib/matchupReport.ts` (headless, previously worked only
because its route did the import) and the damage path generally. The fix also exposed
`features/matchupReport/composition.test.ts` as having passed *because* the ability layer
was a stub.

**Why this memory still exists:** I raised this a second time against `sim/grounding.ts`
after the fix had already landed, by reusing a `grep` result from the previous review
round instead of re-running it. A defect pattern that recently proved true is the easiest
thing to over-apply.

**How to apply:** do NOT raise this from memory. If a new `engine/` module reaches
`lookupAbility`/`forEachAbility`, `grep -rn "impl/index" web/src/` **in the current tree**
first — the answer changed on 2026-09-17 and may change again. What does still transfer is
the test question: is there at least one test exercising an ability-dependent branch? If
not, a wrong answer there is unobservable either way, and that is worth saying without any
claim about imports. Related: [[seams-need-neutral-defaults]],
[[verify-cited-numbers-and-corpus-claims]].
