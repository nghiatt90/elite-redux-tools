/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { MoveBehaviors } from '../basePower'
import type { TypeChart } from '../typeEffectiveness'
import { STATUS1_BLEED, STATUS1_SLEEP, WEATHER_FOG_TEMPORARY, hasFlag } from './constants'

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

function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 30 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
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

function battle(specs: BattlerSpec[], rng: RandomSource, playerParty?: SimPartyMon[], opponentParty?: SimPartyMon[]): BattleState {
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
    playerParty,
    opponentParty,
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

const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }

type ResolveCall = {
  attacker: number
  target: number
  move: string
  extra: boolean
  movePower: number | undefined
  movePos: number | undefined
}

/** Fixed damage per hit, recording who hit whom and whether it was a queued
 * extra attack (state.processingExtraAttacks) -- the only way to observe which
 * attack ran FIRST. */
function recordingDamage(amount = 20): DamageResolver & { calls: ResolveCall[] } {
  const calls: ResolveCall[] = []
  return {
    calls,
    resolve(state, attackerId, targetId, action) {
      calls.push({
        attacker: attackerId,
        target: targetId,
        move: action.chosenMove?.id ?? '',
        extra: state.processingExtraAttacks,
        movePower: state.currentExtraAttack?.movePower,
        movePos: state.currentExtraAttack?.movePos,
      })
      return { targetDamage: amount, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }
    },
  }
}

function testDeps(damage: DamageResolver): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
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
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })
const extraCalls = (calls: ResolveCall[]) => calls.filter((c) => c.extra)

describe('Cycle 95b - Tag (src/abilities.cc:10338-10351)', () => {
  const TAG = 'ABILITY_TAG'

  it('a foe switching out is hit by a 20-power Pursuit FIRST; the holder still acts afterwards', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    // battler 1 switches to party slot 1 (hp 77); slot 0 keeps the outgoing hp.
    const state = battle(
      [{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(TAG) }, { spe: 50 }],
      rng,
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 77 })],
    )
    state.battlers[1]!.monToSwitchIntoId = 1

    const out = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), switchAction], testDeps(dmg))

    // SWITCH actions are grouped first, so the switch slot is where the preempt runs.
    // Pursuit (power overridden to 20) hits the OUTGOING mon, then the switch
    // happens, then Tag's holder uses its own chosen Tackle on the incoming mon.
    expect(extraCalls(dmg.calls)).toEqual([
      { attacker: 0, target: 1, move: 'MOVE_PURSUIT', extra: true, movePower: 20, movePos: undefined },
    ])
    expect(dmg.calls.map((c) => c.move)).toEqual(['MOVE_PURSUIT', 'MOVE_TACKLE'])
    expect(state.sides[1].party[0]!.hp).toBe(80) // 100 - 20, saved before the switch
    expect(state.battlers[1]!.mon.hp).toBe(57) // incoming 77 - 20
    expect(state.queuedExtraAttacks).toEqual([])
    // Tag's own action was NOT consumed: the holder is battler 0 in slot 1.
    expect(out.actions.map((a) => `${a.battlerId}:${a.action}`)).toEqual(['0:USE_MOVE', '1:SWITCH', '0:USE_MOVE'])
  })

  it('does not queue anything when the foe uses a move instead of switching', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    const state = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(TAG) }, { spe: 50 }], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), useMove(0, move('MOVE_TACKLE'))], testDeps(dmg))
    expect(extraCalls(dmg.calls)).toEqual([])
    expect(dmg.calls.map((c) => c.move)).toEqual(['MOVE_TACKLE', 'MOVE_TACKLE'])
  })

  it('does not queue anything when the holder has fainted', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    const state = battle(
      [{ hp: 0, moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(TAG) }, { spe: 50 }],
      rng,
      [partyMon({ hp: 0 }), partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 100 })],
    )
    state.battlers[1]!.monToSwitchIntoId = 1
    executeTurn(state, [null, switchAction], testDeps(dmg))
    expect(extraCalls(dmg.calls)).toEqual([])
  })
})

