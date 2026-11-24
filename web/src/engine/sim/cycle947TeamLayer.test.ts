/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 947 - the solver-v2 TEAM LAYER (s20c, first slice): the replacement
// choice, the team genes, and four purposes (preserve, sacrifice, counter plus
// the switch mechanism they share), all from plan decision 14 "Team layer"
// (docs/battle-sim/solver-v2-plan.md). entryAbility, support and the PP stall
// loop are typed and ordered in `teamLayer.ts` but have no rule yet (s20c2).
//
// Fixtures are built through `createSession` and advanced with `beginTurn` /
// `stepTurn`, the shape cycle946's test uses. HP is patched on the created
// session only BEFORE a decision (never after `executeTurn`). Every damage
// number below is the sim's own range call on these fixtures, and the type
// multipliers behind it are the data rows / the type chart the engine already
// tests; the policy thresholds (safety, switchInSafety) are MODEL CHOICES.
import { describe, expect, it } from 'vitest'

import { aiDamageRolls } from './ai/aiCalcDamage'
import { PARTY_SIZE } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import { playPolicyBattle } from './driver/policyBattle'
import { predictAi } from './driver/policyInputs'
import {
  chooseRoleAction,
  highestRoll,
  lowestRoll,
  meanRoll,
  rangeOnOurReserve,
  stateWithReserve,
} from './driver/rolePolicy'
import { aiDamageDepsFor, beginTurn, createSession, stepTurn } from './driver/session'
import type { BattleSession } from './driver/session'
import { DEFAULT_TEAM_GENES, createTeamLayer } from './driver/teamLayer'
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

/** Writes a patch on both copies of a party slot (the active battler's mon and
 * the party mon), the shape a fixture needs for HP overrides -- cycle946's
 * helper. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const choiceMoveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

// Fixture sets (level 50, Hardy, 0 EVs). The damage numbers beside each use are
// the sim's own `aiDamageRolls` on exactly these sets; the type multipliers are
// the chart's rows (Normal 1x into Fighting; Normal halved twice by Rock/Steel,
// so 1/4x).
const OUR_SNORLAX: PlayerMonSpec = {
  species: 'SPECIES_SNORLAX',
  level: 50,
  moves: ['MOVE_BODY_SLAM', 'MOVE_CELEBRATE'],
}
const OUR_AGGRON: PlayerMonSpec = { species: 'SPECIES_AGGRON', level: 50, moves: ['MOVE_IRON_HEAD'] }
// The fast-heavy-hitter fixture: Jolteon (Speed 150) is far faster than their
// Machamp (Speed 75), and its Thunderbolt onto their 165 HP Machamp rolls
// 78..92 with mean 84.6875 -- 2 * 78 = 156 < 165 (no two-hit KO) but
// 2 * 84.6875 = 169.375 >= 165 (outspeed with heavy damage).
const OUR_JOLTEON: PlayerMonSpec = { species: 'SPECIES_JOLTEON', level: 50, moves: ['MOVE_THUNDERBOLT'] }
// The bench candidate: Close Combat onto their Machamp rolls 103..122, so
// 2 * 103 = 206 >= 165 KOs in two, and Body Slam onto our Machamp is
// 58/165 = 35.2% (the replacement test's number), under the default 50%.
const OUR_MACHAMP_CC: PlayerMonSpec = { species: 'SPECIES_MACHAMP', level: 50, moves: ['MOVE_CLOSE_COMBAT'] }
const OUR_MACHAMP: PlayerMonSpec = { species: 'SPECIES_MACHAMP', level: 50, moves: ['MOVE_BODY_SLAM'] }
const MACHAMP_BODY_SLAM = ['MOVE_BODY_SLAM']
// The per-candidate prediction fixture's Ground candidate: immune to the Thunder
// Punch their Machamp also carries there, so that prediction and the one made
// against the fainted Snorlax name different moves. Its Earthquake's worst roll
// is 86 and its mean 93.5625 onto their 165 HP Machamp (asserted below).
const OUR_DONPHAN: PlayerMonSpec = { species: 'SPECIES_DONPHAN', level: 50, moves: ['MOVE_EARTHQUAKE'] }

// Their Machamp's Body Slam onto our level-50 Snorlax: 39..46 (cycle945/946's
// fixture, same call). 46 is the highest roll every threat arithmetic below
// uses on that pairing.
// Onto our Aggron: 4..5 (1/4x), so 5/145 = 3.45% of its current HP.
const BODY_SLAM_VS_AGGRON_MAX = 5
const AGGRON_MAX_HP = 145
// Aggron's Iron Head onto their Machamp: 78..92 (Steel 1x into Fighting, STAB
// 1.5). 2 * 78 = 156 is the "KO in two" line.
const AGGRON_IRON_HEAD_MIN = 78

/** The counter fixture: our Snorlax is threatened (80 HP: 46*100 = 4600 >
 * 50*80 = 4000) and cannot KO in two; the Aggron bench takes Body Slam for
 * 3.45% of its current HP and KOs their Machamp in two (2 * 78 = 156 >= 150). */
