// Cmd_moveend ladder skeleton, recoil, Life Orb, Rocky Helmet, last-move bookkeeping.
// Source: src/battle_script_commands.c:4309-4968 and include/constants/battle_script_commands.h:337-368.
//
// The Cmd_moveend state machine executes sequentially from MOVEEND_SUM_DAMAGE (0)
// through MOVEEND_CLEAR_BITS (30) up to MOVEEND_COUNT (31).
//
// Enum-ordered classification table (all 31 cases, 0 to 30):
// --------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Step | Enum Constant                   | C Lines    | Classification | Rationale / Behavior
// -----+---------------------------------+------------+----------------+----------------------------------------------------------------------------------------------
//  0   | MOVEEND_SUM_DAMAGE              | 4334-4342  | Unreachable    | Multi-strike damage summing; sim damage resolver returns final totalDamage already.
//  1   | MOVEEND_PROTECT_LIKE_EFFECT     | 4343-4433  | Delegated      | Already ported in turn.ts (handleProtectLikeMoveEnd); called here in enum order.
//  2   | MOVEEND_RAGE                    | 4434-4443  | Gapped (cond.) | Target Rage attack raise; STATUS2_RAGE is not in state.ts.
//  3   | MOVEEND_SYNCHRONIZE_TARGET      | 4523-4526  | Gapped (cond.) | Target Synchronize on status application; gapped if target has ABILITY_SYNCHRONIZE & status.
//  4   | MOVEEND_DANCER                  | 4854-4879  | Gapped (cond.) | Dancer copying dance moves; gapped if danceBased move and other battler has ABILITY_DANCER.
//  5   | MOVEEND_ABILITIES               | 4527-4531  | Ported / Gap   | Target contact abilities (Rough Skin, Static, Flame Body, Poison Point, Effect Spore, Gooey). Other defender abilities gapped.
//  6   | MOVEEND_ABILITIES_ATTACKER      | 4532-4536  | Ported / Gap   | Attacker contact abilities (Static, Flame Body, Poison Point/Touch). Other attacker abilities gapped.
//  7   | MOVEEND_STATUS_IMMUNITY_ABILITIES 4537-4542  | Ported         | Re-checks every battler's status after the move; a removesStatusOnImmunity onStatusImmune ability cures it (battle_util.c:4505-4609), re-entering until a full pass cures nothing.
//  8   | MOVEEND_SYNCHRONIZE_ATTACKER    | 4543-4546  | Gapped (cond.) | Attacker Synchronize.
//  9   | MOVEEND_CHOICE_MOVE             | 4547-4568  | Unreachable    | Choice item move lock; choicedMove array is not in BattlerState.
// 10   | MOVEEND_ATTACKER_INVISIBLE      | 4677-4686  | Unreachable    | Semi-invulnerable sprite invisibility; visual only.
// 11   | MOVEEND_ATTACKER_VISIBLE        | 4687-4701  | Unreachable    | Semi-invulnerable sprite visibility; visual only.
// 12   | MOVEEND_TARGET_VISIBLE          | 4702-4713  | Unreachable    | Target sprite visibility; visual only.
// 13   | MOVEEND_ITEM_EFFECTS_TARGET     | 4569-4572  | Ported / Gap   | Ported: Rocky Helmet, Air Balloon, Weakness Policy. Other target items gapped.
// 14   | MOVEEND_ITEM_EFFECTS_ALL        | 4666-4671  | Ported         | Ported: White Herb, Lum/status berries, Sitrus, Oran, pinch stat/confuse berries.
// 15   | MOVEEND_KINGSROCK               | 4672-4676  | Ported / Gap   | Ported: King's Rock / Razor Fang flinch (battle_util.c:6034-6052). Blunder Policy (:6053-6061) gapped; multi-hit moves gapped.
// 16   | MOVEEND_SUBSTITUTE              | 4714-4722  | Ported         | Clears STATUS2_SUBSTITUTE and sets substituteDestroyedThisTurn if substituteHp is 0.
// 17   | MOVEEND_UPDATE_LAST_MOVES       | 4723-4772  | Ported         | Updates lastMove, lastResultingMove, lastPrintedMove, lastUsedMove, lastHitBy, lastLandedMove, lastHitByType (:4735-4772).
// 18   | MOVEEND_MIRROR_MOVE             | 4773-4781  | Ported         | Updates lastTakenMove, lastTakenMoveFrom (:4773-4781).
// 19   | MOVEEND_MULTIHIT_MOVE           | 4880-4921  | Unreachable    | Multi-hit loop; resolved upstream in calculateMoveDamage / attackCanceller.
// 20   | MOVEEND_MOVE_EFFECTS2_ON_EACH   | 4573-4632  | Ported / Gap   | Ported: Knock Off (:4268-4288), Thief (:4579-4593), Bug Bite (:4595-4597, EatTargetBerry :13221) minus the berry's own effect (gapped), Smack Down (:4598-4606).
// 21   | MOVEEND_NEXT_TARGET             | 4782-4822  | Unreachable    | Double battle second target iteration; sim is single battle.
// 22   | MOVEEND_MOVE_EFFECTS2           | 4633-4655  | Gapped (cond.) | Post-target-item move effects (Make It Rain, Burn Up, Scale Shot, Wyrm Wind).
// 23   | MOVEEND_RECOIL                  | 4457-4517  | Ported         | Recoil self-damage; Magic Guard, noRecoil (Rock Head/Steel Barrel/Bruteforce), halfRecoil.
// 24   | MOVEEND_CHARGE                  | 4922-4933  | Ported         | Clears STATUS3_CHARGED_UP on Electric damaging move.
// 25   | MOVEEND_ABILITIES_AFTER_RECOIL  | 4518-4522  | Gapped (cond.) | ABILITYEFFECT_AFTER_RECOIL hook.
// 26   | MOVEEND_LIFEORB_SHELLBELL       | 4823-4827  | Ported         | Life Orb (floor(maxHp/10) self-damage, Sheer Force/Magic Guard checks), Shell Bell (savedDmg/4, min 1), and Throat Spray (+1 SpAtk on sound move).
// 27   | MOVEEND_CHANGED_ITEMS           | 4656-4665  | Ported         | Assigns the stolen item Thief parked in changedItems at Case 20.
// 28   | MOVEEND_DEFROST                 | 4444-4456  | Unreachable    | Frostbite cured by fire move on target.
// 29   | MOVEEND_PICKPOCKET              | 4828-4853  | Gapped (cond.) | Pickpocket item theft; gapped if target has ABILITY_PICKPOCKET.
// 30   | MOVEEND_CLEAR_BITS              | 4934-4957  | Ported         | Clears rolloutCounter (if not Rollout), targetAffected, gemBoost, berryReduced.
// --------------------------------------------------------------------------------------------------------------------------------------------------------------------

import type { MoveBehaviors } from '../basePower'
import type { BattleState, BattlerState } from './state'
import {
  BATTLE_TYPE_ARENA,
  BATTLE_TYPE_TRAINER,
  DEFAULT_STAT_STAGE,
  ENUM_WEATHER_FOG,
  ENUM_WEATHER_HAIL,
  ENUM_WEATHER_SANDSTORM,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  MOVE_UNSET,
  SIDE_STATUS_CRAFTY_SHIELD,
  SIDE_STATUS_MAT_BLOCK,
  SIDE_STATUS_HAZARDS_ANY,
  SIDE_STATUS_SCREEN_ANY,
  SIDE_STATUS_SMOKESCREEN,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TOXIC_SPIKES,
  SIDE_STATUS_WIDE_GUARD,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON_ANY,
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
  STATUS2_NIGHTMARE,
  STATUS2_CURSED,
  STATUS2_ENRAGED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_FLINCHED,
  STATUS2_INFATUATION,
  STATUS2_MULTIPLETURNS,
  STATUS2_SUBSTITUTE,
  STATUS2_TORMENT,
  STATUS2_TRANSFORMED,
  STATUS2_WRAPPED,
  STATUS3_CHARGED_UP,
  STATUS3_EMBARGO,
  STATUS3_GASTRO_ACID,
  STATUS3_LEECHSEED,
  STATUS3_MAGNET_RISE,
  STATUS3_ME_FIRST,
  STATUS3_ON_AIR,
  STATUS3_PERISH_SONG,
  STATUS3_SMACKED_DOWN,
  STATUS3_TELEKINESIS,
  STATUS3_UNDERWATER,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  WEATHER_FOG_ANY,
  WEATHER_HAIL_ANY,
  WEATHER_PRIMAL_ANY,
  WEATHER_SANDSTORM_ANY,
  MOVE_EFFECT_WRAP,
  STATUS1_ANY,
  STATUS4_FEAR,
  clearFlag,
  hasFlag,
  setFlag,
  statusInfatuatedWith,
  STATUS2_LOCK_CONFUSE,
  getCounter,
} from './constants'
import { hasFlag as abilitySlotsHaveFlag, isIronFistBoosted, resolveEffectiveMoveType } from '../abilities/dispatchCalc'
import { battlerHasAbility } from '../abilities/dispatch'
import { cancelMultiTurnMoves, findAbilitySlot } from './statusEffects'
import type { AbilitySlots } from '../abilities/dispatch'
import { canBattlerHeal, getAbilityStateOf, isMagicGuardProtected, strikeoutClearFlags, strikeoutMarkDamagedBy } from './endTurn'
import { isBattlerGrounded } from './grounding'
import { syncPartyHp } from './outcome'
import { resolveMultihitType } from './attackCanceller'
import {
  CHECK_BLEED,
  CHECK_BURN,
  CHECK_CONFUSION,
  CHECK_FLINCH,
  CHECK_FROSTBITE,
  CHECK_INFATUATE,
  CHECK_NONE,
  CHECK_PARALYSIS,
  CHECK_POISON,
  CHECK_RESTRICTING,
  CHECK_SLEEP,
  MOVE_EFFECT_BLEED,
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_CONFUSION,
  MOVE_EFFECT_ENRAGE,
  MOVE_EFFECT_FLINCH,
  MOVE_EFFECT_FROSTBITE,
  MOVE_EFFECT_PARALYSIS,
  MOVE_EFFECT_POISON,
  MOVE_EFFECT_SLEEP,
  MOVE_EFFECT_TOXIC,
  SET_STATE_ON_EFFECT_ABILITIES,
  applyAttractEffect,
  applyDrenchEffect,
  applyFearEffect,
  applyPrimaryStatusEffect,
  canBeBurned,
  canBeConfused,
  canBeDrenched,
  canBeParalyzed,
  canBePoisoned,
  canBleed,
  canGetFrostbite,
  canInfatuate,
  canSleep,
  doesSubstituteBlockMove,
  findCureOnImmunityAbility,
  isAbilityStatusProtected,
  isKeenEdgeMove,
  isPowderImmune,
  isPreventableSecondaryEffect,
  isSoundMove,
  isStrikerMove,
  setOnMoveEffectReactionFlags,
  testSheerForceFlag,
} from './statusEffects'
import type { StatusDeps } from './statusEffects'
// Both moved to moveTargetFlags.ts so accuracyBridge.ts can reach
// getBattlerBattleMoveTargetFlags without closing an
// accuracyBridge -> moveEnd -> turn -> accuracyBridge runtime cycle. Re-exported
// below the import block so preempt.ts and cycle92FollowUps.test.ts keep their
// import paths.
import { getBattlerBattleMoveTargetFlags, isMegaLauncherBoostedMove } from './moveTargetFlags'
import {
  B_MSG_DEFENDER_STAT_FELL,
  MOVE_EFFECT_AFFECTS_USER,
  MOVE_EFFECT_CERTAIN,
  STAT_BUFF_ALLOW_PTR,
  STAT_BUFF_DONT_SET_BUFFERS,
  STAT_BUFF_NOT_PROTECT_AFFECTED,
  STAT_BUFF_UPDATE_MOVE_EFFECT,
  attackerHasMoldBreakerActive,
  battlerHasSimAbility,
  changeStatBuffs,
  changeStatBuffsImplicit,
  dispatchOnStatLowered,
  getHighestAttackingStatId,
  isSimAbilitySuppressed,
  isUnnerveAbilityOnOpposingSide,
  runReactiveAbilityEffects,
} from './statBuffs'
import { benefitsFromStatBuffs, isBattlerWeatherAffected } from './statBuffs'
import type { StatChangeOutcome, StatusAppliedOutcome, TurnLoopDeps } from './turn'
import { ProtectType, applyDamage, getMoveTarget, handleProtectLikeMoveEnd, isAbilityAliveOnOpposingSide, isBattlerAlive, isBattlerProtected } from './turn'
import type { SimDataContext, SimMoveData } from './dataContext'
import {
  applySwitchInAbilities,
  checkAndSetOncePerTurnAbility,
  disableSwitchInAbility,
  getOncePerTurnAbilityCounter,
  getSingleUseAbilityCounter,
  setOncePerTurnAbilityCounter,
  setSingleUseAbilityCounter,
  tryChangeBattleTerrain,
  tryChangeBattleWeather,
} from './switchInAbility'
import { dispatchOnTerrainChange, dispatchOnWeatherChange } from './onWeather'
import { HP_TRANSFORMATIONS, apeShiftHandler, changeBattlerForm } from './formChange'
import { TOTAL_SPEED_PRIMARY, getBattlerTotalSpeedStat } from './turnOrder'
import { attackPreModify, calculateBattleStat, defensePreModify, spAttackPreModify, spDefensePreModify } from '../battleStat'
import { TYPE_NAME_BY_ID } from './hazards'
import {
  canBattlerSwitch,
  doesBattlerHaveAbilityShield,
  hasAbilityIgnoringSuppression,
  tryScheduleSwitch,
  updateAbilityStateForNewAbility,
} from './moveEffects'
import { countUsablePartyMons, PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES } from './ai/aiAbilityHelpers'

export { getBattlerBattleMoveTargetFlags, isMegaLauncherBoostedMove }

// ---------------------------------------------------------------------------
// Pinned Ability Lists (derived strictly from abilityHooks.json)
// ---------------------------------------------------------------------------

// Quoted grep: grep -o '.\{1,50\}"noRecoil".\{1,50\}' data/v2.65beta/abilityHooks.json
// Matches ABILITY_BRUTEFORCE, ABILITY_ROCK_HEAD, ABILITY_STEEL_BARREL
export const NO_RECOIL_ABILITIES = new Set([
  'ABILITY_BRUTEFORCE',
  'ABILITY_ROCK_HEAD',
  'ABILITY_STEEL_BARREL',
])

// Quoted grep: grep -o '.\{1,50\}"halfRecoil".\{1,50\}' data/v2.65beta/abilityHooks.json
// Matches ABILITY_DAREDEVIL, ABILITY_LIMBER
export const HALF_RECOIL_ABILITIES = new Set([
  'ABILITY_DAREDEVIL',
  'ABILITY_LIMBER',
])

// Quoted grep: grep -oP '"onDefender".+?"id":"\KABILITY_[A-Z0-9_]+' data/v2.65beta/abilityHooks.json
export const ON_DEFENDER_ABILITIES = new Set([
  'ABILITY_AFTERMATH',
  'ABILITY_ANGER_POINT',
  'ABILITY_ANGER_SHELL',
  'ABILITY_APE_SHIFT',
  'ABILITY_ARC_FLASH',
  'ABILITY_ATOMIC_BURST',
  'ABILITY_BALLOON_BLITZ',
  'ABILITY_BALLOON_BOMBER',
  'ABILITY_BERSERK',
  'ABILITY_BERSERKER_RAGE',
  'ABILITY_BLIGHT_SCALE',
  'ABILITY_BLOOD_STAIN',
  'ABILITY_BRAIN_OVERLOAD',
  'ABILITY_CHILLING_PELLETS',
  'ABILITY_CHUCKSTER',
  'ABILITY_COLD_REBOUND',
  'ABILITY_COTTON_DOWN',
  'ABILITY_CRISPY_CREAM',
  'ABILITY_CROWNED_SHIELD',
  'ABILITY_CROWNED_SWORD',
  'ABILITY_CRYO_ARCHITECT',
  'ABILITY_CRYO_PROFICIENCY',
  'ABILITY_CURSED_BODY',
  'ABILITY_CUTE_CHARM',
  'ABILITY_DAMP',
  'ABILITY_DAYBREAK',
  'ABILITY_DEFLECT',
  'ABILITY_DOUBLE_IRON_BARBS',
  'ABILITY_DRAGONFRUIT',
  'ABILITY_DRAKELP_HEAD',
  'ABILITY_DROP_BLOCKS',
  'ABILITY_EFFECT_SPORE',
  'ABILITY_ELECTROMORPHOSIS',
  'ABILITY_EMERGENCY_EXIT',
  'ABILITY_FARADAY_CAGE',
  'ABILITY_FLAME_BODY',
  'ABILITY_FLAMMABLE_COAT',
  'ABILITY_FOG_MACHINE',
  'ABILITY_FORTITUDE',
  'ABILITY_FRAGRANT_DAZE',
  'ABILITY_FREEZING_POINT',
  'ABILITY_FURNACE',
  'ABILITY_GOING_BERSERK',
  'ABILITY_GOOEY',
  'ABILITY_GUILT_TRIP',
  'ABILITY_GULP_MISSILE',
  'ABILITY_HAUNTED_SPIRIT',
  'ABILITY_HYPNOTIC_TOUCH',
  'ABILITY_ICE_DOWNFALL',
  'ABILITY_ILLUSION',
  'ABILITY_ILL_WILL',
  'ABILITY_INFLATABLE',
  'ABILITY_INNARDS_OUT',
  'ABILITY_IRON_BARBS',
  'ABILITY_ITCHY_DEFENSE',
  'ABILITY_LINGERING_AROMA',
  'ABILITY_LOOSE_QUILLS',
  'ABILITY_LOOSE_ROCKS',
  'ABILITY_LOOSE_THORNS',
  'ABILITY_MAGICAL_DUST',
  'ABILITY_MALODOR',
  'ABILITY_MASSIVE_PELT',
  'ABILITY_MENACING_SITUATION',
  'ABILITY_MOUSTACHE',
  'ABILITY_MUCUS_MEMBRANE',
  'ABILITY_MUMMY',
  'ABILITY_NO_TURNING_BACK',
  'ABILITY_PARRY',
  'ABILITY_PATCHWORK',
  'ABILITY_PERISH_BODY',
  'ABILITY_PETAL_SHIELD',
  'ABILITY_POISON_POINT',
  'ABILITY_POISON_QUILLS',
  'ABILITY_POISON_TOUCH',
  'ABILITY_POWER_LEAK',
  'ABILITY_PRIM_AND_PROPER',
  'ABILITY_PURE_LOVE',
  'ABILITY_RAGE_POINT',
  'ABILITY_RATTLED',
  'ABILITY_RESILIENCE',
  'ABILITY_RESTRAINING_ORDER',
  'ABILITY_ROUGH_SKIN',
  'ABILITY_SAND_SPIT',
  'ABILITY_SCARECROW',
  'ABILITY_SCRAPYARD',
  'ABILITY_SEED_SOWER',
  'ABILITY_SHATTERED_ARMOR',
  'ABILITY_SLIME_MOLD',
  'ABILITY_SMOLDERING_WOOD',
  'ABILITY_SNAP_TRAP_WHEN_HIT',
  'ABILITY_SOUL_LINKER',
  'ABILITY_SPIKE_ARMOR',
  'ABILITY_SPITEFUL',
  'ABILITY_STAMINA',
  'ABILITY_STATIC',
  'ABILITY_STEAM_ENGINE',
  'ABILITY_STRIKEOUT',
  'ABILITY_SUPERSWEET_SYRUP',
  'ABILITY_SUPER_HOT_GOO',
  'ABILITY_TALON_TRAP',
  'ABILITY_TANGLING_HAIR',
  'ABILITY_TENDER_AFFECTION',
  'ABILITY_THERMAL_ENTROPY',
  'ABILITY_THERMAL_EXCHANGE',
  'ABILITY_TIPPING_POINT',
  'ABILITY_TOXIC_DEBRIS',
  'ABILITY_TOXIC_SHELL',
  'ABILITY_ULTRA_INSTINCT',
  'ABILITY_UNLOCKED_POTENTIAL',
  'ABILITY_UNSTABLE_CORE',
  'ABILITY_VENGEFUL_SPIRIT',
  'ABILITY_VENOM_CROWN',
  'ABILITY_VICTORY_BOMB',
  'ABILITY_VOODOO_POWER',
  'ABILITY_WANDERING_SPIRIT',
  'ABILITY_WATER_COMPACTION',
  'ABILITY_WEAK_ARMOR',
  'ABILITY_WHITE_NOISE',
  'ABILITY_WIMP_OUT',
  'ABILITY_WIND_CHIMES',
  'ABILITY_WIND_POWER',
  'ABILITY_WOODLAND_CURSE',
])

// Quoted grep: grep -oP '"onAttacker".+?"id":"\KABILITY_[A-Z0-9_]+' data/v2.65beta/abilityHooks.json
export const ON_ATTACKER_ABILITIES = new Set([
  'ABILITY_ABSORBANT',
  'ABILITY_AFTERMATH',
  'ABILITY_AFTERSHOCK',
  'ABILITY_ANGELS_WRATH',
  'ABILITY_ARCHMAGE',
  'ABILITY_ARC_FLASH',
  'ABILITY_ASSASSINS_TOOLS',
  'ABILITY_ATOMIC_BURST',
  'ABILITY_BACKFLIP',
  'ABILITY_BEAUTIFUL_MUSIC',
  'ABILITY_BLADE_DANCE',
  'ABILITY_BLIGHT_SCALE',
  'ABILITY_BLOOD_STAIN',
  'ABILITY_BREAK_IT_DOWN',
  'ABILITY_CHAINSAW',
  'ABILITY_CHUNKY_BASS_LINE',
  'ABILITY_CRUSHING_JAW',
  'ABILITY_CRYO_PROFICIENCY',
  'ABILITY_CURRENT_CRASH',
  'ABILITY_CUTE_CHARM',
  'ABILITY_DAMP',
  'ABILITY_DAREDEVIL',
  'ABILITY_DAYBREAK',
  'ABILITY_DEAD_POWER',
  'ABILITY_DEEP_CUTS',
  'ABILITY_DEMOLITIONIST',
  'ABILITY_DENTING_BLOWS',
  'ABILITY_DEVIATE',
  'ABILITY_ELEMENTAL_CHARGE',
  'ABILITY_EMANATE',
  'ABILITY_ENERGY_SIPHON',
  'ABILITY_ENERGY_TAP',
  'ABILITY_ENLIGHTENED',
  'ABILITY_ENVENOM',
  'ABILITY_FEARMONGER',
  'ABILITY_FERTILIZE',
  'ABILITY_FIRES_WRATH',
  'ABILITY_FIRE_ASPECT',
  'ABILITY_FLAME_BODY',
  'ABILITY_FLAMING_JAWS',
  'ABILITY_FLAMING_MAW',
  'ABILITY_FORECAST',
  'ABILITY_FRAGRANT_DAZE',
  'ABILITY_FREEZING_POINT',
  'ABILITY_FROM_THE_SHADOWS',
  'ABILITY_FROSTMAW',
  'ABILITY_FROST_BURN',
  'ABILITY_FROST_DRAGON',
  'ABILITY_FUNGAL_INFECTION',
  'ABILITY_GALVANIZE',
  'ABILITY_GHOST_PEPPER',
  'ABILITY_GLACIAL_RAGE',
  'ABILITY_GRASS_FLUTE',
  'ABILITY_GRIP_PINCER',
  'ABILITY_GROWING_TOOTH',
  'ABILITY_GULP_MISSILE',
  'ABILITY_HARDENED_SHEATH',
  'ABILITY_HAUNTING_FRENZY',
  'ABILITY_HIGH_TIDE',
  'ABILITY_HOLLOW_ICE_ZONE',
  'ABILITY_HOME_RUN',
  'ABILITY_HYDRATE',
  'ABILITY_HYDRO_CIRCUIT',
  'ABILITY_HYPNOTIC_TOUCH',
  'ABILITY_HYPNOTIC_TRANCE',
  'ABILITY_ICICLE_FIST',
  'ABILITY_ILLUMINATE',
  'ABILITY_IMMOLATE',
  'ABILITY_IMPALER',
  'ABILITY_INTOXICATE',
  'ABILITY_KNOW_YOUR_PLACE',
  'ABILITY_KOMODO',
  'ABILITY_LASER_DRILL',
  'ABILITY_LEAD_CLAWS',
  'ABILITY_LIGHT_SABER',
  'ABILITY_LOUD_BANG',
  'ABILITY_LUNAR_WRATH',
  'ABILITY_MAGICAL_DUST',
  'ABILITY_MENACING_SITUATION',
  'ABILITY_MINERALIZE',
  'ABILITY_MOB_BOSS',
  'ABILITY_MOLTEN_BLADES',
  'ABILITY_MOLTEN_COAT',
  'ABILITY_PAINT_SHOT',
  'ABILITY_PIERCING_SOLO',
  'ABILITY_PINNACLE_BLADE',
  'ABILITY_PIXILATE',
  'ABILITY_POISON_POINT',
  'ABILITY_POISON_QUILLS',
  'ABILITY_POISON_TOUCH',
  'ABILITY_POWER_OUTAGE',
  'ABILITY_PURE_LOVE',
  'ABILITY_PURPLE_HAZE',
  'ABILITY_PYRO_SHELLS',
  'ABILITY_RADIO_JAM',
  'ABILITY_RAZOR_SHARP',
  'ABILITY_REFRIGERATE',
  'ABILITY_RESONANCE',
  'ABILITY_SERPENT_BIND',
  'ABILITY_SHARP_TALONS',
  'ABILITY_SHIELDS_DOWN',
  'ABILITY_SHOCKING_JAWS',
  'ABILITY_SHOCKING_MAW',
  'ABILITY_SINISTER_CLAWS',
  'ABILITY_SLUDGE_SPIT',
  'ABILITY_SLUDGY_MIX',
  'ABILITY_SMOLDERING_WOOD',
  'ABILITY_SOLAR_FLARE',
  'ABILITY_SOLENOGLYPHS',
  'ABILITY_SOUL_LINKER',
  'ABILITY_SPECTRALIZE',
  'ABILITY_SPECTRAL_SHROUD',
  'ABILITY_SPIKE_ARMOR',
  'ABILITY_SPINNING_TOP',
  'ABILITY_STATIC',
  'ABILITY_STENCH',
  'ABILITY_STRIKER_PIXILATE',
  'ABILITY_STUN_SHOCK',
  'ABILITY_SUPER_HOT_GOO',
  'ABILITY_TALON_TRAP',
  'ABILITY_TANGLED_TAILS',
  'ABILITY_TEMPORAL_RUPTURE',
  'ABILITY_TENDER_AFFECTION',
  'ABILITY_TENTALOCK',
  'ABILITY_THUNDERCALL',
  'ABILITY_THUNDER_CLOUDS',
  'ABILITY_TOXIC_CHAIN',
  'ABILITY_TOXIC_SHELL',
  'ABILITY_TO_THE_BONE',
  'ABILITY_TWO_STEP',
  'ABILITY_UNICORN',
  'ABILITY_VENOBLAZE_PINCERS',
  'ABILITY_VENOM_CROWN',
  'ABILITY_VIRUS',
  'ABILITY_VITALITY_STRIKE',
  'ABILITY_VITAL_SPIRIT',
  'ABILITY_VOLCANO_RAGE',
  'ABILITY_WHIPLASH',
  'ABILITY_WHITE_NOISE',
  'ABILITY_WINGS_OF_PESTILENCE',
  'ABILITY_WOODLAND_CURSE',
  'ABILITY_WORLD_SERPENT',
  'ABILITY_WRESTLE_SHOWMAN',
  'ABILITY_YUKI_ONNA',
])

// Quoted grep: grep -oP '"onBattlerFaints".+?"id":"\KABILITY_[A-Z0-9_]+' data/v2.65beta/abilityHooks.json
// Dispatched by dispatchOnBattlerFaints; the stat-raise subset (KO_STAT_RAISES), Soul Eater / Predator (KO_SOUL_EATER_ABILITIES),
// Jaws of Carnage (KO_JAWS_OF_CARNAGE_ABILITIES), and Pretentious (KO_CRIT_BOOST_ABILITIES) are ported; the rest gap when applicable.
export const ON_BATTLER_FAINTS_ABILITIES = new Set([
  'ABILITY_ADRENALINE_RUSH',
  'ABILITY_APEX_PREDATOR',
  'ABILITY_AS_ONE_ICE_RIDER',
  'ABILITY_AS_ONE_SHADOW_RIDER',
  'ABILITY_BANDIT',
  'ABILITY_BATTLE_BOND',
  'ABILITY_BEAST_BOOST',
  'ABILITY_BERSERKER_RAGE',
  'ABILITY_BLOODLUST',
  'ABILITY_BLOOD_BATH',
  'ABILITY_BREEZY_NEIGH',
  'ABILITY_CHILLING_NEIGH',
  'ABILITY_CHOKEHOLD',
  'ABILITY_COMMANDER',
  'ABILITY_CROWNED_KING',
  'ABILITY_CRYOSTASIS',
  'ABILITY_DRAGONS_RITUAL',
  'ABILITY_DRAKE_OF_RAGE',
  'ABILITY_EDGELORD',
  'ABILITY_ENERGIZED',
  'ABILITY_ENTRANCE',
  'ABILITY_FORSAKEN_HEART',
  'ABILITY_FROSTBIND',
  'ABILITY_GHOST_FRENZY',
  'ABILITY_GOING_BERSERK',
  'ABILITY_GRIM_NEIGH',
  'ABILITY_HAUNTING_FRENZY',
  'ABILITY_HEMOTOXIN',
  'ABILITY_HUBRIS',
  'ABILITY_HUNGRY_MAWS',
  'ABILITY_HUNTERS_HORN',
  'ABILITY_HYDRA',
  'ABILITY_JAWS_OF_CARNAGE',
  'ABILITY_LOOTER',
  'ABILITY_MAGMA_EATER',
  'ABILITY_MASTER_HAND',
  'ABILITY_MOXIE',
  'ABILITY_NEUROTOXIN',
  'ABILITY_POISON_PUPPETEER',
  'ABILITY_POWER_OF_ALCHEMY',
  'ABILITY_PREDATOR',
  'ABILITY_PRETENTIOUS',
  'ABILITY_QIGONG',
  'ABILITY_RAGING_GODDESS',
  'ABILITY_RAMPAGE',
  'ABILITY_RECEIVER',
  'ABILITY_SCAVENGER',
  'ABILITY_SET_ABLAZE',
  'ABILITY_SIDEWINDER',
  'ABILITY_SOUL_DEVOURER',
  'ABILITY_SOUL_EATER',
  'ABILITY_SOUL_HEART',
  'ABILITY_STRIKEOUT',
  'ABILITY_SUPER_STRAIN',
  'ABILITY_WAY_OF_SWIFTNESS',
])

// ---------------------------------------------------------------------------
// Pinned Move Behavior Recoil Fractions
// ---------------------------------------------------------------------------

// Quoted grep: grep -o '.\{1,40\}"recoilFraction":[1-9].\{1,40\}' data/v2.65beta/moveBehaviors.json
// Matches EFFECT_RECOIL_25: 4, EFFECT_RECOIL_33: 3, EFFECT_RECOIL_50: 2, EFFECT_FLINCH_RECOIL_33: 3, EFFECT_FLINCH_RECOIL_50: 2
export const RECOIL_FRACTIONS: Record<string, number> = {
  EFFECT_RECOIL_25: 4,
  EFFECT_RECOIL_33: 3,
  EFFECT_RECOIL_50: 2,
  EFFECT_FLINCH_RECOIL_33: 3,
  EFFECT_FLINCH_RECOIL_50: 2,
}

// grep onRecoil hooks in data/v2.65beta/abilityHooks.json (MOVEEND_RECOIL's ON_ABILITY onRecoil, :4483-4490)
const ON_RECOIL_ABILITIES = [
  'ABILITY_DOOM_BLAST',
  'ABILITY_DUAL_SHADOW',
  'ABILITY_ELECTRIC_BURST',
  'ABILITY_INFERNAL_RAGE',
  'ABILITY_SUPER_STRAIN',
]

// The move types each ON_RECOIL ability's onRecoil(100, battler, moveType) answers non-zero for; null = every type.
// Read for IsRecklessBoosted (src/abilities.cc:463-470). Doom Blast :9297, Dual Shadow :9569, Electric Burst :4337, Infernal Rage :5474, Super Strain :6317.
const ON_RECOIL_TYPES: Record<string, readonly string[] | null> = {
  ABILITY_DOOM_BLAST: ['DARK'],
  ABILITY_DUAL_SHADOW: ['ELECTRIC', 'DARK'],
  ABILITY_ELECTRIC_BURST: ['ELECTRIC'],
  ABILITY_INFERNAL_RAGE: ['FIRE'],
  ABILITY_SUPER_STRAIN: null,
}

// Target items in ITEMEFFECT_TARGET (battle_util.c:6126-6250) other than Rocky Helmet
const TARGET_ITEM_EFFECTS = new Set([
  'HOLD_EFFECT_RED_CARD',
  'HOLD_EFFECT_EJECT_BUTTON',
  'HOLD_EFFECT_SNOWBALL',
  'HOLD_EFFECT_LUMINOUS_MOSS',
  'HOLD_EFFECT_CELL_BATTERY',
  'HOLD_EFFECT_ABSORB_BULB',
  'HOLD_EFFECT_KEE_BERRY',
  'HOLD_EFFECT_MARANGA_BERRY',
  'HOLD_EFFECT_JABOCA_BERRY',
  'HOLD_EFFECT_ROWAP_BERRY',
])

// Move effects handled in MOVEEND_MOVE_EFFECTS2 (battle_script_commands.c:4633-4655)
const MOVE_EFFECTS2 = new Set([
  'EFFECT_MAKE_IT_RAIN',
  'EFFECT_BURN_UP',
  'EFFECT_SCALE_SHOT',
  'EFFECT_WYRM_WIND',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * IsMoveMakingContact, src/battle_util.c:6554-6569. The Shell Side Arm swapped-category
 * branch (:6556) is not modelled; Shell Side Arm only counts as contact via its own flag.
 */
export function isMoveMakingContact(
  moveData: SimMoveData | undefined,
  attacker: BattlerState,
  attackerHoldEffect: string | null,
): boolean {
  if (!moveData?.flags?.contact) {
    return false
  }
  if (battlerHasAbility(attacker.mon.abilities, 'ABILITY_LONG_REACH', () => false)) {
    return false
  }
  if (attackerHoldEffect === 'HOLD_EFFECT_PROTECTIVE_PADS') {
    return false
  }
  if (attackerHoldEffect === 'HOLD_EFFECT_PUNCHING_GLOVE' && isIronFistBoosted(attacker.mon.abilities, moveData.flags, moveData.split ?? 'STATUS')) {
    return false
  }
  return true
}

/**
 * GetRecoilFraction, MoveRecoilGenerator.kt:14-20 / battle_script_commands.c:4474.
 * Returns denominator of damage (e.g. 4 for 1/4 recoil, 3 for 1/3, 2 for 1/2),
 * or 0 if move has no recoil.
 */
export function getRecoilFraction(
  effect: string | null | undefined,
  moveBehaviors?: MoveBehaviors,
): number {
  if (!effect) return 0
  const fromBehavior = moveBehaviors?.[effect]?.attack?.recoilFraction
  if (typeof fromBehavior === 'number' && fromBehavior > 0) {
    return fromBehavior
  }
  return RECOIL_FRACTIONS[effect] ?? 0
}

function battlerHasNoRecoil(battler: BattlerState): boolean {
  if (abilitySlotsHaveFlag(battler.mon.abilities, 'noRecoil')) return true
  for (const ab of NO_RECOIL_ABILITIES) {
    if (battlerHasAbility(battler.mon.abilities, ab, () => false)) return true
  }
  return false
}

function battlerHasHalfRecoil(battler: BattlerState): boolean {
  if (abilitySlotsHaveFlag(battler.mon.abilities, 'halfRecoil')) return true
  for (const ab of HALF_RECOIL_ABILITIES) {
    if (battlerHasAbility(battler.mon.abilities, ab, () => false)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// MOVEEND_ABILITIES & MOVEEND_ABILITIES_ATTACKER Hook Implementations
// ---------------------------------------------------------------------------

// Quoted grep: grep -rn 'Impl<ABILITY_ROUGH_SKIN>' pipeline/.upstream/eliteredux-source/src/abilities.cc
// Matches: ABILITY_ROUGH_SKIN (:783), ABILITY_IRON_BARBS (:2263), ABILITY_DRAGONFRUIT (:11224), ABILITY_POISON_QUILLS (:10149)
// Plus ABILITY_DOUBLE_IRON_BARBS (:7324)
// Plus Static family: ABILITY_STATIC (:620), ABILITY_WHITE_NOISE (:8180)
// Plus Flame Body family: ABILITY_FLAME_BODY (:1136), ABILITY_SMOLDERING_WOOD (:4362), ABILITY_SUPER_HOT_GOO (:6103)
// Plus Poison Point family: ABILITY_POISON_POINT (:997), ABILITY_POISON_TOUCH (:2099), ABILITY_TOXIC_SHELL (:11534), ABILITY_VENOM_CROWN (:9518), ABILITY_BLIGHT_SCALE (:9525)
// Plus Effect Spore: ABILITY_EFFECT_SPORE (:818)
// Plus Gooey family: ABILITY_GOOEY (:2482), ABILITY_SLIME_MOLD (:2495), ABILITY_TANGLING_HAIR (:3053), ABILITY_MASSIVE_PELT (:11357), ABILITY_MUCUS_MEMBRANE (:11628)
// Plus Cycle 42 onDefender batch:
// - Stamina family: ABILITY_STAMINA (:2598), ABILITY_CROWNED_SHIELD (:6701), ABILITY_MOUSTACHE (:10949)
// - Weak Armor: ABILITY_WEAK_ARMOR (:1950)
// - Anger Point family: ABILITY_ANGER_POINT (:1461), ABILITY_CROWNED_SWORD (:6695), ABILITY_TIPPING_POINT (:6219), ABILITY_BERSERKER_RAGE (:6237), ABILITY_FORTITUDE (:6623), ABILITY_RAGE_POINT (:8784)
// - Berserk family: ABILITY_BERSERK (:2758), ABILITY_UNLOCKED_POTENTIAL (:8239), ABILITY_GOING_BERSERK (:12144)
// - Anger Shell: ABILITY_ANGER_SHELL (:7061)
// - Inflatable family: ABILITY_INFLATABLE (:3860), ABILITY_BALLOON_BLITZ (:9282), ABILITY_BALLOON_BOMBER (:7761)
// - Toxic Debris: ABILITY_TOXIC_DEBRIS (:5060)
// - Scrapyard family: ABILITY_SCRAPYARD (:5043), ABILITY_LOOSE_QUILLS (:5056), ABILITY_SHATTERED_ARMOR (:12285), ABILITY_LOOSE_ROCKS (:5104)
// - Cute Charm family: ABILITY_CUTE_CHARM (:1217), ABILITY_TENDER_AFFECTION (:10008), ABILITY_PRIM_AND_PROPER (:6311), ABILITY_PURE_LOVE (:6537)
// - Damp: ABILITY_DAMP (:578)
// - Furnace: ABILITY_FURNACE (:5797)
// - Guilt Trip: ABILITY_GUILT_TRIP (:7108)
// - Haunted Spirit family: ABILITY_HAUNTED_SPIRIT (:4321), ABILITY_VENGEFUL_SPIRIT (:7189)
// - Ill Will: ABILITY_ILL_WILL (:7278)
// - Itchy Defense: ABILITY_ITCHY_DEFENSE (:6154)
// - Sand Spit: ABILITY_SAND_SPIT (:3317)
// - Seed Sower: ABILITY_SEED_SOWER (:6859)
// - Wind Power: ABILITY_WIND_POWER (:7032)
// - Cotton Down family: ABILITY_COTTON_DOWN (:3242), ABILITY_SCARECROW (:9982)
// - Cursed Body: ABILITY_CURSED_BODY (:1910)
// - Justified-style defender stat raises: ABILITY_RATTLED (:2213), ABILITY_WATER_COMPACTION (:2650), ABILITY_STEAM_ENGINE (:3291), ABILITY_THERMAL_EXCHANGE (:7339), ABILITY_THERMAL_ENTROPY (:12404)
// - Electromorphosis family: ABILITY_ELECTROMORPHOSIS (:5299), ABILITY_ATOMIC_BURST (:5313)
// - Cycle 88a: ABILITY_INNARDS_OUT (:2995), ABILITY_SPITEFUL (:6610), ABILITY_COLD_REBOUND (:4850), ABILITY_ICE_DOWNFALL (:7944),
//   ABILITY_SNAP_TRAP_WHEN_HIT (:6734), ABILITY_SUPERSWEET_SYRUP (:8957), ABILITY_DROP_BLOCKS (:10996), ABILITY_LOOSE_THORNS (:11042),
//   ABILITY_VOODOO_POWER (:6813), ABILITY_MUMMY (:2182), ABILITY_FLAMMABLE_COAT (:8320)
// - Cycle 88b: ABILITY_BRAIN_OVERLOAD (:11645), ABILITY_POWER_LEAK (:10916), ABILITY_CHILLING_PELLETS (:10700), ABILITY_FARADAY_CAGE (:9316),
//   ABILITY_PARRY (:5031), ABILITY_DEFLECT (:12536), ABILITY_FOG_MACHINE (:10979), ABILITY_CRISPY_CREAM (:10838), ABILITY_LINGERING_AROMA (:5826),
//   ABILITY_MALODOR (:9853), ABILITY_NO_TURNING_BACK (:8307), ABILITY_PERISH_BODY (:3469)
export const PORTED_DEFENDER_ABILITIES = new Set([
  'ABILITY_ROUGH_SKIN',
  'ABILITY_IRON_BARBS',
  'ABILITY_DRAGONFRUIT',
  'ABILITY_DRAKELP_HEAD', // Cycle 98 (:12055-12079)
  'ABILITY_DOUBLE_IRON_BARBS',
  'ABILITY_POISON_QUILLS',
  'ABILITY_STATIC',
  'ABILITY_WHITE_NOISE',
  'ABILITY_FLAME_BODY',
  'ABILITY_SMOLDERING_WOOD',
  'ABILITY_SUPER_HOT_GOO',
  'ABILITY_POISON_POINT',
  'ABILITY_POISON_TOUCH',
  'ABILITY_TOXIC_SHELL',
  'ABILITY_VENOM_CROWN',
  'ABILITY_BLIGHT_SCALE',
  'ABILITY_EFFECT_SPORE',
  'ABILITY_GOOEY',
  'ABILITY_SLIME_MOLD',
  'ABILITY_TANGLING_HAIR',
  'ABILITY_MASSIVE_PELT',
  'ABILITY_MUCUS_MEMBRANE',
  'ABILITY_STAMINA',
  'ABILITY_CROWNED_SHIELD',
  'ABILITY_MOUSTACHE',
  'ABILITY_WEAK_ARMOR',
  'ABILITY_ANGER_POINT',
  'ABILITY_CROWNED_SWORD',
  'ABILITY_TIPPING_POINT',
  'ABILITY_BERSERKER_RAGE',
  'ABILITY_FORTITUDE',
  'ABILITY_RAGE_POINT',
  'ABILITY_BERSERK',
  'ABILITY_UNLOCKED_POTENTIAL',
  'ABILITY_GOING_BERSERK',
  'ABILITY_ANGER_SHELL',
  'ABILITY_APE_SHIFT', // Cycle 108 (onDefender :9063; onEntry/onEndTurn are form-change hooks)
  'ABILITY_INFLATABLE',
  'ABILITY_BALLOON_BLITZ',
  'ABILITY_BALLOON_BOMBER',
  'ABILITY_TOXIC_DEBRIS',
  'ABILITY_SCRAPYARD',
  'ABILITY_LOOSE_QUILLS',
  'ABILITY_SHATTERED_ARMOR',
  'ABILITY_LOOSE_ROCKS',
  'ABILITY_CUTE_CHARM',
  'ABILITY_TENDER_AFFECTION',
  'ABILITY_PRIM_AND_PROPER',
  'ABILITY_PURE_LOVE',
  'ABILITY_DAMP',
  'ABILITY_FURNACE',
  'ABILITY_GUILT_TRIP',
  'ABILITY_HAUNTED_SPIRIT',
  'ABILITY_VENGEFUL_SPIRIT',
  'ABILITY_ILL_WILL',
  'ABILITY_ITCHY_DEFENSE',
  'ABILITY_SAND_SPIT',
  'ABILITY_SEED_SOWER',
  'ABILITY_WIND_POWER',
  'ABILITY_COTTON_DOWN',
  'ABILITY_SCARECROW',
  'ABILITY_CURSED_BODY',
  'ABILITY_RATTLED',
  'ABILITY_WATER_COMPACTION',
  'ABILITY_STEAM_ENGINE',
  'ABILITY_THERMAL_EXCHANGE',
  'ABILITY_THERMAL_ENTROPY',
  'ABILITY_ELECTROMORPHOSIS',
  'ABILITY_ATOMIC_BURST',
  'ABILITY_INNARDS_OUT',
  'ABILITY_SPITEFUL',
  'ABILITY_COLD_REBOUND',
  'ABILITY_ICE_DOWNFALL',
  'ABILITY_SNAP_TRAP_WHEN_HIT',
  'ABILITY_SUPERSWEET_SYRUP',
  'ABILITY_DROP_BLOCKS',
  'ABILITY_LOOSE_THORNS',
  'ABILITY_VOODOO_POWER',
  'ABILITY_MUMMY',
  'ABILITY_FLAMMABLE_COAT',
  'ABILITY_BRAIN_OVERLOAD',
  'ABILITY_POWER_LEAK',
  'ABILITY_CHILLING_PELLETS',
  'ABILITY_FARADAY_CAGE',
  'ABILITY_PARRY',
  'ABILITY_DEFLECT',
  'ABILITY_FOG_MACHINE',
  'ABILITY_CRISPY_CREAM',
  'ABILITY_LINGERING_AROMA',
  'ABILITY_MALODOR',
  'ABILITY_NO_TURNING_BACK',
  'ABILITY_PERISH_BODY',
  'ABILITY_FREEZING_POINT',
  'ABILITY_CRYO_PROFICIENCY',
  'ABILITY_RESILIENCE',
  'ABILITY_ULTRA_INSTINCT',
  'ABILITY_UNSTABLE_CORE',
  'ABILITY_VICTORY_BOMB',
  'ABILITY_WANDERING_SPIRIT',
  'ABILITY_WIND_CHIMES',
  'ABILITY_SPIKE_ARMOR',
  'ABILITY_MAGICAL_DUST',
  'ABILITY_FRAGRANT_DAZE',
  'ABILITY_HYPNOTIC_TOUCH',
  'ABILITY_STRIKEOUT', // Cycle 89b (:11143-11155)
  'ABILITY_SOUL_LINKER', // Cycle 96 onDefender half (abilities.cc:4273-4285)
  'ABILITY_CHUCKSTER', // Cycle 98b (:10438-10463, schedules the attacker's switch)
  'ABILITY_RESTRAINING_ORDER', // Cycle 98b (:8579-8597, drain sets the state and switches the attacker)
  'ABILITY_PETAL_SHIELD', // Cycle 108b (:12438-12446, own Defense -1 on every hit that passes the checks)
  // Cycle 109 defender halves
  'ABILITY_CRYO_ARCHITECT', // (:9602-9633, Water arms bit 1 / Ice raises Def, Atk +1 either way)
  'ABILITY_AFTERMATH', // (:1663-1670, UseOutOfTurnAttack Explosion/Outburst after the holder faints)
  'ABILITY_GULP_MISSILE', // (:3289-3301, revert form, attacker loses maxHP/4 + paralysis or Def -1)
  'ABILITY_TALON_TRAP', // ON_EITHER (:4713-4730), wraps the attacker on contact
])

// Quoted grep: ON_EITHER_ABILITY in pipeline/.upstream/eliteredux-source/src/abilities.cc
// and onAttacker hooks in pipeline/.upstream/eliteredux-source/src/abilities.cc & battle_script_commands.c:4828-4853
// Matches:
// - Static family: ABILITY_STATIC (:621), ABILITY_WHITE_NOISE (:8182)
// - Flame Body family: ABILITY_FLAME_BODY (:1137), ABILITY_SMOLDERING_WOOD (:4363), ABILITY_SUPER_HOT_GOO (:6104)
// - Poison Point family: ABILITY_POISON_POINT (:998), ABILITY_POISON_TOUCH (:2100), ABILITY_TOXIC_SHELL (:11535), ABILITY_VENOM_CROWN (:9519), ABILITY_BLIGHT_SCALE (:9526), ABILITY_POISON_QUILLS (:10147)
// - Cycle 43 onAttacker batch:
//   - Absorbant: ABILITY_ABSORBANT (:5397)
//   - Aftershock: ABILITY_AFTERSHOCK (:6350)
//   - Blade Dance: ABILITY_BLADE_DANCE (:9038)
//   - Cute Charm family: ABILITY_CUTE_CHARM (:1207), ABILITY_TENDER_AFFECTION (:10009), ABILITY_PURE_LOVE (:6536)
//   - Damp: ABILITY_DAMP (:564)
//   - Elemental Charge: ABILITY_ELEMENTAL_CHARGE (:5494)
//   - Envenom: ABILITY_ENVENOM (:10269)
//   - Flaming Jaws family: ABILITY_FLAMING_JAWS (:6668), ABILITY_FLAMING_MAW (:7766)
//   - Grip Pincer family: ABILITY_GRIP_PINCER (:4689), ABILITY_WORLD_SERPENT (:10250), ABILITY_SERPENT_BIND (:12007), ABILITY_TENTALOCK (:12080)
//   - Growing Tooth: ABILITY_GROWING_TOOTH (:3847)
//   - High Tide: ABILITY_HIGH_TIDE (:6472)
//   - Illuminate: ABILITY_ILLUMINATE (:912)
//   - Loud Bang: ABILITY_LOUD_BANG (:3898)
//   - Purple Haze: ABILITY_PURPLE_HAZE (:10280)
//   - Stench: ABILITY_STENCH (:484)
//   - Volcano Rage: ABILITY_VOLCANO_RAGE (:4840)
//   - Pickpocket: ABILITY_PICKPOCKET (battle_script_commands.c:4294, :4828-4853)
export const PORTED_ATTACKER_ABILITIES = new Set([
  'ABILITY_ABSORBANT',
  'ABILITY_AFTERMATH',
  'ABILITY_AFTERSHOCK',
  'ABILITY_ATOMIC_BURST',
  'ABILITY_BLADE_DANCE',
  'ABILITY_BLIGHT_SCALE',
  'ABILITY_CUTE_CHARM',
  'ABILITY_DAMP',
  'ABILITY_DEVIATE',
  'ABILITY_ELEMENTAL_CHARGE',
  'ABILITY_EMANATE',
  'ABILITY_ENERGY_TAP',
  'ABILITY_ENLIGHTENED',
  'ABILITY_ENVENOM',
  'ABILITY_FEARMONGER',
  'ABILITY_FERTILIZE',
  'ABILITY_FLAME_BODY',
  'ABILITY_FLAMING_JAWS',
  'ABILITY_FLAMING_MAW',
  'ABILITY_FREEZING_POINT',
  'ABILITY_GALVANIZE',
  'ABILITY_GRIP_PINCER',
  'ABILITY_GROWING_TOOTH',
  'ABILITY_HIGH_TIDE',
  'ABILITY_HYDRATE',
  'ABILITY_ILLUMINATE',
  'ABILITY_IMMOLATE',
  'ABILITY_INTOXICATE',
  'ABILITY_LEAD_CLAWS',
  'ABILITY_LOUD_BANG',
  'ABILITY_MENACING_SITUATION',
  'ABILITY_MINERALIZE',
  'ABILITY_MOB_BOSS',
  'ABILITY_MOLTEN_COAT',
  'ABILITY_PICKPOCKET',
  'ABILITY_PIXILATE',
  'ABILITY_POISON_POINT',
  'ABILITY_POISON_QUILLS',
  'ABILITY_POISON_TOUCH',
  'ABILITY_POWER_OUTAGE', // Cycle 98 (:12352-12371)
  'ABILITY_PURE_LOVE',
  'ABILITY_PURPLE_HAZE',
  'ABILITY_RAZOR_SHARP',
  'ABILITY_REFRIGERATE',
  'ABILITY_RESONANCE',
  'ABILITY_SERPENT_BIND',
  'ABILITY_SLUDGY_MIX',
  'ABILITY_SMOLDERING_WOOD',
  'ABILITY_SOLAR_FLARE',
  'ABILITY_SOLENOGLYPHS',
  'ABILITY_SPECTRALIZE',
  'ABILITY_STATIC',
  'ABILITY_STENCH',
  'ABILITY_STRIKER_PIXILATE',
  'ABILITY_SUPER_HOT_GOO',
  'ABILITY_TENDER_AFFECTION',
  'ABILITY_TENTALOCK',
  'ABILITY_TOXIC_SHELL',
  'ABILITY_TO_THE_BONE',
  'ABILITY_UNICORN',
  'ABILITY_VENOM_CROWN',
  'ABILITY_VITAL_SPIRIT',
  'ABILITY_VOLCANO_RAGE',
  'ABILITY_WHIPLASH',
  'ABILITY_WHITE_NOISE',
  'ABILITY_WORLD_SERPENT',
  'ABILITY_CRYO_PROFICIENCY',
  'ABILITY_SPIKE_ARMOR',
  'ABILITY_FRAGRANT_DAZE',
  'ABILITY_HYPNOTIC_TOUCH',
  'ABILITY_MAGICAL_DUST',
  'ABILITY_DEEP_CUTS',
  'ABILITY_BEAUTIFUL_MUSIC',
  'ABILITY_DEAD_POWER',
  'ABILITY_ASSASSINS_TOOLS',
  'ABILITY_CRUSHING_JAW',
  'ABILITY_CHAINSAW',
  'ABILITY_DENTING_BLOWS',
  'ABILITY_DAREDEVIL',
  'ABILITY_ARCHMAGE',
  'ABILITY_ANGELS_WRATH',
  'ABILITY_ENERGY_SIPHON',
  'ABILITY_FIRE_ASPECT',
  'ABILITY_FIRES_WRATH',
  'ABILITY_FROM_THE_SHADOWS',
  'ABILITY_FROSTMAW',
  'ABILITY_FUNGAL_INFECTION',
  'ABILITY_GHOST_PEPPER',
  'ABILITY_GRASS_FLUTE',
  'ABILITY_HARDENED_SHEATH',
  'ABILITY_HAUNTING_FRENZY',
  'ABILITY_BACKFLIP',
  'ABILITY_BREAK_IT_DOWN',
  'ABILITY_CHUNKY_BASS_LINE',
  'ABILITY_CURRENT_CRASH',
  'ABILITY_FORECAST',
  'ABILITY_FROST_BURN',
  'ABILITY_FROST_DRAGON',
  'ABILITY_GLACIAL_RAGE',
  'ABILITY_LUNAR_WRATH',
  'ABILITY_PYRO_SHELLS',
  'ABILITY_SLUDGE_SPIT',
  'ABILITY_THUNDERCALL',
  'ABILITY_THUNDER_CLOUDS',
  'ABILITY_TWO_STEP',
  // Cycle 95: Impaler (:10222-10232), Molten Blades (:7510-7520), Toxic Chain (:7698-7706), Komodo (:10262-10267, = Toxic Chain),
  // Pinnacle Blade (:8687-8720)
  'ABILITY_IMPALER',
  'ABILITY_MOLTEN_BLADES',
  'ABILITY_TOXIC_CHAIN',
  'ABILITY_KOMODO',
  'ABILITY_PINNACLE_BLADE',
  // Cycle 96: Soul Linker's onAttacker half (abilities.cc:4273-4285), Temporal Rupture (:10043-10067)
  'ABILITY_SOUL_LINKER',
  'ABILITY_TEMPORAL_RUPTURE',
  // Cycle 106: on-hit attacker status/heal batch -- Arc Flash (:8082-8090), Hypnotic Trance (:12593-12601),
  // Icicle Fist (:12500-12508), Laser Drill (:11007-11015), Piercing Solo (:8011-8019), Radio Jam (:7544-7552),
  // Sharp Talons (:11345-11353), Shocking Jaws (:5716-5724), Shocking Maw (:8822-8823), Stun Shock (:8917-8933),
  // Light Saber (:11021-11038), Hydro Circuit (:5368-5380).
  'ABILITY_ARC_FLASH',
  'ABILITY_HYPNOTIC_TRANCE',
  'ABILITY_ICICLE_FIST',
  'ABILITY_LASER_DRILL',
  'ABILITY_PIERCING_SOLO',
  'ABILITY_RADIO_JAM',
  'ABILITY_SHARP_TALONS',
  'ABILITY_SHOCKING_JAWS',
  'ABILITY_SHOCKING_MAW',
  'ABILITY_STUN_SHOCK',
  'ABILITY_LIGHT_SABER',
  'ABILITY_HYDRO_CIRCUIT',
  // Cycle 106b: second on-hit attacker batch -- Blood Stain (:8372-8386), Daybreak (:9193-9205),
  // Demolitionist (:7771-7785), Gulp Missile, onAttacker half (:3262-3288), Hollow Ice Zone (:12178-12198),
  // Home Run, onAttacker half (:11926-11985), Know Your Place (:9074-9085), Paint Shot (:10711-10725),
  // Shields Down, onAttacker half (:2680-2720), Sinister Claws (:12415-12429),
  // Spectral Shroud (:4883-4901, Spectralize's own onAttacker at :4866-4879), Spinning Top (:5116-5142).
  'ABILITY_BLOOD_STAIN',
  'ABILITY_DAYBREAK',
  'ABILITY_DEMOLITIONIST',
  'ABILITY_GULP_MISSILE',
  'ABILITY_HOLLOW_ICE_ZONE',
  'ABILITY_HOME_RUN',
  'ABILITY_KNOW_YOUR_PLACE',
  'ABILITY_PAINT_SHOT',
  'ABILITY_SHIELDS_DOWN',
  'ABILITY_SINISTER_CLAWS',
  'ABILITY_SPECTRAL_SHROUD',
  'ABILITY_SPINNING_TOP',
  // Cycle 106c: third on-hit attacker batch -- Tangled Tails, onAttacker half (= Know Your Place's lambda, :12001-12004),
  // Venoblaze Pincers (:8129-8146), Virus (:10907-10913), Vitality Strike (:8545-8556),
  // Wings of Pestilence (:11297-11313), Woodland Curse onAttacker (:9835-9845, ON_EITHER),
  // Wrestle Showman (:11716-11725), Yuki Onna onAttacker (:6425-6433).
  'ABILITY_TANGLED_TAILS',
  'ABILITY_VENOBLAZE_PINCERS',
  'ABILITY_VIRUS',
  'ABILITY_VITALITY_STRIKE',
  'ABILITY_WINGS_OF_PESTILENCE',
  'ABILITY_WOODLAND_CURSE',
  'ABILITY_WRESTLE_SHOWMAN',
  'ABILITY_YUKI_ONNA',
  // Cycle 109: Talon Trap, onAttacker half (ON_EITHER_ABILITY, abilities.cc:4713-4730, :54)
  'ABILITY_TALON_TRAP',
])

/** Cycle 92 attacker abilities whose onAttacker is AdjustFollowupMoveTarget + UseAttackerFollowUpMove. */
export const ATTACKER_FOLLOWUP_ABILITIES = new Set([
  'ABILITY_BACKFLIP',
  'ABILITY_BREAK_IT_DOWN',
  'ABILITY_CHUNKY_BASS_LINE',
  'ABILITY_CURRENT_CRASH',
  'ABILITY_FORECAST',
  'ABILITY_FROST_BURN',
  'ABILITY_FROST_DRAGON',
  'ABILITY_GLACIAL_RAGE',
  'ABILITY_LUNAR_WRATH',
  'ABILITY_PYRO_SHELLS',
  'ABILITY_SLUDGE_SPIT',
  'ABILITY_THUNDERCALL',
  'ABILITY_THUNDER_CLOUDS',
  'ABILITY_TWO_STEP',
])

/**
 * Extracts a battler's ability slots in reverse order (slot 3 -> 2 -> 1 -> 0),
 * matching HandleDefenderAbility / HandleAttackerAbility in src/battle_util.c:9018, 9059:
 * `abilityNumber = numPossibleAbilities - abilityNumber`.
 */
export function getBattlerAbilitySlotsReverse(slots: AbilitySlots): { abilityId: string; slotIndex: number }[] {
  const result: { abilityId: string; slotIndex: number }[] = []
  if (slots.innates[2]) result.push({ abilityId: slots.innates[2], slotIndex: 3 })
  if (slots.innates[1]) result.push({ abilityId: slots.innates[1], slotIndex: 2 })
  if (slots.innates[0]) result.push({ abilityId: slots.innates[0], slotIndex: 1 })
  if (slots.ability) result.push({ abilityId: slots.ability, slotIndex: 0 })
  return result
}

/**
 * StatLowerableOrMirrorArmor, src/battle_util.c:8538-8542.
 */
function canLowerStatOrMirrorArmor(
  state: BattleState,
  battlerId: number,
  statId: number,
  dataContext: SimDataContext,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  const stage = battler.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
  const contrary = battlerHasSimAbility(state, battler, 'ABILITY_CONTRARY', true, battlerId, false, dataContext)
  const canLower = contrary ? stage < MAX_STAT_STAGE : stage > MIN_STAT_STAGE
  if (canLower) return true
  return (
    battlerHasSimAbility(state, battler, 'ABILITY_MIRROR_ARMOR', true, battlerId, false, dataContext) ||
    battlerHasSimAbility(state, battler, 'ABILITY_CRYSTALLINE_ARMOR', true, battlerId, false, dataContext)
  )
}

/**
 * CanRaiseStat, src/battle_util.c:9364 -> CompareStat (:8545-8561), which flips under Contrary.
 */
function canRaiseStat(
  state: BattleState,
  battlerId: number,
  statId: number,
  dataContext: SimDataContext,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  const stage = battler.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
  const contrary = battlerHasSimAbility(state, battler, 'ABILITY_CONTRARY', true, battlerId, false, dataContext)
  return contrary ? stage > MIN_STAT_STAGE : stage < MAX_STAT_STAGE
}

/**
 * CanLowerStat, src/battle_util.c:9363 -> CompareStat (:8545-8561), which flips under Contrary.
 */
function canLowerStat(
  state: BattleState,
  battlerId: number,
  statId: number,
  dataContext: SimDataContext,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  const stage = battler.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
  const contrary = battlerHasSimAbility(state, battler, 'ABILITY_CONTRARY', true, battlerId, false, dataContext)
  return contrary ? stage < MAX_STAT_STAGE : stage > MIN_STAT_STAGE
}

/**
 * CheckHalfHpAbility, src/battle_util.c:9043-9048.
 * Returns true if defender was above half HP before the hit, is at or below half HP after, and is still alive.
 */
function checkHalfHpAbility(target: BattlerState, hpDealt: number): boolean {
  if (target.mon.hp <= 0) return false
  const hpBefore = target.mon.hp + hpDealt
  const halfHp = Math.floor(target.mon.maxHp / 2)
  return hpBefore > halfHp && target.mon.hp <= halfHp
}

/**
 * HandleDefenderAbility's GET_MOVE_TYPE (battle_util.c:9061) -- read as the declared type, like MOVEEND_CHARGE;
 * dynamic type changes (-ate abilities, Weather Ball) are not applied.
 */
function moveTypeMatches(moveData: SimMoveData | undefined, ...types: string[]): boolean {
  if (!moveData || !moveData.type) return false
  const clean = moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type
  return types.includes(clean)
}

/**
 * `losetype BS_ATTACKER, TYPE_CURRENT_MOVE` (data/battle_scripts_1.s:873-877,
 * BattleScript_BurnUpRemoveType -> battle_script_commands.c:7620-7639
 * VARIOUS_LOSE_TYPE): replaces every copy of the current move's type on the
 * battler with TYPE_MYSTERY. TYPE_CURRENT_MOVE is the effective (ate-adjusted)
 * move type, so callers pass `moveTypeName()`.
 */
function loseCurrentMoveType(
  battler: { mon: { types: [string, string, string] } },
  moveType: string | null,
): void {
  if (!moveType) return
  battler.mon.types = battler.mon.types.map((t) => (t === moveType ? 'MYSTERY' : t)) as [string, string, string]
}

/**
 * UseOutOfTurnAttack (src/battle_util.c:3759-3777): queue `moveId` as an extra attack from `battlerId` at `targetId`.
 * `movePower` 0 means "the move's own power" (CalcMoveBasePowerAfterModifiers `fixedPower ? fixedPower : basePower`, :6969).
 */
function queueOutOfTurnAttack(
  state: BattleState,
  deps: TurnLoopDeps,
  battlerId: number,
  targetId: number,
  abilityId: string,
  moveId: string,
  movePower: number,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (battler.turn.dancerUsedMove) return false
  if (hasFlag(battler.mon.status1, STATUS1_SLEEP | STATUS1_FREEZE)) return false
  if (!isBattlerAlive(state, battlerId) && !(abilityId && deps.dataContext.move(moveId)?.effect === 'EFFECT_EXPLOSION')) return false

  battler.turn.dancerUsedMove = true
  state.queuedExtraAttacks.push({ ability: abilityId, move: moveId, attacker: battlerId, target: targetId, movePower })
  return true
}

/** FollowupType constants (src/abilities.cc:201-205), passed to AdjustFollowupMoveTarget. */
export const FOLLOWUP_STANDARD = 0
export const FOLLOWUP_ALLOW_FAILED = 1 << 0
export const FOLLOWUP_ALLOW_SELF = 1 << 1

/**
 * IsDance (src/battle_util.c:9245) / DoesMoveMatchFlag(battler, move, moveType, MOVE_FLAG_DANCE) (src/abilities.cc:358-388):
 * static FLAG_DANCE (`dance` in moves.json), else onModifyMoveFlags abilities granting MOVE_FLAG_DANCE:
 * Festivities (:10194-10203, sound moves), Taekkyeon (:10666-10671, non-status moves), Backstreet Boy (:11570-11583, kick moves).
 */
export function isDanceMove(
  state: BattleState,
  battlerId: number,
  moveData: SimMoveData | undefined,
  deps: TurnLoopDeps,
): boolean {
  if (!moveData) return false
  if (moveData.flags?.dance) return true
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (moveData.flags?.sound && battlerHasSimAbility(state, battler, 'ABILITY_FESTIVITIES', false, battlerId, false, deps.dataContext)) {
    return true
  }
  if (moveData.split !== 'STATUS' && battlerHasSimAbility(state, battler, 'ABILITY_TAEKKYEON', false, battlerId, false, deps.dataContext)) {
    return true
  }
  if (moveData.flags?.kickBased && battlerHasSimAbility(state, battler, 'ABILITY_BACKSTREET_BOY', false, battlerId, false, deps.dataContext)) {
    return true
  }
  return false
}

/**
 * AdjustFollowupMoveTarget (src/abilities.cc:207-225). Returns the adjusted target battler id, or null if the check fails.
 */
export function adjustFollowupMoveTarget(
  state: BattleState,
  battlerId: number,
  targetId: number,
  moveId: string,
  moveData: SimMoveData | undefined,
  type: number,
  noEffect: boolean,
  deps: TurnLoopDeps,
  statusDeps: StatusDeps,
): number | null {
  if (noEffect && !(type & FOLLOWUP_ALLOW_FAILED)) return null

  const targetFlag = getBattlerBattleMoveTargetFlags(state, battlerId, moveId, moveData, deps, statusDeps)
  if (targetFlag === 'BOTH' || targetFlag === 'FOES_AND_ALLY') {
    const adjusted = getMoveTarget(state, battlerId, 'MOVE_POUND', deps, 1)
    return isBattlerAlive(state, adjusted) ? adjusted : null
  }

  let adjusted = targetId
  if (adjusted === battlerId || adjusted === (battlerId ^ 2)) {
    if (type & FOLLOWUP_ALLOW_SELF) {
      adjusted = getMoveTarget(state, battlerId, 'MOVE_POUND', deps, 1)
    } else {
      return null
    }
  }

  return battlerId !== adjusted && isBattlerAlive(state, adjusted) ? adjusted : null
}

/**
 * CanUseExtraMove (src/battle_util.c:8716-8722).
 */
export function canUseExtraMove(state: BattleState, attackerId: number, targetId: number): boolean {
  const attacker = state.battlers[attackerId]
  if (!attacker) return false
  return (
    attackerId !== targetId &&
    isBattlerAlive(state, attackerId) &&
    isBattlerAlive(state, targetId) &&
    !attacker.round.attackCancelled
  )
}

/**
 * UseAttackerFollowUpMove (src/battle_util.c:4021-4033): checks CanUseExtraMove and CheckAndSetOncePerTurnAbility,
 * then pushes `{ ability, move: extraMove, attacker: battlerId, target: targetId, movePower }` onto `state.queuedExtraAttacks`.
 */
export function queueAttackerFollowUpMove(
  state: BattleState,
  battlerId: number,
  targetId: number,
  abilityId: string,
  extraMove: string,
  movePower: number,
  deps: TurnLoopDeps,
): boolean {
  if (!canUseExtraMove(state, battlerId, targetId)) return false
  if (!checkAndSetOncePerTurnAbility(state, battlerId, abilityId, deps.dataContext)) return false

  state.queuedExtraAttacks.push({
    ability: abilityId,
    attacker: battlerId,
    target: targetId,
    move: extraMove,
    movePower,
  })
  return false
}

/** The contact counterattack abilities: [move, movePower] passed to UseOutOfTurnAttack(battler, attacker, ability, move, movePower). */
const CONTACT_COUNTERATTACKS: Record<string, readonly [string, number]> = {
  ABILITY_COLD_REBOUND: ['MOVE_ICY_WIND', 0], // src/abilities.cc:4850-4858
  ABILITY_ICE_DOWNFALL: ['MOVE_ICICLE_CRASH', 60], // src/abilities.cc:7944-7952
  ABILITY_SNAP_TRAP_WHEN_HIT: ['MOVE_SNAP_TRAP', 50], // src/abilities.cc:6734-6742
  ABILITY_CHILLING_PELLETS: ['MOVE_ICICLE_SPEAR', 13], // src/abilities.cc:10700-10708
  ABILITY_FARADAY_CAGE: ['MOVE_THUNDER_CAGE', 50], // src/abilities.cc:9316-9328
  ABILITY_PARRY: ['MOVE_MACH_PUNCH', 0], // src/abilities.cc:5031-5040
  ABILITY_ULTRA_INSTINCT: ['MOVE_VACUUM_WAVE', 20], // src/abilities.cc:8226-8235
}

/**
 * ON_EITHER abilities that run on both sides of a contact hit (abilities.cc ON_EITHER_ABILITY, :54): `can` is the CanX predicate on the victim, `chance` the
 * Random() % 100 bound. Defender and attacker halves share the table; AbilityStatusEffectSafe(effect, battler, opponent) makes the holder the inflicter.
 */
const ON_EITHER_CONTACT_STATUS: Record<
  string,
  { effect: number; can: (state: BattleState, victimId: number, sourceId: number, deps: StatusDeps) => boolean; chance: number }
> = {
  ABILITY_SPIKE_ARMOR: { effect: MOVE_EFFECT_BLEED, can: canBleed, chance: 30 }, // src/abilities.cc:6798-6806
  ABILITY_FRAGRANT_DAZE: { effect: MOVE_EFFECT_CONFUSION, can: canBeConfused, chance: 30 }, // src/abilities.cc:7792-7800
  ABILITY_HYPNOTIC_TOUCH: { effect: MOVE_EFFECT_SLEEP, can: canSleep, chance: 20 }, // src/abilities.cc:11267-11275
}

export interface MoveEndAbilitiesContext {
  state: BattleState
  attackerId: number
  targetId: number
  moveId: string
  moveData: SimMoveData | undefined
  targetDamage: number
  hpDealt?: number
  isCriticalHit?: boolean
  /** The turn loop's "target's slot was already reached" (turn.ts targetHasActedThisTurn); the negation of
   * `GetBattlerTurnOrderNum(target) >= gCurrentTurnActionNumber`, read by From the Shadows. Undefined = not supplied. */
  targetHasActedThisTurn?: boolean
  /** `Boolean(gMoveResultFlags & MOVE_RESULT_NO_EFFECT)` (include/constants/battle.h:389), read by AdjustFollowupMoveTarget. */
  noEffect?: boolean
  /** When true, only evaluate abilities in `ATTACKER_FOLLOWUP_ABILITIES` (used by the status-move path in `turn.ts`). */
  onlyFollowupAbilities?: boolean
  deps: TurnLoopDeps
  unmodelled: string[]
  fainted: number[]
}

export interface MoveEndAbilitiesResult {
  attackerDamage: number
  statChanges: StatChangeOutcome[]
  statusApplied: StatusAppliedOutcome | null
}

/**
 * ON_EITHER(TalonTrap), src/abilities.cc:4713-4730. ON_EITHER's signature is
 * `(ability, battler, opponent, move, moveType)` (:53) and
 * HandleAttackerAbility/HandleDefenderAbility (:9034 / :9075) pass
 * `(battler = holder, opponent = target | attacker)`, so `battler`/`holderId` is
 * always the Talon Trap holder and `opponentId` the battler it wraps:
 *  - onAttacker: holder = attacker, opponent = target;
 *  - onDefender: holder = defender, opponent = attacker.
 * Body, as written: ShouldApplyOnHitEffect(opponent) (DidMoveHit && the opponent
 * alive, battle_util.c:4062), IsBattlerAlive(holder), contact, opponent not
 * already wrapped, then `isFirstTurn == 2 || GetAbilityState(holder) ||
 * Random() % 100 < 50` (the Random draw is short-circuited away by the first two
 * operands). The five writes are the Grip Pincer branch's (abilities.cc:4697-4704):
 * SetOnMoveEffectReactionFlags(holder, opponent, MOVE_EFFECT_WRAP), STATUS2_WRAPPED,
 * wrapTurns = WrapDuration(holder) (battle_script_commands.c:2300-2309),
 * wrapAbility = the ability, wrappedMove/wrappedBy.
 * Returns true when the wrap was applied.
 */
function tryTalonTrapWrap(
  state: BattleState,
  deps: TurnLoopDeps,
  holderId: number,
  opponentId: number,
  attackerId: number,
  moveData: SimMoveData | undefined,
  targetDamage: number,
  attackerHoldEffect: string | null,
): boolean {
  const holder = state.battlers[holderId]
  const opponent = state.battlers[opponentId]
  if (!holder || !opponent) return false
  if (!(targetDamage > 0 && opponent.mon.hp > 0)) return false // ShouldApplyOnHitEffect(opponent)
  if (holder.mon.hp === 0) return false // IsBattlerAlive(battler)
  // IsMoveMakingContact(move, gBattlerAttacker): the MOVE USER's Long Reach /
  // Protective Pads / Punching Glove, not the holder's -- they are the same
  // battler only in the onAttacker half.
  const moveUser = state.battlers[attackerId]
  if (!moveUser || !isMoveMakingContact(moveData, moveUser, attackerHoldEffect)) return false
  if (hasFlag(opponent.mon.status2, STATUS2_WRAPPED)) return false // CHECK_NOT(... STATUS2_WRAPPED)

  // CHECK(isFirstTurn == 2 || GetAbilityState(battler, ability) || Random() % 100 < 50)
  if (holder.volatiles.isFirstTurn !== 2 && !getAbilityStateOf(holder, 'ABILITY_TALON_TRAP')) {
    if (state.rng.random16() % 100 >= 50) return false
  }

  // SetOnMoveEffectReactionFlags(battler, opponent, MOVE_EFFECT_WRAP) (:4722)
  setOnMoveEffectReactionFlags(state, holderId, opponentId, MOVE_EFFECT_WRAP, { dataContext: deps.dataContext, grounding: deps.grounding })
  // gBattleMons[opponent].status2 |= STATUS2_WRAPPED (:4723)
  opponent.mon.status2 = setFlag(opponent.mon.status2, STATUS2_WRAPPED)
  // gVolatileStructs[opponent].wrapTurns = WrapDuration(battler) (:4724, battle_script_commands.c:2300-2309)
  const hasGrappler = ['ABILITY_GRAPPLER', 'ABILITY_TANGLED_TAILS', 'ABILITY_TENTALOCK'].some((ab) =>
    battlerHasSimAbility(state, holder, ab, false, holderId, false, deps.dataContext),
  )
  const hasGripClaw = deps.grounding.holdEffectOf(holderId) === 'HOLD_EFFECT_GRIP_CLAW'
  opponent.volatiles.wrapTurns =
    hasGrappler || hasGripClaw ? 5 + (hasGrappler ? 1 : 0) + (hasGripClaw ? 2 : 0) : (state.rng.random16() % 2) + 4
  opponent.volatiles.wrapAbility = 'ABILITY_TALON_TRAP' // (:4725)
  state.wrappedMove[opponentId] = 'MOVE_SNAP_TRAP' // (:4727)
  state.wrappedBy[opponentId] = holderId // (:4728)
  return true
}

function handleDefenderMoveEndAbility(
  state: BattleState,
  abilityId: string,
  slotIndex: number,
  targetId: number,
  attackerId: number,
  moveData: SimMoveData | undefined,
  moveId: string,
  targetDamage: number,
  hpDealt: number,
  isCriticalHit: boolean,
  attackerHoldEffect: string | null,
  deps: TurnLoopDeps,
  statusDeps: StatusDeps,
  unmodelled: string[],
  fainted: number[],
): { attackerDamage: number; statusApplied: StatusAppliedOutcome | null; statChanges: StatChangeOutcome[] } {
  const result: { attackerDamage: number; statusApplied: StatusAppliedOutcome | null; statChanges: StatChangeOutcome[] } = {
    attackerDamage: 0,
    statusApplied: null,
    statChanges: [],
  }

  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  if (!attacker || !target) return result

  // Soul Linker (src/abilities.cc:4273-4285, ON_EITHER_ABILITY at :4282-4285). This is the defender
  // half: holder = target, opponent = attacker. BattleScript_AttackerSoulLinker
  // (data/battle_scripts_1.s:11467-11472) runs `healthbarupdate BS_ATTACKER; datahpupdate BS_ATTACKER;
  // tryfaintmon BS_ATTACKER` with gBattleMoveDamage, the move's own damage (positive) -- so the move's
  // attacker takes the damage it dealt. DidMoveHit/ShouldApplyOnHitEffect (:4060-4062) are read as
  // "the move dealt damage", the same reading as Strikeout below.
  if (abilityId === 'ABILITY_SOUL_LINKER') {
    if (
      targetDamage > 0 &&
      target.mon.hp > 0 && // CHECK(IsBattlerAlive(battler))
      attacker.mon.hp > 0 && // ShouldApplyOnHitEffect(opponent)
      moveId !== 'MOVE_PAIN_SPLIT' &&
      !battlerHasSimAbility(state, attacker, 'ABILITY_SOUL_LINKER', false, attackerId, false, deps.dataContext)
    ) {
      applyDamage(state, attackerId, targetDamage, fainted, deps)
      result.attackerDamage += targetDamage
    }
    return result
  }

  // Ape Shift onDefender (src/abilities.cc:9063 -> ApeShiftHandler :9047-9059). The hook itself
  // does not gate on damage: ShouldChangeFormHpBased only needs the HP threshold and the ability,
  // and HandleDefenderAbility (:9050-9084) calls onDefender on every move-end pass. During
  // onDefender gBattlerAttacker is still the move's attacker, so BattleScript_ApeShift's
  // status half targets the ATTACKER (see apeShiftHandler's scriptAttackerId).
  if (abilityId === 'ABILITY_APE_SHIFT') {
    apeShiftHandler(state, targetId, deps, unmodelled, attackerId)
    return result
  }

  // Strikeout (src/abilities.cc:11143-11155): CHECK(DidMoveHit()), CHECK(GetBattlerSide(attacker) != GetBattlerSide(battler)); DidMoveHit is
  // read as "the move dealt damage", like the other ports here. Unlike most defender hooks it does not require the holder to be alive.
  if (abilityId === 'ABILITY_STRIKEOUT') {
    if (targetDamage > 0 && (attackerId & 1) !== (targetId & 1)) strikeoutMarkDamagedBy(target, abilityId, attackerId)
    return result
  }

  // 1. Rough Skin family (src/abilities.cc:784-793, 2262, 7325, 10149, 11224)
  if (
    abilityId === 'ABILITY_ROUGH_SKIN' ||
    abilityId === 'ABILITY_IRON_BARBS' ||
    abilityId === 'ABILITY_DRAGONFRUIT' ||
    abilityId === 'ABILITY_DOUBLE_IRON_BARBS' ||
    abilityId === 'ABILITY_POISON_QUILLS'
  ) {
    if (attacker.mon.hp > 0 && isMoveMakingContact(moveData, attacker, attackerHoldEffect) && !isMagicGuardProtected(state, attacker)) {
      const denom = abilityId === 'ABILITY_DOUBLE_IRON_BARBS' ? 6 : 8
      const dmg = Math.max(1, Math.floor(attacker.mon.maxHp / denom))
      applyDamage(state, attackerId, dmg, fainted, deps)
      result.attackerDamage += dmg
    }
  }

  // 2. Poison Point on defender (src/abilities.cc:987-995, 2101, 9519, 9526, 10149, 11536)
  if (
    abilityId === 'ABILITY_POISON_POINT' ||
    abilityId === 'ABILITY_POISON_TOUCH' ||
    abilityId === 'ABILITY_TOXIC_SHELL' ||
    abilityId === 'ABILITY_VENOM_CROWN' ||
    abilityId === 'ABILITY_BLIGHT_SCALE' ||
    abilityId === 'ABILITY_POISON_QUILLS'
  ) {
    if (attacker.mon.hp > 0 && canBePoisoned(state, targetId, attackerId, 'MOVE_NONE', statusDeps)) {
      if (isMoveMakingContact(moveData, attacker, attackerHoldEffect)) {
        if (state.rng.random16() % 100 < 30) {
          const res = applyPrimaryStatusEffect(state, targetId, attackerId, MOVE_EFFECT_POISON, moveId, statusDeps, unmodelled, false, false, true)
          if (res.applied && res.status) {
            result.statusApplied = { battlerId: attackerId, status: res.status }
          }
        }
      }
    }
  }

  // 3. Static on defender (src/abilities.cc:610-618, 8183)
  if (abilityId === 'ABILITY_STATIC' || abilityId === 'ABILITY_WHITE_NOISE') {
    if (attacker.mon.hp > 0 && canBeParalyzed(state, targetId, attackerId, statusDeps)) {
      const chance = isMoveMakingContact(moveData, attacker, attackerHoldEffect) ? 30 : 10
      if (state.rng.random16() % 100 < chance) {
        const res = applyPrimaryStatusEffect(state, targetId, attackerId, MOVE_EFFECT_PARALYSIS, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          result.statusApplied = { battlerId: attackerId, status: res.status }
        }
      }
    }
  }

  // 4. Flame Body on defender (src/abilities.cc:1126-1134, 4364, 6106)
  if (abilityId === 'ABILITY_FLAME_BODY' || abilityId === 'ABILITY_SMOLDERING_WOOD' || abilityId === 'ABILITY_SUPER_HOT_GOO') {
    if (attacker.mon.hp > 0 && canBeBurned(state, attackerId, targetId, statusDeps)) {
      const chance = isMoveMakingContact(moveData, attacker, attackerHoldEffect) ? 30 : 20
      if (state.rng.random16() % 100 < chance) {
        const res = applyPrimaryStatusEffect(state, targetId, attackerId, MOVE_EFFECT_BURN, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          result.statusApplied = { battlerId: attackerId, status: res.status }
        }
      }
    }
  }

  // 5. Effect Spore on defender (src/abilities.cc:818-845)
  if (abilityId === 'ABILITY_EFFECT_SPORE') {
    if (
      attacker.mon.hp > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !isPowderImmune(state, targetId, attackerId, statusDeps)
    ) {
      if (state.rng.random16() % 100 < 30) {
        const roll = state.rng.random16() % 3
        if (roll === 0) {
          if (canBePoisoned(state, targetId, attackerId, 'MOVE_NONE', statusDeps)) {
            const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_POISON | MOVE_EFFECT_AFFECTS_USER, moveId, statusDeps, unmodelled, false, false, true)
            if (res.applied && res.status) {
              result.statusApplied = { battlerId: attackerId, status: res.status }
            }
          }
        } else if (roll === 1) {
          if (canBeParalyzed(state, targetId, attackerId, statusDeps)) {
            const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_PARALYSIS | MOVE_EFFECT_AFFECTS_USER, moveId, statusDeps, unmodelled, false, false, true)
            if (res.applied && res.status) {
              result.statusApplied = { battlerId: attackerId, status: res.status }
            }
          }
        } else if (roll === 2) {
          if (canSleep(state, attackerId, targetId, statusDeps)) {
            const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_SLEEP | MOVE_EFFECT_AFFECTS_USER, moveId, statusDeps, unmodelled, false, false, true)
            if (res.applied && res.status) {
              result.statusApplied = { battlerId: attackerId, status: res.status }
            }
          }
        }
      }
    }
  }

  // 6. Gooey family on defender (src/abilities.cc:2482-2492, 2496, 3054, 6106, 10949, 11358, 11629)
  if (
    abilityId === 'ABILITY_GOOEY' ||
    abilityId === 'ABILITY_SLIME_MOLD' ||
    abilityId === 'ABILITY_TANGLING_HAIR' ||
    abilityId === 'ABILITY_MASSIVE_PELT' ||
    abilityId === 'ABILITY_MUCUS_MEMBRANE' ||
    abilityId === 'ABILITY_SUPER_HOT_GOO' ||
    abilityId === 'ABILITY_MOUSTACHE'
  ) {
    if (
      attacker.mon.hp > 0 &&
      canLowerStatOrMirrorArmor(state, attackerId, STAT_SPEED, deps.dataContext) &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !testSheerForceFlag(state, targetId, moveId, statusDeps) &&
      !doesSubstituteBlockMove(state, targetId, attackerId, moveId, statusDeps, unmodelled)
    ) {
      const dropRes = changeStatBuffsImplicit(
        state,
        targetId,
        attackerId,
        -1,
        STAT_SPEED,
        STAT_BUFF_UPDATE_MOVE_EFFECT,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (dropRes.delta !== 0) {
        result.statChanges.push({ battlerId: attackerId, stat: STAT_SPEED, change: dropRes.delta })
      }
      if (dropRes.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (targetId & 1) !== (attackerId & 1)) {
        dispatchOnStatLowered(state, attackerId, targetId, { dataContext: deps.dataContext, grounding: deps.grounding }, unmodelled, result.statChanges)
      }
    }
  }

  // 8b. Petal Shield (src/abilities.cc:12438-12446). AbilityStatusEffectSafe(MOVE_EFFECT_DEF_MINUS_1 |
  // MOVE_EFFECT_AFFECTS_USER, battler, attacker) (data/battle_scripts_1.s:10588-10594) makes the
  // holder gBattlerAttacker, so SetMoveEffect's stat-drop path (battle_script_commands.c:2765-2776)
  // lowers the HOLDER's own Defense; ChangeStatBuffsImplicit gets `affectsUser | STAT_BUFF_UPDATE_
  // MOVE_EFFECT`, i.e. MOVE_EFFECT_AFFECTS_USER here, with a non-null BS pointer. CHECK(ShouldApply
  // OnHitEffect(battler)) is read as "the move dealt damage and the holder is alive", the same
  // reading as Weak Armor above; CHECK(CanLowerStat(battler, STAT_DEF)) is the shared helper
  // (Contrary-aware) so Clear Body/White Smoke reach the stat-drop block below.
  if (abilityId === 'ABILITY_PETAL_SHIELD') {
    if (targetDamage > 0 && target.mon.hp > 0 && canLowerStat(state, targetId, STAT_DEF, deps.dataContext)) {
      target.round.disableEjectPack = true // gRoundStructs[battler].disableEjectPack = TRUE
      const defRes = changeStatBuffsImplicit(
        state,
        targetId,
        attackerId,
        -1,
        STAT_DEF,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_UPDATE_MOVE_EFFECT,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (defRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_DEF, change: defRes.delta })
      }
    }
  }

  // 7. Stamina family (src/abilities.cc:2598-2604, 6701, 10949)
  if (
    abilityId === 'ABILITY_STAMINA' ||
    abilityId === 'ABILITY_CROWNED_SHIELD' ||
    abilityId === 'ABILITY_MOUSTACHE'
  ) {
    if (target.mon.hp > 0 && canRaiseStat(state, targetId, STAT_DEF, deps.dataContext)) {
      const stages = isCriticalHit ? 12 : 1
      const res = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        stages,
        STAT_DEF,
        STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_DEF, change: res.delta })
      }
    }
  }

  // 8. Weak Armor (src/abilities.cc:1950-1961, data/battle_scripts_1.s:10300-10324)
  if (abilityId === 'ABILITY_WEAK_ARMOR') {
    if (
      target.mon.hp > 0 &&
      moveData?.split === 'PHYSICAL' &&
      (canRaiseStat(state, targetId, STAT_SPEED, deps.dataContext) || canLowerStat(state, targetId, STAT_DEF, deps.dataContext))
    ) {
      if (moveData?.effect === 'EFFECT_HIT_ESCAPE') {
        target.round.disableEjectPack = true
      }
      const defRes = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        -1,
        STAT_DEF,
        STAT_BUFF_ALLOW_PTR,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (defRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_DEF, change: defRes.delta })
      }
      // No onStatLowered dispatch for this drop: BattleScript_WeakArmorActivates' Defense half does
      // not print from gStatDownStringIds when the drop succeeds. ChangeStatBuffs leaves the chooser
      // at B_MSG_DEFENDER_STAT_FELL (:9736, 1), which is < B_MSG_STAT_WONT_DECREASE (2), so :10303
      // jumps to BattleScript_WeakArmorDefAnim and that prints STRINGID_TARGETABILITYSTATLOWER
      // (data/battle_scripts_1.s:10309-10313). PrepareStringBattle's onStatLowered block runs only
      // for STRINGID_DEFENDERSSTATFELL (src/battle_util.c:1222-1255), so the holder's own Defiant
      // does not react to Weak Armor.
      const speRes = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        2,
        STAT_SPEED,
        STAT_BUFF_ALLOW_PTR,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (speRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPEED, change: speRes.delta })
      }
    }
  }

  // 9. Anger Point family (src/abilities.cc:1461-1473, 6220-6232, 6237, 6624-6636, 6695, 8785-8792)
  if (abilityId === 'ABILITY_ANGER_POINT' || abilityId === 'ABILITY_CROWNED_SWORD') {
    if (target.mon.hp > 0 && canRaiseStat(state, targetId, STAT_ATK, deps.dataContext)) {
      const stages = isCriticalHit ? 12 : 1
      const res = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        stages,
        STAT_ATK,
        STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_ATK, change: res.delta })
      }
    }
  }
  if (abilityId === 'ABILITY_TIPPING_POINT' || abilityId === 'ABILITY_BERSERKER_RAGE') {
    if (target.mon.hp > 0 && canRaiseStat(state, targetId, STAT_SPATK, deps.dataContext)) {
      const stages = isCriticalHit ? 12 : 1
      const res = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        stages,
        STAT_SPATK,
        STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPATK, change: res.delta })
      }
    }
  }
  if (abilityId === 'ABILITY_FORTITUDE') {
    if (target.mon.hp > 0 && canRaiseStat(state, targetId, STAT_SPDEF, deps.dataContext)) {
      const stages = isCriticalHit ? 12 : 1
      const res = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        stages,
        STAT_SPDEF,
        STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPDEF, change: res.delta })
      }
    }
  }
  if (abilityId === 'ABILITY_RAGE_POINT') {
    if (
      target.mon.hp > 0 &&
      isCriticalHit &&
      (canRaiseStat(state, targetId, STAT_ATK, deps.dataContext) || canRaiseStat(state, targetId, STAT_SPATK, deps.dataContext))
    ) {
      const atkRes = changeStatBuffs(
        state,
        targetId,
        targetId,
        attackerId,
        1,
        STAT_ATK,
        MOVE_EFFECT_AFFECTS_USER,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (atkRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_ATK, change: atkRes.delta })
      }
      const spAtkRes = changeStatBuffs(
        state,
        targetId,
        targetId,
        attackerId,
        1,
        STAT_SPATK,
        MOVE_EFFECT_AFFECTS_USER,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (spAtkRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPATK, change: spAtkRes.delta })
      }
    }
  }

  // 10. Berserk family (src/abilities.cc:2759-2769, 8239, 12144)
  if (
    abilityId === 'ABILITY_BERSERK' ||
    abilityId === 'ABILITY_UNLOCKED_POTENTIAL' ||
    abilityId === 'ABILITY_GOING_BERSERK'
  ) {
    if (checkHalfHpAbility(target, hpDealt) && !target.volatiles.abilityState[slotIndex]) {
      const highestStat = getHighestAttackingStatId(state, targetId, deps.statStageRatios)
      if (canRaiseStat(state, targetId, highestStat, deps.dataContext)) {
        target.volatiles.abilityState[slotIndex] = 1
        const res = changeStatBuffs(
          state,
          targetId,
          attackerId,
          targetId,
          1,
          highestStat,
          STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
          false,
          { dataContext: deps.dataContext, grounding: deps.grounding },
          unmodelled,
          moveId,
        )
        if (res.delta !== 0) {
          result.statChanges.push({ battlerId: targetId, stat: highestStat, change: res.delta })
        }
      }
    }
  }

  // 11. Anger Shell (src/abilities.cc:7062-7070, data/battle_scripts_1.s:1848-1893)
  if (abilityId === 'ABILITY_ANGER_SHELL') {
    if (
      checkHalfHpAbility(target, hpDealt) &&
      !target.volatiles.abilityState[slotIndex] &&
      (canRaiseStat(state, targetId, STAT_ATK, deps.dataContext) ||
        canRaiseStat(state, targetId, STAT_SPATK, deps.dataContext) ||
        canRaiseStat(state, targetId, STAT_SPEED, deps.dataContext))
    ) {
      target.volatiles.abilityState[slotIndex] = 1
      const defRes = changeStatBuffs(
        state,
        targetId,
        targetId,
        attackerId,
        -1,
        STAT_DEF,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR | MOVE_EFFECT_CERTAIN,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (defRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_DEF, change: defRes.delta })
      }
      const spDefRes = changeStatBuffs(
        state,
        targetId,
        targetId,
        attackerId,
        -1,
        STAT_SPDEF,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR | MOVE_EFFECT_CERTAIN,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (spDefRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPDEF, change: spDefRes.delta })
      }
      const atkRes = changeStatBuffs(
        state,
        targetId,
        targetId,
        attackerId,
        2,
        STAT_ATK,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (atkRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_ATK, change: atkRes.delta })
      }
      const spAtkRes = changeStatBuffs(
        state,
        targetId,
        targetId,
        attackerId,
        2,
        STAT_SPATK,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (spAtkRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPATK, change: spAtkRes.delta })
      }
      const speRes = changeStatBuffs(
        state,
        targetId,
        targetId,
        attackerId,
        2,
        STAT_SPEED,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (speRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPEED, change: speRes.delta })
      }
    }
  }

  // Balloon Bomber (src/abilities.cc:7759-7762) is Aftermath.onDefender || Inflatable.onDefender.
  // Aftermath's body returns FALSE unconditionally, so `||` never short-circuits the Inflatable half
  // below: both always run, in that order. This is the Aftermath half (use the Balloon Bomber id in
  // the queued action, because that is the `ability` the C's hook was called with).
  if (abilityId === 'ABILITY_BALLOON_BOMBER') {
    if (targetDamage > 0 && !isBattlerAlive(state, targetId)) {
      const highestStat = getHighestAttackingStatId(state, targetId, deps.statStageRatios)
      queueOutOfTurnAttack(state, deps, targetId, attackerId, abilityId, highestStat === STAT_SPATK ? 'MOVE_OUTBURST' : 'MOVE_EXPLOSION', 100)
    }
  }

  // 12. Inflatable family (src/abilities.cc:3861-3868, 7761, 9282, data/battle_scripts_1.s:9075-9096)
  if (
    abilityId === 'ABILITY_INFLATABLE' ||
    abilityId === 'ABILITY_BALLOON_BLITZ' ||
    abilityId === 'ABILITY_BALLOON_BOMBER'
  ) {
    if (
      target.mon.hp > 0 &&
      moveTypeMatches(moveData, 'FIRE', 'FLYING') &&
      (canRaiseStat(state, targetId, STAT_DEF, deps.dataContext) || canRaiseStat(state, targetId, STAT_SPDEF, deps.dataContext))
    ) {
      const defRes = changeStatBuffs(
        state,
        targetId,
        targetId,
        attackerId,
        1,
        STAT_DEF,
        MOVE_EFFECT_AFFECTS_USER,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (defRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_DEF, change: defRes.delta })
      }
      const spDefRes = changeStatBuffs(
        state,
        targetId,
        targetId,
        attackerId,
        1,
        STAT_SPDEF,
        MOVE_EFFECT_AFFECTS_USER,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (spDefRes.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPDEF, change: spDefRes.delta })
      }
    }
  }

  // 13. Toxic Debris (src/abilities.cc:5061-5068)
  if (abilityId === 'ABILITY_TOXIC_DEBRIS') {
    if (targetDamage > 0 && isMoveMakingContact(moveData, attacker, attackerHoldEffect)) {
      const oppSide = (targetId & 1) ^ 1
      const sideState = state.sides[oppSide]!
      if (sideState.timers.toxicSpikesAmount < 2) {
        sideState.timers.toxicSpikesAmount++
        sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_TOXIC_SPIKES)
      }
    }
  }

  // 14. Scrapyard / Loose Quills / Loose Rocks (src/abilities.cc:5044-5051, 5056, 5105-5112, 12285)
  if (
    abilityId === 'ABILITY_SCRAPYARD' ||
    abilityId === 'ABILITY_LOOSE_QUILLS' ||
    abilityId === 'ABILITY_SHATTERED_ARMOR'
  ) {
    if (targetDamage > 0 && isMoveMakingContact(moveData, attacker, attackerHoldEffect)) {
      const oppSide = (targetId & 1) ^ 1
      const sideState = state.sides[oppSide]!
      if (sideState.timers.spikesAmount < 3) {
        sideState.timers.spikesAmount++
        sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_SPIKES)
      }
    }
  }
  if (abilityId === 'ABILITY_LOOSE_ROCKS') {
    if (targetDamage > 0 && isMoveMakingContact(moveData, attacker, attackerHoldEffect)) {
      const oppSide = (targetId & 1) ^ 1
      const sideState = state.sides[oppSide]!
      if (!hasFlag(sideState.statuses, SIDE_STATUS_STEALTH_ROCK)) {
        sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_STEALTH_ROCK)
        sideState.timers.stealthRockType = 5 // TYPE_ROCK
      }
    }
  }

  // 15. Cute Charm family (src/abilities.cc:1207-1215, 6311, 6537, 10009)
  if (
    abilityId === 'ABILITY_CUTE_CHARM' ||
    abilityId === 'ABILITY_TENDER_AFFECTION' ||
    abilityId === 'ABILITY_PRIM_AND_PROPER' ||
    abilityId === 'ABILITY_PURE_LOVE'
  ) {
    if (
      attacker.mon.hp > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      canInfatuate(state, targetId, attackerId, statusDeps)
    ) {
      if (state.rng.random16() % 100 < 50) {
        attacker.mon.status2 = setFlag(attacker.mon.status2, statusInfatuatedWith(targetId))
      }
    }
  }

  // 16. Damp (src/abilities.cc:564-576)
  if (abilityId === 'ABILITY_DAMP') {
    if (
      attacker.mon.hp > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !attacker.mon.types.includes('WATER')
    ) {
      attacker.mon.types = ['WATER', 'WATER', 'MYSTERY']
    }
  }

  // 17. Furnace (src/abilities.cc:5798-5805)
  if (abilityId === 'ABILITY_FURNACE') {
    if (
      target.mon.hp > 0 &&
      moveTypeMatches(moveData, 'ROCK') &&
      canRaiseStat(state, targetId, STAT_SPEED, deps.dataContext)
    ) {
      const res = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        2,
        STAT_SPEED,
        STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPEED, change: res.delta })
      }
    }
  }

  // 18. Guilt Trip (src/abilities.cc:7109-7116, data/battle_scripts_1.s:6158-6175)
  if (abilityId === 'ABILITY_GUILT_TRIP') {
    if (
      attacker.mon.hp > 0 &&
      target.mon.hp <= 0 &&
      (canLowerStat(state, attackerId, STAT_ATK, deps.dataContext) || canLowerStat(state, attackerId, STAT_SPATK, deps.dataContext))
    ) {
      const atkRes = changeStatBuffs(
        state,
        attackerId,
        attackerId,
        targetId,
        -2,
        STAT_ATK,
        STAT_BUFF_ALLOW_PTR | MOVE_EFFECT_AFFECTS_USER,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (atkRes.delta !== 0) {
        result.statChanges.push({ battlerId: attackerId, stat: STAT_ATK, change: atkRes.delta })
      }
      const spAtkRes = changeStatBuffs(
        state,
        attackerId,
        attackerId,
        targetId,
        -2,
        STAT_SPATK,
        STAT_BUFF_ALLOW_PTR | MOVE_EFFECT_AFFECTS_USER,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (spAtkRes.delta !== 0) {
        result.statChanges.push({ battlerId: attackerId, stat: STAT_SPATK, change: spAtkRes.delta })
      }
    }
  }

  // 19. Haunted Spirit family (src/abilities.cc:4321-4332, 7189)
  if (abilityId === 'ABILITY_HAUNTED_SPIRIT' || abilityId === 'ABILITY_VENGEFUL_SPIRIT') {
    if (
      attacker.mon.hp > 0 &&
      target.mon.hp <= 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !attacker.mon.types.includes('GHOST') &&
      !hasFlag(attacker.mon.status2, STATUS2_CURSED)
    ) {
      attacker.mon.status2 = setFlag(attacker.mon.status2, STATUS2_CURSED)
    }
  }

  // 20. Ill Will (src/abilities.cc:7278-7292)
  if (abilityId === 'ABILITY_ILL_WILL') {
    if (
      attacker.mon.hp > 0 &&
      target.mon.hp <= 0 &&
      moveId !== 'MOVE_STRUGGLE' &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect)
    ) {
      // gChosenMovePos: the slot of the move being used; a called move (Metronome etc.) has no slot of its own.
      const slot = attacker.mon.moves.indexOf(moveId)
      if (slot === -1) {
        unmodelled.push(`Ill Will: ${moveId} is not in the attacker's move slots, so gChosenMovePos is unknown`)
      } else if (attacker.mon.pp[slot]! > 0) {
        attacker.mon.pp[slot] = 0
      }
    }
  }

  // 21. Itchy Defense (src/abilities.cc:6154-6170, battle_script_commands.c:2300-2309)
  if (abilityId === 'ABILITY_ITCHY_DEFENSE') {
    if (
      attacker.mon.hp > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !hasFlag(attacker.mon.status2, STATUS2_WRAPPED)
    ) {
      // SetOnMoveEffectReactionFlags(battler, attacker, MOVE_EFFECT_WRAP) (src/abilities.cc:6160)
      setOnMoveEffectReactionFlags(
        state,
        targetId,
        attackerId,
        MOVE_EFFECT_WRAP,
        { dataContext: deps.dataContext, grounding: deps.grounding },
      )
      attacker.mon.status2 = setFlag(attacker.mon.status2, STATUS2_WRAPPED)
      // HasGrappler: bitfields.grappler (grep '"grappler"' abilityHooks.json -> Grappler, Tangled Tails, Tentalock)
      const hasGrappler = ['ABILITY_GRAPPLER', 'ABILITY_TANGLED_TAILS', 'ABILITY_TENTALOCK'].some((ab) =>
        battlerHasSimAbility(state, target, ab, false, targetId, false, deps.dataContext),
      )
      const hasGripClaw = deps.grounding.holdEffectOf(targetId) === 'HOLD_EFFECT_GRIP_CLAW'
      attacker.volatiles.wrapTurns =
        hasGrappler || hasGripClaw ? 5 + (hasGrappler ? 1 : 0) + (hasGripClaw ? 2 : 0) : (state.rng.random16() % 2) + 4
      attacker.volatiles.wrapAbility = abilityId
      unmodelled.push('Itchy Defense set STATUS2_WRAPPED; ENDTURN_WRAP damage and the trap are not modelled')
    }
  }

  // 22. Sand Spit (src/abilities.cc:3317-3337)
  if (abilityId === 'ABILITY_SAND_SPIT') {
    if (
      target.mon.hp > 0 &&
      !hasFlag(state.field.weather, WEATHER_SANDSTORM_ANY) &&
      !hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)
    ) {
      const changed = tryChangeBattleWeather(state, targetId, ENUM_WEATHER_SANDSTORM, true, deps)
      if (changed) {
        if (!isBattlerGrounded(state, attackerId, deps.grounding) && attacker.mon.hp > 0) {
          attacker.statuses3 = setFlag(attacker.statuses3, STATUS3_SMACKED_DOWN)
          attacker.statuses3 = clearFlag(attacker.statuses3, STATUS3_MAGNET_RISE | STATUS3_TELEKINESIS | STATUS3_ON_AIR)
        }
        dispatchOnWeatherChange(state, deps, unmodelled) // BattleScript_SandSpitActivates, battle_scripts_1.s:9622-9627
      }
    }
  }

  // 23. Seed Sower (src/abilities.cc:6859-6866, battle_util.c:3778-3795)
  if (abilityId === 'ABILITY_SEED_SOWER') {
    if (target.mon.hp > 0) {
      if (tryChangeBattleTerrain(state, targetId, STATUS_FIELD_GRASSY_TERRAIN, deps)) {
        dispatchOnTerrainChange(state, deps, unmodelled)
      }
    }
  }

  // 24. Wind Power (src/abilities.cc:7032-7041)
  if (abilityId === 'ABILITY_WIND_POWER') {
    if (target.mon.hp > 0 && !!moveData?.flags?.airBased && !hasFlag(target.statuses3, STATUS3_CHARGED_UP)) {
      target.statuses3 = setFlag(target.statuses3, STATUS3_CHARGED_UP)
    }
  }

  // 25. Cotton Down family (src/abilities.cc:3242-3252, 9982, data/battle_scripts_1.s:8553-8575)
  // DidMoveHit, then BATTLE_OPPOSITE(battler) or its partner alive; the script walks gBattlerTarget from
  // GetOppositeSide(battler) in steps of 2, skipping absent battlers, with the holder as gBattlerAttacker.
  if (abilityId === 'ABILITY_COTTON_DOWN' || abilityId === 'ABILITY_SCARECROW') {
    const opposite = targetId ^ 1
    const anyAlive = (state.battlers[opposite]?.mon.hp ?? 0) > 0 || (state.battlers[opposite ^ 2]?.mon.hp ?? 0) > 0
    if (targetDamage > 0 && anyAlive) {
      for (let foeId = (targetId & 1) ^ 1; foeId < state.battlersCount; foeId += 2) {
        if ((state.battlers[foeId]?.mon.hp ?? 0) <= 0) continue
        const res = changeStatBuffs(
          state,
          foeId,
          targetId,
          foeId,
          -1,
          STAT_SPEED,
          STAT_BUFF_NOT_PROTECT_AFFECTED,
          true,
          { dataContext: deps.dataContext, grounding: deps.grounding },
          unmodelled,
          moveId,
        )
        if (res.delta !== 0) {
          result.statChanges.push({ battlerId: foeId, stat: STAT_SPEED, change: res.delta })
        }
        if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (targetId & 1) !== (foeId & 1)) {
          dispatchOnStatLowered(state, foeId, targetId, { dataContext: deps.dataContext, grounding: deps.grounding }, unmodelled, result.statChanges)
        }
      }
    }
  }

  // 26. Cursed Body (src/abilities.cc:1910-1924)
  if (abilityId === 'ABILITY_CURSED_BODY') {
    if (
      attacker.mon.hp > 0 &&
      !attacker.volatiles.disabledMove &&
      !isAbilityStatusProtected(state, attackerId, CHECK_RESTRICTING, targetId, statusDeps) &&
      (attacker.mon.pp[attacker.mon.moves.indexOf(moveId)] ?? 0) > 0
    ) {
      if (state.rng.random16() % 100 < 30) {
        attacker.volatiles.disabledMove = moveId
        attacker.volatiles.disableTimer = 4
        attacker.volatiles.disableTimerStartValue = 4
      }
    }
  }

  // 27. Justified-style defender stat raises
  if (abilityId === 'ABILITY_RATTLED') {
    // src/abilities.cc:2213-2224
    if (
      target.mon.hp > 0 &&
      moveTypeMatches(moveData, 'DARK', 'BUG', 'GHOST') &&
      canRaiseStat(state, targetId, STAT_SPEED, deps.dataContext)
    ) {
      const res = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        1,
        STAT_SPEED,
        STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPEED, change: res.delta })
      }
    }
  }
  if (abilityId === 'ABILITY_WATER_COMPACTION') {
    // src/abilities.cc:2650-2659
    if (
      target.mon.hp > 0 &&
      moveTypeMatches(moveData, 'WATER') &&
      canRaiseStat(state, targetId, STAT_DEF, deps.dataContext)
    ) {
      const res = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        2,
        STAT_DEF,
        STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_DEF, change: res.delta })
      }
    }
  }
  if (abilityId === 'ABILITY_STEAM_ENGINE') {
    // src/abilities.cc:3291-3300
    if (
      target.mon.hp > 0 &&
      moveTypeMatches(moveData, 'FIRE', 'WATER') &&
      canRaiseStat(state, targetId, STAT_SPEED, deps.dataContext)
    ) {
      const res = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        12,
        STAT_SPEED,
        STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPEED, change: res.delta })
      }
    }
  }
  if (abilityId === 'ABILITY_THERMAL_EXCHANGE' || abilityId === 'ABILITY_THERMAL_ENTROPY') {
    // src/abilities.cc:7339-7348, 12405
    if (
      target.mon.hp > 0 &&
      moveTypeMatches(moveData, 'FIRE') &&
      canRaiseStat(state, targetId, STAT_ATK, deps.dataContext)
    ) {
      const res = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        1,
        STAT_ATK,
        STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: targetId, stat: STAT_ATK, change: res.delta })
      }
    }
  }

  // Cryo Architect onDefender (src/abilities.cc:9602-9633). CHECK(ShouldApplyOnHitEffect(battler)) ->
  // the holder is alive and the hit dealt damage (the neighbouring defender reading); CHECK(moveType
  // == WATER || ICE). If Def can still rise (CanRaiseStat == CompareStat(..., CMP_LESS_THAN), :9610):
  // a Water move only arms bit 1 of the ability state (`state |= 1 << 1`, :9612-9615) -- the raise
  // happens two end turns later, see endTurn.ts -- while an Ice move raises Def by 1 at once (:9617-9620,
  // BattleScript_TargetAbilityStatRaiseOnMoveEnd == Steam Engine's script, so the same ChangeStatBuffs).
  // Independent of that branch, Atk rises by 1 whenever it can, for either type (:9624-9628).
  // SetStatChanger + BattleScriptCall(TargetAbilityStatRaiseOnMoveEnd) is transcribed as the
  // Steam Engine / Thermal Exchange changeStatBuffs calls just above.
  if (abilityId === 'ABILITY_CRYO_ARCHITECT') {
    if (target.mon.hp > 0 && targetDamage > 0 && moveTypeMatches(moveData, 'WATER', 'ICE')) {
      const isWater = moveTypeMatches(moveData, 'WATER')
      if (canRaiseStat(state, targetId, STAT_DEF, deps.dataContext)) {
        if (isWater) {
          target.volatiles.abilityState[slotIndex] = (target.volatiles.abilityState[slotIndex] ?? 0) | (1 << 1)
        } else {
          const defRes = changeStatBuffs(
            state,
            targetId,
            attackerId,
            targetId,
            1,
            STAT_DEF,
            STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
            false,
            { dataContext: deps.dataContext, grounding: deps.grounding },
            unmodelled,
            moveId,
          )
          if (defRes.delta !== 0) {
            result.statChanges.push({ battlerId: targetId, stat: STAT_DEF, change: defRes.delta })
          }
        }
      }
      if (canRaiseStat(state, targetId, STAT_ATK, deps.dataContext)) {
        const atkRes = changeStatBuffs(
          state,
          targetId,
          attackerId,
          targetId,
          1,
          STAT_ATK,
          STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
          false,
          { dataContext: deps.dataContext, grounding: deps.grounding },
          unmodelled,
          moveId,
        )
        if (atkRes.delta !== 0) {
          result.statChanges.push({ battlerId: targetId, stat: STAT_ATK, change: atkRes.delta })
        }
      }
    }
  }

  // 28. Electromorphosis family (src/abilities.cc:5299-5308, 5313)
  if (abilityId === 'ABILITY_ELECTROMORPHOSIS' || abilityId === 'ABILITY_ATOMIC_BURST') {
    if (target.mon.hp > 0 && !hasFlag(target.statuses3, STATUS3_CHARGED_UP)) {
      target.statuses3 = setFlag(target.statuses3, STATUS3_CHARGED_UP)
    }
  }

  // 29. Innards Out (src/abilities.cc:2995-3005; BattleScript_AftermathDmg, data/battle_scripts_1.s:8585-8592)
  // gBattleMoveDamage = gTurnStructs[battler].dmg: the sim does not maintain TurnState.dmg (first damage taken this turn, :1933),
  // so the hit's own hp dealt stands in -- identical for a single-hit KO of a mon that was undamaged this turn.
  if (abilityId === 'ABILITY_INNARDS_OUT') {
    if (targetDamage > 0 && attacker.mon.hp > 0 && target.mon.hp <= 0 && !isMagicGuardProtected(state, attacker)) {
      applyDamage(state, attackerId, hpDealt, fainted, deps)
      result.attackerDamage += hpDealt
    }
  }

  // 30. Spiteful (src/abilities.cc:6610-6620; BattleScript_AbilitySpiteful, data/battle_scripts_1.s:4833-4840;
  // Cmd_tryspiteppreduce, src/battle_script_commands.c:10975-11020). swapbattlerandtargetvia34 makes gBattlerTarget the attacker,
  // so Spite's PP cut lands on gLastMoves[attacker] -- the attacker's PREVIOUS move, since MOVEEND_UPDATE_LAST_MOVES (:4750)
  // runs after MOVEEND_ABILITIES. B_CAN_SPITE_FAIL / B_PP_REDUCED_BY_SPITE take the Gen 4+ branch, as handleSpite does.
  if (abilityId === 'ABILITY_SPITEFUL') {
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 &&
      moveId !== 'MOVE_STRUGGLE' &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      (attacker.mon.pp[state.chosenMovePositions[attackerId] ?? 0] ?? 0) > 0
    ) {
      const lastMove = attacker.lastMove
      const slot = lastMove && lastMove !== MOVE_UNSET ? attacker.mon.moves.indexOf(lastMove) : -1
      if (lastMove && lastMove !== 'MOVE_NONE' && slot !== -1 && (attacker.mon.pp[slot] ?? 0) !== 0) {
        const ppToDeduct = Math.min(4, attacker.mon.pp[slot] ?? 0)
        attacker.mon.pp[slot] = (attacker.mon.pp[slot] ?? 0) - ppToDeduct
        if (attacker.mon.pp[slot] === 0) cancelMultiTurnMoves(attacker)
      }
    }
  }

  // 31. Contact counterattacks: Cold Rebound, Ice Downfall, Snap Trap (ability) -- UseOutOfTurnAttack(battler, attacker, ability, move, power)
  const counterattack = CONTACT_COUNTERATTACKS[abilityId]
  if (counterattack) {
    if (targetDamage > 0 && attacker.mon.hp > 0 && isMoveMakingContact(moveData, attacker, attackerHoldEffect)) {
      queueOutOfTurnAttack(state, deps, targetId, attackerId, abilityId, counterattack[0], counterattack[1])
    }
  }

  // 32. Supersweet Syrup (src/abilities.cc:8957-8972; BattleScript_AnnounceAttackerItemDisabled, data/battle_scripts_1.s:12448-12451)
  if (abilityId === 'ABILITY_SUPERSWEET_SYRUP') {
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !hasFlag(attacker.statuses3, STATUS3_EMBARGO) &&
      attacker.mon.itemId !== null
    ) {
      attacker.volatiles.embargoTimer = 2
      attacker.statuses3 = setFlag(attacker.statuses3, STATUS3_EMBARGO)
    }
  }

  // 33. Drop Blocks (src/abilities.cc:10996-11004; BattleScript_DefenderSetsSpikeLayer_Scrapyard, data/battle_scripts_1.s:9390-9398).
  // Scrapyard's hook without the contact check. checkcondition CONDITION_SPIKES (battle_script_commands.c:9606-9611) layers the
  // attacker's side (gBattlerTarget after swapbattlerandtargetvia34).
  if (abilityId === 'ABILITY_DROP_BLOCKS') {
    if (targetDamage > 0) {
      const sideState = state.sides[(targetId & 1) ^ 1]!
      if (sideState.timers.spikesAmount < 3) {
        sideState.timers.spikesAmount++
        sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_SPIKES)
      }
    }
  }

  // 34. Loose Thorns (src/abilities.cc:11042-11051; BattleScript_DefenderSetsCreepingThorns, data/battle_scripts_1.s:9439-9447;
  // CONDITION_CREEPING_THORNS, battle_script_commands.c:9627-9633): Stealth Rock slot filled with TYPE_GRASS.
  if (abilityId === 'ABILITY_LOOSE_THORNS') {
    if (targetDamage > 0 && isMoveMakingContact(moveData, attacker, attackerHoldEffect)) {
      const sideState = state.sides[(targetId & 1) ^ 1]!
      if (!hasFlag(sideState.statuses, SIDE_STATUS_STEALTH_ROCK)) {
        sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_STEALTH_ROCK)
        sideState.timers.stealthRockType = TYPE_NAME_BY_ID.indexOf('GRASS')
      }
    }
  }

  // 35. Voodoo Power (src/abilities.cc:6813-6823): AbilityStatusEffect(MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_BLEED) bleeds the attacker.
  // IS_MOVE_SPECIAL reads GetBattleMoveSplit (battle_util.c:8348-8357), which gSwapDamageCategory can flip; the sim carries no such
  // flag past damage calculation, so the declared split is used.
  if (abilityId === 'ABILITY_VOODOO_POWER') {
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 &&
      moveData?.split === 'SPECIAL' &&
      canBleed(state, attackerId, attackerId, statusDeps) &&
      state.rng.random16() % 100 < 30
    ) {
      const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_BLEED | MOVE_EFFECT_AFFECTS_USER, moveId, statusDeps, unmodelled, false, false, true)
      if (res.applied && res.status) {
        result.statusApplied = { battlerId: attackerId, status: res.status }
      }
    }
  }

  // 36. Mummy (src/abilities.cc:2182-2195; BattleScript_MummyActivates, data/battle_scripts_1.s:10226-10229)
  // ReplaceAbility (battle_util.c:9325) writes abilities[0]; IsPersistentOrUnsuppressableAbility (:4790) reads GetBattlerAbility (abilities[0]).
  // Lingering Aroma is `Impl<ABILITY_MUMMY>.onDefender` (abilities.cc:5826-5828): the hook's `ability` is the holder's own, so it spreads itself.
  if (abilityId === 'ABILITY_MUMMY' || abilityId === 'ABILITY_LINGERING_AROMA') {
    const attackerPrimary = attacker.mon.abilities.ability ?? 'ABILITY_NONE'
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 &&
      !hasAbilityIgnoringSuppression(attacker, abilityId) &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES.includes(attackerPrimary) &&
      !doesBattlerHaveAbilityShield(attacker, deps)
    ) {
      updateAbilityStateForNewAbility(attacker, abilityId)
      attacker.mon.abilities.ability = abilityId
    }
  }

  // 37. Flammable Coat (src/abilities.cc:8320-8344; BattleScript_TargetFormChange, data/battle_scripts_1.s:8532-8540)
  // Handle-form-change cases 0-2 (battle_script_commands.c:7491-7512) are changeBattlerForm; `switchinabilities BS_ATTACKER` runs after
  // swapbattlerandtargetvia34, i.e. for the holder. This hook is reached only for a damaging hit (the call site's targetDamage gate),
  // so the RESOURCE_FLAG_FLASH_FIRE half of the CHECK matters only for a hit that damaged an already-Flash-Fire-boosted holder.
  if (abilityId === 'ABILITY_FLAMMABLE_COAT') {
    if (
      ((targetDamage > 0 && target.mon.hp > 0) || target.volatiles.flashFire) &&
      moveTypeMatches(moveData, 'FIRE') &&
      target.mon.speciesId === 'SPECIES_LUMBERING_SLOTH' &&
      !hasFlag(target.mon.status2, STATUS2_TRANSFORMED)
    ) {
      changeBattlerForm(state, targetId, 'SPECIES_LUMBERING_SLOTH_ENGULFED', deps.dataContext)
      applySwitchInAbilities(state, targetId, deps, unmodelled)
    }
  }

  // 38. Brain Overload / Power Leak (src/abilities.cc:11645-11655 / 10916-10926): CHECK(DidMoveHit()), then TryChangeBattleTerrain
  // (battle_util.c:3778-3795) for the holder; BattleScript_SurgeActivatesRet (data/battle_scripts_1.s:9957-9962) runs OnTerrainChanged.
  if (abilityId === 'ABILITY_BRAIN_OVERLOAD' || abilityId === 'ABILITY_POWER_LEAK') {
    const terrainFlag = abilityId === 'ABILITY_BRAIN_OVERLOAD' ? STATUS_FIELD_PSYCHIC_TERRAIN : STATUS_FIELD_ELECTRIC_TERRAIN
    if (targetDamage > 0 && tryChangeBattleTerrain(state, targetId, terrainFlag, deps)) {
      dispatchOnTerrainChange(state, deps, unmodelled)
    }
  }

  // 39. Deflect (src/abilities.cc:12536-12544): Parry's shape without the contact check -- UseOutOfTurnAttack(MOVE_VACUUM_WAVE, 20).
  if (abilityId === 'ABILITY_DEFLECT') {
    if (targetDamage > 0 && attacker.mon.hp > 0) {
      queueOutOfTurnAttack(state, deps, targetId, attackerId, abilityId, 'MOVE_VACUUM_WAVE', 20)
    }
  }

  // 40. Fog Machine (src/abilities.cc:10979-10993): ShouldApplyOnHitEffect(battler), no Fog yet; under primal weather
  // BattleScript_BlockedByPrimalWeatherRet (bs1:5587-5590) only shows the popup; else TryChangeBattleWeather + BattleScript_FogStartsReturn (bs1:9880-9886).
  if (abilityId === 'ABILITY_FOG_MACHINE') {
    if (
      targetDamage > 0 &&
      target.mon.hp > 0 &&
      !hasFlag(state.field.weather, WEATHER_FOG_ANY) &&
      !hasFlag(state.field.weather, WEATHER_PRIMAL_ANY) &&
      tryChangeBattleWeather(state, targetId, ENUM_WEATHER_FOG, true, deps)
    ) {
      dispatchOnWeatherChange(state, deps, unmodelled)
    }
  }

  // 41. Crispy Cream (src/abilities.cc:10838-10842): `Random() % 2 ? Flame Body : Freezing Point` -- the coin is drawn before either hook's own checks.
  if (abilityId === 'ABILITY_CRISPY_CREAM') {
    const flameBody = state.rng.random16() % 2 !== 0
    if (targetDamage > 0 && attacker.mon.hp > 0) {
      const contact = isMoveMakingContact(moveData, attacker, attackerHoldEffect)
      if (flameBody) {
        // Flame Body (abilities.cc:1126-1134): contact 30, otherwise 20
        if (canBeBurned(state, attackerId, targetId, statusDeps) && state.rng.random16() % 100 < (contact ? 30 : 20)) {
          const res = applyPrimaryStatusEffect(state, targetId, attackerId, MOVE_EFFECT_BURN, moveId, statusDeps, unmodelled, false, false, true)
          if (res.applied && res.status) {
            result.statusApplied = { battlerId: attackerId, status: res.status }
          }
        }
      } else if (canGetFrostbite(state, attackerId, targetId, statusDeps) && state.rng.random16() % 100 < (contact ? 20 : 30)) {
        // Freezing Point (abilities.cc:6360-6367): contact 20, otherwise 30
        const res = applyPrimaryStatusEffect(state, targetId, attackerId, MOVE_EFFECT_FROSTBITE, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          result.statusApplied = { battlerId: attackerId, status: res.status }
        }
      }
    }
  }

  // 42. Malodor (src/abilities.cc:9853-9864): contact Gastro Acid on the attacker (BattleScript_StackAbilitySuppressedMessage is message-only).
  if (abilityId === 'ABILITY_MALODOR') {
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !hasFlag(attacker.statuses3, STATUS3_GASTRO_ACID) &&
      !doesBattlerHaveAbilityShield(attacker, deps)
    ) {
      attacker.statuses3 = setFlag(attacker.statuses3, STATUS3_GASTRO_ACID)
    }
  }

  // 43. Perish Body (src/abilities.cc:3469-3487; BattleScript_PerishBodyActivates bs1:7793-7797 is message-only): both mons get a 3-turn
  // perish count, the holder keeping an existing one.
  if (abilityId === 'ABILITY_PERISH_BODY') {
    if (
      targetDamage > 0 &&
      target.mon.hp > 0 &&
      attacker.mon.hp > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !hasFlag(attacker.statuses3, STATUS3_PERISH_SONG)
    ) {
      if (!hasFlag(target.statuses3, STATUS3_PERISH_SONG)) {
        target.statuses3 = setFlag(target.statuses3, STATUS3_PERISH_SONG)
        target.volatiles.perishSongTimer = 3
        target.volatiles.perishSongTimerStartValue = 3
      }
      attacker.statuses3 = setFlag(attacker.statuses3, STATUS3_PERISH_SONG)
      attacker.volatiles.perishSongTimer = 3
      attacker.volatiles.perishSongTimerStartValue = 3
    }
  }

  // 44. No Turning Back (src/abilities.cc:8307-8317; BattleScript_NoTurningBack bs1:1895-1902): once per holder, when the hit drops it to half HP or
  // below. trynoretreat BS_TARGET = VARIOUS_TRY_NO_RETREAT (battle_script_commands.c:8126-8133) sets only volatiles.noRetreat (unlike the No Retreat
  // move, no STATUS2_ESCAPE_PREVENTION), then BattleScript_AllStatsUp (bs1:7891-7925) raises the holder's five stats by 1.
  if (abilityId === 'ABILITY_NO_TURNING_BACK') {
    if (
      checkHalfHpAbility(target, hpDealt) &&
      !target.volatiles.abilityState[slotIndex] &&
      !target.volatiles.noRetreat &&
      !hasFlag(target.mon.status2, STATUS2_ESCAPE_PREVENTION)
    ) {
      target.volatiles.abilityState[slotIndex] = 1
      target.volatiles.noRetreat = true
      for (const statId of [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]) {
        const res = changeStatBuffsImplicit(
          state,
          targetId,
          targetId,
          1,
          statId,
          MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
          true,
          { dataContext: deps.dataContext, grounding: deps.grounding },
          unmodelled,
          moveId,
        )
        if (res.delta !== 0) {
          result.statChanges.push({ battlerId: targetId, stat: statId, change: res.delta })
        }
      }
    }
  }

  // 45. Freezing Point (src/abilities.cc:6359-6367 FreezingPointOnEither) and Cryo Proficiency (:6387-6391: `Impl<ABILITY_FREEZING_POINT>.onDefender(...) |
  // CryoProficiencyHail(battler)`, a non-short-circuit `|`, so the Frostbite roll is drawn before the Hail check). Frostbite: ShouldApplyOnHitEffect(opponent),
  // CanGetFrostbite, then Random() % 100 < (contact ? 20 : 30); AbilityStatusEffectSafe(MOVE_EFFECT_FROSTBITE, battler, opponent) = holder inflicts, attacker receives.
  if (abilityId === 'ABILITY_FREEZING_POINT' || abilityId === 'ABILITY_CRYO_PROFICIENCY') {
    if (targetDamage > 0 && attacker.mon.hp > 0 && canGetFrostbite(state, attackerId, targetId, statusDeps)) {
      const chance = isMoveMakingContact(moveData, attacker, attackerHoldEffect) ? 20 : 30
      if (state.rng.random16() % 100 < chance) {
        const res = applyPrimaryStatusEffect(state, targetId, attackerId, MOVE_EFFECT_FROSTBITE, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          result.statusApplied = { battlerId: attackerId, status: res.status }
        }
      }
    }
  }

  // 46. CryoProficiencyHail (src/abilities.cc:6373-6385): ShouldApplyOnHitEffect(battler), no Hail up; under primal weather BattleScript_BlockedByPrimalWeatherRet
  // (bs1:5587-5590) only shows the popup; else TryChangeBattleWeather(battler, ENUM_WEATHER_HAIL, TRUE) + BattleScript_CryoProficiencyActivates (bs1:9629-9634,
  // ends in BattleScript_OnWeatherChange). Same shape as Fog Machine.
  if (abilityId === 'ABILITY_CRYO_PROFICIENCY') {
    if (
      targetDamage > 0 &&
      target.mon.hp > 0 &&
      !hasFlag(state.field.weather, WEATHER_HAIL_ANY) &&
      !hasFlag(state.field.weather, WEATHER_PRIMAL_ANY) &&
      tryChangeBattleWeather(state, targetId, ENUM_WEATHER_HAIL, true, deps)
    ) {
      dispatchOnWeatherChange(state, deps, unmodelled)
    }
  }

  // 51. Spike Armor / Fragrant Daze / Hypnotic Touch, defender half (ON_EITHER hooks, abilities.cc:6798-6806 / 7792-7800 / 11267-11275): ShouldApplyOnHitEffect(opponent),
  // CanX(opponent), IsMoveMakingContact, Random() % 100 < chance, AbilityStatusEffectSafe(effect, battler, opponent) = holder inflicts, the attacker receives.
  const contactStatus = ON_EITHER_CONTACT_STATUS[abilityId]
  if (contactStatus) {
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 &&
      contactStatus.can(state, attackerId, targetId, statusDeps) &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      state.rng.random16() % 100 < contactStatus.chance
    ) {
      const res = applyPrimaryStatusEffect(state, targetId, attackerId, contactStatus.effect, moveId, statusDeps, unmodelled, false, false, true)
      if (res.applied && res.status) {
        result.statusApplied = { battlerId: attackerId, status: res.status }
      }
    }
  }

  // 52. Magical Dust, defender half (src/abilities.cc:3990-4003 MagicalDustOnEither): ShouldApplyOnHitEffect(opponent), contact, opponent not already Psychic ->
  // type1 = type2 = Psychic, type3 = Mystery (BattleScript_StackBecameTheTypeFull is message-only).
  if (abilityId === 'ABILITY_MAGICAL_DUST') {
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !attacker.mon.types.includes('PSYCHIC')
    ) {
      attacker.mon.types = ['PSYCHIC', 'PSYCHIC', 'MYSTERY']
    }
  }

  // 47. Resilience (src/abilities.cc:12161-12175; BattleScript_ResilienceActivates bs1:12582-12589): once per holder, when the hit takes it from above half
  // HP to half or below (CheckHalfHpAbility, battle_util.c:9043-9048), CanBattlerHeal, and GetSingleUseAbilityCounter is 0 (-1, "no such ability slot", is
  // also non-zero and blocks). Heals maxHP / 4 (minimum 1) through the passive-damage path of datahpupdate (capped at max HP).
  if (abilityId === 'ABILITY_RESILIENCE') {
    if (
      checkHalfHpAbility(target, hpDealt) &&
      canBattlerHeal(state, targetId, target, unmodelled) &&
      getSingleUseAbilityCounter(state, targetId, abilityId, deps.dataContext) === 0
    ) {
      const heal = Math.max(1, Math.floor(target.mon.maxHp / 4))
      target.mon.hp = Math.min(target.mon.maxHp, target.mon.hp + heal)
      syncPartyHp(state, targetId)
      setSingleUseAbilityCounter(state, targetId, abilityId, 1, deps.dataContext)
    }
  }

  // 48. Wind Chimes (src/abilities.cc:12513-12522): Deflect's shape with Hyper Voice at power 30 -- ShouldApplyOnHitEffect(attacker), no contact check.
  if (abilityId === 'ABILITY_WIND_CHIMES') {
    if (targetDamage > 0 && attacker.mon.hp > 0) {
      queueOutOfTurnAttack(state, deps, targetId, attackerId, abilityId, 'MOVE_HYPER_VOICE', 30)
    }
  }

  // 49. Victory Bomb (src/abilities.cc:9006-9018) and Unstable Core (:12525-12528 = `Impl<ABILITY_AFTERMATH>.onDefender`, :1663-1670): CHECK_NOT(IsBattlerAlive(battler)),
  // then UseOutOfTurnAttack(battler, attacker, ability, move, 100). The fainted holder is allowed because the move is EFFECT_EXPLOSION (battle_util.c:3764).
  // Aftermath/Unstable Core pick Outburst over Explosion when GetHighestAttackingStatId(battler, TRUE) is Sp. Atk (ties go to Attack).
  if (abilityId === 'ABILITY_VICTORY_BOMB') {
    if (targetDamage > 0 && !isBattlerAlive(state, targetId)) {
      queueOutOfTurnAttack(state, deps, targetId, attackerId, abilityId, 'MOVE_EXPLOSION', 100)
    }
  }
  if (abilityId === 'ABILITY_UNSTABLE_CORE') {
    if (targetDamage > 0 && !isBattlerAlive(state, targetId)) {
      const highestStat = getHighestAttackingStatId(state, targetId, deps.statStageRatios)
      queueOutOfTurnAttack(state, deps, targetId, attackerId, abilityId, highestStat === STAT_SPATK ? 'MOVE_OUTBURST' : 'MOVE_EXPLOSION', 100)
    }
  }
  // Aftermath's own onDefender (src/abilities.cc:1663-1670): CHECK_NOT(IsBattlerAlive(battler)), then
  // UseOutOfTurnAttack(battler, attacker, ability, highestStat == STAT_SPATK ? MOVE_OUTBURST :
  // MOVE_EXPLOSION, 100) and return FALSE. Exactly the Unstable Core body above (:12525-12528 aliases
  // this hook); both moves are EFFECT_EXPLOSION, so queueOutOfTurnAttack permits the fainted holder
  // (battle_util.c:3764).
  if (abilityId === 'ABILITY_AFTERMATH') {
    if (targetDamage > 0 && !isBattlerAlive(state, targetId)) {
      const highestStat = getHighestAttackingStatId(state, targetId, deps.statStageRatios)
      queueOutOfTurnAttack(state, deps, targetId, attackerId, abilityId, highestStat === STAT_SPATK ? 'MOVE_OUTBURST' : 'MOVE_EXPLOSION', 100)
    }
  }

  // 50. Wandering Spirit (src/abilities.cc:3490-3515; BattleScript_WanderingSpiritActivates bs1:10242-10248, ..._Swap :10231-10240 is popups only): swap slot-0
  // abilities with a contact attacker. GetBattlerAbility(battler) == ability means only the holder's slot 0 counts (an innate Wandering Spirit does nothing).
  // The two UpdateAbilityStateIndicesForNewAbility calls (battle_util.c:8819-8862) pass the attacker's and the holder's OWN current ability, so as written they
  // are identity remaps; ported as written, not "fixed" to pass the incoming ability. The script then runs `switchinabilities` for the attacker and the
  // holder (VARIOUS_SWITCHIN_ABILITIES, battle_script_commands.c:7090-7101; REQUIRE alive), which applySwitchInAbilities mirrors.
  if (abilityId === 'ABILITY_WANDERING_SPIRIT') {
    const attackerPrimary = attacker.mon.abilities.ability ?? 'ABILITY_NONE'
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 &&
      target.mon.abilities.ability === abilityId &&
      !hasAbilityIgnoringSuppression(attacker, abilityId) &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES.includes(attackerPrimary) &&
      !doesBattlerHaveAbilityShield(attacker, deps)
    ) {
      updateAbilityStateForNewAbility(attacker, attackerPrimary)
      updateAbilityStateForNewAbility(target, abilityId)
      target.mon.abilities.ability = attacker.mon.abilities.ability
      attacker.mon.abilities.ability = abilityId
      applySwitchInAbilities(state, attackerId, deps, unmodelled)
      applySwitchInAbilities(state, targetId, deps, unmodelled)
    }
  }

  // 51. Drakelp Head (src/abilities.cc:12055-12079). CHECK(DidMoveHit()) is read
  // as "the move dealt damage" like the other defender ports; the single-use
  // counter makes it one-shot and is set BEFORE the stat-drop gate
  // (:12060-12062), so a blocked drop still spends it. ShouldApplyOnHitEffect
  // (attacker) = DidMoveHit && IsBattlerAlive(attacker);
  // StatLowerableOrMirrorArmor(attacker, STAT_ATK) is
  // canLowerStatOrMirrorArmor. AbilityStatusEffectSafe(MOVE_EFFECT_ATK_MINUS_1,
  // battler, attacker) makes the HOLDER gBattlerAttacker and the attacker
  // gBattlerTarget (data/battle_scripts_1.s:10588-10594), so the attacker's
  // Attack is the stat that drops.
  // The reform handler (DrakelpHeadReformHandler, :12044-12053) is ported: formChange.ts's
  // drakelpHeadReformHandler runs from switchInAbility.ts's onEntry pass and onWeather.ts's
  // dispatchOnTerrainChange, so a toxic terrain or a repeated switch-in clears the counter.
  if (abilityId === 'ABILITY_DRAKELP_HEAD') {
    if (targetDamage > 0 && getSingleUseAbilityCounter(state, targetId, abilityId, deps.dataContext) === 0) {
      setSingleUseAbilityCounter(state, targetId, abilityId, 1, deps.dataContext)
      const canLowerStat = attacker.mon.hp > 0 && canLowerStatOrMirrorArmor(state, attackerId, STAT_ATK, deps.dataContext)
      if (canLowerStat) {
        applyAbilityStatDrop(state, targetId, attackerId, STAT_ATK, moveId, deps, statusDeps, unmodelled, result)
      }
    }
  }

  // 53. Chuckster (src/abilities.cc:10438-10463): CHECK_NOT(GetAbilityState(battler, ability)),
  // CHECK(DidMoveHit()) (read as "the move dealt damage", like the other defender ports),
  // CHECK(IsMoveMakingContact(move, attacker)). The state is set HERE, at hook time, and the
  // scheduled entry carries no setAbilityState, so a drain that is later filtered (the attacker
  // cannot switch) still spends the ability. The 0.5x contact reduction (:10464-10469) reads the
  // same state on the damage side, which the sim's damage path does not derive from abilityState.
  if (abilityId === 'ABILITY_CHUCKSTER') {
    if (
      targetDamage > 0 &&
      !target.volatiles.abilityState[slotIndex] &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect)
    ) {
      target.volatiles.abilityState[slotIndex] = 1
      // battle_util.c:369-376, no `.setAbilityState`: this hook already spent it.
      tryScheduleSwitch(state, {
        ability: abilityId,
        setAbilityState: false,
        switchingBattler: attackerId,
        sourceBattler: targetId,
      })
    }
  }

  // 54. Restraining Order (src/abilities.cc:8579-8597): CHECK_NOT(GetAbilityState(battler, ability)),
  // CHECK(ShouldApplyOnHitEffect(attacker)) (DidMoveHit && IsBattlerAlive(attacker), battle_util.c:4062),
  // CHECK(CanBattlerBeForceSwitched(attacker)) (battle_util.c:2608-2616): alive, CanBattlerSwitch,
  // BATTLE_TYPE_TRAINER, not BATTLE_TYPE_ARENA, CountUsablePartyMons nonzero. Contact is NOT required.
  // `.setAbilityState` is TRUE, so the DRAIN sets the state after re-checking the ability is still
  // present; a schedule that the drain filters leaves the ability armed.
  if (abilityId === 'ABILITY_RESTRAINING_ORDER') {
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 &&
      !target.volatiles.abilityState[slotIndex] &&
      canBattlerSwitch(state, attackerId) &&
      hasFlag(state.battleTypeFlags, BATTLE_TYPE_TRAINER) &&
      !hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA) &&
      countUsablePartyMons(state, attackerId) !== 0
    ) {
      tryScheduleSwitch(state, {
        ability: abilityId,
        setAbilityState: true,
        switchingBattler: attackerId,
        sourceBattler: targetId,
      })
    }
  }

  // Gulp Missile onDefender (src/abilities.cc:3289-3301; Gorging script data/battle_scripts_1.s:7799-7836,
  // Gulping :7837-7880). CHECK(ShouldApplyOnHitEffect(attacker)) -> the hit dealt damage and the attacker is
  // alive. The holder must still be Cramorant-Gorging or -Gulping. gBattleMoveDamage = attacker.maxHP / 4,
  // floored to a minimum of 1 (:3294-3295), dealt to the ATTACKER (healthbarupdate/datahpupdate BS_ATTACKER)
  // unless the attacker is Magic Guard protected (`jumpifmagicguard BS_ATTACKER`, :7806 / :7844). If that
  // damage faints the attacker, `getbattlerfainted BS_ATTACKER; jumpifbyte CMP_EQUAL, ..., NoSecondEffect...`
  // (:7810-7811 / :7849-7850) skips the secondary effect. The Gulping Clear Amulet jump (:7850) sits
  // AFTER the Magic Guard jump's landing label (:7851), so a Magic Guard attacker is never checked for
  // the amulet at the script level. Either way the holder reverts to SPECIES_CRAMORANT
  // (:3292-3293, the write after the script at :3296) and the script runs `switchinabilities BS_ATTACKER`
  // after swapbattlerandtargetvia34 (:7820 / :7859 -- after the swap BS_ATTACKER is the holder), which is
  // applySwitchInAbilities for the holder, exactly as the onAttacker half's BattleScript_AttackerFormChange.
  if (abilityId === 'ABILITY_GULP_MISSILE') {
    const species = target.mon.speciesId
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 && // ShouldApplyOnHitEffect(attacker)
      (species === 'SPECIES_CRAMORANT_GORGING' || species === 'SPECIES_CRAMORANT_GULPING')
    ) {
      const gorging = species === 'SPECIES_CRAMORANT_GORGING'
      let attackerFainted = false
      // `jumpifmagicguard BS_ATTACKER, BattleScript_GulpMissileNoDmgGulping` (:7844) jumps PAST the
      // healthbarupdate/datahpupdate/tryfaintmon AND the `jumpifholdeffect BS_ATTACKER,
      // HOLD_EFFECT_CLEAR_AMULET` line (:7850), landing on BattleScript_GulpMissileNoDmgGulping
      // (:7851), which falls through into BattleScript_GulpMissileDoDefense. So the amulet check is
      // reached only when the damage path ran: a Magic Guard attacker holding Clear Amulet still
      // reaches `statbuffchange` (ChangeStatBuffs itself is a separate question -- it re-checks the
      // amulet at battle_script_commands.c:9827 and blocks the stage drop, see REPORT.md).
      const magicGuardProtected = isMagicGuardProtected(state, attacker)
      if (!magicGuardProtected) {
        const dmg = Math.max(1, Math.trunc(attacker.mon.maxHp / 4))
        applyDamage(state, attackerId, dmg, fainted, deps)
        result.attackerDamage += dmg
        attackerFainted = attacker.mon.hp === 0
      }
      // UpdateAbilityStateIndicesForNewSpecies + the species write + the form-change animation is the
      // same changeBattlerForm call the onAttacker half makes; `switchinabilities` is applySwitchInAbilities.
      changeBattlerForm(state, targetId, 'SPECIES_CRAMORANT', deps.dataContext)
      applySwitchInAbilities(state, targetId, deps, unmodelled)
      if (!attackerFainted) {
        if (gorging) {
          // BattleScript_GulpMissileDoParalyze (data/battle_scripts_1.s:7821-7835): swapattackerwithtarget;
          // setmoveeffect MOVE_EFFECT_PARALYSIS; seteffectprimary; swap back. After the swap gBattlerAttacker
          // is the holder, so the holder is the effect's source and the attacker its recipient (Static's
          // argument order), and seteffectprimary is the sim's primary=true path.
          const res = applyPrimaryStatusEffect(state, targetId, attackerId, MOVE_EFFECT_PARALYSIS, moveId, statusDeps, unmodelled)
          if (res.applied && res.status) {
            result.statusApplied = { battlerId: attackerId, status: res.status }
          }
        } else if (magicGuardProtected || attackerHoldEffect !== 'HOLD_EFFECT_CLEAR_AMULET') {
          // BattleScript_GulpMissileDoDefense (data/battle_scripts_1.s:7860-7870). The Clear Amulet
          // jump is :7850 and is unreachable for a Magic Guard attacker: the :7844 jump lands on
          // :7851, one line past it. `statbuffchange STAT_BUFF_NOT_PROTECT_AFFECTED` targets
          // gBattlerAttacker after the script's swapattackerwithtarget, i.e. the move's attacker, and
          // its `changedStatsBattlerId` is also that same attacker, so no onStatLowered dispatch fires
          // (battle_util.c:1222-1255).
          const dropRes = changeStatBuffs(
            state,
            attackerId,
            attackerId,
            targetId,
            -1,
            STAT_DEF,
            STAT_BUFF_NOT_PROTECT_AFFECTED,
            true,
            { dataContext: deps.dataContext, grounding: deps.grounding },
            unmodelled,
            moveId,
          )
          if (dropRes.delta !== 0) {
            result.statChanges.push({ battlerId: attackerId, stat: STAT_DEF, change: dropRes.delta })
          }
        }
      }
    }
  }

  // Talon Trap, onDefender half (src/abilities.cc:4713-4730 via ON_EITHER_ABILITY, :54). Holder =
  // target, opponent = attacker.
  if (abilityId === 'ABILITY_TALON_TRAP') {
    tryTalonTrapWrap(state, deps, targetId, attackerId, attackerId, moveData, targetDamage, attackerHoldEffect)
  }

  return result
}

type AteStatusSpec = {
  type: string
  effect: number | 'DRENCH' | 'ATTRACT' | 'FEAR'
  can: (state: BattleState, attackerId: number, targetId: number, deps: StatusDeps) => boolean
}

/** abilities.cc "-ate" status abilities: attacker type == move type -> 10% status on the target. */
const ATE_ON_HIT_STATUS: Record<string, AteStatusSpec> = {
  ABILITY_HYDRATE: { type: 'WATER', effect: 'DRENCH', can: (st, a, t, d) => canBeDrenched(st, t, a, d) },
  ABILITY_PIXILATE: { type: 'FAIRY', effect: 'ATTRACT', can: (st, a, t, d) => canInfatuate(st, a, t, d) },
  ABILITY_STRIKER_PIXILATE: { type: 'FAIRY', effect: 'ATTRACT', can: (st, a, t, d) => canInfatuate(st, a, t, d) },
  ABILITY_UNICORN: { type: 'FAIRY', effect: 'ATTRACT', can: (st, a, t, d) => canInfatuate(st, a, t, d) },
  ABILITY_MINERALIZE: { type: 'ROCK', effect: MOVE_EFFECT_BLEED, can: (st, a, t, d) => canBleed(st, t, a, d) },
  ABILITY_LEAD_CLAWS: { type: 'ROCK', effect: MOVE_EFFECT_BLEED, can: (st, a, t, d) => canBleed(st, t, a, d) },
  ABILITY_GALVANIZE: { type: 'ELECTRIC', effect: MOVE_EFFECT_PARALYSIS, can: (st, a, t, d) => canBeParalyzed(st, a, t, d) },
  ABILITY_ATOMIC_BURST: { type: 'ELECTRIC', effect: MOVE_EFFECT_PARALYSIS, can: (st, a, t, d) => canBeParalyzed(st, a, t, d) },
  ABILITY_REFRIGERATE: { type: 'ICE', effect: MOVE_EFFECT_FROSTBITE, can: (st, a, t, d) => canGetFrostbite(st, t, a, d) },
  ABILITY_INTOXICATE: { type: 'POISON', effect: MOVE_EFFECT_TOXIC, can: (st, a, t, d) => canBePoisoned(st, a, t, 'MOVE_NONE', d) },
  ABILITY_SLUDGY_MIX: { type: 'POISON', effect: MOVE_EFFECT_TOXIC, can: (st, a, t, d) => canBePoisoned(st, a, t, 'MOVE_NONE', d) },
  ABILITY_EMANATE: { type: 'PSYCHIC', effect: MOVE_EFFECT_CONFUSION, can: (st, a, t, d) => canBeConfused(st, t, a, d) },
  ABILITY_ENLIGHTENED: { type: 'PSYCHIC', effect: MOVE_EFFECT_CONFUSION, can: (st, a, t, d) => canBeConfused(st, t, a, d) },
  ABILITY_IMMOLATE: { type: 'FIRE', effect: MOVE_EFFECT_BURN, can: (st, a, t, d) => canBeBurned(st, t, a, d) },
  ABILITY_SOLAR_FLARE: { type: 'FIRE', effect: MOVE_EFFECT_BURN, can: (st, a, t, d) => canBeBurned(st, t, a, d) },
  ABILITY_SPECTRALIZE: { type: 'GHOST', effect: 'FEAR', can: (st, _a, t, _d) => Boolean(st.battlers[t] && !st.battlers[t]!.volatiles.fear && !hasFlag(st.battlers[t]!.statuses4, STATUS4_FEAR)) },
  ABILITY_DEVIATE: { type: 'DARK', effect: MOVE_EFFECT_ENRAGE, can: (st, _a, t, _d) => Boolean(st.battlers[t] && !hasFlag(st.battlers[t]!.mon.status2, STATUS2_ENRAGED)) },
  ABILITY_MOB_BOSS: { type: 'DARK', effect: MOVE_EFFECT_ENRAGE, can: (st, _a, t, _d) => Boolean(st.battlers[t] && !hasFlag(st.battlers[t]!.mon.status2, STATUS2_ENRAGED)) },
}

/** CanBeDisabled (src/battle_util.c:5019-5022): no disabledMove yet and not ability-protected (CHECK_RESTRICTING). */
function canBeDisabled(state: BattleState, targetId: number, attackerId: number, statusDeps: StatusDeps): boolean {
  const target = state.battlers[targetId]
  if (!target) return false
  return target.volatiles.disabledMove === null && isAbilityStatusProtected(state, targetId, CHECK_RESTRICTING, attackerId, statusDeps) === null
}

/** AbilityStatusEffect (abilities.cc:263-268): sets gBattleScripting.moveEffect and runs BattleScript_AbilityStatusEffect, ignoring Safeguard. */
function applyAbilityOnHitStatus(
  state: BattleState,
  effect: number | 'DRENCH' | 'ATTRACT' | 'FEAR' | 'CURSE' | 'PREVENT_ESCAPE' | 'DISABLE',
  attackerId: number,
  targetId: number,
  moveId: string,
  statusDeps: StatusDeps,
  unmodelled: string[],
  result: { statusApplied: StatusAppliedOutcome | null },
): void {
  const target = state.battlers[targetId]
  if (!target || target.mon.hp === 0) return

  if (testSheerForceFlag(state, attackerId, moveId, statusDeps)) return
  if (doesSubstituteBlockMove(state, attackerId, targetId, moveId, statusDeps, unmodelled)) return

  if (effect === 'DRENCH') {
    if (applyDrenchEffect(state, targetId, attackerId, statusDeps)) {
      result.statusApplied = { battlerId: targetId, status: 'DRENCH' }
    }
    return
  }
  if (effect === 'ATTRACT') {
    if (applyAttractEffect(state, attackerId, targetId, statusDeps)) {
      result.statusApplied = { battlerId: targetId, status: 'INFATUATION' }
    }
    return
  }
  if (effect === 'FEAR') {
    if (applyFearEffect(state, targetId)) {
      result.statusApplied = { battlerId: targetId, status: 'FEAR' }
    }
    return
  }
  if (effect === 'CURSE') {
    // MOVE_EFFECT_CURSE (battle_script_commands.c:2721-2726)
    if (!hasFlag(target.mon.status2, STATUS2_CURSED)) {
      target.mon.status2 = setFlag(target.mon.status2, STATUS2_CURSED)
      result.statusApplied = { battlerId: targetId, status: 'CURSE' }
    }
    return
  }
  if (effect === 'PREVENT_ESCAPE') {
    // MOVE_EFFECT_PREVENT_ESCAPE (battle_script_commands.c:2823-2826): no already-set check in the case itself
    target.mon.status2 = setFlag(target.mon.status2, STATUS2_ESCAPE_PREVENTION)
    target.volatiles.battlerPreventingEscape = attackerId
    result.statusApplied = { battlerId: targetId, status: 'ESCAPE_PREVENTION' }
    return
  }
  if (effect === 'DISABLE') {
    // MOVE_EFFECT_DISABLE (battle_script_commands.c:2955-2959): CanBeDisabled, then DisableLastUsedMove (:10714-10737; B_DISABLE_TURNS GEN_7 -> 4)
    const lastMove = target.lastMove
    const moveIdx = lastMove ? target.mon.moves.indexOf(lastMove) : -1
    if (canBeDisabled(state, targetId, attackerId, statusDeps) && moveIdx !== -1 && (target.mon.pp[moveIdx] ?? 0) !== 0) {
      target.volatiles.disabledMove = lastMove
      target.volatiles.disableTimer = 4
      target.volatiles.disableTimerStartValue = 4
    }
    return
  }
  const res = applyPrimaryStatusEffect(state, attackerId, targetId, effect, moveId, statusDeps, unmodelled, false, false, true)
  if (res.applied && res.status) {
    result.statusApplied = { battlerId: targetId, status: res.status }
  }
}

/**
 * AbilityStatusEffect(MOVE_EFFECT_<STAT>_MINUS_1) on the target (abilities.cc:263-268; SetMoveEffect, battle_script_commands.c:2361, 2388, 2765-2781),
 * shaped exactly like Whiplash's: Sheer Force and Substitute gates, then a -1 stage change.
 */
function applyAbilityStatDrop(
  state: BattleState,
  attackerId: number,
  targetId: number,
  statId: number,
  moveId: string,
  deps: TurnLoopDeps,
  statusDeps: StatusDeps,
  unmodelled: string[],
  result: { statChanges: StatChangeOutcome[] },
): void {
  if (testSheerForceFlag(state, attackerId, moveId, statusDeps)) return
  if (doesSubstituteBlockMove(state, attackerId, targetId, moveId, statusDeps, unmodelled)) return
  const res = changeStatBuffs(
    state,
    targetId,
    attackerId,
    targetId,
    -1,
    statId,
    STAT_BUFF_ALLOW_PTR,
    false,
    { dataContext: deps.dataContext, grounding: deps.grounding },
    unmodelled,
    moveId,
  )
  if (res.delta !== 0) {
    result.statChanges.push({ battlerId: targetId, stat: statId, change: res.delta })
  }
  // BattleScript_AbilityStatusEffect -> seteffectsecondary -> SetMoveEffect's MOVE_EFFECT_*_MINUS_1 branch sets
  // BattleScript_StatDown (battle_script_commands.c:2765-2779), whose printfromtable gStatDownStringIds selects
  // STRINGID_DEFENDERSSTATFELL for B_MSG_DEFENDER_STAT_FELL (data/battle_scripts_1.s:3717-3721,
  // src/battle_message.c:2260-2266). PrepareStringBattle dispatches onStatLowered for that string when the
  // changed stat's source (gTurnStructs[gBattlerTarget].changedStatsBattlerId = gBattlerAttacker,
  // :9736) is on the other side (src/battle_util.c:1222-1255).
  if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (targetId & 1) !== (attackerId & 1)) {
    dispatchOnStatLowered(state, targetId, attackerId, { dataContext: deps.dataContext, grounding: deps.grounding }, unmodelled, result.statChanges)
  }
}

/**
 * AbilityStatusEffect(MOVE_EFFECT_<STAT>_PLUS_1 | MOVE_EFFECT_AFFECTS_USER) (abilities.cc:263-268; SetMoveEffect, battle_script_commands.c:2336-2339, 2361,
 * 2751-2764): the Sheer Force gate still applies (:2361), the Substitute gate does not for an affects-user effect (:2388).
 */
function applyAbilitySelfStatRaise(
  state: BattleState,
  attackerId: number,
  targetId: number,
  statId: number,
  moveId: string,
  deps: TurnLoopDeps,
  statusDeps: StatusDeps,
  unmodelled: string[],
  result: { statChanges: StatChangeOutcome[] },
): void {
  if (testSheerForceFlag(state, attackerId, moveId, statusDeps)) return
  const res = changeStatBuffsImplicit(
    state,
    attackerId,
    targetId,
    1,
    statId,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_UPDATE_MOVE_EFFECT,
    false,
    { dataContext: deps.dataContext, grounding: deps.grounding },
    unmodelled,
    moveId,
  )
  if (res.delta !== 0) {
    result.statChanges.push({ battlerId: attackerId, stat: statId, change: res.delta })
  }
}

/**
 * A negative gBattleMoveDamage run through DMG_TO_HP_FROM_ABILITY (battle_script_commands.c:9395-9397) = GetDrainedBigRootHp
 * (battle_util.c:2369-2377: Big Root x3/2, then Absorbant x3/2, each truncating), then healed into the battler (capped at max HP).
 * `amount` is the positive size of the heal before the multipliers; callers guarantee it is nonzero.
 */
function healFromAbilityDrain(state: BattleState, battlerId: number, amount: number, deps: TurnLoopDeps): void {
  const battler = state.battlers[battlerId]
  if (!battler) return
  let heal = amount
  if (deps.grounding.holdEffectOf(battlerId) === 'HOLD_EFFECT_BIG_ROOT') heal = Math.trunc((heal * 3) / 2)
  if (battlerHasSimAbility(state, battler, 'ABILITY_ABSORBANT', false, battlerId, false, deps.dataContext)) heal = Math.trunc((heal * 3) / 2)
  battler.mon.hp = Math.min(battler.mon.maxHp, battler.mon.hp + heal)
  syncPartyHp(state, battlerId)
}

/**
 * AbilityStatusEffectDirect(MOVE_EFFECT_FLINCH) (abilities.cc:270-275): HITMARKER_IGNORE_SAFEGUARD is set BEFORE SetMoveEffect(FALSE, FALSE) runs, so
 * the Shield Dust / Covert Cloak gate (battle_script_commands.c:2348-2350, which requires `!(gHitMarker & HITMARKER_IGNORE_SAFEGUARD)`) is skipped, unlike
 * applyKingsRock's item path. What remains: the Sheer Force gate (:2361), the Substitute gate (:2388) and IsAbilityStatusProtected(CHECK_FLINCH) (:2665-2669).
 */
function applyAbilityDirectFlinch(
  state: BattleState,
  attackerId: number,
  targetId: number,
  moveId: string,
  statusDeps: StatusDeps,
  unmodelled: string[],
): void {
  const target = state.battlers[targetId]
  if (!target || target.mon.hp === 0) return
  if (testSheerForceFlag(state, attackerId, moveId, statusDeps)) return
  if (doesSubstituteBlockMove(state, attackerId, targetId, moveId, statusDeps, unmodelled)) return
  if (!isAbilityStatusProtected(state, targetId, CHECK_FLINCH, attackerId, statusDeps)) {
    target.mon.status2 = setFlag(target.mon.status2, STATUS2_FLINCHED)
  }
}

function handleAttackerMoveEndAbility(
  state: BattleState,
  abilityId: string,
  attackerId: number,
  targetId: number,
  moveData: SimMoveData | undefined,
  moveId: string,
  targetDamage: number,
  hpDealt: number,
  attackerHoldEffect: string | null,
  deps: TurnLoopDeps,
  statusDeps: StatusDeps,
  unmodelled: string[],
  isCriticalHit = false,
  targetHasActedThisTurn?: boolean,
  noEffect?: boolean,
  fainted: number[] = [],
): { attackerDamage: number; statusApplied: StatusAppliedOutcome | null; statChanges: StatChangeOutcome[] } {
  const result: { attackerDamage: number; statusApplied: StatusAppliedOutcome | null; statChanges: StatChangeOutcome[] } = {
    attackerDamage: 0,
    statusApplied: null,
    statChanges: [],
  }

  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  if (!attacker || !target) return result

  // Soul Linker (src/abilities.cc:4273-4285, ON_EITHER_ABILITY at :4282-4285). This is the attacker
  // half: holder = attacker, opponent = target. BattleScript_AttackerSoulLinker
  // (data/battle_scripts_1.s:11467-11472) damages BS_ATTACKER -- the holder -- by the move's own
  // damage, so a Soul Linker holder takes the same damage it inflicts.
  if (abilityId === 'ABILITY_SOUL_LINKER') {
    if (
      targetDamage > 0 &&
      attacker.mon.hp > 0 && // CHECK(IsBattlerAlive(battler))
      target.mon.hp > 0 && // ShouldApplyOnHitEffect(opponent)
      moveId !== 'MOVE_PAIN_SPLIT' &&
      !battlerHasSimAbility(state, target, 'ABILITY_SOUL_LINKER', false, attackerId, false, deps.dataContext)
    ) {
      applyDamage(state, attackerId, targetDamage, fainted, deps)
      result.attackerDamage += targetDamage
    }
    return result
  }

  // Temporal Rupture (src/abilities.cc:10043-10067). ReplaceAbility (battle_util.c:9325) writes
  // abilities[0]; IsPersistentOrUnsuppressableAbility (:4790) reads GetBattlerAbility (abilities[0]).
  if (abilityId === 'ABILITY_TEMPORAL_RUPTURE') {
    const targetPrimary = target.mon.abilities.ability ?? 'ABILITY_NONE'
    if (
      moveId === 'MOVE_ROAR_OF_TIME' &&
      targetDamage > 0 && // ShouldApplyOnHitEffect(target)
      target.mon.hp > 0 &&
      !hasAbilityIgnoringSuppression(target, 'ABILITY_SLOW_START') &&
      !PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES.includes(targetPrimary) &&
      !doesBattlerHaveAbilityShield(target, deps)
    ) {
      updateAbilityStateForNewAbility(target, 'ABILITY_SLOW_START')
      target.mon.abilities.ability = 'ABILITY_SLOW_START'
      target.volatiles.slowStartTimer = 5 // gVolatileStructs[target].slowStartTimer (:10056)
    }
  }

  // "-ate" abilities' 10% on-hit status (src/abilities.cc: Hydrate :4122, Pixilate :2468, Mineralize :5090, Galvanize :2811,
  // Refrigerate :2372, Intoxicate :4201, Emanate :6015, Immolate / Solar Flare :3742, :4638, Spectralize :4870, Deviate / Mob Boss :9760, :12453)
  // Spectral Shroud's onAttacker is `Impl<ABILITY_SPECTRALIZE>.onAttacker(...) | SpectralShroud(...)`, so it runs
  // Spectralize's own 10% Fear check too -- same table row, only the ability key differs.
  const ateStatus =
    ATE_ON_HIT_STATUS[abilityId] ??
    (abilityId === 'ABILITY_SPECTRAL_SHROUD' ? ATE_ON_HIT_STATUS.ABILITY_SPECTRALIZE : undefined)
  if (ateStatus) {
    const rawType = moveData?.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : null
    const effectiveType = rawType ? resolveEffectiveMoveType(attacker.mon.abilities, moveId, rawType, moveData?.flags ?? {}).moveType : null
    if (
      attacker.mon.types.includes(ateStatus.type) &&
      effectiveType === ateStatus.type &&
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      ateStatus.can(state, attackerId, targetId, statusDeps) &&
      state.rng.random16() % 10 === 0
    ) {
      applyAbilityOnHitStatus(state, ateStatus.effect, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Resonance (src/abilities.cc:7871-7880): sound move bleeds target 50%
  if (abilityId === 'ABILITY_RESONANCE') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBleed(state, targetId, attackerId, statusDeps) &&
      Boolean(moveData?.flags?.sound) &&
      state.rng.random16() % 100 < 50
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BLEED, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Solenoglyphs (src/abilities.cc:4371-4380): Strong Jaw / bite move toxic poisons target 50%
  if (abilityId === 'ABILITY_SOLENOGLYPHS') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBePoisoned(state, attackerId, targetId, 'MOVE_NONE', statusDeps) &&
      Boolean(moveData?.flags?.biteBased) &&
      state.rng.random16() % 2 !== 0
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_TOXIC, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Razor Sharp (src/abilities.cc:9021-9029) & To The Bone (:9032): critical hit bleeds target
  if (abilityId === 'ABILITY_RAZOR_SHARP' || abilityId === 'ABILITY_TO_THE_BONE') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isCriticalHit === true &&
      canBleed(state, targetId, attackerId, statusDeps)
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BLEED, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Fearmonger (src/abilities.cc:5170-5180): contact move inflicts Fear 10%
  if (abilityId === 'ABILITY_FEARMONGER') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      !target.volatiles.fear &&
      !hasFlag(target.statuses4, STATUS4_FEAR) &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      state.rng.random16() % 100 < 10
    ) {
      applyAbilityOnHitStatus(state, 'FEAR', attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Menacing Situation on attacker (src/abilities.cc:7905-7919): contact move inflicts Fear 30%
  if (abilityId === 'ABILITY_MENACING_SITUATION') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      !target.volatiles.fear &&
      !hasFlag(target.statuses4, STATUS4_FEAR) &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      state.rng.random16() % 100 < 30
    ) {
      applyAbilityOnHitStatus(state, 'FEAR', attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Freezing Point on attacker (src/abilities.cc:6360-6371): inflicts Frostbite (contact 20%, non-contact 30%)
  // Cryo Proficiency's onAttacker is `Impl<ABILITY_FREEZING_POINT>.onAttacker` (abilities.cc:6388)
  if (abilityId === 'ABILITY_FREEZING_POINT' || abilityId === 'ABILITY_CRYO_PROFICIENCY') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canGetFrostbite(state, targetId, attackerId, statusDeps)
    ) {
      const chance = isMoveMakingContact(moveData, attacker, attackerHoldEffect) ? 20 : 30
      if (state.rng.random16() % 100 < chance) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_FROSTBITE, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      }
    }
  }

  // Spike Armor / Fragrant Daze / Hypnotic Touch, attacker half (ON_EITHER hooks, abilities.cc:6798-6806 / 7792-7800 / 11267-11275):
  // ShouldApplyOnHitEffect(target), CanX(target), contact, Random() % 100 < chance, AbilityStatusEffectSafe(effect, battler, target).
  const contactStatus = ON_EITHER_CONTACT_STATUS[abilityId]
  if (contactStatus) {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      contactStatus.can(state, targetId, attackerId, statusDeps) &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      state.rng.random16() % 100 < contactStatus.chance
    ) {
      applyAbilityOnHitStatus(state, contactStatus.effect, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Magical Dust, attacker half (abilities.cc:3990-4003 MagicalDustOnEither): contact hit turns the target Psychic (type3 Mystery).
  if (abilityId === 'ABILITY_MAGICAL_DUST') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !target.mon.types.includes('PSYCHIC')
    ) {
      target.mon.types = ['PSYCHIC', 'PSYCHIC', 'MYSTERY']
    }
  }

  // Vital Spirit (src/abilities.cc:1351-1364): using a Fighting move heals user's status1 (AbilityHealMonStatus)
  if (abilityId === 'ABILITY_VITAL_SPIRIT') {
    const rawType = moveData?.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : null
    const effectiveType = rawType ? resolveEffectiveMoveType(attacker.mon.abilities, moveId, rawType, moveData?.flags ?? {}).moveType : null
    if (effectiveType === 'FIGHTING' && hasFlag(attacker.mon.status1, STATUS1_ANY)) {
      attacker.mon.status1 = 0
      attacker.mon.status2 = clearFlag(attacker.mon.status2, STATUS2_NIGHTMARE)
      const partySlot = state.sides[attackerId & 1].party[attacker.partyIndex]
      if (partySlot) partySlot.status1 = 0
    }
  }

  // Whiplash (src/abilities.cc:8942-8954): physical move lowers target Defense by 1 stage, once per turn per target
  if (abilityId === 'ABILITY_WHIPLASH') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      moveData?.split === 'PHYSICAL' &&
      canLowerStatOrMirrorArmor(state, targetId, STAT_DEF, deps.dataContext)
    ) {
      const affected = getOncePerTurnAbilityCounter(state, attackerId, abilityId, deps.dataContext)
      if ((affected & (1 << targetId)) === 0) {
        setOncePerTurnAbilityCounter(state, attackerId, abilityId, affected | (1 << targetId), deps.dataContext)
        if (!testSheerForceFlag(state, attackerId, moveId, statusDeps)) {
          if (!doesSubstituteBlockMove(state, attackerId, targetId, moveId, statusDeps, unmodelled)) {
            const res = changeStatBuffs(
              state,
              targetId,
              attackerId,
              targetId,
              -1,
              STAT_DEF,
              STAT_BUFF_ALLOW_PTR,
              false,
              { dataContext: deps.dataContext, grounding: deps.grounding },
              unmodelled,
              moveId,
            )
            if (res.delta !== 0) {
              result.statChanges.push({ battlerId: targetId, stat: STAT_DEF, change: res.delta })
            }
            // Impl<ABILITY_WHIPLASH>.onAttacker (src/abilities.cc:8942-8954) ends in AbilityStatusEffect(MOVE_EFFECT_DEF_MINUS_1)
            // -> seteffectsecondary -> SetMoveEffect's minus-1 branch -> BattleScript_StatDown
            // (battle_script_commands.c:2765-2779). Its printfromtable gStatDownStringIds picks
            // STRINGID_DEFENDERSSTATFELL (data/battle_scripts_1.s:3717-3721), so PrepareStringBattle's onStatLowered
            // block (src/battle_util.c:1222-1255) runs for the target -- changedStatsBattlerId is gBattlerAttacker.
            if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (targetId & 1) !== (attackerId & 1)) {
              dispatchOnStatLowered(state, targetId, attackerId, { dataContext: deps.dataContext, grounding: deps.grounding }, unmodelled, result.statChanges)
            }
          }
        }
      }
    }
  }

  // Aftermath on attacker (src/abilities.cc:1655-1662): Explosion flinches target
  if (abilityId === 'ABILITY_AFTERMATH') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      moveData?.effect === 'EFFECT_EXPLOSION'
    ) {
      if (!isAbilityStatusProtected(state, targetId, CHECK_FLINCH, attackerId, statusDeps)) {
        target.mon.status2 = setFlag(target.mon.status2, STATUS2_FLINCHED)
      }
    }
  }

  // Energy Tap (src/abilities.cc:10623-10634): recovers 1/8 of hp dealt
  if (abilityId === 'ABILITY_ENERGY_TAP') {
    if (
      attacker.mon.hp > 0 &&
      hpDealt > 0 &&
      attacker.mon.hp < attacker.mon.maxHp &&
      canBattlerHeal(state, attackerId, attacker, unmodelled)
    ) {
      const heal = Math.max(1, Math.floor(hpDealt / 8))
      attacker.mon.hp = Math.min(attacker.mon.maxHp, attacker.mon.hp + heal)
      syncPartyHp(state, attackerId)
    }
  }

  // Fertilize (src/abilities.cc:6506-6520): Grass move by Grass attacker recovers 1/10 of hp dealt
  if (abilityId === 'ABILITY_FERTILIZE') {
    const rawType = moveData?.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : null
    const effectiveType = rawType ? resolveEffectiveMoveType(attacker.mon.abilities, moveId, rawType, moveData?.flags ?? {}).moveType : null
    if (
      attacker.mon.types.includes('GRASS') &&
      effectiveType === 'GRASS' &&
      attacker.mon.hp > 0 &&
      hpDealt > 0 &&
      attacker.mon.hp < attacker.mon.maxHp &&
      canBattlerHeal(state, attackerId, attacker, unmodelled)
    ) {
      const heal = Math.max(1, Math.floor(hpDealt / 10))
      attacker.mon.hp = Math.min(attacker.mon.maxHp, attacker.mon.hp + heal)
      syncPartyHp(state, attackerId)
    }
  }

  // Molten Coat (src/abilities.cc:10313-10324): Rock move burns target 50%
  if (abilityId === 'ABILITY_MOLTEN_COAT') {
    const rawType = moveData?.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : null
    const effectiveType = rawType ? resolveEffectiveMoveType(attacker.mon.abilities, moveId, rawType, moveData?.flags ?? {}).moveType : null
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      effectiveType === 'ROCK' &&
      canBeBurned(state, targetId, attackerId, statusDeps) &&
      state.rng.random16() % 2 !== 0
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BURN, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Deep Cuts (src/abilities.cc:9088-9097): CanBleed, Keen Edge move, then the 50% roll (C's CHECK order -- the roll is drawn last)
  if (abilityId === 'ABILITY_DEEP_CUTS') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBleed(state, targetId, attackerId, statusDeps) &&
      isKeenEdgeMove(state, attackerId, moveId, statusDeps, unmodelled) &&
      state.rng.random16() % 2 !== 0
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BLEED, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Beautiful Music (src/abilities.cc:7838-7846): the 50% roll comes BEFORE IsSoundMove in the C, so it is drawn for every hit by the holder.
  // MOVE_EFFECT_ATTRACT runs CanInfatuate inside SetMoveEffect (battle_script_commands.c:2727-2732), i.e. in applyAttractEffect.
  if (abilityId === 'ABILITY_BEAUTIFUL_MUSIC') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      state.rng.random16() % 2 !== 0 &&
      isSoundMove(state, attackerId, moveId, statusDeps, unmodelled)
    ) {
      applyAbilityOnHitStatus(state, 'ATTRACT', attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Dead Power (src/abilities.cc:7585-7598): contact hit curses a target that is not already cursed, 20%
  if (abilityId === 'ABILITY_DEAD_POWER') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      !hasFlag(target.mon.status2, STATUS2_CURSED) &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      state.rng.random16() % 100 < 20
    ) {
      applyAbilityOnHitStatus(state, 'CURSE', attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Assassin's Tools (src/abilities.cc:8598-8621): contact hit, then Random() % 3 picks ONE branch (poison / paralysis / bleed); a branch whose
  // CanX fails does nothing (no reroll). MOVE_EFFECT_POISON, not Toxic.
  if (abilityId === 'ABILITY_ASSASSINS_TOOLS') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect)
    ) {
      const branch = state.rng.random16() % 3
      if (branch === 0 && canBePoisoned(state, attackerId, targetId, 'MOVE_NONE', statusDeps)) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_POISON, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      } else if (branch === 1 && canBeParalyzed(state, attackerId, targetId, statusDeps)) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_PARALYSIS, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      } else if (branch === 2 && canBleed(state, targetId, attackerId, statusDeps)) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_BLEED, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      }
    }
  }

  // Crushing Jaw (src/abilities.cc:11597-11607): FLAG_STRONG_JAW_BOOST (= biteBased), 50% roll, then StatLowerableOrMirrorArmor(target, STAT_DEF)
  if (abilityId === 'ABILITY_CRUSHING_JAW') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      Boolean(moveData?.flags?.biteBased) &&
      state.rng.random16() % 2 !== 0 &&
      canLowerStatOrMirrorArmor(state, targetId, STAT_DEF, deps.dataContext)
    ) {
      applyAbilityStatDrop(state, attackerId, targetId, STAT_DEF, moveId, deps, statusDeps, unmodelled, result)
    }
  }

  // Chainsaw (src/abilities.cc:11236-11248) and Denting Blows (:8045-8057): Whiplash's once-per-turn-per-target Defense drop, gated on a
  // Keen Edge move / a hammer move (gBattleMoves[move].hammerBased). The target's bit is recorded before the effect is applied.
  if (abilityId === 'ABILITY_CHAINSAW' || abilityId === 'ABILITY_DENTING_BLOWS') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      (abilityId === 'ABILITY_CHAINSAW'
        ? isKeenEdgeMove(state, attackerId, moveId, statusDeps, unmodelled)
        : Boolean(moveData?.flags?.hammerBased)) &&
      canLowerStatOrMirrorArmor(state, targetId, STAT_DEF, deps.dataContext)
    ) {
      const affected = getOncePerTurnAbilityCounter(state, attackerId, abilityId, deps.dataContext)
      if ((affected & (1 << targetId)) === 0) {
        setOncePerTurnAbilityCounter(state, attackerId, abilityId, affected | (1 << targetId), deps.dataContext)
        applyAbilityStatDrop(state, attackerId, targetId, STAT_DEF, moveId, deps, statusDeps, unmodelled, result)
      }
    }
  }

  // Daredevil (src/abilities.cc:12382-12391): ShouldApplyOnHitEffect(battler), IsRecklessBoosted (abilities.cc:463-470: FLAG_RECKLESS_BOOST,
  // STATUS2_ENRAGED, or power && an onRecoil ability that answers for this move type), CanRaiseStat, then
  // AbilityStatusEffect(MOVE_EFFECT_ATK_PLUS_1 | MOVE_EFFECT_AFFECTS_USER) -- SetMoveEffect still runs the Sheer Force gate (battle_script_commands.c:2361)
  // but skips the Substitute gate for an affects-user effect (:2388).
  if (abilityId === 'ABILITY_DAREDEVIL') {
    const rawType = moveData?.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : null
    const effectiveType = rawType ? resolveEffectiveMoveType(attacker.mon.abilities, moveId, rawType, moveData?.flags ?? {}).moveType : null
    const recklessBoosted =
      Boolean(moveData?.flags?.reckless) ||
      hasFlag(attacker.mon.status2, STATUS2_ENRAGED) ||
      (Boolean(moveData && moveData.power > 0) &&
        Object.entries(ON_RECOIL_TYPES).some(
          ([ab, types]) =>
            battlerHasAbility(attacker.mon.abilities, ab, () => false) && (types === null || (effectiveType !== null && types.includes(effectiveType))),
        ))
    if (
      attacker.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      recklessBoosted &&
      canRaiseStat(state, attackerId, STAT_ATK, deps.dataContext)
    ) {
      applyAbilitySelfStatRaise(state, attackerId, targetId, STAT_ATK, moveId, deps, statusDeps, unmodelled, result)
    }
  }

  // Archmage (src/abilities.cc:5851-5988): DidMoveHit, not a status move, 30% roll (drawn for every damaging hit, before the type switch), then one
  // effect keyed on the move's type. Every case but Rock also needs the target alive (IsBattlerAlive(target)); Bug is a TODO in the C and does nothing.
  // AbilityStatusEffect cases go through applyAbilityOnHitStatus (Sheer Force / Substitute gates); the BattleScriptCall cases (terrains, Encore,
  // Stealth Rock) bypass SetMoveEffect, so they carry no such gates.
  if (abilityId === 'ABILITY_ARCHMAGE') {
    if (
      hpDealt > 0 &&
      attackerId !== targetId &&
      moveData?.split !== 'STATUS' &&
      state.rng.random16() % 100 < 30
    ) {
      const rawType = moveData?.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : null
      const effectiveType = rawType ? resolveEffectiveMoveType(attacker.mon.abilities, moveId, rawType, moveData?.flags ?? {}).moveType : null
      const targetAlive = target.mon.hp > 0
      const sideOfTarget = state.sides[targetId & 1]!
      switch (effectiveType) {
        case 'POISON':
          if (targetAlive && canBePoisoned(state, attackerId, targetId, 'MOVE_NONE', statusDeps)) {
            applyAbilityOnHitStatus(state, MOVE_EFFECT_TOXIC, attackerId, targetId, moveId, statusDeps, unmodelled, result)
          }
          break
        case 'ICE':
          if (targetAlive && canGetFrostbite(state, targetId, attackerId, statusDeps)) {
            applyAbilityOnHitStatus(state, MOVE_EFFECT_FROSTBITE, attackerId, targetId, moveId, statusDeps, unmodelled, result)
          }
          break
        case 'WATER':
          if (targetAlive && canBeConfused(state, targetId, attackerId, statusDeps)) {
            applyAbilityOnHitStatus(state, MOVE_EFFECT_CONFUSION, attackerId, targetId, moveId, statusDeps, unmodelled, result)
          }
          break
        case 'FIRE':
          if (targetAlive && canBeBurned(state, targetId, attackerId, statusDeps)) {
            applyAbilityOnHitStatus(state, MOVE_EFFECT_BURN, attackerId, targetId, moveId, statusDeps, unmodelled, result)
          }
          break
        case 'ELECTRIC':
        case 'PSYCHIC':
        // Fairy AND Grass both set MISTY terrain in the C (abilities.cc:5901-5906 and :5908-5913: the Grass case passes STATUS_FIELD_MISTY_TERRAIN while its
        // script prints "grassy"). Ported as written, not "fixed" to Grassy.
        case 'FAIRY':
        case 'GRASS': {
          const terrainFlag =
            effectiveType === 'ELECTRIC'
              ? STATUS_FIELD_ELECTRIC_TERRAIN
              : effectiveType === 'PSYCHIC'
                ? STATUS_FIELD_PSYCHIC_TERRAIN
                : STATUS_FIELD_MISTY_TERRAIN
          if (targetAlive && tryChangeBattleTerrain(state, attackerId, terrainFlag, deps)) {
            dispatchOnTerrainChange(state, deps, unmodelled)
          }
          break
        }
        case 'NORMAL': {
          // SetEncore (battle_script_commands.c:10739-10758); the C moves[] search finds the slot holding gLastMoves[target]
          const lastMove = target.lastMove
          const moveIdx = lastMove ? target.mon.moves.indexOf(lastMove) : -1
          if (
            targetAlive &&
            target.volatiles.encoreTimer === 0 &&
            isAbilityStatusProtected(state, targetId, CHECK_RESTRICTING, attackerId, statusDeps) === null &&
            lastMove !== 'MOVE_STRUGGLE' &&
            lastMove !== 'MOVE_ENCORE' &&
            lastMove !== 'MOVE_MIRROR_MOVE' &&
            target.volatiles.encoredMove === null &&
            moveIdx !== -1 &&
            (target.mon.pp[moveIdx] ?? 0) !== 0
          ) {
            target.volatiles.encoredMove = lastMove
            target.volatiles.encoredMovePos = moveIdx
            target.volatiles.encoreTimer = 3
            target.volatiles.encoreTimerStartValue = 3
          }
          break
        }
        case 'ROCK':
          if (!hasFlag(sideOfTarget.statuses, SIDE_STATUS_STEALTH_ROCK)) {
            sideOfTarget.statuses = setFlag(sideOfTarget.statuses, SIDE_STATUS_STEALTH_ROCK)
            sideOfTarget.timers.stealthRockType = TYPE_NAME_BY_ID.indexOf('ROCK')
          }
          break
        case 'GHOST':
          if (targetAlive && canBeDisabled(state, targetId, attackerId, statusDeps)) {
            applyAbilityOnHitStatus(state, 'DISABLE', attackerId, targetId, moveId, statusDeps, unmodelled, result)
          }
          break
        case 'DARK':
          if (targetAlive && canBleed(state, targetId, attackerId, statusDeps)) {
            applyAbilityOnHitStatus(state, MOVE_EFFECT_BLEED, attackerId, targetId, moveId, statusDeps, unmodelled, result)
          }
          break
        case 'FIGHTING':
        case 'FLYING':
        case 'STEEL': {
          const statId = effectiveType === 'FIGHTING' ? STAT_SPATK : effectiveType === 'FLYING' ? STAT_SPEED : STAT_DEF
          if (targetAlive && canRaiseStat(state, attackerId, statId, deps.dataContext)) {
            applyAbilitySelfStatRaise(state, attackerId, targetId, statId, moveId, deps, statusDeps, unmodelled, result)
          }
          break
        }
        case 'DRAGON':
          if (targetAlive && canLowerStatOrMirrorArmor(state, targetId, STAT_ATK, deps.dataContext)) {
            applyAbilityStatDrop(state, attackerId, targetId, STAT_ATK, moveId, deps, statusDeps, unmodelled, result)
          }
          break
        case 'GROUND':
          if (targetAlive && !hasFlag(target.mon.status2, STATUS2_ESCAPE_PREVENTION)) {
            applyAbilityOnHitStatus(state, 'PREVENT_ESCAPE', attackerId, targetId, moveId, statusDeps, unmodelled, result)
          }
          break
        default:
          break
      }
    }
  }

  // Angel's Wrath (src/abilities.cc:5570-5666): a `switch (move)` on the literal move used. Tackle (:5573), Electroweb (:5643) and Bug Bite (:5654) are
  // ported; String Shot (:5592), Harden (:5617) and Iron Defense (:5635) read gMoveResultFlags / WasMoveSuccessful, which MoveEndAbilitiesContext does not
  // carry, so those three only push an unmodelled note. Its onAccuracy / onTypeEffectiveness / onModifyEffectChance / onCanStatusType hooks are damage-path.
  if (abilityId === 'ABILITY_ANGELS_WRATH') {
    if (moveId === 'MOVE_TACKLE') {
      // CHECK(ShouldApplyOnHitEffect(target)), !IsAbilityStatusProtected(CHECK_RESTRICTING), not (encoreTimer AND disableTimer); each missing half is
      // set from the target's slot-0 move (gBattleMons[target].moves[0]); BattleScriptCall only prints.
      if (
        target.mon.hp > 0 &&
        hpDealt > 0 &&
        attackerId !== targetId &&
        isAbilityStatusProtected(state, targetId, CHECK_RESTRICTING, attackerId, statusDeps) === null &&
        (target.volatiles.encoreTimer === 0 || target.volatiles.disableTimer === 0)
      ) {
        if (target.volatiles.encoreTimer === 0) {
          target.volatiles.encoreTimer = 2
          target.volatiles.encoredMove = target.mon.moves[0] ?? null
        }
        if (target.volatiles.disableTimer === 0) {
          target.volatiles.disableTimer = 2
          target.volatiles.disableTimerStartValue = 2
          target.volatiles.disabledMove = target.mon.moves[0] ?? null
        }
      }
    } else if (moveId === 'MOVE_ELECTROWEB') {
      // CHECK(ShouldApplyOnHitEffect(target)), not already trapped, Speed not already -6: Speed to -6 and STATUS2_ESCAPE_PREVENTION (no battlerPreventingEscape write in the C)
      const speedStage = target.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
      if (
        target.mon.hp > 0 &&
        hpDealt > 0 &&
        attackerId !== targetId &&
        !hasFlag(target.mon.status2, STATUS2_ESCAPE_PREVENTION) &&
        speedStage !== MIN_STAT_STAGE
      ) {
        target.mon.statStages[STAT_SPEED] = MIN_STAT_STAGE
        target.mon.status2 = setFlag(target.mon.status2, STATUS2_ESCAPE_PREVENTION)
        result.statChanges.push({ battlerId: targetId, stat: STAT_SPEED, change: MIN_STAT_STAGE - speedStage })
      }
    } else if (moveId === 'MOVE_BUG_BITE') {
      // CHECK(ShouldApplyOnHitEffect(battler)), not at max HP, CanBattlerHeal: gBattleMoveDamage = -gHpDealt, then BattleScript_AngelsWrath_Effect_Bug_Bite_2
      // runs manipulatedamage DMG_TO_HP_FROM_ABILITY = GetDrainedBigRootHp (battle_util.c:2369-2377: Big Root x3/2, Absorbant x3/2) and heals by it.
      if (
        attacker.mon.hp > 0 &&
        hpDealt > 0 &&
        attackerId !== targetId &&
        attacker.mon.hp < attacker.mon.maxHp &&
        canBattlerHeal(state, attackerId, attacker, unmodelled)
      ) {
        healFromAbilityDrain(state, attackerId, hpDealt, deps)
      }
    } else if (moveId === 'MOVE_STRING_SHOT' || moveId === 'MOVE_HARDEN' || moveId === 'MOVE_IRON_DEFENSE') {
      unmodelled.push(
        `Angel's Wrath's ${moveId} case (abilities.cc:5592-5642) is not modelled: it reads gMoveResultFlags / WasMoveSuccessful, which the move-end context does not carry`,
      )
    }
  }

  // ---- Cycle 91b: third batch of onAttacker hooks. Shared conventions: ShouldApplyOnHitEffect(x) = DidMoveHit && IsBattlerAlive(x), read as
  // `hpDealt > 0` + the live battler (the 86/88/91a convention); `moveType` is the effective (ate-adjusted) move type.
  const moveTypeName = (): string | null => {
    const rawType = moveData?.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : null
    return rawType ? resolveEffectiveMoveType(attacker.mon.abilities, moveId, rawType, moveData?.flags ?? {}).moveType : null
  }

  // Energy Siphon (src/abilities.cc:9207-9218): ShouldApplyOnHitEffect(battler), not at max HP, CanBattlerHeal; gBattleMoveDamage = -gHpDealt / 4 (s32, so
  // truncating toward zero), -1 if that is 0; BattleScript_HydroCircuitAbsorbEffectActivated (battle_scripts_1.s:11563-11570) runs
  // DMG_TO_HP_FROM_ABILITY (GetDrainedBigRootHp) and heals the attacker.
  if (abilityId === 'ABILITY_ENERGY_SIPHON') {
    if (
      attacker.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      attacker.mon.hp < attacker.mon.maxHp &&
      canBattlerHeal(state, attackerId, attacker, unmodelled)
    ) {
      healFromAbilityDrain(state, attackerId, Math.max(1, Math.floor(hpDealt / 4)), deps)
    }
  }

  // Fire Aspect (src/abilities.cc:10500-10514): Fire move burns the target, no roll. AbilityStatusEffectSafe(MOVE_EFFECT_BURN, battler, target) re-points
  // gBattlerAttacker / gBattlerTarget at the holder and the hit target around the same BattleScript_AbilityStatusEffect, so the gates are the same.
  if (abilityId === 'ABILITY_FIRE_ASPECT') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      moveTypeName() === 'FIRE' &&
      canBeBurned(state, targetId, attackerId, statusDeps)
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BURN, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Fire's Wrath (src/abilities.cc:5186-5196): CanBeBurned, a NON-contact move, then a 10% roll. (Its onEntry, UseIntimidateClone, is a separate hook.)
  if (abilityId === 'ABILITY_FIRES_WRATH') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBeBurned(state, targetId, attackerId, statusDeps) &&
      !isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      state.rng.random16() % 100 < 10
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BURN, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // From the Shadows (src/abilities.cc:8766-8781): only while the target has not yet acted (GetBattlerTurnOrderNum(target) >= gCurrentTurnActionNumber,
  // i.e. not turn.ts's targetHasActedThisTurn). CanMoveHaveExtraFlinchChance(move) && 20% roll -> AbilityStatusEffectDirect(MOVE_EFFECT_FLINCH); then,
  // independent of the flinch, STATUS2_ESCAPE_PREVENTION + battlerPreventingEscape = holder unless the target is already trapped.
  if (abilityId === 'ABILITY_FROM_THE_SHADOWS') {
    if (target.mon.hp > 0 && hpDealt > 0 && attackerId !== targetId) {
      if (targetHasActedThisTurn === undefined) {
        const msg = "From the Shadows' turn-order check (abilities.cc:8769) needs the target's turn-order slot, which this move-end call was not given"
        if (!unmodelled.includes(msg)) unmodelled.push(msg)
      } else if (!targetHasActedThisTurn) {
        if (isKingsRockAffected(moveData, deps) && state.rng.random16() % 100 < 20) {
          applyAbilityDirectFlinch(state, attackerId, targetId, moveId, statusDeps, unmodelled)
        }
        if (!hasFlag(target.mon.status2, STATUS2_ESCAPE_PREVENTION)) {
          target.mon.status2 = setFlag(target.mon.status2, STATUS2_ESCAPE_PREVENTION)
          target.volatiles.battlerPreventingEscape = attackerId
          if (!result.statusApplied) result.statusApplied = { battlerId: targetId, status: 'ESCAPE_PREVENTION' }
        }
      }
    }
  }

  // Frostmaw (src/abilities.cc:8624-8633): CanGetFrostbite, FLAG_STRONG_JAW_BOOST (= biteBased, as Solenoglyphs / Crushing Jaw), then a 50% roll.
  if (abilityId === 'ABILITY_FROSTMAW') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canGetFrostbite(state, targetId, attackerId, statusDeps) &&
      Boolean(moveData?.flags?.biteBased) &&
      state.rng.random16() % 2 !== 0
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_FROSTBITE, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Fungal Infection (src/abilities.cc:5016-5028): contact hit seeds a non-Grass target that is not already seeded, no roll. The script
  // (BattleScript_AbsorbantActivated, battle_scripts_1.s:11474-11477) only prints. Same bit layout as Absorbant: STATUS3_LEECHSEED_BY(battler) = battler << 0.
  if (abilityId === 'ABILITY_FUNGAL_INFECTION') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      !target.mon.types.includes('GRASS') &&
      !hasFlag(target.statuses3, STATUS3_LEECHSEED) &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect)
    ) {
      target.statuses3 |= attackerId | STATUS3_LEECHSEED
    }
  }

  // Ghost Pepper (src/abilities.cc:12459-12468): Grass move, CanBeBurned, then a 30% roll.
  if (abilityId === 'ABILITY_GHOST_PEPPER') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      moveTypeName() === 'GRASS' &&
      canBeBurned(state, targetId, attackerId, statusDeps) &&
      state.rng.random16() % 100 < 30
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BURN, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Grass Flute (src/abilities.cc:10070-10078): sound move inflicts Fear on a target without gVolatileStructs.fear, no roll.
  if (abilityId === 'ABILITY_GRASS_FLUTE') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isSoundMove(state, attackerId, moveId, statusDeps, unmodelled) &&
      !target.volatiles.fear
    ) {
      applyAbilityOnHitStatus(state, 'FEAR', attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Hardened Sheath (src/abilities.cc:4942-4952): ShouldApplyOnHitEffect(battler), horn move (gBattleMoves[move].hornBased), then a direct
  // ChangeStatBuffs(battler, 1, STAT_ATK, MOVE_EFFECT_AFFECTS_USER, NULL) -- not via SetMoveEffect, so no Sheer Force / Substitute gate.
  if (abilityId === 'ABILITY_HARDENED_SHEATH') {
    if (attacker.mon.hp > 0 && hpDealt > 0 && attackerId !== targetId && Boolean(moveData?.flags?.hornBased)) {
      const res = changeStatBuffs(
        state,
        attackerId,
        attackerId,
        targetId,
        1,
        STAT_ATK,
        MOVE_EFFECT_AFFECTS_USER,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: attackerId, stat: STAT_ATK, change: res.delta })
      }
    }
  }

  // Haunting Frenzy (src/abilities.cc:7523-7533): CanMoveHaveExtraFlinchChance(move), 20% roll, AbilityStatusEffectDirect(MOVE_EFFECT_FLINCH).
  // (Its onBattlerFaints half is a separate hook.)
  if (abilityId === 'ABILITY_HAUNTING_FRENZY') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isKingsRockAffected(moveData, deps) &&
      state.rng.random16() % 100 < 20
    ) {
      applyAbilityDirectFlinch(state, attackerId, targetId, moveId, statusDeps, unmodelled)
    }
  }

  // ---- Cycle 92: onAttacker abilities that run AdjustFollowupMoveTarget + UseAttackerFollowUpMove (src/abilities.cc:201-225, battle_util.c:4021-4033).
  // When noEffect is not supplied by the caller, a move blocked by isBattlerProtected (RoundState.protectMove, turn.ts:895-1045)
  // or a non-status move that dealt 0 damage is treated as MOVE_RESULT_NO_EFFECT.
  const moveHadNoEffect =
    Boolean(noEffect) ||
    (isBattlerProtected(state, attackerId, targetId, moveId, Boolean(targetHasActedThisTurn), deps, unmodelled) &
      ProtectType.PROTECT_BLOCK) !==
      0 ||
    (noEffect === undefined && moveData?.split !== 'STATUS' && !(hpDealt > 0 || targetDamage > 0))

  // Forecast (src/abilities.cc:1251-1266): Sunny Day / Rain Dance / Sandstorm / Hail / Eerie Fog -> FOLLOWUP_ALLOW_FAILED -> Weather Ball (power 0)
  if (abilityId === 'ABILITY_FORECAST') {
    if (
      moveId === 'MOVE_SUNNY_DAY' ||
      moveId === 'MOVE_RAIN_DANCE' ||
      moveId === 'MOVE_SANDSTORM' ||
      moveId === 'MOVE_HAIL' ||
      moveId === 'MOVE_EERIE_FOG'
    ) {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_ALLOW_FAILED, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_WEATHER_BALL', 0, deps)
      }
    }
  }

  // Thundercall (src/abilities.cc:4915-4922) & Current Crash (:12376-12379, Impl<ABILITY_THUNDERCALL>.onAttacker):
  // Electric move -> FOLLOWUP_STANDARD -> Smite at .2 * gBattleMoves[MOVE_SMITE].power (trunc(0.2 * 120) = 24)
  if (abilityId === 'ABILITY_THUNDERCALL' || abilityId === 'ABILITY_CURRENT_CRASH') {
    if (moveTypeName() === 'ELECTRIC') {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_STANDARD, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        const smitePower = Math.trunc(0.2 * (deps.dataContext.move('MOVE_SMITE')?.power ?? 120))
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_SMITE', smitePower, deps)
      }
    }
  }

  // Pyro Shells (src/abilities.cc:5006-5013): IsMegaLauncherBoosted(battler, move) -> FOLLOWUP_STANDARD -> Outburst (power 50)
  if (abilityId === 'ABILITY_PYRO_SHELLS') {
    if (isMegaLauncherBoostedMove(state, attackerId, moveData, deps)) {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_STANDARD, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_OUTBURST', 50, deps)
      }
    }
  }

  // Frost Burn (src/abilities.cc:6144-6151): Fire move -> FOLLOWUP_STANDARD -> Ice Beam (power 40)
  if (abilityId === 'ABILITY_FROST_BURN') {
    if (moveTypeName() === 'FIRE') {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_STANDARD, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_ICE_BEAM', 40, deps)
      }
    }
  }

  // Two Step (src/abilities.cc:6600-6607): IsDance(battler, move) -> FOLLOWUP_ALLOW_SELF -> Revelation Dance (power 50)
  if (abilityId === 'ABILITY_TWO_STEP') {
    if (isDanceMove(state, attackerId, moveData, deps)) {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_ALLOW_SELF, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_REVELATION_DANCE', 50, deps)
      }
    }
  }

  // Chunky Bass Line (src/abilities.cc:8027-8034): IsSoundMove(battler, move) -> FOLLOWUP_STANDARD -> Earthquake (power 40)
  if (abilityId === 'ABILITY_CHUNKY_BASS_LINE') {
    if (isSoundMove(state, attackerId, moveId, statusDeps, unmodelled)) {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_STANDARD, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_EARTHQUAKE', 40, deps)
      }
    }
  }

  // Glacial Rage (src/abilities.cc:9635-9642): Ice move -> FOLLOWUP_STANDARD -> Blizzard (power 50)
  if (abilityId === 'ABILITY_GLACIAL_RAGE') {
    if (moveTypeName() === 'ICE') {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_STANDARD, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_BLIZZARD', 50, deps)
      }
    }
  }

  // Sludge Spit (src/abilities.cc:10674-10681): gBattleMoves[move].power -> FOLLOWUP_STANDARD -> Venom Bolt (power 35)
  if (abilityId === 'ABILITY_SLUDGE_SPIT') {
    if (Boolean(moveData && moveData.power > 0)) {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_STANDARD, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_VENOM_BOLT', 35, deps)
      }
    }
  }

  // Lunar Wrath (src/abilities.cc:10862-10869): Ghost move -> FOLLOWUP_STANDARD -> Moongeist Beam (power 50)
  if (abilityId === 'ABILITY_LUNAR_WRATH') {
    if (moveTypeName() === 'GHOST') {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_STANDARD, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_MOONGEIST_BEAM', 50, deps)
      }
    }
  }

  // Break It Down (src/abilities.cc:11558-11565): gBattleMoves[move].power -> FOLLOWUP_STANDARD -> Rapid Spin (power 20)
  if (abilityId === 'ABILITY_BREAK_IT_DOWN') {
    if (Boolean(moveData && moveData.power > 0)) {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_STANDARD, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_RAPID_SPIN', 20, deps)
      }
    }
  }

  // Backflip (src/abilities.cc:11587-11594): DoesMoveMatchFlag(battler, move, moveType, MOVE_FLAG_DANCE) -> FOLLOWUP_ALLOW_SELF -> Chip Away (power 50)
  if (abilityId === 'ABILITY_BACKFLIP') {
    if (isDanceMove(state, attackerId, moveData, deps)) {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_ALLOW_SELF, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_CHIP_AWAY', 50, deps)
      }
    }
  }

  // Thunder Clouds (src/abilities.cc:12150-12158): gBattleMoves[move].power && IS_MOVE_SPECIAL(move) -> FOLLOWUP_STANDARD -> Thunderbolt (power 35)
  if (abilityId === 'ABILITY_THUNDER_CLOUDS') {
    if (Boolean(moveData && moveData.power > 0) && moveData?.split === 'SPECIAL') {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_STANDARD, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_THUNDERBOLT', 35, deps)
      }
    }
  }

  // Frost Dragon (src/abilities.cc:12394-12401): Ice or Dragon move -> FOLLOWUP_STANDARD -> Blizzard (power 50)
  if (abilityId === 'ABILITY_FROST_DRAGON') {
    const mType = moveTypeName()
    if (mType === 'ICE' || mType === 'DRAGON') {
      const followupTarget = adjustFollowupMoveTarget(state, attackerId, targetId, moveId, moveData, FOLLOWUP_STANDARD, moveHadNoEffect, deps, statusDeps)
      if (followupTarget !== null) {
        queueAttackerFollowUpMove(state, attackerId, followupTarget, abilityId, 'MOVE_BLIZZARD', 50, deps)
      }
    }
  }

  // 1. Poison Point on attacker (src/abilities.cc:987-995, 2100, 9519, 9526, 10147, 11535)
  if (
    abilityId === 'ABILITY_POISON_POINT' ||
    abilityId === 'ABILITY_POISON_TOUCH' ||
    abilityId === 'ABILITY_TOXIC_SHELL' ||
    abilityId === 'ABILITY_VENOM_CROWN' ||
    abilityId === 'ABILITY_BLIGHT_SCALE' ||
    abilityId === 'ABILITY_POISON_QUILLS'
  ) {
    if (target.mon.hp > 0 && targetDamage > 0 && canBePoisoned(state, attackerId, targetId, 'MOVE_NONE', statusDeps)) {
      if (isMoveMakingContact(moveData, attacker, attackerHoldEffect)) {
        if (state.rng.random16() % 100 < 30) {
          const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_POISON, moveId, statusDeps, unmodelled, false, false, true)
          if (res.applied && res.status) {
            result.statusApplied = { battlerId: targetId, status: res.status }
          }
        }
      }
    }
  }

  // 2. Static on attacker (src/abilities.cc:610-618, 8182)
  if (abilityId === 'ABILITY_STATIC' || abilityId === 'ABILITY_WHITE_NOISE') {
    if (target.mon.hp > 0 && targetDamage > 0 && canBeParalyzed(state, attackerId, targetId, statusDeps)) {
      const chance = isMoveMakingContact(moveData, attacker, attackerHoldEffect) ? 30 : 10
      if (state.rng.random16() % 100 < chance) {
        const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_PARALYSIS, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          result.statusApplied = { battlerId: targetId, status: res.status }
        }
      }
    }
  }

  // 3. Flame Body on attacker (src/abilities.cc:1126-1134, 4363, 6104)
  if (abilityId === 'ABILITY_FLAME_BODY' || abilityId === 'ABILITY_SMOLDERING_WOOD' || abilityId === 'ABILITY_SUPER_HOT_GOO') {
    if (target.mon.hp > 0 && targetDamage > 0 && canBeBurned(state, targetId, attackerId, statusDeps)) {
      const chance = isMoveMakingContact(moveData, attacker, attackerHoldEffect) ? 30 : 20
      if (state.rng.random16() % 100 < chance) {
        const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_BURN, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          result.statusApplied = { battlerId: targetId, status: res.status }
        }
      }
    }
  }

  // 4. Absorbant (src/abilities.cc:5397-5408)
  if (abilityId === 'ABILITY_ABSORBANT') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      !target.mon.types.includes('GRASS') &&
      !hasFlag(target.statuses3, STATUS3_LEECHSEED) &&
      (moveData?.effect === 'EFFECT_ABSORB' || moveData?.effect === 'EFFECT_DREAM_EATER')
    ) {
      target.statuses3 |= attackerId | STATUS3_LEECHSEED
    }
  }

  // 5. Aftershock (src/abilities.cc:6350-6357)
  if (abilityId === 'ABILITY_AFTERSHOCK') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      attackerId !== targetId &&
      Boolean(moveData && moveData.power > 0)
    ) {
      unmodelled.push("Aftershock's followup move (UseAttackerFollowUpMove MOVE_MAGNITUDE, abilities.cc:6355) is not modelled")
    }
  }

  // 6. Blade Dance (src/abilities.cc:9038-9045)
  if (abilityId === 'ABILITY_BLADE_DANCE') {
    if (
      isBattlerAlive(state, targetId) &&
      Boolean(moveData?.flags?.dance)
    ) {
      unmodelled.push("Blade Dance's followup move (UseAttackerFollowUpMove MOVE_LEAF_BLADE, abilities.cc:9043) is not modelled")
    }
  }

  // 7. Cute Charm family on attacker (src/abilities.cc:1207-1215, 6522-6536, 10009)
  if (
    abilityId === 'ABILITY_CUTE_CHARM' ||
    abilityId === 'ABILITY_TENDER_AFFECTION' ||
    abilityId === 'ABILITY_PURE_LOVE'
  ) {
    if (abilityId === 'ABILITY_PURE_LOVE') {
      if (
        targetDamage > 0 &&
        attacker.mon.hp < attacker.mon.maxHp &&
        canBattlerHeal(state, attackerId, attacker, unmodelled) &&
        hasFlag(target.mon.status2, STATUS2_INFATUATION)
      ) {
        const heal = Math.max(1, Math.floor(hpDealt / 4))
        attacker.mon.hp = Math.min(attacker.mon.maxHp, attacker.mon.hp + heal)
        syncPartyHp(state, attackerId)
      }
    }
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      canInfatuate(state, attackerId, targetId, statusDeps)
    ) {
      if (state.rng.random16() % 100 < 50) {
        target.mon.status2 = setFlag(target.mon.status2, statusInfatuatedWith(attackerId))
      }
    }
  }

  // 8. Damp on attacker (src/abilities.cc:564-576)
  if (abilityId === 'ABILITY_DAMP') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !target.mon.types.includes('WATER')
    ) {
      target.mon.types = ['WATER', 'WATER', 'MYSTERY']
    }
  }

  // 9. Elemental Charge (src/abilities.cc:5495-5519)
  if (abilityId === 'ABILITY_ELEMENTAL_CHARGE') {
    if (target.mon.hp > 0 && targetDamage > 0) {
      if (state.rng.random16() % 100 < 20) {
        if (moveTypeMatches(moveData, 'ELECTRIC')) {
          if (canBeParalyzed(state, attackerId, targetId, statusDeps)) {
            const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_PARALYSIS, moveId, statusDeps, unmodelled, false, false, true)
            if (res.applied && res.status) {
              result.statusApplied = { battlerId: targetId, status: res.status }
            }
          }
        } else if (moveTypeMatches(moveData, 'FIRE')) {
          if (canBeBurned(state, targetId, attackerId, statusDeps)) {
            const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_BURN, moveId, statusDeps, unmodelled, false, false, true)
            if (res.applied && res.status) {
              result.statusApplied = { battlerId: targetId, status: res.status }
            }
          }
        } else if (moveTypeMatches(moveData, 'ICE')) {
          if (canGetFrostbite(state, targetId, attackerId, statusDeps)) {
            const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_FROSTBITE, moveId, statusDeps, unmodelled, false, false, true)
            if (res.applied && res.status) {
              result.statusApplied = { battlerId: targetId, status: res.status }
            }
          }
        }
      }
    }
  }

  // 10. Envenom (src/abilities.cc:10270-10276)
  if (abilityId === 'ABILITY_ENVENOM') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      canBePoisoned(state, attackerId, targetId, 'MOVE_NONE', statusDeps)
    ) {
      if (state.rng.random16() % 100 < 30) {
        const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_POISON, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          result.statusApplied = { battlerId: targetId, status: res.status }
        }
      }
    }
  }

  // Impaler (src/abilities.cc:10222-10232): ShouldApplyOnHitEffect(target), CanBleed(target), horn move, then the 30% roll (drawn last, after
  // the three checks pass), then AbilityStatusEffect(MOVE_EFFECT_BLEED). Its onOffensiveMultiplier is Mighty Horn's (impl/10-aliases.ts).
  if (abilityId === 'ABILITY_IMPALER') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBleed(state, targetId, attackerId, statusDeps) &&
      Boolean(moveData?.flags?.hornBased) &&
      state.rng.random16() % 100 < 30
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BLEED, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Molten Blades (src/abilities.cc:7510-7520): CanBeBurned(target), Keen Edge move, then the 20% roll, then AbilityStatusEffect(MOVE_EFFECT_BURN).
  if (abilityId === 'ABILITY_MOLTEN_BLADES') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBeBurned(state, targetId, attackerId, statusDeps) &&
      isKeenEdgeMove(state, attackerId, moveId, statusDeps, unmodelled) &&
      state.rng.random16() % 100 < 20
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BURN, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Toxic Chain (src/abilities.cc:7698-7706): CanBePoisoned(battler, target, MOVE_NONE), 30% roll, AbilityStatusEffect(MOVE_EFFECT_TOXIC).
  // Komodo's onAttacker is `Impl<ABILITY_TOXIC_CHAIN>.onAttacker` (:10262-10267).
  if (abilityId === 'ABILITY_TOXIC_CHAIN' || abilityId === 'ABILITY_KOMODO') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBePoisoned(state, attackerId, targetId, 'MOVE_NONE', statusDeps) &&
      state.rng.random16() % 100 < 30
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_TOXIC, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // ---- Cycle 106: on-hit attacker abilities. ShouldApplyOnHitEffect(target) == DidMoveHit() && IsBattlerAlive(target)
  // (src/battle_util.c:4058-4062: WasMoveSuccessful() = !(gMoveResultFlags & MOVE_RESULT_NO_EFFECT) && attacker != target,
  // DidMoveHit() = WasMoveSuccessful() && TARGET_TURN_DAMAGED), read with the same approximation the Impaler block uses
  // (target alive, hpDealt > 0, attacker != target). The roll is always drawn last, after every earlier CHECK passes.

  // Arc Flash (src/abilities.cc:8082-8090): CanBeParalyzed(battler, target), then the 50% roll, then AbilityStatusEffect(MOVE_EFFECT_PARALYSIS).
  // Its onDefender half (:8091-8097) is separate and untouched.
  if (abilityId === 'ABILITY_ARC_FLASH') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBeParalyzed(state, attackerId, targetId, statusDeps) &&
      state.rng.random16() % 2 !== 0
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_PARALYSIS, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Hypnotic Trance (src/abilities.cc:12593-12601): move == MOVE_HYPNOSIS, WasMoveSuccessful(), CanBeConfused(target), no roll.
  // WasMoveSuccessful (src/battle_util.c:4058) = !(gMoveResultFlags & MOVE_RESULT_NO_EFFECT) && gBattlerAttacker != gBattlerTarget,
  // which the dispatcher supplies as `noEffect` (MoveEndAbilitiesContext.noEffect). Undefined (test dispatch) is treated as success.
  if (abilityId === 'ABILITY_HYPNOTIC_TRANCE') {
    if (
      moveId === 'MOVE_HYPNOSIS' &&
      !noEffect &&
      attackerId !== targetId &&
      canBeConfused(state, targetId, attackerId, statusDeps)
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_CONFUSION, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Icicle Fist (src/abilities.cc:12500-12508): IsIronFistBoosted(battler, move) (DoesMoveMatchFlag(... MOVE_FLAG_PUNCH),
  // battle_util.c:9375), CanGetFrostbite(target), then the 30% roll, then AbilityStatusEffect(MOVE_EFFECT_FROSTBITE).
  if (abilityId === 'ABILITY_ICICLE_FIST') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isIronFistBoosted(attacker.mon.abilities, moveData?.flags ?? {}, moveData?.split ?? 'STATUS') &&
      canGetFrostbite(state, targetId, attackerId, statusDeps) &&
      state.rng.random16() % 100 < 30
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_FROSTBITE, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Laser Drill (src/abilities.cc:11007-11015): CanBeBurned(target), gBattleMoves[move].hornBased, then the 50% roll,
  // then AbilityStatusEffect(MOVE_EFFECT_BURN).
  if (abilityId === 'ABILITY_LASER_DRILL') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBeBurned(state, targetId, attackerId, statusDeps) &&
      Boolean(moveData?.flags?.hornBased) &&
      state.rng.random16() % 2 !== 0
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BURN, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Piercing Solo (src/abilities.cc:8011-8019): CanBleed(target), IsSoundMove(battler, move), no roll,
  // then AbilityStatusEffect(MOVE_EFFECT_BLEED).
  if (abilityId === 'ABILITY_PIERCING_SOLO') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBleed(state, targetId, attackerId, statusDeps) &&
      isSoundMove(state, attackerId, moveId, statusDeps, unmodelled)
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BLEED, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Radio Jam (src/abilities.cc:7544-7552): CanBeDisabled(target), IsSoundMove(battler, move), then the 20% roll,
  // then AbilityStatusEffect(MOVE_EFFECT_DISABLE). applyAbilityOnHitStatus's 'DISABLE' branch carries the script's own
  // CanBeDisabled + DisableLastUsedMove writes (battle_script_commands.c:2955-2959, :10714-10737).
  if (abilityId === 'ABILITY_RADIO_JAM') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBeDisabled(state, targetId, attackerId, statusDeps) &&
      isSoundMove(state, attackerId, moveId, statusDeps, unmodelled) &&
      state.rng.random16() % 100 < 20
    ) {
      applyAbilityOnHitStatus(state, 'DISABLE', attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Sharp Talons (src/abilities.cc:11345-11353): DoesMoveMatchFlag(battler, move, moveType, MOVE_FLAG_KICK) -- statusEffects.ts
  // isStrikerMove, the same helper IsStrikerBoosted uses (:9377) -- then CanBleed(target), then the 50% roll,
  // then AbilityStatusEffect(MOVE_EFFECT_BLEED).
  if (abilityId === 'ABILITY_SHARP_TALONS') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isStrikerMove(state, attackerId, moveId, statusDeps) &&
      canBleed(state, targetId, attackerId, statusDeps) &&
      state.rng.random16() % 2 !== 0
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BLEED, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Shocking Jaws (src/abilities.cc:5716-5724) / Shocking Maw (:8822-8823, `Impl<ABILITY_SHOCKING_JAWS>.onAttacker`):
  // CanBeParalyzed(battler, target), FLAG_STRONG_JAW_BOOST (= flags.biteBased), then the 50% roll,
  // then AbilityStatusEffect(MOVE_EFFECT_PARALYSIS).
  if (abilityId === 'ABILITY_SHOCKING_JAWS' || abilityId === 'ABILITY_SHOCKING_MAW') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBeParalyzed(state, attackerId, targetId, statusDeps) &&
      Boolean(moveData?.flags?.biteBased) &&
      state.rng.random16() % 2 !== 0
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_PARALYSIS, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Stun Shock (src/abilities.cc:8917-8933): the 60% roll, then switch (Random() % 2); both rolls are drawn after
  // ShouldApplyOnHitEffect passes, and the %2 roll is consumed even when the branch's own CHECK fails.
  // case 0: CanBePoisoned(battler, target, MOVE_NONE) then MOVE_EFFECT_POISON; case 1: CanBeParalyzed(battler, target)
  // then MOVE_EFFECT_PARALYSIS.
  if (abilityId === 'ABILITY_STUN_SHOCK') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      state.rng.random16() % 100 < 60
    ) {
      const branch = state.rng.random16() % 2
      if (branch === 0 && canBePoisoned(state, attackerId, targetId, 'MOVE_NONE', statusDeps)) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_POISON, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      } else if (branch === 1 && canBeParalyzed(state, attackerId, targetId, statusDeps)) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_PARALYSIS, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      }
    }
  }

  // Light Saber (src/abilities.cc:11021-11038): DoesMoveMatchFlag(... MOVE_FLAG_KEEN_EDGE) (isKeenEdgeMove), then the 50% roll,
  // then switch (Random() % 4): case 0 CanBeBurned(target) -> MOVE_EFFECT_BURN; case 1 CanBeParalyzed(battler, target) ->
  // MOVE_EFFECT_PARALYSIS; default nothing. Draw order is the %2 roll followed by the %4 roll.
  if (abilityId === 'ABILITY_LIGHT_SABER') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isKeenEdgeMove(state, attackerId, moveId, statusDeps, unmodelled) &&
      state.rng.random16() % 2 !== 0
    ) {
      const branch = state.rng.random16() % 4
      if (branch === 0 && canBeBurned(state, targetId, attackerId, statusDeps)) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_BURN, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      } else if (branch === 1 && canBeParalyzed(state, attackerId, targetId, statusDeps)) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_PARALYSIS, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      }
    }
  }

  // Hydro Circuit (src/abilities.cc:5368-5380): ShouldApplyOnHitEffect(battler) -- the ATTACKER, so attacker alive and the
  // move hit -- then not at max HP, CanBattlerHeal(battler), moveType == TYPE_WATER. gBattleMoveDamage = -gHpDealt / 4
  // (s32 division truncating toward zero), bumped to -1 when zero; BattleScript_HydroCircuitAbsorbEffectActivated
  // (battle_scripts_1.s:11563-11570) runs manipulatedamage DMG_TO_HP_FROM_ABILITY (GetDrainedBigRootHp, battle_util.c:2369-2377)
  // and heals BS_ATTACKER (healthbarupdate/datahpupdate BS_ATTACKER). moveType is GET_MOVE_TYPE's resolved type (battle_util.c:9019).
  if (abilityId === 'ABILITY_HYDRO_CIRCUIT') {
    if (
      attacker.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      attacker.mon.hp < attacker.mon.maxHp &&
      canBattlerHeal(state, attackerId, attacker, unmodelled) &&
      moveTypeName() === 'WATER'
    ) {
      healFromAbilityDrain(state, attackerId, Math.max(1, Math.floor(hpDealt / 4)), deps)
    }
  }

  // Pinnacle Blade (src/abilities.cc:8687-8720; its onInfiltrate half is statusEffects.ts infiltratesSubstitute): DidMoveHit() only -- the
  // target may already have fainted -- then a Keen Edge move. A keen-edge move always infiltrates Substitute, so the hit landed on the mon.
  if (abilityId === 'ABILITY_PINNACLE_BLADE') {
    if (hpDealt > 0 && attackerId !== targetId && isKeenEdgeMove(state, attackerId, moveId, statusDeps, unmodelled)) {
      // BattleScript_AttackerDestroysSubstitute (data/battle_scripts_1.s:10706-10710) only prints a message and plays the fade animation; the
      // state change is the C's `substituteHP = 0` (:8698-8700), which MOVEEND_SUBSTITUTE (case 16) turns into the cleared STATUS2_SUBSTITUTE.
      if (target.volatiles.substituteHp) {
        target.volatiles.substituteHp = 0
      }

      if (isBattlerAlive(state, targetId)) {
        const targetSide = state.sides[targetId & 1]
        // BattleScript_AttackerShattersScreens (data/battle_scripts_1.s:6374-6378) is `removelightscreenreflect`, i.e. Cmd_removelightscreenreflect
        // (battle_script_commands.c:12384-12416, side = GetBattlerSide(gBattlerTarget)); same writes as Brick Break (turn.ts).
        if (targetSide.timers.reflectTimer || targetSide.timers.lightscreenTimer || targetSide.timers.auroraVeilTimer) {
          if (hasFlag(targetSide.statuses, SIDE_STATUS_SCREEN_ANY | SIDE_STATUS_SMOKESCREEN)) {
            targetSide.statuses = clearFlag(targetSide.statuses, SIDE_STATUS_SCREEN_ANY | SIDE_STATUS_SMOKESCREEN)
            targetSide.timers.reflectTimer = 0
            targetSide.timers.lightscreenTimer = 0
            targetSide.timers.auroraVeilTimer = 0
            targetSide.timers.smokescreenTimer = 0
          }
        }

        // AbilityStatusEffectDirect(MOVE_EFFECT_FEINT) (abilities.cc:270-275 -> SetMoveEffect -> battle_script_commands.c:2879-2891), gated by
        // IS_BATTLER_PROTECTED (include/battle.h:762-764). SetMoveEffect's Sheer Force (:2361) and Substitute (:2388) gates still apply.
        const isProtected =
          Boolean(target.round.protectMove) ||
          hasFlag(targetSide.statuses, SIDE_STATUS_WIDE_GUARD | SIDE_STATUS_CRAFTY_SHIELD | SIDE_STATUS_MAT_BLOCK)
        if (
          isProtected &&
          !testSheerForceFlag(state, attackerId, moveId, statusDeps) &&
          !doesSubstituteBlockMove(state, attackerId, targetId, moveId, statusDeps, unmodelled)
        ) {
          target.round.protectMove = null
          targetSide.statuses = clearFlag(targetSide.statuses, SIDE_STATUS_WIDE_GUARD | SIDE_STATUS_CRAFTY_SHIELD | SIDE_STATUS_MAT_BLOCK)
        }
      }
    }
  }

  // ---- Cycle 106b: second batch of on-hit attacker abilities. Same ShouldApplyOnHitEffect(x) approximation as the
  // Cycle 106 block above (target alive, hpDealt > 0, attacker != target); `moveType` is the effective (ate-adjusted)
  // move type, via the `moveTypeName()` closure defined in Cycle 91b.

  // Blood Stain (src/abilities.cc:8372-8386; ON_EITHER(BloodStain), assigned to BOTH hooks by ON_EITHER_ABILITY
  // (:54) -- on the onAttacker path `battler` is the holder (the attacker) and `opponent` is gBattlerTarget, the mon
  // whose ability is replaced). ReplaceAbility (battle_util.c:9325) writes abilities[0]; the same writes Mummy's port
  // above makes, plus DisableSwitchInAbility (:3922-3927).
  if (abilityId === 'ABILITY_BLOOD_STAIN') {
    const targetPrimary = target.mon.abilities.ability ?? 'ABILITY_NONE'
    if (
      target.mon.hp > 0 && // ShouldApplyOnHitEffect(opponent)
      hpDealt > 0 &&
      attackerId !== targetId &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES.includes(targetPrimary) &&
      !hasAbilityIgnoringSuppression(target, abilityId) &&
      !doesBattlerHaveAbilityShield(target, deps)
    ) {
      updateAbilityStateForNewAbility(target, abilityId)
      target.mon.abilities.ability = abilityId
      disableSwitchInAbility(state, targetId, abilityId, deps.dataContext)
    }
  }

  // Daybreak (src/abilities.cc:9193-9205; ON_EITHER(Daybreak), :9206-9208): ShouldApplyOnHitEffect(opponent),
  // CanBeBurned(opponent), IsMoveMakingContact, then AbilityStatusEffectSafe(MOVE_EFFECT_BURN, battler, opponent) --
  // no roll. AbilityStatusEffectSafe (:277-283) only re-points gBattlerAttacker/gBattlerTarget at (attacker, target)
  // around the same seteffectsecondary script, and on the onAttacker path those already ARE the holder and the hit
  // target, so applyAbilityOnHitStatus is the same call here.
  if (abilityId === 'ABILITY_DAYBREAK') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canBeBurned(state, targetId, attackerId, statusDeps) &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect)
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_BURN, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Demolitionist (src/abilities.cc:7771-7785): DidMoveHit() -- which does NOT require the target alive, so a
  // lethal hit still shatters the screens -- then the holder's own readiedAction volatile, then the TARGET side's
  // reflect / light screen / aurora veil timers (GetBattlerSide(target)). BattleScript_AttackerShattersScreens
  // (data/battle_scripts_1.s:6374-6378) is `removelightscreenreflect`; the writes are the ones Pinnacle Blade
  // already carries (battle_script_commands.c:12384-12416).
  if (abilityId === 'ABILITY_DEMOLITIONIST') {
    const targetSide = state.sides[targetId & 1]
    if (
      hpDealt > 0 && // DidMoveHit()
      attackerId !== targetId &&
      attacker.volatiles.readiedAction &&
      targetSide &&
      (targetSide.timers.reflectTimer || targetSide.timers.lightscreenTimer || targetSide.timers.auroraVeilTimer)
    ) {
      if (hasFlag(targetSide.statuses, SIDE_STATUS_SCREEN_ANY | SIDE_STATUS_SMOKESCREEN)) {
        targetSide.statuses = clearFlag(targetSide.statuses, SIDE_STATUS_SCREEN_ANY | SIDE_STATUS_SMOKESCREEN)
        targetSide.timers.reflectTimer = 0
        targetSide.timers.lightscreenTimer = 0
        targetSide.timers.auroraVeilTimer = 0
        targetSide.timers.smokescreenTimer = 0
      }
    }
  }

  // Gulp Missile, onAttacker (src/abilities.cc:3262-3288): not transformed, the holder IS SPECIES_CRAMORANT, then
  // `(Surf / Triple Dive && TARGET_TURN_DAMAGED) || holder is STATUS3_UNDERWATER || (Dive && acceleratedTwoTurn)`.
  // The third branch is dead code at this SHA: nothing anywhere in the tree ever writes
  // gBattleScripting.acceleratedTwoTurn = TRUE (battle_util.c:745 and battle_main.c:2738 only clear it), and the sim
  // has no such field, so it is modelled as always-false -- which is what the C does at runtime.
  // `hp <= maxHP / 2` picks GORGING else GULPING; UpdateAbilityStateIndicesForNewSpecies + the species write +
  // BattleScript_AttackerFormChange are changeBattlerForm + applySwitchInAbilities, exactly as in Shields Down below.
  // (This ability's onDefender half is a separate hook, ported in handleDefenderMoveEndAbility below;
  //  it is not touched here.)
  if (abilityId === 'ABILITY_GULP_MISSILE') {
    if (
      !hasFlag(attacker.mon.status2, STATUS2_TRANSFORMED) &&
      attacker.mon.speciesId === 'SPECIES_CRAMORANT' &&
      (((moveId === 'MOVE_SURF' || moveId === 'MOVE_TRIPLE_DIVE') && hpDealt > 0) ||
        hasFlag(attacker.statuses3, STATUS3_UNDERWATER))
    ) {
      const newSpecies =
        attacker.mon.hp <= Math.trunc(attacker.mon.maxHp / 2) ? 'SPECIES_CRAMORANT_GORGING' : 'SPECIES_CRAMORANT_GULPING'
      changeBattlerForm(state, attackerId, newSpecies, deps.dataContext)
      applySwitchInAbilities(state, attackerId, deps, unmodelled)
    }
  }

  // Hollow Ice Zone (src/abilities.cc:12178-12198): an Ice move, ShouldApplyOnHitEffect(target), the target is not
  // already an ice statue, and the target does not itself have the ability (BattlerHasAbility(..., FALSE): no Mold
  // Breaker, but Neutralizing Gas / Gastro Acid still suppress). BattleScript_IceStatue (data/battle_scripts_1.s:
  // 12597-12600) is the message alone. SET_BATTLER_TYPE (include/battle.h:755-760) writes all three type slots.
  // The scheduled entry is copied verbatim from the C's ExtraSwitchActionStruct: switchingBattler is `battler`, the
  // HOLDER (so Hollow Ice Zone switches the attacker out, not the frozen target), and sourceBattler is the holder.
  if (abilityId === 'ABILITY_HOLLOW_ICE_ZONE') {
    if (
      moveTypeName() === 'ICE' &&
      target.mon.hp > 0 && // ShouldApplyOnHitEffect(target)
      hpDealt > 0 &&
      attackerId !== targetId &&
      !target.volatiles.iceStatue &&
      !battlerHasSimAbility(state, target, abilityId, false, attackerId, false, deps.dataContext)
    ) {
      target.volatiles.iceStatue = true
      target.mon.types = ['ICE', 'ICE', 'MYSTERY']
      tryScheduleSwitch(state, {
        ability: abilityId,
        setAbilityState: false,
        switchingBattler: attackerId,
        sourceBattler: attackerId,
      })
    }
  }

  // Home Run (src/abilities.cc:11926-11985). gIsCriticalHit, ShouldApplyOnHitEffect(battler) -- the ATTACKER -- and the
  // ability state still clear. The five CalculateStat(..., FALSE x4) calls are battle_util.c:7105-7217 with
  // isAttack / isCrit / isUnaware all FALSE and a zeroed secondaryStat: the stat stage is left as it is (only
  // BenefitsFromStatBuffs can clamp it) and the tail is the stage ratio then extraStatLevel. STAT_SPEED delegates to
  // GetBattlerTotalSpeedStat(battler, TOTAL_SPEED_PRIMARY, move) (battle_main.c:4195-4210), i.e. the ability-adjusted
  // raw stat before stages.
  if (abilityId === 'ABILITY_HOME_RUN') {
    const slot = findAbilitySlot(attacker.mon.abilities, abilityId)
    if (
      isCriticalHit === true &&
      attacker.mon.hp > 0 && // ShouldApplyOnHitEffect(battler)
      hpDealt > 0 &&
      attackerId !== targetId &&
      slot !== -1 &&
      !attacker.volatiles.abilityState[slot] // CHECK_NOT(GetAbilityState(battler, ability))
    ) {
      // The same gaps Strength Sap's CalculateStat port carries (moveEffects.ts): no onStat ability hooks and no
      // Wonder Room swap, plus the burn / frostbite halving's IgnoresBurnAtkDrop / IgnoresFrostbiteSpatkDrop checks
      // (:7095-7103) when a relevant status is actually up.
      unmodelled.push("Home Run's CalculateStat (battle_util.c:7105-7217) applies no onStat ability hooks and ignores Wonder Room")

      const common = {
        isUnaware: false,
        isWonderRoomActive: false,
        isOffensiveStatForWonderRoom: false,
        isCrit: false,
        isAttackRole: false,
        benefitsFromStatBuffs: benefitsFromStatBuffs(state, attackerId),
        applyOnStatHooks: (s: number) => s, // no onStat registry in the sim
        secondaryStatPercent: 0,
        statStageRatios: deps.statStageRatios,
      }
      const isFacade = moveData?.effect === 'EFFECT_FACADE'
      const isBurned = hasFlag(attacker.mon.status1, STATUS1_BURN) && !isFacade
      const isFrostbitten = hasFlag(attacker.mon.status1, STATUS1_FROSTBITE) && !isFacade
      if (isBurned || isFrostbitten) {
        unmodelled.push(
          "Home Run's CalculateStat burn / frostbite halving does not check IgnoresBurnAtkDrop / IgnoresFrostbiteSpatkDrop (battle_util.c:7095-7103)",
        )
      }
      const isIceInHail =
        attacker.mon.types.includes('ICE') && isBattlerWeatherAffected(state, attackerId, WEATHER_HAIL_ANY, statusDeps)
      const isRockInSandstorm =
        attacker.mon.types.includes('ROCK') && isBattlerWeatherAffected(state, attackerId, WEATHER_SANDSTORM_ANY, statusDeps)
      // CalculateStat's STAT_SPEED case (:7179) is GetBattlerTotalSpeedStat(battler, TOTAL_SPEED_PRIMARY, move); the
      // stage and extra level are then applied by CalculateStat's own tail, which calculateBattleStat does below.
      const speedPrimary = getBattlerTotalSpeedStat(
        state,
        attackerId,
        TOTAL_SPEED_PRIMARY,
        moveId,
        { ...deps.turnOrder, isBattlerGrounded: (id: number) => isBattlerGrounded(state, id, deps.grounding) },
        deps.statStageRatios,
      )

      const stats: [number, number][] = [
        [
          STAT_ATK,
          calculateBattleStat({
            ...common,
            rawStat: attacker.mon.rawStats.atk,
            extraStatLevel: attacker.volatiles.extraAttackLevel ?? 0,
            statStage: attacker.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE,
            preModify: attackPreModify({
              violentRush: !!attacker.volatiles.violentRush,
              showdownMode: !!attacker.volatiles.showdownMode,
              readiedAction: !!attacker.volatiles.readiedAction,
              isBurned,
            }),
          }),
        ],
        [
          STAT_DEF,
          calculateBattleStat({
            ...common,
            rawStat: attacker.mon.rawStats.def,
            extraStatLevel: attacker.volatiles.extraDefenseLevel ?? 0,
            statStage: attacker.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE,
            preModify: defensePreModify({ isIceTypeInHail: isIceInHail }),
          }),
        ],
        [
          STAT_SPATK,
          calculateBattleStat({
            ...common,
            rawStat: attacker.mon.rawStats.spatk,
            extraStatLevel: attacker.volatiles.extraSpAttackLevel ?? 0,
            statStage: attacker.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE,
            preModify: spAttackPreModify({ rapidResponse: !!attacker.volatiles.rapidResponse, isFrostbitten }),
          }),
        ],
        [
          STAT_SPDEF,
          calculateBattleStat({
            ...common,
            rawStat: attacker.mon.rawStats.spdef,
            extraStatLevel: attacker.volatiles.extraSpDefenseLevel ?? 0,
            statStage: attacker.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE,
            preModify: spDefensePreModify({ isRockTypeInSandstorm: isRockInSandstorm }),
          }),
        ],
        [
          STAT_SPEED,
          calculateBattleStat({
            ...common,
            rawStat: speedPrimary,
            extraStatLevel: attacker.volatiles.extraSpeedLevel ?? 0,
            statStage: attacker.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE,
            preModify: (s: number) => s,
          }),
        ],
      ]

      // "This is just a partial bubble sort" (:11952-11960): the tie-break `Random() % 2` is drawn only on equal
      // values, in loop order, and a nonzero result skips the swap.
      for (const maxValueIndex of [4, 3]) {
        for (let i = 0; i < maxValueIndex; i++) {
          if (stats[i][1] < stats[maxValueIndex][1]) continue
          if (stats[i][1] === stats[maxValueIndex][1] && state.rng.random16() % 2 !== 0) continue
          const tmp = stats[i]
          stats[i] = stats[maxValueIndex]
          stats[maxValueIndex] = tmp
        }
      }

      // "Sort stats by boost order. Read LIFO so in reverse order." (:11964-11974).
      const statsToBoost: number[] = []
      for (const statId of [STAT_SPEED, STAT_SPDEF, STAT_DEF, STAT_SPATK, STAT_ATK]) {
        for (let i = 0; i < 3; i++) {
          if (stats[i][0] === statId) {
            statsToBoost.push(statId)
            break
          }
        }
        if (statsToBoost.length >= 3) break
      }

      for (const stat of statsToBoost) {
        if (!canRaiseStat(state, attackerId, stat, deps.dataContext)) continue // FILTER(CanRaiseStat(battler, stat))
        attacker.volatiles.abilityState[slot] = 1 // SetAbilityState(battler, ability, 1)
        // SetStatChanger(stat, 1) + BattleScript_StackBattlerStatUp (data/battle_scripts_1.s:9028-9037), i.e.
        // `statbuffchange MOVE_EFFECT_AFFECTS_USER` with gBattlerAttacker = the holder.
        const res = changeStatBuffs(
          state,
          attackerId,
          attackerId,
          targetId,
          1,
          stat,
          MOVE_EFFECT_AFFECTS_USER,
          true,
          { dataContext: deps.dataContext, grounding: deps.grounding },
          unmodelled,
          moveId,
        )
        if (res.delta !== 0) {
          result.statChanges.push({ battlerId: attackerId, stat, change: res.delta })
        }
      }
    }
  }

  // Know Your Place (src/abilities.cc:9074-9085): ShouldApplyOnHitEffect(target), the target is not already dazed,
  // contact. Then `gVolatileStructs[target].dazed = 5` (a 3-bit field, `5` fits) and `started.dazed = TRUE`; the
  // timer itself is decremented by ENDTURN_GENERIC_BATTLER_TIMERS (battle_util.c:2960-2979, SUBTRACT_VOLATILE_TIMER),
  // which endTurn.ts still notes as unapplied. BattleScript_TargetDazed (data/battle_scripts_1.s:12469-12472) is the
  // message alone. No roll.
  // Tangled Tails (src/abilities.cc:12001-12004) is `.onAttacker = Impl<ABILITY_KNOW_YOUR_PLACE>.onAttacker`, so the
  // same lambda runs for it; its `.grappler = TRUE` is a damage-side flag (not this hook) and is not touched here.
  if (abilityId === 'ABILITY_KNOW_YOUR_PLACE' || abilityId === 'ABILITY_TANGLED_TAILS') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      !target.volatiles.dazed &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect)
    ) {
      target.volatiles.dazed = 5
      target.volatiles.started.dazed = true
    }
  }

  // Paint Shot (src/abilities.cc:10711-10725): ShouldApplyOnHitEffect(target), the target is not already of the
  // move's type, IsMegaLauncherBoosted(battler, move) (battle_util.c:9373 -> DoesMoveMatchFlag(... MOVE_FLAG_MEGA_LAUNCHER),
  // i.e. the bulletBased flag or Gunman). Then type1 = type2 = moveType and type3 = TYPE_MYSTERY (:10720-10722).
  if (abilityId === 'ABILITY_PAINT_SHOT') {
    const moveType = moveTypeName()
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      moveType !== null &&
      !target.mon.types.includes(moveType) &&
      isMegaLauncherBoostedMove(state, attackerId, moveData, deps)
    ) {
      target.mon.types = [moveType, moveType, 'MYSTERY']
    }
  }

  // Shields Down, onAttacker (src/abilities.cc:2680-2720): alive, not MOVE_RESULT_NO_EFFECT, the move's effect is
  // EFFECT_SHELL_SMASH, not transformed; then the gHpTransformations row (battle_util.c:3798-3810) whose ability is
  // this one and whose highHpSpecies is the battler's species. The C then runs UpdateAbilityStateIndicesForNewSpecies,
  // SetAbilityState(TRUE) and the species write before BattleScript_AttackerFormChange (data/battle_scripts_1.s:
  // 8454-8462), whose handleformchange cases 0-2 are changeBattlerForm (species + ability-slot remap + RecalcBattlerStats).
  if (abilityId === 'ABILITY_SHIELDS_DOWN') {
    if (
      attacker.mon.hp > 0 && // CHECK(IsBattlerAlive(battler))
      !noEffect && // CHECK_NOT(gMoveResultFlags & MOVE_RESULT_NO_EFFECT)
      moveData?.effect === 'EFFECT_SHELL_SMASH' && // CHECK(gBattleMoves[move].effect == EFFECT_SHELL_SMASH)
      !hasFlag(attacker.mon.status2, STATUS2_TRANSFORMED)
    ) {
      const row = HP_TRANSFORMATIONS.find((t) => t.ability === abilityId && t.highHpSpecies === attacker.mon.speciesId)
      if (row) {
        // UpdateAbilityStateIndicesForNewSpecies + the species write; BattleScript_AttackerFormChange's
        // handleformchange cases 0-2 are changeBattlerForm and its tail `switchinabilities BS_ATTACKER` is
        // applySwitchInAbilities (formChange.ts's tryTransformAttacker, same script).
        changeBattlerForm(state, attackerId, row.lowHpSpecies, deps.dataContext)
        // SetAbilityState(battler, ability, TRUE) after the remap, so the flag lands in the NEW slot for the ability.
        const slot = findAbilitySlot(attacker.mon.abilities, abilityId)
        if (slot !== -1) attacker.volatiles.abilityState[slot] = 1
        applySwitchInAbilities(state, attackerId, deps, unmodelled)
      }
    }
  }

  // Sinister Claws (src/abilities.cc:12415-12429): ShouldApplyOnHitEffect(target), a Keen Edge move,
  // StatLowerableOrMirrorArmor(target, STAT_SPDEF), then the once-per-turn-per-target counter (Get/Set once-per-turn
  // ability counter, battle_util.c -- the same pattern Whiplash and Chainsaw use), then
  // AbilityStatusEffect(MOVE_EFFECT_SP_DEF_MINUS_1).
  if (abilityId === 'ABILITY_SINISTER_CLAWS') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isKeenEdgeMove(state, attackerId, moveId, statusDeps, unmodelled) &&
      canLowerStatOrMirrorArmor(state, targetId, STAT_SPDEF, deps.dataContext)
    ) {
      const affected = getOncePerTurnAbilityCounter(state, attackerId, abilityId, deps.dataContext)
      if ((affected & (1 << targetId)) === 0) {
        setOncePerTurnAbilityCounter(state, attackerId, abilityId, affected | (1 << targetId), deps.dataContext)
        applyAbilityStatDrop(state, attackerId, targetId, STAT_SPDEF, moveId, deps, statusDeps, unmodelled, result)
      }
    }
  }

  // Spectral Shroud (src/abilities.cc:4883-4901). Its onAttacker is `Impl<ABILITY_SPECTRALIZE>.onAttacker(...) |
  // SpectralShroud(...)` -- a bitwise OR, so BOTH halves run: the ATE half is handled by the ATE_ON_HIT_STATUS block
  // above (SPECTRALIZE's entry, reached for this ability too), and this half is SpectralShroud (:4883-4894). Its
  // onMoveType / onStab are SPECTRALIZE's (10-aliases.ts), already the damage side. Draw order: the ATE block's
  // `Random() % 10` (only when its own CHECKs pass) precedes this half's `Random() % 100`.
  // The status-move branch uses WasMoveSuccessful() + IsBattlerAlive(target) instead of ShouldApplyOnHitEffect; the
  // dispatcher carries the MOVE_RESULT_NO_EFFECT bit as `noEffect`. It has NO attacker != target guard, which the
  // C makes visible on a self-targeted status move (CanBePoisoned(battler, battler) then poisons the user) -- kept
  // as written rather than quietly tightened.
  if (abilityId === 'ABILITY_SPECTRAL_SHROUD') {
    const applies =
      moveData?.split === 'STATUS'
        ? !noEffect && target.mon.hp > 0
        : target.mon.hp > 0 && hpDealt > 0 && attackerId !== targetId
    if (
      applies &&
      canBePoisoned(state, attackerId, targetId, 'MOVE_NONE', statusDeps) &&
      state.rng.random16() % 100 < 30
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_TOXIC, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Spinning Top (src/abilities.cc:5116-5142): ShouldApplyOnHitEffect(battler) -- the ATTACKER -- then a Fighting
  // move, then CheckAndSetOncePerTurnAbility (consumed even when neither part below happens). GetClearableHazardFlags
  // (:424-428) is SIDE_STATUS_HAZARDS_ANY minus Sticky Web while the side's Foamy Web is up; the C clears only the
  // flag bits and the two side timers (no spikesAmount / toxicSpikesAmount reset, unlike Pickup), which is why the
  // sim's Pickup block's extra two writes are NOT copied here. Then ChangeStatBuffs(battler, +1, STAT_SPEED,
  // MOVE_EFFECT_AFFECTS_USER, NULL) -- a direct call, not SetMoveEffect, so no Sheer Force / Substitute gate.
  if (abilityId === 'ABILITY_SPINNING_TOP') {
    if (
      attacker.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      moveTypeName() === 'FIGHTING' &&
      checkAndSetOncePerTurnAbility(state, attackerId, abilityId, deps.dataContext)
    ) {
      const holderSide = state.sides[attackerId & 1]
      if (holderSide) {
        let hazardBits = SIDE_STATUS_HAZARDS_ANY
        if (holderSide.timers.foamyWeb) hazardBits &= ~SIDE_STATUS_STICKY_WEB
        if (hasFlag(holderSide.statuses, hazardBits) || holderSide.timers.hotCoals || holderSide.timers.caltrops) {
          holderSide.statuses = clearFlag(holderSide.statuses, hazardBits)
          holderSide.timers.hotCoals = false
          holderSide.timers.caltrops = false
        }
      }
      const res = changeStatBuffs(
        state,
        attackerId,
        attackerId,
        targetId,
        1,
        STAT_SPEED,
        MOVE_EFFECT_AFFECTS_USER,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        result.statChanges.push({ battlerId: attackerId, stat: STAT_SPEED, change: res.delta })
      }
    }
  }

  // ---- Cycle 106c: third batch of on-hit attacker abilities. Same ShouldApplyOnHitEffect(x) approximation as the
  // Cycle 106 / 106b blocks above (target alive, hpDealt > 0, attacker != target); `moveTypeName()` is the effective
  // (ate-adjusted) move type.

  // Venoblaze Pincers (src/abilities.cc:8129-8146): ShouldApplyOnHitEffect(target), a physical move, then the 20% roll,
  // then a SECOND draw switching on Random() % 2: case 0 CanBeBurned(target) -> MOVE_EFFECT_BURN, case 1
  // CanBePoisoned(battler, target, MOVE_NONE) -> MOVE_EFFECT_TOXIC. The %2 draw is consumed even when the branch's own
  // CHECK fails (a failing CanX does nothing, no reroll), and the switch has no default. Its onOffensiveMultiplier
  // (:8147-8150, physical moves MUL(1.2)) is the damage side and is not this hook.
  if (abilityId === 'ABILITY_VENOBLAZE_PINCERS') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      moveData?.split === 'PHYSICAL' &&
      state.rng.random16() % 100 < 20
    ) {
      const branch = state.rng.random16() % 2
      if (branch === 0 && canBeBurned(state, targetId, attackerId, statusDeps)) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_BURN, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      } else if (branch === 1 && canBePoisoned(state, attackerId, targetId, 'MOVE_NONE', statusDeps)) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_TOXIC, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      }
    }
  }

  // Virus (src/abilities.cc:10907-10913): ShouldApplyOnHitEffect(target), moveType == TYPE_ELECTRIC, then
  // CanBePoisoned(battler, target, move) -- the REAL move id, not MOVE_NONE: CanPoisonType (battle_script_commands.c:
  // 6462-6468) hands the move to each onCanStatusType hook, and the sim's canPoisonType only reads it for Poison Sting's
  // Angel's Wrath bypass -- then AbilityStatusEffect(MOVE_EFFECT_POISON). No roll.
  if (abilityId === 'ABILITY_VIRUS') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      moveTypeName() === 'ELECTRIC' &&
      canBePoisoned(state, attackerId, targetId, moveId, statusDeps)
    ) {
      applyAbilityOnHitStatus(state, MOVE_EFFECT_POISON, attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // Vitality Strike (src/abilities.cc:8545-8556): ShouldApplyOnHitEffect(battler) -- the ATTACKER -- then not at max HP,
  // CanBattlerHeal(battler), IsIronFistBoosted(battler, move) (battle_util.c:9375 -> DoesMoveMatchFlag(... MOVE_FLAG_PUNCH)).
  // gBattleMoveDamage = -gHpDealt / 10 (s32, truncating toward zero), bumped to -1 when zero, then
  // BattleScript_HydroCircuitAbsorbEffectActivated (data/battle_scripts_1.s:11563-11570) -- the same script Hydro Circuit
  // uses: manipulatedamage DMG_TO_HP_FROM_ABILITY (GetDrainedBigRootHp, battle_util.c:2369-2377: Big Root and Absorbant
  // both multiply by 3/2), healthbarupdate/datahpupdate BS_ATTACKER. Nothing else follows.
  if (abilityId === 'ABILITY_VITALITY_STRIKE') {
    if (
      attacker.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      attacker.mon.hp < attacker.mon.maxHp &&
      canBattlerHeal(state, attackerId, attacker, unmodelled) &&
      isIronFistBoosted(attacker.mon.abilities, moveData?.flags ?? {}, moveData?.split ?? 'STATUS')
    ) {
      healFromAbilityDrain(state, attackerId, Math.max(1, Math.floor(hpDealt / 10)), deps)
    }
  }

  // Wings of Pestilence (src/abilities.cc:11297-11313): ShouldApplyOnHitEffect(target), then TWO unconditional draws.
  // C `&&` order matters: the 10% curse roll is drawn FIRST and the STATUS2_CURSED test runs only after it (so the draw
  // happens even when the target is already cursed), and the 20% bleed roll is likewise drawn before CanBleed(target).
  // The curse is the C's own direct `gBattleMons[target].status2 |= STATUS2_CURSED` -- NOT AbilityStatusEffect, so
  // neither SetMoveEffect's Sheer Force gate (battle_script_commands.c:2361) nor its Substitute gate (:2388) applies;
  // BattleScript_MoveEffectCurse (data/battle_scripts_1.s:3378-3382) is statusanimation + message alone.
  if (abilityId === 'ABILITY_WINGS_OF_PESTILENCE') {
    if (target.mon.hp > 0 && hpDealt > 0 && attackerId !== targetId) {
      if (state.rng.random16() % 100 < 10 && !hasFlag(target.mon.status2, STATUS2_CURSED)) {
        target.mon.status2 = setFlag(target.mon.status2, STATUS2_CURSED)
        if (!result.statusApplied) result.statusApplied = { battlerId: targetId, status: 'CURSE' }
      }
      if (state.rng.random16() % 100 < 20 && canBleed(state, targetId, attackerId, statusDeps)) {
        applyAbilityOnHitStatus(state, MOVE_EFFECT_BLEED, attackerId, targetId, moveId, statusDeps, unmodelled, result)
      }
    }
  }

  // Woodland Curse onAttacker (src/abilities.cc:9835-9845). ON_EITHER_ABILITY (:54) assigns that lambda to BOTH hooks, so
  // on this path `battler` is the holder and `opponent` is the target. ShouldApplyOnHitEffect(opponent), IsMoveMakingContact, the target is not
  // already a Grass type (IS_BATTLER_OF_TYPE checks type1/type2/type3, include/battle.h:753-754), then the single write
  // `gBattleMons[opponent].type3 = TYPE_GRASS` -- type1 and type2 are left alone, unlike SET_BATTLER_TYPE.
  // BattleScript_StackAddedTheTypeRet (data/battle_scripts_1.s) is the message alone. Its onEntry (Forest's Curse) and
  // its onDefender half are separate hooks and are not touched here.
  if (abilityId === 'ABILITY_WOODLAND_CURSE') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !target.mon.types.includes('GRASS')
    ) {
      target.mon.types = [target.mon.types[0], target.mon.types[1], 'GRASS']
    }
  }

  // Wrestle Showman (src/abilities.cc:11716-11725): move == MOVE_FLYING_PRESS, ShouldApplyOnHitEffect(target),
  // IsBattlerAlive(target) (redundant with the hook above), !IsAbilityStatusProtected(target, CHECK_RESTRICTING), then
  // "not already taunted". BattleScript_WrestleShowman_Effect_FlyingPress (data/battle_scripts_1.s:12560-12565) re-runs
  // `jumpifabilitystatusimmunity BS_TARGET, MOVE_TAUNT` (the same CHECK_RESTRICTING gate) and then `settaunt`, i.e.
  // Cmd_settaunt (battle_script_commands.c:11678-11698): the Oblivious branch, then the tauntTimer == 0 branch, then
  // B_TAUNT_TURNS >= GEN_5's `turns = 4; if (GetBattlerTurnOrderNum(target) > GetBattlerTurnOrderNum(attacker))
  // turns--;` and `tauntTimer = tauntTimer2 = turns`. turn.ts supplies that ordering fact as `targetHasActedThisTurn`
  // (turn.ts:2572: target's slot index < the attacker's), so turns = 3 when the target has not moved yet, else 4. The
  // script has no ppreduce / accuracycheck of its own -- those belong to BattleScript_EffectTaunt, not here.
  if (abilityId === 'ABILITY_WRESTLE_SHOWMAN') {
    if (
      moveId === 'MOVE_FLYING_PRESS' &&
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      isAbilityStatusProtected(state, targetId, CHECK_RESTRICTING, attackerId, statusDeps) === null &&
      target.volatiles.tauntTimer === 0
    ) {
      if (targetHasActedThisTurn === undefined) {
        const msg = "Wrestle Showman's turn-order check (battle_script_commands.c:11684-11686) needs the target's turn-order slot, which this move-end call was not given"
        if (!unmodelled.includes(msg)) unmodelled.push(msg)
      } else {
        const attackerHasMB = attackerHasMoldBreakerActive(attacker, deps)
        if (!battlerHasSimAbility(state, target, 'ABILITY_OBLIVIOUS', true, attackerId, attackerHasMB, deps.dataContext)) {
          const turns = targetHasActedThisTurn ? 4 : 3
          target.volatiles.tauntTimer = turns
          target.volatiles.tauntTimer2 = turns
        }
      }
    }
  }

  // Yuki Onna onAttacker (src/abilities.cc:6425-6433): ShouldApplyOnHitEffect(target), CanInfatuate(battler, target)
  // -- the holder is the infatuating side, so the sim's canInfatuate(state, attackerId, targetId) argument order --
  // BEFORE the 30% roll, then AbilityStatusEffect(MOVE_EFFECT_ATTRACT). Its onEntry (UseIntimidateClone) is a separate
  // hook and is not touched here.
  if (abilityId === 'ABILITY_YUKI_ONNA') {
    if (
      target.mon.hp > 0 &&
      hpDealt > 0 &&
      attackerId !== targetId &&
      canInfatuate(state, attackerId, targetId, statusDeps) &&
      state.rng.random16() % 100 < 30
    ) {
      applyAbilityOnHitStatus(state, 'ATTRACT', attackerId, targetId, moveId, statusDeps, unmodelled, result)
    }
  }

  // 11. Flaming Jaws family (src/abilities.cc:6669-6676, 7766)
  if (abilityId === 'ABILITY_FLAMING_JAWS' || abilityId === 'ABILITY_FLAMING_MAW') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      canBeBurned(state, targetId, attackerId, statusDeps) &&
      Boolean(moveData?.flags?.biteBased)
    ) {
      if (state.rng.random16() % 2 !== 0) {
        const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_BURN, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          result.statusApplied = { battlerId: targetId, status: res.status }
        }
      }
    }
  }

  // 12. Grip Pincer family (src/abilities.cc:4690-4705, 10250, 12025-12041, 12082)
  if (
    abilityId === 'ABILITY_GRIP_PINCER' ||
    abilityId === 'ABILITY_WORLD_SERPENT' ||
    abilityId === 'ABILITY_SERPENT_BIND' ||
    abilityId === 'ABILITY_TENTALOCK'
  ) {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      !hasFlag(target.mon.status2, STATUS2_WRAPPED)
    ) {
      if (state.rng.random16() % 2 !== 0) {
        // SetOnMoveEffectReactionFlags(battler, target, MOVE_EFFECT_WRAP) (src/abilities.cc:4697, 4720, 12032)
        setOnMoveEffectReactionFlags(
          state,
          attackerId,
          targetId,
          MOVE_EFFECT_WRAP,
          { dataContext: deps.dataContext, grounding: deps.grounding },
        )
        target.mon.status2 = setFlag(target.mon.status2, STATUS2_WRAPPED)
        const hasGrappler = ['ABILITY_GRAPPLER', 'ABILITY_TANGLED_TAILS', 'ABILITY_TENTALOCK'].some((ab) =>
          battlerHasSimAbility(state, attacker, ab, false, attackerId, false, deps.dataContext),
        )
        const hasGripClaw = deps.grounding.holdEffectOf(attackerId) === 'HOLD_EFFECT_GRIP_CLAW'
        target.volatiles.wrapTurns =
          hasGrappler || hasGripClaw ? 5 + (hasGrappler ? 1 : 0) + (hasGripClaw ? 2 : 0) : (state.rng.random16() % 2) + 4
        target.volatiles.wrapAbility = abilityId
        const name =
          abilityId === 'ABILITY_WORLD_SERPENT'
            ? 'World Serpent'
            : abilityId === 'ABILITY_TENTALOCK'
              ? 'Tentalock'
              : abilityId === 'ABILITY_SERPENT_BIND'
                ? 'Serpent Bind'
                : 'Grip Pincer'
        unmodelled.push(`${name} set STATUS2_WRAPPED; ENDTURN_WRAP damage and the trap are not modelled`)
      }
    }
  }

  // Talon Trap, onAttacker half (src/abilities.cc:4713-4730 via ON_EITHER_ABILITY, :54). Holder =
  // attacker, opponent = target; see tryTalonTrapWrap.
  if (abilityId === 'ABILITY_TALON_TRAP') {
    tryTalonTrapWrap(state, deps, attackerId, targetId, attackerId, moveData, targetDamage, attackerHoldEffect)
  }

  // 13. Growing Tooth (src/abilities.cc:3848-3856)
  if (abilityId === 'ABILITY_GROWING_TOOTH') {
    if (
      targetDamage > 0 &&
      Boolean(moveData?.flags?.biteBased) &&
      canRaiseStat(state, attackerId, STAT_ATK, deps.dataContext)
    ) {
      const atkRes = changeStatBuffs(
        state,
        attackerId,
        attackerId,
        attackerId,
        1,
        STAT_ATK,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
        false,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (atkRes.delta !== 0) {
        result.statChanges.push({ battlerId: attackerId, stat: STAT_ATK, change: atkRes.delta })
      }
    }
  }

  // 14. High Tide (src/abilities.cc:6473-6478)
  if (abilityId === 'ABILITY_HIGH_TIDE') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      attackerId !== targetId &&
      moveTypeMatches(moveData, 'WATER')
    ) {
      unmodelled.push("High Tide's followup move (UseAttackerFollowUpMove MOVE_SURF, abilities.cc:6477) is not modelled")
    }
  }

  // 15. Illuminate (src/abilities.cc:913-942)
  if (abilityId === 'ABILITY_ILLUMINATE') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      target.mon.types.includes('GHOST')
    ) {
      let type1 = target.mon.types[0] ?? 'MYSTERY'
      let type2 = target.mon.types[1] ?? type1
      let type3 = target.mon.types[2] ?? 'MYSTERY'

      if (type1 === 'GHOST') {
        if (type1 === type2) {
          if (type3 === 'GHOST') {
            type1 = 'MYSTERY'
            type2 = 'MYSTERY'
            type3 = 'MYSTERY'
          } else {
            type1 = type3
            type2 = type3
            type3 = 'MYSTERY'
          }
        } else {
          type1 = type2
        }
      } else if (type2 === 'GHOST') {
        type2 = type1
      }

      if (type3 === 'GHOST') {
        type3 = 'MYSTERY'
      }

      target.mon.types = [type1, type2, type3]
    }
  }

  // 16. Loud Bang (src/abilities.cc:3899-3906)
  if (abilityId === 'ABILITY_LOUD_BANG') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      canBeConfused(state, targetId, attackerId, statusDeps) &&
      Boolean(moveData?.flags?.sound)
    ) {
      if (state.rng.random16() % 2 !== 0) {
        const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_CONFUSION, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          result.statusApplied = { battlerId: targetId, status: res.status }
        }
      }
    }
  }

  // 17. Purple Haze (src/abilities.cc:10281-10285)
  if (abilityId === 'ABILITY_PURPLE_HAZE') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      attackerId !== targetId
    ) {
      unmodelled.push("Purple Haze's followup move (UseAttackerFollowUpMove MOVE_POISON_GAS, abilities.cc:10284) is not modelled")
    }
  }

  // 18. Stench (src/abilities.cc:485-491)
  if (abilityId === 'ABILITY_STENCH') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      isKingsRockAffected(moveData, deps)
    ) {
      if (state.rng.random16() % 100 < 10) {
        // AbilityStatusEffectDirect (abilities.cc:270-275) sets HITMARKER_IGNORE_SAFEGUARD, so SetMoveEffect's
        // Shield Dust / Covert Cloak check (battle_script_commands.c:2350) is skipped.
        if (!testSheerForceFlag(state, attackerId, moveId, statusDeps)) {
          if (!doesSubstituteBlockMove(state, attackerId, targetId, moveId, statusDeps, unmodelled)) {
            if (!isAbilityStatusProtected(state, targetId, CHECK_FLINCH, attackerId, statusDeps)) {
              target.mon.status2 = setFlag(target.mon.status2, STATUS2_FLINCHED)
            }
          }
        }
      }
    }
  }

  // 19. Volcano Rage (src/abilities.cc:4841-4846)
  if (abilityId === 'ABILITY_VOLCANO_RAGE') {
    if (
      target.mon.hp > 0 &&
      targetDamage > 0 &&
      attackerId !== targetId &&
      moveTypeMatches(moveData, 'FIRE')
    ) {
      unmodelled.push("Volcano Rage's followup move (UseAttackerFollowUpMove MOVE_ERUPTION, abilities.cc:4845) is not modelled")
    }
  }

  // 20. Pickpocket (src/battle_script_commands.c:4290-4305, 4828-4853)
  if (abilityId === 'ABILITY_PICKPOCKET') {
    if (
      targetDamage > 0 &&
      attacker.mon.itemId === null &&
      isMoveMakingContact(moveData, attacker, attackerHoldEffect) &&
      target.mon.itemId !== null &&
      canBattlerGetOrLoseItem(target, target.mon.itemId, deps) &&
      canBattlerGetOrLoseItem(attacker, target.mon.itemId, deps)
    ) {
      const attackerHasMoldBreaker = attackerHasMoldBreakerActive(attacker, deps)
      const hasStickyHold =
        battlerHasSimAbility(state, target, 'ABILITY_STICKY_HOLD', true, attackerId, attackerHasMoldBreaker, deps.dataContext) ||
        battlerHasSimAbility(state, target, 'ABILITY_SUPERSWEET_SYRUP', true, attackerId, attackerHasMoldBreaker, deps.dataContext)
      if (
        !hasStickyHold &&
        !testSheerForceFlag(state, attackerId, moveId, statusDeps) &&
        !doesSubstituteBlockMove(state, attackerId, targetId, moveId, statusDeps, unmodelled)
      ) {
        unmodelled.push("Pickpocket's item theft (StealTargetItem, battle_script_commands.c:4848) is not modelled")
      }
    }
  }

  // 21. Power Outage (src/abilities.cc:12352-12371). Electric move with the
  // ability state still clear: SetAbilityState(TRUE) runs BEFORE the type
  // check (:12355-12357), then only if the ATTACKER is itself Electric type
  // does BattleScript_BurnUpRemoveType (data/battle_scripts_1.s:873-877,
  // `losetype BS_ATTACKER, TYPE_CURRENT_MOVE`) drop the move's type from it.
  // The flag is one-shot: the ability's onOffensiveMultiplier (:12365-12368) is
  // the damage-path half and reads the same store.
  if (abilityId === 'ABILITY_POWER_OUTAGE') {
    const slot = findAbilitySlot(attacker.mon.abilities, 'ABILITY_POWER_OUTAGE')
    if (slot !== -1 && moveTypeName() === 'ELECTRIC' && !attacker.volatiles.abilityState[slot]) {
      attacker.volatiles.abilityState[slot] = 1
      if (attacker.mon.types.includes('ELECTRIC')) {
        loseCurrentMoveType(attacker, moveTypeName())
      }
    }
  }

  return result
}

/**
 * Port of AbilityBattleEffects(ABILITYEFFECT_MOVE_END, gBattlerTarget), src/battle_util.c:4485-4489.
 * Iterates target's ability slots in reverse order (slot 3 -> 2 -> 1 -> 0).
 */
export function dispatchMoveEndDefenderAbilities(ctx: MoveEndAbilitiesContext): MoveEndAbilitiesResult {
  const { state, attackerId, targetId, moveId, moveData, targetDamage, deps, unmodelled, fainted } = ctx
  const hpDealt = ctx.hpDealt ?? targetDamage
  const isCriticalHit = ctx.isCriticalHit ?? false
  const target = state.battlers[targetId]
  const result: MoveEndAbilitiesResult = {
    attackerDamage: 0,
    statChanges: [],
    statusApplied: null,
  }
  if (!target) return result

  const statusDeps: StatusDeps = { dataContext: deps.dataContext, grounding: deps.grounding }
  const attackerHoldEffect = deps.grounding.holdEffectOf(attackerId)
  const slots = getBattlerAbilitySlotsReverse(target.mon.abilities)

  for (const { abilityId, slotIndex } of slots) {
    if (isSimAbilitySuppressed(state, target, abilityId, false, attackerId, false, deps.dataContext)) {
      continue
    }
    if (PORTED_DEFENDER_ABILITIES.has(abilityId)) {
      const abRes = handleDefenderMoveEndAbility(
        state,
        abilityId,
        slotIndex,
        targetId,
        attackerId,
        moveData,
        moveId,
        targetDamage,
        hpDealt,
        isCriticalHit,
        attackerHoldEffect,
        deps,
        statusDeps,
        unmodelled,
        fainted,
      )
      if (abRes.attackerDamage > 0) {
        result.attackerDamage += abRes.attackerDamage
      }
      if (abRes.statChanges.length > 0) {
        result.statChanges.push(...abRes.statChanges)
      }
      if (abRes.statusApplied && !result.statusApplied) {
        result.statusApplied = abRes.statusApplied
      }
    } else if (ON_DEFENDER_ABILITIES.has(abilityId)) {
      const msg = `move-end defender ability ${abilityId} is not modelled yet`
      if (!unmodelled.includes(msg)) {
        unmodelled.push(msg)
      }
    }
  }

  return result
}

/**
 * Port of AbilityBattleEffects(ABILITYEFFECT_MOVE_END_ATTACKER, gBattlerAttacker), src/battle_util.c:4491-4495.
 * Iterates attacker's ability slots in reverse order (slot 3 -> 2 -> 1 -> 0).
 */
export function dispatchMoveEndAttackerAbilities(ctx: MoveEndAbilitiesContext): MoveEndAbilitiesResult {
  const { state, attackerId, targetId, moveId, moveData, targetDamage, deps, unmodelled } = ctx
  const hpDealt = ctx.hpDealt ?? targetDamage
  const attacker = state.battlers[attackerId]
  const result: MoveEndAbilitiesResult = {
    attackerDamage: 0,
    statChanges: [],
    statusApplied: null,
  }
  if (!attacker) return result

  const statusDeps: StatusDeps = { dataContext: deps.dataContext, grounding: deps.grounding }
  const attackerHoldEffect = deps.grounding.holdEffectOf(attackerId)
  const slots = getBattlerAbilitySlotsReverse(attacker.mon.abilities)

  for (const { abilityId } of slots) {
    if (ctx.onlyFollowupAbilities && !ATTACKER_FOLLOWUP_ABILITIES.has(abilityId)) {
      continue
    }
    if (isSimAbilitySuppressed(state, attacker, abilityId, false, attackerId, false, deps.dataContext)) {
      continue
    }
    if (PORTED_ATTACKER_ABILITIES.has(abilityId)) {
      const abRes = handleAttackerMoveEndAbility(
        state,
        abilityId,
        attackerId,
        targetId,
        moveData,
        moveId,
        targetDamage,
        hpDealt,
        attackerHoldEffect,
        deps,
        statusDeps,
        unmodelled,
        ctx.isCriticalHit ?? false,
        ctx.targetHasActedThisTurn,
        ctx.noEffect,
        ctx.fainted,
      )
      if (abRes.attackerDamage > 0) {
        result.attackerDamage += abRes.attackerDamage
      }
      if (abRes.statChanges.length > 0) {
        result.statChanges.push(...abRes.statChanges)
      }
      if (abRes.statusApplied && !result.statusApplied) {
        result.statusApplied = abRes.statusApplied
      }
    } else if (ON_ATTACKER_ABILITIES.has(abilityId)) {
      const msg = `move-end attacker ability ${abilityId} is not modelled yet`
      if (!unmodelled.includes(msg)) {
        unmodelled.push(msg)
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// onBattlerFaints dispatch (VARIOUS_ON_FAINTED_BY_ATTACKER / VARIOUS_ON_FAINTED_BY_OTHER)
// ---------------------------------------------------------------------------

type FaintApplyOn = 'ATTACKER' | 'ANY' | 'OTHER' | 'ALLY' | 'FOE'

// Each ability's onBattlerFaintsFor. Quoted grep:
//   grep -oP '"ABILITY_[A-Z0-9_]+":\{"applyOn":\{[^}]*"onBattlerFaintsFor":"[^"]*"' data/v2.65beta/abilityHooks.json
// Alias values resolved against their targets in src/abilities.cc: BANDIT -> Impl<SCAVENGER> (:4454, ATTACKER),
// GHOST_FRENZY and SOUL_DEVOURER -> Impl<SOUL_EATER> (:4270, ATTACKER), QIGONG -> Impl<RAMPAGE> (:3716, ATTACKER),
// CRYOSTASIS and HEMOTOXIN -> Impl<POISON_PUPPETEER> (:7728, OTHER).
export const ON_BATTLER_FAINTS_FOR: Record<string, FaintApplyOn> = {
  ABILITY_ADRENALINE_RUSH: 'ATTACKER',
  ABILITY_APEX_PREDATOR: 'ATTACKER',
  ABILITY_AS_ONE_ICE_RIDER: 'ATTACKER',
  ABILITY_AS_ONE_SHADOW_RIDER: 'ATTACKER',
  ABILITY_BANDIT: 'ATTACKER',
  ABILITY_BATTLE_BOND: 'ATTACKER',
  ABILITY_BEAST_BOOST: 'ATTACKER',
  ABILITY_BERSERKER_RAGE: 'ATTACKER',
  ABILITY_BLOODLUST: 'ANY',
  ABILITY_BLOOD_BATH: 'OTHER',
  ABILITY_BREEZY_NEIGH: 'ATTACKER',
  ABILITY_CHILLING_NEIGH: 'ATTACKER',
  ABILITY_CHOKEHOLD: 'OTHER',
  ABILITY_COMMANDER: 'ALLY',
  ABILITY_CROWNED_KING: 'ATTACKER',
  ABILITY_CRYOSTASIS: 'OTHER',
  ABILITY_DRAGONS_RITUAL: 'ATTACKER',
  ABILITY_DRAKE_OF_RAGE: 'ATTACKER',
  ABILITY_EDGELORD: 'ATTACKER',
  ABILITY_ENERGIZED: 'ATTACKER',
  ABILITY_ENTRANCE: 'OTHER',
  ABILITY_FORSAKEN_HEART: 'ANY',
  ABILITY_FROSTBIND: 'OTHER',
  ABILITY_GHOST_FRENZY: 'ATTACKER',
  ABILITY_GOING_BERSERK: 'ATTACKER',
  ABILITY_GRIM_NEIGH: 'ATTACKER',
  ABILITY_HAUNTING_FRENZY: 'ATTACKER',
  ABILITY_HEMOTOXIN: 'OTHER',
  ABILITY_HUBRIS: 'ATTACKER',
  ABILITY_HUNGRY_MAWS: 'ATTACKER',
  ABILITY_HUNTERS_HORN: 'ATTACKER',
  ABILITY_HYDRA: 'ATTACKER',
  ABILITY_JAWS_OF_CARNAGE: 'ATTACKER',
  ABILITY_LOOTER: 'ATTACKER',
  ABILITY_MAGMA_EATER: 'ATTACKER',
  ABILITY_MASTER_HAND: 'ATTACKER',
  ABILITY_MOXIE: 'ATTACKER',
  ABILITY_NEUROTOXIN: 'OTHER',
  ABILITY_POISON_PUPPETEER: 'OTHER',
  ABILITY_POWER_OF_ALCHEMY: 'OTHER',
  ABILITY_PREDATOR: 'ATTACKER',
  ABILITY_PRETENTIOUS: 'ATTACKER',
  ABILITY_QIGONG: 'ATTACKER',
  ABILITY_RAGING_GODDESS: 'ATTACKER',
  ABILITY_RAMPAGE: 'ATTACKER',
  ABILITY_RECEIVER: 'ALLY',
  ABILITY_SCAVENGER: 'ATTACKER',
  ABILITY_SET_ABLAZE: 'OTHER',
  ABILITY_SIDEWINDER: 'ATTACKER',
  ABILITY_SOUL_DEVOURER: 'ATTACKER',
  ABILITY_SOUL_EATER: 'ATTACKER',
  ABILITY_SOUL_HEART: 'ANY',
  ABILITY_STRIKEOUT: 'FOE',
  ABILITY_SUPER_STRAIN: 'ATTACKER',
  ABILITY_WAY_OF_SWIFTNESS: 'ATTACKER',
}

/**
 * Port of IsTargettedApplyOnFlagAppropriate (src/abilities.cc:175-188) / IsApplyOnFlagAppropriate (:190-198) for the
 * onBattlerFaintsFor flags, with contextBattler = the fainted battler and target = the fainted battler.
 * `attackerId` is gBattlerAttacker for VARIOUS_ON_FAINTED_BY_ATTACKER and null (MAX_BATTLERS_COUNT) for _BY_OTHER,
 * so APPLY_ON_ATTACKER can never match there (battle_script_commands.c:7140, :7167).
 */
function faintHookApplies(flag: FaintApplyOn, holderId: number, faintedId: number, attackerId: number | null): boolean {
  switch (flag) {
    case 'ATTACKER':
      return holderId === attackerId
    case 'ANY':
      return true // APPLY_ON_ALLY | APPLY_ON_FOE_OR_SELF: every side matches (the holder is alive, the fainted battler is not)
    case 'OTHER':
      return holderId !== faintedId // APPLY_ON_ANY | APPLY_IGNORE_SELF
    case 'ALLY':
      return (holderId & 1) === (faintedId & 1) // APPLY_ON_ALLY
    case 'FOE':
      return (holderId & 1) !== (faintedId & 1) // APPLY_ON_FOE
  }
}

/** GetHighestStatId(battler, FALSE), src/battle_util.c:8724-8746: raw in-battle stats in struct order (pokemon.h:167-171). */
function getHighestStatId(mon: BattlerState['mon']): number {
  const order: [number, keyof BattlerState['mon']['rawStats']][] = [
    [STAT_ATK, 'atk'],
    [STAT_DEF, 'def'],
    [STAT_SPEED, 'spe'],
    [STAT_SPATK, 'spatk'],
    [STAT_SPDEF, 'spdef'],
  ]
  let highestId = STAT_ATK
  let highestStat = 0
  for (const [id, key] of order) {
    const value = mon.rawStats[key]
    if (value > highestStat) {
      highestStat = value
      highestId = id
    }
  }
  return highestId
}

const HIGHEST = 'HIGHEST'

// onBattlerFaints hooks whose whole body is a +1 ChangeStatBuffs(battler, 1, stat,
// MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_DONT_SET_BUFFERS, NULL) followed by BattleScript_RaiseStatOnFaintingTarget
// (data/battle_scripts_1.s:10331-10337, text only). `moxieClone` hooks route through MoxieClone (src/abilities.cc:315-320),
// which first requires HasAttackerFaintedTarget(); Soul Heart / Forsaken Heart call ChangeStatBuffs directly.
// Sources (src/abilities.cc): MOXIE :2199 ATK; CHILLING_NEIGH :3609 = Moxie; GRIM_NEIGH :3615 SPATK; HUBRIS :6751 = Grim Neigh;
// HYDRA :11290 = Hubris; ADRENALINE_RUSH :5846 SPEED; HAUNTING_FRENZY :7531 and BREEZY_NEIGH :10390 = Adrenaline Rush;
// BEAST_BOOST :3130 GetHighestStatId(battler, FALSE); AS_ONE_ICE_RIDER :3622 = Chilling Neigh; AS_ONE_SHADOW_RIDER :3637 = Grim Neigh;
// CROWNED_KING :6723-6725 = Shadow Rider | Ice Rider (SPATK then ATK); SOUL_HEART :3043 SPATK; FORSAKEN_HEART :9418 ATK.
export const KO_STAT_RAISES: Record<string, { stats: readonly (number | typeof HIGHEST)[]; moxieClone: boolean }> = {
  ABILITY_MOXIE: { stats: [STAT_ATK], moxieClone: true },
  ABILITY_CHILLING_NEIGH: { stats: [STAT_ATK], moxieClone: true },
  ABILITY_GRIM_NEIGH: { stats: [STAT_SPATK], moxieClone: true },
  ABILITY_HUBRIS: { stats: [STAT_SPATK], moxieClone: true },
  ABILITY_HYDRA: { stats: [STAT_SPATK], moxieClone: true },
  ABILITY_ADRENALINE_RUSH: { stats: [STAT_SPEED], moxieClone: true },
  ABILITY_HAUNTING_FRENZY: { stats: [STAT_SPEED], moxieClone: true },
  ABILITY_BREEZY_NEIGH: { stats: [STAT_SPEED], moxieClone: true },
  ABILITY_BEAST_BOOST: { stats: [HIGHEST], moxieClone: true },
  ABILITY_AS_ONE_ICE_RIDER: { stats: [STAT_ATK], moxieClone: true },
  ABILITY_AS_ONE_SHADOW_RIDER: { stats: [STAT_SPATK], moxieClone: true },
  ABILITY_CROWNED_KING: { stats: [STAT_SPATK, STAT_ATK], moxieClone: true },
  ABILITY_SOUL_HEART: { stats: [STAT_SPATK], moxieClone: false },
  ABILITY_FORSAKEN_HEART: { stats: [STAT_ATK], moxieClone: false },
}

// Soul Eater and its aliases (src/abilities.cc: SOUL_EATER :4263, PREDATOR :4619, LOOTER :4625, SCAVENGER :4452,
// BANDIT :12300 via Scavenger, GHOST_FRENZY :12293, SOUL_DEVOURER :9382, HUNTERS_HORN :6065, MAGMA_EATER :6096,
// APEX_PREDATOR :8670). BattleScript_HandleSoulEaterEffect heals 25% max HP (battle_scripts_1.s:11454,
// tryhealpercenthealth BS_STACK_1 25, battle_script_commands.c:7899-7901 floor 1).
export const KO_SOUL_EATER_ABILITIES = new Set([
  'ABILITY_SOUL_EATER',
  'ABILITY_PREDATOR',
  'ABILITY_LOOTER',
  'ABILITY_SCAVENGER',
  'ABILITY_BANDIT',
  'ABILITY_GHOST_FRENZY',
  'ABILITY_SOUL_DEVOURER',
  'ABILITY_HUNTERS_HORN',
  'ABILITY_MAGMA_EATER',
  'ABILITY_APEX_PREDATOR',
])

// Jaws of Carnage and its alias Hungry Maws (src/abilities.cc: JAWS_OF_CARNAGE :5556, HUNGRY_MAWS :10418).
// Heals 50% max HP if move has FLAG_STRONG_JAW_BOOST (biteBased), else 25% (BattleScript_HandleJawsOfCarnageEffect :11464).
export const KO_JAWS_OF_CARNAGE_ABILITIES = new Set([
  'ABILITY_JAWS_OF_CARNAGE',
  'ABILITY_HUNGRY_MAWS',
])

// Pretentious and its alias Way of Swiftness (src/abilities.cc: PRETENTIOUS :8116, WAY_OF_SWIFTNESS :8482).
// Increments volatiles.critBoost if < 3 (BattleScript_AbilityBoostsCrit :8121).
export const KO_CRIT_BOOST_ABILITIES = new Set([
  'ABILITY_PRETENTIOUS',
  'ABILITY_WAY_OF_SWIFTNESS',
])

export interface FaintDispatchContext {
  state: BattleState
  faintedId: number
  attackerId: number
  targetId: number
  /** VARIOUS_ON_FAINTED_BY_ATTACKER (the target fainted to the attacker's move) vs VARIOUS_ON_FAINTED_BY_OTHER. */
  byAttacker: boolean
  moveId: string
  moveData: SimMoveData | undefined
  targetDamage: number
  deps: TurnLoopDeps
  unmodelled: string[]
}

/**
 * HasAttackerFaintedTarget, src/battle_script_commands.c:6394-6402. gLastHitBy / GetTurnBattler / the chosen-move
 * comparison are always satisfied for the move the sim is resolving (the attacker is acting and chose this move), so
 * they reduce to: a damaging move that did something, attacker != target.
 */
function hasAttackerFaintedTarget(ctx: FaintDispatchContext): boolean {
  return (ctx.moveData?.power ?? 0) !== 0 && ctx.targetDamage > 0 && ctx.attackerId !== ctx.targetId
}

/**
 * Port of VARIOUS_ON_FAINTED_BY_ATTACKER / VARIOUS_ON_FAINTED_BY_OTHER, src/battle_script_commands.c:7132-7148 and
 * :7159-7175, run from BattleScript_FaintTarget (data/battle_scripts_1.s:6897-6915, onfaintedbyattacker) and
 * BattleScript_FaintAttacker (:6892, onfaintedbyother), i.e. after seteffectwithchance / tryfaintmon and before moveend
 * for the target.
 *
 * REQUIRE_NOT(NoAliveMonsForEitherParty()), then every ALIVE battler i in index order, its ability slots in reverse
 * (ON_ABILITY, include/battle_util.h:269, checkMoldBreaker FALSE), for abilities with an onBattlerFaints hook whose
 * onBattlerFaintsFor matches (faintHookApplies). Returns the stat changes made.
 */
export function dispatchOnBattlerFaints(ctx: FaintDispatchContext): StatChangeOutcome[] {
  const { state, faintedId, attackerId, targetId, byAttacker, moveId, deps, unmodelled } = ctx
  const statChanges: StatChangeOutcome[] = []
  if (state.battleOutcome) return statChanges

  // VARIOUS_TRY_ACTIVATE_FELL_STINGER (battle_script_commands.c:7176-7189), `tryactivatefellstinger BS_ATTACKER` ahead of
  // onfaintedbyattacker in BattleScript_FaintTarget (data/battle_scripts_1.s:6911-6912): a Fell Stinger KO raises the user's Attack by
  // THREE stages (B_FELL_STINGER_STAT_RAISE >= GEN_7) unless it is already maxed. The NoAliveMonsForEitherParty break is the
  // battleOutcome return above. The same case runs MISC_EFFECT_TRANSMUTE's BattleScript_TryRecycle (:7185-7187, s:6356-6360), i.e.
  // Cmd_tryrecycleitem (:12296-12311): REQUIRE(IsBattlerAlive) and HasAttackerFaintedTarget gate it just as they gate Fell Stinger.
  // (Transmute's type change is not in this tree's scripts or commands: grep finds MISC_EFFECT_TRANSMUTE only at :7185.)
  if (
    byAttacker &&
    ctx.moveData?.effect === 'EFFECT_MISC_HIT' &&
    ctx.moveData.argument?.kind === 'misc' &&
    ctx.moveData.argument.misc === 'MISC_EFFECT_TRANSMUTE' &&
    hasAttackerFaintedTarget(ctx) &&
    isBattlerAlive(state, attackerId)
  ) {
    const recycler = state.battlers[attackerId]
    const used = recycler?.usedHeldItem
    if (recycler && used && used !== 'ITEM_NONE' && !recycler.mon.itemId) {
      recycler.mon.itemId = used
      recycler.usedHeldItem = null
      const slotU = findAbilitySlot(recycler.mon.abilities, 'ABILITY_UNBURDEN')
      if (slotU !== -1) recycler.volatiles.abilityState[slotU] = 0
      const slotS = findAbilitySlot(recycler.mon.abilities, 'ABILITY_SUGAR_RUSH')
      if (slotS !== -1) recycler.volatiles.abilityState[slotS] = 0
    }
  }
  if (byAttacker && ctx.moveData?.effect === 'EFFECT_FELL_STINGER' && hasAttackerFaintedTarget(ctx)) {
    const stinger = state.battlers[attackerId]
    if (stinger && isBattlerAlive(state, attackerId) && (stinger.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE) < MAX_STAT_STAGE) {
      const res = changeStatBuffsImplicit(
        state,
        attackerId,
        targetId,
        3,
        STAT_ATK,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
        true,
        { dataContext: deps.dataContext, grounding: deps.grounding },
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) statChanges.push({ battlerId: attackerId, stat: STAT_ATK, change: res.delta })
    }
  }

  for (let i = 0; i < state.battlersCount; i++) {
    const holder = state.battlers[i]
    if (!holder || !isBattlerAlive(state, i)) continue

    for (const { abilityId } of getBattlerAbilitySlotsReverse(holder.mon.abilities)) {
      const flag = ON_BATTLER_FAINTS_FOR[abilityId]
      if (!flag || !faintHookApplies(flag, i, faintedId, byAttacker ? attackerId : null)) continue
      if (isSimAbilitySuppressed(state, holder, abilityId, false, attackerId, false, deps.dataContext)) continue

      if (abilityId === 'ABILITY_STRIKEOUT') {
        // Impl<ABILITY_STRIKEOUT>.onBattlerFaints (src/abilities.cc:11157): StrikeoutClearFlags(battler, ability, fainted)
        strikeoutClearFlags(holder, abilityId, faintedId)
        continue
      }

      // Impl<ABILITY_POISON_PUPPETEER>.onBattlerFaints (src/abilities.cc:7722-7726, shared with
      // CHOKEHOLD / ENTRANCE / NEUROTOXIN / BLOOD_BATH / CRYOSTASIS / FROSTBIND / HEMOTOXIN / SET_ABLAZE):
      //   int state = GetAbilityState(battler, ability);
      //   if (state & (1 << fainted)) SetAbilityState(battler, ability, state ^ (1 << fainted));
      // i.e. clear only the fainted battler's armed bit, leaving the other targets' bits alone.
      if ((SET_STATE_ON_EFFECT_ABILITIES as readonly string[]).includes(abilityId)) {
        const slot = findAbilitySlot(holder.mon.abilities, abilityId)
        if (slot !== -1) {
          const armed = holder.volatiles.abilityState[slot] ?? 0
          if (armed & (1 << faintedId)) holder.volatiles.abilityState[slot] = armed ^ (1 << faintedId)
        }
        continue
      }

      const raise = KO_STAT_RAISES[abilityId]
      if (raise) {
        if (raise.moxieClone && !hasAttackerFaintedTarget(ctx)) continue

        for (const stat of raise.stats) {
          const statId = stat === HIGHEST ? getHighestStatId(holder.mon) : stat
          const res = changeStatBuffs(
            state,
            i,
            attackerId,
            targetId,
            1,
            statId,
            MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_DONT_SET_BUFFERS,
            false,
            { dataContext: deps.dataContext, grounding: deps.grounding },
            unmodelled,
            moveId,
          )
          if (res.delta !== 0) statChanges.push({ battlerId: i, stat: statId, change: res.delta })
        }
        continue
      }

      if (KO_SOUL_EATER_ABILITIES.has(abilityId)) {
        if (holder.mon.hp < holder.mon.maxHp && canBattlerHeal(state, i, holder, unmodelled)) {
          const heal = Math.max(1, Math.trunc((holder.mon.maxHp * 25) / 100))
          holder.mon.hp = Math.min(holder.mon.maxHp, holder.mon.hp + heal)
          syncPartyHp(state, i)
        }
        continue
      }

      if (KO_JAWS_OF_CARNAGE_ABILITIES.has(abilityId)) {
        if (holder.mon.hp < holder.mon.maxHp && canBattlerHeal(state, i, holder, unmodelled)) {
          const isBite = Boolean(ctx.moveData?.flags.biteBased)
          const percent = isBite ? 50 : 25
          const heal = Math.max(1, Math.trunc((holder.mon.maxHp * percent) / 100))
          holder.mon.hp = Math.min(holder.mon.maxHp, holder.mon.hp + heal)
          syncPartyHp(state, i)
        }
        continue
      }

      if (KO_CRIT_BOOST_ABILITIES.has(abilityId)) {
        if (holder.volatiles.critBoost < 3) {
          holder.volatiles.critBoost++
        }
        continue
      }

      const msg = `on-faint ability ${abilityId} is not modelled yet`
      if (!unmodelled.includes(msg)) unmodelled.push(msg)
    }
  }
  return statChanges
}

// ---------------------------------------------------------------------------
// MOVE_EFFECT_KNOCK_OFF (MOVEEND_MOVE_EFFECTS2_ON_EACH)
// ---------------------------------------------------------------------------

/** CanBattlerGetOrLoseItem, src/battle_util.c:8250-8273. GET_BASE_SPECIES_ID is approximated by the species id prefix
 * (the same approximation ai/aiCheckBadMove.ts uses); HOLD_EFFECT_Z_CRYSTAL is behind an #ifdef that is not defined. */
function canBattlerGetOrLoseItem(battler: BattlerState, itemId: string, deps: TurnLoopDeps): boolean {
  if (itemId === 'ITEM_ENIGMA_BERRY') return false
  const holdEffect = deps.dataContext.item(itemId)?.resolvedHoldEffect ?? null
  if (holdEffect === 'HOLD_EFFECT_PRIMAL_ORB' || holdEffect === 'HOLD_EFFECT_MEGA_STONE') return false
  const species = battler.mon.speciesId
  if (species.startsWith('SPECIES_GENESECT') && holdEffect === 'HOLD_EFFECT_DRIVE') return false
  if (species.startsWith('SPECIES_SILVALLY') && holdEffect === 'HOLD_EFFECT_MEMORY') return false
  if (species.startsWith('SPECIES_ARCEUS') && holdEffect === 'HOLD_EFFECT_PLATE') return false
  return true
}

/**
 * Port of TryKnockOffBattleScript, src/battle_script_commands.c:4268-4288, reached from MOVEEND_MOVE_EFFECTS2_ON_EACH
 * (:4573-4594) when seteffectwithchance stored MOVE_EFFECT_KNOCK_OFF in moveEffect2.
 * `targetDamaged` is TARGET_TURN_DAMAGED (battle.h:750): HP actually removed from the target, which a Substitute that
 * absorbed the hit leaves at zero (Cmd_datahpupdate :1877-1892 never reaches the physicalDmg/specialDmg writes).
 */
function applyKnockOff(
  state: BattleState,
  attackerId: number,
  targetId: number,
  targetDamaged: boolean,
  deps: TurnLoopDeps,
  unmodelled: string[],
): void {
  const target = state.battlers[targetId]
  const attacker = state.battlers[attackerId]
  if (!target || !attacker || !target.mon.itemId) return
  const itemId = target.mon.itemId
  if (!canBattlerGetOrLoseItem(target, itemId, deps)) return
  // ShouldApplyOnHitEffect(battlerDef): DidMoveHit() && IsBattlerAlive(battlerDef)
  if (!targetDamaged || !isBattlerAlive(state, targetId)) return
  // NoAliveMonsForEitherParty()
  if (state.battleOutcome) return

  // IsStickyHold, battle_util.c:9329-9333: BattlerHasAbility(battler, X, TRUE) -- Mold Breaker can bypass it.
  const attackerHasMoldBreaker = attackerHasMoldBreakerActive(attacker, deps)
  if (
    battlerHasSimAbility(state, target, 'ABILITY_STICKY_HOLD', true, attackerId, attackerHasMoldBreaker, deps.dataContext) ||
    battlerHasSimAbility(state, target, 'ABILITY_SUPERSWEET_SYRUP', true, attackerId, attackerHasMoldBreaker, deps.dataContext)
  ) {
    return
  }

  clearBattlerItem(state, target, unmodelled)
}

/**
 * UpdateBattlerItem(battler, ITEM_NONE), battle_script_commands.c:2194-2221. The ability-state side effects
 * (:2198-2212) have no state to write to here; gap them when a holder of the ability is actually present.
 */
function clearBattlerItem(state: BattleState, battler: BattlerState, unmodelled: string[]): void {
  const itemId = battler.mon.itemId
  const slotU = findAbilitySlot(battler.mon.abilities, 'ABILITY_UNBURDEN')
  if (slotU !== -1) battler.volatiles.abilityState[slotU] = 1
  const slotS = findAbilitySlot(battler.mon.abilities, 'ABILITY_SUGAR_RUSH')
  if (slotS !== -1) battler.volatiles.abilityState[slotS] = 1

  const hasAbility = (b: BattlerState, id: string) => battlerHasAbility(b.mon.abilities, id, () => false)
  if (hasAbility(battler, 'ABILITY_GREEDY')) {
    unmodelled.push("UpdateBattlerItem's Greedy ability state (battle_script_commands.c:2209-2212) is not modelled")
  }
  if (itemId !== 'ITEM_BIG_NUGGET' && state.battlers.some((b) => b && hasAbility(b, 'ABILITY_POWER_OF_ALCHEMY'))) {
    unmodelled.push("UpdateBattlerItem's Power of Alchemy item memory (battle_script_commands.c:2206-2207) is not modelled")
  }
  battler.mon.itemId = null
}

/**
 * MOVE_EFFECT_STEAL_ITEM, battle_script_commands.c:4579-4593 (Thief, Covet). Only reads the attacker's and target's
 * items: no ShouldApplyOnHitEffect / alive check and no IsStickyHold check, so Thief takes the item of a mon it just
 * knocked out and ignores Sticky Hold. An attacker that already holds an item FALLTHROUGHs into TryKnockOffBattleScript
 * (which does check both). `changedItems` is gBattleStruct->changedItems: MOVEEND_CHANGED_ITEMS hands the item over.
 */
function applyStealItem(
  state: BattleState,
  attackerId: number,
  targetId: number,
  targetDamaged: boolean,
  deps: TurnLoopDeps,
  unmodelled: string[],
  changedItems: Map<number, string>,
): void {
  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  if (!attacker || !target) return
  if (attacker.mon.itemId) {
    applyKnockOff(state, attackerId, targetId, targetDamaged, deps, unmodelled)
    return
  }
  // CanStealItem, battle_util.c:8500-8510 (the stealer-holds-nothing clause is the branch above).
  const itemId = target.mon.itemId
  if (!itemId || !canBattlerGetOrLoseItem(target, itemId, deps) || !canBattlerGetOrLoseItem(attacker, itemId, deps)) return

  // StealTargetItem, battle_script_commands.c:2224-2229: UpdateBattlerItem(target, NONE), then UpdateBattlerItem(attacker, item).
  clearBattlerItem(state, target, unmodelled)
  const slotU = findAbilitySlot(attacker.mon.abilities, 'ABILITY_UNBURDEN')
  if (slotU !== -1) attacker.volatiles.abilityState[slotU] = 0
  const slotS = findAbilitySlot(attacker.mon.abilities, 'ABILITY_SUGAR_RUSH')
  if (slotS !== -1) attacker.volatiles.abilityState[slotS] = 0
  // gBattleMons[attacker].item = 0 until MOVEEND_CHANGED_ITEMS (:4585-4586).
  changedItems.set(attackerId, itemId)
}

/**
 * MOVE_EFFECT_BUG_BITE via EatTargetBerry, battle_script_commands.c:13221-13234 (Bug Bite, Pluck). No alive /
 * DidMoveHit / CanBattlerGetOrLoseItem check; only IsStickyHold. The target loses the berry; BattleScript_MoveEffectBugBite
 * (data/battle_scripts_1.s:1006-1014) then runs `consumeberry BS_ATTACKER, TRUE` (VARIOUS_CONSUME_BERRY,
 * battle_script_commands.c:8024-8041), which fires the berry's ITEMEFFECT_BATTLER_MOVE_END effect on the attacker and
 * restores the attacker's own item from changedItems. The restore leaves the attacker's item unchanged, which is all
 * that is modelled; the berry's effect is gapped by name.
 */
function applyBugBite(
  state: BattleState,
  attackerId: number,
  targetId: number,
  deps: TurnLoopDeps,
  unmodelled: string[],
): void {
  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  if (!attacker || !target || !target.mon.itemId) return
  const itemId = target.mon.itemId
  if (deps.dataContext.item(itemId)?.grouping !== 'POCKET_BERRIES') return
  const attackerHasMoldBreaker = attackerHasMoldBreakerActive(attacker, deps)
  if (
    battlerHasSimAbility(state, target, 'ABILITY_STICKY_HOLD', true, attackerId, attackerHasMoldBreaker, deps.dataContext) ||
    battlerHasSimAbility(state, target, 'ABILITY_SUPERSWEET_SYRUP', true, attackerId, attackerHasMoldBreaker, deps.dataContext)
  ) {
    return
  }
  clearBattlerItem(state, target, unmodelled)
  unmodelled.push(
    `Bug Bite's consumeberry of ${itemId} on the attacker (VARIOUS_CONSUME_BERRY, battle_script_commands.c:8024-8041, ItemBattleEffects(ITEMEFFECT_BATTLER_MOVE_END)) is not modelled; only the target's berry loss is`,
  )
}

/** MOVE_EFFECT_SMACK_DOWN, battle_script_commands.c:4598-4606. */
function applySmackDown(state: BattleState, attackerId: number, targetId: number, deps: TurnLoopDeps): void {
  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  if (!attacker || !target || !isBattlerAlive(state, targetId)) return
  // IsBattlerGrounded reads Levitate with checkMoldBreaker TRUE (battle_util.c:6669) against gBattlerAttacker.
  const grounding = { ...deps.grounding, attackerHasMoldBreaker: attackerHasMoldBreakerActive(attacker, deps) }
  if (isBattlerGrounded(state, targetId, grounding)) return
  target.statuses3 = clearFlag(setFlag(target.statuses3, STATUS3_SMACKED_DOWN), STATUS3_MAGNET_RISE | STATUS3_TELEKINESIS | STATUS3_ON_AIR)
}

/**
 * MOVEEND_KINGSROCK's HOLD_EFFECT_FLINCH branch, ItemBattleEffects(ITEMEFFECT_KINGSROCK), battle_util.c:6034-6052.
 * `&&` order matters for the RNG: Random() is only drawn once the damage, NO_EFFECT and TARGET_TURN_DAMAGED terms pass,
 * and it is drawn before the FLAG_KINGS_ROCK_AFFECTED and target-alive terms. gBattleMoveDamage != 0 is read as the hit's
 * targetDamage. There is no attacker-alive check.
 */
function applyKingsRock(
  state: BattleState,
  attackerId: number,
  targetId: number,
  moveId: string,
  moveData: SimMoveData | undefined,
  targetDamage: number,
  targetDamaged: boolean,
  deps: TurnLoopDeps,
  unmodelled: string[],
): void {
  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  if (!attacker || !target) return
  const statusDeps: StatusDeps = { dataContext: deps.dataContext, grounding: deps.grounding }

  // GetBattlerHoldEffectParam, then B_SERENE_GRACE_BOOST >= GEN_5 (battle_config.h:115, GEN_7) doubling.
  let param = (attacker.mon.itemId ? deps.dataContext.item(attacker.mon.itemId)?.holdEffectStrength : null) ?? 0
  if (battlerHasSimAbility(state, attacker, 'ABILITY_SERENE_GRACE', false, attackerId, false, deps.dataContext)) {
    param = Math.min(100, param * 2)
  }
  if (state.sides[attackerId & 1]?.timers?.rainbowTimer) {
    param = Math.min(100, param * 2)
  }

  if (targetDamage === 0 || !targetDamaged) return
  if (state.rng.random16() % 100 >= param) return

  // The C fires this once per hit of a multi-strike move; the sim resolves the move once.
  if (resolveMultihitType(attacker, moveId, moveData, deps.grounding.holdEffectOf(attackerId), []) !== null) {
    unmodelled.push("ITEMEFFECT_KINGSROCK fires once per hit of a multi-strike move (battle_util.c:6033); the sim rolls it once for the whole move")
  }
  if (!isKingsRockAffected(moveData, deps) || target.mon.hp === 0) return

  // SetMoveEffect(FALSE, 0) with MOVE_EFFECT_FLINCH, battle_script_commands.c:2336-2392 and :2665-2669. The Safeguard
  // gate (:2352) is `moveEffect <= MOVE_EFFECT_CONFUSION`, which flinch is not.
  const attackerHasMoldBreaker = attackerHasMoldBreakerActive(attacker, deps)
  const hasShieldDust = battlerHasSimAbility(state, target, 'ABILITY_SHIELD_DUST', true, attackerId, attackerHasMoldBreaker, deps.dataContext)
  if ((hasShieldDust || deps.grounding.holdEffectOf(targetId) === 'HOLD_EFFECT_COVERT_CLOAK') && isPreventableSecondaryEffect(MOVE_EFFECT_FLINCH)) return
  if (testSheerForceFlag(state, attackerId, moveId, statusDeps)) return
  if (doesSubstituteBlockMove(state, attackerId, targetId, moveId, statusDeps, unmodelled)) return
  if (!isAbilityStatusProtected(state, targetId, CHECK_FLINCH, attackerId, statusDeps)) {
    target.mon.status2 = setFlag(target.mon.status2, STATUS2_FLINCHED)
  }
}

/**
 * FLAG_KINGS_ROCK_AFFECTED, tools/codegen/src/er/move/BattleMovesGenerator.kt:80-88: not a status move, not a flinching
 * move (the effect's `flinch_effect`, or MOVE_EFFECT_FLINCH as the argument effect, with a nonzero effectChance), and the
 * effect has no `no_kings_rock` option. The move's own `no_kings_rock` flag has no flag_code_value and is not read.
 * `customBehavior.causesFlinch` stands in for `move.customBehavior.causesFlinch`.
 */
function isKingsRockAffected(moveData: SimMoveData | undefined, deps: TurnLoopDeps): boolean {
  if (!moveData || moveData.split === 'STATUS') return false
  const options = moveData.effect ? deps.moveBehaviors?.[moveData.effect]?.options : undefined
  if ((moveData.effectChance ?? 0) > 0) {
    if (options?.flinchEffect) return false
    if (moveData.argument?.kind === 'effect' && moveData.argument.effect === 'MOVE_EFFECT_FLINCH') return false
  }
  if (options?.noKingsRock) return false
  if (moveData.customBehavior?.causesFlinch) return false
  return true
}

// ---------------------------------------------------------------------------
// MoveEnd Ladder
// ---------------------------------------------------------------------------

export interface MoveEndBookkeepingContext {
  state: BattleState
  attackerId: number
  targetId: number | null
  currentMoveId: string
  chosenMoveId: string
  deps: { dataContext: TurnLoopDeps['dataContext'] }
  noEffect: boolean
  /** (gMoveResultFlags & (MOVE_RESULT_FAILED | MOVE_RESULT_DOESNT_AFFECT_FOE)), battle_script_commands.c:4724. A plain
   * miss (MOVE_RESULT_MISSED) or a Protect block is NOT this. */
  moveFailed?: boolean
  obeys?: boolean
  fainted?: number[]
  /** Run Case 30 (MOVEEND_CLEAR_BITS) here. runMoveEnd passes false: it runs Case 30 itself, after cases 19-29 that read these bits. Default true (paths that skip the rest of the ladder). */
  clearBits?: boolean
}

/**
 * Factored move-end bookkeeping implementing:
 * - Case 17: MOVEEND_UPDATE_LAST_MOVES (src/battle_script_commands.c:4723-4772)
 * - Case 18: MOVEEND_MIRROR_MOVE (src/battle_script_commands.c:4773-4781)
 * - Case 30: MOVEEND_CLEAR_BITS (src/battle_script_commands.c:4934-4957)
 *
 * In the C engine, every move ends with `goto BattleScript_MoveEnd` (or `moveendall`),
 * running these cases for hits, misses, status moves, protected/absorbed hits, etc.
 *
 * Conditions from C:
 * - `HITMARKER_OBEYS` (:4748, 4760, 4775): set in Cmd_attackcanceler (:1146). In the sim,
 *   all moves reaching this function passed attack cancellers and obeyed (obeys = true).
 * - `MOVE_RESULT_NO_EFFECT` (:4760, 4776, 4938): defined as (MOVE_RESULT_MISSED |
 *   MOVE_RESULT_DOESNT_AFFECT_FOE | MOVE_RESULT_FAILED) in include/constants/battle.h:389.
 *   Derived as true on misses, failures, protect blocks, type immunities, or absorbing abilities.
 * - `gProcessingExtraAttacks` (:4738, 4749, 4943): extra attacks skip usedMoves, lastPrintedMove,
 *   lastUsedMove, lastMove, lastResultingMove, and rolloutCounter reset.
 * - `!(gHitMarker & HITMARKER_FAINTED(gBattlerTarget))` (:4758, 4776): target must be alive
 *   and not fainted this action to record lastHitBy and Mirror Move.
 * - `!(gAbsentBattlerFlags & gBitTable[attacker]) && !(field_91 & gBitTable[attacker])` (:4746, 4774).
 * - `originallyUsedMove` (:4318-4321): if gChosenMove == 0xFFFF, originallyUsedMove = 0 (MOVE_NONE).
 *   Checked for EFFECT_BATON_PASS / EFFECT_HEALING_WISH (:4747) and FLAG_MIRROR_MOVE_AFFECTED (:4775).
 */
export function runMoveEndBookkeeping(ctx: MoveEndBookkeepingContext): void {
  const {
    state,
    attackerId,
    targetId,
    currentMoveId,
    chosenMoveId,
    deps,
    noEffect,
    moveFailed = false,
    obeys = true,
    fainted = [],
  } = ctx

  const attacker = state.battlers[attackerId]
  const target = targetId !== null ? state.battlers[targetId] : null
  const currentMoveData = deps.dataContext.move(currentMoveId)

  // originallyUsedMove (src/battle_script_commands.c:4318-4321):
  // if (gChosenMove == 0xFFFF) originallyUsedMove = 0; else originallyUsedMove = gChosenMove;
  const originallyUsedMove = chosenMoveId === MOVE_UNSET || !chosenMoveId ? null : chosenMoveId
  const origMoveData = originallyUsedMove ? deps.dataContext.move(originallyUsedMove) : null

  // 1. Case 17: MOVEEND_UPDATE_LAST_MOVES (battle_script_commands.c:4723-4772)
  if (attacker) {
    if (
      moveFailed ||
      (currentMoveData?.effect === 'EFFECT_FOCUS_PUNCH' &&
        (attacker.round.physicalDmg > 0 || attacker.round.specialDmg > 0))
    ) {
      state.lastMoveFailed = setFlag(state.lastMoveFailed, 1 << attackerId)
    } else {
      state.lastMoveFailed = clearFlag(state.lastMoveFailed, 1 << attackerId)
    }
  }

  if (!state.processingExtraAttacks) {
    if (attacker) {
      const movePos =
        chosenMoveId !== MOVE_UNSET && chosenMoveId
          ? attacker.mon.moves.indexOf(chosenMoveId)
          : -1
      if (movePos >= 0 && movePos < 4) {
        attacker.volatiles.usedMoves |= 1 << movePos
      }
      attacker.lastPrintedMove = chosenMoveId
    }
    state.lastUsedMove = currentMoveId
  }

  const isBatonPassOrHealingWish =
    origMoveData?.effect === 'EFFECT_BATON_PASS' || origMoveData?.effect === 'EFFECT_HEALING_WISH'

  const attackerAbsent =
    hasFlag(state.absentBattlerFlags, 1 << attackerId) ||
    hasFlag(state.field_91 ?? 0, 1 << attackerId)

  if (attacker && !attackerAbsent && !isBatonPassOrHealingWish) {
    if (obeys) {
      if (!state.processingExtraAttacks) {
        attacker.lastMove = chosenMoveId
        attacker.lastResultingMove = currentMoveId
      }
    } else {
      attacker.lastMove = MOVE_UNSET
      attacker.lastResultingMove = MOVE_UNSET
    }

    const targetFainted =
      targetId === null ||
      !target ||
      !isBattlerAlive(state, targetId) ||
      fainted.includes(targetId) ||
      target.mon.hp <= 0

    if (target && !targetFainted) {
      target.lastHitBy = attackerId
    }

    if (target) {
      if (obeys && !noEffect) {
        if (chosenMoveId === MOVE_UNSET) {
          target.lastLandedMove = MOVE_UNSET
        } else {
          target.lastLandedMove = currentMoveId
          const moveType = (currentMoveData?.type ?? 'TYPE_NORMAL').replace(/^TYPE_/, '')
          target.lastHitByType = moveType
        }
      } else {
        target.lastLandedMove = MOVE_UNSET
      }
    }
  }

  // 2. Case 18: MOVEEND_MIRROR_MOVE (battle_script_commands.c:4773-4781)
  const targetFaintedForMirror =
    targetId === null ||
    !target ||
    !isBattlerAlive(state, targetId) ||
    fainted.includes(targetId) ||
    target.mon.hp <= 0

  if (
    attacker &&
    target &&
    attackerId !== targetId &&
    !attackerAbsent &&
    origMoveData?.flags?.mirrorMoveAffected === true &&
    obeys &&
    !targetFaintedForMirror &&
    !noEffect
  ) {
    state.lastTakenMove[targetId] = chosenMoveId
    state.lastTakenMoveFrom[targetId][attackerId] = chosenMoveId
  }

  // 3. Case 30: MOVEEND_CLEAR_BITS (battle_script_commands.c:4934-4957)
  if (ctx.clearBits ?? true) {
    applyMoveEndClearBits(state, attackerId, targetId, currentMoveId, deps, noEffect)
  }
}

/** Case 30: MOVEEND_CLEAR_BITS (src/battle_script_commands.c:4934-4957). */
export function applyMoveEndClearBits(
  state: BattleState,
  attackerId: number,
  targetId: number | null,
  currentMoveId: string,
  deps: { dataContext: TurnLoopDeps['dataContext'] },
  noEffect = false,
): void {
  const attacker = state.battlers[attackerId]
  const target = targetId !== null ? state.battlers[targetId] : null
  const currentMoveData = deps.dataContext.move(currentMoveId)
  // B_RAMPAGE_CANCELLING >= GEN_5 (:4936-4942): an unusable rampage move that does not end this turn cancels the lock.
  if (
    attacker &&
    currentMoveData?.effect === 'EFFECT_RAMPAGE' &&
    noEffect &&
    getCounter(attacker.mon.status2, STATUS2_LOCK_CONFUSE) !== 1
  ) {
    cancelMultiTurnMoves(attacker)
  }
  if (attacker) {
    if (!state.processingExtraAttacks && currentMoveData?.effect !== 'EFFECT_ROLLOUT') {
      attacker.volatiles.rolloutCounter = 0
    }
    attacker.round.usesBouncedMove = false
    attacker.round.targetAffected = false
    attacker.turn.gemBoost = false
    attacker.statuses3 = clearFlag(attacker.statuses3, STATUS3_ME_FIRST)
  }
  if (target) {
    target.turn.berryReduced = false
  }
}

export interface MoveEndContext {
  state: BattleState
  attackerId: number
  targetId: number
  moveId: string
  targetDamage: number
  /** gTurnStructs[attacker].savedDmg -- the HP actually removed from the target (gHpDealt, :4335). */
  hpDealt: number
  isCriticalHit?: boolean
  isSuperEffective?: boolean
  /** gBattleStruct->moveEffect2, set by seteffectwithchance (moveEffects.ts applySecondaryMoveEffects). */
  moveEffect2?: string | null
  deps: TurnLoopDeps
  unmodelled: string[]
  fainted: number[]
  /** gChosenMove (:4321) -- defaults to moveId when not a called move. */
  chosenMoveId?: string
  /** turn.ts's targetHasActedThisTurn, forwarded to the attacker-ability dispatch (From the Shadows). */
  targetHasActedThisTurn?: boolean
  /** MOVE_RESULT_NO_EFFECT (include/constants/battle.h:389) */
  noEffect?: boolean
  /**
   * Which half of the ladder to walk. MOVEEND_MULTIHIT_MOVE (case 19, :4880-4921) sits in the middle of it: for every hit but
   * the last it resets `moveendState` to 0 and re-runs the move's script, so cases 0-18 run once per hit and cases 20-30 once,
   * after the last. 'FIRST' is cases 0-18 (plus the faint hook and ABILITYEFFECT_REACTIVE that bracket them), 'SECOND' is cases
   * 19-30, 'FULL' (the default, every single-hit move) is both in one call.
   */
  part?: 'FULL' | 'FIRST' | 'SECOND'
}

/**
 * HasRipenEffect, battle_util.c:5162-5165.
 */
function hasRipenEffect(state: BattleState, battlerId: number, deps: { dataContext: SimDataContext }): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  return (
    battlerHasSimAbility(state, battler, 'ABILITY_RIPEN', false, battlerId, false, deps.dataContext) ||
    battlerHasSimAbility(state, battler, 'ABILITY_SUGAR_RUSH', false, battlerId, false, deps.dataContext) ||
    battlerHasSimAbility(state, battler, 'ABILITY_APPLE_PIE', false, battlerId, false, deps.dataContext)
  )
}

/**
 * ItemBattleEffects(ITEMEFFECT_MOVE_END, 0, FALSE), battle_util.c:5874-6033.
 * Iterates all battlers for post-move items: White Herb, Lum/status berries, Sitrus, Oran, pinch berries.
 */
export function applyMoveEndItemEffectsAll(
  state: BattleState,
  deps: TurnLoopDeps,
  unmodelled: string[],
): { statChanges: StatChangeOutcome[] } {
  const statChanges: StatChangeOutcome[] = []
  for (let bId = 0; bId < state.battlersCount; bId++) {
    const battler = state.battlers[bId]
    if (!battler || battler.mon.hp === 0) continue
    const holdEffect = deps.grounding.holdEffectOf(bId)
    if (!holdEffect) continue
    const itemData = battler.mon.itemId ? deps.dataContext.item(battler.mon.itemId) : null

    // White Herb, battle_util.c:6007-6021
    if (holdEffect === 'HOLD_EFFECT_RESTORE_STATS') {
      if (!isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext)) {
        let restored = false
        for (let s = 0; s < 7; s++) {
          if (battler.mon.statStages[s] < DEFAULT_STAT_STAGE) {
            const diff = DEFAULT_STAT_STAGE - battler.mon.statStages[s]
            battler.mon.statStages[s] = DEFAULT_STAT_STAGE
            statChanges.push({ battlerId: bId, stat: s, change: diff })
            restored = true
          }
        }
        if (restored) {
          battler.mon.itemId = null
        }
      }
      continue
    }

    // Lum Berry / Status-curing items, battle_util.c:5925-6005
    if (holdEffect === 'HOLD_EFFECT_CURE_STATUS') {
      if (
        (battler.mon.status1 !== 0 || hasFlag(battler.mon.status2, STATUS2_CONFUSION)) &&
        !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext)
      ) {
        battler.mon.status1 = 0
        battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_CONFUSION | STATUS2_NIGHTMARE)
        battler.mon.itemId = null
      }
      continue
    }
    if (holdEffect === 'HOLD_EFFECT_CURE_PAR' && hasFlag(battler.mon.status1, STATUS1_PARALYSIS) && !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext)) {
      battler.mon.status1 = clearFlag(battler.mon.status1, STATUS1_PARALYSIS)
      battler.mon.itemId = null
      continue
    }
    if (holdEffect === 'HOLD_EFFECT_CURE_PSN' && hasFlag(battler.mon.status1, STATUS1_POISON_ANY) && !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext)) {
      battler.mon.status1 = clearFlag(battler.mon.status1, STATUS1_POISON_ANY)
      battler.mon.itemId = null
      continue
    }
    if (holdEffect === 'HOLD_EFFECT_CURE_BRN' && hasFlag(battler.mon.status1, STATUS1_BURN) && !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext)) {
      battler.mon.status1 = clearFlag(battler.mon.status1, STATUS1_BURN)
      battler.mon.itemId = null
      continue
    }
    if (holdEffect === 'HOLD_EFFECT_CURE_FRZ' && (hasFlag(battler.mon.status1, STATUS1_FREEZE) || hasFlag(battler.mon.status1, STATUS1_FROSTBITE)) && !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext)) {
      battler.mon.status1 = clearFlag(battler.mon.status1, STATUS1_FREEZE | STATUS1_FROSTBITE)
      battler.mon.itemId = null
      continue
    }
    if (holdEffect === 'HOLD_EFFECT_CURE_SLP' && hasFlag(battler.mon.status1, STATUS1_SLEEP) && !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext)) {
      battler.mon.status1 = 0
      battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_NIGHTMARE)
      battler.mon.itemId = null
      continue
    }
    if (holdEffect === 'HOLD_EFFECT_CURE_CONFUSION' && hasFlag(battler.mon.status2, STATUS2_CONFUSION) && !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext)) {
      battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_CONFUSION)
      battler.mon.itemId = null
      continue
    }

    // Sitrus Berry, battle_util.c:5889-5891, 5311-5333
    if (holdEffect === 'HOLD_EFFECT_RESTORE_PCT_HP') {
      if (
        battler.mon.hp <= Math.floor(battler.mon.maxHp / 2) &&
        !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext) &&
        canBattlerHeal(state, bId, battler, unmodelled)
      ) {
        const pct = itemData?.holdEffectStrength ?? 25
        let heal = Math.max(1, Math.floor((battler.mon.maxHp * pct) / 100))
        if (hasRipenEffect(state, bId, deps)) heal *= 2
        battler.mon.hp = Math.min(battler.mon.maxHp, battler.mon.hp + heal)
        syncPartyHp(state, bId)
        battler.mon.itemId = null
      }
      continue
    }

    // Oran Berry / Berry Juice, battle_util.c:5883-5885, 5311-5333
    if (holdEffect === 'HOLD_EFFECT_RESTORE_HP') {
      if (
        battler.mon.hp <= Math.floor(battler.mon.maxHp / 2) &&
        !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext) &&
        canBattlerHeal(state, bId, battler, unmodelled)
      ) {
        let heal = itemData?.holdEffectStrength ?? 10
        if (hasRipenEffect(state, bId, deps)) heal *= 2
        battler.mon.hp = Math.min(battler.mon.maxHp, battler.mon.hp + heal)
        syncPartyHp(state, bId)
        battler.mon.itemId = null
      }
      continue
    }

    // Confuse berries (Figy, Wiki, Mago, Aguav, Iapapa), battle_util.c:5892-5906, 5167-5193
    if (
      holdEffect === 'HOLD_EFFECT_CONFUSE_SPICY' ||
      holdEffect === 'HOLD_EFFECT_CONFUSE_DRY' ||
      holdEffect === 'HOLD_EFFECT_CONFUSE_SWEET' ||
      holdEffect === 'HOLD_EFFECT_CONFUSE_BITTER' ||
      holdEffect === 'HOLD_EFFECT_CONFUSE_SOUR'
    ) {
      const hasGluttony = battlerHasSimAbility(state, battler, 'ABILITY_GLUTTONY', false, bId, false, deps.dataContext)
      const threshold = Math.floor(battler.mon.maxHp / (hasGluttony ? 2 : 4))
      if (
        battler.mon.hp <= threshold &&
        !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext) &&
        canBattlerHeal(state, bId, battler, unmodelled)
      ) {
        const param = itemData?.holdEffectStrength ?? 3
        let heal = Math.max(1, Math.floor(battler.mon.maxHp / param))
        if (hasRipenEffect(state, bId, deps)) heal *= 2
        battler.mon.hp = Math.min(battler.mon.maxHp, battler.mon.hp + heal)
        syncPartyHp(state, bId)
        battler.mon.itemId = null
      }
      continue
    }

    // Pinch stat berries (Salac, Liechi, Ganlon, Petaya, Apicot), battle_util.c:5907-5921, 5195-5215
    if (
      holdEffect === 'HOLD_EFFECT_SPEED_UP' ||
      holdEffect === 'HOLD_EFFECT_ATTACK_UP' ||
      holdEffect === 'HOLD_EFFECT_DEFENSE_UP' ||
      holdEffect === 'HOLD_EFFECT_SP_ATTACK_UP' ||
      holdEffect === 'HOLD_EFFECT_SP_DEFENSE_UP'
    ) {
      const statId =
        holdEffect === 'HOLD_EFFECT_ATTACK_UP'
          ? STAT_ATK
          : holdEffect === 'HOLD_EFFECT_DEFENSE_UP'
            ? STAT_DEF
            : holdEffect === 'HOLD_EFFECT_SPEED_UP'
              ? STAT_SPEED
              : holdEffect === 'HOLD_EFFECT_SP_ATTACK_UP'
                ? STAT_SPATK
                : STAT_SPDEF
      const hasGluttony = battlerHasSimAbility(state, battler, 'ABILITY_GLUTTONY', false, bId, false, deps.dataContext)
      const threshold = Math.floor(battler.mon.maxHp / (hasGluttony ? 2 : 4))
      if (
        battler.mon.hp <= threshold &&
        !isUnnerveAbilityOnOpposingSide(state, bId, deps.dataContext) &&
        canRaiseStat(state, bId, statId, deps.dataContext)
      ) {
        const boost = hasRipenEffect(state, bId, deps) ? 2 : 1
        const res = changeStatBuffs(
          state,
          bId,
          bId,
          bId,
          boost,
          statId,
          STAT_BUFF_ALLOW_PTR,
          false,
          { dataContext: deps.dataContext, grounding: deps.grounding },
          unmodelled,
        )
        if (res.delta !== 0) {
          statChanges.push({ battlerId: bId, stat: statId, change: res.delta })
        }
        battler.mon.itemId = null
      }
      continue
    }
  }
  return { statChanges }
}

export interface MoveEndOutcome {
  attackerDamage: number | null
  statChanges: StatChangeOutcome[] | null
  statusApplied: StatusAppliedOutcome | null
}

/**
 * ABILITYEFFECT_IMMUNITY's status pick, battle_util.c:4508-4524. ONE status by
 * fixed priority: poison-any, bleed, burn, frostbite, sleep, paralysis,
 * confusion, infatuation, restricting (taunt/disable/encore timer or
 * STATUS2_TORMENT). STATUS1_FREEZE is deliberately absent -- the C's list does
 * not test it either.
 */
function pickImmunityStatus(battler: BattlerState): number {
  if (hasFlag(battler.mon.status1, STATUS1_POISON_ANY)) return CHECK_POISON
  if (hasFlag(battler.mon.status1, STATUS1_BLEED)) return CHECK_BLEED
  if (hasFlag(battler.mon.status1, STATUS1_BURN)) return CHECK_BURN
  if (hasFlag(battler.mon.status1, STATUS1_FROSTBITE)) return CHECK_FROSTBITE
  if (hasFlag(battler.mon.status1, STATUS1_SLEEP)) return CHECK_SLEEP
  if (hasFlag(battler.mon.status1, STATUS1_PARALYSIS)) return CHECK_PARALYSIS
  if (hasFlag(battler.mon.status2, STATUS2_CONFUSION)) return CHECK_CONFUSION
  if (hasFlag(battler.mon.status2, STATUS2_INFATUATION)) return CHECK_INFATUATE
  if (
    battler.volatiles.tauntTimer ||
    battler.volatiles.disableTimer ||
    battler.volatiles.encoreTimer ||
    hasFlag(battler.mon.status2, STATUS2_TORMENT)
  ) {
    return CHECK_RESTRICTING
  }
  return CHECK_NONE
}

/**
 * The cure half of ABILITYEFFECT_IMMUNITY, battle_util.c:4585-4609 (the `effect`
 * switch): status1 -> 0 (also written back to the party, matching
 * AbilityHealMonStatus), confusion/infatuation cleared from status2, and the
 * restricting timers + STATUS2_TORMENT zeroed.
 */
function cureStatusForImmunity(state: BattleState, battlerId: number, battler: BattlerState, status: number): void {
  switch (status) {
    case CHECK_CONFUSION:
      battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_CONFUSION)
      break
    case CHECK_INFATUATE:
      battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_INFATUATION)
      break
    case CHECK_RESTRICTING:
      battler.volatiles.tauntTimer = 0
      battler.volatiles.disableTimer = 0
      battler.volatiles.encoreTimer = 0
      battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_TORMENT)
      break
    default:
      // Every remaining picked value is a status1 condition.
      battler.mon.status1 = 0
      {
        const partySlot = state.sides[battlerId & 1].party[battler.partyIndex]
        if (partySlot) partySlot.status1 = 0
      }
      break
  }
}

/**
 * Cmd_moveend state machine ladder, src/battle_script_commands.c:4309-4968.
 * Walks cases 0 through 30 in numerical C enum order.
 */
export function runMoveEnd(ctx: MoveEndContext): MoveEndOutcome {
  const { state, attackerId, targetId, moveId, targetDamage, hpDealt, deps, unmodelled, fainted } = ctx
  const chosenMoveId = ctx.chosenMoveId ?? moveId
  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  const moveData = deps.dataContext.move(moveId)

  let totalAttackerDamage = 0
  let hadAttackerDamage = false
  const statChanges: StatChangeOutcome[] = []
  let statusApplied: StatusAppliedOutcome | null = null

  // TARGET_TURN_DAMAGED (battle.h:750), read at MOVEEND_MOVE_EFFECTS2_ON_EACH by Knock Off. Captured before Case 16
  // clears STATUS2_SUBSTITUTE: a Substitute that absorbed the hit leaves physicalDmg / specialDmg at zero
  // (Cmd_datahpupdate :1877-1892).
  const subAbsorbedHit =
    !!target &&
    hasFlag(target.mon.status2, STATUS2_SUBSTITUTE) &&
    doesSubstituteBlockMove(state, attackerId, targetId, moveId, { dataContext: deps.dataContext, grounding: deps.grounding }, [])
  const targetTurnDamaged = hpDealt > 0 && !subAbsorbedHit
  // gBattleStruct->changedItems: items parked at MOVEEND_MOVE_EFFECTS2_ON_EACH and handed over at MOVEEND_CHANGED_ITEMS.
  const changedItems = new Map<number, string>()

  const part = ctx.part ?? 'FULL'
  const isNoEffect = ctx.noEffect ?? !(hpDealt > 0 || targetDamage > 0 || targetTurnDamaged)

  // Cases 0-18 (see MoveEndContext.part). The block is not re-indented so the single-hit diff stays readable.
  if (part !== 'SECOND') {
  // BattleScript_MoveEndTryFaintTarget -> BattleScript_FaintTarget -> onfaintedbyattacker
  // (battle_scripts_1.s:2881-2882, 6911-6912), which runs before moveendall.
  if (target && target.mon.hp === 0 && fainted.includes(targetId)) {
    statChanges.push(
      ...dispatchOnBattlerFaints({
        state,
        faintedId: targetId,
        attackerId,
        targetId,
        byAttacker: true,
        moveId,
        moveData,
        targetDamage,
        deps,
        unmodelled,
      }),
    )
  }

  // battle_script_commands.c:4330 -- ABILITYEFFECT_REACTIVE at start of Cmd_moveend
  runReactiveAbilityEffects(state, deps, unmodelled, statChanges)

  // Case 0: MOVEEND_SUM_DAMAGE (:4334-4342)
  // Target damage already accumulated in targetDamage.

  // Case 1: MOVEEND_PROTECT_LIKE_EFFECT (:4343-4433)
  const protectResult = handleProtectLikeMoveEnd(state, attackerId, targetId, moveId, deps, unmodelled)
  if (protectResult.statChanges) {
    statChanges.push(...protectResult.statChanges)
  }
  if (protectResult.statusApplied) {
    statusApplied = protectResult.statusApplied
  }

  // Case 2: MOVEEND_RAGE (:4434-4443)
  // Rage check: target has STATUS2_RAGE, is alive, took damage. STATUS2_RAGE is not in state.ts.

  // Case 3: MOVEEND_SYNCHRONIZE_TARGET (:4523-4526)
  if (target && target.mon.hp > 0 && statusApplied?.battlerId === targetId) {
    if (battlerHasAbility(target.mon.abilities, 'ABILITY_SYNCHRONIZE', () => false)) {
      unmodelled.push('move-end Synchronize is not modelled yet')
    }
  }

  // Case 4: MOVEEND_DANCER (:4854-4879)
  if (moveData?.flags?.dance) {
    for (const b of state.battlers) {
      if (b && b.id !== attackerId && b.mon.hp > 0 && battlerHasAbility(b.mon.abilities, 'ABILITY_DANCER', () => false)) {
        unmodelled.push('move-end Dancer is not modelled yet')
        break
      }
    }
  }

  // Case 5: MOVEEND_ABILITIES (:4527-4531)
  // Target contact/move-end abilities (Rough Skin, Static, Flame Body, Poison Point, Effect Spore, Gooey)
  if (target && targetDamage > 0) {
    const defAbResult = dispatchMoveEndDefenderAbilities({
      state,
      attackerId,
      targetId,
      moveId,
      moveData,
      targetDamage,
      hpDealt,
      isCriticalHit: ctx.isCriticalHit ?? false,
      deps,
      unmodelled,
      fainted,
    })
    if (defAbResult.attackerDamage > 0) {
      totalAttackerDamage += defAbResult.attackerDamage
      hadAttackerDamage = true
    }
    if (defAbResult.statChanges.length > 0) {
      statChanges.push(...defAbResult.statChanges)
    }
    if (defAbResult.statusApplied && !statusApplied) {
      statusApplied = defAbResult.statusApplied
    }
  }

  // Case 6: MOVEEND_ABILITIES_ATTACKER (:4532-4536)
  // Attacker contact/move-end abilities
  if (attacker) {
    const atkAbResult = dispatchMoveEndAttackerAbilities({
      state,
      attackerId,
      targetId,
      moveId,
      moveData,
      targetDamage,
      hpDealt,
      isCriticalHit: ctx.isCriticalHit ?? false,
      targetHasActedThisTurn: ctx.targetHasActedThisTurn,
      noEffect: isNoEffect,
      deps,
      unmodelled,
      fainted,
    })
    if (atkAbResult.attackerDamage > 0) {
      totalAttackerDamage += atkAbResult.attackerDamage
      hadAttackerDamage = true
    }
    if (atkAbResult.statChanges.length > 0) {
      statChanges.push(...atkAbResult.statChanges)
    }
    if (atkAbResult.statusApplied && !statusApplied) {
      statusApplied = atkAbResult.statusApplied
    }
  }

  // Case 7: MOVEEND_STATUS_IMMUNITY_ABILITIES (:4537-4542)
  // AbilityBattleEffects(ABILITYEFFECT_IMMUNITY) re-checks every battler's
  // status and lets a `removesStatusOnImmunity` ability cure it
  // (battle_util.c:4505-4609). The caller only increments moveendState when the
  // call returns 0, and the body returns immediately after a cure, so each
  // re-entry restarts the scan at battler 0. Mirror both: one status per pass,
  // then loop again until a full pass cures nothing.
  {
    const statusDeps: StatusDeps = { dataContext: deps.dataContext, grounding: deps.grounding }
    for (;;) {
      let cured = false
      for (let bId = 0; bId < state.battlersCount; bId++) {
        const battler = state.battlers[bId]
        if (!battler) continue
        const status = pickImmunityStatus(battler)
        if (status === CHECK_NONE) continue
        const ability = findCureOnImmunityAbility(state, bId, status, statusDeps)
        if (ability === null) continue
        cureStatusForImmunity(state, bId, battler, status)
        cured = true
        break // `return effect` in the C: caller re-runs this case from battler 0
      }
      if (!cured) break
    }
  }

  // Case 8: MOVEEND_SYNCHRONIZE_ATTACKER (:4543-4546)
  // Attacker synchronize.

  // Case 9: MOVEEND_CHOICE_MOVE (:4547-4568)
  // Choice lock updates. Not in BattlerState.

  // Case 10: MOVEEND_ATTACKER_INVISIBLE (:4677-4686)
  // Semi-invulnerable sprite invisibility (visual only).

  // Case 11: MOVEEND_ATTACKER_VISIBLE (:4687-4701)
  // Semi-invulnerable sprite visibility (visual only).

  // Case 12: MOVEEND_TARGET_VISIBLE (:4702-4713)
  // Target sprite visibility (visual only).

  // Case 13: MOVEEND_ITEM_EFFECTS_TARGET (:4569-4572, :6126-6250)
  if (target && !isNoEffect) {
    const targetHoldEffect = deps.grounding.holdEffectOf(targetId)
    if (targetHoldEffect === 'HOLD_EFFECT_ROCKY_HELMET') {
      if (targetTurnDamaged && attacker && attacker.mon.hp > 0) {
        const attackerHoldEffect = deps.grounding.holdEffectOf(attackerId)
        if (isMoveMakingContact(moveData, attacker, attackerHoldEffect) && !isMagicGuardProtected(state, attacker)) {
          const helmetDmg = Math.max(1, Math.floor(attacker.mon.maxHp / 6))
          applyDamage(state, attackerId, helmetDmg, fainted, deps)
          totalAttackerDamage += helmetDmg
          hadAttackerDamage = true
        }
      }
    } else if (targetHoldEffect === 'HOLD_EFFECT_AIR_BALLOON') {
      // Air Balloon pops when holder is damaged by an attack (:6154-6159, battle_scripts_1.s:10912-10916)
      if (attackerId !== targetId && targetTurnDamaged) {
        target.mon.itemId = null
      }
    } else if (targetHoldEffect === 'HOLD_EFFECT_WEAKNESS_POLICY') {
      // Weakness Policy raises Atk and SpAtk by 2 when hit super-effectively (:6171-6176, battle_scripts_1.s:7576-7600)
      if (
        target.mon.hp > 0 &&
        targetTurnDamaged &&
        ctx.isSuperEffective &&
        !isUnnerveAbilityOnOpposingSide(state, targetId, deps.dataContext)
      ) {
        const canBoostAtk = canRaiseStat(state, targetId, STAT_ATK, deps.dataContext)
        const canBoostSpAtk = canRaiseStat(state, targetId, STAT_SPATK, deps.dataContext)
        if (canBoostAtk || canBoostSpAtk) {
          const atkRes = changeStatBuffs(
            state,
            targetId,
            targetId,
            targetId,
            2,
            STAT_ATK,
            STAT_BUFF_ALLOW_PTR,
            false,
            { dataContext: deps.dataContext, grounding: deps.grounding },
            unmodelled,
            moveId,
          )
          const spAtkRes = changeStatBuffs(
            state,
            targetId,
            targetId,
            targetId,
            2,
            STAT_SPATK,
            STAT_BUFF_ALLOW_PTR,
            false,
            { dataContext: deps.dataContext, grounding: deps.grounding },
            unmodelled,
            moveId,
          )
          if (atkRes.delta !== 0) {
            statChanges.push({ battlerId: targetId, stat: STAT_ATK, change: atkRes.delta })
          }
          if (spAtkRes.delta !== 0) {
            statChanges.push({ battlerId: targetId, stat: STAT_SPATK, change: spAtkRes.delta })
          }
          target.mon.itemId = null
        }
      }
    } else if (targetHoldEffect && TARGET_ITEM_EFFECTS.has(targetHoldEffect)) {
      unmodelled.push(`move-end target hold effect ${targetHoldEffect} is not modelled yet`)
    }
  }

  // Case 14: MOVEEND_ITEM_EFFECTS_ALL (:4666-4671)
  // Item effects for all battlers: White Herb, Lum/status berries, Sitrus, Oran, pinch berries.
  const itemOutcome = applyMoveEndItemEffectsAll(state, deps, unmodelled)
  if (itemOutcome.statChanges.length > 0) {
    statChanges.push(...itemOutcome.statChanges)
  }

  // Case 15: MOVEEND_KINGSROCK (:4672-4676)
  if (attacker && target && deps.grounding.holdEffectOf(attackerId) === 'HOLD_EFFECT_FLINCH') {
    applyKingsRock(state, attackerId, targetId, moveId, moveData, targetDamage, targetTurnDamaged, deps, unmodelled)
  }

  // Case 16: MOVEEND_SUBSTITUTE (:4714-4722)
  for (const b of state.battlers) {
    if (b && b.volatiles.substituteHp === 0 && hasFlag(b.mon.status2, STATUS2_SUBSTITUTE)) {
      b.mon.status2 = clearFlag(b.mon.status2, STATUS2_SUBSTITUTE)
      b.volatiles.substituteDestroyedThisTurn = true
    }
  }

  // Cases 17, 18, 30: MOVEEND_UPDATE_LAST_MOVES (:4723-4772), MOVEEND_MIRROR_MOVE (:4773-4781), MOVEEND_CLEAR_BITS (:4934-4957)
  runMoveEndBookkeeping({
    state,
    attackerId,
    targetId,
    currentMoveId: moveId,
    chosenMoveId,
    deps,
    noEffect: isNoEffect,
    moveFailed: isNoEffect,
    obeys: true,
    fainted,
    clearBits: false,
  })

  }

  // Case 19: MOVEEND_MULTIHIT_MOVE (:4880-4921) is the boundary between the two halves; the per-hit loop itself is turn.ts's.
  if (part === 'FIRST') {
    return {
      attackerDamage: hadAttackerDamage ? totalAttackerDamage : null,
      statChanges: statChanges.length > 0 ? statChanges : null,
      statusApplied,
    }
  }

  // Case 20: MOVEEND_MOVE_EFFECTS2_ON_EACH (:4573-4632)
  switch (ctx.moveEffect2) {
    case 'MOVE_EFFECT_STEAL_ITEM':
      applyStealItem(state, attackerId, targetId, targetTurnDamaged, deps, unmodelled, changedItems)
      break
    case 'MOVE_EFFECT_KNOCK_OFF':
      applyKnockOff(state, attackerId, targetId, targetTurnDamaged, deps, unmodelled)
      break
    case 'MOVE_EFFECT_BUG_BITE':
      applyBugBite(state, attackerId, targetId, deps, unmodelled)
      break
    case 'MOVE_EFFECT_SMACK_DOWN':
      applySmackDown(state, attackerId, targetId, deps)
      break
    case 'MOVE_EFFECT_REMOVE_STATUS':
      // C: battle_script_commands.c:4606-4625
      if (target && target.mon.hp > 0 && targetTurnDamaged) {
        let statusToClear = 0
        if (typeof moveData?.argumentInt === 'number' && moveData.argumentInt > 0) {
          statusToClear = moveData.argumentInt
        } else if (moveData?.argument && typeof moveData.argument === 'object') {
          if ('value' in moveData.argument && typeof moveData.argument.value === 'number') {
            statusToClear = moveData.argument.value
          } else if ('status' in moveData.argument && typeof moveData.argument.status === 'number') {
            statusToClear = moveData.argument.status
          }
        }
        if (statusToClear === 0) {
          if (moveData?.effect === 'EFFECT_SPARKLING_ARIA') {
            statusToClear = STATUS1_BURN
          } else if (moveData?.effect === 'EFFECT_WAKE_UP_SLAP') {
            statusToClear = STATUS1_SLEEP
          } else if (moveData?.effect === 'EFFECT_SMELLING_SALTS') {
            statusToClear = STATUS1_PARALYSIS
          }
        }
        if (statusToClear !== 0 && hasFlag(target.mon.status1, statusToClear)) {
          target.mon.status1 = clearFlag(target.mon.status1, statusToClear)
        }
      }
      break
  }

  // Case 21: MOVEEND_NEXT_TARGET (:4782-4822)
  // Double battle second target loop.

  // Case 22: MOVEEND_MOVE_EFFECTS2 (:4633-4655)
  if (ctx.moveEffect2 === 'MOVE_EFFECT_BURN_UP') {
    // C: battle_script_commands.c:4640-4643, battle_scripts_1.s:873-877 (VARIOUS_LOSE_TYPE :7620-7639)
    if (attacker && attacker.mon.hp > 0 && moveData?.type) {
      const moveType = moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type
      loseCurrentMoveType(attacker, moveType)
    }
  } else if (ctx.moveEffect2 === 'MOVE_EFFECT_SCALE_SHOT' || ctx.moveEffect2 === 'MOVE_EFFECT_WYRM_WIND') {
    // C: battle_script_commands.c:4644-4651 -> BattleScript_MoveEffectScaleShot / _WyrmWind (data/battle_scripts_1.s:195-208):
    // `setmoveeffect X_MINUS_1 | AFFECTS_USER | CERTAIN; seteffectsecondary; setmoveeffect SPD_PLUS_1 | AFFECTS_USER;
    // seteffectsecondary`. seteffectsecondary is SetMoveEffect(FALSE, 0) (:3132-3135), which draws no chance but still stops at
    // TestSheerForceFlag (:2361) and a fainted effect battler (:2364-2383); the user is the effect battler, so the Shield Dust,
    // Safeguard and Substitute gates do not apply. The stat calls are the ones SetMoveEffect makes for MOVE_EFFECT_*_MINUS_1 /
    // _PLUS_1 (:2751-2781) with affectsUser | STAT_BUFF_UPDATE_MOVE_EFFECT.
    const dropStat = ctx.moveEffect2 === 'MOVE_EFFECT_SCALE_SHOT' ? STAT_DEF : STAT_SPDEF
    if (
      attacker &&
      attacker.mon.hp > 0 &&
      !testSheerForceFlag(state, attackerId, moveId, { dataContext: deps.dataContext, grounding: deps.grounding })
    ) {
      for (const [delta, stat] of [[-1, dropStat], [1, STAT_SPEED]] as const) {
        const res = changeStatBuffsImplicit(
          state,
          attackerId,
          targetId,
          delta,
          stat,
          MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_UPDATE_MOVE_EFFECT,
          delta < 0,
          deps,
          unmodelled,
          moveId,
        )
        if (res.delta !== 0) statChanges.push({ battlerId: attackerId, stat, change: res.delta })
      }
    }
  } else if (moveData?.effect && MOVE_EFFECTS2.has(moveData.effect)) {
    unmodelled.push(`move-end effect ${moveData.effect} is not modelled yet`)
  }

  // Case 23: MOVEEND_RECOIL (:4457-4517) -- recoil is a fraction of savedDmg (HP actually dealt).
  // Struggle's Magic Guard / noRecoil bypass (:4467) only matters for the gapped hooks below:
  // EFFECT_RECOIL_HP_25 has no GetRecoilFraction entry.
  if (moveData?.split !== 'STATUS' && hpDealt > 0 && attacker && attacker.mon.hp > 0) {
    const struggle = moveId === 'MOVE_STRUGGLE'
    if (struggle || (!isMagicGuardProtected(state, attacker) && !battlerHasNoRecoil(attacker))) {
      const fraction = getRecoilFraction(moveData?.effect, deps.moveBehaviors)
      let recoilDmg = fraction > 0 ? Math.max(1, Math.floor(hpDealt / fraction)) : 0
      const onRecoil = ON_RECOIL_ABILITIES.find((ab) => battlerHasAbility(attacker.mon.abilities, ab, () => false))
      if (onRecoil) unmodelled.push(`MOVEEND_RECOIL's onRecoil hook (${onRecoil}, battle_script_commands.c:4483-4490) is not modelled`)
      if (hasFlag(attacker.mon.status2, STATUS2_ENRAGED)) {
        unmodelled.push('MOVEEND_RECOIL\'s enraged recoil (savedDmg / 3, battle_script_commands.c:4492-4505) is not modelled')
      }
      if (recoilDmg > 0) {
        if (hasFlag(attacker.mon.status2, STATUS2_CONFUSION) && isAbilityAliveOnOpposingSide(state, attackerId, 'ABILITY_COSMIC_DAZE')) {
          recoilDmg *= 2
        }
        if (battlerHasHalfRecoil(attacker)) {
          recoilDmg = Math.max(1, Math.floor(recoilDmg / 2))
        }
        applyDamage(state, attackerId, recoilDmg, fainted, deps)
        totalAttackerDamage += recoilDmg
        hadAttackerDamage = true
      }
    }
  }

  // Case 24: MOVEEND_CHARGE (:4922-4933) -- GET_MOVE_TYPE's dynamic type is read as the declared type.
  if (
    moveData?.type === 'TYPE_ELECTRIC' &&
    moveData.power > 0 &&
    attacker &&
    !hasFlag(attacker.mon.status2, STATUS2_MULTIPLETURNS) &&
    hasFlag(attacker.statuses3, STATUS3_CHARGED_UP)
  ) {
    if (target && battlerHasAbility(target.mon.abilities, 'ABILITY_ENERGIZED', () => false)) {
      unmodelled.push("MOVEEND_CHARGE's GetOncePerTurnAbilityCounter(target, ABILITY_ENERGIZED) gate (:4929) is not modelled")
    }
    attacker.statuses3 = clearFlag(attacker.statuses3, STATUS3_CHARGED_UP)
  }

  // Case 25: MOVEEND_ABILITIES_AFTER_RECOIL (:4518-4522)
  // ABILITYEFFECT_AFTER_RECOIL (battle_util.c:4722-4732)
  if (
    attacker &&
    attacker.mon.hp > 0 &&
    targetTurnDamaged &&
    battlerHasSimAbility(state, attacker, 'ABILITY_NOSFERATU', false, attackerId, false, deps.dataContext) &&
    isMoveMakingContact(moveData, attacker, deps.grounding.holdEffectOf(attackerId)) &&
    attacker.mon.hp < attacker.mon.maxHp &&
    canBattlerHeal(state, attackerId, attacker, unmodelled)
  ) {
    const heal = Math.max(1, Math.floor(hpDealt / 2))
    attacker.mon.hp = Math.min(attacker.mon.maxHp, attacker.mon.hp + heal)
    syncPartyHp(state, attackerId)
  }

  // Case 26: MOVEEND_LIFEORB_SHELLBELL (:4823-4827, :6066-6124)
  if (attacker && attacker.mon.hp > 0) {
    const atkHoldEffect = deps.grounding.holdEffectOf(attackerId)
    if (atkHoldEffect === 'HOLD_EFFECT_LIFE_ORB') {
      if (targetDamage > 0 && attackerId !== targetId) {
        const sheerForce = testSheerForceFlag(state, attackerId, moveId, {
          dataContext: deps.dataContext,
          grounding: deps.grounding,
        })
        if (!sheerForce && !isMagicGuardProtected(state, attacker)) {
          const loDmg = Math.max(1, Math.floor(attacker.mon.maxHp / 10))
          applyDamage(state, attackerId, loDmg, fainted, deps)
          totalAttackerDamage += loDmg
          hadAttackerDamage = true
        }
      }
    } else if (atkHoldEffect === 'HOLD_EFFECT_SHELL_BELL') {
      if (targetDamage > 0 && attackerId !== targetId) {
        // REQUIRE chain, battle_util.c:6068-6073; the heal is savedDmg / 4 (min 1), :6077-6078, capped at maxHp by datahpupdate.
        if (
          hpDealt > 0 &&
          attacker.mon.hp < attacker.mon.maxHp &&
          canBattlerHeal(state, attackerId, attacker, unmodelled) &&
          !testSheerForceFlag(state, attackerId, moveId, { dataContext: deps.dataContext, grounding: deps.grounding })
        ) {
          const heal = Math.max(1, Math.floor(hpDealt / 4))
          attacker.mon.hp = Math.min(attacker.mon.maxHp, attacker.mon.hp + heal)
          syncPartyHp(state, attackerId)
        }
      }
    } else if (atkHoldEffect === 'HOLD_EFFECT_THROAT_SPRAY') {
      // Throat Spray raises SpAtk by 1 when using a sound move (:6111-6124, battle_scripts_1.s:7618-7632). The C does not require a
      // damaging move, but this ladder only runs for damaging moves, so a sound STATUS move (handler path) never triggers it here.
      const isSound = Boolean(moveData?.flags?.sound)
      const hitOrAffected = !isNoEffect || targetTurnDamaged || targetDamage > 0
      if (
        isSound &&
        hitOrAffected &&
        canRaiseStat(state, attackerId, STAT_SPATK, deps.dataContext)
      ) {
        const res = changeStatBuffs(
          state,
          attackerId,
          attackerId,
          attackerId,
          1,
          STAT_SPATK,
          STAT_BUFF_ALLOW_PTR,
          false,
          { dataContext: deps.dataContext, grounding: deps.grounding },
          unmodelled,
          moveId,
        )
        if (res.delta !== 0) {
          statChanges.push({ battlerId: attackerId, stat: STAT_SPATK, change: res.delta })
        }
        attacker.mon.itemId = null
      }
    }
  }

  // Case 27: MOVEEND_CHANGED_ITEMS (:4656-4665)
  for (const [battlerId, itemId] of changedItems) {
    const holder = state.battlers[battlerId]
    if (holder) holder.mon.itemId = itemId
  }

  // Case 28: MOVEEND_DEFROST (:4444-4456)
  // Frostbite thaw

  // Case 29: MOVEEND_PICKPOCKET (:4828-4853)
  if (target && targetDamage > 0 && battlerHasAbility(target.mon.abilities, 'ABILITY_PICKPOCKET', () => false)) {
    unmodelled.push('move-end Pickpocket is not modelled yet')
  }

  // Case 30: MOVEEND_CLEAR_BITS (:4934-4957)
  applyMoveEndClearBits(state, attackerId, targetId, moveId, deps, isNoEffect)

  // Every other faint this action caused (the attacker, from recoil / Rocky Helmet / Rough Skin / Life Orb) goes through
  // BattleScript_FaintAttacker -> onfaintedbyother (battle_scripts_1.s:6892), after moveend.
  for (const faintedId of fainted) {
    if (faintedId === targetId) continue
    statChanges.push(
      ...dispatchOnBattlerFaints({
        state,
        faintedId,
        attackerId,
        targetId,
        byAttacker: false,
        moveId,
        moveData,
        targetDamage,
        deps,
        unmodelled,
      }),
    )
  }

  // Cmd_moveend re-enters after every case that calls a script, and runs ABILITYEFFECT_REACTIVE
  // (battle_script_commands.c:4330) at each entry; this single-pass port runs it once more at the end
  // so stat changes made during move end (Stamina, Weak Armor, KO raises...) are still copied.
  runReactiveAbilityEffects(state, deps, unmodelled, statChanges)

  return {
    attackerDamage: hadAttackerDamage ? totalAttackerDamage : null,
    statChanges: statChanges.length > 0 ? statChanges : null,
    statusApplied,
  }
}
