/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 109b: Illusion's activation state (SetIllusionMon / GetIllusionMonPtr, break on hit,
// the 1.3x offensive multiplier, the Imposter and Transform gates) and Camouflage's use of the
// resolved move type.
//
// Hand-derived from eliteredux-source at the pinned SHA:
// - GetIllusionMonPtr (src/battle_util.c:8281-8292): NULL when `broken`; a lazy SetIllusionMon
//   when `!set`; NULL when still `!on`; else the disguise mon.
// - SetIllusionMon (:8296-8330): `set = 1` first (:8304); FALSE unless the resolved ability is
//   ABILITY_ILLUSION or it is an innate (:8305); scans party slots PARTY_SIZE-1 ... 0 for
//   species && HP && !egg && != mon && != partnerMon (:8316-8326). partnerMon is the live
//   partner's party mon, else `mon` itself (:8310-8313), so in singles the partner test is the
//   self test. Eggs are not modelled by this sim.
// - Impl<ABILITY_ILLUSION> (src/abilities.cc:2145-2158): onDefender checks DidMoveHit()
//   (:4060: WasMoveSuccessful && TARGET_TURN_DAMAGED), illusion.on and !illusion.broken, then
//   runs BattleScript_IllusionOff. The state change is battle_gfx_sfx_util.c:405-406
//   (`broken = 1; on = 0`) when that script's animation launches.
//   onOffensiveMultiplier is `if (on && !broken) MUL(1.3)`.
// - Impl<ABILITY_IMPOSTER> (:2161-2175): CHECK_NOT(gBattleStruct->illusion[target].on).
// - Cmd_transformdataexecution (src/battle_script_commands.c:10485): the `illusion[target].on`
//   term is a plain `||` in the Transform failure condition.
// - Camouflage (src/battle_script_commands.c:4415-4427): GET_MOVE_TYPE(gCurrentMove, moveType)
//   (include/battle.h:735-741) is the RESOLVED type; if IS_BATTLER_OF_TYPE(target, moveType)
//   nothing happens, else type3 = moveType.
import { describe, expect, it } from 'vitest'

import { createBridgeDamageResolver } from './damageResolver'
import { STATUS2_TRANSFORMED, hasFlag } from './constants'
import { createBattleState, createBattlerState } from './create'
import type { SimMoveData } from './dataContext'
import { loadSimData } from './driver/loadSimData'
import { dispatchMoveEndDefenderAbilities } from './moveEnd'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { applySwitchInAbilities, getIllusionMonPtr } from './switchInAbility'
import { executeTurn, handleProtectLikeMoveEnd, type TurnLoopDeps } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const GROUNDING = simData.grounding
const RATIOS = simData.statStageRatios

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function ability(id: string): SimBattleMon['abilities'] {
  return { ability: id, innates: [null, null, null] }
}

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as
    | { types: string[]; abilities: (string | null)[]; innates: (string | null)[] }
    | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: {
      ability: s.abilities[0] ?? null,
      innates: [s.innates[0] ?? null, s.innates[1] ?? null, s.innates[2] ?? null],
    },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

/** A reserve party member as the SimPartyMon fields SetIllusionMon reads them: speciesId
 * (MON_DATA_SANITY_HAS_SPECIES) and hp (MON_DATA_HP). */
function partyMon(speciesId: string | null, hp: number): SimPartyMon {
  return {
    speciesId,
    hp,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: noAbility,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
  }
}

function scriptedRng(rolls: number[]): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return rolls[rng.calls - 1] ?? 0
    },
  }
  return rng
}

interface BattleOptions {
  playerParty?: SimPartyMon[]
  opponentParty?: SimPartyMon[]
  rng?: RandomSource
}

function battle(a: SimBattleMon, b: SimBattleMon, opts: BattleOptions = {}): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng: opts.rng ?? { random16: () => 0 },
    playerParty: opts.playerParty,
    opponentParty: opts.opponentParty,
  })
}

