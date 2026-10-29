/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 106 -- the on-hit attacker ability batch. Each block is a transcription of the
// onAttacker lambda in pipeline/.upstream/eliteredux-source/src/abilities.cc; the roll is
// always drawn last, after every earlier CHECK passes.
//
// Common C references (pinned upstream):
// - ShouldApplyOnHitEffect(applyTo) = DidMoveHit() && IsBattlerAlive(applyTo),
//   src/battle_util.c:4058-4062; DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED.
// - AbilityStatusEffect(MoveEffectEnum), src/abilities.cc:263-268.
// - CanBeParalyzed / CanBleed / CanBeBurned / CanGetFrostbite / CanBeConfused /
//   CanBePoisoned / CanBeDisabled, src/battle_util.c:5019-5123.
// - IsIronFistBoosted (:9375), IsSoundMove (:9379), IsKeenEdge (:9381) ->
//   DoesMoveMatchFlag, src/abilities.cc:358-388; MOVE_FLAG_KICK grants at :7603-7622,
//   :9898-9905, :11570-11583 (port: statusEffects.ts isStrikerMove).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { dispatchMoveEndAttackerAbilities } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { TypeChart } from '../typeEffectiveness'
import {
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS2_CONFUSION,
  hasFlag,
} from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- the same snapshot-backed shape cycle95Abilities.test.ts uses.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 as string | null,
    target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'],
    argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    sheerForceBoost: m.sheerForceBoost as true | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
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
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

type BattlerSpec = {
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  gender?: SimBattleMon['gender']
  status1?: number
  status2?: number
}

function battle(specs: BattlerSpec[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          gender: s.gender ?? 'MALE',
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      const val = values[idx] ?? 0
      idx++
      return val
    },
  }
  return r
}

function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ?? 'NORMAL',
    power: moveData.power,
    flags: moveData.flags,
    split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function fixedDamage(amount: number, isCriticalHit = false): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function testDeps(damage: DamageResolver = fixedDamage(20), grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })
const notModelled = (notes: string[], ability: string) => notes.filter((n) => n.includes(ability))
const TYPES = (t: string): [string, string, string] => [t, 'MYSTERY', 'MYSTERY']

/** One turn: holder (battler 0) uses `moveId` on battler 1 for a fixed amount of damage. */
function run(
  ability: string,
  moveId: string,
  rolls: number[],
  holder: BattlerSpec = {},
  target: BattlerSpec = {},
  setup?: (state: BattleState) => void,
  dmg = 10,
) {
  const rng = scriptedRng(rolls)
  const state = battle([{ moves: slot(moveId), pp: pps, abilities: hasAbility(ability), ...holder }, target], rng)
  setup?.(state)
  const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(dmg)))
  return { state, rng, out, holder: state.battlers[0]!, target: state.battlers[1]! }
}

/** The move-end attacker dispatch alone (no accuracy / protect pipeline), for states a real turn would not reach. */
function dispatchOnly(
  state: BattleState,
  moveId: string,
  opts: { targetDamage?: number; hpDealt?: number; noEffect?: boolean } = {},
) {
  const unmodelled: string[] = []
  const targetDamage = opts.targetDamage ?? 20
  const hpDealt = opts.hpDealt ?? targetDamage
  const res = dispatchMoveEndAttackerAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt,
    noEffect: opts.noEffect,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled,
    fainted: [],
  })
  return { res, unmodelled }
}

