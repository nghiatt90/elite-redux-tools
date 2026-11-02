/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 128: the eight switching / pivot move effects. Every expected number is derived by hand from
// the pinned C named on the assertion that needs it: the script line in data/battle_scripts_1.s and the
// command in src/battle_script_commands.c / src/battle_util.c. Stat stages run 0..12 with neutral at 6,
// so a -2 drop is 6 -> 4 and "-6" in the C's own frame is stage 0 (MIN_STAT_STAGE).
import { describe, expect, it } from 'vitest'

import type { BridgeDeps } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ACC,
  STAT_ATK,
  STAT_SPATK,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_SUBSTITUTE,
  STATUS2_WRAPPED,
  STATUS3_GASTRO_ACID,
  STATUS3_ON_AIR,
  STATUS3_ROOTED,
  STATUS4_COMMANDED,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_SUN_PRIMAL,
  hasFlag,
} from './constants'
import { createBattleState, createBattlerState } from './create'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import { findAllowance } from './driver/auditAllowlist'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import { canBattlerEscape } from './escape'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ReplacementDeps } from './switchIn'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }
const only = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

/** A 200 Speed against the foe's default 100 keeps GetFastestBattler's speed-tie coin flip
 * (turnOrder.ts:583, and the same flip in fieldEndTurn.ts:443) out of the scripted draw arrays. */
const FAST_STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = SIM.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: noAbility,
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function partyMon(speciesId: string, overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId,
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    itemId: null,
    abilities: noAbility,
    rawStats: FAST_STATS,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

/** Every draw is 0 (accuracy always hits, no crit); `calls` counts draws. */
function countRng(): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return 0
    },
  }
  return rng
}

/** Draw the scripted values in order; 0 once the script runs out. `calls` counts draws. */
function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      const value = values[idx] ?? 0
      idx++
      return value
    },
  }
  return rng
}

function battle(
  a: SimBattleMon,
  b: SimBattleMon,
  rng: RandomSource,
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[] } = {},
): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
    ...(opts.playerParty ? { playerParty: opts.playerParty } : {}),
    ...(opts.opponentParty ? { opponentParty: opts.opponentParty } : {}),
  })
}

function useMove(target: number, moveId: string): ChosenAction {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  const view: TurnOrderMoveView = {
    id: m.id,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags,
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

/** The fixed-damage scripts overwrite the resolver's answer only when it is NON-ZERO (turn.ts:3130),
 * so `0` models a type-immune target and any positive number models a connected hit. */
const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }),
})

/** The real bridge resolver, only needed where a number depends on the damage formula (Beat Up). */
function bridgeDamage(state: BattleState, random: RandomSource): DamageResolver {
  const bridge: BridgeDeps = {
    grounding: groundingFor(SIM, state),
    turnOrder: TURN_ORDER,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  }
  const deps: BridgeDamageResolverDeps = {
    ...bridge,
    moveData: SIM.moveData,
    typeChart: SIM.typeChart,
    inverseTypeChart: SIM.inverseTypeChart,
    moveBehaviors: SIM.moveBehaviors,
    battleConstants: SIM.battleConstants,
    random,
  }
  return createBridgeDamageResolver(deps)
}

function loopDeps(state: BattleState, damage: DamageResolver, replacement?: ReplacementDeps): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(SIM, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: SIM.typeChart, inverseTypeChart: SIM.inverseTypeChart, inverseBattle: false },
    ...(replacement ? { replacement } : {}),
  }
}

/** The party-menu replacement: always the second party slot. */
const REPLACEMENT: ReplacementDeps = { chooseReplacement: () => 1 }

const THIS_FILE = 'web/src/engine/sim/cycle128SwitchEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)
const ppOf = (state: BattleState, battlerId = 0) => state.battlers[battlerId]!.mon.pp[0]

