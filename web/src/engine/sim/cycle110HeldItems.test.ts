/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 110: held-item verification, first 12 boss hold effects.
//
// Every expected number below is derived from the fixed-point arithmetic in
// web/src/engine/fixed.ts: ER's UQ_4_12 has TEN-bit precision, so uq(1.0) = 1024,
// uq(0.5) = 512, uq(1.3) = 1331, uq(1.6) = 1638; ApplyModifier(m, v) = floor((m*v + 512) / 1024)
// and MulModifier re-quantises with the same rounding (fixed.ts, from global.h:113-139 and
// battle_util.c:6808-6812). The base damage is CalculateBaseDamage's
// `dmg = idiv(level*2, 5) + 2; dmg *= power; dmg *= atk; dmg = idiv(dmg, def); dmg = idiv(dmg, 50) + 2`
// (calculate.ts:1096-1100, battle_util.c:7226-7234), and CalcFinalDmg applies its stages in
// finalDamage.ts's fixed order (battle_util.c:7517-7720).
import { describe, expect, it } from 'vitest'

import { attackItemModifier, calcDefenseStatModifiers } from '../battleStat'
import { getTotalAccuracy } from './accuracy'
import { buildAccuracyInputs } from './accuracyBridge'
import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_SPATK,
  STAT_SPDEF,
  STATUS3_EMBARGO,
  STATUS3_HEAL_BLOCK,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
} from './constants'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { createSession } from './driver/session'
import { legalChoices } from './driver/expectimax'
import { aiDamageDepsFor } from './driver/session'
import { groundingFor } from './driver/session'
import { computeMoveLimitations } from './ai/aiMoveLimitations'
import { PARADOX_BOOSTER_ENERGY, PARADOX_WEATHER_ACTIVE } from './onWeather'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { getHighestStatId } from './statBuffs'
import { applySwitchInAbilities } from './switchInAbility'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'
import {
  NEUTRAL_TURN_ORDER_CONTEXT,
  TOTAL_SPEED_FULL,
  getBattlerTotalSpeedStat,
  type ChosenAction,
  type TurnOrderContext,
  type TurnOrderMoveView,
} from './turnOrder'

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

/** The real damage engine, reading hold effects from the state being fought over
 * (driver/session.ts's groundingFor binds GetBattlerHoldEffect(battler, TRUE) to it). */
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

function actionOf(out: TurnOutcome, battlerId: number) {
  const action = out.actions.find((a) => a.battlerId === battlerId)
  if (!action) throw new Error(`no action for battler ${battlerId}`)
  return action
}

const attackItem = (resolvedHoldEffect: string | null, baseSpeciesId: string, isPhysical = true, isSpecial = false) =>
  attackItemModifier({ resolvedHoldEffect, baseSpeciesId, isPhysical, isSpecial })

const defenseItem = (resolvedHoldEffect: string | null, defStatToUse: 'atk' | 'def' | 'spatk' | 'spdef' | 'spe') =>
  calcDefenseStatModifiers(100, {
    resolvedHoldEffect,
    speciesId: 'SPECIES_MUDKIP',
    baseSpeciesId: 'SPECIES_MUDKIP',
    isTransformed: false,
    canEvolveStrict: false,
    defStatToUse,
  })

