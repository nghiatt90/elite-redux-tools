// Constructors for the battle state model. Every one returns the state the game
// itself starts from, which is the zeroed struct (`AllocZeroed` / the C's `ZERO`
// macro) EXCEPT where the game explicitly writes something else immediately
// after zeroing. Those exceptions are the whole reason these are functions
// rather than object literals at each call site, and each one cites its line:
//
//   - statStages start at DEFAULT_STAT_STAGE (6), not 0 -- battle_main.c:2809
//     (SwitchInClearSetData) and :2951 (FaintClearSetData) both fill all
//     NUM_BATTLE_STATS entries.
//   - `isFirstTurn` starts at 2, not 1 and not a boolean -- battle_main.c:2899
//     and :2970, both immediately after ZERO(gVolatileStructs[...]).
//
// No behaviour here: nothing calculates a stat, resolves an ability, reads
// game data or advances a turn.

import type {
  BattlerState,
  BattleHistoryState,
  BattleState,
  FieldBeganThisTurn,
  FieldState,
  FieldTimerState,
  RandomSource,
  RoundState,
  SideBeganThisTurn,
  SideState,
  SideTimerState,
  SimBattleMon,
  SimPartyMon,
  Slot4,
  TurnState,
  VolatileBeganThisTurn,
  VolatileState,
} from './state'
import { ABILITY_SLOT_COUNT, MOVE_HISTORY_COUNT, SWITCH_IN_ABILITY_DONE_COUNT, defaultStatStages } from './state'
import { MAX_BATTLERS_COUNT, PARTY_SIZE, WEATHER_NONE } from './constants'

function nullSlot4(): Slot4<string | null> {
  return [null, null, null, null]
}

function createVolatileBeganThisTurn(): VolatileBeganThisTurn {
  return {
    violentRush: false,
    rapidResponse: false,
    readiedAction: false,
    showdownMode: false,
    fear: false,
    onTheProwl: false,
    dazed: false,
    drenched: false,
    trepidation: false,
  }
}

/** A freshly switched-in battler's VolatileStruct. `isFirstTurn` is 2 because
 * both of the game's reset paths set it to 2 right after zeroing the struct
 * (battle_main.c:2899, :2970) -- it is a two-turn countdown, not a flag, which
 * is why the field is a number here. */
export function createVolatileState(): VolatileState {
  return {
    transformedMonPersonality: 0,
    abilityState: new Array<number>(ABILITY_SLOT_COUNT).fill(0),
    started: createVolatileBeganThisTurn(),
    disabledMove: null,
    encoredMove: null,
    wrapAbility: null,
    protectUses: 0,
    stockpileCounter: 0,
    stockpileDef: 0,
    stockpileSpDef: 0,
    stockpileBeforeDef: 0,
    stockpileBeforeSpDef: 0,
    substituteHp: 0,
    switchInAbilityDone: new Array<boolean>(SWITCH_IN_ABILITY_DONE_COUNT).fill(false),
    battlerPreventingEscape: 0,
    battlerWithSureHit: 0,
    isFirstTurn: 2,
    rechargeTimer: 0,
    autotomizeCount: 0,
    slowStartTimer: 0,
    embargoTimer: 0,
    magnetRiseTimer: 0,
    telekinesisTimer: 0,
    healBlockTimer: 0,
    laserFocusTimer: 0,
    throatChopTimer: 0,
    encoredMovePos: 0,
    furyCutterCounter: 0,
    extraAttackLevel: 0,
    extraDefenseLevel: 0,
    extraSpAttackLevel: 0,
    extraSpDefenseLevel: 0,
    extraSpeedLevel: 0,
    disableTimer: 0,
    disableTimerStartValue: 0,
    encoreTimer: 0,
    encoreTimerStartValue: 0,
    perishSongTimer: 0,
    perishSongTimerStartValue: 0,
    rolloutCounter: 0,
    tauntTimer: 0,
    tauntTimer2: 0,
    mimickedMoves: 0,
    usedMoves: 0,
    wrapTurns: 0,
    noRetreat: false,
    tarShot: false,
    octolock: false,
    hasBeenOnBattle: false,
    substituteDestroyedThisTurn: false,
    disciplineCounter: 0,
    syrupBombIsShiny: false,
    ghastlyEchoTimer: 0,
    syrupTimer: 0,
    violentRush: false,
    rapidResponse: false,
    readiedAction: false,
    showdownMode: false,
    parasiticSpores: false,
    critBoost: 0,
    fear: false,
    onTheProwl: false,
    trickOrTreat: false,
    skyDropped: false,
    skyDroppedBy: 0,
    shouldClearSkyDrop: false,
    dazed: 0,
    trepidation: 0,
    hazardDamaged: false,
    iceStatue: false,
    usedMonotypeEntry: false,
    drenched: 0,
  }
}

