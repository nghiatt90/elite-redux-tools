/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { dispatchMoveEndDefenderAbilities } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import {
  MOVE_UNSET,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FREEZE,
  STATUS1_SLEEP,
  STATUS2_TRANSFORMED,
  STATUS3_EMBARGO,
  hasFlag,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const rawSpecies = snapshot<Array<Record<string, any>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')

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
    pp: m.pp as number,
  }
}

// Only the Lumbering Sloth pair is resolvable: Flammable Coat's form change reads the engulfed species' stats, types and abilities.
function speciesData(id: string): SimSpeciesData | undefined {
  if (!id.startsWith('SPECIES_LUMBERING_SLOTH')) return undefined
  const s = speciesById.get(id)
  if (!s) throw new Error(`species.json has no ${id}`)
  return {
    id,
    baseStats: s.baseStats,
    types: (s.types as string[]).map((t) => t.replace('TYPE_', '')),
    abilities: s.abilities,
    innates: s.innates,
    weight: s.weight ?? 0,
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
  species: speciesData,
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

interface Spec {
  spe?: number
  hp?: number
  maxHp?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status1?: number
  status2?: number
}

function battle(specs: Spec[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

function countingRng(): RandomSource & { calls: number } {
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return 0
    },
  }
  return r
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

function testDeps(damage: DamageResolver = fixedDamage(20), replacement?: ReplacementDeps, grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    replacement,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })

/** One turn: battler 0 uses `moveId` on battler 1, battler 1 does nothing. */
function turn(state: BattleState, moveId: string, damage = 20): void {
  executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(damage)))
}

/** MOVEEND_ABILITIES for the defender, called directly so a hook's own conditions can be isolated from the rest of the turn. */
function dispatch(state: BattleState, moveId: string, targetDamage = 20, hpDealt = targetDamage): { unmodelled: string[]; fainted: number[] } {
  const unmodelled: string[] = []
  const fainted: number[] = []
  dispatchMoveEndDefenderAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled,
    fainted,
  })
  return { unmodelled, fainted }
}

describe('Cycle 88a - Innards Out (src/abilities.cc:2995-3005, BattleScript_AftermathDmg battle_scripts_1.s:8585-8592)', () => {
  const ability = hasAbility('ABILITY_INNARDS_OUT')

  it('deals the defender\'s hp dealt to the attacker when the hit faints it: 30 damage into 20 hp -> 20', () => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { hp: 20, abilities: ability }], countingRng())
    turn(s, 'MOVE_TACKLE', 30)
    expect(s.battlers[1]?.mon.hp).toBe(0)
    expect(s.battlers[0]?.mon.hp).toBe(80)
  })

  it('does nothing when the defender survives the hit (CHECK_NOT(IsBattlerAlive(battler)))', () => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { hp: 25, abilities: ability }], countingRng())
    turn(s, 'MOVE_TACKLE', 20)
    expect(s.battlers[1]?.mon.hp).toBe(5)
    expect(s.battlers[0]?.mon.hp).toBe(100)
  })

  it('is blocked by Magic Guard on the attacker', () => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_MAGIC_GUARD') }, { hp: 20, abilities: ability }], countingRng())
    turn(s, 'MOVE_TACKLE', 30)
    expect(s.battlers[0]?.mon.hp).toBe(100)
  })

  it('does nothing when the move dealt no damage', () => {
    const s = battle([{}, { hp: 0, abilities: ability }], countingRng())
    dispatch(s, 'MOVE_TACKLE', 0)
    expect(s.battlers[0]?.mon.hp).toBe(100)
  })

  it('does nothing when the attacker is already fainted (ShouldApplyOnHitEffect(attacker))', () => {
    const s = battle([{ hp: 0 }, { hp: 0, abilities: ability }], countingRng())
    const { fainted } = dispatch(s, 'MOVE_TACKLE', 30, 20)
    expect(s.battlers[0]?.mon.hp).toBe(0)
    expect(fainted).toEqual([])
  })

  it('faints an attacker with less hp than the damage, and reports it', () => {
    const s = battle([{ hp: 15 }, { hp: 0, abilities: ability }], countingRng())
    const { fainted } = dispatch(s, 'MOVE_TACKLE', 30, 20)
    expect(s.battlers[0]?.mon.hp).toBe(0)
    expect(fainted).toEqual([0])
  })
})

