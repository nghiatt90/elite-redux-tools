// Battle outcome (Cmd_checkteamslost, outcome.ts), the mid-turn/end-of-turn
// short-circuit (RunTurnActionsFunctions/BattleTurnPassed, turn.ts), and
// end-of-turn fainted-mon replacement (HandleFaintedMonActions/
// SwitchInClearSetData, switchIn.ts). See each module's own header for the C
// citations; this file only exercises the resulting behaviour.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { STATUS1_BURN, STATUS1_POISON, STATUS2_CONFUSION, STAT_ATK, DEFAULT_STAT_STAGE, WEATHER_SANDSTORM_PERMANENT } from './constants'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData } from './dataContext'
import type { ReplacementDeps } from './switchIn'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const abilityHooks = snapshot<Record<string, { hooks?: Record<string, unknown> }>>('abilityHooks.json')
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const speciesIds = new Set(snapshot<Array<{ id: string }>>('species.json').map((s) => s.id))

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}
function requireItem(id: string): SimItemData {
  const it = itemsById.get(id)
  if (!it) throw new Error(`items.json has no ${id}`)
  return {
    id,
    resolvedHoldEffect: (it.resolvedHoldEffect as string | null) ?? null,
    holdEffectStrength: (it.holdEffectStrength as number | null) ?? null,
    holdEffectType: (it.holdEffectType as string | null) ?? null,
    naturalGift: (it.naturalGift as { power: number; type: string } | null) ?? null,
  }
}
function requireSpecies(id: string): string {
  if (!speciesIds.has(id)) throw new Error(`species.json has no ${id}`)
  return id
}

// Fail loudly, not by a silently-vacuous test later, if any of these ids are
// ever renamed or removed -- and pin the exact onEntry/switch-in classification
// this batch's gap lines depend on, per the brief's "verify every id" rule.
const MUDKIP = requireSpecies('SPECIES_MUDKIP')
const INTIMIDATE = requireAbility('ABILITY_INTIMIDATE')
if (!abilityHooks[INTIMIDATE]?.hooks?.onEntry) throw new Error(`${INTIMIDATE} no longer has an onEntry hook in abilityHooks.json`)
const MAGIC_GUARD = requireAbility('ABILITY_MAGIC_GUARD')
if (abilityHooks[MAGIC_GUARD]?.hooks?.onEntry) throw new Error(`${MAGIC_GUARD} unexpectedly gained an onEntry hook -- pick a different "no gap" ability`)
const AIR_BALLOON = requireItem('ITEM_AIR_BALLOON')
if (AIR_BALLOON.resolvedHoldEffect !== 'HOLD_EFFECT_AIR_BALLOON') throw new Error('ITEM_AIR_BALLOON no longer resolves to HOLD_EFFECT_AIR_BALLOON')
const LEFTOVERS = requireItem('ITEM_LEFTOVERS')
if (LEFTOVERS.resolvedHoldEffect !== 'HOLD_EFFECT_LEFTOVERS') throw new Error('ITEM_LEFTOVERS no longer resolves to HOLD_EFFECT_LEFTOVERS')

const GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
  // No move data -- accuracyBridge.ts's own "moveAccuracy 0 -> accuracy 101,
  // cannot miss" precedent (turn.test.ts), so every action in this file hits
  // deterministically without needing a scripted RNG for the accuracy draw.
  move: () => undefined,
}
const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: MUDKIP,
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
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: MUDKIP,
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

function battle(
  specs: { spe: number; hp?: number; maxHp?: number; status1?: number; abilities?: SimBattleMon['abilities']; itemId?: string | null }[],
  rng: RandomSource,
  playerParty?: SimPartyMon[],
  opponentParty?: SimPartyMon[],
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe },
          hp: s.hp ?? s.maxHp ?? 100,
          maxHp: s.maxHp ?? 100,
          status1: s.status1 ?? 0,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          itemId: s.itemId ?? null,
        }),
        0,
      ),
    ),
    rng,
    playerParty,
    opponentParty,
  })
}

