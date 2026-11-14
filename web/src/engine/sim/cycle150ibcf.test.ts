/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ibcf: the flag predicates read GetMoveTypeInternal's full answer, not
// only the onMoveType ("-ate") slice, and the Pinnacle Blade protect bypass reads
// the ATTACKER's type rather than the protecting battler's.
//
// C at the pinned SHA:
// - IsBattlerProtected (src/battle_util.c:6571-6645): GET_MOVE_TYPE(move, moveType)
//   at :6574, then `BATTLER_HAS_ABILITY(gBattlerAttacker, ABILITY_PINNACLE_BLADE)
//   && IsKeenEdge(battlerId, move, moveType)` at :6597. IsKeenEdge
//   (src/battle_util.c:9381) is DoesMoveMatchFlag(battler, move, moveType,
//   MOVE_FLAG_KEEN_EDGE) (src/abilities.cc:358-386): the static
//   FLAG_KEEN_EDGE_BOOST bit first, then the ability scan over `battler`'s slots
//   -- `battlerId`, the PROTECTING battler, a C quirk the sim keeps. Chestnut Axe
//   (src/abilities.cc:11709-11712) answers only `moveType == TYPE_GRASS`.
// - Cutthroat priority (src/battle_main.c:4278) is
//   IsKeenEdge(battlerId, move, GetTypeBeforeUsingMove(move, battlerId)).
// - Brawling Wyvern's PUNCH grant (src/abilities.cc:7603-7607) tests
//   IS_MOVE_TYPE(move, TYPE_DRAGON) (include/battle.h:743, the dynamic type).
// - Corrupted Mind (src/abilities.cc:9464-9470) reads GET_MOVE_TYPE and does
//   `*effectChance *= 1.4` on a Psychic move.
// - GetMoveTypeInternal (src/battle_main.c:5093-5204): Weather Ball, Hidden Power,
//   Judgment/Plate, Revelation Dance, Terrain Pulse, Ion Deluge/Electrify, then the
//   onMoveType hooks; IsSuppressed hides a Gastro Acid'd "-ate".
//
// Every number is hand-derived from the C and data/v2.65beta. The fixed RNG is 1:
// every accuracy check hits and Protect's first-use roll (65535 threshold) passes.
import { describe, expect, it } from 'vitest'

import {
  STATUS3_GASTRO_ACID,
  STATUS4_CUTTHROAT,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  hasFlag,
  setFlag,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import { MOVE_EFFECT_FLINCH, getMoveEffectChance, type StatusDeps } from './statusEffects'
import type { RandomSource } from './state'

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
  /** Extra innate slots (after the chosen ability) so a second ability can be combined. */
  innates?: [string | null, string | null, string | null]
}

/** Builds the player at level 50 and the foe at the same level (the driver derives
 * the opponent level from the player's highest level). Player innates are cleared
 * unless the scenario supplies them. */
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

/** Step one turn with both actions fixed; returns the player's action outcome. */
function playerAction(s: BattleSession, playerMove: string, foeMove: string) {
  const step = stepTurn(
    s,
    buildMoveAction(s.state, data, 0, playerMove),
    buildMoveAction(s.state, data, 1, foeMove),
  )
  return { step, action: step.outcome.actions.find((a) => a.battlerId === 0)! }
}

// ---------------------------------------------------------------------------
// Item A: Pinnacle Blade's protect bypass reads the ATTACKER's resolved type
// (battle_util.c:6574 GET_MOVE_TYPE), while the Chestnut Axe grant is scanned on
// the PROTECTING battler (battle_util.c:6597's IsKeenEdge(battlerId, ...)).
// ---------------------------------------------------------------------------

