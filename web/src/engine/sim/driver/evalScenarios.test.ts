/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 139: scenario harness for the opt-in status1 leaf term; cycle 140
// appends the same harness for the volatile terms (Leech Seed, Substitute,
// confusion); cycle 141 appends it for the per-side terms (entry hazards,
// screens, Tailwind); cycle 142 appends it for the field terms (Sandstorm/Hail
// chip, Grassy Terrain heal, Toxic Terrain chip, terrain/weather move boosts,
// Trick Room).
//
// Each seed gets a fresh session; the starting position is edited right after
// createSession (before beginTurn), and the expectimax policy picks with
// `statusTerms: true`. A positive passes when the intended status move is chosen
// on >= 6 of 8 seeds; a twin (the same position where the status cannot land)
// passes when it is chosen on <= 1 of 8.
import { describe, expect, it } from 'vitest'

import {
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_TAILWIND,
  STATUS1_BURN,
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
  STATUS2_SUBSTITUTE,
  STATUS3_LEECHSEED,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SANDSTORM_TEMPORARY,
  hasFlag,
} from '../constants'
import { createRandomSource } from '../rng'
import { DEFAULT_EXPECTIMAX, chooseExpectimaxAction, statusScore } from './expectimax'
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

/** Writes the side status word and the per-side timers the leaf scorer reads.
 * Hazards need both the bit and the layer count (hazards.ts:165-171). */
