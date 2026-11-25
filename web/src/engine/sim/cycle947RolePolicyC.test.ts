/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 947: the solver-v2 role policy's sixth and last role, support (plan
// decision 14, the remainder of s20b2; docs/battle-sim/solver-v2-plan.md). A
// support sets its effect (screens, weather, terrain, Trick Room, or its own
// boosts to pass with Baton Pass) when it is down, hands off with a pivot move,
// and otherwise switches out when threatened or plays a fallback role.
//
// Fixtures are built through `createSession` and advanced with `beginTurn` /
// `stepTurn`, the same shape as cycle946's test. HP / stat stages / field
// timers are patched on the created session only BEFORE a decision; nothing is
// poked after `executeTurn`. Every effect gate cites the handler that decides
// it; the policy thresholds (safetyPct, targetStage, refresh) are MODEL
// CHOICES (decision 14's defaults).
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STAT_STAGE,
  PARTY_SIZE,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  STAT_SPATK,
  STAT_SPDEF,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  WEATHER_RAIN_TEMPORARY,
} from './constants'
import { aiDamageRolls } from './ai/aiCalcDamage'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { legalChoices } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import type { RoleMemory, RoleParams, RoleName } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { aiDamageDepsFor, beginTurn, createSession, stepTurn } from './driver/session'
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
 * the party mon), the shape a fixture needs for HP/stat overrides. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const memory = (): RoleMemory => ({ turn: 0, lastMove: null })

const moveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

/** One turn exactly as `playPolicyBattle` runs it: beginTurn, the policy, the
 * switch-slot write (`replacement` for a hard switch or a pivot), stepTurn. */
function playTurn(s: BattleSession, role: RoleName, params: RoleParams, mem: RoleMemory): PlayerChoice {
  beginTurn(s)
  const choice = chooseRoleAction(s, role, params, mem)
  s.state.battlers[0]!.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
  stepTurn(s, choice.action)
  return choice
}

const playerOne = (moves: string[]): PlayerMonSpec[] => [{ species: 'SPECIES_SNORLAX', level: 50, moves }]

/** Machamp's Body Slam onto our level-50 Hardy Snorlax: min 39, max 46 (the
 * same fixture and range call as cycles 945/946). Every threat threshold below
 * uses that 46. */
const MACHAMP_BODY_SLAM_MAX = 46

describe('cycle 947 - support: switch when threatened, else fallback', () => {
  // A screen is patched up so rule 1 is already satisfied: these fixtures test
  // rule 3 (hard switch / fallback), not the screen. Light Screen, not Reflect,
  // because Body Slam is physical and Reflect would halve the damage this
  // fixture's threat arithmetic depends on.
  const setup = (): BattleSession => {
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_LIGHT_SCREEN', 'MOVE_BODY_SLAM', 'MOVE_TOXIC'] },
        // Ghost bench: immune to the predicted Normal move (Body Slam).
        { species: 'SPECIES_GENGAR', level: 50, moves: ['MOVE_SHADOW_BALL'] },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])],
    )
    s.state.sides[0].statuses |= SIDE_STATUS_LIGHTSCREEN
    s.state.sides[0].timers.lightscreenTimer = 5
    return s
  }

  it('switches to the teammate that takes the predicted move better', () => {
    const s = setup()
    // HP 80: Machamp's 46 crosses the default 50% line (4600 > 4000) without a
    // KO. The bench Gengar takes 0 (Normal immunity) against our 46. Derive
    // the 46 from the same sim range call first.
    const incoming = aiDamageRolls(s.state, 'MOVE_BODY_SLAM', 1, 0, aiDamageDepsFor(data, s.state, s.inverseBattle))!
    const high = (incoming.totalRolls ?? incoming.rolls)[15]!
    expect(high).toBe(MACHAMP_BODY_SLAM_MAX)
    expect(high * 100).toBeGreaterThan(50 * 80)
    patchMon(s.state, 0, 0, { hp: 80 })
    beginTurn(s)
    const choice = chooseRoleAction(s, 'support', {}, memory())
    expect(choice.action.action).toBe('SWITCH')
    expect(choice.switchTo).toBe(1)
  })

  it('plays the attacker fallback when not threatened', () => {
    const s = setup()
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'support', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('plays the staller fallback when fallbackRole is staller', () => {
    // At full HP nothing threatens, so rule 3 falls through; the delegated
    // staller statuses the clean Machamp (Toxic works on Fighting).
    const s = setup()
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'support', { fallbackRole: 'staller' }, memory()))).toBe('MOVE_TOXIC')
  })
})

