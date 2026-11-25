/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20cd - the team layer's role memory: it belongs to one battler OBJECT
// (reset on every switch-in, `gLastResultingMoves[gActiveBattler] = 0`,
// battle_main.c:2903) and records the moves the layer itself decides, not only
// the ones `chooseRoleAction` decides.
import { describe, expect, it } from 'vitest'

import { aiDamageRolls } from './ai/aiCalcDamage'
import { PARTY_SIZE, STATUS1_BURN } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { legalChoices } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import { highestRoll } from './driver/rolePolicy'
import type { RoleName } from './driver/rolePolicy'
import { aiDamageDepsFor, beginTurn, createSession, stepTurn } from './driver/session'
import type { BattleSession } from './driver/session'
import { createTeamLayer } from './driver/teamLayer'
import type { TeamGenes } from './driver/teamLayer'
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

function session(playerMons: PlayerMonSpec[], foeMons: TrainerMonData[], seed = 1): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons),
    rng: createRandomSource(seed),
  })
}

function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const choiceMoveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

const OUR_SNORLAX: PlayerMonSpec = {
  species: 'SPECIES_SNORLAX',
  level: 50,
  moves: ['MOVE_PROTECT', 'MOVE_BODY_SLAM'],
}
const OUR_AGGRON: PlayerMonSpec = { species: 'SPECIES_AGGRON', level: 50, moves: ['MOVE_IRON_HEAD'] }
const ROLES: RoleName[] = ['staller', 'setupSweeper']
const NO_PURPOSES: Partial<TeamGenes> = {
  purposeFlags: {
    preserve: false,
    sacrifice: false,
    counter: false,
    entryAbility: false,
    support: false,
    ppLoop: false,
  },
}
const ONLY_SACRIFICE: Partial<TeamGenes> = {
  purposeFlags: { ...NO_PURPOSES.purposeFlags!, sacrifice: true },
}

/** A hard switch to `slot`, read the way `switchChoice` reads it. */
function hardSwitch(s: BattleSession, slot: number): PlayerChoice {
  const choice = legalChoices(s).find((c) => c.action.action === 'SWITCH' && c.switchTo === slot)
  if (!choice) throw new Error(`no legal switch to slot ${slot}`)
  return choice
}

/** One real turn exactly as `playPolicyBattle` runs it (policyBattle.ts:93-100). */
function runChoice(s: BattleSession, choice: PlayerChoice): void {
  s.state.battlers[0]!.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
  stepTurn(s, choice.action)
}

