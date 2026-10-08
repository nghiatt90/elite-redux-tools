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
//  7   | MOVEEND_STATUS_IMMUNITY_ABILITIES 4537-4542  | Unreachable    | Re-checks immunities to cure status; no-op in single-action sim.
//  8   | MOVEEND_SYNCHRONIZE_ATTACKER    | 4543-4546  | Gapped (cond.) | Attacker Synchronize.
//  9   | MOVEEND_CHOICE_MOVE             | 4547-4568  | Unreachable    | Choice item move lock; choicedMove array is not in BattlerState.
// 10   | MOVEEND_ATTACKER_INVISIBLE      | 4677-4686  | Unreachable    | Semi-invulnerable sprite invisibility; visual only.
// 11   | MOVEEND_ATTACKER_VISIBLE        | 4687-4701  | Unreachable    | Semi-invulnerable sprite visibility; visual only.
// 12   | MOVEEND_TARGET_VISIBLE          | 4702-4713  | Unreachable    | Target sprite visibility; visual only.
// 13   | MOVEEND_ITEM_EFFECTS_TARGET     | 4569-4572  | Ported / Gap   | Ported: Rocky Helmet (floor(maxHp/6) to contact attacker). Other target items gapped.
// 14   | MOVEEND_ITEM_EFFECTS_ALL        | 4666-4671  | Gapped (cond.) | Item effects for all battlers (pinch berries etc.).
// 15   | MOVEEND_KINGSROCK               | 4672-4676  | Gapped (cond.) | King's Rock flinch roll.
// 16   | MOVEEND_SUBSTITUTE              | 4714-4722  | Ported         | Clears STATUS2_SUBSTITUTE and sets substituteDestroyedThisTurn if substituteHp is 0.
// 17   | MOVEEND_UPDATE_LAST_MOVES       | 4723-4772  | Ported         | attacker.lastMove = moveId (the only field existing in state.ts).
// 18   | MOVEEND_MIRROR_MOVE             | 4773-4781  | Unreachable    | Mirror move tracking; not modeled in BattlerState.
// 19   | MOVEEND_MULTIHIT_MOVE           | 4880-4921  | Unreachable    | Multi-hit loop; resolved upstream in calculateMoveDamage / attackCanceller.
// 20   | MOVEEND_MOVE_EFFECTS2_ON_EACH   | 4573-4632  | Gapped (cond.) | Post-target-item effects: Knock Off, Thief, Bug Bite, Smack Down. Out of scope per brief.
// 21   | MOVEEND_NEXT_TARGET             | 4782-4822  | Unreachable    | Double battle second target iteration; sim is single battle.
// 22   | MOVEEND_MOVE_EFFECTS2           | 4633-4655  | Gapped (cond.) | Post-target-item move effects (Make It Rain, Burn Up, Scale Shot, Wyrm Wind).
// 23   | MOVEEND_RECOIL                  | 4457-4517  | Ported         | Recoil self-damage; Magic Guard, noRecoil (Rock Head/Steel Barrel/Bruteforce), halfRecoil.
// 24   | MOVEEND_CHARGE                  | 4922-4933  | Ported         | Clears STATUS3_CHARGED_UP on Electric damaging move.
// 25   | MOVEEND_ABILITIES_AFTER_RECOIL  | 4518-4522  | Gapped (cond.) | ABILITYEFFECT_AFTER_RECOIL hook.
// 26   | MOVEEND_LIFEORB_SHELLBELL       | 4823-4827  | Ported / Gap   | Ported: Life Orb (floor(maxHp/10) self-damage, Sheer Force/Magic Guard checks). Shell Bell gapped.
// 27   | MOVEEND_CHANGED_ITEMS           | 4656-4665  | Unreachable    | Changed held items assignment.
// 28   | MOVEEND_DEFROST                 | 4444-4456  | Unreachable    | Frostbite cured by fire move on target.
// 29   | MOVEEND_PICKPOCKET              | 4828-4853  | Gapped (cond.) | Pickpocket item theft; gapped if target has ABILITY_PICKPOCKET.
// 30   | MOVEEND_CLEAR_BITS              | 4934-4957  | Ported         | Clears rolloutCounter (if not Rollout), targetAffected, gemBoost, berryReduced.
// --------------------------------------------------------------------------------------------------------------------------------------------------------------------