function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

function moveView(overrides: Partial<TurnOrderMoveView> = {}): TurnOrderMoveView {
  return {
    id: 'MOVE_TACKLE', priority: 0, effect: null, isStatus: false, resolvedType: 'NORMAL', power: 40, flags: {}, split: 'PHYSICAL',
    hasStrongJawBoostFlag: false, isKeenEdge: false, naturalGiftPriority: 0, isGrassyTerrainAffected: false, myceliumMightAffected: false,
    ...overrides,
  }
}
function useMove(target: number, m: TurnOrderMoveView = moveView()): ChosenAction {
  return { action: 'USE_MOVE', moveToBeUsed: m, chosenMove: m, target }
}

function deps(damage: DamageResolver, replacement?: ReplacementDeps): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT, replacement }
}

/** Deals `amount` to the target only. */
function lethalToTarget(amount: number): DamageResolver & { calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    resolve(_state, attackerId, _targetId) {
      calls.push(attackerId)
      return { targetDamage: amount, attackerDamage: null, unmodelled: [] }
    },
  }
}

/** Deals lethal damage to BOTH the target and the attacker (a fatal-recoil
 * move) in one action -- see this file's own DREW test for why this is the
 * only way two singles battlers' last mons can faint in the SAME action. */
function mutualLethal(amount: number): DamageResolver {
  return {
    resolve() {
      return { targetDamage: amount, attackerDamage: amount, unmodelled: [] }
    },
  }
}

describe('computeBattleOutcome / mid-turn short-circuit', () => {
  it('the opponent\'s last mon fainting sets WON and stops the loop', () => {
    const state = battle([{ spe: 200, hp: 100 }, { spe: 50, hp: 10 }], scripted(), [partyMon({ hp: 100 })], [partyMon({ hp: 10 })])
    const dmg = lethalToTarget(999)
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(dmg))
    expect(out.outcome).toBe('WON')
    expect(state.battleOutcome).toBe('WON')
    // The slower (and now-fainted) battler's own action never runs -- its slot
    // is reported as battleOver, and the resolver was never invoked for it.
    expect(out.actions[1].battleOver).toBe(true)
    expect(out.actions[1].skippedBecauseFainted).toBe(false)
    expect(dmg.calls).toEqual([0])
  })

  it('the player\'s last mon fainting sets LOST', () => {
    const state = battle([{ spe: 50, hp: 10 }, { spe: 200, hp: 100 }], scripted(), [partyMon({ hp: 10 })], [partyMon({ hp: 100 })])
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(lethalToTarget(999)))
    expect(out.outcome).toBe('LOST')
    expect(out.actions[1].battleOver).toBe(true)
  })

  it('both sides\' last mons fainting in the same action sets DREW (B_OUTCOME_WON | B_OUTCOME_LOST)', () => {
    // A single fatal-recoil action: the target dies first (WON, momentarily),
    // then the attacker's own recoil kills it too (DREW) -- both within the
    // SAME applyDamage-driven recompute sequence turn.ts documents.
    const state = battle([{ spe: 200, hp: 10 }, { spe: 50, hp: 10 }], scripted(), [partyMon({ hp: 10 })], [partyMon({ hp: 10 })])
    const out = executeTurn(state, [useMove(1), null], deps(mutualLethal(999)))
    expect(out.outcome).toBe('DREW')
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(0)
  })

  it('a poisoned survivor takes no poison damage the turn the battle ends', () => {
    const state = battle(
      [{ spe: 200, hp: 80, status1: STATUS1_POISON }, { spe: 50, hp: 10 }],
      scripted(),
      [partyMon({ hp: 80, status1: STATUS1_POISON })],
      [partyMon({ hp: 10 })],
    )
    const out = executeTurn(state, [useMove(1), null], deps(lethalToTarget(999)))
    expect(out.outcome).toBe('WON')
    // Neither end-turn ladder ran at all.
    expect(out.fieldEndTurn).toEqual([])
    expect(out.endTurn).toEqual([])
    expect(out.endTurnOrder).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(80) // no poison damage
  })

  it('a fainting battler mid-ladder stops the REST of that same ladder pass for the other battler', () => {
    // Both battlers poisoned; battler 0 is processed first in the (identity)
    // battlerOrder and has only 1 HP left, so its OWN poison damage decides
    // the outcome before battler 1's own poison entry is ever reached.
    const state = battle(
      [{ spe: 200, hp: 1, maxHp: 1, status1: STATUS1_POISON }, { spe: 50, hp: 50, status1: STATUS1_POISON }],
      scripted(),
      [partyMon({ hp: 1, maxHp: 1, status1: STATUS1_POISON })],
      [partyMon({ hp: 50, status1: STATUS1_POISON })],
    )
    const out = executeTurn(state, [null, null], deps(lethalToTarget(0)))
    expect(out.outcome).toBe('LOST')
    // Battler 0 took its own poison damage (fainted); battler 1's own poison
    // entry in the SAME ladder pass never ran.
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'POISON', hpChange: -1, fainted: true }])
    expect(state.battlers[1]!.mon.hp).toBe(50) // untouched
  })
})

