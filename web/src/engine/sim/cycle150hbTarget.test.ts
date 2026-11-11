/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150hb: MOVEEND_ABILITIES must dispatch on the CONTROLLER'S target, not on a
// universal move-target rule. Hand-derived from eliteredux-source at the pinned SHA:
//
// - Opponent controller (battle_controller_opponent.c:1598-1601 in the return-values
//   path, :1625-1626 in the no-return-values path):
//     if (gBattleMoves[move].target & (MOVE_TARGET_USER_OR_SELECTED | MOVE_TARGET_USER))
//         gBattlerTarget = gActiveBattler;
//   It reads the STATIC target only -- no Curse rule, no dynamic target flags. So an
//   AI non-Ghost Curse (static target SELECTED, data/v2.65beta/moves.json) keeps the
//   foe, while an AI Swords Dance (static USER) dispatches on itself.
// - Player controller (battle_controller_player.c:2385-2398):
//     MOVE_CURSE -> SELECTED when Ghost or under fog, else USER;
//     every other move -> GetBattlerBattleMoveTargetFlags (battle_util.c:128-150),
//     whose Rain Dance / Sunny Day / Sandstorm / Hail / Eerie Fog branch returns USER
//     unless the user has ABILITY_FORECAST (:134-143);
//     then `if (moveTarget & MOVE_TARGET_USER) gMultiUsePlayerCursor = gActiveBattler;`.
//   MOVE_TARGET_USER_OR_SELECTED (0x2) does not contain MOVE_TARGET_USER (0x10)
//   (include/constants/battle.h:493-501), so a player USER_OR_SELECTED move keeps the
//   foe.
//
// MOVEEND_ABILITIES runs AbilityBattleEffects(ABILITYEFFECT_MOVE_END, gBattlerTarget)
// (battle_script_commands.c:4527-4531, battle_util.c:4485-4489) with no damage gate,
// so a status move's success tail reaches it too.
//
// Probe: Crispy Cream's onDefender (src/abilities.cc:10837-10842) draws `Random() % 2`
// BEFORE either delegated hook and before its own zero-damage check. One draw from a
// dispatch therefore means "MOVEEND_ABILITIES dispatched on this battler"; zero means
// it did not. Every expectation below is that draw count, derived by hand from the C.
//
// Reversion note: the parent commit applied the Curse rule to BOTH sides and otherwise
// read the static target. Tests 1, 2 and 5 fail when that rule is restored. Test 3 and
// test 4 are pins the parent already satisfied: test 3's Forecast branch falls through
// to the static target, which is exactly what the old static rule returned, and test
// 4's self/foe cases agree with the old rule. See REPORT.md.
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
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle150hTarget.test.ts.
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

/** data/v2.65beta/moves.json (and er-config MoveList.textproto) contain NO move
 * whose target is USER_OR_SELECTED -- `grep -c USER_OR_SELECTED` on both is 0 -- even
 * though MoveList.proto declares the enum value. Test 5 therefore substitutes the
 * static target of a real status move on the data-context seam; it does not invent a
 * move or guess a tournament-relevant one. */
