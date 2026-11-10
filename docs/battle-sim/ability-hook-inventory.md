# Ability Hook Completeness Inventory

Static completeness audit of all ability hooks defined in `data/v2.65beta/abilityHooks.json` against the battle simulator and damage engine implementations.

- **Source Commit (eliteredux-source)**: `bdebcbbff9760cdd41a02c425bea4857fa0eee26` (game version `v2.65beta`)
- **Source Commit (er-config)**: `1b8e2cc4a8096d7ec90616f87fbf771bfa732447`
- **Regeneration Command**: `SIM_INVENTORY_WRITE=1 npm --prefix web test -- --run src/engine/sim/driver/abilityHookInventory.test.ts`

## Classification Method per Hook Kind

A `(ability, hook)` pair is classified as **ported** only when an explicit registry entry or case branch handles that exact ability and hook. Below are the detection mechanisms per hook kind:

1. **Calc-side hooks (18 kinds)**: Checked via `lookupAbility(id)` in `web/src/engine/abilities/registry.ts` (populated by `web/src/engine/abilities/impl/index.ts`). Ported iff `!isUnmodelled(entry)` and `typeof entry[hook] === "function"`.
   - `onOffensiveMultiplier`, `onDefensiveMultiplier`, `onStat`, `onStab`, `onCrit`, `onTypeEffectiveness`, `onAfterTypeEffectiveness`, `onChooseOffensiveStat`, `onChooseDefensiveStat`, `onSwapSplit`, `onMoveType`, `onRecoil`, `onPriority`, `onMoldBreaker`, `onParentalBond`, `onAbsorb`, `onImmune`, `onInfiltrate`. (`onRecoil` and `onAbsorb` also consult their sim-side handler tables).
