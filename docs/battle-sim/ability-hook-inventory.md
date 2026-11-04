# Ability Hook Completeness Inventory

Static completeness audit of all ability hooks defined in `data/v2.65beta/abilityHooks.json` against the battle simulator and damage engine implementations.

- **Source Commit (eliteredux-source)**: `bdebcbbff9760cdd41a02c425bea4857fa0eee26` (game version `v2.65beta`)
- **Source Commit (er-config)**: `1b8e2cc4a8096d7ec90616f87fbf771bfa732447`
- **Regeneration Command**: `SIM_INVENTORY_WRITE=1 npm --prefix web test -- --run src/engine/sim/driver/abilityHookInventory.test.ts`

## Classification Method per Hook Kind

A `(ability, hook)` pair is classified as **ported** only when an explicit registry entry or case branch handles that exact ability and hook (or transitively through its `form: "alias"` target). Below are the detection mechanisms per hook kind:

1. **Calc-side hooks (19 kinds)**: Checked via `lookupAbility(id)` in `web/src/engine/abilities/registry.ts` (populated by `web/src/engine/abilities/impl/index.ts`). Ported iff `!isUnmodelled(entry)` and `typeof entry[hook] === "function"`.
   - `onOffensiveMultiplier`, `onDefensiveMultiplier`, `onStat`, `onStab`, `onCrit`, `onTypeEffectiveness`, `onAfterTypeEffectiveness`, `onChooseOffensiveStat`, `onChooseDefensiveStat`, `onSwapSplit`, `onMoveType`, `onRecoil`, `onPriority`, `onMoldBreaker`, `onParentalBond`, `onAbsorb`, `onImmune`, `onInfiltrate`, `onModifyMoveFlags`.
2. **onAttacker**: Membership in exported `PORTED_ATTACKER_ABILITIES` (`web/src/engine/sim/moveEnd.ts`).
3. **onDefender**: Membership in exported `PORTED_DEFENDER_ABILITIES` (`web/src/engine/sim/moveEnd.ts`).
4. **onEntry**: Handled across weather/terrain/entry-move/intimidate/announce dispatch in `applySwitchInAbilities` (`web/src/engine/sim/switchInAbility.ts`), catalogued by exported `SWITCH_IN_ABILITY_IDS`.
5. **onEndTurn**: `runEndTurnAbilities` switch cases in `web/src/engine/sim/endTurn.ts`.
6. **onAccuracy**: Cases in `runAttackerAbilityHook` and `runDefenderAbilityHook` in `web/src/engine/sim/accuracy.ts`.
7. **onBattlerFaints**: Dispatched in `web/src/engine/sim/moveEnd.ts` (`dispatchOnBattlerFaints`): `ABILITY_STRIKEOUT`, `SET_STATE_ON_EFFECT_ABILITIES` (`web/src/engine/sim/statusEffects.ts`), keys of `KO_STAT_RAISES`, `KO_SOUL_EATER_ABILITIES`, `KO_JAWS_OF_CARNAGE_ABILITIES`, and `KO_CRIT_BOOST_ABILITIES`. All other `ON_BATTLER_FAINTS_ABILITIES` hit the unmodelled note.
8. **onBeforeAttack**: Not ported (no handler in `web/src/engine/`).
9. **onBlockStatDrops**: Membership in exported `STAT_DROP_BLOCK_ABILITIES` (`web/src/engine/sim/statBuffs.ts`).
10. **onCanStatusType**: Membership in exported `CAN_STATUS_TYPE_ABILITIES` (`web/src/engine/sim/statusEffects.ts`).
11. **onCopyMove**: Not ported (gapped in `web/src/engine/sim/moveEnd.ts`).
12. **onDisguise**: Not ported (bust handler not modelled; note in `web/src/engine/sim/moveEnd.ts`).
13. **onExit**: Membership in exported `SWITCH_OUT_HOOK_ABILITIES` (`web/src/engine/sim/turn.ts`).
14. **onModifyEffectChance**: Membership in exported `ON_MODIFY_EFFECT_CHANCE_ABILITIES` (`web/src/engine/sim/statusEffects.ts`).
15. **onModifyTargetFlag**: Handled in `getBattlerBattleMoveTargetFlags` (`web/src/engine/sim/moveTargetFlags.ts`).
16. **onPreemptAction**: Cases in `tryPreemptiveActions` (`web/src/engine/sim/preempt.ts`).
17. **onReactive**: Handled in `runReactiveAbilityEffects` (`web/src/engine/sim/statBuffs.ts`): `POISON_PUPPETEER_CLONE_ABILITIES` (`SET_STATE_ON_EFFECT_ABILITIES`), `ABILITY_EGOIST`, `ABILITY_SHARING_IS_CARING`, `ABILITY_ACID_REFLUX`.
18. **onRevive**: Handled in `latchRecurringNightmareOnFaint` (`web/src/engine/sim/turn.ts`, `ABILITY_RECURRING_NIGHTMARE`).
19. **onStatLowered**: Membership in exported `ON_STAT_LOWERED_ABILITIES` (`web/src/engine/sim/ai/aiCheckBadMove.ts`), implemented in `ON_STAT_LOWERED_HOOKS` (`web/src/engine/sim/statBuffs.ts`).
20. **onStatusImmune**: Membership in exported `STATUS_IMMUNE_ABILITIES` (`web/src/engine/sim/statusEffects.ts`).
21. **onTerrain**: Cases in `dispatchOnTerrainChange` (`web/src/engine/sim/onWeather.ts`).
22. **onTrap**: Membership in exported `TRAPPING_ABILITIES` (`web/src/engine/sim/escape.ts`).
23. **onWeather**: Cases in `dispatchOnWeatherChange` (`web/src/engine/sim/onWeather.ts`).

