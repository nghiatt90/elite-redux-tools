/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ibcb: Cutthroat's +1 priority and Blade Dance's IsDance test go
// through the DoesMoveMatchFlag predicates instead of a hard-coded `false` /
// the static moves.json `dance` bit.
//
// C at the pinned SHA:
// - GetMovePriority (src/battle_main.c:4257-4292) gives STATUS4_CUTTHROAT's
//   holder +1 when `IsKeenEdge(battlerId, move, GetTypeBeforeUsingMove(move,
//   battlerId))` answers TRUE (:4278-4280). The sim side already reads
//   `TurnOrderMoveView.isKeenEdge` (web/src/engine/sim/turnOrder.ts:437); every
//   production builder of that view used to hard-code it to false.
// - IsKeenEdge (src/battle_util.c:9381) is DoesMoveMatchFlag over
//   MOVE_FLAG_KEEN_EDGE: the move's static `sliceBased` flag, else an
//   onModifyMoveFlags ability. Chestnut Axe (src/abilities.cc:11709-11712) is
//   the only grant, and it answers only for a RESOLVED-GRASS move.
// - STATUS4_CUTTHROAT is set by Cutthroat's onEntry (src/abilities.cc:9166-9172),
//   already ported in web/src/engine/sim/switchInAbility.ts.
// - Blade Dance's onAttacker (src/abilities.cc:9036-9045) begins
//   `CHECK(IsDance(battler, move))`; IsDance (src/battle_util.c:9245) is
//   DoesMoveMatchFlag over MOVE_FLAG_DANCE, which also accepts the grants from
//   Festivities (:10194-10203, sound), Taekkyeon (:10666-10671, non-status) and
//   Backstreet Boy (:11570-11583, kick). The follow-up move is still not
//   modelled; only the predicate changed.
//
// Every number is hand-derived from the C and data/v2.65beta. The fixed RNG is
// 1: every accuracy check hits (1 % 100 = 1 below every accuracy in play) and
// no crit fires.
import { describe, expect, it } from 'vitest'

import { STATUS4_CUTTHROAT, hasFlag } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
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

/** Runs one turn with both actions fixed (so the AI's own choice cannot perturb the order). */
function battlerOrder(s: BattleSession, playerMove: string, foeMove: string): number[] {
  const step = stepTurn(
    s,
    buildMoveAction(s.state, data, 0, playerMove),
    buildMoveAction(s.state, data, 1, foeMove),
  )
  return step.outcome.actions.map((a) => a.battlerId)
}

// Shuckle (Speed 5) vs Regieleki (Speed 200): the foe is unambiguously faster, so
// only a priority bonus can make the player act first.
function slowPlayerAbility(ability: string | null, moves: string[], innates?: PlayerSpec['innates']): BattleSession {
  return session(
    { species: 'SPECIES_SHUCKLE', ability, moves, ...(innates ? { innates } : {}) },
    foeMon('SPECIES_REGIELEKI', 'ABILITY_NONE', ['MOVE_TACKLE']),
  )
}

// ---------------------------------------------------------------------------
// Item A: Cutthroat's +1 priority reads TurnOrderMoveView.isKeenEdge, which is
// now built with IsKeenEdge (battle_main.c:4278-4280).
// ---------------------------------------------------------------------------

