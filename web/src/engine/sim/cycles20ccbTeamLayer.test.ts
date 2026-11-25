/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle cycles20ccb - counter purpose: bench fast-heavy threat uses move priority
// and tests individual moves. A slower bench mon with a priority move can qualify
// as fast-heavy (battle_main.c:4386 GetWhoStrikesFirst with priority from
// battle_main.c:4257 GetMovePriority), and a faster bench mon cannot qualify when
// their predicted move has higher priority.
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

describe('cycle cycles20ccb - counter: bench fast-heavy uses move priority', () => {
  it('case 1: slower bench mon with priority move outspeeds and counters', () => {
    // Slower Aggron (Spe 70) vs Machamp (Spe 75), Extreme Speed has priority +2.
    // Their HP H = 110 is chosen so 2 * lowest (102) < H <= 2 * mean (111.875).
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_CELEBRATE'] },
        { species: 'SPECIES_AGGRON', level: 50, moves: ['MOVE_EXTREME_SPEED'] },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])],
    )
    const theirHp = 110
    patchMon(s.state, 0, 0, { hp: 50 })
    patchMon(s.state, 1, 0, { hp: theirHp })

    // Premise assertions: speeds
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBe(70)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBe(75)
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBeLessThan(s.state.battlers[1]!.mon.rawStats.spe)

    // Premise assertions: move priorities
    expect(data.dataContext.move('MOVE_EXTREME_SPEED')!.priority).toBe(2)
    expect(data.dataContext.move('MOVE_BODY_SLAM')!.priority).toBe(0)
    expect(data.dataContext.move('MOVE_EXTREME_SPEED')!.priority!).toBeGreaterThan(
      data.dataContext.move('MOVE_BODY_SLAM')!.priority!,
    )

    // Premise assertions: bench mon's rolls on stateWithReserve
    const benchState = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const es = aiDamageRolls(benchState, 'MOVE_EXTREME_SPEED', 0, 1, aiDamageDepsFor(data, benchState, false))!
    expect(lowestRoll(es)).toBe(51)
    expect(meanRoll(es)).toBeCloseTo(55.9375, 4)
    expect(highestRoll(es)).toBe(61)
    expect(2 * lowestRoll(es)).toBe(102)
    expect(2 * lowestRoll(es)).toBeLessThan(theirHp)
    expect(2 * meanRoll(es)).toBeCloseTo(111.875, 4)
    expect(2 * meanRoll(es)).toBeGreaterThanOrEqual(theirHp)

    // Premise assertions: incoming high roll <= 50% current HP
    expect(s.state.sides[0].party[1]!.maxHp).toBe(145)
    const incomingBodySlam = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(highestRoll(incomingBodySlam)).toBe(5)
    expect(highestRoll(incomingBodySlam) * 100).toBeLessThanOrEqual(50 * s.state.sides[0].party[1]!.hp)

    // Premise assertions: active mon does neither (only Celebrate, threatened)
    expect(s.state.battlers[0]!.mon.moves).toEqual(['MOVE_CELEBRATE', null, null, null])
    const activeIncoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 0)!
    expect(highestRoll(activeIncoming) * 100).toBeGreaterThan(50 * s.state.battlers[0]!.mon.hp)

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'counter'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)
  })

  it('case 2: negative for case 1 - same fixture and window with priority 0 bench move does not counter', () => {
    // Slower Aggron (Spe 70) vs Machamp (Spe 75), Strength has priority 0.
    // Window H = 110: 2 * lowest (106) < H <= 2 * mean (115.625).
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_CELEBRATE'] },
        { species: 'SPECIES_AGGRON', level: 50, moves: ['MOVE_STRENGTH'] },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])],
    )
    const theirHp = 110
    patchMon(s.state, 0, 0, { hp: 50 })
    patchMon(s.state, 1, 0, { hp: theirHp })

    // Premise assertions: speeds
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBe(70)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBe(75)
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBeLessThan(s.state.battlers[1]!.mon.rawStats.spe)

    // Premise assertions: move priorities
    expect(data.dataContext.move('MOVE_STRENGTH')!.priority).toBe(0)
    expect(data.dataContext.move('MOVE_BODY_SLAM')!.priority).toBe(0)

    // Premise assertions: bench mon's rolls on stateWithReserve
    const benchState = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const str = aiDamageRolls(benchState, 'MOVE_STRENGTH', 0, 1, aiDamageDepsFor(data, benchState, false))!
    expect(lowestRoll(str)).toBe(53)
    expect(meanRoll(str)).toBeCloseTo(57.8125, 4)
    expect(highestRoll(str)).toBe(63)
    expect(2 * lowestRoll(str)).toBe(106)
    expect(2 * lowestRoll(str)).toBeLessThan(theirHp)
    expect(2 * meanRoll(str)).toBeCloseTo(115.625, 4)
    expect(2 * meanRoll(str)).toBeGreaterThanOrEqual(theirHp)

    // Premise assertions: incoming high roll <= 50% current HP
    expect(s.state.sides[0].party[1]!.maxHp).toBe(145)
    const incomingBodySlam = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(highestRoll(incomingBodySlam)).toBe(5)
    expect(highestRoll(incomingBodySlam) * 100).toBeLessThanOrEqual(50 * s.state.sides[0].party[1]!.hp)

    // Premise assertions: active mon does neither
    expect(s.state.battlers[0]!.mon.moves).toEqual(['MOVE_CELEBRATE', null, null, null])
    const activeIncoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 0)!
    expect(highestRoll(activeIncoming) * 100).toBeGreaterThan(50 * s.state.battlers[0]!.mon.hp)

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    layer.policy(s, 1, trace)
    expect(trace[0]!.tags).not.toEqual(['team', 'counter'])
  })

  it('case 3: same-move rule - heavy priority-0 move and light priority move cannot combine to counter', () => {
    // Slower Aggron (Spe 70) vs Machamp (Spe 75), H = 114.
    // Strength (prio 0): 2 * mean (115.625) >= H, but does not outspeed.
    // Extreme Speed (prio 2): outspeeds, but 2 * mean (111.875) < H.
    // Neither move has 2 * lowest >= H (106 < 114, 102 < 114).
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_CELEBRATE'] },
        { species: 'SPECIES_AGGRON', level: 50, moves: ['MOVE_STRENGTH', 'MOVE_EXTREME_SPEED'] },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])],
    )
    const theirHp = 114
    patchMon(s.state, 0, 0, { hp: 50 })
    patchMon(s.state, 1, 0, { hp: theirHp })

    // Premise assertions: speeds
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBe(70)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBe(75)
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBeLessThan(s.state.battlers[1]!.mon.rawStats.spe)

    // Premise assertions: move priorities
    expect(data.dataContext.move('MOVE_STRENGTH')!.priority).toBe(0)
    expect(data.dataContext.move('MOVE_EXTREME_SPEED')!.priority).toBe(2)
    expect(data.dataContext.move('MOVE_BODY_SLAM')!.priority).toBe(0)

    // Premise assertions: bench mon's rolls on stateWithReserve
    const benchState = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const deps = aiDamageDepsFor(data, benchState, false)
    const str = aiDamageRolls(benchState, 'MOVE_STRENGTH', 0, 1, deps)!
    const es = aiDamageRolls(benchState, 'MOVE_EXTREME_SPEED', 0, 1, deps)!
    expect(lowestRoll(str)).toBe(53)
    expect(meanRoll(str)).toBeCloseTo(57.8125, 4)
    expect(lowestRoll(es)).toBe(51)
    expect(meanRoll(es)).toBeCloseTo(55.9375, 4)

    // Premise assertions: Strength is heavy priority 0, ES is non-heavy priority, no KO in two
    expect(2 * meanRoll(str)).toBeCloseTo(115.625, 4)
    expect(2 * meanRoll(str)).toBeGreaterThanOrEqual(theirHp)
    expect(2 * meanRoll(es)).toBeCloseTo(111.875, 4)
    expect(2 * meanRoll(es)).toBeLessThan(theirHp)
    expect(2 * lowestRoll(str)).toBe(106)
    expect(2 * lowestRoll(str)).toBeLessThan(theirHp)
    expect(2 * lowestRoll(es)).toBe(102)
    expect(2 * lowestRoll(es)).toBeLessThan(theirHp)

    // Premise assertions: incoming high roll <= 50% current HP
    expect(s.state.sides[0].party[1]!.maxHp).toBe(145)
    const incomingBodySlam = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(highestRoll(incomingBodySlam)).toBe(5)
    expect(highestRoll(incomingBodySlam) * 100).toBeLessThanOrEqual(50 * s.state.sides[0].party[1]!.hp)

    // Premise assertions: active mon does neither
    expect(s.state.battlers[0]!.mon.moves).toEqual(['MOVE_CELEBRATE', null, null, null])
    const activeIncoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 0)!
    expect(highestRoll(activeIncoming) * 100).toBeGreaterThan(50 * s.state.battlers[0]!.mon.hp)

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    layer.policy(s, 1, trace)
    expect(trace[0]!.tags).not.toEqual(['team', 'counter'])
  })

  it('case 4: faster bench mon with priority-0 move facing priority +1 foe move does not counter', () => {
    // Faster Jolteon (Spe 150) vs Machamp (Spe 75).
    // Jolteon has priority-0 Thunderbolt; foe has priority +1 Mach Punch.
    // Window H = 165: 2 * lowest (156) < H <= 2 * mean (169.375).
    // Mach Punch strikes first due to priority, so Jolteon does not outspeed.
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_CELEBRATE'] },
        { species: 'SPECIES_JOLTEON', level: 50, moves: ['MOVE_THUNDERBOLT'] },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_MACH_PUNCH'])],
    )
    const theirHp = 165
    patchMon(s.state, 0, 0, { hp: 50 })
    patchMon(s.state, 1, 0, { hp: theirHp })

    // Premise assertions: speeds
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBe(150)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBe(75)
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBeGreaterThan(s.state.battlers[1]!.mon.rawStats.spe)

    // Premise assertions: move priorities
    expect(data.dataContext.move('MOVE_THUNDERBOLT')!.priority).toBe(0)
    expect(data.dataContext.move('MOVE_MACH_PUNCH')!.priority).toBe(1)
    expect(data.dataContext.move('MOVE_MACH_PUNCH')!.priority!).toBeGreaterThan(
      data.dataContext.move('MOVE_THUNDERBOLT')!.priority!,
    )

    // Premise assertions: bench mon's rolls on stateWithReserve
    const benchState = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const tb = aiDamageRolls(benchState, 'MOVE_THUNDERBOLT', 0, 1, aiDamageDepsFor(data, benchState, false))!
    expect(lowestRoll(tb)).toBe(78)
    expect(meanRoll(tb)).toBeCloseTo(84.6875, 4)
    expect(highestRoll(tb)).toBe(92)
    expect(2 * lowestRoll(tb)).toBe(156)
    expect(2 * lowestRoll(tb)).toBeLessThan(theirHp)
    expect(2 * meanRoll(tb)).toBeCloseTo(169.375, 4)
    expect(2 * meanRoll(tb)).toBeGreaterThanOrEqual(theirHp)

    // Premise assertions: incoming high roll <= 50% current HP
    expect(s.state.sides[0].party[1]!.maxHp).toBe(140)
    const incomingMachPunch = rangeOnOurReserve(s, 'MOVE_MACH_PUNCH', 1)!
    expect(highestRoll(incomingMachPunch)).toBe(68)
    expect(highestRoll(incomingMachPunch) * 100).toBeLessThanOrEqual(50 * s.state.sides[0].party[1]!.hp)

    // Premise assertions: active mon does neither
    expect(s.state.battlers[0]!.mon.moves).toEqual(['MOVE_CELEBRATE', null, null, null])
    const activeIncoming = rangeOnOurReserve(s, 'MOVE_MACH_PUNCH', 0)!
    expect(highestRoll(activeIncoming) * 100).toBeGreaterThan(50 * s.state.battlers[0]!.mon.hp)

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    layer.policy(s, 1, trace)
    expect(trace[0]!.tags).not.toEqual(['team', 'counter'])
  })

  it('case 5: control for case 4 - identical bench and H rule with priority 0 foe move counters', () => {
    // Identical Jolteon bench and H = 165 rule, but foe has priority-0 Rock Slide.
    // Thunderbolt (prio 0) vs Rock Slide (prio 0): Jolteon is faster (150 > 75),
    // so Jolteon strikes first and fast-heavy counter fires.
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_CELEBRATE'] },
        { species: 'SPECIES_JOLTEON', level: 50, moves: ['MOVE_THUNDERBOLT'] },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_ROCK_SLIDE'])],
    )
    const theirHp = 165
    patchMon(s.state, 0, 0, { hp: 50 })
    patchMon(s.state, 1, 0, { hp: theirHp })

    // Premise assertions: speeds
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBe(150)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBe(75)
    expect(s.state.sides[0].party[1]!.rawStats.spe).toBeGreaterThan(s.state.battlers[1]!.mon.rawStats.spe)

    // Premise assertions: move priorities
    expect(data.dataContext.move('MOVE_THUNDERBOLT')!.priority).toBe(0)
    expect(data.dataContext.move('MOVE_ROCK_SLIDE')!.priority).toBe(0)

    // Premise assertions: bench mon's rolls on stateWithReserve
    const benchState = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const tb = aiDamageRolls(benchState, 'MOVE_THUNDERBOLT', 0, 1, aiDamageDepsFor(data, benchState, false))!
    expect(lowestRoll(tb)).toBe(78)
    expect(meanRoll(tb)).toBeCloseTo(84.6875, 4)
    expect(highestRoll(tb)).toBe(92)
    expect(2 * lowestRoll(tb)).toBe(156)
    expect(2 * lowestRoll(tb)).toBeLessThan(theirHp)
    expect(2 * meanRoll(tb)).toBeCloseTo(169.375, 4)
    expect(2 * meanRoll(tb)).toBeGreaterThanOrEqual(theirHp)

    // Premise assertions: incoming high roll <= 50% current HP
    expect(s.state.sides[0].party[1]!.maxHp).toBe(140)
    const incomingRockSlide = rangeOnOurReserve(s, 'MOVE_ROCK_SLIDE', 1)!
    expect(highestRoll(incomingRockSlide)).toBe(63)
    expect(highestRoll(incomingRockSlide) * 100).toBeLessThanOrEqual(50 * s.state.sides[0].party[1]!.hp)

    // Premise assertions: active mon does neither
    expect(s.state.battlers[0]!.mon.moves).toEqual(['MOVE_CELEBRATE', null, null, null])
    const activeIncoming = rangeOnOurReserve(s, 'MOVE_ROCK_SLIDE', 0)!
    expect(highestRoll(activeIncoming) * 100).toBeGreaterThan(50 * s.state.battlers[0]!.mon.hp)

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'counter'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)
  })
})