describe('Cycle 88a - Spiteful (src/abilities.cc:6610-6620, BattleScript_AbilitySpiteful battle_scripts_1.s:4833-4840, Cmd_tryspiteppreduce battle_script_commands.c:10975-11020)', () => {
  const ability = hasAbility('ABILITY_SPITEFUL')
  const attackerMoves = slot('MOVE_TACKLE', 'MOVE_SCRATCH')

  it('cuts 4 PP from the attacker\'s PREVIOUS move on a contact hit (Tackle is slot 0; Scratch in slot 1 was last: 10 -> 6)', () => {
    const s = battle([{ moves: attackerMoves, pp: [20, 10, 0, 0] }, { abilities: ability }], countingRng())
    s.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    turn(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.pp).toEqual([19, 6, 0, 0])
  })

  it('takes only the PP that is left when the previous move has fewer than 4 (3 -> 0)', () => {
    const s = battle([{ moves: attackerMoves, pp: [20, 3, 0, 0] }, { abilities: ability }], countingRng())
    s.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    turn(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.pp).toEqual([19, 0, 0, 0])
  })

  it('does nothing on the attacker\'s first move (gLastMoves is 0 / unset)', () => {
    const first = battle([{ moves: attackerMoves, pp: [20, 10, 0, 0] }, { abilities: ability }], countingRng())
    turn(first, 'MOVE_TACKLE')
    expect(first.battlers[0]?.mon.pp).toEqual([19, 10, 0, 0])

    const unset = battle([{ moves: attackerMoves, pp: [20, 10, 0, 0] }, { abilities: ability }], countingRng())
    unset.battlers[0]!.lastMove = MOVE_UNSET
    turn(unset, 'MOVE_TACKLE')
    expect(unset.battlers[0]?.mon.pp).toEqual([19, 10, 0, 0])
  })

  it('does nothing when the previous move has no PP left (pp != 0 is required) or is not one the attacker knows', () => {
    const empty = battle([{ moves: attackerMoves, pp: [20, 0, 0, 0] }, { abilities: ability }], countingRng())
    empty.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    turn(empty, 'MOVE_TACKLE')
    expect(empty.battlers[0]?.mon.pp).toEqual([19, 0, 0, 0])

    const unknown = battle([{ moves: attackerMoves, pp: [20, 10, 0, 0] }, { abilities: ability }], countingRng())
    unknown.battlers[0]!.lastMove = 'MOVE_POUND'
    turn(unknown, 'MOVE_TACKLE')
    expect(unknown.battlers[0]?.mon.pp).toEqual([19, 10, 0, 0])
  })

  it('does nothing for a non-contact move', () => {
    const s = battle([{ moves: slot('MOVE_ARCHER_SHOT', 'MOVE_SCRATCH'), pp: [20, 10, 0, 0] }, { abilities: ability }], countingRng())
    s.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    turn(s, 'MOVE_ARCHER_SHOT')
    expect(s.battlers[0]?.mon.pp).toEqual([19, 10, 0, 0])
  })

  it('does nothing when the move dealt no damage', () => {
    const s = battle([{ moves: attackerMoves, pp: [20, 10, 0, 0] }, { abilities: ability }], countingRng())
    s.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    turn(s, 'MOVE_TACKLE', 0)
    expect(s.battlers[0]?.mon.pp).toEqual([19, 10, 0, 0])
  })

  it('does nothing when the move just used left the chosen slot at 0 PP (CHECK(pp[gChosenMovePos]))', () => {
    const s = battle([{ moves: attackerMoves, pp: [1, 10, 0, 0] }, { abilities: ability }], countingRng())
    s.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    turn(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.pp).toEqual([0, 10, 0, 0])
  })

  it('does nothing for Struggle (CHECK(move != MOVE_STRUGGLE)) and when the attacker has fainted', () => {
    const struggle = battle([{ moves: attackerMoves, pp: [20, 10, 0, 0] }, { abilities: ability }], countingRng())
    struggle.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    dispatch(struggle, 'MOVE_STRUGGLE')
    expect(struggle.battlers[0]?.mon.pp).toEqual([20, 10, 0, 0])

    const dead = battle([{ hp: 0, moves: attackerMoves, pp: [20, 10, 0, 0] }, { abilities: ability }], countingRng())
    dead.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    dispatch(dead, 'MOVE_TACKLE')
    expect(dead.battlers[0]?.mon.pp).toEqual([20, 10, 0, 0])
  })
})

