# Stat and damage formulas

_Verified — ER's CALC_STAT and core damage equations at the pinned SHA, with the worked derivation of why 252 EVs are worth less damage at low level_

Verified 2026-09-11 at the pinned SHA. This is the derivation behind the EV-dilution numbers
in [Party level is not symmetric](er-level-asymmetries.md), which were previously asserted without a source.

## Stat formula

`CALC_STAT`, `src/pokemon.c:954-961` (non-HP stats):

```c
s32 n = (((2 * baseStat + iv + ev / 4) * level) / 100) + 5;
n = ModifyStatByNature(nature, n, statIndex);
```

HP, `src/pokemon.c:1002-1003`: `((2*baseHP + hpIV + hpEV/4) * level) / 100 + level + 10`.

IVs are forced to 31 for both sides at `pokemon.c:989-990` unless Hell mode with
`HELL_MODE_0_IVS_FLAG`; `speedDown` zeroes the Speed IV alone (994).

**EVs are gated twice, and the second gate applies to both sides.** `battle_main.c:1857` only
writes the trainer's config EV spread when `difficultySetting > DIFFICULTY_EASY`, but
`pokemon.c:996-997` then zeroes all six EVs whenever `!gSaveBlock2Ptr->enableEvs` — and that
branch has **no `isEnemyMon` exemption**, unlike the IV branch above it.
`CalculateEnemyTrainerMonStats` (`battle_main.c:1882`) runs it on the AI's party. So with EVs
disabled in the save, neither side has EVs and the plan's ~6.1e9 EV search dimension collapses
to a single point.

## Damage formula

`DoMoveDamageCalcInternal`, `src/battle_util.c:7707-7711`, all integer truncation:

```c
dmg = ((level * 2) / 5) + 2;
dmg *= gBattleMovePower;
dmg *= CalcAttackStat(...);
dmg /= CalcDefenseStat(...);
dmg = (dmg / 50) + 2;
```

then `CalcFinalDmg` (7714) for STAB/type/screens, then the Monotype Champion switch
(7717-7760), then the 85-100% roll at 7791-7795 — applied only when `randomFactor` is true,
which the AI's own `AI_CalcDamage` sets to FALSE.

## Worked EV dilution

Base attack 130 vs base defence 130, 100 BP, IV 31, neutral nature, neutral type, no other
modifiers. (`SPECIES_GARCHOMP` atk 130 and `SPECIES_METAGROSS` def 130 in
`data/v2.65beta/species.json`, so the numbers below are ER's, not vanilla's.)

| level | atk 0 EV | atk 252 EV | def | dmg 0 EV | dmg 252 EV | damage gain |
|---|---|---|---|---|---|---|
| 100 | 296 | 359 | 296 | 86 | 103 | +19.8% |
| 50 | 150 | 182 | 150 | 46 | 55 | +19.6% |
| 30 | 92 | 111 | 92 | 30 | 35 | +16.7% |
| 20 | 63 | 75 | 63 | 22 | 25 | +13.6% |

**These reproduce the four figures in [Party level is not symmetric](er-level-asymmetries.md) exactly.** That note's
conclusion stands.

Its stated *mechanism* needs correcting, though. It blames "the `+5` in CALC_STAT and the
trailing `+2` in the damage formula" jointly. Decomposing:

| level | stat ratio 252/0 | damage ratio | damage ratio excluding the trailing +2 |
|---|---|---|---|
| 100 | 1.2128 | 1.1977 | 1.2024 |
| 50 | 1.2133 | 1.1957 | 1.2045 |
| 30 | 1.2065 | 1.1667 | 1.1786 |
| 20 | 1.1905 | 1.1364 | 1.1500 |

The `+5` costs only 2.2 points of ratio between L100 and L20 (1.2128 -> 1.1905), because it
appears in both numerator and denominator of `atk/def` and largely cancels. The damage ratio
falls 6.1 points over the same span. So **most of the dilution comes from the damage
formula's trailing `+2` and from truncation at the `/def` and `/50` steps**, not from the
stat formula. The constant `+2` is 2.3% of damage at L100 and 9.1% at L20.

Nature is a multiplier applied after the `+5` (`pokemon.c:959`), so unlike EVs it does not
dilute with level.
