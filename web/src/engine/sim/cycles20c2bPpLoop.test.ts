/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20c2b - the PP stall loop must not drain a foe whose usable moves can
// land a non-volatile status, and its stop must stay latched. Decision 14,
// docs/battle-sim/solver-v2-plan.md ("stopping only when both sides switched
// every turn for 4 turns with no HP or PP change on either side").
//
// Every fixture makes Body Slam (or, in the Blood Shot landing case, Shadow
// Ball) immune on both of our mons, so only the status test can decide. The
// status gates and their C citations are in teamLayer.ts's statusLandsOnUs.
import { describe, expect, it } from 'vitest'

import { aiDamageRolls } from './ai/aiCalcDamage'
import { STATUS1_BURN } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import { rangeOnOurReserve, stateWithReserve } from './driver/rolePolicy'
import { aiDamageDepsFor, createSession } from './driver/session'
import type { BattleSession } from './driver/session'
import { createTeamLayer } from './driver/teamLayer'
import type { TeamPurpose } from './driver/teamLayer'
import { canBePoisoned } from './statusEffects'
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

/** Writes a patch on both copies of a party slot (the active battler's mon and
 * the party mon), the shape a fixture needs for HP/type/status overrides --
 * cycle946's helper. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

/** One purpose on, every other off: the isolation every fixture needs. */
const onlyPurpose = (purpose: TeamPurpose): Record<TeamPurpose, boolean> => ({
  preserve: purpose === 'preserve',
  sacrifice: purpose === 'sacrifice',
  counter: purpose === 'counter',
  entryAbility: purpose === 'entryAbility',
  support: purpose === 'support',
  ppLoop: purpose === 'ppLoop',
})

// Fixtures. Ghost typing makes Body Slam (Normal) immune; the moves list only
// needs one damaging move so the attacker fallback has a legal choice.
const OUR_DUSKNOIR: PlayerMonSpec = { species: 'SPECIES_DUSKNOIR', level: 50, moves: ['MOVE_SHADOW_BALL'] }
const OUR_HONEDGE: PlayerMonSpec = { species: 'SPECIES_HONEDGE', level: 50, moves: ['MOVE_SHADOW_BALL'] }
const OUR_GENGAR: PlayerMonSpec = { species: 'SPECIES_GENGAR', level: 50, moves: ['MOVE_SHADOW_BALL'] }
// ABILITY_IMMUNITY blocks every non-sleep status1 (OWN_STATUS_IMMUNE_CONDITIONS,
// statusEffects.ts:1084-1085), and it is not unsuppressable, so Gastro Acid's
// suppression must be the only thing that turns Toxic into a threat.
const OUR_IMMUNE: PlayerMonSpec = {
  species: 'SPECIES_DUSKNOIR',
  level: 50,
  moves: ['MOVE_SHADOW_BALL'],
  ability: 'ABILITY_IMMUNITY',
}

// Two identical copies so a pp patch can hit "both copies" like the queue asks.
const foe = (moves: string[]): TrainerMonData[] => [
  mon('SPECIES_SNORLAX', moves),
  mon('SPECIES_SNORLAX', moves),
]

const layerFor = () =>
  createTeamLayer({ roles: ['attacker', 'attacker'], genes: { purposeFlags: onlyPurpose('ppLoop') } })

function decide(s: BattleSession): string[] {
  const layer = layerFor()
  const trace: PolicyTraceEntry[] = []
  layer.policy(s, 1, trace)
  return trace[0]!.tags
}

/** `moveId` is immune on our active mon and on our bench slot 1. */
function expectImmuneBoth(s: BattleSession, moveId: string): void {
  const active = aiDamageRolls(s.state, moveId, 1, 0, aiDamageDepsFor(data, s.state, false))!
  expect(active.isImmune).toBe(true)
  expect(rangeOnOurReserve(s, moveId, 1)!.isImmune).toBe(true)
}

const poisonDeps = (s: BattleSession) => aiDamageDepsFor(data, s.state, false)

describe('cycle s20c2b - PP loop: a status move disqualifies a loop member', () => {
  it('does not loop when their Toxic can land', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_TOXIC']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    expect(canBePoisoned(s.state, 1, 0, 'MOVE_TOXIC', poisonDeps(s))).toBe(true)
    expect(decide(s)[0]).toBe('attacker')
  })

  it('loops when their Toxic cannot land: Steel/Ghost and Poison/Ghost pairs', () => {
    const steel = session([OUR_HONEDGE, OUR_HONEDGE], foe(['MOVE_BODY_SLAM', 'MOVE_TOXIC']))
    expectImmuneBoth(steel, 'MOVE_BODY_SLAM')
    expect(canBePoisoned(steel.state, 1, 0, 'MOVE_TOXIC', poisonDeps(steel))).toBe(false)
    expect(decide(steel)).toEqual(['team', 'ppLoop'])

    const poison = session([OUR_GENGAR, OUR_GENGAR], foe(['MOVE_BODY_SLAM', 'MOVE_TOXIC']))
    expectImmuneBoth(poison, 'MOVE_BODY_SLAM')
    expect(canBePoisoned(poison.state, 1, 0, 'MOVE_TOXIC', poisonDeps(poison))).toBe(false)
    expect(decide(poison)).toEqual(['team', 'ppLoop'])
  })

  it('loops once their Toxic has no PP left', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_TOXIC']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    expect(canBePoisoned(s.state, 1, 0, 'MOVE_TOXIC', poisonDeps(s))).toBe(true)
    // Toxic is the second move slot; zero it on both party copies and the live
    // battler's mon.
    for (const slot of [0, 1]) s.state.sides[1].party[slot]!.pp[1] = 0
    s.state.battlers[1]!.mon.pp[1] = 0
    expect(decide(s)).toEqual(['team', 'ppLoop'])
  })

  it('loops when our mons already have a status', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_TOXIC']))
    for (const slot of [0, 1]) patchMon(s.state, 0, slot, { status1: STATUS1_BURN })
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    expect(decide(s)).toEqual(['team', 'ppLoop'])
  })

  it('does not loop when only the bench mon can be statused', () => {
    const s = session([OUR_HONEDGE, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_TOXIC']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    const benchState = stateWithReserve(s.state, 0, s.state.sides[0].party[1]!, 1)
    expect(canBePoisoned(benchState, 1, 0, 'MOVE_TOXIC', aiDamageDepsFor(data, benchState, false))).toBe(true)
    expect(decide(s)[0]).toBe('attacker')
  })
})

