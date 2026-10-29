// Unit tests for Cmd_moveend ladder skeleton, recoil, Life Orb, Rocky Helmet, last-move bookkeeping (cycle 31, step 5, batch 8a).
//
// Hand-derived from upstream C source code at pinned SHA:
// - Cmd_moveend (src/battle_script_commands.c:4309-4968)
// - MOVEEND_RECOIL (src/battle_script_commands.c:4457-4517)
// - MOVEEND_ITEM_EFFECTS_TARGET / Rocky Helmet (src/battle_util.c:6160-6169)
// - MOVEEND_LIFEORB_SHELLBELL / Life Orb (src/battle_util.c:6085-6110)
// - IsMoveMakingContact (src/battle_util.c:6554-6569)
// - GetRecoilFraction (tools/codegen/src/er/move/MoveRecoilGenerator.kt:14-20)
// - MOVEEND_UPDATE_LAST_MOVES (src/battle_script_commands.c:4723-4772)
// - MOVEEND_CHARGE (src/battle_script_commands.c:4922-4933)
// - MOVEEND_SUBSTITUTE (src/battle_script_commands.c:4714-4722)
// - MOVEEND_CLEAR_BITS (src/battle_script_commands.c:4934-4957)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  BATTLER_NONE,
  DEFAULT_STAT_STAGE,
  MOVE_UNSET,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_TOXIC_SPIKES,
  STATUS1_BURN,
  STATUS1_NONE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
  STATUS2_SUBSTITUTE,
  STATUS2_WRAPPED,
  STATUS3_CHARGED_UP,
  STATUS3_GASTRO_ACID,
  STATUS3_HEAL_BLOCK,
  STATUS3_LEECHSEED,
  STATUS3_MAGNET_RISE,
  STATUS3_ME_FIRST,
  STATUS3_SMACKED_DOWN,
  STATUS3_TELEKINESIS,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  WEATHER_SANDSTORM_TEMPORARY,
  hasFlag,
  statusInfatuatedWith,
} from './constants'
import {
  HALF_RECOIL_ABILITIES,
  KO_CRIT_BOOST_ABILITIES,
  KO_JAWS_OF_CARNAGE_ABILITIES,
  KO_SOUL_EATER_ABILITIES,
  KO_STAT_RAISES,
  NO_RECOIL_ABILITIES,
  ON_BATTLER_FAINTS_ABILITIES,
  ON_BATTLER_FAINTS_FOR,
  PORTED_ATTACKER_ABILITIES,
  ON_DEFENDER_ABILITIES,
  PORTED_DEFENDER_ABILITIES,
  RECOIL_FRACTIONS,
  runMoveEnd,
  runMoveEndBookkeeping,
} from './moveEnd'

// ---------------------------------------------------------------------------
// Verbatim Fixture Block from moveEffectsScreensHazards.test.ts
// ---------------------------------------------------------------------------

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
    sheerForceBoost: m.sheerForceBoost as true | undefined,
  }
}

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}

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

function fixedDamage(targetDamage: number, isCriticalHit?: boolean): DamageResolver {
  return {
    resolve: () => ({ targetDamage, attackerDamage: null, unmodelled: [], isCriticalHit: isCriticalHit ?? false }),
  }
}

function testDepsWithDamage(damageResolver: DamageResolver, holdEffects: Record<number, string> = {}): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const grounding: GroundingContext = { ...GROUNDING, holdEffectOf: (id) => holdEffects[id] ?? null }
  return { turnOrder: rest, grounding, damage: damageResolver, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

// ---------------------------------------------------------------------------
// Move & Ability Fixtures
// ---------------------------------------------------------------------------

const MOVE_TACKLE = requireMove('MOVE_TACKLE')
const MOVE_HEAD_CHARGE = requireMove('MOVE_HEAD_CHARGE')
const MOVE_DOUBLE_EDGE = requireMove('MOVE_DOUBLE_EDGE')
const MOVE_HEAD_SMASH = requireMove('MOVE_HEAD_SMASH')
const MOVE_WATER_GUN = requireMove('MOVE_WATER_GUN')
const MOVE_FIRE_PUNCH = requireMove('MOVE_FIRE_PUNCH')
const MOVE_THUNDERBOLT = requireMove('MOVE_THUNDERBOLT')
const MOVE_FLAMETHROWER = requireMove('MOVE_FLAMETHROWER')
const MOVE_RAPID_SPIN = requireMove('MOVE_RAPID_SPIN')
const MOVE_AQUA_FANG = requireMove('MOVE_AQUA_FANG')
// requireMove() omits effectChance (adding it would start firing secondary effects in every older test); Knock Off's
// seteffectwithchance needs moves.json's effectChance (100) as its percentChance.
const MOVE_KNOCK_OFF: SimMoveData = { ...requireMove('MOVE_KNOCK_OFF'), effectChance: movesById.get('MOVE_KNOCK_OFF')!.effectChance as number }
const MOVE_TAUNT = requireMove('MOVE_TAUNT')
const MOVE_TRANSFORM = requireMove('MOVE_TRANSFORM')
const MOVE_SKETCH = requireMove('MOVE_SKETCH')

const ABILITY_ROCK_HEAD = requireAbility('ABILITY_ROCK_HEAD')
const ABILITY_STEEL_BARREL = requireAbility('ABILITY_STEEL_BARREL')
const ABILITY_BRUTEFORCE = requireAbility('ABILITY_BRUTEFORCE')
const ABILITY_DAREDEVIL = requireAbility('ABILITY_DAREDEVIL')
const ABILITY_LIMBER = requireAbility('ABILITY_LIMBER')
const ABILITY_MAGIC_GUARD = requireAbility('ABILITY_MAGIC_GUARD')
const ABILITY_LONG_REACH = requireAbility('ABILITY_LONG_REACH')
const ABILITY_SHEER_FORCE = requireAbility('ABILITY_SHEER_FORCE')
const ABILITY_ROUGH_SKIN = requireAbility('ABILITY_ROUGH_SKIN')
const ABILITY_IRON_BARBS = requireAbility('ABILITY_IRON_BARBS')
const ABILITY_DOUBLE_IRON_BARBS = requireAbility('ABILITY_DOUBLE_IRON_BARBS')
const ABILITY_DRAGONFRUIT = requireAbility('ABILITY_DRAGONFRUIT')
const ABILITY_POISON_QUILLS = requireAbility('ABILITY_POISON_QUILLS')
const ABILITY_STATIC = requireAbility('ABILITY_STATIC')
const ABILITY_SHIELD_DUST = requireAbility('ABILITY_SHIELD_DUST')
const ABILITY_WHITE_NOISE = requireAbility('ABILITY_WHITE_NOISE')
const ABILITY_FLAME_BODY = requireAbility('ABILITY_FLAME_BODY')
const ABILITY_SMOLDERING_WOOD = requireAbility('ABILITY_SMOLDERING_WOOD')
const ABILITY_POISON_POINT = requireAbility('ABILITY_POISON_POINT')
const ABILITY_POISON_TOUCH = requireAbility('ABILITY_POISON_TOUCH')
const ABILITY_EFFECT_SPORE = requireAbility('ABILITY_EFFECT_SPORE')
const ABILITY_GOOEY = requireAbility('ABILITY_GOOEY')
const ABILITY_MOXIE = requireAbility('ABILITY_MOXIE')
const ABILITY_BEAST_BOOST = requireAbility('ABILITY_BEAST_BOOST')
const ABILITY_SOUL_HEART = requireAbility('ABILITY_SOUL_HEART')
const ABILITY_SOUL_EATER = requireAbility('ABILITY_SOUL_EATER')
const ABILITY_PREDATOR = requireAbility('ABILITY_PREDATOR')
const ABILITY_JAWS_OF_CARNAGE = requireAbility('ABILITY_JAWS_OF_CARNAGE')
const ABILITY_PRETENTIOUS = requireAbility('ABILITY_PRETENTIOUS')
const ABILITY_RAMPAGE = requireAbility('ABILITY_RAMPAGE')
const ABILITY_STICKY_HOLD = requireAbility('ABILITY_STICKY_HOLD')
const ABILITY_AFTERMATH = requireAbility('ABILITY_AFTERMATH')
const ABILITY_ABSORBANT = requireAbility('ABILITY_ABSORBANT')
const ABILITY_MOLD_BREAKER = requireAbility('ABILITY_MOLD_BREAKER')
const ABILITY_STAMINA = requireAbility('ABILITY_STAMINA')
const ABILITY_WEAK_ARMOR = requireAbility('ABILITY_WEAK_ARMOR')
const ABILITY_ANGER_POINT = requireAbility('ABILITY_ANGER_POINT')
const ABILITY_BERSERK = requireAbility('ABILITY_BERSERK')
const ABILITY_CUTE_CHARM = requireAbility('ABILITY_CUTE_CHARM')
const ABILITY_TOXIC_DEBRIS = requireAbility('ABILITY_TOXIC_DEBRIS')
const ABILITY_LOOSE_QUILLS = requireAbility('ABILITY_LOOSE_QUILLS')
const ABILITY_SAND_SPIT = requireAbility('ABILITY_SAND_SPIT')
const ABILITY_INFLATABLE = requireAbility('ABILITY_INFLATABLE')
const ABILITY_GUILT_TRIP = requireAbility('ABILITY_GUILT_TRIP')
const ABILITY_STEAM_ENGINE = requireAbility('ABILITY_STEAM_ENGINE')
const MOVE_MEGA_DRAIN = requireMove('MOVE_MEGA_DRAIN')
const MOVE_HYPER_VOICE = requireMove('MOVE_HYPER_VOICE')
const ABILITY_GROWING_TOOTH = requireAbility('ABILITY_GROWING_TOOTH')
const ABILITY_ENVENOM = requireAbility('ABILITY_ENVENOM')
const ABILITY_STENCH = requireAbility('ABILITY_STENCH')
const ABILITY_DAMP = requireAbility('ABILITY_DAMP')
const ABILITY_PURE_LOVE = requireAbility('ABILITY_PURE_LOVE')
const ABILITY_ILLUMINATE = requireAbility('ABILITY_ILLUMINATE')
const ABILITY_LOUD_BANG = requireAbility('ABILITY_LOUD_BANG')
const ABILITY_GRIP_PINCER = requireAbility('ABILITY_GRIP_PINCER')
const ABILITY_VOLCANO_RAGE = requireAbility('ABILITY_VOLCANO_RAGE')
const ABILITY_PICKPOCKET = requireAbility('ABILITY_PICKPOCKET')
const ABILITY_NOSFERATU = requireAbility('ABILITY_NOSFERATU')

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe('MOVEEND_RECOIL: Recoil Moves', () => {
  it('applies 25% recoil (EFFECT_RECOIL_25, Head Charge -- Take Down is EFFECT_SPEED_DOWN_HIT in Elite Redux): floor(40 / 4) = 10 self-damage', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_HEAD_CHARGE), null], testDepsWithDamage(fixedDamage(40)))

    expect(state.battlers[1]!.mon.hp).toBe(60) // 100 - 40
    expect(state.battlers[0]!.mon.hp).toBe(90) // 100 - 10
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.targetDamage).toBe(40)
    expect(act.attackerDamage).toBe(10)
  })

  it('applies 33% recoil (EFFECT_RECOIL_33, Double-Edge): floor(60 / 3) = 20 self-damage', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[1]!.mon.hp).toBe(40) // 100 - 60
    expect(state.battlers[0]!.mon.hp).toBe(80) // 100 - 20
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(20)
  })

  it('applies 50% recoil (EFFECT_RECOIL_50, Head Smash): floor(50 / 2) = 25 self-damage', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_HEAD_SMASH), null], testDepsWithDamage(fixedDamage(50)))

    expect(state.battlers[1]!.mon.hp).toBe(50) // 100 - 50
    expect(state.battlers[0]!.mon.hp).toBe(75) // 100 - 25
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(25)
  })

  it('enforces minimum 1 recoil damage when division truncates to 0', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(1)))

    expect(state.battlers[1]!.mon.hp).toBe(99) // 100 - 1
    expect(state.battlers[0]!.mon.hp).toBe(99) // 100 - max(1, floor(1/3)) = 100 - 1
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(1)
  })

  it('deals no recoil when target took 0 damage (e.g. immunity / dummyDamage)', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(0)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('blocks recoil with Rock Head (ABILITY_ROCK_HEAD)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_ROCK_HEAD, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('blocks recoil with Steel Barrel (ABILITY_STEEL_BARREL)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_STEEL_BARREL, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('blocks recoil with Bruteforce (ABILITY_BRUTEFORCE)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_BRUTEFORCE, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('blocks recoil with Magic Guard (ABILITY_MAGIC_GUARD)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_MAGIC_GUARD, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('halves recoil with Daredevil (ABILITY_DAREDEVIL): floor(20 / 2) = 10', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_DAREDEVIL, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(90) // 100 - 10
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(10)
  })

  it('halves recoil with Limber (ABILITY_LIMBER): floor(20 / 2) = 10', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_LIMBER, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(90) // 100 - 10
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(10)
  })
})

