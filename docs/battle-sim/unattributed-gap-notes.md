# Gap notes that carry no ability id

The ability audit (`web/src/engine/sim/driver/abilityAudit.test.ts`) runs one two-turn
fight per ability in `data/v2.65beta/abilityHooks.json` and records the `unmodelled`
notes the sim raises. Until cycle 155 it kept only notes whose text contained the
ability id under test, so every gap note with no `ABILITY_` token was silently
dropped. `web/src/engine/sim/driver/abilityAuditNotes.ts` now partitions each run's
notes into attributed (unchanged rows) and unattributed (gap phrase, no `ABILITY_`
token, not in the hook-free control baseline), and the audit writes the latter as
`UNATTRIBUTED: ` rows.

This file is the site inventory that change was based on.

## Method

```
grep -rnE "is not modelled|has no port|not applied|hook was not run|are not modelled" \
  web/src/engine/sim --include='*.ts' --exclude='*.test.ts'
```

155 lines match. Each was read and classified:

- **(A) raised note** -- a string that reaches the sim's note channel: `unmodelled.push(...)`,
  `note(...)`, `missing.add(...)`, `gaps.push(...)`, `gapIf(...)`, or a returned
  `unmodelled: [...]` string.
- **(B) not a note** -- a comment, doc comment, trailing comment, inventory/doc text.

**103 raised (A) sites. 59 of them do not contain an ability id in the raised text**
(44 do: literal `ABILITY_X`, or an interpolated `${abilityId}` / `${slotAbility}` /
`${held}` that is an ability id at runtime). 38 of the 103 are AI raise sites, and
36 of those carry no id. "reachable via: unknown" means the surrounding code does not
make the triggering ability clear; it is not a claim that no ability can reach it.

Sites are static inventory entries: the audit only measures the ones the two-turn
Tyranitar-vs-SAWYER_1 fight actually reaches.

## (B) non-note matches (52)

Comments, doc comments, trailing comments and inventory text. None is raised.

- `switchIn.ts`: 147 (comment)
- `switchInAbility.ts`: 1107, 2332, 2525 (comments)
- `endTurn.ts`: 129, 602, 614, 2039 (comments)
- `fieldEndTurn.ts`: 49, 301 (comments)
- `attackCanceller.ts`: 127, 410 (comments)
- `statusEffects.ts`: 1881 (comment)
- `accuracyBridge.ts`: 18 (comment)
- `formChange.ts`: 322 (comment)
- `state.ts`: 89 (comment)
- `statBuffs.ts`: 1469 (comment)
- `accuracy.ts`: 216, 793 (comments)
- `moveEnd.ts`: 659, 1215 (comments)
- `moveEffects.ts`: 5115, 6351 (comments)
- `turn.ts`: 64, 1130, 1291, 1295, 2034 (comments)
- `driver/session.ts`: 266 (comment)
- `driver/expectimax.ts`: 376, 385, 489, 566, 908, 954 (comments)
- `driver/abilityHookInventory.ts`: 883 (comment), 901 (scanner doc text)
- `driver/environmentInventory.ts`: 1799, 1808 (inventory prose)
- `ai/aiCheckViability.ts`: 88, 304, 540 (comments)
- `ai/chooseAiAction.ts`: 63 (trailing comment on a property value)
- `ai/aiAbilityHelpers.ts`: 101, 221 (comments)
- `ai/aiCheckBadMove.ts`: 66, 81, 110, 396, 532, 757, 781 (comments)

## Non-AI raise sites

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|

### `web/src/engine/sim/switchIn.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 249 | battler ${battlerId}: ITEMEFFECT_ON_SWITCH_IN (battle_util.c:5418-5604) is not applied -- ${incoming.itemId}'s switch-in hold effect (${heldEffect}... | **no** | reachable via: unknown |

### `web/src/engine/sim/switchInAbility.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 2498 | battler ${battlerId}: HandleSwitchInAbility (battle_util.c:9103-9204) is not applied -- ${abilityId}'s onEntry hook was not run | yes | any ability with an onEntry hook (`${abilityId}` in the text) |

