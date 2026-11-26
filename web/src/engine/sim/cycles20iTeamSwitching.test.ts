/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20i: Team layer voluntary switching -- stay test, stricter switch-in
// rule, and new gene otherMoveKoRisk.
//
// Principle: switching gives the opponent a free hit, so never switch when we
// can KO. Switch only to keep a mon we cannot afford to lose, or to bring in a
// mon that takes the hit with a negligible loss AND does something meaningful.
//
// Scaffolding follows cycle947TeamLayer.test.ts: sessions driven through
// createSession -> createTeamLayer(...).policy -> stepTurn with beginTurn.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { aiDamageRolls } from './ai/aiCalcDamage'
import { PARTY_SIZE } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import {
  buildFightSetup,
  gameSeed,
  playComparisonGame,
  type PolicyComparisonFixture,
} from './driver/policyComparison'
import {
  damageDistribution,
  evaluateMoves,
  highestRoll,
  koProbability,
  lowestRoll,
  outspeeds,
  rangeOnOurReserve,
  readPredictions,
} from './driver/rolePolicy'
import { aiDamageDepsFor, beginTurn, createSession, stepTurn } from './driver/session'
import type { BattleSession } from './driver/session'
import {
  DEFAULT_TEAM_GENES,
  STAY_KO_CHANCE,
  acceptableSwitchIn,
  createTeamLayer,
  stayTest,
  theirUsableMoves,
} from './driver/teamLayer'
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

const choiceMoveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

