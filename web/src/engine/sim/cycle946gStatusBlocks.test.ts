/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 946g: ability immunity, Prankster and absorb blocks on handler-dispatched status moves.
// Covers:
//  1. Prankster Thunder Wave into Dark target (status1 0, PP drops 1; non-Prankster paralyses; Mold Breaker does not bypass).
//  2. Prankster Toxic into Dark target with Magic Bounce (bounced, not Dark-blocked).
//  3. Good As Gold blocks Will-O-Wisp; Mold Breaker lands it; Gastro-Acid-suppressed Good As Gold lands it.
//  4. Soundproof blocks sound status move but not holder's self-target sound move (Howl); Bulletproof (Tar Shot); Dazzling blocks Prankster Thunder Wave.
//  5. Radiance on target blocks Dark status move (Fake Tears); Radiance on user or foe blocks user's own Dark status move (Hone Claws).
//  6. Volt Absorb (Thunder Wave heals floor(maxHp/4)), Lightning Rod (+1 higher attack stat), Motor Drive (+1 Speed), Flash Fire (sets volatiles.flashFire, no burn), Mold Breaker Thunder Wave into Volt Absorb paralyses without heal, missed Thunder Wave into Volt Absorb does not heal.
//  7. Magic Bounced status move into original user with Good As Gold: no status on either side.
//  8. Policy: staller does not pick Thunder Wave (Dark target with Prankster; Volt Absorb), Will-O-Wisp (Flash Fire), Leech Seed or Ghost Curse (Good As Gold); does pick them with Mold Breaker or non-Prankster user where sim lets them land.

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STAT_STAGE,
  PARTY_SIZE,
  STAT_ATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_POISON_ANY,
  STATUS3_GASTRO_ACID,
  STATUS_FIELD_ION_DELUGE,
  WEATHER_SANDSTORM_TEMPORARY,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import type { PlayerChoice } from './driver/expectimax'
import { legalChoices } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import type { PolicyTraceEntry } from './driver/policyBattle'
import type { RoleMemory } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { beginTurn, buildMoveAction, createSession, stepTurn } from './driver/session'
import { createTeamLayer } from './driver/teamLayer'
import type { BattleState, RandomSource } from './state'
import { createRandomSource } from './rng'

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
  rng: RandomSource = createRandomSource(1),
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons, overrides),
    rng,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      if (idx < values.length) return values[idx++]!
      return 0
    },
  }
  return r
}

const memory = (): RoleMemory => ({ turn: 0, lastMove: null })

const moveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

function forceMove(s: BattleSession, id: string): void {
  beginTurn(s)
  const choice = legalChoices(s).find((c) => moveId(c) === id)
  expect(choice, `${id} must be a legal choice`).toBeDefined()
  s.state.battlers[0]!.monToSwitchIntoId = PARTY_SIZE
  stepTurn(s, choice!.action)
}

const playerOne = (moves: string[], ability?: string, species = 'SPECIES_SNORLAX'): PlayerMonSpec[] => [
  { species, level: 50, moves, ...(ability ? { ability } : {}) },
]

const idle = (species: string, moves: string[], overrides: Partial<TrainerMonData> = {}): TrainerMonData =>
  mon(species, moves, overrides)

const IDLE_MOVES = ['MOVE_CELEBRATE']

