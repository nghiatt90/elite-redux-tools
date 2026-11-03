/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 139: scenario harness for the opt-in status1 leaf term; cycle 140
// appends the same harness for the volatile terms (Leech Seed, Substitute,
// confusion).
//
// Each seed gets a fresh session; the starting position is edited right after
// createSession (before beginTurn), and the expectimax policy picks with
// `statusTerms: true`. A positive passes when the intended status move is chosen
// on >= 6 of 8 seeds; a twin (the same position where the status cannot land)
// passes when it is chosen on <= 1 of 8.
import { describe, expect, it } from 'vitest'

import { STATUS1_BURN, STATUS1_SLEEP, STATUS2_CONFUSION, STATUS2_SUBSTITUTE, STATUS3_LEECHSEED, hasFlag } from '../constants'
import { createRandomSource } from '../rng'
import { DEFAULT_EXPECTIMAX, chooseExpectimaxAction } from './expectimax'
import { buildPlayerParty } from './buildParty'
import { beginTurn, buildMoveAction, createSession, stepTurn, type BattleSession } from './session'
import { loadSimData, type TrainerData, type TrainerMonData } from './loadSimData'

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

/** Writes HP on BOTH copies of a party slot. */
function setHp(s: BattleSession, side: 0 | 1, partyIndex: number, hp: number): void {
  s.state.sides[side].party[partyIndex]!.hp = hp
  const active = s.state.battlers[side]
  if (active && active.partyIndex === partyIndex) active.mon.hp = hp
}

/** Writes volatile fields on the ACTIVE battler only: status2/statuses3/
 * volatiles have no party-mon copy (they are cleared on switch out). */
function setVolatiles(
  s: BattleSession,
  side: 0 | 1,
  patch: { status2?: number; statuses3?: number; substituteHp?: number },
): void {
  const battler = s.state.battlers[side]!
  if (patch.status2 !== undefined) battler.mon.status2 = patch.status2
  if (patch.statuses3 !== undefined) battler.statuses3 = patch.statuses3
  if (patch.substituteHp !== undefined) battler.volatiles.substituteHp = patch.substituteHp
}

/** The move id the expectimax policy picks for one fresh seeded session. */
function chosenMove(
  seed: number,
  playerMoves: string[],
  foeMons: TrainerMonData[],
  setup?: (s: BattleSession) => void,
): string | null {
  const s = freshSession(seed, playerMoves, foeMons)
  setup?.(s)
  beginTurn(s)
  const choice = chooseExpectimaxAction(s, { ...DEFAULT_EXPECTIMAX, statusTerms: true }, seed)
  const action = choice?.action
  if (!action || action.action !== 'USE_MOVE') return null
  return action.chosenMove?.id ?? null
}

function picks(playerMoves: string[], foeMons: TrainerMonData[], moveId: string, setup?: (s: BattleSession) => void): number {
  return SEEDS.filter((seed) => chosenMove(seed, playerMoves, foeMons, setup) === moveId).length
}

/** Runs one turn with the player's move forced and the opponent doing nothing. */
function forcedTurn(
  seed: number,
  playerMoves: string[],
  foeMons: TrainerMonData[],
  moveId: string,
  setup?: (s: BattleSession) => void,
) {
  const s = freshSession(seed, playerMoves, foeMons)
  setup?.(s)
  beginTurn(s)
  const result = stepTurn(s, buildMoveAction(s.state, data, 0, moveId), null)
  return { session: s, result }
}

