import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, SimBattleMon, SimPartyMon } from './state'
import {
  BATTLE_TYPE_ARENA,
  STAT_SPEED,
  STATUS2_WRAPPED,
  STATUS3_GASTRO_ACID,
  STATUS3_ROOTED,
  STATUS4_COMMANDED,
  STATUS_FIELD_FAIRY_LOCK,
} from './constants'
import { isAbilityPreventingEscape, canBattlerEscape, type EscapeDeps } from './escape'
import type { SimDataContext, SimItemData, SimSpeciesData } from './dataContext'
import type { GroundingContext } from './grounding'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { ChosenAction } from './turnOrder'
import { executeTurn, type DamageResolver, type TurnLoopDeps } from './turn'
import { chooseMoveOrActionSingles } from './ai/aiPipeline'
import { trainerAiFlags } from './ai/aiFlags'
import type { AiSwitchingDeps } from './ai/aiSwitching'
import type { BridgeDeps } from './bridge'
import type { MoveData } from '../calculate'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const read = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = read<Array<Record<string, any>>>('moves.json')
const moveById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = read<Array<Record<string, any>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const rawItems = read<Array<Record<string, any>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const natures = read<any>('natures.json')
const holdEffectIds = read<Record<string, number>>('holdEffectIds.json')
const moveBehaviors = read<any>('moveBehaviors.json').behaviors
const chart = read<Record<string, Record<string, number>>>('types.json')
const inverseChart = read<Record<string, Record<string, number>>>('typesInverse.json')

