// Battle-state constants, transcribed from the pinned eliteredux-source checkout
// (SHAs in sources.lock.json). Every value here is copied from the C, not recalled
// from vanilla Pokemon -- ER adds flags (FROSTBITE, BLEED, FEAR, TOXIC_TERRAIN,
// INVERSE_ROOM, FOG weather, ...) and reuses bit positions vanilla leaves free.
//
// The sim keeps the game's own PACKED representation rather than expanding each
// flag into a named boolean. That is deliberate: several of these words are not
// pure flag sets -- STATUS1 carries a 3-bit sleep counter and a 4-bit toxic
// counter in the same u32, STATUS2 carries confusion/uproar/bide/thrash counters
// and a 4-bit "infatuated with battler N" mask, STATUS3 carries the Leech Seed
// receiver's battler id. Expanding them would have to re-invent that packing, and
// the AI port reads them with expressions copied straight from the C
// (`status1 & STATUS1_SLEEP`, `statStages[STAT_EVASION] > 9`), which stays
// auditable line-for-line only if the operand means the same thing here.
//
// `erasableSyntaxOnly` (tsconfig.app.json) bans TS `enum`, so these are `const`
// objects with derived union types, matching engine/types.ts.

// ---------------------------------------------------------------------------
// Sizes and indices
// ---------------------------------------------------------------------------

/** include/constants/global.h:64 */
export const MAX_BATTLERS_COUNT = 4
/** include/constants/global.h:67 */
export const MAX_MON_MOVES = 4
/** include/constants/global.h:79 */
export const PARTY_SIZE = 6
/** include/constants/pokemon.h:464 -- innate slots per species. */
export const NUM_INNATE_PER_SPECIES = 3
/** include/constants/pokemon.h:458 -- `BattlePokemon.abilities[]` length: the
 * chosen ability plus NUM_INNATE_PER_SPECIES innates. */
export const TOTAL_ABILITY_COUNT = 4
/** include/constants/pokemon.h:459 */
export const HELL_MODE_EXTRA_ABILITIES = 3
/** include/battle.h:379 -- BattleHistory.moveHistory depth. */
export const AI_MOVE_HISTORY_COUNT = 3

/** include/constants/pokemon.h:105-112. Index 0 (HP) exists in
 * `BattlePokemon.statStages[]` but is never a stage; 6/7 are battle-only. */
export const STAT_HP = 0
export const STAT_ATK = 1
export const STAT_DEF = 2
export const STAT_SPEED = 3
export const STAT_SPATK = 4
export const STAT_SPDEF = 5
export const STAT_ACC = 6
export const STAT_EVASION = 7
/** include/constants/pokemon.h:120 -- `NUM_STATS + 2`, so statStages[] is 8 long. */
export const NUM_BATTLE_STATS = 8

/** include/constants/pokemon.h:122-124. The C stores stages in 0..12 with 6 as
 * neutral, NOT the -6..+6 the UI shows -- engine/types.ts's BattlerBattleState
 * uses the -6..+6 external form and converts at point of use; the sim uses the
 * internal form so AI branches transcribe unchanged. */
export const MIN_STAT_STAGE = 0
export const DEFAULT_STAT_STAGE = 6
export const MAX_STAT_STAGE = 12

/** include/constants/battle.h:30-33, 39-40, 45. */
export const B_POSITION_PLAYER_LEFT = 0
export const B_POSITION_OPPONENT_LEFT = 1
export const B_POSITION_PLAYER_RIGHT = 2
export const B_POSITION_OPPONENT_RIGHT = 3
export const B_SIDE_PLAYER = 0
export const B_SIDE_OPPONENT = 1
/** include/constants/battle.h:45 -- `GET_BATTLER_SIDE`, position & BIT_SIDE. */
export const BIT_SIDE = 1

/** include/battle.h:25-27 -- the actions a turn loop dispatches on. Only these
 * three are reachable in a trainer battle the solver models (no Safari, no
 * link, no ball throws); the rest of the B_ACTION_* block is omitted rather
 * than transcribed dead. */
