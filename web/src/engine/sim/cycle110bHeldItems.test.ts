/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 110b: held-item verification, Sitrus Berry / Shell Bell / Choice Band & Specs / Mega Stone / Choice lock.
//
// Every expected number below is derived from the fixed-point arithmetic in web/src/engine/fixed.ts:
// UQ_4_12 has TEN-bit precision, so uq(1.0) = 1024 and uq(1.5) = 1536; ApplyModifier(m, v) =
// floor((m*v + 512) / 1024) and MulModifier re-quantises the same way (fixed.ts, global.h:113-139,
// battle_util.c:7279-7294). The base damage is CalculateBaseDamage's
// `dmg = idiv(level*2, 5) + 2; dmg *= power; dmg *= atk; dmg = idiv(dmg, def); dmg = idiv(dmg, 50) + 2`
// (calculate.ts:1096-1100, battle_util.c:7226-7234) -- at level 50 the leading term is 22 -- and
// CalcFinalDmg applies its stages in finalDamage.ts's fixed order (battle_util.c:7517-7720).
// All battlers here are level 50 with rawStats 100/100/100/100/100 unless the test overrides them.
// RNG draw order for an ordinary single-target move (a slower defender keeps the action order fixed):
// accuracy (turn.ts), then the crit roll and the 16-entry damage roll (damageResolver.ts:203-218), then the
// secondary effect's chance roll. SetCritFlag is `!(critRoll % critChance)` (battle_script_commands.c:1588-1594),
// so a crit roll of 0 -- or any multiple of 24/8/2/1 -- IS a crit; the streams below use 5, which divides none of
// those, and 0 for the damage roll (values[15], the 100% entry).
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { STATUS3_EMBARGO, STATUS3_HEAL_BLOCK } from './constants'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { createSession } from './driver/session'
import { groundingFor } from './driver/session'
import { legalChoices } from './driver/expectimax'
import { canMegaEvolve, getMegaEvolutionSpecies, megaEvolveBattler } from './formChange'
import type { FormChangeDeps } from './formChange'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'

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

const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }

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

/** Fixed damage: keeps the HP arithmetic of the item under test independent of the damage engine. */
const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [] }),
})

function actionOf(out: TurnOutcome, battlerId: number) {
  const action = out.actions.find((a) => a.battlerId === battlerId)
  if (!action) throw new Error(`no action for battler ${battlerId}`)
  return action
}

