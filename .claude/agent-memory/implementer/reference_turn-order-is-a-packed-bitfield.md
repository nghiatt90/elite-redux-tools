---
name: turn-order-is-a-packed-bitfield
description: ER turn order is one packed u32 comparison (union SpeedValue), not priority-then-speed; After You and dazed outrank priority, Trick Room is a u16 complement, and the order is resolved lazily per action
metadata:
  type: reference
---

ER does **not** compare priority and then speed. `GetMoveSpeed`
(`battle_main.c:4297-4327`) packs six fields into one u32 (`union SpeedValue`,
`include/battle_main.h:29-40`) and every comparison is a plain unsigned `>` on it.
Precedence is therefore fixed by bit position, most significant first:

| bits | field | source |
|---|---|---|
| 26 | `afterYou` | `gRoundStructs[b].afterYou` |
| 24-25 | `dazedNegation` | `~(volatiles.dazed + round.waterlog)` |
| 20-23 | `priority` | `7 + GetMovePriority`, clamped 0..15 |
| 18-19 | `goesFirst` | `round.quickDraw + round.usedCustapBerry` |
| 16-17 | `goesLastNegation` | `~(laggingTail + myceliumMight + drenched)` |
| 0-15 | `effectiveSpeed` | `GetBattlerTotalSpeedStat`, truncated to u16 |

The header comment says "Compiler lays this out in reverse order" — GBA little-endian
bitfields allocate from the LSB, so the first-declared `effectiveSpeed` is the low half.

Consequences that a "priority then speed" model gets wrong:

- **After You outranks priority outright**, and so does **being dazed or waterlogged**
  (through a negated field, so more dazed sorts lower).
- **Trick Room is `~effectiveSpeed` within the u16** (`:4325`), not a reversed
  comparison and not a negation: 65535 − speed. It cannot override priority because it
  only touches the low 16 bits.
- **Speed wraps at 65536.** `GetBattlerTotalSpeedStat` returns u32 into a u16 field.
- **`dazed` is a 3-bit counter written into a 2-bit field**, so dazed==4 complements back
  to 3 and sorts as if undazed. A real defect; reproduce it.
- **Quash gates the high fields off** (`afterYou`/`dazedNegation` stay 0) and forces
  `GetMovePriority` to `min(-4, priority)` (`:4262`) and the speed calc to
  `TOTAL_SPEED_QUASH`, which skips abilities, Tailwind, Swamp, Steamroller and stat
  stages but keeps item effects.

**`SetActionsAndBattlersTurnOrder` never speed-sorts.** Its two grouping loops
(`:4458-4475`) cover every battler and set every bit of `except`, so
`SortBattlersExcept` at `:4476` filters them all out, writes nothing and returns 0; the
follow-up loop at `:4477` starts at `gBattlersCount` and does not run. The real ordering
is **lazy**: `RecalculateMoveOrder(gCurrentTurnActionNumber)` runs after every action
(`battle_util.c:839, :851`) and pulls the fastest remaining battler into the next slot,
so speeds are re-read mid-turn. Its guard at `:4553` returns early unless the slot's
action is `USE_MOVE`, which is what preserves the "switches and items first, in battler
id order" grouping.

Other traps:

- `GetMoveSpeed` reads priority from **`GetMoveToBeUsed`** (`:4308`, honours Encore and
  multi-turn/recharge locks, `battle_util.c:152-160`) but Mycelium Might and the
  speed-stat move argument from **`GetChosenMove`** (`:4319`, `:4324`, which does not).
  Under Encore those are different moves.
- `GetBattlerTotalSpeedStat` applies **extra stat levels BEFORE stat stages**
  (`:4226-4236`) — the reverse of `CalculateStat`'s tail. Do not reuse `applyStatTail`.
- Paralysis divides by **2**, not 4: `B_PARALYSIS_SPEED` is `GEN_7`
  (`include/constants/battle_config.h:21`).
- Violent Rush / Rapid Response / Showdown Mode are three **sequential** `*150/100`
  steps, each truncating (`:4178-4182`), not one combined multiplier.
- Swamp is `speed /= 1.5` on a u32 — promotes to double and truncates back (`:4208`).
- Razor Wind checks **both** sides' Tailwind (`:4282`), not the user's own.
- On The Prowl tests the move's **declared** priority in both branches (`:4284-4289`),
  not the running total.
- `FILTER(x)` is `if (!(x)) continue;` and `FILTER_NOT(x)` is `if (x) continue;`
  (`include/global.h:59-62`) — needed to read any of these loops.

**Ability hooks are a separate problem, and the note this originally pointed at was lost** —
the agent hit a usage limit between writing this file and writing that one. What is
recoverable without redoing the work: the ability registry under `web/src/engine/abilities/`
holds only the abilities `abilityHooks.json` marks damage-relevant, so priority-affecting
abilities are not in it at all. `docs/battle-sim/boss-fight-coverage.md` counts 8 with an
`onPriority` hook among the abilities these fights field and the registry does not carry.
Modelling them needs somewhere new for that hook to live, and that is its own batch. The
detail of what shape that should take is gone; re-derive it rather than guessing.

See also [[battle-state-c-struct-facts]].
