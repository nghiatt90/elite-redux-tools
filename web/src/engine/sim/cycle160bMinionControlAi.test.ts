/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 160b: AI_CalcDamage's MINION_CONTROL count must not silently use attackerId.
//
// GetParentalBondCount's MINION_CONTROL branch (battle_script_commands.c:1026-1040) picks
// the party side and the excluded party slot from the GLOBAL gBattlerAttacker, not from
// its own `battler` argument. AI_CalcDamage calls it with battlerAtk (battle_ai_util.c:740)
// and nothing in battle_ai_main.c / battle_ai_util.c ever assigns gBattlerAttacker, so the
// scoring value is whatever the last non-AI path left there. The sim keeps no such field,
// so aiCalcDamage keeps using the scored attacker as the best estimate AND reports the
// approximation as unmodelled. The damage itself is still multiplied by the count.
//
// Expected numbers are hand-derived from the C in a comment.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { MoveData } from '../calculate'
import type { TypeChart } from '../typeEffectiveness'
import { applyModifier } from '../fixed'
import { getParentalBondMultiplier } from '../abilities/dispatchCalc'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiCalcDamage } from './ai/aiCalcDamage'

// ---------------------------------------------------------------------------
// Snapshot-backed fixtures, the shape cycle160EnragedEjectPackMinion.test.ts uses.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
/** natures.json is BattleConstants (natureStatTable, statStageRatios, criticalHitChance, ...). */
const battleConstants = snapshot<Record<string, unknown>>('natures.json') as never
const holdEffectIds = snapshot<Record<string, number>>('holdEffectIds.json')

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

