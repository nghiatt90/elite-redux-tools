/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 160: four small C behaviours.
//
// A. MOVEEND_RECOIL's Enraged addition (battle_script_commands.c:4492-4505):
//    savedDmg / 3 on top of the fraction/onRecoil recoil, doubled by an opposing
//    Cosmic Daze, the sum floored at 1, and the whole branch skipped when the
//    attacker holds Madness Enhancement.
// B. The Eject Pack ABILITY branch of Cmd_statbuffchange (battle_script_commands.c:
//    9868-9893): an `if`/`else if`, so a fired ability branch never reaches the
//    item branch, which stays a note.
// C. GetParentalBondCount's MINION_CONTROL live party scan in AI_CalcDamage
//    (battle_script_commands.c:1020-1041), reusing attackCanceller.ts's scan.
// D. AI_CheckBadMove's Shields Down check (battle_ai_main.c:660).
//
// Every expected number is hand-derived from the C in a comment.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { MoveData } from '../calculate'
import type { TypeChart } from '../typeEffectiveness'
import { applyModifier } from '../fixed'
import { getParentalBondMultiplier } from '../abilities/dispatchCalc'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  BATTLE_TYPE_TRAINER,
  MIN_STAT_STAGE,
  STAT_ATK,
  STATUS1_POISON,
  STATUS2_ENRAGED,
} from './constants'
import { changeStatBuffs } from './statBuffs'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiCalcDamage } from './ai/aiCalcDamage'
import { aiCheckBadMove } from './ai/aiCheckBadMove'

// ---------------------------------------------------------------------------
// Snapshot-backed fixtures, the shape cycle159AnticipationMirrorArmor.test.ts uses.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
/** natures.json is BattleConstants (natureStatTable, statStageRatios, criticalHitChance, ...). */
const battleConstants = snapshot<Record<string, unknown>>('natures.json') as never
const holdEffectIds = snapshot<Record<string, number>>('holdEffectIds.json')

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 as string | null,
    target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'],
    argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    sheerForceBoost: m.sheerForceBoost as true | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}

/** The damage engine's own MoveData shape (calculate.ts), as damageResolver.test.ts builds it. */
function toMoveData(id: string): MoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  const arg = m.argument as Record<string, unknown> | undefined
  return {
    id,
    power: m.power as number,
    type: String(m.type).replace('TYPE_', ''),
    type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
    split: m.split as MoveData['split'],
    effectChance: m.effectChance as number,
    splitFlag: m.splitFlag as string | undefined,
    effect: m.effect as string | null,
    customBehavior: m.customBehavior,
    crit: m.crit as MoveData['crit'],
    flags: (m.flags as Record<string, true>) ?? {},
    priority: m.priority as number,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? (arg.value as string) : null,
    miscEffect: arg?.kind === 'misc' ? (arg.value as string) : null,
    multiHitArgument: arg?.kind === 'int' ? (arg.value as number) : null,
  }
}

function requireItem(id: string): SimItemData {
  const it = itemsById.get(id)
  if (!it) throw new Error(`items.json has no ${id}`)
  return {
    id,
    resolvedHoldEffect: (it.resolvedHoldEffect as string | null) ?? null,
    holdEffectStrength: (it.holdEffectStrength as number | null) ?? null,
    holdEffectType: (it.holdEffectType as string | null) ?? null,
    naturalGift: (it.naturalGift as SimItemData['naturalGift']) ?? null,
    grouping: (it.grouping as string | null) ?? null,
  }
}

function requireSpecies(id: string): SimSpeciesData {
  const s = speciesById.get(id)
  if (!s) throw new Error(`species.json has no ${id}`)
  return {
    id,
    baseStats: s.baseStats as SimSpeciesData['baseStats'],
    types: ((s.types as string[] | undefined) ?? []).map((t) => t.replace(/^TYPE_/, '')),
    abilities: ((s.abilities as (string | null)[] | undefined) ?? []).slice(),
    innates: ((s.innates as (string | null)[] | undefined) ?? []).slice(),
    weight: (s.weight as number | undefined) ?? 0,
    formOf: (s.formOf as string | null | undefined) ?? null,
  }
}

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: (id) => (speciesById.has(id) ? requireSpecies(id) : undefined),
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
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