2. **onAttacker**: Membership in exported `PORTED_ATTACKER_ABILITIES` (`web/src/engine/sim/moveEnd.ts`) **and** branch evidence in `handleAttackerMoveEndAbility`: an `abilityId === 'ABILITY_X'` comparison, a key of a table the handler indexes with `[abilityId]` (`ATE_ON_HIT_STATUS`, `ON_EITHER_CONTACT_STATUS`), or the alias comparison it resolves (`ABILITY_SPECTRAL_SHROUD` -> the `ABILITY_SPECTRALIZE` row).
3. **onDefender**: Membership in exported `PORTED_DEFENDER_ABILITIES` (`web/src/engine/sim/moveEnd.ts`) **and** branch evidence in `handleDefenderMoveEndAbility`: an `abilityId === 'ABILITY_X'` comparison or a key of `CONTACT_COUNTERATTACKS` / `ON_EITHER_CONTACT_STATUS`.
4. **onEntry**: Handled across weather/terrain/entry-move/intimidate/announce dispatch in `applySwitchInAbilities` (`web/src/engine/sim/switchInAbility.ts`). The ported set is derived from that dispatcher: the keys of `WEATHER_SETTER_MAP`, `TERRAIN_SETTER_MAP`, `PORTED_ENTRY_MOVE_MAP`, `INTIMIDATE_CLONE_MAP`, `ADD_TYPE_ON_ENTRY` and `ANNOUNCE_ONLY_ON_ENTRY`, plus every `case` label or ability-variable comparison (`abilityId === ...`) in `applySwitchInAbilities` and the same-file helpers it calls. Bare literals passed as arguments, array elements or map values are not evidence.
5. **onEndTurn**: `runEndTurnAbilities` switch cases in `web/src/engine/sim/endTurn.ts`.
6. **onAccuracy**: Cases in `runAttackerAbilityHook` and `runDefenderAbilityHook` in `web/src/engine/sim/accuracy.ts`.
7. **onBattlerFaints**: Dispatched in `web/src/engine/sim/moveEnd.ts` (`dispatchOnBattlerFaints`): `ABILITY_STRIKEOUT`, `SET_STATE_ON_EFFECT_ABILITIES` (`web/src/engine/sim/statusEffects.ts`), keys of `KO_STAT_RAISES`, `KO_SOUL_EATER_ABILITIES`, `KO_JAWS_OF_CARNAGE_ABILITIES`, and `KO_CRIT_BOOST_ABILITIES`. All other `ON_BATTLER_FAINTS_ABILITIES` hit the unmodelled note.
8. **onBeforeAttack**: Not ported (no handler in `web/src/engine/`).
9. **onBlockStatDrops**: Case labels of `statDropBlockForAbility` (`web/src/engine/sim/statBuffs.ts`), extracted from source text.
10. **onCanStatusType**: Quoted `ABILITY_...` ids inside `canPoisonType` and `canParalyzeType` (`web/src/engine/sim/statusEffects.ts`), extracted from source text: the CanPoisonType bypass array, the Angel's Wrath `MOVE_POISON_STING` comparison, and the CanParalyzeType bypass array.
11. **onCopyMove**: Not ported (gapped in `web/src/engine/sim/moveEnd.ts`).
12. **onDisguise**: Not ported (bust handler not modelled; note in `web/src/engine/sim/moveEnd.ts`).
13. **onExit**: Case labels of `dispatchSwitchOutAbilities` (`web/src/engine/sim/turn.ts`), extracted from source text; note-only branches are unported.
14. **onModifyEffectChance**: `abilityId === 'ABILITY_X'` comparisons inside `getMoveEffectChance` (`web/src/engine/sim/statusEffects.ts`), extracted from source text.
15. **onModifyMoveFlags**: `MODIFY_MOVE_FLAGS_GRANTS` records the `MOVE_FLAG_*` families each hook grants, read from `src/abilities.cc` at the pinned SHA. A pair is ported only when **every** granted family is listed in `MOVE_FLAG_CONSUMERS_WIRED` **and** has a returning-true `battlerHasSimAbility` branch for that ability in the matching sim predicate: SOUND in `isSoundMove`, KEEN_EDGE in `isKeenEdgeMove`, KICK in `isStrikerMove`, DANCE in `isDanceMove` (`web/src/engine/sim/moveEnd.ts`), MEGA_LAUNCHER in `isMegaLauncherBoostedMove` (`web/src/engine/sim/moveTargetFlags.ts`). `MOVE_FLAG_CONSUMERS_WIRED` is **empty**, so all 10 pairs are unported: every predicate now has its returning-true branch and the sim consumers listed below read the predicates, but each family still has at least one consumer that tests the static move flag, so the ability's grant changes nothing at that site. Cycle 150ibbd routed Heal Pulse's attacker read (`battle_script_commands.c:7269`), Throat Spray (`battle_util.c:6114`) and Pinnacle Blade's protect bypass (`battle_util.c:6597`) through the predicates, and removed `isSoundMove`/`isKeenEdgeMove`'s `DoesMoveMatchFlag` gap notes because Festivities/Musical Notes/Reverbate and Chestnut Axe are the only grants for those families. Cycle 150ibc added `matchesMoveFlag` to the onChooseOffensiveStat/onChooseDefensiveStat/onCrit/onImmune/onParentalBond contexts and routed Soundproof's `onImmune` (`src/abilities.cc:1054`, ATTACKER slots), Dual Wield's and Raging Boxer's `onParentalBond` (`:5488`, `:4162`), Roundhouse's `onChooseDefensiveStat` (`:5074`), Magical Fists'/Power Fists' choose-stat hooks (`:9158`, `:3691`) and Precise Fist's `onCrit` (`:4757`, holder slots) through it. The remaining unwired consumers: (a) dance -- `ABILITY_BLADE_DANCE`'s `onAttacker` tests `ctx.moveFlags.dance` (`web/src/engine/sim/moveEnd.ts:4551`) where the C calls `IsDance` (`src/abilities.cc:9040`), and move-end Dancer is gapped (`web/src/engine/sim/moveEnd.ts:7184-7185`); (b) keenEdge -- Cutthroat's +1 priority reads `TurnOrderMoveView.isKeenEdge`, which both action builders hard-code to `false` (`web/src/engine/sim/turnOrder.ts:437`, `web/src/engine/sim/driver/session.ts:151`, `web/src/engine/sim/turn.ts:4441`; C `battle_main.c:4278`). PUNCH has no sim predicate at all (the sim only reads the static `punchBased` flag, as at the effect-chance read in `web/src/engine/sim/statusEffects.ts:1866`), so any hook that grants PUNCH stays unported even once every other family is wired.
16. **onModifyTargetFlag**: Handled in `getBattlerBattleMoveTargetFlags` (`web/src/engine/sim/moveTargetFlags.ts`).
17. **onPreemptAction**: Cases in `tryPreemptiveActions` (`web/src/engine/sim/preempt.ts`).
18. **onReactive**: `abilityId === 'ABILITY_X'` comparisons inside `runReactiveAbilityEffects` (`web/src/engine/sim/statBuffs.ts`) plus the members of `POISON_PUPPETEER_CLONE_ABILITIES` that appear as `case 'ABILITY_X'` labels inside `runPoisonPuppeteerClone` (the gate set alone is not evidence: Frostbind and Hemotoxin are in it but only raise a note); note-only branches are unported.
19. **onRevive**: Handled in `latchRecurringNightmareOnFaint` (`web/src/engine/sim/turn.ts`, `ABILITY_RECURRING_NIGHTMARE`).
20. **onStatLowered**: Handled in `ON_STAT_LOWERED_HOOKS` (`web/src/engine/sim/statBuffs.ts`).
21. **onStatusImmune**: Handled in `OWN_STATUS_IMMUNE_CONDITIONS` (`web/src/engine/sim/statusEffects.ts`).
22. **onTerrain**: Cases in `dispatchOnTerrainChange` (`web/src/engine/sim/onWeather.ts`).
23. **onTrap**: Case labels of `onTrap` (`web/src/engine/sim/escape.ts`), extracted from source text.
24. **onWeather**: Cases in `dispatchOnWeatherChange` (`web/src/engine/sim/onWeather.ts`).