### `web/src/engine/sim/endTurn.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 947 | BattleScript_AbsorbSoulLinker (data/battle_scripts_1.s:3309-3317; ABILITY_SOUL_LINKER): the second hit on the drained battler is not modelled | yes | ABILITY_SOUL_LINKER |
| 985 | battler ${battlerId}: ${abilityId}'s consumeberry (VARIOUS_CONSUME_BERRY, battle_script_commands.c:8024-8041) is not applied -- no consumeBerryWith... | yes | any ability whose consumeberry hook ran (`${abilityId}` in the text) |
| 1776 | battler ${battlerId}: ENDTURN_ABILITIES (battle_util.c:2452-2459) is not applied -- ${slotAbility}'s onEndTurn hook was not run | yes | any ability with an onEndTurn hook (`${slotAbility}` in the text) |
| 1960 | battler ${battlerId}: ENDTURN_ITEMS1/ENDTURN_ITEMS2 (battle_util.c:5622-5855) are not applied -- ${battler.mon.itemId}'s end-of-turn hold effect ($... | **no** | reachable via: unknown |

### `web/src/engine/sim/damageResolver.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 220 | return { targetDamage: null, attackerDamage: null, unmodelled: ['status effects are not modelled yet'] } | **no** | reachable via: unknown |

### `web/src/engine/sim/moveEnd.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 2325 | Itchy Defense (ABILITY_ITCHY_DEFENSE) set STATUS2_WRAPPED; ENDTURN_WRAP damage and the trap are not modelled | yes | ABILITY_ITCHY_DEFENSE |
| 3295 | const note = 'move-end ABILITY_PATCHWORK onDisguise hook (pipeline/.upstream/eliteredux-source/src/abilities.cc:8638-8644) is not modelled yet | yes | ABILITY_PATCHWORK |
| 4152 | Angel's Wrath's ${moveId} case (abilities.cc:5592-5642; ABILITY_ANGELS_WRATH) is not modelled: it reads gMoveResultFlags / WasMoveSuccessful, which... | yes | ABILITY_ANGELS_WRATH |
| 4538 | Aftershock's followup move (UseAttackerFollowUpMove MOVE_MAGNITUDE, abilities.cc:6355; ABILITY_AFTERSHOCK) is not modelled | yes | ABILITY_AFTERSHOCK |
| 4548 | Blade Dance's followup move (UseAttackerFollowUpMove MOVE_LEAF_BLADE, abilities.cc:9043; ABILITY_BLADE_DANCE) is not modelled | yes | ABILITY_BLADE_DANCE |
| 5534 | ${name} (${abilityId}) set STATUS2_WRAPPED; ENDTURN_WRAP damage and the trap are not modelled | yes | any ability that sets STATUS2_WRAPPED (`${abilityId}` in the text) |
| 5579 | High Tide's followup move (UseAttackerFollowUpMove MOVE_SURF, abilities.cc:6477; ABILITY_HIGH_TIDE) is not modelled | yes | ABILITY_HIGH_TIDE |
| 5644 | Purple Haze's followup move (UseAttackerFollowUpMove MOVE_POISON_GAS, abilities.cc:10284; ABILITY_PURPLE_HAZE) is not modelled | yes | ABILITY_PURPLE_HAZE |
| 5677 | Volcano Rage's followup move (UseAttackerFollowUpMove MOVE_ERUPTION, abilities.cc:4845; ABILITY_VOLCANO_RAGE) is not modelled | yes | ABILITY_VOLCANO_RAGE |
| 5700 | Pickpocket's item theft (StealTargetItem, battle_script_commands.c:4848; ABILITY_PICKPOCKET) is not modelled | yes | ABILITY_PICKPOCKET |
| 5779 | const msg = `move-end defender ability ${abilityId} is not modelled yet | yes | any defender ability the move-end loop did not recognise (`${abilityId}` in the text) |
| 5845 | const msg = `move-end attacker ability ${abilityId} is not modelled yet | yes | any attacker ability the move-end loop did not recognise (`${abilityId}` in the text) |
| 6186 | const msg = `on-faint ability ${abilityId} is not modelled yet | yes | any on-faint ability the loop did not recognise (`${abilityId}` in the text) |
| 6261 | UpdateBattlerItem's Greedy ability state (battle_script_commands.c:2209-2212; ABILITY_GREEDY) is not modelled | yes | ABILITY_GREEDY |
| 6264 | UpdateBattlerItem's Power of Alchemy item memory (battle_script_commands.c:2206-2207; ABILITY_POWER_OF_ALCHEMY) is not modelled | yes | ABILITY_POWER_OF_ALCHEMY |
| 6334 | Bug Bite's consumeberry of ${itemId} on the attacker (VARIOUS_CONSUME_BERRY, battle_script_commands.c:8024-8041, ItemBattleEffects(ITEMEFFECT_BATTL... | **no** | reachable via: unknown |
| 7159 | move-end Synchronize (ABILITY_SYNCHRONIZE) is not modelled yet | yes | ABILITY_SYNCHRONIZE |
| 7167 | move-end Dancer (ABILITY_DANCER) is not modelled yet | yes | ABILITY_DANCER |
| 7346 | move-end target hold effect ${targetHoldEffect} is not modelled yet | **no** | reachable via: unknown |
| 7479 | move-end effect ${moveData.effect} is not modelled yet | **no** | reachable via: unknown |
| 7522 | MOVEEND_RECOIL\'s enraged recoil (savedDmg / 3, battle_script_commands.c:4492-4505) is not modelled | **no** | reachable via: unknown |
| 7547 | MOVEEND_CHARGE's GetOncePerTurnAbilityCounter(target, ABILITY_ENERGIZED) gate (:4929) is not modelled | yes | ABILITY_ENERGIZED |
| 7659 | move-end Pickpocket (ABILITY_PICKPOCKET) is not modelled yet | yes | ABILITY_PICKPOCKET |

### `web/src/engine/sim/hazards.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 178 | battler ${battlerId}: Stealth Rock damage (battle_script_commands.c:8751) is not applied -- no hazardTypes (type chart) was supplied in the deps | **no** | reachable via: unknown |
| 197 | battler ${battlerId}: SetOnMoveEffectReactionFlags (battle_script_commands.c:8776-8782) is not applied after Toxic Spikes poisoned it | **no** | `SET_STATE_ON_EFFECT_MAP[MOVE_EFFECT_POISON]`: ABILITY_HEMOTOXIN / ABILITY_NEUROTOXIN / ABILITY_POISON_PUPPETEER on the foe |
| 227 | battler ${battlerId}: ${name} entry hazard (battle_script_commands.c:8800-8830) is not applied | **no** | reachable via: unknown |