type BattlerSpec = {
  atk?: number
  spe?: number
  hp?: number
  maxHp?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status2?: number
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource,
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {},
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
    playerParty: opts.playerParty,
    opponentParty: opts.opponentParty,
    battleTypeFlags: opts.battleTypeFlags,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
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

/** A resolver that returns a fixed amount with no draws; the turn loop still draws accuracy (and any
 *  secondary chance) itself. Copied from cycle98bSwitches.test.ts. */
function fixedDamage(amount: number): DamageResolver {
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

function testDeps(damage: DamageResolver): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const aiDeps: AiDamageDeps = {
  grounding: GROUNDING,
  turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  inverseBattle: false,
  moveData: (id) => (movesById.has(id) ? toMoveData(id) : undefined),
  typeChart,
  inverseTypeChart,
  moveBehaviors,
  battleConstants,
  holdEffectIds,
}

const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const ability = (id: string, ...innates: (string | null)[]): SimBattleMon['abilities'] => ({
  ability: id,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})
const move = (id: string): SimMoveData => requireMove(id)

function partyMon(speciesId: string | null, hp: number, status1 = 0): SimPartyMon {
  return {
    speciesId,
    hp,
    maxHp: 100,
    level: 50,
    moves: [null, null, null, null],
    pp: [0, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
  }
}

// Moves, with the snapshot facts each case leans on.
const TACKLE = move('MOVE_TACKLE') // NORMAL, PHYSICAL, 40 power, no recoil, accuracy 100
const BRAVE_BIRD = move('MOVE_BRAVE_BIRD') // FLYING, PHYSICAL, EFFECT_RECOIL_33 -> recoilFraction 3
const GROWL = move('MOVE_GROWL') // NORMAL, SPECIAL, 60 power, EFFECT_ATTACK_DOWN_HIT at 100% (Atk -1)
const MEGA_PUNCH = move('MOVE_MEGA_PUNCH') // NORMAL, PHYSICAL, eligible for Parental Bond
const WILL_O_WISP = move('MOVE_WILL_O_WISP') // STATUS, EFFECT_WILL_O_WISP (non-volatile burn)
const TOXIC = move('MOVE_TOXIC') // STATUS, EFFECT_TOXIC (non-volatile poison)

const ENRAGED = STATUS2_ENRAGED
const EJECT_PACK_ABILITY = ability('ABILITY_EJECT_PACK_ABILITY')
const MAGIC_GUARD = ability('ABILITY_MAGIC_GUARD')
const MADNESS = ability('ABILITY_MADNESS_ENHANCEMENT')
const COSMIC_DAZE = ability('ABILITY_COSMIC_DAZE')
const MINION_CONTROL = ability('ABILITY_MINION_CONTROL')
const SHIELDS_DOWN = ability('ABILITY_SHIELDS_DOWN')

/** One turn: battler 0 uses `moveId` on battler 1 with a fixed damage amount; battler 1 does nothing. */
function turn(state: BattleState, moveData: SimMoveData, damage = 20) {
  return executeTurn(state, [useMove(1, moveData), null], testDeps(fixedDamage(damage)))
}

// ---------------------------------------------------------------------------
// A. MOVEEND_RECOIL enraged recoil (battle_script_commands.c:4492-4505)
// ---------------------------------------------------------------------------

describe('cycle 160 - Enraged recoil (battle_script_commands.c:4492-4505)', () => {
  it('adds floor(hpDealt / 3) even when no other recoil exists', () => {
    // :4498 `damage = savedDmg / 3`; :4500 `gBattleMoveDamage = max(1, gBattleMoveDamage + damage)`.
    // The fixed resolver deals 9 into a 100 HP target, so hpDealt (savedDmg) = 9 and the fraction /
    // onRecoil recoil is 0 (Tackle has no recoil). extra = floor(9 / 3) = 3; max(1, 0 + 3) = 3.
    const state = battle([{ abilities: { ability: null, innates: [null, null, null] }, status2: ENRAGED }, { hp: 100 }], scriptedRng([0]))
    const out = turn(state, TACKLE, 9)
    expect(out.actions[0]!.targetDamage).toBe(9)
    expect(out.actions[0]!.attackerDamage).toBe(3)
    expect(state.battlers[0]!.mon.hp).toBe(97)
    expect(out.actions[0]!.unmodelled.some((u) => u.includes('enraged recoil'))).toBe(false)
  })

  it('doubles the enraged part with an opposing Cosmic Daze', () => {
    // :4499 `if (IsAbilityOnOpposingSide(attacker, COSMIC_DAZE)) damage *= 2`.
    // hpDealt 9 -> 3, doubled to 6; max(1, 0 + 6) = 6.
    const state = battle([{ status2: ENRAGED }, { hp: 100, abilities: COSMIC_DAZE }], scriptedRng([0]))
    const out = turn(state, TACKLE, 9)
    expect(out.actions[0]!.attackerDamage).toBe(6)
    expect(state.battlers[0]!.mon.hp).toBe(94)
  })

  it('floors a zero savedDmg / 3 at 1 (hpDealt 2)', () => {
    // floor(2 / 3) = 0, and the C's max(1, ...) applies to the SUM, so 0 + 0 becomes 1.
    const state = battle([{ status2: ENRAGED }, { hp: 100 }], scriptedRng([0]))
    const out = turn(state, TACKLE, 2)
    expect(out.actions[0]!.targetDamage).toBe(2)
    expect(out.actions[0]!.attackerDamage).toBe(1)
    expect(state.battlers[0]!.mon.hp).toBe(99)
  })

  it('Madness Enhancement adds nothing (:4493 takes the other branch)', () => {
    // `if (!BattlerHasAbility(attacker, MADNESS_ENHANCEMENT))` is false, so the else (:4502-4504)
    // only queues BattleScript_AttackerIsEnragedMadness: no damage.
    const state = battle([{ abilities: MADNESS, status2: ENRAGED }, { hp: 100 }], scriptedRng([0]))
    const out = turn(state, TACKLE, 9)
    expect(out.actions[0]!.attackerDamage).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('not Enraged takes no recoil at all (negative)', () => {
    const state = battle([{}, { hp: 100 }], scriptedRng([0]))
    const out = turn(state, TACKLE, 9)
    expect(out.actions[0]!.attackerDamage).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Magic Guard skips the whole recoil case (negative, :4467-4472)', () => {
    // REQUIRE_NOT(IsMagicGuardProtected(attacker)) guards the fraction recoil, the onRecoil hooks AND
    // the enraged block alike, because all three live under MOVEEND_RECOIL.
    const state = battle([{ abilities: MAGIC_GUARD, status2: ENRAGED }, { hp: 100 }], scriptedRng([0]))
    const out = turn(state, TACKLE, 9)
    expect(out.actions[0]!.attackerDamage).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('sums the fraction recoil and the enraged part before max(1)', () => {
    // Brave Bird's EFFECT_RECOIL_33 -> GetRecoilFraction = 3, so the fraction recoil is
    // max(1, floor(9 / 3)) = 3 (:4474-4475). The enraged block then adds floor(9 / 3) = 3
    // (:4498) and takes max(1, 3 + 3) = 6 (:4500). Doubling with Cosmic Daze would apply
    // only to the enraged part, not to the fraction recoil (:4498-4499).
    const state = battle([{ status2: ENRAGED }, { hp: 100 }], scriptedRng([0]))
    const out = turn(state, BRAVE_BIRD, 9)
    expect(out.actions[0]!.targetDamage).toBe(9)
    expect(out.actions[0]!.attackerDamage).toBe(6)
    expect(state.battlers[0]!.mon.hp).toBe(94)
  })

  it('Brave Bird + Cosmic Daze: 3 fraction + 6 enraged = 9', () => {
    // The fraction recoil is outside the Cosmic Daze multiplication; only `damage` (the enraged
    // addition) doubles (:4498-4500): max(1, 3 + 3*2) = 9.
    const state = battle([{ status2: ENRAGED }, { hp: 100, abilities: COSMIC_DAZE }], scriptedRng([0]))
    const out = turn(state, BRAVE_BIRD, 9)
    expect(out.actions[0]!.attackerDamage).toBe(9)
    expect(state.battlers[0]!.mon.hp).toBe(91)
  })
})

// ---------------------------------------------------------------------------
// B. Eject Pack ability (battle_script_commands.c:9868-9893)
// ---------------------------------------------------------------------------

function ejectPackState(rng: RandomSource, opts: { reserve: boolean; holderAbility?: SimBattleMon['abilities']; holderItem?: string | null }) {
  const party = opts.reserve
    ? [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)]
    : [partyMon('SPECIES_MUDKIP', 100)]
  return battle(
    [
      { moves: slot(GROWL.id), pp: pps },
      { abilities: opts.holderAbility ?? EJECT_PACK_ABILITY, itemId: opts.holderItem ?? null, hp: 100, maxHp: 100 },
    ],
    rng,
    { opponentParty: party, battleTypeFlags: BATTLE_TYPE_TRAINER },
  )
}

describe('cycle 160 - Eject Pack ability (battle_script_commands.c:9868-9893)', () => {
  it('switches the holder out after a stat drop when a reserve exists', () => {
    // :9877-9884: BattlerHasAbility(battler, EJECT_PACK_ABILITY) && !GetSingleUseAbilityCounter
    // -> TryScheduleSwitch(SWITCH_ABILITY, BattleScript_EmergencyExitPopupNoPause). The drain
    // re-checks the ability and CanBattlerSwitch, then picks a replacement. Growl's secondary is
    // 100% (EFFECT_ATTACK_DOWN_HIT), so the Atk -1 reaches ChangeStatBuffs and schedules.
    // Draws: accuracy 0 (hit), secondary chance 0 (fires), replacement pick 1 (slot 0 is the
    // current partyIndex and is rejected; slot 1 is accepted).
    const rng = scriptedRng([0, 0, 1, 1, 1, 1])
    const state = ejectPackState(rng, { reserve: true })
    const out = turn(state, GROWL)

    expect(state.battlers[1]!.partyIndex).toBe(1) // switched into the reserve
    expect(state.queuedSwitches).toEqual([])
    expect(out.actions[0]!.unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })

  it('stays in with no reserve (CanBattlerSwitch false)', () => {
    // TryScheduleSwitch still queues, but the drain's FILTER(CanBattlerSwitch) drops it (:812).
    const rng = scriptedRng([0, 0])
    const state = ejectPackState(rng, { reserve: false })
    const out = turn(state, GROWL)

    expect(state.battlers[1]!.partyIndex).toBe(0)
    expect(state.queuedSwitches).toEqual([])
    expect(out.actions[0]!.unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })

  it('does not trigger at MIN_STAT_STAGE (:9870-9872)', () => {
    // `if (gBattleMons[battler].statStages[statId] == MIN_STAT_STAGE)` takes the WONT_DECREASE
    // branch and the Eject Pack block is in the `else`, so a stage already at 0 never schedules.
    const rng = scriptedRng([0, 0])
    const state = ejectPackState(rng, { reserve: true })
    state.battlers[1]!.mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    turn(state, GROWL)
    expect(state.battlers[1]!.partyIndex).toBe(0)
    expect(state.queuedSwitches).toEqual([])
  })

  it('does not trigger when disableEjectPack is set (:9876)', () => {
    // Unit-level ChangeStatBuffs call: gRoundStructs[battler].disableEjectPack guards the whole
    // ability/item block. A real earlier effect (e.g. moveEnd.ts's own writer) sets the flag; here
    // it is set directly to isolate this guard.
    const state = ejectPackState(scriptedRng([]), { reserve: true })
    state.battlers[1]!.round.disableEjectPack = true
    const unmodelled: string[] = []
    const res = changeStatBuffs(state, 1, 0, 1, -1, STAT_ATK, 0, false, { dataContext: DATA_CONTEXT, grounding: GROUNDING }, unmodelled, 'MOVE_GROWL')
    expect(res.delta).toBe(-1)
    expect(state.queuedSwitches).toEqual([])
    expect(unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })

  it('schedules the exact SWITCH_ABILITY entry at unit level', () => {
    const state = ejectPackState(scriptedRng([]), { reserve: true })
    const unmodelled: string[] = []
    changeStatBuffs(state, 1, 0, 1, -1, STAT_ATK, 0, false, { dataContext: DATA_CONTEXT, grounding: GROUNDING }, unmodelled, 'MOVE_GROWL')
    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_EJECT_PACK_ABILITY', setAbilityState: false, switchingBattler: 1, sourceBattler: 1, script: 'EMERGENCY_EXIT' },
    ])
    expect(unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })

  it('a holder without the ability does not switch (negative)', () => {
    const rng = scriptedRng([0, 0])
    const state = ejectPackState(rng, { reserve: true, holderAbility: { ability: null, innates: [null, null, null] } })
    turn(state, GROWL)
    expect(state.battlers[1]!.partyIndex).toBe(0)
    expect(state.queuedSwitches).toEqual([])
  })

  it('the ITEM branch queues the SWITCH_ITEM entry (battle_script_commands.c:9885-9892)', () => {
    // :9885-9892 -- reached only when the ability branch above is not taken. ITEM_EJECT_PACK's
    // resolvedHoldEffect is HOLD_EFFECT_EJECT_PACK; no opposing Unnerve, so the entry is queued.
    const state = ejectPackState(scriptedRng([]), { reserve: true, holderAbility: { ability: null, innates: [null, null, null] }, holderItem: 'ITEM_EJECT_PACK' })
    const unmodelled: string[] = []
    changeStatBuffs(state, 1, 0, 1, -1, STAT_ATK, 0, false, { dataContext: DATA_CONTEXT, grounding: GROUNDING }, unmodelled, 'MOVE_GROWL')
    expect(state.queuedSwitches).toEqual([
      { ability: '', cause: 'ITEM', item: 'ITEM_EJECT_PACK', setAbilityState: false, switchingBattler: 1, sourceBattler: 1, script: 'EJECT_BUTTON' },
    ])
    expect(unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C. Minion Control in AI_CalcDamage (battle_script_commands.c:1020-1041)
// ---------------------------------------------------------------------------

describe('cycle 160 - Minion Control in the AI (battle_script_commands.c:1020-1041)', () => {
  const minionBattle = (party: SimPartyMon[]) =>
    battle(
      [{ abilities: MINION_CONTROL, atk: 200, moves: slot(MEGA_PUNCH.id), pp: pps, hp: 300, maxHp: 300 }, { hp: 300, maxHp: 300 }],
      scriptedRng([]),
      { playerParty: party },
    )

  it('count = 1 + every other eligible party mon, applied through the multiplier loop', () => {
    // :1021-1040: count starts at 1, then +1 for each party slot that is not the attacker's own,
    // has HP, a species and no status1. Slots: 0 = attacker (its own, FILTERed), 1 healthy,
    // 2 healthy, 3 fainted (hp 0), 4 statused, 5 empty (species null). count = 1 + 2 = 3.
    // GetParentalBondMultiplier (battle_util.c:7475-7477, :7487) is 1.0x for turn 0 and 0.1x after,
    // so the AI's `multiplier +=` loop sums uq(1.0) + uq(0.1) + uq(0.1).
    const sixParty = [
      partyMon('SPECIES_MUDKIP', 100),
      partyMon('SPECIES_MUDKIP', 100),
      partyMon('SPECIES_MUDKIP', 100),
      partyMon('SPECIES_MUDKIP', 0),
      partyMon('SPECIES_MUDKIP', 100, STATUS1_POISON),
      partyMon(null, 0),
    ]
    const six = aiCalcDamage(minionBattle(sixParty), MEGA_PUNCH.id, 0, 1, aiDeps)
    // A party of only the attacker: count 1, so only the 1.0x multiplier applies and the
    // scaled damage is the unscaled base (applyModifier(uq(1.0), x) === x).
    const lone = aiCalcDamage(minionBattle([partyMon('SPECIES_MUDKIP', 100)]), MEGA_PUNCH.id, 0, 1, aiDeps)

    const multiplier = [0, 1, 2].reduce<number>((sum, i) => sum + getParentalBondMultiplier('MINION_CONTROL', i), 0)
    expect(six.dmg).toBe(applyModifier(multiplier, lone.dmg))
    expect(six.dmg).toBeGreaterThan(lone.dmg)
    // The count itself is still applied, but the AI path cannot prove its scan used the same
    // battler the C's gBattlerAttacker pointed at, so the port now reports that as unmodelled:
    // the C reads the global (battle_script_commands.c:1026-1040) that AI_CalcDamage never
    // assigns (battle_ai_util.c:740).
    expect(six.unmodelled.some((u) => u.includes('MINION_CONTROL') && u.includes('gBattlerAttacker'))).toBe(true)
    expect(lone.unmodelled.some((u) => u.includes('MINION_CONTROL') && u.includes('gBattlerAttacker'))).toBe(true)
  })

  it('a lone mon gives count 1 (negative)', () => {
    // The attacker's own slot is the only party entry, so the scan's FILTER skips it and count
    // stays 1: the AI damage equals applyModifier(uq(1.0), base) === base.
    const state = minionBattle([partyMon('SPECIES_MUDKIP', 100)])
    const res = aiCalcDamage(state, MEGA_PUNCH.id, 0, 1, aiDeps)
    expect(res.dmg).toBe(applyModifier(getParentalBondMultiplier('MINION_CONTROL', 0), res.dmg))
    // Even at count 1 the trigger itself is MINION_CONTROL, so the gBattlerAttacker caveat
    // (battle_script_commands.c:1026-1040, battle_ai_util.c:740) is reported.
    expect(res.unmodelled.some((u) => u.includes('MINION_CONTROL') && u.includes('gBattlerAttacker'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// D. Shields Down AI check (battle_ai_main.c:660, battle_script_commands.c:6563-6576)
// ---------------------------------------------------------------------------

describe('cycle 160 - Shields Down AI check (battle_ai_main.c:660)', () => {
  // The defender holds Shields Down so the def-ability switch reaches the case (the C's own
  // case labels are the DEFENDER's slots, battle_ai_main.c:616-618); the case body then reads
  // IsShieldsDownProtected(battlerAtk), i.e. the ATTACKER's species AND its own Shields Down
  // ability (battle_script_commands.c:6563-6576). The attacker therefore carries the same
  // innate the snapshot gives every meteor form.
  const scoreOf = (attackerSpecies: string, moveData: SimMoveData, attackerAbilities: SimBattleMon['abilities'] = SHIELDS_DOWN) => {
    const state = battle(
      [{ speciesId: attackerSpecies, abilities: attackerAbilities, moves: slot(moveData.id), pp: pps }, { abilities: SHIELDS_DOWN, hp: 100, maxHp: 100 }],
      scriptedRng([]),
    )
    return aiCheckBadMove(state, 0, 1, moveData.id, 100, aiDeps)
  }

  it('a meteor-form attacker choosing Will-O-Wisp scores -10', () => {
    // IsShieldsDownProtected: species in the 7-form list (:6563-6572) and BATTLER_HAS_ABILITY
    // SHIELDS_DOWN; IsNonVolatileStatusMoveEffect(EFFECT_WILL_O_WISP) is true -> -10.
    const scored = scoreOf('SPECIES_MINIOR_METEOR_ORANGE', WILL_O_WISP)
    expect(scored.score).toBe(90)
    expect(scored.unmodelled.some((u) => u.includes('IsShieldsDownProtected'))).toBe(false)
  })

  it('the same check fires for Toxic', () => {
    expect(scoreOf('SPECIES_MINIOR_METEOR_ORANGE', TOXIC).score).toBe(90)
  })

  it('SPECIES_MINIOR_CORE_RED is not in the list, so the score is unchanged (negative)', () => {
    // The core form is the form after Shields Down breaks; the C switch has no case for it.
    expect(scoreOf('SPECIES_MINIOR_CORE_RED', WILL_O_WISP).score).toBe(100)
  })

  it('a damaging move is not a non-volatile status effect (negative)', () => {
    expect(scoreOf('SPECIES_MINIOR_METEOR_ORANGE', TACKLE).score).toBe(100)
  })

  it('a meteor form WITHOUT Shields Down is not protected: BATTLER_HAS_ABILITY is false (negative)', () => {
    // IsShieldsDownProtected's second half is BATTLER_HAS_ABILITY(battlerAtk, ABILITY_SHIELDS_DOWN)
    // (battle_script_commands.c:6572), so the species alone is not enough.
    expect(scoreOf('SPECIES_MINIOR_METEOR_ORANGE', WILL_O_WISP, { ability: null, innates: [null, null, null] }).score).toBe(100)
  })
})