describe('cycle s20c2b - PP loop: the status effect table', () => {
  it('Yawn: loops, because a switch clears the drowsiness', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_YAWN']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    expect(decide(s)).toEqual(['team', 'ppLoop'])
  })

  it('Will-O-Wisp: does not loop, but a Fire-immune pair loops', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_WILL_O_WISP']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    expect(decide(s)[0]).toBe('attacker')

    const fire = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_WILL_O_WISP']))
    for (const slot of [0, 1]) patchMon(fire.state, 0, slot, { types: ['GHOST', 'FIRE'] })
    expectImmuneBoth(fire, 'MOVE_BODY_SLAM')
    expect(decide(fire)).toEqual(['team', 'ppLoop'])
  })

  it('Spore: does not loop, but a Grass pair loops by powder immunity', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_SPORE']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    expect(decide(s)[0]).toBe('attacker')

    const grass = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_SPORE']))
    for (const slot of [0, 1]) patchMon(grass.state, 0, slot, { types: ['GHOST', 'GRASS'] })
    expectImmuneBoth(grass, 'MOVE_BODY_SLAM')
    expect(decide(grass)).toEqual(['team', 'ppLoop'])
  })

  it('Toxic Thread: does not loop, but the Honedge pair loops', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_TOXIC_THREAD']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    expect(decide(s)[0]).toBe('attacker')

    const steel = session([OUR_HONEDGE, OUR_HONEDGE], foe(['MOVE_BODY_SLAM', 'MOVE_TOXIC_THREAD']))
    expectImmuneBoth(steel, 'MOVE_BODY_SLAM')
    expect(decide(steel)).toEqual(['team', 'ppLoop'])
  })

  it('Flash Freeze: does not loop, but an Ice pair loops', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_FLASH_FREEZE']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    expect(decide(s)[0]).toBe('attacker')

    const ice = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_FLASH_FREEZE']))
    for (const slot of [0, 1]) patchMon(ice.state, 0, slot, { types: ['GHOST', 'ICE'] })
    expectImmuneBoth(ice, 'MOVE_BODY_SLAM')
    expect(decide(ice)).toEqual(['team', 'ppLoop'])
  })

  it('Blood Shot: Ghosts cannot bleed, but Normal-types can', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_BLOOD_SHOT']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    expect(decide(s)).toEqual(['team', 'ppLoop'])

    const normal = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_SHADOW_BALL', 'MOVE_BLOOD_SHOT']))
    for (const slot of [0, 1]) patchMon(normal.state, 0, slot, { types: ['NORMAL'] })
    expectImmuneBoth(normal, 'MOVE_SHADOW_BALL')
    expect(decide(normal)[0]).toBe('attacker')
  })

  it('Psycho Shift: a healthy foe does not status us, a burned one does', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_PSYCHO_SHIFT']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    expect(decide(s)).toEqual(['team', 'ppLoop'])

    const burned = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM', 'MOVE_PSYCHO_SHIFT']))
    patchMon(burned.state, 1, 0, { status1: STATUS1_BURN })
    expectImmuneBoth(burned, 'MOVE_BODY_SLAM')
    expect(decide(burned)[0]).toBe('attacker')
  })
})

describe('cycle s20c2b - PP loop: Gastro Acid suppression', () => {
  it('Toxic is blocked by an ability immunity that Gastro Acid suppresses', () => {
    const toxic = session([OUR_IMMUNE, OUR_IMMUNE], foe(['MOVE_BODY_SLAM', 'MOVE_TOXIC']))
    expectImmuneBoth(toxic, 'MOVE_BODY_SLAM')
    expect(canBePoisoned(toxic.state, 1, 0, 'MOVE_TOXIC', poisonDeps(toxic))).toBe(false)
    expect(decide(toxic)).toEqual(['team', 'ppLoop'])

    const acid = session([OUR_IMMUNE, OUR_IMMUNE], foe(['MOVE_BODY_SLAM', 'MOVE_GASTRO_ACID']))
    expectImmuneBoth(acid, 'MOVE_BODY_SLAM')
    const statuses3 = acid.state.battlers[0]!.statuses3
    expect(decide(acid)[0]).toBe('attacker')
    // The suppression probe is a copy: the live battler is untouched.
    expect(acid.state.battlers[0]!.statuses3).toBe(statuses3)
  })
})
