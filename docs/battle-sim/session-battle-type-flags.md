# `battleTypeFlags: BATTLE_TYPE_TRAINER` in `createSession`

**Status: settled C facts + coverage note.** `createSession` passes
`battleTypeFlags: BATTLE_TYPE_TRAINER` to `createBattleState` (`web/src/engine/sim/driver/session.ts:238`,
added by commit `2b8c8b9`, re-committed as `cc38834`). This note records what that bit enables in
C, which of those paths the sim implements, and how little of it is pinned by tests.

## What the C bit does

`BATTLE_TYPE_TRAINER` is one of the two bits that gate forced switches:

```c
u32 CanBattlerBeForceSwitched(u8 battler) {          // src/abilities.cc:2608-2615
    CHECK(IsBattlerAlive(battler))
    CHECK(CanBattlerSwitch(battler))
    CHECK(gBattleTypeFlags & BATTLE_TYPE_TRAINER)    // :2611
    CHECK_NOT(gBattleTypeFlags & BATTLE_TYPE_ARENA)  // :2612
    CHECK(CountUsablePartyMons(battler))
    return TRUE;
}
```

Callers:

- **Wimp Out / Emergency Exit** — `Impl<ABILITY_WIMP_OUT>.onDefender`, `abilities.cc:2618-2642`:
  the half-HP check, `CHECK_NOT(TestSheerForceFlag(...))`, `CHECK(CanBattlerBeForceSwitched(battler))`
  (`:2622`), then `TryScheduleSwitch` with `BattleScript_EmergencyExit` (trainer battle or player
  side) or `BattleScript_EmergencyExitWild` (`:2626-2630`). `ABILITY_EMERGENCY_EXIT` aliases this
  hook (`:2645-2647`).
- **Restraining Order** — `Impl<ABILITY_RESTRAINING_ORDER>.onDefender`, `abilities.cc:8579-8597`:
  `CHECK(CanBattlerBeForceSwitched(attacker))` at `:8583`, then schedules
  `BattleScript_RestrainingOrderActivates` with `setAbilityState = TRUE`.
- **Red Card does *not* read the bit.** Its hold effect is scheduled in `ITEMEFFECT_TARGET`
  (`battle_util.c:6126-6141`) with no trainer test, and `BattleScript_RedCardActivates`
  (`data/battle_scripts_1.s:11320-11335`) checks only Rooted, Suction Cups and Commander before
  `forcerandomswitch`. There is also no arena test in that script — the arena exclusion for
  Wimp Out / Emergency Exit comes from `CanBattlerBeForceSwitched`, not from the script (the
  `EmergencyExit` script itself has no forced-switch blocks; see `turn.ts`'s drain comment).

The same `CanBattlerBeForceSwitched` shape is open-coded in the sim:

| gate | sim |
|------|-----|
| Wimp Out / Emergency Exit | `moveEnd.ts:3249-3267` (alive, `CanBattlerSwitch`, `BATTLE_TYPE_TRAINER`, not `ARENA`, `countUsablePartyMons`) |
| Restraining Order | `moveEnd.ts:3019-3036` (same five checks) |
| Red Card | not modelled: target hold effects are pushed as unmodelled at `moveEnd.ts:7317-7319`; the generic `RED_CARD` drain path (`state.ts:861-862`, used when a queued switch has no `script`) exists, but no current scheduler creates a script-less entry |

Chuckster (`moveEnd.ts:2996`) and Hollow Ice Zone (`moveEnd.ts:4983`) schedule switches without
the trainer gate, matching their C hooks (neither calls `CanBattlerBeForceSwitched`).

## Effect on every turn

`createSession` sets the bit once and never changes it, so for the whole session
`state.battleTypeFlags` contains `BATTLE_TYPE_TRAINER` and not `BATTLE_TYPE_ARENA`. The sim's
`canProcessSwitches` (the `battle_util.c:785` gate) is ported as always true (`turn.ts:4403-4411`),
and `drainQueuedSwitches` runs at every turn transition (`turn.ts:4737, 4777, 4795, 4864, 4879,
4898, 4929`) as well as during battle start (`session.ts:279` and the replacement re-entry at
`:341`). Consequently Emergency Exit / Wimp Out / Restraining Order can force a switch on **any**
turn of a sim session, not just during the battle-start sequence.

Red Card's `SWITCH_ITEM` path is not implemented, so the trainer bit does not "turn on Red Card
switches" in the sim today: only the `RED_CARD` script default is present, and nothing schedules
it. (The `BATTLE_TYPE_ARENA` skip at `turn.ts:4471-4480` is therefore also unreachable from
`createSession`; it is exercised only by tests that set the arena bit on a hand-built state.)

## Test coverage

- No test asserts `createSession(...).state.battleTypeFlags`. `create.test.ts:319-323` pins
  `createBattleState`'s default of 0, which is a different function.
- The only `createSession`-based tests that depend on the bit are the Emergency Exit battle-start
  test (`cycle148fFixes.test.ts:419`, "queued battle-start switches drain before the cleanup") and
  the incoming-mon Emergency Exit scenario in `cycle148gFixes.test.ts` (Item 4(c) describe). Remove
  the flag and both lose the switch.
- `cycle145Abilities.test.ts:488/:529` and `cycle145bAbilities.test.ts:223/:323` set
  `BATTLE_TYPE_TRAINER` themselves on their own `holderBattle` states, so they pin the Wimp Out
  gate but not `createSession`'s flag.

## Cited-line drift

Earlier comments cited `moveEnd.ts:2980` and `:3210` for Red Card / Restraining Order. Those lines
now fall inside Drakelp Head and Menacing Situation respectively; the current anchors are
Restraining Order `moveEnd.ts:3019-3036`, Wimp Out / Emergency Exit `:3249-3267`, and Red Card's
unmodelled note `:7317-7319`. The `session.ts` comment was corrected in this cycle. Red Card never
read the trainer bit, so the old "Red Card reads it too" wording was also wrong on the C side.
