# Encounters guard-field semantics

_Settled measurements of the Poryscript map corpus's else styles, and the open defect that encounters.json's `guard` field records the bare string "else" instead of the negated antecedent_

**Settled corpus measurements** (pinned `eliteredux-source` bdebcbb, 515 `data/maps/*/scripts.pory`
files; re-measured independently 2026-09-11, do not re-derive):

- 281 `else` branches total: 74 same-line `} else {`, 207 own-line `}` then `else{`.
- **Zero `else if` in any form anywhere in the corpus.** `_ELSE_IF_RE` in
  `pipeline/src/erdata/encounters.py` is dead against this data (correct, just unexercised).
  Any comment describing the corpus as containing "else/else-if" branches is loose wording.
- All 207 own-line cases carry `{` on the `else` line, so the two-line join is exhaustive.
- 14 other lines contain the word "else": 13 dialogue strings, 1 `#else` preprocessor
  directive (`MossdeepCity_SpaceCenter_1F:253`). None can trigger the join.
- 42 of 621 `if`/`switch` headers span multiple lines (`&&` continuations, plus
  `LavaridgeTown:657` with the brace on the next line). The tracker does not recognise
  these as `if`s, so it pushes an unguarded `None` frame; **the matching `else` then pops
  `None` 45 times corpus-wide**, which is the only path that reaches the `"else"` literal
  fallback in `_scan_file`'s `_ELSE_RE` branch. It is well-formed Poryscript, not a
  malformed line. **None of the 45 encloses a `registerbattleevent` /
  `setvar(VAR_BATTLE_FIELD_*)` / `trainerbattle` call**, so the gap is inert in the
  emitted data only. Re-check if the corpus is repinned.
- All 51 `registerbattleevent` call sites sit behind 0 (7) or exactly 1 (44) non-null
  guard frames, never 2+, so the innermost-guard-only limitation is likewise inert today.
- 38 `else` branches pop a `!`-prefixed sibling and so produce a double negation like
  `!(!defeated(TRAINER_X))`. Faithful transcription; none is emitted today. Do not add a
  simplifier -- guards are raw Poryscript source text throughout, so a consumer needs an
  expression parser anyway and a hand-rolled normaliser has no test oracle.
- 71 of 515 files do not return the tracker's brace depth to zero (unbalanced braces inside
  `.string` text). Pre-existing, identical with and without the join.

**Settled: `else` guards carry the negated antecedent.** `_scan_file`'s `_ELSE_RE` branch
pushes `f"!({popped})"`, so the three affected rows read `!(flag(FLAG_BADGE08_GET))`
(Sootopolis TENSE_BATTLE) and `!(var(VAR_RESULT) == NO)` (the Bug and Ice Monotype Champion
rooms). It used to push the literal string `"else"`, which said a negated branch was taken
but not what it negated, collapsing a fixed story flag and a dialogue yes/no into one opaque
token. Fixed 2026-09-11; do not re-litigate.

**Settled: frame identity replaced the prefix rule, and clique semantics are sound.**
`_Frame(text, group, branch)` with `_frames_compatible` stopping at the first divergence.
The proof that pairwise compatibility implies joint co-occurrence: a group id is minted at
one source line, so every path containing that group shares an identical prefix above it;
two paths therefore diverge at the shallowest index where they differ, and subtrees below a
divergence are disjoint, so no same-group conflict can hide behind an earlier
different-group one. Realizability is then just "each group takes one branch", a pairwise
condition. Verified: 0 violations of the prefix premise over all 331 pairs, 0 pairwise-
compatible-but-unsatisfiable subsets of size 3-4. Do not re-derive.

**Settled: `FLAG_SYS_DISABLE_AUTOHEAL` is a PRE-battle heal skip.** `battle_main.c:844`
(`CB2_HandleStartBattle`, singles) and `pokemon.c:2120` (`GetMonsStateToDoubles`, tag
battles) both read it immediately before `HealPlayerParty()`. `overworld.c:1575`
(`CB2_WhiteOut`) only clears it on a loss. So a chain is heal-free exactly when the flag is
set at every member's call site except the first, since the heal before the first member
precedes the chain. Corpus: 5 files use it, 8 set and 9 clear, the extra clear being a
defensive one at `SootopolisCity_Gym_1F:301`.