const DUMMY_DAMAGE = { resolve: () => ({ targetDamage: 0, attackerDamage: null, unmodelled: [] }) }

const LOOP_DEPS: TurnLoopDeps = {
  turnOrder: simData.turnOrder,
  grounding: GROUNDING,
  damage: DUMMY_DAMAGE,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
}

function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ?? 'NORMAL',
    power: moveData.power,
    flags: moveData.flags,
    split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

const move = (id: string): SimMoveData => {
  const m = DATA_CONTEXT.move(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return m
}

function illusionMon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_ILLUSION'), ...overrides })
}

function plainMon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return monFor('SPECIES_MUDKIP', { abilities: noAbility, ...overrides })
}

/** The move-end defender dispatch for one battler taking a hit. */
function defenderHit(state: BattleState, targetId: number, targetDamage: number) {
  return dispatchMoveEndDefenderAbilities({
    state,
    attackerId: targetId ^ 1,
    targetId,
    moveId: 'MOVE_TACKLE',
    moveData: DATA_CONTEXT.move('MOVE_TACKLE'),
    targetDamage,
    hpDealt: targetDamage,
    deps: LOOP_DEPS,
    unmodelled: [],
    fainted: [],
  })
}

// ---------------------------------------------------------------------------
// SetIllusionMon / GetIllusionMonPtr (battle_util.c:8281-8330)
// ---------------------------------------------------------------------------
describe('Cycle 109b - Illusion activation state', () => {
  it('arms on first read when a distinct alive non-self party mon exists', () => {
    // party slot 0 is the active mon (partyIndex 0), so the scan 5..0 accepts only slot 1.
    const state = battle(illusionMon(), plainMon(), {
      playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_CHARIZARD', 100)],
    })
    const disguise = getIllusionMonPtr(state, 0)

    expect(disguise?.speciesId).toBe('SPECIES_CHARIZARD')
    expect(state.battlers[0]!.illusion).toEqual({ set: true, on: true, broken: false, partyId: 1 })
  })

  it('stays off with a one-mon party (every candidate is the active mon)', () => {
    const state = battle(illusionMon(), plainMon(), { playerParty: [partyMon('SPECIES_MUDKIP', 100)] })

    expect(getIllusionMonPtr(state, 0)).toBeNull()
    expect(state.battlers[0]!.illusion.on).toBe(false)
    // `set = 1` is written at :8304 before the scan, even when no candidate exists.
    expect(state.battlers[0]!.illusion.set).toBe(true)
  })

  it('stays off when the only candidate is fainted (MON_DATA_HP == 0, :8318)', () => {
    const state = battle(illusionMon(), plainMon(), {
      playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_CHARIZARD', 0)],
    })

    expect(getIllusionMonPtr(state, 0)).toBeNull()
    expect(state.battlers[0]!.illusion.on).toBe(false)
  })

  it('picks the LAST valid party slot, scanning PARTY_SIZE-1 down to 0 (:8316-8326)', () => {
    // Slots 1 and 2 are both eligible; the descending loop must land on 2.
    const state = battle(illusionMon(), plainMon(), {
      playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_TREECKO', 100), partyMon('SPECIES_CHARIZARD', 100)],
    })

    const disguise = getIllusionMonPtr(state, 0)
    expect(disguise?.speciesId).toBe('SPECIES_CHARIZARD')
    expect(state.battlers[0]!.illusion.partyId).toBe(2)
  })

  it('does not arm for a holder without Illusion in any slot (:8305)', () => {
    const state = battle(plainMon(), plainMon(), {
      playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_CHARIZARD', 100)],
    })

    expect(getIllusionMonPtr(state, 0)).toBeNull()
    expect(state.battlers[0]!.illusion.on).toBe(false)
    expect(state.battlers[0]!.illusion.set).toBe(true)
  })

  it('breaks on a damaging hit and does nothing on a miss or a blocked (zero-damage) hit', () => {
    // onDefender (:2145-2150) requires DidMoveHit() = WasMoveSuccessful && TARGET_TURN_DAMAGED;
    // this sim reads it as targetDamage > 0 (the reading Strikeout uses).
    const hit = battle(illusionMon(), plainMon(), {
      playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_CHARIZARD', 100)],
    })
    getIllusionMonPtr(hit, 0)
    expect(hit.battlers[0]!.illusion.on).toBe(true)
    defenderHit(hit, 0, 10)
    // battle_gfx_sfx_util.c:405-406: broken = 1; on = 0.
    expect(hit.battlers[0]!.illusion.broken).toBe(true)
    expect(hit.battlers[0]!.illusion.on).toBe(false)

    const miss = battle(illusionMon(), plainMon(), {
      playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_CHARIZARD', 100)],
    })
    getIllusionMonPtr(miss, 0)
    defenderHit(miss, 0, 0) // miss, or a fully blocked hit: TARGET_TURN_DAMAGED stays false
    expect(miss.battlers[0]!.illusion.on).toBe(true)
    expect(miss.battlers[0]!.illusion.broken).toBe(false)
  })

  it('does not re-trigger on a second hit after the break', () => {
    const state = battle(illusionMon(), plainMon(), {
      playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_CHARIZARD', 100)],
    })
    getIllusionMonPtr(state, 0)
    defenderHit(state, 0, 10)
    const afterFirst = { ...state.battlers[0]!.illusion }

    defenderHit(state, 0, 10)
    // CHECK(illusion.on) fails once broken, so the second hit changes nothing.
    expect(state.battlers[0]!.illusion).toEqual(afterFirst)
  })
})

