/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 947 (s20c2) - the solver-v2 TEAM LAYER, second slice: the entry-ability
// purpose, the bring-in-support purpose and the PP stall loop, all from plan
// decision 14 "Team layer" (docs/battle-sim/solver-v2-plan.md).
//
// The entry-ability fixtures cite the C that dispatches the effect: Intimidate
// `abilities.cc:764-771` (Intimidate<ABILITY_INTIMIDATE> + UseIntimidateClone),
// the weather setters' TryChangeBattleWeather (Drizzle :501-514, Sand Stream
// :1076, Drought :1332, Snow Warning :1798) and the four Surges'
// TryChangeBattleTerrain (:3144-3194). Damage numbers are the sim's own range
// calls on these fixtures; the 25% "little or nothing" line is a MODEL CHOICE.
//
// Fixtures are built through `createSession` and advanced with `beginTurn` /
// `stepTurn`, the shape cycle947TeamLayer.test.ts uses. HP/PP patches happen
// only on a created session before a decision; every purpose is isolated with
// `purposeFlags` so another rule cannot decide the turn.
import { describe, expect, it } from 'vitest'

import { aiDamageRolls } from './ai/aiCalcDamage'
import {
  DEFAULT_STAT_STAGE,
  PARTY_SIZE,
  SIDE_STATUS_REFLECT,
  STAT_ATK,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_TERRAIN_ANY,
  WEATHER_RAIN_TEMPORARY,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import { highestRoll, meanRoll, rangeOnOurReserve, stateWithReserve } from './driver/rolePolicy'
import { aiDamageDepsFor, beginTurn, createSession, stepTurn } from './driver/session'
import type { BattleSession } from './driver/session'
import { PP_LOOP_LITTLE_PCT, createTeamLayer } from './driver/teamLayer'
import type { TeamPurpose } from './driver/teamLayer'
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
 * the party mon), the shape a fixture needs for HP overrides -- cycle946's
 * helper. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const choiceMoveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

/** One purpose on, every other off: the isolation every fixture needs. */
const onlyPurpose = (purpose: TeamPurpose): Record<TeamPurpose, boolean> => ({
  preserve: purpose === 'preserve',
  sacrifice: purpose === 'sacrifice',
  counter: purpose === 'counter',
  entryAbility: purpose === 'entryAbility',
  support: purpose === 'support',
  ppLoop: purpose === 'ppLoop',
})

/** Our reserve `slot` attacking their active mon, optionally under a patched
 * field, using the same substituted-state call `bestReserveMove` makes. */
function meanFromReserve(
  s: BattleSession,
  slot: number,
  moveId: string,
  patch: { weather?: number; terrain?: number } = {},
): number {
  const state = stateWithReserve(s.state, 0, s.state.sides[0].party[slot]!, slot)
  const field = { ...state.field }
  if (patch.weather !== undefined) field.weather = patch.weather
  if (patch.terrain !== undefined) field.statuses = (field.statuses & ~STATUS_FIELD_TERRAIN_ANY) | patch.terrain
  state.field = field
  return meanRoll(aiDamageRolls(state, moveId, 0, 1, aiDamageDepsFor(data, state, false))!)
}

const ppSum = (pp: readonly number[]): number => pp.reduce((total, value) => total + value, 0)