describe('cycle 150ibcb (A) - Cutthroat gains +1 on a keen-edge move', () => {
  it('a slower Cutthroat holder with a static slice move acts first', () => {
    // Razor Leaf is a Grass PHYSICAL move carrying the static `sliceBased` flag.
    const s = slowPlayerAbility('ABILITY_CUTTHROAT', ['MOVE_RAZOR_LEAF'])
    const player = s.state.battlers[0]!
    const foe = s.state.battlers[1]!

    // Cutthroat's onEntry sets STATUS4_CUTTHROAT (abilities.cc:9166-9172).
    expect(hasFlag(player.statuses4, STATUS4_CUTTHROAT)).toBe(true)
    expect(foe.mon.rawStats.spe).toBeGreaterThan(player.mon.rawStats.spe)

    // The builder resolves the predicate, not a hard-coded false.
    expect(buildMoveAction(s.state, data, 0, 'MOVE_RAZOR_LEAF').chosenMove?.isKeenEdge).toBe(true)

    // Both moves have declared priority 0, so Cutthroat's +1 (battle_main.c:4278)
    // beats the foe's speed lead.
    expect(battlerOrder(s, 'MOVE_RAZOR_LEAF', 'MOVE_TACKLE')).toEqual([0, 1])
  })

  it('negative: the same Cutthroat holder with a non-slice move stays second', () => {
    const s = slowPlayerAbility('ABILITY_CUTTHROAT', ['MOVE_TACKLE'])
    expect(hasFlag(s.state.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(true)
    expect(buildMoveAction(s.state, data, 0, 'MOVE_TACKLE').chosenMove?.isKeenEdge).toBe(false)

    expect(battlerOrder(s, 'MOVE_TACKLE', 'MOVE_TACKLE')).toEqual([1, 0])
  })

  it('negative: a slice move without STATUS4_CUTTHROAT gets no priority', () => {
    const s = slowPlayerAbility(null, ['MOVE_RAZOR_LEAF'])
    expect(hasFlag(s.state.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(false)

    // The move IS keen edge (static flag); only the status bit is missing, so the
    // +1 at battle_main.c:4278 never applies.
    expect(buildMoveAction(s.state, data, 0, 'MOVE_RAZOR_LEAF').chosenMove?.isKeenEdge).toBe(true)

    expect(battlerOrder(s, 'MOVE_RAZOR_LEAF', 'MOVE_TACKLE')).toEqual([1, 0])
  })

  it('a grant-only keen edge (Chestnut Axe innate on Grass) also acts first', () => {
    // Vine Whip carries NO sliceBased flag. Chestnut Axe grants KEEN_EDGE to a
    // resolved-GRASS move (abilities.cc:11709-11712), and Cutthroat supplies
    // STATUS4_CUTTHROAT. Combining them needs the innate slot, which the player
    // mon model supports (level 50 clears the Elite slot-0 threshold of 1).
    const s = slowPlayerAbility('ABILITY_CUTTHROAT', ['MOVE_VINE_WHIP'], ['ABILITY_CHESTNUT_AXE', null, null])
    const player = s.state.battlers[0]!

    expect(hasFlag(player.statuses4, STATUS4_CUTTHROAT)).toBe(true)
    expect(player.mon.abilities.innates[0]).toBe('ABILITY_CHESTNUT_AXE')
    expect(buildMoveAction(s.state, data, 0, 'MOVE_VINE_WHIP').chosenMove?.isKeenEdge).toBe(true)

    expect(battlerOrder(s, 'MOVE_VINE_WHIP', 'MOVE_TACKLE')).toEqual([0, 1])
  })
})

// ---------------------------------------------------------------------------
// Item B: Blade Dance's onAttacker tests IsDance (grants included), not the
// static `dance` flag. The follow-up is still not modelled, so the note is kept.
// ---------------------------------------------------------------------------

const BLADE_DANCE_NOTE =
  "Blade Dance's followup move (UseAttackerFollowUpMove MOVE_LEAF_BLADE, abilities.cc:9043; ABILITY_BLADE_DANCE) is not modelled"

function bladeDanceTurn(s: BattleSession, playerMove: string): string[] {
  const step = stepTurn(
    s,
    buildMoveAction(s.state, data, 0, playerMove),
    buildMoveAction(s.state, data, 1, 'MOVE_TACKLE'),
  )
  return step.unmodelled
}

describe('cycle 150ibcb (B) - Blade Dance uses IsDance', () => {
  it('a static dance move still raises the not-modelled note', () => {
    // Aqua Step carries the static `dance` flag; Blade Dance's IsDance check passes.
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_BLADE_DANCE', moves: ['MOVE_AQUA_STEP'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    expect(bladeDanceTurn(s, 'MOVE_AQUA_STEP')).toContain(BLADE_DANCE_NOTE)
  })

  it('negative: a non-dance move raises no Blade Dance note', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_BLADE_DANCE', moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    expect(bladeDanceTurn(s, 'MOVE_TACKLE')).not.toContain(BLADE_DANCE_NOTE)
  })

  it('a Festivities innate grants IsDance to a sound move, so the note still fires', () => {
    // Hyper Voice is sound and carries no static dance flag. Festivities grants
    // MOVE_FLAG_DANCE to sound moves (abilities.cc:10194-10203), which only the
    // IsDance predicate sees.
    const s = session(
      {
        species: 'SPECIES_MUDKIP',
        ability: 'ABILITY_BLADE_DANCE',
        moves: ['MOVE_HYPER_VOICE'],
        innates: ['ABILITY_FESTIVITIES', null, null],
      },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    expect(s.state.battlers[0]!.mon.abilities.innates[0]).toBe('ABILITY_FESTIVITIES')
    expect(bladeDanceTurn(s, 'MOVE_HYPER_VOICE')).toContain(BLADE_DANCE_NOTE)
  })
})