function toMoveData(id: string): MoveData {
  const move = moveById.get(id)
  if (!move) throw new Error(`snapshot is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id,
    power: move.power,
    type: move.type ? String(move.type).replace('TYPE_', '') : null,
    type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split,
    effectChance: move.effectChance,
    splitFlag: move.splitFlag,
    effect: move.effect,
    customBehavior: move.customBehavior,
    crit: move.crit,
    flags: move.flags ?? {},
    priority: move.priority,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? (arg.value as string) : null,
    miscEffect: arg?.kind === 'misc' ? (arg.value as string) : null,
    multiHitArgument: arg?.kind === 'int' ? (arg.value as number) : null,
  } as MoveData
}

const dataContext: SimDataContext = {
  species: (id) => speciesById.get(id) as SimSpeciesData | undefined,
  item: (id) => itemsById.get(id) as SimItemData | undefined,
  move: (id) => {
    const m = moveById.get(id)
    if (!m) return undefined
    const arg = m.argument as Record<string, unknown> | undefined
    return {
      id,
      power: m.power,
      type: m.type,
      split: m.split,
      effect: m.effect,
      priority: m.priority,
      flags: m.flags ?? {},
      accuracy: m.accuracy,
      argumentInt: arg?.kind === 'int' ? (arg.value as number) : null,
    }
  },
}

const grounding: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const bridge: BridgeDeps = {
  grounding,
  turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
  statStageRatios: natures.statStageRatios,
  dataContext,
  inverseBattle: false,
}

const aiDeps: AiSwitchingDeps = {
  ...bridge,
  moveData: (id) => (moveById.has(id) ? toMoveData(id) : undefined),
  typeChart: chart,
  inverseTypeChart: inverseChart,
  moveBehaviors,
  battleConstants: natures,
  holdEffectIds,
}

function escDeps(s: BattleState, monotypeChampType: string | null = null): EscapeDeps {
  return {
    dataContext,
    grounding: {
      ...grounding,
      monotypeChampType,
      holdEffectOf: (id) => {
        const itemId = s.battlers[id]?.mon.itemId
        return itemId ? ((itemsById.get(itemId)?.resolvedHoldEffect as string | null) ?? null) : null
      },
    },
  }
}

function makeTurnDeps(ctx: SimDataContext): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const damage: DamageResolver = {
    resolve() {
      return { targetDamage: 10, attackerDamage: null, unmodelled: [] }
    },
  }
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: natures.statStageRatios,
    dataContext: ctx,
  }
}

function makeMon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
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

function makePartyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
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

function makeState(
  a: Partial<SimBattleMon> = {},
  d: Partial<SimBattleMon> = {},
  options: { battleTypeFlags?: number } = {},
): BattleState {
  return createBattleState({
    battlers: [
      createBattlerState(0, makeMon(a), 0),
      createBattlerState(1, makeMon(d), 0),
    ],
    rng: { random16: () => 0 },
    battleTypeFlags: options.battleTypeFlags ?? 0,
  })
}

describe('isAbilityPreventingEscape and canBattlerEscape (cycle 49)', () => {
  it('1. Shadow Tag traps a non-Ghost foe', () => {
    const s = makeState(
      { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
      { abilities: { ability: 'ABILITY_SHADOW_TAG', innates: [null, null, null] } },
    )
    const res = isAbilityPreventingEscape(s, 0, escDeps(s))
    expect(res.prevents).toBe(true)
    expect(res.trappingBattlerId).toBe(1)
    expect(res.unmodelled).toEqual([])
  })

  it('2. does not trap a Ghost', () => {
    const s = makeState(
      { types: ['GHOST', 'MYSTERY', 'MYSTERY'] },
      { abilities: { ability: 'ABILITY_SHADOW_TAG', innates: [null, null, null] } },
    )
    const res = isAbilityPreventingEscape(s, 0, escDeps(s))
    expect(res.prevents).toBe(false)
    expect(res.unmodelled).toEqual([])
  })

  it('3. does not trap a foe that also has Shadow Tag (and Frenzied Phantom alias)', () => {
    const sShadowTag = makeState(
      { abilities: { ability: 'ABILITY_SHADOW_TAG', innates: [null, null, null] } },
      { abilities: { ability: 'ABILITY_SHADOW_TAG', innates: [null, null, null] } },
    )
    expect(isAbilityPreventingEscape(sShadowTag, 0, escDeps(sShadowTag)).prevents).toBe(false)

    const sFrenzied = makeState(
      { abilities: { ability: 'ABILITY_SHADOW_TAG', innates: [null, null, null] } },
      { abilities: { ability: 'ABILITY_FRENZIED_PHANTOM', innates: [null, null, null] } },
    )
    expect(isAbilityPreventingEscape(sFrenzied, 0, escDeps(sFrenzied)).prevents).toBe(false)

    // Frenzied Phantom traps a non-Shadow Tag foe
    const sFrenziedTraps = makeState(
      { abilities: { ability: null, innates: [null, null, null] } },
      { abilities: { ability: 'ABILITY_FRENZIED_PHANTOM', innates: [null, null, null] } },
    )
    expect(isAbilityPreventingEscape(sFrenziedTraps, 0, escDeps(sFrenziedTraps)).prevents).toBe(true)
  })

  it('4. Magnet Pull traps a Steel type only', () => {
    const steelState = makeState(
      { types: ['STEEL', 'MYSTERY', 'MYSTERY'] },
      { abilities: { ability: 'ABILITY_MAGNET_PULL', innates: [null, null, null] } },
    )
    expect(isAbilityPreventingEscape(steelState, 0, escDeps(steelState)).prevents).toBe(true)

    const waterState = makeState(
      { types: ['WATER', 'MYSTERY', 'MYSTERY'] },
      { abilities: { ability: 'ABILITY_MAGNET_PULL', innates: [null, null, null] } },
    )
    expect(isAbilityPreventingEscape(waterState, 0, escDeps(waterState)).prevents).toBe(false)
  })

  it('5. Arena Trap traps a grounded foe but not a Flying type / Levitate holder', () => {
    const groundedState = makeState(
      { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
      { abilities: { ability: 'ABILITY_ARENA_TRAP', innates: [null, null, null] } },
    )
    expect(isAbilityPreventingEscape(groundedState, 0, escDeps(groundedState)).prevents).toBe(true)

    const flyingState = makeState(
      { types: ['FLYING', 'MYSTERY', 'MYSTERY'] },
      { abilities: { ability: 'ABILITY_ARENA_TRAP', innates: [null, null, null] } },
    )
    expect(isAbilityPreventingEscape(flyingState, 0, escDeps(flyingState)).prevents).toBe(false)

    const levitateState = makeState(
      { abilities: { ability: 'ABILITY_LEVITATE', innates: [null, null, null] } },
      { abilities: { ability: 'ABILITY_ARENA_TRAP', innates: [null, null, null] } },
    )
    expect(isAbilityPreventingEscape(levitateState, 0, escDeps(levitateState)).prevents).toBe(false)
  })

  it('6. Sap Trap traps at Speed stage 3 vs 4', () => {
    const s3 = makeState(
      {},
      { abilities: { ability: 'ABILITY_SAP_TRAP', innates: [null, null, null] } },
    )
    // Fixtures may ignore statStages at battle start -- set after creating the state
    s3.battlers[0]!.mon.statStages[STAT_SPEED] = 3
    expect(isAbilityPreventingEscape(s3, 0, escDeps(s3)).prevents).toBe(true)

    const s4 = makeState(
      {},
      { abilities: { ability: 'ABILITY_SAP_TRAP', innates: [null, null, null] } },
    )
    s4.battlers[0]!.mon.statStages[STAT_SPEED] = 4
    expect(isAbilityPreventingEscape(s4, 0, escDeps(s4)).prevents).toBe(false)
  })

  it('7. Shed Shell frees from ability trapping and wrap', () => {
    const sTrap = makeState(
      { itemId: 'ITEM_SHED_SHELL' },
      { abilities: { ability: 'ABILITY_SHADOW_TAG', innates: [null, null, null] } },
    )
    expect(isAbilityPreventingEscape(sTrap, 0, escDeps(sTrap)).prevents).toBe(false)

    // CanBattlerEscape check: Shed Shell frees from wrap
    const sWrapWithShell = makeState({ status2: STATUS2_WRAPPED, itemId: 'ITEM_SHED_SHELL' }, {})
    expect(canBattlerEscape(sWrapWithShell, 0, escDeps(sWrapWithShell))).toBe(true)

    const sWrapWithoutShell = makeState({ status2: STATUS2_WRAPPED }, {})
    expect(canBattlerEscape(sWrapWithoutShell, 0, escDeps(sWrapWithoutShell))).toBe(false)
  })

  it('8. a suppressed trap ability does not trap', () => {
    const sGa = makeState(
      {},
      { abilities: { ability: 'ABILITY_SHADOW_TAG', innates: [null, null, null] } },
    )
    sGa.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    expect(isAbilityPreventingEscape(sGa, 0, escDeps(sGa)).prevents).toBe(false)

    const sNg = makeState(
      {},
      { abilities: { ability: 'ABILITY_SHADOW_TAG', innates: [null, null, null] } },
    )
    sNg.field.timers.neutralizingGas = true
    expect(isAbilityPreventingEscape(sNg, 0, escDeps(sNg)).prevents).toBe(false)
  })

  it('9. the AI no longer considers switching when trapped', () => {
    const aiFlags = trainerAiFlags({
      risky: false,
      preferStall: false,
      preferStatus: false,
      noSwitching: false,
      forcedDouble: false,
    })
    const reserve = makePartyMon({ hp: 100, moves: ['MOVE_TACKLE', null, null, null] })
    const scores: [number, number, number, number] = [50, 0, 0, 0]

    // AI is battler 1. Foe (battler 0) has Shadow Tag.
    const trappedAiState = createBattleState({
      battlers: [
        createBattlerState(0, makeMon({ abilities: { ability: 'ABILITY_SHADOW_TAG', innates: [null, null, null] } }), 0),
        createBattlerState(1, makeMon({ hp: 100, maxHp: 100 }), 0),
      ],
      rng: { random16: () => 0 },
      opponentParty: [makePartyMon({ hp: 100 }), reserve],
      aiFlags,
    })
    const trappedChoice = chooseMoveOrActionSingles(trappedAiState, 1, scores, aiDeps).choice
    expect(trappedChoice.kind).toBe('move')

    // Untrapped AI: foe has no ability. AI selects switch.
    const freeAiState = createBattleState({
      battlers: [
        createBattlerState(0, makeMon({ abilities: { ability: null, innates: [null, null, null] } }), 0),
        createBattlerState(1, makeMon({ hp: 100, maxHp: 100 }), 0),
      ],
      rng: { random16: () => 0 },
      opponentParty: [makePartyMon({ hp: 100 }), reserve],
      aiFlags,
    })
    const freeChoice = chooseMoveOrActionSingles(freeAiState, 1, scores, aiDeps).choice
    expect(freeChoice).toEqual({ kind: 'switch' })
  })

  it('10. a trapped player switch is refused', () => {
    const reserve = makePartyMon({ hp: 100, moves: ['MOVE_TACKLE', null, null, null] })
    const sTrapped = createBattleState({
      battlers: [
        createBattlerState(0, makeMon({ hp: 100, maxHp: 100 }), 0),
        createBattlerState(1, makeMon({ abilities: { ability: 'ABILITY_SHADOW_TAG', innates: [null, null, null] } }), 0),
      ],
      rng: { random16: () => 0 },
      playerParty: [makePartyMon({ hp: 100 }), reserve],
    })
    sTrapped.battlers[0]!.monToSwitchIntoId = 1

    const actions: (ChosenAction | null)[] = [{ action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }, null]
    const turnDeps = makeTurnDeps(dataContext)
    const outTrapped = executeTurn(sTrapped, actions, turnDeps)

    const playerOutcome = outTrapped.actions.find((a) => a.battlerId === 0)!
    expect(playerOutcome.unmodelled).toContain(
      'executeTurn: SWITCH action for battler 0 refused (prevented by ability of battler 1)',
    )
    expect(sTrapped.battlers[0]!.partyIndex).toBe(0)

    // Also verify CanBattlerEscape / Arena battle refusal
    const sWrapped = createBattleState({
      battlers: [
        createBattlerState(0, makeMon({ hp: 100, maxHp: 100, status2: STATUS2_WRAPPED }), 0),
        createBattlerState(1, makeMon(), 0),
      ],
      rng: { random16: () => 0 },
      playerParty: [makePartyMon({ hp: 100 }), reserve],
    })
    sWrapped.battlers[0]!.monToSwitchIntoId = 1
    const outWrapped = executeTurn(sWrapped, actions, turnDeps)
    const wrappedOutcome = outWrapped.actions.find((a) => a.battlerId === 0)!
    expect(wrappedOutcome.unmodelled).toContain(
      'executeTurn: SWITCH action for battler 0 refused (cannot escape)',
    )
    expect(sWrapped.battlers[0]!.partyIndex).toBe(0)

    // Arena battle flag refusal
    const sArena = createBattleState({
      battlers: [
        createBattlerState(0, makeMon({ hp: 100, maxHp: 100 }), 0),
        createBattlerState(1, makeMon(), 0),
      ],
      rng: { random16: () => 0 },
      battleTypeFlags: BATTLE_TYPE_ARENA,
      playerParty: [makePartyMon({ hp: 100 }), reserve],
    })
    sArena.battlers[0]!.monToSwitchIntoId = 1
    const outArena = executeTurn(sArena, actions, turnDeps)
    const arenaOutcome = outArena.actions.find((a) => a.battlerId === 0)!
    expect(arenaOutcome.unmodelled).toContain(
      'executeTurn: SWITCH action for battler 0 refused (cannot escape)',
    )
    expect(sArena.battlers[0]!.partyIndex).toBe(0)

    // Untrapped switch succeeds
    const sFree = createBattleState({
      battlers: [
        createBattlerState(0, makeMon({ hp: 100, maxHp: 100 }), 0),
        createBattlerState(1, makeMon(), 0),
      ],
      rng: { random16: () => 0 },
      playerParty: [makePartyMon({ hp: 100 }), reserve],
    })
    sFree.battlers[0]!.monToSwitchIntoId = 1
    const outFree = executeTurn(sFree, actions, turnDeps)
    const freeOutcome = outFree.actions.find((a) => a.battlerId === 0)!
    expect(freeOutcome.unmodelled).toEqual([])
    expect(sFree.battlers[0]!.partyIndex).toBe(1)
  })

  it('canBattlerEscape: checks rooted, commanded, and fairy lock', () => {
    // Rooted
    const sRooted = makeState({}, {})
    sRooted.battlers[0]!.statuses3 |= STATUS3_ROOTED
    expect(canBattlerEscape(sRooted, 0, escDeps(sRooted))).toBe(false)

    // Commanded
    const sCommanded = makeState({}, {})
    sCommanded.battlers[0]!.statuses4 |= STATUS4_COMMANDED
    expect(canBattlerEscape(sCommanded, 0, escDeps(sCommanded))).toBe(false)

    // Fairy Lock (gFieldStatuses & STATUS_FIELD_FAIRY_LOCK)
    const sFairyLock = makeState({}, {})
    sFairyLock.field.statuses |= STATUS_FIELD_FAIRY_LOCK
    expect(canBattlerEscape(sFairyLock, 0, escDeps(sFairyLock))).toBe(false)

    // Fighting Monotype Champion blocks player battler (battler 0) but not opponent (battler 1)
    const sFightChamp = makeState({}, {})
    expect(canBattlerEscape(sFightChamp, 0, escDeps(sFightChamp, 'FIGHTING'))).toBe(false)
    expect(canBattlerEscape(sFightChamp, 1, escDeps(sFightChamp, 'FIGHTING'))).toBe(true)

    // Sky dropped
    const sSkyDrop = makeState({}, {})
    sSkyDrop.battlers[0]!.volatiles.skyDropped = true
    expect(canBattlerEscape(sSkyDrop, 0, escDeps(sSkyDrop))).toBe(false)

    // Fear
    const sFear = makeState({}, {})
    sFear.battlers[0]!.volatiles.fear = true
    expect(canBattlerEscape(sFear, 0, escDeps(sFear))).toBe(false)

    // Ghost escapes wrap even without Shed Shell
    const sGhostWrapped = makeState({ types: ['GHOST', 'MYSTERY', 'MYSTERY'], status2: STATUS2_WRAPPED }, {})
    expect(canBattlerEscape(sGhostWrapped, 0, escDeps(sGhostWrapped))).toBe(true)
  })
})
