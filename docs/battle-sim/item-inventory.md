# Held-Item Completeness Inventory

Static inventory of every held-item unit for `data/v2.65beta/items.json` against the battle simulator and damage engine.

- **Source Commit (eliteredux-source)**: `bdebcbbff9760cdd41a02c425bea4857fa0eee26` (game version `v2.65beta`)
- **Source Commit (er-config)**: `1b8e2cc4a8096d7ec90616f87fbf771bfa732447`
- **Regeneration Command**: `SIM_INVENTORY_WRITE=1 npm --prefix web test -- --run src/engine/sim/driver/itemInventory.test.ts`

## Unit Kinds and Classification Rules

A unit is **ported** only when its token appears in production source in the mapped function/file that ports that C site
and in an engine test file outside `sim/ai/` (and `sim/driver/`). Production evidence excludes `sim/ai/` for non-AI units.
Comments and note-only gap blocks (`SWITCH_IN_HOLD_EFFECTS`, `ITEMS_1_2_HOLD_EFFECTS`, `TARGET_ITEM_EFFECTS`, etc.)
are stripped before scanning. Skipped tests (`it.skip`, `describe.skip`, `test.skip`, `it.todo`) and test title strings
are removed so names alone do not count as test evidence. Tests that reference any item id carrying the effect also qualify.
`registered, untested` means production handles the unit but no qualifying test names it; it is counted as unported.
Sites without an explicit mapping fall back to any non-AI production file and are flagged in the doc as `site-unmapped`.
Preprocessor `#ifdef` blocks for enum symbols (compiled out) are skipped. Allowlisted units require an exact pinned C `file:line`.

1. **hold-trigger**: one unit per (resolved hold effect, C trigger site) in `battle_util.c`,
   `battle_script_commands.c`, `battle_main.c`, `pokemon.c` and `abilities.cc`. The site is the enclosing
   `ITEMEFFECT_*` case inside `ItemBattleEffects` (with numeric `case 1:` mapped to `ENDTURN_ITEMS1/2`),
   top-level `constexpr Ability Impl<ABILITY_X> =` declaration in `abilities.cc`, or the nearest enclosing function/macro elsewhere.
   The token is the `HOLD_EFFECT_*` name. Several hits of one effect in one site collapse to one unit.
2. **ai-trigger**: the same rule for `battle_ai_util.c` and `battle_ai_main.c`; production evidence must come
   from a source file under `web/src/engine/sim/ai/`.
3. **item-data**: one unit per item whose hold effect has no hold-trigger unit. The token is the item id.
4. **natural-gift**: one unit per berry with a `naturalGift` block, citing the `gNaturalGiftTable` read sites.
   The token is the item id.
5. **fling**: one unit per item read by `VARIOUS_TRY_FLING` (no `gFlingTable` definition is on disk). The token
   is the item id.

Berry trigger conditions are represented by their `hold-trigger` units; this inventory does not create a second
unit kind for them.

## Summary

| Unit kind | Defined | Ported | Registered, untested | Unported | Unclassified | Allowlisted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `hold-trigger` | 216 | 93 | 20 | 123 | 0 | 0 |
| `ai-trigger` | 57 | 17 | 0 | 40 | 0 | 0 |
| `item-data` | 43 | 0 | 0 | 43 | 0 | 0 |
| `natural-gift` | 47 | 9 | 6 | 38 | 0 | 0 |
| `fling` | 8 | 7 | 1 | 1 | 0 | 0 |
| **total** | **371** | **126** | **27** | **245** | **0** | **0** |

Items in `data/v2.65beta/items.json`: 929; distinct non-`HOLD_EFFECT_NONE` resolved hold effects: 133.

## Known Partial Ports

Units whose production handling diverges from the pinned C in ways confirmed by manual audit.
They are kept out of the ported count (status `unported` with a partial reason).