describe('cycle 139 - status1 scenarios', () => {
  describe('Spore into a sleepable foe', () => {
    const MACHAMP = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_BODY_SLAM', 'MOVE_ROCK_SLIDE'])]
    const PLAYER_MOVES = ['MOVE_SPORE', ...WEAK_MOVES]

    it('sanity: Spore puts a fresh Machamp to sleep (statusApplied SLEEP)', () => {
      const slept = SEEDS.map((seed) => {
        const { result } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_SPORE')
        return result.outcome.actions.find((a) => a.battlerId === 0)?.statusApplied?.status ?? null
      })
      expect(slept.filter((s) => s === 'SLEEP').length).toBeGreaterThan(0)
    })

    it('sanity: an already-asleep foe cannot be re-slept (status1 counter unchanged)', () => {
      for (const seed of SEEDS) {
        // 3 is STATUS1_SLEEP counter 3 (the mask itself is 0x7).
        const { session, result } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_SPORE', (s) => setStatus(s, 1, 0, 3))
        const applied = result.outcome.actions.find((a) => a.battlerId === 0)?.statusApplied ?? null
        expect(applied).toBeNull()
        expect(session.state.battlers[1]!.mon.status1 & STATUS1_SLEEP).toBe(3)
      }
    })

    it('positive: Spore is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, MACHAMP(), 'MOVE_SPORE')).toBeGreaterThanOrEqual(6)
    })

    it('twin: with the foe already asleep, Spore is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, MACHAMP(), 'MOVE_SPORE', (s) => setStatus(s, 1, 0, 3))
      expect(n).toBeLessThanOrEqual(1)
    })
  })

  describe('Will-O-Wisp into a physical attacker', () => {
    const GOLEM = () => [foeMon('SPECIES_GOLEM', 'ABILITY_ROCK_HEAD', ['MOVE_ROCK_SLIDE', 'MOVE_BODY_SLAM', 'MOVE_EARTHQUAKE'])]
    const TORKOAL = () => [foeMon('SPECIES_TORKOAL', 'ABILITY_SHELL_ARMOR', ['MOVE_BODY_SLAM', 'MOVE_ROCK_SLIDE'])]
    const PLAYER_MOVES = ['MOVE_WILL_O_WISP', ...WEAK_MOVES]

    it('sanity: Will-O-Wisp burns a non-Fire physical attacker', () => {
      const burned = SEEDS.map((seed) => {
        const { session } = forcedTurn(seed, PLAYER_MOVES, GOLEM(), 'MOVE_WILL_O_WISP')
        return hasFlag(session.state.battlers[1]!.mon.status1, STATUS1_BURN)
      })
      expect(burned.filter(Boolean).length).toBeGreaterThan(0)
    })

    it('sanity: a Fire-type foe cannot be burned', () => {
      for (const seed of SEEDS) {
        const { session, result } = forcedTurn(seed, PLAYER_MOVES, TORKOAL(), 'MOVE_WILL_O_WISP')
        expect(hasFlag(session.state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(false)
        expect(result.outcome.actions.find((a) => a.battlerId === 0)?.statusApplied ?? null).toBeNull()
      }
    })

    it('positive: Will-O-Wisp is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, GOLEM(), 'MOVE_WILL_O_WISP')).toBeGreaterThanOrEqual(6)
    })

    it('twin: with the foe already burned, Will-O-Wisp is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, GOLEM(), 'MOVE_WILL_O_WISP', (s) => setStatus(s, 1, 0, STATUS1_BURN))
      expect(n).toBeLessThanOrEqual(1)
    })

    it('twin: against a Fire-type foe, Will-O-Wisp is chosen on at most 1 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, TORKOAL(), 'MOVE_WILL_O_WISP')).toBeLessThanOrEqual(1)
    })
  })

  it('anti-regression: the default options leave the status term off', () => {
    expect(DEFAULT_EXPECTIMAX.statusTerms).toBeFalsy()
  })
})