describe('MOVEEND_LIFEORB_SHELLBELL: Life Orb', () => {
  it('deals floor(maxHp / 10) self-damage on damaging hit: floor(100 / 10) = 10', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(50), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[1]!.mon.hp).toBe(50) // 100 - 50
    expect(state.battlers[0]!.mon.hp).toBe(90) // 100 - 10
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(10)
  })

  it('enforces minimum 1 Life Orb self-damage on low maxHp', () => {
    const state = battle([{ hp: 5, maxHp: 5 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(50), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(4) // 5 - 1
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(1)
  })

  it('does NOT deal Life Orb damage when target took 0 damage', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(0), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is blocked by Magic Guard (ABILITY_MAGIC_GUARD)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_MAGIC_GUARD, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(50), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is negated by Sheer Force on boosted moves (Flamethrower)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_SHEER_FORCE, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, MOVE_FLAMETHROWER), null],
      testDepsWithDamage(fixedDamage(50), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(100) // Sheer Force negates Life Orb recoil
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is NOT negated by Sheer Force on non-boosted moves (Tackle)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_SHEER_FORCE, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(50), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(90) // Life Orb recoil applies
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(10)
  })
})

describe('MOVEEND_ITEM_EFFECTS_TARGET: Rocky Helmet', () => {
  it('deals floor(attacker.maxHp / 6) on contact hit: floor(120 / 6) = 20', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(30), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[1]!.mon.hp).toBe(70) // 100 - 30
    expect(state.battlers[0]!.mon.hp).toBe(100) // 120 - 20
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(20)
  })

  it('does NOT deal damage on non-contact hit (Water Gun)', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_WATER_GUN), null],
      testDepsWithDamage(fixedDamage(30), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is prevented by Protective Pads (HOLD_EFFECT_PROTECTIVE_PADS) on contact', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(30), { 0: 'HOLD_EFFECT_PROTECTIVE_PADS', 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is prevented by Punching Glove (HOLD_EFFECT_PUNCHING_GLOVE) on punch-based move (Fire Punch)', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_FIRE_PUNCH), null],
      testDepsWithDamage(fixedDamage(30), { 0: 'HOLD_EFFECT_PUNCHING_GLOVE', 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is NOT prevented by Punching Glove on non-punch contact move (Tackle)', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(30), { 0: 'HOLD_EFFECT_PUNCHING_GLOVE', 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(100) // 120 - 20
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(20)
  })

  it('is prevented by Long Reach (ABILITY_LONG_REACH)', () => {
    const state = battle(
      [{ hp: 120, maxHp: 120, abilities: { ability: ABILITY_LONG_REACH, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(30), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is blocked by Magic Guard (ABILITY_MAGIC_GUARD)', () => {
    const state = battle(
      [{ hp: 120, maxHp: 120, abilities: { ability: ABILITY_MAGIC_GUARD, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(30), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('does NOT trigger when target took 0 damage', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(0), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })
})

describe('Ordering & Interactions: Rocky Helmet (13), Recoil (23), Life Orb (26)', () => {
  it('applies Rocky Helmet then Recoil in C enum order when attacker survives both', () => {
    // Attacker: maxHp 120, hp 120.
    // Target: holds Rocky Helmet, takes 60 damage from Double-Edge (33% recoil).
    // Step 13 (Rocky Helmet): floor(120 / 6) = 20 damage. Attacker HP drops to 100.
    // Step 23 (Recoil): floor(60 / 3) = 20 damage. Attacker HP drops to 80.
    // Total attackerDamage = 40.
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_DOUBLE_EDGE), null],
      testDepsWithDamage(fixedDamage(60), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[1]!.mon.hp).toBe(40) // 100 - 60
    expect(state.battlers[0]!.mon.hp).toBe(80) // 120 - 20 (helmet) - 20 (recoil)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(40)
    expect(act.fainted).toEqual([])
  })

  it('faints attacker from Rocky Helmet (13), suppressing subsequent Recoil (23) and Life Orb (26)', () => {
    // Attacker: maxHp 120, hp 15. Holds Life Orb.
    // Target: holds Rocky Helmet, takes 60 damage from Double-Edge.
    // Step 13 (Rocky Helmet): floor(120 / 6) = 20 damage >= 15 hp -> attacker FAINTS (hp = 0).
    // Step 23 (Recoil): REQUIRE(IsBattlerAlive) -> skipped!
    // Step 26 (Life Orb): REQUIRE(IsBattlerAlive) -> skipped!
    // Total attackerDamage = 20.
    const state = battle([{ hp: 15, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_DOUBLE_EDGE), null],
      testDepsWithDamage(fixedDamage(60), { 0: 'HOLD_EFFECT_LIFE_ORB', 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(0)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(20) // Only the 20 damage from helmet, no recoil or Life Orb added
    expect(act.fainted).toContain(0)
  })

  it('applies Rocky Helmet (13) + Recoil (23) + Life Orb (26) in order when attacker survives all three', () => {
    // Attacker: maxHp 120, hp 120. Holds Life Orb.
    // Target: holds Rocky Helmet, takes 60 damage from Double-Edge.
    // Step 13 (Rocky Helmet): floor(120 / 6) = 20 damage -> hp becomes 100.
    // Step 23 (Recoil): floor(60 / 3) = 20 damage -> hp becomes 80.
    // Step 26 (Life Orb): floor(120 / 10) = 12 damage -> hp becomes 68.
    // Total attackerDamage = 20 + 20 + 12 = 52.
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_DOUBLE_EDGE), null],
      testDepsWithDamage(fixedDamage(60), { 0: 'HOLD_EFFECT_LIFE_ORB', 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(68)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(52)
  })
})

describe('State Bookkeeping & Clear Bits', () => {
  it('MOVEEND_UPDATE_LAST_MOVES (17): updates attacker.lastMove', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    expect(state.battlers[0]!.lastMove).toBeNull()

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state.battlers[0]!.lastMove).toBe('MOVE_TACKLE')
  })

  it('MOVEEND_UPDATE_LAST_MOVES (17): hit updates attacker lastMove/lastResultingMove/lastPrintedMove, global lastUsedMove, target lastHitBy/lastLandedMove/lastHitByType', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    expect(state.battlers[0]!.lastMove).toBeNull()
    expect(state.battlers[0]!.lastResultingMove).toBeNull()
    expect(state.battlers[0]!.lastPrintedMove).toBeNull()
    expect(state.battlers[1]!.lastHitBy).toBe(BATTLER_NONE)
    expect(state.battlers[1]!.lastLandedMove).toBeNull()
    expect(state.battlers[1]!.lastHitByType).toBeNull()
    expect(state.lastUsedMove).toBeNull()
    expect(state.lastTakenMove[1]).toBeNull()
    expect(state.lastTakenMoveFrom[1][0]).toBeNull()

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state.battlers[0]!.lastMove).toBe('MOVE_TACKLE')
    expect(state.battlers[0]!.lastResultingMove).toBe('MOVE_TACKLE')
    expect(state.battlers[0]!.lastPrintedMove).toBe('MOVE_TACKLE')
    expect(state.battlers[1]!.lastHitBy).toBe(0)
    expect(state.battlers[1]!.lastLandedMove).toBe('MOVE_TACKLE')
    expect(state.battlers[1]!.lastHitByType).toBe('NORMAL')
    expect(state.lastUsedMove).toBe('MOVE_TACKLE')
    expect(state.lastTakenMove[1]).toBe('MOVE_TACKLE')
    expect(state.lastTakenMoveFrom[1][0]).toBe('MOVE_TACKLE')
  })

  // Aqua Fang: a damaging move without the mirrorMoveAffected flag (Counter used to stand in, but it now fails when nothing hit the user first).
  it('MOVEEND_MIRROR_MOVE (18): move without mirrorMoveAffected does not set lastTakenMove', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_AQUA_FANG), null], testDepsWithDamage(fixedDamage(20)))

    expect(state.battlers[1]!.lastLandedMove).toBe('MOVE_AQUA_FANG')
    expect(state.lastTakenMove[1]).toBeNull()
    expect(state.lastTakenMoveFrom[1][0]).toBeNull()
  })

  it('MOVEEND_MIRROR_MOVE (18): faint clears lastTakenMove and lastTakenMoveFrom (FaintClearSetData, battle_main.c:2982-2995)', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(100)))

    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(state.lastTakenMove[1]).toBeNull()
    expect(state.lastTakenMoveFrom[1][0]).toBeNull()
  })

  describe('Cycle 73: last-move bookkeeping for status moves and misses; Transform / Sketch chosen-move quirk', () => {
    it('MOVEEND on miss: writes attacker lastMove/lastResultingMove/lastPrintedMove, global lastUsedMove, target lastHitBy and lastLandedMove = MOVE_UNSET, and clears bits', () => {
      const rng = scriptedRng([99, 0])
      const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], rng)
      state.battlers[0]!.mon.statStages[STAT_ACC] = 0 // -6 accuracy stages: 100 * 3/9 = 33 -> 99 >= 33 misses
      state.battlers[0]!.statuses3 |= STATUS3_ME_FIRST
      state.battlers[0]!.turn.gemBoost = true

      const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

      expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
      expect(state.battlers[0]!.lastMove).toBe('MOVE_TACKLE')
      expect(state.battlers[0]!.lastResultingMove).toBe('MOVE_TACKLE')
      expect(state.battlers[0]!.lastPrintedMove).toBe('MOVE_TACKLE')
      expect(state.lastUsedMove).toBe('MOVE_TACKLE')
      expect(state.battlers[1]!.lastHitBy).toBe(0)
      expect(state.battlers[1]!.lastLandedMove).toBe(MOVE_UNSET)
      expect(state.lastTakenMove[1]).toBeNull()
      expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ME_FIRST)).toBe(false)
      expect(state.battlers[0]!.turn.gemBoost).toBe(false)
    })

    it('MOVEEND on status move: connected Taunt writes target lastLandedMove, lastHitBy, lastHitByType, and Mirror Move lastTakenMove', () => {
      const state = battle([{ spe: 100, hp: 100, maxHp: 100 }, { spe: 50, hp: 100, maxHp: 100 }], scriptedRng())
      const out = executeTurn(state, [useMove(1, MOVE_TAUNT), null], testDepsWithDamage(fixedDamage(0)))

      const act0 = out.actions.find((a) => a.battlerId === 0)!
      expect(act0.missed).toBe(false)
      expect(state.battlers[0]!.lastMove).toBe('MOVE_TAUNT')
      expect(state.battlers[0]!.lastResultingMove).toBe('MOVE_TAUNT')
      expect(state.battlers[0]!.lastPrintedMove).toBe('MOVE_TAUNT')
      expect(state.lastUsedMove).toBe('MOVE_TAUNT')
      expect(state.battlers[1]!.lastHitBy).toBe(0)
      expect(state.battlers[1]!.lastLandedMove).toBe('MOVE_TAUNT')
      expect(state.battlers[1]!.lastHitByType).toBe('DARK')
      expect(state.lastTakenMove[1]).toBe('MOVE_TAUNT')
      expect(state.lastTakenMoveFrom[1][0]).toBe('MOVE_TAUNT')
    })

    it('MOVEEND on Transform: writes lastMove = MOVE_UNSET, lastPrintedMove = MOVE_UNSET, lastResultingMove = MOVE_TRANSFORM, lastUsedMove = MOVE_TRANSFORM, target lastLandedMove = MOVE_UNSET', () => {
      const state = battle([{ spe: 100, hp: 100, maxHp: 100 }, { spe: 50, hp: 100, maxHp: 100 }], scriptedRng())
      const out = executeTurn(state, [useMove(1, MOVE_TRANSFORM), null], testDepsWithDamage(fixedDamage(0)))

      const act0 = out.actions.find((a) => a.battlerId === 0)!
      expect(act0.missed).toBe(false)
      expect(state.battlers[0]!.lastMove).toBe(MOVE_UNSET)
      expect(state.battlers[0]!.lastPrintedMove).toBe(MOVE_UNSET)
      expect(state.battlers[0]!.lastResultingMove).toBe('MOVE_TRANSFORM')
      expect(state.lastUsedMove).toBe('MOVE_TRANSFORM')
      expect(state.battlers[1]!.lastHitBy).toBe(0)
      expect(state.battlers[1]!.lastLandedMove).toBe(MOVE_UNSET)
      expect(state.lastTakenMove[1]).toBeNull()
    })

    it('MOVEEND on Sketch: writes lastMove = MOVE_UNSET, lastPrintedMove = MOVE_UNSET, lastResultingMove = MOVE_SKETCH, lastUsedMove = MOVE_SKETCH, target lastLandedMove = MOVE_UNSET', () => {
      const state = battle(
        [
          { spe: 100, moves: ['MOVE_SKETCH', null, null, null], hp: 100, maxHp: 100 },
          { spe: 50, hp: 100, maxHp: 100 },
        ],
        scriptedRng(),
      )
      state.battlers[1]!.lastPrintedMove = 'MOVE_EMBER'

      const out = executeTurn(state, [useMove(1, MOVE_SKETCH), null], testDepsWithDamage(fixedDamage(0)))

      const act0 = out.actions.find((a) => a.battlerId === 0)!
      expect(act0.missed).toBe(false)
      expect(state.battlers[0]!.lastMove).toBe(MOVE_UNSET)
      expect(state.battlers[0]!.lastPrintedMove).toBe(MOVE_UNSET)
      expect(state.battlers[0]!.lastResultingMove).toBe('MOVE_SKETCH')
      expect(state.lastUsedMove).toBe('MOVE_SKETCH')
      expect(state.battlers[1]!.lastHitBy).toBe(0)
      expect(state.battlers[1]!.lastLandedMove).toBe(MOVE_UNSET)
      expect(state.lastTakenMove[1]).toBeNull()
    })

    it('MOVEEND during processingExtraAttacks: writes only what C writes (target lastHitBy, lastLandedMove, lastHitByType, Mirror Move; leaves attacker lastMove/lastPrintedMove/lastResultingMove and global lastUsedMove unchanged; leaves rolloutCounter untouched)', () => {
      const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
      state.processingExtraAttacks = true
      state.battlers[0]!.lastMove = 'MOVE_HEAD_CHARGE'
      state.battlers[0]!.lastResultingMove = 'MOVE_HEAD_CHARGE'
      state.battlers[0]!.lastPrintedMove = 'MOVE_HEAD_CHARGE'
      state.lastUsedMove = 'MOVE_HEAD_CHARGE'
      state.battlers[0]!.volatiles.rolloutCounter = 3

      runMoveEnd({
        state,
        attackerId: 0,
        targetId: 1,
        moveId: 'MOVE_TACKLE',
        chosenMoveId: 'MOVE_TACKLE',
        targetDamage: 20,
        hpDealt: 20,
        deps: testDepsWithDamage(fixedDamage(20)),
        unmodelled: [],
        fainted: [],
      })

      // Attacker bookkeeping must be untouched (:4738, 4749, 4943)
      expect(state.battlers[0]!.lastMove).toBe('MOVE_HEAD_CHARGE')
      expect(state.battlers[0]!.lastResultingMove).toBe('MOVE_HEAD_CHARGE')
      expect(state.battlers[0]!.lastPrintedMove).toBe('MOVE_HEAD_CHARGE')
      expect(state.lastUsedMove).toBe('MOVE_HEAD_CHARGE')
      expect(state.battlers[0]!.volatiles.rolloutCounter).toBe(3)

      // Target bookkeeping and Mirror Move must be written (:4758, 4764, 4777)
      expect(state.battlers[1]!.lastHitBy).toBe(0)
      expect(state.battlers[1]!.lastLandedMove).toBe('MOVE_TACKLE')
      expect(state.battlers[1]!.lastHitByType).toBe('NORMAL')
      expect(state.lastTakenMove[1]).toBe('MOVE_TACKLE')
      expect(state.lastTakenMoveFrom[1][0]).toBe('MOVE_TACKLE')
    })

    it('MOVEEND with originallyUsedMove as Baton Pass: skips lastMove/lastResultingMove and target lastHitBy/lastLandedMove', () => {
      const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
      state.battlers[0]!.lastMove = null
      state.battlers[0]!.lastResultingMove = null
      state.battlers[1]!.lastHitBy = BATTLER_NONE
      state.battlers[1]!.lastLandedMove = null

      runMoveEndBookkeeping({
        state,
        attackerId: 0,
        targetId: 1,
        currentMoveId: 'MOVE_BATON_PASS',
        chosenMoveId: 'MOVE_BATON_PASS',
        deps: testDepsWithDamage(fixedDamage(0)),
        noEffect: false,
        obeys: true,
        fainted: [],
      })

      // Baton Pass guard (:4747): skips attacker lastMove/lastResultingMove and target lastHitBy/lastLandedMove
      expect(state.battlers[0]!.lastMove).toBeNull()
      expect(state.battlers[0]!.lastResultingMove).toBeNull()
      expect(state.battlers[1]!.lastHitBy).toBe(BATTLER_NONE)
      expect(state.battlers[1]!.lastLandedMove).toBeNull()
      // but lastPrintedMove and lastUsedMove are still set (:4742-4743)
      expect(state.battlers[0]!.lastPrintedMove).toBe('MOVE_BATON_PASS')
      expect(state.lastUsedMove).toBe('MOVE_BATON_PASS')
    })
  })

  it('MOVEEND_CHARGE (24): clears STATUS3_CHARGED_UP on Electric damaging move', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    state.battlers[0]!.statuses3 |= STATUS3_CHARGED_UP
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)

    executeTurn(state, [useMove(1, MOVE_THUNDERBOLT), null], testDepsWithDamage(fixedDamage(50)))

    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(false)
  })

  it('MOVEEND_SUBSTITUTE (16): clears STATUS2_SUBSTITUTE and sets substituteDestroyedThisTurn if substituteHp is 0', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 0
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(true)

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(false)
    // MOVEEND_SUBSTITUTE set it, and ENDTURN_EMBARGO clears it for every battler at the end of
    // the turn (battle_util.c:2871), so it is false again once executeTurn returns.
    expect(state.battlers[1]!.volatiles.substituteDestroyedThisTurn).toBe(false)
  })

  it('MOVEEND_CLEAR_BITS (30): resets rolloutCounter, targetAffected, gemBoost, berryReduced', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    state.battlers[0]!.volatiles.rolloutCounter = 3
    state.battlers[0]!.round.targetAffected = true
    state.battlers[0]!.turn.gemBoost = true
    state.battlers[1]!.turn.berryReduced = true

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state.battlers[0]!.volatiles.rolloutCounter).toBe(0)
    expect(state.battlers[0]!.round.targetAffected).toBe(false)
    expect(state.battlers[0]!.turn.gemBoost).toBe(false)
    expect(state.battlers[1]!.turn.berryReduced).toBe(false)
  })
})