import type { MoveBehaviors } from '../basePower'
import type { BattleState, BattlerState } from './state'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  STATUS2_CONFUSION,
  STATUS2_ENRAGED,
  STATUS2_MULTIPLETURNS,
  STATUS2_SUBSTITUTE,
  STATUS3_CHARGED_UP,
  STAT_SPEED,
  clearFlag,
  hasFlag,
} from './constants'
import { hasFlag as abilitySlotsHaveFlag, isIronFistBoosted } from '../abilities/dispatchCalc'
import { battlerHasAbility } from '../abilities/dispatch'
import type { AbilitySlots } from '../abilities/dispatch'
import { isMagicGuardProtected } from './endTurn'
import {
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_PARALYSIS,
  MOVE_EFFECT_POISON,
  MOVE_EFFECT_SLEEP,
  applyPrimaryStatusEffect,
  canBeBurned,
  canBeParalyzed,
  canBePoisoned,
  canSleep,
  doesSubstituteBlockMove,
  isPowderImmune,
  testSheerForceFlag,
} from './statusEffects'
import type { StatusDeps } from './statusEffects'
import {
  battlerHasSimAbility,
  changeStatBuffsImplicit,
  isSimAbilitySuppressed,
  MOVE_EFFECT_AFFECTS_USER,
  STAT_BUFF_UPDATE_MOVE_EFFECT,
} from './statBuffs'
import type { StatChangeOutcome, StatusAppliedOutcome, TurnLoopDeps } from './turn'
import { applyDamage, handleProtectLikeMoveEnd, isAbilityAliveOnOpposingSide } from './turn'
import type { SimDataContext, SimMoveData } from './dataContext'

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

// Target items in ITEMEFFECT_TARGET (battle_util.c:6126-6250) other than Rocky Helmet
const TARGET_ITEM_EFFECTS = new Set([
  'HOLD_EFFECT_RED_CARD',
  'HOLD_EFFECT_EJECT_BUTTON',
  'HOLD_EFFECT_AIR_BALLOON',
  'HOLD_EFFECT_WEAKNESS_POLICY',
  'HOLD_EFFECT_SNOWBALL',
  'HOLD_EFFECT_LUMINOUS_MOSS',
  'HOLD_EFFECT_CELL_BATTERY',
  'HOLD_EFFECT_ABSORB_BULB',
  'HOLD_EFFECT_KEE_BERRY',
  'HOLD_EFFECT_MARANGA_BERRY',
  'HOLD_EFFECT_JABOCA_BERRY',
  'HOLD_EFFECT_ROWAP_BERRY',
])

