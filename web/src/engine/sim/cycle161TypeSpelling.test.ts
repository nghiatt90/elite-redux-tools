/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 161: the production loader strips the TYPE_ prefix from BOTH move and species types
// (`loadSimData.ts:142`, `:188`, `:214`), so `moveData.type === 'TYPE_X'` / `mon.types.includes(
// 'TYPE_X')` is dead in production. Each production fix below gets a positive and a negative case
// whose data context is `loadSimData()` (the real loader shape), plus the item-2 mutation test that
// proves a `!==` comparison is no longer branch evidence.
//
// C lines checked:
//   Reverbate            abilities.cc:10656-10662 (`CHECK(gBattleMoves[move].type == TYPE_NORMAL)`)
//   MOVEEND_CHARGE       battle_script_commands.c:4922-4934 (`currentMoveType == TYPE_ELECTRIC`)
//   Curse target         battle_util.c:6353-6360 (`IS_BATTLER_OF_TYPE(attacker, TYPE_GHOST)`)
//   Tangling Husk        battle_util.c:6618-6620 (`if (moveType != TYPE_FIRE) return PROTECT_BLOCK;`)
//   Trace exemption      battle_util.c:9189-9195 (excluded from CheckAndSetSwitchInAbility)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { extractReviveAbilities, extractSwitchInAbilities } from './driver/abilityHookInventory'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { createBattleState, createBattlerState } from './create'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn, getMoveTarget, isBattlerProtected, ProtectType } from './turn'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { STATUS2_CONFUSION, STATUS3_CHARGED_UP, hasFlag } from './constants'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  // The species record comes from the production data context, so its types are already stripped
  // exactly as the loader does it (loadSimData.ts:142).
  const s = DATA_CONTEXT.species(speciesId)
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  return {
    speciesId,
    rawStats: { ...STATS },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    hp: 300,
    maxHp: 300,
    itemId: null,
    statStages: [],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
    // Last, so an override wins AND is cloned.
    types: [...(overrides.types ?? [s.types[0] ?? 'MYSTERY', s.types[1] ?? 'MYSTERY', s.types[2] ?? 'MYSTERY'])] as [
      string,
      string,
      string,
    ],
  }
}

const defender = (overrides: Partial<SimBattleMon> = {}): SimBattleMon =>
  monFor('SPECIES_MUDKIP', { rawStats: { ...STATS, spe: 50 }, ...overrides })

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return values[idx++] ?? 0
    },
  }
  return rng
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource = scriptedRng([])): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
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

/** A resolver that returns a fixed amount with no draws; the turn loop still draws accuracy
 *  (and any secondary chance) itself. */
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

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    grounding: groundingFor(SIM, state),
    damage,
    statStageRatios: SIM.statStageRatios,
    dataContext: DATA_CONTEXT,
    moveBehaviors: SIM.moveBehaviors,
    hazardTypes: { typeChart: SIM.typeChart, inverseTypeChart: SIM.inverseTypeChart, inverseBattle: false },
  }
}

// ---------------------------------------------------------------------------
// Reverbate: SOUND granted to Normal-type moves (abilities.cc:10656-10662)
// ---------------------------------------------------------------------------

describe('cycle 161 - Reverbate reads the loader bare type', () => {
  const reverbateLoudBang: SimBattleMon['abilities'] = {
    ability: 'ABILITY_LOUD_BANG',
    innates: ['ABILITY_REVERBATE', null, null],
  }

  it('a Normal move becomes sound, so Loud Bang confuses (abilities.cc:3899-3906)', () => {
    // Reverbate: CHECK(flag == MOVE_FLAG_SOUND), CHECK(gBattleMoves[move].type == TYPE_NORMAL)
    // -> TRUE. Loud Bang then draws `random16() % 2` and confuses on odd (:3901-3905).
    // Draw order: accuracy 0 (hit), Loud Bang 1 (odd -> confuse), confusion duration 0.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: reverbateLoudBang }), defender(), rng)
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(20)))

    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
    expect(rng.calls).toBe(3)
  })

  it('a non-Normal move does not get SOUND (negative)', () => {
    // Ember is FIRE (`moves.json` -> loader `type: 'FIRE'`), so the Reverbate CHECK is false and
    // Loud Bang's `random16() % 2` is never drawn: only the accuracy roll remains.
    const rng = scriptedRng([0])
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: reverbateLoudBang }), defender(), rng)
    executeTurn(state, [useMove(1, 'MOVE_EMBER'), null], loopDeps(state, fixedDamage(20)))

    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// MOVEEND_CHARGE (battle_script_commands.c:4922-4934)
// ---------------------------------------------------------------------------