/** A zeroed RoundStruct -- `ZERO(gRoundStructs[gActiveBattler])`,
 * battle_main.c:2968. */
export function createRoundState(): RoundState {
  return {
    physicalDmg: 0,
    specialDmg: 0,
    protectMove: null,
    physicalBattlerId: 0,
    specialBattlerId: 0,
    endured: false,
    noValidMoves: false,
    helpingHand: false,
    bounceMove: false,
    stealMove: false,
    prlzImmobility: false,
    targetAffected: false,
    chargingTurn: false,
    fleeFlag: 0,
    usedImprisonedMove: false,
    loveImmobility: false,
    usedDisabledMove: false,
    usedTauntedMove: false,
    flag2Unknown: false,
    flinchImmobility: false,
    notFirstStrike: false,
    palaceUnableToUseMove: false,
    usesBouncedMove: false,
    usedHealBlockedMove: false,
    usedGravityPreventedMove: false,
    powderSelfDmg: false,
    usedThroatChopPreventedMove: false,
    statRaised: false,
    usedMicleBerry: false,
    usedCustapBerry: false,
    touchedProtectLike: false,
    disableEjectPack: false,
    statFell: false,
    quickDraw: false,
    glaiveRush: false,
    attackCancelled: false,
    afterYou: false,
    damaged: false,
    safePassage: false,
    confusionSelfDmg: false,
    waterlog: false,
  }
}

export function createTurnState(): TurnState {
  return {
    dmg: 0,
    physicalDmg: 0,
    specialDmg: 0,
    savedDmg: 0,
    parentalBondTrigger: null,
    flungItem: null,
    redirectedAbility: null,
    sturdyAbility: null,
    turnAbilityTriggers: new Array<boolean>(ABILITY_SLOT_COUNT).fill(false),
    gemParam: 0,
    physicalBattlerId: 0,
    specialBattlerId: 0,
    changedStatsBattlerId: 0,
    multiHitsUsed: 0,
    damagedMons: 0,
    mirrorHerbStat: 0,
    multiHitCounter: 0,
    parentalBondOn: 0,
    parentalBondInitialCount: 0,
    statLowered: false,
    intimidatedMon: false,
    scaredMon: false,
    traced: false,
    flag40: false,
    focusBanded: false,
    focusSashed: false,
    sturdied: false,
    switchInItemDone: false,
    berryReduced: false,
    gemBoost: false,
    rototillerAffected: false,
    dancerUsedMove: false,
    neutralizingGasRemoved: false,
    shouldTriggerSwitchItem: false,
    haloed: false,
    sleepTalk: false,
  }
}

function createSideBeganThisTurn(): SideBeganThisTurn {
  return {
    reflect: false,
    lightscreen: false,
    mist: false,
    safeguard: false,
    followme: false,
    auroraVeil: false,
    tailwind: false,
    luckyChant: false,
    spiderWeb: false,
    swamp: false,
    fireSea: false,
    rainbow: false,
    smokescreen: false,
    quickGuard: false,
  }
}

