/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 135c: verify and port EFFECT_PURSUIT (the pre-switch hit), EFFECT_CONCOCTION
// (setrandomtempberry + the MOVEEND_CHANGED_ITEMS hand-back) and EFFECT_FETCH
// (tryrecycleitem + the party-slot item write-back on switch-out).
// Every expected number is hand-derived from the pinned C named on the assertion.
//
// Damage shortcut used throughout: at level 50 with Atk == Def == 100
// `((2*50/5+2) * power * atk / def) / 50 + 2` reduces to `22*power/50 + 2`, divisions truncating.
// Every target below is Normal-typed so the type chart contributes nothing, and the user's
// Mudkip (Water) is neither Dark nor Grass, so there is no STAB either.
//
// Draw order: the pre-switch Pursuit hit has NO accuracycheck (s:7235-7259), so its two draws
// are the damage resolver's crit roll (1 = no crit) and its damage roll (0 = max roll).
// Concoction runs accuracycheck, then crit, then the damage roll, then the berry draw(s).
// Fetch has no accuracycheck and draws nothing.
import { describe, expect, it } from 'vitest'

import type { BridgeDeps } from './bridge'
import { BATTLE_TYPE_ARENA, MIN_STAT_STAGE, STAT_ACC, STATUS1_FREEZE, STATUS1_SLEEP, setCounter } from './constants'
import { createBattleState, createBattlerState } from './create'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { isEligibleMove, VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import { consumeBerryWithOverride } from './moveEffects'
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
const THIS_FILE = 'web/src/engine/sim/cycle135cPursuitConcoctionFetch.test.ts'

const freshAbilities = (): SimBattleMon['abilities'] => ({ ability: null, innates: [null, null, null] })

/** 200 Speed against the foe's default 100 keeps GetFastestBattler's speed-tie coin flip
 * (turnOrder.ts:583) out of the scripted draw arrays. */
const FAST_STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 }
const NORMAL_TYPES: [string, string, string] = ['NORMAL', 'MYSTERY', 'MYSTERY']

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
    abilities: freshAbilities(),
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
    abilities: freshAbilities(),
    rawStats: { ...FAST_STATS },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: NORMAL_TYPES,
    ...overrides,
  }
}

/** Draws the scripted values in order (0 once they run out); `calls` counts draws. */
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

function viewOf(moveId: string): TurnOrderMoveView {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  return {
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
}

function useMove(target: number, moveId: string): ChosenAction {
  const view = viewOf(moveId)
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }

const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }),
})

/** The real bridge resolver, needed wherever a number depends on the damage formula. */
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

const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
describe('Cycle 135c Verified Move Effects list registration', () => {
  it('registers EFFECT_PURSUIT, EFFECT_CONCOCTION and EFFECT_FETCH as verified in this file', () => {
    for (const effect of ['EFFECT_PURSUIT', 'EFFECT_CONCOCTION', 'EFFECT_FETCH']) {
      expect(VERIFIED_MOVE_EFFECTS.get(effect), effect).toBe(THIS_FILE)
    }
    // The audit gate treats every power <= 1 move as gated unless its effect is verified, so a
    // gated Fetch is only eligible because of this registration.
    expect(isEligibleMove({ power: 0, effect: 'EFFECT_FETCH' })).toBe(true)
    expect(isEligibleMove({ power: 0, effect: 'EFFECT_SOMETHING_UNVERIFIED' })).toBe(false)
  })

  it.each([
    ['MOVE_PURSUIT', 'EFFECT_PURSUIT'],
    ['MOVE_CONCOCTION', 'EFFECT_CONCOCTION'],
    ['MOVE_FETCH', 'EFFECT_FETCH'],
  ])('%s has %s', (moveId, effect) => expect(effectOf(moveId)).toBe(effect))
})