// ---------------------------------------------------------------------------
// 1. Leftovers -- ENDTURN_ITEMS1 case HOLD_EFFECT_LEFTOVERS, battle_util.c:5706-5715
// ---------------------------------------------------------------------------
describe('cycle 110 - Leftovers', () => {
  it('heals maxHp/16 with a floor of 1 when maxHp < 16', () => {
    // battle_util.c:5707-5711: heal only when hp < maxHP, CanBattlerHeal() and !moveTurn;
    // gBattleMoveDamage = maxHP / 16; if (gBattleMoveDamage == 0) gBattleMoveDamage = 1.
    // maxHp 15: idiv(15, 16) = 0 -> 1, so 10 + 1 = 11.
    const state = battle(monFor('SPECIES_MUDKIP', { hp: 10, maxHp: 15, itemId: 'ITEM_LEFTOVERS' }), monFor('SPECIES_MUDKIP'), countRng())
    const out = executeTurn(state, [null, null], loopDeps(state, nullResolver))
    expect(state.battlers[0]!.mon.hp).toBe(11)
    expect(out.endTurn).toContainEqual({ battlerId: 0, effect: 'ITEM', hpChange: 1, fainted: false })
  })

  it('does nothing at full HP (hp < maxHP gate)', () => {
    const state = battle(monFor('SPECIES_MUDKIP', { hp: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }), monFor('SPECIES_MUDKIP'), countRng())
    const out = executeTurn(state, [null, null], loopDeps(state, nullResolver))
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(out.endTurn.some((e) => e.effect === 'ITEM' && e.battlerId === 0)).toBe(false)
  })

  it('does nothing while Heal Block is active (CanBattlerHeal, battle_util.c:8983-8984)', () => {
    const state = battle(monFor('SPECIES_MUDKIP', { hp: 10, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }), monFor('SPECIES_MUDKIP'), countRng())
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    executeTurn(state, [null, null], loopDeps(state, nullResolver))
    expect(state.battlers[0]!.mon.hp).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// 2. Focus Sash -- Cmd_adjustdamage, battle_script_commands.c:1626-1710
// ---------------------------------------------------------------------------
describe('cycle 110 - Focus Sash', () => {
  it('multi-hit move: hit 1 is saved from full HP and eats the sash, hit 2 hits a non-full-HP target and KOs', () => {
    // :1639-1644: the sash is set only when holdEffect == FOCUS_SASH, !IsUnnerveAbilityOnOpposingSide and
    // BATTLER_MAX_HP, checked afresh on each hit. Hit 1: 150 damage vs 100 HP with a full-HP target ->
    // gBattleMoveDamage = hp - 1 = 99 (BattleScript_HangedOnMsg then removeitem, s:10962-10964), leaving 1 HP.
    // Hit 2: hp (1) != maxHP, so no sash; 150 damage KOs. C calls Cmd_adjustdamage once per hit.
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), countRng())
    // defender overrides (rawStats untouched, item set, SPE 50 so it moves second and no tie draw happens)
    state.battlers[1]!.mon.itemId = 'ITEM_FOCUS_SASH'
    state.battlers[1]!.mon.rawStats.spe = 50
    const hps: number[] = []
    const damage: DamageResolver = {
      resolve(state) {
        hps.push(state.battlers[1]!.mon.hp)
        return { targetDamage: 150, attackerDamage: null, unmodelled: [] }
      },
    }

    const out = executeTurn(state, [useMove(1, 'MOVE_DOUBLE_HIT'), null], loopDeps(state, damage))
    expect(hps).toEqual([100, 1])
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
    // 99 (clipped) + 150 (second hit) = 249
    expect(actionOf(out, 0).targetDamage).toBe(249)
  })

  it('EFFECT_FALSE_SWIPE clips the hit to hp-1 even without Endure, and a full-HP sash holder still consumes it', () => {
    // :1668-1674: `move != EFFECT_FALSE_SWIPE && !forceFalseSwipeEffect` is one of the early-outs; a False Swipe
    // hits the `gBattleMoveDamage = hp - 1` path regardless of Endure. 150 damage vs 100 HP -> 99 damage, 1 HP.
    // :1683-1688: FOE_HUNG_ON (set because the sash branch at :1642-1646 fired) makes BattleScript_HangedOnMsg
    // remove the sash even though False Swipe, not the sash, is what stopped the KO (s:10958-10965).
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP', { itemId: 'ITEM_FOCUS_SASH' }), scriptedRng([0, 99]))
    state.battlers[1]!.mon.rawStats.spe = 50
    const damage: DamageResolver = { resolve: () => ({ targetDamage: 150, attackerDamage: null, unmodelled: [] }) }
    executeTurn(state, [useMove(1, 'MOVE_FALSE_SWIPE'), null], loopDeps(state, damage))
    expect(state.battlers[1]!.mon.hp).toBe(1)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('EFFECT_FALSE_SWIPE clips the hit with no sash at all', () => {
    // Same :1668-1674 branch, no item on the defender.
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), scriptedRng([0, 99]))
    state.battlers[1]!.mon.rawStats.spe = 50
    const damage: DamageResolver = { resolve: () => ({ targetDamage: 150, attackerDamage: null, unmodelled: [] }) }
    executeTurn(state, [useMove(1, 'MOVE_FALSE_SWIPE'), null], loopDeps(state, damage))
    expect(state.battlers[1]!.mon.hp).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Life Orb -- attack multiplier battle_util.c:7650-7652, recoil battle_util.c:6082-6105
// ---------------------------------------------------------------------------
describe('cycle 110 - Life Orb', () => {
  it('multiplies final damage by 1.3 (19 -> 25) and deals maxHp/10 recoil', () => {
    // Tackle: (idiv(100,5)+2)=22; 22*40*100/100=880; idiv(880,50)+2=19. Final modifiers: type eff 1.0 and no STAB,
    // so CalcFinalDmg applies attackerItem 1331 to 19: ApplyModifier(1331, 19) = floor((25289+512)/1024) = 25.
    // Every other stage is identity (no crit: crit roll 1 is not divisible by the 24 denominator).
    // Roll: Random()%16 = 0 -> the 16-entry ascending 85%..100% table is indexed 15-r (battle_util.c:7790-7795),
    // so 15-0 = 15 is the 100% roll.
    const rngFree = scriptedRng([0, 1, 0])
    const plain = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), rngFree)
    plain.battlers[1]!.mon.rawStats.spe = 50
    const outPlain = executeTurn(plain, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(plain, bridgeDamage(plain)))
    expect(actionOf(outPlain, 0).targetDamage).toBe(19)

    const rng = scriptedRng([0, 1, 0])
    const state = battle(monFor('SPECIES_MUDKIP', { itemId: 'ITEM_LIFE_ORB' }), monFor('SPECIES_MUDKIP'), rng)
    state.battlers[1]!.mon.rawStats.spe = 50
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, bridgeDamage(state)))
    expect(actionOf(out, 0).targetDamage).toBe(25)
    // battle_util.c:6087-6093 + moveEnd.ts: `gBattleMoveDamage = maxHP / 10; if 0 then 1` -> 100/10 = 10.
    expect(state.battlers[0]!.mon.hp).toBe(90)
    expect(state.battlers[1]!.mon.hp).toBe(75)
  })

  it('still boosts damage but deals no recoil under Magic Guard (REQUIRE_NOT at battle_util.c:6100)', () => {
    // The 1.3x lives in CalcFinalDmg (:7651) and is not gated by Magic Guard; only the recoil REQUIRE is.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        itemId: 'ITEM_LIFE_ORB',
        abilities: { ability: 'ABILITY_MAGIC_GUARD', innates: [null, null, null] },
      }),
      monFor('SPECIES_MUDKIP'),
      rng,
    )
    state.battlers[1]!.mon.rawStats.spe = 50
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, bridgeDamage(state)))
    expect(actionOf(out, 0).targetDamage).toBe(25)
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 4. Resist berries -- battle_util.c:7664-7679 (halving) and :6130-6240 (consume)
// ---------------------------------------------------------------------------
describe('cycle 110 - resist berries (Occa/Kasib)', () => {
  // Flamethrower: (idiv(100,5)+2)=22; 22*90*100/100=1980; idiv(1980,50)+2=41.
  // Fire vs Grass is 2.0x, so CalcFinalDmg's typeEffectiveness stage multiplies the accumulator 1024 -> 2048
  // (MulModifier(1024, 2048) = 2048) before the berry stage:
  //   base      ApplyModifier(2048, 41) = floor((83968+512)/1024) = 82
  //   Occa      MulModifier(2048, uq(0.5)=512) = floor((1048576+512)/1024) = 1024 -> ApplyModifier(1024, 41) = 41
  //   Ripen     MulModifier(2048, uq(0.25)=256) = floor((524288+512)/1024) = 512 -> ApplyModifier(512, 41) = 21
  // NO STAB (Mudkip is WATER using a FIRE move); the drawn roll index is 0, i.e. the 100% entry (15-0).
  const flamethrowerCase = (defenderOverride: Partial<SimBattleMon>, attackerOverride: Partial<SimBattleMon> = {}) => {
    const rng = scriptedRng([0, 1, 0, 99])
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_FLAMETHROWER', null, null, null], pp: [15, 0, 0, 0], ...attackerOverride }),
      monFor('SPECIES_MUDKIP', { types: ['GRASS', 'MYSTERY', 'MYSTERY'], ...defenderOverride }),
      rng,
    )
    state.battlers[1]!.mon.rawStats.spe = 50
    const out = executeTurn(state, [useMove(1, 'MOVE_FLAMETHROWER'), null], loopDeps(state, bridgeDamage(state)))
    return { state, damage: actionOf(out, 0).targetDamage }
  }

  it('Occa Berry halves a super-effective Fire hit (82 -> 41) and is consumed', () => {
    const { state, damage } = flamethrowerCase({ itemId: 'ITEM_OCCA_BERRY' })
    expect(damage).toBe(41)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('Sugar Rush doubles the reduction through the `ripen` flag (82 -> 21), abilities.cc:8163', () => {
    // HasRipenEffect (battle_util.c:5162-5165) tests the flag, not the ability id: SUGAR_RUSH (abilities.cc:8163),
    // APPLE_PIE (:8879) and RIPEN (:12280) all carry it.
    const { state, damage } = flamethrowerCase({
      itemId: 'ITEM_OCCA_BERRY',
      abilities: { ability: 'ABILITY_SUGAR_RUSH', innates: [null, null, null] },
    })
    expect(damage).toBe(21)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('Kasib Berry halves a super-effective Ghost hit only for Ghost moves (type mismatch = no berry)', () => {
    // ItemId_GetSecondaryId == moveType (:7666): Kasib's holdEffectType is TYPE_GHOST, so Fire does not match.
    const { state, damage } = flamethrowerCase({ itemId: 'ITEM_KASIB_BERRY' })
    expect(damage).toBe(82)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_KASIB_BERRY')
  })

  it('Unnerve on the attacker blocks both the halving and the consume, including via As One (abilities.cc:3631)', () => {
    // IsUnnerveAbilityOnOpposingSide(defender) (:7667) reads the `unnerve` flag; As One Ice Rider carries it.
    const { state, damage } = flamethrowerCase(
      { itemId: 'ITEM_OCCA_BERRY' },
      { abilities: { ability: 'ABILITY_AS_ONE_ICE_RIDER', innates: [null, null, null] } },
    )
    expect(damage).toBe(82)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_OCCA_BERRY')
  })
})

// ---------------------------------------------------------------------------
// 5. Assault Vest -- SpDef x1.5 battle_util.c:7425-7428; status-move lock :1571-1578 / :1651-1653
// ---------------------------------------------------------------------------
describe('cycle 110 - Assault Vest', () => {
  it('multiplies SpDef by 1.5 but leaves Def alone', () => {
    // CalcDefenseStat :7446-7448: MulModifier(uq(1.0), uq(1.5)) = 1536;
    // ApplyModifier(1536, 100) = floor((153600+512)/1024) = 150. Def is not touched (100).
    expect(defenseItem('HOLD_EFFECT_ASSAULT_VEST', 'spdef')).toBe(150)
    expect(defenseItem('HOLD_EFFECT_ASSAULT_VEST', 'def')).toBe(100)
    // Tactical Vest is the physical mirror (:7449-7451).
    expect(defenseItem('HOLD_EFFECT_TACTICAL_VEST', 'def')).toBe(150)
    expect(defenseItem('HOLD_EFFECT_TACTICAL_VEST', 'spdef')).toBe(100)
  })

  it('a vest holder cannot pick a status move on the player side, except Me First', () => {
    // battle_util.c:1571-1578 (player selection) and :1651-1653 (CheckMoveLimitations) reject
    // IS_MOVE_STATUS(move) && move != MOVE_ME_FIRST for HOLD_EFFECT_ASSAULT_VEST/TACTICAL_VEST;
    // both read GetBattlerHoldEffect(battler, TRUE) (:1418, :1623), so Klutz/Embargo lift the block.
    // MOVE_TOXIC is a real STATUS move in this dataset (Growl is a 60-power SPECIAL attack here).
    const moves = ['MOVE_TACKLE', 'MOVE_TOXIC', 'MOVE_ME_FIRST', null] as SimBattleMon['moves']
    const sessionFor = (ability: string) => {
      const party = buildPlayerParty(
        [{ species: 'SPECIES_MUDKIP', level: 50, nature: 'NATURE_HARDY', ability, item: 'ITEM_ASSAULT_VEST', moves }],
        50,
        simData,
      )
      return createSession({
        data: simData,
        playerParty: party,
        opponentTrainer: simData.trainersById.get('TRAINER_SAWYER_1')!,
        rng: createRandomSource(1),
      })
    }
    const chosen = (session: ReturnType<typeof sessionFor>) =>
      legalChoices(session).map((choice) => choice.action.chosenMove?.id ?? null)

    expect(chosen(sessionFor('ABILITY_TORRENT'))).toEqual(['MOVE_TACKLE', 'MOVE_ME_FIRST'])

    // Klutz negates the vest, so the full menu comes back.
    expect(chosen(sessionFor('ABILITY_KLUTZ'))).toEqual(['MOVE_TACKLE', 'MOVE_TOXIC', 'MOVE_ME_FIRST'])

    const embargoed = sessionFor('ABILITY_TORRENT')
    embargoed.state.battlers[0]!.statuses3 |= STATUS3_EMBARGO
    expect(chosen(embargoed)).toEqual(['MOVE_TACKLE', 'MOVE_TOXIC', 'MOVE_ME_FIRST'])
  })

  it('CheckMoveLimitations masks the vest holder\'s status slot for the AI (battle_util.c:1647-1648)', () => {
    // Empty slot 3 is always unusable (:1634), so the bits are 0b1010: slot 1 (MOVE_TOXIC) is the only
    // STATUS move and is not Me First; slots 0 (Tackle) and 2 (Me First) stay usable.
    const moves = ['MOVE_TACKLE', 'MOVE_TOXIC', 'MOVE_ME_FIRST', null] as SimBattleMon['moves']
    const maskFor = (ability: string) => {
      const party = buildPlayerParty(
        [{ species: 'SPECIES_MUDKIP', level: 50, nature: 'NATURE_HARDY', ability, item: 'ITEM_ASSAULT_VEST', moves }],
        50,
        simData,
      )
      const session = createSession({
        data: simData,
        playerParty: party,
        opponentTrainer: simData.trainersById.get('TRAINER_SAWYER_1')!,
        rng: createRandomSource(1),
      })
      return computeMoveLimitations(session.state, 0, aiDamageDepsFor(simData, session.state)).mask
    }
    expect(maskFor('ABILITY_TORRENT')).toBe(0b1010)
    // GetBattlerHoldEffect(battler, TRUE) (:1623) negates the vest under Klutz, so only the empty slot is masked.
    expect(maskFor('ABILITY_KLUTZ')).toBe(0b1000)
  })
})

// ---------------------------------------------------------------------------
// 6. Gems -- base power battle_util.c:7019-7022; consumption battle_main.c:5222-5262 + battle_script_commands.c:1687-1690
// ---------------------------------------------------------------------------
describe('cycle 110 - Dragon Gem', () => {
  // Dragon Claw: 22*90*100/100 = 1980; idiv(1980,50)+2 = 41 at type effectiveness 1.0 and no STAB.
  // The gem boosts BASE POWER by holdEffectStrength 50%: MulModifier(1024, 1024+512=1536) = 1536;
  // ApplyModifier(1536, 90) = floor((138240+512)/1024) = 135 -> 22*135 = 2970 -> idiv(2970,50)+2 = 61.
  const dragonClaw = (overrides: { itemId?: string | null; ability?: string; embargo?: boolean; defenderAbility?: string }) => {
    const rng = scriptedRng([0, 1, 0, 99])
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        itemId: overrides.itemId ?? 'ITEM_DRAGON_GEM',
        moves: ['MOVE_DRAGON_CLAW', null, null, null],
        pp: [15, 0, 0, 0],
        abilities: overrides.ability ? { ability: overrides.ability, innates: [null, null, null] } : noAbility,
      }),
      monFor('SPECIES_MUDKIP', {
        abilities: overrides.defenderAbility ? { ability: overrides.defenderAbility, innates: [null, null, null] } : noAbility,
      }),
      rng,
    )
    state.battlers[1]!.mon.rawStats.spe = 50
    if (overrides.embargo) state.battlers[0]!.statuses3 |= STATUS3_EMBARGO
    const out = executeTurn(state, [useMove(1, 'MOVE_DRAGON_CLAW'), null], loopDeps(state, bridgeDamage(state)))
    return { state, damage: actionOf(out, 0).targetDamage }
  }

  it('boosts a matching Dragon move and is consumed after the hit', () => {
    const { state, damage } = dragonClaw({})
    expect(damage).toBe(61)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
  })

  it('is not consumed by a non-matching move type (Tackle, Normal)', () => {
    // ItemId_GetSecondaryId(ITEM_DRAGON_GEM) = TYPE_DRAGON != TYPE_NORMAL, so gemBoost stays FALSE
    // (battle_main.c:5228-5233) and the post-damage check (:1687-1690) does not fire.
    const rng = scriptedRng([0, 1, 0, 99])
    const state = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_DRAGON_GEM' }),
      monFor('SPECIES_MUDKIP'),
      rng,
    )
    state.battlers[1]!.mon.rawStats.spe = 50
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, bridgeDamage(state)))
    // 19, unchanged: the gem only boosts the matching type.
    expect(actionOf(out, 0).targetDamage).toBe(19)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_DRAGON_GEM')
  })

  it('is still consumed when the hit is clipped to 0 by Endure at 1 HP (battle_script_commands.c:1689-1691)', () => {
    // The gem check only tests MOVE_RESULT_NO_EFFECT, so the clipped `gBattleMoveDamage == 0` does not spare
    // the item. 1 HP + endured -> Cmd_adjustdamage sets damage to hp-1 = 0; the gem is consumed anyway.
    const rng = scriptedRng([0, 1, 0, 99])
    const state = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_DRAGON_GEM', moves: ['MOVE_DRAGON_CLAW', null, null, null], pp: [15, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      rng,
    )
    state.battlers[1]!.mon.rawStats.spe = 50
    state.battlers[1]!.mon.hp = 1
    state.battlers[1]!.round.endured = true
    const out = executeTurn(state, [useMove(1, 'MOVE_DRAGON_CLAW'), null], loopDeps(state, bridgeDamage(state)))
    expect(actionOf(out, 0).targetDamage).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(1)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
  })

  it('is not consumed by a status move of the matching type (Dragon Dance)', () => {
    // Cmd_adjustdamage is only reached by damaging moves; SetTypeBeforeUsingMove may still set gemBoost for
    // Dragon Dance, but nothing consumes it (the item is checked only at battle_script_commands.c:1687-1690).
    const rng = scriptedRng([])
    const state = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_DRAGON_GEM', moves: ['MOVE_DRAGON_DANCE', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      rng,
    )
    state.battlers[1]!.mon.rawStats.spe = 50
    executeTurn(state, [useMove(0, 'MOVE_DRAGON_DANCE'), null], loopDeps(state, bridgeDamage(state)))
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_DRAGON_GEM')
  })

  it('is not consumed when the defender has Unnerve (battle_main.c:5229)', () => {
    const { state, damage } = dragonClaw({ defenderAbility: 'ABILITY_UNNERVE' })
    expect(damage).toBe(41)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_DRAGON_GEM')
  })

  it('is inert under the holder\'s Klutz (GetBattlerHoldEffect(TRUE))', () => {
    const { state, damage } = dragonClaw({ ability: 'ABILITY_KLUTZ' })
    expect(damage).toBe(41)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_DRAGON_GEM')
  })

  it('is inert under Embargo (IsItemNegated, battle_util.c:6519-6524)', () => {
    const { state, damage } = dragonClaw({ embargo: true })
    expect(damage).toBe(41)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_DRAGON_GEM')
  })
})