// Fixtures.
//
// The lead is a plain Snorlax with only Celebrate: nothing on it can set the
// field, so the weather/terrain gate's "the ACTIVE mon holds none of the four"
// clause can never be what fails. Its default ability LETS_ROLL is a switch-in
// ability but not one of the nine this purpose handles.
const OUR_LEAD: PlayerMonSpec = { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_CELEBRATE'] }
// Aggron + Intimidate: the entry-ability fixture. Iron Head is a damaging move
// so the role fallback still finds one; Body Slam is Normal, so Aggron takes
// only 1/4x from it.
const OUR_INTIMIDATE: PlayerMonSpec = {
  species: 'SPECIES_AGGRON',
  level: 50,
  moves: ['MOVE_IRON_HEAD'],
  ability: 'ABILITY_INTIMIDATE',
}
// A Water special attacker carrying Drizzle: rain multiplies Surf by 1.5.
const OUR_DRIZZLE: PlayerMonSpec = {
  species: 'SPECIES_BLASTOISE',
  level: 50,
  moves: ['MOVE_SURF'],
  ability: 'ABILITY_DRIZZLE',
}
// Drizzle with no move the rain helps: the "nobody benefits" control.
const OUR_DRIZZLE_DRY: PlayerMonSpec = {
  species: 'SPECIES_AGGRON',
  level: 50,
  moves: ['MOVE_IRON_HEAD'],
  ability: 'ABILITY_DRIZZLE',
}
// A grounded Electric attacker carrying Electric Surge: the terrain raises
// Thunderbolt's power, so the team-benefit test sees a difference.
const OUR_SURGE: PlayerMonSpec = {
  species: 'SPECIES_PIKACHU',
  level: 50,
  moves: ['MOVE_THUNDERBOLT'],
  ability: 'ABILITY_ELECTRIC_SURGE',
}
// A frail Intimidate holder for the "predicted move KOs the candidate" gate.
const OUR_FRAIL_INTIMIDATE: PlayerMonSpec = {
  species: 'SPECIES_PIKACHU',
  level: 50,
  moves: ['MOVE_THUNDERBOLT'],
  ability: 'ABILITY_INTIMIDATE',
}
// The support teammate: a screen move, which `chooseSupportSetter` reads by its
// moves.json effect EFFECT_REFLECT.
const OUR_SUPPORT: PlayerMonSpec = { species: 'SPECIES_BLASTOISE', level: 50, moves: ['MOVE_REFLECT'] }
// A support on the field with a screen still to set.
const OUR_ACTIVE_SUPPORT: PlayerMonSpec = { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_REFLECT'] }
// Two identical Gengars: Ghost is immune to their foe's only move (Normal), so
// they both take nothing and the PP loop can alternate them.
const OUR_GENGAR: PlayerMonSpec = { species: 'SPECIES_GENGAR', level: 50, moves: ['MOVE_SHADOW_BALL'] }
// A non-Ghost bench mon: Body Slam hits it normally, so it does not qualify.
const OUR_BENCH_PIKACHU: PlayerMonSpec = { species: 'SPECIES_PIKACHU', level: 50, moves: ['MOVE_THUNDERBOLT'] }

const foePhysical = (): TrainerMonData[] => [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])]
const foeSpecial = (): TrainerMonData[] => [mon('SPECIES_MACHAMP', ['MOVE_THUNDERBOLT'])]
const foeBodySlam = (): TrainerMonData[] => [mon('SPECIES_SNORLAX', ['MOVE_BODY_SLAM'])]