// ---------------------------------------------------------------------------
// EFFECT_PURSUIT
// Cmd_jumpifnopursuitswitchdmg (src/battle_script_commands.c:11294-11325),
// BattleScript_ActionSwitch (data/battle_scripts_1.s:7196-7209),
// BattleScript_PursuitDmgOnSwitchOut (:7235-7259).
// ---------------------------------------------------------------------------
describe('EFFECT_PURSUIT pre-switch hit', () => {
  // Pursuit, Dark, power 50. battle_util.c:6860-6861 doubles it while the target's slot action is
  // B_ACTION_SWITCH, so the pre-switch hit is power 100. At level 50, Atk 100 vs Def 100:
  //   floor(floor(22 * 100 * 100 / 100) / 50) + 2 = floor(2200 / 50) + 2 = 44 + 2 = 46.
  // The switcher is Normal-typed and the Pursuit user's Mudkip gives no STAB, so 46 is final.
  const PURSUIT_SWITCH_DAMAGE = 46
  // The same move without a switch is the plain 50 power: floor(floor(22 * 50) / 50) + 2 = 22 + 2 = 24.
  const PURSUIT_PLAIN_DAMAGE = 24

  /** Battler 0 (player) has a two-mon party and is the one switching; battler 1 is the Pursuit user. */
  function pursuitBattle(rng: RandomSource, opts: { switchTo?: number } = {}) {
    const state = battle(
      monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES, rawStats: { ...FAST_STATS }, hp: 100, maxHp: 100 }),
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_PURSUIT', null, null, null], pp: [20, 0, 0, 0] }),
      rng,
      { playerParty: [partyMon('SPECIES_MUDKIP', { types: NORMAL_TYPES }), partyMon('SPECIES_TREECKO')] },
    )
    state.battlers[0]!.monToSwitchIntoId = opts.switchTo ?? 1
    return state
  }

  it('positive: the OUTGOING mon takes the doubled hit, the incoming mon is untouched, the foe does not act again, 1 PP', () => {
    // No accuracy draw (:7235-7259 has no accuracycheck): draw 1 = crit check (1 % 24 != 0, no crit),
    // draw 2 = damage roll (0 = max).
    const rng = scriptedRng([1, 0])
    const state = pursuitBattle(rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [switchAction, useMove(0, 'MOVE_PURSUIT')], deps)

    // The switch slot carries the pre-switch hit's damage (BattleScript_PursuitDmgOnSwitchOut).
    expect(actionOf(out, 0)?.targetDamage).toBe(PURSUIT_SWITCH_DAMAGE)
    expect(actionOf(out, 0)?.targetId).toBe(0)
    // The outgoing mon's party record took the hit; the incoming mon is at full HP.
    expect(state.sides[0].party[0]!.hp).toBe(100 - PURSUIT_SWITCH_DAMAGE)
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(state.battlers[0]!.mon.hp).toBe(100)
    // gActionsByTurnOrder[foe] = B_ACTION_TRY_FINISH (:11317-11319): no second Pursuit.
    expect(out.actions.filter((a) => a.battlerId === 1)).toHaveLength(0)
    expect(state.battlers[1]!.mon.pp[0]).toBe(19) // exactly one ppreduce (:7238)
    expect(rng.calls).toBe(2) // crit + damage roll only
  })

  it('negative: an asleep foe does not get the pre-switch hit (status1 & STATUS1_SLEEP, :11310-11311)', () => {
    const rng = scriptedRng([])
    const state = pursuitBattle(rng)
    // STATUS1_SLEEP is a 3-bit counter; 3 keeps the foe asleep through its own slot too.
    state.battlers[1]!.mon.status1 = setCounter(0, STATUS1_SLEEP, 3)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [switchAction, useMove(0, 'MOVE_PURSUIT')], deps)

    expect(actionOf(out, 0)?.targetDamage).toBeNull()
    expect(state.sides[0].party[0]!.hp).toBe(100)
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[1]!.mon.pp[0]).toBe(20) // CANCELLER_ASLEEP cancels before ppreduce
  })

  it('negative: a frozen foe does not get the pre-switch hit (status1 & STATUS1_FREEZE)', () => {
    // The foe's own slot still runs the 1-in-5 thaw roll (CANCELLER_FROZEN); 1 keeps it frozen.
    const rng = scriptedRng([1])
    const state = pursuitBattle(rng)
    state.battlers[1]!.mon.status1 = STATUS1_FREEZE
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [switchAction, useMove(0, 'MOVE_PURSUIT')], deps)

    expect(actionOf(out, 0)?.targetDamage).toBeNull()
    expect(state.sides[0].party[0]!.hp).toBe(100)
    expect(state.battlers[0]!.partyIndex).toBe(1)
  })

  it('negative: a foe that chose another move hits the INCOMING mon after the switch', () => {
    // Tackle, power 40: floor(floor(22 * 40) / 50) + 2 = 17 + 2 = 19. The hit lands after the switch
    // because no Pursuit interception exists for it.
    const rng = scriptedRng([0, 1, 0])
    const state = pursuitBattle(rng)
    state.battlers[1]!.mon.moves = ['MOVE_TACKLE', null, null, null]
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [switchAction, useMove(0, 'MOVE_TACKLE')], deps)

    expect(actionOf(out, 0)?.targetDamage).toBeNull()
    expect(state.sides[0].party[0]!.hp).toBe(100) // the outgoing mon was never hit
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.hp).toBe(81) // the incoming mon took Tackle's 19
  })

  it('negative: a Pursuit aimed at a battler other than the switcher is not intercepted', () => {
    // gBattlerAttacker == moveTarget[foe] (:11310-11311) fails, so no pre-switch hit; the foe then
    // uses its own slot on itself (target 1) for the plain power 50 -> 24.
    const rng = scriptedRng([0, 1, 0])
    const state = pursuitBattle(rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [switchAction, useMove(1, 'MOVE_PURSUIT')], deps)

    expect(actionOf(out, 0)?.targetDamage).toBeNull()
    expect(state.sides[0].party[0]!.hp).toBe(100)
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[1]!.mon.hp).toBe(100 - PURSUIT_PLAIN_DAMAGE)
  })

  it('the pre-switch hit has no accuracycheck: a would-miss roll is spent on the crit check instead', () => {
    // A 99 first draw would miss any accuracy check. It is read as gCritRoll: 99 % 24 = 3, no crit.
    // The second draw is the damage roll (0 = max). Two draws, and the hit lands for 46.
    const rng = scriptedRng([99, 0])
    const state = pursuitBattle(rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [switchAction, useMove(0, 'MOVE_PURSUIT')], deps)

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(actionOf(out, 0)?.targetDamage).toBe(PURSUIT_SWITCH_DAMAGE)
    expect(rng.calls).toBe(2)
  })

  it('a switching mon at 1 HP faints to the hit and the switch still resolves (the C falls through to BattleScript_DoSwitchOut)', () => {
    const rng = scriptedRng([1, 0])
    const state = pursuitBattle(rng)
    state.battlers[0]!.mon.hp = 1
    state.sides[0].party[0]!.hp = 1
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [switchAction, useMove(0, 'MOVE_PURSUIT')], deps)

    expect(actionOf(out, 0)?.fainted).toContain(0)
    expect(state.sides[0].party[0]!.hp).toBe(0) // the outgoing mon fainted on its party record
    // The switch is not skipped: the reserve is now on the field.
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('a plain (non-switching) Pursuit keeps its 50 power: 24, with no doubling', () => {
    // Accuracy 0 (hit), crit 1 (no crit), roll 0 (max).
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES, rawStats: { ...FAST_STATS }, moves: ['MOVE_PURSUIT', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES }),
      rng,
    )
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [useMove(1, 'MOVE_PURSUIT'), null], deps)

    expect(actionOf(out, 0)?.targetDamage).toBe(PURSUIT_PLAIN_DAMAGE)
    expect(state.battlers[1]!.mon.hp).toBe(100 - PURSUIT_PLAIN_DAMAGE)
    expect(rng.calls).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// EFFECT_CONCOCTION
