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
//  5   | MOVEEND_ABILITIES               | 4527-4531  | Gapped (cond.) | Target contact/move-end abilities (Rough Skin, Iron Barbs, Static...); out of scope per brief.
//  6   | MOVEEND_ABILITIES_ATTACKER      | 4532-4536  | Gapped (cond.) | Attacker move-end abilities (Poison Touch...); out of scope per brief.
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
  STATUS2_CONFUSION,
  STATUS2_ENRAGED,
  STATUS2_MULTIPLETURNS,
  STATUS2_SUBSTITUTE,
  STATUS3_CHARGED_UP,
  clearFlag,
  hasFlag,
} from './constants'
import { hasFlag as abilitySlotsHaveFlag, isIronFistBoosted } from '../abilities/dispatchCalc'
import { battlerHasAbility } from '../abilities/dispatch'
import { isMagicGuardProtected } from './endTurn'
import { testSheerForceFlag } from './statusEffects'
import type { StatChangeOutcome, StatusAppliedOutcome, TurnLoopDeps } from './turn'
import { applyDamage, handleProtectLikeMoveEnd, isAbilityAliveOnOpposingSide } from './turn'
import type { SimMoveData } from './dataContext'

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
  // Target contact/move-end abilities
  if (target && targetDamage > 0) {
    for (const ab of ON_DEFENDER_ABILITIES) {
      if (battlerHasAbility(target.mon.abilities, ab, () => false)) {
        unmodelled.push(`move-end defender ability ${ab} is not modelled yet`)
        break
      }
    }
  }

  // Case 6: MOVEEND_ABILITIES_ATTACKER (:4532-4536)
  // Attacker contact/move-end abilities (e.g. Poison Touch)
  if (attacker && targetDamage > 0) {
    for (const ab of ON_ATTACKER_ABILITIES) {
      if (battlerHasAbility(attacker.mon.abilities, ab, () => false)) {
        unmodelled.push(`move-end attacker ability ${ab} is not modelled yet`)
        break
      }
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
