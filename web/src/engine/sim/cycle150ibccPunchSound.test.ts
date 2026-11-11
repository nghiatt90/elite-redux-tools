/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ibcc: PUNCH gets a returning-true sim predicate (isPunchMove), the
// effect-chance read uses it, and Sleep Talk filters sound moves through IsSoundMove.
//
// C at the pinned SHA:
// - DoesMoveMatchFlag (src/abilities.cc:358-386): the move's static flag wins,
//   else any of the USER's onModifyMoveFlags abilities answers TRUE. The wrapper
//   predicates pass their own moveType argument; IsIronFistBoosted/IsSoundMove
//   pass the TYPE_NORMAL dummy (src/battle_util.c:9375, :9379).
// - IsIronFistBoosted's punch grants: Junshi Sanda on FLAG_STRIKER_BOOST
//   (abilities.cc:7613-7622), Mixed Martial Arts on the DECLARED Normal type
//   (:9898-9905), Brawling Wyvern on the RESOLVED Dragon type (:7603-7609,
//   IS_MOVE_TYPE = include/battle.h:743).
// - Precise Fist onModifyEffectChance (abilities.cc:4762-4765): IsIronFistBoosted
//   -> *effectChance *= 5; Way of Precision aliases it (:8475).
// - Corrupted Mind onModifyEffectChance (:9465-9470) reads GET_MOVE_TYPE, the
//   resolved/dynamic type (include/battle.h:735).
// - Cmd_trychoosesleeptalkmove (src/battle_script_commands.c:10898-10915) calls
//   CheckMoveLimitations, whose throat-chop filter is
//   `throatChopTimer && IsSoundMove(battlerId, move)` (src/battle_util.c:1652);
//   IsSoundMove is DoesMoveMatchFlag(..., MOVE_FLAG_SOUND) (:9379), so a grant such
//   as Reverbate on a Normal move (abilities.cc:10657-10662) excludes that move.
//
// Every number is hand-derived from the C and data/v2.65beta. The punch unit tests
// use the scaffolding's fixed RNG value 1; the Sleep Talk tests use a scripted
// sequence because a fixed 1 (`1 & 3` = slot 1) cannot exercise an excluded slot --
// the do-while at battle_script_commands.c:10916-10924 would spin forever.
import { describe, expect, it } from 'vitest'

import { DEFAULT_STAT_STAGE, STAT_ATK, STAT_DEF, STATUS1_SLEEP, setCounter } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import type { RandomSource } from './state'
import {
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_PARALYSIS,
  getMoveEffectChance,
  isPunchMove,
  type StatusDeps,
} from './statusEffects'

const data = loadSimData()

function fixedRng(value: number): RandomSource {
  return { random16: () => value }
}

