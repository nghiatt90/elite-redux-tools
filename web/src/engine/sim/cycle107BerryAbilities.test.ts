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
import { consumeBerryWithOverride, setCudChew } from './moveEffects'
import { CUD_CHEW_ACTIVATING, CUD_CHEW_SET_THIS_TURN, runEndTurnEffects } from './endTurn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import { STATUS3_GASTRO_ACID } from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- cycle89aAbilities.test.ts's snapshot-backed scaffolding, plus the
// real item records (Sitrus' hold-effect parameter, berry pockets) that
// cycle96Abilities.test.ts wires in.
// ---------------------------------------------------------------------------

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

// The numbers these tests hand-derive depend on the snapshot's own item values.
const SITRUS = itemsById.get('ITEM_SITRUS_BERRY')
if (!SITRUS || SITRUS.grouping !== 'POCKET_BERRIES' || SITRUS.resolvedHoldEffect !== 'HOLD_EFFECT_RESTORE_PCT_HP' || SITRUS.holdEffectStrength !== 25) {
  throw new Error('ITEM_SITRUS_BERRY no longer resolves to POCKET_BERRIES / HOLD_EFFECT_RESTORE_PCT_HP / 25')
}
const BERRY_JUICE = itemsById.get('ITEM_BERRY_JUICE')
if (!BERRY_JUICE || BERRY_JUICE.grouping !== 'POCKET_MEDICINE' || BERRY_JUICE.resolvedHoldEffect !== 'HOLD_EFFECT_RESTORE_HP' || BERRY_JUICE.holdEffectStrength !== 20) {
  throw new Error('ITEM_BERRY_JUICE no longer resolves to POCKET_MEDICINE / HOLD_EFFECT_RESTORE_HP / 20')
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
const pps: SimBattleMon['pp'] = [20, 0, 0, 0]
const hasAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })
const innate = (id: string, index: 0 | 1 | 2 = 0): SimBattleMon['abilities'] => {
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

describe('Cycle 107 - SetCudChew (battle_script_commands.c:6028-6038, called at battle_util.c:6300)', () => {
  it('arms {itemId, setThisTurn} when a move eats a berry: Sitrus at 50/100 heals 25 and arms slot 0', () => {
    const s = battle([{ hp: 50, maxHp: 100, itemId: 'ITEM_SITRUS_BERRY', abilities: hasAbility('ABILITY_CUD_CHEW') }, {}], countingRng())
    const notes: string[] = []
    consumeBerryWithOverride(s, 0, 0, 'MOVE_STUFF_CHEEKS', testDeps(), notes, [], false)
    const b = s.battlers[0]!
    // ItemHealHp: maxHp * holdEffectStrength / 100 = 100 * 25 / 100 = 25; 50 + 25 = 75.
    expect(b.mon.hp).toBe(75)
    expect(b.mon.itemId).toBeNull()
    expect(b.usedHeldItem).toBe('ITEM_SITRUS_BERRY') // Cmd_removeitem records the eaten berry
    expect(b.ateBerry).toBe(true) // battle_util.c:6300
    expect(b.cudChewItem).toBe('ITEM_SITRUS_BERRY')
    expect(b.volatiles.abilityState[0]).toBe(CUD_CHEW_SET_THIS_TURN) // bit0 only
    expect(notes.join('\n')).not.toContain('SetCudChew')
  })

  it('does not arm for an item outside POCKET_BERRIES (Berry Juice is POCKET_MEDICINE)', () => {
    const s = battle([{ hp: 50, maxHp: 100, itemId: 'ITEM_BERRY_JUICE', abilities: hasAbility('ABILITY_CUD_CHEW') }, {}], countingRng())
    consumeBerryWithOverride(s, 0, 0, 'MOVE_TACKLE', testDeps(), [], [], false)
    const b = s.battlers[0]!
    expect(b.mon.hp).toBe(70) // HOLD_EFFECT_RESTORE_HP 20: 50 + 20
    expect(b.mon.itemId).toBeNull()
    expect(b.cudChewItem ?? null).toBeNull()
    expect(b.volatiles.abilityState[0]).toBe(0)
    // battle_util.c:6298-6300 also gates the ateBerry bit itself on the berry item range.
    expect(b.ateBerry ?? false).toBe(false)
  })

  it('does not arm without Cud Chew', () => {
    const s = battle([{ hp: 50, maxHp: 100, itemId: 'ITEM_SITRUS_BERRY' }, {}], countingRng())
    consumeBerryWithOverride(s, 0, 0, 'MOVE_TACKLE', testDeps(), [], [], false)
    const b = s.battlers[0]!
    expect(b.mon.hp).toBe(75)
    expect(b.cudChewItem ?? null).toBeNull()
    expect(b.volatiles.abilityState[0]).toBe(0)
  })

  it('does not arm while the ateBerry bit is unset; arming it makes the same call arm', () => {
    const s = battle([{ hp: 100, maxHp: 100, itemId: 'ITEM_SITRUS_BERRY', abilities: hasAbility('ABILITY_CUD_CHEW') }, {}], countingRng())
    const deps = testDeps()
    setCudChew(s, 0, 'ITEM_SITRUS_BERRY', 0, deps)
    expect(s.battlers[0]!.cudChewItem ?? null).toBeNull()
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)

    s.battlers[0]!.ateBerry = true
    setCudChew(s, 0, 'ITEM_SITRUS_BERRY', 0, deps)
    expect(s.battlers[0]!.cudChewItem).toBe('ITEM_SITRUS_BERRY')
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(CUD_CHEW_SET_THIS_TURN)
  })

  it('clears the whole state instead of re-arming while activating (a Cud Chew eat cannot chain)', () => {
    const s = battle([{ hp: 100, maxHp: 100, abilities: hasAbility('ABILITY_CUD_CHEW') }, {}], countingRng())
    const b = s.battlers[0]!
    b.ateBerry = true
    b.cudChewItem = 'ITEM_ORAN_BERRY'
    b.volatiles.abilityState[0] = CUD_CHEW_ACTIVATING
    setCudChew(s, 0, 'ITEM_SITRUS_BERRY', 0, testDeps())
    expect(b.cudChewItem).toBeNull()
    expect(b.volatiles.abilityState[0]).toBe(0)
  })
})