/** Writes a patch on both copies of a party slot (the active battler's mon and
 * the party mon), the shape a fixture needs for HP/stat overrides. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

describe('cycle 946g - Status Move Ability Immunity and Prankster Block', () => {
  // Case 1: Prankster Thunder Wave into Dark target
  it('Prankster Thunder Wave into Dark target: status1 0, PP drops by 1. Non-Prankster paralyses. Mold Breaker does NOT bypass Prankster.', () => {
    // Snorlax with Prankster into Umbreon (Dark)
    const s1 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_PRANKSTER'), [
      idle('SPECIES_UMBREON', IDLE_MOVES),
    ])
    const initialPp = s1.state.battlers[0]!.mon.pp[0]!
    forceMove(s1, 'MOVE_THUNDER_WAVE')
    expect(s1.state.battlers[1]!.mon.status1).toBe(0)
    expect(s1.state.battlers[0]!.mon.pp[0]).toBe(initialPp - 1)

    // Negative: Non-Prankster user (Guts) paralyses
    const s2 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'), [
      idle('SPECIES_UMBREON', IDLE_MOVES),
    ])
    forceMove(s2, 'MOVE_THUNDER_WAVE')
    expect((s2.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS) !== 0).toBe(true)

    // Mold Breaker does NOT bypass Prankster (BATTLER_HAS_ABILITY checkMoldBreaker=FALSE in BlocksPrankster)
    const s3 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_PRANKSTER'), [
      idle('SPECIES_UMBREON', IDLE_MOVES),
    ])
    // Give user both Prankster and Mold Breaker innate
    s3.state.battlers[0]!.mon.abilities = {
      ability: 'ABILITY_PRANKSTER',
      innates: ['ABILITY_MOLD_BREAKER', null, null],
    }
    forceMove(s3, 'MOVE_THUNDER_WAVE')
    expect(s3.state.battlers[1]!.mon.status1).toBe(0)
  })

  // Case 2: Prankster Toxic into Dark target with Magic Bounce
  it('Prankster Toxic into a Dark target that has Magic Bounce: bounced, not Dark-blocked', () => {
    const s = session(playerOne(['MOVE_TOXIC', 'MOVE_BODY_SLAM'], 'ABILITY_PRANKSTER'), [
      idle('SPECIES_UMBREON', IDLE_MOVES, { ability: 'ABILITY_MAGIC_BOUNCE' }),
    ])
    forceMove(s, 'MOVE_TOXIC')
    // Target is unaffected; bounced Toxic poisons the attacker
    expect(s.state.battlers[1]!.mon.status1).toBe(0)
    expect((s.state.battlers[0]!.mon.status1 & STATUS1_POISON_ANY) !== 0).toBe(true)
  })

  // Case 3: Good As Gold blocks Will-O-Wisp; Mold Breaker lands it; Gastro Acid suppresses it
  it('Good As Gold blocks Will-O-Wisp; Mold Breaker user lands it; Gastro-Acid-suppressed Good As Gold does not block', () => {
    // Good As Gold blocks Will-O-Wisp (control: non-Mold-Breaker user does not burn)
    const s1 = session(playerOne(['MOVE_WILL_O_WISP', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_GOOD_AS_GOLD' }),
    ])
    forceMove(s1, 'MOVE_WILL_O_WISP')
    expect(s1.state.battlers[1]!.mon.status1).toBe(0)

    // Mold Breaker user lands Will-O-Wisp (scripted hit with roll 0)
    const s2 = session(playerOne(['MOVE_WILL_O_WISP', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_GOOD_AS_GOLD' }),
    ], {}, scriptedRng([0]))
    forceMove(s2, 'MOVE_WILL_O_WISP')
    expect((s2.state.battlers[1]!.mon.status1 & STATUS1_BURN) !== 0).toBe(true)

    // Mold Breaker Gastro Acid suppresses Good As Gold, then Will-O-Wisp lands even with non-Mold-Breaker user
    // Note: in Elite Redux, Gastro Acid also applies Poison on hit. We clear status1 so Will-O-Wisp can inflict Burn.
    const s3 = session(playerOne(['MOVE_GASTRO_ACID', 'MOVE_WILL_O_WISP', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'), [
      idle('SPECIES_MACHAMP', IDLE_MOVES, { ability: 'ABILITY_GOOD_AS_GOLD' }),
    ], {}, scriptedRng([0, 0]))
    forceMove(s3, 'MOVE_GASTRO_ACID')
    expect((s3.state.battlers[1]!.statuses3 & STATUS3_GASTRO_ACID) !== 0).toBe(true)
    patchMon(s3.state, 1, 0, { status1: 0 })
    s3.state.battlers[0]!.mon.abilities = {
      ability: 'ABILITY_GUTS',
      innates: [null, null, null],
    }
    forceMove(s3, 'MOVE_WILL_O_WISP')
    expect((s3.state.battlers[1]!.mon.status1 & STATUS1_BURN) !== 0).toBe(true)
  })

  // Case 4: Soundproof blocks sound status move but not holder's self-target sound move; Bulletproof / Dazzling
  it('Soundproof blocks sound move but not self-target Howl; Bulletproof and Dazzling block status moves', () => {
    // Soundproof blocks Growl (sound status move)
    const s1 = session(playerOne(['MOVE_GROWL', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_SOUNDPROOF' }),
    ])
    const initialAtkStage = s1.state.battlers[1]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
    forceMove(s1, 'MOVE_GROWL')
    expect(s1.state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(initialAtkStage)

    // Holder's own self-target sound move (Howl) is not blocked
    const s2 = session(playerOne(['MOVE_BODY_SLAM']), [
      idle('SPECIES_SNORLAX', ['MOVE_HOWL'], { ability: 'ABILITY_SOUNDPROOF' }),
    ])
    beginTurn(s2)
    stepTurn(s2, null, buildMoveAction(s2.state, data, 1, 'MOVE_HOWL'))
    expect(s2.state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(initialAtkStage + 1)

    // Bulletproof blocks Tar Shot (ballistic status move)
    const s3 = session(playerOne(['MOVE_TAR_SHOT', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_BULLETPROOF' }),
    ])
    const initialSpeStage = s3.state.battlers[1]!.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
    forceMove(s3, 'MOVE_TAR_SHOT')
    expect(s3.state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(initialSpeStage)

    // Dazzling blocks Prankster Thunder Wave (priority > 0)
    const s4 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_PRANKSTER'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_DAZZLING' }),
    ])
    forceMove(s4, 'MOVE_THUNDER_WAVE')
    expect(s4.state.battlers[1]!.mon.status1).toBe(0)
  })

  // Case 5: Radiance on target blocks Dark status move; Radiance on user or foe blocks user's own Dark status move (Hone Claws)
  it('Radiance on target blocks Dark status move; Radiance blocks user own Dark status move (Hone Claws)', () => {
    // Radiance on target blocks Fake Tears (Dark status move)
    const s1 = session(playerOne(['MOVE_FAKE_TEARS', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_RADIANCE' }),
    ])
    const initialSpDefStage = s1.state.battlers[1]!.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE
    forceMove(s1, 'MOVE_FAKE_TEARS')
    expect(s1.state.battlers[1]!.mon.statStages[STAT_SPDEF]).toBe(initialSpDefStage)

    // Radiance on user blocks user's own Hone Claws (Dark status move)
    const s2 = session(playerOne(['MOVE_HONE_CLAWS', 'MOVE_BODY_SLAM'], 'ABILITY_RADIANCE'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES),
    ])
    const initialAtkStage = s2.state.battlers[0]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
    forceMove(s2, 'MOVE_HONE_CLAWS')
    expect(s2.state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(initialAtkStage)

    // Negative case: no Radiance on either side, Hone Claws gives Attack stage +1
    const s3 = session(playerOne(['MOVE_HONE_CLAWS', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_SNORLAX', IDLE_MOVES),
    ])
    forceMove(s3, 'MOVE_HONE_CLAWS')
    expect(s3.state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(initialAtkStage + 1)

    // Radiance on the FOE only: user's Hone Claws leaves Attack unchanged
    const s4 = session(playerOne(['MOVE_HONE_CLAWS', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_RADIANCE' }),
    ])
    forceMove(s4, 'MOVE_HONE_CLAWS')
    expect(s4.state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(initialAtkStage)

    // Mold Breaker user with Radiance foe: Hone Claws gives Attack stage +1
    const s5 = session(playerOne(['MOVE_HONE_CLAWS', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_RADIANCE' }),
    ])
    forceMove(s5, 'MOVE_HONE_CLAWS')
    expect(s5.state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(initialAtkStage + 1)
  })

  // Case 6: Volt Absorb, Lightning Rod, Motor Drive, Flash Fire, Mold Breaker bypass, and Missed Thunder Wave
  it('Absorb abilities on status moves: Volt Absorb, Lightning Rod, Motor Drive, Flash Fire, Mold Breaker bypass, missed no-heal', () => {
    // Volt Absorb heals floor(maxHp/4) on Thunder Wave
    const s1 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_RATICATE', IDLE_MOVES, { ability: 'ABILITY_VOLT_ABSORB' }),
    ], {}, scriptedRng([0]))
    const maxHp = s1.state.battlers[1]!.mon.maxHp
    const damagedHp = Math.floor(maxHp / 2)
    patchMon(s1.state, 1, 0, { hp: damagedHp })
    forceMove(s1, 'MOVE_THUNDER_WAVE')
    expect(s1.state.battlers[1]!.mon.status1).toBe(0)
    expect(s1.state.battlers[1]!.mon.hp).toBe(damagedHp + Math.floor(maxHp / 4))

    // Lightning Rod gives +1 to higher attacking stat
    const s2 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_RATICATE', IDLE_MOVES, { ability: 'ABILITY_LIGHTNING_ROD' }),
    ], {}, scriptedRng([0]))
    // Raticate raw stats: Atk > SpAtk
    const initialAtk = s2.state.battlers[1]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
    forceMove(s2, 'MOVE_THUNDER_WAVE')
    expect(s2.state.battlers[1]!.mon.status1).toBe(0)
    expect(s2.state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(initialAtk + 1)

    // Motor Drive gives +1 Speed
    const s3 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_RATICATE', IDLE_MOVES, { ability: 'ABILITY_MOTOR_DRIVE' }),
    ], {}, scriptedRng([0]))
    const initialSpe = s3.state.battlers[1]!.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
    forceMove(s3, 'MOVE_THUNDER_WAVE')
    expect(s3.state.battlers[1]!.mon.status1).toBe(0)
    expect(s3.state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(initialSpe + 1)

    // Flash Fire sets volatiles.flashFire on Will-O-Wisp, no burn
    const s4 = session(playerOne(['MOVE_WILL_O_WISP', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_RATICATE', IDLE_MOVES, { ability: 'ABILITY_FLASH_FIRE' }),
    ], {}, scriptedRng([0]))
    forceMove(s4, 'MOVE_WILL_O_WISP')
    expect(s4.state.battlers[1]!.mon.status1).toBe(0)
    expect(s4.state.battlers[1]!.volatiles.flashFire).toBe(true)

    // Mold Breaker Thunder Wave into Volt Absorb paralyses with no heal
    const s5 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'), [
      idle('SPECIES_RATICATE', IDLE_MOVES, { ability: 'ABILITY_VOLT_ABSORB' }),
    ], {}, scriptedRng([0]))
    patchMon(s5.state, 1, 0, { hp: damagedHp })
    forceMove(s5, 'MOVE_THUNDER_WAVE')
    expect((s5.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS) !== 0).toBe(true)
    expect(s5.state.battlers[1]!.mon.hp).toBe(damagedHp)

    // A MISSED Thunder Wave into Volt Absorb does not heal (accuracy roll 99 misses Thunder Wave's 90% accuracy)
    const missRng = scriptedRng([99, 99, 99, 99, 99])
    const s6 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM']), [
      idle('SPECIES_RATICATE', IDLE_MOVES, { ability: 'ABILITY_VOLT_ABSORB' }),
    ], {}, missRng)
    patchMon(s6.state, 1, 0, { hp: damagedHp })
    forceMove(s6, 'MOVE_THUNDER_WAVE')
    expect(s6.state.battlers[1]!.mon.status1).toBe(0)
    expect(s6.state.battlers[1]!.mon.hp).toBe(damagedHp)

    // User with Mold Breaker and Volt Absorb using Ion Deluge (Electric status move) heals and is not suppressed by own Mold Breaker
    expect(data.dataContext.move('MOVE_ION_DELUGE')?.type).toBe('ELECTRIC')
    const s7 = session(playerOne(['MOVE_ION_DELUGE', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'), [
      idle('SPECIES_RATICATE', IDLE_MOVES),
    ])
    s7.state.battlers[0]!.mon.abilities = {
      ability: 'ABILITY_MOLD_BREAKER',
      innates: ['ABILITY_VOLT_ABSORB', null, null],
    }
    const maxHp7 = s7.state.battlers[0]!.mon.maxHp
    const damagedHp7 = Math.floor(maxHp7 / 2)
    patchMon(s7.state, 0, 0, { hp: damagedHp7 })
    forceMove(s7, 'MOVE_ION_DELUGE')
    expect(s7.state.battlers[0]!.mon.hp).toBe(damagedHp7 + Math.floor(maxHp7 / 4))
    expect((s7.state.field.statuses & STATUS_FIELD_ION_DELUGE) !== 0).toBe(false)
  })

  // Case 7: Magic Bounced status move into original user with Good As Gold
  it('Magic Bounced status move into an original user with Good As Gold: no status on either side', () => {
    const s = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_GOOD_AS_GOLD'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_MAGIC_BOUNCE' }),
    ])
    forceMove(s, 'MOVE_THUNDER_WAVE')
    expect(s.state.battlers[0]!.mon.status1).toBe(0)
    expect(s.state.battlers[1]!.mon.status1).toBe(0)
  })

  // Case 8: Role policy gates
  it('Policy: staller does not pick blocked status moves, picks them when unblocked', () => {
    // 1. Prankster staller vs Dark target does not pick Thunder Wave; non-Prankster does pick it
    const s1 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_PRANKSTER'), [
      idle('SPECIES_UMBREON', IDLE_MOVES),
    ])
    beginTurn(s1)
    expect(moveId(chooseRoleAction(s1, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    const s1Neg = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'), [
      idle('SPECIES_UMBREON', IDLE_MOVES),
    ])
    beginTurn(s1Neg)
    expect(moveId(chooseRoleAction(s1Neg, 'staller', {}, memory()))).toBe('MOVE_THUNDER_WAVE')

    // 2. Staller vs Volt Absorb does not pick Thunder Wave; Mold Breaker does pick it
    const s2 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_VOLT_ABSORB' }),
    ])
    beginTurn(s2)
    expect(moveId(chooseRoleAction(s2, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    const s2Neg = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_VOLT_ABSORB' }),
    ])
    beginTurn(s2Neg)
    expect(moveId(chooseRoleAction(s2Neg, 'staller', {}, memory()))).toBe('MOVE_THUNDER_WAVE')

    // 3. Staller vs Flash Fire does not pick Will-O-Wisp; Mold Breaker does pick it
    const s3 = session(playerOne(['MOVE_WILL_O_WISP', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_FLASH_FIRE' }),
    ])
    beginTurn(s3)
    expect(moveId(chooseRoleAction(s3, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    const s3Neg = session(playerOne(['MOVE_WILL_O_WISP', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_FLASH_FIRE' }),
    ])
    beginTurn(s3Neg)
    expect(moveId(chooseRoleAction(s3Neg, 'staller', {}, memory()))).toBe('MOVE_WILL_O_WISP')

    // 4. Staller vs Good As Gold does not pick Leech Seed; Mold Breaker does pick it
    const s4 = session(playerOne(['MOVE_LEECH_SEED', 'MOVE_BODY_SLAM'], 'ABILITY_GUTS'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_GOOD_AS_GOLD' }),
    ])
    beginTurn(s4)
    expect(moveId(chooseRoleAction(s4, 'staller', {}, memory()))).toBe('MOVE_BODY_SLAM')

    const s4Neg = session(playerOne(['MOVE_LEECH_SEED', 'MOVE_BODY_SLAM'], 'ABILITY_MOLD_BREAKER'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_GOOD_AS_GOLD' }),
    ])
    beginTurn(s4Neg)
    expect(moveId(chooseRoleAction(s4Neg, 'staller', {}, memory()))).toBe('MOVE_LEECH_SEED')

    // 5. Ghost Curse user vs Good As Gold does not pick Curse; negative case without Good As Gold picks it
    const s5 = session(playerOne(['MOVE_CURSE', 'MOVE_ICE_BEAM'], 'ABILITY_GUTS', 'SPECIES_DUSCLOPS'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_GOOD_AS_GOLD' }),
    ])
    beginTurn(s5)
    expect(moveId(chooseRoleAction(s5, 'staller', {}, memory()))).toBe('MOVE_ICE_BEAM')

    const s5Neg = session(playerOne(['MOVE_CURSE', 'MOVE_ICE_BEAM'], 'ABILITY_GUTS', 'SPECIES_DUSCLOPS'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_GUTS' }),
    ])
    beginTurn(s5Neg)
    expect(moveId(chooseRoleAction(s5Neg, 'staller', {}, memory()))).toBe('MOVE_CURSE')
  })

  // Case 9: Weather-dependent ability immunity (Sand Guard) and weather suppression (Cloud Nine)
  it('Sand Guard blocks Prankster Thunder Wave in sandstorm; Cloud Nine suppresses weather and allows paralysis', () => {
    // Sand Guard in sandstorm blocks priority move (Prankster Thunder Wave)
    const s1 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_PRANKSTER'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_SAND_GUARD' }),
    ])
    s1.state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    forceMove(s1, 'MOVE_THUNDER_WAVE')
    expect(s1.state.battlers[1]!.mon.status1).toBe(0)

    // With Cloud Nine on the field, weather has no effect, so Sand Guard does not block and Thunder Wave paralyses
    const s2 = session(playerOne(['MOVE_THUNDER_WAVE', 'MOVE_BODY_SLAM'], 'ABILITY_PRANKSTER'), [
      idle('SPECIES_SNORLAX', IDLE_MOVES, { ability: 'ABILITY_SAND_GUARD' }),
    ], {}, scriptedRng([0]))
    s2.state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    s2.state.battlers[0]!.mon.abilities = {
      ability: 'ABILITY_PRANKSTER',
      innates: ['ABILITY_CLOUD_NINE', null, null],
    }
    forceMove(s2, 'MOVE_THUNDER_WAVE')
    expect((s2.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS) !== 0).toBe(true)
  })

  // Case 10: teamLayer statusLandsOnUs checks blocksStatusMove before Gastro Acid suppression
  it('teamLayer: Good As Gold blocks Gastro Acid so ppLoop incoming evaluates as safe', () => {
    const layer = createTeamLayer({
      roles: ['attacker', 'attacker'],
      genes: {
        purposeFlags: {
          preserve: false,
          sacrifice: false,
          counter: false,
          doubleSwitch: false,
          entryAbility: false,
          support: false,
          ppLoop: true,
        },
      },
    })

    // Both our active and bench Dusclops have Good As Gold. Foe has Gastro Acid and Tackle (0 dmg to Ghost).
    // Because Good As Gold blocks Gastro Acid, statusLandsOnUs returns false, and ppLoop fires.
    const s = session(
      [
        { species: 'SPECIES_DUSCLOPS', level: 50, moves: ['MOVE_SHADOW_BALL'], ability: 'ABILITY_GOOD_AS_GOLD' },
        { species: 'SPECIES_DUSCLOPS', level: 50, moves: ['MOVE_SHADOW_BALL'], ability: 'ABILITY_GOOD_AS_GOLD' },
      ],
      [idle('SPECIES_SNORLAX', ['MOVE_GASTRO_ACID', 'MOVE_TACKLE'])],
    )
    beginTurn(s)
    const trace: PolicyTraceEntry[] = []
    const choice = layer.policy(s, 1, trace)
    expect(trace[0]!.tags).toEqual(['team', 'ppLoop'])
    expect(choice!.action.action).toBe('SWITCH')

    // Control: without Good As Gold (e.g. Guts), Gastro Acid lands on us, so ppLoopIncoming returns null and ppLoop does not fire.
    const sGuts = session(
      [
        { species: 'SPECIES_DUSCLOPS', level: 50, moves: ['MOVE_SHADOW_BALL'], ability: 'ABILITY_GUTS' },
        { species: 'SPECIES_DUSCLOPS', level: 50, moves: ['MOVE_SHADOW_BALL'], ability: 'ABILITY_GOOD_AS_GOLD' },
      ],
      [idle('SPECIES_SNORLAX', ['MOVE_GASTRO_ACID', 'MOVE_TACKLE'])],
    )
    beginTurn(sGuts)
    const traceGuts: PolicyTraceEntry[] = []
    const choiceGuts = layer.policy(sGuts, 1, traceGuts)
    expect(traceGuts[0]!.tags).not.toEqual(['team', 'ppLoop'])
    expect(choiceGuts!.action.action).toBe('USE_MOVE')
  })
})
