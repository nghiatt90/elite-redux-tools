// executeTurn's attack canceller (Cmd_attackcanceler / AtkCanceller_UnableToUseMove)
// -- see attackCanceller.ts's header for the C citations, the enum-ordered
// ladder and the loop-exit rule this batch relies on. Split from
// turnAccuracyPp.test.ts the same way that file split from turn.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { STATUS1_FREEZE, STATUS1_PARALYSIS, STATUS1_SLEEP, STATUS2_CONFUSION, STATUS2_FLINCHED, STATUS2_POWDER, setCounter } from './constants'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimMoveData } from './dataContext'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  const arg = m.argument as { kind: string; value: unknown } | undefined
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    argumentInt: arg?.kind === 'int' ? (arg.value as number) : null,
  }
}
function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}
function requireItem(id: string): { id: string; resolvedHoldEffect: string | null; holdEffectStrength: number | null; holdEffectType: string | null; naturalGift: { power: number; type: string } | null } {
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

// Fail loudly here, not by a silently-vacuous test later, if any of these ids
// are ever renamed or removed.
const TACKLE = requireMove('MOVE_TACKLE') // accuracy 100, not Snore/Sleep Talk
const SNORE = requireMove('MOVE_SNORE') // accuracy 100, usable while asleep
const SLEEP_TALK = requireMove('MOVE_SLEEP_TALK') // usable while asleep, status split
const SCALD = requireMove('MOVE_SCALD') // thawUser, not EFFECT_BURN_UP
const BURN_UP = requireMove('MOVE_BURN_UP') // thawUser AND EFFECT_BURN_UP
const POISON_POWDER = requireMove('MOVE_POISON_POWDER') // powderAffected, status split
const EMBER = requireMove('MOVE_EMBER') // TYPE_FIRE, accuracy 100
const ARM_THRUST = requireMove('MOVE_ARM_THRUST') // EFFECT_MULTI_HIT, accuracy 100
const EARLY_BIRD = requireAbility('ABILITY_EARLY_BIRD')
const TRUANT = requireAbility('ABILITY_TRUANT')
const SKILL_LINK = requireAbility('ABILITY_SKILL_LINK')
const LOADED_DICE = requireItem('ITEM_LOADED_DICE')
if (LOADED_DICE.resolvedHoldEffect !== 'HOLD_EFFECT_LOADED_DICE') throw new Error('ITEM_LOADED_DICE no longer resolves to HOLD_EFFECT_LOADED_DICE')

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
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
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function battle(
  specs: {
    spe: number
    hp?: number
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
    status1?: number
    status2?: number
    types?: SimBattleMon['types']
    itemId?: string | null
    speciesId?: string
  }[],
  rng: RandomSource,
  playerParty?: SimPartyMon[],
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe },
          hp: s.hp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ?? [35, 0, 0, 0],
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
          types: s.types ?? ['WATER', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
        }),
        0,
      ),
    ),
    rng,
    playerParty,
  })
}

function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

function useMove(target: number, move: SimMoveData = TACKLE): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id, priority: 0, effect: move.effect, isStatus: move.split === 'STATUS', resolvedType: move.type ?? 'NORMAL', power: move.power,
    flags: move.flags, split: move.split ?? 'PHYSICAL', hasStrongJawBoostFlag: false, isKeenEdge: false, naturalGiftPriority: 0,
    isGrassyTerrainAffected: false, myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function fixedDamage(amount: number): DamageResolver & { calls: number } {
  const r = { calls: 0, resolve: () => { r.calls++; return { targetDamage: amount, attackerDamage: null, unmodelled: [] } } }
  return r
}

// Records the attacker's multiHitCounter at the moment the resolver consumes
// it. executeTurn clears every TurnState after each action (TurnStructsClear),
// so reading it off the state after the call would always see 0.
function counterRecorder(): DamageResolver & { seen: number[] } {
  const r = {
    seen: [] as number[],
    resolve: (state: BattleState, attackerId: number) => {
      r.seen.push(state.battlers[attackerId]!.turn.multiHitCounter)
      return { targetDamage: 10, attackerDamage: null, unmodelled: [] }
    },
  }
  return r
}

