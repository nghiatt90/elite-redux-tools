// Unit tests for the Protect move family, Endure, and protect blocking (step 5, batch 4).
//
// Every test case is hand-derived from the C source code at the pinned upstream SHA:
// - BattleScript_EffectProtect (data/battle_scripts_1.s:5034-5046)
// - BattleScript_EffectEndure (data/battle_scripts_1.s:5042-5046)
// - Cmd_setprotectlike (src/battle_script_commands.c:9161-9205)
// - ProtectSucceeds (src/battle_script_commands.c:6649-6655)
// - sProtectSuccessRates (src/battle_script_commands.c:727)
// - IsBattlerProtected (src/battle_util.c:6571-6645)
// - MOVEEND_PROTECT_LIKE_EFFECT (src/battle_script_commands.c:4343-4433)
// - Cmd_adjustdamage (src/battle_script_commands.c:1626-1676)
// - Cmd_accuracycheck / JumpIfMoveAffectedByProtect (src/battle_script_commands.c:1198-1210, 1422)
// - TurnValuesCleanUp (src/battle_main.c:3492, 4490)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import {
  ProtectType,
  executeTurn,
  isBattlerProtected,
  roundStructsClear,
} from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_NONE,
  STATUS1_POISON,
} from './constants'
import { handleProtect } from './moveEffects'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    target: m.target as string | undefined,
    priority: m.priority as number | undefined,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
  }
}

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}

// Assert IDs exist at module load
const MOVE_PROTECT = requireMove('MOVE_PROTECT')
const MOVE_KINGS_SHIELD = requireMove('MOVE_KINGS_SHIELD')
const MOVE_BANEFUL_BUNKER = requireMove('MOVE_BANEFUL_BUNKER')
const MOVE_SPIKY_SHIELD = requireMove('MOVE_SPIKY_SHIELD')
const MOVE_BURNING_BULWARK = requireMove('MOVE_BURNING_BULWARK')
const MOVE_OBSTRUCT = requireMove('MOVE_OBSTRUCT')
const MOVE_ENDURE = requireMove('MOVE_ENDURE')
const MOVE_CAMOUFLAGE = requireMove('MOVE_CAMOUFLAGE')
const MOVE_TACKLE = requireMove('MOVE_TACKLE')
const MOVE_SWIFT = requireMove('MOVE_SWIFT')
const MOVE_TOXIC = requireMove('MOVE_TOXIC')
const MOVE_SWORDS_DANCE = requireMove('MOVE_SWORDS_DANCE')

const ABILITY_UNSEEN_FIST = requireAbility('ABILITY_UNSEEN_FIST')
const ABILITY_SHIELD_DUST = requireAbility('ABILITY_SHIELD_DUST')

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
  species: () => undefined,
  item: (id) => itemsById.get(id),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_PROTECT', 'MOVE_TACKLE', null, null],
    pp: [10, 35, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: STATUS1_NONE,
    status2: 0,
    ...overrides,
  }
}

function battle(
  specs: {
    spe?: number
    atk?: number
    hp?: number
    maxHp?: number
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
  }[],
  rng: RandomSource,
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_PROTECT', 'MOVE_TACKLE', null, null],
          pp: s.pp ?? [10, 35, 0, 0],
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(rolls: number[] = []): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      if (idx < rolls.length) {
        return rolls[idx++]!
      }
      return 0
    },
  }
  return r
}