function counterSession(seed = 1): BattleSession {
  const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)], {}, seed)
  patchMon(s.state, 0, 0, { hp: 80 })
  patchMon(s.state, 1, 0, { hp: 150 })
  return s
}

describe('cycle 947 - team layer: purpose order', () => {
  it('checks purposeOrder first: preserve before counter, then the swapped order', () => {
    const s1 = counterSession()
    const layer1 = createTeamLayer({ roles: ['attacker', 'setupSweeper'], genes: { preserve: 0 } })
    const trace1: PolicyTraceEntry[] = []
    const choice1 = layer1.policy(s1, 1, trace1)
    // Both rules would fire here (the preserve member is the threatened active
    // Snorlax; the Aggron bench is a qualifying counter candidate), so the
    // trace tag is what proves which one decided.
    expect(trace1[0]!.tags).toEqual(['team', 'preserve'])
    expect(choice1!.action.action).toBe('SWITCH')
    expect(choice1!.switchTo).toBe(1)

    const s2 = counterSession()
    const layer2 = createTeamLayer({
      roles: ['attacker', 'setupSweeper'],
      genes: {
        preserve: 0,
        purposeOrder: ['counter', 'preserve', 'sacrifice', 'entryAbility', 'support', 'ppLoop'],
      },
    })
    const trace2: PolicyTraceEntry[] = []
    const choice2 = layer2.policy(s2, 1, trace2)
    expect(trace2[0]!.tags).toEqual(['team', 'counter'])
    expect(choice2!.action.action).toBe('SWITCH')
    expect(choice2!.switchTo).toBe(1)
  })

  it('a false flag skips that purpose', () => {
    const s = counterSession()
    const layer = createTeamLayer({
      roles: ['attacker', 'setupSweeper'],
      genes: {
        preserve: 0,
        purposeFlags: { ...DEFAULT_TEAM_GENES.purposeFlags, preserve: false },
      },
    })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'counter'])
    expect(choice!.switchTo).toBe(1)
  })

  it('throws on a purposeOrder that is not a permutation', () => {
    expect(() =>
      createTeamLayer({ roles: ['attacker'], genes: { purposeOrder: ['preserve', 'counter'] } }),
    ).toThrow(/permutation/)
  })
})