// ---------------------------------------------------------------------------
// 7. Light Ball -- CalcAttackStat battle_util.c:7271-7285
// ---------------------------------------------------------------------------
describe('cycle 110 - Light Ball', () => {
  it('doubles Pikachu-family attack stats and gives 1.6x to the partner forms', () => {
    // The C's if-chain, one branch per species (:7272-7284):
    //   SPECIES_PIKACHU 2.0 -> MulModifier(1024, 2048) = 2048
    //   SPECIES_PICHU / PICHU_SPIKY_EARED 2.0 -> 2048
    //   SPECIES_PIKACHU_PARTNER_MEGA 1.6 -> MulModifier(1024, 1638) = 1638
    //   any other species -> the 1024 initial modifier, unchanged.
    expect(attackItem('HOLD_EFFECT_LIGHT_BALL', 'SPECIES_PICHU')).toBe(2048)
    expect(attackItem('HOLD_EFFECT_LIGHT_BALL', 'SPECIES_PICHU_SPIKY_EARED')).toBe(2048)
    expect(attackItem('HOLD_EFFECT_LIGHT_BALL', 'SPECIES_PIKACHU_PARTNER_MEGA')).toBe(1638)
    expect(attackItem('HOLD_EFFECT_LIGHT_BALL', 'SPECIES_MUDKIP')).toBe(1024)
  })

  it('applies on special moves too (the C has no split gate)', () => {
    // GetBaseSpeciesFromMega(Pikachu Partner Mega) still returns SPECIES_PIKACHU_PARTNER; the switch has no
    // IS_MOVE_PHYSICAL / IS_MOVE_SPECIAL test at all, so a special attacker keeps the same modifier.
    expect(attackItem('HOLD_EFFECT_LIGHT_BALL', 'SPECIES_PIKACHU_PARTNER_MEGA', false, true)).toBe(1638)
  })
})

