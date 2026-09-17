---
name: ability-registry-holds-non-damage-hooks
description: The ability registry can hold non-damage hooks without weakening its coverage gate, because the gate's population comes from abilityHooks.json's damageRelevant flag, not from registry membership
metadata:
  type: reference
---

`web/src/engine/abilities/` was built for damage hooks, but a non-damage hook (the first
was `onPriority`, batch AS) belongs in the SAME registry, not a parallel one.

**The coverage gate is not weakened by this, and does not need loosening.** The reason is
structural, and four facts establish it:

1. `coverage.test.ts` derives its population from `abilityHooks.json`'s `damageRelevant`
   flag. It never enumerates the registry, so registry membership is not an input to any
   of its assertions.
2. None of the new entries is `damageRelevant`, so none joins that population.
3. Of the 19 priority abilities exactly 3 are `damageRelevant`; the only one touched
   (Perfectionist) already had a real, non-stub entry, so the stub count cannot move.
4. None of the new entries was previously a stub, so nothing left the population either.

**Do not cite the gate's number as evidence here.** It reads the same whether or not the
design is sound, because its population comes from committed hook data that a registry
change does not touch. That is a check which cannot come out differently — the same
defect worth catching in tests, and easy to commit in one's own reasoning.

**Why not a parallel registry.** Some abilities declare both kinds of hook — of the 19
with `onPriority`, three (Flame Bubble, Iron Barrage, Perfectionist) are also
damage-relevant and already had entries. `registerAbilities` throws on a duplicate id
specifically so one batch owns one ability; a second registry would put those three in
both and make that guarantee meaningless. `forEachAbility` (dispatch.ts) also already
implements `ON_ABILITY`'s reverse-slot iteration, which any second registry would have to
duplicate.

**Give the new hook its own gate** rather than widening the damage one — otherwise the
damage gate's number moves for reasons unrelated to damage. See
`priorityCoverage.test.ts`: it asserts the census size, that ported + remaining accounts
for every census member, and a ported count that may only go UP.

**The registry is populated by side-effect import, and only routes do it.**
`DamageCalculator.tsx` and `TrainerMatchup.tsx` carry `import
'../engine/abilities/impl/index'`. A headless consumer (the sim, a solver) has no route,
so without its own import every hook silently contributes zero — a wrong number with
nothing to notice it through. `dispatchPriority.ts` therefore imports `impl/index`
itself. Check this whenever engine code is consumed outside React.

**Hook-body traps found while porting** (read the scraped source, never the name):
- `CHECK(x)` is `if (!(x)) return __EnumHack();` (`include/type_utils.hh:63`); for an
  int-returning lambda that is 0.
- Temporal Rupture returns `-gBattleMoves[MOVE_ROAR_OF_TIME].priority` — it CANCELS Roar
  of Time's -6, landing it at 0. The name suggests a boost; it is a penalty removal.
- Sighting System returns **-3**: an onPriority hook can be a penalty.
- Perfectionist uses `power <= 25` for `onPriority` and `power <= 50` for `onCrit` —
  two thresholds on one ability. Its registry entry also cited `abilities.cc:3806`, which
  is a different ability's tail; the real entry is `:3833`.
- `BATTLER_MAX_HP` (`include/battle.h:749`) is `hp == maxHP` exactly, so the Gale Wings
  family dies to one point of chip damage.
- Opportunist's `maxHP / 2` is integer division — compare with `Math.trunc`, not a float
  ratio.

**onPriority is not the only route to turn order.** `ABILITY_QUICK_DRAW` is checked by
name at `battle_main.c:4407` and sets `gRoundStructs[].quickDraw`, which packs into
`goesFirst` (bits 18-19) — a HIGHER field than priority. It has no hook lambda and is
absent from `abilityHooks.json` entirely, so scanning hooks can never find it. Measured:
carried only by Slowbro-Galarian forms, fielded only by `TRAINER_TATE_AND_LIZA_1`'s ACE
party, so out of scope while the solver is Elite-only.

See [[turn-order-is-a-packed-bitfield]], [[seams-need-neutral-defaults]].