export function createSideTimerState(): SideTimerState {
  return {
    started: createSideBeganThisTurn(),
    reflectTimer: 0,
    reflectBattlerId: 0,
    lightscreenTimer: 0,
    lightscreenBattlerId: 0,
    mistTimer: 0,
    mistBattlerId: 0,
    safeguardTimer: 0,
    safeguardBattlerId: 0,
    followmeTimer: 0,
    spikesAmount: 0,
    toxicSpikesAmount: 0,
    stealthRockType: 0,
    auroraVeilTimer: 0,
    auroraVeilBattlerId: 0,
    tailwindTimer: 0,
    tailwindBattlerId: 0,
    luckyChantTimer: 0,
    luckyChantBattlerId: 0,
    retaliateTimer: 0,
    stickyWebTimer: 0,
    swampTimer: 0,
    fireSeaTimer: 0,
    rainbowTimer: 0,
    smokescreenTimer: 0,
    smokescreenBattler: 0,
    followmeTarget: 0,
    followmePowder: false,
    hotCoals: false,
    caltrops: false,
    quickGuardTimer: 0,
    foamyWeb: false,
  }
}

/** One side with no hazards, no screens and the given reserve roster. */
export function createSideState(party: SimPartyMon[] = []): SideState {
  return {
    statuses: 0,
    timers: createSideTimerState(),
    faintedCount: 0,
    party,
  }
}

function createFieldBeganThisTurn(): FieldBeganThisTurn {
  return {
    mudSport: false,
    waterSport: false,
    wonderRoom: false,
    magicRoom: false,
    trickRoom: false,
    terrain: false,
    gravity: false,
    fairyLock: false,
    inverseRoom: false,
    weather: false,
    quash: false,
    clearSkiesTimer: false,
  }
}

export function createFieldTimerState(): FieldTimerState {
  return {
    started: createFieldBeganThisTurn(),
    mudSportTimer: 0,
    waterSportTimer: 0,
    wonderRoomTimer: 0,
    magicRoomTimer: 0,
    trickRoomTimer: 0,
    terrainTimer: 0,
    terrainBattlerId: 0,
    gravityTimer: 0,
    fairyLockTimer: 0,
    inverseRoomTimer: 0,
    quashTimer: 0,
    fogReturnTimer: 0,
    clearSkiesTimer: 0,
    neutralizingGas: false,
  }
}

/** Clear skies, no terrain, no Room. A battle that starts under weather (a
 * Drizzle lead, an encounters.json field effect) sets `weather` afterwards --
 * the constructor does not decide that, because deciding it needs data. */
export function createFieldState(): FieldState {
  return {
    statuses: 0,
    weather: WEATHER_NONE,
    timers: createFieldTimerState(),
    weatherDuration: 0,
  }
}

/** A BattleHistory in which the AI knows nothing: no item effect observed, no
 * move revealed. That is the state SetBattlerData reads as "blank the player's
 * item and every move slot" (battle_ai_util.c:538-541), so turn one's AI
 * decisions are made against an opponent it cannot see. Arrays are
 * MAX_BATTLERS_COUNT long regardless of format, matching the C's fixed sizes. */
export function createBattleHistoryState(): BattleHistoryState {
  return {
    itemEffects: new Array<number>(MAX_BATTLERS_COUNT).fill(0),
    usedMoves: Array.from({ length: MAX_BATTLERS_COUNT }, () => nullSlot4()),
    moveHistory: Array.from({ length: MAX_BATTLERS_COUNT }, () => new Array<string | null>(MOVE_HISTORY_COUNT).fill(null)),
    moveHistoryIndex: new Array<number>(MAX_BATTLERS_COUNT).fill(0),
    trainerItems: new Array<string | null>(MAX_BATTLERS_COUNT).fill(null),
    itemsNo: 0,
  }
}

/** Puts `mon` on the field as battler `id`, coming from party slot
 * `partyIndex`. The mon's own statStages are overwritten with the neutral set
 * (battle_main.c:2809, :2951) -- a caller that wants pre-set stages applies them
 * after construction, the same way the game's Baton Pass path does. */
