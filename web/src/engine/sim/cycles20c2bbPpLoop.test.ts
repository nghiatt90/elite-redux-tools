/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20c2bb - the PP stall loop gate must price what a SWITCH-IN pays, and
// Yawn must not disqualify a foe that is switched against every turn. Decision
// 14, docs/battle-sim/solver-v2-plan.md.
//
// Every fixture makes Body Slam (Normal) immune on our Ghost pair, so move
// damage is 0 and only the new switch-in cost decides. Numbers are derived by
// hand from the C: Spikes maxHp/((5 - layers) * 2) and Stealth Rock maxHp/8, /4
// ... by type effectiveness (battle_script_commands.c:8729-8757), Toxic Terrain
// maxHp/16 (battle_util.c:2124-2146, battle_scripts_1.s:10167-10168).
import { describe, expect, it } from 'vitest'

import { aiDamageRolls } from './ai/aiCalcDamage'
import {
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_TOXIC_SPIKES,
  STATUS_FIELD_TOXIC_TERRAIN,
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
import { TYPE_ROCK_ID } from './hazards'
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
  doubleSwitch: purpose === 'doubleSwitch',
  entryAbility: purpose === 'entryAbility',
  support: purpose === 'support',
  ppLoop: purpose === 'ppLoop',
})

const OUR_DUSKNOIR: PlayerMonSpec = { species: 'SPECIES_DUSKNOIR', level: 50, moves: ['MOVE_SHADOW_BALL'] }

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

/** Bench slot 1's grounding, read on the same clone the layer's probe builds:
 * `stateWithReserve` at battler 0 plus a fresh session so the grounding context
 * is bound to that state. */
function benchGrounded(s: BattleSession): boolean {
  const reserve = s.state.sides[0].party[1]!
  const probe = cloneSession({ ...s, state: stateWithReserve(s.state, 0, reserve, 1) }, 0)
  return isBattlerGrounded(probe.state, 0, { ...probe.turnDeps.grounding, attackerHasMoldBreaker: false })
}

function halfHpBench(s: BattleSession): number {
  const maxHp = s.state.sides[0].party[1]!.maxHp
  const hp = Math.trunc(maxHp / 2)
  patchMon(s.state, 0, 1, { hp })
  return hp
}

describe('cycle s20c2bb - PP loop: Yawn is free when the loop switches', () => {
  it('a foe whose only move is Yawn still qualifies', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_YAWN']))
    expect(decide(s)).toEqual(['team', 'ppLoop'])
  })
})

describe('cycle s20c2bb - PP loop: entry hazards price the switch-in', () => {
  it('no hazard: a half-HP bench mon loops', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    halfHpBench(s)
    expect(decide(s)).toEqual(['team', 'ppLoop'])
  })

  it('Spikes: three layers outweigh 25% of a half-HP bench mon, one layer does not', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    const maxHp = s.state.sides[0].party[1]!.maxHp
    const hp = halfHpBench(s)
    s.state.sides[0].statuses |= SIDE_STATUS_SPIKES
    s.state.sides[0].timers.spikesAmount = 3
    expect(benchGrounded(s)).toBe(true)
    // (5 - 3) * 2 = 4 -> maxHp/4, over 25% of half HP.
    const cost = Math.max(1, Math.trunc(maxHp / ((5 - 3) * 2)))
    expect(cost * 100).toBeGreaterThan(25 * hp)
    expect(decide(s)[0]).toBe('attacker')

    const full = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(full, 'MOVE_BODY_SLAM')
    full.state.sides[0].statuses |= SIDE_STATUS_SPIKES
    full.state.sides[0].timers.spikesAmount = 1
    expect(benchGrounded(full)).toBe(true)
    const fullMaxHp = full.state.sides[0].party[1]!.maxHp
    const fullHp = full.state.sides[0].party[1]!.hp
    // (5 - 1) * 2 = 8 -> 12.5% of maxHp, under 25% of full HP.
    const fullCost = Math.max(1, Math.trunc(fullMaxHp / ((5 - 1) * 2)))
    expect(fullCost * 100).toBeLessThanOrEqual(25 * fullHp)
    expect(decide(full)).toEqual(['team', 'ppLoop'])
  })

  it('Spikes: an airborne bench mon pays nothing', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(s.state, 0, slot, { types: ['GHOST', 'FLYING'] })
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    s.state.sides[0].statuses |= SIDE_STATUS_SPIKES
    s.state.sides[0].timers.spikesAmount = 3
    expect(benchGrounded(s)).toBe(false)
    expect(decide(s)).toEqual(['team', 'ppLoop'])
  })

  it('Stealth Rock: a 2x-weak half-HP bench mon does not loop', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(s.state, 0, slot, { types: ['GHOST', 'FIRE'] })
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    const maxHp = s.state.sides[0].party[1]!.maxHp
    const hp = halfHpBench(s)
    s.state.sides[0].statuses |= SIDE_STATUS_STEALTH_ROCK
    s.state.sides[0].timers.stealthRockType = TYPE_ROCK_ID
    expect(s.state.sides[0].party[1]!.types).toEqual(['GHOST', 'FIRE'])
    // Rock is 2x on Fire, neutral on Ghost -> maxHp/4, over 25% of half HP.
    const cost = Math.max(1, Math.trunc(maxHp / 4))
    expect(cost * 100).toBeGreaterThan(25 * hp)
    expect(decide(s)[0]).toBe('attacker')

    const clean = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(clean.state, 0, slot, { types: ['GHOST', 'FIRE'] })
    expectImmuneBoth(clean, 'MOVE_BODY_SLAM')
    patchMon(clean.state, 0, 1, { hp })
    expect(decide(clean)).toEqual(['team', 'ppLoop'])
  })
})

