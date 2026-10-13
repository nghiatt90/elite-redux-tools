// Unit tests for stat-copy reactions (cycle 48):
// Egoist, Sharing is Caring, Mirror Herb, and Opportunist comparison.
//
// Hand-derived from upstream C sources at pinned SHA:
// - battle_script_commands.c:9937-9940: ChangeStatBuffs recording into statChangesToCheck
//   and gating on statStageCheckState != STAT_STAGE_CHECK_IN_PROGRESS
// - battle_util.c:4733-4774: AbilityBattleEffects(ABILITYEFFECT_REACTIVE, ...)
//   Mirror Herb scan, onReactive dispatch, reset/zeroing
// - battle_script_commands.c:8202-8309: VARIOUS_DO_COPY_STAT_CHANGE
//   Egoist loop (:8206-8241), Sharing is Caring loop (:8243-8279),
//   Mirror Herb loop (:8280-8305), BattleScript_AttackerAteItem (:8297)
// - abilities.cc:4665 (Opportunist onPriority), :7074 (Egoist onReactive),
//   :7368 (Sharing is Caring onReactive), :5145 (Retribution Blow onReactive)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  STAT_ATK,
  STAT_SPEED,
  STAT_STAGE_CHECK_NEEDED,
  STAT_STAGE_CHECK_NOT_NEEDED,
} from './constants'
import { runReactiveAbilityEffects } from './statBuffs'
import { applyBattleStartPass, type BattleStartDeps } from './switchInAbility'
import type { HazardDeps } from './hazards'

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
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
  }
}

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
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
  species: () => undefined,
  item: (id) => itemsById.get(id),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [30, 0, 0, 0],
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
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function battle(
  specs: {
    spe?: number
    atk?: number
    def?: number
    spatk?: number
    spdef?: number
    hp?: number
    maxHp?: number
    itemId?: string | null
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
  }[],
  rng: RandomSource = scriptedRng(),
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: {
            atk: s.atk ?? 100,
            def: s.def ?? 90,
            spatk: s.spatk ?? 80,
            spdef: s.spdef ?? 85,
            spe: s.spe ?? (i === 0 ? 100 : 50),
          },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          itemId: s.itemId ?? null,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ?? [30, 0, 0, 0],
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(): RandomSource & { calls: number } {
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return 0
    },
  }
  return r
}

function dummyDamage(): DamageResolver & { calls: number } {
  const r = {
    calls: 0,
    resolve: () => {
      r.calls++
      return { targetDamage: null, attackerDamage: null, unmodelled: [] }
    },
  }
  return r
}

function makeDeps(damage: DamageResolver = dummyDamage(), holdEffects: Record<number, string> = {}): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: {
      ...GROUNDING,
      holdEffectOf: (battlerId: number) => holdEffects[battlerId] ?? null,
    },
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
  }
}

function makeStartDeps(holdEffects: Record<number, string> = {}): BattleStartDeps & HazardDeps {
  return {
    grounding: {
      ...GROUNDING,
      holdEffectOf: (battlerId: number) => holdEffects[battlerId] ?? null,
    },
    dataContext: DATA_CONTEXT,
    statStageRatios: RATIOS,
  }
}

