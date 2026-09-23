// The battle simulator's state model. Pure data -- no behaviour lives here.
//
// Shape derived from the game's own structures at the pinned SHA, not from
// general Pokemon knowledge: `include/battle.h` for the per-battler, per-side and
// per-field structs and the globals that hold them, `include/pokemon.h` for
// `struct BattlePokemon`. Field-level citations are inline. Where ER's struct
// differs from what the name suggests (fear living on VolatileStruct as well as
// in gStatuses4, `usedMoves` being a per-SLOT reveal mask rather than a history,
// two separate switch-target arrays) the note says so.
//
// What is deliberately NOT here, per docs/battle-sim/plan.md's "statistically
// faithful, not bit-exact" decision: anything whose only purpose is reproducing
// the game's RNG call sequence. `gRngValue` is not threaded; a seeded source
// (rng.ts) stands in for it. Graphics, link-battle, Battle Frontier, Safari,
// Battle Palace/Arena and Battle TV state are omitted outright.

import type { BattleStatKey } from '../types'
import type { AbilitySlots } from '../abilities/dispatch'
import { NUM_BATTLE_STATS, DEFAULT_STAT_STAGE, MAX_MON_MOVES, AI_MOVE_HISTORY_COUNT, NUM_INNATE_PER_SPECIES, TOTAL_ABILITY_COUNT, HELL_MODE_EXTRA_ABILITIES } from './constants'

/** A per-move-slot tuple. The C stores `moves[4]`, `pp[4]`,
 * `BattleHistory.usedMoves[battler][4]` and `AI_ThinkingStruct.score[4]` as
 * separate parallel arrays indexed by the same 0-3 slot, and several places key
 * off the slot rather than the move id (`gBattleStruct->chosenMovePositions`,
 * `AI_DATA->simulatedDmg[..][..][moveIndex]`). Keeping them parallel preserves
 * that identity. */
export type Slot4<T> = [T, T, T, T]

/** `statStages[NUM_BATTLE_STATS]`, pokemon.h:181 -- 8 entries indexed by the
 * STAT_* constants. Index 0 (STAT_HP) is present in the C array and never used
 * as a stage; indices 6 and 7 are accuracy and evasion, which the AI reads
 * directly (`statStages[STAT_EVASION] > 9`, battle_ai_main.c:2726). Values are
 * the C's INTERNAL 0..12 with 6 neutral, not the -6..+6 the UI shows. */
export type StatStages = number[]

// ---------------------------------------------------------------------------
// Per-battler
// ---------------------------------------------------------------------------

/** `struct BattlePokemon`, include/pokemon.h:158-196 -- the active copy of a
 * party mon while it is on the field.
 *
 * Omitted from the C struct, with reasons: `experience`, `otId`, `personality`,
 * `nickname`, `otName`, `friendship`, `ppBonuses` (no effect on any AI score or
 * damage path), `wasalreadytotemboosted` (totem boosts are a wild-battle
 * mechanic, and the 40 fights are all trainer battles), `abilityNum` (superseded
 * by the resolved `abilities` slots below). `personality` would also be needed
 * for Illusion, which SetBattlerData stubs out anyway -- ShouldFailForIllusion
 * is `return FALSE` at battle_ai_util.c:518. */
