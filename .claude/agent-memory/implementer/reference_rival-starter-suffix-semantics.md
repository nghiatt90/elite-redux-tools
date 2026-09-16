---
name: rival-starter-suffix-semantics
description: TRAINER_MAY_*_TREECKO/TORCHIC/MUDKIP names the PLAYER's starter for opponent entries but MAY's own starter for the Meteor Falls partner entries -- verify against the party, never the label
metadata:
  type: reference
---

Measured 2026-09-16 against `data/v2.65beta/trainers.json` and the pinned map corpus.

Every rival battle dispatches on `switch VAR_STARTER_MON` with `case 0/1/2` ->
`...Treecko/Torchic/Mudkip` (e.g. `Route103:78-81`), so **case 0 = the player picked
Treecko**, and the suffix on the id reached from that case is `_TREECKO`.

**For OPPONENT ids the suffix is the player's starter and May fields the counter-starter:**

| id suffix | May's starter line | means the player chose |
|---|---|---|
| `_TREECKO` | Torchic (Combusken/Blaziken) | Treecko |
| `_TORCHIC` | Mudkip (Marshtomp/Swampert) | Torchic |
| `_MUDKIP`  | Treecko (Grovyle/Sceptile)   | Mudkip |

Verified on `TRAINER_MAY_ROUTE_103_*` (2-mon parties: `_TREECKO` = TORCHIC+GOOMY,
`_TORCHIC` = MUDKIP+GOOMY, `_MUDKIP` = TREECKO+GOOMY) and consistent across
RUSTBORO / ROUTE_110 / ROUTE_119 / LILYCOVE.

**The Meteor Falls PARTNER entries invert it.** `MAY_TREECKO_METEOR_FALLS` (reached from
the same `case 0`, `MeteorFalls_1F_1R:193`) has SCEPTILE, and `MAY_TORCHIC_METEOR_FALLS`
has BLAZIKEN -- i.e. the ally May carries the player's OWN starter line, not the
counter. Upstream inconsistency, not a misreading; do not generalise one rule to both.

**How to apply:** "the rival had the Mudkip line" and "I picked Treecko" are NOT the same
statement and cannot both be true of the same save. Resolve from the party contents, and
say which reading you used. There are also **five** distinct story May ids, not four
(ROUTE_103, RUSTBORO, ROUTE_110, ROUTE_119, LILYCOVE); LILYCOVE's id is reused by the
Route 103 daily rematch (`Route103:142`).

See [[map-script-battle-macros-and-engine-introspection]].