describe('cycle 947b - team layer: entry ability', () => {
  it('switches in an Intimidate teammate against a physical move, not a special one', () => {
    const s = session([OUR_LEAD, OUR_INTIMIDATE], foePhysical())
    // Preconditions: Body Slam is physical, and the Aggron candidate survives
    // its highest roll.
    expect(data.dataContext.move('MOVE_BODY_SLAM')?.split).toBe('PHYSICAL')
    const incoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(highestRoll(incoming)).toBeLessThan(s.state.sides[0].party[1]!.hp)
    expect(s.state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)

    const layer = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { purposeFlags: onlyPurpose('entryAbility'), switchInSafety: 50 },
    })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'entryAbility'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)

    // Run the switch: the incoming Aggron's Intimidate lowers the foe's Attack
    // stage by one from neutral. The foe takes no action, so nothing else can
    // touch the stage.
    s.state.battlers[0]!.monToSwitchIntoId = choice!.switchTo ?? PARTY_SIZE
    stepTurn(s, choice!.action, null)
    expect(s.state.battlers[0]!.partyIndex).toBe(1)
    expect(s.state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)

    // Control: the same bench against a special predicted move stays put -- the
    // Intimidate clause requires a PHYSICAL move.
    const special = session([OUR_LEAD, OUR_INTIMIDATE], foeSpecial())
    expect(data.dataContext.move('MOVE_THUNDERBOLT')?.split).toBe('SPECIAL')
    const specialTrace: PolicyTraceEntry[] = []
    const specialChoice = layer.policy(special, 1, specialTrace)
    expect(specialTrace[0]!.tags[0]).toBe('attacker')
    expect(specialChoice!.action.action).toBe('USE_MOVE')
    expect(specialChoice!.switchTo).toBeUndefined()
  })

  it('does not switch when the foe is already at the minimum Attack stage', () => {
    const s = session([OUR_LEAD, OUR_INTIMIDATE], foePhysical())
    // The C's internal stages run 0..12 with 6 neutral (constants.ts:63); 0 is
    // the floor UseIntimidateClone can no longer lower.
    s.state.battlers[1]!.mon.statStages[STAT_ATK] = 0
    // The physical gate still holds, so only the "did it actually fall" test
    // can keep this from firing.
    expect(data.dataContext.move('MOVE_BODY_SLAM')?.split).toBe('PHYSICAL')

    const layer = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { purposeFlags: onlyPurpose('entryAbility'), switchInSafety: 50 },
    })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags[0]).toBe('attacker')
    expect(choice!.action.action).toBe('USE_MOVE')
  })

  it('brings in a weather setter when rain is down and the team benefits', () => {
    const s = session([OUR_LEAD, OUR_DRIZZLE], foePhysical())
    expect(s.state.field.weather).toBe(0)
    expect(highestRoll(rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!)).toBeLessThan(
      s.state.sides[0].party[1]!.hp,
    )
    // The benefit the rule looks for: Surf is 1.5x in rain.
    const dry = meanFromReserve(s, 1, 'MOVE_SURF', { weather: 0 })
    const rain = meanFromReserve(s, 1, 'MOVE_SURF', { weather: WEATHER_RAIN_TEMPORARY })
    expect(rain).toBeGreaterThan(dry)

    const layer = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { purposeFlags: onlyPurpose('entryAbility'), switchInSafety: 50 },
    })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'entryAbility'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)

    // Rain already up: TryChangeBattleWeather refuses the re-set, so the field
    // does not change and the rule falls through.
    const wet = session([OUR_LEAD, OUR_DRIZZLE], foePhysical())
    wet.state.field.weather = WEATHER_RAIN_TEMPORARY
    const wetTrace: PolicyTraceEntry[] = []
    const wetChoice = layer.policy(wet, 1, wetTrace)
    expect(wetTrace[0]!.tags[0]).toBe('attacker')
    expect(wetChoice!.action.action).toBe('USE_MOVE')

    // Nobody benefits: Iron Head is Steel and their Body Slam is Normal, so the
    // field change leaves every axis the benefit test reads unchanged.
    const dryTeam = session([OUR_LEAD, OUR_DRIZZLE_DRY], foePhysical())
    expect(meanFromReserve(dryTeam, 1, 'MOVE_IRON_HEAD', { weather: WEATHER_RAIN_TEMPORARY })).toBe(
      meanFromReserve(dryTeam, 1, 'MOVE_IRON_HEAD', { weather: 0 }),
    )
    const dryTrace: PolicyTraceEntry[] = []
    const dryChoice = layer.policy(dryTeam, 1, dryTrace)
    expect(dryTrace[0]!.tags[0]).toBe('attacker')
    expect(dryChoice!.action.action).toBe('USE_MOVE')
  })

  it('brings in a terrain setter when the terrain is down and the team benefits', () => {
    const s = session([OUR_LEAD, OUR_SURGE], foePhysical())
    expect(s.state.field.statuses & STATUS_FIELD_TERRAIN_ANY).toBe(0)
    expect(highestRoll(rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!)).toBeLessThan(
      s.state.sides[0].party[1]!.hp,
    )
    // The benefit: Electric Terrain raises a grounded Thunderbolt.
    const plain = meanFromReserve(s, 1, 'MOVE_THUNDERBOLT', { terrain: 0 })
    const boosted = meanFromReserve(s, 1, 'MOVE_THUNDERBOLT', { terrain: STATUS_FIELD_ELECTRIC_TERRAIN })
    expect(boosted).toBeGreaterThan(plain)
    const layer = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { purposeFlags: onlyPurpose('entryAbility'), switchInSafety: 90 },
    })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'entryAbility'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)
  })

  it('does not switch when the predicted move KOs the candidate', () => {
    const s = session([OUR_LEAD, OUR_FRAIL_INTIMIDATE], foePhysical())
    // 1 HP: any non-immune highest roll reaches it, and Body Slam is Normal
    // into an Electric target (not immune). Without the survival gate this
    // fixture would fire on Intimidate alone.
    patchMon(s.state, 0, 1, { hp: 1 })
    const incoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(incoming.isImmune).toBe(false)
    expect(highestRoll(incoming)).toBeGreaterThanOrEqual(1)

    const layer = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { purposeFlags: onlyPurpose('entryAbility'), switchInSafety: 50 },
    })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags[0]).toBe('attacker')
    expect(choice!.action.action).toBe('USE_MOVE')
  })
})