| Unit key | What differs | C citation |
| --- | --- | --- |
| `HOLD_EFFECT_LIFE_ORB@battle_util.c:ITEMEFFECT_LIFEORB_SHELLBELL` | no canProc / gQueuedAttackCount gate and targetDamage > 0 instead of damagedMons check | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6085` |

## Known limitations

Test evidence is per effect token or item id, not per site.

## Unported Units by Trigger Kind

| Unit kind | Trigger kind | Unported |
| --- | --- | ---: |
| `hold-trigger` | `AbilityBattleEffects` | 1 |
| `hold-trigger` | `AdjustFriendship` | 1 |
| `hold-trigger` | `BENEFITS_FROM_LEEK` | 1 |
| `hold-trigger` | `CalcAttackStat` | 2 |
| `hold-trigger` | `CalcCritChanceStage` | 2 |
| `hold-trigger` | `CalcDefenseStat` | 2 |
| `hold-trigger` | `CalcFinalDmg` | 1 |
| `hold-trigger` | `CalcMoveBasePowerAfterModifiers` | 1 |
| `hold-trigger` | `CanBattlerGetOrLoseItem` | 1 |
| `hold-trigger` | `CheckMoveLimitations` | 2 |
| `hold-trigger` | `CheckQuickClaw_CustapBerryActivation` | 1 |
| `hold-trigger` | `Cmd_accuracycheck` | 2 |
| `hold-trigger` | `Cmd_adjustdamage` | 1 |
| `hold-trigger` | `Cmd_getexp` | 3 |
| `hold-trigger` | `Cmd_setmultihitcounter` | 1 |
| `hold-trigger` | `Cmd_various` | 5 |
| `hold-trigger` | `DoBattlerEndTurnEffects` | 2 |
| `hold-trigger` | `DoesBattlerHaveAbilityShield` | 1 |
| `hold-trigger` | `ENDTURN_ITEMS1/2` | 25 |
| `hold-trigger` | `GetBattlerTotalSpeedStat` | 3 |
| `hold-trigger` | `GetBattlerWeight` | 1 |
| `hold-trigger` | `GetEvolutionTargetSpecies` | 1 |
| `hold-trigger` | `GetMonMoveType` | 1 |
| `hold-trigger` | `ITEMEFFECT_KINGSROCK` | 2 |
| `hold-trigger` | `ITEMEFFECT_LIFEORB_SHELLBELL` | 1 |
| `hold-trigger` | `ITEMEFFECT_MOVE_END` | 12 |
| `hold-trigger` | `ITEMEFFECT_ON_SWITCH_IN` | 25 |
| `hold-trigger` | `ITEMEFFECT_TARGET` | 11 |
| `hold-trigger` | `IsBattlerWeatherAffected` | 1 |
| `hold-trigger` | `IsRunningFromBattleImpossible` | 1 |
| `hold-trigger` | `PlayStatChangeAnimation` | 1 |
| `hold-trigger` | `SetActionsAndBattlersTurnOrder` | 2 |
| `hold-trigger` | `SetMoveEffect` | 1 |
| `hold-trigger` | `SetSwapDamageCategory` | 1 |
| `hold-trigger` | `TryRunFromBattle` | 1 |
| `hold-trigger` | `TrySetCantSelectMoveBattleScript` | 2 |
| `hold-trigger` | `UPDATE_FRIENDSHIP_FROM_ITEM` | 1 |
| `ai-trigger` | `AI_CheckViability` | 28 |
| `ai-trigger` | `AI_DoubleBattle` | 3 |
| `ai-trigger` | `GetTrapDamage` | 1 |
| `ai-trigger` | `HasHealingItem` | 3 |
| `ai-trigger` | `IsBattlerTrapped` | 1 |
| `ai-trigger` | `PartyBattlerShouldAvoidHazards` | 3 |
| `ai-trigger` | `ShouldPivot` | 1 |
| `item-data` | `HOLD_EFFECT_ADRENALINE_ORB` | 1 |
| `item-data` | `HOLD_EFFECT_DESTINY_KNOT` | 1 |
| `item-data` | `HOLD_EFFECT_DRAGON_SCALE` | 1 |
| `item-data` | `HOLD_EFFECT_GRACIDEA` | 1 |
| `item-data` | `HOLD_EFFECT_POWER_HERB` | 1 |
| `item-data` | `HOLD_EFFECT_REPEL` | 2 |
| `item-data` | `HOLD_EFFECT_UPGRADE` | 1 |
| `item-data` | `HOLD_EFFECT_Z_CRYSTAL` | 34 |
| `item-data` | `HOLD_EFFECT_Z_RING` | 1 |
| `natural-gift` | `naturalGift` | 38 |
| `fling` | `VARIOUS_TRY_FLING` | 1 |

## Hold-Trigger Units

One line per unit, sorted by unit key. `Items` lists the first five item names sharing the hold effect
(then `+N`); item-keyed units list their own item.

| Unit key | Items | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `HOLD_EFFECT_ABILITY_SHIELD@battle_util.c:DoesBattlerHaveAbilityShield` | Ability Shield | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6543` | unported | `web/src/engine/sim/accuracy.test.ts` |
| `HOLD_EFFECT_ABSORB_BULB@battle_util.c:ITEMEFFECT_TARGET` | Absorb Bulb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6198` | unported | none |
| `HOLD_EFFECT_AIR_BALLOON@battle_script_commands.c:Cmd_removeitem` | Air Balloon | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:6047` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_AIR_BALLOON@battle_util.c:CheckLevitatingEffects` | Air Balloon | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6667` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_AIR_BALLOON@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Air Balloon | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5573` | unported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_AIR_BALLOON@battle_util.c:ITEMEFFECT_TARGET` | Air Balloon | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6154` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_AMULET_COIN@battle_script_commands.c:SetMoveEffect` | Amulet Coin | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:2686` | unported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_AMULET_COIN@battle_util.c:CalcFinalDmg` | Amulet Coin | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7654` | unported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_ASSAULT_VEST@battle_util.c:CalcDefenseStat` | Assault Vest | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7425` | ported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_ASSAULT_VEST@battle_util.c:CheckMoveLimitations` | Assault Vest | `pipeline/.upstream/eliteredux-source/src/battle_util.c:1647` | unported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_ASSAULT_VEST@battle_util.c:TrySetCantSelectMoveBattleScript` | Assault Vest | `pipeline/.upstream/eliteredux-source/src/battle_util.c:1574` | unported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_ATTACK_UP@battle_util.c:ENDTURN_ITEMS1/2` | Liechi Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5732` | unported | `web/src/engine/sim/cycle129CopyEffects.test.ts` |
| `HOLD_EFFECT_ATTACK_UP@battle_util.c:ITEMEFFECT_MOVE_END` | Liechi Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5907` | ported | `web/src/engine/sim/cycle129CopyEffects.test.ts` |
| `HOLD_EFFECT_ATTACK_UP@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Liechi Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5457` | unported | `web/src/engine/sim/cycle129CopyEffects.test.ts` |
| `HOLD_EFFECT_BIG_ROOT@battle_util.c:GetDrainedBigRootHp` | Big Root | `pipeline/.upstream/eliteredux-source/src/battle_util.c:2372` | ported | `web/src/engine/sim/cycle111Chains.test.ts` |
| `HOLD_EFFECT_BINDING_BAND@battle_util.c:DoBattlerEndTurnEffects` | Binding Band | `pipeline/.upstream/eliteredux-source/src/battle_util.c:2682` | unported (registered, untested) | none |
| `HOLD_EFFECT_BLACK_SLUDGE@battle_util.c:ENDTURN_ITEMS1/2` | Black Sludge | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5694` | ported | `web/src/engine/sim/cycle90aAbilities.test.ts` |
| `HOLD_EFFECT_BLUNDER_POLICY@battle_script_commands.c:Cmd_accuracycheck` | Blunder Policy | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:1435` | unported | none |
| `HOLD_EFFECT_BLUNDER_POLICY@battle_util.c:ITEMEFFECT_KINGSROCK` | Blunder Policy | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6055` | unported | none |
| `HOLD_EFFECT_BOOSTER_ENERGY@abilities.cc:ProtosynthesisHandler` | Booster Energy | `pipeline/.upstream/eliteredux-source/src/abilities.cc:6942` | ported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_BOOSTER_ENERGY@abilities.cc:QuarkDriveHandler` | Booster Energy | `pipeline/.upstream/eliteredux-source/src/abilities.cc:6998` | ported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_CELL_BATTERY@battle_util.c:ITEMEFFECT_TARGET` | Cell Battery | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6191` | unported | none |
| `HOLD_EFFECT_CHOICE_BAND@battle_util.c:CalcAttackStat` | Choice Band | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7288` | ported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_CHOICE_SCARF@battle_main.c:GetBattlerTotalSpeedStat` | Choice Scarf | `pipeline/.upstream/eliteredux-source/src/battle_main.c:4220` | ported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_CHOICE_SPECS@battle_util.c:CalcAttackStat` | Choice Specs | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7291` | ported | `web/src/engine/sim/cycle110bHeldItems.test.ts` |
| `HOLD_EFFECT_CLEAR_AMULET@battle_script_commands.c:ChangeStatBuffs` | Clear Amulet | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:9827` | ported (site-unmapped) | `web/src/engine/sim/cycle104Hooks.test.ts` |
| `HOLD_EFFECT_CLEAR_AMULET@battle_script_commands.c:PlayStatChangeAnimation` | Clear Amulet | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:4207` | unported | `web/src/engine/sim/cycle104Hooks.test.ts` |
| `HOLD_EFFECT_CLEAR_AMULET@battle_util.c:DoBattlerEndTurnEffects` | Clear Amulet | `pipeline/.upstream/eliteredux-source/src/battle_util.c:2711` | unported | `web/src/engine/sim/cycle104Hooks.test.ts` |
| `HOLD_EFFECT_CONFUSE_BITTER@battle_util.c:ENDTURN_ITEMS1/2` | Aguav Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5726` | unported | `web/src/engine/sim/bridge.test.ts` |
| `HOLD_EFFECT_CONFUSE_BITTER@battle_util.c:ITEMEFFECT_MOVE_END` | Aguav Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5901` | ported | `web/src/engine/sim/bridge.test.ts` |
| `HOLD_EFFECT_CONFUSE_BITTER@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Aguav Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5451` | unported | `web/src/engine/sim/bridge.test.ts` |
| `HOLD_EFFECT_CONFUSE_DRY@battle_util.c:ENDTURN_ITEMS1/2` | Wiki Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5720` | unported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `HOLD_EFFECT_CONFUSE_DRY@battle_util.c:ITEMEFFECT_MOVE_END` | Wiki Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5895` | ported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `HOLD_EFFECT_CONFUSE_DRY@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Wiki Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5445` | unported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `HOLD_EFFECT_CONFUSE_SOUR@battle_util.c:ENDTURN_ITEMS1/2` | Iapapa Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5729` | unported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `HOLD_EFFECT_CONFUSE_SOUR@battle_util.c:ITEMEFFECT_MOVE_END` | Iapapa Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5904` | ported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `HOLD_EFFECT_CONFUSE_SOUR@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Iapapa Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5454` | unported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `HOLD_EFFECT_CONFUSE_SPICY@battle_util.c:ENDTURN_ITEMS1/2` | Figy Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5717` | unported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `HOLD_EFFECT_CONFUSE_SPICY@battle_util.c:ITEMEFFECT_MOVE_END` | Figy Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5892` | ported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `HOLD_EFFECT_CONFUSE_SPICY@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Figy Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5442` | unported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `HOLD_EFFECT_CONFUSE_SWEET@battle_util.c:ENDTURN_ITEMS1/2` | Mago Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5723` | unported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `HOLD_EFFECT_CONFUSE_SWEET@battle_util.c:ITEMEFFECT_MOVE_END` | Mago Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5898` | ported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `HOLD_EFFECT_CONFUSE_SWEET@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Mago Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5448` | unported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `HOLD_EFFECT_COVERT_CLOAK@battle_script_commands.c:SetMoveEffect` | Covert Cloak | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:2348` | ported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_CRITICAL_UP@battle_util.c:ENDTURN_ITEMS1/2` | Lansat Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5747` | unported | none |
| `HOLD_EFFECT_CRITICAL_UP@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Lansat Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5472` | unported | none |
| `HOLD_EFFECT_CURE_BRN@battle_util.c:ENDTURN_ITEMS1/2` | Rawst Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5773` | unported | none |
| `HOLD_EFFECT_CURE_BRN@battle_util.c:ITEMEFFECT_MOVE_END` | Rawst Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5939` | unported (registered, untested) | none |
| `HOLD_EFFECT_CURE_BRN@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Rawst Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5498` | unported | none |
| `HOLD_EFFECT_CURE_CONFUSION@battle_util.c:ENDTURN_ITEMS1/2` | Persim Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5795` | unported | none |
| `HOLD_EFFECT_CURE_CONFUSION@battle_util.c:ITEMEFFECT_MOVE_END` | Persim Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5961` | unported (registered, untested) | none |
| `HOLD_EFFECT_CURE_FRZ@battle_util.c:ENDTURN_ITEMS1/2` | Aspear Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5780` | unported | none |
| `HOLD_EFFECT_CURE_FRZ@battle_util.c:ITEMEFFECT_MOVE_END` | Aspear Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5946` | unported (registered, untested) | none |
| `HOLD_EFFECT_CURE_FRZ@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Aspear Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5505` | unported | none |
| `HOLD_EFFECT_CURE_PAR@battle_util.c:ENDTURN_ITEMS1/2` | Cheri Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5759` | unported | `web/src/engine/sim/cycle129CopyEffects.test.ts` |
| `HOLD_EFFECT_CURE_PAR@battle_util.c:ITEMEFFECT_MOVE_END` | Cheri Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5925` | ported | `web/src/engine/sim/cycle129CopyEffects.test.ts` |
| `HOLD_EFFECT_CURE_PAR@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Cheri Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5484` | unported | `web/src/engine/sim/cycle129CopyEffects.test.ts` |
| `HOLD_EFFECT_CURE_PSN@battle_util.c:ENDTURN_ITEMS1/2` | Pecha Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5766` | unported | none |
| `HOLD_EFFECT_CURE_PSN@battle_util.c:ITEMEFFECT_MOVE_END` | Pecha Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5932` | unported (registered, untested) | none |
| `HOLD_EFFECT_CURE_PSN@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Pecha Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5491` | unported | none |
| `HOLD_EFFECT_CURE_SLP@battle_util.c:ENDTURN_ITEMS1/2` | Chesto Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5787` | unported | none |
| `HOLD_EFFECT_CURE_SLP@battle_util.c:ITEMEFFECT_MOVE_END` | Chesto Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5953` | unported (registered, untested) | none |
| `HOLD_EFFECT_CURE_SLP@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Chesto Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5512` | unported | none |
| `HOLD_EFFECT_CURE_STATUS@battle_util.c:ENDTURN_ITEMS1/2` | Lum Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5802` | ported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_CURE_STATUS@battle_util.c:ITEMEFFECT_MOVE_END` | Lum Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5975` | ported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_CURE_STATUS@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Lum Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5520` | ported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_CUSTAP_BERRY@battle_main.c:CheckQuickClaw_CustapBerryActivation` | Custap Berry | `pipeline/.upstream/eliteredux-source/src/battle_main.c:4616` | unported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_CUSTAP_BERRY@battle_main.c:SetActionsAndBattlersTurnOrder` | Custap Berry | `pipeline/.upstream/eliteredux-source/src/battle_main.c:4411` | unported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_DAMP_ROCK@battle_util.c:sWeatherFlagsInfo` | Damp Rock | `pipeline/.upstream/eliteredux-source/src/battle_util.c:3711` | ported | `web/src/engine/sim/cycle115bFieldEffects.test.ts` |
| `HOLD_EFFECT_DEEP_SEA_SCALE@battle_util.c:CalcDefenseStat` | DeepSeaScale | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7415` | unported (registered, untested) | none |
| `HOLD_EFFECT_DEEP_SEA_TOOTH@battle_util.c:CalcAttackStat` | DeepSeaTooth | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7268` | unported (registered, untested) | none |
| `HOLD_EFFECT_DEFENSE_UP@battle_util.c:ENDTURN_ITEMS1/2` | Ganlon Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5735` | unported | none |
| `HOLD_EFFECT_DEFENSE_UP@battle_util.c:ITEMEFFECT_MOVE_END` | Ganlon Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5910` | unported (registered, untested) | none |
| `HOLD_EFFECT_DEFENSE_UP@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Ganlon Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5460` | unported | none |
| `HOLD_EFFECT_DOUBLE_PRIZE@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Luck Incense | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5421` | unported | none |
| `HOLD_EFFECT_DRIVE@battle_util.c:CanBattlerGetOrLoseItem` | Burn Drive, Chill Drive, Douse Drive, Shock Drive | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8261` | unported (registered, untested) | none |
| `HOLD_EFFECT_EJECT_BUTTON@battle_util.c:ITEMEFFECT_TARGET` | Eject Button | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6142` | unported | none |
| `HOLD_EFFECT_EJECT_PACK@battle_script_commands.c:ChangeStatBuffs` | Eject Pack | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:9885` | ported (site-unmapped) | `web/src/engine/sim/statBuffsLoweredReactions.test.ts` |
| `HOLD_EFFECT_EVASION_UP@battle_script_commands.c:GetTotalAccuracy` | Bright Powder, Lax Incense | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:1376` | ported | `web/src/engine/sim/accuracy.test.ts` |
| `HOLD_EFFECT_EVIOLITE@battle_util.c:CalcDefenseStat` | Eviolite | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7422` | ported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_EXPERT_BELT@battle_util.c:CalcFinalDmg` | Expert Belt | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7648` | ported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_EXP_SHARE@battle_script_commands.c:Cmd_getexp` | Exp. Share | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3534` | unported | none |
| `HOLD_EFFECT_FLAME_ORB@battle_util.c:ITEMEFFECT_ORBS` | Flame Orb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6262` | ported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_FLINCH@battle_util.c:ITEMEFFECT_KINGSROCK` | King's Rock, Razor Fang | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6037` | unported | `web/src/engine/sim/moveEnd.test.ts` |
| `HOLD_EFFECT_FLOAT_STONE@battle_util.c:GetBattlerWeight` | Float Stone | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6720` | unported (registered, untested) | none |
| `HOLD_EFFECT_FOCUS_BAND@battle_script_commands.c:Cmd_adjustdamage` | Focus Band | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:1642` | unported | none |
| `HOLD_EFFECT_FOCUS_SASH@battle_script_commands.c:Cmd_adjustdamage` | Focus Sash | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:1645` | ported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_FRIENDSHIP_UP@pokemon.c:AdjustFriendship` | Soothe Bell | `pipeline/.upstream/eliteredux-source/src/pokemon.c:3546` | unported | none |
| `HOLD_EFFECT_FRIENDSHIP_UP@pokemon.c:UPDATE_FRIENDSHIP_FROM_ITEM` | Soothe Bell | `pipeline/.upstream/eliteredux-source/src/pokemon.c:2333` | unported | none |
| `HOLD_EFFECT_FROST_ORB@battle_util.c:ITEMEFFECT_ORBS` | Frost Orb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6270` | ported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_GEMS@battle_main.c:ApplyTypeOverrideInformation` | Bug Gem, Dark Gem, Dragon Gem, Electric Gem, Fairy Gem +13 | `pipeline/.upstream/eliteredux-source/src/battle_main.c:5222` | ported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_GEMS@battle_main.c:GetMonMoveType` | Bug Gem, Dark Gem, Dragon Gem, Electric Gem, Fairy Gem +13 | `pipeline/.upstream/eliteredux-source/src/battle_main.c:5034` | unported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_GEMS@battle_main.c:GetMoveTypeInternal` | Bug Gem, Dark Gem, Dragon Gem, Electric Gem, Fairy Gem +13 | `pipeline/.upstream/eliteredux-source/src/battle_main.c:5134` | ported (site-unmapped) | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_GEMS@battle_main.c:SetTypeBeforeUsingMove` | Bug Gem, Dark Gem, Dragon Gem, Electric Gem, Fairy Gem +13 | `pipeline/.upstream/eliteredux-source/src/battle_main.c:5246` | ported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_GEMS@battle_script_commands.c:SetMoveEffect` | Bug Gem, Dark Gem, Dragon Gem, Electric Gem, Fairy Gem +13 | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:2935` | ported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_GEMS@battle_util.c:CalcMoveBasePowerAfterModifiers` | Bug Gem, Dark Gem, Dragon Gem, Electric Gem, Fairy Gem +13 | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7003` | ported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_GRIP_CLAW@battle_script_commands.c:WrapDuration` | Grip Claw | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:2302` | ported | `web/src/engine/sim/cycle109Abilities.test.ts` |
| `HOLD_EFFECT_HEAT_ROCK@battle_util.c:sWeatherFlagsInfo` | Heat Rock | `pipeline/.upstream/eliteredux-source/src/battle_util.c:3713` | ported | `web/src/engine/sim/cycle115bFieldEffects.test.ts` |
| `HOLD_EFFECT_HEAVY_DUTY_BOOTS@battle_util.c:IsBattlerAffectedByHazards` | Heavy-Duty Boots | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8523` | ported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_HONEY@battle_util.c:ENDTURN_ITEMS1/2` | Honey | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5628` | unported | `web/src/engine/sim/cycle89aAbilities.test.ts` |
| `HOLD_EFFECT_HONEY@battle_util.c:ITEMEFFECT_MOVE_END` | Honey | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5886` | unported | `web/src/engine/sim/cycle89aAbilities.test.ts` |
| `HOLD_EFFECT_HONEY@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Honey | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5567` | unported | `web/src/engine/sim/cycle89aAbilities.test.ts` |
| `HOLD_EFFECT_ICY_ROCK@battle_util.c:sWeatherFlagsInfo` | Icy Rock | `pipeline/.upstream/eliteredux-source/src/battle_util.c:3716` | ported | `web/src/engine/sim/cycle115bFieldEffects.test.ts` |
| `HOLD_EFFECT_IRON_BALL@abilities.cc:Impl<ABILITY_MERCILESS>.onCrit` | Iron Ball | `pipeline/.upstream/eliteredux-source/src/abilities.cc:2674` | ported (site-unmapped) | `web/src/engine/abilities/impl/04-crit-a.test.ts` |
| `HOLD_EFFECT_IRON_BALL@battle_main.c:GetBattlerTotalSpeedStat` | Iron Ball | `pipeline/.upstream/eliteredux-source/src/battle_main.c:4218` | ported | `web/src/engine/abilities/impl/04-crit-a.test.ts` |
| `HOLD_EFFECT_IRON_BALL@battle_util.c:CheckGroundingEffects` | Iron Ball | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6648` | ported | `web/src/engine/abilities/impl/04-crit-a.test.ts` |
| `HOLD_EFFECT_JABOCA_BERRY@battle_util.c:ITEMEFFECT_TARGET` | Jaboca Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6205` | unported | none |
| `HOLD_EFFECT_KEE_BERRY@battle_util.c:ITEMEFFECT_TARGET` | Kee Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6231` | unported | none |
| `HOLD_EFFECT_LAGGING_TAIL@battle_main.c:GetMoveSpeed` | Full Incense, Lagging Tail | `pipeline/.upstream/eliteredux-source/src/battle_main.c:4318` | ported | `web/src/engine/sim/turnOrder.test.ts` |
| `HOLD_EFFECT_LEEK@battle_script_commands.c:BENEFITS_FROM_LEEK` | Leek | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:1518` | unported | none |
| `HOLD_EFFECT_LEEK@battle_util.c:CalcAttackStat` | Leek | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7285` | unported (registered, untested) | none |
| `HOLD_EFFECT_LEFTOVERS@battle_util.c:ENDTURN_ITEMS1/2` | Leftovers | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5706` | ported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_LIFE_ORB@battle_util.c:CalcFinalDmg` | Life Orb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7651` | ported | `web/src/engine/conditions.test.ts` |
| `HOLD_EFFECT_LIFE_ORB@battle_util.c:ITEMEFFECT_LIFEORB_SHELLBELL` | Life Orb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6085` | unported (partial: no canProc / gQueuedAttackCount gate and targetDamage > 0 instead of damagedMons check) | `web/src/engine/conditions.test.ts` |
| `HOLD_EFFECT_LIGHT_BALL@battle_util.c:CalcAttackStat` | Light Ball | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7271` | ported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_LIGHT_CLAY@abilities.cc:Impl<ABILITY_NORTH_WIND>.onEntry` | Light Clay | `pipeline/.upstream/eliteredux-source/src/abilities.cc:4488` | ported (site-unmapped) | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_LIGHT_CLAY@battle_script_commands.c:Cmd_setlightscreen` | Light Clay | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:10260` | ported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_LIGHT_CLAY@battle_script_commands.c:Cmd_setreflect` | Light Clay | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:9327` | ported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_LIGHT_CLAY@battle_script_commands.c:Cmd_various` | Light Clay | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:7759` | unported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_LIGHT_CLAY@battle_script_commands.c:SetMoveEffect` | Light Clay | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:2988` | ported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_LOADED_DICE@battle_script_commands.c:Cmd_accuracycheck` | Loaded Dice | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:1416` | unported | `web/src/engine/multiHit.test.ts` |
| `HOLD_EFFECT_LOADED_DICE@battle_script_commands.c:Cmd_setmultihitcounter` | Loaded Dice | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:10021` | unported | `web/src/engine/multiHit.test.ts` |
| `HOLD_EFFECT_LOADED_DICE@battle_util.c:GetMultihitType` | Loaded Dice | `pipeline/.upstream/eliteredux-source/src/battle_util.c:3586` | ported | `web/src/engine/multiHit.test.ts` |
| `HOLD_EFFECT_LUCKY_EGG@battle_script_commands.c:Cmd_getexp` | Lucky Egg | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3536` | unported | none |
| `HOLD_EFFECT_LUCKY_PUNCH@battle_script_commands.c:CalcCritChanceStage` | Lucky Punch | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:1548` | unported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_LUMINOUS_MOSS@battle_util.c:ITEMEFFECT_TARGET` | Luminous Moss | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6184` | unported | none |
| `HOLD_EFFECT_MACHO_BRACE@battle_main.c:GetBattlerTotalSpeedStat` | Macho Brace | `pipeline/.upstream/eliteredux-source/src/battle_main.c:4216` | unported (registered, untested) | none |
| `HOLD_EFFECT_MARANGA_BERRY@battle_util.c:ITEMEFFECT_TARGET` | Maranga Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6234` | unported | none |
| `HOLD_EFFECT_MEGA_STONE@battle_util.c:CanBattlerGetOrLoseItem` | Abomasite, Abomasite S, Absolite, Absolite Z, Aegislashite R +265 | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8259` | ported | `web/src/engine/sim/cycle110bHeldItems.test.ts` |
| `HOLD_EFFECT_MEMORY@battle_util.c:CanBattlerGetOrLoseItem` | Bug Memory, Dark Memory, Dragon Memory, ElectrcMemory, Fairy Memory +12 | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8263` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_MENTAL_HERB@battle_util.c:ENDTURN_ITEMS1/2` | Mental Herb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5845` | unported | none |
| `HOLD_EFFECT_MENTAL_HERB@battle_util.c:ITEMEFFECT_MOVE_END` | Mental Herb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5968` | unported | none |
| `HOLD_EFFECT_METAL_POWDER@battle_util.c:CalcDefenseStat` | Metal Powder | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7418` | unported (registered, untested) | none |
| `HOLD_EFFECT_METRONOME@battle_util.c:CalcFinalDmg` | Metronome | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7644` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_MICLE_BERRY@battle_util.c:ENDTURN_ITEMS1/2` | Micle Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5852` | unported | none |
| `HOLD_EFFECT_MICLE_BERRY@battle_util.c:ITEMEFFECT_MOVE_END` | Micle Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5880` | unported | none |
| `HOLD_EFFECT_MIRROR_HERB@battle_script_commands.c:Cmd_various` | Mirror Herb | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8284` | unported | `web/src/engine/sim/cycle148gFixes.test.ts` |
| `HOLD_EFFECT_MIRROR_HERB@battle_util.c:AbilityBattleEffects` | Mirror Herb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4738` | unported | `web/src/engine/sim/cycle148gFixes.test.ts` |
| `HOLD_EFFECT_MUSCLE_BAND@battle_util.c:CalcMoveBasePowerAfterModifiers` | Muscle Band | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6991` | ported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_PLATE@battle_util.c:CalcMoveBasePowerAfterModifiers` | Draco Plate, Dread Plate, Earth Plate, Fist Plate, Flame Plate +12 | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7007` | ported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_PLATE@battle_util.c:CanBattlerGetOrLoseItem` | Draco Plate, Dread Plate, Earth Plate, Fist Plate, Flame Plate +12 | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8265` | ported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_POWER_ITEM@battle_main.c:GetBattlerTotalSpeedStat` | Power Anklet, Power Band, Power Belt, Power Bracer, Power Lens +1 | `pipeline/.upstream/eliteredux-source/src/battle_main.c:4216` | unported (registered, untested) | none |
| `HOLD_EFFECT_PREVENT_EVOLVE@pokemon.c:GetEvolutionTargetSpecies` | Everstone | `pipeline/.upstream/eliteredux-source/src/pokemon.c:3155` | unported | none |
| `HOLD_EFFECT_PRIMAL_ORB@battle_script_commands.c:Cmd_various` | Adamant Orb, Blue Orb, Dynamax Orb, Galactic Orb, Griseous Orb +12 | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:7416` | unported | `web/src/engine/sim/formChange.test.ts` |
| `HOLD_EFFECT_PRIMAL_ORB@battle_util.c:CanBattlerGetOrLoseItem` | Adamant Orb, Blue Orb, Dynamax Orb, Galactic Orb, Griseous Orb +12 | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8257` | ported | `web/src/engine/sim/formChange.test.ts` |
| `HOLD_EFFECT_PRIMAL_ORB@battle_util.c:CanMegaEvolve` | Adamant Orb, Blue Orb, Dynamax Orb, Galactic Orb, Griseous Orb +12 | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8150` | ported | `web/src/engine/sim/formChange.test.ts` |
| `HOLD_EFFECT_PRIMAL_ORB@battle_util.c:TryPrimalReversion` | Adamant Orb, Blue Orb, Dynamax Orb, Galactic Orb, Griseous Orb +12 | `pipeline/.upstream/eliteredux-source/src/battle_util.c:3909` | ported | `web/src/engine/sim/formChange.test.ts` |
| `HOLD_EFFECT_PROTECTIVE_PADS@battle_util.c:IsMoveMakingContact` | Protective Pads | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6562` | ported | `web/src/engine/sim/cycle91bAbilities.test.ts` |
| `HOLD_EFFECT_PUNCHING_GLOVE@battle_util.c:CalcFinalDmg` | Punching Glove | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7658` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_PUNCHING_GLOVE@battle_util.c:IsMoveMakingContact` | Punching Glove | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6564` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_QUICK_CLAW@battle_main.c:SetActionsAndBattlersTurnOrder` | Quick Claw | `pipeline/.upstream/eliteredux-source/src/battle_main.c:4409` | unported | none |
| `HOLD_EFFECT_QUICK_POWDER@battle_main.c:GetBattlerTotalSpeedStat` | Quick Powder | `pipeline/.upstream/eliteredux-source/src/battle_main.c:4222` | unported (registered, untested) | none |
| `HOLD_EFFECT_RANDOM_STAT_UP@battle_util.c:ENDTURN_ITEMS1/2` | Starf Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5756` | unported | none |
| `HOLD_EFFECT_RANDOM_STAT_UP@battle_util.c:ITEMEFFECT_MOVE_END` | Starf Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5922` | unported | none |
| `HOLD_EFFECT_RANDOM_STAT_UP@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Starf Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5481` | unported | none |
| `HOLD_EFFECT_RED_CARD@battle_util.c:ITEMEFFECT_TARGET` | Red Card | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6130` | unported | none |
| `HOLD_EFFECT_RESIST_BERRY@battle_util.c:CalcFinalDmg` | Babiri Berry, Charti Berry, Chilan Berry, Chople Berry, Coba Berry +13 | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7666` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_RESTORE_HP@battle_util.c:ENDTURN_ITEMS1/2` | Berry Juice, Oran Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5625` | unported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `HOLD_EFFECT_RESTORE_HP@battle_util.c:ITEMEFFECT_MOVE_END` | Berry Juice, Oran Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5883` | ported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `HOLD_EFFECT_RESTORE_HP@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Berry Juice, Oran Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5564` | unported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `HOLD_EFFECT_RESTORE_PCT_HP@battle_util.c:ENDTURN_ITEMS1/2` | Sitrus Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5636` | unported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `HOLD_EFFECT_RESTORE_PCT_HP@battle_util.c:ITEMEFFECT_MOVE_END` | Sitrus Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5889` | ported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `HOLD_EFFECT_RESTORE_PCT_HP@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Sitrus Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5570` | unported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `HOLD_EFFECT_RESTORE_PP@battle_util.c:ENDTURN_ITEMS1/2` | Leppa Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5639` | unported | `web/src/engine/sim/cycle149cMoveEndType.test.ts` |
| `HOLD_EFFECT_RESTORE_STATS@battle_util.c:ENDTURN_ITEMS1/2` | White Herb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5679` | unported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_RESTORE_STATS@battle_util.c:ITEMEFFECT_MOVE_END` | White Herb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6007` | ported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_RESTORE_STATS@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | White Herb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5427` | unported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_RING_TARGET@battle_util.c:MulByTypeEffectiveness` | Ring Target | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7854` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_ROCKY_HELMET@battle_util.c:ITEMEFFECT_TARGET` | Rocky Helmet | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6160` | ported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_ROOM_SERVICE@battle_script_commands.c:Cmd_various` | Room Service | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:7810` | unported | none |
| `HOLD_EFFECT_ROOM_SERVICE@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Room Service | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5579` | unported | none |
| `HOLD_EFFECT_ROWAP_BERRY@battle_util.c:ITEMEFFECT_TARGET` | Rowap Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6218` | unported | none |
| `HOLD_EFFECT_SAFETY_GOGGLES@battle_script_commands.c:IsHailImmune` | Safety Goggles | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:10391` | ported | `web/src/engine/sim/turnFieldEndTurn.test.ts` |
| `HOLD_EFFECT_SAFETY_GOGGLES@battle_script_commands.c:IsSandImmune` | Safety Goggles | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:10381` | ported | `web/src/engine/sim/turnFieldEndTurn.test.ts` |
| `HOLD_EFFECT_SAFETY_GOGGLES@battle_util.c:IsPowderImmune` | Safety Goggles | `pipeline/.upstream/eliteredux-source/src/battle_util.c:3193` | ported | `web/src/engine/sim/turnFieldEndTurn.test.ts` |
| `HOLD_EFFECT_SCOPE_LENS@battle_script_commands.c:CalcCritChanceStage` | Razor Claw, Scope Lens | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:1547` | unported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_SEEDS@abilities.cc:Impl<ABILITY_ZEN_GARDEN>.onEntry` | Electric Seed, Grassy Seed, Misty Seed, Psychic Seed | `pipeline/.upstream/eliteredux-source/src/abilities.cc:11320` | ported (site-unmapped) | `web/src/engine/sim/switchInAbility.test.ts` |
| `HOLD_EFFECT_SEEDS@battle_script_commands.c:Cmd_various` | Electric Seed, Grassy Seed, Misty Seed, Psychic Seed | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:7819` | unported | `web/src/engine/sim/switchInAbility.test.ts` |
| `HOLD_EFFECT_SEEDS@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Electric Seed, Grassy Seed, Misty Seed, Psychic Seed | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5585` | unported | `web/src/engine/sim/switchInAbility.test.ts` |
| `HOLD_EFFECT_SHED_SHELL@battle_main.c:IsRunningFromBattleImpossible` | Shed Shell | `pipeline/.upstream/eliteredux-source/src/battle_main.c:3566` | unported | `web/src/engine/sim/cycle104Hooks.test.ts` |
| `HOLD_EFFECT_SHED_SHELL@battle_util.c:CanBattlerEscape` | Shed Shell | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4839` | ported | `web/src/engine/sim/cycle104Hooks.test.ts` |
| `HOLD_EFFECT_SHED_SHELL@battle_util.c:IsAbilityPreventingEscape` | Shed Shell | `pipeline/.upstream/eliteredux-source/src/battle_util.c:4827` | ported | `web/src/engine/sim/cycle104Hooks.test.ts` |
| `HOLD_EFFECT_SHED_SHELL@battle_util.c:TryRunFromBattle` | Shed Shell | `pipeline/.upstream/eliteredux-source/src/battle_util.c:511` | unported | `web/src/engine/sim/cycle104Hooks.test.ts` |
| `HOLD_EFFECT_SHELL_BELL@battle_util.c:ITEMEFFECT_LIFEORB_SHELLBELL` | Shell Bell | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6069` | ported | `web/src/engine/sim/cycle110bHeldItems.test.ts` |
| `HOLD_EFFECT_SMOKE_BALL@battle_util.c:sWeatherFlagsInfo` | Smoke Ball | `pipeline/.upstream/eliteredux-source/src/battle_util.c:3718` | ported | `web/src/engine/sim/cycle131UncategorisedEffects.test.ts` |
| `HOLD_EFFECT_SMOOTH_ROCK@battle_util.c:sWeatherFlagsInfo` | Smooth Rock | `pipeline/.upstream/eliteredux-source/src/battle_util.c:3715` | ported | `web/src/engine/sim/battleEvents.test.ts` |
| `HOLD_EFFECT_SNOWBALL@battle_util.c:ITEMEFFECT_TARGET` | Snowball | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6177` | unported | none |
| `HOLD_EFFECT_SOUL_DEW@battle_util.c:CalcDefenseStat` | Soul Dew | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7432` | ported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_SOUL_DEW@battle_util.c:CalcMoveBasePowerAfterModifiers` | Soul Dew | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6997` | ported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_SPEED_UP@battle_util.c:ENDTURN_ITEMS1/2` | Salac Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5738` | unported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_SPEED_UP@battle_util.c:ITEMEFFECT_MOVE_END` | Salac Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5913` | ported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_SPEED_UP@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Salac Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5463` | unported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_SP_ATTACK_UP@battle_util.c:ENDTURN_ITEMS1/2` | Petaya Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5741` | unported | none |
| `HOLD_EFFECT_SP_ATTACK_UP@battle_util.c:ITEMEFFECT_MOVE_END` | Petaya Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5916` | unported (registered, untested) | none |
| `HOLD_EFFECT_SP_ATTACK_UP@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Petaya Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5466` | unported | none |
| `HOLD_EFFECT_SP_DEFENSE_UP@battle_util.c:ENDTURN_ITEMS1/2` | Apicot Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5744` | unported | none |
| `HOLD_EFFECT_SP_DEFENSE_UP@battle_util.c:ITEMEFFECT_MOVE_END` | Apicot Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5919` | unported (registered, untested) | none |
| `HOLD_EFFECT_SP_DEFENSE_UP@battle_util.c:ITEMEFFECT_ON_SWITCH_IN` | Apicot Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:5469` | unported | none |
| `HOLD_EFFECT_STICKY_BARB@battle_util.c:ITEMEFFECT_ORBS` | Sticky Barb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6278` | ported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_STICKY_BARB@battle_util.c:ITEMEFFECT_TARGET` | Sticky Barb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6237` | unported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_SWIRLY_GLASSES@battle_util.c:SetSwapDamageCategory` | Swirly Glasses | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7356` | unported (registered, untested) | none |
| `HOLD_EFFECT_TACTICAL_VEST@battle_util.c:CalcDefenseStat` | Tactical Vest | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7428` | ported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_TACTICAL_VEST@battle_util.c:CheckMoveLimitations` | Tactical Vest | `pipeline/.upstream/eliteredux-source/src/battle_util.c:1647` | unported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_TACTICAL_VEST@battle_util.c:TrySetCantSelectMoveBattleScript` | Tactical Vest | `pipeline/.upstream/eliteredux-source/src/battle_util.c:1574` | unported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_TERRAIN_EXTENDER@battle_script_commands.c:HandleTerrainMove` | Terrain Extender | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:6458` | ported | `web/src/engine/sim/cycle115bFieldEffects.test.ts` |
| `HOLD_EFFECT_TERRAIN_EXTENDER@battle_util.c:TryChangeBattleTerrain` | Terrain Extender | `pipeline/.upstream/eliteredux-source/src/battle_util.c:3785` | ported | `web/src/engine/sim/cycle115bFieldEffects.test.ts` |
| `HOLD_EFFECT_THICK_CLUB@battle_util.c:CalcAttackStat` | Thick Club | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7262` | ported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_THROAT_SPRAY@battle_util.c:ITEMEFFECT_LIFEORB_SHELLBELL` | Throat Spray | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6111` | ported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_TOXIC_ORB@battle_util.c:ITEMEFFECT_ORBS` | Toxic Orb | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6254` | ported | `web/src/engine/sim/heldItems.test.ts` |
| `HOLD_EFFECT_TRAINING_BAND@battle_script_commands.c:Cmd_getexp` | Training Band | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3537` | unported | none |
| `HOLD_EFFECT_TYPE_POWER@battle_util.c:CalcMoveBasePowerAfterModifiers` | Black Belt, Black Glasses, Charcoal, Dragon Fang, Fairy Feather +18 | `pipeline/.upstream/eliteredux-source/src/battle_util.c:7008` | ported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_UTILITY_UMBRELLA@battle_util.c:IsBattlerWeatherAffected` | Utility Umbrella | `pipeline/.upstream/eliteredux-source/src/battle_util.c:8647` | unported | `web/src/engine/sim/cycle102Accuracy.test.ts` |
| `HOLD_EFFECT_WEAKNESS_POLICY@battle_util.c:ITEMEFFECT_TARGET` | Weakness Policy | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6171` | ported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `HOLD_EFFECT_WIDE_LENS@battle_script_commands.c:GetTotalAccuracy` | Wide Lens | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:1378` | ported | `web/src/engine/sim/accuracy.test.ts` |
| `HOLD_EFFECT_WISE_GLASSES@battle_util.c:CalcMoveBasePowerAfterModifiers` | Wise Glasses | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6994` | unported (registered, untested) | none |
| `HOLD_EFFECT_ZOOM_LENS@battle_script_commands.c:GetTotalAccuracy` | Zoom Lens | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:1380` | ported | `web/src/engine/sim/accuracy.test.ts` |

