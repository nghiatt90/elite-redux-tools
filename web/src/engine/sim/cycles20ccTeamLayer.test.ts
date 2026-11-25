/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20cc - the team layer's counter purpose decides each side of the
// matchup over its WHOLE move list: a mon that threatens through a different
// move than its best-by-floor one is no longer missed, and a bench mon's "KO in
// two" floor no longer has to come from its largest-mean move. Design text,
// docs/battle-sim/solver-v2-plan.md:343. Every damage number below is the sim's
// own `aiDamageRolls` on these fixtures; the thresholds are MODEL CHOICES.
import { describe, expect, it } from 'vitest'

import { aiDamageRolls } from './ai/aiCalcDamage'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import { highestRoll, lowestRoll, meanRoll, rangeOnOurReserve, stateWithReserve } from './driver/rolePolicy'
import { aiDamageDepsFor, createSession } from './driver/session'
import type { BattleSession } from './driver/session'
import { createTeamLayer } from './driver/teamLayer'
import { createRandomSource } from './rng'
import type { BattleState } from './state'

const data = loadSimData()

const mon = (species: string, moves: string[], overrides: Partial<TrainerMonData> = {}): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
  ...overrides,
})

const parties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })

const opponent = (mons: TrainerMonData[], overrides: Partial<TrainerData> = {}): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  noSwitching: true,
  parties: parties(mons),
  ...overrides,
})

function session(
  playerMons: PlayerMonSpec[],
  foeMons: TrainerMonData[],
  overrides: Partial<TrainerData> = {},
  seed = 1,
  playerReplacement?: (state: BattleState, battlerId: number) => number,
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons, overrides),
    rng: createRandomSource(seed),
    playerReplacement,
  })
}

function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const OUR_AGGRON: PlayerMonSpec = { species: 'SPECIES_AGGRON', level: 50, moves: ['MOVE_IRON_HEAD'] }
const THEIR_MACHAMP = (): TrainerMonData => mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])

describe('cycle s20cc - counter: the active mon decides over every move', () => {
  it('a priority move makes the slower active mon a fast-heavy threat, so no counter', () => {
    // Snorlax (Speed 50) is slower than their Machamp (75), but Extreme Speed's
    // +2 priority still makes its action strike first. Body Slam's worst roll is
    // the higher floor (63 vs 60) yet its mean is not heavy at this HP, while
    // Extreme Speed's mean is: the old single-move gate looked only at Body
    // Slam and switched the mon out.
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_BODY_SLAM', 'MOVE_EXTREME_SPEED'] },
        OUR_AGGRON,
      ],
      [THEIR_MACHAMP()],
    )
    const theirHp = 128
    patchMon(s.state, 0, 0, { hp: 80 })
    patchMon(s.state, 1, 0, { hp: theirHp })

    const deps = aiDamageDepsFor(data, s.state, false)
    const bodySlam = aiDamageRolls(s.state, 'MOVE_BODY_SLAM', 0, 1, deps)!
    const extremeSpeed = aiDamageRolls(s.state, 'MOVE_EXTREME_SPEED', 0, 1, deps)!
    expect(lowestRoll(bodySlam)).toBe(63)
    expect(highestRoll(bodySlam)).toBe(75)
    expect(meanRoll(bodySlam)).toBe(69)
    expect(lowestRoll(extremeSpeed)).toBe(60)
    expect(highestRoll(extremeSpeed)).toBe(71)
    expect(meanRoll(extremeSpeed)).toBeCloseTo(65.25, 4)
    // The window the rule straddles: Body Slam's worst roll doubled falls short
    // of their HP, Extreme Speed's mean doubled reaches it.
    expect(2 * lowestRoll(bodySlam)).toBe(126)
    expect(2 * lowestRoll(bodySlam)).toBeLessThan(theirHp)
    expect(2 * meanRoll(extremeSpeed)).toBeCloseTo(130.5, 4)
    expect(2 * meanRoll(extremeSpeed)).toBeGreaterThanOrEqual(theirHp)
    expect(lowestRoll(extremeSpeed)).toBeLessThan(lowestRoll(bodySlam))
    expect(data.dataContext.move('MOVE_BODY_SLAM')!.priority).toBe(0)
    expect(data.dataContext.move('MOVE_EXTREME_SPEED')!.priority).toBe(2)
    expect(s.state.battlers[0]!.mon.rawStats.spe).toBe(50)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBe(75)

    // The bench Aggron IS a qualifying candidate (it takes Body Slam for
    // 5/145 = 3.45% and reaches 128 twice with Iron Head), so only the active
    // gate can refuse the switch.
    const incoming = s.state.sides[0].party[1]!
    expect(incoming.maxHp).toBe(145)
    const bodySlamOnAggron = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(highestRoll(bodySlamOnAggron)).toBe(5)
    expect(highestRoll(bodySlamOnAggron) * 100).toBeLessThanOrEqual(50 * incoming.maxHp)
    const benchState = stateWithReserve(s.state, 0, incoming, 1)
    const ironHead = aiDamageRolls(benchState, 'MOVE_IRON_HEAD', 0, 1, aiDamageDepsFor(data, benchState, false))!
    expect(lowestRoll(ironHead)).toBe(78)
    expect(2 * lowestRoll(ironHead)).toBeGreaterThanOrEqual(theirHp)

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).not.toEqual(['team', 'counter'])
    expect(choice!.action.action).toBe('USE_MOVE')
  })

  it('one point above the Extreme Speed mean window, the same fixture fires the counter', () => {
    // H = floor(2 * 65.25) + 1 = 131: Extreme Speed's mean doubled is no longer
    // heavy, and Body Slam neither KOs in two (126) nor outspeeds, so the
    // active mon does neither and the qualifying Aggron bench comes in.
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_BODY_SLAM', 'MOVE_EXTREME_SPEED'] },
        OUR_AGGRON,
      ],
      [THEIR_MACHAMP()],
    )
    const deps = aiDamageDepsFor(data, s.state, false)
    const extremeSpeed = aiDamageRolls(s.state, 'MOVE_EXTREME_SPEED', 0, 1, deps)!
    const theirHp = Math.floor(2 * meanRoll(extremeSpeed)) + 1
    expect(theirHp).toBe(131)
    patchMon(s.state, 0, 0, { hp: 80 })
    patchMon(s.state, 1, 0, { hp: theirHp })

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'counter'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)
  })

  it('without the priority move the same active mon does neither, so the counter fires', () => {
    const s = session(
      [{ species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_BODY_SLAM'] }, OUR_AGGRON],
      [THEIR_MACHAMP()],
    )
    patchMon(s.state, 0, 0, { hp: 80 })
    patchMon(s.state, 1, 0, { hp: 128 })
    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'counter'])
    expect(choice!.switchTo).toBe(1)
  })
})