function useMove(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: move.priority ?? 0,
    effect: move.effect,
    isStatus: move.split === 'STATUS',
    resolvedType: move.type ?? 'NORMAL',
    power: move.power,
    flags: move.flags,
    split: move.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function dummyDamage(targetDmg: number | null = null): DamageResolver & { calls: number } {
  const r = {
    calls: 0,
    resolve: () => {
      r.calls++
      return { targetDamage: targetDmg, attackerDamage: null, unmodelled: [] }
    },
  }
  return r
}

function testDeps(damage: DamageResolver = dummyDamage()): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

describe('Protect move family: success rates and consecutive uses', () => {
  it('Protect success on turn 1, then second consecutive use at success (32767) and failure (32768) thresholds', () => {
    // Turn 1: protectUses is 0. Threshold is sProtectSuccessRates[0] = 65535.
    // Random roll of 50000 <= 65535 -> succeeds!
    // Turn 2 success: protectUses is 1. Threshold is sProtectSuccessRates[1] = 32767.
    // Scripted roll = 32767. Since 32767 >= 32767, Protect succeeds!
    {
      const rng = scriptedRng([50000, 32767])
      const state = battle([{}, {}], rng)
      const dmg = dummyDamage()

      // Turn 1
      const out1 = executeTurn(state, [useMove(1, MOVE_PROTECT), null], testDeps(dmg))
      const action1 = out1.actions.find((a) => a.battlerId === 0)!
      expect(action1.missed).toBe(false)
      expect(state.battlers[0]!.mon.pp[0]).toBe(9)
      expect(state.battlers[0]!.lastMove).toBe('MOVE_PROTECT')
      expect(state.battlers[0]!.volatiles.protectUses).toBe(1)

      // Turn 2: consecutive Protect with roll = 32767 (success boundary)
      const out2 = executeTurn(state, [useMove(1, MOVE_PROTECT), null], testDeps(dmg))
      const action2 = out2.actions.find((a) => a.battlerId === 0)!
      expect(action2.missed).toBe(false)
      expect(state.battlers[0]!.mon.pp[0]).toBe(8)
      expect(state.battlers[0]!.lastMove).toBe('MOVE_PROTECT')
      expect(state.battlers[0]!.volatiles.protectUses).toBe(2)
    }

    // Turn 2 failure: protectUses is 1. Threshold is 32767.
    // Scripted roll = 32768. 32767 >= 32768 is FALSE -> Protect fails!
    // Cmd_setprotectlike:9200 resets protectUses to 0 on failure.
    {
      const rng = scriptedRng([50000, 32768])
      const state = battle([{}, {}], rng)
      const dmg = dummyDamage()

      // Turn 1
      const out1 = executeTurn(state, [useMove(1, MOVE_PROTECT), null], testDeps(dmg))
      expect(out1.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
      expect(state.battlers[0]!.volatiles.protectUses).toBe(1)

      // Turn 2: consecutive Protect with roll = 32768 (failure boundary)
      const out2 = executeTurn(state, [useMove(1, MOVE_PROTECT), null], testDeps(dmg))
      const action2 = out2.actions.find((a) => a.battlerId === 0)!
      expect(action2.missed).toBe(true)
      expect(state.battlers[0]!.mon.pp[0]).toBe(8) // PP still reduced in C (ppreduce before setprotectlike)
      expect(state.battlers[0]!.lastMove).toBe('MOVE_PROTECT')
      expect(state.battlers[0]!.volatiles.protectUses).toBe(0) // Reset to 0 on failure (:9200)
    }
  })

  it('protectUses reset to 0 after using a non-protection move (Tackle)', () => {
    // Turn 1: Protect -> succeeds, protectUses = 1, lastMove = 'MOVE_PROTECT'
    // Turn 2: Tackle -> lastMove becomes 'MOVE_TACKLE' (non-protection move)
    // Turn 3: Protect -> ProtectSucceeds(:6650) resets protectUses to 0, so rate is 65535 again!
    const rng = scriptedRng([50000, 0, 50000]) // rolls for Protect T1, Tackle T2 accuracy (if any), Protect T3
    const state = battle([{}, {}], rng)
    const dmg = dummyDamage(10)

    // Turn 1: Protect
    executeTurn(state, [useMove(1, MOVE_PROTECT), null], testDeps(dmg))
    expect(state.battlers[0]!.volatiles.protectUses).toBe(1)
    expect(state.battlers[0]!.lastMove).toBe('MOVE_PROTECT')

    // Turn 2: Tackle
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(dmg))
    expect(state.battlers[0]!.lastMove).toBe('MOVE_TACKLE')

    // Turn 3: Protect (roll = 50000 would have failed at rate 32767, but since protectUses reset to 0, rate is 65535)
    const out3 = executeTurn(state, [useMove(1, MOVE_PROTECT), null], testDeps(dmg))
    const action3 = out3.actions.find((a) => a.battlerId === 0)!
    expect(action3.missed).toBe(false)
    expect(state.battlers[0]!.volatiles.protectUses).toBe(1) // incremented from reset 0 to 1
    expect(state.battlers[0]!.lastMove).toBe('MOVE_PROTECT')
  })

  it('damaging move into Protect: no accuracy RNG draw, no damage, PP deducted', () => {
    // Battler 0 uses Protect (+4 prio). Battler 1 uses Tackle (0 prio).
    // Protect succeeds (1 RNG roll).
    // Tackle hits Protect: isBattlerProtected returns PROTECT_BLOCK.
    // In C (battle_script_commands.c:1198-1210, 1422 JumpIfMoveAffectedByProtect):
    // Accuracy check is skipped entirely (0 RNG draws for accuracy).
    // Damage resolver is never called.
    // PP is deducted via deductPp.
    // Outcome: missed = true, targetDamage = null.
    const rng = scriptedRng([0]) // Protect roll
    const state = battle([{}, {}], rng)
    const dmg = dummyDamage(25)

    const out = executeTurn(state, [useMove(1, MOVE_PROTECT), useMove(0, MOVE_TACKLE)], testDeps(dmg))

    // Total RNG draws must be exactly 1 (Protect only, 0 for Tackle)
    expect(rng.calls).toBe(1)
    expect(dmg.calls).toBe(0)

    const tackleAction = out.actions.find((a) => a.battlerId === 1)!
    expect(tackleAction.missed).toBe(true)
    expect(tackleAction.targetDamage).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(100) // undamaged
    expect(state.battlers[1]!.mon.pp[1]).toBe(34) // Tackle PP reduced 35 -> 34
  })

  it('status move into Protect: blocked with FLAG_PROTECT_AFFECTED (Toxic), bypasses without it (Swords Dance)', () => {
    // 1. With FLAG_PROTECT_AFFECTED: Toxic is blocked by Protect.
    // No accuracy RNG draw, no poison applied, missed = true, PP deducted.
    {
      const rng = scriptedRng([0]) // Protect roll
      const state = battle(
        [
          { moves: ['MOVE_PROTECT', null, null, null], pp: [10, 0, 0, 0] },
          { moves: ['MOVE_TOXIC', null, null, null], pp: [10, 0, 0, 0] },
        ],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_PROTECT), useMove(0, MOVE_TOXIC)], testDeps())

      // RNG draw count is 1 (Protect only, 0 for Toxic's checkAccuracy)
      expect(rng.calls).toBe(1)

      const toxicAction = out.actions.find((a) => a.battlerId === 1)!
      expect(toxicAction.missed).toBe(true)
      expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
      expect(state.battlers[1]!.mon.pp[0]).toBe(9) // PP deducted

      // Direct isBattlerProtected assertion
      state.battlers[0]!.round.protectMove = 'MOVE_PROTECT'
      expect(isBattlerProtected(state, 1, 0, 'MOVE_TOXIC', false, testDeps(), [])).toBe(ProtectType.PROTECT_BLOCK)
    }

    // 2. Without FLAG_PROTECT_AFFECTED: Swords Dance (target: USER) bypasses Protect.
    // User gains +2 Attack, missed = false.
    {
      const rng = scriptedRng([0]) // Protect roll
      const state = battle(
        [
          { moves: ['MOVE_PROTECT', null, null, null], pp: [10, 0, 0, 0] },
          { moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [30, 0, 0, 0] },
        ],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_PROTECT), useMove(0, MOVE_SWORDS_DANCE)], testDeps())

      const sdAction = out.actions.find((a) => a.battlerId === 1)!
      expect(sdAction.missed).toBe(false)
      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2) // stage 8

      // Direct isBattlerProtected assertion
      state.battlers[0]!.round.protectMove = 'MOVE_PROTECT'
      expect(isBattlerProtected(state, 1, 0, 'MOVE_SWORDS_DANCE', false, testDeps(), [])).toBe(ProtectType.PROTECT_NONE)
    }
  })

  it("King's Shield: drops contact attacker Attack by 1, leaves non-contact attacker alone, and allows status moves through", () => {
    // 1. Contact attacker (Tackle): Attack dropped by 1 stage (6 -> 5)
    {
      const rng = scriptedRng([0]) // King's Shield roll
      const state = battle(
        [
          { moves: ['MOVE_KINGS_SHIELD', null, null, null], pp: [10, 0, 0, 0] },
          { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
        ],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_KINGS_SHIELD), useMove(0, MOVE_TACKLE)], testDeps())

      const tackleAction = out.actions.find((a) => a.battlerId === 1)!
      expect(tackleAction.missed).toBe(true)
      expect(tackleAction.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: -1 }])
      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1) // 5
      expect(state.battlers[0]!.mon.hp).toBe(100)
    }

    // 2. Non-contact attacker (Swift): Attack untouched (contact is false)
    {
      const rng = scriptedRng([0]) // King's Shield roll
      const state = battle(
        [
          { moves: ['MOVE_KINGS_SHIELD', null, null, null], pp: [10, 0, 0, 0] },
          { moves: ['MOVE_SWIFT', null, null, null], pp: [20, 0, 0, 0] },
        ],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_KINGS_SHIELD), useMove(0, MOVE_SWIFT)], testDeps())

      const swiftAction = out.actions.find((a) => a.battlerId === 1)!
      expect(swiftAction.missed).toBe(true)
      expect(swiftAction.statChanges).toBeNull()
      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE) // 6
    }

    // 3. Status move (Toxic) into King's Shield: King's Shield does NOT block status moves
    // C: battle_util.c:6604 `case MOVE_KINGS_SHIELD: if (!IS_MOVE_STATUS(move)) return PROTECT_BLOCK; break;`
    {
      const rng = scriptedRng([0, 0]) // King's Shield roll, Toxic accuracy roll
      const state = battle(
        [
          { moves: ['MOVE_KINGS_SHIELD', null, null, null], pp: [10, 0, 0, 0] },
          { moves: ['MOVE_TOXIC', null, null, null], pp: [10, 0, 0, 0] },
        ],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_KINGS_SHIELD), useMove(0, MOVE_TOXIC)], testDeps())

      const toxicAction = out.actions.find((a) => a.battlerId === 1)!
      expect(toxicAction.missed).toBe(false)
      expect(toxicAction.statusApplied).toEqual({ battlerId: 0, status: 'TOXIC' })
      // Toxic sets STATUS1_TOXIC_POISON, not STATUS1_POISON.
      expect(state.battlers[0]!.mon.status1).not.toBe(0)
    }
  })

  it('Baneful Bunker: poisons attacker on contact', () => {
    // Baneful Bunker blocks Tackle and inflicts POISON on the contact attacker.
    // C: battle_script_commands.c:4377 `case MOVE_BANEFUL_BUNKER: gBattleScripting.moveEffect = MOVE_EFFECT_POISON; goto KINGS_SHIELD_EFFECT;`
    const rng = scriptedRng([0]) // Baneful Bunker roll
    const state = battle(
      [
        { moves: ['MOVE_BANEFUL_BUNKER', null, null, null], pp: [10, 0, 0, 0] },
        { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      ],
      rng,
    )
    const out = executeTurn(state, [useMove(1, MOVE_BANEFUL_BUNKER), useMove(0, MOVE_TACKLE)], testDeps())

    const tackleAction = out.actions.find((a) => a.battlerId === 1)!
    expect(tackleAction.missed).toBe(true)
    expect(tackleAction.statusApplied).toEqual({ battlerId: 1, status: 'POISON' })
    expect(state.battlers[1]!.mon.status1 & STATUS1_POISON).not.toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Spiky Shield real effect: inflicts BLEED on contact (not fractional HP recoil), and Burning Bulwark burns on contact', () => {
    // Spiky Shield in Elite Redux does NOT inflict 1/8 HP damage; it inflicts the custom BLEED status!
    // C: battle_script_commands.c:4391-4393
    // `case MOVE_SPIKY_SHIELD: gBattleScripting.moveEffect = MOVE_EFFECT_BLEED; goto KINGS_SHIELD_EFFECT;`
    {
      const rng = scriptedRng([0]) // Spiky Shield roll
      const state = battle(
        [
          { moves: ['MOVE_SPIKY_SHIELD', null, null, null], pp: [10, 0, 0, 0] },
          { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
        ],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_SPIKY_SHIELD), useMove(0, MOVE_TACKLE)], testDeps())

      const tackleAction = out.actions.find((a) => a.battlerId === 1)!
      expect(tackleAction.missed).toBe(true)
      expect(tackleAction.statusApplied).toEqual({ battlerId: 1, status: 'BLEED' })
      expect(state.battlers[1]!.mon.status1 & STATUS1_BLEED).not.toBe(0)
      expect(state.battlers[1]!.mon.hp).toBe(100) // NO direct recoil damage from the shield itself
      expect(state.battlers[0]!.mon.hp).toBe(100)
    }

    // Burning Bulwark: burns on contact
    // C: battle_script_commands.c:4386-4389
    // `case MOVE_BURNING_BULWARK: gBattleScripting.moveEffect = MOVE_EFFECT_BURN; goto KINGS_SHIELD_EFFECT;`
    {
      const rng = scriptedRng([0]) // Burning Bulwark roll
      const state = battle(
        [
          { moves: ['MOVE_BURNING_BULWARK', null, null, null], pp: [10, 0, 0, 0] },
          { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
        ],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_BURNING_BULWARK), useMove(0, MOVE_TACKLE)], testDeps())

      const tackleAction = out.actions.find((a) => a.battlerId === 1)!
      expect(tackleAction.missed).toBe(true)
      expect(tackleAction.statusApplied).toEqual({ battlerId: 1, status: 'BURN' })
      expect(state.battlers[1]!.mon.status1 & STATUS1_BURN).not.toBe(0)
    }

    // Obstruct: Defense dropped by 1 on contact
    // C: battle_script_commands.c:4400-4402
    // `case MOVE_OBSTRUCT: gBattleScripting.moveEffect = MOVE_EFFECT_DEF_MINUS_1; goto KINGS_SHIELD_EFFECT;`
    {
      const rng = scriptedRng([0]) // Obstruct roll
      const state = battle(
        [
          { moves: ['MOVE_OBSTRUCT', null, null, null], pp: [10, 0, 0, 0] },
          { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
        ],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_OBSTRUCT), useMove(0, MOVE_TACKLE)], testDeps())

      const tackleAction = out.actions.find((a) => a.battlerId === 1)!
      expect(tackleAction.missed).toBe(true)
      expect(tackleAction.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: -1 }])
      expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1) // 5
    }
  })

  it('Detect against normal move, sure-hit move (reachability), Unseen Fist, and Feint', () => {
    // 1. Detect against normal move (Tackle, acc 100 < 101):
    // Caught by switch 1 (battle_util.c:6585): GetTotalAccuracy < 101 -> returns PROTECT_BLOCK.
    {
      const state = battle([{}, {}], scriptedRng([0]))
      state.battlers[0]!.round.protectMove = 'MOVE_DETECT'
      expect(isBattlerProtected(state, 1, 0, 'MOVE_TACKLE', false, testDeps(), [])).toBe(ProtectType.PROTECT_BLOCK)
    }

    // 2. Detect against sure-hit move (Aerial Ace, acc 101):
    // In C (battle_util.c:6585): GetTotalAccuracy < 101 is FALSE, so switch 1 breaks.
    // In switch 2 (:6605-6627), MOVE_DETECT is not listed in any case, falling into default: return PROTECT_BLOCK;
    // Bypassing Detect with a sure-hit move alone is therefore UNREACHABLE in upstream C.
    {
      const state = battle([{}, {}], scriptedRng([0]))
      state.battlers[0]!.round.protectMove = 'MOVE_DETECT'
      expect(isBattlerProtected(state, 1, 0, 'MOVE_AERIAL_ACE', false, testDeps(), [])).toBe(ProtectType.PROTECT_BLOCK)
    }

    // 3. Unseen Fist (evadesProtect, :6591-6593) gets a contact move through Protect, but NOT through Detect:
    // Detect's GetTotalAccuracy < 101 branch (:6584-6586) returns PROTECT_BLOCK before evadesProtect is computed.
    {
      const state = battle(
        [
          {},
          { abilities: { ability: ABILITY_UNSEEN_FIST, innates: [null, null, null] } },
        ],
        scriptedRng([0]),
      )
      state.battlers[0]!.round.protectMove = 'MOVE_PROTECT'
      expect(isBattlerProtected(state, 1, 0, 'MOVE_TACKLE', false, testDeps(), [])).toBe(ProtectType.PROTECT_NONE)
      state.battlers[0]!.round.protectMove = 'MOVE_DETECT'
      expect(isBattlerProtected(state, 1, 0, 'MOVE_TACKLE', false, testDeps(), [])).toBe(ProtectType.PROTECT_BLOCK)
    }

    // 4. Feint (EFFECT_FEINT, :6602) evades Protect; Detect's accuracy branch (:6584-6586) blocks it first.
    {
      const state = battle([{}, {}], scriptedRng([0]))
      state.battlers[0]!.round.protectMove = 'MOVE_PROTECT'
      expect(isBattlerProtected(state, 1, 0, 'MOVE_FEINT', false, testDeps(), [])).toBe(ProtectType.PROTECT_NONE)
      state.battlers[0]!.round.protectMove = 'MOVE_DETECT'
      expect(isBattlerProtected(state, 1, 0, 'MOVE_FEINT', false, testDeps(), [])).toBe(ProtectType.PROTECT_BLOCK)
    }
  })

  it('Endure: allows attacks to hit, but caps lethal damage so battler survives at 1 HP', () => {
    // Cmd_adjustdamage (battle_script_commands.c:1666-1676):
    // If gRoundStructs[target].endured && damage >= target.hp:
    // gBattleMoveDamage = gBattleMons[target].hp - 1;
    // 1. Lethal damage (150 damage against 100 HP) -> reduced to 99 damage, battler survives at 1 HP!
    {
      const rng = scriptedRng([0, 0]) // Endure roll, Tackle accuracy roll
      const state = battle(
        [
          { hp: 100, maxHp: 100, moves: ['MOVE_ENDURE', null, null, null], pp: [10, 0, 0, 0] },
          { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
        ],
        rng,
      )
      const dmg = dummyDamage(150) // lethal damage resolver

      const out = executeTurn(state, [useMove(1, MOVE_ENDURE), useMove(0, MOVE_TACKLE)], testDeps(dmg))

      const endureAction = out.actions.find((a) => a.battlerId === 0)!
      expect(endureAction.missed).toBe(false)
      expect(state.battlers[0]!.round.endured).toBe(false) // cleared at end of turn by roundStructsClear

      const tackleAction = out.actions.find((a) => a.battlerId === 1)!
      expect(tackleAction.missed).toBe(false)
      expect(tackleAction.targetDamage).toBe(99) // adjusted from 150 to 99
      expect(tackleAction.fainted).toEqual([])
      expect(state.battlers[0]!.mon.hp).toBe(1) // left at exactly 1 HP!
    }

    // 2. Non-lethal damage (40 damage against 100 HP) -> untouched (40 damage taken, HP is 60)
    {
      const rng = scriptedRng([0, 0])
      const state = battle(
        [
          { hp: 100, maxHp: 100, moves: ['MOVE_ENDURE', null, null, null], pp: [10, 0, 0, 0] },
          { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
        ],
        rng,
      )
      const dmg = dummyDamage(40)

      const out = executeTurn(state, [useMove(1, MOVE_ENDURE), useMove(0, MOVE_TACKLE)], testDeps(dmg))
      const tackleAction = out.actions.find((a) => a.battlerId === 1)!
      expect(tackleAction.targetDamage).toBe(40)
      expect(state.battlers[0]!.mon.hp).toBe(60)
    }
  })

  it('Camouflage: blocks a non-contact move and adds its type as type3', () => {
    // battle_util.c:6624 PROTECT_BLOCK_ALWAYS_TOUCH sets touchedProtectLike without contact;
    // battle_script_commands.c:4415-4427 writes the move's type into type3.
    const state = battle(
      [
        { moves: ['MOVE_CAMOUFLAGE', null, null, null], pp: [10, 0, 0, 0] },
        { moves: ['MOVE_SWIFT', null, null, null], pp: [20, 0, 0, 0] },
      ],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_CAMOUFLAGE), useMove(0, MOVE_SWIFT)], testDeps())
    expect(out.actions.find((a) => a.battlerId === 1)!.missed).toBe(true)
    expect(state.battlers[0]!.mon.types).toEqual(['WATER', 'MYSTERY', 'NORMAL'])
  })

  it("King's Shield: Shield Dust on the contact attacker prevents the Attack drop", () => {
    // SetMoveEffect(FALSE, FALSE) runs with the attacker as gEffectBattler (battle_scripts_1.s:10551-10554),
    // so its Shield Dust check (battle_script_commands.c:2348-2350) applies.
    const state = battle(
      [
        { moves: ['MOVE_KINGS_SHIELD', null, null, null], pp: [10, 0, 0, 0] },
        {
          moves: ['MOVE_TACKLE', null, null, null],
          pp: [35, 0, 0, 0],
          abilities: { ability: ABILITY_SHIELD_DUST, innates: [null, null, null] },
        },
      ],
      scriptedRng([0]),
    )
    const out = executeTurn(state, [useMove(1, MOVE_KINGS_SHIELD), useMove(0, MOVE_TACKLE)], testDeps())
    expect(out.actions.find((a) => a.battlerId === 1)!.statChanges).toBeNull()
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('round reset: clears protectMove, endured, and touchedProtectLike for the next turn', () => {
    // TurnValuesCleanUp(FALSE) (battle_main.c:3492, 4490) runs at the end of each turn,
    // resetting gRoundStructs for all battlers.
    // 1. Direct roundStructsClear assertion:
    {
      const state = battle([{}, {}], scriptedRng([0]))
      state.battlers[0]!.round.protectMove = 'MOVE_PROTECT'
      state.battlers[0]!.round.endured = true
      state.battlers[0]!.round.touchedProtectLike = true
      expect(state.battlers[0]!.round.protectMove).toBe('MOVE_PROTECT')
      expect(state.battlers[0]!.round.endured).toBe(true)
      expect(state.battlers[0]!.round.touchedProtectLike).toBe(true)

      roundStructsClear(state)

      expect(state.battlers[0]!.round.protectMove).toBeNull()
      expect(state.battlers[0]!.round.endured).toBe(false)
      expect(state.battlers[0]!.round.touchedProtectLike).toBe(false)
    }

    // 2. End-to-end multi-turn reset:
    // Turn 1: Battler 0 uses Protect. Turn ends -> roundStructsClear clears protectMove.
    // Turn 2: Battler 0 uses Tackle. Battler 1 uses Tackle into Battler 0.
    // Battler 1's Tackle connects because Battler 0's protectMove was cleared at end of Turn 1!
    {
      const rng = scriptedRng([0, 0, 0]) // Protect T1 roll, Tackle T2 acc, Tackle T2 acc
      const state = battle([{}, {}], rng)
      const dmg = dummyDamage(20)

      // Turn 1: Battler 0 Protects
      executeTurn(state, [useMove(1, MOVE_PROTECT), null], testDeps(dmg))
      expect(state.battlers[0]!.round.protectMove).toBeNull() // already cleared after Turn 1

      // Turn 2: Battler 0 and Battler 1 both Tackle
      const out2 = executeTurn(state, [useMove(1, MOVE_TACKLE), useMove(0, MOVE_TACKLE)], testDeps(dmg))
      const foeTackle = out2.actions.find((a) => a.battlerId === 1)!
      expect(foeTackle.missed).toBe(false)
      expect(foeTackle.targetDamage).toBe(20) // deals damage, not blocked
      expect(state.battlers[0]!.mon.hp).toBe(80)
    }
  })

  it('Protect edge cases: last mover in turn fails, and protectUses > 3 fails without RNG draw', () => {
    // 1. Last mover in turn (battle_script_commands.c:9165):
    // if (gCurrentTurnActionNumber == (gBattlersCount - 1)) notLastTurn = FALSE;
    // When notLastTurn is FALSE, Protect fails immediately.
    {
      const rng = scriptedRng([0])
      // Battler 0 has 50 Spe, Battler 1 has 100 Spe
      // Both choose moves with priority 0: Tackle vs Tackle (Battler 1 goes first, Battler 0 goes second).
      // Or Battler 1 uses Tackle (prio 0), Battler 0 uses Protect (prio -1 override to force moving last).
      // Or directly testing handleProtect with turnOrderIndex = 1 in a 2-battler order:
      const state = battle([{}, {}], rng)
      const order = { battlerByTurnOrder: [1, 0], actionsByTurnOrder: ['USE_MOVE', 'USE_MOVE'] as any }
      const unmodelled: string[] = []
      const out = handleProtect({
        state,
        battlerId: 0,
        targetId: 1,
        action: useMove(1, MOVE_PROTECT),
        turnOrderIndex: 1, // last mover (1 === 2 - 1)
        order,
        deps: testDeps(),
        unmodelled,
        deductPp: () => {},
        applyDamage: () => {},
      })
      expect(out.missed).toBe(true)
      expect(state.battlers[0]!.volatiles.protectUses).toBe(0)
    }

    // 2. protectUses > 3 (battle_script_commands.c:6652):
    // if (gVolatileStructs[battler].protectUses > 3) return FALSE;
    // When protectUses is 4, it fails without calling Random()!
    {
      const rng = scriptedRng([]) // 0 rolls provided; calls must be 0!
      const state = battle([{}, {}], rng)
      state.battlers[0]!.lastMove = 'MOVE_PROTECT'
      state.battlers[0]!.volatiles.protectUses = 4

      const order = { battlerByTurnOrder: [0, 1], actionsByTurnOrder: ['USE_MOVE', 'USE_MOVE'] as any }
      const unmodelled: string[] = []
      const out = handleProtect({
        state,
        battlerId: 0,
        targetId: 1,
        action: useMove(1, MOVE_PROTECT),
        turnOrderIndex: 0, // not last mover
        order,
        deps: testDeps(),
        unmodelled,
        deductPp: () => {},
        applyDamage: () => {},
      })
      expect(rng.calls).toBe(0) // No Random() drawn!
      expect(out.missed).toBe(true)
      expect(state.battlers[0]!.volatiles.protectUses).toBe(0) // reset on failure
    }
  })
})
