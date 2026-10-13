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
// 15   | MOVEEND_KINGSROCK               | 4672-4676  | Ported / Gap   | Ported: King's Rock / Razor Fang flinch (battle_util.c:6034-6052). Blunder Policy (:6053-6061) gapped; multi-hit moves gapped.
// 16   | MOVEEND_SUBSTITUTE              | 4714-4722  | Ported         | Clears STATUS2_SUBSTITUTE and sets substituteDestroyedThisTurn if substituteHp is 0.
// 17   | MOVEEND_UPDATE_LAST_MOVES       | 4723-4772  | Ported         | attacker.lastMove = moveId (the only field existing in state.ts).
// 18   | MOVEEND_MIRROR_MOVE             | 4773-4781  | Unreachable    | Mirror move tracking; not modeled in BattlerState.
// 19   | MOVEEND_MULTIHIT_MOVE           | 4880-4921  | Unreachable    | Multi-hit loop; resolved upstream in calculateMoveDamage / attackCanceller.
// 20   | MOVEEND_MOVE_EFFECTS2_ON_EACH   | 4573-4632  | Ported / Gap   | Ported: Knock Off (:4268-4288), Thief (:4579-4593), Bug Bite (:4595-4597, EatTargetBerry :13221) minus the berry's own effect (gapped), Smack Down (:4598-4606).
// 21   | MOVEEND_NEXT_TARGET             | 4782-4822  | Unreachable    | Double battle second target iteration; sim is single battle.
// 22   | MOVEEND_MOVE_EFFECTS2           | 4633-4655  | Gapped (cond.) | Post-target-item move effects (Make It Rain, Burn Up, Scale Shot, Wyrm Wind).
// 23   | MOVEEND_RECOIL                  | 4457-4517  | Ported         | Recoil self-damage; Magic Guard, noRecoil (Rock Head/Steel Barrel/Bruteforce), halfRecoil.
// 24   | MOVEEND_CHARGE                  | 4922-4933  | Ported         | Clears STATUS3_CHARGED_UP on Electric damaging move.
// 25   | MOVEEND_ABILITIES_AFTER_RECOIL  | 4518-4522  | Gapped (cond.) | ABILITYEFFECT_AFTER_RECOIL hook.
// 26   | MOVEEND_LIFEORB_SHELLBELL       | 4823-4827  | Ported         | Life Orb (floor(maxHp/10) self-damage, Sheer Force/Magic Guard checks) and Shell Bell (savedDmg/4, min 1).
// 27   | MOVEEND_CHANGED_ITEMS           | 4656-4665  | Ported         | Assigns the stolen item Thief parked in changedItems at Case 20.
// 28   | MOVEEND_DEFROST                 | 4444-4456  | Unreachable    | Frostbite cured by fire move on target.
// 29   | MOVEEND_PICKPOCKET              | 4828-4853  | Gapped (cond.) | Pickpocket item theft; gapped if target has ABILITY_PICKPOCKET.
// 30   | MOVEEND_CLEAR_BITS              | 4934-4957  | Ported         | Clears rolloutCounter (if not Rollout), targetAffected, gemBoost, berryReduced.
// --------------------------------------------------------------------------------------------------------------------------------------------------------------------

import type { MoveBehaviors } from '../basePower'
import type { BattleState, BattlerState } from './state'
import {
  DEFAULT_STAT_STAGE,
  ENUM_WEATHER_SANDSTORM,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_TOXIC_SPIKES,
  STATUS2_CONFUSION,
  STATUS2_CURSED,
  STATUS2_ENRAGED,
  STATUS2_FLINCHED,
  STATUS2_MULTIPLETURNS,
  STATUS2_SUBSTITUTE,
  STATUS2_WRAPPED,
  STATUS3_CHARGED_UP,
  STATUS3_MAGNET_RISE,
  STATUS3_ON_AIR,
  STATUS3_SMACKED_DOWN,
  STATUS3_TELEKINESIS,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_TERRAIN_ANY,
  STATUS_FIELD_TERRAIN_PERMANENT,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  WEATHER_PRIMAL_ANY,
  WEATHER_SANDSTORM_ANY,
  clearFlag,
  hasFlag,
  setFlag,
  statusInfatuatedWith,
} from './constants'
import { hasFlag as abilitySlotsHaveFlag, isIronFistBoosted } from '../abilities/dispatchCalc'
import { battlerHasAbility } from '../abilities/dispatch'
import type { AbilitySlots } from '../abilities/dispatch'
import { canBattlerHeal, isMagicGuardProtected } from './endTurn'
import { isBattlerGrounded } from './grounding'
import { syncPartyHp } from './outcome'
import { resolveMultihitType } from './attackCanceller'
import {
  CHECK_FLINCH,
  CHECK_RESTRICTING,
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_FLINCH,
  MOVE_EFFECT_PARALYSIS,
  MOVE_EFFECT_POISON,
  MOVE_EFFECT_SLEEP,
  applyPrimaryStatusEffect,
  canBeBurned,
  canBeParalyzed,
  canBePoisoned,
  canInfatuate,
  canSleep,
  doesSubstituteBlockMove,
  isAbilityStatusProtected,
  isPowderImmune,
  isPreventableSecondaryEffect,
  testSheerForceFlag,
} from './statusEffects'
import type { StatusDeps } from './statusEffects'
import {
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
  getHighestAttackingStatId,
  isSimAbilitySuppressed,
} from './statBuffs'
import type { StatChangeOutcome, StatusAppliedOutcome, TurnLoopDeps } from './turn'
import { applyDamage, handleProtectLikeMoveEnd, isAbilityAliveOnOpposingSide, isBattlerAlive } from './turn'
import type { SimDataContext, SimMoveData } from './dataContext'
import { tryChangeBattleWeather } from './switchInAbility'

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

