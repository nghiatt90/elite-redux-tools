/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ibbd: the remaining sim-side move-flag consumers go through the
// DoesMoveMatchFlag predicates instead of the static moves.json bits.
//
// C at the pinned SHA:
// - DoesMoveMatchFlag (src/abilities.cc:358-388): the move's static flag wins,
//   else any of the BATTLER's onModifyMoveFlags abilities answers TRUE. The
//   wrapper predicates each pass their own `moveType` argument:
//   IsMegaLauncherBoosted/IsSoundMove/IsStrikerBoosted/IsIronFistBoosted pass
//   TYPE_NORMAL (src/battle_util.c:9373-9379), IsKeenEdge passes the real type
//   (:9381).
// - Heal Pulse, Cmd_tryhealpulse (src/battle_script_commands.c:7261-7280):
//   `IsMegaLauncherBoosted(gBattlerAttacker, gCurrentMove)` -- the ATTACKER's
//   slots -- then ON_ABILITY over the TARGET with `megaLauncherBoost`; 3/4 maxHP
//   vs 1/2.
// - Throat Spray (src/battle_util.c:6111-6124): REQUIRE(IsSoundMove(
//   gBattlerAttacker, gCurrentMove)).
// - Pinnacle Blade's protect bypass (src/battle_util.c:6571, :6597):
//   `IsKeenEdge(battlerId, move, moveType)` -- `battlerId` is
//   IsBattlerProtected's own parameter, i.e. the PROTECTING battler, so the
//   scan reads the TARGET's slots. A C quirk, ported as written.
//
// Every number is hand-derived from the C and data/v2.65beta. The fixed RNG is
// 1: every accuracy check hits (1 % 100 = 1), every crit roll misses
// (1 % 24 = 1), Protect's `sProtectSuccessRates[0] >= 1` succeeds, and every
// `Random() % 2 !== 0` check is true.
import { describe, expect, it } from 'vitest'

import { DEFAULT_STAT_STAGE, STAT_SPATK } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import type { RandomSource } from './state'
import { isKeenEdgeMove, isSoundMove, type StatusDeps } from './statusEffects'

const data = loadSimData()

function fixedRng(value: number): RandomSource {
  return { random16: () => value }
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
  /** Extra innate slots (after the chosen ability) for the inverse Pinnacle Blade negative. */
  innates?: [string | null, string | null, string | null]
}

/** Builds the player at level 50 and the foe at the same level (the driver derives
 * the opponent level from the player's highest level). Player innates are cleared
 * unless the scenario supplies them, so no unrelated onEntry innate perturbs the
 * HP arithmetic or the ability scans. */
function session(player: PlayerSpec, foe: TrainerMonData, rng: RandomSource = fixedRng(1)): BattleSession {
  const party = buildPlayerParty(
    [{ species: player.species, level: 50, item: player.item ?? null, moves: player.moves }],
    50,
    data,
  )
  party[0]!.abilities = { ability: player.ability, innates: player.innates ?? [null, null, null] }
  return createSession({ data, playerParty: party, opponentTrainer: trainer([foe]), rng })
}

/** Sets a battler's HP without changing its max HP, on the active mon and its party slot. */
function setHp(s: BattleSession, battlerId: number, hp: number): void {
  const battler = s.state.battlers[battlerId]!
  battler.mon.hp = hp
  const slot = s.state.sides[battlerId & 1].party[battler.partyIndex]
  if (slot) slot.hp = hp
}

function statusDeps(s: BattleSession): StatusDeps {
  return { dataContext: data.dataContext, grounding: s.turnDeps.grounding }
}

// ---------------------------------------------------------------------------
// Item A: Cmd_tryhealpulse reads IsMegaLauncherBoosted from the ATTACKER.
// ---------------------------------------------------------------------------

