/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import { aiDamageRolls } from './ai/aiCalcDamage'
import { PARTY_SIZE } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import { highestRoll, rangeOnOurReserve } from './driver/rolePolicy'
import { aiDamageDepsFor, beginTurn, createSession, stepTurn } from './driver/session'
import type { BattleSession } from './driver/session'
import {
  compareUsefulness,
  createTeamLayer,
  DEFAULT_TEAM_GENES,
  isGoodCounter,
  isStrictlyLessUseful,
  scoreBench,
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
  seed = 1,
  playerReplacement?: (state: BattleState, battlerId: number) => number,
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons),
    rng: createRandomSource(seed),
    ...(playerReplacement ? { playerReplacement } : {}),
  })
}

function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const choiceMoveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

function runChoice(s: BattleSession, choice: PlayerChoice): void {
  s.state.battlers[0]!.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
  stepTurn(s, choice.action)
}

const OUR_SNORLAX: PlayerMonSpec = {
  species: 'SPECIES_SNORLAX',
  level: 50,
  moves: ['MOVE_BODY_SLAM'],
}
const OUR_AGGRON: PlayerMonSpec = {
  species: 'SPECIES_AGGRON',
  level: 50,
  moves: ['MOVE_IRON_HEAD'],
}
const MACHAMP_BODY_SLAM = ['MOVE_BODY_SLAM']
const AGGRON_MAX_HP = 145