export interface MoveEndAbilitiesContext {
  state: BattleState
  attackerId: number
  targetId: number
  moveId: string
  moveData: SimMoveData | undefined
  targetDamage: number
  hpDealt?: number
  isCriticalHit?: boolean
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
      applyDamage(state, attackerId, dmg, fainted)
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

  if (abilityId === 'ABILITY_BALLOON_BOMBER' && target.mon.hp <= 0) {
    unmodelled.push("Balloon Bomber's Aftermath half (UseOutOfTurnAttack Explosion/Outburst on faint, abilities.cc:7761) is not modelled")
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
      }
    }
  }

  // 23. Seed Sower (src/abilities.cc:6859-6866, battle_util.c:3778-3795)
  if (abilityId === 'ABILITY_SEED_SOWER') {
    if (
      target.mon.hp > 0 &&
      !hasFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN) &&
      !hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_PERMANENT)
    ) {
      state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_TERRAIN_ANY)
      state.field.statuses = setFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)
      state.field.timers.started.terrain = true
      state.field.timers.terrainBattlerId = targetId
      const heldEffect = deps.grounding.holdEffectOf(targetId)
      state.field.timers.terrainTimer = heldEffect === 'HOLD_EFFECT_TERRAIN_EXTENDER' ? 12 : 8
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
        unmodelled.push('Disable move lock is not modelled yet: CANCELLER_DISABLED is not implemented in turn loop')
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

  // 28. Electromorphosis family (src/abilities.cc:5299-5308, 5313)
  if (abilityId === 'ABILITY_ELECTROMORPHOSIS' || abilityId === 'ABILITY_ATOMIC_BURST') {
    if (target.mon.hp > 0 && !hasFlag(target.statuses3, STATUS3_CHARGED_UP)) {
      target.statuses3 = setFlag(target.statuses3, STATUS3_CHARGED_UP)
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

  for (let i = 0; i < state.battlersCount; i++) {
    const holder = state.battlers[i]
    if (!holder || !isBattlerAlive(state, i)) continue

    for (const { abilityId } of getBattlerAbilitySlotsReverse(holder.mon.abilities)) {
      const flag = ON_BATTLER_FAINTS_FOR[abilityId]
      if (!flag || !faintHookApplies(flag, i, faintedId, byAttacker ? attackerId : null)) continue
      if (isSimAbilitySuppressed(state, holder, abilityId, false, attackerId, false, deps.dataContext)) continue

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
  const hasAbility = (b: BattlerState, id: string) => battlerHasAbility(b.mon.abilities, id, () => false)
  if (hasAbility(battler, 'ABILITY_UNBURDEN') || hasAbility(battler, 'ABILITY_SUGAR_RUSH')) {
    unmodelled.push("UpdateBattlerItem's Unburden / Sugar Rush ability state (battle_script_commands.c:2198-2204) is not modelled")
  }
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
  const hasAbility = (id: string) => battlerHasAbility(attacker.mon.abilities, id, () => false)
  if (hasAbility('ABILITY_UNBURDEN') || hasAbility('ABILITY_SUGAR_RUSH')) {
    unmodelled.push("UpdateBattlerItem's Unburden / Sugar Rush ability state reset (battle_script_commands.c:2194-2197) is not modelled")
  }
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

export interface MoveEndContext {
  state: BattleState
  attackerId: number
  targetId: number
  moveId: string
  targetDamage: number
  /** gTurnStructs[attacker].savedDmg -- the HP actually removed from the target (gHpDealt, :4335). */
  hpDealt: number
  isCriticalHit?: boolean
  /** gBattleStruct->moveEffect2, set by seteffectwithchance (moveEffects.ts applySecondaryMoveEffects). */
  moveEffect2?: string | null
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

  // Case 17: MOVEEND_UPDATE_LAST_MOVES (:4723-4772)
  if (attacker) {
    attacker.lastMove = moveId
  }

  // Case 18: MOVEEND_MIRROR_MOVE (:4773-4781)
  // Mirror Move tracking. Not in BattlerState.

  // Case 19: MOVEEND_MULTIHIT_MOVE (:4880-4921)
  // Multi-hit loop. Total-damage resolved in sim.

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

  return {
    attackerDamage: hadAttackerDamage ? totalAttackerDamage : null,
    statChanges: statChanges.length > 0 ? statChanges : null,
    statusApplied,
  }
}