function deps(damage: DamageResolver): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

describe('executeTurn: attack canceller -- sleep (CANCELLER_ASLEEP, battle_util.c:3209-3247)', () => {
  it('a sleeping attacker with turns left does not move, its counter decrements, and draws/deducts nothing', () => {
    const state = battle([{ spe: 200, pp: [10, 0, 0, 0], status1: 2 }, { spe: 50 }], scripted(85, 42)) // both values would matter if wrongly drawn
    const dmg = fixedDamage(10)
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(dmg))
    expect(out.actions[0].cancelledBy).toBe('SLEEP')
    expect(out.actions[0].missed).toBe(false)
    expect(out.actions[0].targetDamage).toBeNull()
    expect(state.battlers[0]!.mon.status1 & STATUS1_SLEEP).toBe(1) // decremented by 1
    expect(state.battlers[0]!.mon.pp[0]).toBe(10) // no PP deducted
    expect(dmg.calls).toBe(0) // no damage resolver call
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.round.attackCancelled).toBe(true)
  })

  it('wakes up when the counter reaches zero and acts THIS turn (the C\'s own effect=3 exits the ladder without cancelling)', () => {
    const state = battle([{ spe: 200, status1: 1 }, { spe: 50 }], scripted(50)) // 50 hits TACKLE (accuracy 100)
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(out.actions[0].cancelledBy).toBeNull()
    expect(out.actions[0].missed).toBe(false)
    expect(out.actions[0].targetDamage).toBe(10)
    expect(state.battlers[0]!.mon.status1 & STATUS1_SLEEP).toBe(0)
  })

  it('Early Bird subtracts 2 from the sleep counter instead of 1', () => {
    const state = battle([{ spe: 200, status1: 2, abilities: { ability: EARLY_BIRD, innates: [null, null, null] } }, { spe: 50 }], scripted(50))
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    // toSub=2 against a counter of 2 -> wakes immediately, same turn as an
    // ordinary Pokémon would still need a second turn to wake from.
    expect(out.actions[0].cancelledBy).toBeNull()
    expect(state.battlers[0]!.mon.status1 & STATUS1_SLEEP).toBe(0)
  })

  it('Snore/Sleep Talk are usable while still asleep: no cancellation, no ladder stop, falls through to the rest of the ladder', () => {
    const state = battle([{ spe: 200, status1: 2, moves: ['MOVE_SNORE', null, null, null], pp: [10, 0, 0, 0] }, { spe: 50 }], scripted(50))
    const out = executeTurn(state, [useMove(1, SNORE), null], deps(fixedDamage(10)))
    expect(out.actions[0].cancelledBy).toBeNull()
    expect(out.actions[0].missed).toBe(false)
    expect(out.actions[0].targetDamage).toBe(10)
    expect(state.battlers[0]!.mon.status1 & STATUS1_SLEEP).toBe(1) // still decremented
    void SLEEP_TALK // referenced so the requireMove check above actually runs
  })
})

