import { describe, expect, it } from 'vitest'

import {
  createBattleHistoryState,
  createBattleState,
  createBattlerState,
  createFieldState,
  createRoundState,
  createSideState,
  createTurnState,
  createVolatileState,
} from './create'
import { createRandomSource } from './rng'
import type { SimBattleMon, SimPartyMon } from './state'
import { ABILITY_SLOT_COUNT, SWITCH_IN_ABILITY_DONE_COUNT, defaultStatStages } from './state'
import {
  DEFAULT_STAT_STAGE,
  MAX_BATTLERS_COUNT,
  NUM_BATTLE_STATS,
  PARTY_SIZE,
  STAT_EVASION,
  STATUS1_ANY,
  STATUS1_SLEEP,
  STATUS1_TOXIC_COUNTER,
  STATUS1_TOXIC_POISON,
  STATUS2_INFATUATION,
  STATUS2_TORMENT,
  WEATHER_NONE,
  WEATHER_PERMANENT,
  WEATHER_RAIN_ANY,
  WEATHER_RAIN_PERMANENT,
  WEATHER_SUN_PRIMAL,
  clearFlag,
  getCounter,
  hasFlag,
  setCounter,
  setFlag,
  statusInfatuatedWith,
} from './constants'

function stubMon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 70 },
    moves: ['MOVE_TACKLE', 'MOVE_WATER_GUN', null, null],
    pp: [35, 25, 0, 0],
    hp: 120,
    maxHp: 120,
    itemId: null,
    // Deliberately non-neutral, to prove createBattlerState overwrites it.
    statStages: new Array<number>(NUM_BATTLE_STATS).fill(9),
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 20,
    nature: 'NATURE_ADAMANT',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: 'ABILITY_TORRENT', innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function stubPartyMon(): SimPartyMon {
  return {
    speciesId: 'SPECIES_TAILLOW',
    hp: 60,
    maxHp: 60,
    level: 20,
    moves: ['MOVE_PECK', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: 'ABILITY_GUTS', innates: [null, null, null] },
    rawStats: { atk: 70, def: 50, spatk: 40, spdef: 45, spe: 85 },
    nature: 'NATURE_JOLLY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'FEMALE',
    status1: 0,
    types: ['NORMAL', 'FLYING', 'MYSTERY'],
  }
}

describe('bitfield helpers', () => {
  it('reads and writes the bit-31 flag as unsigned', () => {
    // STATUS2_TORMENT is 1 << 31. JS `|` yields int32, so a naive setFlag would
    // store a negative number; setFlag normalises with >>> 0.
    const set = setFlag(0, STATUS2_TORMENT)
    expect(set).toBe(0x80000000)
    expect(set).toBeGreaterThan(0)
    expect(hasFlag(set, STATUS2_TORMENT)).toBe(true)
    expect(clearFlag(set, STATUS2_TORMENT)).toBe(0)
  })

  it('reads a packed counter at bit 0 and at bit 8', () => {
    // STATUS1_SLEEP is the low 3 bits: the value IS the turn count.
    expect(getCounter(setCounter(0, STATUS1_SLEEP, 3), STATUS1_SLEEP)).toBe(3)
    // STATUS1_TOXIC_COUNTER is 4 bits at bit 8, so it needs the shift.
    const toxic = setCounter(STATUS1_TOXIC_POISON, STATUS1_TOXIC_COUNTER, 5)
    expect(getCounter(toxic, STATUS1_TOXIC_COUNTER)).toBe(5)
    expect(hasFlag(toxic, STATUS1_TOXIC_POISON)).toBe(true)
  })

  it('does not let a counter write bleed into neighbouring flags', () => {
    // 3 bits of sleep cannot hold 9; the C's STATUS1_SLEEP_TURN macro is a bare
    // shift and would spill into STATUS1_POISON (bit 3). setCounter masks.
    const spilled = setCounter(0, STATUS1_SLEEP, 9)
    expect(getCounter(spilled, STATUS1_SLEEP)).toBe(1)
    expect(spilled & ~STATUS1_SLEEP).toBe(0)
  })

  it('STATUS1_ANY omits the toxic counter, as the header writes it', () => {
    // constants/battle.h:119-120. A mon with only a toxic counter set and no
    // TOXIC_POISON bit reads as statusless -- transcribed, not corrected.
    const counterOnly = setCounter(0, STATUS1_TOXIC_COUNTER, 3)
    expect(hasFlag(counterOnly, STATUS1_ANY)).toBe(false)
  })

  it('statusInfatuatedWith lands inside STATUS2_INFATUATION for every battler', () => {
    for (let battler = 0; battler < MAX_BATTLERS_COUNT; battler++) {
      const bit = statusInfatuatedWith(battler)
      expect(hasFlag(bit, STATUS2_INFATUATION)).toBe(true)
      expect(bit & ~STATUS2_INFATUATION).toBe(0)
    }
    expect(statusInfatuatedWith(0)).not.toBe(statusInfatuatedWith(1))
  })

  it('weather masks agree with their members', () => {
    expect(hasFlag(WEATHER_RAIN_PERMANENT, WEATHER_RAIN_ANY)).toBe(true)
    // WEATHER_PERMANENT means "does not tick down", and includes the primal
    // tiers (constants/battle.h:414-415) -- not just the *_PERMANENT bits.
    expect(hasFlag(WEATHER_SUN_PRIMAL, WEATHER_PERMANENT)).toBe(true)
  })
})