describe('Conditional Gaps (Out-of-scope abilities, items, moves)', () => {
  it('conditionally gaps defender contact ability (ABILITY_AFTERMATH) on damaged target', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_AFTERMATH, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.unmodelled).toContain('move-end defender ability ABILITY_AFTERMATH is not modelled yet')
  })

  it('conditionally gaps an unported attacker ability (ABILITY_BACKFLIP) on damaging hit', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: requireAbility('ABILITY_BACKFLIP'), innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.unmodelled).toContain('move-end attacker ability ABILITY_BACKFLIP is not modelled yet')
  })

  it('conditionally gaps an unported on-faint ability (ABILITY_RAMPAGE, APPLY_ON_ATTACKER) when its holder KOs', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_RAMPAGE, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(act.unmodelled).toContain('on-faint ability ABILITY_RAMPAGE is not modelled yet')
  })

  it('does not gap an unported on-faint ability when nobody faints', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_RAMPAGE, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.unmodelled).not.toContain('on-faint ability ABILITY_RAMPAGE is not modelled yet')
  })

  it('does not gap an APPLY_ON_ATTACKER ability held by the fainted battler or when it is not the attacker', () => {
    // The defender holds Rampage and survives; the attacker faints to Rocky Helmet. Attacker = MAX_BATTLERS_COUNT in
    // VARIOUS_ON_FAINTED_BY_OTHER (battle_script_commands.c:7167), so APPLY_ON_ATTACKER matches nobody.
    const state = battle(
      [
        { hp: 15, maxHp: 120 },
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_RAMPAGE, innates: [null, null, null] } },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(10), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toEqual([0])
    expect(act.unmodelled).not.toContain('on-faint ability ABILITY_RAMPAGE is not modelled yet')
  })

  it('no longer gaps Rapid Spin hazard/binding removal (hazards.ts rapidSpinFree)', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_RAPID_SPIN), null], testDepsWithDamage(fixedDamage(20)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.unmodelled).not.toContain('Rapid Spin hazard/binding removal is not modelled yet')
  })
})

describe('Oracle Tests: Pinned Ability Sets & Recoil Fractions', () => {
  it('NO_RECOIL_ABILITIES pins Rock Head, Steel Barrel, Bruteforce', () => {
    expect(Array.from(NO_RECOIL_ABILITIES).sort()).toEqual([
      'ABILITY_BRUTEFORCE',
      'ABILITY_ROCK_HEAD',
      'ABILITY_STEEL_BARREL',
    ])
  })

  it('HALF_RECOIL_ABILITIES pins Daredevil, Limber', () => {
    expect(Array.from(HALF_RECOIL_ABILITIES).sort()).toEqual([
      'ABILITY_DAREDEVIL',
      'ABILITY_LIMBER',
    ])
  })

  it('RECOIL_FRACTIONS pins exact denominators for the 5 recoil effects', () => {
    expect(RECOIL_FRACTIONS).toEqual({
      EFFECT_RECOIL_25: 4,
      EFFECT_RECOIL_33: 3,
      EFFECT_RECOIL_50: 2,
      EFFECT_FLINCH_RECOIL_33: 3,
      EFFECT_FLINCH_RECOIL_50: 2,
    })
  })

  it('PORTED_DEFENDER_ABILITIES pins all 103 ported onDefender abilities, each with an onDefender hook', () => {
    expect(Array.from(PORTED_DEFENDER_ABILITIES).sort()).toEqual([
      'ABILITY_ANGER_POINT',
      'ABILITY_ANGER_SHELL',
      'ABILITY_ATOMIC_BURST',
      'ABILITY_BALLOON_BLITZ',
      'ABILITY_BALLOON_BOMBER',
      'ABILITY_BERSERK',
      'ABILITY_BERSERKER_RAGE',
      'ABILITY_BLIGHT_SCALE',
      'ABILITY_BRAIN_OVERLOAD',
      'ABILITY_CHILLING_PELLETS',
      'ABILITY_COLD_REBOUND',
      'ABILITY_COTTON_DOWN',
      'ABILITY_CRISPY_CREAM',
      'ABILITY_CROWNED_SHIELD',
      'ABILITY_CROWNED_SWORD',
      'ABILITY_CRYO_PROFICIENCY',
      'ABILITY_CURSED_BODY',
      'ABILITY_CUTE_CHARM',
      'ABILITY_DAMP',
      'ABILITY_DEFLECT',
      'ABILITY_DOUBLE_IRON_BARBS',
      'ABILITY_DRAGONFRUIT',
      'ABILITY_DROP_BLOCKS',
      'ABILITY_EFFECT_SPORE',
      'ABILITY_ELECTROMORPHOSIS',
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
      'ABILITY_HAUNTED_SPIRIT',
      'ABILITY_HYPNOTIC_TOUCH',
      'ABILITY_ICE_DOWNFALL',
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
      'ABILITY_MOUSTACHE',
      'ABILITY_MUCUS_MEMBRANE',
      'ABILITY_MUMMY',
      'ABILITY_NO_TURNING_BACK',
      'ABILITY_PARRY',
      'ABILITY_PERISH_BODY',
      'ABILITY_POISON_POINT',
      'ABILITY_POISON_QUILLS',
      'ABILITY_POISON_TOUCH',
      'ABILITY_POWER_LEAK',
      'ABILITY_PRIM_AND_PROPER',
      'ABILITY_PURE_LOVE',
      'ABILITY_RAGE_POINT',
      'ABILITY_RATTLED',
      'ABILITY_RESILIENCE',
      'ABILITY_ROUGH_SKIN',
      'ABILITY_SAND_SPIT',
      'ABILITY_SCARECROW',
      'ABILITY_SCRAPYARD',
      'ABILITY_SEED_SOWER',
      'ABILITY_SHATTERED_ARMOR',
      'ABILITY_SLIME_MOLD',
      'ABILITY_SMOLDERING_WOOD',
      'ABILITY_SNAP_TRAP_WHEN_HIT',
      'ABILITY_SPIKE_ARMOR',
      'ABILITY_SPITEFUL',
      'ABILITY_STAMINA',
      'ABILITY_STATIC',
      'ABILITY_STEAM_ENGINE',
      'ABILITY_STRIKEOUT',
      'ABILITY_SUPERSWEET_SYRUP',
      'ABILITY_SUPER_HOT_GOO',
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
      'ABILITY_WIND_CHIMES',
      'ABILITY_WIND_POWER',
    ])
    for (const id of PORTED_DEFENDER_ABILITIES) expect(ON_DEFENDER_ABILITIES.has(id)).toBe(true)
  })

  it('PORTED_ATTACKER_ABILITIES pins all 90 attacker abilities and aliases', () => {
    expect(Array.from(PORTED_ATTACKER_ABILITIES).sort()).toEqual([
      'ABILITY_ABSORBANT',
      'ABILITY_AFTERMATH',
      'ABILITY_AFTERSHOCK',
      'ABILITY_ANGELS_WRATH',
      'ABILITY_ARCHMAGE',
      'ABILITY_ASSASSINS_TOOLS',
      'ABILITY_ATOMIC_BURST',
      'ABILITY_BEAUTIFUL_MUSIC',
      'ABILITY_BLADE_DANCE',
      'ABILITY_BLIGHT_SCALE',
      'ABILITY_CHAINSAW',
      'ABILITY_CRUSHING_JAW',
      'ABILITY_CRYO_PROFICIENCY',
      'ABILITY_CUTE_CHARM',
      'ABILITY_DAMP',
      'ABILITY_DAREDEVIL',
      'ABILITY_DEAD_POWER',
      'ABILITY_DEEP_CUTS',
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
      'ABILITY_FRAGRANT_DAZE',
      'ABILITY_FREEZING_POINT',
      'ABILITY_FROM_THE_SHADOWS',
      'ABILITY_FROSTMAW',
      'ABILITY_FUNGAL_INFECTION',
      'ABILITY_GALVANIZE',
      'ABILITY_GHOST_PEPPER',
      'ABILITY_GRASS_FLUTE',
      'ABILITY_GRIP_PINCER',
      'ABILITY_GROWING_TOOTH',
      'ABILITY_HARDENED_SHEATH',
      'ABILITY_HAUNTING_FRENZY',
      'ABILITY_HIGH_TIDE',
      'ABILITY_HYDRATE',
      'ABILITY_HYPNOTIC_TOUCH',
      'ABILITY_ILLUMINATE',
      'ABILITY_IMMOLATE',
      'ABILITY_INTOXICATE',
      'ABILITY_LEAD_CLAWS',
      'ABILITY_LOUD_BANG',
      'ABILITY_MAGICAL_DUST',
      'ABILITY_MENACING_SITUATION',
      'ABILITY_MINERALIZE',
      'ABILITY_MOB_BOSS',
      'ABILITY_MOLTEN_COAT',
      'ABILITY_PICKPOCKET',
      'ABILITY_PIXILATE',
      'ABILITY_POISON_POINT',
      'ABILITY_POISON_QUILLS',
      'ABILITY_POISON_TOUCH',
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
      'ABILITY_SPIKE_ARMOR',
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
    ])
  })
})