describe('Cycle 107 - Cud Chew end of turn (src/abilities.cc:7194-7210)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ maxHp: 100, abilities: hasAbility('ABILITY_CUD_CHEW'), ...extra })

  it('clears setThisTurn at the end of the turn it was set, without re-eating (Stuff Cheeks: 50 -> 75 only)', () => {
    const s = battle([holder({ hp: 50, itemId: 'ITEM_SITRUS_BERRY', moves: slot('MOVE_STUFF_CHEEKS'), pp: pps }), {}], countingRng())
    const out = turn(s, 'MOVE_STUFF_CHEEKS')
    const b = s.battlers[0]!
    // The move's own consumeberry: 100 * 25 / 100 = 25, 50 -> 75. The end-turn pass only
    // clears setThisTurn (abilities.cc:7197-7199), so the HP must not move again.
    expect(b.mon.hp).toBe(75)
    expect(b.mon.itemId).toBeNull()
    expect(b.cudChewItem).toBe('ITEM_SITRUS_BERRY')
    expect(b.volatiles.abilityState[0]).toBe(0)
    expect(out.endTurnUnmodelled.join('\n')).not.toContain('SetCudChew')
  })

  it('re-eats the stored Sitrus at the end of the NEXT turn: 120/4 = 30, 60 -> 90, state cleared, not re-armed', () => {
    const s = battle([holder({ hp: 60, maxHp: 120 })], countingRng())
    s.battlers[0]!.cudChewItem = 'ITEM_SITRUS_BERRY' // set by the previous turn's eat; flags cleared then
    const out = quietTurn(s)
    const b = s.battlers[0]!
    expect(b.mon.hp).toBe(90) // maxHp * 25 / 100 = 30
    expect(b.usedHeldItem).toBe('ITEM_SITRUS_BERRY')
    expect(b.mon.itemId).toBeNull()
    expect(b.changedItem ?? null).toBeNull()
    // SetCudChew ran again inside the consume with state.activating -> the whole state is 0,
    // so the berry is not stored for another turn.
    expect(b.cudChewItem).toBeNull()
    expect(b.volatiles.abilityState[0]).toBe(0)
    expect(out.endTurnUnmodelled.filter((n) => n.includes('MOVEEND_CHANGED_ITEMS'))).toHaveLength(0)
  })

  it('parks a held item in changedItems when the re-eaten berry fires; the restore is reported, not invented', () => {
    const s = battle([holder({ hp: 60, maxHp: 120, itemId: 'ITEM_LEFTOVERS' })], countingRng())
    s.battlers[0]!.cudChewItem = 'ITEM_SITRUS_BERRY'
    const out = quietTurn(s)
    const b = s.battlers[0]!
    expect(b.mon.hp).toBe(90) // the Sitrus fires: 60 + 30
    expect(b.mon.itemId).toBeNull() // removeitem clears the temporary berry
    expect(b.changedItem).toBe('ITEM_LEFTOVERS') // still parked: MOVEEND_CHANGED_ITEMS never runs at end of turn
    expect(b.volatiles.abilityState[0]).toBe(0)
    expect(b.cudChewItem).toBeNull()
    const deferred = out.endTurnUnmodelled.filter((n) => n.includes('MOVEEND_CHANGED_ITEMS'))
    expect(deferred).toHaveLength(1)
  })

  it('restores the parked item and leaves the state activating when the berry cannot fire (full HP)', () => {
    const s = battle([holder({ hp: 120, maxHp: 120, itemId: 'ITEM_LEFTOVERS' })], countingRng())
    s.battlers[0]!.cudChewItem = 'ITEM_SITRUS_BERRY'
    const out = quietTurn(s)
    const b = s.battlers[0]!
    // ItemHealHp breaks at hp == maxHP (battle_util.c:5315), so ItemBattleEffects returns 0 and
    // VARIOUS_CONSUME_BERRY takes the restore branch (:8037-8040): item = changedItems.
    expect(b.mon.hp).toBe(120)
    expect(b.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(b.changedItem ?? null).toBeNull()
    // The restore branch returns before Cmd_removeitem, so SetCudChew never runs: the C state
    // stays {activating} with itemId cleared.
    expect(b.volatiles.abilityState[0]).toBe(CUD_CHEW_ACTIVATING)
    expect(b.cudChewItem).toBeNull()
    expect(out.endTurnUnmodelled.filter((n) => n.includes('MOVEEND_CHANGED_ITEMS'))).toHaveLength(0)

    // And with no itemId left, later end turns do nothing at all.
    quietTurn(s)
    expect(b.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(b.volatiles.abilityState[0]).toBe(CUD_CHEW_ACTIVATING)
  })

  it('fires from an innate slot (innates[0] = abilityState slot 1)', () => {
    const s = battle([{ hp: 60, maxHp: 120, abilities: innate('ABILITY_CUD_CHEW', 0) }, {}], countingRng())
    s.battlers[0]!.cudChewItem = 'ITEM_SITRUS_BERRY'
    quietTurn(s)
    const b = s.battlers[0]!
    expect(b.mon.hp).toBe(90)
    expect(b.volatiles.abilityState[1]).toBe(0) // slot 1 held activating, then SetCudChew cleared it
    expect(b.volatiles.abilityState[0]).toBe(0)
    expect(b.cudChewItem).toBeNull()
  })

  it('is skipped while suppressed (IsSuppressed, battle_util.c:9233)', () => {
    const s = battle([holder({ hp: 60, maxHp: 120 })], countingRng())
    s.battlers[0]!.cudChewItem = 'ITEM_SITRUS_BERRY'
    s.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    const out = quietTurn(s)
    const b = s.battlers[0]!
    expect(b.mon.hp).toBe(60)
    expect(b.cudChewItem).toBe('ITEM_SITRUS_BERRY') // untouched: neither eaten nor cleared
    expect(out.endTurnUnmodelled.join('\n')).not.toContain('CUD_CHEW')
  })
})

describe('Cycle 107 - Craving (src/abilities.cc:7238-7246, SetRandomTempBerry :7226-7236)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ maxHp: 120, abilities: hasAbility('ABILITY_CRAVING'), ...extra })

  it('draw 1 -> Sitrus, heals 120/4 = 30 and consumes it (one draw)', () => {
    const rng = scriptedRng([1])
    const s = battle([holder({ hp: 60 })], rng)
    quietTurn(s)
    const b = s.battlers[0]!
    expect(b.mon.hp).toBe(90)
    expect(b.usedHeldItem).toBe('ITEM_SITRUS_BERRY')
    expect(b.mon.itemId).toBeNull()
    expect(b.changedItem ?? null).toBeNull() // original item was ITEM_NONE
    expect(rng.calls).toBe(1) // no Figy second draw
  })

  it('draw 0 -> Lum with no status: no effect, the parked item is restored, still one draw', () => {
    const rng = scriptedRng([0])
    const s = battle([holder({ hp: 90, itemId: 'ITEM_LEFTOVERS' })], rng)
    quietTurn(s)
    const b = s.battlers[0]!
    // HOLD_EFFECT_CURE_STATUS with no status1/confusion never calls finishBerryRemoval.
    expect(b.mon.hp).toBe(90)
    expect(rng.calls).toBe(1)
    expect(b.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(b.changedItem ?? null).toBeNull()
    expect(b.usedHeldItem ?? null).toBeNull()
  })

  it('draw 2 -> Figy then a second draw % 5 = 1 -> Wiki: two draws, half-max HP heal', () => {
    const rng = scriptedRng([2, 1])
    const s = battle([holder({ hp: 60 })], rng)
    quietTurn(s)
    const b = s.battlers[0]!
    // HealConfuseBerry: maxHp / param = 120 / 2 = 60; 60 + 60 caps at 120.
    expect(b.mon.hp).toBe(120)
    expect(b.usedHeldItem).toBe('ITEM_WIKI_BERRY')
    expect(rng.calls).toBe(2) // the table draw, then the Figy alternatives draw
  })

  it('does nothing and draws nothing on the turn it came in (isFirstTurn == 2)', () => {
    const rng = scriptedRng([1])
    const s = battle([holder({ hp: 90, itemId: 'ITEM_LEFTOVERS' })], rng)
    s.battlers[0]!.volatiles.isFirstTurn = 2
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(90)
    expect(s.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(rng.calls).toBe(0)
  })

  it('does nothing and draws nothing while an Unnerve ability is on the opposing side', () => {
    const rng = scriptedRng([1])
    const s = battle([holder({ hp: 90, itemId: 'ITEM_LEFTOVERS' }), { abilities: hasAbility('ABILITY_UNNERVE') }], rng)
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(90)
    expect(s.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(rng.calls).toBe(0)
  })

  it('is skipped for a fainted holder (IsBattlerAlive, battle_util.c:9217)', () => {
    const rng = scriptedRng([1])
    const s = battle([holder({ hp: 0, itemId: 'ITEM_LEFTOVERS' })], rng)
    // endTurn.ts's own ladder guard, rather than executeTurn (whose battle-over handling
    // would stop at computeBattleOutcome before the ability loop is reached).
    runEndTurnEffects(s, [0, 1], DATA_CONTEXT, { grounding: GROUNDING, statStageRatios: RATIOS })
    expect(s.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(rng.calls).toBe(0)
  })

  it('still works through an innate slot', () => {
    const rng = scriptedRng([1])
    const s = battle([{ maxHp: 120, hp: 60, abilities: innate('ABILITY_CRAVING', 2) }], rng)
    quietTurn(s)
    expect(s.battlers[0]!.mon.hp).toBe(90)
    expect(rng.calls).toBe(1)
  })
})