function makeMoveAction(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: 0,
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

const MOVE_SWORDS_DANCE = requireMove('MOVE_SWORDS_DANCE')
const MOVE_DRAGON_DANCE = requireMove('MOVE_DRAGON_DANCE')
const MOVE_TACKLE = requireMove('MOVE_TACKLE')

describe('cycle 48: stat-copy reactions', () => {
  // 1. Foe uses Swords Dance -> Egoist holder copies Atk +2
  it('Egoist copies foe Swords Dance (+2 Atk)', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_EGOIST'), innates: [null, null, null] }, spe: 50 },
      { moves: ['MOVE_SWORDS_DANCE', null, null, null], spe: 100 },
    ])

    const out = executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(1, MOVE_SWORDS_DANCE)],
      makeDeps(),
    )

    // Foe (battler 1) rose to Atk stage 8 (DEFAULT_STAT_STAGE + 2)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    // Battler 0 (Egoist) copied Atk +2 -> stage 8
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)

    // State reset cleanly
    expect(state.statStageCheckState).toBe(STAT_STAGE_CHECK_NOT_NEEDED)
    expect(state.statChangesToCheck[1]!.every((v) => v === 0)).toBe(true)

    // The copy stat change is present in the action outcome
    const sdAction = out.actions.find((a) => a.battlerId === 1)
    expect(sdAction).toBeDefined()
    expect(sdAction!.statChanges).toEqual(
      expect.arrayContaining([
        { battlerId: 1, stat: STAT_ATK, change: 2 },
        { battlerId: 0, stat: STAT_ATK, change: 2 },
      ]),
    )
  })

  // 2. Opportunist does NOT copy stat boosts (Elite Redux C rework)
  it('Opportunist does not copy stat changes (in Elite Redux C:4665 Opportunist is onPriority, not a stat copier)', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_OPPORTUNIST'), innates: [null, null, null] }, spe: 50 },
      { moves: ['MOVE_SWORDS_DANCE', null, null, null], spe: 100 },
    ])

    executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(1, MOVE_SWORDS_DANCE)],
      makeDeps(),
    )

    // Foe gained +2 Atk
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    // Opportunist holder did NOT copy (remains at neutral stage 6)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  // 3. Mirror Herb copies and is consumed per script
  it('Mirror Herb copies foe Swords Dance (+2 Atk) and item is consumed', () => {
    const state = battle([
      { itemId: 'ITEM_MIRROR_HERB', spe: 50 },
      { moves: ['MOVE_SWORDS_DANCE', null, null, null], spe: 100 },
    ])

    const out = executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(1, MOVE_SWORDS_DANCE)],
      makeDeps(dummyDamage(), { 0: 'HOLD_EFFECT_MIRROR_HERB' }),
    )

    // Foe gained +2 Atk
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    // Battler 0 copied +2 Atk -> stage 8
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    // Item is consumed: itemId cleared, usedHeldItem set
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.usedHeldItem).toBe('ITEM_MIRROR_HERB')

    const sdAction = out.actions.find((a) => a.battlerId === 1)
    expect(sdAction!.statChanges).toEqual(
      expect.arrayContaining([
        { battlerId: 1, stat: STAT_ATK, change: 2 },
        { battlerId: 0, stat: STAT_ATK, change: 2 },
      ]),
    )
  })

  // 4. Multi-stat copy: Dragon Dance (+1 Atk, +1 Speed) copies both and consumes Herb once
  it('Mirror Herb copies multiple stats (Dragon Dance: +1 Atk, +1 Spe) and consumes once', () => {
    const state = battle([
      { itemId: 'ITEM_MIRROR_HERB', spe: 50 },
      { moves: ['MOVE_DRAGON_DANCE', null, null, null], spe: 100 },
    ])

    executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(1, MOVE_DRAGON_DANCE)],
      makeDeps(dummyDamage(), { 0: 'HOLD_EFFECT_MIRROR_HERB' }),
    )

    // Battler 0 copied both stats
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.usedHeldItem).toBe('ITEM_MIRROR_HERB')
  })

  // 5. Mirror Herb is NOT consumed if stats cannot increase (holder already at +6)
  it('Mirror Herb is not consumed if holder is already at max stage for all raised stats', () => {
    const state = battle([
      { itemId: 'ITEM_MIRROR_HERB', spe: 50 },
      { moves: ['MOVE_SWORDS_DANCE', null, null, null], spe: 100 },
    ])
    // Manually set Atk to MAX_STAT_STAGE after creation
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE

    executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(1, MOVE_SWORDS_DANCE)],
      makeDeps(dummyDamage(), { 0: 'HOLD_EFFECT_MIRROR_HERB' }),
    )

    // Battler 0 Atk remains at MAX_STAT_STAGE
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    // Herb was NOT consumed because no stat actually rose
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_MIRROR_HERB')
    expect(state.battlers[0]!.usedHeldItem).toBeUndefined()
  })

  // 6. Mirror Herb blocked by Unnerve
  it('Mirror Herb is blocked by opposing Unnerve', () => {
    const state = battle([
      { itemId: 'ITEM_MIRROR_HERB', spe: 50 },
      {
        abilities: { ability: requireAbility('ABILITY_UNNERVE'), innates: [null, null, null] },
        moves: ['MOVE_SWORDS_DANCE', null, null, null],
        spe: 100,
      },
    ])

    executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(1, MOVE_SWORDS_DANCE)],
      makeDeps(dummyDamage(), { 0: 'HOLD_EFFECT_MIRROR_HERB' }),
    )

    // Battler 0 Atk did not rise; item not consumed
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_MIRROR_HERB')
  })

  // 7. A stat drop on a foe is not copied
  it('a stat drop on a foe is not copied by Egoist or Mirror Herb', () => {
    const state = battle([
      {
        abilities: {
          ability: requireAbility('ABILITY_INTIMIDATE'),
          innates: [requireAbility('ABILITY_EGOIST'), null, null],
        },
        itemId: 'ITEM_MIRROR_HERB',
        spe: 100,
      },
      { spe: 50 },
    ])
    const unmodelled: string[] = []
    applyBattleStartPass(state, makeStartDeps({ 0: 'HOLD_EFFECT_MIRROR_HERB' }), unmodelled)

    // Foe's Atk dropped to stage 5 (6 - 1)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    // Holder's Atk remains at stage 6 (drops are not copied)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    // Herb not eaten
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_MIRROR_HERB')
  })

  // 8. Ally stat raising is not copied (foe-side only)
  it('ally stat raising is not copied (cross-side / opponent only)', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_EGOIST'), innates: [null, null, null] }, itemId: 'ITEM_MIRROR_HERB', spe: 50 },
      { spe: 100 },
      { moves: ['MOVE_SWORDS_DANCE', null, null, null], spe: 80 },
      { spe: 60 },
    ])
    state.battlersCount = 4

    // Battler 0 (side 0) has Egoist and Mirror Herb.
    // Battler 2 (side 0) is ally and uses Swords Dance.
    const unmodelled: string[] = []
    const statChanges: { battlerId: number; stat: number; change: number }[] = []

    // Directly set needed state simulating ally stat buff
    state.statStageCheckState = STAT_STAGE_CHECK_NEEDED
    state.statChangesToCheck[2]![STAT_ATK - 1] = 2

    const res = runReactiveAbilityEffects(state, makeDeps(dummyDamage(), { 0: 'HOLD_EFFECT_MIRROR_HERB' }), unmodelled, statChanges)
    expect(res).toBe(false)
    expect(statChanges).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_MIRROR_HERB')
  })

  // 9. State resets so a second turn does not re-copy an old change
  it('state resets so a second turn does not re-copy an old change', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_EGOIST'), innates: [null, null, null] }, spe: 50 },
      { moves: ['MOVE_SWORDS_DANCE', null, null, null], spe: 100 },
    ])

    // Turn 1: Swords Dance -> copied (+2 Atk, stage 8)
    executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(1, MOVE_SWORDS_DANCE)],
      makeDeps(),
    )
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)

    // Turn 2: Foe uses Tackle (no stat changes)
    executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(0, MOVE_TACKLE)],
      makeDeps(),
    )
    // Battler 0 Atk remains at stage 8, not stage 10
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  // 10. Copy does not chain into another copy (IN_PROGRESS prevents recursion)
  it('copy itself does not chain into another copy (IN_PROGRESS flag prevents recursion)', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_EGOIST'), innates: [null, null, null] }, spe: 50 },
      {
        abilities: { ability: requireAbility('ABILITY_EGOIST'), innates: [null, null, null] },
        moves: ['MOVE_SWORDS_DANCE', null, null, null],
        spe: 100,
      },
    ])

    // Battler 1 uses Swords Dance. Battler 0 has Egoist. Battler 1 also has Egoist.
    // Battler 0 copies Battler 1's Atk +2.
    // If Battler 0's copy recorded into statChangesToCheck, Battler 1 would try to re-copy it.
    executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(1, MOVE_SWORDS_DANCE)],
      makeDeps(),
    )

    // Both end at stage 8 without infinite chaining
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(state.statStageCheckState).toBe(STAT_STAGE_CHECK_NOT_NEEDED)
  })

  // 11. Retribution Blow reports unmodelled gap
  it('Retribution Blow triggers unmodelled gap when opponent raises stats', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_RETRIBUTION_BLOW'), innates: [null, null, null] }, spe: 50 },
      { moves: ['MOVE_SWORDS_DANCE', null, null, null], spe: 100 },
    ])

    const out = executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(1, MOVE_SWORDS_DANCE)],
      makeDeps(),
    )

    const sdAction = out.actions.find((a) => a.battlerId === 1)
    expect(sdAction).toBeDefined()
    expect(
      sdAction!.unmodelled.some((m) =>
        m.includes('Retribution Blow out-of-turn attack (abilities.cc:5145-5160) is not modelled'),
      ),
    ).toBe(true)
  })

  // 12. Sharing is Caring copies all stat changes across all battlers
  it('Sharing is Caring copies stat changes to all battlers', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_SHARING_IS_CARING'), innates: [null, null, null] }, spe: 50 },
      { moves: ['MOVE_SWORDS_DANCE', null, null, null], spe: 100 },
    ])

    executeTurn(
      state,
      [makeMoveAction(1, MOVE_TACKLE), makeMoveAction(1, MOVE_SWORDS_DANCE)],
      makeDeps(),
    )

    // Battler 1 raised Atk +2 -> stage 8
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    // Battler 0 (Sharing is Caring) copies Atk +2 -> stage 8
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  // 13. Direct invocation of runReactiveAbilityEffects: no-op when NOT_NEEDED
  it('runReactiveAbilityEffects is a no-op when statStageCheckState is NOT_NEEDED', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_EGOIST'), innates: [null, null, null] } },
      { itemId: 'ITEM_MIRROR_HERB' },
    ])
    state.statStageCheckState = STAT_STAGE_CHECK_NOT_NEEDED

    const unmodelled: string[] = []
    const statChanges: { battlerId: number; stat: number; change: number }[] = []
    const res = runReactiveAbilityEffects(state, makeDeps(), unmodelled, statChanges)

    expect(res).toBe(false)
    expect(statChanges).toEqual([])
    expect(state.statStageCheckState).toBe(STAT_STAGE_CHECK_NOT_NEEDED)
  })
})