describe('Cycle 95b - Dreamcatcher / Dreamscape (src/abilities.cc:4021-4024, :10403)', () => {
  const DREAMCATCHER = 'ABILITY_DREAMCATCHER'
  const DREAMSCAPE = 'ABILITY_DREAMSCAPE'

  it('a SLEEPING foe switching out is hit by the holder’s chosen move first; movePos set, PP deducted once, holder slot consumed', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    // The chosen move sits in slot 1, so chosenMovePositions + 1 = 2 is observable.
    const state = battle(
      [{ moves: [null, 'MOVE_HORN_ATTACK', null, null], pp: [0, 10, 0, 0] as SimBattleMon['pp'], abilities: hasAbility(DREAMCATCHER) }, { spe: 50, status1: STATUS1_SLEEP }],
      rng,
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 77 })],
    )
    state.battlers[1]!.monToSwitchIntoId = 1

    const out = executeTurn(state, [useMove(1, move('MOVE_HORN_ATTACK')), switchAction], testDeps(dmg))

    expect(extraCalls(dmg.calls)).toEqual([
      { attacker: 0, target: 1, move: 'MOVE_HORN_ATTACK', extra: true, movePower: undefined, movePos: 2 },
    ])
    // The move ran exactly once: the holder's own slot is B_ACTION_FINISHED.
    expect(dmg.calls).toHaveLength(1)
    expect(out.actions.map((a) => `${a.battlerId}:${a.action}`)).toEqual(['0:USE_MOVE', '1:SWITCH'])
    // PP deducted once, from the slot the chosen move lives in.
    expect(state.battlers[0]!.mon.pp[1]).toBe(9)
    // The outgoing sleeping mon took the hit; the replacement entered afterwards.
    expect(state.sides[1].party[0]!.hp).toBe(80)
    expect(state.battlers[1]!.mon.hp).toBe(77)
  })

  it('Dreamscape shares Dreamcatcher’s hook', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    const state = battle(
      [{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(DREAMSCAPE) }, { spe: 50, status1: STATUS1_SLEEP }],
      rng,
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 77 })],
    )
    state.battlers[1]!.monToSwitchIntoId = 1
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), switchAction], testDeps(dmg))
    expect(extraCalls(dmg.calls)).toEqual([
      { attacker: 0, target: 1, move: 'MOVE_TACKLE', extra: true, movePower: undefined, movePos: 1 },
    ])
  })

  it('a Comatose foe counts as asleep (IsComatose, src/battle_util.c:8995-8998)', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    const state = battle(
      [{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(DREAMCATCHER) }, { spe: 50, abilities: hasAbility('ABILITY_COMATOSE') }],
      rng,
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 77 })],
    )
    state.battlers[1]!.monToSwitchIntoId = 1
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), switchAction], testDeps(dmg))
    expect(extraCalls(dmg.calls)).toHaveLength(1)
    expect(extraCalls(dmg.calls)[0]!.move).toBe('MOVE_TACKLE')
  })

  it('an AWAKE foe does not trigger it', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    const state = battle(
      [{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(DREAMCATCHER) }, { spe: 50 }],
      rng,
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 77 })],
    )
    state.battlers[1]!.monToSwitchIntoId = 1
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), switchAction], testDeps(dmg))
    expect(extraCalls(dmg.calls)).toEqual([])
    // The holder's own move still runs, AFTER the switch, against the incoming mon.
    expect(dmg.calls).toEqual([
      { attacker: 0, target: 1, move: 'MOVE_TACKLE', extra: false, movePower: undefined, movePos: undefined },
    ])
    expect(state.battlers[1]!.mon.hp).toBe(57)
  })

  it('does not trigger when the holder’s move does not target the switching battler (SELECTED check)', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    const state = battle(
      [{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(DREAMCATCHER) }, { spe: 50, status1: STATUS1_SLEEP }],
      rng,
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 77 })],
    )
    state.battlers[1]!.monToSwitchIntoId = 1
    // Targeted at the holder itself, not the sleeping switcher.
    executeTurn(state, [useMove(0, move('MOVE_TACKLE')), switchAction], testDeps(dmg))
    expect(extraCalls(dmg.calls)).toEqual([])
  })

  it('does not trigger for a RANDOM-target move (UseTurnAttackAsPursuit’s default branch)', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    const state = battle(
      [{ moves: slot('MOVE_OUTRAGE'), pp: pps, abilities: hasAbility(DREAMCATCHER) }, { spe: 50, status1: STATUS1_SLEEP }],
      rng,
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 77 })],
    )
    state.battlers[1]!.monToSwitchIntoId = 1
    executeTurn(state, [useMove(1, move('MOVE_OUTRAGE')), switchAction], testDeps(dmg))
    expect(extraCalls(dmg.calls)).toEqual([])
  })

  it('does not trigger when the foe uses a move rather than switching', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    const state = battle(
      [{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(DREAMCATCHER) }, { spe: 50, status1: STATUS1_SLEEP }],
      rng,
    )
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), useMove(0, move('MOVE_TACKLE'))], testDeps(dmg))
    expect(extraCalls(dmg.calls)).toEqual([])
  })
})