## AI-Trigger Units

One line per unit, sorted by unit key. `Items` lists the first five item names sharing the hold effect
(then `+N`); item-keyed units list their own item.

| Unit key | Items | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `HOLD_EFFECT_AIR_BALLOON@battle_ai_main.c:AI_CheckBadMove` | Air Balloon | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:1940` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_AIR_BALLOON@battle_ai_util.c:PartyBattlerShouldAvoidHazards` | Air Balloon | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1858` | unported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_BIG_ROOT@battle_ai_main.c:AI_CheckViability` | Big Root | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2639` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_BIG_ROOT@battle_ai_util.c:HasHealingItem` | Big Root | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1478` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_BINDING_BAND@battle_ai_util.c:GetTrapDamage` | Binding Band | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1728` | unported | none |
| `HOLD_EFFECT_BLACK_SLUDGE@battle_ai_main.c:AI_CheckViability` | Black Sludge | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3113` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_BLACK_SLUDGE@battle_ai_util.c:HasHealingItem` | Black Sludge | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1479` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_CHOICE_BAND@battle_ai_main.c:AI_CheckBadMove` | Choice Band | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:1366` | ported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_CHOICE_BAND@battle_ai_main.c:AI_CheckViability` | Choice Band | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3099` | unported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_CHOICE_BAND@battle_ai_util.c:ShouldFakeOut` | Choice Band | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:2130` | ported | `web/src/engine/battleStat.test.ts` |
| `HOLD_EFFECT_CHOICE_SCARF@battle_ai_main.c:AI_CheckViability` | Choice Scarf | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3100` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_CHOICE_SPECS@battle_ai_main.c:AI_CheckViability` | Choice Specs | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3101` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_CLEAR_AMULET@battle_ai_main.c:AI_CheckBadMove` | Clear Amulet | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:746` | ported | `web/src/engine/sim/cycle104Hooks.test.ts` |
| `HOLD_EFFECT_CURE_CONFUSION@battle_ai_main.c:AI_DoubleBattle` | Persim Berry | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2405` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_CURE_CONFUSION@battle_ai_util.c:IncreaseConfusionScore` | Persim Berry | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:2737` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_CURE_SLP@battle_ai_main.c:AI_CheckViability` | Chesto Berry | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2900` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_CURE_STATUS@battle_ai_main.c:AI_CheckViability` | Lum Berry | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2900` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_CURE_STATUS@battle_ai_main.c:AI_DoubleBattle` | Lum Berry | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2406` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_CURE_STATUS@battle_ai_util.c:IncreaseConfusionScore` | Lum Berry | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:2737` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_DAMP_ROCK@battle_ai_main.c:AI_CheckViability` | Damp Rock | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3247` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_EJECT_BUTTON@battle_ai_main.c:AI_CheckViability` | Eject Button | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3477` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_FLAME_ORB@battle_ai_main.c:AI_CheckViability` | Flame Orb | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3107` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_FOCUS_SASH@battle_ai_util.c:ShouldPivot` | Focus Sash | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1907` | unported | `web/src/engine/sim/ai/aiCheckBadMove.test.ts` |
| `HOLD_EFFECT_FROST_ORB@battle_ai_main.c:AI_CheckViability` | Frost Orb | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3110` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_GEMS@battle_ai_main.c:AI_CheckViability` | Bug Gem, Dark Gem, Dragon Gem, Electric Gem, Fairy Gem +13 | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3724` | unported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_HEAT_ROCK@battle_ai_main.c:AI_CheckViability` | Heat Rock | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3256` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_HEAVY_DUTY_BOOTS@battle_ai_util.c:PartyBattlerShouldAvoidHazards` | Heavy-Duty Boots | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1854` | unported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `HOLD_EFFECT_ICY_ROCK@battle_ai_main.c:AI_CheckViability` | Icy Rock | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3239` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_IRON_BALL@battle_ai_main.c:AI_CheckBadMove` | Iron Ball | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:1961` | ported | `web/src/engine/abilities/impl/04-crit-a.test.ts` |
| `HOLD_EFFECT_IRON_BALL@battle_ai_main.c:AI_CheckViability` | Iron Ball | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3116` | unported | `web/src/engine/abilities/impl/04-crit-a.test.ts` |
| `HOLD_EFFECT_IRON_BALL@battle_ai_util.c:PartyBattlerShouldAvoidHazards` | Iron Ball | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1857` | unported | `web/src/engine/abilities/impl/04-crit-a.test.ts` |
| `HOLD_EFFECT_LAGGING_TAIL@battle_ai_main.c:AI_CheckViability` | Full Incense, Lagging Tail | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3119` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_LEFTOVERS@battle_ai_main.c:AI_CheckViability` | Leftovers | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3826` | unported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_LEFTOVERS@battle_ai_util.c:HasHealingItem` | Leftovers | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1481` | ported | `web/src/engine/basePower.test.ts` |
| `HOLD_EFFECT_LIGHT_CLAY@battle_ai_main.c:AI_CheckViability` | Light Clay | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2892` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_MEGA_STONE@battle_ai_main.c:AI_DoubleBattle` | Abomasite, Abomasite S, Absolite, Absolite Z, Aegislashite R +265 | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2349` | unported | `web/src/engine/sim/cycle110bHeldItems.test.ts` |
| `HOLD_EFFECT_MENTAL_HERB@battle_ai_main.c:AI_CheckBadMove` | Mental Herb | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:1191` | ported | `web/src/engine/sim/ai/aiCheckBadMove.test.ts` |
| `HOLD_EFFECT_MENTAL_HERB@battle_ai_main.c:AI_CheckViability` | Mental Herb | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3024` | unported | `web/src/engine/sim/ai/aiCheckBadMove.test.ts` |
| `HOLD_EFFECT_POWER_HERB@battle_ai_main.c:AI_CheckBadMove` | Power Herb | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:1551` | ported | `web/src/engine/sim/ai/aiCheckBadMove.test.ts` |
| `HOLD_EFFECT_POWER_HERB@battle_ai_main.c:AI_CheckViability` | Power Herb | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3638` | unported | `web/src/engine/sim/ai/aiCheckBadMove.test.ts` |
| `HOLD_EFFECT_PROTECTIVE_PADS@battle_ai_util.c:AI_MoveMakesContact` | Protective Pads | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:2773` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_PROTECTIVE_PADS@battle_ai_util.c:WhichMoveBetter` | Protective Pads | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:770` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_RESTORE_HP@battle_ai_util.c:HasHealingItem` | Berry Juice, Oran Berry | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1483` | unported | `web/src/engine/sim/ai/aiAbilitySuppression.test.ts` |
| `HOLD_EFFECT_RESTORE_PCT_HP@battle_ai_util.c:HasHealingItem` | Sitrus Berry | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1482` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_RESTORE_STATS@battle_ai_main.c:AI_CheckViability` | White Herb | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3652` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_RING_TARGET@battle_ai_main.c:AI_CheckBadMove` | Ring Target | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2103` | ported | `web/src/engine/calculate.test.ts` |
| `HOLD_EFFECT_ROCKY_HELMET@battle_ai_main.c:AI_CheckViability` | Rocky Helmet | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2846` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_ROCKY_HELMET@battle_ai_util.c:WhichMoveBetter` | Rocky Helmet | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:771` | ported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_SCOPE_LENS@battle_ai_main.c:AI_CheckViability` | Razor Claw, Scope Lens | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2930` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_SHED_SHELL@battle_ai_util.c:IsBattlerTrapped` | Shed Shell | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:569` | unported | `web/src/engine/sim/ai/aiCheckBadMove.test.ts` |
| `HOLD_EFFECT_SHELL_BELL@battle_ai_util.c:HasHealingItem` | Shell Bell | `pipeline/.upstream/eliteredux-source/src/battle_ai_util.c:1480` | unported | `web/src/engine/sim/cycle110bHeldItems.test.ts` |
| `HOLD_EFFECT_SMOOTH_ROCK@battle_ai_main.c:AI_CheckViability` | Smooth Rock | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3227` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_STICKY_BARB@battle_ai_main.c:AI_CheckViability` | Sticky Barb | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3120` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_TERRAIN_EXTENDER@battle_ai_main.c:AI_CheckViability` | Terrain Extender | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3737` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_TOXIC_ORB@battle_ai_main.c:AI_CheckViability` | Toxic Orb | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:3104` | unported | `web/src/engine/sim/ai/aiCheckViability.test.ts` |
| `HOLD_EFFECT_UTILITY_UMBRELLA@battle_ai_main.c:AI_CheckBadMove` | Utility Umbrella | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:666` | ported | `web/src/engine/sim/ai/aiCheckBadMove.test.ts` |
| `HOLD_EFFECT_UTILITY_UMBRELLA@battle_ai_main.c:AI_CheckViability` | Utility Umbrella | `pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:2818` | unported | `web/src/engine/sim/ai/aiCheckBadMove.test.ts` |

## Item-Data Units

One line per unit, sorted by unit key. `Items` lists the first five item names sharing the hold effect
(then `+N`); item-keyed units list their own item.

| Unit key | Items | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `ITEM_ADRENALINE_ORB` | Adrenaline Orb | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_ALORAICHIUM_Z` | Aloraichium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_BUGINIUM_Z` | Buginium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_CLEANSE_TAG` | Cleanse Tag | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_DARKINIUM_Z` | Darkinium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_DECIDIUM_Z` | Decidium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_DESTINY_KNOT` | Destiny Knot | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_DRAGONIUM_Z` | Dragonium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_DRAGON_SCALE` | Dragon Scale | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_EEVIUM_Z` | Eevium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_ELECTRIUM_Z` | Electrium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_FAIRIUM_Z` | Fairium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_FIGHTINIUM_Z` | Fightinium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_FIRIUM_Z` | Firium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_FLYINIUM_Z` | Flyinium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_GHOSTIUM_Z` | Ghostium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_GRACIDEA` | Gracidea | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_GRASSIUM_Z` | Grassium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_GROUNDIUM_Z` | Groundium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_ICIUM_Z` | Icium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_INCINIUM_Z` | Incinium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_KOMMONIUM_Z` | Kommonium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_LUNALIUM_Z` | Lunalium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_LYCANIUM_Z` | Lycanium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_MARSHADIUM_Z` | Marshadium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_MEWNIUM_Z` | Mewnium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_MIMIKIUM_Z` | Mimikium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_NORMALIUM_Z` | Normalium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_PIKANIUM_Z` | Pikanium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_PIKASHUNIUM_Z` | Pikashunium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_POISONIUM_Z` | Poisinium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_POWER_HERB` | Power Herb | `none (data-only; data/v2.65beta/items.json)` | unported | `web/src/engine/sim/cycle87bEffects.test.ts` |
| `ITEM_PRIMARIUM_Z` | Primarium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_PSYCHIUM_Z` | Psychium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_PURE_INCENSE` | Pure Incense | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_ROCKIUM_Z` | Rockium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_SNORLIUM_Z` | Snorlium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_SOLGANIUM_Z` | Solganium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_STEELIUM_Z` | Steelium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_TAPUNIUM_Z` | Tapunium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_UPGRADE` | Upgrade | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_WATERIUM_Z` | Waterium Z | `none (data-only; data/v2.65beta/items.json)` | unported | none |
| `ITEM_Z_RING` | Z-Ring | `none (data-only; data/v2.65beta/items.json)` | unported | none |

## Natural-Gift Units

One line per unit, sorted by unit key. `Items` lists the first five item names sharing the hold effect
(then `+N`); item-keyed units list their own item.

| Unit key | Items | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `ITEM_AGUAV_BERRY` | Aguav Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | ported | `web/src/engine/sim/bridge.test.ts` |
| `ITEM_APICOT_BERRY` | Apicot Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported (registered, untested) | none |
| `ITEM_ASPEAR_BERRY` | Aspear Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_BABIRI_BERRY` | Babiri Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_BLUK_BERRY` | Bluk Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_CHARTI_BERRY` | Charti Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_CHERI_BERRY` | Cheri Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | `web/src/engine/sim/cycle129CopyEffects.test.ts` |
| `ITEM_CHESTO_BERRY` | Chesto Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_CHILAN_BERRY` | Chilan Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | `web/src/engine/sim/cycle129CopyEffects.test.ts` |
| `ITEM_CHOPLE_BERRY` | Chople Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_COBA_BERRY` | Coba Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_COLBUR_BERRY` | Colbur Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_CUSTAP_BERRY` | Custap Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | `web/src/engine/sim/heldItems.test.ts` |
| `ITEM_ENIGMA_BERRY` | Enigma Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | ported | `web/src/engine/sim/bridge.test.ts` |
| `ITEM_FIGY_BERRY` | Figy Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | ported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `ITEM_GANLON_BERRY` | Ganlon Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported (registered, untested) | none |
| `ITEM_HABAN_BERRY` | Haban Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_IAPAPA_BERRY` | Iapapa Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | ported | `web/src/engine/sim/cycle137MoveNotes.test.ts` |
| `ITEM_KASIB_BERRY` | Kasib Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `ITEM_KEBIA_BERRY` | Kebia Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_LANSAT_BERRY` | Lansat Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported (registered, untested) | none |
| `ITEM_LEPPA_BERRY` | Leppa Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | `web/src/engine/sim/cycle149cMoveEndType.test.ts` |
| `ITEM_LIECHI_BERRY` | Liechi Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | ported | `web/src/engine/sim/cycle129CopyEffects.test.ts` |
| `ITEM_LUM_BERRY` | Lum Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | ported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `ITEM_MAGO_BERRY` | Mago Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported (registered, untested) | none |
| `ITEM_MICLE_BERRY` | Micle Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_NANAB_BERRY` | Nanab Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_OCCA_BERRY` | Occa Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | `web/src/engine/sim/cycle110HeldItems.test.ts` |
| `ITEM_ORAN_BERRY` | Oran Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `ITEM_PASSHO_BERRY` | Passho Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_PAYAPA_BERRY` | Payapa Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_PECHA_BERRY` | Pecha Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_PERSIM_BERRY` | Persim Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_PETAYA_BERRY` | Petaya Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported (registered, untested) | none |
| `ITEM_PINAP_BERRY` | Pinap Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_RAWST_BERRY` | Rawst Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_RAZZ_BERRY` | Razz Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_RINDO_BERRY` | Rindo Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_ROSELI_BERRY` | Roseli Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_SALAC_BERRY` | Salac Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | ported | `web/src/engine/sim/cycle110cHeldItems.test.ts` |
| `ITEM_SHUCA_BERRY` | Shuca Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_SITRUS_BERRY` | Sitrus Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | ported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `ITEM_STARF_BERRY` | Starf Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported (registered, untested) | none |
| `ITEM_TANGA_BERRY` | Tanga Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_WACAN_BERRY` | Wacan Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |
| `ITEM_WIKI_BERRY` | Wiki Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | ported | `web/src/engine/sim/cycle107BerryAbilities.test.ts` |
| `ITEM_YACHE_BERRY` | Yache Berry | `pipeline/.upstream/eliteredux-source/src/battle_util.c:6840; pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023; pipeline/.upstream/eliteredux-source/src/battle_main.c:5072; pipeline/.upstream/eliteredux-source/src/battle_main.c:5171` | unported | none |

