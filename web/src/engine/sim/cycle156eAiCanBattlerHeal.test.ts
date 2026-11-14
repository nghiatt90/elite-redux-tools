/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 156e: the AI layer's CanBattlerHeal port (aiCheckViability.ts) picks up
// the two opposing-side clauses it used to report as unmodelled:
//
//   CanBattlerHeal, battle_util.c:8979-8986:
//     if (gStatuses3[battler] & STATUS3_HEAL_BLOCK) return FALSE;            // :8980
//     if (gBattleMons[battler].status1 & STATUS1_BLEED) return FALSE;        // :8981
//     if (IsBloodStainAffected(battler)) return FALSE;                       // :8982
//     if (IsAbilityOnOpposingSide(battler, ABILITY_PERMANENCE)) return FALSE; // :8983
//     if (status1 & STATUS1_POISON_ANY
//         && IsAbilityOnOpposingSide(battler, ABILITY_HEMOLYSIS)) return FALSE; // :8984
//     return TRUE;
//
//   IsAbilityOnSide, battle_util.c:4792-4799: for every live battler on the
//   opposite side, BATTLER_HAS_ABILITY_AND_ALIVE(id, ability, TRUE). TRUE is
//   checkMoldBreaker, so the holder is read through IsSuppressed
//   (battle_util.c:9255-9260): Neutralizing Gas / Gastro Acid suppress it unless
//   the holder has an ability shield.
//
// Where the clause bites: ShouldRecover, battle_ai_util.c:2232-2245
//   damage = AI_DATA->simulatedDmg[atk][def][movesetIndex];
//   healAmount = (healPercent * damage) / 100;
//   if (!CanBattlerHeal(battlerAtk)) healAmount = 0;
//   if (CanTargetFaintAi(def, atk) && !CanTargetFaintAiWithMod(def, atk, healAmount, 0))
//       return TRUE;  // the heal is what saves the attacker
//   else if (!CanTargetFaintAi(def, atk) && hpPercents[atk] < 60 && (Random() % 3))
//       return TRUE;  // no faint either way; hp < 60 and 2/3 RNG
// The +3 is EFFECT_RESTORE_HP's own branch (aiCheckViability.ts:1998-2006).
//
// MOVE_RECOVER itself is 0 power / STATUS in data/v2.65beta/moves.json, so its
// simulatedDmg -- and therefore the healAmount the first branch tests -- is 0;
// the clause would be invisible through it. The scored move here is a synthetic
// 100-power special move wearing EFFECT_RESTORE_HP, so healAmount is nonzero
// and the first branch is live. aiCalcDamage is deterministic (no roll spread),
// and the FAST/SLOW stats make the attacker go first with no turn-order draw.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from './create'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import { STATUS1_POISON } from './constants'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from './dataContext'
import type { MoveData } from '../calculate'
import type { BridgeDeps } from './bridge'
import { type AiDamageDeps } from './ai/aiCalcDamage'
import { aiCheckViability as aiCheckViabilityAt } from './ai/aiCheckViability'

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
    id, power: move.power, type: move.type ? String(move.type).replace('TYPE_', '') : null, type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, hitsAir: move.hitsAir === 'DOESNT_HIT_AIR' ? undefined : move.hitsAir, flags: move.flags ?? {}, priority: move.priority,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? (arg.value as string) : null,
    miscEffect: arg?.kind === 'misc' ? (arg.value as string) : null,
    multiHitArgument: arg?.kind === 'int' ? (arg.value as number) : null,
    target: move.target,
  } as MoveData
}

const grounding: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const dataContext: SimDataContext = {
  species: (id) => speciesById.get(id) as SimSpeciesData | undefined,
  item: (id) => itemsById.get(id) as SimItemData | undefined,
  move: (id) => {
    const m = moveById.get(id)
    if (!m) return undefined
    const arg = m.argument as Record<string, unknown> | undefined
    return { id, power: m.power, type: m.type, split: m.split, effect: m.effect, priority: m.priority, flags: m.flags ?? {}, accuracy: m.accuracy, argumentInt: arg?.kind === 'int' ? (arg.value as number) : null }
  },
}
const bridge: BridgeDeps = { grounding, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext, inverseBattle: false }
const deps: AiDamageDeps = { ...bridge, moveData: (id) => (moveById.has(id) ? toMoveData(id) : undefined), typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: natures, holdEffectIds }

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['NORMAL', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)], rng })
}
/** Every draw is 250, so 250 % 3 = 1 != 0: ShouldRecover's 2/3 encouragement holds. */
const RNG_HIGH = 250
const draws = (value: number): RandomSource => ({ random16: () => value })
const FAST = { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 200 } }
const SLOW = { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 50 } }
const ability = (id: string) => ({ ability: id, innates: [null, null, null] as [string | null, string | null, string | null] })