function setSide(
  s: BattleSession,
  side: 0 | 1,
  patch: { statuses?: number; spikesAmount?: number; reflectTimer?: number; tailwindTimer?: number },
): void {
  const sideState = s.state.sides[side]
  if (patch.statuses !== undefined) sideState.statuses = patch.statuses
  if (patch.spikesAmount !== undefined) sideState.timers.spikesAmount = patch.spikesAmount
  if (patch.reflectTimer !== undefined) sideState.timers.reflectTimer = patch.reflectTimer
  if (patch.tailwindTimer !== undefined) sideState.timers.tailwindTimer = patch.tailwindTimer
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

// Cycle 141: the same harness for the per-side terms (entry hazards, screens,
// Tailwind). The player's attacks are the weak WEAK_MOVES set, so the setup move
// has to win on the field term, not on damage.
describe('cycle 141 - side scenarios', () => {
  describe('Spikes into a six-mon foe bench', () => {
    const SIX_FOE = () => Array.from({ length: 6 }, () => foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_PECK', 'MOVE_EMBER']))
    const ONE_FOE = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_PECK', 'MOVE_EMBER'])]
    const PLAYER_MOVES = ['MOVE_SPIKES', ...WEAK_MOVES]

    it('sanity: Spikes sets the bit and one layer on the foe side', () => {
      for (const seed of SEEDS) {
        const { session } = forcedTurn(seed, PLAYER_MOVES, SIX_FOE(), 'MOVE_SPIKES')
        expect(hasFlag(session.state.sides[1].statuses, SIDE_STATUS_SPIKES)).toBe(true)
        expect(session.state.sides[1].timers.spikesAmount).toBe(1)
      }
    })

    it('sanity: Spikes cannot add a fourth layer', () => {
      for (const seed of SEEDS) {
        const { session } = forcedTurn(seed, PLAYER_MOVES, SIX_FOE(), 'MOVE_SPIKES', (s) =>
          setSide(s, 1, { statuses: SIDE_STATUS_SPIKES, spikesAmount: 3 }),
        )
        expect(session.state.sides[1].timers.spikesAmount).toBe(3)
      }
    })

    it('positive: Spikes is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, SIX_FOE(), 'MOVE_SPIKES')).toBeGreaterThanOrEqual(6)
    })

    it('twin: with three layers already up, Spikes is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, SIX_FOE(), 'MOVE_SPIKES', (s) =>
        setSide(s, 1, { statuses: SIDE_STATUS_SPIKES, spikesAmount: 3 }),
      )
      expect(n).toBeLessThanOrEqual(1)
    })

    it('twin: against a one-mon foe party (no bench), Spikes is chosen on at most 1 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, ONE_FOE(), 'MOVE_SPIKES')).toBeLessThanOrEqual(1)
    })
  })

  describe('Reflect against a physical foe', () => {
    const PHYSICAL = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_BODY_SLAM', 'MOVE_ROCK_SLIDE'])]
    // Both moves are SPECIAL in data/v2.65beta/moves.json.
    const SPECIAL = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_EMBER', 'MOVE_WATER_GUN'])]
    const PLAYER_MOVES = ['MOVE_REFLECT', ...WEAK_MOVES]

    it('sanity: Reflect sets the bit and a five-turn timer on the player side', () => {
      for (const seed of SEEDS) {
        const { session } = forcedTurn(seed, PLAYER_MOVES, PHYSICAL(), 'MOVE_REFLECT')
        expect(hasFlag(session.state.sides[0].statuses, SIDE_STATUS_REFLECT)).toBe(true)
        expect(session.state.sides[0].timers.reflectTimer).toBe(5)
      }
    })

    it('sanity: Reflect with Reflect already up misses', () => {
      for (const seed of SEEDS) {
        const { result } = forcedTurn(seed, PLAYER_MOVES, PHYSICAL(), 'MOVE_REFLECT', (s) =>
          setSide(s, 0, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 }),
        )
        expect(result.outcome.actions.find((a) => a.battlerId === 0)?.missed).toBe(true)
      }
    })

    it('positive: Reflect is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, PHYSICAL(), 'MOVE_REFLECT')).toBeGreaterThanOrEqual(6)
    })

    it('twin: with Reflect already up, Reflect is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, PHYSICAL(), 'MOVE_REFLECT', (s) =>
        setSide(s, 0, { statuses: SIDE_STATUS_REFLECT, reflectTimer: 5 }),
      )
      expect(n).toBeLessThanOrEqual(1)
    })

    // battle_util.c:7622: Reflect halves only IS_MOVE_PHYSICAL hits, and the
    // leaf scorer now weights a screen by the foe's split mix. Against a foe
    // whose moves are all special, Reflect is worth 0 and the weak attacks win.
    it('sanity: Reflect still sets the bit and a five-turn timer against a special-only foe', () => {
      for (const seed of SEEDS) {
        const { session } = forcedTurn(seed, PLAYER_MOVES, SPECIAL(), 'MOVE_REFLECT')
        expect(hasFlag(session.state.sides[0].statuses, SIDE_STATUS_REFLECT)).toBe(true)
        expect(session.state.sides[0].timers.reflectTimer).toBe(5)
      }
    })

    it('twin: against a special-only foe, Reflect is chosen on at most 1 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, SPECIAL(), 'MOVE_REFLECT')).toBeLessThanOrEqual(1)
    })
  })

  describe('Tailwind', () => {
    const FOE = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_PECK', 'MOVE_EMBER'])]
    const PLAYER_MOVES = ['MOVE_TAILWIND', ...WEAK_MOVES]

    it('sanity: Tailwind sets the bit and a three-turn timer on the player side', () => {
      for (const seed of SEEDS) {
        const { session } = forcedTurn(seed, PLAYER_MOVES, FOE(), 'MOVE_TAILWIND')
        expect(hasFlag(session.state.sides[0].statuses, SIDE_STATUS_TAILWIND)).toBe(true)
        expect(session.state.sides[0].timers.tailwindTimer).toBe(3)
      }
    })

    it('positive: Tailwind is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, FOE(), 'MOVE_TAILWIND')).toBeGreaterThanOrEqual(6)
    })

    // Cmd_settailwind, battle_script_commands.c:10961-10972: with
    // SIDE_STATUS_TAILWIND already set, the command jumps to the fail pointer
    // (:10971) instead of setting the bit and timer again. The sim reports
    // that as a plain failure -- no `missed` flag, unlike Reflect -- and the
    // standing timer then counts down to 2 at end of turn.
    it('sanity: Tailwind with Tailwind already up fails and keeps the standing timer', () => {
      for (const seed of SEEDS) {
        const { result, session } = forcedTurn(seed, PLAYER_MOVES, FOE(), 'MOVE_TAILWIND', (s) =>
          setSide(s, 0, { statuses: SIDE_STATUS_TAILWIND, tailwindTimer: 3 }),
        )
        expect(result.outcome.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()
        expect(hasFlag(session.state.sides[0].statuses, SIDE_STATUS_TAILWIND)).toBe(true)
        expect(session.state.sides[0].timers.tailwindTimer).toBe(2)
      }
    })

    it('twin: with Tailwind already up, Tailwind is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, FOE(), 'MOVE_TAILWIND', (s) =>
        setSide(s, 0, { statuses: SIDE_STATUS_TAILWIND, tailwindTimer: 3 }),
      )
      expect(n).toBeLessThanOrEqual(1)
    })
  })
})