// ---------------------------------------------------------------------------
// 1.3x offensive multiplier (abilities.cc:2152-2156)
// ---------------------------------------------------------------------------
describe('Cycle 109b - Illusion damage multiplier', () => {
  it('is 1.3x while on and back to baseline once broken', () => {
    // onOffensiveMultiplier runs `if (on && !broken) MUL(1.3)`. Both resolves are the same
    // attacker/target/move and the same rng, so the only differing stage is this 1.3x: the
    // on-hit damage must be strictly larger, and the broken one is the baseline.
    const state = battle(illusionMon(), plainMon(), {
      playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_CHARIZARD', 100)],
      rng: { random16: () => 0 },
    })
    const damage = createBridgeDamageResolver({
      grounding: GROUNDING,
      turnOrder: simData.turnOrder,
      statStageRatios: RATIOS,
      dataContext: DATA_CONTEXT,
      inverseBattle: false,
      moveData: simData.moveData,
      typeChart: simData.typeChart,
      inverseTypeChart: simData.inverseTypeChart,
      moveBehaviors: simData.moveBehaviors,
      battleConstants: simData.battleConstants,
      random: state.rng,
    })
    const action = useMove(1, move('MOVE_TACKLE'))

    // First resolve is the first read of illusion[]: GetIllusionMonPtr arms it lazily.
    const boosted = damage.resolve(state, 0, 1, action).targetDamage
    expect(state.battlers[0]!.illusion.on).toBe(true)

    // Battler 1's move lands on the Illusion holder (battler 0) and breaks the disguise.
    defenderHit(state, 0, 10)
    expect(state.battlers[0]!.illusion.broken).toBe(true)

    const baseline = damage.resolve(state, 0, 1, action).targetDamage
    expect(boosted).not.toBeNull()
    expect(baseline).not.toBeNull()
    expect(boosted!).toBeGreaterThan(baseline!)
  })
})

