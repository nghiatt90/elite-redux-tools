/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 156b: FaintClearSetData's cross-battler wrap release
// (battle_main.c:2957-2962, reached from cleareffectsonfaint in
// BattleScript_FaintAttacker/FaintTarget). A battler whose wrapper faints
// mid-turn loses STATUS2_WRAPPED before the end-turn ladder, so ENDTURN_WRAP
// does not damage it a final time. Cycle 156 only ported the switch-out half
// (switchIn.ts, battle_main.c:2844-2847); this file covers the faint half.
//
// Setup (borrowed from cycle156WrapPressure.test.ts): battler 1 holds the
// grappler ability Tentalock and lands a contact move, which wraps battler 0
// with wrapTurns = 5 + 1 (moveEnd.ts, battle_script_commands.c:2300-2309).
// ENDTURN_WRAP then bills maxHP / 6 = trunc(235 / 6) = 39 (battle_util.c:2680-2685)
// on each remaining turn. The RNG stream returns 1 for every draw: accuracy
// 1%100=1 < 100 (hit), crit 1%24=1 (no crit), ability `Random() % 2 !== 0` true.
import { describe, expect, it } from 'vitest'

import { STATUS2_WRAPPED, hasFlag } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import type { RandomSource } from './state'

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
 * end-turn HP arithmetic. */
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

/** Sets a battler's HP both on the active mon and its party slot (endTurn.ts's
 * applyEndTurnHp calls syncPartyHp). */
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

/** Battler 1 wraps battler 0 with Tentalock. Two foe mons so the battle
 * continues after battler 1 faints on the second turn and the end-turn ladder
 * still runs. */
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

/** KOs battler 1 through the real turn path: the player's Tackle lands on a
 * foe left at 1 HP while the foe passes (a second foe mon is in reserve, so
 * the battle continues into the end-turn ladder). */
function koWrapper(s: BattleSession) {
  setHp(s, 1, 1)
  const hpBefore = s.state.battlers[0]!.mon.hp
  const step = stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_TACKLE'), null)
  return { step, hpBefore }
}

describe('cycle 156b - a fainting wrapper releases the wrap', () => {
  it('the wrapper fainting mid-turn clears STATUS2_WRAPPED and skips ENDTURN_WRAP', () => {
    const s = wrappedByFoe()
    const { step, hpBefore } = koWrapper(s)

    // Battler 1 fainted during the turn (it is already replaced by the reserve,
    // partyIndex 1, which is why the end-turn ladder still ran).
    expect(step.outcome.actions.some((a) => a.fainted.includes(1))).toBe(true)
    expect(s.state.battlers[1]!.partyIndex).toBe(1)
    // FaintClearSetData, battle_main.c:2957-2962: the bit is cleared at faint time.
    expect(hasFlag(s.state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
    // Released before the end-turn ladder: no -39 WRAP tick on battler 0.
    expect(step.outcome.endTurn.some((e) => e.battlerId === 0 && e.effect === 'WRAP')).toBe(false)
    expect(s.state.battlers[0]!.mon.hp).toBe(hpBefore)
  })

  it('a wrap by a different battler survives the faint (wrappedBy guard)', () => {
    const s = wrappedByFoe()
    // Only battler 1 is the real wrapper; claiming battler 0 keeps the bit set.
    s.state.wrappedBy[0] = 0

    koWrapper(s)

    expect(hasFlag(s.state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
  })
})
