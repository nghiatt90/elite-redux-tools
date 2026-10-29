/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { runEndTurnEffects } from './endTurn'
import { isAbilityPreventingEscape } from './escape'
import type { EscapeDeps } from './escape'
import type { ReplacementDeps } from './switchIn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_POISON,
  STATUS2_DESTINY_BOND,
  STATUS2_WRAPPED,
  STATUS3_GASTRO_ACID,
  WEATHER_FOG_PERMANENT,
} from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- the same snapshot-backed shape cycle103StatusImmune.test.ts and
// turnFaintSwitch.test.ts use. `requireMove` strips the TYPE_ prefix from
// `type` the way the production loader does (driver/loadSimData.ts:181).
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<Record<string, unknown>>('types.json')
const inverseTypeChart = snapshot<Record<string, unknown>>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type ? String(m.type).replace('TYPE_', '') : null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
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

function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

type BattlerSpec = {
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  level?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status1?: number
  status2?: number
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource,
  playerParty?: SimPartyMon[],
  opponentParty?: SimPartyMon[],
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          level: s.level ?? 50,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
    playerParty,
    opponentParty,
  })
}

function scripted(...values: number[]): RandomSource & { calls: number } {
  let i = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[i++] ?? 0
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

function deps(damage: DamageResolver = fixedDamage(0), replacement?: ReplacementDeps): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
    replacement,
  }
}

function replacementDeps(chosenIndex: number): ReplacementDeps & { calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    chooseReplacement(_state, battlerId) {
      calls.push(battlerId)
      return chosenIndex
    },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const ability = (id: string, ...innates: (string | null)[]): SimBattleMon['abilities'] => ({
  ability: id,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})

const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }

function stages(state: BattleState, battlerId: number): number[] {
  return state.battlers[battlerId]!.mon.statStages
}

// ---------------------------------------------------------------------------
// 1. onExit heals -- Cmd_switchoutabilities (src/battle_script_commands.c:12102-12120)
//    runs onExit for the switching battler. Regenerator's body
//    (abilities.cc:2106-2111) is CHECK(IsBattlerAlive) / CHECK_NOT(BATTLER_MAX_HP)
//    -> BattleScript_RegeneratorExits -> Cmd_tryhealpercenthealth
//    (battle_script_commands.c:7896-7907): maxHP * 33 / 100, clamped to at least 1,
//    then datahpupdate. Eternal Blessing aliases it (abilities.cc:8154-8158).
// ---------------------------------------------------------------------------