describe('Cycle 88a - contact counterattacks via UseOutOfTurnAttack (src/battle_util.c:3759-3777)', () => {
  const queueEntry = (ability: string, moveId: string, movePower: number) => ({ ability, move: moveId, attacker: 1, target: 0, movePower })

  it('Cold Rebound queues Icy Wind at natural power (movePower 0) from the defender at the attacker (abilities.cc:4850-4858)', () => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: hasAbility('ABILITY_COLD_REBOUND') }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.queuedExtraAttacks).toEqual([queueEntry('ABILITY_COLD_REBOUND', 'MOVE_ICY_WIND', 0)])
    expect(s.battlers[1]?.turn.dancerUsedMove).toBe(true)
  })

  it('Ice Downfall queues Icicle Crash at power 60 (abilities.cc:7944-7952)', () => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: hasAbility('ABILITY_ICE_DOWNFALL') }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.queuedExtraAttacks).toEqual([queueEntry('ABILITY_ICE_DOWNFALL', 'MOVE_ICICLE_CRASH', 60)])
  })

  it('Snap Trap (ABILITY_SNAP_TRAP_WHEN_HIT) queues Snap Trap at power 50 (abilities.cc:6734-6742)', () => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: hasAbility('ABILITY_SNAP_TRAP_WHEN_HIT') }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.queuedExtraAttacks).toEqual([queueEntry('ABILITY_SNAP_TRAP_WHEN_HIT', 'MOVE_SNAP_TRAP', 50)])
  })

  const counterattackers = ['ABILITY_COLD_REBOUND', 'ABILITY_ICE_DOWNFALL', 'ABILITY_SNAP_TRAP_WHEN_HIT']

  it('queues nothing without contact, without damage, from a sleeping or frozen holder, after the holder already used an out-of-turn move, or when the attacker has fainted', () => {
    for (const id of counterattackers) {
      const noContact = battle([{}, { abilities: hasAbility(id) }], countingRng())
      dispatch(noContact, 'MOVE_ARCHER_SHOT')
      expect(noContact.queuedExtraAttacks, `${id} non-contact`).toEqual([])

      const noDamage = battle([{}, { abilities: hasAbility(id) }], countingRng())
      dispatch(noDamage, 'MOVE_TACKLE', 0)
      expect(noDamage.queuedExtraAttacks, `${id} no damage`).toEqual([])

      const asleep = battle([{}, { abilities: hasAbility(id), status1: STATUS1_SLEEP }], countingRng())
      dispatch(asleep, 'MOVE_TACKLE')
      expect(asleep.queuedExtraAttacks, `${id} asleep`).toEqual([])

      const frozen = battle([{}, { abilities: hasAbility(id), status1: STATUS1_FREEZE }], countingRng())
      dispatch(frozen, 'MOVE_TACKLE')
      expect(frozen.queuedExtraAttacks, `${id} frozen`).toEqual([])

      const dancerUsed = battle([{}, { abilities: hasAbility(id) }], countingRng())
      dancerUsed.battlers[1]!.turn.dancerUsedMove = true
      dispatch(dancerUsed, 'MOVE_TACKLE')
      expect(dancerUsed.queuedExtraAttacks, `${id} dancerUsedMove`).toEqual([])

      const attackerDead = battle([{ hp: 0 }, { abilities: hasAbility(id) }], countingRng())
      dispatch(attackerDead, 'MOVE_TACKLE')
      expect(attackerDead.queuedExtraAttacks, `${id} attacker fainted`).toEqual([])

      const holderDead = battle([{}, { hp: 0, abilities: hasAbility(id) }], countingRng())
      dispatch(holderDead, 'MOVE_TACKLE')
      expect(holderDead.queuedExtraAttacks, `${id} holder fainted`).toEqual([])
    }
  })

  it('queues only one out-of-turn move per turn for a holder with two such abilities (dancerUsedMove is set by the first)', () => {
    const s = battle([{}, { abilities: { ability: 'ABILITY_COLD_REBOUND', innates: ['ABILITY_ICE_DOWNFALL', null, null] } }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.queuedExtraAttacks).toHaveLength(1)
  })

  it('Cold Rebound end to end: the queued Icy Wind runs after the attacker\'s action, hitting the attacker for the resolver\'s damage', () => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: hasAbility('ABILITY_COLD_REBOUND'), moves: slot('MOVE_TACKLE'), pp: pps }], countingRng())
    const seen: { attacker: number; moveId: string; movePower: number | undefined }[] = []
    const resolver: DamageResolver = {
      resolve: (state, attackerId, _targetId, action) => {
        seen.push({ attacker: attackerId, moveId: action.chosenMove!.id, movePower: state.currentExtraAttack?.movePower })
        return { targetDamage: 20, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }
      },
    }
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], testDeps(resolver))
    expect(seen).toEqual([
      { attacker: 0, moveId: 'MOVE_TACKLE', movePower: undefined },
      { attacker: 1, moveId: 'MOVE_ICY_WIND', movePower: 0 },
    ])
    expect(s.battlers[1]?.mon.hp).toBe(80)
    expect(s.battlers[0]?.mon.hp).toBe(80)
  })

  it('Ice Downfall end to end: the queued Icicle Crash reaches the damage resolver with movePower 60 in the current extra attack', () => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: hasAbility('ABILITY_ICE_DOWNFALL'), moves: slot('MOVE_TACKLE'), pp: pps }], countingRng())
    const seen: { attacker: number; moveId: string; movePower: number | undefined }[] = []
    const resolver: DamageResolver = {
      resolve: (state, attackerId, _targetId, action) => {
        seen.push({ attacker: attackerId, moveId: action.chosenMove!.id, movePower: state.currentExtraAttack?.movePower })
        return { targetDamage: 20, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }
      },
    }
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], testDeps(resolver))
    expect(seen).toEqual([
      { attacker: 0, moveId: 'MOVE_TACKLE', movePower: undefined },
      { attacker: 1, moveId: 'MOVE_ICICLE_CRASH', movePower: 60 },
    ])
    expect(s.battlers[0]?.mon.hp).toBe(80)
  })
})

