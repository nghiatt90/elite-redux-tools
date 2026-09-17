---
name: side-effect-registries-fail-silently-headless
description: A registry populated by side-effect import contributes nothing to a headless caller — no error, no failing test, a whole subsystem silently inert; make the consuming module import it rather than relying on a route
metadata:
  type: reference
---

`web/src/engine/abilities/` is populated by evaluating `impl/index.ts` for its side
effects. Until 2026-09-17 the only things that did so were two React routes,
`DamageCalculator.tsx` and `TrainerMatchup.tsx`, each with its own
`import '../engine/abilities/impl/index'`.

**The failure mode is an entire subsystem contributing nothing, with no error and no
failing test.** `lookupAbility` returns `undefined`, `forEachAbility` skips every slot,
every hook contributes its neutral value, and the result is a plausible number that is
simply wrong. Nothing throws. Nothing logs.

This is invisible exactly where this project is heading: the team-build solver is a local,
headless tool that will never load a page. `web/src/lib/matchupReport.ts` is already
headless by design and sits behind the damage dispatch — it worked in the app solely
because its route happened to import the registry first.

**Rule: the module whose correctness depends on the registry imports it.** Both
`dispatchCalc.ts` (damage) and `dispatchPriority.ts` (turn order) now carry
`import './impl/index'`. The routes keep theirs — harmless, and they document the
dependency at the point of use.

**No cycle, and check this before copying the pattern elsewhere:** no file under `impl/`
imports `dispatchCalc` or `dispatch`, so the import is one-directional. Verify that again
if an impl batch ever starts reusing a dispatcher helper — `44-priority.ts` nearly did,
for `isIronFistBoosted`, and instead takes it precomputed on the context.

**How it was found:** writing the first test for a new dispatcher outside React. The test
failed, which is the only reason anyone looked; the identical defect had been live in the
damage path for far longer with every test green.

**What it had been hiding, which is the part worth remembering.** Fixing it turned
`features/matchupReport/composition.test.ts` red. That test asserted Dragon Claw was
immune against a Rock/Fairy Carbink, with a comment calling it "a sanity check that the
composed pipeline reaches the real type chart, not a stub" — and it passed *because* the
ability layer was a stub. The attacker is Garchomp, whose slot-0 ability is
`ABILITY_OVERWHELM`, whose entire hook is "Dragon move, Fairy defending type, modifier
currently 0 -> 1.0x". With abilities live the immunity is correctly gone.

Note the precise scope: the shipped app was right, because its route imported the
registry. The TESTS were wrong — they exercised a no-abilities damage path that the app
never ran. A test suite that green-lights behaviour the product does not have is the real
cost here, not a user-visible bug.

**Generalisation:** any lazily-populated global — registry, plugin table, codec map — that
is filled by import side effect has this shape. Ask who guarantees the fill, and whether
that guarantee survives the code being called from a script instead of a page.

See [[ability-registry-holds-non-damage-hooks]], [[seams-need-neutral-defaults]].
