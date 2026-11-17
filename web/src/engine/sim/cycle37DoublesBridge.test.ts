/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 37 (dbl-1b): feed the three doubles-only damage terms from SIM STATE, so the
// engine work cycle 36 landed (commit d22e848) is actually supplied by the battle
// simulator. Nothing below hand-sets a scenario field: every case goes through
// createBridgeDamageResolver (the player path) or aiCalcDamage (the AI path).
//
//   (1) GetMoveTargetCount(move, battlerAtk, battlerDef) >= 2 -> x0.75
//       (battle_util.c:6761-6781, :7498). The target FLAG is the dynamic
//       GetBattlerBattleMoveTargetFlags (:128-149), and aliveness is IsBattlerAlive
//       (:6685-6694); partner ids are `id ^ 2` (BATTLE_PARTNER).
//   (2) Reflect/Light Screen/Aurora Veil -> x0.66 when
//       `gBattleTypeFlags & BATTLE_TYPE_DOUBLE`, else x0.5 (:7622-7629).
//   (3) Defender's ALIVE partner's Friend Guard / Caretaker / Food Lovers, each
//       BATTLER_HAS_ABILITY_AND_ALIVE(BATTLE_PARTNER(battlerDef), ability, TRUE)
//       -> x0.5 (:7637-7640). TRUE suppresses a `breakable` ability under Mold
//       Breaker; per abilityHooks.json Friend Guard and Food Lovers are breakable,
//       Caretaker is not.
//
// Scaffolding (snapshot loaders, deps, species stats, action builder) is adapted
// from cycle160bMinionControlAi.test.ts / cycle36DoublesDamage.test.ts. Attacker is
// Garchomp (level 100, neutral, 31 IV / 0 EV -> Atk 296), defender Snorlax (Def 166).
// Both are defined from real base stats, so these are the same numbers cycle 36 used:
//
//   Tackle (Normal, 40 power, physical, SELECTED), no STAB on Garchomp, 1x on a
//   pure-Normal Snorlax:
//     dmg = floor(42 * 40 * 296 / 166) = floor(497280 / 166) = 2995
//         = floor(2995 / 50) = 59, + 2 = 61.  rolls[15] = 61 (the 100% roll).
//   Rock Slide (Rock, 75 power, physical, BOTH), no STAB on Garchomp, 1x on Snorlax:
//     core = floor(42 * 75 * 296 / 166) = floor(932400 / 166) = 5616
//          = floor(5616 / 50) = 112, + 2 = 114.  rolls[15] = 114.
//
// Fixed-point: uq(n) = trunc(n*1024); mulModifier(a,b) = floor((a*b+512)/1024);
// applyModifier(m,v) = floor((m*v+512)/1024). uq(0.75)=768, uq(0.5)=512, uq(0.66)=675.
// Every expected literal below is hand-derived from those two cores in its comment.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import { aiCalcDamage, type AiDamageDeps } from './ai/aiCalcDamage'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { BridgeDeps } from './bridge'
import { BATTLE_TYPE_DOUBLE, SIDE_STATUS_LUCKY_CHANT, SIDE_STATUS_REFLECT, STATUS3_GASTRO_ACID } from './constants'
import { registerAbilities, _resetRegistryForTests } from '../abilities/registry'
import { MOLD_BREAKER_ABILITIES } from '../abilities/impl/23-mold-breaker'
import { applyModifier, mulModifier, uq } from '../fixed'
import { calcStat } from '../stats'
import type { MoveData } from '../calculate'
import type { MoveBehaviors } from '../basePower'
import type { TypeChart } from '../typeEffectiveness'

// ---------------------------------------------------------------------------
// Snapshot-backed fixtures.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
/** natures.json is BattleConstants (natureStatTable, statStageRatios, criticalHitChance, ...). */
const battleConstants = snapshot<Record<string, unknown>>('natures.json') as never
const holdEffectIds = snapshot<Record<string, number>>('holdEffectIds.json')

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

/** The bridge/accuracy/target-flag view of a move (SimMoveData). */
function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    type2: (m.type2 as string | null) ?? null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    target: m.target as string | undefined,
    priority: m.priority as number | undefined,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    argumentInt: (m.argumentInt as number | null) ?? null,
    effectChance: m.effectChance as number | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}