describe('Cycle 95b - Super Sniper (src/abilities.cc:9825-9832)', () => {
  const SUPER_SNIPER = 'ABILITY_SUPER_SNIPER'

  it('is UseTurnAttackAsPursuit with no sleep requirement', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    const state = battle(
      [{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(SUPER_SNIPER) }, { spe: 50 }],
      rng,
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 77 })],
    )
    state.battlers[1]!.monToSwitchIntoId = 1
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), switchAction], testDeps(dmg))
    expect(extraCalls(dmg.calls)).toEqual([
      { attacker: 0, target: 1, move: 'MOVE_TACKLE', extra: true, movePower: undefined, movePos: 1 },
    ])
    expect(dmg.calls).toHaveLength(1) // holder's slot consumed
  })
})

describe('Cycle 95b - Surprise (src/abilities.cc:10355-10374)', () => {
  const SURPRISE = 'ABILITY_SURPRISE'

  function surpriseBattle(actorSpe: number, actorMove: string, actorTarget: number, fog: boolean, rng = scriptedRng([0])) {
    const dmg = recordingDamage(20)
    const state = battle(
      [{ spe: 50, moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility(SURPRISE) }, { spe: actorSpe }],
      rng,
    )
    if (fog) state.field.weather = WEATHER_FOG_TEMPORARY
    const actor = state.battlers[1]!
    const out = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), useMove(actorTarget, move(actorMove))], testDeps(dmg))
    return { dmg, state, actor, out }
  }

  it('in fog, a NON-ZERO-priority move is hit by Astonish first', () => {
    // battler 1 is the faster actor (slot 0): the preempt runs on the FIRST action of the turn.
    const rng = scriptedRng([0])
    const { dmg, out } = surpriseBattle(200, 'MOVE_QUICK_ATTACK', 0, true, rng)
    expect(extraCalls(dmg.calls)).toEqual([
      { attacker: 0, target: 1, move: 'MOVE_ASTONISH', extra: true, movePower: undefined, movePos: undefined },
    ])
    // Astonish ran before Quick Attack ... and its 100% flinch stopped it.
    const actorOutcome = out.actions.find((a) => a.battlerId === 1 && a.action === 'USE_MOVE')!
    expect(actorOutcome.cancelledBy).toBe('FLINCH')
    expect(dmg.calls.every((c) => c.target === 1)).toBe(true) // Quick Attack never reached the resolver
    // Draws: Astonish accuracy (1), its 100% flinch roll (2), then the holder's own Tackle accuracy (3).
    // The cancelled Quick Attack draws nothing.
    expect(rng.calls).toBe(3)
  })

  it('does not trigger without fog', () => {
    const { dmg } = surpriseBattle(200, 'MOVE_QUICK_ATTACK', 0, false)
    expect(extraCalls(dmg.calls)).toEqual([])
    expect(dmg.calls.map((c) => c.move)).toEqual(['MOVE_QUICK_ATTACK', 'MOVE_TACKLE'])
  })

  it('does not trigger for a priority-0 move', () => {
    const { dmg } = surpriseBattle(200, 'MOVE_TACKLE', 0, true)
    expect(extraCalls(dmg.calls)).toEqual([])
    expect(dmg.calls.map((c) => c.move)).toEqual(['MOVE_TACKLE', 'MOVE_TACKLE'])
  })

  it('does not trigger for a SELECTED target on the actor’s own side', () => {
    // Quick Attack aimed at the actor itself: side(target)=1 != side(holder)=0.
    const { dmg } = surpriseBattle(200, 'MOVE_QUICK_ATTACK', 1, true)
    expect(extraCalls(dmg.calls)).toEqual([])
  })
})