describe('createVolatileState', () => {
  it('starts isFirstTurn at 2, not 1 and not a boolean', () => {
    // battle_main.c:2899 (SwitchInClearSetData) and :2970 (FaintClearSetData)
    // both set it to 2 immediately after zeroing the struct.
    expect(createVolatileState().isFirstTurn).toBe(2)
  })

  it('sizes its per-ability-slot arrays from the C, not from the innate count', () => {
    const v = createVolatileState()
    // abilityState is NUM_INNATE_PER_SPECIES + 1 (battle.h:91) -- the chosen
    // ability plus three innates.
    expect(v.abilityState).toHaveLength(ABILITY_SLOT_COUNT)
    expect(ABILITY_SLOT_COUNT).toBe(4)
    // switchInAbilityDone is a DIFFERENT length: TOTAL_ABILITY_COUNT +
    // HELL_MODE_EXTRA_ABILITIES (battle.h:103). Conflating the two would
    // silently truncate.
    expect(v.switchInAbilityDone).toHaveLength(SWITCH_IN_ABILITY_DONE_COUNT)
    expect(SWITCH_IN_ABILITY_DONE_COUNT).toBe(7)
  })

  it('is otherwise zeroed', () => {
    const v = createVolatileState()
    expect(v.protectUses).toBe(0)
    expect(v.disableTimer).toBe(0)
    expect(v.fear).toBe(false)
    expect(v.skyDropped).toBe(false)
    expect(v.disabledMove).toBeNull()
    expect(v.started.fear).toBe(false)
  })
})