describe('cycle 161 - MOVEEND_CHARGE reads the loader bare type', () => {
  it('an Electric damaging move clears STATUS3_CHARGED_UP', () => {
    // :4928 `currentMoveType == TYPE_ELECTRIC && gBattleMoves[gCurrentMove].power &&
    // !(status2 & STATUS2_MULTIPLETURNS)` -> `gStatuses3[battler] &= ~STATUS3_CHARGED_UP`.
    const rng = scriptedRng([0])
    const state = battle(monFor('SPECIES_MUDKIP'), defender(), rng)
    state.battlers[0]!.statuses3 |= STATUS3_CHARGED_UP
    executeTurn(state, [useMove(1, 'MOVE_THUNDERBOLT'), null], loopDeps(state, fixedDamage(50)))

    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(false)
  })

  it('a non-Electric move leaves the flag set (negative)', () => {
    // Tackle's loader type is 'NORMAL', so :4928's first clause is false and the flag survives.
    const rng = scriptedRng([0])
    const state = battle(monFor('SPECIES_MUDKIP'), defender(), rng)
    state.battlers[0]!.statuses3 |= STATUS3_CHARGED_UP
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(50)))

    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Curse target (battle_util.c:6353-6360)
// ---------------------------------------------------------------------------

describe('cycle 161 - Curse target reads the loader bare species type', () => {
  it('a Ghost user targets the foe', () => {
    // :6354-6355 `if (IS_BATTLER_OF_TYPE(attacker, TYPE_GHOST)) moveTarget = MOVE_TARGET_SELECTED;`
    // The loader strips species.json's TYPE_GHOST to 'GHOST' (loadSimData.ts:142).
    const state = battle(monFor('SPECIES_GENGAR'), monFor('SPECIES_MUDKIP'))
    expect(getMoveTarget(state, 0, 'MOVE_CURSE', loopDeps(state, fixedDamage(0)))).toBe(1)
  })

  it('a non-Ghost user targets itself (negative)', () => {
    // :6358 `else moveTarget = MOVE_TARGET_USER;`
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'))
    expect(getMoveTarget(state, 0, 'MOVE_CURSE', loopDeps(state, fixedDamage(0)))).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tangling Husk protect (battle_util.c:6618-6620)
// ---------------------------------------------------------------------------

describe('cycle 161 - Tangling Husk reads the loader bare move type', () => {
  const protectedState = () => {
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'))
    state.battlers[1]!.round.protectMove = 'MOVE_TANGLING_HUSK'
    return state
  }

  it('blocks a non-Fire move', () => {
    // :6619 `if (moveType != TYPE_FIRE) return PROTECT_BLOCK;` -- Tackle's loader type is 'NORMAL'.
    const state = protectedState()
    expect(isBattlerProtected(state, 0, 1, 'MOVE_TACKLE', false, loopDeps(state, fixedDamage(0)), [])).toBe(
      ProtectType.PROTECT_BLOCK,
    )
  })

  it('lets a Fire move through (negative)', () => {
    // Flamethrower's loader type is 'FIRE', so :6619's `!=` is false and the switch breaks; no
    // side-wide guard applies, so the function reaches PROTECT_NONE.
    const state = protectedState()
    expect(isBattlerProtected(state, 0, 1, 'MOVE_FLAMETHROWER', false, loopDeps(state, fixedDamage(0)), [])).toBe(
      ProtectType.PROTECT_NONE,
    )
  })
})

// ---------------------------------------------------------------------------
// Item 2: `!==` is not branch evidence (the Trace exemption)
// ---------------------------------------------------------------------------

const SWITCH_IN_PATH = join(import.meta.dirname, 'switchInAbility.ts')

/** Removes the block whose header contains `marker` (from the marker through its matching `}`). */
function removeBranch(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  const open = source.indexOf('{', start)
  if (open === -1) throw new Error(`no block after ${marker}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(0, start) + source.slice(i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${marker}`)
}

describe('cycle 161 - inequality comparisons are not branch evidence', () => {
  it('deleting the Trace branch makes Trace unported even though `abilityId !== TRACE` survives', () => {
    const source = readFileSync(SWITCH_IN_PATH, 'utf8')
    expect(extractSwitchInAbilities(source).has('ABILITY_TRACE')).toBe(true)

    const mutated = removeBranch(source, "if (abilityId === 'ABILITY_TRACE') {")
    // The C exemption (battle_util.c:9189-9195) is still there; it is not a Trace port.
    expect(mutated).toContain("abilityId !== 'ABILITY_TRACE'")
    expect(extractSwitchInAbilities(mutated).has('ABILITY_TRACE')).toBe(false)
  })

  it('the unmutated source keeps Trace ported', () => {
    const source = readFileSync(SWITCH_IN_PATH, 'utf8')
    expect(extractSwitchInAbilities(source).has('ABILITY_TRACE')).toBe(true)
  })

  it('the one !==-only pair (Recurring Nightmare onRevive) keeps positive evidence', () => {
    // Its guards are written as `abilityId === 'ABILITY_RECURRING_NIGHTMARE'` blocks, so dropping
    // `!==` from the extractor does not flip a genuinely ported pair to unported.
    expect(extractReviveAbilities().has('ABILITY_RECURRING_NIGHTMARE')).toBe(true)
  })
})