Move-end branch evidence: 0 of the 144 defined `onAttacker` pairs are listed in `PORTED_ATTACKER_ABILITIES` with no branch in `handleAttackerMoveEndAbility` (none). 0 of the 122 defined `onDefender` pairs are listed in `PORTED_DEFENDER_ABILITIES` with no branch in `handleDefenderMoveEndAbility` (none). A listed pair with no branch is unported, not an error.

## Hook Completeness Summary

| Hook Kind | Defined | Ported | Allowlisted | Unported | Unclassified | Ability Mentioned in Tests |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| onAbsorb | 22 | 22 | 0 | 0 | 0 | 22 |
| onAccuracy | 50 | 50 | 0 | 0 | 0 | 50 |
| onAfterTypeEffectiveness | 13 | 13 | 0 | 0 | 0 | 13 |
| onAttacker | 144 | 139 | 0 | 5 | 0 | 144 |
| onBattlerFaints | 55 | 38 | 0 | 17 | 0 | 37 |
| onBeforeAttack | 9 | 0 | 0 | 9 | 0 | 3 |
| onBlockStatDrops | 11 | 11 | 0 | 0 | 0 | 9 |
| onCanStatusType | 8 | 8 | 0 | 0 | 0 | 8 |
| onChooseDefensiveStat | 11 | 11 | 0 | 0 | 0 | 10 |
| onChooseOffensiveStat | 20 | 20 | 0 | 0 | 0 | 19 |
| onCopyMove | 4 | 0 | 0 | 4 | 0 | 1 |
| onCrit | 31 | 31 | 0 | 0 | 0 | 28 |
| onDefender | 122 | 122 | 0 | 0 | 0 | 122 |
| onDefensiveMultiplier | 102 | 102 | 0 | 0 | 0 | 84 |
| onDisguise | 3 | 0 | 0 | 3 | 0 | 2 |
| onEndTurn | 67 | 67 | 0 | 0 | 0 | 65 |
| onEntry | 225 | 225 | 0 | 0 | 0 | 207 |
| onExit | 12 | 9 | 0 | 3 | 0 | 12 |
| onImmune | 19 | 19 | 0 | 0 | 0 | 19 |
| onInfiltrate | 10 | 10 | 0 | 0 | 0 | 10 |
| onModifyEffectChance | 13 | 13 | 0 | 0 | 0 | 12 |
| onModifyMoveFlags | 10 | 0 | 0 | 10 | 0 | 10 |
| onModifyTargetFlag | 7 | 7 | 0 | 0 | 0 | 7 |
| onMoldBreaker | 10 | 10 | 0 | 0 | 0 | 10 |
| onMoveType | 42 | 42 | 0 | 0 | 0 | 42 |
| onOffensiveMultiplier | 199 | 199 | 0 | 0 | 0 | 174 |
| onParentalBond | 23 | 23 | 0 | 0 | 0 | 23 |
| onPreemptAction | 5 | 5 | 0 | 0 | 0 | 5 |
| onPriority | 19 | 11 | 0 | 8 | 0 | 14 |
| onReactive | 18 | 10 | 0 | 8 | 0 | 16 |
| onRecoil | 5 | 5 | 0 | 0 | 0 | 5 |
| onRevive | 2 | 1 | 0 | 1 | 0 | 1 |
| onStab | 44 | 44 | 0 | 0 | 0 | 43 |
| onStat | 63 | 62 | 0 | 1 | 0 | 58 |
| onStatLowered | 11 | 11 | 0 | 0 | 0 | 8 |
| onStatusImmune | 40 | 40 | 0 | 0 | 0 | 39 |
| onSwapSplit | 7 | 7 | 0 | 0 | 0 | 7 |
| onTerrain | 7 | 7 | 0 | 0 | 0 | 7 |
| onTrap | 5 | 5 | 0 | 0 | 0 | 5 |
| onTypeEffectiveness | 22 | 22 | 0 | 0 | 0 | 19 |
| onWeather | 8 | 8 | 0 | 0 | 0 | 7 |
| **Total** | **1498** | **1429** | **0** | **69** | **0** | **1377** |

