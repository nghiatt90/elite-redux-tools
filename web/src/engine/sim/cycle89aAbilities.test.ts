/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'
import { applySwitchInAbilities } from './switchInAbility'
import { runEndTurnEffects } from './endTurn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  MOVE_UNSET,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS2_WRAPPED,
  STATUS3_HEAL_BLOCK,
  WEATHER_FOG_TEMPORARY,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
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

interface Spec {
  spe?: number
  hp?: number
  maxHp?: number
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
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? s.maxHp ?? 100,
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

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[idx++] ?? 0
    },
  }
  return r
}

const countingRng = () => scriptedRng([])

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

function fixedDamage(amount: number): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function testDeps(damage: DamageResolver = fixedDamage(20)): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })
const innate = (id: string, index: 0 | 1 | 2 = 0) => {
  const innates: [string | null, string | null, string | null] = [null, null, null]
  innates[index] = id
  return { ability: null, innates }
}

/** A turn where nobody acts, so only the end-turn ladder runs. */
function quietTurn(state: BattleState): TurnOutcome {
  return executeTurn(state, [null, null], testDeps())
}

/** battler 0 uses `moveId` on battler 1, battler 1 does nothing. */
function turn(state: BattleState, moveId: string, damage = 20): TurnOutcome {
  return executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(damage)))
}

describe('Cycle 89a - Acid Reflux (src/abilities.cc:12253-12258)', () => {
  it('moves the live ability state into the once-per-turn counter and clears it', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_ACID_REFLUX') }, {}], countingRng())
    s.battlers[0]!.volatiles.abilityState[0] = 1
    quietTurn(s)
    expect(s.battlers[0]!.turn.turnAbilityTriggers[0]).toBe(1)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('writes the slot the ability sits in (innate 2 = slot 2)', () => {
    const s = battle([{ abilities: innate('ABILITY_ACID_REFLUX', 1) }, {}], countingRng())
    s.battlers[0]!.volatiles.abilityState[2] = 1
    quietTurn(s)
    expect(s.battlers[0]!.turn.turnAbilityTriggers[2]).toBe(1)
    expect(s.battlers[0]!.volatiles.abilityState[2]).toBe(0)
  })

  it('copies a zero state as zero (the counter is overwritten, not incremented)', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_ACID_REFLUX') }, {}], countingRng())
    s.battlers[0]!.turn.turnAbilityTriggers[0] = 1
    quietTurn(s)
    expect(s.battlers[0]!.turn.turnAbilityTriggers[0]).toBe(0)
  })
})

describe('Cycle 89a - Blood Price (src/abilities.cc:6783-6794, BattleScript_AbilitySelfDamage battle_scripts_1.s:9597-9604)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ maxHp: 160, abilities: hasAbility('ABILITY_BLOOD_PRICE'), moves: slot('MOVE_TACKLE', 'MOVE_HARDEN'), pp: pps, ...extra })

  it('costs maxHP / 10 at end of turn after a damaging move: 160 / 10 = 16', () => {
    const s = battle([holder(), {}], countingRng())
    turn(s, 'MOVE_TACKLE', 20)
    expect(s.battlers[1]!.mon.hp).toBe(80)
    expect(s.battlers[0]!.mon.hp).toBe(144)
  })

  it('costs nothing after a status move (IS_MOVE_STATUS)', () => {
    const s = battle([holder(), {}], countingRng())
    turn(s, 'MOVE_HARDEN')
    expect(s.battlers[0]!.mon.hp).toBe(160)
  })

  it('costs nothing before any move has been used (gLastResultingMoves == 0)', () => {
    const s = battle([holder(), {}], countingRng())
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(160)
  })

  it('costs nothing when the last move failed (gLastResultingMoves == 0xFFFF)', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.lastResultingMove = MOVE_UNSET
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(160)
  })

  it('keeps charging on later turns, because gLastResultingMoves is not cleared between turns', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.lastResultingMove = 'MOVE_TACKLE'
    quietTurn(s)
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(128)
  })

  it('is blocked by Magic Guard', () => {
    const s = battle([holder({ abilities: { ability: 'ABILITY_BLOOD_PRICE', innates: ['ABILITY_MAGIC_GUARD', null, null] } }), {}], countingRng())
    turn(s, 'MOVE_TACKLE')
    expect(s.battlers[0]!.mon.hp).toBe(160)
  })

  it('takes at least 1 (maxHP 5 / 10 = 0 -> 1)', () => {
    const s = battle([holder({ maxHp: 5 }), {}], countingRng())
    s.battlers[0]!.lastResultingMove = 'MOVE_TACKLE'
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(4)
  })

  it('faints the holder when the cost is more than its hp left', () => {
    const s = battle([holder({ hp: 10 }), {}], countingRng())
    s.battlers[0]!.lastResultingMove = 'MOVE_TACKLE'
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(0)
  })

  it('reports a move whose data is unavailable instead of guessing its category', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.lastResultingMove = 'MOVE_NOT_IN_THE_DATA'
    const out = quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(160)
    expect(out.endTurnUnmodelled.join('\n')).toContain("Blood Price's IS_MOVE_STATUS(MOVE_NOT_IN_THE_DATA)")
  })
})