// BattleScript_EffectBatonPass data/battle_scripts_1.s:5266-5275, used for
// EFFECT_SWITCH_ARGUMENT (pipeline/.upstream/er-config/MoveBehaviorConfigList.textproto:742-744):
//   ppreduce (:5269); jumpifbattletype BATTLE_TYPE_ARENA (:5270);
//   jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER (:5271); scheduleswitch BS_ATTACKER (:5274).
// Cmd_jumpifcantswitch (src/battle_script_commands.c:5174-5184) is CanBattlerSwitch (:5061-5172):
// STATUS4_COMMANDED then "alive, non-egg reserve";
// SWITCH_IGNORE_ESCAPE_PREVENTION means CanBattlerEscape (battle_util.c) is NOT consulted.
describe('cycle 128 - Safe Passage / Teleport (EFFECT_SWITCH_ARGUMENT)', () => {
  const teleporter = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_TELEPORT', null, null, null], pp: [20, 0, 0, 0], ...overrides })
  const mudkipSlot = (overrides: Partial<SimPartyMon> = {}) =>
    partyMon('SPECIES_MUDKIP', { moves: ['MOVE_TELEPORT', null, null, null], pp: [20, 0, 0, 0], ...overrides })

  it('with a live reserve it switches the user out mid-turn and the outgoing slot carries the spent PP', () => {
    const state = battle(teleporter(), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [mudkipSlot(), partyMon('SPECIES_TREECKO')],
    })
    const out = executeTurn(state, [useMove(0, 'MOVE_TELEPORT'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(state.battlers[0]!.partyIndex).toBe(1)
    // ppreduce runs before scheduleswitch; Cmd_ppreduce writes the new PP back to the party mon.
    expect(state.sides[0].party[0]!.pp[0]).toBe(19)
  })

  it('with no live reserve it fails, spends one PP and stays in (:5271)', () => {
    const state = battle(teleporter(), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [mudkipSlot(), partyMon('SPECIES_TREECKO', { hp: 0 })],
    })
    const out = executeTurn(state, [useMove(0, 'MOVE_TELEPORT'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(ppOf(state)).toBe(19)
  })

  it('a trapping effect on the user cannot stop it: the switch ignores escape prevention', () => {
    const state = battle(teleporter(), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [mudkipSlot(), partyMon('SPECIES_TREECKO')],
    })
    state.battlers[0]!.mon.status2 = STATUS2_ESCAPE_PREVENTION
    // Control: an ordinary switch action would be refused here (battle_util.c's CanBattlerEscape).
    expect(canBattlerEscape(state, 0, { dataContext: DATA_CONTEXT, grounding: groundingFor(SIM, state) })).toBe(false)
    const out = executeTurn(state, [useMove(0, 'MOVE_TELEPORT'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
  })

  it('CanBattlerSwitch still refuses a commanded user even with a live reserve (STATUS4_COMMANDED, :5061-5172)', () => {
    const state = battle(teleporter(), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [mudkipSlot(), partyMon('SPECIES_TREECKO')],
    })
    state.battlers[0]!.statuses4 = STATUS4_COMMANDED
    const out = executeTurn(state, [useMove(0, 'MOVE_TELEPORT'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(ppOf(state)).toBe(19)
  })
})

// BattleScript_EffectRoar data/battle_scripts_1.s:3755-3774:
//   accuracycheck BattleScript_PrintMoveMissed (:3757); ppreduce (:3759);
//   jumpifroarfails (:3760, wild-doubles only, battle_script_commands.c:6761-6768 -- a no-op in singles);
//   jumpifabilityflag ABILITY_SUCTION_CUPS (:3761); jumpifstatus3 STATUS3_ROOTED (:3762);
//   jumpifstatus4 STATUS4_COMMANDED (:3763); jumpifbattletype ARENA (:3764); scheduleswitch BS_TARGET (:3772).
// Cmd_forcerandomswitch (battle_script_commands.c:10047-10196): singles (:10156-10163, minNeeded 1)
// counts the target's alive, non-egg party (:10164-10169) and redraws `Random() % 6` while it lands on the
// target's own slot or an empty / fainted slot (:10176-10181).
describe('cycle 128 - Roar (EFFECT_ROAR)', () => {
  const roarer = () =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_ROAR', null, null, null], pp: [20, 0, 0, 0] })
  // The reserves are deliberately slower than the Roar user: the post-switch move-order
  // recalculation (turnOrder.ts:583) and the end-of-turn sort (fieldEndTurn.ts:443) both
  // draw a random16() on a Speed tie, which would shift every scripted draw after them.
  const SLOW_RESERVE = { ...FAST_STATS, spe: 100 }
  const slug = (overrides: Partial<SimPartyMon> = {}) =>
    partyMon('SPECIES_MUDKIP', { rawStats: SLOW_RESERVE, ...overrides })
  const reserve = (speciesId: string, overrides: Partial<SimPartyMon> = {}) =>
    partyMon(speciesId, { rawStats: SLOW_RESERVE, ...overrides })

  it('redraws the own slot and picks the next accepted party slot (0 -> 2)', () => {
    // Draws: accuracy (0), slot 0 = the target's own slot (rejected), slot 2 (Machop, accepted).
    const rng = scriptedRng([0, 0, 2])
    const state = battle(roarer(), monFor('SPECIES_MUDKIP'), rng, {
      opponentParty: [slug(), reserve('SPECIES_TREECKO'), reserve('SPECIES_MACHOP')],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_MACHOP')
    expect(state.battlers[1]!.partyIndex).toBe(2)
    expect(rng.calls).toBe(3)
    expect(ppOf(state)).toBe(19)
  })

  it('a fainted slot is redrawn too (0 -> fainted 1 -> 2)', () => {
    const rng = scriptedRng([0, 1, 2])
    const state = battle(roarer(), monFor('SPECIES_MUDKIP'), rng, {
      opponentParty: [slug(), reserve('SPECIES_TREECKO', { hp: 0 }), reserve('SPECIES_MACHOP')],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_MACHOP')
    expect(rng.calls).toBe(3)
    expect(ppOf(state)).toBe(19)
  })

  it('with no reserve the draw is never made and nothing happens (:10162-10164 -> BattleScript_End)', () => {
    // validMons == 1 <= minNeeded, so the script jumps to BattleScript_End: no "but it failed", no switch.
    const rng = scriptedRng([0])
    const state = battle(roarer(), monFor('SPECIES_MUDKIP'), rng, { opponentParty: [slug()] })
    const out = executeTurn(state, [useMove(1, 'MOVE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(rng.calls).toBe(1) // accuracy only
    expect(ppOf(state)).toBe(19)
  })

  it('Ingrain (STATUS3_ROOTED) blocks the phase-out (:3762), PP still spent', () => {
    const rng = scriptedRng([0])
    const state = battle(roarer(), monFor('SPECIES_MUDKIP'), rng, {
      opponentParty: [slug(), reserve('SPECIES_TREECKO')],
    })
    state.battlers[1]!.statuses3 = STATUS3_ROOTED
    const out = executeTurn(state, [useMove(1, 'MOVE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(19)
  })

  it('Suction Cups (and the other suctionCups abilities) blocks the phase-out (:3761)', () => {
    const rng = scriptedRng([0])
    const state = battle(roarer(), monFor('SPECIES_MUDKIP', { abilities: only('ABILITY_SUCTION_CUPS') }), rng, {
      opponentParty: [slug(), reserve('SPECIES_TREECKO')],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(19)
  })

  it('a miss switches nobody and still spends one PP (BattleScript_PrintMoveMissed:3089-3094)', () => {
    // MOVE_ROAR's own accuracy is 0, so Cmd_accuracycheck's GetTotalAccuracy short-circuits to
    // HITS_IF_POSSIBLE (101); the only reachable miss is the semi-invulnerable branch (:1267-1282).
    const rng = scriptedRng([0])
    const state = battle(roarer(), monFor('SPECIES_MUDKIP'), rng, {
      opponentParty: [slug(), reserve('SPECIES_TREECKO')],
    })
    state.battlers[1]!.statuses3 = STATUS3_ON_AIR
    const out = executeTurn(state, [useMove(1, 'MOVE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(19)
  })

  it('never misses from the accuracy stage: accuracy 0 is HITS_IF_POSSIBLE, so a 99 roll still phases', () => {
    const rng = scriptedRng([99, 2])
    const state = battle(roarer(), monFor('SPECIES_MUDKIP'), rng, {
      opponentParty: [slug(), reserve('SPECIES_TREECKO'), reserve('SPECIES_MACHOP')],
    })
    state.battlers[0]!.mon.statStages[STAT_ACC] = MIN_STAT_STAGE
    const out = executeTurn(state, [useMove(1, 'MOVE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_MACHOP')
    expect(rng.calls).toBe(2)
  })
})

// BattleScript_EffectMemento data/battle_scripts_1.s:6111-6156. There is NO accuracycheck in this script.
// B_MEMENTO_FAIL is GEN_7 (include/constants/battle_config.h:78), so
// Cmd_jumpifattackandspecialattackcannotfall (src/battle_script_commands.c:11590-11610) takes the
// `#else` branch: protected / semi-invulnerable / substitute-blocked -> BattleScript_ButItFailed.
// The script's own later `jumpifsubstituteblocks` (:6120) is therefore unreachable for a substitute.
// Cmd_setatkhptozero (:9229-9238) then tryfaintmon BS_ATTACKER (:6139) makes the user faint.
describe('cycle 128 - Memento (EFFECT_MEMENTO)', () => {
  const mementoUser = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_MEMENTO', null, null, null], pp: [10, 0, 0, 0], ...overrides })
  const foe = (overrides: Partial<SimBattleMon> = {}) => monFor('SPECIES_MUDKIP', overrides)

  it('the user faints and the target loses two Atk and two SpAtk stages; no accuracy roll exists', () => {
    const rng = countRng()
    const state = battle(mementoUser(), foe(), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_MEMENTO'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(actionOf(out, 0)?.attackerDamage).toBe(100)
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 2)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE - 2)
    expect(ppOf(state)).toBe(9) // ppreduce :6115
    expect(rng.calls).toBe(0)
  })

  it('a target already at -6 / -6 still costs the user its life (GEN_7 branch: no stat check)', () => {
    const state = battle(mementoUser(), foe(), countRng())
    state.battlers[1]!.mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    state.battlers[1]!.mon.statStages[STAT_SPATK] = MIN_STAT_STAGE
    const out = executeTurn(state, [useMove(1, 'MOVE_MEMENTO'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(MIN_STAT_STAGE)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute makes it fail outright: the user survives with no drops (DoesSubstituteBlockMove, :11599)', () => {
    const state = battle(mementoUser(), foe(), countRng())
    state.battlers[1]!.mon.status2 = STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 25
    const out = executeTurn(state, [useMove(1, 'MOVE_MEMENTO'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state)).toBe(9)
  })

  it('Protect still costs the user its life: BattleScript_MementoFailProtect runs setatkhptozero (:6145-6156)', () => {
    const state = battle(mementoUser(), foe(), countRng())
    state.battlers[1]!.round.protectMove = 'MOVE_PROTECT'
    const out = executeTurn(state, [useMove(1, 'MOVE_MEMENTO'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state)).toBe(9)
  })

  it('Clear Body refuses the drops but the user still faints', () => {
    const state = battle(mementoUser(), foe({ abilities: only('ABILITY_CLEAR_BODY') }), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_MEMENTO'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
  })
})

// BattleScript_EffectBeatUp with B_BEAT_UP_DMG == GEN_8 (include/constants/battle_config.h:24), i.e. the
// `.else` branch data/battle_scripts_1.s:5775-5779: accuracycheck, then `addbyte gBattleCommunication, 1`
// per hit. CANCELLER_MULTIHIT_MOVES counts the attacker's live, non-egg, status-free party
// (src/battle_util.c:3523-3538) and the per-hit power comes from CalcBeatUpPower
// (`party[gBattleCommunication[0] - 1]`, battle_util.c:101-116).
// Damage at level 50, maximum roll, no crit: floor(floor(22 * P * A / D) / 50) + 2 with A = 100, D = 90.
//   P = floor(baseAtk / 10) + 5: Mudkip 75 -> 12 -> 7, Bulbasaur 49 -> 9 -> 6, Machop 80 -> 13 -> 8.
describe('cycle 128 - Beat Up (EFFECT_BEAT_UP)', () => {
  const beater = () =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_BEAT_UP', null, null, null], pp: [10, 0, 0, 0] })
  const slowFoe = () =>
    monFor('SPECIES_MUDKIP', { rawStats: { atk: 100, def: 90, spatk: 100, spdef: 100, spe: 100 } })

  it('three live party members give three hits, each powered by its own slot (7 + 6 + 8 = 21)', () => {
    // Draws: accuracy (50); hit 1 crit (1 = no crit), hit 1 roll (0 = maximum); then one crit roll after
    // every counted hit (:4885): 1, roll 0, 1, roll 0, 1.
    const rng = scriptedRng([50, 1, 0, 1, 0, 1, 0, 1])
    const state = battle(beater(), slowFoe(), rng, {
      playerParty: [partyMon('SPECIES_MUDKIP'), partyMon('SPECIES_BULBASAUR'), partyMon('SPECIES_MACHOP')],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_BEAT_UP'), null], loopDeps(state, bridgeDamage(state, rng)))
    expect(actionOf(out, 0)?.targetDamage).toBe(21)
    expect(state.battlers[1]!.mon.hp).toBe(79)
    expect(rng.calls).toBe(8)
  })

  it('the hit total skips a fainted slot but the power still comes from that slot: 7 + 6 = 13', () => {
    // The fainted Bulbasaur lowers the hit count to 2, but hit 2 is powered by party slot 1 (still
    // Bulbasaur's base Attack); Machop's slot 2 is never reached.
    const rng = scriptedRng([50, 1, 0, 1, 0, 1])
    const state = battle(beater(), slowFoe(), rng, {
      playerParty: [partyMon('SPECIES_MUDKIP'), partyMon('SPECIES_BULBASAUR', { hp: 0 }), partyMon('SPECIES_MACHOP')],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_BEAT_UP'), null], loopDeps(state, bridgeDamage(state, rng)))
    expect(actionOf(out, 0)?.targetDamage).toBe(13)
    expect(state.battlers[1]!.mon.hp).toBe(87)
    expect(rng.calls).toBe(6)
  })

  it('a single-mon party hits exactly once for its own power (7)', () => {
    const rng = scriptedRng([50, 1, 0, 1])
    const state = battle(beater(), slowFoe(), rng, { playerParty: [partyMon('SPECIES_MUDKIP')] })
    const out = executeTurn(state, [useMove(1, 'MOVE_BEAT_UP'), null], loopDeps(state, bridgeDamage(state, rng)))
    expect(actionOf(out, 0)?.targetDamage).toBe(7)
    expect(state.battlers[1]!.mon.hp).toBe(93)
    expect(rng.calls).toBe(4)
  })
})

// BattleScript_EffectNobleRoar data/battle_scripts_1.s:1772-1798:
//   ppreduce (:1775); jumpifstat BS_TARGET STAT_ATK > MIN -> do the move (:1776);
//   jumpifstat BS_TARGET STAT_SPATK == MIN -> BattleScript_CantLowerMultipleStats (:1777);
//   accuracycheck (:1779); then the two -1 statbuffchange calls (:1786, :1793).
// So both stats at MIN fails WITHOUT an accuracy roll, and only-Atk-at-MIN still rolls and drops SpAtk.
describe('cycle 128 - Noble Roar (EFFECT_NOBLE_ROAR)', () => {
  const roarer = () =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_NOBLE_ROAR', null, null, null], pp: [20, 0, 0, 0] })
  const foe = (overrides: Partial<SimBattleMon> = {}) => monFor('SPECIES_MUDKIP', overrides)

  it('drops Atk and SpAtk by one stage each after one accuracy roll', () => {
    const rng = countRng()
    const state = battle(roarer(), foe(), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_NOBLE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(19)
  })

  it('only Atk at -6 still drops SpAtk (:1776 -> :1777 falls through to the accuracy check)', () => {
    const rng = countRng()
    const state = battle(roarer(), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    const out = executeTurn(state, [useMove(1, 'MOVE_NOBLE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    // The blocked Atk drop reports MISSED: B_MSG_STAT_WONT_DECREASE and B_MSG_STAT_WONT_INCREASE are both
    // index 2 of their respective tables (include/constants/battle_string_ids.h:1088,1097), so the
    // `MULTISTRING_CHOOSER == B_MSG_STAT_WONT_INCREASE` test at battle_script_commands.c:9942 fires for a
    // blocked decrease too and sets MOVE_RESULT_MISSED. The SpAtk drop still happens.
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(rng.calls).toBe(1)
  })

  it('both stats at -6 fails with no accuracy roll at all', () => {
    const rng = countRng()
    const state = battle(roarer(), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    state.battlers[1]!.mon.statStages[STAT_SPATK] = MIN_STAT_STAGE
    const out = executeTurn(state, [useMove(1, 'MOVE_NOBLE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(MIN_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(19) // ppreduce :1775 already ran
  })

  it('Mist blocks both drops but not the PP cost', () => {
    const state = battle(roarer(), foe(), countRng())
    state.sides[1]!.timers.mistTimer = 5
    const out = executeTurn(state, [useMove(1, 'MOVE_NOBLE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state)).toBe(19)
  })

  it('Clear Body blocks both drops but not the PP cost', () => {
    const state = battle(roarer(), foe({ abilities: only('ABILITY_CLEAR_BODY') }), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_NOBLE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state)).toBe(19)
  })

  it('a miss drops nothing and still spends one PP (:1779 -> BattleScript_ButItFailed)', () => {
    const rng = scriptedRng([99])
    const state = battle(roarer(), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ACC] = MIN_STAT_STAGE // 100% -> 33%
    const out = executeTurn(state, [useMove(1, 'MOVE_NOBLE_ROAR'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(19)
  })
})

// BattleScript_EffectShedTail data/battle_scripts_1.s:5351-5369:
//   ppreduce (:5354); STATUS2_SUBSTITUTE -> AlreadyHasSubstitute (:5356); arena (:5357);
//   jumpifcantswitch (:5358); setsubstitute (:5359); BattleScript_MoveSwitchOpenPartyScreen (:5369).
// Cmd_setsubstitute (src/battle_script_commands.c:10535-10555) with EFFECT_SHED_TAIL:
//   hp = max(maxHP / 4, 1); damage = max(maxHP / 2, 1); fails if hp <= damage.
// SwitchInClearSetData (src/battle_main.c:2834-2837, 2890-2892) hands ONLY STATUS2_SUBSTITUTE and
// substituteHP to the incoming mon: everything else (stat stages, other volatiles) is rebuilt fresh.
describe('cycle 128 - Shed Tail (EFFECT_SHED_TAIL)', () => {
  const shedder = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_SHED_TAIL', null, null, null],
      pp: [10, 0, 0, 0],
      hp: 200,
      maxHp: 200,
      ...overrides,
    })
  const shedderSlot = (overrides: Partial<SimPartyMon> = {}) =>
    partyMon('SPECIES_MUDKIP', {
      moves: ['MOVE_SHED_TAIL', null, null, null],
      pp: [10, 0, 0, 0],
      hp: 200,
      maxHp: 200,
      ...overrides,
    })

  it('maxHP 200: pays 100 HP, the replacement keeps a 50 HP substitute and nothing else', () => {
    const state = battle(shedder(), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [shedderSlot(), partyMon('SPECIES_TREECKO')],
    })
    state.battlers[0]!.mon.status2 = STATUS2_WRAPPED
    state.battlers[0]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 2
    // A Stockpile volatile proves the same point as Taunt would without cancelling a status move.
    state.battlers[0]!.volatiles.stockpileCounter = 2
    const out = executeTurn(state, [useMove(0, 'MOVE_SHED_TAIL'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(actionOf(out, 0)?.attackerDamage).toBe(100) // maxHP / 2
    expect(state.sides[0].party[0]!.hp).toBe(100) // 200 - 100
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(state.battlers[0]!.volatiles.substituteHp).toBe(50) // maxHP / 4
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(true)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
    expect(state.battlers[0]!.volatiles.stockpileCounter).toBe(0) // no Baton Pass carry-over
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.sides[0].party[0]!.pp[0]).toBe(9)
  })

  it('HP <= half the max fails with no HP lost, no substitute and no switch (:10542-10544)', () => {
    const state = battle(shedder({ hp: 100 }), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [shedderSlot({ hp: 100 }), partyMon('SPECIES_TREECKO')],
    })
    const out = executeTurn(state, [useMove(0, 'MOVE_SHED_TAIL'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(state.battlers[0]!.volatiles.substituteHp).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('an existing substitute fails before the HP cost is paid (:5356)', () => {
    const state = battle(shedder(), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [shedderSlot(), partyMon('SPECIES_TREECKO')],
    })
    state.battlers[0]!.mon.status2 = STATUS2_SUBSTITUTE
    state.battlers[0]!.volatiles.substituteHp = 25
    const out = executeTurn(state, [useMove(0, 'MOVE_SHED_TAIL'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(200)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(ppOf(state)).toBe(9)
  })

  it('with no live reserve it fails before the HP cost (:5358)', () => {
    const state = battle(shedder(), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [shedderSlot(), partyMon('SPECIES_TREECKO', { hp: 0 })],
    })
    const out = executeTurn(state, [useMove(0, 'MOVE_SHED_TAIL'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(200)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectChillyReception data/battle_scripts_1.s:5298-5315:
//   ppreduce (:5302); arena / jumpifcantswitch -> _FailIfPrimal (:5303-5305);
//   _FailIfPrimal: checkprimalweather -> ButItFailed (:5307);
//     setbattleweather HAIL, ButItFailed, TRUE (:5308); goto MoveSwitch.
//   _NoFail (can switch): checkprimalweather -> MoveSwitch (:5312);
//     setbattleweather HAIL, MoveSwitch, FALSE (:5313); goto MoveSwitch (:5314).
// TryChangeBattleWeather (src/battle_util.c:3721-3746) fails when the weather is already active and,
// for a non-primal weather, when a primal weather is up; the success sets duration 8 (12 with Icy Rock).
describe('cycle 128 - Chilly Reception (EFFECT_CHILLY_RECEPTION)', () => {
  const chiller = () =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_CHILLY_RECEPTION', null, null, null], pp: [10, 0, 0, 0] })
  const chillerSlot = () =>
    partyMon('SPECIES_MUDKIP', { moves: ['MOVE_CHILLY_RECEPTION', null, null, null], pp: [10, 0, 0, 0] })
  const foe = () => monFor('SPECIES_MUDKIP')

  it('switches out and sets 8 turns of hail when no weather is up', () => {
    const state = battle(chiller(), foe(), countRng(), {
      playerParty: [chillerSlot(), partyMon('SPECIES_TREECKO')],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_CHILLY_RECEPTION'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.field.weather).toBe(WEATHER_HAIL_TEMPORARY)
    expect(state.field.weatherDuration).toBe(8)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(state.sides[0].party[0]!.pp[0]).toBe(9)
  })

  it('when hail is already up it still switches (setbattleweather failure jumps to MoveSwitch, :5313)', () => {
    const state = battle(chiller(), foe(), countRng(), {
      playerParty: [chillerSlot(), partyMon('SPECIES_TREECKO')],
    })
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.weatherDuration = 8
    const out = executeTurn(state, [useMove(1, 'MOVE_CHILLY_RECEPTION'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.field.weather).toBe(WEATHER_HAIL_TEMPORARY)
    // The hail was already up BEFORE this turn, so gFieldTimers.started.weather is false and
    // ENDTURN_HAIL ticks the counter once (fieldEndTurn.ts:644-651, battle_util.c:2013-2020).
    expect(state.field.weatherDuration).toBe(7)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
  })

  it('with no reserve and no hail it sets hail and succeeds without switching (:5308-5309)', () => {
    const state = battle(chiller(), foe(), countRng(), {
      playerParty: [chillerSlot(), partyMon('SPECIES_TREECKO', { hp: 0 })],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_CHILLY_RECEPTION'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.field.weather).toBe(WEATHER_HAIL_TEMPORARY)
    expect(state.field.weatherDuration).toBe(8)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(ppOf(state)).toBe(9)
  })

  it('with no reserve and hail already up it fails (:5308 -> BattleScript_ButItFailed)', () => {
    const state = battle(chiller(), foe(), countRng(), {
      playerParty: [chillerSlot(), partyMon('SPECIES_TREECKO', { hp: 0 })],
    })
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.weatherDuration = 3
    const out = executeTurn(state, [useMove(1, 'MOVE_CHILLY_RECEPTION'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.field.weather).toBe(WEATHER_HAIL_TEMPORARY)
    // Pre-existing hail also ticks down once at the end of this turn (3 -> 2).
    expect(state.field.weatherDuration).toBe(2)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(ppOf(state)).toBe(9)
  })

  it('under a primal weather it switches but sets no hail (:5312 checkprimalweather -> MoveSwitch)', () => {
    const state = battle(chiller(), foe(), countRng(), {
      playerParty: [chillerSlot(), partyMon('SPECIES_TREECKO')],
    })
    state.field.weather = WEATHER_SUN_PRIMAL
    state.field.weatherDuration = 255
    const out = executeTurn(state, [useMove(1, 'MOVE_CHILLY_RECEPTION'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.field.weather).toBe(WEATHER_SUN_PRIMAL)
    expect(state.field.weatherDuration).toBe(255)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
  })
})

// BattleScript_SepticSwitch data/battle_scripts_1.s:12602-12620:
//   accuracycheck (:12604); ppreduce (:12606); setgastroacid -> _FailIfNoSwitch (:12607).
// Cmd_setgastroacid (src/battle_script_commands.c:11831-11838) fails when STATUS3_GASTRO_ACID is already
// set or the target has an ability shield; the failure branch is
//   jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER, BattleScript_ButItFailed (:12617),
// i.e. "already suppressed + a live reserve" still switches, but "already suppressed + no reserve" fails.
describe('cycle 128 - Septic Switch (EFFECT_SEPTIC_SWITCH)', () => {
  const septicker = () =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_SEPTIC_SWITCH', null, null, null], pp: [20, 0, 0, 0] })
  const septickerSlot = () =>
    partyMon('SPECIES_MUDKIP', { moves: ['MOVE_SEPTIC_SWITCH', null, null, null], pp: [20, 0, 0, 0] })
  const foe = () => monFor('SPECIES_MUDKIP')

  it('suppresses the target and switches the user out (:12608-12615)', () => {
    const rng = countRng()
    const state = battle(septicker(), foe(), rng, {
      playerParty: [septickerSlot(), partyMon('SPECIES_TREECKO')],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_SEPTIC_SWITCH'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(state.sides[0].party[0]!.pp[0]).toBe(19)
    expect(rng.calls).toBe(1) // accuracy only
  })

  it('an already suppressed target takes the failure branch, which still switches (:12616-12620)', () => {
    const state = battle(septicker(), foe(), countRng(), {
      playerParty: [septickerSlot(), partyMon('SPECIES_TREECKO')],
    })
    state.battlers[1]!.statuses3 = STATUS3_GASTRO_ACID
    const out = executeTurn(state, [useMove(1, 'MOVE_SEPTIC_SWITCH'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
  })

  it('with no reserve and no suppression it suppresses without switching', () => {
    const state = battle(septicker(), foe(), countRng(), {
      playerParty: [septickerSlot(), partyMon('SPECIES_TREECKO', { hp: 0 })],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_SEPTIC_SWITCH'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(ppOf(state)).toBe(19)
  })

  it('with no reserve and an already suppressed target it fails (:12617)', () => {
    const state = battle(septicker(), foe(), countRng(), {
      playerParty: [septickerSlot(), partyMon('SPECIES_TREECKO', { hp: 0 })],
    })
    state.battlers[1]!.statuses3 = STATUS3_GASTRO_ACID
    const out = executeTurn(state, [useMove(1, 'MOVE_SEPTIC_SWITCH'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(ppOf(state)).toBe(19)
  })

  it('a miss does neither: no suppression, no switch, PP still spent (:12604 -> PrintMoveMissed)', () => {
    const rng = scriptedRng([99])
    const state = battle(septicker(), foe(), rng, {
      playerParty: [septickerSlot(), partyMon('SPECIES_TREECKO')],
    })
    state.battlers[0]!.mon.statStages[STAT_ACC] = MIN_STAT_STAGE // 100% -> 33%
    const out = executeTurn(state, [useMove(1, 'MOVE_SEPTIC_SWITCH'), null], loopDeps(state, fixedDamage(0), REPLACEMENT))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(19)
  })
})

describe('cycle 128 - registry', () => {
  const SHIPPED_EFFECTS = [
    'EFFECT_SWITCH_ARGUMENT',
    'EFFECT_ROAR',
    'EFFECT_MEMENTO',
    'EFFECT_BEAT_UP',
    'EFFECT_NOBLE_ROAR',
    'EFFECT_SHED_TAIL',
    'EFFECT_CHILLY_RECEPTION',
    'EFFECT_SEPTIC_SWITCH',
  ]

  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })

  it('none of these effects is allowlisted: every one of them is singles-observable', () => {
    for (const effect of SHIPPED_EFFECTS) expect(findAllowance(effect)).toBeUndefined()
  })

  it.each([
    ['MOVE_SAFE_PASSAGE', 'EFFECT_SWITCH_ARGUMENT'],
    ['MOVE_TELEPORT', 'EFFECT_SWITCH_ARGUMENT'],
    ['MOVE_ROAR', 'EFFECT_ROAR'],
    ['MOVE_MEMENTO', 'EFFECT_MEMENTO'],
    ['MOVE_BEAT_UP', 'EFFECT_BEAT_UP'],
    ['MOVE_NOBLE_ROAR', 'EFFECT_NOBLE_ROAR'],
    ['MOVE_SHED_TAIL', 'EFFECT_SHED_TAIL'],
    ['MOVE_CHILLY_RECEPTION', 'EFFECT_CHILLY_RECEPTION'],
    ['MOVE_SEPTIC_SWITCH', 'EFFECT_SEPTIC_SWITCH'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})