describe('cycles20i: team layer voluntary switching', () => {
  // Case 1 & Case 2 & Case 8
  it('case 1 & 2 & 8: fast KO lead stays; sub-50% KO lead switches to support when active not threatened', () => {
    // Jolteon (Spe 150) vs Machamp (Spe 75). Jolteon has Thunderbolt.
    // Teammate slot 1 is Kingdra (support) with Rain Dance.
    const playerLead: PlayerMonSpec = {
      species: 'SPECIES_JOLTEON',
      level: 50,
      moves: ['MOVE_THUNDERBOLT'],
    }
    const playerSupport: PlayerMonSpec = {
      species: 'SPECIES_KINGDRA',
      level: 50,
      moves: ['MOVE_RAIN_DANCE', 'MOVE_WATER_PULSE'],
    }
    // Opponent Machamp has Water Pulse (weak special move).
    const foeMon = mon('SPECIES_MACHAMP', ['MOVE_WATER_PULSE'])

    // --- Case 1: Foe HP patched so Thunderbolt is >= 50% KO ---
    const s1 = session([playerLead, playerSupport], [foeMon])
    const tbRange = aiDamageRolls(s1.state, 'MOVE_THUNDERBOLT', 0, 1, aiDamageDepsFor(data, s1.state, false))!
    expect(tbRange).not.toBeNull()
    const low = lowestRoll(tbRange)
    const high = highestRoll(tbRange)
    // Patch Machamp HP between lowest and highest roll so KO chance is >= 50%
    const targetHp = Math.floor((low + high) / 2)
    patchMon(s1.state, 1, 0, { hp: targetHp })

    const dist = damageDistribution(tbRange)
    const rawKo = koProbability(dist, targetHp)
    expect(rawKo).toBeGreaterThanOrEqual(0.5)
    expect(s1.state.battlers[0]!.mon.rawStats.spe).toBeGreaterThan(s1.state.battlers[1]!.mon.rawStats.spe)

    const view1 = readPredictions(s1, 50)
    const stay1 = stayTest(s1, view1)
    expect(stay1.stay).toBe(true)
    expect(stay1.outspeedsWithKo).toBe(true)

    const layer1 = createTeamLayer({ roles: ['attacker', 'support'] })
    const trace1: PolicyTraceEntry[] = []
    beginTurn(s1)
    const choice1 = layer1.policy(s1, 1, trace1)
    expect(choice1).not.toBeNull()
    // Should NOT switch to support!
    expect(choice1!.switchTo).toBeUndefined()
    expect(choiceMoveId(choice1!)).toBe('MOVE_THUNDERBOLT')
    expect(trace1.some((t) => t.tags.includes('support'))).toBe(false)

    s1.state.battlers[0]!.monToSwitchIntoId = choice1!.switchTo ?? PARTY_SIZE
    stepTurn(s1, choice1!.action)
    expect(s1.state.battlers[0]!.partyIndex).toBe(0)

    // --- Case 2: Machamp at full HP (165), Thunderbolt KO chance is 0% (< 50%) ---
    const s2 = session([playerLead, playerSupport], [foeMon])
    expect(s2.state.battlers[1]!.mon.hp).toBe(165)
    const rawKoFull = koProbability(dist, 165)
    expect(rawKoFull).toBe(0)

    const view2 = readPredictions(s2, 50)
    // Case 8: Assert active mon is not threatened
    expect(view2.threatened).toBe(false)

    const stay2 = stayTest(s2, view2)
    expect(stay2.stay).toBe(false)
    expect(stay2.outspeedsWithKo).toBe(false)

    const layer2 = createTeamLayer({ roles: ['attacker', 'support'] })
    const trace2: PolicyTraceEntry[] = []
    beginTurn(s2)
    const choice2 = layer2.policy(s2, 1, trace2)
    expect(choice2).not.toBeNull()
    expect(choice2!.switchTo).toBe(1)
    expect(trace2.some((t) => t.tags.includes('support'))).toBe(true)

    s2.state.battlers[0]!.monToSwitchIntoId = choice2!.switchTo ?? PARTY_SIZE
    stepTurn(s2, choice2!.action)
    expect(s2.state.battlers[0]!.partyIndex).toBe(1)
    expect(s2.state.battlers[0]!.mon.speciesId).toBe('SPECIES_KINGDRA')
  })

  // Case 3
  it('case 3: slower lead whose predicted hit KOs it (koThreat) does NOT pass stay test', () => {
    // Snorlax (Spe 50) vs Machamp (Spe 75).
    // Machamp has Close Combat (super-effective vs Snorlax).
    const playerLead: PlayerMonSpec = {
      species: 'SPECIES_SNORLAX',
      level: 50,
      moves: ['MOVE_BODY_SLAM'],
    }
    const playerReserve: PlayerMonSpec = {
      species: 'SPECIES_AGGRON',
      level: 50,
      moves: ['MOVE_IRON_HEAD'],
    }
    const foeMon = mon('SPECIES_MACHAMP', ['MOVE_CLOSE_COMBAT'])
    const s = session([playerLead, playerReserve], [foeMon])

    // Snorlax is slower
    expect(s.state.battlers[0]!.mon.rawStats.spe).toBe(50)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBe(75)

    // Patch foe Machamp to 20 HP so Snorlax Body Slam is 100% KO
    patchMon(s.state, 1, 0, { hp: 20 })
    // Patch Snorlax HP to 20 so Machamp Close Combat is guaranteed KO (koThreat)
    patchMon(s.state, 0, 0, { hp: 20 })

    const view = readPredictions(s, 50)
    expect(view.koThreat).toBe(true)

    const stay = stayTest(s, view)
    expect(stay.stay).toBe(false)
    expect(stay.outspeedsWithKo).toBe(false)
  })

  // Case 4
  it('case 4: preserve member that only survives switches; outspeeding preserve stays', () => {
    // Position A: Slower preserve member (Snorlax Spe 50 vs Machamp Spe 75)
    // Snorlax can KO Machamp (Machamp HP = 30, Body Slam >= 50).
    // Machamp has Body Slam (deals ~58 to Snorlax).
    // Snorlax HP = 80: survives Body Slam (80 > 58, koThreat = false),
    // but 58 > 80 * 0.5 (threatened = true).
    const playerPreserve: PlayerMonSpec = {
      species: 'SPECIES_SNORLAX',
      level: 50,
      moves: ['MOVE_BODY_SLAM'],
    }
    const playerBench: PlayerMonSpec = {
      species: 'SPECIES_AGGRON',
      level: 50,
      moves: ['MOVE_IRON_HEAD'],
    }
    const foeMon = mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])

    const sA = session([playerPreserve, playerBench], [foeMon])
    patchMon(sA.state, 1, 0, { hp: 30 })
    patchMon(sA.state, 0, 0, { hp: 80 })

    const viewA = readPredictions(sA, 50)
    expect(viewA.koThreat).toBe(false)
    expect(viewA.threatened).toBe(true)

    const stayA = stayTest(sA, viewA)
    // Survives and has KO, but does not outspeed
    expect(stayA.stay).toBe(true)
    expect(stayA.outspeedsWithKo).toBe(false)

    const layerA = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { preserve: 0 },
    })
    const traceA: PolicyTraceEntry[] = []
    beginTurn(sA)
    const choiceA = layerA.policy(sA, 1, traceA)
    expect(choiceA).not.toBeNull()
    expect(choiceA!.switchTo).toBe(1)
    expect(traceA[0]!.tags).toEqual(['team', 'preserve'])

    sA.state.battlers[0]!.monToSwitchIntoId = choiceA!.switchTo ?? PARTY_SIZE
    stepTurn(sA, choiceA!.action)
    expect(sA.state.battlers[0]!.partyIndex).toBe(1)

    // Position B: Same position, but preserve member outspeeds (Jolteon Spe 150)
    const fastPreserve: PlayerMonSpec = {
      species: 'SPECIES_JOLTEON',
      level: 50,
      moves: ['MOVE_THUNDERBOLT'],
    }
    const sB = session([fastPreserve, playerBench], [foeMon])
    patchMon(sB.state, 1, 0, { hp: 30 })
    patchMon(sB.state, 0, 0, { hp: 80 })

    const viewB = readPredictions(sB, 50)
    const stayB = stayTest(sB, viewB)
    expect(stayB.stay).toBe(true)
    expect(stayB.outspeedsWithKo).toBe(true)

    const layerB = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { preserve: 0 },
    })
    const traceB: PolicyTraceEntry[] = []
    beginTurn(sB)
    const choiceB = layerB.policy(sB, 1, traceB)
    expect(choiceB).not.toBeNull()
    expect(choiceB!.switchTo).toBeUndefined()
    expect(choiceMoveId(choiceB!)).toBe('MOVE_THUNDERBOLT')

    sB.state.battlers[0]!.monToSwitchIntoId = choiceB!.switchTo ?? PARTY_SIZE
    stepTurn(sB, choiceB!.action)
    expect(sB.state.battlers[0]!.partyIndex).toBe(0)
  })

  // Case 5
  it('case 5: incoming mon whose predicted loss is above switchInSafety is refused', () => {
    // Snorlax vs Machamp. Machamp predicted move is Body Slam.
    // Reserve slot 1 is Snorlax at full HP (235). Machamp Body Slam rolls 68 max damage.
    // 68 / 235 = 28.9% of current HP (between 20% and 30%).
    const playerLead: PlayerMonSpec = {
      species: 'SPECIES_SNORLAX',
      level: 50,
      moves: ['MOVE_CELEBRATE'],
    }
    const playerBench: PlayerMonSpec = {
      species: 'SPECIES_SNORLAX',
      level: 50,
      moves: ['MOVE_BODY_SLAM'],
    }
    const foeMon = mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])
    const s = session([playerLead, playerBench], [foeMon])

    const bsRange = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(bsRange).not.toBeNull()
    const high = highestRoll(bsRange)
    const reserveHp = s.state.sides[0].party[1]!.hp
    const lossPct = (high / reserveHp) * 100
    expect(lossPct).toBeGreaterThan(20)
    expect(lossPct).toBeLessThan(30)

    // With default switchInSafety: 20 -> refused!
    const refused = acceptableSwitchIn(s, 1, ['MOVE_BODY_SLAM'], DEFAULT_TEAM_GENES)
    expect(refused).toBeNull()

    // Positive control: With switchInSafety: 30 -> accepted!
    const accepted = acceptableSwitchIn(s, 1, ['MOVE_BODY_SLAM'], {
      ...DEFAULT_TEAM_GENES,
      switchInSafety: 30,
    })
    expect(accepted).not.toBeNull()
    expect(accepted!.acceptable).toBe(true)
  })

  // Case 6 & Case 7
  it('case 6 & 7: incoming mon barely scratched by predicted move refused if another move KOs it (including priority)', () => {
    // Opponent has two moves:
    // Move 0: Peck (Flying vs Rock/Steel Aggron deals ~4 damage)
    // Move 1: Mach Punch (priority move, 4x super effective vs Aggron)
    const playerLead: PlayerMonSpec = {
      species: 'SPECIES_SNORLAX',
      level: 50,
      moves: ['MOVE_CELEBRATE'],
    }
    const playerBench: PlayerMonSpec = {
      species: 'SPECIES_AGGRON',
      level: 50,
      moves: ['MOVE_IRON_HEAD'],
    }
    const foeMon = mon('SPECIES_MACHAMP', ['MOVE_PECK', 'MOVE_MACH_PUNCH'])
    const s = session([playerLead, playerBench], [foeMon])

    // Patch reserve Aggron HP to 40 HP so Mach Punch (deals ~45-55) is >= 0.15 KO,
    // while Peck deals ~4 damage (4 / 40 = 10% <= 20%)
    patchMon(s.state, 0, 1, { hp: 40 })
    const pRange = rangeOnOurReserve(s, 'MOVE_PECK', 1)!
    expect(pRange).not.toBeNull()
    const pHigh = highestRoll(pRange)
    expect((pHigh / 40) * 100).toBeLessThanOrEqual(20)

    const mpRange = rangeOnOurReserve(s, 'MOVE_MACH_PUNCH', 1)!
    expect(mpRange).not.toBeNull()
    const mpKo = koProbability(damageDistribution(mpRange), 40)
    expect(mpKo).toBeGreaterThanOrEqual(DEFAULT_TEAM_GENES.otherMoveKoRisk)

    // Case 7: Mach Punch is a priority move
    expect(data.dataContext.move('MOVE_MACH_PUNCH')?.priority).toBeGreaterThan(0)
    expect(theirUsableMoves(s)).toContain('MOVE_MACH_PUNCH')

    // Refused because Mach Punch KOs with prob >= 0.15
    const refused = acceptableSwitchIn(s, 1, ['MOVE_PECK'], DEFAULT_TEAM_GENES)
    expect(refused).toBeNull()

    // Control 1: Raising otherMoveKoRisk above mpKo accepts it
    const acceptedHighGene = acceptableSwitchIn(s, 1, ['MOVE_PECK'], {
      ...DEFAULT_TEAM_GENES,
      otherMoveKoRisk: 1.01,
    })
    expect(acceptedHighGene).not.toBeNull()

    // Control 2: Setting Mach Punch PP to 0 removes it from usable moves, accepts it
    s.state.battlers[1]!.mon.pp[1] = 0
    expect(theirUsableMoves(s)).not.toContain('MOVE_MACH_PUNCH')
    const acceptedZeroPp = acceptableSwitchIn(s, 1, ['MOVE_PECK'], DEFAULT_TEAM_GENES)
    expect(acceptedZeroPp).not.toBeNull()
  })

  // Case 9
  it('case 9: live session HP, stat stages and RNG draw count unchanged after stay test and scan', () => {
    const playerLead: PlayerMonSpec = {
      species: 'SPECIES_JOLTEON',
      level: 50,
      moves: ['MOVE_THUNDERBOLT'],
    }
    const playerBench: PlayerMonSpec = {
      species: 'SPECIES_SNORLAX',
      level: 50,
      moves: ['MOVE_BODY_SLAM'],
    }
    const foeMon = mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM', 'MOVE_CLOSE_COMBAT'])
    const s = session([playerLead, playerBench], [foeMon])

    const leadHpBefore = s.state.battlers[0]!.mon.hp
    const leadStagesBefore = [...s.state.battlers[0]!.mon.statStages]
    const benchHpBefore = s.state.sides[0].party[1]!.hp
    const foeHpBefore = s.state.battlers[1]!.mon.hp
    const foeStagesBefore = [...s.state.battlers[1]!.mon.statStages]

    let draws = 0
    const origRng = s.state.rng.random16
    s.state.rng.random16 = () => {
      draws++
      return origRng()
    }

    const view = readPredictions(s, 50)
    // Reset draw count after predictAi (which uses SPEED_PROBE_SEED / PREDICTION_SEED clone)
    draws = 0

    // Evaluate stay test and acceptableSwitchIn scan
    const stay = stayTest(s, view)
    expect(stay).toBeDefined()
    const scored = acceptableSwitchIn(s, 1, ['MOVE_BODY_SLAM'], DEFAULT_TEAM_GENES)
    expect(scored).toBeDefined()

    // Assert zero RNG draws on live session
    expect(draws).toBe(0)
    // Assert HP unchanged
    expect(s.state.battlers[0]!.mon.hp).toBe(leadHpBefore)
    expect(s.state.sides[0].party[1]!.hp).toBe(benchHpBefore)
    expect(s.state.battlers[1]!.mon.hp).toBe(foeHpBefore)
    // Assert stat stages unchanged
    expect(s.state.battlers[0]!.mon.statStages).toEqual(leadStagesBefore)
    expect(s.state.battlers[1]!.mon.statStages).toEqual(foeStagesBefore)
  })

  // Case 10
  it('case 10: accuracy factor: move with raw KO prob >= 0.5 but product < 0.5 does not pass stay test', () => {
    // Zap Cannon (50% accuracy).
    // Set target HP so raw KO prob is ~0.80 (>= 0.5), product 0.80 * 0.50 = 0.40 < 0.50.
    const playerLead: PlayerMonSpec = {
      species: 'SPECIES_JOLTEON',
      level: 50,
      moves: ['MOVE_ZAP_CANNON'],
    }
    const playerBench: PlayerMonSpec = {
      species: 'SPECIES_SNORLAX',
      level: 50,
      moves: ['MOVE_BODY_SLAM'],
    }
    const foeMon = mon('SPECIES_MACHAMP', ['MOVE_WATER_PULSE'])
    const s = session([playerLead, playerBench], [foeMon])

    const acc = data.dataContext.move('MOVE_ZAP_CANNON')?.accuracy ?? 50
    expect(acc).toBe(50)

    const zcRange = aiDamageRolls(s.state, 'MOVE_ZAP_CANNON', 0, 1, aiDamageDepsFor(data, s.state, false))!
    const low = lowestRoll(zcRange)
    const high = highestRoll(zcRange)

    const targetHp = Math.round(low + (4 * (high - low)) / 15)
    patchMon(s.state, 1, 0, { hp: targetHp })

    const dist = damageDistribution(zcRange)
    const rawKo = koProbability(dist, targetHp)
    expect(rawKo).toBeGreaterThanOrEqual(0.5)
    const effectiveKo = rawKo * (acc / 100)
    expect(effectiveKo).toBeLessThan(STAY_KO_CHANCE)

    const view = readPredictions(s, 50)
    const stay = stayTest(s, view)
    expect(stay.stay).toBe(false)
    expect(stay.outspeedsWithKo).toBe(false)

    // Positive control: Thunderbolt (100% accuracy) with same target HP passes
    const playerLeadControl: PlayerMonSpec = {
      species: 'SPECIES_JOLTEON',
      level: 50,
      moves: ['MOVE_THUNDERBOLT'],
    }
    const sCtrl = session([playerLeadControl, playerBench], [foeMon])
    const tbRange = aiDamageRolls(sCtrl.state, 'MOVE_THUNDERBOLT', 0, 1, aiDamageDepsFor(data, sCtrl.state, false))!
    const tbLow = lowestRoll(tbRange)
    const tbHigh = highestRoll(tbRange)
    const tbTargetHp = Math.round(tbLow + (4 * (tbHigh - tbLow)) / 15)
    patchMon(sCtrl.state, 1, 0, { hp: tbTargetHp })

    const tbRawKo = koProbability(damageDistribution(tbRange), tbTargetHp)
    expect(tbRawKo).toBeGreaterThanOrEqual(0.5)
    const tbEffectiveKo = tbRawKo * 1.0
    expect(tbEffectiveKo).toBeGreaterThanOrEqual(STAY_KO_CHANCE)

    const viewCtrl = readPredictions(sCtrl, 50)
    const stayCtrl = stayTest(sCtrl, viewCtrl)
    expect(stayCtrl.stay).toBe(true)
    expect(stayCtrl.outspeedsWithKo).toBe(true)
  })

  // Case 11
  it('case 11: entryAbility candidate refused by (a) or (b), and counter candidate refused by (b)', () => {
    // --- entryAbility refused by (a) ---
    // Bench mon has Intimidate (Aggron).
    // Foe Machamp uses physical move Close Combat which deals > 20% to Aggron.
    const playerLead: PlayerMonSpec = {
      species: 'SPECIES_SNORLAX',
      level: 50,
      moves: ['MOVE_CELEBRATE'],
    }
    const playerIntimidate: PlayerMonSpec = {
      species: 'SPECIES_AGGRON',
      level: 50,
      moves: ['MOVE_IRON_HEAD'],
      ability: 'ABILITY_INTIMIDATE',
    }
    const foeMachamp = mon('SPECIES_MACHAMP', ['MOVE_CLOSE_COMBAT'])
    const s1 = session([playerLead, playerIntimidate], [foeMachamp])

    // Close Combat vs Aggron is 4x super effective, deals > 20%
    const ccRange = aiDamageRolls(s1.state, 'MOVE_CLOSE_COMBAT', 1, 0, aiDamageDepsFor(data, s1.state, false))!
    const aggronHp = s1.state.sides[0].party[1]!.hp
    expect((highestRoll(ccRange) / aggronHp) * 100).toBeGreaterThan(20)

    // ruleEntryAbility refuses via (a)
    const layer1 = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { purposeOrder: ['entryAbility', 'preserve', 'sacrifice', 'counter', 'support', 'ppLoop'] },
    })
    const trace1: PolicyTraceEntry[] = []
    const choice1 = layer1.policy(s1, 1, trace1)
    expect(choice1?.switchTo).toBeUndefined()
    expect(trace1.some((t) => t.tags.includes('entryAbility'))).toBe(false)

    // Positive control for (a): If predicted move deals <= 20% (e.g. Tackle), Intimidate qualifies
    const foeTackle = mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])
    const s1Ctrl = session([playerLead, playerIntimidate], [foeTackle])
    const trace1Ctrl: PolicyTraceEntry[] = []
    const choice1Ctrl = layer1.policy(s1Ctrl, 1, trace1Ctrl)
    expect(choice1Ctrl?.switchTo).toBe(1)
    expect(trace1Ctrl.some((t) => t.tags.includes('entryAbility'))).toBe(true)

    // --- entryAbility refused by (b) ---
    // Foe has Tackle (predicted move, deals little) AND Close Combat (lethal move with PP).
    const foeBoth = mon('SPECIES_MACHAMP', ['MOVE_TACKLE', 'MOVE_CLOSE_COMBAT'])
    const s2 = session([playerLead, playerIntimidate], [foeBoth])
    const trace2: PolicyTraceEntry[] = []
    const choice2 = layer1.policy(s2, 1, trace2)
    expect(choice2?.switchTo).toBeUndefined()
    // Refused by (b) because Close Combat KOs with >= otherMoveKoRisk!
    expect(trace2.some((t) => t.tags.includes('entryAbility'))).toBe(false)

    // Positive control for (b): Zero out Close Combat PP -> qualifies!
    s2.state.battlers[1]!.mon.pp[1] = 0
    const trace2Ctrl: PolicyTraceEntry[] = []
    const choice2Ctrl = layer1.policy(s2, 1, trace2Ctrl)
    expect(choice2Ctrl?.switchTo).toBe(1)
    expect(trace2Ctrl.some((t) => t.tags.includes('entryAbility'))).toBe(true)

    // --- counter candidate refused by (b) ---
    // Player lead Jolteon has Thunder Shock (weak attack that outspeeds but does not 2-hit KO).
    // Bench mon Machamp has Close Combat (threatens 2-hit KO on foe Snorlax).
    // Foe Snorlax has Pursuit (deals 15 damage, <= 20% of 100 HP) AND Giga Impact (deals 150+ damage, KOs 100 HP).
    const playerFastLead: PlayerMonSpec = {
      species: 'SPECIES_JOLTEON',
      level: 50,
      moves: ['MOVE_THUNDER_SHOCK'],
    }
    const playerCounter: PlayerMonSpec = {
      species: 'SPECIES_MACHAMP',
      level: 50,
      moves: ['MOVE_CLOSE_COMBAT'],
    }
    const foeSnorlax = mon('SPECIES_SNORLAX', ['MOVE_PURSUIT', 'MOVE_GIGA_IMPACT'])
    const s3 = session([playerFastLead, playerCounter], [foeSnorlax])
    // Patch bench Machamp HP to 100 HP so Giga Impact KOs with >= 0.15, while Pursuit is <= 20%
    patchMon(s3.state, 0, 1, { hp: 100 })

    const layerCounter = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { purposeOrder: ['counter', 'preserve', 'sacrifice', 'entryAbility', 'support', 'ppLoop'] },
    })
    const trace3: PolicyTraceEntry[] = []
    const choice3 = layerCounter.policy(s3, 1, trace3)
    expect(choice3?.switchTo).toBeUndefined()
    // Refused by (b) because Giga Impact KOs Machamp!
    expect(trace3.some((t) => t.tags.includes('counter'))).toBe(false)

    // Positive control: Zero out Giga Impact PP -> counter fires!
    s3.state.battlers[1]!.mon.pp[1] = 0
    const trace3Ctrl: PolicyTraceEntry[] = []
    const choice3Ctrl = layerCounter.policy(s3, 1, trace3Ctrl)
    expect(choice3Ctrl?.switchTo).toBe(1)
    expect(trace3Ctrl.some((t) => t.tags.includes('counter'))).toBe(true)
    expect(trace3Ctrl.some((t) => t.tags.includes('counter'))).toBe(true)
    expect(trace3Ctrl.some((t) => t.tags.includes('counter'))).toBe(true)
  })

  // Case 12
  it('case 12: Fake Out off the first turn is not a KO move', () => {
    // Lead Snorlax with Fake Out. Foe Machamp patched to 10 HP (Fake Out deals ~25+).
    const playerLead: PlayerMonSpec = {
      species: 'SPECIES_SNORLAX',
      level: 50,
      moves: ['MOVE_FAKE_OUT'],
    }
    const playerBench: PlayerMonSpec = {
      species: 'SPECIES_AGGRON',
      level: 50,
      moves: ['MOVE_IRON_HEAD'],
    }
    const foeMon = mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])
    const s = session([playerLead, playerBench], [foeMon])
    patchMon(s.state, 1, 0, { hp: 10 })

    const foRange = aiDamageRolls(s.state, 'MOVE_FAKE_OUT', 0, 1, aiDamageDepsFor(data, s.state, false))!
    expect(lowestRoll(foRange)).toBeGreaterThan(10)

    // Off the first turn: isFirstTurn = 0
    s.state.battlers[0]!.volatiles.isFirstTurn = 0

    const view = readPredictions(s, 50)
    const stay = stayTest(s, view)
    // Fake Out excluded, so stay is false!
    expect(stay.stay).toBe(false)
    expect(stay.outspeedsWithKo).toBe(false)

    // Positive control: On first turn (isFirstTurn = 2)
    s.state.battlers[0]!.volatiles.isFirstTurn = 2
    const stayFirstTurn = stayTest(s, view)
    expect(stayFirstTurn.stay).toBe(true)
    expect(stayFirstTurn.outspeedsWithKo).toBe(true)
  })
})

