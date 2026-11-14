/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150hbd: the player's gBattlerTarget is fixed at move SELECTION by the controller, and
// HandleAction_UseMove reads the stored id. The driver builders used to derive it from
// `moveData.target === 'USER'` (wrong for ALL_BATTLERS, USER_OR_ALLY, Rain Dance, Curse) and
// resolveMoveEndDispatchTarget re-derived it at execution, which differs from the C whenever the
// state changes between selection and execution.
//
// C source at the pinned SHA (pipeline/.upstream/eliteredux-source):
// - src/battle_controller_player.c:2385-2398 (on A press):
//     MOVE_CURSE -> MOVE_TARGET_SELECTED if type1/2/3 is TYPE_GHOST or
//                   IsBattlerWeatherAffected(gActiveBattler, WEATHER_FOG_ANY), else MOVE_TARGET_USER;
//     every other move -> GetBattlerBattleMoveTargetFlags(move, gActiveBattler).
//     then `if (moveTarget & MOVE_TARGET_USER) gMultiUsePlayerCursor = gActiveBattler;`
//     else the opposing-side battler.
//   The bit test means USER, USER_OR_ALLY (USER|ALLY) and ALL_BATTLERS (0x100|USER,
//   include/constants/battle.h:499-501) all select the user; USER_OR_SELECTED (0x2) does not.
// - src/battle_util.c:128-150 GetBattlerBattleMoveTargetFlags: Rain Dance / Sunny Day / Sandstorm /
//   Hail / Eerie Fog return MOVE_TARGET_USER unless the battler has ABILITY_FORECAST.
// - src/battle_util.c:212-243 HandleAction_UseMove reads the stored
//   `gBattleStruct->moveTarget[gBattlerAttacker]` (:242) and does NOT re-read the flags. The only
//   execution-time re-read is the MOVE_TARGET_ALLY re-check (:283-287): dynamic flags ==
//   MOVE_TARGET_ALLY -> live partner (BATTLE_PARTNER), else the attacker.
// - src/battle_controller_opponent.c:1598-1601, 1625-1626: the opponent reads the STATIC
//   gBattleMoves[].target, `target & (MOVE_TARGET_USER_OR_SELECTED | MOVE_TARGET_USER)` -> itself.
//
// MOVEEND_ABILITIES (battle_script_commands.c:4527-4531, battle_util.c:4485-4489) then dispatches
// on that gBattlerTarget with no damage gate.
//
// Probe: Crispy Cream's onDefender (src/abilities.cc:10837-10842) draws `Random() % 2` BEFORE it
// delegates, so exactly one rng draw means MOVEEND_ABILITIES ran on the battler holding it.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { WEATHER_FOG_TEMPORARY } from './constants'
import type { SimDataContext } from './dataContext'
import { loadSimData } from './driver/loadSimData'
import { buildMoveAction, groundingFor } from './driver/session'
import { getPlayerSelectedMoveTarget } from './moveTargetFlags'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { StatusDeps } from './statusEffects'
import { executeTurn, type DamageResolver, type TurnLoopDeps } from './turn'

// ---------------------------------------------------------------------------
// Scaffolding -- the committed snapshot through the same loader the drivers use
// (cycle152fNaturalGiftPriority.test.ts builds its bundle the same way).
// ---------------------------------------------------------------------------

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext

function requireMove(id: string) {
  const m = DATA_CONTEXT.move(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return m
}

type BattlerSpec = {
  spe?: number
  hp?: number
  maxHp?: number
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  abilities?: SimBattleMon['abilities']
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 300,
    maxHp: 300,
    itemId: null,
    statStages: [],
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function battle(specs: BattlerSpec[], rng: RandomSource = scriptedRng([0])): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 300,
          maxHp: s.maxHp ?? 300,
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(values: number[] = [0]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      const val = values[idx] ?? 0
      idx++
      return val
    },
  }
  return r
}

function fixedDamage(amount = 0): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function turnDeps(state: BattleState): TurnLoopDeps {
  return {
    turnOrder: simData.turnOrder,
    grounding: groundingFor(simData, state),
    damage: fixedDamage(0),
    statStageRatios: simData.statStageRatios,
    dataContext: DATA_CONTEXT,
    moveBehaviors: simData.moveBehaviors,
    hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
  }
}