describe('cycle s20ib - team layer fodder: a state, not a role', () => {
  it('case 1: good counter unsafe, weak active stays and attacks, faints, and counter enters', () => {
    // Snorlax (Body Slam) vs Machamp (Body Slam), bench Aggron (Iron Head).
    // Aggron takes 5/145 max (500 > 435, so switchInSafety: 3 makes it unsafe).
    // Iron Head's lowest roll is 78, so foe HP 150 makes it a good counter (156 >= 150).
    const layer = createTeamLayer({
      roles: ['attacker', 'setupSweeper'],
      genes: { switchInSafety: 3 },
    })
    const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)], 1, layer.replacement)
    patchMon(s.state, 1, 0, { hp: 150, maxHp: 150 })
    patchMon(s.state, 0, 0, { hp: 20 })

    // Verify numbers with sim calls:
    // Aggron incoming max roll = 5; 5 * 100 = 500 > 3 * 145 = 435 -> unsafe
    const incoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(highestRoll(incoming)).toBe(5)
    expect(highestRoll(incoming) * 100).toBeGreaterThan(3 * AGGRON_MAX_HP)

    // Aggron offense lowest roll = 78; 2 * 78 = 156 >= 150 -> good counter
    const scored = scoreBench(s, 1, ['MOVE_BODY_SLAM'], 3)!
    expect(scored.lowestRoll).toBe(78)
    expect(2 * scored.lowestRoll).toBeGreaterThanOrEqual(150)
    expect(isGoodCounter(s, 1, scored, 150, null)).toBe(true)

    // Active Snorlax Body Slam lowest 63, highest 75; 75 < 150 -> cannot KO them
    const deps = aiDamageDepsFor(data, s.state, s.inverseBattle)
    const snorlaxOffense = aiDamageRolls(s.state, 'MOVE_BODY_SLAM', 0, 1, deps)!
    expect(highestRoll(snorlaxOffense)).toBe(75)
    expect(highestRoll(snorlaxOffense)).toBeLessThan(150)

    // Machamp Body Slam highest roll 46 >= 20 HP Snorlax -> Snorlax is doomed
    const machampOffense = aiDamageRolls(s.state, 'MOVE_BODY_SLAM', 1, 0, deps)!
    expect(highestRoll(machampOffense)).toBe(46)
    expect(highestRoll(machampOffense)).toBeGreaterThanOrEqual(20)

    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'sacrifice'])
    expect(choice!.action.action).toBe('USE_MOVE')
    expect(choiceMoveId(choice!)).toBe('MOVE_BODY_SLAM')

    // Step the turn: Snorlax faints from Machamp's Body Slam, Aggron enters at full HP
    runChoice(s, choice!)
    expect(s.state.battlers[0]!.partyIndex).toBe(1)
    expect(s.state.battlers[0]!.mon.speciesId).toBe('SPECIES_AGGRON')
    expect(s.state.battlers[0]!.mon.hp).toBe(AGGRON_MAX_HP)
  })

  it('case 2: active is preserve member, least useful bench fodder is switched in, not the counter', () => {
    // Snorlax (preserve: 0, purposeFlags.preserve: false so preserve purpose does not pre-empt).
    // Bench: Aggron (slot 1, designated unsafe counter), Donphan (slot 2, bench fodder).
    const layer = createTeamLayer({
      roles: ['attacker', 'setupSweeper', 'attacker'],
      genes: {
        preserve: 0,
        purposeFlags: { ...DEFAULT_TEAM_GENES.purposeFlags, preserve: false },
        switchInSafety: 3,
      },
    })
    const s = session(
      [OUR_SNORLAX, OUR_AGGRON, { species: 'SPECIES_DONPHAN', level: 50, moves: ['MOVE_TACKLE'] }],
      [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)],
      1,
    )
    patchMon(s.state, 1, 0, { hp: 150, maxHp: 150 })
    patchMon(s.state, 0, 0, { hp: 20 })

    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'sacrifice'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(2)

    runChoice(s, choice!)
    expect(s.state.battlers[0]!.partyIndex).toBe(2)
    expect(s.state.battlers[0]!.mon.speciesId).toBe('SPECIES_DONPHAN')
  })

  it('case 3: two non-counter bench mons, first key decides over second key', () => {
    // Active is Snorlax (preserve: 0, purposeFlags.preserve: false).
    // Bench:
    // Slot 1: Aggron (unsafe good counter).
    // Slot 2: Capable mon with Reflect (pending screen), but very low HP and low damage,
    //         so (hp / maxHp) * (damage / theirHp) is very low (~0.003).
    // Slot 3: Non-capable mon with no screen, full HP and moderate damage (~0.233).
    // Second key alone would choose slot 2 (0.003 < 0.233), but first key makes slot 3 less useful.
    const layer = createTeamLayer({
      roles: ['attacker', 'setupSweeper', 'support', 'attacker'],
      genes: {
        preserve: 0,
        purposeFlags: { ...DEFAULT_TEAM_GENES.purposeFlags, preserve: false },
        switchInSafety: 3,
      },
    })
    const s = session(
      [
        OUR_SNORLAX,
        OUR_AGGRON,
        { species: 'SPECIES_DONPHAN', level: 50, moves: ['MOVE_REFLECT', 'MOVE_TACKLE'] },
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_BODY_SLAM'] },
      ],
      [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)],
    )
    patchMon(s.state, 1, 0, { hp: 150, maxHp: 150 })
    patchMon(s.state, 0, 0, { hp: 20 })
    // Patch slot 2 to 5 HP (5 / 165 = 0.030 HP ratio)
    patchMon(s.state, 0, 2, { hp: 5 })

    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'sacrifice'])
    expect(choice!.action.action).toBe('SWITCH')
    // Slot 3 chosen because it is not capable (first key decides)
    expect(choice!.switchTo).toBe(3)
  })

  it('case 4: exception (b) by second key: strictly less useful bench mon switches in; equal or better leaves active in', () => {
    // Active Snorlax (preserve: null).
    // Bench: Slot 1 Aggron (unsafe good counter), Slot 2 Donphan (bench fodder).
    const layer = createTeamLayer({
      roles: ['attacker', 'setupSweeper', 'attacker'],
      genes: { switchInSafety: 3 },
    })

    // Positive: Active Snorlax is at 160/160 HP, Body Slam ~70 dmg -> damageFraction ~0.467.
    // Bench Donphan is at 5/165 HP with Tackle ~10 dmg -> damageFraction ~0.002.
    // Donphan is strictly less useful than active Snorlax -> switches in Donphan.
    const sPos = session(
      [OUR_SNORLAX, OUR_AGGRON, { species: 'SPECIES_DONPHAN', level: 50, moves: ['MOVE_TACKLE'] }],
      [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)],
    )
    patchMon(sPos.state, 1, 0, { hp: 150, maxHp: 150 })
    patchMon(sPos.state, 0, 0, { hp: 160 })
    patchMon(sPos.state, 0, 2, { hp: 5 })

    beginTurn(sPos)
    const tracePos: PolicyTraceEntry[] = []
    const choicePos = layer.policy(sPos, 1, tracePos)
    expect(tracePos[0]!.tags).toEqual(['team', 'sacrifice'])
    expect(choicePos!.action.action).toBe('SWITCH')
    expect(choicePos!.switchTo).toBe(2)

    // Negative: Active Snorlax is at 5/160 HP -> damageFraction ~0.015.
    // Bench Donphan is at full HP (165/165) with Body Slam -> damageFraction ~0.467.
    // Bench Donphan is MORE useful than active Snorlax -> active Snorlax stays in.
    const sNeg = session(
      [OUR_SNORLAX, OUR_AGGRON, { species: 'SPECIES_DONPHAN', level: 50, moves: ['MOVE_BODY_SLAM'] }],
      [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)],
    )
    patchMon(sNeg.state, 1, 0, { hp: 150, maxHp: 150 })
    patchMon(sNeg.state, 0, 0, { hp: 5 })

    beginTurn(sNeg)
    const traceNeg: PolicyTraceEntry[] = []
    const choiceNeg = layer.policy(sNeg, 1, traceNeg)
    expect(traceNeg[0]!.tags).toEqual(['team', 'sacrifice'])
    expect(choiceNeg!.action.action).toBe('USE_MOVE')
  })

  it('case 5: counter that can enter safely switches to counter, no sacrifice tag', () => {
    // Default switchInSafety: 20. Aggron takes 5/145 = 3.45% <= 20%, so it enters safely.
    const layer = createTeamLayer({ roles: ['attacker', 'setupSweeper'] })
    const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(s.state, 1, 0, { hp: 150, maxHp: 150 })
    patchMon(s.state, 0, 0, { hp: 20 })

    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'counter'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)
  })

  it('case 6: no good counter on the bench, tag is not sacrifice', () => {
    // Foe Machamp HP 165. Aggron worst roll 78 doubled is 156 < 165 (not a good counter).
    const layer = createTeamLayer({
      roles: ['attacker', 'setupSweeper'],
      genes: { switchInSafety: 3 },
    })
    const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(s.state, 0, 0, { hp: 20 })

    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).not.toEqual(['team', 'sacrifice'])
    expect(choice!.action.action).toBe('USE_MOVE')
  })

  it('case 7: stay test true (foe low HP so active KOs and survives), no fodder switch, no sacrifice tag', () => {
    // Foe Machamp at 20 HP. Snorlax Body Slam lowest roll 63 >= 20 (guaranteed KO).
    // Snorlax at full HP survives (!koThreat). Stay test is true.
    const layer = createTeamLayer({
      roles: ['attacker', 'setupSweeper'],
      genes: { switchInSafety: 3 },
    })
    const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    patchMon(s.state, 1, 0, { hp: 20, maxHp: 165 })

    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).not.toEqual(['team', 'sacrifice'])
    expect(choice!.action.action).toBe('USE_MOVE')
  })

  it('case 8: preserve slot is never picked as bench fodder', () => {
    // Preserve is slot 2 (Donphan). Slot 3 is Jolteon.
    // Active Snorlax is at 160 HP. Both Donphan and Jolteon are at 5 HP with Tackle (strictly less useful).
    // Slot 2 would rank before slot 3 by lower slot, but slot 2 is preserve, so slot 3 is picked.
    const layer = createTeamLayer({
      roles: ['attacker', 'setupSweeper', 'attacker', 'attacker'],
      genes: {
        preserve: 2,
        switchInSafety: 3,
      },
    })
    const s = session(
      [
        OUR_SNORLAX,
        OUR_AGGRON,
        { species: 'SPECIES_DONPHAN', level: 50, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_JOLTEON', level: 50, moves: ['MOVE_TACKLE'] },
      ],
      [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)],
    )
    patchMon(s.state, 1, 0, { hp: 150, maxHp: 150 })
    patchMon(s.state, 0, 0, { hp: 160 })
    patchMon(s.state, 0, 2, { hp: 5 })
    patchMon(s.state, 0, 3, { hp: 5 })

    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'sacrifice'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(3)
  })

  it('case 9: live session and RNG are unchanged after a policy call evaluating bench probes', () => {
    const s = session(
      [
        OUR_SNORLAX,
        OUR_AGGRON,
        { species: 'SPECIES_DONPHAN', level: 50, moves: ['MOVE_TACKLE'] },
      ],
      [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)],
    )
    patchMon(s.state, 1, 0, { hp: 150, maxHp: 150 })
    patchMon(s.state, 0, 0, { hp: 20 })

    const realRng = s.state.rng
    let draws = 0
    s.state.rng = {
      random16: () => {
        draws++
        return realRng.random16()
      },
    }

    const layer = createTeamLayer({
      roles: ['attacker', 'setupSweeper', 'attacker'],
      genes: { switchInSafety: 3 },
    })

    // Read the state once first: GetIllusionMonPtr lazily arms illusion.set on
    // the FIRST read (battle_util.c:8281-8292, bridge.ts:547) and the policy's
    // own readPredictions does the same, so warm that one-time flag before the
    // snapshot.
    layer.policy(s, 1, [])
    draws = 0
    const stateBefore = JSON.stringify(s.state, (key, value) => (key === 'rng' ? undefined : value))

    layer.policy(s, 1, [])
    expect(draws).toBe(0)

    const stateAfter = JSON.stringify(s.state, (key, value) => (key === 'rng' ? undefined : value))
    expect(stateAfter).toBe(stateBefore)
  })

  it('case 10: pure comparator: first key beats second, second decides within first key, lower slot on full tie', () => {
    // First key beats second: Mon A not capable with high damage (0.9) vs Mon B capable with low damage (0.1)
    // Mon A ranks before Mon B (< 0) as fodder
    const a1 = { slot: 2, capable: false, damageFraction: 0.9 }
    const b1 = { slot: 1, capable: true, damageFraction: 0.1 }
    expect(compareUsefulness(a1, b1)).toBeLessThan(0)
    expect(compareUsefulness(b1, a1)).toBeGreaterThan(0)
    expect(isStrictlyLessUseful(a1, b1)).toBe(true)
    expect(isStrictlyLessUseful(b1, a1)).toBe(false)

    // Second key decides within a first key: both not capable, Mon A (0.2) vs Mon B (0.5)
    const a2 = { slot: 2, capable: false, damageFraction: 0.2 }
    const b2 = { slot: 1, capable: false, damageFraction: 0.5 }
    expect(compareUsefulness(a2, b2)).toBeLessThan(0)
    expect(compareUsefulness(b2, a2)).toBeGreaterThan(0)
    expect(isStrictlyLessUseful(a2, b2)).toBe(true)
    expect(isStrictlyLessUseful(b2, a2)).toBe(false)

    // Lower slot on a full tie: both not capable, same damageFraction (0.3), slot 1 vs slot 2
    const a3 = { slot: 1, capable: false, damageFraction: 0.3 }
    const b3 = { slot: 2, capable: false, damageFraction: 0.3 }
    expect(compareUsefulness(a3, b3)).toBeLessThan(0)
    expect(compareUsefulness(b3, a3)).toBeGreaterThan(0)
    // Between active and bench, slot never counts:
    expect(isStrictlyLessUseful(a3, b3)).toBe(false)
    expect(isStrictlyLessUseful(b3, a3)).toBe(false)
  })
})