describe('cycle 947 - team layer: replacement', () => {
  it('predicts against each candidate, so the AI move it fears depends on who comes in', () => {
    // Decision 14: "a fresh 3-sample prediction against each candidate". Their
    // Machamp carries two damaging moves, and which one the AI picks depends on
    // the monster standing across from it: Body Slam is Normal, which Donphan
    // (Ground) takes 1x, while Thunder Punch is Electric, which Donphan is
    // immune to; Aggron (Rock/Steel) takes Thunder Punch 1x and Body Slam at
    // 1/4x (Normal is halved by Rock and halved again by Steel).
    // So a prediction made against the FAINTED Snorlax (Body Slam) scores Aggron
    // highest, and a prediction made against each candidate scores Donphan
    // highest -- the defect this fixture pins.
    const s = session(
      [OUR_SNORLAX, OUR_DONPHAN, OUR_AGGRON],
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM', 'MOVE_THUNDER_PUNCH'])],
    )
    const layer = createTeamLayer({ roles: ['attacker', 'attacker', 'attacker'] })
    layer.policy(s, 1, [])
    patchMon(s.state, 0, 0, { hp: 0 })

    // predictAi's defaults are the layer's own SAMPLE_COUNT / PREDICTION_SEED
    // (3, 0), and the callback dedupes samples in order, so these are exactly
    // the move lists the rule scores against.
    const predicted = (slot: number): string[] => {
      const candidate = stateWithReserve(s.state, 0, s.state.sides[0].party[slot]!, slot)
      return predictAi({ ...s, state: candidate }, 3, 0).flatMap((sample) => {
        const action = sample.action
        if (!action || action.action !== 'USE_MOVE') return []
        const id = action.chosenMove?.id ?? action.moveToBeUsed?.id ?? null
        return id ? [id] : []
      })
    }
    // Against the mon that just fainted, the AI's move is Body Slam -- the one
    // prediction the old code made for every candidate.
    const fainted = predictAi({ ...s, state: s.state }, 3, 0)
    expect(
      fainted.map((sample) => (sample.action?.action === 'USE_MOVE' ? sample.action.chosenMove?.id : null)),
    ).toEqual(['MOVE_BODY_SLAM', 'MOVE_BODY_SLAM', 'MOVE_BODY_SLAM'])
    expect(new Set(predicted(1))).toEqual(new Set(['MOVE_BODY_SLAM']))
    expect(new Set(predicted(2))).toEqual(new Set(['MOVE_THUNDER_PUNCH']))

    // The damage behind both scores, from the same calls the rule makes.
    const theirHp = s.state.battlers[1]!.mon.hp
    expect(theirHp).toBe(165)
    expect(s.state.sides[0].party[1]!.maxHp).toBe(165)
    expect(s.state.sides[0].party[2]!.maxHp).toBe(AGGRON_MAX_HP)
    const bodySlamOnDonphan = highestRoll(rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!)
    const bodySlamOnAggron = highestRoll(rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 2)!)
    const punchOnAggron = highestRoll(rangeOnOurReserve(s, 'MOVE_THUNDER_PUNCH', 2)!)
    const punchOnDonphan = rangeOnOurReserve(s, 'MOVE_THUNDER_PUNCH', 1)!
    expect(bodySlamOnDonphan).toBe(31) // 31/165 = 18.8%
    expect(punchOnAggron).toBe(23) // 23/145 = 15.9%
    expect(bodySlamOnAggron).toBe(BODY_SLAM_VS_AGGRON_MAX) // 5/145 = 3.45%
    expect(punchOnDonphan.isImmune).toBe(true) // Ground: the AI will not choose it
    const offense = (slot: number, moveId: string): number => {
      const state = stateWithReserve(s.state, 0, s.state.sides[0].party[slot]!, slot)
      return meanRoll(aiDamageRolls(state, moveId, 0, 1, aiDamageDepsFor(data, state, false))!)
    }
    const donphanOffense = offense(1, 'MOVE_EARTHQUAKE') // 93.5625 onto their 165 HP
    const aggronOffense = offense(2, 'MOVE_IRON_HEAD') // 84.6875 onto their 165 HP
    expect(donphanOffense).toBeCloseTo(93.5625, 4)
    expect(aggronOffense).toBeCloseTo(84.6875, 4)

    // The rule's own score (offense fraction - incoming fraction), both ways.
    const score = (offenseMean: number, incomingHigh: number, candidateHp: number): number =>
      offenseMean / theirHp - incomingHigh / candidateHp
    const donphanOwn = score(donphanOffense, bodySlamOnDonphan, 165) // 0.5671 - 0.1879 = 0.3792
    const aggronOwn = score(aggronOffense, punchOnAggron, AGGRON_MAX_HP) // 0.5133 - 0.1586 = 0.3546
    expect(donphanOwn).toBeGreaterThan(aggronOwn)
    // With one prediction taken against the fainted Snorlax and reused for both
    // candidates -- the pre-fix behaviour -- Aggron wins instead, which is what
    // makes this fixture a regression test rather than a restatement.
    const aggronAgainstFainted = score(aggronOffense, bodySlamOnAggron, AGGRON_MAX_HP) // 0.5133 - 0.0345 = 0.4788
    expect(aggronAgainstFainted).toBeGreaterThan(donphanOwn)

    // No probe may touch the real position: the substituted state is a copy and
    // every predictAi sample clones its own generator, so the fainted lead stays
    // fainted, the bench stays at full HP and the real RNG is never drawn.
    const real = s.state.rng
    let draws = 0
    s.state.rng = {
      random16: () => {
        draws++
        return real.random16()
      },
    }
    expect(layer.replacement(s.state, 0)).toBe(1)
    expect(draws).toBe(0)
    expect(s.state.battlers[0]!.mon.hp).toBe(0)
    expect(s.state.sides[0].party[1]!.hp).toBe(165)
    expect(s.state.sides[0].party[2]!.hp).toBe(AGGRON_MAX_HP)
  })

  it('skips the preserve member when another candidate is acceptable and it scores higher', () => {
    // The replacement callback only runs after a faint and receives only the
    // state, so the layer needs one `policy` call first to hold a session for
    // its prediction probe (teamLayer.ts). The active mon is then set to 0 HP
    // on the created session -- the state a faint hands to the callback.
    //
    // Their Machamp has ONE move, so every candidate is predicted against the
    // same Body Slam and the per-candidate prediction leaves this fixture's
    // ordering alone. The preserve member is the HIGHER scorer here: Aggron
    // (slot 2, Iron Head mean 84.6875 onto 165 HP, 5/145 = 3.45% incoming)
    // scores 0.5133 - 0.0345 = 0.4788, while our Machamp (slot 1, Body Slam
    // mean 53.1875, 58/165 = 35.2% incoming) scores 0.3223 - 0.3515 = -0.0292.
    const s = session([OUR_SNORLAX, OUR_MACHAMP, OUR_AGGRON], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    const benchStateOf = (slot: number): BattleState =>
      stateWithReserve(s.state, 0, s.state.sides[0].party[slot]!, slot)
    const offenseOf = (slot: number, moveId: string): number => {
      const state = benchStateOf(slot)
      return meanRoll(aiDamageRolls(state, moveId, 0, 1, aiDamageDepsFor(data, state, false))!)
    }
    const aggronOffense = offenseOf(2, 'MOVE_IRON_HEAD')
    const machampOffense = offenseOf(1, 'MOVE_BODY_SLAM')
    expect(aggronOffense).toBeCloseTo(84.6875, 4)
    expect(machampOffense).toBeCloseTo(53.1875, 4)
    const machampIncoming = highestRoll(rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!)
    expect(machampIncoming).toBe(58)
    // Machamp 58/165 = 35.2% is acceptable under the default 50% line, but it
    // is NOT acceptable under a 20% line -- that is the third case below.
    expect(machampIncoming * 100).toBeLessThanOrEqual(50 * 165)
    expect(machampIncoming * 100).toBeGreaterThan(20 * 165)
    const score = (offenseMean: number, incomingHigh: number, hp: number): number => offenseMean / 165 - incomingHigh / hp
    expect(score(aggronOffense, BODY_SLAM_VS_AGGRON_MAX, AGGRON_MAX_HP)).toBeGreaterThan(
      score(machampOffense, machampIncoming, 165),
    )

    // The preserve member (Aggron) outscores our Machamp, and removing the
    // preserve filter would return it. With the filter, our Machamp's 35.2% is
    // acceptable, so the preserve member is skipped and slot 1 comes in.
    const skipLayer = createTeamLayer({ roles: ['attacker', 'attacker', 'attacker'], genes: { preserve: 2 } })
    skipLayer.policy(s, 1, [])
    patchMon(s.state, 0, 0, { hp: 0 })
    expect(skipLayer.replacement(s.state, 0)).toBe(1)

    // Control: with no preserve member the scoring is unfiltered and Aggron,
    // the higher scorer, comes in -- so the slot 1 answer above is the skip,
    // not the score.
    const controlState = session([OUR_SNORLAX, OUR_MACHAMP, OUR_AGGRON], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    const controlLayer = createTeamLayer({ roles: ['attacker', 'attacker', 'attacker'] })
    controlLayer.policy(controlState, 1, [])
    patchMon(controlState.state, 0, 0, { hp: 0 })
    expect(controlLayer.replacement(controlState.state, 0)).toBe(2)

    // A 20% safety line makes our Machamp unsafe, so the preserve member is the
    // only acceptable candidate: nothing is left to skip to, it stays in the
    // pool and wins on score.
    const strictState = session([OUR_SNORLAX, OUR_MACHAMP, OUR_AGGRON], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    const strictLayer = createTeamLayer({
      roles: ['attacker', 'attacker', 'attacker'],
      genes: { preserve: 2, switchInSafety: 20 },
    })
    strictLayer.policy(strictState, 1, [])
    patchMon(strictState.state, 0, 0, { hp: 0 })
    expect(strictLayer.replacement(strictState.state, 0)).toBe(2)
  })

  it('uses the preserve member when it is the only live candidate', () => {
    const s = session([OUR_SNORLAX, OUR_MACHAMP], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    const layer = createTeamLayer({ roles: ['attacker', 'attacker'], genes: { preserve: 1 } })
    layer.policy(s, 1, [])
    patchMon(s.state, 0, 0, { hp: 0 })
    expect(layer.replacement(s.state, 0)).toBe(1)
  })

  it('falls back to firstLiveReplacement before any policy call', () => {
    // A faint before the layer has seen a position (the lead faints on turn 1
    // before `policy` runs) cannot build a probe session, so the fallback is
    // the first live non-active slot (session.ts:103).
    const s = session([OUR_SNORLAX, OUR_MACHAMP], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    patchMon(s.state, 0, 0, { hp: 0 })
    expect(layer.replacement(s.state, 0)).toBe(1)
  })
})

describe('cycle 947 - team layer: counter', () => {
  it('switches when the teammate takes the predicted move under switchInSafety', () => {
    // Aggron takes 5/145 = 3.45%, under the default 50% line, and KOs their
    // 150 HP Machamp in two (2 * 78 = 156 >= 150).
    const s = counterSession()
    const layer = createTeamLayer({ roles: ['attacker', 'setupSweeper'] })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'counter'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)

    // The numbers the threshold straddles, read from the same calls the rule
    // makes: 5 * 100 = 500 versus 3 * 145 = 435 and 50 * 145 = 7250.
    const incoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    const high = (incoming.totalRolls ?? incoming.rolls)[15]!
    expect(high).toBe(BODY_SLAM_VS_AGGRON_MAX)
    expect(s.state.sides[0].party[1]!.maxHp).toBe(AGGRON_MAX_HP)
    expect(high * 100).toBeGreaterThan(3 * AGGRON_MAX_HP)
    expect(high * 100).toBeLessThanOrEqual(50 * AGGRON_MAX_HP)
    const benchState = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const offense = aiDamageRolls(benchState, 'MOVE_IRON_HEAD', 0, 1, aiDamageDepsFor(data, benchState, false))!
    expect((offense.totalRolls ?? offense.rolls)[0]).toBe(AGGRON_IRON_HEAD_MIN)
    expect(2 * AGGRON_IRON_HEAD_MIN).toBeGreaterThanOrEqual(150)
  })

  it('does not fire when the active mon outspeeds with heavy damage but no two-hit KO', () => {
    // Decision 14's active-mon gate exempts a mon that either KOs in two OR
    // outspeeds with heavy damage. Jolteon does the second and not the first,
    // so it must stay in; the old gate (KO in two only, plus outspeed) switched
    // this fast heavy hitter out.
    const s = session([OUR_JOLTEON, OUR_MACHAMP_CC], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    // Speed 150 vs 75: no tie, so `outspeeds` cannot draw RNG and answer false.
    expect(s.state.battlers[0]!.mon.rawStats.spe).toBe(150)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBe(75)
    expect(s.state.battlers[1]!.mon.maxHp).toBe(165)

    // The numbers the gate straddles, from the same call the rule makes:
    // 2 * 78 = 156 < 165 (not "KO in two"), 2 * 84.6875 = 169.375 >= 165
    // ("heavy damage").
    const activeRolls = aiDamageRolls(
      s.state,
      'MOVE_THUNDERBOLT',
      0,
      1,
      aiDamageDepsFor(data, s.state, false),
    )!
    expect(lowestRoll(activeRolls)).toBe(78)
    expect(highestRoll(activeRolls)).toBe(92)
    expect(meanRoll(activeRolls)).toBeCloseTo(84.6875, 4)
    expect(2 * lowestRoll(activeRolls)).toBeLessThan(165)
    expect(2 * meanRoll(activeRolls)).toBeGreaterThanOrEqual(165)

    // The bench mon is a real counter candidate, so only the active gate keeps
    // the switch from firing: it takes Body Slam for 58/165 = 35.2% and its
    // Close Combat worst roll KOs their Machamp in two (206 >= 165).
    const incoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(highestRoll(incoming)).toBe(58)
    expect(highestRoll(incoming) * 100).toBeLessThanOrEqual(50 * s.state.sides[0].party[1]!.maxHp)
    const benchState = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    const offense = aiDamageRolls(
      benchState,
      'MOVE_CLOSE_COMBAT',
      0,
      1,
      aiDamageDepsFor(data, benchState, false),
    )!
    expect(lowestRoll(offense)).toBe(103)
    expect(2 * lowestRoll(offense)).toBeGreaterThanOrEqual(165)

    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    // The role's own trace, not the counter's ['team', 'counter']: the layer
    // fell through and Jolteon attacks.
    expect(trace[0]!.tags).toEqual(['attacker', 'damage'])
    expect(choice!.action.action).toBe('USE_MOVE')
    expect(choiceMoveId(choice!)).toBe('MOVE_THUNDERBOLT')

    // Control: the original counter fixture still fires, so the gate only
    // removes this exemption case, not the rule.
    const control = counterSession()
    const controlTrace: PolicyTraceEntry[] = []
    createTeamLayer({ roles: ['attacker', 'setupSweeper'] }).policy(control, 1, controlTrace)
    expect(controlTrace[0]!.tags).toEqual(['team', 'counter'])
  })

  it('does not fire when switchInSafety is below the predicted damage', () => {
    // 3 * 145 = 435 < 500, so the same switch is refused and the active mon's
    // own role decides (attacker -> Body Slam; no KO, so the damage fallback).
    const s = counterSession()
    const layer = createTeamLayer({ roles: ['attacker', 'setupSweeper'], genes: { switchInSafety: 3 } })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['attacker', 'damage'])
    expect(choiceMoveId(choice!)).toBe('MOVE_BODY_SLAM')
  })
})

describe('cycle 947 - team layer: sacrifice', () => {
  it('keeps the doomed mon in and the replacement then enters', () => {
    const layer = createTeamLayer({ roles: ['attacker', 'setupSweeper'] })
    const s = session(
      [{ species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_BODY_SLAM'] }, OUR_AGGRON],
      [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)],
      {},
      1,
      layer.replacement,
    )
    // 20 HP: Machamp's Body Slam highest roll 46 >= 20, so a sample can KO us
    // (koThreat) while our own worst roll 63 does not finish its 165 HP.
    patchMon(s.state, 0, 0, { hp: 20 })

    const trace: PolicyTraceEntry[] = []
    beginTurn(s)
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'sacrifice'])
    // Staying is a move choice, not a switch: this is the point of the rule.
    expect(choice!.action.action).toBe('USE_MOVE')
    expect(choiceMoveId(choice!)).toBe('MOVE_BODY_SLAM')
    s.state.battlers[0]!.monToSwitchIntoId = choice!.switchTo ?? PARTY_SIZE
    stepTurn(s, choice!.action)

    // The doomed Snorlax fainted and the layer's replacement sent Aggron in at
    // full HP (145), giving the set-up teammate the free entry the rule wanted.
    expect(s.state.battlers[0]!.partyIndex).toBe(1)
    expect(s.state.battlers[0]!.mon.speciesId).toBe('SPECIES_AGGRON')
    expect(s.state.battlers[0]!.mon.hp).toBe(AGGRON_MAX_HP)
    expect(s.state.battlers[0]!.mon.hp).toBe(s.state.battlers[0]!.mon.maxHp)
  })

  it('does not fire without a preserve or set-up teammate waiting', () => {
    // The same doomed position, but the bench Aggron is a plain attacker: the
    // sacrifice rule has no one to hand a free entry to and the role decides.
    const layer = createTeamLayer({ roles: ['attacker', 'attacker'] })
    const s = session(
      [{ species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_BODY_SLAM'] }, OUR_AGGRON],
      [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)],
    )
    patchMon(s.state, 0, 0, { hp: 20 })
    const trace: PolicyTraceEntry[] = []
    layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['attacker', 'damage'])
  })
})

describe('cycle 947 - team layer: the switch mechanism', () => {
  it('a pivot holder switches by its pivot move', () => {
    // Snorlax with U-turn (EFFECT_HIT_ESCAPE, data/v2.65beta/moves.json); Bug is
    // 1x into Fighting, so pivotSwitchWorks' non-immune gate passes and the
    // switch is the move action carrying switchTo.
    const s = session(
      [{ species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_U_TURN'] }, OUR_AGGRON],
      [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)],
    )
    patchMon(s.state, 0, 0, { hp: 80 })
    const layer = createTeamLayer({ roles: ['attacker', 'attacker'], genes: { preserve: 0 } })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'preserve'])
    expect(choice!.action.action).toBe('USE_MOVE')
    expect(choiceMoveId(choice!)).toBe('MOVE_U_TURN')
    expect(choice!.switchTo).toBe(1)
  })

  it('a non-pivot mon hard-switches', () => {
    const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(s.state, 0, 0, { hp: 80 })
    const layer = createTeamLayer({ roles: ['attacker', 'attacker'], genes: { preserve: 0 } })
    const choice = layer.policy(s, 1, [])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choiceMoveId(choice!)).toBeNull()
    expect(choice!.switchTo).toBe(1)
  })

  it('a HIT_ESCAPE pivot into an immune target falls back to the hard switch', () => {
    // Volt Switch is Electric and their Donphan is Ground: the range is immune,
    // so the move would deal no HP and never queue its switch
    // (turn.ts:4798-4803), and pivotSwitchWorks (rolePolicy.ts:1104-1108)
    // refuses it.
    const s = session(
      [{ species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_VOLT_SWITCH'] }, OUR_AGGRON],
      [mon('SPECIES_DONPHAN', ['MOVE_EARTHQUAKE'])],
    )
    patchMon(s.state, 0, 0, { hp: 80 })
    const layer = createTeamLayer({ roles: ['attacker', 'attacker'], genes: { preserve: 0 } })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'preserve'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)
  })
})

describe('cycle 947 - team layer: playPolicyBattle wiring', () => {
  /** The layer with every team rule off, so the active mon's plain `attacker`
   * role decides: this test is about the replacement option, not the purposes. */
  const attackerOnlyPolicy = () =>
    createTeamLayer({
      roles: ['attacker', 'attacker', 'attacker'],
      genes: {
        purposeFlags: {
          preserve: false,
          sacrifice: false,
          counter: false,
          entryAbility: false,
          support: false,
          ppLoop: false,
        },
      },
    }).policy

  it('sends in the slot the supplied playerReplacement names, not the heuristic one', () => {
    // A real fight, not a hand-set position: the lead Snorlax is passed in at 20
    // HP (the party is the session's INPUT -- nothing is edited after a turn
    // runs) and their Machamp's Body Slam rolls 39..46, so every roll KOs it.
    // `maxTurns: 1` therefore stops right after turn 1's faint and its
    // replacement, which is all this test needs.
    const playerParty = (): ReturnType<typeof buildPlayerParty> => {
      const party = buildPlayerParty([OUR_SNORLAX, OUR_DONPHAN, OUR_AGGRON], 50, data)
      party[0]!.hp = 20
      return party
    }
    // Both bench mons are alive, so the slot is a real choice; the game's own
    // "most suitable mon" heuristic (expectimax.ts:1417-1431) picks Donphan
    // (slot 1) here, which the control run below shows.
    const calls: Array<{ battlerId: number }> = []
    const wired = playPolicyBattle({
      data,
      playerParty: playerParty(),
      opponentTrainer: opponent([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)]),
      seed: 1,
      maxTurns: 1,
      policy: attackerOnlyPolicy(),
      playerReplacement: (_state, battlerId) => {
        calls.push({ battlerId })
        return 2
      },
    })
    expect(wired.outcome).toBe('MAX_TURNS')
    expect(wired.capped).toBe(true)
    expect(wired.turns).toBe(1)
    // The lead really fainted this turn, and the callback really ran for battler 0.
    expect(wired.session.state.sides[0].party[0]!.hp).toBe(0)
    expect(calls).toEqual([{ battlerId: 0 }])
    // The option's answer, not the heuristic's: Aggron (slot 2) is on the field.
    expect(wired.session.state.battlers[0]!.partyIndex).toBe(2)
    expect(wired.session.state.battlers[0]!.mon.speciesId).toBe('SPECIES_AGGRON')

    // Control: the same fight without the option. playPolicyBattle falls back to
    // createHeuristicPlayerReplacement, which sends in slot 1 instead -- so the
    // assertion above is the wiring, not the game's heuristic agreeing.
    const control = playPolicyBattle({
      data,
      playerParty: playerParty(),
      opponentTrainer: opponent([mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)]),
      seed: 1,
      maxTurns: 1,
      policy: attackerOnlyPolicy(),
    })
    expect(control.session.state.sides[0].party[0]!.hp).toBe(0)
    expect(control.session.state.battlers[0]!.partyIndex).toBe(1)
    expect(control.session.state.battlers[0]!.mon.speciesId).toBe('SPECIES_DONPHAN')
    expect(control.session.state.battlers[0]!.partyIndex).not.toBe(
      wired.session.state.battlers[0]!.partyIndex,
    )
    // The control never went through the supplied callback.
    expect(calls).toHaveLength(1)
  })
})