// --- smoke: Sidney and Drake, a few role games with turn-1 stay test numbers ---
const FIXTURE_PATH = resolve(import.meta.dirname, '../../../../docs/battle-sim/role-policy-test-fights.json')
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as PolicyComparisonFixture

describe.skipIf(process.env.SIM_SMOKE !== '1')('cycle s20i smoke - Sidney and Drake, turn 1 analysis', () => {
  for (const trainer of ['TRAINER_SIDNEY', 'TRAINER_DRAKE']) {
    it(`${trainer}: reports turn 1 stay test numbers and lead action`, () => {
      const fight = fixture.fights.find((entry) => entry.trainer === trainer)
      expect(fight, `${trainer} fixture`).toBeDefined()
      const setup = buildFightSetup(data, fight!)

      for (let game = 1; game <= 3; game++) {
        const seed = gameSeed(0, game)
        const record = playComparisonGame(setup, 'role', seed, { collectLog: true })
        const lines = (record.log ?? '').split('\n').filter(Boolean)
        console.log(`\n--- ${trainer} Game ${game} (outcome=${record.outcome}, turns=${record.turns}) ---`)
        console.log(`First log lines: ${lines.slice(0, 3).join(' | ')}`)

        // Recreate the initial turn-1 session to print stay-test numbers
        const s = createSession({
          data,
          playerParty: setup.party,
          opponentTrainer: setup.trainer,
          rng: createRandomSource(seed),
          leadIndex: setup.leadIndex,
          tier: setup.tier,
          format: setup.fightSpec.format,
          inverseBattle: setup.fightSpec.inverseBattle,
          battleEvents: setup.fightSpec.battleEvents,
          startFieldEffects: setup.fightSpec.startFieldEffects,
        })
        beginTurn(s)

        const view = readPredictions(s, 50)
        const activeMon = s.state.battlers[0]!.mon
        const foeMon = s.state.battlers[1]!.mon
        console.log(`Lead: ${activeMon.speciesId} (Spe ${activeMon.rawStats.spe}) vs ${foeMon.speciesId} (HP ${foeMon.hp}, Spe ${foeMon.rawStats.spe})`)
        console.log(`Prediction: move=${view.predictedMoveId} threatened=${view.threatened} koThreat=${view.koThreat}`)

        const moves = evaluateMoves(s, null)
        for (const info of moves) {
          if (!info.range || info.range.isImmune) {
            console.log(`  Move ${info.moveId}: non-damaging / immune`)
            continue
          }
          const dist = damageDistribution(info.range)
          const rawKo = koProbability(dist, foeMon.hp)
          const product = rawKo * (info.accuracy / 100)
          const outspeed = outspeeds(s, info.choice.action, view.predictedAction)
          console.log(
            `  Move ${info.moveId}: rawKo=${rawKo.toFixed(4)} acc=${info.accuracy}% product=${product.toFixed(4)} outspeeds=${outspeed}`,
          )
        }
        const decision = stayTest(s, view)
        console.log(`StayDecision: stay=${decision.stay} outspeedsWithKo=${decision.outspeedsWithKo}`)
      }
    })
  }
})
