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
import { chooseRoleAction, rangeOnOurReserve, stateWithReserve } from './driver/rolePolicy'
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
const OUR_MACHAMP: PlayerMonSpec = { species: 'SPECIES_MACHAMP', level: 50, moves: ['MOVE_BODY_SLAM'] }
const MACHAMP_BODY_SLAM = ['MOVE_BODY_SLAM']

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
  it('skips the preserve member while another candidate is acceptable', () => {
    // The replacement callback only runs after a faint and receives only the
    // state, so the layer needs one `policy` call first to hold a session for
    // its prediction probe (teamLayer.ts). The active mon is then set to 0 HP
    // on the created session -- the state a faint hands to the callback.
    const s = session([OUR_SNORLAX, OUR_MACHAMP, OUR_AGGRON], [mon('SPECIES_MACHAMP', MACHAMP_BODY_SLAM)])
    const layer = createTeamLayer({ roles: ['attacker', 'attacker', 'attacker'], genes: { preserve: 1 } })
    layer.policy(s, 1, [])
    patchMon(s.state, 0, 0, { hp: 0 })
    // Our Machamp (the preserve member, slot 1) takes 58/165 = 35.2% from the
    // predicted Body Slam: acceptable, but Aggron takes 5/145 = 3.45% and
    // scores higher (Iron Head mean 85 onto 165 HP; our Machamp's Body Slam
    // mean 53), so the preserve member is skipped and Aggron comes in.
    expect(layer.replacement(s.state, 0)).toBe(2)
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
