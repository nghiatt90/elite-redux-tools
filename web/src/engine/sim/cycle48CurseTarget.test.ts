/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 48: Ghost Curse re-targets through `getmovetarget BS_ATTACKER`.
//
// C lines checked:
//   data/battle_scripts_1.s:4969-4972  BattleScript_GhostCurse: `jumpifbytenotequal
//                                       gBattlerAttacker, gBattlerTarget` only re-targets
//                                       when the target IS the user; then `getmovetarget BS_ATTACKER`
//   src/battle_util.c:6343-6416        GetMoveTarget
//   src/battle_util.c:6353-6360        the MOVE_CURSE special case (Ghost or Fog -> SELECTED)
//   src/battle_util.c:6362-6379        the SELECTED branch (Follow Me, else SetRandomTarget)
//   src/battle_util.c:6326-6341        SetRandomTarget: doubles draws exactly one `Random() % 2`;
//                                      a dead pick flips with `^= BIT_FLANK` and is not re-checked;
//                                      singles draws nothing and takes the left foe
//
// ASSUMPTION: the `getmovetarget` opcode has no `Cmd_` handler anywhere in the pinned tree
// (a grep finds only battle_scripts_1.s:4971), so its body is not a read C fact. The port
// follows docs/battle-sim/doubles-opposite-audit.md:37,126, which reads it as
// GetMoveTarget(attacker, move, 0) with the attacker as the battler.
import { describe, expect, it } from 'vitest'

import { STAT_ATK, STAT_DEF, STAT_SPEED, STATUS2_CURSED, hasFlag } from './constants'
import { buildBattleState } from './driver/battleFormat'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { loadSimData } from './driver/loadSimData'
import { buildMoveAction, groundingFor } from './driver/session'
import type { BattleState, RandomSource, SimPartyMon } from './state'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

const data = loadSimData()
const trainer = data.trainersById.get('TRAINER_SAWYER_1')!

// Mimikyu is Ghost/Fairy, so the Curse user takes the Ghost branch through the real builder
// rather than a hand-written mon.
const SPECS = [
  { species: 'SPECIES_MIMIKYU', level: 50, moves: ['MOVE_CURSE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

const playerParty = (): SimPartyMon[] => buildPlayerParty(SPECS, 50, data)
const opponentParty = (): SimPartyMon[] => buildOpponentParty(trainer, 'elite', 50, data)

/** Scripted draws, in order, so every case names exactly what the C rolls. */
function scriptRng(values: number[]): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      const value = values[rng.calls] ?? 0
      rng.calls++
      return value
    },
  }
  return rng
}

/** All four speeds distinct so SortBattlersBySpeed's tie-break draw never fires; abilities and
 * items cleared so no ability hook or held item can add a draw to the turn. Fixture setup, not
 * an outcome. */
function normalize(state: BattleState): void {
  const speeds = [200, 180, 160, 140]
  for (let i = 0; i < state.battlersCount; i++) {
    const mon = state.battlers[i]!.mon
    mon.rawStats.spe = speeds[i]!
    mon.abilities = { ability: null, innates: [null, null, null] }
    mon.itemId = null
  }
}

function doublesState(rng: RandomSource): BattleState {
  const state = buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng },
  )
  normalize(state)
  return state
}

function singlesState(rng: RandomSource): BattleState {
  const state = buildBattleState(
    { opponents: [trainer] },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng },
  )
  normalize(state)
  return state
}

const noDamage: DamageResolver = {
  resolve: () => ({ targetDamage: 0, attackerDamage: null, unmodelled: [] }),
}

function loopDeps(state: BattleState): TurnLoopDeps {
  return {
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    grounding: groundingFor(data, state),
    damage: noDamage,
    statStageRatios: data.statStageRatios,
    dataContext: data.dataContext,
    hazardTypes: { typeChart: data.typeChart, inverseTypeChart: data.inverseTypeChart, inverseBattle: false },
  }
}

/** The sim's action builder (not a React hook), copied from cycle119: an explicit target id
 * that does NOT pass through the player controller's cursor choice. */