export const BATTLE_ACTIONS = ['USE_MOVE', 'USE_ITEM', 'SWITCH'] as const
export type BattleAction = (typeof BATTLE_ACTIONS)[number]
export const B_ACTION_USE_MOVE = 0
export const B_ACTION_USE_ITEM = 1
export const B_ACTION_SWITCH = 2
/** include/battle.h:45 */
export const B_ACTION_NONE = 0xff

// ---------------------------------------------------------------------------
// Bitfield helpers
//
// JS bitwise operators coerce to int32, so a flag at bit 31 (STATUS2_TORMENT)
// reads back negative from `|`. `hasFlag` is safe regardless (a nonzero int32 is
// truthy either way), but `setFlag` re-normalises with `>>> 0` so a stored word
// is always the unsigned value the C holds.
// ---------------------------------------------------------------------------

export function hasFlag(bits: number, flag: number): boolean {
  return (bits & flag) !== 0
}

export function setFlag(bits: number, flag: number): number {
  return (bits | flag) >>> 0
}

export function clearFlag(bits: number, flag: number): number {
  return (bits & ~flag) >>> 0
}

/** Reads a packed counter out of a status word -- `(bits & mask) >> shift` where
 * the shift is the mask's lowest set bit. STATUS1_SLEEP sits at bit 0 so this is
 * an identity there, but STATUS1_TOXIC_COUNTER (bit 8) and STATUS2_UPROAR (bit 4)
 * need it, and the C spells the shift out by hand at each site. */
export function getCounter(bits: number, mask: number): number {
  const shift = 31 - Math.clz32(mask & -mask)
  return (bits & mask) >>> shift
}

/** Writes a packed counter, clearing the field first. Mirrors the C's
 * STATUS1_SLEEP_TURN(n) / STATUS1_TOXIC_TURN(n) / STATUS2_*_TURN(n) macros,
 * which are plain shifts with no range check -- this one masks, so an
 * over-range value truncates rather than corrupting neighbouring flags. */
export function setCounter(bits: number, mask: number, value: number): number {
  const shift = 31 - Math.clz32(mask & -mask)
  return ((bits & ~mask) | ((value << shift) & mask)) >>> 0
}

// ---------------------------------------------------------------------------
// status1 -- include/constants/battle.h:106-138 (the header defines these twice,
// once as #defines and once as the Status1 enum; identical values).
// Persists across switches; stored on the party mon, not just the battler.
// ---------------------------------------------------------------------------

export const STATUS1_NONE = 0
/** 3-bit turn counter, not a flag -- nonzero means asleep with N turns left. */
export const STATUS1_SLEEP = 0x7
export const STATUS1_POISON = 1 << 3
export const STATUS1_BURN = 1 << 4
export const STATUS1_FREEZE = 1 << 5
export const STATUS1_PARALYSIS = 1 << 6
export const STATUS1_TOXIC_POISON = 1 << 7
/** 4-bit counter at bit 8. */
export const STATUS1_TOXIC_COUNTER = 0xf00
/** ER addition (:116). */
export const STATUS1_FROSTBITE = 1 << 12
/** ER addition (:118). */
export const STATUS1_BLEED = 1 << 13
export const STATUS1_POISON_ANY = STATUS1_POISON | STATUS1_TOXIC_POISON
/** :119-120 -- note this deliberately omits STATUS1_TOXIC_COUNTER, so a mon
 * whose toxic counter is set but whose TOXIC_POISON bit was cleared reads as
 * statusless. Transcribed as written. */
export const STATUS1_ANY =
  STATUS1_SLEEP | STATUS1_POISON | STATUS1_BURN | STATUS1_FREEZE | STATUS1_PARALYSIS | STATUS1_TOXIC_POISON | STATUS1_FROSTBITE | STATUS1_BLEED
/** :121 -- statuses that do not stop the mon acting. */
export const STATUS1_CAN_ACT = STATUS1_POISON_ANY | STATUS1_BURN | STATUS1_PARALYSIS | STATUS1_FROSTBITE | STATUS1_BLEED

// ---------------------------------------------------------------------------
// status2 -- include/constants/battle.h:149-204. Cleared on switch out.
// ---------------------------------------------------------------------------

