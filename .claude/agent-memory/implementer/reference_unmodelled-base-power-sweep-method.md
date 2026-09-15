---
name: unmodelled-base-power-sweep-method
description: The power<=1 proxy for finding damaging moves web/src/engine can't compute was DISPROVED 2026-09-15 by Squall Hammer; read the battle scripts directly, and ask a precise question when counting
metadata:
  type: reference
---

**Corrected 2026-09-15. The original version of this note recommended a method
that is now disproved -- do not reuse it.**

The original idea: filter `data/v2.65beta/moves.json` to `split !== 'STATUS'` and
`power <= 1`, on the theory that ER's placeholder convention for a move whose real
damage bypasses the ordinary formula is a declared power of 0 or 1. That found
`EFFECT_METAL_BURST`/`EFFECT_PLACEHOLDER`/`EFFECT_FETCH` correctly, but a
follow-up review disproved the premise: **`MOVE_SQUALL_HAMMER` is PHYSICAL, power
95 -- an entirely ordinary-looking value -- and still deals zero real damage.**
It shares `EFFECT_DEFOG` with the status move `MOVE_DEFOG`; `BattleScript_EffectDefog`
(`battle_scripts_1.s:1560-1592`) has no damage step on any path (an evasion drop
and a hazard clear only), so Squall Hammer inherits that status-only script
wholesale despite its own normal-looking declared power. **A damaging move sharing
an effect with a STATUS move can have completely ordinary power and still be a
real gap.** The power proxy cannot detect this class at all.

**The battle scripts are directly readable.** `battle_scripts_1.s`/`_2.s` are
under `pipeline/.upstream/eliteredux-source/data/`. An earlier version of this
note (and of comments in `web/src/engine/basePower.ts`) wrongly said this
bytecode was out of the pipeline's reach / inaccessible. It never was; nobody had
opened the files.

**The correct method:** read the legacy-config battle script for each candidate
effect directly (follow every label, `goto` and `call`) rather than inferring
from declared power or move-text descriptions.

**A count answers ONE precise predicate -- state which one, or two correct
counts will look like they disagree.** A 2026-09-15 review reported "thirteen"
legacy-config effects (of 126 used by a damaging move) whose script never
reaches a damage step. A follow-up re-traced the same 126 and got "five", and
first (wrongly) wrote that off as the thirteen being unreliable secondhand
relay. It wasn't unreliable -- the two counts answer different questions, and
both are correct for their own:
- **Thirteen** = never reaches the ORDINARY `damagecalc` opcode specifically.
  Of these, nine deal real damage through their OWN special calculator
  instead (`counterdamagecalculator`, `mirrorcoatdamagecalculator`,
  `metalburstdamagecalculator`, `calculatesetdamage`,
  `setdamagetohealthdifference`/`dmgtocurrattackerhp`) -- Bide, Counter,
  Mirror Coat, Endeavor, Final Gambit, Level Damage, Super Fang, Super Fang
  Haze, Metal Burst. Three deal no damage at all -- Defog (only damaging
  user: Squall Hammer), Fetch, Placeholder. One is not a gap -- Future Sight.
  9 + 3 + 1 = 13.
- **Five** = never reaches ANY damage-applying opcode, special calculators
  included (a 15-opcode list: `damagecalc`, `adjustdamage`,
  `calculatesetdamage`, `counterdamagecalculator`,
  `mirrorcoatdamagecalculator`, `metalburstdamagecalculator`,
  `setdamagetohealthdifference`, `dmgtocurrattackerhp`, `dmgtomaxattackerhp`,
  `hpfractiontodamage`, `presentdamagecalculation`,
  `magnitudedamagecalculation`, `stockpiletobasedamage`, `painsplitdmgcalc`,
  `manipulatedamage`) -- Bide, Defog, Fetch, Future Sight, Placeholder.

The five and the nine-effect "special calculator" group from the thirteen
disagree by exactly Bide and Future Sight, and that disagreement is itself the
useful fact, not an error: both deal real damage through a SEPARATE, delayed
script the game's own future-attack scheduling triggers
(`setbide`/`trysetfutureattack`), not through anything reachable via a direct
trace from their own starting label. **Future Sight's delayed script DOES use
the ordinary formula** -- `BattleScript_MonTookFutureAttack`
(`battle_scripts_1.s:8008-8017`) reaches `damagecalc`/`adjustdamage` when the
hit actually lands -- so it is NOT a gap; this engine's existing (never
specially-flagged) computation for it is already correct, only the timing
differs (irrelevant to a turn-one snapshot calculator). **Bide's is not** --
still genuinely unported, correctly in the "not modelled" set.

**Seismic Toss is in neither count.** Its own script branch
(`battle_scripts_1.s:5822-5827`) DOES reach a damage step
(`calculatesetdamage` for its real level-based fixed damage, then
`adjustdamage`) -- the script isn't silent, the ordinary ATK/DEF formula just
can't reproduce that fixed value, which is why it needs
`UNMODELLED_BASE_POWER_MOVE_IDS` (move-id-keyed, since it shares
`EFFECT_SKY_DROP` with the correctly-computed `MOVE_SKY_DROP`) rather than an
effect-keyed entry.

**Two distinct outcomes when a script has no damage step, not one:**
- Real damage is a genuine, computable-in-principle NONZERO number this engine
  cannot produce (Counter/Mirror Coat/Bide/Metal Burst/Super Fang/etc.) --
  `UNMODELLED_BASE_POWER_EFFECTS`/`_MOVE_IDS` in `basePower.ts`, message
  `"${x}: not modelled"`.
- Real damage is a script-confirmed KNOWN ZERO (`MOVE_AIRBORNE_SLAM`,
  `MOVE_FETCH`, `MOVE_SQUALL_HAMMER`) -- `ZERO_DAMAGE_BASE_POWER_EFFECTS`/
  `_MOVE_IDS` in `basePower.ts`, message `"${x}: its battle script deals no
  damage in this build"`. "Not modelled" would be a FALSE claim for these:
  nothing is uncomputed, the formula just doesn't know the real answer is 0.

Kept warning-only in both cases -- the small nonzero number this formula's power
floor (`Math.max(power, 1)`) still prints for the known-zero class is a real,
separate, reviewed decision to change, not something to fold into a warning-only
batch.

**`lib/matchupReport.ts` now imports `ZERO_DAMAGE_BASE_POWER_EFFECTS`/
`_MOVE_IDS` from `basePower.ts` directly**, rather than keeping a third copy --
duplicated sets (its own `TRUE_DAMAGE_UNAVAILABLE_EFFECTS`/`_MOVE_IDS`,
separate from `basePower.ts`'s equivalents) are exactly how `EFFECT_METAL_BURST`
landed in `basePower.ts` first and only reached the report in a follow-up once
a reviewer caught the two surfaces disagreeing (a bare, unexplained dash on the
report page while the calculator had already started warning). The zero-damage
sets were imported specifically to avoid repeating that mistake for Squall
Hammer/Fetch/Placeholder.