describe('cycle 947 - support: Baton Pass boosts', () => {
  const batonParty = (): PlayerMonSpec[] => [
    { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_CALM_MIND', 'MOVE_BATON_PASS', 'MOVE_BODY_SLAM'] },
    { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
  ]

  it('boosts to the target stage, then Baton Passes the stages to the bench', () => {
    // Celebrate never threatens and holds no Haze/phazing move, so the
    // set-up gate is open. Calm Mind is EFFECT_CALM_MIND -> Sp. Atk (+1 each
    // use, battle_scripts_1.s:6739-6763). targetStage 2 is the default.
    const s = session(batonParty(), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const mem = memory()

    expect(moveId(playTurn(s, 'support', {}, mem))).toBe('MOVE_CALM_MIND')
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(moveId(playTurn(s, 'support', {}, mem))).toBe('MOVE_CALM_MIND')
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 2)

    // At the target stage the pivot hand-off runs; handleBatonPass carries
    // statStages to the incoming mon (turn.ts:1905-1930; moveEffects.ts:10437+).
    const pass = playTurn(s, 'support', {}, mem)
    expect(moveId(pass)).toBe('MOVE_BATON_PASS')
    expect(pass.switchTo).toBe(1)
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  it('does not boost when threatened', () => {
    // HP 80 makes Machamp's 46 threatening, so the safe-to-boost gate closes
    // and the support falls through to its pivot hand-off.
    const s = session(batonParty(), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM'])])
    patchMon(s.state, 0, 0, { hp: 80 })
    beginTurn(s)
    const choice = chooseRoleAction(s, 'support', {}, memory())
    expect(moveId(choice)).not.toBe('MOVE_CALM_MIND')
    expect(moveId(choice)).toBe('MOVE_BATON_PASS')
  })
})

describe('cycle 947 - support: screens', () => {
  it('sets Reflect when down and skips it on the next turn when up', () => {
    const s = session(playerOne(['MOVE_REFLECT', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const mem = memory()
    const trace: PolicyTraceEntry[] = []
    beginTurn(s)
    const first = chooseRoleAction(s, 'support', {}, mem, trace)
    expect(moveId(first)).toBe('MOVE_REFLECT')
    expect(trace[0]!.tags).toEqual(['support', 'screen'])
    s.state.battlers[0]!.monToSwitchIntoId = PARTY_SIZE
    stepTurn(s, first.action)
    // handleReflect sets the bit and reflectTimer 5 without Light Clay
    // (moveEffects.ts:2956-2965). started.reflect stops this turn's decrement.
    expect(s.state.sides[0].statuses & SIDE_STATUS_REFLECT).toBe(SIDE_STATUS_REFLECT)
    expect(s.state.sides[0].timers.reflectTimer).toBe(5)

    // Next turn the screen is already up, so rule 1 skips it.
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'support', {}, mem))).toBe('MOVE_BODY_SLAM')
  })
})

describe('cycle 947 - support: weather', () => {
  it('sets Rain Dance when down and skips it while it is up', () => {
    const s = session(playerOne(['MOVE_RAIN_DANCE', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const mem = memory()
    expect(moveId(playTurn(s, 'support', {}, mem))).toBe('MOVE_RAIN_DANCE')
    // TryChangeBattleWeather sets the temporary bit and duration 8
    // (switchInAbility.ts:430-441; WEATHER_DURATION constants.ts:378).
    expect(s.state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(s.state.field.weatherDuration).toBe(8)

    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'support', {}, mem))).toBe('MOVE_BODY_SLAM')
  })

  it('does not re-cast Rain Dance on its last turn even with refresh=yes', () => {
    // The weather handler rejects a re-cast of the weather already active
    // (tryChangeBattleWeather, switchInAbility.ts:427), so refresh cannot help.
    const s = session(playerOne(['MOVE_RAIN_DANCE', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    s.state.field.weather = WEATHER_RAIN_TEMPORARY
    s.state.field.weatherDuration = 1
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'support', { refresh: 'yes' }, memory()))).toBe('MOVE_BODY_SLAM')
  })
})

describe('cycle 947 - support: terrain', () => {
  it('sets Electric Terrain when down and skips it while it is up', () => {
    const s = session(playerOne(['MOVE_ELECTRIC_TERRAIN', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
    ])
    const mem = memory()
    expect(moveId(playTurn(s, 'support', {}, mem))).toBe('MOVE_ELECTRIC_TERRAIN')
    // setFieldTerrain sets the bit and terrainTimer 8 without Terrain Extender
    // (moveEffects.ts:3399-3414; TERRAIN_DURATION constants.ts:382).
    expect(s.state.field.statuses & STATUS_FIELD_ELECTRIC_TERRAIN).toBe(STATUS_FIELD_ELECTRIC_TERRAIN)
    expect(s.state.field.timers.terrainTimer).toBe(8)

    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'support', {}, mem))).toBe('MOVE_BODY_SLAM')
  })
})

describe('cycle 947 - support: Trick Room', () => {
  const trickRoom = (ourSpe: number, theirSpe: number): BattleSession => {
    const s = session(playerOne(['MOVE_TRICK_ROOM', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: ourSpe } })
    patchMon(s.state, 1, 0, { rawStats: { ...s.state.battlers[1]!.mon.rawStats, spe: theirSpe } })
    return s
  }

  it('sets Trick Room when our mon is slower than the target', () => {
    const s = trickRoom(1, 200)
    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    expect(moveId(chooseRoleAction(s, 'support', {}, memory(), trace))).toBe('MOVE_TRICK_ROOM')
    expect(trace[0]!.tags).toEqual(['support', 'trickroom'])
  })

  it('does not cast Trick Room when our mon is faster', () => {
    // Trick Room only helps the slower side; outspeeds reads the predicted
    // action, so a faster support plays its fallback instead.
    const s = trickRoom(200, 1)
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'support', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })

  it('does not re-cast Trick Room while it is up (the handler would toggle it off)', () => {
    // handleRoomMove toggles the flag OFF when it is already up
    // (moveEffects.ts:3461-3475), so the policy must never choose it there.
    const s = trickRoom(1, 200)
    s.state.field.statuses |= STATUS_FIELD_TRICK_ROOM
    s.state.field.timers.trickRoomTimer = 5
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'support', {}, memory()))).toBe('MOVE_BODY_SLAM')
  })
})

describe('cycle 947 - support: refresh', () => {
  const reflectUp = (s: BattleSession, timer: number): void => {
    s.state.sides[0].statuses |= SIDE_STATUS_REFLECT
    s.state.sides[0].timers.reflectTimer = timer
  }

  it('re-sets Reflect on its last turn with Screen Cleaner and refresh=yes', () => {
    // Screen Cleaner makes handleReflect accept the re-cast
    // (moveEffects.ts:2950-2956): the timer is reset to 5.
    const s = session(
      [
        {
          species: 'SPECIES_SNORLAX',
          level: 50,
          ability: 'ABILITY_SCREEN_CLEANER',
          moves: ['MOVE_REFLECT', 'MOVE_BODY_SLAM'],
        },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])],
    )
    reflectUp(s, 1)
    const turn = playTurn(s, 'support', { refresh: 'yes' }, memory())
    expect(moveId(turn)).toBe('MOVE_REFLECT')
    expect(s.state.sides[0].timers.reflectTimer).toBe(5)
    expect(s.state.sides[0].statuses & SIDE_STATUS_REFLECT).toBe(SIDE_STATUS_REFLECT)
  })

  it('with refresh=no leaves the last-turn Reflect to expire', () => {
    const s = session(playerOne(['MOVE_REFLECT', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    reflectUp(s, 1)
    const turn = playTurn(s, 'support', { refresh: 'no' }, memory())
    expect(moveId(turn)).toBe('MOVE_BODY_SLAM')
    // Timer 1 is the last turn, so ENDTURN_REFLECT decrements it to 0 and
    // clears the bit (fieldEndTurn.ts:504-510, battle_util.c:1793-1810).
    expect(s.state.sides[0].timers.reflectTimer).toBe(0)
    expect(s.state.sides[0].statuses & SIDE_STATUS_REFLECT).toBe(0)
  })

  it('does not recast Reflect without Screen Cleaner; the handler would miss', () => {
    // Handle the refresh decision first: no Screen Cleaner means the re-cast is
    // rejected, so the support must NOT pick Reflect.
    const s = session(playerOne(['MOVE_REFLECT', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    reflectUp(s, 1)
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'support', { refresh: 'yes' }, memory()))).toBe('MOVE_BODY_SLAM')

    // Then prove the handler's real outcome by forcing the re-cast: it misses
    // and the timer is not reset to 5 (moveEffects.ts:2952-2954).
    const reflectChoice = legalChoices(s).find((choice) => moveId(choice) === 'MOVE_REFLECT')!
    const result = stepTurn(s, reflectChoice.action)
    const ours = result.outcome.actions.find((action) => action.battlerId === 0)!
    expect(ours.missed).toBe(true)
    expect(s.state.sides[0].timers.reflectTimer).toBe(0)
  })
})

describe('cycle 947 - support: negative cases', () => {
  it('a support with no setter and no pivot plays its fallback when safe', () => {
    const s = session(playerOne(['MOVE_BODY_SLAM', 'MOVE_TOXIC']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    beginTurn(s)
    expect(moveId(chooseRoleAction(s, 'support', {}, memory()))).toBe('MOVE_BODY_SLAM')
    expect(moveId(chooseRoleAction(s, 'support', { fallbackRole: 'staller' }, memory()))).toBe('MOVE_TOXIC')
  })

  it('a Baton Pass holder with no live bench slot does not choose Baton Pass', () => {
    const s = session(playerOne(['MOVE_CALM_MIND', 'MOVE_BATON_PASS', 'MOVE_BODY_SLAM']), [
      mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']),
    ])
    beginTurn(s)
    const choice = chooseRoleAction(s, 'support', {}, memory())
    expect(moveId(choice)).not.toBe('MOVE_BATON_PASS')
    expect(moveId(choice)).toBe('MOVE_BODY_SLAM')
  })

  it('a Baton Pass holder does not boost against an opponent Haze user', () => {
    // PHASE_OUT_EFFECTS reads MOVE_HAZE = EFFECT_HAZE from moves.json, so the
    // bench Snorlax's Haze closes the safe-to-boost gate; the support pivots
    // its (unboosted) Baton Pass out instead.
    const s = session(
      [
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_CALM_MIND', 'MOVE_BATON_PASS', 'MOVE_BODY_SLAM'] },
        { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
      ],
      [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE']), mon('SPECIES_SNORLAX', ['MOVE_HAZE'])],
    )
    beginTurn(s)
    const choice = chooseRoleAction(s, 'support', {}, memory())
    expect(moveId(choice)).not.toBe('MOVE_CALM_MIND')
    expect(moveId(choice)).toBe('MOVE_BATON_PASS')
  })
})

describe('cycle 947 - support: trace', () => {
  it('tags its decision [support, <tag>] like the other roles', () => {
    const s = session(playerOne(['MOVE_REFLECT', 'MOVE_BODY_SLAM']), [mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])])
    const trace: PolicyTraceEntry[] = []
    beginTurn(s)
    chooseRoleAction(s, 'support', {}, memory(), trace)
    expect(trace[0]!.tags.length).toBeGreaterThanOrEqual(2)
    expect(trace[0]!.tags[0]).toBe('support')
    expect(trace[0]!.tags[1]).toBe('screen')
  })
})