describe('executeTurn: attack canceller -- freeze and thaw (CANCELLER_FROZEN :3248-3263, CANCELLER_THAW :3436-3454)', () => {
  it('stays frozen on a 4-in-5 draw (Random() % 5 !== 0)', () => {
    const state = battle([{ spe: 200, status1: STATUS1_FREEZE }, { spe: 50 }], scripted(1)) // 1 % 5 !== 0
    const dmg = fixedDamage(10)
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(dmg))
    expect(out.actions[0].cancelledBy).toBe('FREEZE')
    expect(dmg.calls).toBe(0)
    expect(state.battlers[0]!.mon.status1 & STATUS1_FREEZE).toBe(STATUS1_FREEZE)
  })

  it('thaws on a 1-in-5 draw (Random() % 5 === 0) and acts this turn', () => {
    const state = battle([{ spe: 200, status1: STATUS1_FREEZE }, { spe: 50 }], scripted(5, 50)) // 5 % 5 === 0 (thaw), then 50 for accuracy
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(out.actions[0].cancelledBy).toBeNull()
    expect(out.actions[0].targetDamage).toBe(10)
    expect(state.battlers[0]!.mon.status1 & STATUS1_FREEZE).toBe(0)
  })

  it('a thaw-flagged move (Scald) thaws the user unconditionally, with no RNG draw', () => {
    const state = battle([{ spe: 200, status1: STATUS1_FREEZE, moves: ['MOVE_SCALD', null, null, null] }, { spe: 50 }], scripted(50)) // only value: the accuracy draw
    const out = executeTurn(state, [useMove(1, SCALD), null], deps(fixedDamage(10)))
    expect(out.actions[0].cancelledBy).toBeNull()
    expect(out.actions[0].missed).toBe(false) // proves the single scripted value was consumed by accuracy, not a freeze draw
    expect(state.battlers[0]!.mon.status1 & STATUS1_FREEZE).toBe(0)
  })

  it('Burn Up does not thaw a non-Fire-type user, even though it carries thawUser (battle_util.c:3438-3440)', () => {
    const state = battle([{ spe: 200, status1: STATUS1_FREEZE, moves: ['MOVE_BURN_UP', null, null, null], types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { spe: 50 }], scripted(50))
    const out = executeTurn(state, [useMove(1, BURN_UP), null], deps(fixedDamage(10)))
    // effect=2 unconditionally once status1&FREEZE is true at CANCELLER_THAW,
    // so the move still is NOT cancelled -- but the inner clear is skipped, so
    // FREEZE remains set. Transcribed as written, not as expected.
    expect(out.actions[0].cancelledBy).toBeNull()
    expect(state.battlers[0]!.mon.status1 & STATUS1_FREEZE).toBe(STATUS1_FREEZE)
  })
})

describe('executeTurn: attack canceller -- paralysis (CANCELLER_PARALYSED, battle_util.c:3400-3413)', () => {
  it('is fully paralyzed on a 1-in-4 draw (Random() % 4 === 0)', () => {
    const state = battle([{ spe: 200, status1: STATUS1_PARALYSIS }, { spe: 50 }], scripted(4)) // 4 % 4 === 0
    const dmg = fixedDamage(10)
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(dmg))
    expect(out.actions[0].cancelledBy).toBe('PARALYSIS')
    expect(dmg.calls).toBe(0)
    expect(state.battlers[0]!.round.prlzImmobility).toBe(true)
  })

  it('acts normally on the other 3-in-4 (Random() % 4 !== 0)', () => {
    const state = battle([{ spe: 200, status1: STATUS1_PARALYSIS }, { spe: 50 }], scripted(1, 50)) // 1 % 4 !== 0, then accuracy draw
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(out.actions[0].cancelledBy).toBeNull()
    expect(out.actions[0].targetDamage).toBe(10)
  })
})