## Unported Ability Hook Pairs

Grouped by hook kind, sorted alphabetically. Source lines cite `pipeline/.upstream/eliteredux-source/src/abilities.cc`.

### onAttacker (5)

- `ABILITY_AFTERSHOCK` (src/abilities.cc:6350) *(ability mentioned in test)*
- `ABILITY_BLADE_DANCE` (src/abilities.cc:9038) *(ability mentioned in test)*
- `ABILITY_HIGH_TIDE` (src/abilities.cc:6472) *(ability mentioned in test)*
- `ABILITY_PURPLE_HAZE` (src/abilities.cc:10280) *(ability mentioned in test)*
- `ABILITY_VOLCANO_RAGE` (src/abilities.cc:4840) *(ability mentioned in test)*

### onBattlerFaints (17)

- `ABILITY_BATTLE_BOND` (src/abilities.cc:2889)
- `ABILITY_BERSERKER_RAGE` (src/abilities.cc:6236) *(ability mentioned in test)*
- `ABILITY_BLOODLUST` (src/abilities.cc:7995) *(ability mentioned in test)*
- `ABILITY_COMMANDER` (src/abilities.cc:7163) *(ability mentioned in test)*
- `ABILITY_DRAGONS_RITUAL` (src/abilities.cc:8677)
- `ABILITY_DRAKE_OF_RAGE` (src/abilities.cc:9891)
- `ABILITY_EDGELORD` (src/abilities.cc:10747) *(ability mentioned in test)*
- `ABILITY_ENERGIZED` (src/abilities.cc:8721) *(ability mentioned in test)*
- `ABILITY_GOING_BERSERK` (src/abilities.cc:12143) *(ability mentioned in test)*
- `ABILITY_MASTER_HAND` (src/abilities.cc:8512) *(ability mentioned in test)*
- `ABILITY_POWER_OF_ALCHEMY` (src/abilities.cc:3077) *(ability mentioned in test)*
- `ABILITY_QIGONG` (src/abilities.cc:9352) *(ability mentioned in test)*
- `ABILITY_RAGING_GODDESS` (src/abilities.cc:8935) *(ability mentioned in test)*
- `ABILITY_RAMPAGE` (src/abilities.cc:3709) *(ability mentioned in test)*
- `ABILITY_RECEIVER` (src/abilities.cc:3058) *(ability mentioned in test)*
- `ABILITY_SIDEWINDER` (src/abilities.cc:8424) *(ability mentioned in test)*
- `ABILITY_SUPER_STRAIN` (src/abilities.cc:6316) *(ability mentioned in test)*

### onBeforeAttack (9)

- `ABILITY_COLOR_CHANGE` (src/abilities.cc:680)
- `ABILITY_DNA_SCRAMBLE` (src/abilities.cc:9657)
- `ABILITY_FLAMMABLE_COAT` (src/abilities.cc:8320) *(ability mentioned in test)*
- `ABILITY_LIBERO` (src/abilities.cc:3236)
- `ABILITY_PATTERN_CHANGE` (src/abilities.cc:8300) *(ability mentioned in test)*
- `ABILITY_PRISMATIC_FUR` (src/abilities.cc:5705) *(ability mentioned in test)*
- `ABILITY_PROTEAN` (src/abilities.cc:2331)
- `ABILITY_RKS_SYSTEM` (src/abilities.cc:3135)
- `ABILITY_STANCE_CHANGE` (src/abilities.cc:2396)

### onCopyMove (4)

- `ABILITY_DANCER` (src/abilities.cc:3008)
- `ABILITY_LUNAR_AFFINITY` (src/abilities.cc:8855)
- `ABILITY_PARROTING` (src/abilities.cc:6880) *(ability mentioned in test)*
- `ABILITY_SAMBA` (src/abilities.cc:9406)

### onDisguise (3)