/** The damage engine's own MoveData shape (calculate.ts). */
function toMoveData(id: string): MoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  const arg = m.argument as Record<string, unknown> | undefined
  return {
    id,
    power: m.power as number,
    type: m.type ? String(m.type).replace('TYPE_', '') : null,
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

const BRIDGE: BridgeDeps = {
  grounding: GROUNDING,
  turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  inverseBattle: false,
}

function resolverDeps(random: RandomSource): BridgeDamageResolverDeps {
  return {
    ...BRIDGE,
    moveData: (id) => (movesById.has(id) ? toMoveData(id) : undefined),
    typeChart,
    inverseTypeChart,
    moveBehaviors,
    battleConstants,
    random,
  }
}

const aiDeps: AiDamageDeps = {
  ...BRIDGE,
  moveData: (id) => (movesById.has(id) ? toMoveData(id) : undefined),
  typeChart,
  inverseTypeChart,
  moveBehaviors,
  battleConstants,
  holdEffectIds,
}

// ---------------------------------------------------------------------------
// State builders.
// ---------------------------------------------------------------------------

function rawStatsFor(speciesId: string): SimBattleMon['rawStats'] {
  const s = requireSpecies(speciesId)
  const level = 100
  const nature = 'NATURE_HARDY' // neutral
  const table = (battleConstants as unknown as { natureStatTable: Parameters<typeof calcStat>[6] }).natureStatTable
  return {
    atk: calcStat(s.baseStats.atk, 31, 0, level, nature, 'atk', table),
    def: calcStat(s.baseStats.def, 31, 0, level, nature, 'def', table),
    spatk: calcStat(s.baseStats.spatk, 31, 0, level, nature, 'spatk', table),
    spdef: calcStat(s.baseStats.spdef, 31, 0, level, nature, 'spdef', table),
    spe: calcStat(s.baseStats.spe, 31, 0, level, nature, 'spe', table),
  }
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', 'MOVE_ROCK_SLIDE', null, null],
    pp: [20, 10, 0, 0],
    hp: 999,
    maxHp: 999,
    itemId: null,
    statStages: [],
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 100,
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

interface Spec {
  speciesId?: string
  hp?: number
  maxHp?: number
  abilities?: SimBattleMon['abilities']
  types?: [string, string, string]
  moves?: SimBattleMon['moves']
}

/** battler 0 = Garchomp (attacker), battler 1 = Snorlax (defender); pass the
 * remaining partners explicitly. `battleTypeFlags` decides doubles. */
function battle(specs: Spec[], opts: { battleTypeFlags?: number } = {}): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) => {
      const speciesId = s.speciesId ?? (i === 0 ? 'SPECIES_GARCHOMP' : 'SPECIES_SNORLAX')
      const species = requireSpecies(speciesId)
      return createBattlerState(
        i,
        mon({
          speciesId,
          rawStats: rawStatsFor(speciesId),
          types: s.types ?? (species.types as [string, string, string]),
          hp: s.hp ?? 999,
          maxHp: s.maxHp ?? 999,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', 'MOVE_ROCK_SLIDE', null, null],
        }),
        0,
      )
    }),
    rng: scripted(),
    battleTypeFlags: opts.battleTypeFlags,
  })
}

/** A doubles battle: 0 = player left (attacker), 1 = opponent left (defender),
 * 2 = player right (attacker's partner), 3 = opponent right (defender's partner). */
function doubles(defenderPartnerAbilities: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }, defenderPartnerHp = 999): BattleState {
  return battle(
    [
      { speciesId: 'SPECIES_GARCHOMP' },
      { speciesId: 'SPECIES_SNORLAX' },
      { speciesId: 'SPECIES_SNORLAX' },
      { speciesId: 'SPECIES_SNORLAX', hp: defenderPartnerHp, abilities: defenderPartnerAbilities },
    ],
    { battleTypeFlags: BATTLE_TYPE_DOUBLE },
  )
}

function scripted(...values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[idx++] ?? 0
    },
  }
  return r
}

const noCritMaxRoll = (): RandomSource => scripted(1, 0)