// ---------------------------------------------------------------------------
// 1. Sitrus Berry -- HOLD_EFFECT_RESTORE_PCT_HP
//    ItemHealHp battle_util.c:5311-5333 (percentHeal), HasEnoughHpToEatBerry :5146-5163,
//    ITEMEFFECT_MOVE_END call site :5874-5891.
// ---------------------------------------------------------------------------
describe('cycle 110b - Sitrus Berry', () => {
  /** One Tackle from battler 0 into the Sitrus holder (battler 1) that deals 0, then the move-end item pass. */
  function sitrusTurn(opts: { attacker?: Partial<SimBattleMon>; defender?: Partial<SimBattleMon> } = {}) {
    const rng = countRng()
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], ...opts.attacker }),
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_SITRUS_BERRY', ...opts.defender }),
      rng,
    )
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(0)))
    return { state, rng }
  }

  it('eats at exactly half HP and heals floor(maxHp * 25 / 100)', () => {
    // ItemHealHp(battler, item, FALSE, TRUE) (:5889-5890) -> gBattleMoveDamage = maxHP * GetBattlerHoldEffectParam / 100
    // as a negative (heal) (:5317). HasEnoughHpToEatBerry(battler, 2, item) (:5314) is
    // `hp <= maxHP / 2` (:5153). maxHp 100, hp 50: 50 <= 50 -> heal floor(100*25/100) = 25 -> 75.
    const { state } = sitrusTurn({ defender: { hp: 50 } })
    expect(state.battlers[1]!.mon.hp).toBe(75)
    // BattleScript_ItemHealHP_RemoveItem removes it: the berry is gone.
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('does not eat at full HP', () => {
    // hp (100) > maxHP / 2 (50): HasEnoughHpToEatBerry returns FALSE, so nothing is consumed.
    const { state } = sitrusTurn({ defender: { hp: 100 } })
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
  })

  it('does not eat one point above half HP (strict `<=`)', () => {
    // hp 51 > 50 -> no eat. The Gluttony clause (:5155-5157) cannot widen this: ItemHealHp already passes
    // hpFraction 2, so Gluttony's extra test is `hp <= maxHP / 2` -- the same threshold.
    const { state } = sitrusTurn({ defender: { hp: 51 } })
    expect(state.battlers[1]!.mon.hp).toBe(51)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
  })

  it('Gluttony does not widen the threshold for Sitrus', () => {
    // hp 60 > 50: both the plain check (:5153) and the Gluttony branch (:5155-5157, hpFraction 2 <= 4) fail.
    const { state } = sitrusTurn({
      defender: { hp: 60, abilities: { ability: 'ABILITY_GLUTTONY', innates: [null, null, null] } },
    })
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
  })

  it('a tiny maxHp heals 0 and the berry is still consumed (ItemHealHp has no minimum)', () => {
    // gBattleMoveDamage = maxHP * param / 100 with NO floor of 1 (:5317), unlike Leftovers' explicit
    // `if (== 0) = 1` (:5709-5710). maxHp 3, hp 1: 1 <= 3/2 = 1 -> eat; heal floor(3*25/100) = 0 -> still 1 HP,
    // and BattleScript_ItemHealHP_RemoveItem still runs.
    const { state } = sitrusTurn({ defender: { hp: 1, maxHp: 3 } })
    expect(state.battlers[1]!.mon.hp).toBe(1)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('Klutz negates the berry (GetBattlerHoldEffect(battler, TRUE), :6526)', () => {
    const { state } = sitrusTurn({
      defender: { hp: 50, abilities: { ability: 'ABILITY_KLUTZ', innates: [null, null, null] } },
    })
    expect(state.battlers[1]!.mon.hp).toBe(50)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
  })

  it('Embargo negates the berry', () => {
    // GetBattlerHoldEffect(battler, TRUE) is HOLD_EFFECT_NONE under STATUS3_EMBARGO (IsItemNegated, :6520-6527), so the move-end pass
    // never sees HOLD_EFFECT_RESTORE_PCT_HP.
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { hp: 50, itemId: 'ITEM_SITRUS_BERRY' }),
      countRng(),
    )
    state.battlers[1]!.statuses3 |= STATUS3_EMBARGO
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[1]!.mon.hp).toBe(50)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
  })

  it('Unnerve blocks the opponent\'s berry (HasEnoughHpToEatBerry :5152)', () => {
    // `isBerry && IsUnnerveAbilityOnOpposingSide(battlerId)` -> FALSE for a POCKET_BERRIES item.
    const { state } = sitrusTurn({
      attacker: { abilities: { ability: 'ABILITY_UNNERVE', innates: [null, null, null] } },
      defender: { hp: 50 },
    })
    expect(state.battlers[1]!.mon.hp).toBe(50)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
  })

  it('Heal Block blocks the heal and the consumption (CanBattlerHeal, ItemHealHp :5312)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { hp: 50, itemId: 'ITEM_SITRUS_BERRY' }),
      countRng(),
    )
    state.battlers[1]!.statuses3 |= STATUS3_HEAL_BLOCK
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[1]!.mon.hp).toBe(50)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
  })

  it('eating a berry draws no random numbers', () => {
    // The heal is deterministic arithmetic (:5317); only the accuracy roll of the move reads the RNG.
    const eaten = sitrusTurn({ defender: { hp: 50 } })
    const kept = sitrusTurn({ defender: { hp: 100 } })
    expect(eaten.rng.calls).toBe(kept.rng.calls)
  })
})