function statusDepsFor(state: BattleState): StatusDeps {
  return { dataContext: DATA_CONTEXT, grounding: groundingFor(simData, state) }
}

const hasAbility = (
  ability: string | null,
  innates: [string | null, string | null, string | null] = [null, null, null],
): SimBattleMon['abilities'] => ({ ability, innates })

const CRISPY_CREAM = hasAbility('ABILITY_CRISPY_CREAM')

/** data/v2.65beta/moves.json declares no USER_OR_SELECTED move (the enum value exists in
 * MoveList.proto), so the negative case overrides one real status move's static target on the
 * data-context seam rather than inventing a move -- the same device cycle150hbTarget.test.ts uses. */
function dataContextWithTarget(moveId: string, target: string): SimDataContext {
  return {
    ...DATA_CONTEXT,
    move: (id: string) => {
      const m = DATA_CONTEXT.move(id)
      if (!m || id !== moveId) return m
      return { ...m, target }
    },
  }
}

/** One turn of the drift scenario: the foe (faster) uses Trick-or-Treat on the player, the
 * player's non-Ghost-or-Ghost Curse is built BEFORE the turn from the same state. */
function driftTurn(player: BattlerSpec, foe: BattlerSpec) {
  const rng = scriptedRng([0])
  const state = battle([player, foe], rng)
  const playerAction = buildMoveAction(state, simData, 0, 'MOVE_CURSE')
  const foeAction = buildMoveAction(state, simData, 1, 'MOVE_TRICK_OR_TREAT')
  const out = executeTurn(state, [playerAction, foeAction], turnDeps(state))
  return { rng, state, out, playerAction, foeAction }
}

/** The same opening turn WITHOUT the Curse: the baseline that isolates Trick-or-Treat's own
 * MOVEEND dispatch from the Curse's, so the draw difference is the Curse dispatch alone. */
function trickOrTreatOnlyTurn(player: BattlerSpec, foe: BattlerSpec) {
  const rng = scriptedRng([0])
  const state = battle([player, foe], rng)
  executeTurn(state, [null, buildMoveAction(state, simData, 1, 'MOVE_TRICK_OR_TREAT')], turnDeps(state))
  return { rng, state }
}

/** The same drift with the fog gone by execution: the player picks Curse UNDER fog (so the
 * selection target is the foe, battle_controller_player.c:2391-2393) and the faster foe's
 * Sunny Day clears it before Curse runs. */
function fogDriftTurn(player: BattlerSpec, foe: BattlerSpec) {
  const rng = scriptedRng([0])
  const state = battle([player, foe], rng)
  state.field.weather = WEATHER_FOG_TEMPORARY
  const playerAction = buildMoveAction(state, simData, 0, 'MOVE_CURSE')
  const foeAction = buildMoveAction(state, simData, 1, 'MOVE_SUNNY_DAY')
  const out = executeTurn(state, [playerAction, foeAction], turnDeps(state))
  return { rng, state, out, playerAction }
}

function sunnyDayOnlyTurn(player: BattlerSpec, foe: BattlerSpec) {
  const rng = scriptedRng([0])
  const state = battle([player, foe], rng)
  state.field.weather = WEATHER_FOG_TEMPORARY
  executeTurn(state, [null, buildMoveAction(state, simData, 1, 'MOVE_SUNNY_DAY')], turnDeps(state))
  return { rng, state }
}

const foeSunnyDay = (overrides: BattlerSpec = {}): BattlerSpec => ({
  spe: 200,
  moves: ['MOVE_SUNNY_DAY', null, null, null],
  pp: [10, 0, 0, 0],
  ...overrides,
})

const playerCurse = (overrides: BattlerSpec = {}): BattlerSpec => ({
  spe: 50,
  moves: ['MOVE_CURSE', null, null, null],
  pp: [10, 0, 0, 0],
  ...overrides,
})
const foeTrickOrTreat = (overrides: BattlerSpec = {}): BattlerSpec => ({
  spe: 200,
  moves: ['MOVE_TRICK_OR_TREAT', null, null, null],
  pp: [20, 0, 0, 0],
  ...overrides,
})

