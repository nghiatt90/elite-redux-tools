/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 161c: every `TurnOrderMoveView` the sim builds sets `resolvedType` to
// GetTypeBeforeUsingMove's answer, not the move's declared type.
//
//   GALE_WINGS_CLONE, src/abilities.cc:126-131:
//     CHECK(GetTypeBeforeUsingMove(move, battler) == type)
//     CHECK(BATTLER_MAX_HP(battler))
//     return 1;
//   GetTypeBeforeUsingMove, src/battle_main.c:5206-5209:
//     return GetMoveTypeInternal(move, battlerAtk, &ignored, &ignored);
//   GetMoveTypeInternal, src/battle_main.c:5093-5204: the move-ID switch (Struggle,
//   Weather Ball, ...), the effect switch (Judgment/Plate, Natural Gift, Hidden
//   Power, Terrain Pulse, Fling gem, Spit Up, Revelation Dance, Synchronoise), then
//   Ion Deluge/Electrify/Plasma Fists (:5196-5198) and the onMoveType "-ate" loop
//   (:5200-5201, through ON_ABILITY's FILTER_NOT(IsSuppressed),
//   include/battle_util.h:269-275).
//   getMovePriority, web/src/engine/sim/turnOrder.ts:412, forwards the view's
//   `resolvedType` as the onPriority `moveType`, so a declared-Normal Tackle that
//   Aerilate retypes to Flying must arrive as FLYING for Gale Wings' CHECK.
//
// Every case below drives the sim's own builders (buildMoveAction, chooseAiAction,
// and executeTurn's applyLockedMove/applyEncore) rather than hand-writing a view.
// Nothing here rolls RNG for turn order; the fixed stream 1 makes every accuracy
// check hit and every crit roll miss, so damage never decides an order.
import { describe, expect, it } from 'vitest'

import { chooseAiAction } from './ai/chooseAiAction'
import { STATUS2_MULTIPLETURNS, STATUS3_GASTRO_ACID } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import type { AbilitySlots } from '../abilities/dispatch'
import type { RandomSource } from './state'
import type { ChosenAction } from './turnOrder'
import { getMovePriority } from './turnOrder'

const data = loadSimData()

/** Aerilate as the chosen ability, Gale Wings as innate 1 -- the arrangement the C
 * does not care about (ON_ABILITY scans every slot, battle_util.h:269-275) but the
 * one that exercises the innate path too. */
const AERILATE_AND_GALE_WINGS: AbilitySlots = {
  ability: 'ABILITY_AERILATE',
  innates: ['ABILITY_GALE_WINGS', null, null],
}
const GALE_WINGS_ONLY: AbilitySlots = { ability: 'ABILITY_GALE_WINGS', innates: [null, null, null] }

/** 1 makes an accuracy check hit (1 % 100 = 1), a crit miss (1 % 24 = 1) and every
 * `Random() % 2 !== 0` ability check true. Turn order draws nothing. */
function fixedRng(value = 1): RandomSource {
  return { random16: () => value }
}

function foeMon(ability = 'ABILITY_NONE'): TrainerMonData {
  return {
    species: 'SPECIES_ELECTRODE',
    item: 'ITEM_NONE',
    nature: 'NATURE_HARDY',
    ability,
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    moves: ['MOVE_TACKLE'],
    ironPill: false,
    hiddenPowerType: 'TYPE_NORMAL',
  }
}

function trainer(mons: TrainerMonData[]): TrainerData {
  return {
    ...data.trainersById.get('TRAINER_SAWYER_1')!,
    noSwitching: true,
    parties: { ace: mons, elite: mons, hell: mons },
  }
}

/** SPECIES_MUDKIP (base Speed 40) is the slow side; SPECIES_ELECTRODE (150) is the
 * faster foe, so a default-priority player moves second and a +1 priority one
 * moves first. The player's abilities are installed on the built party before
 * createSession, which clones it and gates innates (level 50 clears every Elite
 * threshold). */