describe('executeTurn: attack canceller -- confusion (CANCELLER_CONFUSED, battle_util.c:3368-3399; enum value 20, not its source position)', () => {
  it('wears off when the counter reaches zero and acts this turn, with no self-hit draw', () => {
    const state = battle([{ spe: 200, status2: setCounter(0, STATUS2_CONFUSION, 1) }, { spe: 50 }], scripted(50)) // only the accuracy draw
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(out.actions[0].cancelledBy).toBeNull()
    expect(out.actions[0].targetDamage).toBe(10)
    expect(state.battlers[0]!.mon.status2 & STATUS2_CONFUSION).toBe(0)
  })

  it('self-hits on a 1-in-3 draw (Random() % 3 === 0), deducting no PP and dealing no target damage', () => {
    const state = battle([{ spe: 200, status2: setCounter(0, STATUS2_CONFUSION, 2), pp: [10, 0, 0, 0] }, { spe: 50 }], scripted(3)) // 3 % 3 === 0
    const dmg = fixedDamage(10)
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(dmg))
    expect(out.actions[0].cancelledBy).toBe('CONFUSION')
    expect(out.actions[0].targetDamage).toBeNull()
    expect(out.actions[0].confusionSelfHitDamage).toBeNull() // gapped, not computed -- see attackCanceller.ts
    expect(dmg.calls).toBe(0)
    expect(state.battlers[0]!.mon.pp[0]).toBe(10)
    expect(state.battlers[0]!.round.confusionSelfDmg).toBe(true)
    expect(state.battlers[0]!.mon.status2 & STATUS2_CONFUSION).toBe(1) // decremented, still confused
    expect(out.actions[0].unmodelled.some((u) => u.startsWith("CANCELLER_CONFUSED's self-hit damage"))).toBe(true)
  })

  it('acts through confusion on the other 2-in-3 (Random() % 3 !== 0), with the gap line absent', () => {
    const state = battle([{ spe: 200, status2: setCounter(0, STATUS2_CONFUSION, 2) }, { spe: 50 }], scripted(1, 50)) // 1 % 3 !== 0, then accuracy
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(out.actions[0].cancelledBy).toBeNull()
    expect(out.actions[0].targetDamage).toBe(10)
    expect(out.actions[0].unmodelled.some((u) => u.startsWith("CANCELLER_CONFUSED's self-hit damage"))).toBe(false)
  })
})

describe('executeTurn: attack canceller -- flinch (CANCELLER_FLINCH, battle_util.c:3305-3314)', () => {
  it('a flinched attacker does not move and draws/deducts nothing', () => {
    const state = battle([{ spe: 200, pp: [10, 0, 0, 0], status2: STATUS2_FLINCHED }, { spe: 50 }], scripted(85, 42))
    const dmg = fixedDamage(10)
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(dmg))
    expect(out.actions[0].cancelledBy).toBe('FLINCH')
    expect(dmg.calls).toBe(0)
    expect(state.battlers[0]!.mon.pp[0]).toBe(10)
    expect(state.battlers[0]!.round.flinchImmobility).toBe(true)
  })
})

describe('executeTurn: attack canceller -- Truant (CANCELLER_TRUANT, battle_util.c:3281-3293)', () => {
  it('a loafing Truant user (abilityState nonzero on its ability slot) is cancelled for a non-status move', () => {
    const state = battle([{ spe: 200, pp: [10, 0, 0, 0], abilities: { ability: TRUANT, innates: [null, null, null] } }, { spe: 50 }], scripted(85))
    state.battlers[0]!.volatiles.abilityState[0] = 1
    const dmg = fixedDamage(10)
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(dmg))
    expect(out.actions[0].cancelledBy).toBe('TRUANT')
    expect(dmg.calls).toBe(0)
    expect(state.battlers[0]!.mon.pp[0]).toBe(10)
  })

  it('a non-loafing Truant user (abilityState 0, the sim default) is not cancelled', () => {
    const state = battle([{ spe: 200, abilities: { ability: TRUANT, innates: [null, null, null] } }, { spe: 50 }], scripted(50))
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(out.actions[0].cancelledBy).toBeNull()
    expect(out.actions[0].targetDamage).toBe(10)
  })

  it('a status move is never Truant-cancelled, even while loafing', () => {
    const state = battle([{ spe: 200, abilities: { ability: TRUANT, innates: [null, null, null] }, moves: ['MOVE_POISON_POWDER', null, null, null] }, { spe: 50 }], scripted(50))
    state.battlers[0]!.volatiles.abilityState[0] = 1
    const out = executeTurn(state, [useMove(1, POISON_POWDER), null], deps(fixedDamage(10)))
    expect(out.actions[0].cancelledBy).toBeNull()
  })
})

