/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 110c: held-item verification, the non-boss player-pool hold effects.
//
// Every expected number is hand-derived from the fixed-point arithmetic in
// web/src/engine/fixed.ts: uq(1.0) = 1024, uq(1.2) = 1228 (trunc(1.2 * 1024)),
// uq(1.5) = 1536; MulModifier(m, v) = floor((m*v + 512) / 1024) re-quantized at
// every call, ApplyModifier(m, v) = floor((m*v + 512) / 1024). The base damage is
// CalculateBaseDamage's `dmg = idiv(level*2, 5) + 2; dmg *= power; dmg *= atk;
// dmg = idiv(dmg, def); dmg = idiv(dmg, 50) + 2` (calculate.ts:1096-1100,
// battle_util.c:7226-7234); CalcFinalDmg applies its stages in finalDamage.ts's
// fixed order (battle_util.c:7517-7720). At level 50 the leading term is
// idiv(100, 5) + 2 = 22.
//
// The bridge resolver consumes RNG only where the C does: one accuracy draw
// (Cmd_accuracycheck), then the crit check, then the damage roll. These tests
// pass `critRoll` explicitly so the crit check costs exactly one deterministic
// value, and every resolver call here then draws exactly one damage roll.
import { describe, expect, it } from 'vitest'

import { calcDefenseStatModifiers } from '../battleStat'
import { calcCritStage, critChanceDenominator, type CritStageInputs } from '../crit'
import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_SPIKES,
  STAT_ATK,
  STAT_SPATK,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_SLEEP,
  STATUS1_TOXIC_COUNTER,
  STATUS2_CONFUSION,
  STATUS2_NIGHTMARE,
  STATUS3_EMBARGO,
} from './constants'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { createSession, groundingFor } from './driver/session'
import { applySwitchInHazards, type HazardDeps } from './hazards'
import { applyMoveEndItemEffectsAll } from './moveEnd'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { applyPrimaryStatusEffect, MOVE_EFFECT_BURN, MOVE_EFFECT_PARALYSIS, type StatusDeps } from './statusEffects'
import { switchIn } from './switchIn'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'
import { NEUTRAL_TURN_ORDER_CONTEXT, type ChosenAction, type TurnOrderMoveView } from './turnOrder'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const RATIOS = simData.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as { types: string[] } | undefined
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
    abilities: noAbility,
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

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

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
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

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(simData, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
  }
}

/** The real damage engine, reading hold effects from the live state. */
function bridgeDamage(state: BattleState): DamageResolver {
  return createBridgeDamageResolver({
    moveData: simData.moveData,
    typeChart: simData.typeChart,
    inverseTypeChart: simData.inverseTypeChart,
    moveBehaviors: simData.moveBehaviors,
    battleConstants: simData.battleConstants,
    random: state.rng,
    grounding: groundingFor(simData, state),
    turnOrder: TURN_ORDER,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  })
}

const nullResolver: DamageResolver = {
  resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
}

/** A one-number resolver. `isSuperEffective` is what Weakness Policy reads (MOVE_RESULT_SUPER_EFFECTIVE). */
function fixedDamage(amount: number, extra: { isSuperEffective?: boolean } = {}): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: extra.isSuperEffective ?? false,
    }),
  }
}

function actionOf(out: TurnOutcome, battlerId: number) {
  const action = out.actions.find((a) => a.battlerId === battlerId)
  if (!action) throw new Error(`no action for battler ${battlerId}`)
  return action
}

const statusDeps = (state: BattleState): StatusDeps => ({ dataContext: DATA_CONTEXT, grounding: groundingFor(simData, state) })
const hazardDeps = (state: BattleState): HazardDeps => ({ dataContext: DATA_CONTEXT, grounding: groundingFor(simData, state) })

