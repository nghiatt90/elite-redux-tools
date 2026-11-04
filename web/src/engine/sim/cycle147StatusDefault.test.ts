// Cycle 147: statusTerms defaults to true in DEFAULT_EXPECTIMAX and evaluateState.
import { describe, expect, it } from 'vitest'

import { STATUS1_BURN } from './constants'
import {
  DEFAULT_EXPECTIMAX,
  chooseExpectimaxAction,
  evaluateState,
  positionScore,
  statusScore,
  type ExpectimaxOptions,
} from './driver/expectimax'
import { buildPlayerParty } from './driver/buildParty'
import { beginTurn, createSession, type BattleSession } from './driver/session'
import { createRandomSource } from './rng'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'

const data = loadSimData()

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]

// Shuckle: Atk 10 / SpA 10, so the three weak attacks cannot outscore a status
// on damage alone. Its innates (Shell Armor / Oblivious / Solid Rock) are all
// defensive and none of them blocks an opponent's status.
const PLAYER = {
  species: 'SPECIES_SHUCKLE',
  level: 50,
  nature: 'NATURE_IMPISH',
  evs: { hp: 252, def: 252, spdef: 4 },
  ability: 'ABILITY_CONTRARY',
  item: 'ITEM_NONE',
}

const WEAK_MOVES = ['MOVE_PECK', 'MOVE_EMBER', 'MOVE_MUD_SLAP']

function foeMon(species: string, ability: string, moves: string[]): TrainerMonData {
  return {
    species,
    item: 'ITEM_NONE',
    nature: 'NATURE_ADAMANT',
    ability,
    evs: { hp: 252, atk: 252, def: 0, spatk: 0, spdef: 4, spe: 0 },
    moves,
    ironPill: false,
    hiddenPowerType: 'TYPE_NORMAL',
  }
}

const opponent = (mons: TrainerMonData[]): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  noSwitching: true,
  parties: { ace: mons, elite: mons, hell: mons },
})

function freshSession(seed: number, playerMoves: string[], foeMons: TrainerMonData[]): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty([{ ...PLAYER, moves: playerMoves }], 50, data),
    opponentTrainer: opponent(foeMons),
    rng: createRandomSource(seed),
  })
}

/** Writes status1 and the HP pair on BOTH copies of a party slot. */
function setStatus(s: BattleSession, side: 0 | 1, partyIndex: number, status1: number): void {
  const partyMon = s.state.sides[side].party[partyIndex]!
  partyMon.status1 = status1
  const active = s.state.battlers[side]
  if (active && active.partyIndex === partyIndex) {
    active.mon.status1 = status1
    active.mon.hp = partyMon.hp
    active.mon.maxHp = partyMon.maxHp
  }
}

/** The move id the expectimax policy picks for one fresh seeded session. */
function chosenMoveWith(
  seed: number,
  playerMoves: string[],
  foeMons: TrainerMonData[],
  options: ExpectimaxOptions,
  setup?: (s: BattleSession) => void,
): string | null {
  const s = freshSession(seed, playerMoves, foeMons)
  setup?.(s)
  beginTurn(s)
  const choice = chooseExpectimaxAction(s, options, seed)
  const action = choice?.action
  if (!action || action.action !== 'USE_MOVE') return null
  return action.chosenMove?.id ?? null
}

