/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 106b -- the second on-hit attacker batch: Blood Stain, Daybreak, Demolitionist, Gulp Missile,
// Hollow Ice Zone, Home Run, Know Your Place, Paint Shot, Shields Down, Sinister Claws, Spectral Shroud and
// Spinning Top. Every block is a transcription of the onAttacker lambda in
// pipeline/.upstream/eliteredux-source/src/abilities.cc at the pinned SHA (sources.lock.json:
// eliteredux-source bdebcbbff9760cdd41a02c425bea4857fa0eee26). The tests pin the C's draw order: an ability's
// own Random() is drawn only after every earlier CHECK passes, and Spectral Shroud draws its ATE half's roll
// before its own because the C ORs the two halves.
//
// Common C references (pinned upstream):
// - ShouldApplyOnHitEffect(applyTo) = DidMoveHit() && IsBattlerAlive(applyTo), src/battle_util.c:4058-4062;
//   DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED, with no liveness requirement.
// - AbilityStatusEffect / AbilityStatusEffectSafe / AbilityStatusEffectDirect, src/abilities.cc:263-283.
// - CanBeBurned / CanBePoisoned, src/battle_util.c:5061-5070 (see the :5019-5123 block).
// - ChangeStatBuffs, src/battle_script_commands.c:9713-9946; BattleScript_StackBattlerStatUp,
//   data/battle_scripts_1.s:9028-9037.
// - CalculateStat, src/battle_util.c:7105-7217.

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
import { dispatchMoveEndAttackerAbilities } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { TypeChart } from '../typeEffectiveness'
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_SPIKES,
  STATUS1_BURN,
  STATUS1_TOXIC_POISON,
  STATUS2_TRANSFORMED,
  STATUS3_UNDERWATER,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  hasFlag,
  setFlag,
} from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- the snapshot-backed shape cycle106Abilities.test.ts uses.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const itemsById = new Map(snapshot<Array<SimItemData>>('items.json').map((item) => [item.id, item]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
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
  item: (id) => itemsById.get(id),
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
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  gender?: SimBattleMon['gender']
  status1?: number
  status2?: number
}

function battle(specs: BattlerSpec[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          gender: s.gender ?? 'MALE',
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
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
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })
const TYPES = (t: string): [string, string, string] => [t, 'MYSTERY', 'MYSTERY']
const stage = (state: BattleState, battlerId: number, stat: number) =>
  state.battlers[battlerId]!.mon.statStages[stat] ?? DEFAULT_STAT_STAGE

/** The attacker-side note the dispatch is supposed to have stopped emitting for a ported ability. */
const attackerNote = (notes: string[], ability: string) =>
  notes.filter((n) => n === `move-end attacker ability ${ability} is not modelled yet`)

/** One turn: holder (battler 0) uses `moveId` on battler 1 for a fixed amount of damage. */
function run(
  ability: string,
  moveId: string,
  rolls: number[],
  holder: BattlerSpec = {},
  target: BattlerSpec = {},
  setup?: (state: BattleState) => void,
  dmg = 10,
) {
  const rng = scriptedRng(rolls)
  const state = battle([{ moves: slot(moveId), pp: pps, abilities: hasAbility(ability), ...holder }, target], rng)
  setup?.(state)
  const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(dmg)))
  return { state, rng, out, holder: state.battlers[0]!, target: state.battlers[1]! }
}

/** The move-end attacker dispatch alone (no accuracy / protect pipeline), for states a real turn would not reach. */
function dispatch(
  state: BattleState,
  moveId: string,
  opts: { targetDamage?: number; hpDealt?: number; noEffect?: boolean; isCriticalHit?: boolean } = {},
) {
  const unmodelled: string[] = []
  const targetDamage = opts.targetDamage ?? 20
  const hpDealt = opts.hpDealt ?? targetDamage
  const res = dispatchMoveEndAttackerAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt,
    noEffect: opts.noEffect,
    isCriticalHit: opts.isCriticalHit,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled,
    fainted: [],
  })
  return { res, unmodelled }
}