export interface SimBattleMon {
  speciesId: string // SpeciesEnum species (:164) -- exact SPECIES_* id
  /** `u16 stats[5]` / the attack..spDefense union (:165-174). Out-of-battle
   * stats with nature and EVs already applied; CalculateStat's in-battle
   * modifiers are applied on top by the damage engine, not stored here. */
  rawStats: Record<BattleStatKey, number>
  moves: Slot4<string | null> // MoveEnum moves[MAX_MON_MOVES] (:175); null == MOVE_NONE
  pp: Slot4<number> // u8 pp[MAX_MON_MOVES] (:185)
  hp: number // u16 hp (:178)
  maxHp: number // u16 maxHP (:179)
  itemId: string | null // ItemEnum item (:180); null == ITEM_NONE
  statStages: StatStages // s8 statStages[NUM_BATTLE_STATS] (:181)
  /** `Type type1/type2/type3` (:182-184) as a fixed triple. 'MYSTERY' is the
   * C's TYPE_MYSTERY sentinel for "no type here" -- SET_BATTLER_TYPE
   * (battle.h:755-760) writes it into type3 explicitly, so this is a live value
   * mid-battle, not just an absent slot. Matches engine/typeEffectiveness.ts's
   * `noneType` default. */
  types: [string, string, string]
  level: number // u8 level (:186)
  nature: string // u8 nature (:191) -- bare NATURE_* id, as natures.json spells it
  /** `u8 hpType` (:192) -- Hidden Power / Secret Power / Techno Blast's type.
   * NOT derived from IVs in ER; an independently random BoxMon field at creation
   * (src/pokemon.c:573-579). See engine/types.ts's hiddenPowerType note. */
  hiddenPowerType: string | null
  /** `u8 speedDown:1` (:194) -- the "iron pill" flag that zeroes the Speed IV
   * alone. Every other IV is forced to 31 on each recalculation
   * (src/pokemon.c:988-994), so this is the only IV state the sim carries. */
  speedDown: boolean
  /** `AbilityEnum abilities[TOTAL_ABILITY_COUNT]` (:176), resolved to the
   * engine's existing slot shape: slot 0 the chosen ability, 1-3 the innates.
   * `extraAbilities[HELL_MODE_EXTRA_ABILITIES]` (:177) is omitted -- Hell mode
   * is backlog per the plan's scope decision 2. */
  abilities: AbilitySlots
  /** GetGenderFromSpeciesAndPersonality's result, carried explicitly rather than
   * derived from `personality` (which is not modelled) -- same precedent as
   * engine/types.ts's BattlerBattleState.gender. */
  gender: 'MALE' | 'FEMALE' | 'GENDERLESS'
  /** `Status1 status1` (:161) -- packed, see constants.ts. Persists across
   * switches: it is copied back to the party mon, so the reserve roster carries
   * it too (SimPartyMon.status1). */
  status1: number
  /** `Status2 status2` (:162) -- packed. Cleared on switch out, so it has no
   * party-mon counterpart. */
  status2: number
}

/** `struct VolatileBeganThisTurn`, include/battle.h:77-87 -- "this volatile was
 * set THIS turn", so end-of-turn processing skips its first tick. */
export interface VolatileBeganThisTurn {
  violentRush: boolean
  rapidResponse: boolean
  readiedAction: boolean
  showdownMode: boolean
  fear: boolean
  onTheProwl: boolean
  dazed: boolean
  drenched: boolean
  trepidation: boolean
}

/** `struct VolatileStruct`, include/battle.h:89-162 (gVolatileStructs,
 * battle.h:1006) -- per-battler state that survives a turn but not a switch.
 * Transcribed whole rather than trimmed to the AI's current readers: the
 * research note names only disableTimer/protectUses/fear/skyDropped as the
 * minimum, but the port's later batches read most of the rest, and a partial
 * transcription is where "looks right, is subtly wrong" enters.
 *
 * Bit widths from the C are preserved as range notes, not as types -- the
 * narrow ones are load-bearing (`rolloutCounter:2` caps at 3, which is why
 * Cmd_handlerollout's own `< 3` gate makes 3 the ceiling in normal play). */