function useMove(target: number, moveId: string): ChosenAction {
  const m = data.dataContext.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  const view: TurnOrderMoveView = {
    id: m.id,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags,
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

const hpCost = (state: BattleState): number => Math.max(1, Math.floor(state.battlers[0]!.mon.maxHp / 2))

describe('cycle48: Ghost Curse target via getmovetarget BS_ATTACKER', () => {
  it('1a. doubles, self target, even draw: SetRandomTarget picks index 0 = battler 1, exactly one draw', () => {
    // battle_util.c:6334: Random() % 2 with an even draw takes targets[B_SIDE_PLAYER][0] = 1.
    const rng = scriptRng([0])
    const state = doublesState(rng)
    const hpBefore = state.battlers[0]!.mon.hp
    const action = buildMoveAction(state, data, 0, 'MOVE_CURSE', undefined, 0)
    expect(action.target).toBe(0)

    executeTurn(state, [action, null, null, null], loopDeps(state))

    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(hasFlag(state.battlers[3]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(state.battlers[0]!.mon.hp).toBe(hpBefore - hpCost(state))
    expect(rng.calls).toBe(1) // the single Random() % 2; no accuracy draw (:4976)
  })

  it('1b. doubles, self target, odd draw: index 1 = battler 3 is cursed, exactly one draw', () => {
    const rng = scriptRng([1])
    const state = doublesState(rng)
    const action = buildMoveAction(state, data, 0, 'MOVE_CURSE', undefined, 0)
    expect(action.target).toBe(0)

    executeTurn(state, [action, null, null, null], loopDeps(state))

    expect(hasFlag(state.battlers[3]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(rng.calls).toBe(1)
  })

  it('2. doubles, the even pick (1) is dead: `^ BIT_FLANK` flips it to battler 3 (battle_util.c:6335-6336)', () => {
    const rng = scriptRng([0])
    const state = doublesState(rng)
    state.battlers[1]!.mon.hp = 0 // scenario setup: battler 1 starts the turn fainted
    const action = buildMoveAction(state, data, 0, 'MOVE_CURSE', undefined, 0)
    expect(action.target).toBe(0)

    executeTurn(state, [action, null, null, null], loopDeps(state))

    // 1 ^ BIT_FLANK(2) = 3; the C does not re-check that the flank is alive.
    expect(hasFlag(state.battlers[3]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(rng.calls).toBe(1)
  })

  it('3. negative: an explicit target different from the user skips getmovetarget, so NO draw', () => {
    // battle_scripts_1.s:4970: jumpifbytenotequal is true (0 != 3), so :4971 never runs.
    const rng = scriptRng([0])
    const state = doublesState(rng)
    const action = buildMoveAction(state, data, 0, 'MOVE_CURSE', undefined, 3)
    expect(action.target).toBe(3)

    executeTurn(state, [action, null, null, null], loopDeps(state))

    expect(hasFlag(state.battlers[3]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('4. negative: singles with target = user draws nothing and curses the left foe (battle_util.c:6337)', () => {
    const rng = scriptRng([1]) // would pick battler 3 if any draw happened; singles must not draw
    const state = singlesState(rng)
    const hpBefore = state.battlers[0]!.mon.hp
    const action = useMove(0, 'MOVE_CURSE')
    expect(action.target).toBe(0)

    executeTurn(state, [action, null], loopDeps(state))

    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(hpBefore - hpCost(state))
    expect(rng.calls).toBe(0)
  })

  it('5. negative: a non-Ghost user keeps the Atk+1/Def+1/Spe-1 branch and never targets', () => {
    const rng = scriptRng([1])
    const state = singlesState(rng)
    state.battlers[0]!.mon.types = ['NORMAL', 'MYSTERY', 'MYSTERY'] // no Fog either
    const action = useMove(0, 'MOVE_CURSE')

    executeTurn(state, [action, null], loopDeps(state))

    const stages = state.battlers[0]!.mon.statStages
    expect(stages[STAT_SPEED]).toBe(5)
    expect(stages[STAT_ATK]).toBe(7)
    expect(stages[STAT_DEF]).toBe(7)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(rng.calls).toBe(0)
  })
})