describe('cycle 150ibbd (A) - Heal Pulse / Floral Healing read the attacker predicate', () => {
  // Heal amounts are trunc(maxHp * 3 / 4) or trunc(maxHp / 2) from the target's
  // maxHP (battle_script_commands.c:7274-7277). The target is a level-50
  // Magikarp: calcHp(20, 31, 0, 50) = floor((2*20 + 31) * 50 / 100) + 60 = 95.
  it('a Gunman user makes Floral Healing a Mega Launcher move when the target has megaLauncherBoost', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_GUNMAN', moves: ['MOVE_FLORAL_HEALING'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_MEGA_LAUNCHER', ['MOVE_TACKLE']),
    )
    const target = s.state.battlers[1]!
    const maxHp = target.mon.maxHp
    expect(maxHp).toBe(95)
    setHp(s, 1, 1)

    stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_FLORAL_HEALING'), null)

    // Gunman grants MOVE_FLAG_MEGA_LAUNCHER to STATUS moves (abilities.cc:9535-9540),
    // and Floral Healing carries no bulletBased flag, so this is the grant-only path.
    expect(target.mon.hp).toBe(1 + Math.trunc((maxHp * 3) / 4)) // 1 + 71
  })

  it('negative: without Gunman the same Floral Healing heals half', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_NONE', moves: ['MOVE_FLORAL_HEALING'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_MEGA_LAUNCHER', ['MOVE_TACKLE']),
    )
    const target = s.state.battlers[1]!
    const maxHp = target.mon.maxHp
    setHp(s, 1, 1)

    stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_FLORAL_HEALING'), null)

    expect(target.mon.hp).toBe(1 + Math.trunc(maxHp / 2)) // 1 + 47
  })

  it('Heal Pulse’s own bulletBased flag still boosts the heal with no attacker grant', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_NONE', moves: ['MOVE_HEAL_PULSE'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_MEGA_LAUNCHER', ['MOVE_TACKLE']),
    )
    const target = s.state.battlers[1]!
    const maxHp = target.mon.maxHp
    setHp(s, 1, 1)

    stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_HEAL_PULSE'), null)

    expect(target.mon.hp).toBe(1 + Math.trunc((maxHp * 3) / 4))
  })

  it('negative: a target without a megaLauncherBoost ability gets half', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_GUNMAN', moves: ['MOVE_FLORAL_HEALING'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    const target = s.state.battlers[1]!
    const maxHp = target.mon.maxHp
    setHp(s, 1, 1)

    stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_FLORAL_HEALING'), null)

    expect(target.mon.hp).toBe(1 + Math.trunc(maxHp / 2))
  })
})

// ---------------------------------------------------------------------------
// Item B: Throat Spray reads IsSoundMove, not the static sound flag.
// ---------------------------------------------------------------------------

describe('cycle 150ibbd (B) - Throat Spray uses IsSoundMove', () => {
  it('a Reverbate holder triggers Throat Spray on a Normal damaging move', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_REVERBATE', item: 'ITEM_THROAT_SPRAY', moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    const attacker = s.state.battlers[0]!
    expect(attacker.mon.itemId).toBe('ITEM_THROAT_SPRAY')

    stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_TACKLE'), null)

    // Reverbate grants SOUND to Normal moves (abilities.cc:10657-10662); Tackle has
    // no static sound flag, so only the grant can trigger this.
    expect(attacker.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(attacker.mon.itemId).toBeNull()
  })

  it('negative: no Reverbate, so the same Tackle leaves the item and SpAtk alone', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_NONE', item: 'ITEM_THROAT_SPRAY', moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    const attacker = s.state.battlers[0]!

    stepTurn(s, buildMoveAction(s.state, data, 0, 'MOVE_TACKLE'), null)

    expect(attacker.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(attacker.mon.itemId).toBe('ITEM_THROAT_SPRAY')
  })
})