describe('cycle 147 - statusTerms default flip', () => {
  const MACHAMP = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_BODY_SLAM', 'MOVE_ROCK_SLIDE'])]
  const PLAYER_MOVES = ['MOVE_SPORE', ...WEAK_MOVES]

  describe('Case 1: evaluateState default semantics and hand-derived burn term', () => {
    it('DEFAULT_EXPECTIMAX has statusTerms === true', () => {
      expect(DEFAULT_EXPECTIMAX.statusTerms).toBe(true)
    })

    it('evaluateState with no options equals evaluateState with statusTerms: true', () => {
      const s = freshSession(1, PLAYER_MOVES, MACHAMP())
      expect(evaluateState(s.state)).toBe(evaluateState(s.state, { ...DEFAULT_EXPECTIMAX, statusTerms: true }))
    })

    it('evaluateState with statusTerms: false equals positionScore alone', () => {
      const s = freshSession(1, PLAYER_MOVES, MACHAMP())
      setStatus(s, 1, 0, STATUS1_BURN)
      expect(evaluateState(s.state, { ...DEFAULT_EXPECTIMAX, statusTerms: false })).toBe(positionScore(s.state))
    })

    it('on and off differ by hand-derived burn term on burned active foe, and by 0 on clean state', () => {
      const s = freshSession(1, PLAYER_MOVES, MACHAMP())

      // Clean state: no status or field conditions -> statusScore is 0
      expect(statusScore(s.state)).toBe(0)
      const cleanOn = evaluateState(s.state)
      const cleanOff = evaluateState(s.state, { ...DEFAULT_EXPECTIMAX, statusTerms: false })
      expect(cleanOn - cleanOff).toBe(0)

      // Burned active foe with 320 maxHP:
      // - battle_util.c:2573-2582 (ENDTURN_BURN): maxHP / 16 (B_BURN_DAMAGE >= GEN_7)
      //   chip per turn, times STATUS_HORIZON_TURNS = 3 -> (20 / 320) * 3 = 0.1875
      // - battle_util.c:7135 (statBase /= 2 for burned physical attacker):
      //   BURN_ATTACK_HALF_VALUE = ACTION_VALUE / 2 = 0.25 / 2 = 0.125
      // Total hand-derived difference = 0.1875 + 0.125 = 0.3125
      s.state.sides[1].party[0]!.hp = 320
      s.state.sides[1].party[0]!.maxHp = 320
      setStatus(s, 1, 0, STATUS1_BURN)

      const burnedOn = evaluateState(s.state)
      const burnedOff = evaluateState(s.state, { ...DEFAULT_EXPECTIMAX, statusTerms: false })
      expect(burnedOn - burnedOff).toBeCloseTo(0.3125, 10)
      expect(burnedOn - burnedOff).toBeCloseTo(statusScore(s.state), 10)
    })
  })

  // Case 2 is the check not redundant with driver/evalScenarios.test.ts: it passes DEFAULT_EXPECTIMAX straight through chooseExpectimaxAction, whereas that file always builds its options with an explicit statusTerms: SCENARIO_TERMS.
  describe('Case 2: chooseExpectimaxAction default options carry statusTerms through entry point', () => {
    it('picks Spore on at least 6 of 8 seeds with default options', () => {
      const picks = SEEDS.filter((seed) => chosenMoveWith(seed, PLAYER_MOVES, MACHAMP(), DEFAULT_EXPECTIMAX) === 'MOVE_SPORE').length
      expect(picks).toBeGreaterThanOrEqual(6)
    })

    it('picks Spore on at most 1 of 8 seeds when foe is already asleep (counter 3)', () => {
      const asleepPicks = SEEDS.filter(
        (seed) => chosenMoveWith(seed, PLAYER_MOVES, MACHAMP(), DEFAULT_EXPECTIMAX, (s) => setStatus(s, 1, 0, 3)) === 'MOVE_SPORE',
      ).length
      expect(asleepPicks).toBeLessThanOrEqual(1)
    })
  })

  describe('Case 3: statusTerms: false does not carry statusTerms', () => {
    it('picks Spore on fewer than 6 of 8 seeds (measured 0 of 8) with statusTerms: false', () => {
      const offPicks = SEEDS.filter(
        (seed) => chosenMoveWith(seed, PLAYER_MOVES, MACHAMP(), { ...DEFAULT_EXPECTIMAX, statusTerms: false }) === 'MOVE_SPORE',
      ).length
      expect(offPicks).toBeLessThan(6)
      expect(offPicks).toBe(0)
    })
  })
})