// All three moves are in verifiedMoveEffects.ts's honoured set: EFFECT_LEECH_SEED
// (cycle 115b), EFFECT_SUBSTITUTE (cycle 114) and EFFECT_CONFUSE (cycle 119).
// Shuckle's innates (Shell Armor / Oblivious / Solid Rock) are defensive and
// none of them blocks the opponent from being seeded, subbed against or confused.
describe('cycle 140 - volatile scenarios', () => {
  describe('Leech Seed into a non-Grass foe', () => {
    const MACHAMP = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_BODY_SLAM', 'MOVE_ROCK_SLIDE'])]
    // Pure Grass: the sim's EFFECT_LEECH_SEED handler (moveEffects.ts's
    // handleLeechSeed) refuses a Grass-type target, so the seed cannot land.
    const TANGELA = () => [foeMon('SPECIES_TANGELA', 'ABILITY_CHLOROPHYLL', ['MOVE_BODY_SLAM', 'MOVE_ROCK_SLIDE'])]
    const PLAYER_MOVES = ['MOVE_LEECH_SEED', ...WEAK_MOVES]

    it('sanity: Leech Seed seeds a fresh non-Grass foe', () => {
      // handleLeechSeed writes statuses3 and returns no statusApplied record, so
      // the state flag is the observable.
      const seeded = SEEDS.map((seed) => {
        const { session } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_LEECH_SEED')
        return hasFlag(session.state.battlers[1]!.statuses3, STATUS3_LEECHSEED)
      })
      expect(seeded.filter(Boolean).length).toBeGreaterThan(0)
    })

    it('sanity: a Grass-type foe cannot be seeded', () => {
      for (const seed of SEEDS) {
        const { session, result } = forcedTurn(seed, PLAYER_MOVES, TANGELA(), 'MOVE_LEECH_SEED')
        expect(result.outcome.actions.find((a) => a.battlerId === 0)?.missed).toBe(true)
        expect(hasFlag(session.state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(false)
      }
    })

    it('sanity: an already-seeded foe cannot be re-seeded', () => {
      for (const seed of SEEDS) {
        const { session, result } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_LEECH_SEED', (s) =>
          setVolatiles(s, 1, { statuses3: STATUS3_LEECHSEED | 0 }),
        )
        // handleLeechSeed bails with `missed` on the already-set flag; the flag
        // itself is left in place.
        expect(result.outcome.actions.find((a) => a.battlerId === 0)?.missed).toBe(true)
        expect(hasFlag(session.state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(true)
      }
    })

    it('positive: Leech Seed is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, MACHAMP(), 'MOVE_LEECH_SEED')).toBeGreaterThanOrEqual(6)
    })

    it('twin: against a Grass-type foe, Leech Seed is chosen on at most 1 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, TANGELA(), 'MOVE_LEECH_SEED')).toBeLessThanOrEqual(1)
    })

    it('twin: with the foe already seeded, Leech Seed is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, MACHAMP(), 'MOVE_LEECH_SEED', (s) =>
        setVolatiles(s, 1, { statuses3: STATUS3_LEECHSEED | 0 }),
      )
      expect(n).toBeLessThanOrEqual(1)
    })
  })

  describe('Substitute at full HP', () => {
    const MACHAMP = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_BODY_SLAM', 'MOVE_ROCK_SLIDE'])]
    const PLAYER_MOVES = ['MOVE_SUBSTITUTE', ...WEAK_MOVES]

    it('sanity: Substitute sets the flag and the buffer on a full-HP player', () => {
      const up = SEEDS.map((seed) => {
        const { session } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_SUBSTITUTE')
        const battler = session.state.battlers[0]!
        return hasFlag(battler.mon.status2, STATUS2_SUBSTITUTE) && battler.volatiles.substituteHp > 0
      })
      expect(up.filter(Boolean).length).toBeGreaterThan(0)
    })

    it('sanity: with a sub already up, Substitute fails', () => {
      for (const seed of SEEDS) {
        const { result } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_SUBSTITUTE', (s) => {
          setVolatiles(s, 0, { status2: STATUS2_SUBSTITUTE, substituteHp: 1 })
        })
        expect(result.outcome.actions.find((a) => a.battlerId === 0)?.missed).toBe(true)
      }
    })

    // Cmd_setsubstitute, battle_script_commands.c:10537-10541: the cost is
    // `max(hp / 4, 1)` and the sub fails when `hp <= damage`, so
    // hp == floor(maxHP / 4) fails.
    it('sanity: at hp <= maxHP / 4 Substitute fails', () => {
      for (const seed of SEEDS) {
        let maxHp = 0
        const { result } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_SUBSTITUTE', (s) => {
          maxHp = s.state.battlers[0]!.mon.maxHp
          setHp(s, 0, 0, Math.floor(maxHp / 4))
        })
        expect(maxHp).toBeGreaterThan(0)
        expect(result.outcome.actions.find((a) => a.battlerId === 0)?.missed).toBe(true)
      }
    })

    it('positive: Substitute is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, MACHAMP(), 'MOVE_SUBSTITUTE')).toBeGreaterThanOrEqual(6)
    })

    it('twin: already behind a sub, Substitute is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, MACHAMP(), 'MOVE_SUBSTITUTE', (s) => {
        setVolatiles(s, 0, { status2: STATUS2_SUBSTITUTE, substituteHp: 1 })
      })
      expect(n).toBeLessThanOrEqual(1)
    })

    it('twin: at hp <= maxHP / 4, Substitute is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, MACHAMP(), 'MOVE_SUBSTITUTE', (s) => {
        setHp(s, 0, 0, Math.floor(s.state.battlers[0]!.mon.maxHp / 4))
      })
      expect(n).toBeLessThanOrEqual(1)
    })
  })

  describe('Confuse Ray into a fresh foe', () => {
    const MACHAMP = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_BODY_SLAM', 'MOVE_ROCK_SLIDE'])]
    const PLAYER_MOVES = ['MOVE_CONFUSE_RAY', ...WEAK_MOVES]
    // Counter 4 is inside the C's `((Random()) % 2) + 3` range (3-4 turns,
    // battle_script_commands.c:2660) and is what `canBeConfused` treats as
    // already confused.
    const CONFUSED = 4

    it('sanity: Confuse Ray confuses a fresh foe', () => {
      const confused = SEEDS.map((seed) => {
        const { result } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_CONFUSE_RAY')
        return result.outcome.actions.find((a) => a.battlerId === 0)?.statusApplied?.status ?? null
      })
      expect(confused.filter((s) => s === 'CONFUSION').length).toBeGreaterThan(0)
    })

    it('sanity: an already-confused foe cannot be re-confused', () => {
      for (const seed of SEEDS) {
        const { session, result } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_CONFUSE_RAY', (s) =>
          setVolatiles(s, 1, { status2: CONFUSED }),
        )
        expect(result.outcome.actions.find((a) => a.battlerId === 0)?.statusApplied ?? null).toBeNull()
        expect(session.state.battlers[1]!.mon.status2 & STATUS2_CONFUSION).toBe(CONFUSED)
      }
    })

    it('positive: Confuse Ray is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, MACHAMP(), 'MOVE_CONFUSE_RAY')).toBeGreaterThanOrEqual(6)
    })

    it('twin: against an already-confused foe, Confuse Ray is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, MACHAMP(), 'MOVE_CONFUSE_RAY', (s) => setVolatiles(s, 1, { status2: CONFUSED }))
      expect(n).toBeLessThanOrEqual(1)
    })
  })
})