describe('executeTurn: attack canceller -- gapped branches, only emitted when actually hit', () => {
  it('gaps CANCELLER_POWDER_MOVE by name only when the move is powderAffected and targets someone else', () => {
    const withPowder = battle([{ spe: 200, moves: ['MOVE_POISON_POWDER', null, null, null] }, { spe: 50 }], scripted(50))
    const out = executeTurn(withPowder, [useMove(1, POISON_POWDER), null], deps(fixedDamage(10)))
    expect(out.actions[0].unmodelled.some((u) => u.startsWith('CANCELLER_POWDER_MOVE'))).toBe(true)

    const withoutPowder = battle([{ spe: 200 }, { spe: 50 }], scripted(50))
    const out2 = executeTurn(withoutPowder, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(out2.actions[0].unmodelled.some((u) => u.startsWith('CANCELLER_POWDER_MOVE'))).toBe(false)
  })

  it('gaps CANCELLER_POWDER_STATUS by name only when the attacker carries STATUS2_POWDER and uses a Fire move', () => {
    const withPowder = battle([{ spe: 200, status2: STATUS2_POWDER, moves: ['MOVE_EMBER', null, null, null] }, { spe: 50 }], scripted(50))
    const out = executeTurn(withPowder, [useMove(1, EMBER), null], deps(fixedDamage(10)))
    expect(out.actions[0].unmodelled.some((u) => u.startsWith('CANCELLER_POWDER_STATUS'))).toBe(true)

    const nonFireMove = battle([{ spe: 200, status2: STATUS2_POWDER }, { spe: 50 }], scripted(50))
    const out2 = executeTurn(nonFireMove, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(out2.actions[0].unmodelled.some((u) => u.startsWith('CANCELLER_POWDER_STATUS'))).toBe(false)
  })
})

const TWINEEDLE = requireMove('MOVE_TWINEEDLE') // one of the six hitCountOverride moves, gapped -- see attackCanceller.ts header
const BEAT_UP = requireMove('MOVE_BEAT_UP')

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
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    ...overrides,
  }
}

