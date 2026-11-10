/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 156:
//   1. Grip Pincer / World Serpent / Serpent Bind / Tentalock and Itchy Defense now
//      write gBattleStruct->wrappedMove/wrappedBy (abilities.cc:4702-4703,
//      12037-12038, 6165-6166). Before this, wrappedBy defaulted to 0, so a
//      foe-side wrapper (battler 1) was read as battler 0 by ENDTURN_WRAP's
//      grappler/Binding Band check (battle_util.c:2680-2685) and by the
//      Serpent Bind / Tentalock / Chokehold end-turn Speed drop (endTurn.ts:1310).
//   2. SwitchInClearSetData releases STATUS2_WRAPPED when the wrapper switches
//      out (battle_main.c:2844-2847).
//   3. Pressure's PP surcharge goes through IsSuppressed (battle_util.c:9255-9260).
//
// Every number is hand-derived from the pinned C; the arithmetic is in the
// comments. The RNG stream returns 1 for every draw: accuracy 1%100=1 < 100 (hit),
// crit 1%24=1 (no crit), ability `Random() % 2 !== 0` true. WrapDuration then
// reads `Random() % 2 + 4` only for a non-grappler wrapper with no Grip Claw
// (battle_script_commands.c:2300-2310); Tentalock is a grappler, so no draw.
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STAT_STAGE,
  STAT_SPEED,
  STATUS2_WRAPPED,
  STATUS3_GASTRO_ACID,
  hasFlag,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import {
  buildMoveAction,
  createSession,
  groundingFor,
  stepTurn,
  type BattleSession,
} from './driver/session'
import { canBattlerEscape } from './escape'
import type { RandomSource } from './state'
import type { ChosenAction } from './turnOrder'

const data = loadSimData()

/** The all-ones stream described in the file header. */
function onesRng(): RandomSource {
  return { random16: () => 1 }
}