function makeSession(opts: { abilities?: AbilitySlots; moves?: string[]; foeAbility?: string } = {}): BattleSession {
  const abilities = opts.abilities ?? AERILATE_AND_GALE_WINGS
  const party = buildPlayerParty([{ species: 'SPECIES_MUDKIP', level: 50, moves: opts.moves ?? ['MOVE_TACKLE'] }], 50, data)
  party[0].abilities = { ability: abilities.ability, innates: [...abilities.innates] }
  return createSession({
    data,
    playerParty: party,
    opponentTrainer: trainer([foeMon(opts.foeAbility)]),
    rng: fixedRng(),
  })
}

function setHp(s: BattleSession, battlerId: number, hp: number, maxHp: number): void {
  const battler = s.state.battlers[battlerId]!
  battler.mon.hp = hp
  battler.mon.maxHp = maxHp
  const slot = s.state.sides[battlerId & 1].party[battler.partyIndex]
  if (slot) {
    slot.hp = hp
    slot.maxHp = maxHp
  }
}

function playerAction(s: BattleSession, moveId = 'MOVE_TACKLE'): ChosenAction {
  return buildMoveAction(s.state, data, 0, moveId, s.turnDeps.damage)
}

function foeAction(s: BattleSession): ChosenAction {
  return buildMoveAction(s.state, data, 1, 'MOVE_TACKLE', s.turnDeps.damage)
}

/** The execution order, which is exactly the turn-order comparison's outcome. */
function orderOf(step: ReturnType<typeof stepTurn>): number[] {
  return step.outcome.actions.map((a) => a.battlerId)
}

