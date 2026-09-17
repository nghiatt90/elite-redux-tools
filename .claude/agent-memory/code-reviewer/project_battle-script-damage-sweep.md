---
name: battle-script-damage-sweep
description: Battle-script bytecode IS in the pinned checkout; measured which damaging moves' scripts have no ordinary damage step (Squall Hammer deals no damage; Fetch/Airborne Slam too) -- declared power is not a valid proxy
metadata:
  type: project
---

`pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s` and `_2.s` are present (verified 2026-09-15).
Script selection: `tools/codegen/src/er/move/MoveScriptGenerator.kt:28-35` -- `legacyConfig` names the script
directly; declarative `attack` configs route to `BattleScript_EffectHit` / `EffectArgumentHit` / a generated
script that calls `BattleScript_EffectHitUntilArgumentReturn` (all reach `damagecalc`). So only `legacyConfig`
effects can hide a nonstandard damage path.

**Measured sweep (data/v2.65beta, 755 damaging moves, 192 effects, 126 legacyConfig):** following label/goto/call
edges from each legacy script (stopping at shared tails like BattleScript_MoveEnd/HitFromAtkAnimation), 13
effects reach no `damagecalc`: PLACEHOLDER, BIDE, METAL_BURST, COUNTER, MIRROR_COAT, FUTURE_SIGHT, ENDEAVOR,
FETCH, FINAL_GAMBIT, SUPER_FANG, SUPER_FANG_HAZE, LEVEL_DAMAGE, DEFOG. Breakdown (settled 2026-09-15 after I
misstated it once as "10 old + 3 new"): 8 of the 10 old UNMODELLED effects (PSYWAVE/DRAGON_RAGE have no move),
3 new (METAL_BURST, FETCH, PLACEHOLDER), FUTURE_SIGHT (not a gap), DEFOG (Squall Hammer). Seismic Toss is NOT in
the 13: SKY_DROP's script reaches damagecalc and branches by move id. FUTURE_SIGHT is fine (ordinary
`damagecalc` at landing, `BattleScript_MonTookFutureAttack` :8008-8017). Special calc commands inside
damagecalc scripts: `calculatesetdamage` (SKY_DROP -> Seismic Toss only, :5822-5827), `magnitudedamagecalculation`,
Beat Up. Everything else with normal power only adds secondary commands.

**Counterexample to "normal power => script only adds a secondary":** MOVE_SQUALL_HAMMER (PHYSICAL, power 95,
EFFECT_DEFOG) runs `BattleScript_EffectDefog` (:1560-1592), a pure status script -- no damage at the pinned SHA.
Engine prints 32-38 with no warning. Fetch (:5316-5343) and Airborne Slam/EFFECT_PLACEHOLDER (:2847-2853,
"not done yet") also deal no damage, so "not modelled" is the wrong label for them.

**Invariance check method:** a temp vitest that runs every move, clears the two exported unmodelled Sets, reruns,
and diffs results minus `unmodelled`. 1031 moves, 0 number diffs. Delete the temp file afterwards.

See [[trick-room-and-forced-double-facts]].