// ---------------------------------------------------------------------------
// 1. Eviolite -- CalcDefenseStat's HOLD_EFFECT_EVIOLITE case, battle_util.c:7422-7424
// ---------------------------------------------------------------------------
describe('cycle 110c - Eviolite', () => {
  const evioliteDef = (canEvolveStrict: boolean, speciesId = 'SPECIES_MUDKIP') =>
    calcDefenseStatModifiers(100, {
      resolvedHoldEffect: 'HOLD_EFFECT_EVIOLITE',
      speciesId,
      baseSpeciesId: speciesId,
      isTransformed: false,
      canEvolveStrict,
      defStatToUse: 'def',
    })

  it('x1.5 defense for a species that can still evolve: 100 -> 150', () => {
    // :7423-7424: `CanEvolveStrict(species) && species != SPECIES_NECROZMA -> MulModifier(1.5)`.
    // uq(1.5) = 1536; ApplyModifier(1536, 100) = floor((153600 + 512) / 1024) = floor(150.5) = 150.
    expect(evioliteDef(true)).toBe(150)
  })

  it('no boost for a fully evolved species (CanEvolveStrict false): 100', () => {
    // Swampert has no entry in gEvolutionTable (species.json evolutions: []), so CanEvolveStrict
    // (:7309-7315) is FALSE and the switch case leaves modifier = uq(1.0) = 1024; 100 stays 100.
    expect(evioliteDef(false, 'SPECIES_SWAMPERT')).toBe(100)
  })

  it('no boost for Necrozma even though it has evolution entries (:7423 species != SPECIES_NECROZMA)', () => {
    // Necrozma's species rows carry form evolutions, so the sim's canEvolveStrict is true; the
    // C's own explicit exclusion keeps the modifier at 1024 -> 100.
    expect(evioliteDef(true, 'SPECIES_NECROZMA')).toBe(100)
  })

  it('end to end: Tackle does 13 instead of 19 through the real damage engine', () => {
    // base = 22 * 40 (Tackle) * 100 (Atk) / def / 50 + 2. def 100: 88000/100 = 880, /50 = 17, +2 = 19.
    // def 150: 88000/150 = 586, /50 = 11, +2 = 13. Type is Normal vs Water = 1x (1024), STAB none,
    // so CalcFinalDmg's accumulator is 1024 and ApplyModifier(1024, dmg) = dmg.
    const plain = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), countRng())
    const withItem = battle(
      monFor('SPECIES_MUDKIP'),
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_EVIOLITE' }),
      countRng(),
    )
    // critRoll 3: 3 % 24 != 0, so no crit on either side; the damage roll draw is 0 -> 100% roll.
    const plainRes = bridgeDamage(plain).resolve(plain, 0, 1, useMove(1, 'MOVE_TACKLE'), { targetHasActedThisTurn: false, critRoll: 3 })
    const itemRes = bridgeDamage(withItem).resolve(withItem, 0, 1, useMove(1, 'MOVE_TACKLE'), { targetHasActedThisTurn: false, critRoll: 3 })
    expect(plainRes.targetDamage).toBe(19)
    expect(itemRes.targetDamage).toBe(13)
  })
})