// BattleScript_EffectConcoction (data/battle_scripts_1.s:2907-2931),
// SetRandomTempBerry (src/abilities.cc:7226-7236),
// VARIOUS_CONSUME_BERRY (src/battle_script_commands.c:8024-8041),
// MOVEEND_CHANGED_ITEMS (:4656-4665).
// ---------------------------------------------------------------------------
describe('EFFECT_CONCOCTION', () => {
  // Concoction, Grass, power 30. At level 50, Atk 100 vs Def 100:
  //   floor(floor(22 * 30 * 100 / 100) / 50) + 2 = floor(660 / 50) + 2 = 13 + 2 = 15.
  // The target is Normal-typed and Mudkip (Water) gets no Grass STAB, so 15 is final.
  const CONCOCTION_DAMAGE = 15
  // ITEM_SITRUS_BERRY is sCravingBerryTable[1] (abilities.cc:7215); HOLD_EFFECT_RESTORE_PCT_HP
  // heals maxHp * 25 / 100 (battle_util.c:5311-5333), i.e. 25 at maxHp 100.
  const SITRUS_HEAL = 25
  // Draw order: accuracy 0 (hit), crit 1 (no crit), roll 0 (max), berry index 1 (Sitrus).
  const DRAW_TO_SITRUS = [0, 1, 0, 1]

  const concoctor = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      types: NORMAL_TYPES,
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_CONCOCTION', null, null, null],
      pp: [5, 0, 0, 0],
      ...overrides,
    })
  const target = () => monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES, hp: 100, maxHp: 100 })

  it('positive: a fired Sitrus heals 25 and the parked item comes back at MOVEEND_CHANGED_ITEMS', () => {
    const rng = scriptedRng(DRAW_TO_SITRUS)
    const state = battle(concoctor({ hp: 40, maxHp: 100, itemId: 'ITEM_BIG_NUGGET' }), target(), rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [useMove(1, 'MOVE_CONCOCTION'), null], deps)

    expect(actionOf(out, 0)?.targetDamage).toBe(CONCOCTION_DAMAGE)
    expect(state.battlers[1]!.mon.hp).toBe(100 - CONCOCTION_DAMAGE)
    expect(state.battlers[0]!.mon.hp).toBe(40 + SITRUS_HEAL) // 40 -> 65
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_BIG_NUGGET') // restored (:4658-4660)
    expect(state.battlers[0]!.changedItem ?? null).toBeNull() // changedItems[i] = 0
    expect(state.battlers[0]!.usedHeldItem).toBe('ITEM_SITRUS_BERRY') // Cmd_removeitem recorded the eat
    expect(state.battlers[0]!.mon.pp[0]).toBe(4) // exactly one ppreduce
    expect(rng.calls).toBe(4) // accuracy, crit, damage roll, berry draw
  })

  it('a berry that cannot fire is handed back immediately by VARIOUS_CONSUME_BERRY (:8037-8040)', () => {
    // Full HP: ItemHealHp (:5315) does not fire, so the C restores changedItems[battler] right there.
    const rng = scriptedRng(DRAW_TO_SITRUS)
    const state = battle(concoctor({ hp: 100, maxHp: 100, itemId: 'ITEM_BIG_NUGGET' }), target(), rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    executeTurn(state, [useMove(1, 'MOVE_CONCOCTION'), null], deps)

    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_BIG_NUGGET')
    expect(state.battlers[0]!.changedItem ?? null).toBeNull()
    expect(state.battlers[0]!.usedHeldItem ?? null).toBeNull() // nothing was consumed
  })

  it('a fired berry with NO held item leaves the attacker with no item (changedItems[i] == 0 is skipped)', () => {
    const rng = scriptedRng(DRAW_TO_SITRUS)
    const state = battle(concoctor({ hp: 40, maxHp: 100, itemId: null }), target(), rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    executeTurn(state, [useMove(1, 'MOVE_CONCOCTION'), null], deps)

    expect(state.battlers[0]!.mon.hp).toBe(40 + SITRUS_HEAL)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.changedItem ?? null).toBeNull()
  })

  it('a Figy draw spends the second % 5 draw on figyAlternatives (abilities.cc:7231-7234)', () => {
    // Table index 2 = ITEM_FIGY_BERRY, then alternatives index 1 = ITEM_WIKI_BERRY.
    // Five draws: accuracy, crit, damage roll, table draw, alternatives draw.
    const rng = scriptedRng([0, 1, 0, 2, 1])
    const state = battle(concoctor({ hp: 40, maxHp: 100 }), target(), rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    executeTurn(state, [useMove(1, 'MOVE_CONCOCTION'), null], deps)

    expect(rng.calls).toBe(5)
    expect(state.battlers[0]!.usedHeldItem).toBe('ITEM_WIKI_BERRY')
  })

  it('negative: a missed Concoction draws no berry and leaves the item untouched (accuracycheck s:2909)', () => {
    // Accuracy at its floor makes a 100%-accuracy move 33%; the 99 roll misses.
    const rng = scriptedRng([99])
    const state = battle(concoctor({ hp: 40, maxHp: 100, itemId: 'ITEM_BIG_NUGGET' }), target(), rng)
    state.battlers[0]!.mon.statStages[STAT_ACC] = MIN_STAT_STAGE
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [useMove(1, 'MOVE_CONCOCTION'), null], deps)

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(40)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_BIG_NUGGET')
    expect(state.battlers[0]!.changedItem ?? null).toBeNull()
    expect(state.battlers[0]!.mon.pp[0]).toBe(4) // ppreduce still runs on a miss
    expect(rng.calls).toBe(1) // accuracy only: no berry draw
  })
})