describe('MOVEEND_RECOIL uses savedDmg', () => {
  it('recoil is a fraction of the HP actually dealt (gHpDealt, battle_script_commands.c:4335), not the overkill damage', () => {
    // Double-Edge (EFFECT_RECOIL_33) for 300 into a 90-HP target: savedDmg = 90, recoil = floor(90 / 3) = 30.
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 90, maxHp: 100 }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(300)))
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(70)
  })
})

describe('MOVEEND_ABILITIES (Case 5): Defender Contact Abilities', () => {
  it('Rough Skin deals floor(maxHp / 8) damage on contact hit (Tackle)', () => {
    // Attacker: 100 max HP -> floor(100 / 8) = 12 damage.
    // Defender: holds Rough Skin.
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ROUGH_SKIN, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[1]!.mon.hp).toBe(70) // 100 - 30
    expect(state.battlers[0]!.mon.hp).toBe(88) // 100 - 12
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(12)
  })

  it('Iron Barbs deals floor(maxHp / 8) damage on contact hit (Tackle)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_IRON_BARBS, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(88) // 100 - 12
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(12)
  })

  it('Double Iron Barbs deals floor(maxHp / 6) damage on contact hit (Tackle)', () => {
    // Attacker: 100 max HP -> floor(100 / 6) = 16 damage.
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_DOUBLE_IRON_BARBS, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(84) // 100 - 16
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(16)
  })

  it('Dragonfruit deals floor(maxHp / 8) damage on contact hit (Tackle)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_DRAGONFRUIT, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(88)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(12)
  })

  it('Rough Skin does NOT deal damage on non-contact hit (Water Gun)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ROUGH_SKIN, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('Rough Skin recoil is blocked by attacker Magic Guard', () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_MAGIC_GUARD, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ROUGH_SKIN, innates: [null, null, null] } },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('Static paralyzes attacker on contact hit when roll < 30', () => {
    // Contact hit (Tackle): 30% chance. Roll 15 < 30 -> paralyzed.
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_STATIC, innates: [null, null, null] } }],
      scriptedRng([0, 15]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'PARALYSIS' })
  })

  it('Static does NOT paralyze attacker on failing roll (roll >= 30)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_STATIC, innates: [null, null, null] } }],
      scriptedRng([0, 30]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toBeNull()
  })

  it('Static paralyzes attacker on non-contact hit (Water Gun) with 10% chance (roll < 10)', () => {
    // Non-contact hit: 10% chance. Roll 5 < 10 -> paralyzed.
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_STATIC, innates: [null, null, null] } }],
      scriptedRng([0, 5]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'PARALYSIS' })
  })

  it('Static does NOT paralyze attacker on non-contact hit if roll >= 10', () => {
    // Non-contact hit: 10% chance. Roll 15 >= 10 -> no paralysis.
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_STATIC, innates: [null, null, null] } }],
      scriptedRng([0, 15]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toBeNull()
  })

  it('White Noise (Static alias) paralyzes attacker on contact hit', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_WHITE_NOISE, innates: [null, null, null] } }],
      scriptedRng([0, 10]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'PARALYSIS' })
  })

  it('Flame Body burns attacker on contact hit (30% chance, roll < 30)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_FLAME_BODY, innates: [null, null, null] } }],
      scriptedRng([0, 10]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'BURN' })
  })

  it('Flame Body burns attacker on non-contact hit with 20% chance (roll < 20)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_FLAME_BODY, innates: [null, null, null] } }],
      scriptedRng([0, 15]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'BURN' })
  })

  it('Smoldering Wood (Flame Body alias) burns attacker on contact hit', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_SMOLDERING_WOOD, innates: [null, null, null] } }],
      scriptedRng([0, 10]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'BURN' })
  })

  it('Poison Point poisons attacker on contact hit (30% chance, roll < 30)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_POISON_POINT, innates: [null, null, null] } }],
      scriptedRng([0, 10]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_POISON)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'POISON' })
  })

  it('Poison Point does NOT poison on non-contact hit (Water Gun) even with roll < 30', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_POISON_POINT, innates: [null, null, null] } }],
      scriptedRng([0, 10]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toBeNull()
  })

  it('Poison Quills deals Rough Skin recoil (12) and can poison attacker on contact', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_POISON_QUILLS, innates: [null, null, null] } }],
      scriptedRng([0, 10]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(76) // 100 - 12 recoil - 12 end-turn poison (maxHp / 8)
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_POISON)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(12)
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'POISON' })
  })
})

describe('MOVEEND_ABILITIES (Case 5): Effect Spore Draw Branches', () => {
  it('Branch 0 (Poison): roll < 30, roll % 3 == 0 inflicts poison', () => {
    // Draw 1: 10 (< 30) -> triggers
    // Draw 2: 0 (% 3 == 0) -> Poison
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_EFFECT_SPORE, innates: [null, null, null] } }],
      scriptedRng([0, 10, 0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_POISON)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'POISON' })
  })

  it('Branch 1 (Paralysis): roll < 30, roll % 3 == 1 inflicts paralysis', () => {
    // Draw 1: 10 (< 30) -> triggers
    // Draw 2: 1 (% 3 == 1) -> Paralysis
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_EFFECT_SPORE, innates: [null, null, null] } }],
      scriptedRng([0, 10, 1]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'PARALYSIS' })
  })

  it('Branch 2 (Sleep): roll < 30, roll % 3 == 2 inflicts sleep (with sleep turns draw)', () => {
    // Draw 1: 10 (< 30) -> triggers
    // Draw 2: 2 (% 3 == 2) -> Sleep
    // Draw 3: 1 -> sleepTurns = (1 % 3) + 2 = 3 turns in applyPrimaryStatusEffect
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_EFFECT_SPORE, innates: [null, null, null] } }],
      scriptedRng([0, 10, 2, 1]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_SLEEP)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 0, status: 'SLEEP' })
  })

  it('Effect Spore does NOT trigger when roll >= 30', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_EFFECT_SPORE, innates: [null, null, null] } }],
      scriptedRng([0, 50]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toBeNull()
  })

  it('Effect Spore does NOT trigger on non-contact hit (Water Gun)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_EFFECT_SPORE, innates: [null, null, null] } }],
      scriptedRng([0, 10, 0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toBeNull()
  })
})

describe('MOVEEND_ABILITIES (Case 5): Gooey Speed Drop', () => {
  it('lowers attacker Speed by 1 stage on contact hit (Tackle)', () => {
    // Default speed stage is 6 (DEFAULT_STAT_STAGE). Drops to 5.
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_GOOEY, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: -1 }])
  })

  it('does NOT lower attacker Speed on non-contact hit (Water Gun)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_GOOEY, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toBeNull()
  })
})

describe('MOVEEND_ABILITIES_ATTACKER (Case 6): Attacker Contact Abilities', () => {
  it('attacker with Static paralyzes target on contact hit when roll < 30', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_STATIC, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng([0, 10]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 1, status: 'PARALYSIS' })
  })

  it('attacker with Static does NOT paralyze target on roll >= 30', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_STATIC, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng([0, 40]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_NONE)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toBeNull()
  })

  it('attacker with Poison Touch poisons target on contact hit when roll < 30', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_POISON_TOUCH, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng([0, 15]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(true)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toEqual({ battlerId: 1, status: 'POISON' })
  })

  it('attacker with Poison Touch does NOT poison target on non-contact hit (Water Gun)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_POISON_TOUCH, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng([0, 10]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_NONE)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statusApplied).toBeNull()
  })
})

describe('Ability Slots, Innates, Suppression & Ordering Rules', () => {
  it('triggers contact ability located in innate slot (innates[0])', () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100 },
        { hp: 100, maxHp: 100, abilities: { ability: null, innates: [ABILITY_ROUGH_SKIN, null, null] } },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(88)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(12)
  })

  it('applies reverse slot order (slot 3 before slot 0) and both effects trigger when attacker survives', () => {
    // Target has Rough Skin in innate slot 3 (innates[2]) and Gooey in main slot 0 (ability).
    // Attacker has 100 HP, takes 12 recoil (survives), then Gooey drops speed.
    const state = battle(
      [
        { hp: 100, maxHp: 100 },
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_GOOEY, innates: [null, null, ABILITY_ROUGH_SKIN] } },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(88) // 100 - 12
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(12)
    expect(act.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: -1 }])
  })

  it('fainting attacker from earlier slot (Rough Skin in slot 3) stops later slot (Gooey in slot 0)', () => {
    // Target has Rough Skin in slot 3 (innates[2]) and Gooey in slot 0 (ability).
    // Attacker has only 10 HP. Rough Skin deals 12 damage >= 10 HP -> attacker faints!
    // Gooey's ShouldApplyOnHitEffect(attacker) checks IsBattlerAlive -> false, so Gooey does not trigger.
    const state = battle(
      [
        { hp: 10, maxHp: 100 },
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_GOOEY, innates: [null, null, ABILITY_ROUGH_SKIN] } },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(12)
    expect(act.statChanges).toBeNull()
    expect(act.fainted).toContain(0)
  })

  it('Rough Skin STILL triggers against attacker with Mold Breaker (IsSuppressed checkMoldBreaker is FALSE)', () => {
    // Mold Breaker does NOT bypass contact abilities in upstream C!
    const state = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_MOLD_BREAKER, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ROUGH_SKIN, innates: [null, null, null] } },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(88) // 100 - 12
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(12)
  })

  it('Rough Skin does NOT trigger when defender is suppressed under Gastro Acid', () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100 },
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ROUGH_SKIN, innates: [null, null, null] } },
      ],
      scriptedRng(),
    )
    state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID

    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })
})

describe('ability statuses set HITMARKER_IGNORE_SAFEGUARD', () => {
  it("Static paralyses a Shield Dust attacker: SetMoveEffect's Shield Dust check (:2348) is skipped under the flag", () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_SHIELD_DUST, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_STATIC, innates: [null, null, null] } },
      ],
      scriptedRng([0, 0]),
    )
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
  })

  it("Safeguard still blocks Static, via CanBeParalyzed's IsStatusImmune (battle_util.c:5028)", () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_STATIC, innates: [null, null, null] } }],
      scriptedRng([0, 0]),
    )
    state.sides[0]!.statuses |= SIDE_STATUS_SAFEGUARD
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
  })
})

// ---------------------------------------------------------------------------
// Knock-out abilities (VARIOUS_ON_FAINTED_BY_ATTACKER / _BY_OTHER)
// ---------------------------------------------------------------------------

function partyMon(hp: number): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 50 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: STATUS1_NONE,
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
  }
}