describe('executeTurn: attack canceller -- CANCELLER_MULTIHIT_MOVES (battle_util.c:3491-3541, GetMultihitType :3568-3605), ported fix cycle 6', () => {
  it('MULTIHIT_TWO_TO_FIVE draws two values, consumed AFTER the canceller status draws and BEFORE the accuracy draw, and sets multiHitCounter to the C formula', () => {
    const rec = counterRecorder()
    // No status conditions, so the ladder falls straight through to the
    // multi-hit step with zero status draws first. 1 and 3 are the two
    // hit-count draws (2 + 1%2 + 2*(3%3==0) = 5); 50 is the accuracy draw.
    const state = battle([{ spe: 200 }, { spe: 50 }], scripted(1, 3, 50))
    const out = executeTurn(state, [useMove(1, ARM_THRUST), null], deps(rec))
    expect(rec.seen[0]).toBe(5)
    expect(out.actions[0].missed).toBe(false) // proves the 3rd scripted value (50) was consumed by accuracy, not a 3rd hit-count draw
    expect(out.actions[0].targetDamage).toBe(10)
  })

  it('MULTIHIT_TWO_TO_FIVE: the other draw pair (0, 1) rolls a hit count of 2', () => {
    const rec = counterRecorder()
    const state = battle([{ spe: 200 }, { spe: 50 }], scripted(0, 1, 50)) // 2 + 0%2 + 2*(1%3==0) = 2
    executeTurn(state, [useMove(1, ARM_THRUST), null], deps(rec))
    expect(rec.seen[0]).toBe(2)
  })

  it('MULTIHIT_FOUR_OR_FIVE (Loaded Dice) draws exactly ONE value, not the two-draw formula', () => {
    const rec = counterRecorder()
    const state = battle([{ spe: 200, itemId: 'ITEM_LOADED_DICE' }, { spe: 50 }], scripted(1, 50)) // 4 + 1%2 = 5, then accuracy
    const out = executeTurn(state, [useMove(1, ARM_THRUST), null], deps(rec))
    expect(rec.seen[0]).toBe(5)
    expect(out.actions[0].missed).toBe(false) // proves only ONE draw was consumed before accuracy's 50
  })

  it('MULTIHIT_FOUR_OR_FIVE (Loaded Dice): a 0 draw rolls a hit count of 4', () => {
    const rec = counterRecorder()
    const state = battle([{ spe: 200, itemId: 'ITEM_LOADED_DICE' }, { spe: 50 }], scripted(0, 50))
    executeTurn(state, [useMove(1, ARM_THRUST), null], deps(rec))
    expect(rec.seen[0]).toBe(4)
  })

  it('Skill Link sets multiHitCounter to 5 with NO RNG draw at all', () => {
    const rec = counterRecorder()
    const state = battle([{ spe: 200, abilities: { ability: SKILL_LINK, innates: [null, null, null] } }, { spe: 50 }], scripted(50)) // ONLY the accuracy draw
    const out = executeTurn(state, [useMove(1, ARM_THRUST), null], deps(rec))
    expect(rec.seen[0]).toBe(5)
    expect(out.actions[0].missed).toBe(false) // proves the single scripted value (50) was consumed by accuracy, not a hit-count draw
  })

  it('a single-hit move (Tackle) never sets multiHitCounter and draws nothing for it', () => {
    const rec = counterRecorder()
    const state = battle([{ spe: 200 }, { spe: 50 }], scripted(50)) // ONLY the accuracy draw
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(rec))
    expect(rec.seen[0]).toBe(0)
    expect(out.actions[0].missed).toBe(false)
  })

  it('MULTIHIT_BEAT_UP counts the attacker\'s own live, non-statused party (no RNG draw)', () => {
    const rec = counterRecorder()
    // The C's own loop (battle_script_commands.c:1030-1038) iterates the whole
    // PARTY_SIZE array with no exclusion for the active battler's own slot --
    // two of these five pass the HP/species/status filter, so 2 is the count,
    // not a headline-count-plus-one.
    const party: SimPartyMon[] = [
      partyMon(), // live -- counted (this is also the active battler's own party record)
      partyMon({ hp: 0 }), // fainted -- excluded
      partyMon({ speciesId: null }), // empty slot -- excluded
      partyMon({ status1: STATUS1_PARALYSIS }), // statused -- excluded
      partyMon(), // live -- counted
    ]
    const state = battle([{ spe: 200 }, { spe: 50 }], scripted(50), party)
    const out = executeTurn(state, [useMove(1, BEAT_UP), null], deps(rec))
    expect(rec.seen[0]).toBe(2)
    expect(out.actions[0].missed).toBe(false) // proves the single scripted value (50) was consumed by accuracy, not a draw
  })

  it('gaps hitCountOverride by name only for the six moves.json cannot represent, absent for an ordinary EFFECT_MULTI_HIT move', () => {
    const rec = counterRecorder()
    const withOverride = battle([{ spe: 200, moves: ['MOVE_TWINEEDLE', null, null, null] }, { spe: 50 }], scripted(50))
    const out = executeTurn(withOverride, [useMove(1, TWINEEDLE), null], deps(rec))
    expect(out.actions[0].unmodelled.some((u) => u.startsWith('MOVE_TWINEEDLE'))).toBe(true)
    expect(rec.seen[0]).toBe(0) // the override itself is not applied, per the gap

    const withoutOverride = battle([{ spe: 200 }, { spe: 50 }], scripted(1, 3, 50))
    const out2 = executeTurn(withoutOverride, [useMove(1, ARM_THRUST), null], deps(rec))
    expect(out2.actions[0].unmodelled.some((u) => u.startsWith('MOVE_'))).toBe(false)
  })
  it('TurnStructsClear (battle_util.c:856): a multi-hit move\'s counter does not leak into the next turn\'s single-hit move', () => {
    const rec = counterRecorder()
    const state = battle([{ spe: 200, moves: ['MOVE_ARM_THRUST', 'MOVE_TACKLE', null, null] }, { spe: 50 }], scripted(1, 3, 50, 50))
    executeTurn(state, [useMove(1, ARM_THRUST), null], deps(rec))
    expect(state.battlers[0]!.turn.multiHitCounter).toBe(0) // cleared after the action, as ZERO(gTurnStructs) does
    executeTurn(state, [useMove(1, TACKLE), null], deps(rec))
    expect(rec.seen).toEqual([5, 0])
  })
})