// ---------------------------------------------------------------------------
// EFFECT_FETCH
// BattleScript_EffectFetch (data/battle_scripts_1.s:5316-5345),
// Cmd_tryrecycleitem (src/battle_script_commands.c:12296-12311),
// UpdateBattlerItem (:2203-2224, REQUEST_HELDITEM_BATTLE).
// ---------------------------------------------------------------------------
describe('EFFECT_FETCH', () => {
  const fetcher = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_FETCH', null, null, null],
      pp: [5, 0, 0, 0],
      ...overrides,
    })
  const foe = () => monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES })

  it('positive: recycles the used item, switches, and the outgoing party slot carries it; it returns on switch-in', () => {
    const rng = scriptedRng([])
    const state = battle(fetcher(), foe(), rng, {
      playerParty: [partyMon('SPECIES_MUDKIP'), partyMon('SPECIES_TREECKO')],
    })
    state.battlers[0]!.usedHeldItem = 'ITEM_SITRUS_BERRY'
    state.battlers[0]!.monToSwitchIntoId = 1
    const deps = loopDeps(state, fixedDamage(0))

    const out = executeTurn(state, [useMove(1, 'MOVE_FETCH'), null], deps)

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.partyIndex).toBe(1) // the switch happened (:5328 -> BattleScript_MoveSwitch)
    expect(state.sides[0].party[0]!.itemId).toBe('ITEM_SITRUS_BERRY') // UpdateBattlerItem wrote it through
    expect(state.battlers[0]!.usedHeldItem ?? null).toBeNull() // tryrecycleitem cleared *usedHeldItem
    expect(state.sides[0].party[0]!.pp[0]).toBe(4) // ppreduce (:5321) before the branches

    // Switch back to the first mon: the recycled item is on it again.
    state.battlers[0]!.monToSwitchIntoId = 0
    executeTurn(state, [switchAction, null], deps)
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
  })

  it('a battler still holding an item recycles nothing and takes the _SwitchNoItem path', () => {
    const rng = scriptedRng([])
    const state = battle(fetcher({ itemId: 'ITEM_BIG_NUGGET' }), foe(), rng, {
      playerParty: [partyMon('SPECIES_MUDKIP', { itemId: 'ITEM_BIG_NUGGET' }), partyMon('SPECIES_TREECKO')],
    })
    state.battlers[0]!.usedHeldItem = 'ITEM_SITRUS_BERRY'
    state.battlers[0]!.monToSwitchIntoId = 1
    const deps = loopDeps(state, fixedDamage(0))

    const out = executeTurn(state, [useMove(1, 'MOVE_FETCH'), null], deps)

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.sides[0].party[0]!.itemId).toBe('ITEM_BIG_NUGGET') // the held item, not the used one
    expect(state.sides[0].party[0]!.pp[0]).toBe(4)
  })

  it('cannot switch (no reserve) but has something to recycle: item restored, no failure flag, no switch', () => {
    const rng = scriptedRng([])
    const state = battle(fetcher(), foe(), rng, { playerParty: [partyMon('SPECIES_MUDKIP')] })
    state.battlers[0]!.usedHeldItem = 'ITEM_SITRUS_BERRY'
    const deps = loopDeps(state, fixedDamage(0))

    const out = executeTurn(state, [useMove(1, 'MOVE_FETCH'), null], deps)

    expect(actionOf(out, 0)?.missed).toBe(false) // _NoEffectIfNoItem's successful recycle (:5334-5338)
    expect(state.battlers[0]!.partyIndex).toBe(0) // no switch
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
    expect(state.battlers[0]!.usedHeldItem ?? null).toBeNull()
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
  })

  it('cannot switch AND nothing to recycle: MOVE_RESULT_FAILED -> missed (:5339-5343)', () => {
    const rng = scriptedRng([])
    const state = battle(fetcher(), foe(), rng, { playerParty: [partyMon('SPECIES_MUDKIP')] })
    const deps = loopDeps(state, fixedDamage(0))

    const out = executeTurn(state, [useMove(1, 'MOVE_FETCH'), null], deps)

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.mon.pp[0]).toBe(4) // ppreduce ran before the branch
  })

  it('BATTLE_TYPE_ARENA takes NoEffectIfNoItem even with a reserve (:5322)', () => {
    const rng = scriptedRng([])
    const state = battle(fetcher(), foe(), rng, {
      playerParty: [partyMon('SPECIES_MUDKIP'), partyMon('SPECIES_TREECKO')],
    })
    state.battleTypeFlags = BATTLE_TYPE_ARENA
    state.battlers[0]!.usedHeldItem = 'ITEM_SITRUS_BERRY'
    state.battlers[0]!.monToSwitchIntoId = 1
    const deps = loopDeps(state, fixedDamage(0))

    const out = executeTurn(state, [useMove(1, 'MOVE_FETCH'), null], deps)

    expect(actionOf(out, 0)?.missed).toBe(false) // the recycle succeeded
    expect(state.battlers[0]!.partyIndex).toBe(0) // no switch
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
  })

  it('regression: an item consumed by its own held-item effect leaves the party slot with no item after a plain switch', () => {
    const rng = scriptedRng([])
    const state = battle(monFor('SPECIES_MUDKIP', { hp: 50, maxHp: 100, itemId: 'ITEM_SITRUS_BERRY' }), foe(), rng, {
      playerParty: [partyMon('SPECIES_MUDKIP', { hp: 50, maxHp: 100, itemId: 'ITEM_SITRUS_BERRY' }), partyMon('SPECIES_TREECKO')],
    })
    state.battlers[0]!.monToSwitchIntoId = 1
    const deps = loopDeps(state, fixedDamage(0))

    // ItemHealHp fires: 50 + 25 = 75, the item is gone.
    consumeBerryWithOverride(state, 0, 0, 'MOVE_TACKLE', deps, [], [], false)
    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(state.battlers[0]!.mon.itemId).toBeNull()

    executeTurn(state, [switchAction, null], deps)

    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.sides[0].party[0]!.itemId).toBeNull() // UpdateBattlerItem wrote the cleared item through
    expect(state.sides[0].party[0]!.hp).toBe(75)
  })
})