// ---------------------------------------------------------------------------
// 2. Shell Bell -- ITEMEFFECT_LIFEORB_SHELLBELL, battle_util.c:6066-6086.
//    savedDmg accumulates over hits (`savedDmg += gHpDealt`, battle_script_commands.c:4335) and is
//    zeroed at MOVEEND_CLEAR_BITS (:4951); the heal is savedDmg / 4 with a floor of 1 (:6076-6078).
// ---------------------------------------------------------------------------
describe('cycle 110b - Shell Bell', () => {
  function doubleHitTurn(overrides: {
    attacker?: Partial<SimBattleMon>
    healBlock?: boolean
  } = {}) {
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        hp: 50,
        itemId: 'ITEM_SHELL_BELL',
        moves: ['MOVE_DOUBLE_HIT', null, null, null],
        pp: [10, 0, 0, 0],
        ...overrides.attacker,
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    if (overrides.healBlock) state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    let hits = 0
    const resolver: DamageResolver = {
      resolve: () => {
        hits++
        return { targetDamage: 10, attackerDamage: null, unmodelled: [] }
      },
    }
    executeTurn(state, [useMove(1, 'MOVE_DOUBLE_HIT'), null], loopDeps(state, resolver))
    return { state, hits }
  }

  it('heals from the summed multi-hit damage, not from the last hit', () => {
    // Double Hit (EFFECT_DOUBLE_HIT) hits twice for 10 each: gHpDealt 10 + 10, savedDmg = 20 (:4335).
    // MOVEEND_LIFEORB_SHELLBELL runs after the final hit (:6068 comment, :4823-4827), so the heal is
    // floor(20 / 4) = 5 -> 50 + 5 = 55, not floor(10 / 4) = 2 -> 52.
    const { state, hits } = doubleHitTurn()
    expect(hits).toBe(2)
    expect(state.battlers[1]!.mon.hp).toBe(80)
    expect(state.battlers[0]!.mon.hp).toBe(55)
  })

  it('the heal has a floor of 1 (savedDmg < 4)', () => {
    // REQUIRE(gTurnStructs[attacker].savedDmg) is satisfied by 1-3 damage; `if (gBattleMoveDamage == 0)
    // gBattleMoveDamage = -1` (:6081) turns floor(3 / 4) = 0 into a 1-point heal.
    const state = battle(
      monFor('SPECIES_MUDKIP', { hp: 50, itemId: 'ITEM_SHELL_BELL', moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(3)))
    expect(state.battlers[1]!.mon.hp).toBe(97)
    expect(state.battlers[0]!.mon.hp).toBe(51)
  })

  it('does nothing at full HP (REQUIRE_NOT(BATTLER_MAX_HP), :6072)', () => {
    const { state } = doubleHitTurn({ attacker: { hp: 100 } })
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Klutz negates Shell Bell (atkHoldEffect read with GetBattlerHoldEffect(TRUE), :4326)', () => {
    const { state } = doubleHitTurn({ attacker: { abilities: { ability: 'ABILITY_KLUTZ', innates: [null, null, null] } } })
    expect(state.battlers[1]!.mon.hp).toBe(80)
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('Heal Block blocks the drain (REQUIRE(CanBattlerHeal), :6073)', () => {
    const { state } = doubleHitTurn({ healBlock: true })
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('Sheer Force blocks the drain (REQUIRE_NOT(TestSheerForceFlag), :6074)', () => {
    // Psychic (90 power, sheerForceBoost true in moves.json) used by a Sheer Force holder.
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        hp: 50,
        itemId: 'ITEM_SHELL_BELL',
        moves: ['MOVE_PSYCHIC', null, null, null],
        pp: [15, 0, 0, 0],
        abilities: { ability: 'ABILITY_SHEER_FORCE', innates: [null, null, null] },
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_PSYCHIC'), null], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// 3. Choice Band / Choice Specs -- attack-stat modifier, battle_util.c:7288-7294
//    (inside CalcAttackStat, before ApplyModifier(modifier, atkStat) at :7300).
// ---------------------------------------------------------------------------
describe('cycle 110b - Choice Band / Choice Specs', () => {
  /** The defender is given Speed 50 so it always moves second: a Speed tie makes the turn loop draw for
   * the order and shift the accuracy/crit/roll stream (see the header note). */
  const slowerDefender = (): Partial<SimBattleMon> => ({
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 },
  })

  function damageOf(
    attacker: Partial<SimBattleMon>,
    moveId: string,
    rolls: number[],
  ): number {
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: [moveId, null, null, null], pp: [35, 0, 0, 0], ...attacker }),
      monFor('SPECIES_MUDKIP', slowerDefender()),
      scriptedRng(rolls),
    )
    const out = executeTurn(state, [useMove(1, moveId), null], loopDeps(state, bridgeDamage(state)))
    return actionOf(out, 0).targetDamage ?? -1
  }

  it('Tackle: 100 Atk -> ApplyModifier(uq(1.5), 100) = 150 Atk -> 28 damage (vs 19 without)', () => {
    // MulModifier(uq(1.0), uq(1.5)) = uq(1.5) = 1536; ApplyModifier(1536, 100) = floor((153600 + 512) / 1024) = 150.
    // Base: 22 * 40 = 880; 880 * 150 = 132000; idiv(132000, 100) = 1320; idiv(1320, 50) = 26; + 2 = 28.
    // Without the band: 880 * 100 = 88000 -> 880 -> 17 -> 19. Normal vs Water is 1.0 and Mudkip gets no STAB.
    expect(damageOf({ itemId: null }, 'MOVE_TACKLE', [0, 5, 0])).toBe(19)
    expect(damageOf({ itemId: 'ITEM_CHOICE_BAND' }, 'MOVE_TACKLE', [0, 5, 0])).toBe(28)
  })

  it('Klutz and Embargo negate the band (GetBattlerHoldEffect(battler, TRUE), :7261)', () => {
    expect(
      damageOf({ itemId: 'ITEM_CHOICE_BAND', abilities: { ability: 'ABILITY_KLUTZ', innates: [null, null, null] } }, 'MOVE_TACKLE', [0, 5, 0]),
    ).toBe(19)
    const state = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_CHOICE_BAND', moves: ['MOVE_TACKLE', null, null, null] }),
      monFor('SPECIES_MUDKIP', slowerDefender()),
      scriptedRng([0, 5, 0]),
    )
    state.battlers[0]!.statuses3 |= STATUS3_EMBARGO
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, bridgeDamage(state)))
    expect(actionOf(out, 0).targetDamage).toBe(19)
  })

  it('does not boost a special move: Psychic stays 41 with a Choice Band', () => {
    // IS_MOVE_SPECIAL(move) is false for HOLD_EFFECT_CHOICE_BAND (:7289), so the stat is untouched:
    // 22 * 90 = 1980 * 100 = 198000 -> 1980 -> idiv(1980, 50) = 39 -> 41.
    expect(damageOf({ itemId: null }, 'MOVE_PSYCHIC', [0, 5, 0, 99])).toBe(41)
    expect(damageOf({ itemId: 'ITEM_CHOICE_BAND' }, 'MOVE_PSYCHIC', [0, 5, 0, 99])).toBe(41)
  })

  it('Choice Specs boosts the same special move to 61', () => {
    // ApplyModifier(1536, 100) = 150 SpAtk: 1980 * 150 = 297000 -> 2970 -> 59 -> 61.
    expect(damageOf({ itemId: 'ITEM_CHOICE_SPECS' }, 'MOVE_PSYCHIC', [0, 5, 0, 99])).toBe(61)
  })

  it('Photon Geyser follows the RESOLVED category when Atk > SpAtk: 68 -> 101 with a Choice Band', () => {
    // splitFlag USE_HIGHEST_OFFENSE (battle_util.c:7327-7337) makes GetBattleMoveSplit report PHYSICAL when
    // Atk (150) > SpAtk (50), so IS_MOVE_PHYSICAL is true and the band applies (:7289):
    // ApplyModifier(1536, 150) = floor((230400 + 512) / 1024) = 225.
    // Base at 100 power: 22 * 100 = 2200 -> *150 = 330000 -> 3300 -> 66 -> 68; *225 = 495000 -> 4950 -> 99 -> 101.
    const raw = { atk: 150, spatk: 50 }
    expect(damageOf({ itemId: null, rawStats: { ...monFor('SPECIES_MUDKIP').rawStats, ...raw } }, 'MOVE_PHOTON_GEYSER', [0, 5, 0])).toBe(68)
    expect(
      damageOf({ itemId: 'ITEM_CHOICE_BAND', rawStats: { ...monFor('SPECIES_MUDKIP').rawStats, ...raw } }, 'MOVE_PHOTON_GEYSER', [0, 5, 0]),
    ).toBe(101)
  })

  it('Photon Geyser stays special when SpAtk > Atk, so the Choice Band does nothing', () => {
    // Atk 50 < SpAtk 150 -> resolved split SPECIAL -> IS_MOVE_SPECIAL true and IS_MOVE_PHYSICAL false.
    // Base: 2200 * 150 = 330000 -> 3300 -> 66 -> 68 with or without the band.
    const raw = { atk: 50, spatk: 150 }
    expect(damageOf({ itemId: null, rawStats: { ...monFor('SPECIES_MUDKIP').rawStats, ...raw } }, 'MOVE_PHOTON_GEYSER', [0, 5, 0])).toBe(68)
    expect(
      damageOf({ itemId: 'ITEM_CHOICE_BAND', rawStats: { ...monFor('SPECIES_MUDKIP').rawStats, ...raw } }, 'MOVE_PHOTON_GEYSER', [0, 5, 0]),
    ).toBe(68)
  })

  it('Psyshock is still a SPECIAL category move (HITS_DEF only changes the defence stat)', () => {
    // MOVE_PSYSHOCK is split SPECIAL with splitFlag HITS_DEF, so IS_MOVE_PHYSICAL is false: the band is
    // inert and the specs apply. Base: 22 * 80 = 1760 -> *100 = 176000 -> 1760 -> 35 -> 37; specs at 150
    // SpAtk: 1760 * 150 = 264000 -> 2640 -> 52 -> 54 (defence of the target is 100 either way).
    expect(damageOf({ itemId: 'ITEM_CHOICE_BAND' }, 'MOVE_PSYSHOCK', [0, 5, 0])).toBe(37)
    expect(damageOf({ itemId: 'ITEM_CHOICE_SPECS' }, 'MOVE_PSYSHOCK', [0, 5, 0])).toBe(54)
  })
})

// ---------------------------------------------------------------------------
// 4. Mega Stone -- GetMegaEvolutionSpecies battle_util.c:8092-8100, CanMegaEvolve :8124-8185,
//    VARIOUS_HANDLE_MEGA_EVO battle_script_commands.c:7374-7426, CanBattlerGetOrLoseItem :8259.
// ---------------------------------------------------------------------------
describe('cycle 110b - Mega Stone', () => {
  const bossStones: [string, string, string][] = [
    ['ITEM_METAGROSSITE', 'SPECIES_METAGROSS', 'SPECIES_METAGROSS_MEGA'],
    ['ITEM_CENTISKITE', 'SPECIES_CENTISKORCH', 'SPECIES_CENTISKORCH_MEGA'],
    ['ITEM_GARBODORITE', 'SPECIES_GARBODOR', 'SPECIES_GARBODOR_MEGA'],
    ['ITEM_GOTHITITE', 'SPECIES_GOTHITELLE', 'SPECIES_GOTHITELLE_MEGA'],
    ['ITEM_SANDACONDITE', 'SPECIES_SANDACONDA', 'SPECIES_SANDACONDA_MEGA'],
    ['ITEM_CINDERACEITE', 'SPECIES_CINDERACE', 'SPECIES_CINDERACE_MEGA'],
    ['ITEM_DECIDUITE', 'SPECIES_DECIDUEYE', 'SPECIES_DECIDUEYE_MEGA'],
    ['ITEM_SWAMPERTITE', 'SPECIES_SWAMPERT', 'SPECIES_SWAMPERT_MEGA'],
  ]

  it('all eight boss stones resolve through megaEvolveBattler with real data', () => {
    // Each stone is HOLD_EFFECT_MEGA_STONE in items.json and each mega species record carries a
    // {from, item} pair, so GetMegaEvolutionSpecies (:8092-8100) and CanMegaEvolve (:8161) both succeed.
    // megaEvolveBattler runs the whole VARIOUS_HANDLE_MEGA_EVO flow: form change, alreadyEvolved (:7416-7419)
    // and the switch-in ability pass (:8412). The stone is NOT consumed.
    for (const [item, species, mega] of bossStones) {
      const state = battle(monFor(species, { itemId: item }), monFor('SPECIES_MUDKIP'), countRng())
      const deps: FormChangeDeps = {
        dataContext: DATA_CONTEXT,
        grounding: groundingFor(simData, state),
        hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
      }
      expect(getMegaEvolutionSpecies(species, item, DATA_CONTEXT)).toBe(mega)
      expect(canMegaEvolve(state, 0, DATA_CONTEXT)).toBe(true)

      const unmodelled: string[] = []
      expect(megaEvolveBattler(state, 0, deps, unmodelled)).toBe(mega)
      expect(state.battlers[0]!.mon.speciesId).toBe(mega)
      expect(state.battlers[0]!.mon.itemId).toBe(item)
      expect(state.mega.alreadyEvolved[0]).toBe(true)
    }
  })

  it('a Mega Stone cannot be removed by Knock Off, a Choice Band can (positive control)', () => {
    // CanBattlerGetOrLoseItem (battle_util.c:8250-8260) answers FALSE for HOLD_EFFECT_MEGA_STONE
    // (`else if (holdEffect == HOLD_EFFECT_MEGA_STONE) return FALSE;`), so TryKnockOffBattleScript
    // (:4268-4288) bails at the guard the sim ports as moveEnd.ts:5903. Knock Off reaches it through
    // EFFECT_KNOCK_OFF's `setmoveeffect MOVE_EFFECT_KNOCK_OFF`, i.e. moveBehaviors.json's structured entry
    // (driver/session.ts injects the same map in production; the legacy script path has no handler).
    const knockOff = (targetItem: string) => {
      const state = battle(
        monFor('SPECIES_MUDKIP', { moves: ['MOVE_KNOCK_OFF', null, null, null], pp: [20, 0, 0, 0] }),
        monFor('SPECIES_METAGROSS', { itemId: targetItem }),
        scriptedRng([0, 5, 0]),
      )
      executeTurn(state, [useMove(1, 'MOVE_KNOCK_OFF'), null], { ...loopDeps(state, fixedDamage(10)), moveBehaviors: simData.moveBehaviors })
      return state.battlers[1]!.mon.itemId
    }
    expect(knockOff('ITEM_METAGROSSITE')).toBe('ITEM_METAGROSSITE')
    expect(knockOff('ITEM_CHOICE_BAND')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. Choice lock -- gBattleStruct->choicedMove
//    Writer: battle_script_commands.c:4547-4568 (MOVEEND_CHOICE_MOVE). Clears: UpdateBattlerItem :2214,
//    FaintClearSetData battle_main.c:2925, SwitchInClearSetData :2980. Enforced at selection:
//    TrySetCantSelectMoveBattleScript battle_util.c:1565-1571 (player) and CheckMoveLimitations :1646 (AI).
// ---------------------------------------------------------------------------
describe('cycle 110b - Choice lock', () => {
  const choiceLockSession = (moves: SimBattleMon['moves']) => {
    const party = buildPlayerParty(
      [{ species: 'SPECIES_MUDKIP', level: 50, nature: 'NATURE_HARDY', ability: 'ABILITY_TORRENT', item: 'ITEM_CHOICE_BAND', moves }],
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
  const legalMoveIds = (session: ReturnType<typeof choiceLockSession>) =>
    legalChoices(session)
      .filter((choice) => choice.action.action === 'USE_MOVE')
      .map((choice) => choice.action.chosenMove?.id ?? null)

  it('records the first move and the player menu refuses the others on the next turn', () => {
    // Writer (:4550-4563): HITMARKER_OBEYS && gChosenMove != MOVE_STRUGGLE && gChosenMove &&
    // !gProcessingExtraAttacks && attacker == GetTurnBattler() && (*choicedMove == 0 || 0xFFFF) &&
    // HOLD_EFFECT_CHOICE(holdEffect) -> *choicedMove = gChosenMove. The tail (:4564-4567) keeps it because
    // MOVE_TACKLE is still in the moveset.
    const session = choiceLockSession(['MOVE_TACKLE', 'MOVE_WATER_GUN', null, null])
    executeTurn(session.state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(session.state, fixedDamage(10)))
    const battler = session.state.battlers[0]!
    expect(battler.choicedMove).toBe('MOVE_TACKLE')
    expect(legalMoveIds(session)).toEqual(['MOVE_TACKLE'])

    // Turn 2: the only legal move is Tackle; Water Gun would be rejected by TrySetCantSelectMoveBattleScript
    // (:1565-1571 rewrites gCurrentMove to the locked move and returns TRUE). Running the legal menu entry
    // must therefore be Tackle: its PP drops by one, Water Gun's PP is untouched, and the foe takes another 10.
    const ppBefore = [...battler.mon.pp]
    const foeHpBefore = session.state.battlers[1]!.mon.hp
    executeTurn(session.state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(session.state, fixedDamage(10)))
    expect(battler.mon.pp[0]).toBe(ppBefore[0]! - 1)
    expect(battler.mon.pp[1]).toBe(ppBefore[1])
    expect(session.state.battlers[1]!.mon.hp).toBe(foeHpBefore - 10)

    // Embargo lifts the restriction while the lock is still stored, because both enforcement sites read the
    // hold effect with GetBattlerHoldEffect(battler, TRUE) (battle_util.c:1418 -> :1565): the full menu returns.
    battler.statuses3 |= STATUS3_EMBARGO
    expect(legalMoveIds(session)).toEqual(['MOVE_TACKLE', 'MOVE_WATER_GUN'])
  })

  it('switching out clears the lock (SwitchInClearSetData, battle_main.c:2925)', () => {
    const session = choiceLockSession(['MOVE_TACKLE', 'MOVE_WATER_GUN', null, null])
    // A second party member so the switch is legal.
    session.state.sides[0].party.push({
      ...session.state.sides[0].party[0]!,
      hp: 100,
      moves: ['MOVE_WATER_GUN', null, null, null],
      pp: [25, 0, 0, 0],
    })
    executeTurn(session.state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(session.state, fixedDamage(10)))
    expect(session.state.battlers[0]!.choicedMove).toBe('MOVE_TACKLE')

    session.state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(session.state, [switchAction, null], loopDeps(session.state, fixedDamage(10)))
    expect(session.state.battlers[0]!.partyIndex).toBe(1)
    // The incoming battler is a fresh switch-in for SwitchInClearSetData: choicedMove back to 0.
    expect(session.state.battlers[0]!.choicedMove).toBeNull()
    expect(legalMoveIds(session)).toEqual(['MOVE_WATER_GUN'])
  })

  it('losing the item clears the lock (UpdateBattlerItem(battler, ITEM_NONE), :2214)', () => {
    // Bug Bite's non-berry branch pushes MOVE_EFFECT_KNOCK_OFF (moveEffects.ts:11526-11539), the second route into
    // the same clearBattlerItem (:2214) that Knock Off reaches through its structured behavior.
    const state = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_CHOICE_BAND', moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_BUG_BITE', null, null, null], pp: [20, 0, 0, 0] }),
      scriptedRng([0, 5, 0, 0, 5, 0, 0]),
    )
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.choicedMove).toBe('MOVE_TACKLE')

    executeTurn(state, [null, useMove(0, 'MOVE_BUG_BITE')], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.choicedMove).toBeNull()
  })

  it('Struggle is never recorded (`gChosenMove != MOVE_STRUGGLE`, :4550)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_CHOICE_BAND', moves: ['MOVE_TACKLE', null, null, null], pp: [0, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_STRUGGLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.choicedMove).toBeNull()
  })

  it('a successful Baton Pass does not record the lock (the C `break`s before the write)', () => {
    // :4558-4560: `if ((chosenMove == Baton Pass || Healing Wish) && !(gMoveResultFlags & MOVE_RESULT_FAILED))
    // break;` leaves the case before *choicedMove = gChosenMove, so the incoming mon (also a Choice Band holder,
    // so the write would otherwise have happened) is not locked into Baton Pass.
    const party = buildPlayerParty(
      [{ species: 'SPECIES_MUDKIP', level: 50, nature: 'NATURE_HARDY', ability: 'ABILITY_TORRENT', item: 'ITEM_CHOICE_BAND', moves: ['MOVE_BATON_PASS', 'MOVE_TACKLE', null, null] }],
      50,
      simData,
    )
    const session = createSession({
      data: simData,
      playerParty: party,
      opponentTrainer: simData.trainersById.get('TRAINER_SAWYER_1')!,
      rng: createRandomSource(1),
    })
    session.state.sides[0].party.push({
      ...session.state.sides[0].party[0]!,
      moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0],
    })
    session.state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(session.state, [useMove(0, 'MOVE_BATON_PASS'), null], loopDeps(session.state, fixedDamage(0)))
    expect(session.state.battlers[0]!.partyIndex).toBe(1)
    expect(session.state.battlers[0]!.mon.itemId).toBe('ITEM_CHOICE_BAND')
    expect(session.state.battlers[0]!.choicedMove).toBeNull()
  })

  it('a Klutz or Embargo holder is never locked (GetBattlerHoldEffect(attacker, TRUE), :4326)', () => {
    const tackle = (overrides: Partial<SimBattleMon>, embargo: boolean) => {
      const state = battle(monFor('SPECIES_MUDKIP', { itemId: 'ITEM_CHOICE_BAND', ...overrides }), monFor('SPECIES_MUDKIP'), countRng())
      if (embargo) state.battlers[0]!.statuses3 |= STATUS3_EMBARGO
      executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
      return state.battlers[0]!.choicedMove
    }
    expect(tackle({ abilities: { ability: 'ABILITY_KLUTZ', innates: [null, null, null] } }, false)).toBeNull()
    expect(tackle({}, true)).toBeNull()
    expect(tackle({}, false)).toBe('MOVE_TACKLE')
  })
})