describe('cycle 947b - team layer: support', () => {
  it('brings in a support teammate whose screen is down and safe to set', () => {
    const s = session([OUR_LEAD, OUR_SUPPORT], foePhysical())
    // Preconditions: the screen is down, and the candidate takes at most the
    // default 50% line (and is not KO'd).
    expect(s.state.sides[0].statuses & SIDE_STATUS_REFLECT).toBe(0)
    const incoming = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(highestRoll(incoming) * 100).toBeLessThanOrEqual(50 * s.state.sides[0].party[1]!.hp)
    expect(highestRoll(incoming)).toBeLessThan(s.state.sides[0].party[1]!.hp)

    const layer = createTeamLayer({
      roles: ['attacker', 'support'],
      genes: { purposeFlags: onlyPurpose('support'), switchInSafety: 50 },
    })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'support'])
    expect(choice!.action.action).toBe('SWITCH')
    expect(choice!.switchTo).toBe(1)

    // Screen already up: the setter has nothing left to set.
    const up = session([OUR_LEAD, OUR_SUPPORT], foePhysical())
    up.state.sides[0].statuses = up.state.sides[0].statuses | SIDE_STATUS_REFLECT
    const upTrace: PolicyTraceEntry[] = []
    const upChoice = layer.policy(up, 1, upTrace)
    expect(upTrace[0]!.tags[0]).toBe('attacker')
    expect(upChoice!.action.action).toBe('USE_MOVE')

    // The predicted move threatens the candidate: 1 HP makes its highest roll
    // at least its whole HP, so both `acceptable` and the < 1 gate fail.
    const threatened = session([OUR_LEAD, OUR_SUPPORT], foePhysical())
    patchMon(threatened.state, 0, 1, { hp: 1 })
    expect(highestRoll(rangeOnOurReserve(threatened, 'MOVE_BODY_SLAM', 1)!)).toBeGreaterThanOrEqual(1)
    const threatenedTrace: PolicyTraceEntry[] = []
    const threatenedChoice = layer.policy(threatened, 1, threatenedTrace)
    expect(threatenedTrace[0]!.tags[0]).toBe('attacker')
    expect(threatenedChoice!.action.action).toBe('USE_MOVE')
  })

  it('does not fire while the active mon is a support with its own effect to set', () => {
    // Two supports and the screen down: without the active-support gate they
    // would ping-pong before either set the screen. The active support sets it,
    // which is the role's own ['support', 'screen'] trace.
    const s = session([OUR_ACTIVE_SUPPORT, OUR_SUPPORT], foePhysical())
    const layer = createTeamLayer({
      roles: ['support', 'support'],
      genes: { purposeFlags: onlyPurpose('support') },
    })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['support', 'screen'])
    expect(choice!.action.action).toBe('USE_MOVE')
    expect(choiceMoveId(choice!)).toBe('MOVE_REFLECT')
  })
})