// ---------------------------------------------------------------------------
// 1. Blood Stain (src/abilities.cc:8372-8386)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Blood Stain (abilities.cc:8372-8386)', () => {
  const BS = 'ABILITY_BLOOD_STAIN'
  const holder = { abilities: hasAbility(BS), moves: slot('MOVE_TACKLE'), pp: pps }

  it('overwrites the contacted target primary ability and disables that slot switch-in', () => {
    // ReplaceAbility (battle_util.c:9325) writes abilities[0]; DisableSwitchInAbility (:3922-3927) then marks the
    // slot it just wrote. No roll of its own.
    const state = battle([holder, {}], scriptedRng([]))
    const { res, unmodelled } = dispatch(state, 'MOVE_TACKLE')
    expect(state.battlers[1]!.mon.abilities.ability).toBe(BS)
    expect(state.battlers[1]!.volatiles.switchInAbilityDone[0]).toBe(true)
    expect(res.statusApplied).toBeNull()
    expect(attackerNote(unmodelled, BS)).toEqual([])
  })

  it('needs contact, a damaging hit and a replaceable ability', () => {
    const noContact = battle([holder, {}], scriptedRng([]))
    dispatch(noContact, 'MOVE_WATER_GUN') // bulletBased, non-contact
    expect(noContact.battlers[1]!.mon.abilities.ability).toBeNull()

    const noDamage = battle([holder, {}], scriptedRng([]))
    dispatch(noDamage, 'MOVE_TACKLE', { targetDamage: 0, hpDealt: 0 })
    expect(noDamage.battlers[1]!.mon.abilities.ability).toBeNull()

    // IsPersistentOrUnsuppressableAbility (battle_util.c:4790) blocks the write.
    const persistent = battle([holder, { abilities: hasAbility('ABILITY_MULTITYPE') }], scriptedRng([]))
    dispatch(persistent, 'MOVE_TACKLE')
    expect(persistent.battlers[1]!.mon.abilities.ability).toBe('ABILITY_MULTITYPE')
  })
})