export interface VolatileState {
  transformedMonPersonality: number
  /** `u32 abilityState[NUM_INNATE_PER_SPECIES + 1]` -- one per ability slot,
   * same indexing as SimBattleMon.abilities. GetAbilityState's backing store. */
  abilityState: number[]
  started: VolatileBeganThisTurn
  disabledMove: string | null
  encoredMove: string | null
  wrapAbility: string | null
  protectUses: number
  stockpileCounter: number
  stockpileDef: number
  stockpileSpDef: number
  stockpileBeforeDef: number
  stockpileBeforeSpDef: number
  substituteHp: number
  /** `bool8 switchInAbilityDone[TOTAL_ABILITY_COUNT + HELL_MODE_EXTRA_ABILITIES]`
   * -- 7 entries. Sized from the C even though Hell mode's extra 3 are out of
   * scope, because the index space is what the C writes into. */
  switchInAbilityDone: boolean[]
  battlerPreventingEscape: number
  battlerWithSureHit: number
  isFirstTurn: number
  rechargeTimer: number
  autotomizeCount: number
  slowStartTimer: number
  embargoTimer: number
  magnetRiseTimer: number
  telekinesisTimer: number
  healBlockTimer: number
  laserFocusTimer: number
  throatChopTimer: number
  encoredMovePos: number
  furyCutterCounter: number
  /** ER's "extra stat levels" -- a separate additive track from statStages that
   * cannot be copied or reset. engine/types.ts carries the same five as
   * BattlerBattleState.extraStatLevel. */
  extraAttackLevel: number
  extraDefenseLevel: number
  extraSpAttackLevel: number
  extraSpDefenseLevel: number
  extraSpeedLevel: number
  disableTimer: number // :4
  disableTimerStartValue: number // :4
  encoreTimer: number // :4
  encoreTimerStartValue: number // :4
  perishSongTimer: number // :4
  perishSongTimerStartValue: number // :4
  rolloutCounter: number // :2 -- 0..3
  tauntTimer: number // :4
  tauntTimer2: number // :4
  mimickedMoves: number // :4 -- a per-slot bitmask, not a count
  usedMoves: number // :4 -- a per-slot bitmask, not a count
  wrapTurns: number
  noRetreat: boolean
  tarShot: boolean
  octolock: boolean
  hasBeenOnBattle: boolean
  substituteDestroyedThisTurn: boolean
  disciplineCounter: number // :4
  syrupBombIsShiny: boolean
  ghastlyEchoTimer: number // :2
  syrupTimer: number // :2
  violentRush: boolean
  rapidResponse: boolean
  readiedAction: boolean
  showdownMode: boolean
  parasiticSpores: boolean
  critBoost: number // :2
  /** The flag ShouldSwitch (battle_ai_switch_items.c:619) and IsBattlerTrapped
   * (battle_ai_util.c:574) actually test -- STATUS4_FEAR is a separate bit that
   * these two do not read. Both exist in the game; keep them distinct. */
  fear: boolean
  onTheProwl: boolean
  trickOrTreat: boolean
  skyDropped: boolean
  skyDroppedBy: number // :2
  shouldClearSkyDrop: boolean
  dazed: number // :3
  trepidation: number // :2
  hazardDamaged: boolean
  iceStatue: boolean
  usedMonotypeEntry: boolean
  drenched: number // :2
}

/** `struct RoundStruct`, include/battle.h:164-206 (gRoundStructs, battle.h:1011)
 * -- per-battler state for ONE turn. battle_ai_main.c:200 memsets this as a side
 * effect of scoring, preserving only `protectMove`; that quirk belongs to the AI
 * batch, but it is why protectMove is the one field that outlives scoring. */
export interface RoundState {
  physicalDmg: number
  specialDmg: number
  protectMove: string | null
  physicalBattlerId: number
  specialBattlerId: number
  endured: boolean
  noValidMoves: boolean
  helpingHand: boolean
  bounceMove: boolean
  stealMove: boolean
  prlzImmobility: boolean
  targetAffected: boolean
  chargingTurn: boolean
  fleeFlag: number // :2 -- Run Away and Smoke Ball
  usedImprisonedMove: boolean
  loveImmobility: boolean
  usedDisabledMove: boolean
  usedTauntedMove: boolean
  /** The C's `flag2Unknown`, kept under its own name: "Only set to 0 once.
   * Checked in 'WasUnableToUseMove'" (battle.h:183). Renaming it to a guess
   * would be inventing a meaning the source does not state. */
  flag2Unknown: boolean
  flinchImmobility: boolean
  notFirstStrike: boolean
  palaceUnableToUseMove: boolean
  usesBouncedMove: boolean
  usedHealBlockedMove: boolean
  usedGravityPreventedMove: boolean
  powderSelfDmg: boolean
  usedThroatChopPreventedMove: boolean
  statRaised: boolean
  usedMicleBerry: boolean
  usedCustapBerry: boolean // also Quick Claw
  touchedProtectLike: boolean
  disableEjectPack: boolean
  statFell: boolean
  quickDraw: boolean
  glaiveRush: boolean
  attackCancelled: boolean
  afterYou: boolean
  damaged: boolean
  safePassage: boolean
  confusionSelfDmg: boolean
  waterlog: boolean
}

/** `struct TurnStruct`, include/battle.h:208-246 (gTurnStructs, battle.h:1012)
 * -- per-battler state for the current move resolution. `restoredBattlerSprite`
 * (:229) is the one field omitted; it is graphics only. */