describe('cycle s20cc - counter: a higher-mean move makes the active mon a threat', () => {
  it('Thunderbolt outspeeds with heavy damage even though Seismic Toss has the higher floor', () => {
    // Their Machamp sits at 101 HP. Seismic Toss deals 50 on every roll, so it
    // has the highest floor -- and 2 * 50 = 100 is not a two-hit KO. Thunderbolt
    // has a lower floor but a heavy mean and Jolteon is faster: a fast-heavy
    // threat the old single-move gate (Seismic Toss, the floor-best) missed.
    const s = session(
      [
        { species: 'SPECIES_JOLTEON', level: 50, moves: ['MOVE_SEISMIC_TOSS', 'MOVE_THUNDERBOLT'] },
        { species: 'SPECIES_MACHAMP', level: 50, moves: ['MOVE_CLOSE_COMBAT'] },
      ],
      [THEIR_MACHAMP()],
    )
    const theirHp = 101
    const jolteon = s.state.battlers[0]!.mon
    patchMon(s.state, 0, 0, { rawStats: { ...jolteon.rawStats, spatk: 80 } })
    patchMon(s.state, 1, 0, { hp: theirHp })
    expect(s.state.battlers[0]!.mon.rawStats.spatk).toBe(80)
    expect(s.state.battlers[0]!.mon.rawStats.spe).toBe(150)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBe(75)

    const deps = aiDamageDepsFor(data, s.state, false)
    const seismicToss = aiDamageRolls(s.state, 'MOVE_SEISMIC_TOSS', 0, 1, deps)!
    const thunderbolt = aiDamageRolls(s.state, 'MOVE_THUNDERBOLT', 0, 1, deps)!
    expect(lowestRoll(seismicToss)).toBe(50)
    expect(highestRoll(seismicToss)).toBe(50)
    expect(meanRoll(seismicToss)).toBe(50)
    expect(2 * lowestRoll(seismicToss)).toBe(100)
    expect(2 * lowestRoll(seismicToss)).toBeLessThan(theirHp)
    expect(lowestRoll(thunderbolt)).toBe(49)
    expect(highestRoll(thunderbolt)).toBe(58)
    expect(meanRoll(thunderbolt)).toBeCloseTo(53.1875, 4)
    expect(lowestRoll(thunderbolt)).toBeLessThan(lowestRoll(seismicToss))
    expect(2 * lowestRoll(thunderbolt)).toBe(98)
    expect(2 * lowestRoll(thunderbolt)).toBeLessThan(theirHp)
    expect(2 * meanRoll(thunderbolt)).toBeCloseTo(106.375, 4)
    expect(2 * meanRoll(thunderbolt)).toBeGreaterThanOrEqual(theirHp)

    // The bench Machamp is a real candidate: Body Slam takes 58/165 = 35.2% of
    // its current HP (under the default 50% line) and Close Combat KOs in two.
    expect(s.state.sides[0].party[1]!.maxHp).toBe(165)
    const incoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(highestRoll(incoming)).toBe(58)
    expect(highestRoll(incoming) * 100).toBeLessThanOrEqual(50 * s.state.sides[0].party[1]!.maxHp)
    const benchState = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const closeCombat = aiDamageRolls(benchState, 'MOVE_CLOSE_COMBAT', 0, 1, aiDamageDepsFor(data, benchState, false))!
    expect(lowestRoll(closeCombat)).toBe(103)
    expect(2 * lowestRoll(closeCombat)).toBeGreaterThanOrEqual(theirHp)

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).not.toEqual(['team', 'counter'])
    expect(choice!.action.action).toBe('USE_MOVE')
  })

  it('with only Seismic Toss the active mon does neither, so the counter fires', () => {
    // 2 * 50 = 100 < 101 and no fast-heavy move: the active gate opens. Jolteon
    // is faster, but outspeeding alone (with `threatened` unnecessary) is what
    // the third condition needs.
    const s = session(
      [
        { species: 'SPECIES_JOLTEON', level: 50, moves: ['MOVE_SEISMIC_TOSS'] },
        { species: 'SPECIES_MACHAMP', level: 50, moves: ['MOVE_CLOSE_COMBAT'] },
      ],
      [THEIR_MACHAMP()],
    )
    patchMon(s.state, 1, 0, { hp: 101 })
    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'counter'])
    expect(choice!.switchTo).toBe(1)
  })
})