describe('createBattlerState', () => {
  it('neutralises all 8 stat stages, including accuracy and evasion', () => {
    const b = createBattlerState(0, stubMon(), 0)
    expect(b.mon.statStages).toHaveLength(NUM_BATTLE_STATS)
    expect(b.mon.statStages.every((s) => s === DEFAULT_STAT_STAGE)).toBe(true)
    // The AI reads index 7 directly (battle_ai_main.c:2726), so it has to exist
    // and has to start neutral.
    expect(b.mon.statStages[STAT_EVASION]).toBe(DEFAULT_STAT_STAGE)
  })

  it('does not mutate the mon it was handed', () => {
    const mon = stubMon()
    createBattlerState(0, mon, 0)
    expect(mon.statStages.every((s) => s === 9)).toBe(true)
  })

  it('starts both switch-target slots at PARTY_SIZE, the "none pending" sentinel', () => {
    // battle_main.c:3522 and :2710. Zero would mean "already switching into
    // party slot 0".
    const b = createBattlerState(1, stubMon(), 0)
    expect(b.monToSwitchIntoId).toBe(PARTY_SIZE)
    expect(b.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
  })

  it('records its own id and party slot', () => {
    const b = createBattlerState(1, stubMon(), 3)
    expect(b.id).toBe(1)
    expect(b.partyIndex).toBe(3)
  })

  it('starts with no volatile statuses and no last move', () => {
    const b = createBattlerState(0, stubMon(), 0)
    expect(b.statuses3).toBe(0)
    expect(b.statuses4).toBe(0)
    expect(b.lastMove).toBeNull()
  })

  it('keeps status1 from the mon, since it survives a switch', () => {
    const asleep = setCounter(0, STATUS1_SLEEP, 2)
    const b = createBattlerState(0, stubMon({ status1: asleep }), 0)
    expect(getCounter(b.mon.status1, STATUS1_SLEEP)).toBe(2)
  })
})

describe('createBattleHistoryState', () => {
  it('starts with the AI knowing nothing', () => {
    const h = createBattleHistoryState()
    // itemEffects 0 is what makes SetBattlerData blank the player's item
    // (battle_ai_util.c:538); a null usedMoves slot blanks that move (:540).
    expect(h.itemEffects).toEqual([0, 0, 0, 0])
    expect(h.usedMoves).toHaveLength(MAX_BATTLERS_COUNT)
    expect(h.usedMoves[0]).toEqual([null, null, null, null])
    expect(h.moveHistory[0]).toEqual([null, null, null])
    expect(h.moveHistoryIndex).toEqual([0, 0, 0, 0])
  })

  it('gives each battler its own arrays', () => {
    const h = createBattleHistoryState()
    h.usedMoves[0][0] = 'MOVE_TACKLE'
    expect(h.usedMoves[1][0]).toBeNull()
    h.moveHistory[0][0] = 'MOVE_TACKLE'
    expect(h.moveHistory[1][0]).toBeNull()
  })
})

describe('createBattleState', () => {
  const rng = createRandomSource(1)

  it('pads the battler array to MAX_BATTLERS_COUNT and counts only the filled slots', () => {
    const state = createBattleState({
      battlers: [createBattlerState(0, stubMon(), 0), createBattlerState(1, stubMon(), 0)],
      rng,
    })
    expect(state.battlers).toHaveLength(MAX_BATTLERS_COUNT)
    expect(state.battlers[2]).toBeNull()
    expect(state.battlersCount).toBe(2)
  })

  it("indexes battlers by id, so a battler's index is its own id", () => {
    const state = createBattleState({
      battlers: [createBattlerState(0, stubMon(), 0), createBattlerState(1, stubMon(), 0)],
      rng,
    })
    state.battlers.forEach((b, i) => {
      if (b) expect(b.id).toBe(i)
    })
  })

  it('starts clear of weather, field statuses, hazards and screens', () => {
    const state = createBattleState({ battlers: [], rng })
    expect(state.field.weather).toBe(WEATHER_NONE)
    expect(state.field.statuses).toBe(0)
    expect(state.sides[0].statuses).toBe(0)
    expect(state.sides[1].statuses).toBe(0)
    expect(state.sides[0].timers.spikesAmount).toBe(0)
    expect(state.sides[0].faintedCount).toBe(0)
  })

  it('gives the two sides separate side state', () => {
    const state = createBattleState({ battlers: [], rng })
    state.sides[0].timers.spikesAmount = 3
    expect(state.sides[1].timers.spikesAmount).toBe(0)
  })

  it('carries each side its own reserve roster', () => {
    const state = createBattleState({
      battlers: [],
      playerParty: [stubPartyMon(), stubPartyMon()],
      opponentParty: [stubPartyMon()],
      rng,
    })
    expect(state.sides[0].party).toHaveLength(2)
    expect(state.sides[1].party).toHaveLength(1)
  })

  it('leaves battleTypeFlags and aiFlags at 0 unless told', () => {
    // Defaulting either would silently decide the battle format or the AI's
    // behaviour set; both come from the fight's own data.
    const state = createBattleState({ battlers: [], rng })
    expect(state.battleTypeFlags).toBe(0)
    expect(state.aiFlags).toBe(0)
    expect(state.turnCount).toBe(0)
  })
})

describe('createRandomSource', () => {
  it('returns u16 values', () => {
    const rng = createRandomSource(12345)
    for (let i = 0; i < 1000; i++) {
      const v = rng.random16()
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffff)
    }
  })

  it('is deterministic per seed and differs between seeds', () => {
    const a = createRandomSource(7)
    const b = createRandomSource(7)
    const c = createRandomSource(8)
    const drawA = Array.from({ length: 20 }, () => a.random16())
    const drawB = Array.from({ length: 20 }, () => b.random16())
    const drawC = Array.from({ length: 20 }, () => c.random16())
    expect(drawA).toEqual(drawB)
    expect(drawA).not.toEqual(drawC)
  })

  it('is roughly uniform under the modulus the AI actually uses', () => {
    // AI_RandLessThan is `(Random() % 0xFF) < val` (battle_ai_util.c:441).
    // 0xFF is 255, so a "50%" threshold is 127/255 = 49.8%, not 50%. This only
    // checks the source is not visibly biased; the off-by-one belongs to the AI
    // port, not here.
    const rng = createRandomSource(99)
    let hits = 0
    const n = 20000
    for (let i = 0; i < n; i++) {
      if (rng.random16() % 0xff < 127) hits++
    }
    expect(hits / n).toBeGreaterThan(0.46)
    expect(hits / n).toBeLessThan(0.54)
  })
})

describe('struct constructors are independent', () => {
  it('createRoundState, createTurnState, createFieldState and createSideState share nothing', () => {
    const r1 = createRoundState()
    const r2 = createRoundState()
    r1.damaged = true
    expect(r2.damaged).toBe(false)

    const t = createTurnState()
    expect(t.turnAbilityTriggers).toHaveLength(ABILITY_SLOT_COUNT)
    expect(t.turnAbilityTriggers.every((x) => x === false)).toBe(true)

    const f1 = createFieldState()
    const f2 = createFieldState()
    f1.timers.trickRoomTimer = 5
    expect(f2.timers.trickRoomTimer).toBe(0)

    const s1 = createSideState()
    const s2 = createSideState()
    s1.party.push(stubPartyMon())
    expect(s2.party).toHaveLength(0)
  })

  it('defaultStatStages returns a fresh array each call', () => {
    const a = defaultStatStages()
    a[0] = 0
    expect(defaultStatStages()[0]).toBe(DEFAULT_STAT_STAGE)
  })
})