// ---------------------------------------------------------------------------
// 8. Booster Energy -- GetHighestStatIdExcept battle_util.c:8724-8746, abilities.cc:6942-7012
// ---------------------------------------------------------------------------
describe('cycle 110 - Booster Energy', () => {
  const boosterDeps = (state: BattleState) => ({ grounding: groundingFor(simData, state), dataContext: DATA_CONTEXT, statStageRatios: RATIOS })

  it('tie-break: the first of the equal highest stats wins (Attack before Defense)', () => {
    // GetHighestStatIdExcept walks STAT_ATK..STAT_SPDEF in enum order with a strict `>`, so with atk = def = 120
    // and the rest 100 the loop keeps STAT_ATK (STAT_ATK = 1 in constants.ts).
    const state = battle(monFor('SPECIES_MUDKIP', { rawStats: { atk: 120, def: 120, spatk: 100, spdef: 100, spe: 100 } }), monFor('SPECIES_MUDKIP'), countRng())
    expect(getHighestStatId(state, 0, RATIOS)).toBe(STAT_ATK)

    // A strictly higher later stat still wins: spdef 130 > atk 120 -> STAT_SPDEF.
    state.battlers[0]!.mon.rawStats.spdef = 130
    expect(getHighestStatId(state, 0, RATIOS)).toBe(STAT_SPDEF)
  })

  it('consumes Booster Energy and boosts the highest stat; with sun it boosts from the weather instead', () => {
    // abilities.cc:6942-6956: without sun (and no item) the handler fails; with the item it calls
    // ActivateParadoxBoost(..., PARADOX_BOOSTER_ENERGY) and eats the item. abilityState packs the stat as
    // (GetHighestStatId(battler, TRUE) << 2) | flag, so a tie at the top gives (STAT_ATK << 2) | 1 = 5.
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        itemId: 'ITEM_BOOSTER_ENERGY',
        abilities: { ability: 'ABILITY_PROTOSYNTHESIS', innates: [null, null, null] },
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    applySwitchInAbilities(state, 0, boosterDeps(state), [])
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(PARADOX_BOOSTER_ENERGY | (STAT_ATK << 2))
    expect(state.battlers[0]!.mon.itemId).toBeNull()

    // In sun the weather branch already boosts, so the item is never eaten (abilities.cc:6948-6954).
    const sunny = battle(
      monFor('SPECIES_MUDKIP', {
        itemId: 'ITEM_BOOSTER_ENERGY',
        abilities: { ability: 'ABILITY_PROTOSYNTHESIS', innates: [null, null, null] },
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    sunny.field.weather = WEATHER_SUN_TEMPORARY
    applySwitchInAbilities(sunny, 0, boosterDeps(sunny), [])
    expect(sunny.battlers[0]!.volatiles.abilityState[0]).toBe(PARADOX_WEATHER_ACTIVE | (STAT_ATK << 2))
    expect(sunny.battlers[0]!.mon.itemId).toBe('ITEM_BOOSTER_ENERGY')
  })
})

// ---------------------------------------------------------------------------
// 9. Choice Scarf -- getBattlerTotalSpeedStat battle_main.c:4216-4224
// ---------------------------------------------------------------------------
describe('cycle 110 - Choice Scarf', () => {
  const speedCtx = (state: BattleState): TurnOrderContext => ({
    ...TURN_ORDER,
    holdEffectOf: groundingFor(simData, state).holdEffectOf,
  })
  const speed = (state: BattleState) => getBattlerTotalSpeedStat(state, 0, TOTAL_SPEED_FULL, null, speedCtx(state), RATIOS)

  it('multiplies Speed by 1.5 (100 -> 150) and outruns a 140-Speed foe', () => {
    // :4220: `speed = (speed * 150) / 100` with no stat stages and no other modifiers -> 15000/100 = 150.
    const state = battle(monFor('SPECIES_MUDKIP', { itemId: 'ITEM_CHOICE_SCARF' }), monFor('SPECIES_MUDKIP'), countRng())
    state.battlers[1]!.mon.rawStats.spe = 140
    expect(speed(state)).toBe(150)
    expect(getBattlerTotalSpeedStat(state, 1, TOTAL_SPEED_FULL, null, speedCtx(state), RATIOS)).toBe(140)
  })

  it('is negated by Klutz and Embargo (GetBattlerHoldEffect(battler, TRUE), :4193)', () => {
    const klutz = battle(
      monFor('SPECIES_MUDKIP', {
        itemId: 'ITEM_CHOICE_SCARF',
        abilities: { ability: 'ABILITY_KLUTZ', innates: [null, null, null] },
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    expect(speed(klutz)).toBe(100)

    const embargoed = battle(monFor('SPECIES_MUDKIP', { itemId: 'ITEM_CHOICE_SCARF' }), monFor('SPECIES_MUDKIP'), countRng())
    embargoed.battlers[0]!.statuses3 |= STATUS3_EMBARGO
    expect(speed(embargoed)).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 10. Weakness Policy -- MOVEEND_ITEM_EFFECTS_TARGET battle_util.c:6169-6179
// ---------------------------------------------------------------------------
describe('cycle 110 - Weakness Policy', () => {
  it('does nothing (and keeps the item) at +6 Attack and +6 SpAtk', () => {
    // The script's stat changes are no-ops at the cap; jumpifsecondarystatus-only consumption is not reached,
    // so the item stays (battle_scripts_1.s:7576-7600).
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP', { itemId: 'ITEM_WEAKNESS_POLICY' }), countRng())
    state.battlers[1]!.mon.rawStats.spe = 50
    state.battlers[1]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 6
    state.battlers[1]!.mon.statStages[STAT_SPATK] = DEFAULT_STAT_STAGE + 6
    const damage: DamageResolver = {
      resolve: () => ({ targetDamage: 40, attackerDamage: null, unmodelled: [], isSuperEffective: true }),
    }
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, damage))
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 6)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 6)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_WEAKNESS_POLICY')
  })

  it('is blocked by the attacker\'s Unnerve (jumpifconsumableblocked, battle_script_commands.c:9024-9032)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_UNNERVE', innates: [null, null, null] } }),
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_WEAKNESS_POLICY' }),
      countRng(),
    )
    state.battlers[1]!.mon.rawStats.spe = 50
    const damage: DamageResolver = {
      resolve: () => ({ targetDamage: 40, attackerDamage: null, unmodelled: [], isSuperEffective: true }),
    }
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, damage))
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_WEAKNESS_POLICY')
  })
})