describe('applyEndOfTurnReplacements', () => {
  function replacementDeps(chosenIndex: number): ReplacementDeps & { calls: { battlerId: number }[] } {
    const calls: { battlerId: number }[] = []
    return {
      calls,
      chooseReplacement(_state, battlerId) {
        calls.push({ battlerId })
        return chosenIndex
      },
    }
  }

  it('replaces a fainted battler at end of turn with the chosen live reserve', () => {
    const reserve = partyMon({ hp: 42, maxHp: 60, status1: STATUS1_BURN, moves: ['MOVE_EMBER', null, null, null] })
    const state = battle(
      [{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }],
      scripted(),
      [partyMon({ hp: 5 }), reserve],
      [partyMon({ hp: 100 })],
    )
    const rep = replacementDeps(1)
    const out = executeTurn(state, [null, useMove(0)], deps(lethalToTarget(999), rep))

    expect(out.outcome).toBe(null) // player still has a live reserve
    expect(rep.calls).toEqual([{ battlerId: 0 }])

    // The new battler carries the reserve's own record.
    const battler0 = state.battlers[0]!
    expect(battler0.partyIndex).toBe(1)
    expect(battler0.mon.hp).toBe(42)
    expect(battler0.mon.maxHp).toBe(60)
    expect(battler0.mon.status1).toBe(STATUS1_BURN) // persists
    expect(battler0.mon.status2).toBe(0) // cleared
    expect(battler0.mon.moves).toEqual(['MOVE_EMBER', null, null, null])
    expect(battler0.mon.statStages.every((s) => s === DEFAULT_STAT_STAGE)).toBe(true)
    expect(battler0.statuses3).toBe(0)
    expect(battler0.statuses4).toBe(0)
    expect(battler0.volatiles.isFirstTurn).toBe(2)

    // The fainted mon's own party record shows HP 0.
    expect(state.sides[0].party[0]!.hp).toBe(0)
  })

  it('does not replace mid-turn -- a same-turn field hazard (sandstorm) never touches the fresh switch-in', () => {
    const reserve = partyMon({ hp: 60, maxHp: 60 }) // Water-type Mudkip: not sand-immune
    const state = battle(
      [{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }],
      scripted(),
      [partyMon({ hp: 5 }), reserve],
      [partyMon({ hp: 100 })],
    )
    state.field.weather = WEATHER_SANDSTORM_PERMANENT
    const rep = replacementDeps(1)
    executeTurn(state, [null, useMove(0)], deps(lethalToTarget(999), rep))

    // The field ladder already ran (and applied sandstorm to whoever was on
    // the field THEN) before the replacement happened -- the incoming mon
    // takes no damage this same turn.
    expect(state.battlers[0]!.mon.hp).toBe(60)
  })

  it('an invalid choice throws rather than silently applying', () => {
    const state = battle(
      [{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }],
      scripted(),
      [partyMon({ hp: 5 })], // no live reserve at all in the party -- but the mock below ignores that and answers anyway
      [partyMon({ hp: 100 })],
    )
    const rep: ReplacementDeps = { chooseReplacement: () => 5 } // out of range
    // hasLiveReserve is false here (party has one entry, the fainted one), so
    // this particular case actually short-circuits before ever calling
    // chooseReplacement -- assert no crash and no replacement.
    executeTurn(state, [null, useMove(0)], deps(lethalToTarget(999), rep))
    expect(state.battlers[0]!.mon.hp).toBe(0)

    // Now WITH a live reserve, an out-of-range choice must throw.
    const state2 = battle(
      [{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }],
      scripted(),
      [partyMon({ hp: 5 }), partyMon({ hp: 20 })],
      [partyMon({ hp: 100 })],
    )
    const badRep: ReplacementDeps = { chooseReplacement: () => 5 }
    expect(() => executeTurn(state2, [null, useMove(0)], deps(lethalToTarget(999), badRep))).toThrow(/invalid replacement party slot/)

    // Choosing the very slot that just fainted must also throw.
    const state3 = battle(
      [{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }],
      scripted(),
      [partyMon({ hp: 5 }), partyMon({ hp: 20 })],
      [partyMon({ hp: 100 })],
    )
    const sameSlotRep: ReplacementDeps = { chooseReplacement: () => 0 }
    expect(() => executeTurn(state3, [null, useMove(0)], deps(lethalToTarget(999), sameSlotRep))).toThrow(/invalid replacement party slot/)
  })

  it('the replacement acts normally on the NEXT turn', () => {
    const reserve = partyMon({ hp: 60, maxHp: 60 })
    const state = battle(
      [{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }],
      scripted(),
      [partyMon({ hp: 5 }), reserve],
      [partyMon({ hp: 100 })],
    )
    const rep = replacementDeps(1)
    executeTurn(state, [null, useMove(0)], deps(lethalToTarget(999), rep))
    expect(state.battlers[0]!.mon.hp).toBe(60)

    // Second turn: the replacement (battler 0) now acts.
    const dmg2 = lethalToTarget(30)
    const out2 = executeTurn(state, [useMove(1), useMove(0)], deps(dmg2, rep))
    const battler0Action = out2.actions.find((a) => a.battlerId === 0)!
    expect(battler0Action.skippedBecauseFainted).toBe(false)
    expect(battler0Action.battleOver).toBe(false)
    expect(dmg2.calls).toContain(0)
  })

  it('gaps a switch-in ability by name only when the incoming mon actually has one', () => {
    const withAbility = partyMon({ hp: 60, abilities: { ability: INTIMIDATE, innates: [null, null, null] } })
    const state = battle([{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }], scripted(), [partyMon({ hp: 5 }), withAbility], [partyMon({ hp: 100 })])
    const rep = replacementDeps(1)
    const out = executeTurn(state, [null, useMove(0)], deps(lethalToTarget(999), rep))
    expect(out.replacementUnmodelled.some((g) => g.includes('HandleSwitchInAbility') && g.includes(INTIMIDATE))).toBe(true)
  })

  it('emits no switch-in ability gap when the incoming mon\'s ability has no onEntry hook', () => {
    const withoutAbility = partyMon({ hp: 60, abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } })
    const state = battle([{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }], scripted(), [partyMon({ hp: 5 }), withoutAbility], [partyMon({ hp: 100 })])
    const rep = replacementDeps(1)
    const out = executeTurn(state, [null, useMove(0)], deps(lethalToTarget(999), rep))
    expect(out.replacementUnmodelled.some((g) => g.includes('HandleSwitchInAbility'))).toBe(false)
  })

  it('gaps a switch-in item by name only when the incoming mon holds one', () => {
    const withItem = partyMon({ hp: 60, itemId: AIR_BALLOON.id })
    const state = battle([{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }], scripted(), [partyMon({ hp: 5 }), withItem], [partyMon({ hp: 100 })])
    const rep = replacementDeps(1)
    const out = executeTurn(state, [null, useMove(0)], deps(lethalToTarget(999), rep))
    expect(out.replacementUnmodelled.some((g) => g.includes('ITEMEFFECT_ON_SWITCH_IN') && g.includes(AIR_BALLOON.id))).toBe(true)
  })

  it('emits no switch-in item gap for a hold effect outside ITEMEFFECT_ON_SWITCH_IN\'s own switch', () => {
    const withItem = partyMon({ hp: 60, itemId: LEFTOVERS.id })
    const state = battle([{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }], scripted(), [partyMon({ hp: 5 }), withItem], [partyMon({ hp: 100 })])
    const rep = replacementDeps(1)
    const out = executeTurn(state, [null, useMove(0)], deps(lethalToTarget(999), rep))
    expect(out.replacementUnmodelled.some((g) => g.includes('ITEMEFFECT_ON_SWITCH_IN'))).toBe(false)
  })

  it('never emits a hazard gap line -- hazards are unreachable (nothing in sim/ sets them)', () => {
    const reserve = partyMon({ hp: 60 })
    const state = battle([{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }], scripted(), [partyMon({ hp: 5 }), reserve], [partyMon({ hp: 100 })])
    const rep = replacementDeps(1)
    const out = executeTurn(state, [null, useMove(0)], deps(lethalToTarget(999), rep))
    expect(out.replacementUnmodelled.some((g) => /spikes|stealth rock|sticky web/i.test(g))).toBe(false)
  })

  it('no replacement happens once the battle is already decided', () => {
    // Player has no reserve at all, so its own faint decides the battle
    // (LOST); the opponent's side is untouched and irrelevant here.
    const state = battle([{ spe: 50, hp: 5 }, { spe: 200, hp: 100 }], scripted(), [partyMon({ hp: 5 })], [partyMon({ hp: 100 })])
    const rep = replacementDeps(0)
    executeTurn(state, [null, useMove(0)], deps(lethalToTarget(999), rep))
    expect(rep.calls).toEqual([]) // never called: no live reserve regardless, and the battle is over
    expect(state.battlers[0]!.mon.hp).toBe(0)
  })
})