**Second heal channel, untracked:** scripts also call `special(HealPlayerParty)` directly.
Present in 5 of the 8 chain scripts, but always before the first member or after the last,
never between two, so all 8 `healFree` values are right today.

**New blind spot the clique rewrite introduced:** compatibility is purely structural and never
reads condition text, so two independent `if`s with contradictory conditions
(`if(flag(A))` then `if(!flag(A))`) are called compatible and can emit a bogus chain.

**Historical, superseded: the `_is_prefix` co-occurrence rule.** `_pair_field_effects` and
`_find_chains` treat two points as reachable together iff one guard path is a prefix of the
other. That is sufficient but NOT necessary: two independent sibling `if (A) {}` / `if (B) {}`
blocks yield paths `("A",)` and `("B",)`, neither a prefix of the other, yet both run when A
and B hold. Demonstrated against the shipped `_find_chains`, which silently drops a real
two-battle chain on that input. The corpus contains **zero** such pairs: over all 331 pairs of
recorded call sites sharing a script (37 scripts have 2+ sites, 31 of those at 2+ distinct
frame stacks), `_is_prefix` agrees with structural mutual exclusivity every time.

**Why it is inert:** measured with a per-frame `(group_id, branch_index)` identity where
`else`/`else if` inherit the group of the frame they replace and `case`/`default` keep the
switch's group. Truth is "exclusive iff the first differing frame shares a group but differs
in branch". Making `_is_prefix` sound needs that frame identity, roughly ten lines.

**Also settled about switch handling:** 48 switches, 199 Poryscript `case`/`default` labels
(21 `default:`), zero nested switches, zero loop constructs. 35 runs of stacked labels sharing
one body (e.g. `PetalburgCity_Gym:1838-1839`, `LittlerootTown:1983-1984`) lose all but the
last label in the relabel, but none of those bodies holds a recorded call. The 1455
`case N, LABEL` lines are legacy raw-assembly jump tables, a different construct, correctly
ignored.

**How to apply:** the remaining known lossiness is the innermost-guard-only limitation above
(which also applies to fieldEffects' *emitted* `guard`, not just battleEvents'), plus the
`_is_prefix` unsoundness. All parked. Treat the negated-antecedent shape as settled.
See [Verifying cited numbers and corpus claims](verify-cited-numbers-and-corpus-claims.md).

## FLAG_SYS_INVERSE_BATTLE census (2026-09-12, corrected 2026-09-13) — one set, seven clears in the map script, one general reset on a LOSS — do not re-derive

Prompted by settling [Plan corrections](battle-sim-plan-corrections.md)'s #8. Grepped the FULL
pinned `eliteredux-source` checkout (not just `data/maps/`) for the literal constant
`FLAG_SYS_INVERSE_BATTLE` (`B_FLAG_INVERSE_BATTLE` is a `#define` alias for it,
`include/constants/battle_config.h:121`) and read every hit. **A first pass of this census
undercounted the map-script clears at five and mischaracterized the general reset as a warp;
both are fixed below, re-verified line by line.**