// ---------------------------------------------------------------------------
// 1. Arc Flash (src/abilities.cc:8082-8090)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Arc Flash (abilities.cc:8082-8090)', () => {
  const ARC = 'ABILITY_ARC_FLASH'

  it('paralyzes the target when the 50% roll is odd (1 hits, 0 does not)', () => {
    // Tackle: accuracy 100, no secondary effect -> rolls: accuracy, then Random() % 2.
    const hit = run(ARC, 'MOVE_TACKLE', [0, 1])
    expect(hasFlag(hit.target.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    expect(hit.rng.calls).toBe(2)
    expect(hit.out.actions[0]!.statusApplied).toEqual({ battlerId: 1, status: 'PARALYSIS' })
    expect(notModelled(hit.out.actions[0]!.unmodelled, ARC)).toEqual([])

    const miss = run(ARC, 'MOVE_TACKLE', [0, 0])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)
  })

  it('draws no roll for an Electric target, a statused target, a fainted target or no damage', () => {
    // CanBeParalyzed fails on Electric types (CanParalyzeType) before Random().
    const electric = run(ARC, 'MOVE_TACKLE', [0], {}, { types: TYPES('ELECTRIC') })
    expect(electric.target.mon.status1).toBe(0)
    expect(electric.rng.calls).toBe(1)

    const statused = run(ARC, 'MOVE_TACKLE', [0], {}, { status1: STATUS1_BURN })
    expect(statused.target.mon.status1).toBe(STATUS1_BURN)
    expect(statused.rng.calls).toBe(1)

    // ShouldApplyOnHitEffect(target) requires IsBattlerAlive(target); 10 damage into 10 HP faints it.
    const fainted = run(ARC, 'MOVE_TACKLE', [0], {}, { hp: 10 })
    expect(fainted.target.mon.hp).toBe(0)
    expect(fainted.rng.calls).toBe(1)

    const noDamage = run(ARC, 'MOVE_TACKLE', [0], {}, {}, undefined, 0)
    expect(noDamage.target.mon.status1).toBe(0)
    expect(noDamage.rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. Hypnotic Trance (src/abilities.cc:12593-12601)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Hypnotic Trance (abilities.cc:12593-12601)', () => {
  const HT = 'ABILITY_HYPNOTIC_TRANCE'
  const hypnoticTarget = (overrides: BattlerSpec = {}) =>
    battle([{ abilities: hasAbility(HT), moves: slot('MOVE_HYPNOSIS'), pp: pps }, overrides], scriptedRng([]))

  it('confuses the target after a successful Hypnosis, with no roll', () => {
    const state = hypnoticTarget()
    const { res, unmodelled } = dispatchOnly(state, 'MOVE_HYPNOSIS', { targetDamage: 0, noEffect: false })
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
    expect(res.statusApplied).toEqual({ battlerId: 1, status: 'CONFUSION' })
    expect(notModelled(unmodelled, HT)).toEqual([])
  })

  it('does nothing for another move', () => {
    const state = hypnoticTarget()
    dispatchOnly(state, 'MOVE_TACKLE', { targetDamage: 0, noEffect: false })
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
  })

  it('does nothing when WasMoveSuccessful() is false (MOVE_RESULT_NO_EFFECT)', () => {
    // battle_util.c:4058 -- WasMoveSuccessful && attacker != target is the whole CHECK; the sim carries the
    // MOVE_RESULT_NO_EFFECT bit as MoveEndAbilitiesContext.noEffect.
    const state = hypnoticTarget()
    dispatchOnly(state, 'MOVE_HYPNOSIS', { targetDamage: 0, noEffect: true })
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
  })

  it('does nothing when the target is already confused (CanBeConfused)', () => {
    const state = hypnoticTarget({ status2: STATUS2_CONFUSION })
    dispatchOnly(state, 'MOVE_HYPNOSIS', { targetDamage: 0, noEffect: false })
    expect(state.battlers[1]!.mon.status2).toBe(STATUS2_CONFUSION)
  })
})

// ---------------------------------------------------------------------------
// 3. Icicle Fist (src/abilities.cc:12500-12508)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Icicle Fist (abilities.cc:12500-12508)', () => {
  const IF = 'ABILITY_ICICLE_FIST'

  it('frostbites the target on a 30% roll after a punch move', () => {
    // Mega Punch: punchBased, no secondary effect -> rolls: accuracy, then the ability's 30%.
    const hit = run(IF, 'MOVE_MEGA_PUNCH', [0, 29])
    expect(hasFlag(hit.target.mon.status1, STATUS1_FROSTBITE)).toBe(true)
    expect(hit.rng.calls).toBe(2)
    expect(hit.out.actions[0]!.statusApplied).toEqual({ battlerId: 1, status: 'FROSTBITE' })
    expect(notModelled(hit.out.actions[0]!.unmodelled, IF)).toEqual([])

    const miss = run(IF, 'MOVE_MEGA_PUNCH', [0, 30])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)
  })

  it('draws no roll for a non-punch move, an Ice target, a statused target or no damage', () => {
    const nonPunch = run(IF, 'MOVE_TACKLE', [0])
    expect(nonPunch.target.mon.status1).toBe(0)
    expect(nonPunch.rng.calls).toBe(1)

    const ice = run(IF, 'MOVE_MEGA_PUNCH', [0], {}, { types: TYPES('ICE') })
    expect(ice.target.mon.status1).toBe(0)
    expect(ice.rng.calls).toBe(1)

    const statused = run(IF, 'MOVE_MEGA_PUNCH', [0], {}, { status1: STATUS1_BURN })
    expect(statused.target.mon.status1).toBe(STATUS1_BURN)
    expect(statused.rng.calls).toBe(1)

    const fainted = run(IF, 'MOVE_MEGA_PUNCH', [0], {}, { hp: 10 })
    expect(fainted.rng.calls).toBe(1)

    const noDamage = run(IF, 'MOVE_MEGA_PUNCH', [0], {}, {}, undefined, 0)
    expect(noDamage.target.mon.status1).toBe(0)
    expect(noDamage.rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Laser Drill (src/abilities.cc:11007-11015)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Laser Drill (abilities.cc:11007-11015)', () => {
  const LD = 'ABILITY_LASER_DRILL'

  it('burns the target when the 50% roll is odd after a horn move', () => {
    // Fire Glaive: hornBased, no secondary effect -> rolls: accuracy, then Random() % 2.
    const hit = run(LD, 'MOVE_FIRE_GLAIVE', [0, 1])
    expect(hasFlag(hit.target.mon.status1, STATUS1_BURN)).toBe(true)
    expect(hit.rng.calls).toBe(2)
    expect(notModelled(hit.out.actions[0]!.unmodelled, LD)).toEqual([])

    const miss = run(LD, 'MOVE_FIRE_GLAIVE', [0, 0])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)
  })

  it('draws no roll for a non-horn move, a Fire target, a statused target or no damage', () => {
    const nonHorn = run(LD, 'MOVE_TACKLE', [0])
    expect(nonHorn.target.mon.status1).toBe(0)
    expect(nonHorn.rng.calls).toBe(1)

    const fire = run(LD, 'MOVE_FIRE_GLAIVE', [0], {}, { types: TYPES('FIRE') })
    expect(fire.target.mon.status1).toBe(0)
    expect(fire.rng.calls).toBe(1)

    const statused = run(LD, 'MOVE_FIRE_GLAIVE', [0], {}, { status1: STATUS1_PARALYSIS })
    expect(statused.target.mon.status1).toBe(STATUS1_PARALYSIS)
    expect(statused.rng.calls).toBe(1)

    const fainted = run(LD, 'MOVE_FIRE_GLAIVE', [0], {}, { hp: 10 })
    expect(fainted.rng.calls).toBe(1)

    const noDamage = run(LD, 'MOVE_FIRE_GLAIVE', [0], {}, {}, undefined, 0)
    expect(noDamage.rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Piercing Solo (src/abilities.cc:8011-8019)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Piercing Solo (abilities.cc:8011-8019)', () => {
  const PS = 'ABILITY_PIERCING_SOLO'

  it('bleeds the target with a sound move and no roll', () => {
    // Hyper Voice: sound, no secondary effect -> only the accuracy roll is drawn.
    const hit = run(PS, 'MOVE_HYPER_VOICE', [0])
    expect(hasFlag(hit.target.mon.status1, STATUS1_BLEED)).toBe(true)
    expect(hit.rng.calls).toBe(1)
    expect(hit.out.actions[0]!.statusApplied).toEqual({ battlerId: 1, status: 'BLEED' })
    expect(notModelled(hit.out.actions[0]!.unmodelled, PS)).toEqual([])
  })

  it('does nothing for a non-sound move, a Rock/Ghost target, a statused target or no damage', () => {
    const nonSound = run(PS, 'MOVE_TACKLE', [0])
    expect(nonSound.target.mon.status1).toBe(0)
    expect(nonSound.rng.calls).toBe(1)

    for (const type of ['ROCK', 'GHOST']) {
      const immune = run(PS, 'MOVE_HYPER_VOICE', [0], {}, { types: TYPES(type) })
      expect(immune.target.mon.status1).toBe(0)
      expect(immune.rng.calls).toBe(1)
    }

    const statused = run(PS, 'MOVE_HYPER_VOICE', [0], {}, { status1: STATUS1_BURN })
    expect(statused.target.mon.status1).toBe(STATUS1_BURN)

    const fainted = run(PS, 'MOVE_HYPER_VOICE', [0], {}, { hp: 10 })
    expect(fainted.rng.calls).toBe(1)

    const noDamage = run(PS, 'MOVE_HYPER_VOICE', [0], {}, {}, undefined, 0)
    expect(noDamage.target.mon.status1).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Radio Jam (src/abilities.cc:7544-7552)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Radio Jam (abilities.cc:7544-7552)', () => {
  const RJ = 'ABILITY_RADIO_JAM'
  const withLastMove = (state: BattleState) => {
    state.battlers[1]!.lastMove = 'MOVE_TACKLE'
  }

  it('disables the target last move on a roll < 20 after a sound move', () => {
    // Hyper Voice: sound, no secondary effect -> rolls: accuracy, then the ability's 20%.
    const hit = run(
      RJ,
      'MOVE_HYPER_VOICE',
      [0, 19],
      {},
      { moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
      withLastMove,
    )
    expect(hit.target.volatiles.disabledMove).toBe('MOVE_TACKLE')
    // DisableLastUsedMove writes B_DISABLE_TURNS (4); the turn's end-of-turn ladder then ticks it once.
    expect(hit.target.volatiles.disableTimer).toBe(3)
    expect(hit.rng.calls).toBe(2)
    expect(notModelled(hit.out.actions[0]!.unmodelled, RJ)).toEqual([])

    const miss = run(
      RJ,
      'MOVE_HYPER_VOICE',
      [0, 20],
      {},
      { moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
      withLastMove,
    )
    expect(miss.target.volatiles.disabledMove).toBeNull()
    expect(miss.rng.calls).toBe(2)
  })

  it('draws no roll for a non-sound move, an already-disabled target or no damage', () => {
    const nonSound = run(
      RJ,
      'MOVE_TACKLE',
      [0],
      {},
      { moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
      withLastMove,
    )
    expect(nonSound.target.volatiles.disabledMove).toBeNull()
    expect(nonSound.rng.calls).toBe(1)

    // CanBeDisabled: gVolatileStructs[battlerId].disabledMove set.
    const disabled = run(
      RJ,
      'MOVE_HYPER_VOICE',
      [0],
      {},
      { moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
      (state) => {
        withLastMove(state)
        state.battlers[1]!.volatiles.disabledMove = 'MOVE_TACKLE'
      },
    )
    expect(disabled.target.volatiles.disabledMove).toBe('MOVE_TACKLE')
    expect(disabled.rng.calls).toBe(1)

    const noDamage = run(
      RJ,
      'MOVE_HYPER_VOICE',
      [0],
      {},
      { moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
      withLastMove,
      0,
    )
    expect(noDamage.target.volatiles.disabledMove).toBeNull()
    expect(noDamage.rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 7. Sharp Talons (src/abilities.cc:11345-11353)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Sharp Talons (abilities.cc:11345-11353)', () => {
  const ST = 'ABILITY_SHARP_TALONS'

  it('bleeds the target when the 50% roll is odd after a kick move', () => {
    // Mega Kick: kickBased, no secondary effect -> rolls: accuracy, then Random() % 2.
    const hit = run(ST, 'MOVE_MEGA_KICK', [0, 1])
    expect(hasFlag(hit.target.mon.status1, STATUS1_BLEED)).toBe(true)
    expect(hit.rng.calls).toBe(2)
    expect(notModelled(hit.out.actions[0]!.unmodelled, ST)).toEqual([])

    const miss = run(ST, 'MOVE_MEGA_KICK', [0, 0])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)
  })

  it('draws no roll for a non-kick move, a Rock target, a statused target or no damage', () => {
    const nonKick = run(ST, 'MOVE_TACKLE', [0])
    expect(nonKick.target.mon.status1).toBe(0)
    expect(nonKick.rng.calls).toBe(1)

    const rock = run(ST, 'MOVE_MEGA_KICK', [0], {}, { types: TYPES('ROCK') })
    expect(rock.target.mon.status1).toBe(0)
    expect(rock.rng.calls).toBe(1)

    const statused = run(ST, 'MOVE_MEGA_KICK', [0], {}, { status1: STATUS1_BURN })
    expect(statused.target.mon.status1).toBe(STATUS1_BURN)
    expect(statused.rng.calls).toBe(1)

    const fainted = run(ST, 'MOVE_MEGA_KICK', [0], {}, { hp: 10 })
    expect(fainted.rng.calls).toBe(1)

    const noDamage = run(ST, 'MOVE_MEGA_KICK', [0], {}, {}, undefined, 0)
    expect(noDamage.rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 8/9. Shocking Jaws and Shocking Maw (src/abilities.cc:5716-5724, :8822-8823)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Shocking Jaws / Shocking Maw (abilities.cc:5716-5724, :8822-8823)', () => {
  for (const ability of ['ABILITY_SHOCKING_JAWS', 'ABILITY_SHOCKING_MAW']) {
    it(`${ability}: paralyzes a bite target when the 50% roll is odd`, () => {
      // Psychic Fangs: biteBased, effectChance 0 -> rolls: accuracy, then Random() % 2.
      const hit = run(ability, 'MOVE_PSYCHIC_FANGS', [0, 1])
      expect(hasFlag(hit.target.mon.status1, STATUS1_PARALYSIS)).toBe(true)
      expect(hit.rng.calls).toBe(2)
      expect(notModelled(hit.out.actions[0]!.unmodelled, ability)).toEqual([])

      const miss = run(ability, 'MOVE_PSYCHIC_FANGS', [0, 0])
      expect(miss.target.mon.status1).toBe(0)
      expect(miss.rng.calls).toBe(2)
    })

    it(`${ability}: draws no roll for a non-bite move, an Electric target, a statused target or no damage`, () => {
      const nonBite = run(ability, 'MOVE_TACKLE', [0])
      expect(nonBite.target.mon.status1).toBe(0)
      expect(nonBite.rng.calls).toBe(1)

      const electric = run(ability, 'MOVE_PSYCHIC_FANGS', [0], {}, { types: TYPES('ELECTRIC') })
      expect(electric.target.mon.status1).toBe(0)
      expect(electric.rng.calls).toBe(1)

      const statused = run(ability, 'MOVE_PSYCHIC_FANGS', [0], {}, { status1: STATUS1_BURN })
      expect(statused.target.mon.status1).toBe(STATUS1_BURN)
      expect(statused.rng.calls).toBe(1)

      const fainted = run(ability, 'MOVE_PSYCHIC_FANGS', [0], {}, { hp: 10 })
      expect(fainted.rng.calls).toBe(1)

      const noDamage = run(ability, 'MOVE_PSYCHIC_FANGS', [0], {}, {}, undefined, 0)
      expect(noDamage.target.mon.status1).toBe(0)
      expect(noDamage.rng.calls).toBe(1)
    })
  }
})

// ---------------------------------------------------------------------------
// 10. Stun Shock (src/abilities.cc:8917-8933)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Stun Shock (abilities.cc:8917-8933)', () => {
  const SS = 'ABILITY_STUN_SHOCK'

  it('branch 0 poisons, branch 1 paralyzes; both rolls are drawn after the 60% check', () => {
    // Tackle -> rolls: accuracy, the 60% roll, then Random() % 2.
    const poison = run(SS, 'MOVE_TACKLE', [0, 59, 0])
    expect(hasFlag(poison.target.mon.status1, STATUS1_POISON)).toBe(true)
    expect(poison.rng.calls).toBe(3)
    expect(poison.out.actions[0]!.statusApplied).toEqual({ battlerId: 1, status: 'POISON' })
    expect(notModelled(poison.out.actions[0]!.unmodelled, SS)).toEqual([])

    const paralysis = run(SS, 'MOVE_TACKLE', [0, 59, 1])
    expect(hasFlag(paralysis.target.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    expect(paralysis.rng.calls).toBe(3)
  })

  it('the 60% check failing draws only the accuracy and the 60% roll', () => {
    const miss = run(SS, 'MOVE_TACKLE', [0, 60])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)
  })

  it('a failed branch CHECK leaves the target untouched, but both rolls are still consumed', () => {
    // case 0: CanBePoisoned fails on an already-statused target -> nothing.
    const statused = run(SS, 'MOVE_TACKLE', [0, 59, 0], {}, { status1: STATUS1_BURN })
    expect(statused.target.mon.status1).toBe(STATUS1_BURN)
    expect(statused.rng.calls).toBe(3)

    // case 1: CanBeParalyzed fails on an Electric target -> nothing.
    const electric = run(SS, 'MOVE_TACKLE', [0, 59, 1], {}, { types: TYPES('ELECTRIC') })
    expect(electric.target.mon.status1).toBe(0)
    expect(electric.rng.calls).toBe(3)
  })

  it('draws no roll for a fainted target or no damage', () => {
    const fainted = run(SS, 'MOVE_TACKLE', [0], {}, { hp: 10 })
    expect(fainted.rng.calls).toBe(1)

    const noDamage = run(SS, 'MOVE_TACKLE', [0], {}, {}, undefined, 0)
    expect(noDamage.target.mon.status1).toBe(0)
    expect(noDamage.rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 11. Light Saber (src/abilities.cc:11019-11039)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Light Saber (abilities.cc:11019-11039)', () => {
  const LS = 'ABILITY_LIGHT_SABER'

  it('burn on 1/4, paralysis on the next 1/4, nothing otherwise', () => {
    // Sacred Sword: Keen Edge, no secondary effect -> rolls: accuracy, Random() % 2, Random() % 4.
    const burn = run(LS, 'MOVE_SACRED_SWORD', [0, 1, 0])
    expect(hasFlag(burn.target.mon.status1, STATUS1_BURN)).toBe(true)
    expect(burn.rng.calls).toBe(3)
    expect(notModelled(burn.out.actions[0]!.unmodelled, LS)).toEqual([])

    const paralysis = run(LS, 'MOVE_SACRED_SWORD', [0, 1, 1])
    expect(hasFlag(paralysis.target.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    expect(paralysis.rng.calls).toBe(3)

    const nothing = run(LS, 'MOVE_SACRED_SWORD', [0, 1, 2])
    expect(nothing.target.mon.status1).toBe(0)
    expect(nothing.rng.calls).toBe(3)
  })

  it('the 50% check failing draws only the accuracy and the %2 roll', () => {
    const miss = run(LS, 'MOVE_SACRED_SWORD', [0, 0])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)
  })

  it('a failed branch CHECK leaves the target untouched, but both rolls are still consumed', () => {
    // case 0: CanBeBurned fails on a Fire target.
    const fire = run(LS, 'MOVE_SACRED_SWORD', [0, 1, 0], {}, { types: TYPES('FIRE') })
    expect(fire.target.mon.status1).toBe(0)
    expect(fire.rng.calls).toBe(3)

    // case 1: CanBeParalyzed fails on an already-statused target.
    const statused = run(LS, 'MOVE_SACRED_SWORD', [0, 1, 1], {}, { status1: STATUS1_BURN })
    expect(statused.target.mon.status1).toBe(STATUS1_BURN)
    expect(statused.rng.calls).toBe(3)
  })

  it('draws no roll for a non-Keen-Edge move or no damage', () => {
    const nonKeen = run(LS, 'MOVE_TACKLE', [0])
    expect(nonKeen.target.mon.status1).toBe(0)
    expect(nonKeen.rng.calls).toBe(1)

    const noDamage = run(LS, 'MOVE_SACRED_SWORD', [0], {}, {}, undefined, 0)
    expect(noDamage.rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 12. Hydro Circuit (src/abilities.cc:5368-5380)
// ---------------------------------------------------------------------------

describe('Cycle 106 - Hydro Circuit (abilities.cc:5368-5380)', () => {
  const HC = 'ABILITY_HYDRO_CIRCUIT'

  it('heals the holder floor(hpDealt / 4) after a Water move', () => {
    // Aqua Jet: Water, no secondary effect -> only the accuracy roll. 20 damage -> floor(20 / 4) = 5.
    const heal = run(HC, 'MOVE_AQUA_JET', [0], { hp: 50 }, {}, undefined, 20)
    expect(heal.holder.mon.hp).toBe(55)
    expect(heal.rng.calls).toBe(1)
    expect(notModelled(heal.out.actions[0]!.unmodelled, HC)).toEqual([])
  })

  it('heals at least 1: 3 damage gives -3 / 4 == 0, bumped to -1', () => {
    const heal = run(HC, 'MOVE_AQUA_JET', [0], { hp: 50 }, {}, undefined, 3)
    expect(heal.holder.mon.hp).toBe(51)
  })

  it('does nothing at full HP, for a non-Water move, when healing is blocked, or with no damage', () => {
    const full = run(HC, 'MOVE_AQUA_JET', [0], { hp: 100 }, {}, undefined, 20)
    expect(full.holder.mon.hp).toBe(100)

    const nonWater = run(HC, 'MOVE_TACKLE', [0], { hp: 50 }, {}, undefined, 20)
    expect(nonWater.holder.mon.hp).toBe(50)

    // CanBattlerHeal blocks a bleeding holder (battle_util.c:8979-8986). Dispatch alone: an end-of-turn
    // bleed tick would move the holder's HP and hide the question.
    const bleedingState = battle(
      [{ hp: 50, status1: STATUS1_BLEED, moves: slot('MOVE_AQUA_JET'), pp: pps, abilities: hasAbility(HC) }, {}],
      scriptedRng([0]),
    )
    dispatchOnly(bleedingState, 'MOVE_AQUA_JET', { targetDamage: 20 })
    expect(bleedingState.battlers[0]!.mon.hp).toBe(50)

    const noDamage = run(HC, 'MOVE_AQUA_JET', [0], { hp: 50 }, {}, undefined, 0)
    expect(noDamage.holder.mon.hp).toBe(50)
  })

  it('does nothing when the holder is fainted (ShouldApplyOnHitEffect(battler), not target)', () => {
    const state = battle([{ hp: 0, moves: slot('MOVE_AQUA_JET'), pp: pps, abilities: hasAbility(HC) }, {}], scriptedRng([0]))
    dispatchOnly(state, 'MOVE_AQUA_JET', { targetDamage: 20 })
    expect(state.battlers[0]!.mon.hp).toBe(0)
  })
})