// ---------------------------------------------------------------------------
// 2. Lum Berry -- the three CURE_STATUS sites: move end :5975-6005, switch in
//    :5520-5560, end turn :5802-5845.
// ---------------------------------------------------------------------------
describe('cycle 110c - Lum Berry', () => {
  const lumState = (overrides: Partial<SimBattleMon> = {}, attacker: Partial<SimBattleMon> = {}) =>
    battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_THUNDER_WAVE', null, null, null], pp: [10, 0, 0, 0], ...attacker }),
      // Defender speed 50: moves second without a speed-tie draw, so the accuracy roll below is
      // the turn's FIRST draw (the claim the draw-order assertion pins).
      monFor('SPECIES_MUDKIP', {
        itemId: 'ITEM_LUM_BERRY',
        rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 },
        ...overrides,
      }),
      countRng(),
    )

  it('cures a status inflicted by the hit at move end and eats the berry', () => {
    // Thunder Wave is EFFECT_PARALYZE: status1 = STATUS1_PARALYSIS = 1 << 6 = 64 before the item
    // pass (move end runs ItemBattleEffects(ITEMEFFECT_MOVE_END) after the script, :4667). The C's
    // `status1 & STATUS1_ANY` (:5976) is true, so :6000-6001 zero status1/status2 and removeitem
    // (BattleScript_BerryCureChosenStatusRet, scripts:10825-10831) empties the slot.
    const state = lumState()
    const rng = state.rng as RandomSource & { calls: number }
    const out = executeTurn(state, [useMove(1, 'MOVE_THUNDER_WAVE'), null], loopDeps(state, nullResolver))
    expect(actionOf(out, 0).statusApplied).toEqual({ battlerId: 1, status: 'PARALYSIS' })
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
    // Draw order: Cmd_accuracycheck's 90% roll is the only draw; the item pass draws nothing.
    expect(rng.calls).toBe(1)
  })

  it('Unnerve blocks the cure and keeps the berry: paralysis stays at 64', () => {
    // :5976-5977: `overrideBerryRequirements || !IsUnnerveAbilityOnOpposingSide(battlerId)`.
    // STATUS1_PARALYSIS = 1 << 6 = 64; the item is still held.
    const state = lumState({}, { abilities: { ability: 'ABILITY_UNNERVE', innates: [null, null, null] } })
    executeTurn(state, [useMove(1, 'MOVE_THUNDER_WAVE'), null], loopDeps(state, nullResolver))
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LUM_BERRY')
  })

  it('Klutz negates the berry (GetBattlerHoldEffect(battler, TRUE)): paralysis stays at 64', () => {
    // IsItemNegated, battle_util.c:6520-6524, makes GetBattlerHoldEffect return HOLD_EFFECT_NONE,
    // so the move-end switch never reaches the CURE_STATUS case.
    const state = lumState({ abilities: { ability: 'ABILITY_KLUTZ', innates: [null, null, null] } })
    executeTurn(state, [useMove(1, 'MOVE_THUNDER_WAVE'), null], loopDeps(state, nullResolver))
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LUM_BERRY')
  })

  it('Embargo negates the berry too: paralysis stays at 64', () => {
    const state = lumState()
    state.battlers[1]!.statuses3 |= STATUS3_EMBARGO
    executeTurn(state, [useMove(1, 'MOVE_THUNDER_WAVE'), null], loopDeps(state, nullResolver))
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LUM_BERRY')
  })

  it('cures at end turn (ENDTURN_ITEMS1/ITEMS2 case, :5802-5845) without an HP result entry', () => {
    // A quiet turn reaches DoBattlerEndTurnEffects with no move-end pass, so only the :5802 case
    // can clear it: status1 64 -> 0, item removed, and the result channel (HP-only) gets no
    // battler-0 ITEM entry because no HP changed.
    const state = battle(
      monFor('SPECIES_MUDKIP', { status1: STATUS1_PARALYSIS, itemId: 'ITEM_LUM_BERRY' }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    const out = executeTurn(state, [null, null], loopDeps(state, nullResolver))
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(out.endTurn.some((e) => e.battlerId === 0 && e.effect === 'ITEM')).toBe(false)
  })

  it('cures confusion at move end (status2 & STATUS2_CONFUSION)', () => {
    // :5976 tests status2 & STATUS2_CONFUSION = 0x7 alongside STATUS1_ANY; :6001 clears it.
    const state = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_LUM_BERRY', status2: STATUS2_CONFUSION }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    const notes: string[] = []
    const out = applyMoveEndItemEffectsAll(state, loopDeps(state, nullResolver), notes)
    expect(state.battlers[0]!.mon.status2 & STATUS2_CONFUSION).toBe(0)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(out.statChanges).toEqual([])
    expect(notes).toEqual([])
  })

  it('sleep also clears NIGHTMARE (:5981-5984)', () => {
    // STATUS1_SLEEP = 0x7, STATUS2_NIGHTMARE = 1 << 27; both are cleared, and the party slot's
    // status1 is written back (EmitSetMonData, :6027).
    const state = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_LUM_BERRY', status1: STATUS1_SLEEP, status2: STATUS2_NIGHTMARE }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    applyMoveEndItemEffectsAll(state, loopDeps(state, nullResolver), [])
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.status2 & STATUS2_NIGHTMARE).toBe(0)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
  })

  it('a non-sleep cure leaves NIGHTMARE alone: the C clears it only inside the SLEEP branch', () => {
    // Hand-built state (Nightmare cannot coexist with paralysis in play) that pins the exact
    // branch: status1 64 is cured, status2's Nightmare bit (1 << 27) survives.
    const state = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_LUM_BERRY', status1: STATUS1_PARALYSIS, status2: STATUS2_NIGHTMARE }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    applyMoveEndItemEffectsAll(state, loopDeps(state, nullResolver), [])
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.status2 & STATUS2_NIGHTMARE).toBe(STATUS2_NIGHTMARE)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
  })

  it('a stale TOXIC_COUNTER alone does not trigger the cure (STATUS1_ANY omits it)', () => {
    // include/constants/battle.h:119-120 defines STATUS1_ANY without STATUS1_TOXIC_COUNTER, and
    // :5976 tests `status1 & STATUS1_ANY`; a mon whose TOXIC_POISON bit was cleared but whose
    // 4-bit counter (0xf00 = 3840) survives reads as statusless. The berry stays in the slot.
    const state = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_LUM_BERRY', status1: STATUS1_TOXIC_COUNTER }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    applyMoveEndItemEffectsAll(state, loopDeps(state, nullResolver), [])
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_TOXIC_COUNTER)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LUM_BERRY')
  })

  it('Ripen does not double the cure: one berry, one cure, no stat change', () => {
    // The CURE_STATUS case never calls HasRipenEffect (unlike StatRaiseBerry/ItemHealHp), so the
    // only observable is status1 64 -> 0 with one consumed berry and no statChanges entry.
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        itemId: 'ITEM_LUM_BERRY',
        status1: STATUS1_PARALYSIS,
        abilities: { ability: 'ABILITY_RIPEN', innates: [null, null, null] },
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    const out = applyMoveEndItemEffectsAll(state, loopDeps(state, nullResolver), [])
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(out.statChanges).toEqual([])
  })

  it('cures on switch-in (ITEMEFFECT_ON_SWITCH_IN, :5520-5560) and writes the party status', () => {
    // B_BERRIES_INSTANT is GEN_7 (battle_config.h:100) so :5521's `>= GEN_4` holds; the incoming
    // mon's party status1 64 becomes 0 and the berry is removed (:5558-5560, :5611).
    const party = buildPlayerParty(
      [
        { species: 'SPECIES_MUDKIP', level: 50, nature: 'NATURE_HARDY', ability: 'ABILITY_TORRENT', item: null, moves: ['MOVE_TACKLE', null, null, null] },
        { species: 'SPECIES_MUDKIP', level: 50, nature: 'NATURE_HARDY', ability: 'ABILITY_TORRENT', item: 'ITEM_LUM_BERRY', moves: ['MOVE_TACKLE', null, null, null] },
      ],
      50,
      simData,
    )
    const session = createSession({
      data: simData,
      playerParty: party,
      opponentTrainer: simData.trainersById.get('TRAINER_SAWYER_1')!,
      rng: createRandomSource(1),
    })
    session.state.sides[0].party[1]!.status1 = STATUS1_PARALYSIS
    switchIn(session.state, 0, 1, hazardDeps(session.state), [])
    expect(session.state.battlers[0]!.partyIndex).toBe(1)
    expect(session.state.battlers[0]!.mon.status1).toBe(0)
    expect(session.state.battlers[0]!.mon.itemId).toBeNull()
    expect(session.state.sides[0].party[1]!.status1).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Rocky Helmet -- ITEMEFFECT_TARGET case, battle_util.c:6160-6170
// ---------------------------------------------------------------------------
describe('cycle 110c - Rocky Helmet', () => {
  it('deals maxHp/6 to a contact attacker: 100 / 6 = 16', () => {
    // :6163-6164: TARGET_TURN_DAMAGED && IsMoveMakingContact(gCurrentMove, gBattlerAttacker) &&
    // IsBattlerAlive(attacker) && !MAGIC_GUARD -> gBattleMoveDamage = maxHP / 6 (floor), min 1.
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP', { itemId: 'ITEM_ROCKY_HELMET' }), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(20)))
    expect(state.battlers[0]!.mon.hp).toBe(84)
    expect(actionOf(out, 0).attackerDamage).toBe(16)
  })

  it('does not fire on a non-contact move (IsMoveMakingContact, :6554-6569)', () => {
    // Water Gun has no `contact` flag, so :6555-6559 returns FALSE and no damage is applied.
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP', { itemId: 'ITEM_ROCKY_HELMET' }), countRng())
    executeTurn(state, [useMove(1, 'MOVE_WATER_GUN'), null], loopDeps(state, fixedDamage(20)))
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Magic Guard on the attacker leaves it at full HP (:6163 !BATTLER_HAS_MAGIC_GUARD)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_MAGIC_GUARD', innates: [null, null, null] } }),
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_ROCKY_HELMET' }),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(20)))
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 4. Expert Belt -- CalcFinalDmg's attacker-item case, battle_util.c:7642-7645
// ---------------------------------------------------------------------------
describe('cycle 110c - Expert Belt', () => {
  const damageWith = (moveId: string, defender: SimBattleMon, itemId: string | null) => {
    const state = battle(monFor('SPECIES_MUDKIP', { itemId }), defender, countRng())
    return bridgeDamage(state).resolve(state, 0, 1, useMove(1, moveId), { targetHasActedThisTurn: false, critRoll: 3 }).targetDamage
  }

  it('x1.2 at exactly 2x effectiveness: Flamethrower 82 -> 98', () => {
    // Flamethrower: base = 22 * 90 * 100 / 100 / 50 + 2 = 41. Type 2x -> finalModifier
    // MulModifier(1024, 2048) = floor((2097152 + 512)/1024) = 2048; ApplyModifier(2048, 41) =
    // floor((83968 + 512)/1024) = 82. With the belt (:7643 `typeEffectivenessModifier >= uq(2.0)`):
    // MulModifier(2048, 1228) = floor((2514944 + 512)/1024) = 2456; ApplyModifier(2456, 41) =
    // floor((100696 + 512)/1024) = 98.
    expect(damageWith('MOVE_FLAMETHROWER', monFor('SPECIES_TREECKO'), 'ITEM_EXPERT_BELT')).toBe(98)
    expect(damageWith('MOVE_FLAMETHROWER', monFor('SPECIES_TREECKO'), null)).toBe(82)
  })

  it('x1.2 at 4x effectiveness: Ice Beam 164 -> 197', () => {
    // Ice Beam base 41 too. Type 4x -> 4096: ApplyModifier(4096, 41) = floor(168448/1024) = 164.
    // With the belt MulModifier(4096, 1228) = floor((5029888 + 512)/1024) = 4912;
    // ApplyModifier(4912, 41) = floor((201392 + 512)/1024) = 197.
    const dragonFlying = monFor('SPECIES_MUDKIP', { types: ['DRAGON', 'FLYING', 'MYSTERY'] })
    expect(damageWith('MOVE_ICE_BEAM', dragonFlying, 'ITEM_EXPERT_BELT')).toBe(197)
    expect(damageWith('MOVE_ICE_BEAM', dragonFlying, null)).toBe(164)
  })

  it('no boost at neutral effectiveness: Tackle stays 19', () => {
    // Normal vs Water is 1x (1024). With the belt the case at :7643 is not taken, so the
    // accumulator is 1024 and ApplyModifier(1024, 19) = 19 (had it applied, it would be
    // ApplyModifier(1228, 19) = floor((23332 + 512)/1024) = 23).
    expect(damageWith('MOVE_TACKLE', monFor('SPECIES_MUDKIP'), 'ITEM_EXPERT_BELT')).toBe(19)
    expect(damageWith('MOVE_TACKLE', monFor('SPECIES_MUDKIP'), null)).toBe(19)
  })
})

// ---------------------------------------------------------------------------
// 5. Heavy-Duty Boots -- IsBattlerAffectedByHazards, battle_util.c:8522-8530
// ---------------------------------------------------------------------------
describe('cycle 110c - Heavy-Duty Boots', () => {
  const spikesDamageFor = (itemId: string | null) => {
    const state = battle(monFor('SPECIES_MUDKIP', { itemId }), monFor('SPECIES_MUDKIP'), countRng())
    state.sides[0].statuses |= SIDE_STATUS_SPIKES
    state.sides[0].timers.spikesAmount = 1
    applySwitchInHazards(state, 0, hazardDeps(state), [])
    return 100 - state.battlers[0]!.mon.hp
  }

  it('one layer of Spikes deals 0 with the boots and 12 without', () => {
    // Spikes: (5 - spikesAmount) * 2 = (5 - 1) * 2 = 8; maxHp 100 / 8 = 12 (floor).
    // :8523: GetBattlerHoldEffect(battler, TRUE) == HOLD_EFFECT_HEAVY_DUTY_BOOTS returns FALSE from
    // IsBattlerAffectedByHazards, so the :8739 damage branch never runs.
    expect(spikesDamageFor('ITEM_HEAVY_DUTY_BOOTS')).toBe(0)
    expect(spikesDamageFor(null)).toBe(12)
  })
})

// ---------------------------------------------------------------------------
// 6. Scope Lens -- CalcCritChanceStage, battle_script_commands.c:1547-1555
// ---------------------------------------------------------------------------
describe('cycle 110c - Scope Lens', () => {
  const critInputs = (hasScopeLens: boolean): CritStageInputs => ({
    isBlocked: false,
    isGuaranteed: false,
    abilityCritBonus: 0,
    hasHighCritFlag: false,
    hasScopeLens,
    hasLuckyPunchOnChanseyLine: false,
    hasLeekOnFarfetchdLine: false,
    isViseGrip: false,
  })

  it('adds exactly one crit stage: denominator 24 -> 8 (sCriticalHitChance GEN_7 :1510)', () => {
    // :1547-1548: critChance += (high-crit flag) + (holdEffect == HOLD_EFFECT_SCOPE_LENS) + ...
    // Stage 0 indexes {24, 8, 2, 1, 1} at 24, stage 1 at 8 (:1560-1566).
    expect(calcCritStage(critInputs(false))).toBe(0)
    expect(critChanceDenominator(0, simData.battleConstants.criticalHitChance)).toBe(24)
    expect(calcCritStage(critInputs(true))).toBe(1)
    expect(critChanceDenominator(1, simData.battleConstants.criticalHitChance)).toBe(8)
  })

  it('critRoll 8 crits only with the lens: 29 vs 19 damage on Tackle', () => {
    // SetCritFlag (:1594): isCriticalHit = !(critRoll % critChance). 8 % 24 = 8 -> no crit;
    // 8 % 8 = 0 -> crit. Crit is stage #4, a DIRECT ApplyModifier(1536, dmg) before the final
    // modifier: ApplyModifier(1536, 19) = floor((29184 + 512)/1024) = 29; the 1x final modifier
    // then leaves 29. Without the lens the roll is the plain 19.
    const withLens = battle(monFor('SPECIES_MUDKIP', { itemId: 'ITEM_SCOPE_LENS' }), monFor('SPECIES_MUDKIP'), countRng())
    const without = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), countRng())
    const ctx = { targetHasActedThisTurn: false, critRoll: 8 }
    const lensRes = bridgeDamage(withLens).resolve(withLens, 0, 1, useMove(1, 'MOVE_TACKLE'), ctx)
    const plainRes = bridgeDamage(without).resolve(without, 0, 1, useMove(1, 'MOVE_TACKLE'), ctx)
    expect(lensRes.isCriticalHit).toBe(true)
    expect(lensRes.targetDamage).toBe(29)
    expect(plainRes.isCriticalHit).toBe(false)
    expect(plainRes.targetDamage).toBe(19)
  })

  it('a different item does not add a crit stage: Life Orb at critRoll 8 does not crit', () => {
    // The :1548 term is the hold-effect equality; Life Orb is STAT-raising-free and leaves the
    // denominator at 24, so 8 % 24 != 0. Its own 1.3x then applies: ApplyModifier(1331, 19) =
    // floor((25289 + 512)/1024) = 25.
    const state = battle(monFor('SPECIES_MUDKIP', { itemId: 'ITEM_LIFE_ORB' }), monFor('SPECIES_MUDKIP'), countRng())
    const res = bridgeDamage(state).resolve(state, 0, 1, useMove(1, 'MOVE_TACKLE'), { targetHasActedThisTurn: false, critRoll: 8 })
    expect(res.isCriticalHit).toBe(false)
    expect(res.targetDamage).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// 7. Covert Cloak -- SetMoveEffect's secondary-effect gate,
//    battle_script_commands.c:2348-2350, with IsPreventableSecondaryEffect :2240-2292
// ---------------------------------------------------------------------------
describe('cycle 110c - Covert Cloak', () => {
  it('blocks a secondary burn: status1 stays 0', () => {
    // primary = FALSE, affectsUser = FALSE, IsPreventableSecondaryEffect(MOVE_EFFECT_BURN) = TRUE
    // (:2245), so the Shield Dust / Covert Cloak gate at :2348-2350 returns without applying.
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP', { itemId: 'ITEM_COVERT_CLOAK' }), countRng())
    const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_BURN, 'MOVE_EMBER', statusDeps(state), [], false)
    expect(res.applied).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
  })

  it('without the cloak the same secondary applies STATUS1_BURN = 1 << 4 = 16', () => {
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), countRng())
    const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_BURN, 'MOVE_EMBER', statusDeps(state), [], false)
    expect(res.applied).toBe(true)
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
  })

  it('does not block a PRIMARY status (:2349 `!primary`): Thunder Wave paralysis applies', () => {
    // seteffectprimary passes primary = TRUE, so the gate is skipped even with the cloak; the
    // paralysis bit is STATUS1_PARALYSIS = 1 << 6 = 64.
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP', { itemId: 'ITEM_COVERT_CLOAK' }), countRng())
    const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_PARALYSIS, 'MOVE_THUNDER_WAVE', statusDeps(state), [], true)
    expect(res.applied).toBe(true)
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS)
  })
})

// ---------------------------------------------------------------------------
// 8. Salac Berry -- StatRaiseBerry, battle_util.c:5195-5215, via the move-end
//    HOLD_EFFECT_SPEED_UP case (:5907-5921)
// ---------------------------------------------------------------------------
describe('cycle 110c - Salac Berry', () => {
  const eat = (opts: { hp: number; itemId?: string | null; holderAbility?: string; foeAbility?: string; speedStage?: number }) => {
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        hp: opts.hp,
        maxHp: 100,
        itemId: opts.itemId === undefined ? 'ITEM_SALAC_BERRY' : opts.itemId,
        abilities: { ability: opts.holderAbility ?? null, innates: [null, null, null] },
      }),
      monFor('SPECIES_MUDKIP', { abilities: { ability: opts.foeAbility ?? null, innates: [null, null, null] } }),
      countRng(),
    )
    if (opts.speedStage !== undefined) state.battlers[0]!.mon.statStages[STAT_SPEED] = opts.speedStage
    const notes: string[] = []
    const out = applyMoveEndItemEffectsAll(state, loopDeps(state, nullResolver), notes)
    return { state, out, notes }
  }

  it('at exactly maxHp/4 (25/100) raises Speed one stage and is consumed, with no RNG draw', () => {
    // HasEnoughHpToEatBerry (:5153) `hp <= maxHP / hpFraction` with Salac's holdEffectStrength 4
    // (:5909 GetBattlerHoldEffectParam) -> 25 <= 25. SetStatChanger(STAT_SPEED, 1) (:5199-5202)
    // takes the neutral stage 6 to 7. No branch draws Random().
    const { state, out } = eat({ hp: 25 })
    const rng = state.rng as RandomSource & { calls: number }
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(out.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: 1 }])
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(rng.calls).toBe(0)
  })

  it('one HP above the threshold (26/100) is not eaten', () => {
    const { state, out } = eat({ hp: 26 })
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(out.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_SALAC_BERRY')
  })

  it('Gluttony raises the threshold to maxHp/2: 50/100 is eaten', () => {
    // :5158-5160: hpFraction <= 4 && Gluttony && isBerry && hp <= maxHP / 2.
    const { state } = eat({ hp: 50, holderAbility: 'ABILITY_GLUTTONY' })
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
  })

  it('Unnerve on the opposing side keeps the berry at 25/100', () => {
    // :5151-5152: isBerry && IsUnnerveAbilityOnOpposingSide -> FALSE from HasEnoughHpToEatBerry.
    const { state, out } = eat({ hp: 25, foeAbility: 'ABILITY_UNNERVE' })
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(out.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_SALAC_BERRY')
  })

  it('Ripen raises by two stages instead of one (:5197-5201 SetStatChanger(statId, 2))', () => {
    const { state, out } = eat({ hp: 25, holderAbility: 'ABILITY_RIPEN' })
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(out.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: 2 }])
    expect(state.battlers[0]!.mon.itemId).toBeNull()
  })

  it('is not eaten at +6 Speed: CanRaiseStat fails before HasEnoughHpToEatBerry (:5196)', () => {
    const { state, out } = eat({ hp: 25, speedStage: DEFAULT_STAT_STAGE + 6 })
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 6)
    expect(out.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_SALAC_BERRY')
  })
})