describe('Cycle 89a - Chokehold / Tentalock / Serpent Bind (Impl<ABILITY_SERPENT_BIND>.onEndTurn, src/abilities.cc:12008-12024)', () => {
  /** battler 1 is wrapped by battler 0 (STATUS2_WRAPPED, wrappedBy[1] = 0). */
  function wrapped(by: string, extraFoe: Partial<Spec> = {}): BattleState {
    const s = battle([{ abilities: hasAbility(by) }, extraFoe], countingRng())
    s.battlers[1]!.mon.status2 |= STATUS2_WRAPPED
    s.battlers[1]!.volatiles.wrapTurns = 3
    s.wrappedBy[1] = 0
    return s
  }

  for (const id of ['ABILITY_CHOKEHOLD', 'ABILITY_TENTALOCK', 'ABILITY_SERPENT_BIND']) {
    it(`${id} lowers the wrapped battler's Speed by 1 each end of turn`, () => {
      const s = wrapped(id)
      quietTurn(s)
      expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(5)
      quietTurn(s)
      expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(4)
    })
  }

  it('does nothing when the foe is not wrapped', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_CHOKEHOLD') }, {}], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(6)
  })

  it('does nothing when the wrap belongs to someone else (wrappedBy != holder)', () => {
    const s = wrapped('ABILITY_CHOKEHOLD')
    s.wrappedBy[1] = 1
    quietTurn(s)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(6)
  })

  it('does nothing when Speed is already at -6 (StatLowerableOrMirrorArmor)', () => {
    const s = wrapped('ABILITY_CHOKEHOLD')
    s.battlers[1]!.mon.statStages[STAT_SPEED] = 0
    quietTurn(s)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(0)
  })

  it('a Contrary foe is raised instead (ChangeStatBuffs flips the sign): 6 -> 7', () => {
    const s = wrapped('ABILITY_CHOKEHOLD', { abilities: hasAbility('ABILITY_CONTRARY') })
    quietTurn(s)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(7)
  })
})