describe('cycle s20cc - counter: the bench mon qualifies through its floor move', () => {
  it('the Aggron bench KOs in two through Seismic Toss while Iron Head carries the mean', () => {
    // Lowered Attack keeps Iron Head's worst roll (48) below 50 but its mean
    // (52.3125) above, so Iron Head is the largest-mean move and the old
    // single-move bench read its floor as 48: no KO in two, and Aggron (Speed
    // 70) does not outspeed. Seismic Toss's flat 50 is the real floor.
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_CELEBRATE'] },
        { species: 'SPECIES_AGGRON', level: 50, moves: ['MOVE_SEISMIC_TOSS', 'MOVE_IRON_HEAD'] },
      ],
      [THEIR_MACHAMP()],
    )
    const theirHp = 100
    const aggron = s.state.sides[0].party[1]!
    patchMon(s.state, 0, 0, { hp: 80 })
    patchMon(s.state, 0, 1, { rawStats: { ...aggron.rawStats, atk: 65 } })
    patchMon(s.state, 1, 0, { hp: theirHp })
    expect(s.state.sides[0].party[1]!.rawStats.atk).toBe(65)
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBe(70)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBe(75)
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBeLessThan(s.state.battlers[1]!.mon.rawStats.spe)

    const benchState = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const deps = aiDamageDepsFor(data, benchState, false)
    const ironHead = aiDamageRolls(benchState, 'MOVE_IRON_HEAD', 0, 1, deps)!
    const seismicToss = aiDamageRolls(benchState, 'MOVE_SEISMIC_TOSS', 0, 1, deps)!
    expect(lowestRoll(ironHead)).toBe(48)
    expect(highestRoll(ironHead)).toBe(57)
    expect(meanRoll(ironHead)).toBeCloseTo(52.3125, 4)
    expect(lowestRoll(ironHead)).toBeLessThan(50)
    expect(meanRoll(ironHead)).toBeGreaterThan(50)
    expect(lowestRoll(seismicToss)).toBe(50)
    expect(meanRoll(seismicToss)).toBe(50)
    expect(lowestRoll(seismicToss)).toBeGreaterThan(lowestRoll(ironHead))
    // The bench floor is the larger of the two (50), so 2 * 50 = 100 reaches
    // their HP exactly.
    const benchFloor = Math.max(lowestRoll(ironHead), lowestRoll(seismicToss))
    expect(benchFloor).toBe(50)
    expect(2 * benchFloor).toBe(theirHp)
    expect(2 * lowestRoll(ironHead)).toBe(96)
    expect(2 * lowestRoll(ironHead)).toBeLessThan(theirHp)
    // It takes Body Slam for 5/145 = 3.45%, under the default 50% line.
    const incoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(highestRoll(incoming)).toBe(5)
    expect(highestRoll(incoming) * 100).toBeLessThanOrEqual(50 * 145)

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'counter'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)
  })

  it('one point above the two-hit line the bench does not qualify, so no counter', () => {
    // H = 101: 2 * 50 = 100 < 101 and the bench does not outspeed, so neither
    // half of the bench threat test passes.
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_CELEBRATE'] },
        { species: 'SPECIES_AGGRON', level: 50, moves: ['MOVE_SEISMIC_TOSS', 'MOVE_IRON_HEAD'] },
      ],
      [THEIR_MACHAMP()],
    )
    const aggron = s.state.sides[0].party[1]!
    patchMon(s.state, 0, 0, { hp: 80 })
    patchMon(s.state, 0, 1, { rawStats: { ...aggron.rawStats, atk: 65 } })
    patchMon(s.state, 1, 0, { hp: 101 })
    expect(2 * 50).toBeLessThan(101)

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    layer.policy(s, 1, trace)
    expect(trace[0]!.tags).not.toEqual(['team', 'counter'])
  })
})