- `ABILITY_DISGUISE` (src/abilities.cc:2869) *(ability mentioned in test)*
- `ABILITY_ICE_FACE` (src/abilities.cc:3362)
- `ABILITY_PATCHWORK` (src/abilities.cc:8636) *(ability mentioned in test)*

### onExit (3)

- `ABILITY_ENERGIZED` (src/abilities.cc:8721) *(ability mentioned in test)*
- `ABILITY_GENERATOR` (src/abilities.cc:6174) *(ability mentioned in test)*
- `ABILITY_RETRIEVER` (src/abilities.cc:6574) *(ability mentioned in test)*

### onModifyMoveFlags (10)

- `ABILITY_BACKSTREET_BOY` (src/abilities.cc:11568) *(ability mentioned in test)*
- `ABILITY_BRAWLING_WYVERN` (src/abilities.cc:7601) *(ability mentioned in test)*
- `ABILITY_CHESTNUT_AXE` (src/abilities.cc:11707) *(ability mentioned in test)*
- `ABILITY_FESTIVITIES` (src/abilities.cc:10193) *(ability mentioned in test)*
- `ABILITY_GUNMAN` (src/abilities.cc:9533) *(ability mentioned in test)*
- `ABILITY_JUNSHI_SANDA` (src/abilities.cc:7612) *(ability mentioned in test)*
- `ABILITY_MIXED_MARTIAL_ARTS` (src/abilities.cc:9898) *(ability mentioned in test)*
- `ABILITY_MUSICAL_NOTES` (src/abilities.cc:11988) *(ability mentioned in test)*
- `ABILITY_REVERBATE` (src/abilities.cc:10656) *(ability mentioned in test)*
- `ABILITY_TAEKKYEON` (src/abilities.cc:10665) *(ability mentioned in test)*

### onPriority (8)

- `ABILITY_CUTE_ANTECEDENCE` (src/abilities.cc:7891)
- `ABILITY_DARK_GALE_WINGS` (src/abilities.cc:7103)
- `ABILITY_FLAME_BUBBLE` (src/abilities.cc:8278) *(ability mentioned in test)*
- `ABILITY_FROZEN_SOUL` (src/abilities.cc:4614)
- `ABILITY_GALEFORCE_WINGS` (src/abilities.cc:11251)
- `ABILITY_IRON_BARRAGE` (src/abilities.cc:4992) *(ability mentioned in test)*
- `ABILITY_PRESTO` (src/abilities.cc:9397)
- `ABILITY_SIGHTING_SYSTEM` (src/abilities.cc:4650) *(ability mentioned in test)*

### onReactive (8)

- `ABILITY_BLOODLUST` (src/abilities.cc:7995) *(ability mentioned in test)*
- `ABILITY_FROSTBIND` (src/abilities.cc:9998) *(ability mentioned in test)*
- `ABILITY_GREEDY` (src/abilities.cc:11066)
- `ABILITY_HARUKAZE` (src/abilities.cc:10100) *(ability mentioned in test)*
- `ABILITY_HEMOTOXIN` (src/abilities.cc:10081) *(ability mentioned in test)*
- `ABILITY_MENTAL_POLLUTION` (src/abilities.cc:12118)
- `ABILITY_POWER_OF_ALCHEMY` (src/abilities.cc:3077) *(ability mentioned in test)*
- `ABILITY_RETRIBUTION_BLOW` (src/abilities.cc:5145) *(ability mentioned in test)*

### onRevive (1)

- `ABILITY_BACKUP_POWER` (src/abilities.cc:10929)

### onStat (1)

- `ABILITY_AERILATE` (src/abilities.cc:2502) *(ability mentioned in test)*

## Bitfield-Only Abilities

Abilities that define no hook lambdas in `abilityHooks.json`, only flags/bitfields. Total: **36 abilities**.

### Bitfield Implementation Status in Engine & Sim Code

Static detection of bitfield names across production TypeScript source files under `web/src/engine/` (excluding tests and inventory files). Note that matching on `\bname\b` is a name match and is a weak signal, not proof of full mechanical fidelity.