function dataContextWithTarget(moveId: string, target: string): SimDataContext {
  return {
    ...DATA_CONTEXT,
    move: (id) => {
      const m = DATA_CONTEXT.move(id)
      if (!m || id !== moveId) return m
      return { ...m, target }
    },
  }
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

function battle(
  specs: BattlerSpec[],
  rng: RandomSource = scriptedRng([0]),
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {},
): BattleState {
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
    ...opts,
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

function testDeps(
  damage: DamageResolver = fixedDamage(20),
  grounding: GroundingContext = GROUNDING,
  dataContext: SimDataContext = DATA_CONTEXT,
): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const hasAbility = (ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })

/** Runs one turn with a draw-counting RNG. `deps` defaults to a zero-damage resolver:
 * these are all status moves, so the damage seam must not fabricate a hit. `prepare`
 * mutates the freshly built state before the turn starts; test 3 uses it to isolate
 * the target dispatch from Forecast's unrelated onAttacker follow-up. */
function runTurn(
  specs: BattlerSpec[],
  actions: (ChosenAction | null)[],
  deps: TurnLoopDeps = testDeps(fixedDamage(0)),
  prepare?: (state: BattleState) => void,
) {
  const rng = scriptedRng([0])
  const state = battle(specs, rng)
  prepare?.(state)
  const out = executeTurn(state, actions, deps)
  return { rng, state, out }
}

// ---------------------------------------------------------------------------
// 1. AI (opponent controller) -- static target only. A non-Ghost Curse's static
//    target is SELECTED, so the foe keeps the dispatch.
// ---------------------------------------------------------------------------

describe('Cycle 150hb - MOVEEND_ABILITIES dispatch follows the acting controller', () => {
  it('1a: AI non-Ghost Curse dispatches on the foe (foe Crispy Cream draws once)', () => {
    // battle_controller_opponent.c:1600-1601: SELECTED (0x0) & (USER_OR_SELECTED|USER)
    // == 0, so gBattlerTarget stays the foe the controller selected. Crispy Cream on
    // that foe (battler 0) spends its unconditional %2 (abilities.cc:10837-10842).
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 200, moves: ['MOVE_CURSE', null, null, null], pp: [10, 0, 0, 0] },
      ],
      [null, useMove(0, move('MOVE_CURSE'))],
    )
    expect(rng.calls).toBe(1)
  })

  it('1b: the same AI Curse does not dispatch on the AI itself (own Crispy Cream draws none)', () => {
    // The parent commit's Curse rule (Ghost/fog -> SELECTED, else USER) applied to the
    // AI too and would have turned this into one draw on battler 1. The opponent
    // controller has no Curse rule, so the AI's own holder is never the target.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50 },
        { hp: 300, spe: 200, moves: ['MOVE_CURSE', null, null, null], pp: [10, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [null, useMove(0, move('MOVE_CURSE'))],
    )
    expect(rng.calls).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 2. Player -- GetBattlerBattleMoveTargetFlags. Rain Dance's static target is
  //    SELECTED but the dynamic flags return USER without Forecast, and the
  //    player controller tests `& MOVE_TARGET_USER`.
  // -------------------------------------------------------------------------

  it('2a: player Rain Dance dispatches on the user (own Crispy Cream draws once)', () => {
    // battle_controller_player.c:2392-2397 -> battle_util.c:134-139: no Forecast
    // means MOVE_TARGET_USER, so gMultiUsePlayerCursor = gActiveBattler.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 200, moves: ['MOVE_RAIN_DANCE', null, null, null], pp: [10, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 50 },
      ],
      [useMove(1, move('MOVE_RAIN_DANCE')), null],
    )
    expect(rng.calls).toBe(1)
  })

  it('2b: player Rain Dance does not dispatch on the foe (foe Crispy Cream draws none)', () => {
    // The parent commit read the static SELECTED target here and would have drawn on
    // battler 1; the dynamic USER flag moves the dispatch to battler 0.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 200, moves: ['MOVE_RAIN_DANCE', null, null, null], pp: [10, 0, 0, 0] },
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [useMove(1, move('MOVE_RAIN_DANCE')), null],
    )
    expect(rng.calls).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 3. Player Rain Dance under Forecast: the dynamic branch falls through to the
  //    static SELECTED target (battle_util.c:138-143), so the foe is dispatched.
  // -------------------------------------------------------------------------

  it('3: player Rain Dance with Forecast falls back to SELECTED and dispatches on the foe', () => {
    // `if (!BATTLER_HAS_ABILITY(battler, ABILITY_FORECAST)) return MOVE_TARGET_USER;`
    // -- with Forecast there is no early return, the function returns the static
    // SELECTED target, and SELECTED & MOVE_TARGET_USER is 0.
    //
    // Forecast is ALSO in ATTACKER_FOLLOWUP_ABILITIES (moveEnd.ts:4436-4448): its
    // onAttacker hook queues a power-0 Weather Ball, which this loop would drain as a
    // real extra attack whose accuracy roll and own MOVEEND dispatch draw too. The sim's
    // own isolation convention (`canUseExtraMove`'s `!round.attackCancelled`, mirrored
    // from battle_util.c:8716-8722) suppresses that unrelated follow-up so both counts
    // below are the dispatch itself. Target flags never read attackCancelled.
    const suppressForecastFollowUp = (s: BattleState) => {
      s.battlers[0]!.round.attackCancelled = true
    }
    const foeHolder = runTurn(
      [
        { hp: 300, spe: 200, moves: ['MOVE_RAIN_DANCE', null, null, null], pp: [10, 0, 0, 0], abilities: hasAbility('ABILITY_FORECAST') },
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [useMove(1, move('MOVE_RAIN_DANCE')), null],
      testDeps(fixedDamage(0)),
      suppressForecastFollowUp,
    )
    expect(foeHolder.rng.calls).toBe(1)

    // Same turn with the holder on the user instead: the user is not gBattlerTarget,
    // so its own Crispy Cream does not draw. This half catches an implementation that
    // returned USER for Rain Dance without consulting Forecast.
    const userHolder = runTurn(
      [
        {
          hp: 300,
          spe: 200,
          moves: ['MOVE_RAIN_DANCE', null, null, null],
          pp: [10, 0, 0, 0],
          abilities: hasAbility('ABILITY_FORECAST', ['ABILITY_CRISPY_CREAM', null, null]),
        },
        { hp: 300, spe: 50 },
      ],
      [useMove(1, move('MOVE_RAIN_DANCE')), null],
      testDeps(fixedDamage(0)),
      suppressForecastFollowUp,
    )
    expect(userHolder.rng.calls).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 4. Negatives: both sides still dispatch on themselves for their own
  //    self-targeting shapes, and the player's Curse rule still splits on typing.
  // -------------------------------------------------------------------------

  it('4a: player non-Ghost Curse dispatches on the user', () => {
    // battle_controller_player.c:2389-2396: no Ghost and no fog -> MOVE_TARGET_USER.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 200, moves: ['MOVE_CURSE', null, null, null], pp: [10, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 50 },
      ],
      [useMove(1, move('MOVE_CURSE')), null],
    )
    expect(rng.calls).toBe(1)
  })

  it('4b: player Ghost Curse dispatches on the foe', () => {
    // :2389-2394: a Ghost type takes the MOVE_TARGET_SELECTED branch, so the foe is
    // the target and the user's own holder does not draw.
    const { rng } = runTurn(
      [
        {
          hp: 300,
          spe: 200,
          types: ['GHOST', 'MYSTERY', 'MYSTERY'],
          moves: ['MOVE_CURSE', null, null, null],
          pp: [10, 0, 0, 0],
          abilities: hasAbility('ABILITY_CRISPY_CREAM'),
        },
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [useMove(1, move('MOVE_CURSE')), null],
    )
    // Exactly one draw: the foe's holder. The user's holder is not dispatched on.
    expect(rng.calls).toBe(1)
  })

  it('4c: AI Swords Dance (static USER) dispatches on itself', () => {
    // battle_controller_opponent.c:1600-1601: MOVE_TARGET_USER -> gActiveBattler.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50 },
        {
          hp: 300,
          spe: 200,
          moves: ['MOVE_SWORDS_DANCE', null, null, null],
          pp: [20, 0, 0, 0],
          abilities: hasAbility('ABILITY_CRISPY_CREAM'),
        },
      ],
      [null, useMove(0, move('MOVE_SWORDS_DANCE'))],
    )
    expect(rng.calls).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 5. Player USER_OR_SELECTED: the bit test is MOVE_TARGET_USER (0x10), which
  //    USER_OR_SELECTED (0x2) does not carry, so the foe keeps the dispatch.
  // -------------------------------------------------------------------------

  it('5: player USER_OR_SELECTED keeps the foe (MOVE_TARGET_USER bit is clear)', () => {
    // No released move has this static target (moves.json and MoveList.textproto both
    // contain zero occurrences), so the target is substituted on the data-context
    // seam. battle_controller_player.c:2398 tests only `& MOVE_TARGET_USER`; the
    // parent commit's static rule treated USER_OR_SELECTED as self on both sides.
    const deps = testDeps(fixedDamage(0), GROUNDING, dataContextWithTarget('MOVE_SWORDS_DANCE', 'USER_OR_SELECTED'))
    const foeHolder = runTurn(
      [
        { hp: 300, spe: 200, moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [20, 0, 0, 0] },
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [useMove(1, move('MOVE_SWORDS_DANCE')), null],
      deps,
    )
    expect(foeHolder.rng.calls).toBe(1)

    const userHolder = runTurn(
      [
        { hp: 300, spe: 200, moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [20, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 50 },
      ],
      [useMove(1, move('MOVE_SWORDS_DANCE')), null],
      deps,
    )
    expect(userHolder.rng.calls).toBe(0)
  })
})
