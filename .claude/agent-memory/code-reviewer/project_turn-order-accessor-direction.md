---
name: turn-order-accessor-direction
description: Settled — GetMoveSpeed takes priority AND speed from GetChosenMove; GetMoveToBeUsed feeds only GetFullChosenTarget. The implementer's note, the commit message and turnOrder.ts all had it backwards.
metadata:
  type: project
---

`GetMoveSpeed` (`battle_main.c:4297-4327`) reads the move through two accessors, and the
direction is the opposite of what the first port assumed:

```c
MoveEnum move = GetMoveToBeUsed(battler);                        // :4308
priority += GetChosenMovePriority(battler, GetFullChosenTarget(battler, move));  // :4309
```

`GetChosenMovePriority` (`:4251-4255`) calls `GetChosenMove(battlerId)` itself. So
**`GetMoveToBeUsed`'s only job in this function is to pick the target**; priority (`:4309`),
Mycelium Might (`:4319`) and the speed-stat move argument (`:4324`) all come from
`GetChosenMove`.

The divergence between the two is also mostly *not* Encore. Encore writes
`gChosenMoveByBattler` at selection time (`battle_main.c:3690`), so the two agree.
They diverge on `STATUS2_MULTIPLETURNS` / `STATUS2_RECHARGE` (`GetMoveToBeUsed` returns
`gLockedMoves[battler]`, `battle_util.c:152-160`), on `gProcessingExtraAttacks`
(`GetChosenMove` returns the queued extra attack, `:4242`), and on an Encore applied
mid-turn after selection.

**Why:** `web/src/engine/sim/turnOrder.ts`, its test at `turnOrder.test.ts:479-489`, the
commit message of `9e611bc` and
`.claude/agent-memory/implementer/reference_turn-order-is-a-packed-bitfield.md` all state
the inverse and the code acts on it. Because `useMove()` in the test sets both fields to
the same object, the whole suite passed anyway — a test that restates the implementation.

**How to apply:** when reviewing anything that reads a move for turn order, check that it
uses `chosenMove`, not `moveToBeUsed`. Treat a wrapper function named after one accessor
as no evidence of which accessor it calls; open it. See
[[verify-cited-numbers-and-corpus-claims]].