## Hook Completeness Summary

| Hook Kind | Defined | Ported | Unported | Unclassified | Mentioned in Tests |
| :--- | :--- | :--- | :--- | :--- | :--- |
| onAbsorb | 22 | 22 | 0 | 0 | 22 |
| onAccuracy | 50 | 50 | 0 | 0 | 50 |
| onAfterTypeEffectiveness | 13 | 13 | 0 | 0 | 13 |
| onAttacker | 144 | 144 | 0 | 0 | 144 |
| onBattlerFaints | 55 | 38 | 17 | 0 | 32 |
| onBeforeAttack | 9 | 0 | 9 | 0 | 3 |
| onBlockStatDrops | 11 | 11 | 0 | 0 | 9 |
| onCanStatusType | 8 | 8 | 0 | 0 | 6 |
| onChooseDefensiveStat | 11 | 11 | 0 | 0 | 10 |
| onChooseOffensiveStat | 20 | 20 | 0 | 0 | 19 |
| onCopyMove | 4 | 0 | 4 | 0 | 1 |
| onCrit | 31 | 31 | 0 | 0 | 26 |
| onDefender | 122 | 122 | 0 | 0 | 122 |
| onDefensiveMultiplier | 102 | 102 | 0 | 0 | 82 |
| onDisguise | 3 | 0 | 3 | 0 | 2 |
| onEndTurn | 67 | 67 | 0 | 0 | 64 |
| onEntry | 225 | 225 | 0 | 0 | 207 |
| onExit | 12 | 12 | 0 | 0 | 11 |
| onImmune | 19 | 19 | 0 | 0 | 19 |
| onInfiltrate | 10 | 10 | 0 | 0 | 10 |
| onModifyEffectChance | 13 | 13 | 0 | 0 | 12 |
| onModifyMoveFlags | 10 | 10 | 0 | 0 | 10 |
| onModifyTargetFlag | 7 | 7 | 0 | 0 | 7 |
| onMoldBreaker | 10 | 10 | 0 | 0 | 10 |
| onMoveType | 42 | 42 | 0 | 0 | 42 |
| onOffensiveMultiplier | 199 | 199 | 0 | 0 | 173 |
| onParentalBond | 23 | 23 | 0 | 0 | 23 |
| onPreemptAction | 5 | 5 | 0 | 0 | 5 |
| onPriority | 19 | 12 | 7 | 0 | 13 |
| onReactive | 18 | 13 | 5 | 0 | 10 |
| onRecoil | 5 | 1 | 4 | 0 | 5 |
| onRevive | 2 | 1 | 1 | 0 | 1 |
| onStab | 44 | 44 | 0 | 0 | 43 |
| onStat | 63 | 62 | 1 | 0 | 58 |
| onStatLowered | 11 | 11 | 0 | 0 | 8 |
| onStatusImmune | 40 | 40 | 0 | 0 | 36 |
| onSwapSplit | 7 | 7 | 0 | 0 | 7 |
| onTerrain | 7 | 4 | 3 | 0 | 6 |
| onTrap | 5 | 5 | 0 | 0 | 5 |
| onTypeEffectiveness | 22 | 22 | 0 | 0 | 17 |
| onWeather | 8 | 8 | 0 | 0 | 7 |
| **Total** | **1498** | **1444** | **54** | **0** | **1350** |

