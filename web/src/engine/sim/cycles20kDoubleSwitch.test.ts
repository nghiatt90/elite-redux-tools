/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import { PARTY_SIZE } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import {
  DEFAULT_SAFETY_PCT,
  evaluateMoves,
  highestRoll,
  lowestRoll,
  rangeOnOurReserve,
  readPredictions,
  stateWithReserve,
} from './driver/rolePolicy'
import { beginTurn, cloneSession, createSession, stepTurn } from './driver/session'
import type { BattleSession } from './driver/session'
import {
  DEFAULT_TEAM_GENES,
  TEAM_PURPOSES,
  acceptableSwitchIn,
  createTeamLayer,
  isGoodCounter,
  planDoubleSwitch,
  scoreBench,
  stayTest,
} from './driver/teamLayer'
import type { TeamGenes, TeamPurpose } from './driver/teamLayer'
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
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons, overrides),
    rng: createRandomSource(seed),
  })
}

function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const onlyPurpose = (purpose: TeamPurpose): Record<TeamPurpose, boolean> => ({
  preserve: purpose === 'preserve',
  sacrifice: purpose === 'sacrifice',
  counter: purpose === 'counter',
  doubleSwitch: purpose === 'doubleSwitch',
  entryAbility: purpose === 'entryAbility',
  support: purpose === 'support',
  ppLoop: purpose === 'ppLoop',
})

const playerCelebrateLead: PlayerMonSpec = {
  species: 'SPECIES_SNORLAX',
  level: 50,
  moves: ['MOVE_CELEBRATE'],
}

const playerGengarCounter: PlayerMonSpec = {
  species: 'SPECIES_GENGAR',
  level: 50,
  moves: ['MOVE_SHADOW_BALL'],
}