/** 3-bit counter at bit 0. */
export const STATUS2_CONFUSION = 0x7
export const STATUS2_FLINCHED = 1 << 3
/** 3-bit counter at bit 4. */
export const STATUS2_UPROAR = 0x70
export const STATUS2_UNUSED = 1 << 7
/** 2-bit counter at bit 8. */
export const STATUS2_BIDE = 0x300
/** 2-bit counter at bit 10 -- Thrash/Outrage lock. */
export const STATUS2_LOCK_CONFUSE = 0xc00
export const STATUS2_MULTIPLETURNS = 1 << 12
export const STATUS2_WRAPPED = 1 << 13
export const STATUS2_POWDER = 1 << 14
/** 4-bit mask at bit 16, one bit per battler -- see statusInfatuatedWith(). */
export const STATUS2_INFATUATION = 0xf0000
export const STATUS2_FOCUS_ENERGY = 1 << 20
export const STATUS2_TRANSFORMED = 1 << 21
export const STATUS2_RECHARGE = 1 << 22
export const STATUS2_RAGE = 1 << 23
export const STATUS2_SUBSTITUTE = 1 << 24
export const STATUS2_DESTINY_BOND = 1 << 25
export const STATUS2_ESCAPE_PREVENTION = 1 << 26
export const STATUS2_NIGHTMARE = 1 << 27
export const STATUS2_CURSED = 1 << 28
/** ER addition (:173). */
export const STATUS2_ENRAGED = 1 << 29
export const STATUS2_DEFENSE_CURL = 1 << 30
/** Bit 31 -- written unsigned, see the bitfield-helper note above. */
export const STATUS2_TORMENT = 0x80000000

/** STATUS2_INFATUATED_WITH(battler), include/constants/battle.h:163 --
 * `(1 << battler) << 16`. */
export function statusInfatuatedWith(battler: number): number {
  return ((1 << battler) << 16) >>> 0
}

// ---------------------------------------------------------------------------
// gStatuses3 -- include/constants/battle.h:209-275.
// ---------------------------------------------------------------------------

/** 2-bit battler id at bit 0 -- who RECEIVES the drained HP. */
export const STATUS3_LEECHSEED_BATTLER = 0x3
export const STATUS3_LEECHSEED = 1 << 2
/** 2-bit timer at bit 3 (Lock-On), not a flag. */
export const STATUS3_ALWAYS_HITS = 0x18
export const STATUS3_PERISH_SONG = 1 << 5
export const STATUS3_ON_AIR = 1 << 6
export const STATUS3_UNDERGROUND = 1 << 7
export const STATUS3_MINIMIZED = 1 << 8
export const STATUS3_CHARGED_UP = 1 << 9
export const STATUS3_ROOTED = 1 << 10
/** 2-bit counter at bit 11. */
export const STATUS3_YAWN = 0x1800
export const STATUS3_IMPRISONED_OTHERS = 1 << 13
export const STATUS3_GRUDGE = 1 << 14
export const STATUS3_CANT_SCORE_A_CRIT = 1 << 15
export const STATUS3_GASTRO_ACID = 1 << 16
export const STATUS3_EMBARGO = 1 << 17
export const STATUS3_UNDERWATER = 1 << 18
export const STATUS3_INTIMIDATE_POKES = 1 << 19
export const STATUS3_TRACE = 1 << 20
export const STATUS3_SMACKED_DOWN = 1 << 21
export const STATUS3_ME_FIRST = 1 << 22
export const STATUS3_TELEKINESIS = 1 << 23
export const STATUS3_PHANTOM_FORCE = 1 << 24
export const STATUS3_MIRACLE_EYED = 1 << 25
export const STATUS3_MAGNET_RISE = 1 << 26
export const STATUS3_HEAL_BLOCK = 1 << 27
export const STATUS3_AQUA_RING = 1 << 28
export const STATUS3_LASER_FOCUS = 1 << 29
export const STATUS3_POWER_TRICK = 1 << 30
export const STATUS3_SEMI_INVULNERABLE = STATUS3_UNDERGROUND | STATUS3_ON_AIR | STATUS3_UNDERWATER | STATUS3_PHANTOM_FORCE