describe('cycle s20c2bb - PP loop: Toxic Spikes disqualifies a grounded switch-in', () => {
  it('a grounded non-Poison/non-Steel pair does not loop; Steel, Poison and airborne pairs do', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    s.state.sides[0].statuses |= SIDE_STATUS_TOXIC_SPIKES
    s.state.sides[0].timers.toxicSpikesAmount = 1
    expect(benchGrounded(s)).toBe(true)
    expect(s.state.sides[0].party[1]!.types).not.toContain('POISON')
    expect(s.state.sides[0].party[1]!.types).not.toContain('STEEL')
    expect(decide(s)[0]).toBe('attacker')

    // Honedge is Steel/Ghost; its own innate Levitate would make the species
    // airborne, so the typing is patched onto a grounded body to isolate the
    // Steel exemption.
    const steel = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(steel.state, 0, slot, { types: ['STEEL', 'GHOST'] })
    expectImmuneBoth(steel, 'MOVE_BODY_SLAM')
    steel.state.sides[0].statuses |= SIDE_STATUS_TOXIC_SPIKES
    steel.state.sides[0].timers.toxicSpikesAmount = 1
    expect(benchGrounded(steel)).toBe(true)
    expect(steel.state.sides[0].party[1]!.types).toContain('STEEL')
    expect(decide(steel)).toEqual(['team', 'ppLoop'])

    // Gengar is Poison/Ghost, same Levitate caveat.
    const poison = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(poison.state, 0, slot, { types: ['GHOST', 'POISON'] })
    expectImmuneBoth(poison, 'MOVE_BODY_SLAM')
    poison.state.sides[0].statuses |= SIDE_STATUS_TOXIC_SPIKES
    poison.state.sides[0].timers.toxicSpikesAmount = 1
    expect(benchGrounded(poison)).toBe(true)
    expect(poison.state.sides[0].party[1]!.types).toContain('POISON')
    expect(decide(poison)).toEqual(['team', 'ppLoop'])

    const air = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(air.state, 0, slot, { types: ['GHOST', 'FLYING'] })
    expectImmuneBoth(air, 'MOVE_BODY_SLAM')
    air.state.sides[0].statuses |= SIDE_STATUS_TOXIC_SPIKES
    air.state.sides[0].timers.toxicSpikesAmount = 1
    expect(benchGrounded(air)).toBe(false)
    expect(decide(air)).toEqual(['team', 'ppLoop'])
  })
})

describe('cycle s20c2bb - PP loop: Toxic Terrain chips the switch-in', () => {
  it('a bench mon three chips from empty does not loop; the expiring turn and Steel exempt it', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    const maxHp = s.state.sides[0].party[1]!.maxHp
    const hp = Math.trunc(maxHp / 16) * 3
    patchMon(s.state, 0, 1, { hp })
    s.state.field.statuses |= STATUS_FIELD_TOXIC_TERRAIN
    s.state.field.timers.terrainTimer = 5
    expect(benchGrounded(s)).toBe(true)
    // maxHp/16 is over 25% of three chips' worth of HP.
    const cost = Math.max(1, Math.min(hp, Math.trunc(maxHp / 16)))
    expect(cost * 100).toBeGreaterThan(25 * hp)
    expect(decide(s)[0]).toBe('attacker')

    const clean = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(clean, 'MOVE_BODY_SLAM')
    patchMon(clean.state, 0, 1, { hp })
    expect(decide(clean)).toEqual(['team', 'ppLoop'])

    // Decrement-then-test: a timer of 1 reaches 0 this turn, so the chip is the
    // expiring tick's and nobody is hit.
    const expiring = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(expiring, 'MOVE_BODY_SLAM')
    patchMon(expiring.state, 0, 1, { hp })
    expiring.state.field.statuses |= STATUS_FIELD_TOXIC_TERRAIN
    expiring.state.field.timers.terrainTimer = 1
    expect(decide(expiring)).toEqual(['team', 'ppLoop'])

    const steel = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    for (const slot of [0, 1]) patchMon(steel.state, 0, slot, { types: ['STEEL', 'GHOST'] })
    expectImmuneBoth(steel, 'MOVE_BODY_SLAM')
    patchMon(steel.state, 0, 1, { hp })
    steel.state.field.statuses |= STATUS_FIELD_TOXIC_TERRAIN
    steel.state.field.timers.terrainTimer = 5
    expect(steel.state.sides[0].party[1]!.types).toContain('STEEL')
    expect(decide(steel)).toEqual(['team', 'ppLoop'])
  })
})

describe('cycle s20c2bb - PP loop: the probe leaves the live session alone', () => {
  it('bench HP, hazard flags and the active battler are unchanged by decide', () => {
    const s = session([OUR_DUSKNOIR, OUR_DUSKNOIR], foe(['MOVE_BODY_SLAM']))
    expectImmuneBoth(s, 'MOVE_BODY_SLAM')
    s.state.sides[0].statuses |= SIDE_STATUS_SPIKES
    s.state.sides[0].timers.spikesAmount = 1
    const active = s.state.battlers[0]
    const benchHp = s.state.sides[0].party[1]!.hp
    const statuses = s.state.sides[0].statuses
    expect(decide(s)).toEqual(['team', 'ppLoop'])
    expect(s.state.sides[0].party[1]!.hp).toBe(benchHp)
    expect(s.state.sides[0].statuses).toBe(statuses)
    expect(s.state.sides[0].timers.spikesAmount).toBe(1)
    expect(s.state.battlers[0]).toBe(active)
  })
})