describe('cycle s20k - team layer doubleSwitch purpose', () => {
  it('case 1: fires when a safe first switch and a good second counter exist', () => {
    const foeMachamp = mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])
    const s = session(
      [playerCelebrateLead, playerGengarCounter, playerGengarCounter],
      [foeMachamp],
    )

    // Verify preconditions
    const view = readPredictions(s, DEFAULT_SAFETY_PCT)
    expect(view.predictedMoveId).toBe('MOVE_BODY_SLAM')
    expect(view.predictedAction).not.toBeNull()

    // Snorlax cannot KO with Celebrate -> stay test is false
    const stay = stayTest(s, view)
    expect(stay.stay).toBe(false)

    // Gengar is immune to Body Slam (Normal)
    const bodySlamOnGengar = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)
    expect(bodySlamOnGengar?.isImmune).toBe(true)

    // Calculate Shadow Ball damage against Machamp and patch Machamp HP so 2 * lowest >= hp
    const sub = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const probe = cloneSession({ ...s, state: sub }, 0)
    const gengarMoves = evaluateMoves(probe, null).filter((m) => m.moveId === 'MOVE_SHADOW_BALL')
    expect(gengarMoves.length).toBeGreaterThan(0)
    const shadowBallRoll = lowestRoll(gengarMoves[0]!.range!)
    expect(shadowBallRoll).toBeGreaterThan(0)

    patchMon(s.state, 1, 0, { hp: 2 * shadowBallRoll })
    expect(2 * shadowBallRoll).toBeGreaterThanOrEqual(s.state.battlers[1]!.mon.hp)

    // Check planDoubleSwitch directly
    const genes: TeamGenes = {
      ...DEFAULT_TEAM_GENES,
      purposeFlags: onlyPurpose('doubleSwitch'),
    }
    const plan = planDoubleSwitch(s, view, genes)
    expect(plan).not.toBeNull()
    expect(plan!.firstSlot).toBe(1)
    expect(plan!.secondSlot).toBe(2)
    expect(plan!.secondMoveId).toBe('MOVE_BODY_SLAM')

    // Drive through teamLayer policy
    const layer = createTeamLayer({
      roles: ['attacker', 'attacker', 'attacker'],
      genes,
    })
    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(choice).not.toBeNull()
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)
    expect(trace[0]!.tags).toEqual(['team', 'doubleSwitch'])

    // Apply the choice to the live session as policyBattle.ts does
    const gengarHpBefore = s.state.sides[0].party[1]!.hp
    s.state.battlers[0]!.monToSwitchIntoId = choice!.switchTo ?? PARTY_SIZE
    stepTurn(s, choice!.action)

    expect(s.state.battlers[0]!.partyIndex).toBe(1)
    expect(s.state.battlers[0]!.mon.hp).toBe(gengarHpBefore)
  })

  it('case 2: stay test true skips doubleSwitch even if plan is available', () => {
    // Fast lead Gengar with Shadow Ball vs low HP Machamp (1 hit KO, outspeeds)
    const fastGengarLead: PlayerMonSpec = {
      species: 'SPECIES_GENGAR',
      level: 50,
      moves: ['MOVE_SHADOW_BALL'],
    }
    const foeMachamp = mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])
    const s = session(
      [fastGengarLead, playerGengarCounter, playerGengarCounter],
      [foeMachamp],
    )

    // Patch foe Machamp to 10 HP so Gengar easily KOs with 1 hit
    patchMon(s.state, 1, 0, { hp: 10 })

    const view = readPredictions(s, DEFAULT_SAFETY_PCT)
    expect(view.predictedMoveId).toBe('MOVE_BODY_SLAM')

    const stay = stayTest(s, view)
    expect(stay.stay).toBe(true)
    expect(stay.outspeedsWithKo).toBe(true)

    const genes: TeamGenes = {
      ...DEFAULT_TEAM_GENES,
      purposeFlags: onlyPurpose('doubleSwitch'),
    }
    // Plan is non-null because bench has acceptable switch-in and counter
    const plan = planDoubleSwitch(s, view, genes)
    expect(plan).not.toBeNull()

    const layer = createTeamLayer({
      roles: ['attacker', 'attacker', 'attacker'],
      genes,
    })
    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)

    // Active mon stays and attacks, no doubleSwitch
    expect(trace.some((t) => t.tags.includes('doubleSwitch'))).toBe(false)
    expect(choice?.switchTo).toBeUndefined()
  })

  it('case 3: no good counter to the second prediction gives null plan and no switch', () => {
    // Lead Celebrate, bench mons are both Gengar with Celebrate only
    const nonCounterBench: PlayerMonSpec = {
      species: 'SPECIES_GENGAR',
      level: 50,
      moves: ['MOVE_CELEBRATE'],
    }
    const foeMachamp = mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])
    const s = session(
      [playerCelebrateLead, nonCounterBench, nonCounterBench],
      [foeMachamp],
    )

    // First switch-in (slot 1) is still acceptable
    const genes: TeamGenes = {
      ...DEFAULT_TEAM_GENES,
      purposeFlags: onlyPurpose('doubleSwitch'),
    }
    const acceptable = acceptableSwitchIn(s, 1, ['MOVE_BODY_SLAM'], genes)
    expect(acceptable).not.toBeNull()

    const view = readPredictions(s, DEFAULT_SAFETY_PCT)
    const plan = planDoubleSwitch(s, view, genes)
    expect(plan).toBeNull()

    const layer = createTeamLayer({
      roles: ['attacker', 'attacker', 'attacker'],
      genes,
    })
    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace.some((t) => t.tags.includes('doubleSwitch'))).toBe(false)
    expect(choice?.switchTo).toBeUndefined()
  })

  it('case 4: first hit not negligible (> switchInSafety%) gives null plan', () => {
    const playerMachampBench: PlayerMonSpec = {
      species: 'SPECIES_MACHAMP',
      level: 50,
      moves: ['MOVE_CLOSE_COMBAT'],
    }
    const foeMachamp = mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])
    const s = session(
      [playerCelebrateLead, playerGengarCounter, playerMachampBench],
      [foeMachamp],
    )

    // Calculate Shadow Ball damage against Machamp and patch Machamp HP so 2 * lowest >= hp (as in case 1)
    const sub = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const probe = cloneSession({ ...s, state: sub }, 0)
    const gengarMoves = evaluateMoves(probe, null).filter((m) => m.moveId === 'MOVE_SHADOW_BALL')
    expect(gengarMoves.length).toBeGreaterThan(0)
    const shadowBallRoll = lowestRoll(gengarMoves[0]!.range!)
    expect(shadowBallRoll).toBeGreaterThan(0)

    patchMon(s.state, 1, 0, { hp: 2 * shadowBallRoll })

    const view = readPredictions(s, DEFAULT_SAFETY_PCT)
    expect(view.predictedMoveId).toBe('MOVE_BODY_SLAM')
    expect(view.predictedAction).not.toBeNull()

    const genes: TeamGenes = {
      ...DEFAULT_TEAM_GENES,
      purposeFlags: onlyPurpose('doubleSwitch'),
    }

    const hp = s.state.sides[0].party[2]!.hp
    const range = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 2)
    expect(range).not.toBeNull()
    const high = highestRoll(range!)
    expect(high).toBeLessThan(hp)
    const lossPct = (high / hp) * 100
    expect(high * 100).toBeGreaterThan(DEFAULT_TEAM_GENES.switchInSafety * hp)

    expect(acceptableSwitchIn(s, 2, ['MOVE_BODY_SLAM'], genes)).toBeNull()

    const scored = scoreBench(s, 2, ['MOVE_BODY_SLAM'], genes.switchInSafety)
    expect(scored).not.toBeNull()
    expect(isGoodCounter(s, 2, scored!, s.state.battlers[1]!.mon.hp, view.predictedAction)).toBe(true)

    // Plan is null with default switchInSafety
    expect(planDoubleSwitch(s, view, genes)).toBeNull()

    // Control: relaxed switchInSafety makes plan non-null
    const controlGenes: TeamGenes = {
      ...genes,
      switchInSafety: Math.ceil(lossPct) + 1,
    }
    const controlPlan = planDoubleSwitch(s, view, controlGenes)
    expect(controlPlan).not.toBeNull()
  })

  it('case 5: live session state and RNG are unchanged by planDoubleSwitch', () => {
    const foeMachamp = mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])
    const s1 = session(
      [playerCelebrateLead, playerGengarCounter, playerGengarCounter],
      [foeMachamp],
      {},
      42,
    )
    const s2 = session(
      [playerCelebrateLead, playerGengarCounter, playerGengarCounter],
      [foeMachamp],
      {},
      42,
    )

    // Patch foe Machamp HP so plan fires
    patchMon(s1.state, 1, 0, { hp: 50 })
    patchMon(s2.state, 1, 0, { hp: 50 })

    const view = readPredictions(s1, DEFAULT_SAFETY_PCT)
    const genes: TeamGenes = {
      ...DEFAULT_TEAM_GENES,
      purposeFlags: onlyPurpose('doubleSwitch'),
    }

    const { rng: _r1, ...stateBefore } = s1.state
    const snapshotBefore = structuredClone(stateBefore)

    const plan = planDoubleSwitch(s1, view, genes)
    expect(plan).not.toBeNull()

    const { rng: _r2, ...stateAfter } = s1.state
    expect(stateAfter).toEqual(snapshotBefore)
    expect(s1.state.rng.random16()).toBe(s2.state.rng.random16())
  })

  it('case 6: doubleSwitch flag false suppresses the rule; TEAM_PURPOSES check', () => {
    const foeMachamp = mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])
    const s = session(
      [playerCelebrateLead, playerGengarCounter, playerGengarCounter],
      [foeMachamp],
    )
    patchMon(s.state, 1, 0, { hp: 50 })

    const genes: TeamGenes = {
      ...DEFAULT_TEAM_GENES,
      purposeFlags: {
        ...DEFAULT_TEAM_GENES.purposeFlags,
        doubleSwitch: false,
      },
    }

    const layer = createTeamLayer({
      roles: ['attacker', 'attacker', 'attacker'],
      genes,
    })
    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    layer.policy(s, 1, trace)
    expect(trace.some((t) => t.tags.includes('doubleSwitch'))).toBe(false)

    // With doubleSwitch isolated and off, no switch is chosen
    const sIsolated = session(
      [playerCelebrateLead, playerGengarCounter, playerGengarCounter],
      [foeMachamp],
    )
    patchMon(sIsolated.state, 1, 0, { hp: 50 })
    const layerIsolated = createTeamLayer({
      roles: ['attacker', 'attacker', 'attacker'],
      genes: {
        ...DEFAULT_TEAM_GENES,
        purposeFlags: {
          ...onlyPurpose('doubleSwitch'),
          doubleSwitch: false,
        },
      },
    })
    beginTurn(sIsolated)
    const choiceIsolated = layerIsolated.policy(sIsolated, 1, [])
    expect(choiceIsolated?.switchTo).toBeUndefined()

    // Assert TEAM_PURPOSES equals the 7-element default order
    expect(TEAM_PURPOSES).toEqual([
      'preserve',
      'sacrifice',
      'counter',
      'doubleSwitch',
      'entryAbility',
      'support',
      'ppLoop',
    ])
    expect(DEFAULT_TEAM_GENES.purposeOrder).toEqual([...TEAM_PURPOSES])
    expect(DEFAULT_TEAM_GENES.purposeFlags.doubleSwitch).toBe(true)
  })
})