// ---------------------------------------------------------------------------
// gStatuses4 -- include/constants/battle.h:280-301. Entirely ER-specific.
// ---------------------------------------------------------------------------

export const STATUS4_ELECTRIFIED = 1 << 0
export const STATUS4_PLASMA_FISTS = 1 << 1
export const STATUS4_COILED = 1 << 2
export const STATUS4_SALT_CURE = 1 << 3
export const STATUS4_GHASTLY_ECHO = 1 << 4
export const STATUS4_COMMANDED = 1 << 5
export const STATUS4_DRAGON_CHEER = 1 << 6
/** Distinct from `VolatileStruct.fear` (include/battle.h:150), which is what
 * ShouldSwitch and IsBattlerTrapped actually test
 * (battle_ai_switch_items.c:619, battle_ai_util.c:574). Both exist. */
export const STATUS4_FEAR = 1 << 7
export const STATUS4_CUTTHROAT = 1 << 8
export const STATUS4_FORESIGHT = 1 << 9

// ---------------------------------------------------------------------------
// gSideStatuses -- include/constants/battle.h:332-357. Bit 3 and bit 7 are
// unallocated in this build; transcribed as the gaps they are.
// ---------------------------------------------------------------------------

export const SIDE_STATUS_REFLECT = 1 << 0
export const SIDE_STATUS_LIGHTSCREEN = 1 << 1
export const SIDE_STATUS_STICKY_WEB = 1 << 2
export const SIDE_STATUS_SPIKES = 1 << 4
export const SIDE_STATUS_SAFEGUARD = 1 << 5
export const SIDE_STATUS_FUTUREATTACK = 1 << 6
export const SIDE_STATUS_MIST = 1 << 8
export const SIDE_STATUS_SPIKES_DAMAGED = 1 << 9
export const SIDE_STATUS_TAILWIND = 1 << 10
export const SIDE_STATUS_AURORA_VEIL = 1 << 11
export const SIDE_STATUS_LUCKY_CHANT = 1 << 12
export const SIDE_STATUS_TOXIC_SPIKES = 1 << 13
export const SIDE_STATUS_STEALTH_ROCK = 1 << 14
export const SIDE_STATUS_STEALTH_ROCK_DAMAGED = 1 << 15
export const SIDE_STATUS_TOXIC_SPIKES_DAMAGED = 1 << 16
export const SIDE_STATUS_STICKY_WEB_DAMAGED = 1 << 17
export const SIDE_STATUS_QUICK_GUARD = 1 << 18
export const SIDE_STATUS_WIDE_GUARD = 1 << 19
export const SIDE_STATUS_CRAFTY_SHIELD = 1 << 20
export const SIDE_STATUS_MAT_BLOCK = 1 << 21
export const SIDE_STATUS_SMOKESCREEN = 1 << 22
export const SIDE_STATUS_HAZARDS_ANY = SIDE_STATUS_SPIKES | SIDE_STATUS_STICKY_WEB | SIDE_STATUS_TOXIC_SPIKES | SIDE_STATUS_STEALTH_ROCK
export const SIDE_STATUS_SCREEN_ANY = SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_AURORA_VEIL

// ---------------------------------------------------------------------------
// gFieldStatuses -- include/constants/battle.h:360-377.
// ---------------------------------------------------------------------------

export const STATUS_FIELD_MAGIC_ROOM = 1 << 0
export const STATUS_FIELD_TRICK_ROOM = 1 << 1
export const STATUS_FIELD_WONDER_ROOM = 1 << 2
export const STATUS_FIELD_MUDSPORT = 1 << 3
export const STATUS_FIELD_WATERSPORT = 1 << 4
export const STATUS_FIELD_GRAVITY = 1 << 5
export const STATUS_FIELD_GRASSY_TERRAIN = 1 << 6
export const STATUS_FIELD_MISTY_TERRAIN = 1 << 7
export const STATUS_FIELD_ELECTRIC_TERRAIN = 1 << 8
export const STATUS_FIELD_PSYCHIC_TERRAIN = 1 << 9
export const STATUS_FIELD_ION_DELUGE = 1 << 10
export const STATUS_FIELD_FAIRY_LOCK = 1 << 11
/** :372 -- an overworld thunderstorm makes Electric Terrain permanent. */
export const STATUS_FIELD_TERRAIN_PERMANENT = 1 << 12
/** ER addition (:373). */
export const STATUS_FIELD_INVERSE_ROOM = 1 << 13
/** ER addition (:374) -- a fifth terrain vanilla does not have. */
export const STATUS_FIELD_TOXIC_TERRAIN = 1 << 14
export const STATUS_FIELD_TERRAIN_ANY =
  STATUS_FIELD_GRASSY_TERRAIN | STATUS_FIELD_MISTY_TERRAIN | STATUS_FIELD_ELECTRIC_TERRAIN | STATUS_FIELD_PSYCHIC_TERRAIN | STATUS_FIELD_TOXIC_TERRAIN