describe('onBattlerFaints dispatch: Moxie and the other +1 stat-raise hooks', () => {
  it('Moxie raises the holder Attack by 1 after a KO (MoxieClone, abilities.cc:315-320)', () => {
    // Tackle: accuracy 100, roll 0 hits. Target hp 30 takes 30 -> faints. The attacker (slot 0) holds Moxie and
    // onBattlerFaintsFor = APPLY_ON_ATTACKER, so ChangeStatBuffs(attacker, +1, STAT_ATK) -> stage 6 -> 7.
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_MOXIE, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(act.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
    expect(act.unmodelled).not.toContain('on-faint ability ABILITY_MOXIE is not modelled yet')
  })

  it('Moxie does not raise Attack when the target survives', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_MOXIE, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(act.statChanges).toBeNull()
  })

  it('Moxie does not raise Attack when the attacker is already at +6 (ChangeStatBuffs returns 0, abilities.cc:317)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_MOXIE, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    state.battlers[0]!.mon.statStages[STAT_ATK] = 12
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(12)
    expect(act.statChanges).toBeNull()
  })

  it('Moxie does not fire when the KO ends the battle (REQUIRE_NOT(NoAliveMonsForEitherParty), battle_script_commands.c:7133)', () => {
    const base = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_MOXIE, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const state = createBattleState({
      battlers: [base.battlers[0]!, base.battlers[1]!],
      playerParty: [partyMon(100)],
      opponentParty: [partyMon(30)],
      rng: base.rng,
    })
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(state.battleOutcome).toBe('WON')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(act.statChanges).toBeNull()
  })

  it('Moxie fires when the fainted side still has a reserve mon', () => {
    const base = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_MOXIE, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const state = createBattleState({
      battlers: [base.battlers[0]!, base.battlers[1]!],
      playerParty: [partyMon(100)],
      opponentParty: [partyMon(30), partyMon(100)],
      rng: base.rng,
    })
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(state.battleOutcome).toBeNull()
    expect(act.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
  })

  it('Moxie in an innate slot fires too (ON_ABILITY walks every slot)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: null, innates: [null, ABILITY_MOXIE, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
  })

  it('Beast Boost raises the holder highest raw stat (GetHighestStatId(battler, FALSE), battle_util.c:8724-8746)', () => {
    // Attacker raw stats: atk 70, def 90, spatk 80, spdef 85, spe 100 (battle() helper: spe 100 for slot 0).
    // Struct order ATK, DEF, SPEED, SPATK, SPDEF with strict >: 70 -> 90 -> 100 (Speed) stays highest.
    const state = battle(
      [{ hp: 100, maxHp: 100, atk: 70, abilities: { ability: ABILITY_BEAST_BOOST, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: 1 }])
  })

  it('Soul Heart (APPLY_ON_ANY, no HasAttackerFaintedTarget check) raises Sp. Atk on the foe when the attacker faints', () => {
    // Attacker hp 15 / maxHp 120 hits a Rocky Helmet holder: floor(120 / 6) = 20 >= 15 -> the attacker faints in
    // MOVEEND_ITEM_EFFECTS_TARGET. VARIOUS_ON_FAINTED_BY_OTHER then offers the faint to every alive battler: the
    // target holds Soul Heart (APPLY_ON_ANY) -> Sp. Atk +1 on the target (slot 1).
    const state = battle(
      [{ hp: 15, maxHp: 120 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_SOUL_HEART, innates: [null, null, null] } }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(10), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toEqual([0])
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(act.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPATK, change: 1 }])
  })

  it('Moxie held by the foe does NOT fire when the attacker faints (APPLY_ON_ATTACKER vs attacker = MAX_BATTLERS_COUNT, :7167)', () => {
    const state = battle(
      [{ hp: 15, maxHp: 120 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_MOXIE, innates: [null, null, null] } }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(10), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toEqual([0])
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(act.statChanges).toBeNull()
  })
})

describe('Pinned onBattlerFaints tables', () => {
  it('ON_BATTLER_FAINTS_FOR covers exactly the onBattlerFaints abilities', () => {
    expect(new Set(Object.keys(ON_BATTLER_FAINTS_FOR))).toEqual(ON_BATTLER_FAINTS_ABILITIES)
  })

  it('KO_STAT_RAISES only names abilities that have an onBattlerFaints hook', () => {
    for (const id of Object.keys(KO_STAT_RAISES)) expect(ON_BATTLER_FAINTS_ABILITIES.has(id), id).toBe(true)
  })

  it('KO_SOUL_EATER_ABILITIES only names abilities that have an onBattlerFaints hook', () => {
    for (const id of KO_SOUL_EATER_ABILITIES) expect(ON_BATTLER_FAINTS_ABILITIES.has(id), id).toBe(true)
  })

  it('KO_JAWS_OF_CARNAGE_ABILITIES only names abilities that have an onBattlerFaints hook', () => {
    for (const id of KO_JAWS_OF_CARNAGE_ABILITIES) expect(ON_BATTLER_FAINTS_ABILITIES.has(id), id).toBe(true)
  })

  it('KO_CRIT_BOOST_ABILITIES only names abilities that have an onBattlerFaints hook', () => {
    for (const id of KO_CRIT_BOOST_ABILITIES) expect(ON_BATTLER_FAINTS_ABILITIES.has(id), id).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Knock Off (MOVE_EFFECT_KNOCK_OFF -> MOVEEND_MOVE_EFFECTS2_ON_EACH -> TryKnockOffBattleScript)
// ---------------------------------------------------------------------------

describe('Knock Off (MOVEEND_MOVE_EFFECTS2_ON_EACH)', () => {
  const BEHAVIORS = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
  const knockOffDeps = (damage: DamageResolver, holdEffects: Record<number, string> = {}): TurnLoopDeps => ({
    ...testDepsWithDamage(damage, holdEffects),
    dataContext: { ...DATA_CONTEXT, move: (id) => (id === 'MOVE_KNOCK_OFF' ? MOVE_KNOCK_OFF : DATA_CONTEXT.move(id)) },
    moveBehaviors: BEHAVIORS,
  })

  it('removes the target item after a hit: accuracy draw, then seteffectwithchance draws even at 100% (:3113)', () => {
    // Knock Off effectChance 100 -> `Random() % 100 < 100` always passes but the draw still happens: 2 calls total.
    const rng = scriptedRng([0, 0])
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }], rng)
    const out = executeTurn(state, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(30)))

    expect(state.battlers[1]!.mon.hp).toBe(70)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
    expect(rng.calls).toBe(2)
    expect(out.actions.find((a) => a.battlerId === 0)!.unmodelled).not.toContain('secondary effect of EFFECT_KNOCK_OFF not modelled')
  })

  it('Sticky Hold keeps the item (IsStickyHold, :4274-4278)', () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100 },
        { hp: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS', abilities: { ability: ABILITY_STICKY_HOLD, innates: [null, null, null] } },
      ],
      scriptedRng([0, 0]),
    )
    executeTurn(state, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(30)))

    expect(state.battlers[1]!.mon.hp).toBe(70)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LEFTOVERS')
  })

  it('a Mold Breaker attacker bypasses Sticky Hold (BattlerHasAbility checkMoldBreaker TRUE, :9330)', () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_MOLD_BREAKER, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS', abilities: { ability: ABILITY_STICKY_HOLD, innates: [null, null, null] } },
      ],
      scriptedRng([0, 0]),
    )
    executeTurn(state, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(30)))

    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('does nothing when the target holds no item', () => {
    const rng = scriptedRng([0, 0])
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], rng)
    const out = executeTurn(state, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(30)))

    expect(state.battlers[1]!.mon.hp).toBe(70)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
    expect(out.actions.find((a) => a.battlerId === 0)!.unmodelled.filter((m) => /UpdateBattlerItem|Knock/.test(m))).toEqual([])
  })

  it('does nothing when the move missed (Cmd_moveend never runs; no seteffectwithchance draw)', () => {
    // Accuracy stage -6 on the attacker: 100 * 3 / 9 = 33. A roll of 99 gives 99 >= 33 -> miss.
    const rng = scriptedRng([99, 0])
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }], rng)
    state.battlers[0]!.mon.statStages[STAT_ACC] = 0
    const out = executeTurn(state, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(30)))

    expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(rng.calls).toBe(1)
  })

  it('does nothing when the hit had no effect (MOVE_RESULT_NO_EFFECT: seteffectwithchance does not set moveEffect2)', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(0)))

    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LEFTOVERS')
  })

  it('does not knock off the item of a target the move fainted (ShouldApplyOnHitEffect needs IsBattlerAlive, :4271)', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 30, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }], scriptedRng([0, 0]))
    const out = executeTurn(state, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(30)))

    expect(out.actions.find((a) => a.battlerId === 0)!.fainted).toContain(1)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LEFTOVERS')
  })

  it('cannot remove items CanBattlerGetOrLoseItem forbids (Enigma Berry, Mega Stones; battle_util.c:8255-8259)', () => {
    for (const itemId of ['ITEM_ENIGMA_BERRY', 'ITEM_VENUSAURITE']) {
      const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, itemId }], scriptedRng([0, 0]))
      executeTurn(state, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(30)))

      expect(state.battlers[1]!.mon.itemId, itemId).toBe(itemId)
    }
  })

  it('a Substitute that absorbs the hit leaves TARGET_TURN_DAMAGED false, so the item stays (Cmd_datahpupdate :1877-1892)', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }], scriptedRng([0, 0]))
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 20
    executeTurn(state, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(10)))

    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LEFTOVERS')
  })

  it('writes Unburden ability state (no gap) when the target actually has Unburden', () => {
    const withUnburden = battle(
      [
        { hp: 100, maxHp: 100 },
        { hp: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS', abilities: { ability: requireAbility('ABILITY_UNBURDEN'), innates: [null, null, null] } },
      ],
      scriptedRng([0, 0]),
    )
    const gapped = executeTurn(withUnburden, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(30)))
    expect(gapped.actions.find((a) => a.battlerId === 0)!.unmodelled.some((m) => m.includes('Unburden'))).toBe(false)
    expect(withUnburden.battlers[1]!.volatiles.abilityState[0]).toBe(1)

    const plain = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }], scriptedRng([0, 0]))
    const clean = executeTurn(plain, [useMove(1, MOVE_KNOCK_OFF), null], knockOffDeps(fixedDamage(30)))
    expect(clean.actions.find((a) => a.battlerId === 0)!.unmodelled.filter((m) => m.includes('UpdateBattlerItem'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Thief / Bug Bite / Smack Down (MOVEEND_MOVE_EFFECTS2_ON_EACH), King's Rock (15), Shell Bell (26)
// ---------------------------------------------------------------------------

// requireMove() omits effectChance / argument (adding them would start firing secondary effects in every older test).
function withEffectData(id: string): SimMoveData {
  const raw = movesById.get(id)!
  return { ...requireMove(id), effectChance: raw.effectChance as number, argument: raw.argument as SimMoveData['argument'] }
}

const MOVE_THIEF = withEffectData('MOVE_THIEF')
const MOVE_BUG_BITE = withEffectData('MOVE_BUG_BITE')
const MOVE_SMACK_DOWN = withEffectData('MOVE_SMACK_DOWN')
const MOVE_SMITE = withEffectData('MOVE_SMITE')
const MOVE_BITE = withEffectData('MOVE_BITE')
const ABILITY_KLUTZ = requireAbility('ABILITY_KLUTZ')
const ABILITY_SERENE_GRACE = requireAbility('ABILITY_SERENE_GRACE')
const FLYING_TYPES: SimBattleMon['types'] = ['FLYING', 'MYSTERY', 'MYSTERY']

// The build's linter reads a call to anything named useX inside a non-callback function as a React hook.
const chooseMove = useMove
const itemMoveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
function itemMoveDeps(damage: DamageResolver, holdEffects: Record<number, string>, moves: SimMoveData[]): TurnLoopDeps {
  const byId = new Map(moves.map((m) => [m.id, m]))
  return {
    ...testDepsWithDamage(damage, holdEffects),
    dataContext: { ...DATA_CONTEXT, move: (id) => byId.get(id) ?? DATA_CONTEXT.move(id) },
    moveBehaviors: itemMoveBehaviors,
  }
}

function actionOf(out: ReturnType<typeof executeTurn>, battlerId: number) {
  return out.actions.find((a) => a.battlerId === battlerId)!
}

describe('Thief (MOVE_EFFECT_STEAL_ITEM, battle_script_commands.c:4579-4593)', () => {
  const deps = () => itemMoveDeps(fixedDamage(30), {}, [MOVE_THIEF])

  it('steals the item when the attacker holds none: accuracy draw, then seteffectwithchance draws at 100%', () => {
    const rng = scriptedRng([0, 0])
    const state = battle([{}, { itemId: 'ITEM_LEFTOVERS' }], rng)
    const out = executeTurn(state, [useMove(1, MOVE_THIEF), null], deps())

    expect(state.battlers[1]!.mon.hp).toBe(70) // 100 - 30
    expect(state.battlers[1]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(rng.calls).toBe(2)
    expect(actionOf(out, 0).unmodelled).not.toContain('secondary effect of MOVE_EFFECT_STEAL_ITEM not modelled')
  })

  it('does not steal when the target holds nothing', () => {
    const state = battle([{}, {}], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, MOVE_THIEF), null], deps())

    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('steals through Sticky Hold: CanStealItem (battle_util.c:8500-8510) has no IsStickyHold clause', () => {
    const state = battle(
      [{}, { itemId: 'ITEM_LEFTOVERS', abilities: { ability: ABILITY_STICKY_HOLD, innates: [null, null, null] } }],
      scriptedRng([0, 0]),
    )
    executeTurn(state, [useMove(1, MOVE_THIEF), null], deps())

    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('cannot steal what CanBattlerGetOrLoseItem forbids (Mega Stone)', () => {
    const state = battle([{}, { itemId: 'ITEM_VENUSAURITE' }], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, MOVE_THIEF), null], deps())

    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_VENUSAURITE')
  })

  it('takes the item of a target it knocked out (no ShouldApplyOnHitEffect on this branch)', () => {
    const state = battle([{}, { hp: 30, itemId: 'ITEM_LEFTOVERS' }], scriptedRng([0, 0]))
    const out = executeTurn(state, [useMove(1, MOVE_THIEF), null], deps())

    expect(actionOf(out, 0).fainted).toContain(1)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
  })

  it('an attacker that already holds an item falls through to Knock Off: target loses its item, attacker keeps its own', () => {
    const state = battle([{ itemId: 'ITEM_ORAN_BERRY' }, { itemId: 'ITEM_LEFTOVERS' }], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, MOVE_THIEF), null], deps())

    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('the Knock Off fallthrough still respects Sticky Hold', () => {
    const state = battle(
      [{ itemId: 'ITEM_ORAN_BERRY' }, { itemId: 'ITEM_LEFTOVERS', abilities: { ability: ABILITY_STICKY_HOLD, innates: [null, null, null] } }],
      scriptedRng([0, 0]),
    )
    executeTurn(state, [useMove(1, MOVE_THIEF), null], deps())

    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LEFTOVERS')
  })

  it('steals nothing when the move had no effect (damage 0: seteffectwithchance stores nothing)', () => {
    const state = battle([{}, { itemId: 'ITEM_LEFTOVERS' }], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, MOVE_THIEF), null], itemMoveDeps(fixedDamage(0), {}, [MOVE_THIEF]))

    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LEFTOVERS')
  })

  it('no longer gaps the receiver\'s Unburden reset (ported in cycle 80)', () => {
    const withUnburden = battle(
      [{ abilities: { ability: requireAbility('ABILITY_UNBURDEN'), innates: [null, null, null] } }, { itemId: 'ITEM_LEFTOVERS' }],
      scriptedRng([0, 0]),
    )
    const gapped = executeTurn(withUnburden, [useMove(1, MOVE_THIEF), null], deps())
    expect(actionOf(gapped, 0).unmodelled.some((m) => m.includes('Unburden'))).toBe(false)

    const plain = battle([{}, { itemId: 'ITEM_LEFTOVERS' }], scriptedRng([0, 0]))
    const clean = executeTurn(plain, [useMove(1, MOVE_THIEF), null], deps())
    expect(actionOf(clean, 0).unmodelled.filter((m) => m.includes('UpdateBattlerItem'))).toEqual([])
  })
})

describe('Bug Bite (MOVE_EFFECT_BUG_BITE, battle_script_commands.c:4595-4597, EatTargetBerry :13221)', () => {
  const deps = () => itemMoveDeps(fixedDamage(30), {}, [MOVE_BUG_BITE])

  it('eats the target berry; the move is CERTAIN so there is no seteffectwithchance draw (accuracy draw only)', () => {
    const rng = scriptedRng([0])
    const state = battle([{}, { itemId: 'ITEM_ORAN_BERRY' }], rng)
    const out = executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], deps())

    expect(state.battlers[1]!.mon.hp).toBe(70)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.mon.itemId).toBeNull() // the attacker's own (empty) slot is restored from changedItems
    expect(rng.calls).toBe(1)
    expect(actionOf(out, 0).unmodelled.some((m) => m.startsWith("Bug Bite's consumeberry of ITEM_ORAN_BERRY"))).toBe(true)
  })

  it('leaves the attacker\'s own item alone', () => {
    const state = battle([{ itemId: 'ITEM_LEFTOVERS' }, { itemId: 'ITEM_ORAN_BERRY' }], scriptedRng([0]))
    executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], deps())

    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('Sticky Hold keeps the berry (EatTargetBerry IsStickyHold, :13223)', () => {
    const rng = scriptedRng([0])
    const state = battle(
      [{}, { itemId: 'ITEM_ORAN_BERRY', abilities: { ability: ABILITY_STICKY_HOLD, innates: [null, null, null] } }],
      rng,
    )
    const out = executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], deps())

    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
    expect(actionOf(out, 0).unmodelled.some((m) => m.includes('consumeberry'))).toBe(false)
  })

  it('a non-berry target takes the BattleScript_EffectKnockOff route: 100% roll drawn, item knocked off, nothing eaten', () => {
    const rng = scriptedRng([0, 0])
    const state = battle([{}, { itemId: 'ITEM_LEFTOVERS' }], rng)
    const out = executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], deps())

    expect(state.battlers[1]!.mon.itemId).toBeNull()
    expect(rng.calls).toBe(2)
    expect(actionOf(out, 0).unmodelled.some((m) => m.includes('consumeberry'))).toBe(false)
  })

  it('a Klutz target\'s berry is IsItemNegated, so jumpifnotberry also takes the Knock Off route', () => {
    const rng = scriptedRng([0, 0])
    const state = battle(
      [{}, { itemId: 'ITEM_ORAN_BERRY', abilities: { ability: ABILITY_KLUTZ, innates: [null, null, null] } }],
      rng,
    )
    const out = executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], deps())

    expect(rng.calls).toBe(2)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
    expect(actionOf(out, 0).unmodelled.some((m) => m.includes('consumeberry'))).toBe(false)
  })

  it('Pluck shares the effect', () => {
    const MOVE_PLUCK = withEffectData('MOVE_PLUCK')
    const state = battle([{}, { itemId: 'ITEM_ORAN_BERRY' }], scriptedRng([0]))
    executeTurn(state, [useMove(1, MOVE_PLUCK), null], itemMoveDeps(fixedDamage(30), {}, [MOVE_PLUCK]))

    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })
})

