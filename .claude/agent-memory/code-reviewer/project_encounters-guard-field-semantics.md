---
name: encounters-guard-field-semantics
description: Settled measurements of the Poryscript map corpus's else styles, and the open defect that encounters.json's `guard` field records the bare string "else" instead of the negated antecedent
metadata:
  type: project
---

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
See [[verify-cited-numbers-and-corpus-claims]].

**Settled: `FLAG_SYS_INVERSE_BATTLE` census (re-measured independently 2026-09-13, do not
re-derive).** The constant appears in exactly 5 files of the pinned checkout
(`MossdeepCity_Gym/scripts.pory`, `battle_config.h`, `flags.h`, `battle_util.c`,
`overworld.c`); no raw `2937` use anywhere.

- **One `setflag`**, `MossdeepCity_Gym/scripts.pory:995`, unconditional inside
  `script MossdeepCity_Gym_EventScript_TateAndLiza` (`:989-1027`), after the Trick Room
  writes at `:993-994` and before the `switch` at `:998`. Three `trainerbattle_double*`
  calls at `:1009`, `:1012`, `:1015`, all `TRAINER_TATE_AND_LIZA_1`, differing only in
  dialogue. So fight 1 is Trick Room **and** inverse; fights 2/3 are Trick Room only.
- **Seven `clearflag`s in that file**, not five: `:53` (`TateAndLizaDefeated`), `:82`
  (`TateAndLizaDefeatedFirstTime`, gated by `goto_if_unset FLAG_DEFEATED_MOSSDEEP_GYM`
  at `:54`, so first win only), `:107` / `:119` (the two rematch scripts, defensive),
  `:127` (`AlreadyRematched`), `:132` (`Exit`), and `:1019` — the bracket-closing clear
  inside `TateAndLiza` itself, which is the one the scraper actually depends on.
- `overworld.c:425` is inside **`Overworld_ResetStateAfterWhiteOut`** (`:417`), i.e. a
  loss-only reset, the same channel as `FLAG_SYS_DISABLE_AUTOHEAL`'s. The sibling
  `Overworld_ResetStateAfterDigEscRope` (`:407-414`) deliberately does **not** clear it,
  so the flag survives warps. Describing it as a warp/new-game reset is wrong.
- `battle_util.c:8028` **toggles** rather than sets: `inverted = !inverted`, XORing with
  `IsInverseRoomActive()` and each Miracle Eye. Inverse Room + inverse battle cancel.
- `TRAINER_TATE_AND_LIZA_1` is reachable only pre-game-clear: `:990`
  `goto_if_set(FLAG_SYS_GAME_CLEAR, ...Rematch)` diverts first. The guard tracker models
  no `goto_if_*`, so that condition is invisible to any emitted `guard` field.
- The 6 `starttagbattle` calls in this file (`:728-895`) are all outside the bracket.

**Convention for a bracket-to-trainers row:** `_pair_field_effects` (`encounters.py:853-899`)
already emits `{map, script, guard, trainers: sorted-set}` and dedupes via
`_frames_compatible`, and its row for this very script carries `guard: null` with a
one-element `trainers`. A new list that emits singular `trainer` with no `guard` and a
bespoke `seen_inverse` set is re-solving a solved problem in an inconsistent shape.
