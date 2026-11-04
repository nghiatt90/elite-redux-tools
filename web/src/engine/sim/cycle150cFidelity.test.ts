/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { runMoveEnd } from './moveEnd'
import { applySwitchInAbilities } from './switchInAbility'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { STAT_ATK, STATUS1_PARALYSIS } from './constants'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle149Abilities.test.ts.
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

function battle(specs: BattlerSpec[], rng: RandomSource = scriptedRng([0])): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 300,
          maxHp: s.maxHp ?? 300,
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

function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : 'NORMAL',
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

function fixedDamage(amount: number, isCriticalHit = false): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function testDeps(damage: DamageResolver = fixedDamage(20), grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const hasAbility = (ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })

function runTurn(attackerSpec: BattlerSpec, defenderSpec: BattlerSpec, moveId: string, dmg: number, rolls: number[] = [0, 0]) {
  const state = battle([
    { moves: [moveId, null, null, null], ...attackerSpec },
    defenderSpec,
  ], scriptedRng(rolls))
  const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(dmg)))
  return { state, out }
}

// ---------------------------------------------------------------------------
// Suspicion 1: the MOVEEND_ABILITIES call site has no damage gate
// (battle_script_commands.c:4527-4531; battle_util.c:4485-4489, :9050-9084).
// ---------------------------------------------------------------------------