describe('cycle 150ibcf (A) - Pinnacle Blade protect bypass uses the attacker type', () => {
  it('an attacker "-ate" turns Tackle Grass, so a Chestnut Axe protector is bypassed', () => {
    // Tackle is declared Normal. Fertilize (ATE_ABILITY, abilities.cc:295-301,
    // :6479) makes GetMoveTypeInternal answer Grass, and the protecting foe's
    // Chestnut Axe then grants KEEN_EDGE (abilities.cc:11709-11712).
    const s = session(
      { species: 'SPECIES_SHUCKLE', ability: 'ABILITY_PINNACLE_BLADE', moves: ['MOVE_TACKLE'], innates: ['ABILITY_FERTILIZE', null, null] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_CHESTNUT_AXE', ['MOVE_PROTECT']),
    )
    expect(s.state.battlers[0]!.mon.abilities.innates[0]).toBe('ABILITY_FERTILIZE')
    const foeHpBefore = s.state.battlers[1]!.mon.hp

    const { action } = playerAction(s, 'MOVE_TACKLE', 'MOVE_PROTECT')

    // PROTECT_NONE: the move is not blocked and deals damage.
    expect(action.missed).toBe(false)
    expect(action.targetDamage ?? 0).toBeGreaterThan(0)
    expect(s.state.battlers[1]!.mon.hp).toBeLessThan(foeHpBefore)
  })

  it('reverse ownership: the "-ate" on the PROTECTOR does not retype the attacker move', () => {
    // The attacker's type is plain Normal, so the target's Chestnut Axe grants
    // nothing even though the TARGET also carries Fertilize. Before this fix the
    // predicate resolved the type from the battler it was handed (the target) and
    // wrongly bypassed Protect.
    const s = session(
      { species: 'SPECIES_SHUCKLE', ability: 'ABILITY_PINNACLE_BLADE', moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_CHESTNUT_AXE', ['MOVE_PROTECT']),
    )
    // The trainer mon model has no innate field; set the protector's slot the same
    // way the player side's fixtures do.
    s.state.battlers[1]!.mon.abilities.innates = ['ABILITY_FERTILIZE', null, null]
    expect(s.state.battlers[1]!.mon.abilities.innates[0]).toBe('ABILITY_FERTILIZE')
    const foeHpBefore = s.state.battlers[1]!.mon.hp

    const { action } = playerAction(s, 'MOVE_TACKLE', 'MOVE_PROTECT')

    expect(action.missed).toBe(true)
    expect(action.targetDamage).toBeNull()
    expect(s.state.battlers[1]!.mon.hp).toBe(foeHpBefore)
  })
})

// ---------------------------------------------------------------------------
// Item B1: Cutthroat's +1 priority reads GetMoveTypeInternal, not only the
// onMoveType hooks. Terrain Pulse is declared Normal; in Grassy Terrain
// GetMoveTypeInternal (battle_main.c:5173-5191) answers Grass, so Chestnut Axe
// grants KEEN_EDGE and battle_main.c:4278 adds +1.
//
// The priority number lives on TurnOrderMoveView.isKeenEdge. The driver's own
// buildMoveAction still has no resolver (StatusDeps only), so this test drives
// turn.ts's moveViewFor through Encore: applyEncore rebuilds the encored move's
// view with the TurnLoopDeps in hand, which is the production path that reads
// deps.damage.moveType.
// ---------------------------------------------------------------------------

function encoredSession(terrain: number | null, gastroAcid: boolean): BattleSession {
  const s = session(
    { species: 'SPECIES_SHUCKLE', ability: 'ABILITY_CUTTHROAT', moves: ['MOVE_TERRAIN_PULSE', 'MOVE_TACKLE'], innates: ['ABILITY_CHESTNUT_AXE', null, null] },
    // Regieleki is far faster than Shuckle, so only a priority bonus can put the
    // player first.
    foeMon('SPECIES_REGIELEKI', 'ABILITY_NONE', ['MOVE_TACKLE']),
  )
  if (terrain !== null) s.state.field.statuses = setFlag(s.state.field.statuses, terrain)
  if (gastroAcid) s.state.battlers[0]!.statuses3 = setFlag(s.state.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)
  // applyEncore replaces the chosen Tackle with the encored slot move and rebuilds
  // its view through moveViewFor (battle_main.c:3689-3691, battle_util.c:221-236).
  s.state.battlers[0]!.volatiles.encoredMove = 'MOVE_TERRAIN_PULSE'
  s.state.battlers[0]!.volatiles.encoredMovePos = 0
  return s
}

function turnOrder(s: BattleSession): number[] {
  // The actions array still names Tackle; applyEncore swaps in Terrain Pulse.
  const { step } = playerAction(s, 'MOVE_TACKLE', 'MOVE_TACKLE')
  return step.outcome.actions.map((a) => a.battlerId)
}

describe('cycle 150ibcf (B1) - Cutthroat + Chestnut Axe sees the Terrain Pulse type', () => {
  it('Grassy Terrain makes Terrain Pulse Grass, so the slower Cutthroat holder acts first', () => {
    const s = encoredSession(STATUS_FIELD_GRASSY_TERRAIN, false)
    expect(hasFlag(s.state.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(true)
    expect(s.state.battlers[1]!.mon.rawStats.spe).toBeGreaterThan(s.state.battlers[0]!.mon.rawStats.spe)

    // +1 from battle_main.c:4278 beats the foe's Speed lead.
    expect(turnOrder(s)).toEqual([0, 1])
  })

  it('negative: without terrain Terrain Pulse stays Normal and the faster foe acts first', () => {
    const s = encoredSession(null, false)
    expect(turnOrder(s)).toEqual([1, 0])
  })

  it('a Gastro Acid\'d "-ate" does not change priority: the whole ability scan is suppressed', () => {
    // Gastro Acid suppresses Chestnut Axe (and the "-ate") via IsSuppressed
    // (battle_util.c:9254-9261), so no KEEN_EDGE grant and no +1.
    const s = encoredSession(STATUS_FIELD_GRASSY_TERRAIN, true)
    expect(hasFlag(s.state.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true)
    expect(turnOrder(s)).toEqual([1, 0])
  })
})

// ---------------------------------------------------------------------------
// Item B2: Corrupted Mind reads GET_MOVE_TYPE. Terrain Pulse in Psychic Terrain
// resolves Psychic (GetMoveTypeInternal, battle_main.c:5173-5191), so
// `*effectChance *= 1.4` (abilities.cc:9469) applies: floor(30 * 1.4) = 42.
// ---------------------------------------------------------------------------

function chanceSession(terrain: number | null, gastroAcid: boolean): BattleSession {
  const s = session(
    { species: 'SPECIES_MUDKIP', ability: 'ABILITY_CORRUPTED_MIND', moves: ['MOVE_TERRAIN_PULSE'] },
    foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']),
  )
  if (terrain !== null) s.state.field.statuses = setFlag(s.state.field.statuses, terrain)
  if (gastroAcid) s.state.battlers[0]!.statuses3 = setFlag(s.state.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)
  return s
}

describe('cycle 150ibcf (B2) - Corrupted Mind effect chance reads the resolved type', () => {
  it('Psychic Terrain makes Terrain Pulse Psychic: 30% becomes 42%', () => {
    const s = chanceSession(STATUS_FIELD_PSYCHIC_TERRAIN, false)
    const resolved = s.turnDeps.damage.moveType!(s.state, 0, 1, 'MOVE_TERRAIN_PULSE').moveType
    expect(resolved).toBe('PSYCHIC')
    // battle_script_commands.c:3074-3086 walks the ability slots; the int
    // multiplication truncates: 30 * 1.4 = 42.
    expect(getMoveEffectChance(s.state, 0, 'MOVE_TERRAIN_PULSE', MOVE_EFFECT_FLINCH, 30, statusDeps(s), undefined, resolved)).toBe(42)
    // Contrast: without the resolver's answer the old onMoveType-only fallback
    // sees Normal and leaves the chance at 30.
    expect(getMoveEffectChance(s.state, 0, 'MOVE_TERRAIN_PULSE', MOVE_EFFECT_FLINCH, 30, statusDeps(s))).toBe(30)
  })

  it('negative: without terrain Terrain Pulse stays Normal, so the chance stays 30', () => {
    const s = chanceSession(null, false)
    const resolved = s.turnDeps.damage.moveType!(s.state, 0, 1, 'MOVE_TERRAIN_PULSE').moveType
    expect(resolved).toBe('NORMAL')
    expect(getMoveEffectChance(s.state, 0, 'MOVE_TERRAIN_PULSE', MOVE_EFFECT_FLINCH, 30, statusDeps(s), undefined, resolved)).toBe(30)
  })

  it('a Gastro Acid\'d holder keeps the chance at 30 even with the Psychic type', () => {
    // IsSuppressed (battle_util.c:9254-9261) hides Corrupted Mind itself, so the
    // observable chance is unchanged. (The sim's type resolver is not
    // suppression-aware -- dispatchCalc.ts:50's documented v1 gap -- which is why
    // this asserts the effect chance rather than the retype.)
    const s = chanceSession(STATUS_FIELD_PSYCHIC_TERRAIN, true)
    const resolved = s.turnDeps.damage.moveType!(s.state, 0, 1, 'MOVE_TERRAIN_PULSE').moveType
    expect(getMoveEffectChance(s.state, 0, 'MOVE_TERRAIN_PULSE', MOVE_EFFECT_FLINCH, 30, statusDeps(s), undefined, resolved)).toBe(30)
  })
})
