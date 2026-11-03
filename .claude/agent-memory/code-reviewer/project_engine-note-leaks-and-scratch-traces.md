---
name: engine-note-leaks-and-scratch-traces
description: calculateMoveDamage's "X: not modelled" notes leak through non-damage consumers (typeEffectiveness, AI estimates); how to trace an audit note without touching the tree
metadata:
  type: project
---

A note that calculate.ts raises (e.g. `MOVE_SEISMIC_TOSS: not modelled`, calculate.ts ~1107) reaches the sim
audit through EVERY caller of calculateMoveDamage, not just the damage step. Filtering it in turn.ts's
isFixedDamage block (the hit turn) left it alive in c03d410 via: DamageResolver.typeEffectiveness
(damageResolver.ts, called by the Sky Drop/Seismic Toss charge-turn typecalc at turn.ts ~2925), and
aiCalcDamage / aiGetTypeEffectiveness (aiCalcDamage.ts), which only filter the effect-keyed twin.

**Why:** a worker "cleared" the note with a test that only asserted the hit-turn action; the audit still
showed it. Workers' tests check the path they edited, not the path the audit exercises.

**How to apply:** when a cycle claims an audit note is cleared, list every calculateMoveDamage caller
(`grep -rn "calculateMoveDamage(" web/src/engine/sim`) and check each one filters it. To trace empirically
without modifying the checkout, write a test in the scratchpad that imports web/src by absolute path and run
`web/node_modules/.bin/vitest run --globals --silent=false --reporter=verbose --root <repo>/web --dir <scratch>`
(no `vitest` import needed with --globals; loadSimData resolves data via import.meta.dirname).

Related C trap from the same review: BattleScript_BerryConfuseHealRet (battle_scripts_1.s:10986-11003) acts on
BS_TARGET / gBattlerTarget, and the ITEMEFFECT_MOVE_END loop (battle_util.c:5874-6033) never rebinds it, so an
attacker eating its berry there confuses (and removes the item of) the move's TARGET in the C. Only
VARIOUS_CONSUME_BERRY (battle_script_commands.c:8032-8033) points it at the eater. See [[derived-authority-is-not-authority]].