/** The scored move: a 100-power special version of Tackle wearing `effect`. */
function depsWith(effect: string): AiDamageDeps {
  return { ...deps, moveData: (id) => (id === 'MOVE_SYNTHETIC' ? ({ ...toMoveData('MOVE_TACKLE'), id, effect, power: 100, split: 'SPECIAL' } as MoveData) : moveById.has(id) ? toMoveData(id) : undefined) }
}
/** EFFECT_RESTORE_HP's +3 against the same move wearing EFFECT_HIT. */
function delta(mk: () => BattleState): number {
  const real = aiCheckViabilityAt(mk(), 0, 1, 'MOVE_SYNTHETIC', 100, depsWith('EFFECT_RESTORE_HP'), 0).score
  const plain = aiCheckViabilityAt(mk(), 0, 1, 'MOVE_SYNTHETIC', 100, depsWith('EFFECT_HIT'), 0).score
  return real - plain
}
/** Attacker at 30/100: faster than the defender, and the defender's Tackle (~32)
 * can faint it, so ShouldRecover takes the heal-decides branch (`hpMod`). */
const mk = (a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, tweak: (s: BattleState) => void = () => {}) => () => {
  const s = state({ ...FAST, hp: 30, maxHp: 100, ...a }, { ...SLOW, ...d }, draws(RNG_HIGH))
  tweak(s)
  return s
}
const withPermanence = { abilities: ability('ABILITY_PERMANENCE') }
const withHemolysis = { abilities: ability('ABILITY_HEMOLYSIS') }

describe('CanBattlerHeal in AI_CheckViability (battle_util.c:8979-8986)', () => {
  it(':8983 baseline: no opposing Permanence, the 50% heal keeps the attacker alive, +3', () => {
    // simulatedDmg of the 100-power special synthetic move: ~64 (22*100*80/85/50+2, NORMAL STAB).
    // healAmount = floor(50 * 64 / 100) = 32. Defender Tackle ~32 >= 30 hp, but
    // 32 < 30 + 32, so CanTargetFaintAiWithMod is false and ShouldRecover is TRUE.
    expect(delta(mk())).toBe(3)
  })

  it(':8983 opposing Permanence: CanBattlerHeal is FALSE, healAmount drops to 0, +3 gone', () => {
    // With healAmount 0, CanTargetFaintAiWithMod(def, atk, 0, 0) is true (Tackle ~32 >= 30),
    // so ShouldRecover falls through to FALSE -- no second branch (target CAN faint).
    expect(delta(mk({}, withPermanence))).toBe(0)
  })

  it(':8984 opposing Hemolysis + poisoned attacker: healAmount 0, +3 gone', () => {
    expect(delta(mk({ status1: STATUS1_POISON }, withHemolysis))).toBe(0)
  })

  it(':8984 STATUS1_POISON_ANY gate: a healthy attacker ignores opposing Hemolysis, +3 stays', () => {
    expect(delta(mk({}, withHemolysis))).toBe(3)
  })

  it(':9255-9260 Neutralizing Gas suppresses the opposing Permanence, +3 stays', () => {
    expect(delta(mk({}, withPermanence, (s) => { s.field.timers.neutralizingGas = true }))).toBe(3)
  })

  it(':4792-4799 side check: Permanence on the attacker\'s OWN side does not block, +3', () => {
    expect(delta(mk({ abilities: ability('ABILITY_PERMANENCE') }))).toBe(3)
  })

  it(':4792-4799 alive check: a fainted opposing Permanence holder does not block, +3', () => {
    expect(delta(mk({}, { ...withPermanence, hp: 0 }))).toBe(3)
  })

  it('the old "IsAbilityOnOpposingSide has no port" note is no longer raised', () => {
    for (const mkState of [mk(), mk({}, withPermanence), mk({ status1: STATUS1_POISON }, withHemolysis)]) {
      const result = aiCheckViabilityAt(mkState(), 0, 1, 'MOVE_SYNTHETIC', 100, depsWith('EFFECT_RESTORE_HP'), 0)
      expect(result.unmodelled.filter((n) => n.includes('IsAbilityOnOpposingSide'))).toEqual([])
    }
  })
})