## Unported Ability Hook Pairs

Grouped by hook kind, sorted alphabetically. Source lines cite `pipeline/.upstream/eliteredux-source/src/abilities.cc`.

### onBattlerFaints (17)

- `ABILITY_BATTLE_BOND` (src/abilities.cc:2889)
- `ABILITY_BERSERKER_RAGE` (src/abilities.cc:6236) *(mentioned in test)*
- `ABILITY_BLOODLUST` (src/abilities.cc:7995)
- `ABILITY_COMMANDER` (src/abilities.cc:7163) *(mentioned in test)*
- `ABILITY_DRAGONS_RITUAL` (src/abilities.cc:8677)
- `ABILITY_DRAKE_OF_RAGE` (src/abilities.cc:9891)
- `ABILITY_EDGELORD` (src/abilities.cc:10747) *(mentioned in test)*
- `ABILITY_ENERGIZED` (src/abilities.cc:8721) *(mentioned in test)*
- `ABILITY_GOING_BERSERK` (src/abilities.cc:12143) *(mentioned in test)*
- `ABILITY_MASTER_HAND` (src/abilities.cc:8512) *(mentioned in test)*
- `ABILITY_POWER_OF_ALCHEMY` (src/abilities.cc:3077) *(mentioned in test)*
- `ABILITY_QIGONG` (src/abilities.cc:9352) *(mentioned in test)*
- `ABILITY_RAGING_GODDESS` (src/abilities.cc:8935) *(mentioned in test)*
- `ABILITY_RAMPAGE` (src/abilities.cc:3709) *(mentioned in test)*
- `ABILITY_RECEIVER` (src/abilities.cc:3058) *(mentioned in test)*
- `ABILITY_SIDEWINDER` (src/abilities.cc:8424) *(mentioned in test)*
- `ABILITY_SUPER_STRAIN` (src/abilities.cc:6316) *(mentioned in test)*

### onBeforeAttack (9)

- `ABILITY_COLOR_CHANGE` (src/abilities.cc:680)
- `ABILITY_DNA_SCRAMBLE` (src/abilities.cc:9657)
- `ABILITY_FLAMMABLE_COAT` (src/abilities.cc:8320) *(mentioned in test)*
- `ABILITY_LIBERO` (src/abilities.cc:3236)
- `ABILITY_PATTERN_CHANGE` (src/abilities.cc:8300) *(mentioned in test)*
- `ABILITY_PRISMATIC_FUR` (src/abilities.cc:5705) *(mentioned in test)*
- `ABILITY_PROTEAN` (src/abilities.cc:2331)
- `ABILITY_RKS_SYSTEM` (src/abilities.cc:3135)
- `ABILITY_STANCE_CHANGE` (src/abilities.cc:2396)

### onCopyMove (4)

- `ABILITY_DANCER` (src/abilities.cc:3008)
- `ABILITY_LUNAR_AFFINITY` (src/abilities.cc:8855)
- `ABILITY_PARROTING` (src/abilities.cc:6880) *(mentioned in test)*
- `ABILITY_SAMBA` (src/abilities.cc:9406)

### onDisguise (3)

- `ABILITY_DISGUISE` (src/abilities.cc:2869) *(mentioned in test)*
- `ABILITY_ICE_FACE` (src/abilities.cc:3362)
- `ABILITY_PATCHWORK` (src/abilities.cc:8636) *(mentioned in test)*

### onPriority (7)

- `ABILITY_CUTE_ANTECEDENCE` (src/abilities.cc:7891)
- `ABILITY_DARK_GALE_WINGS` (src/abilities.cc:7103)
- `ABILITY_FROZEN_SOUL` (src/abilities.cc:4614)
- `ABILITY_GALEFORCE_WINGS` (src/abilities.cc:11251)
- `ABILITY_IRON_BARRAGE` (src/abilities.cc:4992) *(mentioned in test)*
- `ABILITY_PRESTO` (src/abilities.cc:9397)
- `ABILITY_SIGHTING_SYSTEM` (src/abilities.cc:4650) *(mentioned in test)*

### onReactive (5)

- `ABILITY_GREEDY` (src/abilities.cc:11066)
- `ABILITY_HARUKAZE` (src/abilities.cc:10100)
- `ABILITY_MENTAL_POLLUTION` (src/abilities.cc:12118)
- `ABILITY_POWER_OF_ALCHEMY` (src/abilities.cc:3077) *(mentioned in test)*
- `ABILITY_RETRIBUTION_BLOW` (src/abilities.cc:5145) *(mentioned in test)*