export interface TurnState {
  dmg: number
  physicalDmg: number
  specialDmg: number
  savedDmg: number
  parentalBondTrigger: string | null // the ABILITY that triggered it
  flungItem: string | null
  redirectedAbility: string | null
  sturdyAbility: string | null
  /** `bool8 turnAbilityTriggers[NUM_INNATE_PER_SPECIES + 1]` -- one per ability
   * slot, same indexing as SimBattleMon.abilities. */
  turnAbilityTriggers: boolean[]
  gemParam: number
  physicalBattlerId: number
  specialBattlerId: number
  changedStatsBattlerId: number
  multiHitsUsed: number // :4
  damagedMons: number // :4 -- a battler bitmask
  mirrorHerbStat: number // :4
  multiHitCounter: number // :4
  parentalBondOn: number // :3
  parentalBondInitialCount: number // :3
  statLowered: boolean
  intimidatedMon: boolean
  scaredMon: boolean
  traced: boolean
  flag40: boolean
  focusBanded: boolean
  focusSashed: boolean
  sturdied: boolean
  switchInItemDone: boolean
  berryReduced: boolean
  gemBoost: boolean
  rototillerAffected: boolean
  dancerUsedMove: boolean
  neutralizingGasRemoved: boolean
  shouldTriggerSwitchItem: boolean
  haloed: boolean
  sleepTalk: boolean
}

/** Everything the sim holds about one on-field battler. The C spreads this
 * across five parallel arrays indexed by battler id (gBattleMons,
 * gStatuses3/4, gVolatileStructs, gRoundStructs, gTurnStructs -- battle.h:964,
 * 1004-1006, 1011-1012); grouping them per battler is the one structural
 * departure from the C's layout, and it changes no semantics because every one
 * of those arrays is indexed by the same battler id. */
export interface BattlerState {
  /** Battler id 0-3, equal to this battler's index in `BattleState.battlers`.
   * In singles only 0 (player) and 1 (opponent) are live. Stored rather than
   * inferred so a BattlerState is meaningful when passed on its own. */
  id: number
  mon: SimBattleMon
  statuses3: number // Status3 gStatuses3[] (battle.h:1004) -- packed
  statuses4: number // Status4 gStatuses4[] (battle.h:1005) -- packed
  volatiles: VolatileState
  round: RoundState
  turn: TurnState
  /** `gBattlerPartyIndexes[MAX_BATTLERS_COUNT]` (battle.h:958) -- which party
   * slot this battler is. ShouldSwitch skips it when counting reserves
   * (battle_ai_switch_items.c:658-661). */
  partyIndex: number
  /** `gLastMoves[MAX_BATTLERS_COUNT]` (battle.h:988). Piece 8 of the research
   * note's list, alongside BattleHistory.usedMoves. */
  lastMove: string | null
  /** `gBattleStruct->monToSwitchIntoId[MAX_BATTLERS_COUNT]` (battle.h:622) --
   * the party slot a pending switch will bring in. PARTY_SIZE (6) means "none
   * pending": battle_main.c:3522 initialises every entry to it and
   * battle_ai_switch_items.c:980 tests for it by name. */
  monToSwitchIntoId: number
  /** `gBattleStruct->AI_monToSwitchIntoId[MAX_BATTLERS_COUNT]` (battle.h:677) --
   * a SECOND, distinct array. ShouldSwitch reads the first when counting
   * available reserves (:662-665); ShouldPivot reads this one to decide whether
   * the mon it would bring in should avoid hazards (battle_ai_util.c:1884, then
   * the hazard call at :1887). Same PARTY_SIZE sentinel, initialised at
   * battle_main.c:2710. The research note lists only `monToSwitchIntoId`; both
   * are required. */
  aiMonToSwitchIntoId: number
  /** `gBattleStruct->sameMoveTurns[MAX_BATTLERS_COUNT]` (battle.h, read/written
   * by Cmd_ppreduce, battle_script_commands.c:1486-1493) -- another
   * per-battler gBattleStruct field, same precedent as monToSwitchIntoId
   * above. Cmd_ppreduce's own increment branch requires
   * `gTurnStructs[battler].parentalBondOn > 0`, which this sim never sets
   * (multi-hit/Parental Bond sequencing is not modelled), so ppreduce's port
   * always takes the reset-to-0 branch -- see turn.ts's deductPp. */
  sameMoveTurns: number
}

// ---------------------------------------------------------------------------
// Reserve party
// ---------------------------------------------------------------------------