describe('cycle 104 - onExit heals (Cmd_switchoutabilities, battle_script_commands.c:12102-12120)', () => {
  it('Eternal Blessing heals maxHP*33/100 = 33 and the heal persists on the party slot', () => {
    const lead = partyMon({ hp: 50, maxHp: 100, abilities: ability('ABILITY_ETERNAL_BLESSING') })
    const reserve = partyMon({ hp: 100, maxHp: 100 })
    const state = battle(
      [{ spe: 200, hp: 50, maxHp: 100, abilities: ability('ABILITY_ETERNAL_BLESSING') }, { spe: 50 }],
      scripted(),
      [lead, reserve],
      [partyMon()],
    )
    state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(state, [switchAction, null], deps())

    // 100 * 33 / 100 = 33; 50 + 33 = 83, written back to the outgoing party slot.
    expect(state.sides[0].party[0]!.hp).toBe(83)
    expect(state.battlers[0]!.partyIndex).toBe(1)

    // Switching back next turn sends out the mon with the 83 HP that survived.
    state.battlers[0]!.monToSwitchIntoId = 0
    executeTurn(state, [switchAction, null], deps())
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(83)
  })

  it('clamps the heal at max HP: 99 + 33 is 100, not 132', () => {
    const state = battle(
      [{ spe: 200, hp: 99, maxHp: 100, abilities: ability('ABILITY_REGENERATOR') }, { spe: 50 }],
      scripted(),
      [partyMon({ hp: 99, maxHp: 100, abilities: ability('ABILITY_REGENERATOR') }), partyMon()],
      [partyMon()],
    )
    state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(state, [switchAction, null], deps())
    expect(state.sides[0].party[0]!.hp).toBe(100)
  })

  it('negative: CHECK_NOT(BATTLER_MAX_HP) -- a full-HP mon is not healed on exit', () => {
    const state = battle(
      [{ spe: 200, hp: 100, maxHp: 100, abilities: ability('ABILITY_REGENERATOR') }, { spe: 50 }],
      scripted(),
      [partyMon({ hp: 100, maxHp: 100, abilities: ability('ABILITY_REGENERATOR') }), partyMon()],
      [partyMon()],
    )
    state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(state, [switchAction, null], deps())
    // The switch itself did happen, so 100 is the mon's own untouched HP.
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.sides[0].party[0]!.hp).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 2. onExit status clearing -- Natural Cure's body (abilities.cc:865-878) is
//    CHECK(IsBattlerAlive) / CHECK(status1 & STATUS1_ANY) -> status1 &= ~STATUS1_ANY
//    -> curestatus. Self Repair aliases it (abilities.cc:5295) and Natural
//    Recovery ORs the two bodies together (abilities.cc:6262-6264), so the last
//    one heals *and* cures on the same exit.
// ---------------------------------------------------------------------------

describe('cycle 104 - onExit status clearing (abilities.cc:865-878, 5295, 6262-6264)', () => {
  it('Natural Cure clears poison on the outgoing party slot', () => {
    const state = battle(
      [{ spe: 200, status1: STATUS1_POISON, abilities: ability('ABILITY_NATURAL_CURE') }, { spe: 50 }],
      scripted(),
      [partyMon({ status1: STATUS1_POISON, abilities: ability('ABILITY_NATURAL_CURE') }), partyMon()],
      [partyMon()],
    )
    state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(state, [switchAction, null], deps())
    expect(state.sides[0].party[0]!.status1).toBe(0)
    expect(state.battlers[0]!.partyIndex).toBe(1)
  })

  it('Self Repair clears burn on the outgoing party slot', () => {
    const state = battle(
      [{ spe: 200, status1: STATUS1_BURN, abilities: ability('ABILITY_SELF_REPAIR') }, { spe: 50 }],
      scripted(),
      [partyMon({ status1: STATUS1_BURN, abilities: ability('ABILITY_SELF_REPAIR') }), partyMon()],
      [partyMon()],
    )
    state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(state, [switchAction, null], deps())
    expect(state.sides[0].party[0]!.status1).toBe(0)
  })

  it('Natural Recovery does both halves: hp 50 -> 83 and poison -> 0', () => {
    const state = battle(
      [{ spe: 200, hp: 50, maxHp: 100, status1: STATUS1_POISON, abilities: ability('ABILITY_NATURAL_RECOVERY') }, { spe: 50 }],
      scripted(),
      [partyMon({ hp: 50, maxHp: 100, status1: STATUS1_POISON, abilities: ability('ABILITY_NATURAL_RECOVERY') }), partyMon()],
      [partyMon()],
    )
    state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(state, [switchAction, null], deps())
    expect(state.sides[0].party[0]!.hp).toBe(83)
    expect(state.sides[0].party[0]!.status1).toBe(0)
  })

  it('negative: Gastro Acid stops both halves of Natural Recovery', () => {
    const state = battle(
      [{ spe: 200, hp: 50, maxHp: 100, status1: STATUS1_POISON, abilities: ability('ABILITY_NATURAL_RECOVERY') }, { spe: 50 }],
      scripted(),
      [partyMon({ hp: 50, maxHp: 100, status1: STATUS1_POISON, abilities: ability('ABILITY_NATURAL_RECOVERY') }), partyMon()],
      [partyMon()],
    )
    // Cmd_switchoutabilities' ON_ABILITY wraps the callback in FILTER_NOT(IsSuppressed)
    // (include/battle_util.h:269-275); IsSuppressed consults STATUS3_GASTRO_ACID
    // (src/battle_util.c:9254-9261), and this ability is not unsuppressable.
    state.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(state, [switchAction, null], deps())
    expect(state.sides[0].party[0]!.hp).toBe(50)
    expect(state.sides[0].party[0]!.status1).toBe(STATUS1_POISON)
  })
})

// ---------------------------------------------------------------------------
// 3. onStatLowered (Defiant / Competitive / Contempt) on a real move.
//    BattleScript_EffectStatDown -> `statbuffchange STAT_BUFF_ALLOW_PTR`
//    (data/battle_scripts_1.s:3666-3687) -> BattleScript_StatDown ->
//    printfromtable gStatDownStringIds[B_MSG_DEFENDER_STAT_FELL] =
//    STRINGID_DEFENDERSSTATFELL (data/battle_scripts_1.s:3717-3721) ->
//    PrepareStringBattle's onStatLowered block (src/battle_util.c:1222-1255).
//    Defiant raises Attack by 2 (abilities.cc:11764-11769), Competitive raises
//    Sp. Atk by 2 (abilities.cc:11774-11779), Contempt is a Defiant alias (:11784).
//    LEER is a 100%-accuracy STATUS EFFECT_DEFENSE_DOWN (data/v2.65beta/moves.json).
// ---------------------------------------------------------------------------

describe('cycle 104 - onStatLowered fires on a real cross-side stat drop', () => {
  it('Defiant: Leer drops Defense 6 -> 5 and raises Attack by 2, 6 -> 8', () => {
    const state = battle(
      [{ spe: 200, moves: slot('MOVE_LEER'), pp: pps }, { spe: 50, abilities: ability('ABILITY_DEFIANT') }],
      scripted(),
    )
    executeTurn(state, [useMove(1, move('MOVE_LEER')), null], deps())
    expect(stages(state, 1)[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stages(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  it('Competitive raises Sp. Atk by 2, 6 -> 8', () => {
    const state = battle(
      [{ spe: 200, moves: slot('MOVE_LEER'), pp: pps }, { spe: 50, abilities: ability('ABILITY_COMPETITIVE') }],
      scripted(),
    )
    executeTurn(state, [useMove(1, move('MOVE_LEER')), null], deps())
    expect(stages(state, 1)[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stages(state, 1)[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(stages(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('Contempt (Defiant alias) raises Attack by 2', () => {
    const state = battle(
      [{ spe: 200, moves: slot('MOVE_LEER'), pp: pps }, { spe: 50, abilities: ability('ABILITY_CONTEMPT') }],
      scripted(),
    )
    executeTurn(state, [useMove(1, move('MOVE_LEER')), null], deps())
    expect(stages(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  it('negative: a Clear Amulet-blocked drop prints B_MSG_STAT_WONT_DECREASE, so Defiant does not fire', () => {
    // ChangeStatBuffs' `!certain && !affectsUser && Clear Amulet` branch
    // (src/battle_script_commands.c:9803-9806) returns WITHOUT setting
    // changedStatsBattlerId's STRINGID_DEFENDERSSTATFELL message.
    const state = battle(
      [{ spe: 200, moves: slot('MOVE_LEER'), pp: pps }, { spe: 50, abilities: ability('ABILITY_DEFIANT'), itemId: 'ITEM_CLEAR_AMULET' }],
      scripted(),
    )
    executeTurn(state, [useMove(1, move('MOVE_LEER')), null], deps())
    expect(stages(state, 1)[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(stages(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('negative: a drop at the -6 floor prints B_MSG_STAT_WONT_DECREASE, so Defiant does not fire', () => {
    const state = battle(
      [{ spe: 200, moves: slot('MOVE_LEER'), pp: pps }, { spe: 50, abilities: ability('ABILITY_DEFIANT') }],
      scripted(),
    )
    state.battlers[1]!.mon.statStages[STAT_DEF] = MIN_STAT_STAGE
    executeTurn(state, [useMove(1, move('MOVE_LEER')), null], deps())
    expect(stages(state, 1)[STAT_DEF]).toBe(MIN_STAT_STAGE)
    expect(stages(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// 4. The stat-drop paths that previously printed STRINGID_DEFENDERSSTATFELL
//    without running onStatLowered: Whiplash, Serpent Bind / Tentalock /
//    Chokehold, and Sap Trap.
// ---------------------------------------------------------------------------

describe('cycle 104 - onStatLowered at the newly dispatched drop sites', () => {
  it('Whiplash (abilities.cc:8942-8954) drops Defense and wakes the target\'s Defiant', () => {
    const state = battle(
      [{ spe: 200, moves: slot('MOVE_TACKLE'), pp: pps, abilities: ability('ABILITY_WHIPLASH') }, { spe: 50, abilities: ability('ABILITY_DEFIANT') }],
      scripted(),
    )
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], deps(fixedDamage(20)))
    expect(state.battlers[1]!.mon.hp).toBe(80)
    expect(stages(state, 1)[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stages(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  it('negative: Weak Armor\'s own Defense drop does not wake the holder\'s Defiant', () => {
    // A successful Weak Armor drop leaves the chooser at B_MSG_DEFENDER_STAT_FELL (1), which is
    // less than B_MSG_STAT_WONT_DECREASE (2), so data/battle_scripts_1.s:10303 jumps to
    // BattleScript_WeakArmorDefAnim and prints STRINGID_TARGETABILITYSTATLOWER (:10309-10313) --
    // not STRINGID_DEFENDERSSTATFELL. PrepareStringBattle's onStatLowered block only runs for the
    // latter (src/battle_util.c:1222-1255), so Defiant stays put.
    const state = battle(
      [
        { spe: 200, moves: slot('MOVE_TACKLE'), pp: pps },
        { spe: 50, abilities: ability('ABILITY_WEAK_ARMOR', 'ABILITY_DEFIANT') },
      ],
      scripted(),
    )
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], deps(fixedDamage(20)))
    expect(state.battlers[1]!.mon.hp).toBe(80)
    expect(stages(state, 1)[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stages(state, 1)[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(stages(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('Serpent Bind (abilities.cc:12008-12024) drops the wrapped target\'s Speed and wakes Defiant', () => {
    const state = battle([{ abilities: ability('ABILITY_SERPENT_BIND') }, { abilities: ability('ABILITY_DEFIANT') }], scripted())
    state.battlers[1]!.mon.status2 |= STATUS2_WRAPPED
    state.wrappedBy[1] = 0
    state.battlers[1]!.volatiles.wrapTurns = 1 // ENDTURN_WRAP: 1 -> 0 ends the wrap without damage
    runEndTurnEffects(state, [0, 1], DATA_CONTEXT, { grounding: GROUNDING })
    expect(stages(state, 1)[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stages(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  it('Sap Trap (abilities.cc:11390-11411) drops the opposite battler\'s Speed and wakes Defiant', () => {
    const state = battle([{ abilities: ability('ABILITY_SAP_TRAP') }, { abilities: ability('ABILITY_DEFIANT') }], scripted())
    runEndTurnEffects(state, [0, 1], DATA_CONTEXT, { grounding: GROUNDING })
    expect(stages(state, 1)[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stages(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  it('negative: the same Sap Trap drop leaves a target without a reaction ability alone', () => {
    const state = battle([{ abilities: ability('ABILITY_SAP_TRAP') }, {}], scripted())
    runEndTurnEffects(state, [0, 1], DATA_CONTEXT, { grounding: GROUNDING })
    expect(stages(state, 1)[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stages(state, 1)[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// 5. onTrap -- IsAbilityPreventingEscape (src/battle_util.c:4826-4834) runs
//    ON_ABILITY(opponent, FALSE, onTrap) for each alive opposing battler. The
//    five onTrap bodies in the pinned snapshot (abilityHooks.json):
//      Arena Trap   -> IsBattlerGrounded(switching)
//      Magnet Pull  -> IS_BATTLER_OF_TYPE(switching, TYPE_STEEL)
//      Sap Trap     -> GetBattlerStatStage(switching, STAT_SPEED) <= 3
//      Shadow Tag / Frenzied Phantom -> !BattlerHasAbility(switching, FALSE,
//        the `shadowTag` bitfield), which only those two abilities carry, so a
//        second Shadow Tag holder escapes.
// ---------------------------------------------------------------------------

describe('cycle 104 - onTrap (IsAbilityPreventingEscape, src/battle_util.c:4826-4834)', () => {
  const ESCAPE_DEPS: EscapeDeps = { dataContext: DATA_CONTEXT, grounding: GROUNDING }

  it('Magnet Pull traps a Steel-type switcher only', () => {
    const steel = battle([{ types: ['STEEL', 'MYSTERY', 'MYSTERY'] }, { abilities: ability('ABILITY_MAGNET_PULL') }], scripted())
    expect(isAbilityPreventingEscape(steel, 0, ESCAPE_DEPS)).toEqual({ prevents: true, trappingBattlerId: 1, unmodelled: [] })

    const normal = battle([{}, { abilities: ability('ABILITY_MAGNET_PULL') }], scripted())
    expect(isAbilityPreventingEscape(normal, 0, ESCAPE_DEPS).prevents).toBe(false)
  })

  it('Shadow Tag traps, but not another Shadow Tag holder', () => {
    const trapped = battle([{}, { abilities: ability('ABILITY_SHADOW_TAG') }], scripted())
    expect(isAbilityPreventingEscape(trapped, 0, ESCAPE_DEPS).prevents).toBe(true)

    const mirror = battle([{ abilities: ability('ABILITY_SHADOW_TAG') }, { abilities: ability('ABILITY_SHADOW_TAG') }], scripted())
    expect(isAbilityPreventingEscape(mirror, 0, ESCAPE_DEPS).prevents).toBe(false)
  })

  it('Frenzied Phantom carries the same shadowTag bitfield', () => {
    const state = battle([{}, { abilities: ability('ABILITY_FRENZIED_PHANTOM') }], scripted())
    expect(isAbilityPreventingEscape(state, 0, ESCAPE_DEPS).prevents).toBe(true)

    const mirror = battle([{ abilities: ability('ABILITY_FRENZIED_PHANTOM', 'ABILITY_SHADOW_TAG') }, { abilities: ability('ABILITY_SHADOW_TAG') }], scripted())
    expect(isAbilityPreventingEscape(mirror, 0, ESCAPE_DEPS).prevents).toBe(false)
  })

  it('Arena Trap traps only a grounded switcher', () => {
    const grounded = battle([{}, { abilities: ability('ABILITY_ARENA_TRAP') }], scripted())
    expect(isAbilityPreventingEscape(grounded, 0, ESCAPE_DEPS).prevents).toBe(true)

    const flying = battle([{ types: ['FLYING', 'MYSTERY', 'MYSTERY'] }, { abilities: ability('ABILITY_ARENA_TRAP') }], scripted())
    expect(isAbilityPreventingEscape(flying, 0, ESCAPE_DEPS).prevents).toBe(false)
  })

  it('Sap Trap traps at Speed stage 3 but not at 4', () => {
    const slow = battle([{}, { abilities: ability('ABILITY_SAP_TRAP') }], scripted())
    slow.battlers[0]!.mon.statStages[STAT_SPEED] = 3
    expect(isAbilityPreventingEscape(slow, 0, ESCAPE_DEPS).prevents).toBe(true)

    const fast = battle([{}, { abilities: ability('ABILITY_SAP_TRAP') }], scripted())
    fast.battlers[0]!.mon.statStages[STAT_SPEED] = 4
    expect(isAbilityPreventingEscape(fast, 0, ESCAPE_DEPS).prevents).toBe(false)
  })

  it('negative: Shed Shell, a Ghost type, and a Gastro Acid-suppressed trapper all let the switcher go', () => {
    const shedShell = battle([{ itemId: 'ITEM_SHED_SHELL' }, { abilities: ability('ABILITY_SHADOW_TAG') }], scripted())
    expect(isAbilityPreventingEscape(shedShell, 0, ESCAPE_DEPS).prevents).toBe(false)

    const ghost = battle([{ types: ['GHOST', 'MYSTERY', 'MYSTERY'] }, { abilities: ability('ABILITY_SHADOW_TAG') }], scripted())
    expect(isAbilityPreventingEscape(ghost, 0, ESCAPE_DEPS).prevents).toBe(false)

    const suppressed = battle([{}, { abilities: ability('ABILITY_SHADOW_TAG') }], scripted())
    suppressed.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    expect(isAbilityPreventingEscape(suppressed, 0, ESCAPE_DEPS).prevents).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. onRevive, the faint half -- Cmd_tryfaintmon's scan
//    (src/battle_script_commands.c:3184-3197): for a fainted battler, ON_ABILITY
//    with `onRevive && !GetSingleUseAbilityCountByIndex(battler, idx)`, and on a
//    message the slot's counter is set to 1. Recurring Nightmare's body
//    (abilities.cc:7895-7903) is CHECK(IsBattlerWeatherAffected(battler,
//    WEATHER_FOG_ANY)); return B_MSG_FADE_OUT. The counters live in
//    gBattleStruct->singleuseability[partyIndex][slot][side]
//    (include/battle.h:726, battle_util.c:3943-3961) and are never cleared.
//
//    And the replacement half -- VARIOUS_TRY_RECURRING_NIGHTMARE
//    (battle_script_commands.c:8645-8655), run by BattleScript_HandleFaintedMon's
//    `tryrecurringnightmare BS_FAINTED` (data/battle_scripts_1.s:6958): when the
//    counter is exactly 1, set it to 2 and write the PARTY mon's HP to
//    maxHP / 4, minimum 1.
// ---------------------------------------------------------------------------

describe('cycle 104 - onRevive latches on faint and revives the party mon on replacement', () => {
  const RN = ability('ABILITY_RECURRING_NIGHTMARE')

  it('in fog: counter 1 at faint, then the party mon comes back at maxHP/4 = 25 with counter 2', () => {
    const state = battle(
      [{ spe: 50, hp: 10, abilities: RN }, { spe: 200 }],
      scripted(),
      [partyMon({ hp: 10, maxHp: 100, abilities: RN }), partyMon({ hp: 70, maxHp: 80 })],
      [partyMon()],
    )
    state.field.weather = WEATHER_FOG_PERMANENT
    const rep = replacementDeps(1)
    executeTurn(state, [null, useMove(0, move('MOVE_TACKLE'))], deps(fixedDamage(999), rep))

    expect(rep.calls).toEqual([0])
    // max(1, 100 / 4) = 25 written to party slot 0, not to the fainted battler.
    expect(state.sides[0].party[0]!.hp).toBe(25)
    expect(state.singleUseAbility[0]![0]![0]).toBe(2)
    // The replacement took the field; the revived mon stays in the party.
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.hp).toBe(70)
  })

  it('negative: no fog, no revive -- the counter stays 0 and the party HP stays 0', () => {
    const state = battle(
      [{ spe: 50, hp: 10, abilities: RN }, { spe: 200 }],
      scripted(),
      [partyMon({ hp: 10, maxHp: 100, abilities: RN }), partyMon({ hp: 70, maxHp: 80 })],
      [partyMon()],
    )
    executeTurn(state, [null, useMove(0, move('MOVE_TACKLE'))], deps(fixedDamage(999), replacementDeps(1)))

    expect(state.sides[0].party[0]!.hp).toBe(0)
    expect(state.singleUseAbility[0]![0]![0]).toBe(0)
  })

  it('negative: Gastro Acid suppresses the latch (ON_ABILITY\'s FILTER_NOT(IsSuppressed))', () => {
    const state = battle(
      [{ spe: 50, hp: 10, abilities: RN }, { spe: 200 }],
      scripted(),
      [partyMon({ hp: 10, maxHp: 100, abilities: RN }), partyMon({ hp: 70, maxHp: 80 })],
      [partyMon()],
    )
    state.field.weather = WEATHER_FOG_PERMANENT
    state.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    executeTurn(state, [null, useMove(0, move('MOVE_TACKLE'))], deps(fixedDamage(999), replacementDeps(1)))

    expect(state.sides[0].party[0]!.hp).toBe(0)
    expect(state.singleUseAbility[0]![0]![0]).toBe(0)
  })

  it('negative: Neutralizing Gas suppresses the latch as well', () => {
    // IsSuppressed (src/battle_util.c:9254-9258) tests gFieldTimers.neutralizingGas without
    // exempting `.persistent` abilities -- only `.unsuppressable` ones skip that clause
    // (IsUnsuppressableAbility, :4788). Recurring Nightmare's snapshot entry has
    // "persistent": "TRUE" and no unsuppressable flag (data/v2.65beta/abilityHooks.json), so
    // ON_ABILITY's FILTER_NOT(IsSuppressed(...)) rejects it under Neutralizing Gas.
    const state = battle(
      [{ spe: 50, hp: 10, abilities: RN }, { spe: 200 }],
      scripted(),
      [partyMon({ hp: 10, maxHp: 100, abilities: RN }), partyMon({ hp: 70, maxHp: 80 })],
      [partyMon()],
    )
    state.field.weather = WEATHER_FOG_PERMANENT
    state.field.timers.neutralizingGas = true
    executeTurn(state, [null, useMove(0, move('MOVE_TACKLE'))], deps(fixedDamage(999), replacementDeps(1)))

    expect(state.sides[0].party[0]!.hp).toBe(0)
    expect(state.singleUseAbility[0]![0]![0]).toBe(0)
  })

  it('the low-HP revive floor is 1, not 0', () => {
    // maxHP / 4 with integer division is 0 for maxHP <= 3, and the C then sets
    // gBattleMoveDamage to 1 (battle_script_commands.c:8649-8650).
    const state = battle(
      [{ spe: 50, hp: 3, maxHp: 3, abilities: RN }, { spe: 200 }],
      scripted(),
      [partyMon({ hp: 3, maxHp: 3, abilities: RN }), partyMon({ hp: 70, maxHp: 80 })],
      [partyMon()],
    )
    state.field.weather = WEATHER_FOG_PERMANENT
    executeTurn(state, [null, useMove(0, move('MOVE_TACKLE'))], deps(fixedDamage(999), replacementDeps(1)))

    expect(state.sides[0].party[0]!.hp).toBe(1)
    expect(state.singleUseAbility[0]![0]![0]).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 7. Destiny Bond disables the revive -- Cmd_tryfaintmon's own block
//    (battle_script_commands.c:3244-3250): once the bond is armed and the
//    target faints to the other side, both ON_ABILITY scans run WITHOUT a
//    counter test and write 2 into every onRevive slot of gBattlerAttacker and
//    gBattlerTarget. var 2 is what VARIOUS_TRY_RECURRING_NIGHTMARE's `== 1`
//    test rejects, so neither mon is revived.
// ---------------------------------------------------------------------------

describe('cycle 104 - Destiny Bond sets the onRevive counter to 2 for both battlers', () => {
  const RN = ability('ABILITY_RECURRING_NIGHTMARE')

  it('both sides end at counter 2 and neither party slot is revived', () => {
    const state = battle(
      [
        { spe: 200, hp: 10, abilities: RN },
        { spe: 50, hp: 10, abilities: RN, status2: STATUS2_DESTINY_BOND },
      ],
      scripted(),
      [partyMon({ hp: 10, maxHp: 100, abilities: RN }), partyMon({ hp: 70, maxHp: 80 })],
      [partyMon({ hp: 10, maxHp: 100, abilities: RN }), partyMon({ hp: 60, maxHp: 80 })],
    )
    state.field.weather = WEATHER_FOG_PERMANENT
    const rep = replacementDeps(1)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], deps(fixedDamage(999), rep))

    // The bond took the attacker with it, and both counters were written to 2
    // -- attacker slot 0 (side 0) and target slot 0 (side 1).
    expect(state.singleUseAbility[0]![0]![0]).toBe(2)
    expect(state.singleUseAbility[0]![0]![1]).toBe(2)
    // Neither fainted mon was revived: the party HP stays 0 even though the
    // weather was fog and both held Recurring Nightmare.
    expect(state.sides[0].party[0]!.hp).toBe(0)
    expect(state.sides[1].party[0]!.hp).toBe(0)
    // Both sides had a reserve, so the battle continues with them on the field.
    expect(state.battleOutcome).toBe(null)
    expect(rep.calls).toEqual([0, 1])
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[1]!.partyIndex).toBe(1)
  })
})