describe('executeTurn: a mid-turn CHOSEN switch (performSwitchAction)', () => {
  function replacementDeps(chosenIndex: number): ReplacementDeps & { calls: { battlerId: number }[] } {
    const calls: { battlerId: number }[] = []
    return {
      calls,
      chooseReplacement(_state, battlerId) {
        calls.push({ battlerId })
        return chosenIndex
      },
    }
  }

  it('the switch happens before the opponent\'s (slower) move: the resolver never sees the outgoing mon as a target', () => {
    // Battler 0 chooses SWITCH; battler 1 (faster) chooses a move targeting
    // battler 0. SWITCH actions are grouped first by
    // setActionsAndBattlersTurnOrder regardless of speed, so the switch must
    // still resolve before battler 1's move -- proven by the resolver
    // recording which mon (by HP) it actually hit.
    const reserve = partyMon({ hp: 77, maxHp: 90, moves: ['MOVE_EMBER', null, null, null] })
    const state = battle([{ spe: 50, hp: 100 }, { spe: 200, hp: 100 }], scripted(), [partyMon({ hp: 100 }), reserve], [partyMon({ hp: 100 })])
    state.battlers[0]!.monToSwitchIntoId = 1

    const seenTargetHp: number[] = []
    const recordingResolver: DamageResolver = {
      resolve(s, _attackerId, targetId) {
        seenTargetHp.push(s.battlers[targetId]!.mon.hp)
        return { targetDamage: 10, attackerDamage: null, unmodelled: [] }
      },
    }
    const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }
    const out = executeTurn(state, [switchAction, useMove(0)], deps(recordingResolver))

    expect(out.actions[0].action).toBe('SWITCH')
    expect(out.actions[1].action).toBe('USE_MOVE')
    // The move (battler 1's, targeting battler 0) resolved AFTER the switch --
    // it saw the INCOMING mon's HP (77), not the outgoing mon's (100).
    expect(seenTargetHp).toEqual([77])
    expect(state.battlers[0]!.partyIndex).toBe(1)
  })

  it('HandleAction_ActionFinished:849 resets monToSwitchIntoId after ANY action, so a pending slot never goes stale', () => {
    // A slot left pending on a battler that then MOVES (not switches) would
    // otherwise make every later GetMostSuitableMonToSwitchInto short-circuit.
    const state = battle([{ spe: 200, hp: 100 }, { spe: 50, hp: 100 }], scripted(), [partyMon({ hp: 100 }), partyMon({ hp: 80 })], [partyMon({ hp: 100 })])
    state.battlers[0]!.monToSwitchIntoId = 1
    state.battlers[1]!.monToSwitchIntoId = 0
    executeTurn(state, [useMove(1), useMove(0)], deps(lethalToTarget(10)))
    expect(state.battlers[0]!.monToSwitchIntoId).toBe(6)
    expect(state.battlers[1]!.monToSwitchIntoId).toBe(6)
  })

  it('the outgoing mon\'s HP and status1 persist on its party record; status2 and stat stages do not carry over', () => {
    const reserve = partyMon({ hp: 50 })
    const state = battle([{ spe: 200, hp: 63, status1: STATUS1_BURN }, { spe: 50, hp: 100 }], scripted(), [partyMon({ hp: 63, status1: STATUS1_BURN }), reserve], [partyMon({ hp: 100 })])
    state.battlers[0]!.mon.status2 = STATUS2_CONFUSION
    state.battlers[0]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 2
    state.battlers[0]!.monToSwitchIntoId = 1

    const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }
    executeTurn(state, [switchAction, null], deps(lethalToTarget(0)))

    // Outgoing mon's own party record.
    expect(state.sides[0].party[0]!.hp).toBe(63)
    expect(state.sides[0].party[0]!.status1).toBe(STATUS1_BURN)

    // Incoming battler is a fresh switch-in: no status2, neutral stat stages.
    const battler0 = state.battlers[0]!
    expect(battler0.partyIndex).toBe(1)
    expect(battler0.mon.hp).toBe(50)
    expect(battler0.mon.status2).toBe(0)
    expect(battler0.mon.statStages.every((s) => s === DEFAULT_STAT_STAGE)).toBe(true)
  })

  it('resolves the target slot via deps.replacement when monToSwitchIntoId was left at PARTY_SIZE (the second switch check\'s own shape)', () => {
    const reserve = partyMon({ hp: 88 })
    const state = battle([{ spe: 200, hp: 100 }, { spe: 50, hp: 100 }], scripted(), [partyMon({ hp: 100 }), reserve], [partyMon({ hp: 100 })])
    expect(state.battlers[0]!.monToSwitchIntoId).toBe(6) // PARTY_SIZE sentinel, never set

    const rep = replacementDeps(1)
    const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }
    const out = executeTurn(state, [switchAction, null], deps(lethalToTarget(0), rep))

    expect(rep.calls).toEqual([{ battlerId: 0 }])
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(out.actions[0].unmodelled).toEqual([])
  })

  it('emits a gap line and switches nothing when monToSwitchIntoId is PARTY_SIZE and no deps.replacement is supplied', () => {
    const reserve = partyMon({ hp: 88 })
    const state = battle([{ spe: 200, hp: 100 }, { spe: 50, hp: 100 }], scripted(), [partyMon({ hp: 100 }), reserve], [partyMon({ hp: 100 })])
    const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }
    const out = executeTurn(state, [switchAction, null], deps(lethalToTarget(0)))

    expect(out.actions[0].unmodelled.some((g) => g.includes('nothing to switch into'))).toBe(true)
    expect(state.battlers[0]!.partyIndex).toBe(0) // unchanged
  })
})