describe('cycle 161c - the view builder carries GetTypeBeforeUsingMove', () => {
  it('1. Aerilate + innate Gale Wings: Tackle resolves FLYING, priority 0 + 1, slow holder acts first', () => {
    const s = makeSession()
    const action = playerAction(s)
    // gBattleMoves[MOVE_TACKLE].type is TYPE_NORMAL; GetMoveTypeInternal's onMoveType
    // loop (battle_main.c:5200-5201) sees Aerilate's ATE_ABILITY(FLYING) (:295-301).
    expect(action.chosenMove?.declaredType).toBe('NORMAL')
    expect(action.chosenMove?.resolvedType).toBe('FLYING')
    // Tackle's own priority is 0 (moves.json); GALE_WINGS_CLONE returns 1 because
    // GetTypeBeforeUsingMove == TYPE_FLYING and BATTLER_MAX_HP holds.
    expect(getMovePriority(s.state, 0, action.chosenMove!, 1)).toBe(1)

    const foe = foeAction(s)
    expect(foe.chosenMove?.resolvedType).toBe('NORMAL')
    expect(getMovePriority(s.state, 1, foe.chosenMove!, 0)).toBe(0)

    // The player is genuinely slower, so speed alone would order [1, 0].
    expect(s.state.battlers[0]!.mon.rawStats.spe).toBeLessThan(s.state.battlers[1]!.mon.rawStats.spe)
    expect(orderOf(stepTurn(s, action, foe))).toEqual([0, 1])
  })

  it('2. 99/100 HP: BATTLER_MAX_HP fails, so priority 0 and the faster foe moves first', () => {
    const s = makeSession()
    const maxHp = s.state.battlers[0]!.mon.maxHp
    setHp(s, 0, maxHp - 1, maxHp)
    const action = playerAction(s)

    // The type still resolves; only the hp == maxHp CHECK (include/battle.h:749) fails.
    expect(action.chosenMove?.resolvedType).toBe('FLYING')
    expect(getMovePriority(s.state, 0, action.chosenMove!, 1)).toBe(0)
    expect(orderOf(stepTurn(s, action, foeAction(s)))).toEqual([1, 0])
  })

  it('3. Gastro Acid drops Aerilate (ON_ABILITY FILTER_NOT(IsSuppressed)): type stays NORMAL, priority 0', () => {
    const s = makeSession()
    s.state.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    const action = playerAction(s)

    // GetMoveTypeInternal's onMoveType loop skips a suppressed ability, so the
    // declared Normal type survives -- even though the target is still at full HP.
    expect(action.chosenMove?.resolvedType).toBe('NORMAL')
    expect(action.chosenMove?.declaredType).toBe('NORMAL')
    expect(getMovePriority(s.state, 0, action.chosenMove!, 1)).toBe(0)
    expect(orderOf(stepTurn(s, action, foeAction(s)))).toEqual([1, 0])
  })

  it('4. no -ate ability: Normal Tackle stays NORMAL and Gale Wings does not fire', () => {
    const s = makeSession({ abilities: GALE_WINGS_ONLY })
    const action = playerAction(s)

    expect(action.chosenMove?.resolvedType).toBe('NORMAL')
    expect(getMovePriority(s.state, 0, action.chosenMove!, 1)).toBe(0)
    expect(orderOf(stepTurn(s, action, foeAction(s)))).toEqual([1, 0])
  })

  it('5a. turn.ts buildMoveView: a LOCKED move view also resolves its type (slow holder still acts first)', () => {
    const s = makeSession()
    s.state.battlers[0]!.mon.status2 |= STATUS2_MULTIPLETURNS
    s.state.lockedMoves[0] = 'MOVE_TACKLE'

    // chosenMove is null, so applyLockedMove builds the view through buildMoveView
    // (turn.ts:2074); the null chosen move is not a view the test wrote.
    const locked: ChosenAction = { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: null, target: 1 }
    expect(orderOf(stepTurn(s, locked, foeAction(s)))).toEqual([0, 1])
  })

  it('5b. turn.ts moveViewFor: an ENCORED move view resolves its type (slow holder still acts first)', () => {
    const s = makeSession({ moves: ['MOVE_TACKLE', 'MOVE_GROWL'] })
    const battler = s.state.battlers[0]!
    battler.volatiles.encoredMove = 'MOVE_TACKLE'
    battler.volatiles.encoredMovePos = 0

    // The player picks Growl; applyEncore (turn.ts:2030+) replaces it with the
    // encored slot's move through moveViewFor, and turn order reads that view.
    const growl = playerAction(s, 'MOVE_GROWL')
    expect(growl.chosenMove?.id).toBe('MOVE_GROWL')
    expect(orderOf(stepTurn(s, growl, foeAction(s)))).toEqual([0, 1])
  })

  it('6. chooseAiAction: the AI view applies the -ate subset (Aerilate Tackle -> FLYING)', () => {
    const s = makeSession({ foeAbility: 'ABILITY_AERILATE' })
    const { action } = chooseAiAction(s.state, 1, s.chooseAiDeps)

    expect(action.action).toBe('USE_MOVE')
    expect(action.chosenMove?.id).toBe('MOVE_TACKLE')
    expect(action.chosenMove?.declaredType).toBe('NORMAL')
    expect(action.chosenMove?.resolvedType).toBe('FLYING')
  })

  it('7. chooseAiAction: Gastro Acid on the AI holder keeps its view type NORMAL', () => {
    const s = makeSession({ foeAbility: 'ABILITY_AERILATE' })
    s.state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    const { action } = chooseAiAction(s.state, 1, s.chooseAiDeps)

    // GetMoveTypeInternal's onMoveType loop skips a suppressed ability
    // (FILTER_NOT(IsSuppressed), include/battle_util.h:269-275), so the raw
    // ABILITY_AERILATE slot must not retype Tackle -- the same answer case 3
    // gets through the player-side builder.
    expect(action.action).toBe('USE_MOVE')
    expect(action.chosenMove?.id).toBe('MOVE_TACKLE')
    expect(action.chosenMove?.declaredType).toBe('NORMAL')
    expect(action.chosenMove?.resolvedType).toBe('NORMAL')
  })
})