export function createBattlerState(id: number, mon: SimBattleMon, partyIndex: number): BattlerState {
  return {
    id,
    mon: { ...mon, statStages: defaultStatStages() },
    statuses3: 0,
    statuses4: 0,
    volatiles: createVolatileState(),
    round: createRoundState(),
    turn: createTurnState(),
    partyIndex,
    lastMove: null,
    // PARTY_SIZE (6) is the game's "no pending switch" sentinel for BOTH arrays,
    // not 0 and not 0xFF: battle_main.c:3522 fills monToSwitchIntoId with
    // PARTY_SIZE across all MAX_BATTLERS_COUNT slots and :2710 does the same for
    // AI_monToSwitchIntoId, and the readers test against it by name
    // (battle_ai_switch_items.c:980, battle_ai_main.c:1408). Zero would be
    // wrong: slot 0 is a real party slot, so ShouldSwitch's reserve count
    // (battle_ai_switch_items.c:662-665) would exclude the lead's replacement.
    monToSwitchIntoId: PARTY_SIZE,
    aiMonToSwitchIntoId: PARTY_SIZE,
    sameMoveTurns: 0,
  }
}

export interface CreateBattleStateOptions {
  /** Length MAX_BATTLERS_COUNT, indexed by battler id. Singles fills 0 and 1. */
  battlers: (BattlerState | null)[]
  /** Reserve rosters, indexed by B_SIDE_PLAYER / B_SIDE_OPPONENT. */
  playerParty?: SimPartyMon[]
  opponentParty?: SimPartyMon[]
  /** `gBattleTypeFlags`. Left 0 by default: the caller supplies the format, and
   * an invented default here would silently decide singles-vs-doubles. */
  battleTypeFlags?: number
  /** `AI_THINKING_STRUCT->aiFlags` -- from the trainer, so the caller supplies
   * it. See state.ts for why there is only one value for the whole battle. */
  aiFlags?: number
  rng: RandomSource
}

/** Assembles a battle at turn zero. Takes battlers already built (turning a
 * party entry into a SimBattleMon needs stat calculation and ability
 * resolution, which are not this batch's job) and fills in everything that
 * starts empty. */
function assertRosterHoldsActiveBattlers(party: SimPartyMon[] | undefined, battlers: (BattlerState | null)[], side: 0 | 1): void {
  if (party === undefined) return
  if (party.length === 0) throw new Error(`side ${side}: a supplied party must not be empty (omit it to opt out of outcome tracking)`)
  battlers.forEach((battler, id) => {
    if (battler && (id & 1) === side && battler.partyIndex >= party.length) {
      throw new Error(`side ${side}: battler ${id} has partyIndex ${battler.partyIndex}, outside its ${party.length}-mon party`)
    }
  })
}

export function createBattleState(options: CreateBattleStateOptions): BattleState {
  const battlers = options.battlers.slice(0, MAX_BATTLERS_COUNT)
  while (battlers.length < MAX_BATTLERS_COUNT) battlers.push(null)
  // outcome.ts reads an EMPTY party as "no roster data", so a side whose
  // roster was supplied but came out empty (a mapping bug) could never lose.
  // Omitting the party is the only way to opt out; a supplied one must be real.
  assertRosterHoldsActiveBattlers(options.playerParty, battlers, 0)
  assertRosterHoldsActiveBattlers(options.opponentParty, battlers, 1)

  return {
    battlers,
    // gBattlersCount is 2 in singles and 4 in doubles (battle.h:957); derived
    // from the filled slots rather than taken as a parameter, so it cannot
    // disagree with the array it describes.
    battlersCount: battlers.filter((b) => b !== null).length,
    absentBattlerFlags: 0,
    battleOutcome: null,
    sides: [createSideState(options.playerParty ?? []), createSideState(options.opponentParty ?? [])],
    field: createFieldState(),
    battleHistory: createBattleHistoryState(),
    battleTypeFlags: options.battleTypeFlags ?? 0,
    aiFlags: options.aiFlags ?? 0,
    turnCount: 0,
    rng: options.rng,
  }
}