- **One `setflag`**: `MossdeepCity_Gym/scripts.pory:995`, inside `TateAndLiza`
  (`TRAINER_TATE_AND_LIZA_1`'s own script, :989-1022), immediately after the same block's
  `VAR_BATTLE_FIELD_ID = STATUS_FIELD_TRICK_ROOM` write. Two independent commands, not one
  effect — see the plan-corrections entry for why that distinction matters.
- **Seven `clearflag`s in the map script**, not five:
  - `:1019` — inside `TateAndLiza` ITSELF, immediately after the switch that holds the three
    `trainerbattle_double*` calls closes, at the same (empty) frame depth as the `setflag`
    seven lines earlier. This is the one that closes the bracket the scraper actually tracks
    (`_pair_inverse_battles` sees only this script's own writes) — a census offered as
    justification for that bracketing has to name it, and an earlier version of this census
    didn't.
  - `:53` — inside `TateAndLizaDefeated`, the post-battle callback `trainerbattle_double`/
    `trainerbattle_double_no_intro` name as their own post-battle script argument.
  - `:82` — inside `TateAndLizaDefeatedFirstTime`, reached from `:53`'s own
    `goto_if_unset FLAG_DEFEATED_MOSSDEEP_GYM` only on the literal first-ever win (badge not
    yet given) — NOT "regardless of which variant was fought": on any later encounter (already
    defeated), that `goto_if_unset` is not taken at all, and `:53`'s own script releases at
    `:55-56` instead.
  - `:107`, `:119` — end of the two rematch scripts, `TateAndLizaRematch`/
    `TateAndLizaDoublesRematch` (`TRAINER_TATE_AND_LIZA_3`/`_2`); neither script contains a
    `setflag` for this flag anywhere in its own body.
  - `:127` — `AlreadyRematched`, a menu dead-end reached when the one rematch has already been
    used.
  - `:132` — `Exit`, a generic exit path.
  
  All six of `:53`/`:82`/`:107`/`:119`/`:127`/`:132` sit in DIFFERENT scripts than the one
  `setflag` (`:995`, inside `TateAndLiza`), and `encounters.py`'s pairing groups writes by
  script name before anything else runs (`_pair_inverse_battles`'s own `by_script`, mirroring
  `_pair_field_effects`) — so none of the six ever faces an open activation to close, regardless
  of whether the ROM's own control flow would reach them with the flag still set. This document
  makes no claim about that runtime reachability question (in particular, whether a
  `trainerbattle`'s own post-battle-script argument REPLACES the calling script's continuation
  entirely, which would make `:1019` unreachable at runtime despite being what the scraper keys
  off) — it is not verified here either way, and nothing in `encounters.py`'s own design depends
  on the answer, since the scraper is a line-order text scan, not a control-flow simulator.
- **One general reset, on a LOSS (white-out), not a warp**: `Overworld_ResetStateAfterWhiteOut`
  (`overworld.c:417-437`, `static`) clears `FLAG_SYS_CYCLING_ROAD`/`_CRUISE_MODE`/
  `_SAFARI_MODE`/`_USE_STRENGTH`/`_USE_FLASH` plus `FLAG_SYS_INVERSE_BATTLE` — six flags, not
  five. It is called from exactly one place, `overworld.c:380`, inside `DoWhiteOut()`
  (`overworld.c:371-383`), itself called from `CB2_WhiteOut` (`overworld.c:1568-1593`, the
  player-loses-and-blacks-out state machine) — the same trigger `FLAG_SYS_DISABLE_AUTOHEAL`'s
  own clear already uses (`CB2_WhiteOut:1575`, a separate call site in the same function, not
  routed through `Overworld_ResetStateAfterWhiteOut`). Confirmed this is loss-specific, not a
  generic warp reset, by reading its two siblings: `Overworld_ResetStateAfterTeleport`
  (`:396-405`, used by Teleport) and `Overworld_ResetStateAfterFly` (`:385-393`, used by Fly)
  both clear only the first five flags; `Overworld_ResetStateAfterDigEscRope` (`:407-415`, used
  by Dig and Escape Rope) clears the identical five and DELIBERATELY omits
  `FLAG_SYS_INVERSE_BATTLE` while clearing its five neighbours. So the flag survives every
  ordinary warp (Fly, Teleport, Dig, Escape Rope) and is cleared only by a loss — the same
  persistence channel as `FLAG_SYS_DISABLE_AUTOHEAL`, not a warp-time reset. Modelling this
  backwards (as warp-scoped) would understate how long an inverse battle's effects persist if
  anything ever reads this flag outside of `TryToSetFieldEffect` itself.
- **Zero occurrences anywhere else** in `data/maps/` (515 files) or `src/`. This mechanic is
  used exactly once in the entire game.

This is scraper-relevant because `encounters.py`'s `fieldEffects`/`battleEvents` extraction had
no concept of this flag at all before this batch — it tracks `VAR_BATTLE_FIELD_*` writes and
`registerbattleevent` calls, not arbitrary `setflag`/`clearflag` pairs. The fix
(`_pair_inverse_battles`) is modeled on `_pair_field_effects`'s own reset-tracking and
frame-compatible-trainer-aggregation, NOT on `FLAG_SYS_DISABLE_AUTOHEAL`'s own pattern:
that flag is tracked as a running boolean during the line scan (`_scan_file`'s own
`heal_disabled`) and consumed by `_find_chains` to compute `healFree` --
`_pair_field_effects` itself receives the same per-call `heal_disabled` value on
`trainer_calls` and explicitly discards it (`_heal_disabled` in its own loop variable name);
it does not bracket anything.