describe('cycle s20cd - team layer role memory', () => {
  it('case 1: resets on every switch-in, so a returned staller Protects again', () => {
    const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    patchMon(s.state, 1, 0, { status1: STATUS1_BURN })
    const layer = createTeamLayer({ roles: ROLES, genes: NO_PURPOSES })

    const trace1: PolicyTraceEntry[] = []
    beginTurn(s)
    const turn1 = layer.policy(s, 1, trace1)
    expect(trace1[0]!.tags).toEqual(['staller', 'protect'])
    expect(choiceMoveId(turn1!)).toBe('MOVE_PROTECT')
    runChoice(s, turn1!)

    // Switch out and back WITHOUT asking the policy (left-and-returned: the
    // party index on the next call equals the one on the previous call).
    beginTurn(s)
    runChoice(s, hardSwitch(s, 1))
    beginTurn(s)
    runChoice(s, hardSwitch(s, 0))

    beginTurn(s)
    expect(s.state.battlers[0]!.partyIndex).toBe(0)
    expect(s.state.battlers[0]!.lastMove).toBeNull()
    expect(s.state.battlers[1]!.mon.hp).toBeGreaterThan(0)
    expect(s.state.battlers[1]!.mon.status1 & STATUS1_BURN).not.toBe(0)
    const trace4: PolicyTraceEntry[] = []
    const turn4 = layer.policy(s, 4, trace4)
    expect(trace4[0]!.tags).toEqual(['staller', 'protect'])
    expect(choiceMoveId(turn4!)).toBe('MOVE_PROTECT')
  })

  it('case 1 variant: asking the policy on the switch turns changes nothing', () => {
    const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    patchMon(s.state, 1, 0, { status1: STATUS1_BURN })
    const layer = createTeamLayer({ roles: ROLES, genes: NO_PURPOSES })

    const trace1: PolicyTraceEntry[] = []
    beginTurn(s)
    const turn1 = layer.policy(s, 1, trace1)
    expect(choiceMoveId(turn1!)).toBe('MOVE_PROTECT')
    runChoice(s, turn1!)

    beginTurn(s)
    layer.policy(s, 2, [])
    runChoice(s, hardSwitch(s, 1))
    beginTurn(s)
    layer.policy(s, 3, [])
    runChoice(s, hardSwitch(s, 0))

    beginTurn(s)
    expect(s.state.battlers[0]!.partyIndex).toBe(0)
    expect(s.state.battlers[0]!.lastMove).toBeNull()
    expect(s.state.battlers[1]!.mon.hp).toBeGreaterThan(0)
    expect(s.state.battlers[1]!.mon.status1 & STATUS1_BURN).not.toBe(0)
    const trace4: PolicyTraceEntry[] = []
    const turn4 = layer.policy(s, 4, trace4)
    expect(trace4[0]!.tags).toEqual(['staller', 'protect'])
    expect(choiceMoveId(turn4!)).toBe('MOVE_PROTECT')
  })

  it('case 2: the memory is kept while the same battler stays in', () => {
    const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    patchMon(s.state, 1, 0, { status1: STATUS1_BURN })
    const layer = createTeamLayer({ roles: ROLES, genes: NO_PURPOSES })
    expect(s.state.battlers[1]!.mon.hp).toBeGreaterThan(0)
    expect(s.state.battlers[1]!.mon.status1 & STATUS1_BURN).not.toBe(0)
    const trace1: PolicyTraceEntry[] = []
    const turn1 = layer.policy(s, 1, trace1)
    expect(trace1[0]!.tags).toEqual(['staller', 'protect'])
    expect(choiceMoveId(turn1!)).toBe('MOVE_PROTECT')

    // The null is set by hand only to force the memory fallback, which the sim
    // otherwise reaches only when the executed move never recorded a last move.
    s.state.battlers[0]!.lastMove = null
    const trace2: PolicyTraceEntry[] = []
    const turn2 = layer.policy(s, 2, trace2)
    expect(trace2[0]!.tags).toEqual(['staller', 'damage'])
    expect(choiceMoveId(turn2!)).toBe('MOVE_BODY_SLAM')
  })

  it('case 3: a layer-decided move replaces the memory', () => {
    const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(s.state, 1, 0, { status1: STATUS1_BURN })
    const layer = createTeamLayer({ roles: ROLES, genes: ONLY_SACRIFICE })

    // No stepTurn anywhere below, so battlers[0].lastMove stays null and the
    // policy reads its memory fallback (as it does on a turn the game's own
    // last-move bookkeeping has not reached yet).
    expect(s.state.battlers[1]!.mon.hp).toBeGreaterThan(0)
    expect(s.state.battlers[1]!.mon.status1 & STATUS1_BURN).not.toBe(0)
    const traceA: PolicyTraceEntry[] = []
    const callA = layer.policy(s, 1, traceA)
    expect(traceA[0]!.tags).toEqual(['staller', 'protect'])
    expect(choiceMoveId(callA!)).toBe('MOVE_PROTECT')

    patchMon(s.state, 0, 0, { hp: 20 })
    const deps = aiDamageDepsFor(data, s.state, s.inverseBattle)
    const theirBodySlam = aiDamageRolls(s.state, 'MOVE_BODY_SLAM', 1, 0, deps)!
    const ourBodySlam = aiDamageRolls(s.state, 'MOVE_BODY_SLAM', 0, 1, deps)!
    // Burned Guts Machamp's Body Slam highest roll 36 >= our 20 HP, so a sample
    // can KO us; ours is 75 against its 165 HP, so we do not KO it first.
    expect(highestRoll(theirBodySlam)).toBe(36)
    expect(highestRoll(ourBodySlam)).toBe(75)
    expect(s.state.battlers[1]!.mon.hp).toBe(165)

    const traceB: PolicyTraceEntry[] = []
    const callB = layer.policy(s, 2, traceB)
    expect(traceB[0]!.tags).toEqual(['team', 'sacrifice'])
    expect(choiceMoveId(callB!)).toBe('MOVE_BODY_SLAM')

    patchMon(s.state, 0, 0, { hp: s.state.battlers[0]!.mon.maxHp })
    const traceC: PolicyTraceEntry[] = []
    const callC = layer.policy(s, 3, traceC)
    expect(traceC[0]!.tags).toEqual(['staller', 'protect'])
    expect(choiceMoveId(callC!)).toBe('MOVE_PROTECT')
  })

  it('case 3 negative: without the sacrifice turn the memory still blocks Protect', () => {
    const s = session([OUR_SNORLAX, OUR_AGGRON], [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(s.state, 1, 0, { status1: STATUS1_BURN })
    const layer = createTeamLayer({ roles: ROLES, genes: ONLY_SACRIFICE })

    expect(s.state.battlers[1]!.mon.hp).toBeGreaterThan(0)
    expect(s.state.battlers[1]!.mon.status1 & STATUS1_BURN).not.toBe(0)
    const traceA: PolicyTraceEntry[] = []
    const callA = layer.policy(s, 1, traceA)
    expect(traceA[0]!.tags).toEqual(['staller', 'protect'])
    expect(choiceMoveId(callA!)).toBe('MOVE_PROTECT')

    const traceC: PolicyTraceEntry[] = []
    const callC = layer.policy(s, 2, traceC)
    expect(traceC[0]!.tags).toEqual(['staller', 'damage'])
    expect(choiceMoveId(callC!)).toBe('MOVE_BODY_SLAM')
  })
})