### `web/src/engine/sim/accuracy.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 738 | ${abilityId}'s onAccuracy hook has no port` } | yes | ABILITY slot from `UNPORTED_ACCURACY_ABILITIES` (`${abilityId}` in the text) |
| 753 | ${abilityId}'s onAccuracy hook has no port` } | yes | ABILITY slot from `UNPORTED_ACCURACY_ABILITIES` (`${abilityId}` in the text) |

### `web/src/engine/sim/statBuffs.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 656 | Mirror Armor stat reflection (battle_script_commands.c:9811; ABILITY_MIRROR_ARMOR) is not modelled | yes | ABILITY_MIRROR_ARMOR |
| 678 | Eject Pack switch trigger (battle_script_commands.c:9877-9893) is not modelled | **no** | `hasEjectPackAbility` branch: ABILITY_EJECT_PACK_ABILITY (or HOLD_EFFECT_EJECT_PACK) |
| 1122 | UpdateBattlerItem's Greedy ability state (battle_script_commands.c:2209-2212; ABILITY_GREEDY) is not modelled | yes | ABILITY_GREEDY |
| 1125 | UpdateBattlerItem's Power of Alchemy item memory (battle_script_commands.c:2206-2207; ABILITY_POWER_OF_ALCHEMY) is not modelled | yes | ABILITY_POWER_OF_ALCHEMY |
| 1254 | Retribution Blow out-of-turn attack (abilities.cc:5145-5160) is not modelled (ABILITY_RETRIBUTION_BLOW) | yes | ABILITY_RETRIBUTION_BLOW |
| 1492 | const msg = `PoisonPuppeteerClone: ${abilityId} applies ${script} (src/abilities.cc:10000, 10083); that effect is not modelled | yes | ABILITY_FROSTBIND / ABILITY_HEMOTOXIN (`${abilityId}` in the text) |

### `web/src/engine/sim/turn.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 1003 | Cmd_accuracycheck's own Anticipation miss branch (battle_script_commands.c:1427-1432; ABILITY_ANTICIPATION) is not modelled: GetSingleUseAbilityCou... | yes | ABILITY_ANTICIPATION |
| 1025 | Cmd_accuracycheck's own Anticipation miss branch (battle_script_commands.c:1427-1432; ABILITY_ANTICIPATION) is not modelled: GetSingleUseAbilityCou... | yes | ABILITY_ANTICIPATION |
| 1215 | Camouflage applies GET_MOVE_TYPE's onMoveType (-ate) resolution only; the item/effect/field dynamic-type branches (Judgment/Plate, Natural Gift, Hi... | **no** | reachable via: unknown |
| 1328 | Pressure's mold-breaker suppression (IsAbilityOnSide's checkMoldBreaker=TRUE, battle_util.c:4793; ABILITY_PRESSURE) is not applied; an opposing Mol... | yes | ABILITY_PRESSURE (opposing side) |
| 1653 | battler ${battlerId}: switch-out Generator SetSingleUseAbilityCounter is not modelled (ABILITY_GENERATOR) | yes | ABILITY_GENERATOR |
| 1661 | battler ${battlerId}: switch-out Energized SetSingleUseAbilityCounter is not modelled (ABILITY_ENERGIZED) | yes | ABILITY_ENERGIZED |
| 1680 | battler ${battlerId}: switch-out Retriever item restoration is not modelled (ABILITY_RETRIEVER) | yes | ABILITY_RETRIEVER |
| 2393 | CANCELLER_CONFUSED's self-hit damage (CalculateMoveDamage MOVE_NONE, battle_util.c:3376-3378, power 40 or 80 with an opposing Cosmic Daze) is not m... | **no** | reachable via: unknown |
| 2562 | BattleScript_MagicCoatBounce: unhandled move effect ${bouncedMoveEffect} for bounced move ${currentMove.id} is not modelled | **no** | reachable via: unknown |
| 2645 | BattleScript_SnatchedMove: unhandled move effect ${snatchedMoveEffect} for snatched move ${currentMove.id} is not modelled | **no** | reachable via: unknown |
| 3159 | EFFECT_TWO_TURN_SECONDARY: charge-turn effect ${effectName} is not modelled | **no** | reachable via: unknown |
| 3616 | Cmd_accuracycheck's own Anticipation miss branch (battle_script_commands.c:1427-1432; ABILITY_ANTICIPATION) is not modelled: GetSingleUseAbilityCou... | yes | ABILITY_ANTICIPATION |
| 4035 | battler ${battlerId}: Grudge's PP wipe (battle_script_commands.c:3252-3263) is not applied -- ${currentMove.id} is not in the chosen-move slot lookup | **no** | reachable via: unknown |
| 4090 | BattleScript_AbsorbSoulLinker (data/battle_scripts_1.s:3306-3313; ABILITY_SOUL_LINKER) is not modelled | yes | ABILITY_SOUL_LINKER |
| 4501 | const note = `queued switch for battler ${switchingBattler} skipped: BATTLE_TYPE_ARENA is not modelled for Red Card-class switches | **no** | reachable via: unknown |

### `web/src/engine/sim/moveEffects.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 426 | Cmd_accuracycheck's own Anticipation miss branch (battle_script_commands.c:1427-1432; ABILITY_ANTICIPATION) is not modelled: GetSingleUseAbilityCou... | yes | ABILITY_ANTICIPATION |
| 3387 | if (held) unmodelled.push(`battler ${i}: ${held}'s onTerrain reaction (BattleScript_OnTerrainChanged, battle_scripts_1.s:9947-9955) is not applied | yes | `ON_TERRAIN_UNMODELLED_ABILITIES` -- the note interpolates `${held}`, so the raised text DOES name the ability |
| 3456 | battler ${i}: Room Service (tryroomservice, battle_scripts_1.s:2647-2652) is not applied | **no** | reachable via: unknown |
| 6473 | battler ${battlerId}: Conversion 2 (battle_script_commands.c:10798-10806) is not applied -- no hazardTypes (type chart) was supplied in deps | **no** | reachable via: unknown |
| 9521 | UpdateBattlerItem's Greedy ability state (battle_script_commands.c:2209-2212; ABILITY_GREEDY) is not modelled | yes | ABILITY_GREEDY |
| 9524 | UpdateBattlerItem's Power of Alchemy item memory (battle_script_commands.c:2206-2207; ABILITY_POWER_OF_ALCHEMY) is not modelled | yes | ABILITY_POWER_OF_ALCHEMY |
| 10233 | VARIOUS_SWAP_WITH (battle_script_commands.c:8855-8878): swapping other battlers' gBattleStruct->moveTarget[i] between the user and BATTLE_PARTNER(u... | **no** | reachable via: unknown |

## AI raise sites (`web/src/engine/sim/ai/`)

These run for every opponent trainer decision regardless of the player mon's ability, which is why the audit's hook-free control baseline removes most of them.

### `web/src/engine/sim/ai/aiMoveLimitations.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 77 | CheckMoveLimitations' Belch check (battle_util.c:1651, IsBelchPreventingMove :1406-1412) is not modelled: ateBerry has no state in the sim and item... | **no** | reachable via: unknown |
| 81 | CheckMoveLimitations' Stuff Cheeks berry check (battle_util.c:1653) is not modelled: items.json carries no POCKET_BERRIES grouping | **no** | reachable via: unknown |
| 85 | CheckMoveLimitations' every-other-turn check (battle_util.c:1656-1658) is not modelled: gLastChosenMove and the Rampage/Master Hand/Raging Goddess/... | **no** | reachable via: unknown |
| 89 | CheckMoveLimitations' sleep-clause check (battle_util.c:1659, IsSleepClauseDisablingMove :4977-5018) is not modelled: gameDifficulty, the monotype-... | **no** | reachable via: unknown |
| 94 | CheckMoveLimitations' monotype-champion status-move lock (battle_util.c:1632-1633) is not modelled | **no** | reachable via: unknown |

### `web/src/engine/sim/ai/aiShouldSwitch.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 217 | MulByTypeEffectiveness (battle_util.c:7843): Ring Target on battler 0 (HOLD_EFFECT_RING_TARGET) is not modelled | **no** | reachable via: unknown |
| 218 | MulByTypeEffectiveness (battle_util.c:7843): STATUS4_FORESIGHT on battler 0 is not modelled | **no** | reachable via: unknown |
| 219 | MulByTypeEffectiveness (battle_util.c:7843): the Monotype Champion type overrides (Fairy/Dragon/Rock) are not modelled | **no** | reachable via: unknown |
| 220 | MulByTypeEffectiveness (battle_util.c:7843): the iceStatue volatile on battler 0 is not modelled | **no** | reachable via: unknown |
| 221 | MulByTypeEffectiveness (battle_util.c:7843): the Ground-vs-Flying grounding override (IsBattlerGrounded(battlerDef)) is not modelled | **no** | reachable via: unknown |
| 222 | MulByTypeEffectiveness (battle_util.c:7843): the tarShot volatile on battler 0 is not modelled | **no** | reachable via: unknown |
| 223 | MulByTypeEffectiveness (battle_util.c:7843): WEATHER_STRONG_WINDS is not modelled | **no** | reachable via: unknown |

### `web/src/engine/sim/ai/aiCalcDamage.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 209 | Monotype Champion's post-formula damage multiplier (battle_util.c:7716-7756) is not applied by calculateMoveDamage | **no** | reachable via: unknown |

### `web/src/engine/sim/ai/aiCheckViability.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 315 | CanBattlerHeal: IsAbilityOnOpposingSide(battler, ABILITY_PERMANENCE/ABILITY_HEMOLYSIS) has no port anywhere in this codebase; treated as absent | yes | note names ABILITY_PERMANENCE/ABILITY_HEMOLYSIS |
| 509 | ShouldTrap: BattlerWillFaintFromSecondaryDamage(battlerDef) needs GetBattlerSecondaryDamage, which has no port anywhere in this codebase; treated a... | **no** | reachable via: unknown |
| 620 | ShouldPivot: PartyBattlerShouldAvoidHazards has no port anywhere in this codebase (needs the resolved switch-target mon); treated as false | **no** | reachable via: unknown |
| 630 | ShouldPivot: IsUnnerveAbilityOnOpposingSide has no port anywhere in this codebase; treated as false | **no** | reachable via: unknown |
| 660 | ShouldPivot: BattlerWillFaintFromSecondaryDamage(battlerAtk) needs GetBattlerSecondaryDamage, which has no port anywhere in this codebase; treated ... | **no** | reachable via: unknown |
| 765 | IncreaseStatUpScore(STAT_EVASION): BattlerWillFaintFromWeather has no port anywhere in this codebase; treated as false | **no** | reachable via: unknown |
| 766 | IncreaseStatUpScore(STAT_EVASION): GetBattlerSecondaryDamage has no port anywhere in this codebase; treated as 0 | **no** | reachable via: unknown |
| 2251 | EFFECT_SLEEP_TALK/EFFECT_SNORE: IsWakeupTurn has no port (no move-history-by-turn tracking exists in this sim); treated as false | **no** | reachable via: unknown |
| 2317 | EFFECT_THIEF: ShouldPoisonSelf has no port anywhere in this codebase; treated as false | **no** | reachable via: unknown |
| 2320 | EFFECT_THIEF: ShouldBurnSelf has no port anywhere in this codebase; treated as false | **no** | reachable via: unknown |
| 2323 | EFFECT_THIEF: ShouldFrostbiteSelf has no port anywhere in this codebase; treated as false | **no** | reachable via: unknown |
| 2609 | EFFECT_ATTRACT: BattlerWillFaintFromSecondaryDamage(battlerDef) needs GetBattlerSecondaryDamage, which has no port anywhere in this codebase; treat... | **no** | reachable via: unknown |

### `web/src/engine/sim/ai/aiCheckBadMove.ts`

| line | note (abridged) | `ABILITY_` id in text? | raised by / reachable via |
|---:|---|---|---|
| 398 | LoweringStatsPointlessOrBad: IsStatDropBlocked(battlerDef, STAT_HP, FALSE) has no port anywhere in this codebase (same admission as accuracy.ts\'s ... | **no** | reachable via: unknown |
| 410 | ShouldLowerStat: IsStatDropBlocked(battlerDef, stat, FALSE) has no port anywhere in this codebase; treated as not blocked | **no** | reachable via: unknown |
| 538 | DoesSubstituteBlockMove: Infiltrates() is narrowed to a plain ABILITY_INFILTRATOR check; other Infiltrates paths (move-specific Sub-piercing exempt... | yes | ABILITY_INFILTRATOR (`selfAbility(...)` gate) |
| 728 | GetNaturePowerMove: sNaturePowerMoves[gBattleTerrain] (the overworld-map-location fallback) has no port -- this sim has no map-terrain concept; def... | **no** | reachable via: unknown |
| 775 | CanFling: IsItemNegated (Embargo/Magic Room/Klutz suppression) has no port; treated as not negated | **no** | reachable via: unknown |
| 785 | CanCamouflage: sTerrainToType[gBattleTerrain] (overworld-map-location type) has no port; treated as the map's type never matching the attacker's ow... | **no** | reachable via: unknown |
| 1027 | AI_CheckBadMove: IsShieldsDownProtected(battlerAtk) is not modelled (Minior form-state is not tracked); treated as not protected | **no** | `case 'ABILITY_SHIELDS_DOWN':` -- ABILITY_SHIELDS_DOWN |
| 1464 | AI_CheckBadMove: IsWakeupTurn is not modelled (no move-history-by-turn tracking exists in this sim -- FindMoveUsedXTurnsAgo has no port); treated a... | **no** | reachable via: unknown |
| 1743 | AI_CheckBadMove: GetBattlerSecondaryDamage(battlerDef) has no port; treated as 0 (falsy), so the \"target about to faint from secondary damage\" br... | **no** | reachable via: unknown |
| 1884 | AI_CheckBadMove: GetBattlerSecondaryDamage(battlerAtk) has no port; treated as 0 (falsy) | **no** | reachable via: unknown |
| 1902 | AI_CheckBadMove: GetBattlerSecondaryDamage(battlerAtk) has no port; treated as 0, so the \"will faint after protecting\" branch (>= the attacker's ... | **no** | reachable via: unknown |
| 1970 | AI_CheckBadMove: BattlerWillFaintFromWeather has no port (BattlerAffectedBySandstorm/Hail are not ported); treated as false | **no** | reachable via: unknown |
| 2001 | AI_CheckBadMove: IsAbilityOfRating(ability, 5) has no port (sAiAbilityRatings has no JSON export anywhere in this data pipeline); treated as below ... | **no** | reachable via: unknown |

## Measured UNATTRIBUTED rows (cycle 155d audit run)

Command:

```
SIM_AUDIT=1 SIM_AUDIT_OUT=<tmp> SIM_AUDIT_UNATTRIBUTED_OUT=<tmp> \
  npm --prefix web test -- --run src/engine/sim/driver/abilityAudit.test.ts
```

The control ability is `ABILITY_NONE` (`abilityHooks.json` lists it with `"hooks": {}`,
and it is a real species ability slot in `species.json`).

The cycle-155 revision of this section reported **23 `UNATTRIBUTED: ` rows across 17
abilities from 13 distinct strings**, and **28** lines matching the `validate.sh`
regex (`hook was not run|is not modelled|not applied|has no port`) in the audit JSON.
Most of that table had already gone stale: the `ABILITY_BERSERK_DNA` enraged-recoil
and `ABILITY_EJECT_PACK_ABILITY` Eject Pack rows no longer reproduce (both sites are
ported — moveEnd.ts:7524-7545 and statBuffs.ts:751-768), and the
`ABILITY_SHIELDS_DOWN` AI note is no longer raised.

A fresh **before** run on the current tree measured **8 rows across 2 abilities from
8 distinct strings**, with **9** `validate.sh`-regex lines. Seven of the eight were
`MulByTypeEffectiveness (battle_util.c:7843):` notes under `ABILITY_IMPOSTER`; the
eighth was `ABILITY_MINION_CONTROL`'s Minion Control note. The seven are AI
admissions: their `missing.add` calls run on every `mulByTypeEffectiveness` call
whatever the ability, so the ABILITY_NONE control fight missed them only because the
AI took a different branch in that ability's fight.

**Cycle 155d** adds `isAiAdmissionNote` to `abilityAuditNotes.ts`; `partitionAuditNotes`
now skips those notes exactly like control-baseline notes (attributed rows are checked
first and are unchanged). The **after** run measures **1 `UNATTRIBUTED: ` row across 1
ability from 1 distinct string**, and **3** `validate.sh`-regex lines (**9 → 3**; the
six dropped lines are the six `is/are not modelled` variants of the seven AI notes —
the plural Monotype note never matched that regex). Total note lines fall 431 → 424,
and all seven losses are `UNATTRIBUTED` rows, so no attributed row changed.
`move_notes` is unchanged at 0.

| ability | note |
|---|---|
| ABILITY_MINION_CONTROL | Minion Control: party-based hit count not modelled (caller supplied no minionControlCount) |

The surviving row is a genuine id-less gap raised by `web/src/engine/multiHit.ts`
(C `battle_script_commands.c:1021-1040`), not an AI admission, so it stays
allowlisted.

## Gate (cycle 150f)

Both audits now **fail** rather than quietly report. `web/src/engine/sim/driver/auditGate.ts`
exports the pure checks, and `web/src/engine/sim/cycle150fAuditGate.test.ts` unit-tests
them without running the 1016-ability sweep:

- `findUncoveredGapNotes(notes, allowlist)` returns every note that matches the shared
  `GAP_NOTE` (exported from `abilityAuditNotes.ts`, widened to the union of both audits'
  patterns), names no `ABILITY_` id, and has no allowance. `abilityAudit.test.ts` asserts
  it is empty after writing its output files.
- `findStaleAllowances(notes, allowlist)` returns allowances whose note no longer occurs;
  both audits assert that is empty too, so the list shrinks when a gap closes.
- A `GapAllowance` needs a `citation` carrying `file:line`; `validateGapAllowance` rejects
  one without it.

The allowlists live in `web/src/engine/sim/driver/gapNoteAllowlist.ts`:

- `ABILITY_GAP_ALLOWLIST` records the id-less gap notes the ability audit raises today.
  After cycle 155d only `Minion Control: party-based hit count not modelled` is listed:
  the seven `MulByTypeEffectiveness` entries became stale when `isAiAdmissionNote`
  excluded those AI admissions (see the measurement above). These are **known open
  gaps**, not ports: an allowance keeps the test green but never removes the note from
  the JSON or the `UNATTRIBUTED: ` rows.
- `SHARED_NOISE_ALLOWLIST` does the same for notes the move audit's shared-note filter
  would hide (more than 20 effects raise them). Today the audit raises no shared note, so
  the list is empty.

`moveEffectAudit.test.ts` now writes those shared notes to `<out>_shared.json`
(`{note: effectCount}`) instead of discarding them, and fails on a shared gap note that is
neither in `SHARED_NOISE_ALLOWLIST` nor covered by an effect allowance in
`auditAllowlist.ts`. Its `/manifest/` exclusion was deleted: no note in the sim contains
that text. Moves skipped because `power <= 1` and they have no effect are counted in its
console line (1 today).

### Cycle 150f measurement

Before: `ability_gaps` 9 lines (validate.sh regex), `move_notes` 0. After: `ability_gaps`
9, `move_notes` 0 — unchanged, nothing hidden. The widened shared regex made one gap
newly visible and it is now allowlisted: `ABILITY_MINION_CONTROL` raises
`Minion Control: party-based hit count not modelled (caller supplied no minionControlCount)`
(`web/src/engine/multiHit.ts`, C `battle_script_commands.c:1021-1040`). It does not match
the validate.sh regex (no `is not modelled`), so the counted figure stays 9 while the
`UNATTRIBUTED: ` rows grow by one. The eight distinct notes are the authoritative result
of the run; the `ABILITY_BERSERK_DNA`, `ABILITY_EJECT_PACK_ABILITY` and
`ABILITY_SHIELDS_DOWN` rows in the cycle-155 table no longer appear in the audit output
(their gap notes are no longer raised in the two-turn fight).