function useMove(target: number, moveData: MoveData): ChosenAction {
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

/** The player path: createBridgeDamageResolver, with a non-crit max-roll draw. */
function playerDamage(state: BattleState, moveId: string, rng: RandomSource = noCritMaxRoll()): number | null {
  return createBridgeDamageResolver(resolverDeps(rng)).resolve(state, 0, 1, useMove(1, toMoveData(moveId))).targetDamage
}

function aiDamage(state: BattleState, moveId: string): number {
  return aiCalcDamage(state, moveId, 0, 1, aiDeps).dmg
}

const ability = (id: string, ...innates: (string | null)[]): SimBattleMon['abilities'] => ({
  ability: id,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})

const TACKLE = 'MOVE_TACKLE'
const ROCK_SLIDE = 'MOVE_ROCK_SLIDE'

beforeEach(() => {
  _resetRegistryForTests()
  registerAbilities(MOLD_BREAKER_ABILITIES)
})

// ---------------------------------------------------------------------------
// 1. GetMoveTargetCount >= 2 -> x0.75, fed from state (:6761-6781, :7498)
// ---------------------------------------------------------------------------
describe('multi-target x0.75 from sim state (battle_util.c:6761-6781, :7498)', () => {
  it('BOTH move, both foes alive: 114 -> 86', () => {
    // mulModifier(uq(1.0), uq(0.75)) = 768; applyModifier(768, 114) = floor((768*114+512)/1024) = 86.
    const damage = playerDamage(doubles(), ROCK_SLIDE)
    expect(damage).toBe(applyModifier(mulModifier(uq(1.0), uq(0.75)), 114))
    expect(damage).toBe(86)
  })

  it('BOTH move, foe partner fainted: targetCount 1, no 0.75 -> 114', () => {
    // IsBattlerAlive(BATTLE_PARTNER(def)) is false, so GetMoveTargetCount returns
    // IsBattlerAlive(def) = 1 and CalcFinalDmg never applies the factor.
    const both = playerDamage(doubles(), ROCK_SLIDE)
    const fainted = playerDamage(doubles(undefined, 0), ROCK_SLIDE)
    expect(both).toBe(86)
    expect(fainted).toBe(114)
    // The two scenarios differ by the factor, not just by a flag: 114 - 86 = 28.
    expect(fainted! - both!).toBe(28)
  })
})

// ---------------------------------------------------------------------------
// 2. A SELECTED move never gets the factor, even in doubles (:6761-6781)
// ---------------------------------------------------------------------------
describe('SELECTED moves in doubles (battle_util.c:6761-6781)', () => {
  it('Tackle with both foes alive: targetCount is IsBattlerAlive(def) = 1 -> 61', () => {
    // SELECTED returns alive(battlerDef) only (the partner is not counted), so 61
    // is the unscaled roll. If the term fired it would be applyModifier(768, 61) = 46.
    const state = doubles()
    expect(playerDamage(state, TACKLE)).toBe(61)
    expect(playerDamage(state, TACKLE)).not.toBe(applyModifier(mulModifier(uq(1.0), uq(0.75)), 61))
    expect(applyModifier(mulModifier(uq(1.0), uq(0.75)), 61)).toBe(46)
  })
})

// ---------------------------------------------------------------------------
// 3. Defender's alive partner abilities (:7637-7640)
// ---------------------------------------------------------------------------
describe('defender ally ability reducers from sim state (battle_util.c:7637-7640)', () => {
  it('Friend Guard on the alive partner: x0.5 -> 31', () => {
    // applyModifier(512, 61) = floor((512*61+512)/1024) = 31.
    expect(playerDamage(doubles(ability('ABILITY_FRIEND_GUARD')), TACKLE)).toBe(31)
  })

  it('Mold Breaker suppresses Friend Guard (breakable): x1 -> 61', () => {
    const state = doubles(ability('ABILITY_FRIEND_GUARD'))
    state.battlers[0]!.mon.abilities = ability('ABILITY_MOLD_BREAKER')
    expect(playerDamage(state, TACKLE)).toBe(61)
  })

  it('Caretaker is not breakable, so Mold Breaker leaves its x0.5 -> 31', () => {
    const state = doubles(ability('ABILITY_CARETAKER'))
    state.battlers[0]!.mon.abilities = ability('ABILITY_MOLD_BREAKER')
    expect(playerDamage(state, TACKLE)).toBe(31)
  })

  it('partner fainted: no alive partner, slots null -> 61', () => {
    expect(playerDamage(doubles(ability('ABILITY_FRIEND_GUARD'), 0), TACKLE)).toBe(61)
  })

  it('two reducers on one partner stack, re-quantized: Friend Guard + Caretaker -> 15', () => {
    // mulModifier(1024,512) = 512; mulModifier(512,512) = 256;
    // applyModifier(256, 61) = floor((256*61+512)/1024) = 15.
    expect(playerDamage(doubles(ability('ABILITY_FRIEND_GUARD', 'ABILITY_CARETAKER')), TACKLE)).toBe(15)
  })

  it('Mold Breaker + Friend Guard + Caretaker: only Caretaker survives -> 31', () => {
    const state = doubles(ability('ABILITY_FRIEND_GUARD', 'ABILITY_CARETAKER'))
    state.battlers[0]!.mon.abilities = ability('ABILITY_MOLD_BREAKER')
    expect(playerDamage(state, TACKLE)).toBe(31)
  })
})

// ---------------------------------------------------------------------------
// 3b. Suppression: the reducers read BattlerHasAbility's IsSuppressed gate
//     (battle_util.c:9271-9279, :9255-9261 via include/battle_util.h:74)
// ---------------------------------------------------------------------------
describe('defender ally abilities respect Gastro Acid / Neutralizing Gas', () => {
  it('Friend Guard on a Gastro-Acid partner is suppressed -> 61, not 31', () => {
    // BATTLER_HAS_ABILITY_AND_ALIVE(partner, FRIEND_GUARD, TRUE) is false once
    // IsSuppressed sees STATUS3_GASTRO_ACID on the partner (Friend Guard is not
    // `unsuppressable`), so CalcFinalDmg applies no x0.5. Removing the
    // suppression filter in damageResolver.ts would restore 31.
    const suppressed = doubles(ability('ABILITY_FRIEND_GUARD'))
    suppressed.battlers[3]!.statuses3 |= STATUS3_GASTRO_ACID
    expect(playerDamage(suppressed, TACKLE)).toBe(61)

    // Negative: the same partner without Gastro Acid still halves to 31.
    expect(playerDamage(doubles(ability('ABILITY_FRIEND_GUARD')), TACKLE)).toBe(31)
  })

  it('Friend Guard under Neutralizing Gas is suppressed -> 61', () => {
    // gFieldTimers.neutralizingGas suppresses every non-unsuppressable ability on
    // every battler, the partner included.
    const gas = doubles(ability('ABILITY_FRIEND_GUARD'))
    gas.field.timers.neutralizingGas = true
    expect(playerDamage(gas, TACKLE)).toBe(61)
    expect(playerDamage(doubles(ability('ABILITY_FRIEND_GUARD')), TACKLE)).toBe(31)
  })

  it('AI path: Gastro-Acid Friend Guard equals the no-Friend-Guard 62', () => {
    // aiCalcDamage feeds the MASKED state through the same filter, so the AI
    // estimate must match its own partner-fainted/no-reducer number (62, see the
    // Mold Breaker AI case above) rather than the halved 31.
    const aiNoReducer = aiDamage(doubles(ability('ABILITY_FRIEND_GUARD'), 0), TACKLE)
    expect(aiNoReducer).toBe(62)

    const suppressed = doubles(ability('ABILITY_FRIEND_GUARD'))
    suppressed.battlers[3]!.statuses3 |= STATUS3_GASTRO_ACID
    expect(aiDamage(suppressed, TACKLE)).toBe(aiNoReducer)
    expect(aiDamage(suppressed, TACKLE)).not.toBe(31)

    // Negative: with the ability live the AI path still halves to 31.
    expect(aiDamage(doubles(ability('ABILITY_FRIEND_GUARD')), TACKLE)).toBe(31)
  })
})

// ---------------------------------------------------------------------------
// 4. Screens: x0.66 in doubles, x0.5 in singles (:7622-7629)
// ---------------------------------------------------------------------------
describe('screens multiplier from battleTypeFlags (battle_util.c:7622-7629)', () => {
  it('Reflect + physical move: 0.66 in doubles -> 40, 0.5 in singles -> 31', () => {
    // doubles: applyModifier(675, 61) = floor((675*61+512)/1024) = 40.
    // singles: applyModifier(512, 61) = 31.
    const doubleState = doubles()
    doubleState.sides[1].statuses |= SIDE_STATUS_REFLECT
    expect(playerDamage(doubleState, TACKLE)).toBe(applyModifier(mulModifier(uq(1.0), uq(0.66)), 61))
    expect(playerDamage(doubleState, TACKLE)).toBe(40)

    const singleState = battle([{ speciesId: 'SPECIES_GARCHOMP' }, { speciesId: 'SPECIES_SNORLAX' }])
    singleState.sides[1].statuses |= SIDE_STATUS_REFLECT
    expect(playerDamage(singleState, TACKLE)).toBe(applyModifier(mulModifier(uq(1.0), uq(0.5)), 61))
    expect(playerDamage(singleState, TACKLE)).toBe(31)

    // Both differ from the unscreened value, and from each other.
    const doublesNoScreen = doubles()
    expect(playerDamage(doublesNoScreen, TACKLE)).toBe(61)
    expect(playerDamage(doubleState, TACKLE)).not.toBe(playerDamage(singleState, TACKLE))
  })
})

// ---------------------------------------------------------------------------
// 5. Singles invariant: no factor, no ally slots (:6685-6694)
// ---------------------------------------------------------------------------
describe('singles invariant (battle_util.c:6685-6694)', () => {
  it('BOTH move in singles has targetCount at most 1 -> 114', () => {
    // battlersCount is 2, so BATTLE_PARTNER(def) = 3 is past it and IsBattlerAlive
    // is false. No singles special case is needed; the aliveness test does it.
    const state = battle([{ speciesId: 'SPECIES_GARCHOMP' }, { speciesId: 'SPECIES_SNORLAX' }])
    expect(playerDamage(state, ROCK_SLIDE)).toBe(114)
  })

  it('Tackle in singles keeps the pre-change number exactly: 61', () => {
    const state = battle([{ speciesId: 'SPECIES_GARCHOMP' }, { speciesId: 'SPECIES_SNORLAX' }])
    expect(playerDamage(state, TACKLE)).toBe(61)
  })

  it('a battler in slot 3 with Friend Guard is dead when battlersCount is 2 -> 61', () => {
    // The aliveness test is IsBattlerAlive, not "is there a battler object": its first
    // condition rejects any id >= gBattlersCount. So even a fully built Friend Guard
    // partner in the array contributes nothing in singles.
    const state = doubles(ability('ABILITY_FRIEND_GUARD'))
    state.battlersCount = 2
    expect(playerDamage(state, TACKLE)).toBe(61)
  })
})

// ---------------------------------------------------------------------------
// 6. The AI path feeds the same terms from the masked state
// ---------------------------------------------------------------------------
describe('AI path (aiCalcDamage.ts)', () => {
  it('Rock Slide doubles: crit-blended 87, from the same 86/128 rolls as the player path', () => {
    // Player path (:7635-7541): core 114, crit is applied DIRECTLY before the final
    // modifier: applyModifier(1536, 114) = 171, then applyModifier(768, 171) = 128.
    // So doubles rolls[15] = 86 and critRolls[15] = 128.
    // AI_CalcDamage's own blend (battle_ai_util.c:672-677, critChance = 24):
    //   idiv(critDmg + normalDmg * 23, 24) = idiv(128 + 86*23, 24) = idiv(2106, 24) = 87.
    expect(playerDamage(doubles(), ROCK_SLIDE)).toBe(86)
    expect(aiDamage(doubles(), ROCK_SLIDE)).toBe(87)
    // Negative: in singles the same blend gives idiv(171 + 114*23, 24) = 116, so the
    // AI number is not independent of the target-count term.
    const singles = battle([{ speciesId: 'SPECIES_GARCHOMP' }, { speciesId: 'SPECIES_SNORLAX' }])
    expect(aiDamage(singles, ROCK_SLIDE)).toBe(116)
    expect(aiDamage(doubles(), ROCK_SLIDE)).not.toBe(aiDamage(singles, ROCK_SLIDE))
  })

  it('with Lucky Chant (no crit outcome) the AI and player paths agree exactly: 86', () => {
    // Lucky Chant makes GetInverseCritChance return -1, so AI_CalcDamage takes the
    // `dmg = normalDmg` branch and the player resolver draws no crit roll at all.
    // Both then read the same rolls[15] = 86, the hand-derived doubles value above.
    const state = doubles()
    state.sides[1].statuses |= SIDE_STATUS_LUCKY_CHANT
    expect(playerDamage(state, ROCK_SLIDE, scripted(0))).toBe(86)
    expect(aiDamage(state, ROCK_SLIDE)).toBe(86)
  })

  it('Friend Guard on the partner: AI doubles 31, same hand-derived number as the player path', () => {
    // Player: 61 -> applyModifier(512, 61) = 31. AI blend: crit is
    // applyModifier(512, 92) = 46, then idiv(46 + 31*23, 24) = idiv(759, 24) = 31.
    expect(playerDamage(doubles(ability('ABILITY_FRIEND_GUARD')), TACKLE)).toBe(31)
    expect(aiDamage(doubles(ability('ABILITY_FRIEND_GUARD')), TACKLE)).toBe(31)
    // Negative: partner fainted -> no reducer; AI blend is 62 (player 61).
    expect(aiDamage(doubles(ability('ABILITY_FRIEND_GUARD'), 0), TACKLE)).toBe(62)
    expect(aiDamage(doubles(ability('ABILITY_FRIEND_GUARD'), 0), TACKLE)).not.toBe(31)
  })

  it('Mold Breaker suppresses Friend Guard on the AI path too: 62, not 31', () => {
    const state = doubles(ability('ABILITY_FRIEND_GUARD'))
    state.battlers[0]!.mon.abilities = ability('ABILITY_MOLD_BREAKER')
    expect(aiDamage(state, TACKLE)).toBe(62)
    expect(playerDamage(state, TACKLE)).toBe(61)
  })
})