// Cycle 142: the same harness for the FIELD terms. The weather/Trick Room terms
// are scored from the leaf state after the move resolves, so a positive has to
// win on the field value against the weak attacks. Shuckle (Bug/Rock) is
// Sandstorm-immune, which keeps the sand term one-sided in the player's favour;
// Shuckle's base Speed 5 is below Machamp's 55, which makes Trick Room
// favourable. `chosenMove` already threads `session.data.dataContext.move`
// through the leaf scorer, so the terrain/weather move-type boosts also apply
// when a matching damaging move is known.
describe('cycle 142 - field scenarios', () => {
  describe('Sandstorm against a non-immune foe', () => {
    const MACHAMP = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_PECK', 'MOVE_EMBER'])]
    // Rock/Ground: IsSandImmune (battle_script_commands.c:10376-10386) refuses
    // the chip, so the term goes to zero for both sides.
    const GOLEM = () => [foeMon('SPECIES_GOLEM', 'ABILITY_ROCK_HEAD', ['MOVE_PECK', 'MOVE_EMBER'])]
    const PLAYER_MOVES = ['MOVE_SANDSTORM', ...WEAK_MOVES]

    it('sanity: Sandstorm sets the weather bit and started.weather', () => {
      for (const seed of SEEDS) {
        const { session } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_SANDSTORM')
        expect(session.state.field.weather & WEATHER_SANDSTORM_ANY).toBeTruthy()
        expect(session.state.field.timers.started.weather).toBe(true)
      }
    })

    // IsSandImmune's type clause (battle_script_commands.c:10376-10386):
    // Cmd_weatherdamage (:10397-10416) deals nothing to a Rock or Ground foe,
    // while the same turn chips Machamp for maxHP/16 (min 1). The foe takes no
    // other damage here -- the forced player move is Sandstorm and the foe
    // passes no action -- so its HP shows the chip alone. This fails if Golem
    // were chipped.
    it('sanity: a Rock/Ground foe takes no sand chip, a Machamp foe does', () => {
      for (const seed of SEEDS) {
        const machamp = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_SANDSTORM').session
        const machampMax = machamp.state.battlers[1]!.mon.maxHp
        expect(machamp.state.battlers[1]!.mon.hp).toBe(machampMax - Math.max(1, Math.trunc(machampMax / 16)))

        const golem = forcedTurn(seed, PLAYER_MOVES, GOLEM(), 'MOVE_SANDSTORM').session
        expect(golem.state.battlers[1]!.mon.hp).toBe(golem.state.battlers[1]!.mon.maxHp)
      }
    })

    it('sanity: Sandstorm with a sandstorm already up does not reset the countdown', () => {
      for (const seed of SEEDS) {
        const { session } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_SANDSTORM', (s) => {
          // WEATHER_SANDSTORM_TEMPORARY with started.weather false is what a
          // real sandstorm leaves at the start of the next turn. "ANY"
          // (temporary | permanent together) is not producible:
          // TryChangeBattleWeather assigns exactly one flag (battle_util.c:
          // 3732), as does SetPermanentWeather (:3749).
          s.state.field.weather = WEATHER_SANDSTORM_TEMPORARY
          s.state.field.weatherDuration = 5
          s.state.field.timers.started.weather = false
        })
        // TryChangeBattleWeather returns FALSE when the matching flag is
        // already set (battle_util.c:3731), so the bit survives and
        // `started.weather` stays false. The end-of-turn countdown still runs
        // (ENDTURN_SANDSTORM, :1982-1996, gated on `!started.weather`), so the
        // duration drops 5 -> 4 rather than being reset to WEATHER_DURATION.
        expect(hasFlag(session.state.field.weather, WEATHER_SANDSTORM_TEMPORARY)).toBe(true)
        expect(session.state.field.timers.started.weather).toBe(false)
        expect(session.state.field.weatherDuration).toBe(4)
      }
    })

    it('positive: Sandstorm is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, MACHAMP(), 'MOVE_SANDSTORM')).toBeGreaterThanOrEqual(6)
    })

    it('twin: against a Sandstorm-immune foe, Sandstorm is chosen on at most 1 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, GOLEM(), 'MOVE_SANDSTORM')).toBeLessThanOrEqual(1)
    })

    it('twin: with a sandstorm already up, Sandstorm is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, MACHAMP(), 'MOVE_SANDSTORM', (s) => {
        s.state.field.weather = WEATHER_SANDSTORM_TEMPORARY
        s.state.field.weatherDuration = 5
        s.state.field.timers.started.weather = false
      })
      expect(n).toBeLessThanOrEqual(1)
    })
  })

  describe('Grassy Terrain over a damaged player', () => {
    // ENDTURN_GRASSY_TERRAIN heals the grounded active mon maxHP/16 for the
    // terrain's remaining turns (battle_util.c:2102-2113), so the player has to
    // be below full HP for the term to exist.
    const MACHAMP = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_PECK', 'MOVE_EMBER'])]
    const PLAYER_MOVES = ['MOVE_GRASSY_TERRAIN', ...WEAK_MOVES]
    const HALF_HP = (s: BattleSession) => setHp(s, 0, 0, Math.floor(s.state.battlers[0]!.mon.maxHp / 2))

    it('sanity: Grassy Terrain sets its bit and the eight-turn terrain timer', () => {
      for (const seed of SEEDS) {
        const { session } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_GRASSY_TERRAIN', HALF_HP)
        expect(hasFlag(session.state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)).toBe(true)
        // TERRAIN_DURATION == 8 (include/battle_util.h:52).
        expect(session.state.field.timers.terrainTimer).toBe(8)
      }
    })

    // VARIOUS_CHECK_IF_GRASSY_TERRAIN_HEALS (battle_script_commands.c:
    // 6876-6886) skips a non-grounded battler and never consults the terrain
    // bit, while IsBattlerTerrainAffected (battle_util.c:4901-4928) is what the
    // REST of the terrain machinery gates on. The foe passes no action, so the
    // player takes no damage; the only HP change is the end-of-turn heal, and
    // the grounded control heals exactly maxHP/16 (min 1) while the Flying
    // player heals nothing.
    it('sanity: a Flying player is not healed by Grassy Terrain', () => {
      for (const seed of SEEDS) {
        const grounded = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_GRASSY_TERRAIN', HALF_HP).session
        const flying = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_GRASSY_TERRAIN', (s) => {
          HALF_HP(s)
          s.state.battlers[0]!.mon.types = ['NORMAL', 'FLYING', 'MYSTERY']
          s.state.sides[0].party[0]!.types = ['NORMAL', 'FLYING', 'MYSTERY']
        }).session
        const maxHp = grounded.state.battlers[0]!.mon.maxHp
        const startHp = Math.floor(maxHp / 2)
        expect(grounded.state.battlers[0]!.mon.hp).toBe(startHp + Math.max(1, Math.trunc(maxHp / 16)))
        expect(flying.state.battlers[0]!.mon.hp).toBe(startHp)
      }
    })

    it('positive: Grassy Terrain is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, MACHAMP(), 'MOVE_GRASSY_TERRAIN', HALF_HP)).toBeGreaterThanOrEqual(6)
    })

    // IsBattlerTerrainAffected (battle_util.c:4901-4928) excludes a Flying
    // active mon, so the damaged player stops healing and the terrain move goes
    // to 0 while the weak attacks still chip the foe. (A full-HP player also
    // scores the terrain 0 -- so do the weak attacks at full HP -- and the seed
    // tie-break then picks the terrain move freely, which is why the twin
    // damages the player first.)
    it('twin: a Flying (non-grounded) player heals nothing, so Grassy Terrain is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, MACHAMP(), 'MOVE_GRASSY_TERRAIN', (s) => {
        HALF_HP(s)
        s.state.battlers[0]!.mon.types = ['NORMAL', 'FLYING', 'MYSTERY']
        s.state.sides[0].party[0]!.types = ['NORMAL', 'FLYING', 'MYSTERY']
      })
      expect(n).toBeLessThanOrEqual(1)
    })
  })

  describe('Trick Room with a slower player', () => {
    const MACHAMP = () => [foeMon('SPECIES_MACHAMP', 'ABILITY_GUTS', ['MOVE_PECK', 'MOVE_EMBER'])]
    const PLAYER_MOVES = ['MOVE_TRICK_ROOM', ...WEAK_MOVES]

    it('sanity: Trick Room sets the bit, timer 5 and started.trickRoom', () => {
      for (const seed of SEEDS) {
        const { session } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_TRICK_ROOM')
        expect(hasFlag(session.state.field.statuses, STATUS_FIELD_TRICK_ROOM)).toBe(true)
        expect(session.state.field.timers.trickRoomTimer).toBe(5)
        expect(session.state.field.timers.started.trickRoom).toBe(true)
      }
    })

    // battle_main.c:4325 reverses the order, so a 999-Speed player is the
    // FASTER side and the room is worth MINUS its per-turn value. The leaf
    // reads Trick Room's 0.1 * min(timer 5, horizon 3) = 0.3 with the sign of
    // the effective-Speed comparison (expectimax.ts `trickRoomValue`), and no
    // other term is live here: no status, hazard, weather or terrain.
    it('sanity: a 999-Speed player is faster, so Trick Room scores negative', () => {
      for (const seed of SEEDS) {
        const { session } = forcedTurn(seed, PLAYER_MOVES, MACHAMP(), 'MOVE_TRICK_ROOM', (s) => {
          s.state.battlers[0]!.mon.rawStats.spe = 999
        })
        expect(statusScore(session.state)).toBeCloseTo(-0.3, 10)
      }
    })

    it('positive: Trick Room is chosen on at least 6 of 8 seeds', () => {
      expect(picks(PLAYER_MOVES, MACHAMP(), 'MOVE_TRICK_ROOM')).toBeGreaterThanOrEqual(6)
    })

    // The room only pays when the player is the slower side (battle_main.c:4325
    // reverses the order). Patching the active mon's speed before beginTurn
    // makes the player the faster side, flipping the term negative.
    it('twin: with a faster player, Trick Room is chosen on at most 1 of 8 seeds', () => {
      const n = picks(PLAYER_MOVES, MACHAMP(), 'MOVE_TRICK_ROOM', (s) => {
        s.state.battlers[0]!.mon.rawStats.spe = 999
      })
      expect(n).toBeLessThanOrEqual(1)
    })
  })
})
