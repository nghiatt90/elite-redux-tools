# `gCurrentTurnActionNumber` during the battle-start sequence

**Status: verified facts, open decision.** This note records what the variable is, every write
and read found at the pinned SHA, and the two candidate readings of its value while
`TryDoEventsBeforeFirstTurn` drains a queued entry move. The simulator currently implements the
first reading (0). Which reading is correct is a decision for the user; this note does not make
that decision and code was not changed on its account.

## The variable

`EWRAM_DATA u8 gCurrentTurnActionNumber = 0;` — `src/battle_main.c:176`. Like the rest of EWRAM it
is zero at power-on, and nothing in `battle_main.c` re-initializes it per battle; the only writes
are the ones below. (The sim has no power-on/battle-count state, so "the first battle since
power-on" is not representable — see *What the sim does*.)

Writes, all at the pinned SHA:

| site | value | context |
|------|-------|---------|
| `battle_main.c:176` | `0` | static initializer (power-on / soft reset) |
| `battle_main.c:3413` | `gBattlersCount` | end of `TryDoEventsBeforeFirstTurn`, immediately before `HandleFaintedMonActions()` |
| `battle_main.c:4637` | `0` | `CheckQuickClaw_CustapBerryActivation`, the "setup stuff before turns/actions" block, i.e. when turn 1's action loop is about to start |
| `battle_script_commands.c:12996` | `gBattlersCount` | `Cmd_finishturn` |
| `battle_util.c:566,577,604,711` | `gBattlersCount` | run / flee paths (`TryRunFromBattle`, `HandleAction_Run`, `HandleAction_SafariZoneRun`) |
| `battle_util.c:838` | `++` | `HandleAction_NothingIsFainted` |
| `battle_util.c:850` | `++` | `HandleAction_ActionFinished` |

Reads that matter for the battle-start question:

- `battle_util.c:3122` — `HandleFaintedMonActions`, state 3: "Don't switch mons until all pokemon
  performed their actions" is `gCurrentTurnActionNumber != gBattlersCount`. This is why
  `battle_main.c:3413` assigns `gBattlersCount`: the replacement attempt that follows sees
  "everyone acted".
- `battle_util.c:765` — `HandleAction_ActionFinished` calls `HandleFaintedMonActions()` after
  `TryPerformExtraAction` returns false; the same state-3 gate applies to mid-turn faints.
- `abilities.cc:2140` — Analytic: `GetBattlerTurnOrderNum(target) < gCurrentTurnActionNumber`
  multiplies damage by 1.3 when the *defender* already acted this turn.
- `abilities.cc:1620` (Stall), `:5150`, `:8769`, `:9910` — other turn-position checks.
- `battle_script_commands.c:9165`, `:12054`, `:12065` — last-battler checks
  (`gCurrentTurnActionNumber == gBattlersCount - 1`).

## The battle-start window

`TryDoEventsBeforeFirstTurn` (`battle_main.c:3303-3440`) starts by dispatching a pending action
(`:3314-3316`), then, before running *any* of its own body, drains a queued extra attack:

```c
} else if (gQueuedAttackCount) {        // :3320
    gCurrentActionFuncId = B_ACTION_TRY_FINISH;
    return;
}
```

The queued entry move therefore runs through `HandleAction_TryFinish` / `TryPerformExtraAction`
(`battle_util.c:751-783`), which pops `gQueuedExtraAttackData`; that struct carries its own
`attacker` and `target`, so the attack does not select a battler via
`gCurrentTurnActionNumber`. The variable is still read by the attack's damage calculation
(Analytic at `abilities.cc:2140`) and by the faint gates (`battle_util.c:3122`).

The lead loop (`:3359-3382`) builds the turn order with `RecalculateMoveOrder(..., TRUE)`
(`:3361`) and runs `HandleSwitchInAbility`, which is where most entry moves are queued
(`UseEntryMove`, `battle_util.c:3994-4019`). After the loop: `ClearMiscTurnFlags` (`:3383`),
`canProcessSwitches = TRUE` and a queued-switch re-entry (`:3392-3397`), then
`TurnValuesCleanUp(FALSE)` (`:3406`), the Coward restore (`:3407-3411`), `TurnStructsClear`
(`:3412`), `gCurrentTurnActionNumber = gBattlersCount` (`:3413`) and
`HandleFaintedMonActions()` (`:3414`). `HandleFaintedMonActions` returning true does **not**
change `gBattleMainFunc`, so the C re-enters `TryDoEventsBeforeFirstTurn`; on that re-entry the
replacement's queued entry move is drained at `:3320-3322` with `gCurrentTurnActionNumber`
already equal to `gBattlersCount` from `:3413`.

So there are two distinct moments:

1. **The first pass**, draining the leads' queued entry moves: the value is whatever was in
   EWRAM when `TryDoEventsBeforeFirstTurn` was entered — it is not written in between.
2. **A replacement re-entry**, after `:3413`: the value is `gBattlersCount` under any reading.

## The two candidate models

**Model A — 0, "first battle since power-on".** `battle_main.c:176` initializes the byte to 0, and
no code writes it before the first pass of the first battle after power-on (nor before the first
pass of any battle if the game was reset in between). Under A every lead's battle-start entry move
runs with `gCurrentTurnActionNumber == 0`, so nothing has acted: Analytic's
`GetBattlerTurnOrderNum(target) < 0` is false and the 1.3x never applies.

**Model B — `gBattlersCount`, steady state.** A battle after the first starts with the previous
battle's last value. Every normal end-of-turn path leaves the variable at `gBattlersCount`:
`HandleAction_ActionFinished` increments past the last slot (`battle_util.c:850-852`),
`Cmd_finishturn` sets it directly (`battle_script_commands.c:12996`), and the run / flee paths do
the same (`battle_util.c:566,577,604,711`). Under B the first pass of every later battle — and the
replacement re-entry under both models — drains entry moves with
`gCurrentTurnActionNumber == gBattlersCount`, so **every** target's turn-order number is smaller
than it: Analytic's condition is true for every defender and a battle-start entry move by an
Analytic holder gets the 1.3x.

The difference is observable only through those readers, chiefly Analytic: `GetBattlerTurnOrderNum`
was filled for the current order by `RecalculateMoveOrder(..., TRUE)` at `battle_main.c:3361`, so
on the first pass both the target's slot (0..`gBattlersCount-1`) and the drain value are real
numbers.

## What the sim does

`createSession` drains battle-start entry attacks with turn-order index 0:

```ts
drainQueuedExtraAttacks(state, 0, startOrder, turnDeps, startOutcomes)
```

and so do the replacement re-entries (the same `0` in `drainAttacksAndReact`). That is **Model A,
always** — including the replacement re-entry, where C is `gBattlersCount` under both models. The
sim models `GetBattlerTurnOrderNum(target) < gCurrentTurnActionNumber` as
`targetIndex >= 0 && targetIndex < turnOrderIndex` (`moveEffects.ts:399`), which feeds
`attackerActsFirst: !context.targetHasActedThisTurn` (`damageResolver.ts:142`) and thus
`ABILITY_ANALYTIC`'s `if (!ctx.attackerActsFirst) MUL(ctx, 1.3)` (`engine/abilities/impl/09-hub-abilities.ts:44-48`).

Two tests pin Model A today:

- `cycle148fFixes.test.ts:558` — "assuming gCurrentTurnActionNumber is 0 (first battle since
  power-on), the slower lead's entry move does not read the faster lead as having acted
  (Analytic)"; it asserts 41 HP, i.e. no 1.3x.
- `cycle148fFixes.test.ts:555` — the drained outcome's `turnOrderIndex` is 0, not the lead's
  loop index.

Model B is **not modelled**. Choosing B would mean passing `state.battlersCount` as the drain
index for the first pass (and for the replacement re-entry, where C already uses it). Choosing B
only for "battles after the first since power-on" would additionally require a battle counter that
the sim does not have; today there is no way to distinguish the first battle after power-on from
the hundredth. The choice is left to the user; no behaviour was changed for this note.
