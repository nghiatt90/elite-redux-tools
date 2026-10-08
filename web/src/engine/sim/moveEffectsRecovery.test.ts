// Unit tests for recovery moves, Pain Split, Strength Sap, and Leech Seed (cycle 28, step 5, batch 5).
//
// Hand-derived from upstream C source code at pinned SHA:
// - BattleScript_EffectRestoreHp (data/battle_scripts_1.s:3940-3956)
// - BattleScript_EffectSoftboiled (data/battle_scripts_1.s:5909-5930)
// - Cmd_tryhealhalfhealth (src/battle_script_commands.c:9255-9274)
// - BattleScript_EffectMorningSun/Synthesis/Moonlight/ShoreUp (data/battle_scripts_1.s:5495-5504)
// - Cmd_recoverbasedonsunlight (src/battle_script_commands.c:11433-11460)
// - BattleScript_EffectRoost (data/battle_scripts_1.s:2736-2742)
// - BattleScript_EffectJungleHealing (data/battle_scripts_1.s:773-805)
// - VARIOUS_JUMP_IF_TEAM_HEALTHY / VARIOUS_TRY_HEAL_PERCENT_HP (src/battle_script_commands.c:7883-7907)
// - BattleScript_EffectPainSplit (data/battle_scripts_1.s:4691-4708)
// - Cmd_painsplitdmgcalc (src/battle_script_commands.c:10765-10786)
// - BattleScript_EffectStrengthSap (data/battle_scripts_1.s:896-943)
// - CalculateStat (src/battle_util.c:7105-7217)
// - BattleScript_EffectLeechSeed (data/battle_scripts_1.s:4579-4592)
// - Cmd_setseeded (src/battle_script_commands.c:9341-9355)
// - ENDTURN_LEECH_SEED (src/battle_util.c:2472-2486) and BattleScript_LeechSeedTurnDrain (data/battle_scripts_1.s:7482-7509)
// - CanBattlerHeal (src/battle_util.c:8979-8986)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { runEndTurnEffects } from './endTurn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ATK,
  STATUS1_BLEED,
  STATUS1_NONE,
  STATUS3_HEAL_BLOCK,
  STATUS3_LEECHSEED,
  STATUS3_LEECHSEED_BATTLER,
  WEATHER_NONE,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    target: m.target as string | undefined,
    priority: m.priority as number | undefined,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
  }
}

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}

// Moves in scope
const MOVE_RECOVER = requireMove('MOVE_RECOVER')
const MOVE_SLACK_OFF = requireMove('MOVE_SLACK_OFF')
const MOVE_SOFT_BOILED = requireMove('MOVE_SOFT_BOILED')
const MOVE_MORNING_SUN = requireMove('MOVE_MORNING_SUN')
const MOVE_SYNTHESIS = requireMove('MOVE_SYNTHESIS')
const MOVE_MOONLIGHT = requireMove('MOVE_MOONLIGHT')
const MOVE_SHORE_UP = requireMove('MOVE_SHORE_UP')
const MOVE_ROOST = requireMove('MOVE_ROOST')
const MOVE_LIFE_DEW = requireMove('MOVE_LIFE_DEW')
const MOVE_JUNGLE_HEALING = requireMove('MOVE_JUNGLE_HEALING')
const MOVE_PAIN_SPLIT = requireMove('MOVE_PAIN_SPLIT')
const MOVE_STRENGTH_SAP = requireMove('MOVE_STRENGTH_SAP')
const MOVE_LEECH_SEED = requireMove('MOVE_LEECH_SEED')

// Abilities in scope
const ABILITY_CHLOROPLAST = requireAbility('ABILITY_CHLOROPLAST')
const ABILITY_MOON_SPIRIT = requireAbility('ABILITY_MOON_SPIRIT')
const ABILITY_LIQUID_OOZE = requireAbility('ABILITY_LIQUID_OOZE')
const ABILITY_ABSORBANT = requireAbility('ABILITY_ABSORBANT')

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: (id) => itemsById.get(id),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: STATUS1_NONE,
    status2: 0,
    ...overrides,
  }
}

function battle(
  specs: {
    spe?: number
    atk?: number
    hp?: number
    maxHp?: number
    itemId?: string | null
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    types?: SimBattleMon['types']
    statStages?: number[]
  }[],
  rng: RandomSource,
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          itemId: s.itemId ?? null,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          types: s.types ?? ['WATER', 'MYSTERY', 'MYSTERY'],
          statStages: s.statStages ?? [],
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(rolls: number[] = []): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      if (idx < rolls.length) {
        return rolls[idx++]!
      }
      return 0
    },
  }
  return r
}