/** A draw sequence for the Sleep Talk selection do-while (battle_script_commands.c:10916-10924). */
function scriptedRng(values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

function foeMon(species: string, ability: string, moves: string[]): TrainerMonData {
  return {
    species,
    item: 'ITEM_NONE',
    nature: 'NATURE_HARDY',
    ability,
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    moves,
    ironPill: false,
    hiddenPowerType: 'TYPE_NORMAL',
  }
}

function trainer(mons: TrainerMonData[]): TrainerData {
  return {
    ...data.trainersById.get('TRAINER_SAWYER_1')!,
    noSwitching: true,
    parties: { ace: mons, elite: mons, hell: mons },
  }
}

interface PlayerSpec {
  species: string
  ability: string | null
  item?: string | null
  moves: string[]
  /** Extra innate slots (after the chosen ability); the ability grant cases need one. */
  innates?: [string | null, string | null, string | null]
}

/** Builds the player at level 50 and the foe at the same level (the driver derives
 * the opponent level from the player's highest level). Player innates are cleared
 * unless the scenario supplies them, so no unrelated onEntry innate perturbs the
 * ability scans. */
function session(player: PlayerSpec, foe: TrainerMonData, rng: RandomSource = fixedRng(1)): BattleSession {
  const party = buildPlayerParty(
    [{ species: player.species, level: 50, item: player.item ?? null, moves: player.moves }],
    50,
    data,
  )
  party[0]!.abilities = { ability: player.ability, innates: player.innates ?? [null, null, null] }
  return createSession({ data, playerParty: party, opponentTrainer: trainer([foe]), rng })
}

function statusDeps(s: BattleSession): StatusDeps {
  return { dataContext: data.dataContext, grounding: s.turnDeps.grounding }
}

// ---------------------------------------------------------------------------
// Item A: isPunchMove answers DoesMoveMatchFlag(battler, move, TYPE_NORMAL,
// MOVE_FLAG_PUNCH) (src/battle_util.c:9375).
// ---------------------------------------------------------------------------

describe('cycle 150ibcc (A) - isPunchMove follows DoesMoveMatchFlag(MOVE_FLAG_PUNCH)', () => {
  const caseSession = (ability: string | null, moves: string[]): BattleSession =>
    session({ species: 'SPECIES_MUDKIP', ability, moves }, foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']))

  it('a static punchBased move is a punch with no ability at all', () => {
    // Fire Punch carries FLAG_IRON_FIST_BOOST (moves.json flags.punchBased), so
    // DoesMoveMatchFlag returns TRUE before the ability scan (abilities.cc:371).
    const s = caseSession('ABILITY_NONE', ['MOVE_FIRE_PUNCH'])
    expect(isPunchMove(s.state, 0, 'MOVE_FIRE_PUNCH', statusDeps(s))).toBe(true)
  })

  it('Junshi Sanda grants PUNCH to a kickBased move (abilities.cc:7613-7622)', () => {
    // Low Kick is kickBased and has no punchBased flag; its PUNCH grant is
    // `gBattleMoves[move].flags & FLAG_STRIKER_BOOST`.
    const withSan = caseSession('ABILITY_JUNSHI_SANDA', ['MOVE_LOW_KICK'])
    expect(isPunchMove(withSan.state, 0, 'MOVE_LOW_KICK', statusDeps(withSan))).toBe(true)
    const without = caseSession('ABILITY_NONE', ['MOVE_LOW_KICK'])
    expect(isPunchMove(without.state, 0, 'MOVE_LOW_KICK', statusDeps(without))).toBe(false)
  })

  it('Mixed Martial Arts grants PUNCH to a declared-NORMAL move (abilities.cc:9898-9905)', () => {
    // gBattleMoves[move].type == TYPE_NORMAL is the DECLARED type, so Tackle counts
    // and a Fire move does not.
    const s = caseSession('ABILITY_MIXED_MARTIAL_ARTS', ['MOVE_TACKLE'])
    expect(isPunchMove(s.state, 0, 'MOVE_TACKLE', statusDeps(s))).toBe(true)
    expect(isPunchMove(s.state, 0, 'MOVE_EMBER', statusDeps(s))).toBe(false)
  })

  it('Brawling Wyvern grants PUNCH to a RESOLVED Dragon move (abilities.cc:7603-7609)', () => {
    // IS_MOVE_TYPE (include/battle.h:743) is the dynamic type; Dragon Claw is a
    // non-punch Dragon move and Ember is not Dragon.
    const s = caseSession('ABILITY_BRAWLING_WYVERN', ['MOVE_DRAGON_CLAW'])
    expect(isPunchMove(s.state, 0, 'MOVE_DRAGON_CLAW', statusDeps(s))).toBe(true)
    expect(isPunchMove(s.state, 0, 'MOVE_EMBER', statusDeps(s))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Item A2: GetMoveEffectChance (src/battle_script_commands.c:3071-3090) resolves
// the punch/psychic reads through the predicate and GET_MOVE_TYPE.
// ---------------------------------------------------------------------------

describe('cycle 150ibcc (A2) - Precise Fist and Corrupted Mind in getMoveEffectChance', () => {
  const chanceSession = (ability: string | null, moves: string[], innates?: PlayerSpec['innates']): BattleSession =>
    session({ species: 'SPECIES_MUDKIP', ability, moves, innates }, foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']))

  it('Precise Fist multiplies a punch move by 5 (abilities.cc:4762-4765)', () => {
    const s = chanceSession('ABILITY_PRECISE_FIST', ['MOVE_FIRE_PUNCH'])
    expect(getMoveEffectChance(s.state, 0, 'MOVE_FIRE_PUNCH', MOVE_EFFECT_BURN, 10, statusDeps(s))).toBe(50)
  })

  it('negative: a non-punch move is unchanged', () => {
    const s = chanceSession('ABILITY_PRECISE_FIST', ['MOVE_EMBER'])
    expect(getMoveEffectChance(s.state, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 10, statusDeps(s))).toBe(10)
  })

  it('Way of Precision aliases the same hook (abilities.cc:8475)', () => {
    const s = chanceSession('ABILITY_WAY_OF_PRECISION', ['MOVE_FIRE_PUNCH'])
    expect(getMoveEffectChance(s.state, 0, 'MOVE_FIRE_PUNCH', MOVE_EFFECT_BURN, 10, statusDeps(s))).toBe(50)
    expect(getMoveEffectChance(s.state, 0, 'MOVE_EMBER', MOVE_EFFECT_BURN, 10, statusDeps(s))).toBe(10)
  })

  it('a Mixed Martial Arts innate makes a declared-Normal non-punch move a punch for Precise Fist', () => {
    // Body Slam is NORMAL with a 30% paralysis chance and no punchBased flag. Mixed
    // Martial Arts grants PUNCH to declared-Normal moves (abilities.cc:9898-9905), so
    // IsIronFistBoosted is TRUE and Precise Fist applies `* 5`: 30 -> 150 -> cap 100.
    const s = chanceSession('ABILITY_PRECISE_FIST', ['MOVE_BODY_SLAM'], ['ABILITY_MIXED_MARTIAL_ARTS', null, null])
    expect(getMoveEffectChance(s.state, 0, 'MOVE_BODY_SLAM', MOVE_EFFECT_PARALYSIS, 30, statusDeps(s))).toBe(100)
  })

  it('negative: without the grant the same Body Slam stays at 30', () => {
    const s = chanceSession('ABILITY_PRECISE_FIST', ['MOVE_BODY_SLAM'])
    expect(getMoveEffectChance(s.state, 0, 'MOVE_BODY_SLAM', MOVE_EFFECT_PARALYSIS, 30, statusDeps(s))).toBe(30)
  })

  it('Corrupted Mind reads the RESOLVED type: Emanate retypes Body Slam to Psychic (1.4x)', () => {
    // GET_MOVE_TYPE (abilities.cc:9468) is the dynamic type (include/battle.h:735).
    // Emanate is the Normal->Psychic "-ate" ability, so floor(30 * 1.4) = 42.
    const notes: string[] = []
    const s = chanceSession('ABILITY_CORRUPTED_MIND', ['MOVE_BODY_SLAM'], ['ABILITY_EMANATE', null, null])
    expect(getMoveEffectChance(s.state, 0, 'MOVE_BODY_SLAM', MOVE_EFFECT_PARALYSIS, 30, statusDeps(s), notes)).toBe(42)
    expect(notes).toEqual([])

    // Without the retype the declared Normal type leaves the chance alone.
    const plain = chanceSession('ABILITY_CORRUPTED_MIND', ['MOVE_BODY_SLAM'])
    expect(getMoveEffectChance(plain.state, 0, 'MOVE_BODY_SLAM', MOVE_EFFECT_PARALYSIS, 30, statusDeps(plain))).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// Item B: Sleep Talk's CheckMoveLimitations filter reads IsSoundMove
// (src/battle_util.c:1652), not the static sound flag.
// ---------------------------------------------------------------------------

describe('cycle 150ibcc (B) - Sleep Talk excludes sound moves through IsSoundMove', () => {
  function sleepTalkSession(ability: string | null, moves: string[], rng: RandomSource): BattleSession {
    const s = session({ species: 'SPECIES_MUDKIP', ability, moves }, foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']), rng)
    // STATUS1_SLEEP with a 3-turn counter: attackcanceler decrements it but the user
    // stays asleep for this turn, so Sleep Talk runs.
    s.state.battlers[0]!.mon.status1 = setCounter(0, STATUS1_SLEEP, 3)
    // Battle_EffectThroatChop sets 2 (src/battle_script_commands.c:2932); set the
    // field directly as there is no Throat Chop scenario in this scaffolding.
    s.state.battlers[0]!.volatiles.throatChopTimer = 2
    return s
  }

  function runSleepTalk(s: BattleSession) {
    return stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_SLEEP_TALK'), null)
  }

  it('a static sound move (Growl) is never picked: draw 0 is rejected, draw 1 calls Tackle', () => {
    // Slots: 0 Growl (static flags.sound), 1 Tackle, 2 Sleep Talk (sleepTalkBanned).
    // First selection draw 0 -> slot 0 excluded by throat chop; second draw 1 -> Tackle.
    const s = sleepTalkSession(null, ['MOVE_GROWL', 'MOVE_TACKLE', 'MOVE_SLEEP_TALK'], scriptedRng([0, 1, 0]))
    const foe = s.state.battlers[1]!
    const maxHp = foe.mon.maxHp

    runSleepTalk(s)

    expect(foe.mon.hp).toBeLessThan(maxHp) // Tackle was called
    expect(foe.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE) // Growl was not
  })

  it('grant case: Festivities makes a dance move a sound move, so it is excluded', () => {
    // Swords Dance is a dance move with no static sound flag. Festivities grants
    // SOUND to dance moves (abilities.cc:10194-10203), so CheckMoveLimitations
    // excludes it (battle_util.c:1652) and draw 1 calls Ember instead. If the filter
    // read only the static flag, Swords Dance would be selected and
    // CANCELLER_THROAT_CHOP would cancel it (attackCanceller.ts), leaving the target
    // at full HP. Reverbate/Musical Notes cannot be used for this turn-level check:
    // both make Sleep Talk itself sound (Normal / STATUS), so the chosen Sleep Talk
    // is cancelled before the selection runs (battle_util.c:3481-3490).
    const s = sleepTalkSession('ABILITY_FESTIVITIES', ['MOVE_SWORDS_DANCE', 'MOVE_EMBER', 'MOVE_SLEEP_TALK'], scriptedRng([0, 1, 0]))
    const foe = s.state.battlers[1]!
    const maxHp = foe.mon.maxHp

    runSleepTalk(s)

    expect(foe.mon.hp).toBeLessThan(maxHp) // Ember, not a cancelled Swords Dance
    expect(s.state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE) // Swords Dance never applied
  })

  it('negative: without Reverbate the same Normal move stays selectable under throat chop', () => {
    // No grant, so IsSoundMove is FALSE for Tail Whip and the filter leaves it
    // usable. Draw 0 selects it: Defense falls by one and the target takes no damage.
    const s = sleepTalkSession(null, ['MOVE_TAIL_WHIP', 'MOVE_EMBER', 'MOVE_SLEEP_TALK'], scriptedRng([0, 0]))
    const foe = s.state.battlers[1]!
    const maxHp = foe.mon.maxHp

    runSleepTalk(s)

    expect(foe.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1) // Tail Whip applied
    expect(foe.mon.hp).toBe(maxHp) // Ember was not called
  })
})