describe('cycle 947b - team layer: PP loop', () => {
  it('alternates two mons that both take nothing, and drains their PP', () => {
    const s = session([OUR_GENGAR, OUR_GENGAR], [foeBodySlam()[0]!, foeBodySlam()[0]!])
    // Preconditions: their only move is Normal and both our mons are Ghost, so
    // the damage is zero on the active and on the bench.
    const activeRange = aiDamageRolls(
      s.state,
      'MOVE_BODY_SLAM',
      1,
      0,
      aiDamageDepsFor(data, s.state, false),
    )!
    expect(activeRange.isImmune).toBe(true)
    expect(rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!.isImmune).toBe(true)

    const layer = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { purposeFlags: onlyPurpose('ppLoop') },
    })
    const ppBefore = s.state.battlers[1]!.mon.pp[0]!

    beginTurn(s)
    const trace1: PolicyTraceEntry[] = []
    const choice1 = layer.policy(s, 1, trace1)
    expect(trace1[0]!.tags).toEqual(['team', 'ppLoop'])
    expect(choice1!.action.action).toBe('SWITCH')
    const firstTarget = choice1!.switchTo!
    s.state.battlers[0]!.monToSwitchIntoId = firstTarget
    stepTurn(s, choice1!.action)
    expect(s.state.battlers[0]!.partyIndex).toBe(firstTarget)
    expect(s.state.battlers[1]!.mon.pp[0]).toBe(ppBefore - 1)

    beginTurn(s)
    const trace2: PolicyTraceEntry[] = []
    const choice2 = layer.policy(s, 2, trace2)
    expect(trace2[0]!.tags).toEqual(['team', 'ppLoop'])
    // The other Gengar is the bench slot now, so the loop alternates.
    expect(choice2!.switchTo).toBe(0)
    s.state.battlers[0]!.monToSwitchIntoId = choice2!.switchTo!
    stepTurn(s, choice2!.action)
    expect(s.state.battlers[0]!.partyIndex).toBe(0)
    expect(s.state.battlers[1]!.mon.pp[0]).toBe(ppBefore - 2)
  })

  it('stops after four stalled swaps and keeps firing while their PP moves', () => {
    const build = (): BattleSession =>
      session([OUR_GENGAR, OUR_GENGAR], [foeBodySlam()[0]!, foeBodySlam()[0]!])
    const layerFor = () =>
      createTeamLayer({
        roles: ['attacker', 'attacker'],
        genes: { purposeFlags: onlyPurpose('ppLoop') },
      })
    // Hand-patched party indexes stand in for a real double switch; the two
    // mons on each side are identical, so the summed HP and PP stay put
    // whichever partyIndex is marked active.
    const swap = (s: BattleSession, slot: number): void => {
      s.state.battlers[0]!.partyIndex = slot
      s.state.battlers[1]!.partyIndex = slot
    }

    const stalled = build()
    expect(ppSum(stalled.state.sides[0].party[0]!.pp)).toBe(ppSum(stalled.state.sides[0].party[1]!.pp))
    expect(ppSum(stalled.state.sides[1].party[0]!.pp)).toBe(ppSum(stalled.state.sides[1].party[1]!.pp))
    const layer = layerFor()
    const tags: string[][] = []
    for (let turn = 1; turn <= 5; turn++) {
      if (turn > 1) swap(stalled, turn % 2 === 0 ? 1 : 0)
      const trace: PolicyTraceEntry[] = []
      layer.policy(stalled, turn, trace)
      tags.push(trace[0]!.tags)
    }
    // Four stalled turns observed by the fifth call: turns 1-4 fire ppLoop,
    // turn 5 falls through to the role and latches the stop.
    expect(tags.slice(0, 4).map((t) => t[0])).toEqual(['team', 'team', 'team', 'team'])
    expect(tags.slice(0, 4).map((t) => t[1])).toEqual(['ppLoop', 'ppLoop', 'ppLoop', 'ppLoop'])
    expect(tags[4]![0]).toBe('attacker')

    // The turn after a stop is never a stalled double switch: our role rule
    // leaves the party index alone and their PP drains. The stop stays latched,
    // so turns 5-10 all fall through -- without the latch the count would reset
    // at turn 6 and ppLoop would fire again.
    const afterStop: string[][] = []
    for (let turn = 6; turn <= 10; turn++) {
      stalled.state.battlers[1]!.mon.pp[0] = stalled.state.battlers[1]!.mon.pp[0]! - 1
      const trace: PolicyTraceEntry[] = []
      layer.policy(stalled, turn, trace)
      afterStop.push(trace[0]!.tags)
    }
    expect([tags[4]!, ...afterStop].every((t) => t[0] === 'attacker')).toBe(true)
    expect([tags[4]!, ...afterStop].some((t) => t[1] === 'ppLoop')).toBe(false)

    // A non-consecutive turn is the new-game signal and the only thing that
    // clears the latch, so the loop fires again.
    const restartTrace: PolicyTraceEntry[] = []
    const restart = layer.policy(stalled, 1, restartTrace)
    expect(restartTrace[0]!.tags).toEqual(['team', 'ppLoop'])
    expect(restart!.action.action).toBe('SWITCH')

    // Their PP drops between calls: the "no HP or PP change" half of the stop
    // rule never holds, so the loop keeps firing past turn 5.
    const moving = build()
    const movingLayer = layerFor()
    const movingTags: string[][] = []
    for (let turn = 1; turn <= 6; turn++) {
      if (turn > 1) {
        swap(moving, turn % 2 === 0 ? 1 : 0)
        moving.state.battlers[1]!.mon.pp[0] = moving.state.battlers[1]!.mon.pp[0]! - 1
      }
      const trace: PolicyTraceEntry[] = []
      movingLayer.policy(moving, turn, trace)
      movingTags.push(trace[0]!.tags)
    }
    expect(movingTags.map((t) => t[0])).toEqual(['team', 'team', 'team', 'team', 'team', 'team'])
    expect(movingTags.map((t) => t[1])).toEqual([
      'ppLoop',
      'ppLoop',
      'ppLoop',
      'ppLoop',
      'ppLoop',
      'ppLoop',
    ])
  })

  it('does not fire when only the active mon qualifies', () => {
    const s = session([OUR_GENGAR, OUR_BENCH_PIKACHU], foeBodySlam())
    // The active Gengar takes nothing, but the bench Pikachu takes more than
    // the 25% line, so there is no second mon to alternate with.
    expect(
      aiDamageRolls(s.state, 'MOVE_BODY_SLAM', 1, 0, aiDamageDepsFor(data, s.state, false))!.isImmune,
    ).toBe(true)
    const benchRange = rangeOnOurReserve(s, 'MOVE_BODY_SLAM', 1)!
    expect(benchRange.isImmune).toBe(false)
    const benchHp = s.state.sides[0].party[1]!.hp
    expect(highestRoll(benchRange) * 100).toBeGreaterThan(PP_LOOP_LITTLE_PCT * benchHp)

    const layer = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: { purposeFlags: onlyPurpose('ppLoop') },
    })
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags[0]).toBe('attacker')
    expect(choice!.action.action).toBe('USE_MOVE')
  })
})