function useMove(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: move.priority ?? 0,
    effect: move.effect,
    isStatus: move.split === 'STATUS',
    resolvedType: move.type ?? 'NORMAL',
    power: move.power,
    flags: move.flags,
    split: move.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function dummyDamage(): DamageResolver {
  return {
    resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
  }
}

function testDeps(): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage: dummyDamage(), statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

describe('Recovery moves: Recover, Soft-Boiled, Roost', () => {
  it('Recover heals 50% max HP (floored) from damaged state', () => {
    // maxHp = 150, current hp = 50. Heal = 150 / 2 = 75. New HP = 50 + 75 = 125.
    const state = battle([{ hp: 50, maxHp: 150 }, { spe: 50 }], scriptedRng())
    const outcome = executeTurn(state, [useMove(0, MOVE_RECOVER), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(125)
    expect(outcome.actions.find((a) => a.battlerId === 0)!.targetId).toBe(0)
  })

  it('Recover uses integer division floor for odd max HP', () => {
    // maxHp = 151, current hp = 50. Heal = Math.trunc(151 / 2) = 75. New HP = 50 + 75 = 125.
    const state = battle([{ hp: 50, maxHp: 151 }, { spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(0, MOVE_RECOVER), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(125)
  })

  it('Recover fails when user is already at full HP', () => {
    // maxHp = 100, current hp = 100. tryhealhalfhealth jumps to AlreadyAtFullHp.
    const state = battle([{ hp: 100, maxHp: 100 }, { spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(0, MOVE_RECOVER), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Soft-Boiled heals 50% max HP identically to Recover', () => {
    const state = battle([{ hp: 40, maxHp: 100 }, { spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(0, MOVE_SOFT_BOILED), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(90)
  })

  it('Slack Off heals 50% max HP identically to Recover', () => {
    const state = battle([{ hp: 40, maxHp: 100 }, { spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(0, MOVE_SLACK_OFF), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(90)
  })

  it('Roost heals 50% max HP and records unmodelled setroost gap', () => {
    const state = battle([{ hp: 30, maxHp: 100 }, { spe: 50 }], scriptedRng())
    const outcome = executeTurn(state, [useMove(0, MOVE_ROOST), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(outcome.actions.find((a) => a.battlerId === 0)!.unmodelled).toContain(
      "Cmd_setroost (battle_script_commands.c:4022-4047): Roost's temporary Flying-type removal and RESOURCE_FLAG_ROOST are not modelled",
    )
  })

  it('Heal Block blocks Recover from healing', () => {
    const state = battle([{ hp: 50, maxHp: 100 }, { spe: 50 }], scriptedRng())
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    executeTurn(state, [useMove(0, MOVE_RECOVER), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(50)
  })
})

describe('Weather recovery: Morning Sun, Synthesis, Moonlight, Shore Up', () => {
  it('Morning Sun heals 1/2 max HP in no weather', () => {
    // maxHp = 120, current hp = 10. Heal = 120 / 2 = 60. New HP = 70.
    const state = battle([{ hp: 10, maxHp: 120 }, { spe: 50 }], scriptedRng())
    state.field.weather = WEATHER_NONE
    executeTurn(state, [useMove(0, MOVE_MORNING_SUN), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(70)
  })

  it('Morning Sun heals 2/3 max HP in sunny weather', () => {
    // maxHp = 120, current hp = 10. Heal = Math.trunc(120 * 2 / 3) = 80. New HP = 90.
    const state = battle([{ hp: 10, maxHp: 120 }, { spe: 50 }], scriptedRng())
    state.field.weather = WEATHER_SUN_TEMPORARY
    executeTurn(state, [useMove(0, MOVE_MORNING_SUN), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(90)
  })

  it('Synthesis heals 1/4 max HP in rain', () => {
    // maxHp = 120, current hp = 10. Heal = Math.trunc(120 / 4) = 30. New HP = 40.
    const state = battle([{ hp: 10, maxHp: 120 }, { spe: 50 }], scriptedRng())
    state.field.weather = WEATHER_RAIN_TEMPORARY
    executeTurn(state, [useMove(0, MOVE_SYNTHESIS), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(40)
  })

  it('Synthesis with Chloroplast heals 2/3 max HP even without sun', () => {
    // maxHp = 120, current hp = 10. HasChloroplast triggers the 2/3 branch. Heal = 80. New HP = 90.
    const state = battle(
      [{ hp: 10, maxHp: 120, abilities: { ability: ABILITY_CHLOROPLAST, innates: [null, null, null] } }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_NONE
    executeTurn(state, [useMove(0, MOVE_SYNTHESIS), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(90)
  })

  it('Moonlight with Moon Spirit heals 3/4 max HP', () => {
    // maxHp = 120, current hp = 10. Heal = Math.trunc(120 * 3 / 4) = 90. New HP = 100.
    const state = battle(
      [{ hp: 10, maxHp: 120, abilities: { ability: ABILITY_MOON_SPIRIT, innates: [null, null, null] } }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_NONE
    executeTurn(state, [useMove(0, MOVE_MOONLIGHT), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Shore Up in sandstorm heals 2/3 max HP vs 1/2 max HP with no weather', () => {
    // In Sandstorm: 120 * 2 / 3 = 80 -> 90 HP, then end-of-turn sandstorm chip 120 / 16 = 7 -> 83.
    {
      const state = battle([{ hp: 10, maxHp: 120 }, { spe: 50 }], scriptedRng())
      state.field.weather = WEATHER_SANDSTORM_TEMPORARY
      executeTurn(state, [useMove(0, MOVE_SHORE_UP), null], testDeps())
      expect(state.battlers[0]!.mon.hp).toBe(83)
    }
    // In No weather: 120 / 2 = 60. New HP = 70.
    {
      const state = battle([{ hp: 10, maxHp: 120 }, { spe: 50 }], scriptedRng())
      state.field.weather = WEATHER_NONE
      executeTurn(state, [useMove(0, MOVE_SHORE_UP), null], testDeps())
      expect(state.battlers[0]!.mon.hp).toBe(70)
    }
  })
})

describe('Jungle Healing / Life Dew', () => {
  it('Life Dew heals 25% max HP to user', () => {
    // maxHp = 100, current hp = 50. Heal = 100 * 25 / 100 = 25. New HP = 75.
    const state = battle([{ hp: 50, maxHp: 100 }, { spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(0, MOVE_LIFE_DEW), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(75)
  })

  it('Jungle Healing cures primary status and heals 25%', () => {
    const state = battle([{ hp: 50, maxHp: 100 }, { spe: 50 }], scriptedRng())
    state.battlers[0]!.mon.status1 = 1 // e.g. Sleep
    executeTurn(state, [useMove(0, MOVE_JUNGLE_HEALING), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })

  it('Jungle Healing fails when team is healthy (full HP and no status)', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(0, MOVE_JUNGLE_HEALING), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(100)
  })
})

describe('Pain Split: HP averaging', () => {
  it('Pain Split averages HP when user has lower HP than target', () => {
    // User hp = 20, Foe hp = 80. Average = (20 + 80) / 2 = 50.
    const state = battle([{ hp: 20, maxHp: 100 }, { hp: 80, maxHp: 100, spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_PAIN_SPLIT), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(state.battlers[1]!.mon.hp).toBe(50)
  })

  it('Pain Split averages HP when user has higher HP than target', () => {
    // User hp = 80, Foe hp = 20. Average = (80 + 20) / 2 = 50.
    const state = battle([{ hp: 80, maxHp: 100 }, { hp: 20, maxHp: 100, spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_PAIN_SPLIT), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(state.battlers[1]!.mon.hp).toBe(50)
  })

  it('Pain Split truncates odd sums', () => {
    // User hp = 30, Foe hp = 61. Sum = 91. Average = Math.trunc(91 / 2) = 45.
    const state = battle([{ hp: 30, maxHp: 100 }, { hp: 61, maxHp: 100, spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_PAIN_SPLIT), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(45)
    expect(state.battlers[1]!.mon.hp).toBe(45)
  })

  it('Pain Split caps at maxHP when average exceeds maxHp', () => {
    // User maxHp = 40, hp = 40. Foe maxHp = 100, hp = 90. Sum = 130. Average = 65.
    // User caps at 40, Foe becomes 65.
    const state = battle([{ hp: 40, maxHp: 40 }, { hp: 90, maxHp: 100, spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_PAIN_SPLIT), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(40)
    expect(state.battlers[1]!.mon.hp).toBe(65)
  })
})

describe('Strength Sap: Attack drop and heal calculation', () => {
  it('Strength Sap lowers target Attack by 1 stage and heals user by target Attack stat', () => {
    // Target has 100 raw Attack, neutral stage 6. Calculated Attack = 100.
    // User has 20 / 150 HP.
    // Target Attack drops to stage 5. User heals by 100 -> 120 HP.
    const state = battle([{ hp: 20, maxHp: 150 }, { atk: 100, spe: 50 }], scriptedRng())
    const outcome = executeTurn(state, [useMove(1, MOVE_STRENGTH_SAP), null], testDeps())

    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.hp).toBe(120)
    expect(outcome.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: -1 }])
  })

  it('Strength Sap with Big Root buffs healing by 1.5x (50%)', () => {
    // Target has 80 raw Attack, stage 6 -> 80.
    // User holds ITEM_BIG_ROOT (HOLD_EFFECT_BIG_ROOT).
    // Heal = Math.trunc(80 * 3 / 2) = 120. User hp 10 -> 130.
    const state = battle(
      [{ hp: 10, maxHp: 150, itemId: 'ITEM_BIG_ROOT' }, { atk: 80, spe: 50 }],
      scriptedRng(),
    )
    executeTurn(state, [useMove(1, MOVE_STRENGTH_SAP), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(130)
  })

  it('Strength Sap with Absorbant ability buffs healing by 1.5x', () => {
    const state = battle(
      [
        { hp: 10, maxHp: 150, abilities: { ability: ABILITY_ABSORBANT, innates: [null, null, null] } },
        { atk: 80, spe: 50 },
      ],
      scriptedRng(),
    )
    executeTurn(state, [useMove(1, MOVE_STRENGTH_SAP), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(130)
  })

  it('Strength Sap does not heal if target is already at MIN_STAT_STAGE', () => {
    // Target Attack stage is MIN_STAT_STAGE (0).
    // Script jumps to MoveEnd without draining HP.
    const state = battle([{ hp: 20, maxHp: 150 }, { atk: 100, spe: 50, statStages: [0, 0, 0, 0, 0, 0, 0, 0] }], scriptedRng())
    state.battlers[1]!.mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    executeTurn(state, [useMove(1, MOVE_STRENGTH_SAP), null], testDeps())

    expect(state.battlers[0]!.mon.hp).toBe(20)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
  })

  it('Strength Sap still lowers Attack if user is already at full HP, but does not heal', () => {
    const state = battle([{ hp: 150, maxHp: 150 }, { atk: 100, spe: 50 }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_STRENGTH_SAP), null], testDeps())

    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.hp).toBe(150)
  })
})

describe('Leech Seed: Application and end-of-turn drain/heal', () => {
  it('Leech Seed sets STATUS3_LEECHSEED and seeder ID on non-Grass target', () => {
    const state = battle([{ spe: 100 }, { spe: 50, types: ['WATER', 'MYSTERY', 'MYSTERY'] }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_LEECH_SEED), null], testDeps())

    expect(state.battlers[1]!.statuses3 & STATUS3_LEECHSEED).toBe(STATUS3_LEECHSEED)
    expect(state.battlers[1]!.statuses3 & STATUS3_LEECHSEED_BATTLER).toBe(0)
  })

  it('Leech Seed fails on Grass-type target', () => {
    const state = battle([{ spe: 100 }, { spe: 50, types: ['GRASS', 'MYSTERY', 'MYSTERY'] }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_LEECH_SEED), null], testDeps())

    expect(state.battlers[1]!.statuses3 & STATUS3_LEECHSEED).toBe(0)
  })

  it('ENDTURN_LEECH_SEED drains 1/8 max HP from seeded battler and heals seeder', () => {
    // Seeded battler 1: maxHp = 80, hp = 80. Drain = 80 / 8 = 10.
    // Seeder battler 0: maxHp = 100, hp = 50. Heals 10 -> 60.
    const state = battle([{ hp: 50, maxHp: 100 }, { hp: 80, maxHp: 80, spe: 50 }], scriptedRng())
    state.battlers[1]!.statuses3 |= STATUS3_LEECHSEED | 0 // seeded by battler 0

    const { results } = runEndTurnEffects(state, [0, 1], DATA_CONTEXT)

    expect(state.battlers[1]!.mon.hp).toBe(70)
    expect(state.battlers[0]!.mon.hp).toBe(60)

    const leechResults = results.filter((r) => r.effect === 'LEECH_SEED')
    expect(leechResults).toHaveLength(2)
    expect(leechResults[0]).toEqual({ battlerId: 1, effect: 'LEECH_SEED', hpChange: -10, fainted: false })
    expect(leechResults[1]).toEqual({ battlerId: 0, effect: 'LEECH_SEED', hpChange: 10, fainted: false })
  })

  it('ENDTURN_LEECH_SEED with Liquid Ooze damages the seeder instead of healing', () => {
    // Seeded battler 1 has Liquid Ooze: maxHp = 80, hp = 80. Drains 10.
    // Seeder battler 0: hp = 50. Takes 10 damage from Liquid Ooze -> 40.
    const state = battle(
      [
        { hp: 50, maxHp: 100 },
        {
          hp: 80,
          maxHp: 80,
          spe: 50,
          abilities: { ability: ABILITY_LIQUID_OOZE, innates: [null, null, null] },
        },
      ],
      scriptedRng(),
    )
    state.battlers[1]!.statuses3 |= STATUS3_LEECHSEED | 0

    const { results } = runEndTurnEffects(state, [0, 1], DATA_CONTEXT)

    expect(state.battlers[1]!.mon.hp).toBe(70)
    expect(state.battlers[0]!.mon.hp).toBe(40)

    const leechResults = results.filter((r) => r.effect === 'LEECH_SEED')
    expect(leechResults).toHaveLength(2)
    expect(leechResults[0]).toEqual({ battlerId: 1, effect: 'LEECH_SEED', hpChange: -10, fainted: false })
    expect(leechResults[1]).toEqual({ battlerId: 0, effect: 'LEECH_SEED', hpChange: -10, fainted: false })
  })

  it('ENDTURN_LEECH_SEED does not heal seeder if seeder is under Heal Block', () => {
    const state = battle([{ hp: 50, maxHp: 100 }, { hp: 80, maxHp: 80, spe: 50 }], scriptedRng())
    state.battlers[1]!.statuses3 |= STATUS3_LEECHSEED | 0
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK

    runEndTurnEffects(state, [0, 1], DATA_CONTEXT)

    expect(state.battlers[1]!.mon.hp).toBe(70)
    expect(state.battlers[0]!.mon.hp).toBe(50) // No healing
  })

  it('ENDTURN_LEECH_SEED with Big Root on seeder buffs healing to 1.5x', () => {
    // Drain = 80 / 8 = 10. Heal = Math.trunc(10 * 3 / 2) = 15.
    const state = battle([{ hp: 50, maxHp: 100, itemId: 'ITEM_BIG_ROOT' }, { hp: 80, maxHp: 80, spe: 50 }], scriptedRng())
    state.battlers[1]!.statuses3 |= STATUS3_LEECHSEED | 0

    runEndTurnEffects(state, [0, 1], DATA_CONTEXT)

    expect(state.battlers[1]!.mon.hp).toBe(70)
    expect(state.battlers[0]!.mon.hp).toBe(65)
  })
})

describe('C quirks in the heal paths', () => {
  it('Recover on a bleeding user at full HP cures the bleed instead of failing', () => {
    // tryhealhalfhealth (:9260) zeroes the heal when CanBattlerHeal is false (bleed) and skips the full-HP jump;
    // jumpifstatus STATUS1_BLEED then reaches BattleScript_MoveUsedBleedHeal's curestatus (:7685-7689).
    const state = battle([{ hp: 100, maxHp: 100 }, { spe: 50 }], scriptedRng())
    state.battlers[0]!.mon.status1 = STATUS1_BLEED
    executeTurn(state, [useMove(0, MOVE_RECOVER), null], testDeps())
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Morning Sun still heals under Heal Block (recoverbasedonsunlight never checks CanBattlerHeal)', () => {
    const state = battle([{ hp: 10, maxHp: 120 }, { spe: 50 }], scriptedRng())
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    executeTurn(state, [useMove(0, MOVE_MORNING_SUN), null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(70)
  })

  it('Strength Sap heals a heal-blocked user when the Attack drop lands (StrengthSapMustLower -> StrengthSapHp)', () => {
    const state = battle([{ hp: 20, maxHp: 150 }, { atk: 100, spe: 50 }], scriptedRng())
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    executeTurn(state, [useMove(1, MOVE_STRENGTH_SAP), null], testDeps())
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.hp).toBe(120)
  })

  it('Pain Split draws no accuracy roll (NO_ACC_CALC_CHECK_LOCK_ON)', () => {
    const rng = scriptedRng()
    const state = battle([{ hp: 20, maxHp: 100 }, { hp: 80, maxHp: 100, spe: 50 }], rng)
    executeTurn(state, [useMove(1, MOVE_PAIN_SPLIT), null], testDeps())
    expect(rng.calls).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })
})
