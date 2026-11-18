/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 5a: FLAG_SYS_INVERSE_BATTLE reaches the sim, and encounters.json's three
// scripted-fight lists load.
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/):
//   battle_util.c:8021-8031  GetTypeModifier: `int inverted = IsInverseRoomActive(); ...
//                            if (B_FLAG_INVERSE_BATTLE != 0 && FlagGet(B_FLAG_INVERSE_BATTLE))
//                            inverted = !inverted; ... if (inverted) ret =
//                            sInverseTypeEffectivenessTable[atkType][defType]; else ret =
//                            sTypeEffectivenessTable[atkType][defType];`
//                            (the FlagGet itself is battle_util.c:8028)
//   battle_ai_main.c:599-601 "check if negates type": `case AI_EFFECTIVENESS_x0:
//                            RETURN_SCORE_MINUS(20)` -- the AI's no-effect penalty.
//
// Damage shortcut, derived from the level-50 formula: with Attack == Defense == 100
// the fixed-point damage is `((2*50/5+2) * power * 100 / 100) / 50 + 2` = `22*power/50 + 2`.
// For MOVE_AQUA_JET (power 40) that is 17 + 2 = 19 before type effectiveness. The two
// chart cells below are read straight out of data/v2.65beta/types.json and
// typesInverse.json: WATER->FIRE is 2.0 normal / 0.5 inverse, so 19 * 2 = 38 and
// 19 * 0.5 = 9.5, which applyModifier (fixed.ts) rounds to nearest with UQ_ROUND and
// floors -> 10. WATER->NORMAL is 1.0 in both charts, so both sessions deal 19. A roll
// of 0 selects the 100% entry (damageResolver.ts draws `random16() % 16` and indexes
// `values[15 - roll]`), and `critRoll: 1` keeps the crit draw out of the comparison.

import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { isInverseBattleTrainer, loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import type { BattleSession } from './driver/session'
import { aiDamageDepsFor, buildMoveAction, cloneSession, createSession } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { defaultStatStages } from './state'
import { computeBattleAiScores } from './ai/aiPipeline'
import { AI_FLAG_CHECK_BAD_MOVE } from './ai/aiFlags'

const data = loadSimData()
const trainer = data.trainersById.get('TRAINER_BRENDEN')!
const PLAYER_SPECS = [{ species: 'SPECIES_TREECKO', level: 50, moves: ['MOVE_AQUA_JET'] }]

function blankAbilities(): SimBattleMon['abilities'] {
  return { ability: null, innates: [null, null, null] }
}

/** A singles session with both active mons replaced by a controlled Attack == Defense == 100
 * pair. `defenderType` is the whole first type slot; the other two stay MYSTERY, which
 * distinctDefendingTypes drops. */
function makeSession(inverseBattle: boolean, defenderType: string): BattleSession {
  const session = createSession({
    data,
    playerParty: buildPlayerParty(PLAYER_SPECS, 50, data),
    opponentTrainer: trainer,
    tier: 'elite',
    rng: createRandomSource(1),
    inverseBattle,
  })
  const attacker = session.state.battlers[0]!.mon
  attacker.rawStats = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 }
  attacker.level = 50
  attacker.types = ['NORMAL', 'MYSTERY', 'MYSTERY']
  attacker.abilities = blankAbilities()
  attacker.itemId = null
  attacker.status1 = 0
  attacker.moves = ['MOVE_AQUA_JET', null, null, null]
  attacker.pp = [20, 0, 0, 0]
  const defender = session.state.battlers[1]!.mon
  defender.rawStats = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 }
  defender.level = 50
  defender.types = [defenderType, 'MYSTERY', 'MYSTERY']
  defender.abilities = blankAbilities()
  defender.itemId = null
  defender.status1 = 0
  defender.hp = defender.maxHp = 500
  return session
}

/** One deterministic physical hit through the session's real damage resolver. */
function aquaJetDamage(session: BattleSession): number | null {
  // `random16: () => 0` makes the percentile draw 0 -> the 100% entry; `critRoll: 1`
  // keeps `1 % 24 != 0`, so `values[15 - 0]` is the non-crit maximum.
  session.state.rng = { random16: () => 0 }
  const action = buildMoveAction(session.state, data, 0, 'MOVE_AQUA_JET', session.turnDeps.damage)
  const result = session.turnDeps.damage.resolve(session.state, 0, 1, action, {
    targetHasActedThisTurn: false,
    critRoll: 1,
  })
  return result.targetDamage
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_TREECKO',
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: defaultStatStages(),
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: blankAbilities(),
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function aiState(rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({
    battlers: [
      // Attacker is Normal-typed; MOVE_TACKLE is NORMAL, so there is no STAB either.
      createBattlerState(0, mon({ moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }), 0),
      // NORMAL -> GHOST is 0.0 in types.json and 2.0 in typesInverse.json.
      createBattlerState(1, mon({ types: ['GHOST', 'MYSTERY', 'MYSTERY'] }), 0),
    ],
    rng,
    aiFlags: AI_FLAG_CHECK_BAD_MOVE,
  })
}

describe('FLAG_SYS_INVERSE_BATTLE reaches the sim (cycle 5a)', () => {
  it('1. loads the inverseBattles row, and both other scripted lists', () => {
    // MossdeepCity_Gym_EventScript_TateAndLiza is the one row; its guard is null.
    expect(data.inverseBattles).toHaveLength(1)
    expect(data.inverseBattles[0]!.trainers).toEqual(['TRAINER_TATE_AND_LIZA_1'])
    expect(data.tagBattles).toHaveLength(26)
    expect(data.fieldEffects).toHaveLength(23)

    // battle_util.c:8028 is the FlagGet; the row above is what sets that flag.
    expect(isInverseBattleTrainer(data, 'TRAINER_TATE_AND_LIZA_1')).toBe(true)
    expect(isInverseBattleTrainer(data, 'TRAINER_BRENDEN')).toBe(false)
  })

  it('2. the damage resolver reads the inverse chart for WATER->FIRE but not WATER->NORMAL', () => {
    // 19 base; 2.0 normal / 0.5 inverse => 38 / 10.
    expect(aquaJetDamage(makeSession(false, 'FIRE'))).toBe(38)
    expect(aquaJetDamage(makeSession(true, 'FIRE'))).toBe(10)

    // 1.0 in both charts: the flag must change nothing.
    expect(aquaJetDamage(makeSession(false, 'NORMAL'))).toBe(19)
    expect(aquaJetDamage(makeSession(true, 'NORMAL'))).toBe(19)
  })

  it('3. AI_CheckBadMove scores a Normal move into a Ghost -20 normally and 0 inverse', () => {
    // battle_ai_main.c:599-601: effectiveness x0 -> RETURN_SCORE_MINUS(20). Scores
    // start at 100 (setupAiScores), so 80 normal and 100 inverse where the chart is 2x.
    const normalState = aiState()
    const normal = computeBattleAiScores(normalState, 0, 1, aiDamageDepsFor(data, normalState)).scores[0]
    const inverseState = aiState()
    const inverse = computeBattleAiScores(inverseState, 0, 1, aiDamageDepsFor(data, inverseState, true)).scores[0]
    expect(normal).toBe(80)
    expect(inverse).toBe(100)
  })

  it('4. cloneSession keeps the flag and reproduces the inverse damage number', () => {
    const original = makeSession(true, 'FIRE')
    const clone = cloneSession(original, 7)
    expect(clone.inverseBattle).toBe(true)
    expect(aquaJetDamage(clone)).toBe(10)
    expect(aquaJetDamage(makeSession(false, 'FIRE'))).toBe(38)
  })
})