describe('Cycle 150c 1 - defender move-end abilities run on a zero-damage move', () => {
  // Ape Shift onDefender (abilities.cc:9065 -> ApeShiftHandler :9047-9067) has no damage gate.
  // gHpTransformations (battle_util.c:3798-3810, columns "form >, form <=") maps APE_SHIFT to
  // (SLAKING_MEGA, SLAKING_MEGA_APE_SHIFT, 2; the row is :3807), so at or below half HP the holder
  // drops to the APE_SHIFT form (`species == highHpSpecies && hp <= maxHP / 2`, :3831-3835): 100 of 300 is <= 150.
  it('Ape Shift switches form on a status move (0 damage): SLAKING_MEGA at 100/300 HP -> SLAKING_MEGA_APE_SHIFT', () => {
    const apeshift = hasAbility('ABILITY_APE_SHIFT')
    const direct = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null] },
      { speciesId: 'SPECIES_SLAKING_MEGA', hp: 100, maxHp: 300, abilities: apeshift },
    ], scriptedRng([0]))
    runMoveEnd({
      state: direct,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_CONFUSE_RAY',
      targetDamage: 0,
      hpDealt: 0,
      deps: testDeps(fixedDamage(0)),
      unmodelled: [],
      fainted: [],
    })
    expect(direct.battlers[1]!.mon.speciesId).toBe('SPECIES_SLAKING_MEGA_APE_SHIFT')

    const { state } = runTurn(
      { hp: 300 },
      { speciesId: 'SPECIES_SLAKING_MEGA', hp: 100, maxHp: 300, abilities: apeshift },
      'MOVE_CONFUSE_RAY',
      0,
      [0, 0, 0, 0],
    )
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_SLAKING_MEGA_APE_SHIFT')
  })

  // Static (abilities.cc:610-618): CHECK(ShouldApplyOnHitEffect(opponent)) = DidMoveHit() && IsBattlerAlive.
  // A status move deals no damage, so DidMoveHit is false and the hook returns before its roll.
  it('Static does NOT fire on a status move, and does fire on a damaging hit (roll 0 < 30 contact)', () => {
    const staticMon = hasAbility('ABILITY_STATIC')

    const statusState = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null] },
      { hp: 300, abilities: staticMon },
    ], scriptedRng([0]))
    runMoveEnd({
      state: statusState,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_CONFUSE_RAY',
      targetDamage: 0,
      hpDealt: 0,
      deps: testDeps(fixedDamage(0)),
      unmodelled: [],
      fainted: [],
    })
    expect(statusState.battlers[0]!.mon.status1 & STATUS1_PARALYSIS).toBe(0)
    // The gate returns before `Random() % 100 < chance` (:614), so nothing is drawn.
    expect((statusState.rng as RandomSource & { calls: number }).calls).toBe(0)

    const hit = runTurn({ hp: 300 }, { hp: 300, abilities: staticMon }, 'MOVE_TACKLE', 20, [0, 0])
    expect(hit.state.battlers[0]!.mon.status1 & STATUS1_PARALYSIS).toBe(STATUS1_PARALYSIS)
  })

  // Aftermath's own onDefender (abilities.cc:1662-1669) gates only on CHECK_NOT(IsBattlerAlive(battler)) --
  // no ShouldApplyOnHitEffect. A zero-damage move against an already-fainted holder still queues the
  // Outburst/Explosion counterattack (the move-end pass runs for the dead gBattlerTarget).
  it('Aftermath fires for a fainted holder even when the move dealt no damage (C has no damage gate)', () => {
    const state = battle([
      { moves: ['MOVE_CONFUSE_RAY', null, null, null] },
      { hp: 0, abilities: hasAbility('ABILITY_AFTERMATH') },
    ], scriptedRng([0, 0]))
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_CONFUSE_RAY',
      targetDamage: 0,
      hpDealt: 0,
      deps: testDeps(fixedDamage(0)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.queuedExtraAttacks.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Suspicion 2: Trace skips CheckAndSetSwitchInAbility
// (battle_util.c:9189-9194).
// ---------------------------------------------------------------------------

describe('Cycle 150c 2 - Trace is exempt from the once-per-switch-in flag', () => {
  it('Trace still traces when switchInAbilityDone is already set, and clears that flag (abilities.cc:963)', () => {
    const state = battle([
      { abilities: hasAbility('ABILITY_TRACE') },
      { abilities: hasAbility('ABILITY_LIMBER') },
    ])
    // A previous entry already set the slot's flag. The C's `case ABILITY_TRACE: break;` (:9190-9191)
    // means Trace never calls CheckAndSetSwitchInAbility, so this cannot block it.
    state.battlers[0]!.volatiles.switchInAbilityDone[0] = true
    applySwitchInAbilities(state, 0, testDeps(), [])
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_LIMBER')
    // Trace's own hook writes gVolatileStructs[battler].switchInAbilityDone[index] = FALSE (:963).
    expect(state.battlers[0]!.volatiles.switchInAbilityDone[0]).toBe(false)
  })

  it('Intimidate is still blocked by the flag; a fresh flag lowers the foe Attack (5 from 6)', () => {
    const blocked = battle([
      { abilities: hasAbility('ABILITY_INTIMIDATE') },
      { hp: 300 },
    ])
    blocked.battlers[0]!.volatiles.switchInAbilityDone[0] = true
    applySwitchInAbilities(blocked, 0, testDeps(), [])
    expect(blocked.battlers[0]!.volatiles.switchInAbilityDone[0]).toBe(true)
    expect(blocked.battlers[1]!.mon.statStages[STAT_ATK]).toBe(6)

    const fresh = battle([
      { abilities: hasAbility('ABILITY_INTIMIDATE') },
      { hp: 300 },
    ])
    applySwitchInAbilities(fresh, 0, testDeps(), [])
    expect(fresh.battlers[0]!.volatiles.switchInAbilityDone[0]).toBe(true)
    expect(fresh.battlers[1]!.mon.statStages[STAT_ATK]).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Suspicion 3: Cursed Body disables gChosenMove and reads pp[gChosenMovePos]
// (abilities.cc:1910-1924; gChosenMovePos is set at battle_util.c:195-197).
// ---------------------------------------------------------------------------

describe('Cycle 150c 3 - Cursed Body uses the chosen move and the chosen slot', () => {
  // Cmd_jumptocalledmove (battle_script_commands.c:5907-5914): with the nonzero argument the sim's
  // jumpToCalledMove(keepChosenMove=true) models, only gCurrentMove is replaced; gChosenMove stays
  // the calling move (Copycat). gChosenMovePos is the selected slot, also still Copycat's.
  it('a called move (Copycat -> Tackle) disables Copycat, the chosen move', () => {
    const state = battle([
      { moves: ['MOVE_TACKLE', 'MOVE_COPYCAT', null, null], pp: [20, 5, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], scriptedRng([29]))
    state.chosenMovePositions[0] = 1 // the writer at turn.ts:4594 records the selected Copycat slot
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      chosenMoveId: 'MOVE_COPYCAT',
      targetDamage: 20,
      hpDealt: 20,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.battlers[0]!.volatiles.disabledMove).toBe('MOVE_COPYCAT')
    expect(state.battlers[0]!.volatiles.disableTimer).toBe(4)
  })

  // Sleep Talk is a QUEUED extra attack, and HandleAction_UseMove overwrites both gCurrentMove and
  // gChosenMove with it (battle_util.c:204): the disable lands on the called move. gChosenMovePos is
  // NOT overwritten, so CHECK(gBattleMons[attacker].pp[gChosenMovePos]) still reads the selected
  // Sleep Talk slot (:200 vs :205-209). With Sleep Talk at 0 PP the hook does not fire even though Tackle has PP.
  it('Sleep Talk: the pp CHECK reads the Sleep Talk slot, so 0 PP there blocks the disable', () => {
    const state = battle([
      { moves: ['MOVE_TACKLE', 'MOVE_SLEEP_TALK', null, null], pp: [20, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], scriptedRng([29]))
    state.chosenMovePositions[0] = 1
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      chosenMoveId: 'MOVE_TACKLE',
      targetDamage: 20,
      hpDealt: 20,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.battlers[0]!.volatiles.disabledMove).toBeNull()
    // The CHECK fails before `Random() % 100 < 30`, so no draw is taken.
    expect((state.rng as RandomSource & { calls: number }).calls).toBe(0)
  })

  it('Sleep Talk with PP in its slot disables the called move', () => {
    const state = battle([
      { moves: ['MOVE_TACKLE', 'MOVE_SLEEP_TALK', null, null], pp: [20, 10, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], scriptedRng([29]))
    state.chosenMovePositions[0] = 1
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      chosenMoveId: 'MOVE_TACKLE',
      targetDamage: 20,
      hpDealt: 20,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.battlers[0]!.volatiles.disabledMove).toBe('MOVE_TACKLE')
  })

  // Draw order through the real turn loop: Cmd_accuracycheck's roll (battle_script_commands.c:1433)
  // first, any seteffectwithchance secondary roll next, then Cursed Body's `Random() % 100 < 30`
  // (abilities.cc:1917). Tackle is 100% accurate with no secondary effect, so its only draw is the
  // ability roll: 30 fails the strict `< 30`, 29 passes.
  it('damaging Tackle vs Cursed Body: roll 30 does not disable, roll 29 does (one draw)', () => {
    const fail = runTurn({ hp: 300 }, { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') }, 'MOVE_TACKLE', 20, [0, 30])
    expect(fail.state.battlers[0]!.volatiles.disabledMove).toBeNull()
    expect((fail.state.rng as RandomSource & { calls: number }).calls).toBe(2) // accuracy + ability

    const pass = runTurn({ hp: 300 }, { hp: 300, abilities: hasAbility('ABILITY_CURSED_BODY') }, 'MOVE_TACKLE', 20, [0, 29])
    expect(pass.state.battlers[0]!.volatiles.disabledMove).toBe('MOVE_TACKLE')
    // The hook sets disableTimer = 4 (abilities.cc:1920); executeTurn then runs ENDTURN_DISABLE,
    // which decrements it (endTurn.ts:2104-2111) to 3.
    expect(pass.state.battlers[0]!.volatiles.disableTimer).toBe(3)
    expect((pass.state.rng as RandomSource & { calls: number }).calls).toBe(2)
  })
})