/** The damage engine's own MoveData shape (calculate.ts), as damageResolver.test.ts builds it. */
function toMoveData(id: string): MoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  const arg = m.argument as Record<string, unknown> | undefined
  return {
    id,
    power: m.power as number,
    type: String(m.type).replace('TYPE_', ''),
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
  atk?: number
  spe?: number
  hp?: number
  maxHp?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status2?: number
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource,
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {},
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
    playerParty: opts.playerParty,
    opponentParty: opts.opponentParty,
    battleTypeFlags: opts.battleTypeFlags,
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

const aiDeps: AiDamageDeps = {
  grounding: GROUNDING,
  turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  inverseBattle: false,
  moveData: (id) => (movesById.has(id) ? toMoveData(id) : undefined),
  typeChart,
  inverseTypeChart,
  moveBehaviors,
  battleConstants,
  holdEffectIds,
}

const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const ability = (id: string, ...innates: (string | null)[]): SimBattleMon['abilities'] => ({
  ability: id,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})

function partyMon(speciesId: string | null, hp: number, status1 = 0): SimPartyMon {
  return {
    speciesId,
    hp,
    maxHp: 100,
    level: 50,
    moves: [null, null, null, null],
    pp: [0, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
  }
}

// MOVE_MEGA_PUNCH: NORMAL, PHYSICAL, eligible for Parental Bond-style bonus hits.
const MEGA_PUNCH = requireMove('MOVE_MEGA_PUNCH')

const MINION_CONTROL = ability('ABILITY_MINION_CONTROL')
/** Parental Bond resolves to the HYPER_AGGRESSIVE trigger (24-parental-bond.test.ts:111). */
const PARENTAL_BOND = ability('ABILITY_PARENTAL_BOND')

const healthy = (n: number): SimPartyMon[] => Array.from({ length: n }, () => partyMon('SPECIES_MUDKIP', 100))

/** Battler 0 is the attacker (player side), battler 1 the defender (opponent side). */
function minionBattle(attackerParty: SimPartyMon[], defenderParty: SimPartyMon[], attackerAbilities: SimBattleMon['abilities'] = MINION_CONTROL): BattleState {
  return battle(
    [{ abilities: attackerAbilities, atk: 200, moves: slot(MEGA_PUNCH.id), pp: pps, hp: 300, maxHp: 300 }, { hp: 300, maxHp: 300 }],
    scriptedRng([]),
    { playerParty: attackerParty, opponentParty: defenderParty },
  )
}

/** Sum of GetParentalBondMultiplier over `count` hits (battle_util.c:7483-7513). */
const minionMultiplier = (count: number): number =>
  Array.from({ length: count }, (_, i) => getParentalBondMultiplier('MINION_CONTROL', i)).reduce((sum, m) => sum + m, 0)

const hasAttackerNote = (notes: string[]): boolean => notes.some((u) => u.includes('MINION_CONTROL') && u.includes('gBattlerAttacker'))

describe('cycle 160b - MINION_CONTROL count in AI_CalcDamage (battle_script_commands.c:1026-1040)', () => {
  it('applies the count from the attacker party and reports the gBattlerAttacker caveat', () => {
    // Attacker side: 4 healthy party slots including the attacker's own (partyIndex 0), so the
    // scan's FILTER skips slot 0 and adds slots 1..3 -> count = 1 + 3 = 4. Multiplier is
    // 1.0x for turn 0 and 0.1x for each later hit (:7487), so [0,1,2,3] summed.
    const state = minionBattle(healthy(4), healthy(1))
    const res = aiCalcDamage(state, MEGA_PUNCH.id, 0, 1, aiDeps)
    const lone = aiCalcDamage(minionBattle(healthy(1), healthy(1)), MEGA_PUNCH.id, 0, 1, aiDeps)

    expect(res.dmg).toBe(applyModifier(minionMultiplier(1 + 3), lone.dmg))
    expect(res.dmg).toBeGreaterThan(lone.dmg)
    // Exactly one note, and it names both the trigger and the global it cannot prove.
    expect(res.unmodelled.filter((u) => u.includes('MINION_CONTROL') && u.includes('gBattlerAttacker'))).toHaveLength(1)
    expect(res.unmodelled.some((u) => /MINION_CONTROL.*gBattlerAttacker/.test(u))).toBe(true)
  })

  it('counts the ATTACKER party side only, regardless of the defender party size', () => {
    // The C's branch reads gBattleMons-side data from gBattlerAttacker (battle_script_commands.c:
    // 1026-1040); AI_CalcDamage's argument is battlerAtk (battle_ai_util.c:740). The estimate
    // therefore follows the attacker's own roster and must be unchanged when the defender's
    // side has more or fewer party members.
    const a4f1 = aiCalcDamage(minionBattle(healthy(4), healthy(1)), MEGA_PUNCH.id, 0, 1, aiDeps)
    const a4f4 = aiCalcDamage(minionBattle(healthy(4), healthy(4)), MEGA_PUNCH.id, 0, 1, aiDeps)
    const a1f1 = aiCalcDamage(minionBattle(healthy(1), healthy(1)), MEGA_PUNCH.id, 0, 1, aiDeps)
    const a1f4 = aiCalcDamage(minionBattle(healthy(1), healthy(4)), MEGA_PUNCH.id, 0, 1, aiDeps)

    // Same attacker party -> same damage, whatever the foe side holds.
    expect(a4f4.dmg).toBe(a4f1.dmg)
    expect(a1f4.dmg).toBe(a1f1.dmg)
    // Attacker party of 1 leaves only the 1.0x multiplier; 4 gives 1.0x + 3 x 0.1x.
    expect(a1f1.dmg).toBe(applyModifier(minionMultiplier(1), a1f1.dmg))
    expect(a4f1.dmg).toBe(applyModifier(minionMultiplier(4), a1f1.dmg))
    expect(a4f1.dmg).toBeGreaterThan(a1f1.dmg)

    for (const res of [a4f1, a4f4, a1f1, a1f4]) expect(hasAttackerNote(res.unmodelled)).toBe(true)
  })

  it('a Parental Bond attacker gets no gBattlerAttacker note (negative)', () => {
    // Parental Bond is HYPER_AGGRESSIVE, not MINION_CONTROL, so GetParentalBondCount's
    // gBattlerAttacker read is never reached. A 4-mon attacker party would otherwise make
    // the absent note obvious if the trigger were mistaken for MINION_CONTROL.
    const res = aiCalcDamage(minionBattle(healthy(4), healthy(1), PARENTAL_BOND), MEGA_PUNCH.id, 0, 1, aiDeps)
    expect(res.unmodelled.some((u) => u.includes('gBattlerAttacker'))).toBe(false)
  })

  it('a Minion-less attacker with no bonus-hit trigger gets no gBattlerAttacker note (negative)', () => {
    const noAbility = { ability: null, innates: [null, null, null] } as SimBattleMon['abilities']
    const res = aiCalcDamage(minionBattle(healthy(4), healthy(1), noAbility), MEGA_PUNCH.id, 0, 1, aiDeps)
    expect(res.unmodelled.some((u) => u.includes('gBattlerAttacker'))).toBe(false)
  })
})