describe('Cycle 95b - draw order', () => {
  it('accuracy roll, then the move’s secondary roll, then the ability’s roll', () => {
    // Super Sniper holder with Impaler as an innate. The preempt reruns its
    // chosen Horn Attack (EFFECT_BLEED_HIT, 10%, accuracy 100) as an extra attack:
    //   1. accuracy (always drawn), 2. the 10% bleed roll, 3. Impaler's 30% roll
    //      (moveEnd dispatch, after applySecondaryMoveEffects).
    // Rolls [0, 50, 10]: hit, bleed fails, Impaler applies the bleed.
    // The switcher's replacement (spe 30) differs from battler 0 (spe 100), so
    // the end-of-turn speed sort never draws a tie-break.
    const rng = scriptedRng([0, 50, 10])
    const dmg = recordingDamage(20)
    const state = battle(
      [
        {
          moves: slot('MOVE_HORN_ATTACK'),
          pp: pps,
          abilities: { ability: 'ABILITY_SUPER_SNIPER', innates: ['ABILITY_IMPALER', null, null] as [string, null, null] },
        },
        { spe: 50 },
      ],
      rng,
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 77 })],
    )
    state.battlers[1]!.monToSwitchIntoId = 1
    executeTurn(state, [useMove(1, move('MOVE_HORN_ATTACK')), switchAction], testDeps(dmg))

    expect(extraCalls(dmg.calls)).toHaveLength(1)
    expect(rng.calls).toBe(3)
    expect(hasFlag(state.sides[1].party[0]!.status1, STATUS1_BLEED)).toBe(true)
  })
})

describe('Cycle 95b - queue pop is LIFO (battle_util.c:831-833)', () => {
  const TAG = 'ABILITY_TAG'

  it('two holders on a doubles-sized state: the LAST queued entry is popped first', () => {
    const rng = scriptedRng([0])
    const dmg = recordingDamage(20)
    // battler 0 (player) switches; battlers 1 and 3 (opponent side) both hold Tag.
    // TryPreemptiveActions pushes 1 then 3 and pops the LAST -- so 3 hits first.
    const state = battle(
      [{ moves: slot('MOVE_TACKLE'), pp: pps }, { spe: 50, abilities: hasAbility(TAG) }, { spe: 60 }, { spe: 40, abilities: hasAbility(TAG) }],
      rng,
      [partyMon({ hp: 100 }), partyMon({ hp: 100 })],
      [partyMon({ hp: 100 }), partyMon({ hp: 100 })],
    )
    state.battlers[0]!.monToSwitchIntoId = 1

    executeTurn(state, [switchAction, null, null, null], testDeps(dmg))

    const extras = extraCalls(dmg.calls)
    expect(extras.map((c) => c.attacker)).toEqual([3, 1])
    expect(extras.every((c) => c.move === 'MOVE_PURSUIT' && c.movePower === 20 && c.target === 0)).toBe(true)
    // Both pursuits land on the mon that was switching OUT (20 damage each):
    // TryPerformExtraAction empties the queue before HandleAction_TryFinish
    // restores the parked SWITCH (battle_util.c:751-783), not after it.
    expect(state.sides[0].party[0]!.hp).toBe(60)
    expect(state.sides[0].party[1]!.hp).toBe(100)
  })
})