// ---------------------------------------------------------------------------
// Imposter and Transform checks (abilities.cc:2165, battle_script_commands.c:10485)
// ---------------------------------------------------------------------------
describe('Cycle 109b - Illusion gates for Imposter and Transform', () => {
  it('Imposter does not copy a target whose illusion is on, and does once broken', () => {
    // CHECK_NOT(gBattleStruct->illusion[gBattlerTarget].on) (abilities.cc:2165).
    const blocked = battle(
      plainMon({ abilities: ability('ABILITY_IMPOSTER') }),
      monFor('SPECIES_CHARIZARD', { abilities: ability('ABILITY_ILLUSION') }),
      { opponentParty: [partyMon('SPECIES_CHARIZARD', 100), partyMon('SPECIES_MUDKIP', 100)] },
    )
    applySwitchInAbilities(blocked, 0, LOOP_DEPS, [])
    expect(hasFlag(blocked.battlers[0]!.mon.status2, STATUS2_TRANSFORMED)).toBe(false)
    // The Imposter check itself performed the lazy arm (battle_util.c:8281-8292).
    expect(blocked.battlers[1]!.illusion.on).toBe(true)

    const broken = battle(
      plainMon({ abilities: ability('ABILITY_IMPOSTER') }),
      monFor('SPECIES_CHARIZARD', { abilities: ability('ABILITY_ILLUSION') }),
      { opponentParty: [partyMon('SPECIES_CHARIZARD', 100), partyMon('SPECIES_MUDKIP', 100)] },
    )
    getIllusionMonPtr(broken, 1)
    defenderHit(broken, 1, 10) // battler 0's move lands on battler 1 and breaks the illusion
    expect(broken.battlers[1]!.illusion.on).toBe(false)
    applySwitchInAbilities(broken, 0, LOOP_DEPS, [])
    expect(hasFlag(broken.battlers[0]!.mon.status2, STATUS2_TRANSFORMED)).toBe(true)
    expect(broken.battlers[0]!.mon.speciesId).toBe('SPECIES_CHARIZARD')
  })

  it('Transform fails while the target illusion is on (battle_script_commands.c:10485)', () => {
    // The condition is `status2 & TRANSFORMED || illusion[target].on || semi-invulnerable`;
    // the illusion term is a plain `||`, so an otherwise-valid Transform must fail.
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_TRANSFORM', null, null, null], pp: [10, 0, 0, 0] }),
      monFor('SPECIES_CHARIZARD'),
      { rng: scriptedRng([]) },
    )
    state.battlers[1]!.illusion = { set: true, on: true, broken: false, partyId: 1 }

    const out = executeTurn(state, [useMove(1, move('MOVE_TRANSFORM')), null], LOOP_DEPS)
    const act = out.actions.find((a) => a.battlerId === 0)!

    expect(act.missed).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
  })
})

// ---------------------------------------------------------------------------
// Camouflage resolved type (battle_script_commands.c:4415-4427)
// ---------------------------------------------------------------------------
describe('Cycle 109b - Camouflage uses GET_MOVE_TYPE', () => {
  it('adds the onMoveType-resolved type and does nothing when already present', () => {
    // GET_MOVE_TYPE (:4417) is the RESOLVED type. TACKLE is TYPE_NORMAL (moves.json); the
    // attacker's Pixilate onMoveType (ATE_ABILITY, abilities.cc:295-301) turns a Normal move
    // FAIRY, so Camouflage must add FAIRY rather than Normal.
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_PIXILATE') }),
      monFor('SPECIES_CHARIZARD', { types: ['FIRE', 'MYSTERY', 'MYSTERY'] }),
    )
    const target = state.battlers[1]!
    target.round.protectMove = 'MOVE_CAMOUFLAGE'
    state.battlers[0]!.round.touchedProtectLike = true
    const notes: string[] = []

    handleProtectLikeMoveEnd(state, 0, 1, 'MOVE_TACKLE', LOOP_DEPS, notes)
    expect(target.mon.types[2]).toBe('FAIRY')
    // The resolver covers only GetMoveTypeInternal's onMoveType branch; the note names the rest.
    expect(notes.some((n) => n.includes('Natural Gift'))).toBe(true)

    // IS_BATTLER_OF_TYPE(target, moveType) is true now, so the second application is a no-op.
    state.battlers[0]!.round.touchedProtectLike = true
    const before = [...target.mon.types]
    handleProtectLikeMoveEnd(state, 0, 1, 'MOVE_TACKLE', LOOP_DEPS, notes)
    expect(target.mon.types).toEqual(before)
  })
})