// ---------------------------------------------------------------------------
// 2. Daybreak (src/abilities.cc:9193-9205)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Daybreak (abilities.cc:9193-9205)', () => {
  const DB = 'ABILITY_DAYBREAK'

  it('burns a contacted, burnable target without drawing a roll', () => {
    const { rng, target, out } = run(DB, 'MOVE_TACKLE', [0])
    expect(hasFlag(target.mon.status1, STATUS1_BURN)).toBe(true)
    expect(rng.calls).toBe(1) // the accuracy roll only: AbilityStatusEffectSafe(MOVE_EFFECT_BURN) draws nothing
    expect(out.actions[0]!.statusApplied).toEqual({ battlerId: 1, status: 'BURN' })
    expect(attackerNote(out.actions[0]!.unmodelled, DB)).toEqual([])
  })

  it('does nothing for a Fire target or a non-contact move', () => {
    // CanBeBurned (battle_util.c:5061-5070) rejects Fire types before the contact check.
    const fire = run(DB, 'MOVE_TACKLE', [0], {}, { types: TYPES('FIRE') })
    expect(fire.target.mon.status1).toBe(0)

    // MOVE_SWIFT: special, no contact, no secondary effect.
    const noContact = run(DB, 'MOVE_SWIFT', [0])
    expect(noContact.target.mon.status1).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Demolitionist (src/abilities.cc:7771-7785)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Demolitionist (abilities.cc:7771-7785)', () => {
  const DEMO = 'ABILITY_DEMOLITIONIST'
  const withScreens = () => {
    const state = battle([{ abilities: hasAbility(DEMO), moves: slot('MOVE_TACKLE'), pp: pps }, {}], scriptedRng([]))
    state.battlers[0]!.volatiles.readiedAction = true
    state.sides[1].statuses = setFlag(0, SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_AURORA_VEIL)
    state.sides[1].timers.reflectTimer = 5
    state.sides[1].timers.lightscreenTimer = 5
    state.sides[1].timers.auroraVeilTimer = 5
    return state
  }

  it('shatters the target side screens while readiedAction is up', () => {
    // BattleScript_AttackerShattersScreens is `removelightscreenreflect`, i.e. the same writes Brick Break makes.
    const state = withScreens()
    dispatch(state, 'MOVE_TACKLE')
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(false)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(false)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_AURORA_VEIL)).toBe(false)
    expect(state.sides[1].timers.reflectTimer).toBe(0)
    expect(state.sides[1].timers.lightscreenTimer).toBe(0)
    expect(state.sides[1].timers.auroraVeilTimer).toBe(0)
  })

  it('needs readiedAction and a hit', () => {
    const noReadied = withScreens()
    noReadied.battlers[0]!.volatiles.readiedAction = false
    dispatch(noReadied, 'MOVE_TACKLE')
    expect(hasFlag(noReadied.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(true)

    const noHit = withScreens()
    dispatch(noHit, 'MOVE_TACKLE', { targetDamage: 0, hpDealt: 0 })
    expect(hasFlag(noHit.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(true)
  })

  it('still shatters on a lethal hit: DidMoveHit() has no liveness requirement', () => {
    const state = withScreens()
    state.battlers[1]!.mon.hp = 0
    dispatch(state, 'MOVE_TACKLE')
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Gulp Missile, onAttacker half (src/abilities.cc:3262-3288)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Gulp Missile onAttacker (abilities.cc:3262-3288)', () => {
  const GM = 'ABILITY_GULP_MISSILE'
  // The real slot layout: Gulp Missile is Cramorant's first innate, not its primary ability.
  const cramorant = (overrides: BattlerSpec = {}): BattlerSpec => ({
    speciesId: 'SPECIES_CRAMORANT',
    abilities: { ability: 'ABILITY_PREDATOR', innates: [GM, null, null] },
    moves: slot('MOVE_SURF'),
    pp: pps,
    ...overrides,
  })

  it('changes to GULPING above half HP on a damaging Surf', () => {
    const state = battle([cramorant({ hp: 100, maxHp: 100 }), {}], scriptedRng([]))
    dispatch(state, 'MOVE_SURF')
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_CRAMORANT_GULPING')
  })

  it('changes to GORGING at or below half HP (hp <= maxHP / 2)', () => {
    const state = battle([cramorant({ hp: 40, maxHp: 100 }), {}], scriptedRng([]))
    dispatch(state, 'MOVE_SURF')
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_CRAMORANT_GORGING')
  })

  it('also fires while the holder is STATUS3_UNDERWATER, even with no damage', () => {
    const state = battle([cramorant(), {}], scriptedRng([]))
    state.battlers[0]!.statuses3 = setFlag(0, STATUS3_UNDERWATER)
    dispatch(state, 'MOVE_DIVE', { targetDamage: 0, hpDealt: 0 })
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_CRAMORANT_GULPING')
  })

  it('needs Surf / Triple Dive damage or the underwater bit, and the base species', () => {
    const otherMove = battle([cramorant(), {}], scriptedRng([]))
    dispatch(otherMove, 'MOVE_TACKLE')
    expect(otherMove.battlers[0]!.mon.speciesId).toBe('SPECIES_CRAMORANT')

    const alreadyGulping = battle([cramorant({ speciesId: 'SPECIES_CRAMORANT_GULPING' }), {}], scriptedRng([]))
    dispatch(alreadyGulping, 'MOVE_SURF')
    expect(alreadyGulping.battlers[0]!.mon.speciesId).toBe('SPECIES_CRAMORANT_GULPING')
  })
})

// ---------------------------------------------------------------------------
// 5. Hollow Ice Zone (src/abilities.cc:12178-12198)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Hollow Ice Zone (abilities.cc:12178-12198)', () => {
  const HIZ = 'ABILITY_HOLLOW_ICE_ZONE'
  const holder = (overrides: BattlerSpec = {}) => ({ abilities: hasAbility(HIZ), moves: slot('MOVE_ICE_BEAM'), pp: pps, ...overrides })

  it('freezes the target into an Ice statue and schedules the holder switch', () => {
    // SET_BATTLER_TYPE (include/battle.h:755-760) writes Ice / Ice / TYPE_MYSTERY, and the C's
    // ExtraSwitchActionStruct really does set switchingBattler = battler, the HOLDER, not the frozen target.
    const state = battle([holder(), {}], scriptedRng([]))
    dispatch(state, 'MOVE_ICE_BEAM')
    expect(state.battlers[1]!.volatiles.iceStatue).toBe(true)
    expect(state.battlers[1]!.mon.types).toEqual(['ICE', 'ICE', 'MYSTERY'])
    expect(state.queuedSwitches).toEqual([
      { ability: HIZ, setAbilityState: false, switchingBattler: 0, sourceBattler: 0 },
    ])
  })

  it('needs an Ice move and a target that is not already a statue', () => {
    const notIce = battle([holder({ moves: slot('MOVE_TACKLE') }), {}], scriptedRng([]))
    dispatch(notIce, 'MOVE_TACKLE')
    expect(notIce.battlers[1]!.volatiles.iceStatue).toBe(false)
    expect(notIce.queuedSwitches).toEqual([])

    const alreadyFrozen = battle([holder(), {}], scriptedRng([]))
    alreadyFrozen.battlers[1]!.volatiles.iceStatue = true
    dispatch(alreadyFrozen, 'MOVE_ICE_BEAM')
    expect(alreadyFrozen.queuedSwitches).toEqual([])

    // CHECK_NOT(BattlerHasAbility(target, ability, FALSE)): the target having it too blocks the hook.
    const sameAbility = battle([holder(), { abilities: hasAbility(HIZ) }], scriptedRng([]))
    dispatch(sameAbility, 'MOVE_ICE_BEAM')
    expect(sameAbility.battlers[1]!.volatiles.iceStatue).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. Home Run, onAttacker half (src/abilities.cc:11926-11985)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Home Run onAttacker (abilities.cc:11926-11985)', () => {
  const HR = 'ABILITY_HOME_RUN'
  const holder = (overrides: BattlerSpec = {}): BattlerSpec => ({
    abilities: hasAbility(HR),
    moves: slot('MOVE_TACKLE'),
    pp: pps,
    atk: 150,
    def: 60,
    spatk: 110,
    spdef: 70,
    spe: 200,
    ...overrides,
  })

  it('raises the three highest stats one stage each, in the C LIFO order', () => {
    // Values ATK 150 / DEF 60 / SPATK 110 / SPDEF 70 / SPEED 200: no ties, so the "partial bubble sort" draws
    // nothing. The sort leaves SPDEF, DEF, SPATK in slots 0-2, and the boost loop reads STAT_SPEED..STAT_ATK.
    const state = battle([holder(), {}], scriptedRng([]))
    const { res } = dispatch(state, 'MOVE_TACKLE', { isCriticalHit: true })
    expect(res.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPDEF, change: 1 },
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_SPATK, change: 1 },
    ])
    expect(stage(state, 0, STAT_SPDEF)).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stage(state, 0, STAT_DEF)).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stage(state, 0, STAT_SPATK)).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stage(state, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE)
    expect(stage(state, 0, STAT_SPEED)).toBe(DEFAULT_STAT_STAGE)
    // SetAbilityState(battler, ability, 1), then onEndTurn clears it.
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(1)

    // CHECK_NOT(GetAbilityState(battler, ability)): a second hit in the same turn does nothing.
    const again = dispatch(state, 'MOVE_TACKLE', { isCriticalHit: true })
    expect(again.res.statChanges).toEqual([])
    expect(stage(state, 0, STAT_SPDEF)).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('draws the tie-break only on equal values, and an odd roll skips the swap', () => {
    // ATK 200 / DEF 100 / SPATK 300 / SPDEF 200 / SPEED 100. Pass 1 (maxValueIndex 4) ends with SPEED, DEF,
    // ATK(200), SPDEF(200), SPATK(300), so pass 2 (maxValueIndex 3) compares ATK against SPDEF and ties there:
    // exactly one draw in both branches, but the swap decides which of ATK / SPDEF survives into the top three.
    const tied = { atk: 200, def: 100, spatk: 300, spdef: 200, spe: 100 }
    const oddRng = scriptedRng([1])
    const odd = battle([holder(tied), {}], oddRng)
    const oddRes = dispatch(odd, 'MOVE_TACKLE', { isCriticalHit: true })
    expect(oddRng.calls).toBe(1)
    // Odd: no swap, top three are SPEED / DEF / ATK, boosted in the C's LIFO priority order.
    expect(oddRes.res.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPEED, change: 1 },
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_ATK, change: 1 },
    ])

    // Even: SPDEF trades places with ATK, so SPDEF is boosted instead of ATK.
    const evenRng = scriptedRng([0])
    const even = battle([holder(tied), {}], evenRng)
    const evenRes = dispatch(even, 'MOVE_TACKLE', { isCriticalHit: true })
    expect(evenRng.calls).toBe(1)
    expect(evenRes.res.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPEED, change: 1 },
      { battlerId: 0, stat: STAT_SPDEF, change: 1 },
      { battlerId: 0, stat: STAT_DEF, change: 1 },
    ])
    expect(stage(even, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE)
  })

  it('needs a critical hit', () => {
    const rng = scriptedRng([])
    const state = battle([holder(), {}], rng)
    const { res } = dispatch(state, 'MOVE_TACKLE')
    expect(res.statChanges).toEqual([])
    expect(stage(state, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 7. Know Your Place (src/abilities.cc:9074-9085)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Know Your Place (abilities.cc:9074-9085)', () => {
  const KYP = 'ABILITY_KNOW_YOUR_PLACE'
  const holder = { abilities: hasAbility(KYP), moves: slot('MOVE_TACKLE'), pp: pps }

  it('sets dazed = 5 and the started bit with no roll of its own', () => {
    const state = battle([holder, {}], scriptedRng([]))
    dispatch(state, 'MOVE_TACKLE')
    expect(state.battlers[1]!.volatiles.dazed).toBe(5)
    expect(state.battlers[1]!.volatiles.started.dazed).toBe(true)
  })

  it('dazes through a real turn', () => {
    const { rng, target } = run(KYP, 'MOVE_TACKLE', [0])
    expect(target.volatiles.dazed).toBe(5)
    expect(rng.calls).toBe(1) // accuracy only
  })

  it('needs contact and a target that is not already dazed', () => {
    const noContact = battle([holder, {}], scriptedRng([]))
    dispatch(noContact, 'MOVE_WATER_GUN')
    expect(noContact.battlers[1]!.volatiles.dazed).toBe(0)

    const already = battle([holder, {}], scriptedRng([]))
    already.battlers[1]!.volatiles.dazed = 2
    dispatch(already, 'MOVE_TACKLE')
    expect(already.battlers[1]!.volatiles.dazed).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 8. Paint Shot (src/abilities.cc:10711-10725)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Paint Shot (abilities.cc:10711-10725)', () => {
  const PS = 'ABILITY_PAINT_SHOT'
  const holder = (overrides: BattlerSpec = {}) => ({ abilities: hasAbility(PS), moves: slot('MOVE_WATER_GUN'), pp: pps, ...overrides })

  it('retypes the target to the Mega Launcher move type', () => {
    // Water Gun carries the bulletBased flag, which is what DoesMoveMatchFlag(... MOVE_FLAG_MEGA_LAUNCHER) reads.
    const state = battle([holder(), {}], scriptedRng([]))
    dispatch(state, 'MOVE_WATER_GUN')
    expect(state.battlers[1]!.mon.types).toEqual(['WATER', 'WATER', 'MYSTERY'])
  })

  it('needs a Mega Launcher move and a target not already of that type', () => {
    const notBoosted = battle([holder({ moves: slot('MOVE_TACKLE') }), {}], scriptedRng([]))
    dispatch(notBoosted, 'MOVE_TACKLE')
    expect(notBoosted.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])

    const alreadyWater = battle([holder(), { types: TYPES('WATER') }], scriptedRng([]))
    dispatch(alreadyWater, 'MOVE_WATER_GUN')
    expect(alreadyWater.battlers[1]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
  })
})

// ---------------------------------------------------------------------------
// 9. Shields Down, onAttacker half (src/abilities.cc:2680-2720)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Shields Down onAttacker (abilities.cc:2680-2720)', () => {
  const SD = 'ABILITY_SHIELDS_DOWN'
  // Minior really has Shields Down as its first innate, in both the Meteor form and the cores.
  const minior = (overrides: BattlerSpec = {}): BattlerSpec => ({
    speciesId: 'SPECIES_MINIOR',
    abilities: { ability: 'ABILITY_REGENERATOR', innates: [SD, null, null] },
    moves: slot('MOVE_SHELL_SMASH'),
    pp: pps,
    ...overrides,
  })

  it('drops the Meteor form to a core after Shell Smash and spends the ability state', () => {
    const state = battle([minior(), {}], scriptedRng([]))
    dispatch(state, 'MOVE_SHELL_SMASH', { targetDamage: 0, hpDealt: 0 })
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_RED')
    // SetAbilityState(TRUE) lands in the NEW species' slot, and it runs BEFORE BattleScript_AttackerFormChange's
    // `switchinabilities` -- so the switch-in Forecast hook cannot revert core -> Meteor (battle_util.c:3824-3825).
    expect(state.battlers[0]!.mon.abilities.innates[0]).toBe(SD)
    expect(state.battlers[0]!.volatiles.abilityState[1]).toBe(1)
  })

  it('only reacts to EFFECT_SHELL_SMASH, and not while transformed or on MOVE_RESULT_NO_EFFECT', () => {
    const otherMove = battle([minior({ moves: slot('MOVE_TACKLE') }), {}], scriptedRng([]))
    dispatch(otherMove, 'MOVE_TACKLE')
    expect(otherMove.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR')

    const transformed = battle([minior(), {}], scriptedRng([]))
    transformed.battlers[0]!.mon.status2 = setFlag(0, STATUS2_TRANSFORMED)
    dispatch(transformed, 'MOVE_SHELL_SMASH', { targetDamage: 0, hpDealt: 0 })
    expect(transformed.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR')

    const noEffect = battle([minior(), {}], scriptedRng([]))
    dispatch(noEffect, 'MOVE_SHELL_SMASH', { targetDamage: 0, hpDealt: 0, noEffect: true })
    expect(noEffect.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR')
  })
})

// ---------------------------------------------------------------------------
// 10. Sinister Claws (src/abilities.cc:12415-12429)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Sinister Claws (abilities.cc:12415-12429)', () => {
  const SC = 'ABILITY_SINISTER_CLAWS'
  const holder = (overrides: BattlerSpec = {}) => ({ abilities: hasAbility(SC), moves: slot('MOVE_NIGHT_SLASH'), pp: pps, ...overrides })

  it('drops the target Sp. Def once per target per turn on a Keen Edge move', () => {
    const state = battle([holder(), {}], scriptedRng([]))
    const { res, unmodelled } = dispatch(state, 'MOVE_NIGHT_SLASH')
    expect(res.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPDEF, change: -1 }])
    expect(stage(state, 1, STAT_SPDEF)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(attackerNote(unmodelled, SC)).toEqual([])

    // SetOncePerTurnAbilityCounter(battler, ability, affected | (1 << target)): the second hit is filtered out.
    const again = dispatch(state, 'MOVE_NIGHT_SLASH')
    expect(again.res.statChanges).toEqual([])
    expect(stage(state, 1, STAT_SPDEF)).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('needs a sliceBased (Keen Edge) move', () => {
    const notKeenEdge = battle([holder({ moves: slot('MOVE_TACKLE') }), {}], scriptedRng([]))
    dispatch(notKeenEdge, 'MOVE_TACKLE')
    expect(stage(notKeenEdge, 1, STAT_SPDEF)).toBe(DEFAULT_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// 11. Spectral Shroud (src/abilities.cc:4883-4901)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Spectral Shroud (abilities.cc:4883-4901)', () => {
  const SS = 'ABILITY_SPECTRAL_SHROUD'
  const holder = (overrides: BattlerSpec = {}) => ({ abilities: hasAbility(SS), moves: slot('MOVE_TACKLE'), pp: pps, ...overrides })

  it('badly poisons on a 30% roll after a damaging hit', () => {
    const rng = scriptedRng([29])
    const state = battle([holder(), {}], rng)
    const { res, unmodelled } = dispatch(state, 'MOVE_TACKLE')
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
    expect(res.statusApplied).toEqual({ battlerId: 1, status: 'TOXIC' })
    expect(rng.calls).toBe(1)
    expect(attackerNote(unmodelled, SS)).toEqual([])
  })

  it('a 30 roll misses, and an already-statused target draws nothing', () => {
    const rng = scriptedRng([30])
    const state = battle([holder(), {}], rng)
    dispatch(state, 'MOVE_TACKLE')
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(1)

    const statusedRng = scriptedRng([])
    const statused = battle([holder(), { status1: STATUS1_BURN }], statusedRng)
    dispatch(statused, 'MOVE_TACKLE')
    expect(statused.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(statusedRng.calls).toBe(0)
  })

  it('fires after a successful status move, where damage is not required', () => {
    // IS_MOVE_STATUS(move): CHECK(WasMoveSuccessful()) + CHECK(IsBattlerAlive(target)), not ShouldApplyOnHitEffect.
    const rng = scriptedRng([0])
    const state = battle([holder({ moves: slot('MOVE_WILL_O_WISP') }), {}], rng)
    dispatch(state, 'MOVE_WILL_O_WISP', { targetDamage: 0, hpDealt: 0 })
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
    expect(rng.calls).toBe(1)

    const failedRng = scriptedRng([])
    const failed = battle([holder({ moves: slot('MOVE_WILL_O_WISP') }), {}], failedRng)
    dispatch(failed, 'MOVE_WILL_O_WISP', { targetDamage: 0, hpDealt: 0, noEffect: true })
    expect(failed.battlers[1]!.mon.status1).toBe(0)
    expect(failedRng.calls).toBe(0)
  })

  it('runs Spectralize onAttacker first: its Fear roll precedes the Shroud roll', () => {
    // The C is `Impl<ABILITY_SPECTRALIZE>.onAttacker(...) | SpectralShroud(...)` on a Ghost holder with a Ghost
    // move: Random() % 10 for Fear, then Random() % 100 for the poison. Both are drawn for a bitwise OR.
    const rng = scriptedRng([0, 30])
    const state = battle([holder({ moves: slot('MOVE_SHADOW_SNEAK'), types: TYPES('GHOST') }), {}], rng)
    dispatch(state, 'MOVE_SHADOW_SNEAK')
    expect(state.battlers[1]!.volatiles.fear).toBe(true)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(2)

    const noFearRng = scriptedRng([1, 29])
    const noFear = battle([holder({ moves: slot('MOVE_SHADOW_SNEAK'), types: TYPES('GHOST') }), {}], noFearRng)
    dispatch(noFear, 'MOVE_SHADOW_SNEAK')
    expect(noFear.battlers[1]!.volatiles.fear).toBe(false)
    expect(hasFlag(noFear.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
    expect(noFearRng.calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 12. Spinning Top (src/abilities.cc:5116-5142)
// ---------------------------------------------------------------------------

describe('Cycle 106b - Spinning Top (abilities.cc:5116-5142)', () => {
  const ST = 'ABILITY_SPINNING_TOP'
  const holder = (overrides: BattlerSpec = {}) => ({ abilities: hasAbility(ST), moves: slot('MOVE_CLOSE_COMBAT'), pp: pps, ...overrides })

  it('clears the holder side hazards and raises Speed, once per turn', () => {
    const state = battle([holder(), {}], scriptedRng([]))
    state.sides[0].statuses = setFlag(0, SIDE_STATUS_SPIKES | SIDE_STATUS_STEALTH_ROCK | SIDE_STATUS_STICKY_WEB)
    state.sides[0].timers.hotCoals = true
    const { res } = dispatch(state, 'MOVE_CLOSE_COMBAT')
    expect(state.sides[0].statuses).toBe(0)
    expect(state.sides[0].timers.hotCoals).toBe(false)
    expect(res.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: 1 }])
    expect(stage(state, 0, STAT_SPEED)).toBe(DEFAULT_STAT_STAGE + 1)

    // CheckAndSetOncePerTurnAbility was consumed by the first Fighting move.
    const again = dispatch(state, 'MOVE_CLOSE_COMBAT')
    expect(again.res.statChanges).toEqual([])
    expect(stage(state, 0, STAT_SPEED)).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('keeps Sticky Web while Foamy Web is up (GetClearableHazardFlags)', () => {
    const state = battle([holder(), {}], scriptedRng([]))
    state.sides[0].statuses = setFlag(0, SIDE_STATUS_SPIKES | SIDE_STATUS_STICKY_WEB)
    state.sides[0].timers.foamyWeb = true
    dispatch(state, 'MOVE_CLOSE_COMBAT')
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_STICKY_WEB)).toBe(true)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(false)
  })

  it('needs a Fighting move and a damaging hit', () => {
    const notFighting = battle([holder({ moves: slot('MOVE_TACKLE') }), {}], scriptedRng([]))
    notFighting.sides[0].statuses = setFlag(0, SIDE_STATUS_SPIKES)
    dispatch(notFighting, 'MOVE_TACKLE')
    expect(hasFlag(notFighting.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(stage(notFighting, 0, STAT_SPEED)).toBe(DEFAULT_STAT_STAGE)

    const noDamage = battle([holder(), {}], scriptedRng([]))
    noDamage.sides[0].statuses = setFlag(0, SIDE_STATUS_SPIKES)
    dispatch(noDamage, 'MOVE_CLOSE_COMBAT', { targetDamage: 0, hpDealt: 0 })
    expect(hasFlag(noDamage.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(true)
  })
})