describe('Smack Down (MOVE_EFFECT_SMACK_DOWN, battle_script_commands.c:4598-4606)', () => {
  const deps = () => itemMoveDeps(fixedDamage(30), {}, [MOVE_SMACK_DOWN, MOVE_SMITE])

  it('grounds a Flying-type and clears Magnet Rise / Telekinesis; no argument effect, but the seteffectwithchance roll is still drawn', () => {
    const rng = scriptedRng([0, 0])
    const state = battle([{}, { types: FLYING_TYPES }], rng)
    state.battlers[1]!.statuses3 |= STATUS3_MAGNET_RISE | STATUS3_TELEKINESIS
    executeTurn(state, [useMove(1, MOVE_SMACK_DOWN), null], deps())

    expect(state.battlers[1]!.mon.hp).toBe(70)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_SMACKED_DOWN)).toBe(true)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_MAGNET_RISE)).toBe(false)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_TELEKINESIS)).toBe(false)
    expect(rng.calls).toBe(2)
  })

  it('does nothing to an already-grounded target', () => {
    const state = battle([{}, { types: ['WATER', 'MYSTERY', 'MYSTERY'] }], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, MOVE_SMACK_DOWN), null], deps())

    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_SMACKED_DOWN)).toBe(false)
  })

  it('does nothing to a target the move fainted (IsBattlerAlive)', () => {
    const state = battle([{}, { hp: 30, types: FLYING_TYPES }], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, MOVE_SMACK_DOWN), null], deps())

    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_SMACKED_DOWN)).toBe(false)
  })

  it('Smite: grounds on the stored effect and rolls its 20% paralysis separately (accuracy 0, roll 19 -> paralysed)', () => {
    const state = battle([{}, { types: FLYING_TYPES }], scriptedRng([0, 19]))
    executeTurn(state, [useMove(1, MOVE_SMITE), null], deps())

    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_SMACKED_DOWN)).toBe(true)
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS)
  })

  it('Smite: roll 20 fails the 20% chance but still grounds', () => {
    const state = battle([{}, { types: FLYING_TYPES }], scriptedRng([0, 20]))
    executeTurn(state, [useMove(1, MOVE_SMITE), null], deps())

    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_SMACKED_DOWN)).toBe(true)
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_NONE)
  })
})

describe("King's Rock (MOVEEND_KINGSROCK, battle_util.c:6034-6052)", () => {
  const FLINCH_HOLD = { 0: 'HOLD_EFFECT_FLINCH' }
  const deps = (moves: SimMoveData[] = [], damage: DamageResolver = fixedDamage(20), holdEffects: Record<number, string> = FLINCH_HOLD) =>
    itemMoveDeps(damage, holdEffects, moves)
  const bothTackle = (state: BattleState, d: TurnLoopDeps) => executeTurn(state, [chooseMove(1, MOVE_TACKLE), chooseMove(0, MOVE_TACKLE)], d)

  it('flinches on a roll below the item param (10): draws are accuracy, then the item roll', () => {
    const rng = scriptedRng([0, 9])
    const state = battle([{ itemId: 'ITEM_KINGS_ROCK' }, {}], rng)
    const out = bothTackle(state, deps())

    expect(actionOf(out, 1).cancelledBy).toBe('FLINCH')
    expect(state.battlers[1]!.mon.hp).toBe(80) // 100 - 20
    expect(state.battlers[0]!.mon.hp).toBe(100) // the flinched target never hit back
    expect(rng.calls).toBe(2)
  })

  it('does not flinch on a roll of 10 (10 < 10 is false); the target then retaliates (its own accuracy draw is the third)', () => {
    const rng = scriptedRng([0, 10])
    const state = battle([{ itemId: 'ITEM_KINGS_ROCK' }, {}], rng)
    const out = bothTackle(state, deps())

    expect(actionOf(out, 1).cancelledBy).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(rng.calls).toBe(3)
  })

  it('Razor Fang shares HOLD_EFFECT_FLINCH and its param', () => {
    const state = battle([{ itemId: 'ITEM_RAZOR_FANG' }, {}], scriptedRng([0, 9]))
    expect(actionOf(bothTackle(state, deps()), 1).cancelledBy).toBe('FLINCH')
  })

  it('Serene Grace doubles the param to 20 (B_SERENE_GRACE_BOOST >= GEN_5): roll 19 flinches, roll 20 does not', () => {
    const serene = { ability: ABILITY_SERENE_GRACE, innates: [null, null, null] as [null, null, null] }
    const hit = battle([{ itemId: 'ITEM_KINGS_ROCK', abilities: serene }, {}], scriptedRng([0, 19]))
    expect(actionOf(bothTackle(hit, deps()), 1).cancelledBy).toBe('FLINCH')

    const miss = battle([{ itemId: 'ITEM_KINGS_ROCK', abilities: serene }, {}], scriptedRng([0, 20]))
    expect(actionOf(bothTackle(miss, deps()), 1).cancelledBy).toBeNull()
  })

  it('an active rainbow on the attacker\'s side doubles the param too', () => {
    const state = battle([{ itemId: 'ITEM_KINGS_ROCK' }, {}], scriptedRng([0, 19]))
    state.sides[0].timers.rainbowTimer = 3
    expect(actionOf(bothTackle(state, deps()), 1).cancelledBy).toBe('FLINCH')
  })

  it('draws nothing when the hit did no damage', () => {
    const rng = scriptedRng([0, 0])
    const state = battle([{ itemId: 'ITEM_KINGS_ROCK' }, {}], rng)
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps([], fixedDamage(0)))

    expect(rng.calls).toBe(1)
  })

  it('draws nothing when a Substitute absorbed the hit (TARGET_TURN_DAMAGED false)', () => {
    const rng = scriptedRng([0, 0])
    const state = battle([{ itemId: 'ITEM_KINGS_ROCK' }, {}], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 50
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps())

    expect(rng.calls).toBe(1)
  })

  it('still draws when the hit faints the target, but nothing flinches (hp term follows the roll)', () => {
    const rng = scriptedRng([0, 0])
    const state = battle([{ itemId: 'ITEM_KINGS_ROCK' }, { hp: 20 }], rng)
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps())

    expect(actionOf(out, 0).fainted).toContain(1)
    expect(rng.calls).toBe(2)
  })

  it('a move that already flinches (Bite, effectChance 30) is not FLAG_KINGS_ROCK_AFFECTED: the roll is drawn, no extra flinch', () => {
    // accuracy 0, Bite's own flinch roll 99 (fails 30%), item roll 0 (passes 10%), then the target's accuracy draw.
    const rng = scriptedRng([0, 99, 0])
    const state = battle([{ itemId: 'ITEM_KINGS_ROCK' }, {}], rng)
    const out = executeTurn(state, [useMove(1, MOVE_BITE), useMove(0, MOVE_TACKLE)], deps([MOVE_BITE]))

    expect(actionOf(out, 1).cancelledBy).toBeNull()
    expect(rng.calls).toBe(4)
  })

  it('Shield Dust on the target blocks the flinch', () => {
    const state = battle(
      [{ itemId: 'ITEM_KINGS_ROCK' }, { abilities: { ability: ABILITY_SHIELD_DUST, innates: [null, null, null] } }],
      scriptedRng([0, 0]),
    )
    expect(actionOf(bothTackle(state, deps()), 1).cancelledBy).toBeNull()
  })

  it('Sheer Force on the attacker blocks the flinch for a Sheer Force boosted move (SetMoveEffect :2361)', () => {
    // Flamethrower: accuracy 0, its burn roll 99 (fails), item roll 0 (passes).
    const state = battle(
      [{ itemId: 'ITEM_KINGS_ROCK', abilities: { ability: ABILITY_SHEER_FORCE, innates: [null, null, null] } }, {}],
      scriptedRng([0, 99, 0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_FLAMETHROWER), useMove(0, MOVE_TACKLE)], deps([MOVE_FLAMETHROWER]))

    expect(actionOf(out, 1).cancelledBy).toBeNull()
  })

  it('does nothing without a HOLD_EFFECT_FLINCH holder', () => {
    const rng = scriptedRng([0, 0])
    const state = battle([{ itemId: 'ITEM_KINGS_ROCK' }, {}], rng)
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps([], fixedDamage(20), {}))

    expect(rng.calls).toBe(1)
  })
})

