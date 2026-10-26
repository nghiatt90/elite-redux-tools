// The data bundle's grounding.holdEffectOf used to be `() => null`, so every held-item effect read through it was off in
// every driver run. The session now binds it to the live state (GetBattlerHoldEffect(battler, TRUE), battle_util.c:6526).
import { expect, it } from 'vitest'
import { loadSimData } from './loadSimData'
import { buildPlayerParty } from './buildParty'
import { createRandomSource } from '../rng'
import { cloneSession, createSession } from './session'
import { STATUS3_EMBARGO } from '../constants'

function lifeOrbSession() {
  const data = loadSimData()
  const party = buildPlayerParty(
    [{ species: 'SPECIES_PINSIR', level: 50, nature: 'NATURE_ADAMANT', evs: { hp: 252, atk: 252 }, ability: 'ABILITY_HYPER_CUTTER', item: 'ITEM_LIFE_ORB', moves: ['MOVE_TACKLE', null, null, null] }],
    50,
    data,
  )
  return createSession({ data, playerParty: party, opponentTrainer: data.trainersById.get('TRAINER_SAWYER_1')!, rng: createRandomSource(1) })
}

it('the session reads the held item\'s hold effect from the live state', () => {
  const session = lifeOrbSession()
  expect(session.turnDeps.grounding.holdEffectOf(0)).toBe('HOLD_EFFECT_LIFE_ORB')
  session.state.battlers[0]!.mon.itemId = null
  expect(session.turnDeps.grounding.holdEffectOf(0)).toBeNull()
})

it('Embargo negates the hold effect (IsItemNegated)', () => {
  const session = lifeOrbSession()
  session.state.battlers[0]!.statuses3 |= STATUS3_EMBARGO
  expect(session.turnDeps.grounding.holdEffectOf(0)).toBeNull()
})

it('a cloned session reads its own state, not the original\'s', () => {
  const session = lifeOrbSession()
  const copy = cloneSession(session, 7)
  copy.state.battlers[0]!.mon.itemId = null
  expect(copy.turnDeps.grounding.holdEffectOf(0)).toBeNull()
  expect(session.turnDeps.grounding.holdEffectOf(0)).toBe('HOLD_EFFECT_LIFE_ORB')
})