/** One reserve party member, as `ShouldSwitch` and its helpers read it through
 * `GetMonData(&party[i], ...)`. The fields are exactly the MON_DATA_* keys those
 * functions ask for -- SPECIES/SPECIES2, HP, MAX_HP, LEVEL, MOVE1..4, ATK,
 * SPATK, ABILITY_NUM (battle_ai_switch_items.c, every GetMonData call site) plus
 * HELD_ITEM and the ability/innate lookup PartyBattlerShouldAvoidHazards needs
 * (battle_ai_util.c:1840-1868).
 *
 * `speciesId === null` is the C's SPECIES_NONE (an empty party slot); ShouldSwitch
 * skips those and eggs at :654-657. Eggs cannot occur in the 40 fights and are
 * not modelled. */
export interface SimPartyMon {
  speciesId: string | null
  hp: number
  maxHp: number
  level: number
  moves: Slot4<string | null>
  pp: Slot4<number>
  itemId: string | null
  abilities: AbilitySlots
  /** Only ATK and SPATK are read from a reserve mon (ShouldSwitchIfAllBadMoves'
   * stat comparison), but the full spread is carried: the mon has to be sent out
   * eventually, at which point it becomes a SimBattleMon. */
  rawStats: Record<BattleStatKey, number>
  nature: string
  hiddenPowerType: string | null
  speedDown: boolean
  gender: 'MALE' | 'FEMALE' | 'GENDERLESS'
  /** Carried on the party mon because status1 persists across switches -- unlike
   * status2, which is cleared on switch out. */
  status1: number
  /** `Type type1/type2/type3` -- NOT carried by `struct BattlePokemon` on the
   * reserve side (types are computed from species+personality via
   * Cmd_switchindataupdate's own RandomizeType calls, battle_script_commands.c:
   * 5016-5020, at the moment a mon takes the field). Added here (batch: faint
   * replacement) because switchIn.ts has to build a full SimBattleMon from a
   * SimPartyMon and every other required field already existed on this
   * interface -- types was the one gap. A reserve mon's types do not change
   * while it sits in the party (no form-change/Multitype mechanic reaches a
   * benched mon), so this is a battle-start-derivable fact like `rawStats`,
   * not state that goes stale mid-battle. */
  types: [string, string, string]
}

// ---------------------------------------------------------------------------
// Per-side
// ---------------------------------------------------------------------------

/** `struct SideBeganThisTurn`, include/battle.h:248-263. */
export interface SideBeganThisTurn {
  reflect: boolean
  lightscreen: boolean
  mist: boolean
  safeguard: boolean
  followme: boolean
  auroraVeil: boolean
  tailwind: boolean
  luckyChant: boolean
  spiderWeb: boolean
  swamp: boolean
  fireSea: boolean
  rainbow: boolean
  smokescreen: boolean
  quickGuard: boolean
}

/** `struct SideTimer`, include/battle.h:265-298 (gSideTimers, battle.h:1003).
 * The `*BattlerId` fields record who set the effect -- they matter for Brick
 * Break-class removal and for crediting damage, so they are not decoration. */
export interface SideTimerState {
  started: SideBeganThisTurn
  reflectTimer: number
  reflectBattlerId: number
  lightscreenTimer: number
  lightscreenBattlerId: number
  mistTimer: number
  mistBattlerId: number
  safeguardTimer: number
  safeguardBattlerId: number
  followmeTimer: number
  /** Hazard LAYER counts, not timers -- Spikes stacks to 3, Toxic Spikes to 2.
   * The presence bit lives in the side's status word; the depth lives here. */
  spikesAmount: number
  toxicSpikesAmount: number
  /** Stealth Rock's TYPE in ER, not a timer -- the hazard is not hardcoded to
   * Rock here. */
  stealthRockType: number
  auroraVeilTimer: number
  auroraVeilBattlerId: number
  tailwindTimer: number
  tailwindBattlerId: number
  luckyChantTimer: number
  luckyChantBattlerId: number
  retaliateTimer: number
  stickyWebTimer: number
  swampTimer: number
  fireSeaTimer: number
  rainbowTimer: number
  smokescreenTimer: number // :3
  smokescreenBattler: number // :2
  followmeTarget: number // :3
  followmePowder: boolean // Rage Powder -- does not affect Grass types
  hotCoals: boolean
  caltrops: boolean
  quickGuardTimer: number // :3
  foamyWeb: boolean
}