describe('Shell Bell (MOVEEND_LIFEORB_SHELLBELL, battle_util.c:6066-6083)', () => {
  const SHELL_BELL = { 0: 'HOLD_EFFECT_SHELL_BELL' }
  const deps = (damage: number, moves: SimMoveData[] = []) => itemMoveDeps(fixedDamage(damage), SHELL_BELL, moves)

  it('heals floor(savedDmg / 4): floor(30 / 4) = 7', () => {
    const state = battle([{ hp: 50, itemId: 'ITEM_SHELL_BELL' }, {}], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(30))

    expect(state.battlers[0]!.mon.hp).toBe(57)
    expect(state.battlers[1]!.mon.hp).toBe(70)
  })

  it('heals at least 1: floor(3 / 4) = 0 becomes 1', () => {
    const state = battle([{ hp: 50, itemId: 'ITEM_SHELL_BELL' }, {}], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(3))

    expect(state.battlers[0]!.mon.hp).toBe(51)
  })

  it('caps the heal at max HP: 99 + floor(40 / 4) -> 100', () => {
    const state = battle([{ hp: 99, itemId: 'ITEM_SHELL_BELL' }, {}], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(40))

    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('uses the HP actually dealt, not the overkill: a 20-HP target hit for 100 heals floor(20 / 4) = 5', () => {
    const state = battle([{ hp: 50, itemId: 'ITEM_SHELL_BELL' }, { hp: 20 }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(100))

    expect(state.battlers[0]!.mon.hp).toBe(55)
  })

  it('does not heal at full HP or under Heal Block (CanBattlerHeal)', () => {
    const full = battle([{ hp: 100, itemId: 'ITEM_SHELL_BELL' }, {}], scriptedRng())
    executeTurn(full, [useMove(1, MOVE_TACKLE), null], deps(30))
    expect(full.battlers[0]!.mon.hp).toBe(100)

    const blocked = battle([{ hp: 50, itemId: 'ITEM_SHELL_BELL' }, {}], scriptedRng())
    blocked.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    executeTurn(blocked, [useMove(1, MOVE_TACKLE), null], deps(30))
    expect(blocked.battlers[0]!.mon.hp).toBe(50)
  })

  it('does not heal when Sheer Force boosts the move (TestSheerForceFlag)', () => {
    // Flamethrower: accuracy 0, burn roll 99 (fails).
    const state = battle(
      [{ hp: 50, itemId: 'ITEM_SHELL_BELL', abilities: { ability: ABILITY_SHEER_FORCE, innates: [null, null, null] } }, {}],
      scriptedRng([0, 99]),
    )
    executeTurn(state, [useMove(1, MOVE_FLAMETHROWER), null], deps(30, [MOVE_FLAMETHROWER]))

    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('does not heal when the target took no damage, and no longer gaps', () => {
    const state = battle([{ hp: 50, itemId: 'ITEM_SHELL_BELL' }, {}], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(0))

    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(actionOf(out, 0).unmodelled).not.toContain('move-end Shell Bell heal is not modelled yet')
  })
})

// ---------------------------------------------------------------------------
// Knock-out abilities beyond stat raises (Soul Eater, Predator, Jaws of Carnage, Pretentious)
// ---------------------------------------------------------------------------

describe('onBattlerFaints dispatch: beyond stat raises (Soul Eater, Predator, Jaws of Carnage, Pretentious)', () => {
  it('Predator heals 25% max HP after KOing the target (BattleScript_HandleSoulEaterEffect, battle_scripts_1.s:11454)', () => {
    // Attacker: maxHp 120, current hp 60. Target: hp 30, maxHp 100.
    // Tackle deals 30 -> target faints.
    // Predator onBattlerFaints (Impl<ABILITY_SOUL_EATER>.onBattlerFaints, src/abilities.cc:4620):
    // maxHP * 25 / 100 = 120 * 25 / 100 = 30 heal.
    // New HP: min(120, 60 + 30) = 90.
    const state = battle(
      [{ hp: 60, maxHp: 120, abilities: { ability: ABILITY_PREDATOR, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(state.battlers[0]!.mon.hp).toBe(90)
    expect(act.unmodelled).not.toContain('on-faint ability ABILITY_PREDATOR is not modelled yet')
  })

  it('Predator does not heal when the target survives', () => {
    // Target takes 30 damage and survives at 70 HP -> dispatchOnBattlerFaints is not invoked.
    const state = battle(
      [{ hp: 60, maxHp: 120, abilities: { ability: ABILITY_PREDATOR, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(60)
  })

  it('Soul Eater heals 25% max HP after KOing the target (src/abilities.cc:4263)', () => {
    // Attacker: maxHp 100, current hp 50. Target: hp 30, maxHp 100.
    // Tackle deals 30 -> target faints.
    // Soul Eater heals floor(100 * 25 / 100) = 25.
    // New HP: min(100, 50 + 25) = 75.
    const state = battle(
      [{ hp: 50, maxHp: 100, abilities: { ability: ABILITY_SOUL_EATER, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(act.unmodelled).not.toContain('on-faint ability ABILITY_SOUL_EATER is not modelled yet')
  })

  it('Soul Eater does not heal when attacker is already at full HP (CHECK_NOT(BATTLER_MAX_HP(battler)))', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_SOUL_EATER, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Soul Eater does not heal when CanBattlerHeal returns false (STATUS3_HEAL_BLOCK)', () => {
    const state = battle(
      [{ hp: 50, maxHp: 100, abilities: { ability: ABILITY_SOUL_EATER, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('Jaws of Carnage heals 50% max HP after a KO with a bite move (BattleScript_HandleJawsOfCarnageEffect, :11464)', () => {
    // MOVE_BITE carries flags.biteBased (FLAG_STRONG_JAW_BOOST).
    // Attacker: maxHp 100, current hp 40. Target: hp 30, maxHp 100.
    // 50% of 100 = 50 heal.
    // New HP: min(100, 40 + 50) = 90.
    const state = battle(
      [{ hp: 40, maxHp: 100, abilities: { ability: ABILITY_JAWS_OF_CARNAGE, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_BITE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(state.battlers[0]!.mon.hp).toBe(90)
    expect(act.unmodelled).not.toContain('on-faint ability ABILITY_JAWS_OF_CARNAGE is not modelled yet')
  })

  it('Jaws of Carnage heals 25% max HP after a KO with a non-bite move (BattleScript_HandleSoulEaterEffect fallback)', () => {
    // MOVE_TACKLE has no biteBased flag.
    // Attacker: maxHp 100, current hp 40. Target: hp 30, maxHp 100.
    // 25% of 100 = 25 heal.
    // New HP: min(100, 40 + 25) = 65.
    const state = battle(
      [{ hp: 40, maxHp: 100, abilities: { ability: ABILITY_JAWS_OF_CARNAGE, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(state.battlers[0]!.mon.hp).toBe(65)
  })

  it('Pretentious increments volatiles.critBoost by 1 on KO (src/abilities.cc:8116-8125)', () => {
    // Attacker: critBoost 0. Target: hp 30, maxHp 100.
    // Pretentious onBattlerFaints: critBoost < 3 -> critBoost++.
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_PRETENTIOUS, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    expect(state.battlers[0]!.volatiles.critBoost).toBe(0)
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(state.battlers[0]!.volatiles.critBoost).toBe(1)
    expect(act.unmodelled).not.toContain('on-faint ability ABILITY_PRETENTIOUS is not modelled yet')
  })

  it('Pretentious caps at critBoost 3 (CHECK(critBoost < 3))', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_PRETENTIOUS, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    state.battlers[0]!.volatiles.critBoost = 3
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.volatiles.critBoost).toBe(3)
  })

  it('Predator held by the defender does NOT fire when the attacker faints (APPLY_ON_ATTACKER)', () => {
    // Defender (slot 1) holds Predator with hp 50 / maxHp 100.
    // Attacker (slot 0) has hp 15 / maxHp 120 and hits defender holding Rocky Helmet.
    // Defender takes 10 -> hp 40.
    // Attacker takes floor(120 / 6) = 20 -> faints in MOVEEND_ITEM_EFFECTS_TARGET.
    // Faint triggers VARIOUS_ON_FAINTED_BY_OTHER (attacker = MAX_BATTLERS_COUNT):
    // faintHookApplies('ATTACKER', ...) returns false, so defender does not heal.
    const state = battle(
      [
        { hp: 15, maxHp: 120 },
        { hp: 50, maxHp: 100, abilities: { ability: ABILITY_PREDATOR, innates: [null, null, null] } },
      ],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(10), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toEqual([0])
    expect(state.battlers[1]!.mon.hp).toBe(40)
  })

  it('Predator in an innate slot fires (ON_ABILITY walks every slot in reverse)', () => {
    const state = battle(
      [{ hp: 60, maxHp: 120, abilities: { ability: null, innates: [null, ABILITY_PREDATOR, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(state.battlers[0]!.mon.hp).toBe(90)
  })

  it('Predator does not heal when KO ends the battle (REQUIRE_NOT(NoAliveMonsForEitherParty), :7133)', () => {
    const base = battle(
      [{ hp: 60, maxHp: 120, abilities: { ability: ABILITY_PREDATOR, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng([0]),
    )
    const state = createBattleState({
      battlers: [base.battlers[0]!, base.battlers[1]!],
      playerParty: [partyMon(60)],
      opponentParty: [partyMon(30)],
      rng: base.rng,
    })
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(state.battleOutcome).toBe('WON')
    expect(state.battlers[0]!.mon.hp).toBe(60)
  })
})

describe('MOVEEND_ABILITIES (Cycle 42 onDefender batch)', () => {
  it('Stamina raises Defense by 1 on standard damaging hit, and by 12 (max) on critical hit', () => {
    // Standard damaging hit
    const state1 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_STAMINA, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out1 = executeTurn(state1, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state1.battlers[1]!.mon.hp).toBe(80)
    expect(state1.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    const act1 = out1.actions.find((a) => a.battlerId === 0)!
    expect(act1.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: 1 }])

    // Critical hit (isCriticalHit = true) raises Defense by 12 stages (clamped to +6 from stage 6)
    const state2 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_STAMINA, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out2 = executeTurn(state2, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20, true)))

    expect(state2.battlers[1]!.mon.statStages[STAT_DEF]).toBe(12)
    const act2 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act2.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: 6 }])
  })

  it('Weak Armor lowers Defense by 1 and raises Speed by 2 on physical hit, and does not activate on special hit', () => {
    // Physical hit (Tackle)
    const state1 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_WEAK_ARMOR, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out1 = executeTurn(state1, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state1.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state1.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)
    const act1 = out1.actions.find((a) => a.battlerId === 0)!
    expect(act1.statChanges).toEqual([
      { battlerId: 1, stat: STAT_DEF, change: -1 },
      { battlerId: 1, stat: STAT_SPEED, change: 2 },
    ])

    // Special hit (Water Gun) does not activate Weak Armor
    const state2 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_WEAK_ARMOR, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out2 = executeTurn(state2, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(20)))

    expect(state2.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state2.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    const act2 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act2.statChanges).toBeNull()
  })

  it('Anger Point raises Attack by 1 on normal hit, and by 12 (max) on critical hit', () => {
    // Normal hit
    const state1 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ANGER_POINT, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out1 = executeTurn(state1, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state1.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    const act1 = out1.actions.find((a) => a.battlerId === 0)!
    expect(act1.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: 1 }])

    // Critical hit (isCriticalHit = true)
    const state2 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ANGER_POINT, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out2 = executeTurn(state2, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20, true)))

    expect(state2.battlers[1]!.mon.statStages[STAT_ATK]).toBe(12)
    const act2 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act2.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: 6 }])
  })

  it('Berserk raises highest attacking stat by 1 when crossing half HP, and does not fire when starting <= half HP', () => {
    // Crossing half HP: starts at 60/100 HP, takes 20 dmg -> 40/100 HP (<= 50, but started > 50).
    // Defender rawStats: atk 100, spatk 80 (atk > spatk, so STAT_ATK is raised).
    const state1 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 60, maxHp: 100, abilities: { ability: ABILITY_BERSERK, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out1 = executeTurn(state1, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state1.battlers[1]!.mon.hp).toBe(40)
    expect(state1.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    const act1 = out1.actions.find((a) => a.battlerId === 0)!
    expect(act1.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: 1 }])
    expect(state1.battlers[1]!.volatiles.abilityState[0]).toBe(1)

    // Starting at or below half HP: starts at 50/100 HP, takes 10 dmg -> 40/100 HP (did not cross).
    const state2 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 50, maxHp: 100, abilities: { ability: ABILITY_BERSERK, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out2 = executeTurn(state2, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(10)))

    expect(state2.battlers[1]!.mon.hp).toBe(40)
    expect(state2.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    const act2 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act2.statChanges).toBeNull()
  })

  it('Cute Charm infatuates attacker on contact hit when roll < 50, and does not infatuate when roll >= 50', () => {
    // Roll < 50: rng draws 0 for accuracy check, 20 for Cute Charm (< 50) -> infatuation applied
    const state1 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_CUTE_CHARM, innates: [null, null, null] } }],
      scriptedRng([0, 20]),
    )
    executeTurn(state1, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state1.battlers[0]!.mon.status2, statusInfatuatedWith(1))).toBe(true)

    // Roll >= 50: rng draws 0 for accuracy check, 60 for Cute Charm (>= 50) -> no infatuation
    const state2 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_CUTE_CHARM, innates: [null, null, null] } }],
      scriptedRng([0, 60]),
    )
    executeTurn(state2, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state2.battlers[0]!.mon.status2, statusInfatuatedWith(1))).toBe(false)
  })

  it('Toxic Debris sets Toxic Spikes on attacker side on contact hit, and does not trigger on non-contact hit', () => {
    // Contact hit (Tackle) sets Toxic Spikes (layer 1)
    const state1 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_TOXIC_DEBRIS, innates: [null, null, null] } }],
      scriptedRng(),
    )
    executeTurn(state1, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state1.sides[0]!.statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(true)
    expect(state1.sides[0]!.timers.toxicSpikesAmount).toBe(1)

    // Non-contact hit (Water Gun) does not set Toxic Spikes
    const state2 = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_TOXIC_DEBRIS, innates: [null, null, null] } }],
      scriptedRng(),
    )
    executeTurn(state2, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state2.sides[0]!.statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(false)
    expect(state2.sides[0]!.timers.toxicSpikesAmount).toBe(0)
  })

  it('Loose Quills sets Spikes on attacker side on contact hit', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_LOOSE_QUILLS, innates: [null, null, null] } }],
      scriptedRng(),
    )
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(state.sides[0]!.timers.spikesAmount).toBe(1)
  })

  it('Sand Spit summons Sandstorm on hit and grounds airborne attacker with Smack Down', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_SAND_SPIT, innates: [null, null, null] } }],
      scriptedRng(),
    )
    // Make attacker airborne via Magnet Rise
    state.battlers[0]!.statuses3 |= STATUS3_MAGNET_RISE

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state.field.weather, WEATHER_SANDSTORM_TEMPORARY)).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_SMACKED_DOWN)).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_MAGNET_RISE)).toBe(false)
  })

  it('Stamina in an innate slot fires (+1 Def on damaging hit)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: null, innates: [ABILITY_STAMINA, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: 1 }])
  })

  it('Inflatable raises Def and SpDef by 1 when hit by Fire or Flying move', () => {
    // Flamethrower (Fire type)
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_INFLATABLE, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_FLAMETHROWER), null], testDepsWithDamage(fixedDamage(20)))

    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[1]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toEqual([
      { battlerId: 1, stat: STAT_DEF, change: 1 },
      { battlerId: 1, stat: STAT_SPDEF, change: 1 },
    ])
  })

  it('Steam Engine raises Speed by 12 (max) when hit by Fire or Water move', () => {
    // Water Gun (Water type)
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_STEAM_ENGINE, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(20)))

    expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(12)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPEED, change: 6 }])
  })

  it('Guilt Trip lowers attacker Attack and Sp. Atk by 2 when defender faints', () => {
    // Defender has 15 HP and takes 20 damage -> faints
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 15, maxHp: 100, abilities: { ability: ABILITY_GUILT_TRIP, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 2)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE - 2)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: -2 },
      { battlerId: 0, stat: STAT_SPATK, change: -2 },
    ])
  })

  it('Cotton Down lowers the opposing Speed by 1 on a hit', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: requireAbility('ABILITY_COTTON_DOWN'), innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: -1 }])
  })

  it("Ill Will zeroes the attacker's PP for the move when the holder faints to a contact hit", () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 15, maxHp: 100, abilities: { ability: requireAbility('ABILITY_ILL_WILL'), innates: [null, null, null] } }],
      scriptedRng(),
    )
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(state.battlers[0]!.mon.pp[0]).toBe(0)
  })
})

