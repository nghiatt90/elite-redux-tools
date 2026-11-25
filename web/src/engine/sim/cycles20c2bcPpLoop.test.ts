/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20c2bc - the PP loop's switch-in disqualification must be what the
// sim's own hazard port does to the probe, not a hand-rolled grounded/
// non-Poison/non-Steel rule. The C block is VARIOUS_DO_HAZARD_DAMAGE's
// HAZARD_MODE_POISON_SPIKES (battle_script_commands.c:8760-8787): Poison type
// or ABILITY_IMMUNITY absorbs, otherwise `IsBattlerAffectedByHazards` (Boots
// fail it) plus `CanBePoisoned` (battle_util.c:5042-5050: no existing status,
// no Misty Terrain/Safeguard/ability protection, `CanPoisonType` needs
// Corrosion or a like ability on the poisoner for a Steel target).
//
// Every fixture makes Body Slam (Normal) immune on our Ghost pair, so move
// damage is 0 and only the switch-in's fate decides. Loops are asserted as the
// ppLoop purpose firing; no-loops as the active mon's 'attacker' role deciding.
import { describe, expect, it } from 'vitest'

import { aiDamageRolls } from './ai/aiCalcDamage'
import {
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_TOXIC_SPIKES,
  STATUS1_BURN,
  STATUS_FIELD_MISTY_TERRAIN,
  hasFlag,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import { rangeOnOurReserve, stateWithReserve } from './driver/rolePolicy'
import { aiDamageDepsFor, cloneSession, createSession } from './driver/session'
import type { BattleSession } from './driver/session'
import { createTeamLayer } from './driver/teamLayer'
import type { TeamPurpose } from './driver/teamLayer'
import { isBattlerGrounded } from './grounding'
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
 * the party mon), the shape a fixture needs for HP/type/status/item/ability
 * overrides. */
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

const OUR_DUSKNOIR: PlayerMonSpec = { species: 'SPECIES_DUSKNOIR', level: 50, moves: ['MOVE_SHADOW_BALL'] }

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

/** Bench slot 1's grounding, read on the same clone the layer's probe builds. */
function benchGrounded(s: BattleSession): boolean {
  const reserve = s.state.sides[0].party[1]!
  const probe = cloneSession({ ...s, state: stateWithReserve(s.state, 0, reserve, 1) }, 0)
  return isBattlerGrounded(probe.state, 0, { ...probe.turnDeps.grounding, attackerHasMoldBreaker: false })
}

/** The fixture's default Toxic Spikes layer on side 0 (one layer -> poison). */
function toxicSpikes(s: BattleSession, amount = 1): void {
  s.state.sides[0].statuses |= SIDE_STATUS_TOXIC_SPIKES
  s.state.sides[0].timers.toxicSpikesAmount = amount
}

const ABILITY = (ability: string) => ({
  abilities: { ability, innates: [null, null, null] },
})

describe('cycle s20c2bc - PP loop: the hazard port decides the switch-in', () => {
  it('an ABILITY_IMMUNITY holder absorbs only on the probe and loops', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(s.state, 0, slot, ABILITY('ABILITY_IMMUNITY'))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    toxicSpikes(s)
    expect(benchGrounded(s)).toBe(true)
    expect(decide(s)).toEqual(['team', 'ppLoop'])
    // The absorb happened on the cloned probe; the live side keeps its spikes.
    expect(hasFlag(s.state.sides[0].statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(true)
    expect(s.state.sides[0].timers.toxicSpikesAmount).toBe(1)
  })

  it('a bench mon that already has a status stays eligible', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    patchMon(s.state, 0, 1, { status1: STATUS1_BURN })
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    toxicSpikes(s)
    expect(benchGrounded(s)).toBe(true)
    expect(decide(s)).toEqual(['team', 'ppLoop'])
  })

  it('Heavy-Duty Boots fail IsBattlerAffectedByHazards, so the pair loops', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(s.state, 0, slot, { itemId: 'ITEM_HEAVY_DUTY_BOOTS' })
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    toxicSpikes(s)
    expect(benchGrounded(s)).toBe(true)
    expect(decide(s)).toEqual(['team', 'ppLoop'])
  })

  it('Safeguard makes CanBePoisoned fail, so the pair loops', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    toxicSpikes(s)
    s.state.sides[0].statuses |= SIDE_STATUS_SAFEGUARD
    expect(benchGrounded(s)).toBe(true)
    expect(decide(s)).toEqual(['team', 'ppLoop'])
  })

  it('Misty Terrain makes CanBePoisoned fail, so the pair loops', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    toxicSpikes(s)
    s.state.field.statuses |= STATUS_FIELD_MISTY_TERRAIN
    expect(benchGrounded(s)).toBe(true)
    expect(decide(s)).toEqual(['team', 'ppLoop'])
  })

  it('a plain grounded pair is poisoned and does not loop (1 or 2 layers)', () => {
    const one = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(one, 'MOVE_BODY_SLAM')
    toxicSpikes(one, 1)
    expect(benchGrounded(one)).toBe(true)
    expect(one.state.sides[0].party[1]!.status1).toBe(0)
    expect(decide(one)[0]).toBe('attacker')

    const two = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(two, 'MOVE_BODY_SLAM')
    toxicSpikes(two, 2)
    expect(benchGrounded(two)).toBe(true)
    expect(two.state.sides[0].party[1]!.status1).toBe(0)
    expect(decide(two)[0]).toBe('attacker')
  })

  it('a Steel/Ghost pair is poisoned only when the foe has Corrosion', () => {
    const corrosion = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(corrosion.state, 0, slot, { types: ['STEEL', 'GHOST'] })
    patchMon(corrosion.state, 1, 0, ABILITY('ABILITY_CORROSION'))
    expectImmuneBoth(corrosion, 'MOVE_BODY_SLAM')
    toxicSpikes(corrosion)
    expect(benchGrounded(corrosion)).toBe(true)
    expect(corrosion.state.sides[0].party[1]!.types).toContain('STEEL')
    // CanPoisonType (battle_util.c, the ABILITY_CORROSION arm) lets it through.
    expect(decide(corrosion)[0]).toBe('attacker')

    const plain = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(plain.state, 0, slot, { types: ['STEEL', 'GHOST'] })
    expectImmuneBoth(plain, 'MOVE_BODY_SLAM')
    toxicSpikes(plain)
    expect(benchGrounded(plain)).toBe(true)
    expect(plain.state.sides[0].party[1]!.types).toContain('STEEL')
    expect(decide(plain)).toEqual(['team', 'ppLoop'])
  })
})