## Fling Units

One line per unit, sorted by unit key. `Items` lists the first five item names sharing the hold effect
(then `+N`); item-keyed units list their own item.

| Unit key | Items | C citation | Status | Test file |
| --- | --- | --- | --- | --- |
| `ITEM_BLACK_SLUDGE` | Black Sludge | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8422` | ported | `web/src/engine/sim/cycle90aAbilities.test.ts` |
| `ITEM_FLAME_ORB` | Flame Orb | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8406` | ported | `web/src/engine/sim/heldItems.test.ts` |
| `ITEM_FROST_ORB` | Frost Orb | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8416` | ported | `web/src/engine/sim/heldItems.test.ts` |
| `ITEM_KINGS_ROCK` | King's Rock | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8410` | ported | `web/src/engine/sim/moveEnd.test.ts` |
| `ITEM_LIGHT_BALL` | Light Ball | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8419` | ported | `web/src/engine/sim/cycle87Effects.test.ts` |
| `ITEM_POISON_BARB` | Poison Barb | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8423` | unported (registered, untested) | none |
| `ITEM_RAZOR_FANG` | Razor Fang | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8409` | ported | `web/src/engine/sim/moveEnd.test.ts` |
| `ITEM_TOXIC_ORB` | Toxic Orb | `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:8413` | ported | `web/src/engine/sim/heldItems.test.ts` |