### onRecoil (4)

- `ABILITY_DOOM_BLAST` (src/abilities.cc:9296) *(mentioned in test)*
- `ABILITY_DUAL_SHADOW` (src/abilities.cc:9566) *(mentioned in test)*
- `ABILITY_ELECTRIC_BURST` (src/abilities.cc:4336) *(mentioned in test)*
- `ABILITY_INFERNAL_RAGE` (src/abilities.cc:5473) *(mentioned in test)*

### onRevive (1)

- `ABILITY_BACKUP_POWER` (src/abilities.cc:10929)

### onStat (1)

- `ABILITY_AERILATE` (src/abilities.cc:2502) *(mentioned in test)*

### onTerrain (3)

- `ABILITY_ENERGIZED` (src/abilities.cc:8721) *(mentioned in test)*
- `ABILITY_GENERATOR` (src/abilities.cc:6174) *(mentioned in test)*
- `ABILITY_HARUKAZE` (src/abilities.cc:10100)

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
| `breakable` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/01-offensive-multiplier-a.ts`, `web/src/engine/abilities/impl/02-defensive-multiplier-a.ts`, `web/src/engine/abilities/impl/05-ate-abilities.ts`, `web/src/engine/abilities/impl/06-offensive-multiplier-c.ts`, `web/src/engine/abilities/impl/07-defensive-multiplier-b.ts`, `web/src/engine/abilities/impl/09-hub-abilities.ts`, `web/src/engine/abilities/impl/10-aliases.ts`, `web/src/engine/abilities/impl/11-offensive-multiplier-d.ts`, `web/src/engine/abilities/impl/12-adds-type.ts`, `web/src/engine/abilities/impl/13-defensive-multiplier-c.ts`, `web/src/engine/abilities/impl/14-on-stat-a.ts`, `web/src/engine/abilities/impl/15-ate-family-and-onstab.ts`, `web/src/engine/abilities/impl/16-type-effectiveness.ts`, `web/src/engine/abilities/impl/17-crit-swapsplit-misc.ts`, `web/src/engine/abilities/impl/18-offensive-multiplier-e.ts`, `web/src/engine/abilities/impl/25-absorb.ts`, `web/src/engine/abilities/impl/26-immune.ts`, `web/src/engine/abilities/impl/30-secondary-stat-blend.ts`, `web/src/engine/abilities/impl/32-rivalry.ts`, `web/src/engine/abilities/impl/34-fainted-count.ts`, `web/src/engine/abilities/impl/37-pretty-princess.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/calculate.ts`, `web/src/engine/sim/accuracy.ts`, `web/src/engine/sim/ai/aiAbilityHelpers.ts`, `web/src/engine/sim/ai/aiCheckBadMove.ts`, `web/src/engine/sim/ai/aiCheckViability.ts`, `web/src/engine/sim/statusEffects.ts` |
| `chloroplast` | Yes | `web/src/engine/basePower.ts`, `web/src/engine/multiHit.ts`, `web/src/engine/sim/ai/aiCheckBadMove.ts`, `web/src/engine/sim/ai/aiCheckViability.ts`, `web/src/engine/sim/moveEffects.ts` |
| `coilUp` | Yes | `web/src/engine/sim/moveEffects.ts` |
| `cutthroat` | No | *(not read by sim or engine code)* |
| `foesMinRoll` | Yes | `web/src/engine/abilities/impl/17-crit-swapsplit-misc.ts`, `web/src/engine/abilities/impl/39-normalize-superconductor.ts`, `web/src/engine/abilities/types.ts` |
| `fortKnox` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/impl/15-ate-family-and-onstab.ts`, `web/src/engine/abilities/types.ts` |
| `grappler` | Yes | `web/src/engine/sim/driver/expectimax.ts`, `web/src/engine/sim/endTurn.ts`, `web/src/engine/sim/moveEnd.ts` |
| `hailImmune` | Yes | `web/src/engine/abilities/impl/05-ate-abilities.ts`, `web/src/engine/sim/fieldEndTurn.ts` |
| `halfRecoil` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/abilities/impl/00-flags.ts`, `web/src/engine/abilities/types.ts`, `web/src/engine/sim/ai/aiCheckBadMove.ts`, `web/src/engine/sim/moveEnd.ts`, `web/src/engine/sim/turn.ts` |
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