// ---------------------------------------------------------------------------
// gBattleWeather -- include/constants/battle.h:393-415.
//
// Each kind has two or three intensity bits held in ONE word, and the game does
// set several at once, so this is a bitfield and not the WeatherKind union that
// engine/types.ts uses for the single-scenario calculator. PERMANENT is the weak
// (ability) tier and TEMPORARY the strong (move) tier -- the opposite of what the
// names suggest; see engine/types.ts's WEATHER_KINDS note.
// ---------------------------------------------------------------------------

export const WEATHER_NONE = 0
export const WEATHER_RAIN_TEMPORARY = 1 << 0
/** :394 -- marked unused in the header. */
export const WEATHER_RAIN_DOWNPOUR = 1 << 1
export const WEATHER_RAIN_PERMANENT = 1 << 2
export const WEATHER_RAIN_PRIMAL = 1 << 3
export const WEATHER_RAIN_ANY = WEATHER_RAIN_TEMPORARY | WEATHER_RAIN_DOWNPOUR | WEATHER_RAIN_PERMANENT | WEATHER_RAIN_PRIMAL
export const WEATHER_SANDSTORM_TEMPORARY = 1 << 4
export const WEATHER_SANDSTORM_PERMANENT = 1 << 5
export const WEATHER_SANDSTORM_ANY = WEATHER_SANDSTORM_TEMPORARY | WEATHER_SANDSTORM_PERMANENT
export const WEATHER_SUN_TEMPORARY = 1 << 6
export const WEATHER_SUN_PERMANENT = 1 << 7
export const WEATHER_SUN_PRIMAL = 1 << 8
export const WEATHER_SUN_ANY = WEATHER_SUN_TEMPORARY | WEATHER_SUN_PERMANENT | WEATHER_SUN_PRIMAL
export const WEATHER_HAIL_TEMPORARY = 1 << 9
export const WEATHER_HAIL_PERMANENT = 1 << 10
export const WEATHER_HAIL_ANY = WEATHER_HAIL_TEMPORARY | WEATHER_HAIL_PERMANENT
export const WEATHER_STRONG_WINDS = 1 << 11
/** ER addition (:409-411) -- fog is real weather here, not a vanilla leftover. */
export const WEATHER_FOG_PERMANENT = 1 << 12
export const WEATHER_FOG_TEMPORARY = 1 << 13
export const WEATHER_FOG_ANY = WEATHER_FOG_PERMANENT | WEATHER_FOG_TEMPORARY
export const WEATHER_ANY = WEATHER_RAIN_ANY | WEATHER_SANDSTORM_ANY | WEATHER_SUN_ANY | WEATHER_HAIL_ANY | WEATHER_STRONG_WINDS | WEATHER_FOG_ANY
export const WEATHER_PRIMAL_ANY = WEATHER_RAIN_PRIMAL | WEATHER_SUN_PRIMAL | WEATHER_STRONG_WINDS
/** :414-415 -- "permanent" here means "does not tick down", and PRIMAL counts. */
export const WEATHER_PERMANENT =
  WEATHER_PRIMAL_ANY | WEATHER_RAIN_PERMANENT | WEATHER_SANDSTORM_PERMANENT | WEATHER_SUN_PERMANENT | WEATHER_HAIL_PERMANENT | WEATHER_FOG_PERMANENT
