---
name: isgrounded-is-a-baseline-not-an-answer
description: BattlerBattleState.isGrounded is the SPECIES-ONLY baseline, not the grounding answer — calculate.ts re-applies Levitate/Air Balloon/Iron Ball/Gravity on top, so feeding it a full IsBattlerGrounded result double-applies and breaks the Mold Breaker case.
metadata:
  type: project
---

`BattlerBattleState.isGrounded` (`web/src/engine/types.ts:191-197`) is documented as the
**species-only baseline**: `!species.types.includes('TYPE_FLYING')`, which is exactly how
`features/damageCalc/scenario.ts:257` builds it. `calculate.ts:720-723` then folds in the
rest itself:

```ts
const isForcedGrounded = defender.condition.resolvedHoldEffect === 'HOLD_EFFECT_IRON_BALL' || field.gravityActive
const isForcedAirborne = !isForcedGrounded && (… AIR_BALLOON || hasFlag(defender.abilitySlots, 'levitate', attackerHasMoldBreaker))
const isGrounded = isForcedGrounded || (defender.isGrounded && !isForcedAirborne)
```

So the field name is a trap: it is not "is this battler grounded". Passing a full
`IsBattlerGrounded` result into it double-applies Levitate, Air Balloon, Iron Ball and
Gravity. Most of that is idempotent, but **Mold Breaker vs Levitate inverts**: the supplier
returns `false` (Levitate applied with its own mold-breaker flag), `calculate.ts` computes
`isForcedAirborne = false` (mold breaker suppresses Levitate), and `false && !false` leaves
the defender airborne when the correct answer is grounded — a Ground move reads as immune.

**Why:** two independent sources for one fact, and the calculator's is the authoritative
one. `sim/grounding.ts` exists for the sim's own consumers (turn order's Swamp gate), where
the full answer IS wanted.

**The general pattern, of which this is one instance.** A field whose NAME describes the
final answer but whose CONTRACT is an input to it, with a second source downstream that
completes it. The two sources agree everywhere except the case where the downstream one
has information the upstream one lacks — here, the attacker's Mold Breaker. Everything
looks right in testing because the disagreeing case is narrow, and the supplier's version
is the more "complete" one, so supplying it feels like an improvement.

Smell: a supplier computing something richer than the consumer asked for. Check what the
consumer does with it before deciding the richer answer is better.

**How to apply:** when reviewing anything that populates a `DamageCalcScenario`, check each
field against its doc comment in `engine/types.ts` rather than against its name —
`isGrounded`, `semiInvulnerable` (defender-only) and `abilityOn` are all narrower than they
sound, and `wasDamagedThisTurnBy` is role-relative to the pending calculation rather than
absolute. See [[seams-need-neutral-defaults]].