// ---------------------------------------------------------------------------
// Item C: IsBattlerProtected's Pinnacle Blade bypass calls IsKeenEdge on the
// PROTECTING battler (battle_util.c:6597 passes `battlerId`, not gBattlerAttacker).
// ---------------------------------------------------------------------------

describe('cycle 150ibbd (C) - Pinnacle Blade protect bypass reads the target IsKeenEdge', () => {
  function protectTurn(player: PlayerSpec, targetAbility: string, rng: RandomSource = fixedRng(1)) {
    const s = session(player, foeMon('SPECIES_MAGIKARP', targetAbility, ['MOVE_PROTECT']), rng)
    const target = s.state.battlers[1]!
    const maxHp = target.mon.maxHp
    stepTurn(
      s,
      buildMoveAction(s.state, data, 0, 'MOVE_VINE_WHIP'),
      buildMoveAction(s.state, data, 1, 'MOVE_PROTECT'),
    )
    return { s, target, maxHp }
  }

  it('attacker Pinnacle Blade + target Chestnut Axe: a Grass non-slice move hits through Protect', () => {
    // Vine Whip is Grass and carries no sliceBased flag. IsKeenEdge(target, move,
    // GRASS) finds the target's Chestnut Axe grant (abilities.cc:11709-11712), so
    // Protect is bypassed (:6597).
    const { target, maxHp } = protectTurn(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_PINNACLE_BLADE', moves: ['MOVE_VINE_WHIP'] },
      'ABILITY_CHESTNUT_AXE',
    )
    expect(target.mon.hp).toBeLessThan(maxHp)
  })

  it('negative: Pinnacle Blade alone (target has no KEEN_EDGE grant) stays blocked', () => {
    const { target, maxHp } = protectTurn(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_PINNACLE_BLADE', moves: ['MOVE_VINE_WHIP'] },
      'ABILITY_NONE',
    )
    expect(target.mon.hp).toBe(maxHp)
  })

  it('negative: Chestnut Axe on the ATTACKER (the battler the C does not read) stays blocked', () => {
    // The C passes the PROTECTING battler to IsKeenEdge, so an attacker-side Chestnut
    // Axe grant alone must not bypass Protect. Venting it as an innate keeps the
    // chosen ability Pinnacle Blade.
    const { target, maxHp } = protectTurn(
      {
        species: 'SPECIES_MUDKIP',
        ability: 'ABILITY_PINNACLE_BLADE',
        moves: ['MOVE_VINE_WHIP'],
        innates: ['ABILITY_CHESTNUT_AXE', null, null],
      },
      'ABILITY_NONE',
    )
    expect(target.mon.hp).toBe(maxHp)
  })
})

// ---------------------------------------------------------------------------
// Item D: the two predicates no longer push a false DoesMoveMatchFlag gap.
// ---------------------------------------------------------------------------

describe('cycle 150ibbd (D) - complete flag scans raise no DoesMoveMatchFlag gap', () => {
  it('an unrelated onModifyMoveFlags holder (Taekkyeon) pushes no note from either predicate', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_TAEKKYEON', moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    const notes: string[] = []

    // Taekkyeon grants DANCE only (abilities.cc:10666-10671); it can never answer
    // TRUE for MOVE_FLAG_SOUND or MOVE_FLAG_KEEN_EDGE.
    expect(isSoundMove(s.state, 0, 'MOVE_TACKLE', statusDeps(s), notes)).toBe(false)
    expect(isKeenEdgeMove(s.state, 0, 'MOVE_TACKLE', statusDeps(s), notes)).toBe(false)
    expect(notes).toEqual([])
  })

  it('a Festivities holder still matches a dance move as sound', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_FESTIVITIES', moves: ['MOVE_DRAGON_DANCE'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    // Dragon Dance is a dance move with no static sound flag; Festivities grants
    // SOUND to dance moves (abilities.cc:10194-10203).
    expect(isSoundMove(s.state, 0, 'MOVE_DRAGON_DANCE', statusDeps(s))).toBe(true)
  })
})