// ---------------------------------------------------------------------------
// 1-6. getPlayerSelectedMoveTarget -- battle_controller_player.c:2385-2398.
// ---------------------------------------------------------------------------

describe('cycle 150hbd - getPlayerSelectedMoveTarget', () => {
  const helper = (state: BattleState, moveId: string, dataContext: SimDataContext = DATA_CONTEXT): number =>
    getPlayerSelectedMoveTarget(state, 0, moveId, dataContext.move(moveId), statusDepsFor(state), statusDepsFor(state))

  it('1: Rain Dance / Sunny Day / Sandstorm / Hail select the user without Forecast', () => {
    // battle_util.c:134-139 returns MOVE_TARGET_USER for these ids (plus Eerie Fog) unless the
    // battler has Forecast, and battle_controller_player.c:2397 tests the USER bit -> self.
    // moves.json declares each of them as SELECTED, so self can only come from the dynamic branch.
    const state = battle([{}, {}])
    for (const moveId of ['MOVE_RAIN_DANCE', 'MOVE_SUNNY_DAY', 'MOVE_SANDSTORM', 'MOVE_HAIL']) {
      expect(requireMove(moveId).target).toBe('SELECTED')
      expect(helper(state, moveId)).toBe(0)
    }
  })

  it('2: Rain Dance with Forecast falls through to the declared SELECTED target (foe)', () => {
    // `if (!BATTLER_HAS_ABILITY(battler, ABILITY_FORECAST)) return MOVE_TARGET_USER;` -- with
    // Forecast the function returns the static target, and SELECTED carries no USER bit.
    const state = battle([{ abilities: hasAbility('ABILITY_FORECAST') }, {}])
    expect(requireMove('MOVE_RAIN_DANCE').target).toBe('SELECTED')
    expect(helper(state, 'MOVE_RAIN_DANCE')).toBe(1)
  })

  it('3: ALL_BATTLERS (Haze, Trick Room) select the user; SELECTED (Tackle) selects the foe', () => {
    // ALL_BATTLERS is 0x100 | MOVE_TARGET_USER (battle.h:501), so the bit test fires.
    const state = battle([{}, {}])
    expect(requireMove('MOVE_HAZE').target).toBe('ALL_BATTLERS')
    expect(requireMove('MOVE_TRICK_ROOM').target).toBe('ALL_BATTLERS')
    expect(helper(state, 'MOVE_HAZE')).toBe(0)
    expect(helper(state, 'MOVE_TRICK_ROOM')).toBe(0)
    // Negative: a plain SELECTED move must not be turned into a self target.
    expect(requireMove('MOVE_TACKLE').target).toBe('SELECTED')
    expect(helper(state, 'MOVE_TACKLE')).toBe(1)
  })

  it('4: USER_OR_ALLY (Acupressure) selects the user', () => {
    // USER_OR_ALLY is USER | ALLY, so it carries the USER bit.
    const state = battle([{}, {}])
    expect(requireMove('MOVE_ACUPRESSURE').target).toBe('USER_OR_ALLY')
    expect(helper(state, 'MOVE_ACUPRESSURE')).toBe(0)
  })

  it('5: USER_OR_SELECTED keeps the foe on the player side (negative) and the user for the opponent', () => {
    // USER_OR_SELECTED is 0x2 and MOVE_TARGET_USER is 0x10: the player's bit test is clear, so
    // the player keeps the opposing side. The opponent's mask does contain USER_OR_SELECTED
    // (battle_controller_opponent.c:1600-1601), so the same static target is a self target there.
    const dataContext = dataContextWithTarget('MOVE_SWORDS_DANCE', 'USER_OR_SELECTED')
    const state = battle([{}, {}])
    expect(helper(state, 'MOVE_SWORDS_DANCE', dataContext)).toBe(1)
    // Opponent side (battler 1): self.
    expect(buildMoveAction(state, { ...simData, dataContext }, 1, 'MOVE_SWORDS_DANCE').target).toBe(1)
  })

  it('6: Curse -- non-Ghost self, Ghost foe, non-Ghost under fog foe', () => {
    // battle_controller_player.c:2389-2396.
    const nonGhost = battle([{}, {}])
    expect(helper(nonGhost, 'MOVE_CURSE')).toBe(0)

    const ghost = battle([{ types: ['GHOST', 'MYSTERY', 'MYSTERY'] }, {}])
    expect(helper(ghost, 'MOVE_CURSE')).toBe(1)

    const foggy = battle([{}, {}])
    foggy.field.weather = WEATHER_FOG_TEMPORARY
    expect(helper(foggy, 'MOVE_CURSE')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 7-10. buildMoveAction stores that id for the turn.
// ---------------------------------------------------------------------------

describe('cycle 150hbd - buildMoveAction stores the controller selection target', () => {
  it('7: player Curse -- non-Ghost self, Ghost foe, fog foe', () => {
    expect(buildMoveAction(battle([{}, {}]), simData, 0, 'MOVE_CURSE').target).toBe(0)

    const ghost = battle([{ types: ['GHOST', 'MYSTERY', 'MYSTERY'] }, {}])
    expect(buildMoveAction(ghost, simData, 0, 'MOVE_CURSE').target).toBe(1)

    const foggy = battle([{}, {}])
    foggy.field.weather = WEATHER_FOG_TEMPORARY
    expect(buildMoveAction(foggy, simData, 0, 'MOVE_CURSE').target).toBe(1)
  })

  it('8: player weather moves -- self without Forecast, foe with it', () => {
    expect(buildMoveAction(battle([{}, {}]), simData, 0, 'MOVE_RAIN_DANCE').target).toBe(0)
    expect(buildMoveAction(battle([{ abilities: hasAbility('ABILITY_FORECAST') }, {}]), simData, 0, 'MOVE_RAIN_DANCE').target).toBe(1)
  })

  it('9: player ALL_BATTLERS and USER_OR_ALLY moves are self targets; Tackle is not', () => {
    const state = battle([{}, {}])
    expect(buildMoveAction(state, simData, 0, 'MOVE_HAZE').target).toBe(0)
    expect(buildMoveAction(state, simData, 0, 'MOVE_ACUPRESSURE').target).toBe(0)
    expect(buildMoveAction(state, simData, 0, 'MOVE_TACKLE').target).toBe(1)
  })

  it('10: opponent static target bits -- all four self shapes, SELECTED stays on the foe', () => {
    // battle_controller_opponent.c:1600-1601: `target & (USER_OR_SELECTED | USER)` -> itself.
    const state = battle([{}, {}])
    const withUserOrSelected = { ...simData, dataContext: dataContextWithTarget('MOVE_SWORDS_DANCE', 'USER_OR_SELECTED') }
    expect(buildMoveAction(state, simData, 1, 'MOVE_SWORDS_DANCE').target).toBe(1) // USER
    expect(buildMoveAction(state, withUserOrSelected, 1, 'MOVE_SWORDS_DANCE').target).toBe(1) // USER_OR_SELECTED
    expect(buildMoveAction(state, simData, 1, 'MOVE_ACUPRESSURE').target).toBe(1) // USER_OR_ALLY
    expect(buildMoveAction(state, simData, 1, 'MOVE_TRICK_ROOM').target).toBe(1) // ALL_BATTLERS
    expect(buildMoveAction(state, simData, 1, 'MOVE_TACKLE').target).toBe(0) // SELECTED (negative)
    expect(buildMoveAction(state, simData, 1, 'MOVE_CURSE').target).toBe(0) // SELECTED, no Curse rule AI-side
  })
})

// ---------------------------------------------------------------------------
// 11-12. Execution-time drift: HandleAction_UseMove reads the stored target.
// ---------------------------------------------------------------------------

describe('cycle 150hbd - the stored selection target survives a mid-turn type change', () => {
  it('11: a non-Ghost Curse stays a self target when Trick-or-Treat adds GHOST first', () => {
    // The player selects Curse with no GHOST type and no fog, so
    // battle_controller_player.c:2395-2396 stores MOVE_TARGET_USER (battler 0). The faster foe's
    // Trick-or-Treat then makes the player part Ghost. HandleAction_UseMove (:242) reads the
    // stored 0 back, so MOVEEND_ABILITIES dispatches on the PLAYER, not on the foe the Curse
    // rule would pick if it were recomputed at execution.
    //
    // Draw accounting (Crispy Cream draws once per dispatch, abilities.cc:10837-10842). Each
    // drift turn is diffed against the same opening WITHOUT the Curse, so Trick-or-Treat's own
    // MOVEEND dispatch on the player cancels out and the difference is the Curse dispatch alone.
    const playerBaseline = trickOrTreatOnlyTurn(playerCurse({ abilities: CRISPY_CREAM }), foeTrickOrTreat())
    const playerDrift = driftTurn(playerCurse({ abilities: CRISPY_CREAM }), foeTrickOrTreat())
    expect(playerDrift.playerAction.target).toBe(0)
    expect(playerDrift.rng.calls - playerBaseline.rng.calls).toBe(1)

    const foeBaseline = trickOrTreatOnlyTurn(playerCurse(), foeTrickOrTreat({ abilities: CRISPY_CREAM }))
    const foeDrift = driftTurn(playerCurse(), foeTrickOrTreat({ abilities: CRISPY_CREAM }))
    expect(foeDrift.rng.calls - foeBaseline.rng.calls).toBe(0)
  })

  it('12: negative -- a Ghost selection stores the foe, so the foe is dispatched', () => {
    // A Ghost Curse takes the MOVE_TARGET_SELECTED branch (:2389-2394), so the stored target is
    // battler 1 and the player's holder draws only from Trick-or-Treat's dispatch.
    const ghostPlayer = (overrides: BattlerSpec = {}): BattlerSpec =>
      playerCurse({ types: ['GHOST', 'MYSTERY', 'MYSTERY'], ...overrides })

    const playerBaseline = trickOrTreatOnlyTurn(ghostPlayer({ abilities: CRISPY_CREAM }), foeTrickOrTreat())
    const playerDrift = driftTurn(ghostPlayer({ abilities: CRISPY_CREAM }), foeTrickOrTreat())
    expect(playerDrift.playerAction.target).toBe(1)
    expect(playerDrift.rng.calls - playerBaseline.rng.calls).toBe(0) // the player is not dispatched

    const foeBaseline = trickOrTreatOnlyTurn(ghostPlayer(), foeTrickOrTreat({ abilities: CRISPY_CREAM }))
    const foeDrift = driftTurn(ghostPlayer(), foeTrickOrTreat({ abilities: CRISPY_CREAM }))
    expect(foeDrift.rng.calls - foeBaseline.rng.calls).toBe(1) // Curse's dispatch on the foe
  })

  it('13: fog cleared before a fog-selected Curse runs keeps the stored foe target', () => {
    // Under fog the player selects Curse as MOVE_TARGET_SELECTED (battle_controller_player.c:2391-2393),
    // so the stored target is battler 1. The foe's faster Sunny Day removes the fog, which would
    // make a fresh reading of the Curse rule on the player side return MOVE_TARGET_USER. The C
    // does not re-read it (battle_util.c:242), so the dispatch still lands on the foe. This is
    // the direction that catches a restored re-derivation: it would move the dispatch to the
    // player and both counts below would flip.
    const playerBaseline = sunnyDayOnlyTurn(playerCurse({ abilities: CRISPY_CREAM }), foeSunnyDay())
    const playerDrift = fogDriftTurn(playerCurse({ abilities: CRISPY_CREAM }), foeSunnyDay())
    expect(playerDrift.playerAction.target).toBe(1)
    expect(playerDrift.rng.calls - playerBaseline.rng.calls).toBe(0)

    const foeBaseline = sunnyDayOnlyTurn(playerCurse(), foeSunnyDay({ abilities: CRISPY_CREAM }))
    const foeDrift = fogDriftTurn(playerCurse(), foeSunnyDay({ abilities: CRISPY_CREAM }))
    expect(foeDrift.rng.calls - foeBaseline.rng.calls).toBe(1)
  })
})