/** One side of the field. `statuses` is `gSideStatuses[2]` (battle.h:1001),
 * `faintedCount` is `gFaintedMonCount[2]` (battle.h:1002) -- which Soul Harvest
 * and Supreme Overlord read, and which engine/types.ts already exposes to the
 * damage path as `alliesFainted`. */
export interface SideState {
  statuses: number
  timers: SideTimerState
  faintedCount: number
  /** The reserve roster for this side, party slot order. Up to PARTY_SIZE. */
  party: SimPartyMon[]
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

/** `struct FieldBeganThisTurn`, include/battle.h:300-313. */
export interface FieldBeganThisTurn {
  mudSport: boolean
  waterSport: boolean
  wonderRoom: boolean
  magicRoom: boolean
  trickRoom: boolean
  terrain: boolean
  gravity: boolean
  fairyLock: boolean
  inverseRoom: boolean
  weather: boolean
  quash: boolean
  clearSkiesTimer: boolean
}

/** `struct FieldTimer`, include/battle.h:315-331 (gFieldTimers, battle.h:1047). */
export interface FieldTimerState {
  started: FieldBeganThisTurn
  mudSportTimer: number
  waterSportTimer: number
  wonderRoomTimer: number
  magicRoomTimer: number
  trickRoomTimer: number
  terrainTimer: number
  terrainBattlerId: number
  gravityTimer: number
  fairyLockTimer: number
  inverseRoomTimer: number
  quashTimer: number
  fogReturnTimer: number
  clearSkiesTimer: number
  neutralizingGas: boolean // :1
}

/** Field-wide state: `gFieldStatuses` (battle.h:1046), `gBattleWeather`
 * (battle.h:1013) and `gFieldTimers` (battle.h:1047).
 *
 * Both words are packed bitfields here, unlike engine/types.ts's
 * ConditionFieldContext which uses a single WeatherKind string. The calculator
 * only ever describes one scenario; the sim has to hold what the game holds,
 * and gBattleWeather really does carry several bits at once (the *_ANY masks
 * exist for exactly that reason). */
export interface FieldState {
  statuses: number
  weather: number
  timers: FieldTimerState
  /** `gWishFutureKnock.weatherDuration` (battle.h:340) -- weather's own countdown,
   * which lives outside gFieldTimers. The rest of WishFutureKnock (Wish, Future
   * Sight) is not modelled yet; those are move behaviours, step 5. */
  weatherDuration: number
}

// ---------------------------------------------------------------------------
// Battle history (what the AI is allowed to know)
// ---------------------------------------------------------------------------

/** `struct BattleHistory`, include/battle.h:381-388 -- the AI's knowledge of the
 * player, and the whole mechanism behind the plan's "the AI's estimate is
 * knowably wrong" note. SetBattlerData (battle_ai_util.c:520-543) BLANKS the
 * player's held item while `itemEffects` is 0 and blanks every move slot whose
 * `usedMoves` entry is 0, before scoring runs.
 *
 * `usedMoves[battler][slot]` is therefore a per-SLOT reveal mask holding the
 * move id, not a chronological list -- the name suggests history and the
 * indexing says otherwise. `moveHistory[battler][0..2]` with `moveHistoryIndex`
 * is the actual ring buffer of the last three moves. */
export interface BattleHistoryState {
  /** Per battler: the hold effect the AI has observed trigger. 0 means "not yet
   * seen", which is what conceals the item. */
  itemEffects: number[]
  /** Per battler, per move slot: the revealed move id, or null for a slot the
   * AI has not seen used. */
  usedMoves: Slot4<string | null>[]
  /** Per battler: the last AI_MOVE_HISTORY_COUNT (3) moves, as a ring buffer. */
  moveHistory: (string | null)[][]
  moveHistoryIndex: number[]
  /** `u16 trainerItems[MAX_BATTLERS_COUNT]` / `u8 itemsNo`. Retained for shape
   * fidelity but dead in these fights: the Kotlin codegen emits no `.items`, so
   * gTrainers[].items[] is empty and the AI never uses healing items (CLAUDE.md,
   * derived from TrainerPartyGenerator.kt). */
  trainerItems: (string | null)[]
  itemsNo: number
}

// ---------------------------------------------------------------------------
// The whole battle
// ---------------------------------------------------------------------------

/** `gBattleOutcome`'s bit values (include/constants/battle.h:91-93), restricted
 * to the three this sim can ever produce -- switching, forfeiting, capturing,
 * fleeing and every link-battle outcome need mechanics this sim does not
 * model. `null` is the C's 0 ("undecided"). Cmd_checkteamslost's own
 * `gBattleOutcome |= B_OUTCOME_LOST` / `|= B_OUTCOME_WON` (battle_script_
 * commands.c:3729-3730) is why DREW is representable at all: WON (1) | LOST
 * (2) = 3, which IS B_OUTCOME_DREW's literal value (battle.h:93) -- not a
 * separate case this sim invents, the same OR the C performs. */
export type BattleOutcome = 'WON' | 'LOST' | 'DREW' | null

export interface BattleState {
  /** Indexed by battler id 0-3 (B_POSITION_*). `null` is an empty slot -- in
   * singles that is ids 2 and 3. Not a sparse array: the index IS the id. */
  battlers: (BattlerState | null)[]
  /** `gBattleOutcome`, restricted to the three values this sim can produce --
   * see `BattleOutcome`'s own doc. Set by `outcome.ts`'s `computeBattleOutcome`
   * whenever a faint changes it, never cleared once set (the C's own
   * `gBattleOutcome = 0` resets belong to a NEW battle, battle_main.c:2741,
   * not to anything mid-battle). */
  battleOutcome: BattleOutcome
  /** `gBattlersCount` (battle.h:957) -- 2 in singles, 4 in doubles. */
  battlersCount: number
  /** `gAbsentBattlerFlags` (battle.h:981) -- a battler bitmask for "fainted or
   * otherwise not on the field right now", distinct from a null slot. */
  absentBattlerFlags: number
  /** Indexed by B_SIDE_PLAYER / B_SIDE_OPPONENT. */
  sides: [SideState, SideState]
  field: FieldState
  battleHistory: BattleHistoryState
  /** `gBattleTypeFlags` (battle.h:946). ShouldSwitch tests BATTLE_TYPE_DOUBLE
   * and BATTLE_TYPE_ARENA against it (battle_ai_switch_items.c:629, 623) -- and
   * also `gBattleTypeFlags & AI_FLAG_DISABLE_SWITCHING` at :611, which is a bug:
   * AI_FLAG_DISABLE_SWITCHING is `1 << 17` (constants/battle_ai.h:61) and so is
   * BATTLE_TYPE_PALACE (constants/battle.h:66), so the trainer-level noSwitching
   * flag is dead and every trainer can switch. Reproduce it; do not fix it. */
  battleTypeFlags: number
  /** `AI_THINKING_STRUCT->aiFlags` (battle.h:372). ONE value for the whole
   * battle, not one per trainer: battle_ai_main.c:147 assigns
   * `gTrainers[gTrainerBattleOpponent_A].aiFlags`, so in a two-trainer fight
   * opponent B's own flags are never read. AI_FLAG_DOUBLE_BATTLE is OR'd in at
   * :154. */
  aiFlags: number
  /** `gBattleResults.battleTurnCounter` (battle.h:448). Turn parity is read by
   * Monotype Champion's Wonder Room alternation and by Truant. */
  turnCount: number
  /** The random source. NOT `gRngValue`: the plan's decision 3 gives up
   * bit-exactness, so this is *a* stream, not the game's. See rng.ts. */
  rng: RandomSource
}

/** A seeded random source. Declared here rather than imported from rng.ts so
 * BattleState has no dependency on a particular generator. */
export interface RandomSource {
  /** A fresh u16 in 0..65535 -- the width the game's own `Random()` returns, so
   * a transcribed `Random() % 100` or `AI_RandLessThan` keeps its distribution
   * (and its modulo bias) unchanged. */
  random16(): number
}

/** The default StatStages array: 8 entries, all DEFAULT_STAT_STAGE (6).
 * Exported for tests and constructors; see constants.ts for why 6 is neutral. */
export function defaultStatStages(): StatStages {
  return new Array<number>(NUM_BATTLE_STATS).fill(DEFAULT_STAT_STAGE)
}

/** Array lengths the constructors and their tests both need, so neither
 * re-derives them from the other. */
export const SLOT_COUNT = MAX_MON_MOVES
export const ABILITY_SLOT_COUNT = NUM_INNATE_PER_SPECIES + 1
export const SWITCH_IN_ABILITY_DONE_COUNT = TOTAL_ABILITY_COUNT + HELL_MODE_EXTRA_ABILITIES
export const MOVE_HISTORY_COUNT = AI_MOVE_HISTORY_COUNT