// ---------------------------------------------------------------------------
// 9. Weakness Policy -- ITEMEFFECT_TARGET case, battle_util.c:6171-6176, script
//    BattleScript_WeaknessPolicy (data/battle_scripts_1.s:7576-7600)
// ---------------------------------------------------------------------------
describe('cycle 110c - Weakness Policy', () => {
  const wpTurn = (opts: { isSuperEffective: boolean; attackerAbility?: string; atkStage?: number; spatkStage?: number }) => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: { ability: opts.attackerAbility ?? null, innates: [null, null, null] } }),
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_WEAKNESS_POLICY' }),
      countRng(),
    )
    if (opts.atkStage !== undefined) state.battlers[1]!.mon.statStages[STAT_ATK] = opts.atkStage
    if (opts.spatkStage !== undefined) state.battlers[1]!.mon.statStages[STAT_SPATK] = opts.spatkStage
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(20, { isSuperEffective: opts.isSuperEffective })))
    return { state, out }
  }

  it('a super-effective hit raises Atk and SpAtk by two and removes the item', () => {
    // :6172: IsBattlerAlive && TARGET_TURN_DAMAGED && MOVE_RESULT_SUPER_EFFECTIVE. The script
    // (:7583-7599) sets STAT_ATK 2 then STAT_SPATK 2 and reaches removeitem. Neutral stage 6 ->
    // 8 for both.
    const { state, out } = wpTurn({ isSuperEffective: true })
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
    expect(actionOf(out, 0).statChanges).toEqual([
      { battlerId: 1, stat: STAT_ATK, change: 2 },
      { battlerId: 1, stat: STAT_SPATK, change: 2 },
    ])
  })

  it('a non-super-effective hit leaves the stages at 6 and keeps the item', () => {
    const { state, out } = wpTurn({ isSuperEffective: false })
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_WEAKNESS_POLICY')
    // Nothing changed, so the action's own statChanges channel stays null.
    expect(actionOf(out, 0).statChanges).toBeNull()
  })

  it('Unnerve blocks the activation (jumpifconsumableblocked, VARIOUS_JUMP_IF_CONSUMABLE_BLOCKED :9024-9029)', () => {
    // The script's `jumpifconsumableblocked BS_TARGET, BattleScript_Return` is
    // IsUnnerveAbilityOnOpposingSide(gActiveBattler).
    const { state } = wpTurn({ isSuperEffective: true, attackerAbility: 'ABILITY_UNNERVE' })
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_WEAKNESS_POLICY')
  })

  it('both stats at +6 leaves the item in place (:7582 `jumpifstat ... STAT_SPATK MAX -> End`)', () => {
    const { state } = wpTurn({ isSuperEffective: true, atkStage: DEFAULT_STAT_STAGE + 6, spatkStage: DEFAULT_STAT_STAGE + 6 })
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 6)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 6)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_WEAKNESS_POLICY')
  })
})
