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
