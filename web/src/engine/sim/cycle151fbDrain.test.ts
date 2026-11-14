/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 151fb: the other two callers of BattleScript_AbsorbLeech_Test.
//
// 151f ported the Absorb / Dream Eater drain including the Soul Linker branch.
// This cycle ports:
//  - Matcha Gotcha's drain: BattleScript_EffectMatchaGotcha (data/battle_scripts_1.s:3334-3354)
//    rolls `setmoveeffect MOVE_EFFECT_BURN; seteffectwithchance` (:3352-3353) and then
//    `goto BattleScript_AbsorbHeal` (:3354), so it reaches the same drain the Absorb script
//    does. DMG_TO_HP_FROM_MOVE (battle_script_commands.c:9398-9411) uses
//    floor(hpDealt / 2) when the move has no argument; Matcha Gotcha has none.
//  - Life Steal / Soul Tap's Soul Linker half at end of turn: BattleScript_AbilityDrainsHp
//    (:3257-3266) lands in BattleScript_AbsorbLeech_Test (:3298-3306), whose Soul Linker
//    jumps (:3304-3305) go to BattleScript_AbsorbSoulLinker (:3309-3317) -- the holder
//    heals, then `datahpupdate BS_TARGET` heals the target by the same amount
//    (battle_script_commands.c:1908-1911, clamped to maxHP).
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
import { STATUS1_BURN, STATUS3_HEAL_BLOCK, hasFlag } from './constants'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle151fSoulLinker.test.ts (which copied it from
// cycle150hbbEncoreTarget.test.ts). The quiet-turn helper at the bottom is the
// end-turn entry cycle89aAbilities.test.ts:492 uses for the Life Steal cases.
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
const hasAbility = (
  ability: string | null,
  innates: [string | null, string | null, string | null] = [null, null, null],
): SimBattleMon['abilities'] => ({ ability, innates })

/** Runs one Matcha Gotcha: battler 0 attacks battler 1 for a fixed 40 damage. */
function runMatcha(specs: BattlerSpec[], rolls: number[] = [0, 99]) {
  const state = battle(specs, scriptedRng(rolls))
  const out = executeTurn(state, [useMove(1, move('MOVE_MATCHA_GOTCHA')), null], testDeps(fixedDamage(40)))
  return { state, out }
}

/** A turn where nobody acts, so only the end-turn ladder (including Life Steal) runs. */
function quietTurn(state: BattleState) {
  return executeTurn(state, [null, null], testDeps())
}

function expectNoSoulLinkerNote(notes: string[]): void {
  expect(notes.some((note) => note.includes('BattleScript_AbsorbSoulLinker'))).toBe(false)
}

describe('Cycle 151fb - Matcha Gotcha drains (BattleScript_EffectMatchaGotcha -> BattleScript_AbsorbHeal)', () => {
  it('1: heals the user by floor(hpDealt / 2)', () => {
    // BattleScript_EffectMatchaGotcha (:3334-3354): damage, then
    // `goto BattleScript_AbsorbHeal` (:3354) -> manipulatedamage DMG_TO_HP_FROM_MOVE
    // (battle_script_commands.c:9398-9411). moves.json gives MOVE_MATCHA_GOTCHA no
    // argument, so drainHp = floor(hpDealt / 2) = floor(40 / 2) = 20.
    // Draw order: accuracy (0, hits), then the effectChance roll (99 >= 20, no burn).
    // user 30 -> 30 + 20 = 50; target 200 -> 200 - 40 = 160.
    const { state, out } = runMatcha([
      { hp: 30, maxHp: 100 },
      { hp: 200, maxHp: 320 },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(state.battlers[1]!.mon.hp).toBe(160)
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(false)
    expectNoSoulLinkerNote(out.actions[0]!.unmodelled)
  })

  it('2: a Liquid Ooze target turns the drain into damage on the user (BattleScript_AbsorbLiquidOoze)', () => {
    // BattleScript_AbsorbLeech_Test's first jump (:3300) is Liquid Ooze, before any
    // Soul Linker check. BattleScript_AbsorbLiquidOoze (:3318-3324) flips the sign and
    // AbsorbUpdateHp damages BS_ATTACKER: 100 -> 100 - 20 = 80. No heal.
    const { state } = runMatcha([
      { hp: 100, maxHp: 100 },
      { hp: 200, maxHp: 320, abilities: hasAbility('ABILITY_LIQUID_OOZE') },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(state.battlers[1]!.mon.hp).toBe(160)
  })

  it('3a: Soul Linker on the user heals it and the target, then the move-end hook takes the stored 20 back', () => {
    // Same shape as the 151f Absorb Soul Linker case. drainHp = floor(40 / 2) = 20.
    // BattleScript_AbsorbSoulLinker (:3309-3317): AbsorbUpdateHp heals the user
    // 100 -> 120, then `datahpupdate BS_TARGET` heals the target 160 -> 180. The
    // trailing DMG_CHANGE_SIGN (:3317) leaves +20 in gBattleMoveDamage, which
    // BattleScript_AttackerSoulLinker (:11467-11472) applies to BS_ATTACKER at
    // MOVEEND_ABILITIES: 120 -> 100.
    const { state, out } = runMatcha([
      { hp: 100, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') },
      { hp: 200, maxHp: 320 },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(180)
    expectNoSoulLinkerNote(out.actions[0]!.unmodelled)
  })

  it('3b: negative -- a target fainted by the hit (jumpifabsent) is not healed back; the user keeps the plain heal', () => {
    // Target 30 HP takes 40, so hpDealt = 30 and drainHp = 15. jumpifabsent BS_TARGET
    // (:3303; VARIOUS_JUMP_IF_ABSENT -> !IsBattlerAlive, battle_script_commands.c:6769-6772)
    // skips BattleScript_AbsorbSoulLinker and lands on
    // BattleScript_AbsorbLeech_SkipSoulLinker, so only the user heals: 100 -> 115.
    // The target stays at 0.
    const { state, out } = runMatcha([
      { hp: 100, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') },
      { hp: 30, maxHp: 320 },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(115)
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(out.actions[0]!.fainted).toContain(1)
    expectNoSoulLinkerNote(out.actions[0]!.unmodelled)
  })

  it('4: the burn roll still lands (scriptedRng([0, 0])) and the drain still happens', () => {
    // :3352-3353 run before `goto BattleScript_AbsorbHeal` (:3354), but the drain block
    // draws no RNG, so the stream remains accuracy (0, hits) then burn chance
    // (0 < 20, burns). The user still heals floor(40 / 2) = 20: 30 -> 50.
    const { state } = runMatcha(
      [
        { hp: 30, maxHp: 100 },
        { hp: 200, maxHp: 320 },
      ],
      [0, 0],
    )
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('5: negative -- Heal Block on the user zeroes the drain (DMG_TO_HP_FROM_MOVE)', () => {
    // battle_script_commands.c:9399-9402 zeroes the drain when CanBattlerHeal fails, and
    // AbsorbLeech_Test's jumpifhealingblocked (:3301) returns before AbsorbUpdateHp.
    // STATUS3_HEAL_BLOCK is CanBattlerHeal's first clause (battle_util.c:8979-8980).
    // User stays at 30; target takes only the hit: 200 -> 160.
    const state = battle(
      [
        { hp: 30, maxHp: 100 },
        { hp: 200, maxHp: 320 },
      ],
      scriptedRng([0, 99]),
    )
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    executeTurn(state, [useMove(1, move('MOVE_MATCHA_GOTCHA')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[0]!.mon.hp).toBe(30)
    expect(state.battlers[1]!.mon.hp).toBe(160)
  })
})

describe('Cycle 151fb - Life Steal Soul Linker at end of turn (BattleScript_AbsorbSoulLinker)', () => {
  const holder = (extra: Partial<BattlerSpec> = {}): BattlerSpec => ({
    hp: 50,
    maxHp: 100,
    abilities: hasAbility('ABILITY_LIFE_STEAL'),
    ...extra,
  })
  const foe = (extra: Partial<BattlerSpec> = {}): BattlerSpec => ({ hp: 60, maxHp: 100, ...extra })

  it('6a: takes maxHP / 10 from the foe and heals the holder by it: foe 60 -> 50, holder 50 -> 60', () => {
    // BattleScript_AbilityDrainsHp (:3257-3266): hpfractiontodamage 10 -> 100 / 10 = 10;
    // the foe loses it, then BattleScript_AbsorbUpdateHp heals the holder by the same 10.
    const s = battle([holder(), foe()], scriptedRng([]))
    const out = quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(50)
    expect(s.battlers[0]!.mon.hp).toBe(60)
    expectNoSoulLinkerNote(out.endTurnUnmodelled)
  })

  it('6b: Soul Linker on the foe heals it back by the drained amount, so both end at 60', () => {
    // BattleScript_AbsorbLeech_Test's target jump (:3305) reaches
    // BattleScript_AbsorbSoulLinker (:3309-3317): the holder heals 50 -> 60, then
    // `datahpupdate BS_TARGET` heals the target 50 -> 60 with the same stored amount.
    const s = battle([holder(), foe({ abilities: hasAbility('ABILITY_SOUL_LINKER') })], scriptedRng([]))
    const out = quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(60)
    expect(s.battlers[0]!.mon.hp).toBe(60)
    expect(out.endTurn.some((r) => r.battlerId === 1 && r.hpChange === 10)).toBe(true)
    expectNoSoulLinkerNote(out.endTurnUnmodelled)
  })

  it('7: negative -- a foe fainted by the drain skips the branch: foe stays 0, holder heals the capped 5', () => {
    // hpfractiontodamage caps at the foe's hp: 100 / 10 = 10 -> min(10, 5) = 5, so the foe
    // faints. jumpifabsent BS_TARGET (:3303) then skips BattleScript_AbsorbSoulLinker; the
    // holder still heals 5: 50 -> 55, and the foe is never revived.
    const s = battle([holder(), foe({ hp: 5, maxHp: 100, abilities: hasAbility('ABILITY_SOUL_LINKER') })], scriptedRng([]))
    const out = quietTurn(s)
    expect(s.battlers[1]!.mon.hp).toBe(0)
    expect(s.battlers[0]!.mon.hp).toBe(55)
    expectNoSoulLinkerNote(out.endTurnUnmodelled)
  })

  it('8: no scenario leaves a "BattleScript_AbsorbSoulLinker ... not modelled" note', () => {
    // The old abilityDrainsHp pushed that note whenever either side held Soul Linker.
    // Cover the move-end path and the end-turn path, holder-side and foe-side.
    const matchaCases: BattlerSpec[][] = [
      [{ hp: 100, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') }, { hp: 200, maxHp: 320 }],
      [{ hp: 100, maxHp: 320 }, { hp: 200, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') }],
    ]
    for (const specs of matchaCases) {
      const { out } = runMatcha(specs)
      expectNoSoulLinkerNote(out.actions[0]!.unmodelled)
    }
    const endTurnCases: BattlerSpec[][] = [
      [holder({ abilities: hasAbility('ABILITY_LIFE_STEAL', ['ABILITY_SOUL_LINKER', null, null]) }), foe()],
      [holder(), foe({ abilities: hasAbility('ABILITY_SOUL_LINKER') })],
    ]
    for (const specs of endTurnCases) {
      const s = battle(specs, scriptedRng([]))
      const out = quietTurn(s)
      expectNoSoulLinkerNote(out.endTurnUnmodelled)
      expect(out.endTurnUnmodelled.some((note) => note.includes('not modelled'))).toBe(false)
    }
  })
})