describe('Cycle 89a - Flame Coat (src/abilities.cc:9480-9495, BattleScript_FireCoatDamage battle_scripts_1.s:8645)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ maxHp: 160, abilities: hasAbility('ABILITY_FLAME_COAT'), ...extra })

  it('hurts every non-Fire battler for maxHP / 8, holder included: 160 -> 140 and 80 -> 70', () => {
    const s = battle([holder(), { maxHp: 80 }], countingRng())
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(140)
    expect(s.battlers[1]!.mon.hp).toBe(70)
  })

  it('spares Fire types, including a Fire-type holder', () => {
    const s = battle([holder({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] }), { maxHp: 80 }], countingRng())
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(160)
    expect(s.battlers[1]!.mon.hp).toBe(70)
  })

  it('spares a Flare Boost battler and a Magic Guard battler', () => {
    const flare = battle([holder(), { maxHp: 80, abilities: hasAbility('ABILITY_FLARE_BOOST') }], countingRng())
    quietTurn(flare)
    expect(flare.battlers[1]!.mon.hp).toBe(80)
    const guarded = battle([holder(), { maxHp: 80, abilities: hasAbility('ABILITY_MAGIC_GUARD') }], countingRng())
    quietTurn(guarded)
    expect(guarded.battlers[1]!.mon.hp).toBe(80)
  })

  it('runs once when both battlers hold it (only the lowest-numbered holder acts): 160 -> 140, not 120', () => {
    const s = battle([holder(), holder()], countingRng())
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(140)
    expect(s.battlers[1]!.mon.hp).toBe(140)
  })

  it('is capped at the hp left, and faints the battler', () => {
    const s = battle([holder(), { maxHp: 80, hp: 3 }], countingRng())
    const out = quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(0)
    expect(out.endTurn).toContainEqual({ battlerId: 1, effect: 'ABILITY', hpChange: -3, fainted: true })
  })

  it('does nothing while the holder is fainted', () => {
    const s = battle([holder({ hp: 0 }), { maxHp: 80 }], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(80)
  })
})