// Move effects handled in MOVEEND_MOVE_EFFECTS2_ON_EACH (battle_script_commands.c:4573-4632)
const MOVE_EFFECTS2_ON_EACH = new Set([
  'EFFECT_KNOCK_OFF',
  'EFFECT_THIEF',
  'EFFECT_BUG_BITE',
  'EFFECT_SMACK_DOWN',
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
export const PORTED_DEFENDER_ABILITIES = new Set([
  'ABILITY_ROUGH_SKIN',
  'ABILITY_IRON_BARBS',
  'ABILITY_DRAGONFRUIT',
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
])

// Quoted grep: ON_EITHER_ABILITY in pipeline/.upstream/eliteredux-source/src/abilities.cc
// Matches:
// - Static family: ABILITY_STATIC (:621), ABILITY_WHITE_NOISE (:8182)
// - Flame Body family: ABILITY_FLAME_BODY (:1137), ABILITY_SMOLDERING_WOOD (:4363), ABILITY_SUPER_HOT_GOO (:6104)
// - Poison Point family: ABILITY_POISON_POINT (:998), ABILITY_POISON_TOUCH (:2100), ABILITY_TOXIC_SHELL (:11535), ABILITY_VENOM_CROWN (:9519), ABILITY_BLIGHT_SCALE (:9526), ABILITY_POISON_QUILLS (:10147)
export const PORTED_ATTACKER_ABILITIES = new Set([
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
  'ABILITY_POISON_QUILLS',
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

export interface MoveEndAbilitiesContext {
  state: BattleState
  attackerId: number
  targetId: number
  moveId: string
  moveData: SimMoveData | undefined
  targetDamage: number
  deps: TurnLoopDeps
  unmodelled: string[]
  fainted: number[]
}

export interface MoveEndAbilitiesResult {
  attackerDamage: number
  statChanges: StatChangeOutcome[]
  statusApplied: StatusAppliedOutcome | null
}

function handleDefenderMoveEndAbility(
  state: BattleState,
  abilityId: string,
  targetId: number,
  attackerId: number,
  moveData: SimMoveData | undefined,
  moveId: string,
  attackerHoldEffect: string | null,
  deps: TurnLoopDeps,
  statusDeps: StatusDeps,
  unmodelled: string[],
  fainted: number[],
): { attackerDamage: number; statusApplied: StatusAppliedOutcome | null; statChange: StatChangeOutcome | null } {
  const result: { attackerDamage: number; statusApplied: StatusAppliedOutcome | null; statChange: StatChangeOutcome | null } = {
    attackerDamage: 0,
    statusApplied: null,
    statChange: null,
  }

  const attacker = state.battlers[attackerId]
  // ShouldApplyOnHitEffect(attacker), src/battle_util.c:4062: DidMoveHit() && IsBattlerAlive(attacker)
  if (!attacker || attacker.mon.hp <= 0) return result

  // 1. Rough Skin family (src/abilities.cc:784-793, 2262, 7325, 10149, 11224)
  if (
    abilityId === 'ABILITY_ROUGH_SKIN' ||
    abilityId === 'ABILITY_IRON_BARBS' ||
    abilityId === 'ABILITY_DRAGONFRUIT' ||
    abilityId === 'ABILITY_DOUBLE_IRON_BARBS' ||
    abilityId === 'ABILITY_POISON_QUILLS'
  ) {
    if (isMoveMakingContact(moveData, attacker, attackerHoldEffect) && !isMagicGuardProtected(state, attacker)) {
      const denom = abilityId === 'ABILITY_DOUBLE_IRON_BARBS' ? 6 : 8
      const dmg = Math.max(1, Math.floor(attacker.mon.maxHp / denom))
      applyDamage(state, attackerId, dmg, fainted)
      result.attackerDamage += dmg
    }
  }

  // If attacker fainted from Rough Skin recoil, subsequent checks won't pass ShouldApplyOnHitEffect
  if (attacker.mon.hp <= 0) return result

  // 2. Poison Point on defender (src/abilities.cc:987-995, 2101, 9519, 9526, 10149, 11536)
  if (
    abilityId === 'ABILITY_POISON_POINT' ||
    abilityId === 'ABILITY_POISON_TOUCH' ||
    abilityId === 'ABILITY_TOXIC_SHELL' ||
    abilityId === 'ABILITY_VENOM_CROWN' ||
    abilityId === 'ABILITY_BLIGHT_SCALE' ||
    abilityId === 'ABILITY_POISON_QUILLS'
  ) {
    if (canBePoisoned(state, targetId, attackerId, 'MOVE_NONE', statusDeps)) {
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
    if (canBeParalyzed(state, targetId, attackerId, statusDeps)) {
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
    if (canBeBurned(state, attackerId, targetId, statusDeps)) {
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

  // 6. Gooey family on defender (src/abilities.cc:2482-2492, 2496, 3054, 6106, 11358, 11629)
  if (
    abilityId === 'ABILITY_GOOEY' ||
    abilityId === 'ABILITY_SLIME_MOLD' ||
    abilityId === 'ABILITY_TANGLING_HAIR' ||
    abilityId === 'ABILITY_MASSIVE_PELT' ||
    abilityId === 'ABILITY_MUCUS_MEMBRANE' ||
    abilityId === 'ABILITY_SUPER_HOT_GOO'
  ) {
    // BattleScript_GooeyActivates (battle_scripts_1.s:10581-10586) swaps attacker and target around
    // seteffectsecondary: SetMoveEffect(FALSE, FALSE) with the Gooey holder as gBattlerAttacker and
    // HITMARKER_IGNORE_SAFEGUARD set (Shield Dust skipped). Its Sheer Force / Substitute checks (:2361, :2388)
    // therefore read the holder against gCurrentMove; MOVE_EFFECT_SPD_MINUS_1 then calls
    // ChangeStatBuffsImplicit with STAT_BUFF_UPDATE_MOVE_EFFECT (:2765-2775).
    if (
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
        result.statChange = { battlerId: attackerId, stat: STAT_SPEED, change: dropRes.delta }
      }
    }
  }

  return result
}

function handleAttackerMoveEndAbility(
  state: BattleState,
  abilityId: string,
  attackerId: number,
  targetId: number,
  moveData: SimMoveData | undefined,
  moveId: string,
  attackerHoldEffect: string | null,
  statusDeps: StatusDeps,
  unmodelled: string[],
): StatusAppliedOutcome | null {
  const target = state.battlers[targetId]
  const attacker = state.battlers[attackerId]
  // ShouldApplyOnHitEffect(target), src/battle_util.c:4062: DidMoveHit() && IsBattlerAlive(target)
  if (!target || target.mon.hp <= 0 || !attacker || attacker.mon.hp <= 0) return null

  // 1. Poison Point on attacker (src/abilities.cc:987-995, 2100, 9519, 9526, 10147, 11535)
  if (
    abilityId === 'ABILITY_POISON_POINT' ||
    abilityId === 'ABILITY_POISON_TOUCH' ||
    abilityId === 'ABILITY_TOXIC_SHELL' ||
    abilityId === 'ABILITY_VENOM_CROWN' ||
    abilityId === 'ABILITY_BLIGHT_SCALE' ||
    abilityId === 'ABILITY_POISON_QUILLS'
  ) {
    if (canBePoisoned(state, attackerId, targetId, 'MOVE_NONE', statusDeps)) {
      if (isMoveMakingContact(moveData, attacker, attackerHoldEffect)) {
        if (state.rng.random16() % 100 < 30) {
          const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_POISON, moveId, statusDeps, unmodelled, false, false, true)
          if (res.applied && res.status) {
            return { battlerId: targetId, status: res.status }
          }
        }
      }
    }
  }

  // 2. Static on attacker (src/abilities.cc:610-618, 8182)
  if (abilityId === 'ABILITY_STATIC' || abilityId === 'ABILITY_WHITE_NOISE') {
    if (canBeParalyzed(state, attackerId, targetId, statusDeps)) {
      const chance = isMoveMakingContact(moveData, attacker, attackerHoldEffect) ? 30 : 10
      if (state.rng.random16() % 100 < chance) {
        const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_PARALYSIS, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          return { battlerId: targetId, status: res.status }
        }
      }
    }
  }

  // 3. Flame Body on attacker (src/abilities.cc:1126-1134, 4363, 6104)
  if (abilityId === 'ABILITY_FLAME_BODY' || abilityId === 'ABILITY_SMOLDERING_WOOD' || abilityId === 'ABILITY_SUPER_HOT_GOO') {
    if (canBeBurned(state, targetId, attackerId, statusDeps)) {
      const chance = isMoveMakingContact(moveData, attacker, attackerHoldEffect) ? 30 : 20
      if (state.rng.random16() % 100 < chance) {
        const res = applyPrimaryStatusEffect(state, attackerId, targetId, MOVE_EFFECT_BURN, moveId, statusDeps, unmodelled, false, false, true)
        if (res.applied && res.status) {
          return { battlerId: targetId, status: res.status }
        }
      }
    }
  }

  return null
}

/**
 * Port of AbilityBattleEffects(ABILITYEFFECT_MOVE_END, gBattlerTarget), src/battle_util.c:4485-4489.
 * Iterates target's ability slots in reverse order (slot 3 -> 2 -> 1 -> 0).
 */
export function dispatchMoveEndDefenderAbilities(ctx: MoveEndAbilitiesContext): MoveEndAbilitiesResult {
  const { state, attackerId, targetId, moveId, moveData, deps, unmodelled, fainted } = ctx
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

  for (const { abilityId } of slots) {
    if (isSimAbilitySuppressed(state, target, abilityId, false, attackerId, false, deps.dataContext)) {
      continue
    }
    if (PORTED_DEFENDER_ABILITIES.has(abilityId)) {
      const abRes = handleDefenderMoveEndAbility(
        state,
        abilityId,
        targetId,
        attackerId,
        moveData,
        moveId,
        attackerHoldEffect,
        deps,
        statusDeps,
        unmodelled,
        fainted,
      )
      if (abRes.attackerDamage > 0) {
        result.attackerDamage += abRes.attackerDamage
      }
      if (abRes.statChange) {
        result.statChanges.push(abRes.statChange)
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
  const { state, attackerId, targetId, moveId, moveData, deps, unmodelled } = ctx
  const attacker = state.battlers[attackerId]
  const result: MoveEndAbilitiesResult = {
    attackerDamage: 0,
    statChanges: [],
    statusApplied: null,
  }
  if (!attacker || attacker.mon.hp <= 0) return result

  const statusDeps: StatusDeps = { dataContext: deps.dataContext, grounding: deps.grounding }
  const attackerHoldEffect = deps.grounding.holdEffectOf(attackerId)
  const slots = getBattlerAbilitySlotsReverse(attacker.mon.abilities)

  for (const { abilityId } of slots) {
    if (isSimAbilitySuppressed(state, attacker, abilityId, false, attackerId, false, deps.dataContext)) {
      continue
    }
    if (PORTED_ATTACKER_ABILITIES.has(abilityId)) {
      const applied = handleAttackerMoveEndAbility(
        state,
        abilityId,
        attackerId,
        targetId,
        moveData,
        moveId,
        attackerHoldEffect,
        statusDeps,
        unmodelled,
      )
      if (applied && !result.statusApplied) {
        result.statusApplied = applied
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
// MoveEnd Ladder
// ---------------------------------------------------------------------------

export interface MoveEndContext {
  state: BattleState
  attackerId: number
  targetId: number
  moveId: string
  targetDamage: number
  /** gTurnStructs[attacker].savedDmg -- the HP actually removed from the target (gHpDealt, :4335). */
  hpDealt: number
  deps: TurnLoopDeps
  unmodelled: string[]
  fainted: number[]
}

export interface MoveEndOutcome {
  attackerDamage: number | null
  statChanges: StatChangeOutcome[] | null
  statusApplied: StatusAppliedOutcome | null
}

/**
 * Cmd_moveend state machine ladder, src/battle_script_commands.c:4309-4968.
 * Walks cases 0 through 30 in numerical C enum order.
 */
export function runMoveEnd(ctx: MoveEndContext): MoveEndOutcome {
  const { state, attackerId, targetId, moveId, targetDamage, hpDealt, deps, unmodelled, fainted } = ctx
  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  const moveData = deps.dataContext.move(moveId)

  let totalAttackerDamage = 0
  let hadAttackerDamage = false
  const statChanges: StatChangeOutcome[] = []
  let statusApplied: StatusAppliedOutcome | null = null

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
  if (moveData?.flags?.danceBased) {
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
  // Attacker contact/move-end abilities (Static, Flame Body, Poison Point/Touch)
  if (attacker && attacker.mon.hp > 0 && targetDamage > 0) {
    const atkAbResult = dispatchMoveEndAttackerAbilities({
      state,
      attackerId,
      targetId,
      moveId,
      moveData,
      targetDamage,
      deps,
      unmodelled,
      fainted,
    })
    if (atkAbResult.statusApplied && !statusApplied) {
      statusApplied = atkAbResult.statusApplied
    }
  }

  // Case 7: MOVEEND_STATUS_IMMUNITY_ABILITIES (:4537-4542)
  // Status immunities loop. Unreachable/no-op in current sim.

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
  if (target && targetDamage > 0 && attacker && attacker.mon.hp > 0) {
    const targetHoldEffect = deps.grounding.holdEffectOf(targetId)
    if (targetHoldEffect === 'HOLD_EFFECT_ROCKY_HELMET') {
      const attackerHoldEffect = deps.grounding.holdEffectOf(attackerId)
      if (isMoveMakingContact(moveData, attacker, attackerHoldEffect) && !isMagicGuardProtected(state, attacker)) {
        const helmetDmg = Math.max(1, Math.floor(attacker.mon.maxHp / 6))
        applyDamage(state, attackerId, helmetDmg, fainted)
        totalAttackerDamage += helmetDmg
        hadAttackerDamage = true
      }
    } else if (targetHoldEffect && TARGET_ITEM_EFFECTS.has(targetHoldEffect)) {
      unmodelled.push(`move-end target hold effect ${targetHoldEffect} is not modelled yet`)
    }
  }

  // Case 14: MOVEEND_ITEM_EFFECTS_ALL (:4666-4671)
  // Item effects for all battlers.

  // Case 15: MOVEEND_KINGSROCK (:4672-4676)
  // King's Rock flinch.

  // Case 16: MOVEEND_SUBSTITUTE (:4714-4722)
  for (const b of state.battlers) {
    if (b && b.volatiles.substituteHp === 0 && hasFlag(b.mon.status2, STATUS2_SUBSTITUTE)) {
      b.mon.status2 = clearFlag(b.mon.status2, STATUS2_SUBSTITUTE)
      b.volatiles.substituteDestroyedThisTurn = true
    }
  }

  // Case 17: MOVEEND_UPDATE_LAST_MOVES (:4723-4772)
  if (attacker) {
    attacker.lastMove = moveId
  }

  // Case 18: MOVEEND_MIRROR_MOVE (:4773-4781)
  // Mirror Move tracking. Not in BattlerState.

  // Case 19: MOVEEND_MULTIHIT_MOVE (:4880-4921)
  // Multi-hit loop. Total-damage resolved in sim.

  // Case 20: MOVEEND_MOVE_EFFECTS2_ON_EACH (:4573-4632)
  if (moveData?.effect && MOVE_EFFECTS2_ON_EACH.has(moveData.effect)) {
    unmodelled.push(`move-end effect ${moveData.effect} is not modelled yet`)
  }

  // Case 21: MOVEEND_NEXT_TARGET (:4782-4822)
  // Double battle second target loop.

  // Case 22: MOVEEND_MOVE_EFFECTS2 (:4633-4655)
  if (moveData?.effect && MOVE_EFFECTS2.has(moveData.effect)) {
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
        applyDamage(state, attackerId, recoilDmg, fainted)
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
  // ABILITYEFFECT_AFTER_RECOIL

  // Case 26: MOVEEND_LIFEORB_SHELLBELL (:4823-4827, :6066-6110)
  if (attacker && attacker.mon.hp > 0 && targetDamage > 0 && attackerId !== targetId) {
    const atkHoldEffect = deps.grounding.holdEffectOf(attackerId)
    if (atkHoldEffect === 'HOLD_EFFECT_LIFE_ORB') {
      const sheerForce = testSheerForceFlag(state, attackerId, moveId, {
        dataContext: deps.dataContext,
        grounding: deps.grounding,
      })
      if (!sheerForce && !isMagicGuardProtected(state, attacker)) {
        const loDmg = Math.max(1, Math.floor(attacker.mon.maxHp / 10))
        applyDamage(state, attackerId, loDmg, fainted)
        totalAttackerDamage += loDmg
        hadAttackerDamage = true
      }
    } else if (atkHoldEffect === 'HOLD_EFFECT_SHELL_BELL') {
      unmodelled.push('move-end Shell Bell heal is not modelled yet')
    }
  }

  // Case 27: MOVEEND_CHANGED_ITEMS (:4656-4665)
  // Changed held items

  // Case 28: MOVEEND_DEFROST (:4444-4456)
  // Frostbite thaw

  // Case 29: MOVEEND_PICKPOCKET (:4828-4853)
  if (target && targetDamage > 0 && battlerHasAbility(target.mon.abilities, 'ABILITY_PICKPOCKET', () => false)) {
    unmodelled.push('move-end Pickpocket is not modelled yet')
  }

  // Case 30: MOVEEND_CLEAR_BITS (:4934-4957)
  if (attacker) {
    if (moveData?.effect !== 'EFFECT_ROLLOUT') {
      attacker.volatiles.rolloutCounter = 0
    }
    attacker.round.targetAffected = false
    attacker.turn.gemBoost = false
  }
  if (target) {
    target.turn.berryReduced = false
  }

  // Rapid Spin hazard clearing gap (per brief item 3)
  if (moveData?.effect === 'EFFECT_RAPID_SPIN') {
    unmodelled.push('Rapid Spin hazard/binding removal is not modelled yet')
  }

  // Knock-out abilities gap (per brief item 3)
  if (fainted.length > 0) {
    for (const b of state.battlers) {
      if (b && b.mon.hp > 0) {
        for (const ab of ON_BATTLER_FAINTS_ABILITIES) {
          if (battlerHasAbility(b.mon.abilities, ab, () => false)) {
            unmodelled.push(`on-faint ability ${ab} is not modelled yet`)
            break
          }
        }
      }
    }
  }

  return {
    attackerDamage: hadAttackerDamage ? totalAttackerDamage : null,
    statChanges: statChanges.length > 0 ? statChanges : null,
    statusApplied,
  }
}