function foeMon(species: string, ability: string, moves: string[], item = 'ITEM_NONE'): TrainerMonData {
  return {
    species,
    item,
    nature: 'NATURE_HARDY',
    ability,
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    moves,
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

/** SPECIES_MUDKIP's species abilities/innates are replaced with null so no
 * onEntry innate (Water Veil sets Aqua Ring, abilityHooks.json) perturbs the
 * end-turn HP arithmetic. buildPlayerParty resolves the party BEFORE the
 * session exists, so the battle-start pass sees the neutral slot too. */
function playerParty(moveIds: string[], count = 1) {
  const party = buildPlayerParty(
    Array.from({ length: count }, () => ({ species: 'SPECIES_MUDKIP', level: 50, moves: moveIds })),
    50,
    data,
  )
  for (const slot of party) slot.abilities = { ability: null, innates: [null, null, null] }
  return party
}

function session(foeMons: TrainerMonData[], playerMoves: string[] = ['MOVE_TACKLE'], playerCount = 1): BattleSession {
  return createSession({
    data,
    playerParty: playerParty(playerMoves, playerCount),
    opponentTrainer: trainer(foeMons),
    rng: onesRng(),
  })
}

/** Sets a battler's HP both on the active mon and its party slot, the same way
 * cycle139StatusTerms.test.ts's patchMon does (endTurn.ts's applyEndTurnHp
 * calls syncPartyHp). */
function setHp(s: BattleSession, battlerId: number, hp: number): void {
  const battler = s.state.battlers[battlerId]!
  battler.mon.hp = hp
  battler.mon.maxHp = hp
  const slot = s.state.sides[battlerId & 1].party[battler.partyIndex]
  if (slot) {
    slot.hp = hp
    slot.maxHp = hp
  }
}

function setActiveAbility(s: BattleSession, battlerId: number, ability: string | null): void {
  const battler = s.state.battlers[battlerId]!
  battler.mon.abilities = { ability, innates: [null, null, null] }
  const slot = s.state.sides[battlerId & 1].party[battler.partyIndex]
  if (slot) slot.abilities = { ability, innates: [null, null, null] }
}

const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }

describe('cycle 156 - Grip Pincer family writes wrappedBy/wrappedMove', () => {
  // Tentalock on the FOE side (battler 1). The sim's move-end attacker half is
  // the attacker; the C's `battler` is the holder, `target` the wrapped mon
  // (abilities.cc:12025-12038), so wrappedBy[0] must be 1, not the default 0.
  // ENDTURN_WRAP (battle_util.c:2680-2685): the wrapper has the grappler
  // ability flag (Tentalock is in GRAPPLER_ABILITIES), so maxHP / 6 =
  // trunc(235 / 6) = trunc(39.16) = 39. Tentalock's onEndTurn (:12008-12024)
  // then lowers the wrapped battler's Speed one stage (6 -> 5).
  it('Tentalock on the foe side wraps the player: wrappedBy 1, maxHP/6 = 39, Speed -1', () => {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_TENTALOCK', ['MOVE_TACKLE'])])
    setHp(s, 0, 235)
    const step = stepTurn(s, null, buildMoveAction(s.state, data, 1, 'MOVE_TACKLE'))

    expect(hasFlag(s.state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
    expect(s.state.wrappedBy[0]).toBe(1)
    expect(s.state.wrappedMove[0]).toBe('MOVE_TACKLE')

    const wrap = step.outcome.endTurn.find((e) => e.battlerId === 0 && e.effect === 'WRAP')
    expect(wrap?.hpChange).toBe(-39) // trunc(235 / 6)
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  // Grip Pincer is NOT a grappler ability and the wrapper holds nothing:
  // battle_util.c:2680-2685 falls to maxHP / 8 = trunc(235 / 8) = trunc(29.37) = 29.
  it('Grip Pincer from the foe side gives maxHP/8 = 29', () => {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_GRIP_PINCER', ['MOVE_TACKLE'])])
    setHp(s, 0, 235)
    const step = stepTurn(s, null, buildMoveAction(s.state, data, 1, 'MOVE_TACKLE'))

    expect(s.state.wrappedBy[0]).toBe(1)
    expect(s.state.wrappedMove[0]).toBe('MOVE_TACKLE')
    const wrap = step.outcome.endTurn.find((e) => e.battlerId === 0 && e.effect === 'WRAP')
    expect(wrap?.hpChange).toBe(-29) // trunc(235 / 8)
  })

  // Same wrap, wrapper holds Binding Band: battle_util.c:2682's second
  // disjunct yields maxHP / 6 = trunc(235 / 6) = 39.
  it('Grip Pincer with Binding Band gives maxHP/6 = 39', () => {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_GRIP_PINCER', ['MOVE_TACKLE'], 'ITEM_BINDING_BAND')])
    setHp(s, 0, 235)
    const step = stepTurn(s, null, buildMoveAction(s.state, data, 1, 'MOVE_TACKLE'))

    expect(s.state.wrappedBy[0]).toBe(1)
    const wrap = step.outcome.endTurn.find((e) => e.battlerId === 0 && e.effect === 'WRAP')
    expect(wrap?.hpChange).toBe(-39) // trunc(235 / 6)
  })
})

describe('cycle 156 - Itchy Defense writes wrappedBy/wrappedMove', () => {
  // Itchy Defense is ON_DEFENDER: the C's `battler` is the holder (the sim's
  // defender, targetId 1) and `attacker` is the mon that gets wrapped
  // (abilities.cc:6154-6168), so wrappedMove[0] = MOVE_INFESTATION and
  // wrappedBy[0] = 1. The holder is also given the Tentalock grappler innate:
  // runWrap reads the WRAPPER's (defender's) grappler flag for the divisor
  // (battle_util.c:2680-2685), giving maxHP / 6 = trunc(235 / 6) = 39 rather
  // than the non-grappler 29.
  it('a contacted defender wraps the attacker with MOVE_INFESTATION, maxHP/6 via its grappler', () => {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_ITCHY_DEFENSE', ['MOVE_TACKLE'])])
    setHp(s, 0, 235)
    // Give the DEFENDER the grappler innate; patched before the turn so the
    // move-end handler and runWrap both see it.
    const foe = s.state.battlers[1]!
    foe.mon.abilities = { ability: 'ABILITY_ITCHY_DEFENSE', innates: ['ABILITY_TENTALOCK', null, null] }
    const foeSlot = s.state.sides[1].party[foe.partyIndex]!
    foeSlot.abilities = { ability: 'ABILITY_ITCHY_DEFENSE', innates: ['ABILITY_TENTALOCK', null, null] }

    const step = stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_TACKLE'), null)

    expect(hasFlag(s.state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
    expect(s.state.wrappedBy[0]).toBe(1)
    expect(s.state.wrappedMove[0]).toBe('MOVE_INFESTATION')
    const wrap = step.outcome.endTurn.find((e) => e.battlerId === 0 && e.effect === 'WRAP')
    expect(wrap?.hpChange).toBe(-39) // trunc(235 / 6)
  })
})

describe('cycle 156 - wrap release on the wrapper switching out', () => {
  // battle_main.c:2844-2847: for every battler i, if
  // (status2 & STATUS2_WRAPPED) && wrappedBy[i] == gActiveBattler, clear the bit.
  // Only the bit is cleared; wrapTurns/wrapAbility are untouched (the C does
  // exactly that).
  function wrappedByFoe(): BattleSession {
    const s = session([
      foeMon('SPECIES_MAGIKARP', 'ABILITY_TENTALOCK', ['MOVE_TACKLE']),
      foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']),
    ])
    setHp(s, 0, 235)
    stepTurn(s, null, buildMoveAction(s.state, data, 1, 'MOVE_TACKLE'))
    expect(hasFlag(s.state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
    expect(s.state.wrappedBy[0]).toBe(1)
    return s
  }

  it('the foe switching out releases the player wrap and the trap', () => {
    const s = wrappedByFoe()
    const escapeDeps = { dataContext: data.dataContext, grounding: groundingFor(data, s.state) }
    // escape.ts:101: STATUS2_WRAPPED blocks CanBattlerEscape before the release.
    expect(canBattlerEscape(s.state, 0, escapeDeps)).toBe(false)

    const step = stepTurn(s, null, switchAction)

    expect(hasFlag(s.state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
    expect(s.state.battlers[1]!.partyIndex).toBe(1)
    // Released before the end-turn ladder, so ENDTURN_WRAP does not run.
    expect(step.outcome.endTurn.some((e) => e.battlerId === 0 && e.effect === 'WRAP')).toBe(false)
    // escape.ts:101 no longer blocks the once-wrapped mon.
    expect(canBattlerEscape(s.state, 0, escapeDeps)).toBe(true)
  })

  // Negative control for the wrappedBy guard: the wrap is recorded as being by
  // battler 0 (in singles the only possible non-switching id), so battler 1's
  // switch-in must NOT clear it.
  it('a wrap by a different battler is not released by the switch', () => {
    const s = wrappedByFoe()
    s.state.wrappedBy[0] = 0

    stepTurn(s, null, switchAction)

    expect(hasFlag(s.state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
  })
})

describe('cycle 156 - Pressure uses the suppression-aware check', () => {
  // Cmd_ppreduce, battle_script_commands.c:1474:
  //   !BATTLER_HAS_ABILITY(gBattlerAttacker, ABILITY_PRESSURE)
  //   && IsAbilityOnOpposingSide(gBattlerAttacker, ABILITY_PRESSURE)
  // IsAbilityOnOpposingSide -> IsAbilityOnSide -> BATTLER_HAS_ABILITY_AND_ALIVE(...,
  // TRUE) (battle_util.c:4792-4799) -> IsSuppressed (battle_util.c:9255-9260):
  //   (checkMoldBreaker && battler != gBattlerAttacker && HITMARKER_MOLD_BREAKER
  //    && gAbilities[ability].breakable)
  //   || ((gFieldTimers.neutralizingGas || gStatuses3[battler] & STATUS3_GASTRO_ACID)
  //       && !IsUnsuppressableAbility(ability))
  // then !DoesBattlerHaveAbilityShield(battler).
  // Pressure has no `.breakable` (abilities.cc:1090-1106, and abilityHooks.json's
  // ABILITY_PRESSURE has bitfields {}), so the mold-breaker clause never fires;
  // Gastro Acid / Neutralizing Gas DO suppress it.
  function pressureTurn(opts: { gastroAcid?: boolean; neutralizingGas?: boolean; moldBreaker?: boolean } = {}) {
    const s = session([foeMon('SPECIES_MAGIKARP', 'ABILITY_PRESSURE', ['MOVE_TACKLE'])])
    if (opts.gastroAcid) s.state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    if (opts.neutralizingGas) s.state.field.timers.neutralizingGas = true
    if (opts.moldBreaker) setActiveAbility(s, 0, 'ABILITY_MOLD_BREAKER')
    const before = s.state.battlers[0]!.mon.pp[0]!
    const step = stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_TACKLE'), null)
    const after = s.state.battlers[0]!.mon.pp[0]!
    const pressureNotes = step.unmodelled.filter((n) => n.includes("Pressure's mold-breaker suppression"))
    return { before, after, pressureNotes }
  }

  it('an unsuppressed opposing Pressure costs 2 PP', () => {
    const { before, after, pressureNotes } = pressureTurn()
    expect(before - after).toBe(2)
    expect(pressureNotes).toEqual([])
  })

  it('Gastro Acid suppresses the opposing Pressure: 1 PP', () => {
    const { before, after, pressureNotes } = pressureTurn({ gastroAcid: true })
    expect(before - after).toBe(1)
    expect(pressureNotes).toEqual([])
  })

  it('Neutralizing Gas suppresses the opposing Pressure: 1 PP', () => {
    const { before, after, pressureNotes } = pressureTurn({ neutralizingGas: true })
    expect(before - after).toBe(1)
    expect(pressureNotes).toEqual([])
  })

  it('a Mold Breaker attacker still pays 2: Pressure is not breakable', () => {
    const { before, after, pressureNotes } = pressureTurn({ moldBreaker: true })
    expect(before - after).toBe(2)
    expect(pressureNotes).toEqual([])
  })
})