// ---------------------------------------------------------------------------
// 11. Ability Shield -- DoesBattlerHaveAbilityShield battle_util.c:6538-6545, IsSuppressed :9254-9261
// ---------------------------------------------------------------------------
describe('cycle 110 - Ability Shield', () => {
  // GetTotalAccuracy :1354-1357 suppresses breakable defender abilities under Mold Breaker unless the defender
  // holds the shield. Sand Veil (abilities.cc:599-608) divides a 100-accuracy move by 1.25 in sandstorm:
  // Math.trunc(100 / 1.25) = 80; with Sand Veil suppressed it stays 100.
  const accuracyWith = (defenderItem: string | null, defenderAbility: string, defenderInnates: SimBattleMon['abilities']['innates'], embargo: boolean) => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_MOLD_BREAKER', innates: [null, null, null] } }),
      monFor('SPECIES_MUDKIP', {
        itemId: defenderItem,
        abilities: { ability: defenderAbility, innates: defenderInnates },
      }),
      countRng(),
    )
    state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    if (embargo) state.battlers[1]!.statuses3 |= STATUS3_EMBARGO
    const { inputs } = buildAccuracyInputs(state, 0, 1, 'MOVE_TACKLE', false, {
      grounding: groundingFor(simData, state),
      dataContext: DATA_CONTEXT,
    })
    return getTotalAccuracy(inputs).accuracy
  }

  it('without the shield, Mold Breaker bypasses Sand Veil (100 instead of 80)', () => {
    expect(accuracyWith(null, 'ABILITY_SAND_VEIL', [null, null, null], false)).toBe(100)
  })

  it('the shield keeps Sand Veil active (80)', () => {
    expect(accuracyWith('ITEM_ABILITY_SHIELD', 'ABILITY_SAND_VEIL', [null, null, null], false)).toBe(80)
  })

  it('the shield survives its holder\'s Klutz: GetBattlerHoldEffect(FALSE) ignores Klutz (80)', () => {
    // :6542 reads the hold effect with checkNegating = FALSE, so IsItemNegated's Klutz branch does not apply;
    // the only negation left is STATUS3_EMBARGO (:6543-6544). A TRUE-mode read here would let Mold Breaker
    // resume suppressing Sand Veil and answer 100.
    expect(accuracyWith('ITEM_ABILITY_SHIELD', 'ABILITY_KLUTZ', ['ABILITY_SAND_VEIL', null, null], false)).toBe(80)
  })

  it('Embargo still negates the shield, so Mold Breaker resumes (100)', () => {
    expect(accuracyWith('ITEM_ABILITY_SHIELD', 'ABILITY_KLUTZ', ['ABILITY_SAND_VEIL', null, null], true)).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 12. Light Clay -- Reflect/Light Screen/Aurora Veil screens battle_script_commands.c:2988/:7759/:9327/:10260,
//     White Smoke abilities.cc:1367-1376
// ---------------------------------------------------------------------------
describe('cycle 110 - Light Clay', () => {
  it('extends Reflect to SCREEN_DURATION_EXTENDED (8) through the real item lookup', () => {
    // Cmd_setreflect :9319-9339: `gSideTimers[side].reflectTimer = (holdEffect == LIGHT_CLAY)
    // ? SCREEN_DURATION_EXTENDED : SCREEN_DURATION` with SCREEN_DURATION 5, EXTENDED 8 (include/battle_util.h:63-64).
    // This uses NO injected hold-effect map: the timer comes from the item on the battler.
    const state = battle(monFor('SPECIES_MUDKIP', { itemId: 'ITEM_LIGHT_CLAY', moves: ['MOVE_REFLECT', null, null, null], pp: [20, 0, 0, 0] }), monFor('SPECIES_MUDKIP'), countRng())
    state.battlers[1]!.mon.rawStats.spe = 50
    executeTurn(state, [useMove(0, 'MOVE_REFLECT'), null], loopDeps(state, nullResolver))
    expect(state.sides[0]!.timers.reflectTimer).toBe(8)

    const plain = battle(monFor('SPECIES_MUDKIP', { moves: ['MOVE_REFLECT', null, null, null], pp: [20, 0, 0, 0] }), monFor('SPECIES_MUDKIP'), countRng())
    plain.battlers[1]!.mon.rawStats.spe = 50
    executeTurn(plain, [useMove(0, 'MOVE_REFLECT'), null], loopDeps(plain, nullResolver))
    expect(plain.sides[0]!.timers.reflectTimer).toBe(5)
  })

  it('White Smoke always gets SCREEN_DURATION_SHORT (3): the C compares a hold effect to an item id', () => {
    // abilities.cc:1372: `GetBattlerHoldEffect(battler, TRUE) == ITEM_LIGHT_CLAY ? SCREEN_DURATION : SCREEN_DURATION_SHORT`.
    // GetBattlerHoldEffect returns HOLD_EFFECT_LIGHT_CLAY (34, holdEffectIds.json), never the item id 294, so the
    // Light Clay branch is dead code and the timer is 3 even while holding the item.
    const state = battle(monFor('SPECIES_MUDKIP', { itemId: 'ITEM_LIGHT_CLAY', abilities: { ability: 'ABILITY_WHITE_SMOKE', innates: [null, null, null] } }), monFor('SPECIES_MUDKIP'), countRng())
    applySwitchInAbilities(state, 0, { grounding: groundingFor(simData, state), dataContext: DATA_CONTEXT, statStageRatios: RATIOS }, [])
    expect(state.sides[0]!.timers.smokescreenTimer).toBe(3)
  })
})
