---
name: calculatestat-line-map-and-speed-blend
description: Settled line map for CalculateStat in battle_util.c at the pinned SHA, the STAT_SPEED same-stat blend branch, and the live stage-scaling divergence in the general cross-stat blend
metadata:
  type: project
---

**Settled line map, `pipeline/.upstream/eliteredux-source/src/battle_util.c` at the pinned
SHA** (read directly 2026-09-12, do not re-derive; the blend range had been cited four
different ways):

- `CalculateStat` spans **7105-7217**. Wonder Room `statEnum` swap: **7111-7116**.
- Stat-stage selection (unaware / Wonder Room / crit direction): **7180-7187**.
- Same-stat self-buff ratio branch, excluding speed: **7192-7194**.
- Cross-stat blend loop: **7196-7200**, `FILTER(i != statEnum)` at **7197**, the recursive
  `CalculateStat(...)*pct/100` at **7199**.
- **STAT_SPEED same-stat branch: 7202-7207.** Stage-scales the primary, adds the recursive
  speed value times the percent, and `return`s at **7206** -- skipping the tail's second
  stage scaling (7210-7211) and its `extraStatLevel` block (**7212-7214**; 7216 is the
  ordinary return). So a Speed-primary + Speed-blend calculation genuinely loses
  `extraStatLevel` on its primary term, and adding a Speed blend can LOWER the stat. That
  paradox is faithful to the source, not a port bug.

**Settled and FIXED 2026-09-12: the blend must be summed before the primary's stage
ratio.** The C adds each blend term at 7199 to the *unscaled* `statBase`, then applies the
primary's ratio (7210-7211) and extra levels (7212-7214) to the combined sum.
`applySecondaryStatBlend` used to scale the primary and each term independently and sum the
results, so the primary's stat stage never reached the blended contribution. Resolved by
splitting `calculateBattleStatPreStage` out of `calculateBattleStat`, which stays as the
composition of the two halves.

**Settled reference numbers** (Garchomp + Juggernaut, Tackle, vs Skarmory, top roll;
verified against the C by hand and by injecting the stat directly, do not re-derive). Raw
Atk 296, raw Def 226, blend term `floor(226*20/100) = 45`, pre-stage sum 341:

| attack stage | attack stat, wrong order | attack stat, C order | roll wrong | roll C |
|---|---|---|---|---|
| neutral | 341 | 341 | 19 | 19 |
| +6 (ratio 40/10) | 1229 | 1364 | 66 | **74** |

The stat-level delta quadruples exactly, 45 to 180. The damage deltas are 2 and 10, a ratio
of 5 rather than 4, purely because each roll is floored independently and 2 is a coarse
rounding of ~2.6 -- not because anything downstream treats the blend term specially. An
earlier review said "about 72" by scaling the already-rounded delta of 2 by four; that is
the wrong way to extrapolate a floored quantity.

**Census discipline: key species by `id`, never by `name`.** Forms share a display name, so
a name-keyed census silently merges them. The Speed-primary plus Speed-blend pairing is 6
species by id: `SPECIES_ELECTRODE_HISUIAN`, `SPECIES_SKARMORY_MEGA_REDUX`,
`SPECIES_ZIGZAGOON`, `SPECIES_ZEBSTRIKA`, `SPECIES_WATTREL`, `SPECIES_KILOWATTREL`. Base
`SPECIES_SKARMORY` and base Electrode carry neither ability; an earlier review said
"Skarmory" and "Electrode" because it grouped on name. The defensive pairing
(Blur/Elude + Sleek Scales) is code-reachable but **data-unreachable**: only Garchomp has
Sleek Scales, and it has neither Blur nor Elude.

**How to apply:** when porting a `FILTER`/`continue` out of a C loop, find every branch the
same condition guards elsewhere in the function before calling the skip faithful. When an
author cites a census, re-run it keyed by id. See
[[verify-cited-numbers-and-corpus-claims]].