describe('MOVEEND_ABILITIES onAttacker batch (cycle 43)', () => {
  it('Growing Tooth raises Attack by 1 when using a bite move', () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_GROWING_TOOTH, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_BITE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
  })

  it('Growing Tooth does NOT raise Attack when using a non-bite move (Tackle)', () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_GROWING_TOOTH, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toBeNull()
  })

  it('Growing Tooth raises Attack by 1 when equipped in an innate slot', () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: null, innates: [ABILITY_GROWING_TOOTH, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_BITE), null], testDepsWithDamage(fixedDamage(30)))

    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
  })

  it('Envenom poisons defender on hit when roll < 30, and misses when roll >= 30', () => {
    // Roll < 30: roll 0 for accuracy, roll 20 for Envenom (< 30) -> poisoned
    const state1 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ENVENOM, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng([0, 20]),
    )
    const out1 = executeTurn(state1, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state1.battlers[1]!.mon.status1).toBe(STATUS1_POISON)
    const act1 = out1.actions.find((a) => a.battlerId === 0)!
    expect(act1.statusApplied).toEqual({ battlerId: 1, status: 'POISON' })

    // Roll >= 30: roll 0 for accuracy, roll 50 for Envenom (>= 30) -> no status
    const state2 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ENVENOM, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng([0, 50]),
    )
    const out2 = executeTurn(state2, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state2.battlers[1]!.mon.status1).toBe(STATUS1_NONE)
    const act2 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act2.statusApplied).toBeNull()
  })

  it('Stench flinches the slower target on a roll below 10, and not on a roll of 10', () => {
    // STATUS2_FLINCHED is cleared at end of turn, so read it through the target's cancelled action.
    const stench = { hp: 100, maxHp: 100, abilities: { ability: ABILITY_STENCH, innates: [null, null, null] as [null, null, null] } }
    const rng1 = scriptedRng([0, 9]) // attacker accuracy, Stench roll
    const state1 = battle([stench, { hp: 100, maxHp: 100 }], rng1)
    const out1 = executeTurn(state1, [useMove(1, MOVE_TACKLE), useMove(0, MOVE_TACKLE)], testDepsWithDamage(fixedDamage(20)))
    expect(actionOf(out1, 1).cancelledBy).toBe('FLINCH')
    expect(state1.battlers[0]!.mon.hp).toBe(100)

    const rng2 = scriptedRng([0, 10])
    const state2 = battle([stench, { hp: 100, maxHp: 100 }], rng2)
    const out2 = executeTurn(state2, [useMove(1, MOVE_TACKLE), useMove(0, MOVE_TACKLE)], testDepsWithDamage(fixedDamage(20)))
    expect(actionOf(out2, 1).cancelledBy).toBeNull()
    expect(state2.battlers[0]!.mon.hp).toBe(80)
  })

  it('Absorbant inflicts Leech Seed on defender on drain move (Mega Drain), and does not affect Grass types', () => {
    // Mega Drain into non-Grass target
    const state1 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ABSORBANT, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    executeTurn(state1, [useMove(1, MOVE_MEGA_DRAIN), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state1.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(true)
    expect(state1.battlers[1]!.statuses3 & 0x3).toBe(0) // seeded by battler 0

    // Mega Drain into Grass target -> Leech Seed immune
    const state2 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ABSORBANT, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, types: ['GRASS', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    executeTurn(state2, [useMove(1, MOVE_MEGA_DRAIN), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state2.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(false)
  })

  it('Damp changes defender type to Water on contact hit, but does not trigger on non-contact move', () => {
    // Contact hit (Tackle)
    const state1 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_DAMP, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    executeTurn(state1, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state1.battlers[1]!.mon.types).toEqual(['WATER', 'WATER', 'MYSTERY'])

    // Non-contact hit (Water Gun)
    const state2 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_DAMP, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    executeTurn(state2, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(20)))

    expect(state2.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
  })

  it('Cute Charm on attacker infatuates defender on contact hit when roll < 50, and misses on roll >= 50 or non-contact move', () => {
    // Roll < 50: roll 0 for accuracy, roll 20 for Cute Charm (< 50) -> infatuation
    const state1 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_CUTE_CHARM, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng([0, 20]),
    )
    executeTurn(state1, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state1.battlers[1]!.mon.status2, statusInfatuatedWith(0))).toBe(true)

    // Roll >= 50: roll 0 for accuracy, roll 60 for Cute Charm (>= 50) -> no infatuation
    const state2 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_CUTE_CHARM, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng([0, 60]),
    )
    executeTurn(state2, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state2.battlers[1]!.mon.status2, statusInfatuatedWith(0))).toBe(false)

    // Non-contact hit (Water Gun): no infatuation regardless of roll
    const state3 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_CUTE_CHARM, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng([0, 20]),
    )
    executeTurn(state3, [useMove(1, MOVE_WATER_GUN), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state3.battlers[1]!.mon.status2, statusInfatuatedWith(0))).toBe(false)
  })

  it('Pure Love heals attacker floor(hpDealt / 4) when target is already infatuated', () => {
    const state = battle(
      [
        { hp: 60, maxHp: 100, abilities: { ability: ABILITY_PURE_LOVE, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng(),
    )
    state.battlers[1]!.mon.status2 = statusInfatuatedWith(0)
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(40)))

    // 60 + floor(40 / 4) = 70 HP
    expect(state.battlers[0]!.mon.hp).toBe(70)
  })

  it('Illuminate removes Ghost type from defender on a damaging hit', () => {
    // Defender has Ghost/Poison types
    const state1 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ILLUMINATE, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, types: ['GHOST', 'POISON', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    executeTurn(state1, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state1.battlers[1]!.mon.types).toEqual(['POISON', 'POISON', 'MYSTERY'])

    // Defender has no Ghost type -> types unchanged
    const state2 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ILLUMINATE, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    executeTurn(state2, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state2.battlers[1]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
  })

  it('Loud Bang confounds target with 50% chance on a sound-based move (Hyper Voice)', () => {
    // 50% roll succeeds: roll 0 for accuracy, roll 1 for Loud Bang (1 % 2 !== 0) -> confused
    const state1 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_LOUD_BANG, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng([0, 1]),
    )
    const out1 = executeTurn(state1, [useMove(1, MOVE_HYPER_VOICE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state1.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
    const act1 = out1.actions.find((a) => a.battlerId === 0)!
    expect(act1.statusApplied).toEqual({ battlerId: 1, status: 'CONFUSION' })

    // 50% roll fails: roll 0 for accuracy, roll 2 for Loud Bang (2 % 2 !== 0 is false) -> no confusion
    const state2 = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_LOUD_BANG, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng([0, 2]),
    )
    const out2 = executeTurn(state2, [useMove(1, MOVE_HYPER_VOICE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state2.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
    const act2 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act2.statusApplied).toBeNull()
  })

  it('Grip Pincer wraps target on contact hit and logs unmodelled wrap message', () => {
    // roll 0 for accuracy, roll 1 for Grip Pincer (< 50% chance), roll 0 for wrap turns
    const state = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_GRIP_PINCER, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng([0, 1, 0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
    // Grip Pincer wraps for 4; ENDTURN_WRAP (battle_util.c:2663) decrements it once in the same turn.
    expect(state.battlers[1]!.volatiles.wrapTurns).toBe(3)
    expect(out.actions.find((a) => a.battlerId === 0)!.unmodelled).toContain('Grip Pincer set STATUS2_WRAPPED; ENDTURN_WRAP damage and the trap are not modelled')
  })

  it('Pickpocket logs unmodelled item theft when attacker has no item and defender has item', () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100, itemId: null, abilities: { ability: ABILITY_PICKPOCKET, innates: [null, null, null] } },
        { hp: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS' },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(out.actions.find((a) => a.battlerId === 0)!.unmodelled).toContain("Pickpocket's item theft (StealTargetItem, battle_script_commands.c:4848) is not modelled")
  })

  it('Volcano Rage logs unmodelled followup move on Fire move', () => {
    const state = battle(
      [
        { hp: 100, maxHp: 100, abilities: { ability: ABILITY_VOLCANO_RAGE, innates: [null, null, null] } },
        { hp: 100, maxHp: 100 },
      ],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_FLAMETHROWER), null], testDepsWithDamage(fixedDamage(20)))

    expect(out.actions.find((a) => a.battlerId === 0)!.unmodelled).toContain("Volcano Rage's followup move (UseAttackerFollowUpMove MOVE_ERUPTION, abilities.cc:4845) is not modelled")
  })

  describe('Case 25: MOVEEND_ABILITIES_AFTER_RECOIL (Nosferatu)', () => {
    it('Nosferatu heals half the damage dealt on a contact move', () => {
      const state = battle(
        [
          { hp: 50, maxHp: 100, abilities: { ability: ABILITY_NOSFERATU, innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        scriptedRng(),
      )
      executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

      // Dealt 20 damage on contact move; heals half = 10 HP. HP was 50, now 60.
      expect(state.battlers[0]!.mon.hp).toBe(60)
    })

    it('Nosferatu does nothing at full HP', () => {
      const state = battle(
        [
          { hp: 100, maxHp: 100, abilities: { ability: ABILITY_NOSFERATU, innates: [null, null, null] } },
          { hp: 100, maxHp: 100 },
        ],
        scriptedRng(),
      )
      executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

      expect(state.battlers[0]!.mon.hp).toBe(100)
    })
  })
})