describe('Cycle 89a - Funeral Pyre (src/abilities.cc:8260-8274, BattleScript_FuneralPyreDamage battle_scripts_1.s:8629)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ maxHp: 160, abilities: hasAbility('ABILITY_FUNERAL_PYRE'), ...extra })

  it('hurts every battler that is neither Ghost nor Dark for maxHP / 4: 160 -> 120 and 80 -> 60', () => {
    const s = battle([holder(), { maxHp: 80 }], countingRng())
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(120)
    expect(s.battlers[1]!.mon.hp).toBe(60)
  })

  it('spares Ghost and Dark types, and Magic Guard', () => {
    const ghost = battle([holder(), { maxHp: 80, types: ['GHOST', 'MYSTERY', 'MYSTERY'] }], countingRng())
    quietTurn(ghost)
    expect(ghost.battlers[1]!.mon.hp).toBe(80)
    const dark = battle([holder(), { maxHp: 80, types: ['NORMAL', 'DARK', 'MYSTERY'] }], countingRng())
    quietTurn(dark)
    expect(dark.battlers[1]!.mon.hp).toBe(80)
    const guarded = battle([holder(), { maxHp: 80, abilities: hasAbility('ABILITY_MAGIC_GUARD') }], countingRng())
    quietTurn(guarded)
    expect(guarded.battlers[1]!.mon.hp).toBe(80)
  })

  it('does not spare a Fire type or a Flare Boost battler (those are Flame Coat\'s exemptions)', () => {
    const s = battle([holder(), { maxHp: 80, types: ['FIRE', 'MYSTERY', 'MYSTERY'], abilities: hasAbility('ABILITY_FLARE_BOOST') }], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(60)
  })

  it('takes at least 1: maxHP 3 / 4 = 0 -> 1', () => {
    const s = battle([holder(), { maxHp: 3 }], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(2)
  })
})

describe('Cycle 89a - Flame Coat / Funeral Pyre onEntry (SwitchInAnnounce only, abilities.cc:9476-9479 / :8255-8259)', () => {
  it('is no longer reported as an unrun switch-in hook', () => {
    for (const id of ['ABILITY_FLAME_COAT', 'ABILITY_FUNERAL_PYRE']) {
      const s = battle([{ abilities: hasAbility(id) }, {}], countingRng())
      const unmodelled: string[] = []
      applySwitchInAbilities(s, 0, { grounding: GROUNDING, dataContext: DATA_CONTEXT, statStageRatios: RATIOS } as Parameters<typeof applySwitchInAbilities>[2], unmodelled)
      expect(unmodelled).toEqual([])
    }
  })
})

describe('Cycle 89a - Home Run (src/abilities.cc:11927-11931)', () => {
  it('clears its ability state at end of turn', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_HOME_RUN') }, {}], countingRng())
    s.battlers[0]!.volatiles.abilityState[0] = 1
    quietTurn(s)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('clears the state of the slot it sits in, and leaves other slots alone', () => {
    const s = battle([{ abilities: { ability: 'ABILITY_PICKUP', innates: [null, null, 'ABILITY_HOME_RUN'] } }, {}], countingRng())
    s.battlers[0]!.volatiles.abilityState[3] = 1
    s.battlers[0]!.volatiles.abilityState[0] = 5
    quietTurn(s)
    expect(s.battlers[0]!.volatiles.abilityState[3]).toBe(0)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(5)
  })
})

describe('Cycle 89a - Honey Gather (src/abilities.cc:1813-1822)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ abilities: hasAbility('ABILITY_HONEY_GATHER'), ...extra })

  it('finds Honey on an odd roll when holding nothing', () => {
    const rng = scriptedRng([7])
    const s = battle([holder(), {}], rng)
    quietTurn(s)
    expect(s.battlers[0]!.mon.itemId).toBe('ITEM_HONEY')
    expect(rng.calls).toBe(1)
  })

  it('finds nothing on an even roll', () => {
    const rng = scriptedRng([8])
    const s = battle([holder(), {}], rng)
    quietTurn(s)
    expect(s.battlers[0]!.mon.itemId).toBeNull()
    expect(rng.calls).toBe(1)
  })

  it('does not roll, and keeps its item, when already holding one (CHECK_NOT precedes the roll)', () => {
    const rng = scriptedRng([7])
    const s = battle([holder({ itemId: 'ITEM_ORAN_BERRY' }), {}], rng)
    quietTurn(s)
    expect(s.battlers[0]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
    expect(rng.calls).toBe(0)
  })

  it('resets Unburden, because UpdateBattlerItem sees the battler go from no item to an item', () => {
    const rng = scriptedRng([1])
    const s = battle([{ abilities: { ability: 'ABILITY_HONEY_GATHER', innates: ['ABILITY_UNBURDEN', null, null] } }, {}], rng)
    s.battlers[0]!.volatiles.abilityState[1] = 1
    quietTurn(s)
    expect(s.battlers[0]!.mon.itemId).toBe('ITEM_HONEY')
    expect(s.battlers[0]!.volatiles.abilityState[1]).toBe(0)
  })
})

describe('Cycle 89a - Life Steal (src/abilities.cc:9101-9114, BattleScript_AbilityDrainsHp battle_scripts_1.s:3257-3266)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ maxHp: 100, hp: 50, abilities: hasAbility('ABILITY_LIFE_STEAL'), ...extra })
  const foe = (extra: Partial<Spec> = {}): Spec => ({ maxHp: 200, ...extra })

  it('takes maxHP / 10 from the foe and heals the holder by it: foe 200 -> 180, holder 50 -> 70', () => {
    const s = battle([holder(), foe()], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(180)
    expect(s.battlers[0]!.mon.hp).toBe(70)
  })

  it('heals only what the foe loses: capped at the foe\'s hp left (5), and the foe faints', () => {
    const s = battle([holder(), foe({ hp: 5 })], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(0)
    expect(s.battlers[0]!.mon.hp).toBe(55)
  })

  it('drains at least 1: foe maxHP 5 / 10 = 0 -> 1', () => {
    const s = battle([holder(), foe({ maxHp: 5 })], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(4)
    expect(s.battlers[0]!.mon.hp).toBe(51)
  })

  it('does not overheal past maxHP', () => {
    const s = battle([holder({ hp: 95 }), foe()], countingRng())
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(100)
    expect(s.battlers[1]!.mon.hp).toBe(180)
  })

  it('skips a Magic Guard foe entirely', () => {
    const s = battle([holder(), foe({ abilities: hasAbility('ABILITY_MAGIC_GUARD') })], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(200)
    expect(s.battlers[0]!.mon.hp).toBe(50)
  })

  it('Liquid Ooze turns the heal into damage on the holder: holder 50 -> 30', () => {
    const s = battle([holder(), foe({ abilities: hasAbility('ABILITY_LIQUID_OOZE') })], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(180)
    expect(s.battlers[0]!.mon.hp).toBe(30)
  })

  it('Heal Block on the holder stops the heal, but the foe is still hit', () => {
    const s = battle([holder(), foe()], countingRng())
    s.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(180)
    expect(s.battlers[0]!.mon.hp).toBe(50)
  })

  it('bleeding stops the heal: holder 50 - 100/16 (6) from the bleed, no drain heal', () => {
    const s = battle([holder({ status1: STATUS1_BLEED }), foe()], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(180)
    expect(s.battlers[0]!.mon.hp).toBe(44)
  })

  it('does nothing against a fainted foe', () => {
    const s = battle([holder(), foe({ hp: 0 })], countingRng())
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(50)
  })
})

describe('Cycle 89a - Soul Tap (src/abilities.cc:9959-9973)', () => {
  const holder = (): Spec => ({ maxHp: 100, hp: 50, abilities: hasAbility('ABILITY_SOUL_TAP') })

  it('drains maxHP / 10 from the foe in fog: foe 200 -> 180, holder 50 -> 70', () => {
    const s = battle([holder(), { maxHp: 200 }], countingRng())
    s.field.weather |= WEATHER_FOG_TEMPORARY
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(180)
    expect(s.battlers[0]!.mon.hp).toBe(70)
  })

  it('does nothing without fog', () => {
    const s = battle([holder(), { maxHp: 200 }], countingRng())
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(200)
    expect(s.battlers[0]!.mon.hp).toBe(50)
  })

  it('skips a Magic Guard foe', () => {
    const s = battle([holder(), { maxHp: 200, abilities: hasAbility('ABILITY_MAGIC_GUARD') }], countingRng())
    s.field.weather |= WEATHER_FOG_TEMPORARY
    quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(200)
  })
})

describe('Cycle 89a - Moody (src/abilities.cc:2053-2083, BattleScript_MoodyActivates battle_scripts_1.s:9459-9477)', () => {
  const holder = (): Spec => ({ abilities: hasAbility('ABILITY_MOODY') })
  const setStages = (s: BattleState, stages: Record<number, number>) => {
    for (const [stat, stage] of Object.entries(stages)) s.battlers[0]!.mon.statStages[Number(stat)] = stage
  }

  it('raises one stat by 2 and lowers a different one by 1; draws re-roll on HP (0) and on the raised stat', () => {
    // 6 % 6 = 0 (HP, never valid), 8 % 6 = 2 (Defense, raised), then the lower draws: 14 % 6 = 2 (just raised, excluded), 9 % 6 = 3 (Speed).
    const rng = scriptedRng([6, 8, 14, 9])
    const s = battle([holder(), {}], rng)
    quietTurn(s)
    const stages = s.battlers[0]!.mon.statStages
    expect(stages[STAT_DEF]).toBe(8)
    expect(stages[STAT_SPEED]).toBe(5)
    expect(stages[STAT_ATK]).toBe(6)
    expect(stages[STAT_SPATK]).toBe(6)
    expect(stages[STAT_SPDEF]).toBe(6)
    expect(rng.calls).toBe(4)
  })

  it('sets disableEjectPack for the round when it acts (gRoundStructs[battler].disableEjectPack)', () => {
    const s = battle([holder(), {}], scriptedRng([8, 9]))
    runEndTurnEffects(s, [0, 1], DATA_CONTEXT, { grounding: GROUNDING, statStageRatios: RATIOS })
    expect(s.battlers[0]!.round.disableEjectPack).toBe(true)
  })

  it('with every stat at +6 it cannot raise, and only lowers: 7 % 6 = 1 -> Attack 12 -> 11', () => {
    const rng = scriptedRng([7])
    const s = battle([holder(), {}], rng)
    setStages(s, { [STAT_ATK]: 12, [STAT_DEF]: 12, [STAT_SPEED]: 12, [STAT_SPATK]: 12, [STAT_SPDEF]: 12 })
    quietTurn(s)
    expect(s.battlers[0]!.mon.statStages[STAT_ATK]).toBe(11)
    expect(rng.calls).toBe(1)
  })

  it('with every stat at -6 it cannot lower, and only raises: 10 % 6 = 4 -> Sp. Atk 0 -> 2', () => {
    const rng = scriptedRng([10])
    const s = battle([holder(), {}], rng)
    setStages(s, { [STAT_ATK]: 0, [STAT_DEF]: 0, [STAT_SPEED]: 0, [STAT_SPATK]: 0, [STAT_SPDEF]: 0 })
    quietTurn(s)
    expect(s.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(2)
    expect(rng.calls).toBe(1)
  })

  it('skips a maxed stat when raising and a floored stat when lowering', () => {
    // Attack at +6 cannot be raised (7 % 6 = 1 re-rolls); Defense at -6 cannot be lowered. 8 % 6 = 2 raises Defense 0 -> 2; 9 % 6 = 3 lowers Speed.
    const rng = scriptedRng([7, 8, 9])
    const s = battle([holder(), {}], rng)
    setStages(s, { [STAT_ATK]: 12, [STAT_DEF]: 0 })
    quietTurn(s)
    const stages = s.battlers[0]!.mon.statStages
    expect(stages[STAT_ATK]).toBe(12)
    expect(stages[STAT_DEF]).toBe(2)
    expect(stages[STAT_SPEED]).toBe(5)
    expect(rng.calls).toBe(3)
  })

  it('does nothing, and draws nothing, on the turn it came in (isFirstTurn == 2)', () => {
    const rng = scriptedRng([8, 9])
    const s = battle([holder(), {}], rng)
    s.battlers[0]!.volatiles.isFirstTurn = 2
    quietTurn(s)
    expect(s.battlers[0]!.mon.statStages[STAT_DEF]).toBe(6)
    expect(rng.calls).toBe(0)
    expect(s.battlers[0]!.round.disableEjectPack).toBe(false)
  })
})

describe('Cycle 89a - Truant (src/abilities.cc:1189-1195; CANCELLER_TRUANT battle_util.c:3281)', () => {
  const holder = (): Spec => ({ abilities: hasAbility('ABILITY_TRUANT'), moves: slot('MOVE_TACKLE', 'MOVE_HARDEN'), pp: pps })

  it('loafs every other turn: hit, loaf, hit', () => {
    const s = battle([holder(), {}], countingRng())
    turn(s, 'MOVE_TACKLE')
    expect(s.battlers[1]!.mon.hp).toBe(80)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(1)
    turn(s, 'MOVE_TACKLE')
    expect(s.battlers[1]!.mon.hp).toBe(80)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
    turn(s, 'MOVE_TACKLE')
    expect(s.battlers[1]!.mon.hp).toBe(60)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(1)
  })

  it('a chosen status move does not start the loaf', () => {
    const s = battle([holder(), {}], countingRng())
    turn(s, 'MOVE_HARDEN')
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
    turn(s, 'MOVE_TACKLE')
    expect(s.battlers[1]!.mon.hp).toBe(80)
  })

  it('choosing no move (no action) does not start the loaf', () => {
    const s = battle([holder(), {}], countingRng())
    quietTurn(s)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('the loaf state is per slot: an innate Truant uses its own slot', () => {
    const s = battle([{ abilities: innate('ABILITY_TRUANT', 2), moves: slot('MOVE_TACKLE'), pp: pps }, {}], countingRng())
    turn(s, 'MOVE_TACKLE')
    expect(s.battlers[0]!.volatiles.abilityState[3]).toBe(1)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })
})

describe('Cycle 89a - what is still skipped', () => {
  it('Craving still reports its onEndTurn hook as not run', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_CRAVING') }, {}], countingRng())
    const out = quietTurn(s)
    expect(out.endTurnUnmodelled.join('\n')).toContain("ABILITY_CRAVING's onEndTurn hook was not run")
  })
})