describe('Cycle 88a - Supersweet Syrup (src/abilities.cc:8957-8972)', () => {
  const ability = hasAbility('ABILITY_SUPERSWEET_SYRUP')

  it('embargoes an item-holding attacker on contact, with a 2-turn timer', () => {
    const s = battle([{ itemId: 'ITEM_EVIOLITE' }, { abilities: ability }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(hasFlag(s.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(true)
    expect(s.battlers[0]?.volatiles.embargoTimer).toBe(2)

    const e2e = battle([{ itemId: 'ITEM_EVIOLITE', moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: ability }], countingRng())
    turn(e2e, 'MOVE_TACKLE')
    expect(hasFlag(e2e.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(true)
  })

  it('does nothing without contact, without an attacker item, with an existing Embargo, or without damage', () => {
    const noContact = battle([{ itemId: 'ITEM_EVIOLITE' }, { abilities: ability }], countingRng())
    dispatch(noContact, 'MOVE_ARCHER_SHOT')
    expect(hasFlag(noContact.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(false)

    const noItem = battle([{}, { abilities: ability }], countingRng())
    dispatch(noItem, 'MOVE_TACKLE')
    expect(hasFlag(noItem.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(false)

    const already = battle([{ itemId: 'ITEM_EVIOLITE' }, { abilities: ability }], countingRng())
    already.battlers[0]!.statuses3 |= STATUS3_EMBARGO
    already.battlers[0]!.volatiles.embargoTimer = 5
    dispatch(already, 'MOVE_TACKLE')
    expect(already.battlers[0]?.volatiles.embargoTimer).toBe(5)

    const noDamage = battle([{ itemId: 'ITEM_EVIOLITE' }, { abilities: ability }], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(hasFlag(noDamage.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(false)

    const dead = battle([{ hp: 0, itemId: 'ITEM_EVIOLITE' }, { abilities: ability }], countingRng())
    dispatch(dead, 'MOVE_TACKLE')
    expect(hasFlag(dead.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(false)
  })
})

describe('Cycle 88a - Drop Blocks (src/abilities.cc:10996-11004, BattleScript_DefenderSetsSpikeLayer_Scrapyard battle_scripts_1.s:9390-9398)', () => {
  const ability = hasAbility('ABILITY_DROP_BLOCKS')

  it('adds a Spikes layer to the attacker\'s side on ANY damaging hit (no contact needed), up to 3', () => {
    const s = battle([{}, { abilities: ability }], countingRng())
    dispatch(s, 'MOVE_ARCHER_SHOT')
    expect(s.sides[0].timers.spikesAmount).toBe(1)
    expect(hasFlag(s.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(s.sides[1].timers.spikesAmount).toBe(0)

    dispatch(s, 'MOVE_TACKLE')
    dispatch(s, 'MOVE_TACKLE')
    expect(s.sides[0].timers.spikesAmount).toBe(3)
    dispatch(s, 'MOVE_TACKLE')
    expect(s.sides[0].timers.spikesAmount).toBe(3)
  })

  it('does nothing when the move dealt no damage', () => {
    const s = battle([{}, { abilities: ability }], countingRng())
    dispatch(s, 'MOVE_TACKLE', 0)
    expect(s.sides[0].timers.spikesAmount).toBe(0)
    expect(hasFlag(s.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(false)
  })

  it('end to end through a turn', () => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: ability }], countingRng())
    turn(s, 'MOVE_TACKLE')
    expect(s.sides[0].timers.spikesAmount).toBe(1)
  })
})

describe('Cycle 88a - Loose Thorns (src/abilities.cc:11042-11051, BattleScript_DefenderSetsCreepingThorns battle_scripts_1.s:9439-9447)', () => {
  const ability = hasAbility('ABILITY_LOOSE_THORNS')
  const TYPE_ROCK = 5
  const TYPE_GRASS = 12

  it('sets Creeping Thorns (the Stealth Rock slot, Grass type) on the attacker\'s side after a contact hit', () => {
    const s = battle([{}, { abilities: ability }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(hasFlag(s.sides[0].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
    expect(s.sides[0].timers.stealthRockType).toBe(TYPE_GRASS)
    expect(hasFlag(s.sides[1].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
  })

  it('does nothing when the slot is already filled, without contact, or without damage', () => {
    const filled = battle([{}, { abilities: ability }], countingRng())
    filled.sides[0].statuses |= SIDE_STATUS_STEALTH_ROCK
    filled.sides[0].timers.stealthRockType = TYPE_ROCK
    dispatch(filled, 'MOVE_TACKLE')
    expect(filled.sides[0].timers.stealthRockType).toBe(TYPE_ROCK)

    const noContact = battle([{}, { abilities: ability }], countingRng())
    dispatch(noContact, 'MOVE_ARCHER_SHOT')
    expect(hasFlag(noContact.sides[0].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)

    const noDamage = battle([{}, { abilities: ability }], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(hasFlag(noDamage.sides[0].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
  })
})

describe('Cycle 88a - Voodoo Power (src/abilities.cc:6813-6823)', () => {
  const ability = hasAbility('ABILITY_VOODOO_POWER')
  // roll 0 = accuracy (hits); roll 1 = Voodoo Power's Random() % 100 < 30
  const bleeds = (rolls: number[], attacker: Spec = {}, moveId = 'MOVE_SUNSTRIKE', damage = 20) => {
    const s = battle([{ moves: slot(moveId), pp: pps, ...attacker }, { abilities: ability }], scriptedRng(rolls))
    turn(s, moveId, damage)
    return s.battlers[0]!.mon.status1
  }

  it('bleeds the attacker 30% of the time on a special hit: roll 29 procs, roll 30 does not', () => {
    expect(bleeds([0, 29])).toBe(STATUS1_BLEED)
    expect(bleeds([0, 30])).toBe(0)
  })

  it('does nothing for a physical move', () => {
    expect(bleeds([0, 0], {}, 'MOVE_TACKLE')).toBe(0)
  })

  it('does nothing when the attacker already has a status, is Rock or Ghost (CanBleed), or the move dealt no damage', () => {
    expect(bleeds([0, 0], { status1: STATUS1_BURN })).toBe(STATUS1_BURN)
    expect(bleeds([0, 0], { types: ['ROCK', 'MYSTERY', 'MYSTERY'] })).toBe(0)
    expect(bleeds([0, 0], { types: ['GHOST', 'MYSTERY', 'MYSTERY'] })).toBe(0)
    expect(bleeds([0, 0], {}, 'MOVE_SUNSTRIKE', 0)).toBe(0)
  })

  it('does not roll at all when the move is physical or the attacker cannot bleed (the roll is the last CHECK)', () => {
    const physicalRng = scriptedRng([0, 0])
    const physical = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: ability }], physicalRng)
    turn(physical, 'MOVE_TACKLE')
    expect(physicalRng.calls).toBe(1)
    const rng = scriptedRng([0, 99])
    const rock = battle([{ moves: slot('MOVE_SUNSTRIKE'), pp: pps, types: ['ROCK', 'MYSTERY', 'MYSTERY'] }, { abilities: ability }], rng)
    turn(rock, 'MOVE_SUNSTRIKE')
    expect(rng.calls).toBe(1)
  })

  it('does nothing when the attacker has fainted', () => {
    const s = battle([{ hp: 0 }, { abilities: ability }], scriptedRng([0, 0]))
    dispatch(s, 'MOVE_SUNSTRIKE')
    expect(s.battlers[0]?.mon.status1).toBe(0)
  })
})

describe('Cycle 88a - Mummy (src/abilities.cc:2182-2195, BattleScript_MummyActivates battle_scripts_1.s:10226-10229)', () => {
  const ability = hasAbility('ABILITY_MUMMY')

  it('replaces the attacker\'s ability (slot 0) with Mummy on contact, including an empty slot', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ability }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.abilities.ability).toBe('ABILITY_MUMMY')

    const empty = battle([{}, { abilities: ability }], countingRng())
    dispatch(empty, 'MOVE_TACKLE')
    expect(empty.battlers[0]?.mon.abilities.ability).toBe('ABILITY_MUMMY')

    const e2e = battle([{ abilities: hasAbility('ABILITY_BLAZE'), moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: ability }], countingRng())
    turn(e2e, 'MOVE_TACKLE')
    expect(e2e.battlers[0]?.mon.abilities.ability).toBe('ABILITY_MUMMY')
  })

  it('leaves the attacker\'s innates alone and carries the old ability\'s state to a slot only if it matches', () => {
    const s = battle([{ abilities: { ability: 'ABILITY_BLAZE', innates: ['ABILITY_OVERGROW', null, null] } }, { abilities: ability }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.abilities).toEqual({ ability: 'ABILITY_MUMMY', innates: ['ABILITY_OVERGROW', null, null] })
  })

  it('does nothing when the attacker already has Mummy in any slot', () => {
    const s = battle([{ abilities: { ability: 'ABILITY_BLAZE', innates: [null, 'ABILITY_MUMMY', null] } }, { abilities: ability }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')
  })

  it('does nothing when the attacker\'s ability is persistent or unsuppressable (Multitype)', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_MULTITYPE') }, { abilities: ability }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.abilities.ability).toBe('ABILITY_MULTITYPE')
  })

  it('does nothing against an Ability Shield holder, without contact, without damage, or after the attacker fainted', () => {
    const shield = battle([{ abilities: hasAbility('ABILITY_BLAZE'), itemId: 'ITEM_ABILITY_SHIELD' }, { abilities: ability }], countingRng())
    dispatch(shield, 'MOVE_TACKLE')
    expect(shield.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')

    const noContact = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ability }], countingRng())
    dispatch(noContact, 'MOVE_ARCHER_SHOT')
    expect(noContact.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')

    const noDamage = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ability }], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')

    const dead = battle([{ hp: 0, abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ability }], countingRng())
    dispatch(dead, 'MOVE_TACKLE')
    expect(dead.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')
  })
})

describe('Cycle 88a - Flammable Coat (src/abilities.cc:8320-8344)', () => {
  const sloth = (overrides: Spec = {}): Spec => ({
    speciesId: 'SPECIES_LUMBERING_SLOTH',
    types: ['FIRE', 'GRASS', 'MYSTERY'],
    abilities: { ability: 'ABILITY_OVERCOAT', innates: ['ABILITY_PROTOSYNTHESIS', 'ABILITY_TOUGH_CLAWS', 'ABILITY_FLAMMABLE_COAT'] },
    ...overrides,
  })

  it('turns Lumbering Sloth into its Engulfed form on a damaging Fire hit: species, ability slots and Speed come from species.json', () => {
    const s = battle([{ moves: slot('MOVE_SUNSTRIKE'), pp: pps }, sloth({ hp: 100, maxHp: 100 })], countingRng())
    turn(s, 'MOVE_SUNSTRIKE')
    const sloth1 = s.battlers[1]!
    expect(sloth1.mon.speciesId).toBe('SPECIES_LUMBERING_SLOTH_ENGULFED')
    expect(sloth1.mon.abilities).toEqual({ ability: 'ABILITY_HYPER_AGGRESSIVE', innates: ['ABILITY_PROTOSYNTHESIS', 'ABILITY_TOUGH_CLAWS', 'ABILITY_PYROMANCY'] })
    // base Speed 61 -> 111 (species.json)
    const before = battle([{}, sloth()], countingRng()).battlers[1]!.mon.rawStats.spe
    expect(sloth1.mon.rawStats.spe).toBeGreaterThan(before)
  })

  it('does nothing for a non-Fire move, another species, a Transformed holder, or a hit that did no damage', () => {
    const nonFire = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, sloth()], countingRng())
    dispatch(nonFire, 'MOVE_TACKLE')
    expect(nonFire.battlers[1]?.mon.speciesId).toBe('SPECIES_LUMBERING_SLOTH')

    const otherSpecies = battle([{}, sloth({ speciesId: 'SPECIES_MUDKIP' })], countingRng())
    dispatch(otherSpecies, 'MOVE_SUNSTRIKE')
    expect(otherSpecies.battlers[1]?.mon.speciesId).toBe('SPECIES_MUDKIP')

    const transformed = battle([{}, sloth({ status2: STATUS2_TRANSFORMED })], countingRng())
    dispatch(transformed, 'MOVE_SUNSTRIKE')
    expect(transformed.battlers[1]?.mon.speciesId).toBe('SPECIES_LUMBERING_SLOTH')

    const noDamage = battle([{}, sloth()], countingRng())
    dispatch(noDamage, 'MOVE_SUNSTRIKE', 0)
    expect(noDamage.battlers[1]?.mon.speciesId).toBe('SPECIES_LUMBERING_SLOTH')
  })

  it('does nothing once the holder has fainted unless Flash Fire already triggered (ShouldApplyOnHitEffect(battler) || RESOURCE_FLAG_FLASH_FIRE)', () => {
    const dead = battle([{}, sloth({ hp: 0 })], countingRng())
    dispatch(dead, 'MOVE_SUNSTRIKE')
    expect(dead.battlers[1]?.mon.speciesId).toBe('SPECIES_LUMBERING_SLOTH')

    const boosted = battle([{}, sloth({ hp: 0 })], countingRng())
    boosted.battlers[1]!.volatiles.flashFire = true
    dispatch(boosted, 'MOVE_SUNSTRIKE')
    expect(boosted.battlers[1]?.mon.speciesId).toBe('SPECIES_LUMBERING_SLOTH_ENGULFED')
  })
})

describe('Cycle 88a - Chuckster hook (drained as of Cycle 98b)', () => {
  it('arms its abilityState and queues the attacker switch instead of reporting itself as not modelled', () => {
    const s = battle([{}, { abilities: hasAbility('ABILITY_CHUCKSTER') }], countingRng())
    const { unmodelled } = dispatch(s, 'MOVE_TACKLE')
    expect(unmodelled).not.toContain('move-end defender ability ABILITY_CHUCKSTER is not modelled yet')
    expect(s.queuedSwitches).toEqual([
      { ability: 'ABILITY_CHUCKSTER', setAbilityState: false, switchingBattler: 0, sourceBattler: 1 },
    ])
    expect(s.battlers[1]!.volatiles.abilityState[0]).toBe(1)
  })
})
