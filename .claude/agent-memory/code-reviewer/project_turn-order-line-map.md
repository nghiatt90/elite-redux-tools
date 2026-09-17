---
name: turn-order-line-map
description: Settled line map for ER's turn-order path in battle_main.c plus the verified packed-bitfield layout and field widths — do not re-derive.
metadata:
  type: project
---

Verified at the pinned SHA, 2026-09-16. Every citation below was checked line by line.

| function | lines |
|---|---|
| `SwapTurnOrder` | `battle_main.c:4160-4165` |
| `GetSpeedFromAbilities` | `:4167-4189` (ability loop `:4170-4176`, three sequential `*150/100` `:4178-4182`, paralysis `/2` `:4185-4186`) |
| `GetBattlerTotalSpeedStat` | `:4191-4239` (Tailwind/champ `:4203-4206`, Swamp `:4208`, Steamroller `:4212`, items `:4216-4224`, extra levels `:4226-4228`, Bleed cap + stages `:4230-4236`) |
| `GetChosenMove` | `:4241-4248` |
| `GetChosenMovePriority` | `:4251-4255` |
| `GetMovePriority` | `:4257-4292` (Quash `:4262`, `ON_ABILITY onPriority` `:4264`) |
| `MYCELIUM_MIGHT_AFFECTED` | `:4294-4295` |
| `GetMoveSpeed` | `:4297-4327` |
| `GetFastestBattler` | `:4329-4347` |
| `SortBattlersExcept` | `:4349-4384` |
| `GetWhoStrikesFirst` | `:4386-4398` |
| `SetActionsAndBattlersTurnOrder` | `:4400-4482` (rolls `:4404-4414`, omitted Safari/link/run `:4416-4455`, grouping loops `:4458-4475`, dead sort `:4476`, dead follow-up `:4477-4479`) |
| `RecalculateMoveOrder` | `:4551-4566` (the `USE_MOVE` guard is `:4553`) |
| `IsTrickRoomActive` | `battle_util.c:8671-8678` |

Call sites of `RecalculateMoveOrder`: `battle_main.c:3361` (switch-in abilities,
`ignoreChosenMove = TRUE`), `battle_main.c:4546` (`TryChangeTurnOrder`, once per turn),
`battle_util.c:839` and `:851` (after every action). All four are correct as cited.

`union SpeedValue` (`include/battle_main.h:29-40`) and the widths it truncates against
(`include/battle.h`): `afterYou:1` (`:201`), `waterlog:1` (`:205`), `quickDraw:1` (`:198`),
`usedCustapBerry:1` (`:194`), `VolatileStruct.dazed:3` (`:156`), `drenched:2` (`:161`).
The 3-bit `dazed` into the union's 2-bit `dazedNegation` is the real ROM defect: `dazed==4`
complements back to 3, the same as undazed.

`GET_BATTLER_SIDE` (`battle.h:20`) and `GET_BATTLER_SIDE2` (`:21`) differ only in reaching
the position through `GetBattlerPosition()` vs `GET_BATTLER_POSITION`/`gBattlerPositions[]`;
in singles and doubles both reduce to `battlerId & 1`.

**Why:** the batch under review cited all of these and every one held up, so re-deriving
them costs a round trip for nothing.

**How to apply:** trust these when reviewing `web/src/engine/sim/turnOrder.ts` and whatever
turn loop lands on top. See [[turn-order-accessor-direction]] for the one thing the batch
got wrong.