describe('cycle 947 - team layer: fall-through and purity', () => {
  it('with every purpose flag false returns what chooseRoleAction returns', () => {
    const s1 = counterSession()
    const layer = createTeamLayer({
      roles: ['attacker', 'setupSweeper'],
      genes: {
        purposeFlags: {
          preserve: false,
          sacrifice: false,
          counter: false,
          entryAbility: false,
          support: false,
          ppLoop: false,
        },
      },
    })
    const trace: PolicyTraceEntry[] = []
    const fromLayer = layer.policy(s1, 1, trace)
    // The role layer's own inputs are deterministic, so an identical session
    // yields the choice `chooseRoleAction` makes for the active mon's role.
    const s2 = counterSession()
    const direct = chooseRoleAction(s2, 'attacker', {}, { turn: 0, lastMove: null })
    expect(fromLayer).toEqual(direct)
    expect(trace[0]!.tags).toEqual(['attacker', 'damage'])
    expect(choiceMoveId(fromLayer!)).toBe('MOVE_BODY_SLAM')
  })

  it('does not advance the real session RNG', () => {
    // `state.rng` is a closure with no serialisable state (rng.ts), so the
    // observable is the draw count: every probe (predictAi, outspeeds, the
    // reserve-speed clone) must use a clone's own generator (cloneSession's
    // doc, session.ts:511-518).
    const s = counterSession()
    const real = s.state.rng
    let draws = 0
    s.state.rng = {
      random16: () => {
        draws++
        return real.random16()
      },
    }
    const layer = createTeamLayer({ roles: ['attacker', 'setupSweeper'] })
    layer.policy(s, 1, [])
    expect(draws).toBe(0)
  })
})