| Bitfield | Read by Code? | Citing Files |
| :--- | :--- | :--- |
| `absorbUp2` | Yes | `web/src/engine/sim/absorb.ts` |
| `adaptability` | Yes | `web/src/engine/abilities/dispatch.ts`, `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/12-adds-type.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/calculate.ts` |
| `addsType` | Yes | `web/src/engine/abilities/impl/12-adds-type.ts`, `web/src/engine/abilities/impl/13-defensive-multiplier-c.ts`, `web/src/engine/abilities/impl/15-ate-family-and-onstab.ts`, `web/src/engine/abilities/types.ts` |
| `allowTerrainIfAirborne` | Yes | `web/src/engine/calculate.ts`, `web/src/engine/sim/damageResolver.ts`, `web/src/engine/sim/driver/expectimax.ts`, `web/src/engine/sim/endTurn.ts`, `web/src/engine/sim/fieldEndTurn.ts`, `web/src/engine/sim/statusEffects.ts` |
| `alwaysSleeping` | Yes | `web/src/engine/sim/ai/aiCheckBadMove.ts`, `web/src/engine/sim/preempt.ts`, `web/src/engine/sim/switchInAbility.ts` |
| `auraBreak` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/10-aliases.ts`, `web/src/engine/abilities/impl/31-aura.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/calculate.ts` |
| `breakable` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/01-offensive-multiplier-a.ts`, `web/src/engine/abilities/impl/02-defensive-multiplier-a.ts`, `web/src/engine/abilities/impl/05-ate-abilities.ts`, `web/src/engine/abilities/impl/06-offensive-multiplier-c.ts`, `web/src/engine/abilities/impl/07-defensive-multiplier-b.ts`, `web/src/engine/abilities/impl/09-hub-abilities.ts`, `web/src/engine/abilities/impl/10-aliases.ts`, `web/src/engine/abilities/impl/11-offensive-multiplier-d.ts`, `web/src/engine/abilities/impl/12-adds-type.ts`, `web/src/engine/abilities/impl/13-defensive-multiplier-c.ts`, `web/src/engine/abilities/impl/14-on-stat-a.ts`, `web/src/engine/abilities/impl/15-ate-family-and-onstab.ts`, `web/src/engine/abilities/impl/16-type-effectiveness.ts`, `web/src/engine/abilities/impl/17-crit-swapsplit-misc.ts`, `web/src/engine/abilities/impl/18-offensive-multiplier-e.ts`, `web/src/engine/abilities/impl/25-absorb.ts`, `web/src/engine/abilities/impl/26-immune.ts`, `web/src/engine/abilities/impl/30-secondary-stat-blend.ts`, `web/src/engine/abilities/impl/32-rivalry.ts`, `web/src/engine/abilities/impl/34-fainted-count.ts`, `web/src/engine/abilities/impl/37-pretty-princess.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/calculate.ts`, `web/src/engine/sim/accuracy.ts`, `web/src/engine/sim/ai/aiAbilityHelpers.ts`, `web/src/engine/sim/ai/aiCheckBadMove.ts`, `web/src/engine/sim/ai/aiCheckViability.ts`, `web/src/engine/sim/endTurn.ts`, `web/src/engine/sim/statusEffects.ts`, `web/src/engine/sim/turn.ts` |
| `chloroplast` | Yes | `web/src/engine/basePower.ts`, `web/src/engine/multiHit.ts`, `web/src/engine/sim/ai/aiCheckBadMove.ts`, `web/src/engine/sim/ai/aiCheckViability.ts`, `web/src/engine/sim/moveEffects.ts` |
| `coilUp` | Yes | `web/src/engine/sim/moveEffects.ts` |
| `cutthroat` | No | *(not read by sim or engine code)* |
| `foesMinRoll` | Yes | `web/src/engine/abilities/impl/17-crit-swapsplit-misc.ts`, `web/src/engine/abilities/impl/39-normalize-superconductor.ts`, `web/src/engine/abilities/types.ts` |
| `fortKnox` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/15-ate-family-and-onstab.ts`, `web/src/engine/abilities/types.ts` |
| `grappler` | Yes | `web/src/engine/sim/driver/expectimax.ts`, `web/src/engine/sim/endTurn.ts`, `web/src/engine/sim/moveEnd.ts` |
| `hailImmune` | Yes | `web/src/engine/abilities/impl/05-ate-abilities.ts`, `web/src/engine/sim/fieldEndTurn.ts` |
| `halfRecoil` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/sim/ai/aiCheckBadMove.ts`, `web/src/engine/sim/driver/moveInventory.ts`, `web/src/engine/sim/moveEnd.ts`, `web/src/engine/sim/turn.ts` |
| `isSoundproof` | Yes | `web/src/engine/sim/ai/aiAbilityHelpers.ts`, `web/src/engine/sim/ai/aiCheckBadMove.ts`, `web/src/engine/sim/moveEffects.ts`, `web/src/engine/sim/turn.ts` |
| `levitate` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/01-offensive-multiplier-a.ts`, `web/src/engine/abilities/impl/06-offensive-multiplier-c.ts`, `web/src/engine/abilities/impl/10-aliases.ts`, `web/src/engine/abilities/impl/12-adds-type.ts`, `web/src/engine/abilities/impl/18-offensive-multiplier-e.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/calculate.ts`, `web/src/engine/sim/grounding.ts` |
| `magicBounce` | No | *(not read by sim or engine code)* |
| `magicGuard` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/26-immune.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/sim/driver/expectimax.ts`, `web/src/engine/sim/endTurn.ts` |
| `megaLauncherBoost` | Yes | `web/src/engine/abilities/types.ts`, `web/src/engine/sim/moveEffects.ts` |
| `mirrorArmor` | Yes | `web/src/engine/sim/hazards.ts` |
| `negatesBurnAtkDrop` | Yes | `web/src/engine/abilities/types.ts`, `web/src/engine/sim/ai/aiCheckViability.ts`, `web/src/engine/sim/driver/expectimax.ts`, `web/src/engine/stats.ts` |
| `negatesFrzSpatkDrop` | Yes | `web/src/engine/abilities/types.ts`, `web/src/engine/sim/ai/aiCheckViability.ts`, `web/src/engine/sim/driver/expectimax.ts` |
| `noBurnDamage` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/02-defensive-multiplier-a.ts`, `web/src/engine/abilities/impl/10-aliases.ts`, `web/src/engine/abilities/impl/13-defensive-multiplier-c.ts`, `web/src/engine/abilities/impl/14-on-stat-a.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/sim/endTurn.ts` |
| `noDamageHits` | Yes | `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/sim/switchInAbility.ts` |
| `noRecoil` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/10-aliases.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/sim/ai/aiCheckBadMove.ts`, `web/src/engine/sim/moveEnd.ts`, `web/src/engine/sim/turn.ts` |
| `omniStab` | Yes | `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/05-ate-abilities.ts`, `web/src/engine/abilities/impl/11-offensive-multiplier-d.ts`, `web/src/engine/abilities/impl/15-ate-family-and-onstab.ts`, `web/src/engine/abilities/types.ts` |
| `persistent` | Yes | `web/src/engine/abilities/impl/13-defensive-multiplier-c.ts`, `web/src/engine/abilities/impl/14-on-stat-a.ts`, `web/src/engine/abilities/impl/17-crit-swapsplit-misc.ts`, `web/src/engine/abilities/impl/29-ability-activation.ts`, `web/src/engine/abilities/impl/36-avenger-blood-stigma.ts`, `web/src/engine/sim/ai/aiAbilityHelpers.ts`, `web/src/engine/sim/ai/aiPipeline.ts` |
| `pollinateImmunities` | Yes | `web/src/engine/sim/attackCanceller.ts`, `web/src/engine/sim/statusEffects.ts` |
| `powderImmune` | Yes | `web/src/engine/sim/attackCanceller.ts`, `web/src/engine/sim/statusEffects.ts` |
| `randomizerBanned` | No | *(not read by sim or engine code)* |
| `redirectType` | No | *(not read by sim or engine code)* |
| `removesStatusOnImmunity` | Yes | `web/src/engine/sim/moveEnd.ts`, `web/src/engine/sim/statusEffects.ts` |
| `resistsFortKnox` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/08-swarm-family.ts`, `web/src/engine/abilities/impl/15-ate-family-and-onstab.ts`, `web/src/engine/abilities/impl/24-parental-bond.ts`, `web/src/engine/abilities/types.ts` |
| `ripen` | Yes | `web/src/engine/calculate.ts`, `web/src/engine/sim/accuracy.ts`, `web/src/engine/sim/ai/aiCheckViability.ts`, `web/src/engine/sim/moveEffects.ts` |
| `ruinStat` | Yes | `web/src/engine/abilities/impl/14-on-stat-a.ts`, `web/src/engine/abilities/types.ts` |
| `sandImmune` | Yes | `web/src/engine/sim/driver/expectimax.ts`, `web/src/engine/sim/fieldEndTurn.ts` |
| `setStateOnEffect` | Yes | `web/src/engine/sim/statBuffs.ts`, `web/src/engine/sim/statusEffects.ts` |
| `shadowTag` | Yes | `web/src/engine/sim/escape.ts` |
| `skillLink` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/10-aliases.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/calculate.ts` |
| `steadfast` | No | *(not read by sim or engine code)* |
| `stealthRockImmune` | Yes | `web/src/engine/sim/hazards.ts` |
| `stickyHold` | No | *(not read by sim or engine code)* |
| `suctionCups` | Yes | `web/src/engine/sim/ai/aiCheckBadMove.ts`, `web/src/engine/sim/moveEffects.ts` |
| `tauntImmune` | Yes | `web/src/engine/sim/switchInAbility.ts` |
| `tectonizeImmunities` | Yes | `web/src/engine/sim/hazards.ts` |
| `toxicTerrainImmune` | Yes | `web/src/engine/sim/fieldEndTurn.ts` |
| `unaware` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/10-aliases.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/battleStat.ts`, `web/src/engine/calculate.ts`, `web/src/engine/sim/accuracy.ts`, `web/src/engine/sim/ai/aiCheckViability.ts`, `web/src/engine/sim/moveEffects.ts` |
| `unnerve` | Yes | `web/src/engine/calculate.ts`, `web/src/engine/sim/statBuffs.ts` |
| `unsuppressable` | Yes | `web/src/engine/sim/ai/aiAbilityHelpers.ts` |

### Complete List of 36 Bitfield-Only Abilities

- `ABILITY_ADAPTABILITY` (src/abilities.cc:1539): adaptability
- `ABILITY_BAD_COMPANY` (src/abilities.cc:4660): randomizerBanned
- `ABILITY_CHEEK_POUCH` (src/abilities.cc:2326): randomizerBanned
- `ABILITY_CHLOROPLAST` (src/abilities.cc:3650): chloroplast
- `ABILITY_CONJOURER_OF_DECEIT` (src/abilities.cc:9362): breakable, magicBounce, magicGuard
- `ABILITY_CONTRARY` (src/abilities.cc:1890): breakable
- `ABILITY_DESOLATE_SUN` (src/abilities.cc:9189): randomizerBanned
- `ABILITY_EJECT_PACK_ABILITY` (src/abilities.cc:7183): persistent
- `ABILITY_FORT_KNOX` (src/abilities.cc:4410): fortKnox
- `ABILITY_FRIEND_GUARD` (src/abilities.cc:1945): breakable
- `ABILITY_GRAPPLER` (src/abilities.cc:11996): grappler
- `ABILITY_GUARD_DOG` (src/abilities.cc:758): breakable, suctionCups
- `ABILITY_IMMOVABLE_OBJECT` (src/abilities.cc:9645): magicGuard
- `ABILITY_IMPENETRABLE` (src/abilities.cc:4215): magicGuard
- `ABILITY_MAGIC_BOUNCE` (src/abilities.cc:2227): breakable, magicBounce
- `ABILITY_MAGIC_GUARD` (src/abilities.cc:1606): magicGuard
- `ABILITY_MIRROR_ARMOR` (src/abilities.cc:3256): breakable, mirrorArmor
- `ABILITY_MULTITYPE` (src/abilities.cc:1851): randomizerBanned, unsuppressable
- `ABILITY_NEUTRALIZING_GAS` (src/abilities.cc:3526): unsuppressable
- `ABILITY_NONE` (src/abilities.cc:479): randomizerBanned
- `ABILITY_OVERZEALOUS` (src/abilities.cc:10029): randomizerBanned
- `ABILITY_POISON_HEAL` (src/abilities.cc:496): toxicTerrainImmune
- `ABILITY_RELIC_STONE` (src/abilities.cc:10479): breakable
- `ABILITY_RIPEN` (src/abilities.cc:12279): ripen
- `ABILITY_ROCK_HEAD` (src/abilities.cc:1325): breakable, noRecoil, removesStatusOnImmunity
- `ABILITY_SHIELD_DUST` (src/abilities.cc:735): breakable, powderImmune
- `ABILITY_SKILL_LINK` (src/abilities.cc:1544): skillLink
- `ABILITY_STEADFAST` (src/abilities.cc:11745): steadfast
- `ABILITY_STEEL_BARREL` (src/abilities.cc:5000): noRecoil, removesStatusOnImmunity
- `ABILITY_STICKY_HOLD` (src/abilities.cc:1272): breakable, stickyHold
- `ABILITY_STURDY` (src/abilities.cc:560): breakable
- `ABILITY_SUCTION_CUPS` (src/abilities.cc:752): breakable, suctionCups
- `ABILITY_SUPERHEAVY` (src/abilities.cc:11750): steadfast, suctionCups
- `ABILITY_SURVIVOR_BIAS` (src/abilities.cc:12307): breakable
- `ABILITY_UNAWARE` (src/abilities.cc:1719): breakable, unaware
- `ABILITY_WONDER_SKIN` (src/abilities.cc:2132): fortKnox
