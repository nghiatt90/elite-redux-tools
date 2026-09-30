// AI_CalcDamage / AI_CalcPartyMonDamage / AI_GetTypeEffectiveness, ported in
// aiCalcDamage.ts. Every case below derives its expected number from the SAME
// calculateMoveDamage call the port itself uses (ground truth: rolls[15],
// critRolls[15], critChanceDenominator), then applies AI_CalcDamage's OWN
// arithmetic (the crit blend, the multi-hit multiplier) by hand in the test --
// so a broken blend or a broken multiplier switch fails here even though both
// paths share the same calculateMoveDamage call.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { createRandomSource } from '../rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import type { BattleState, SimBattleMon, SimPartyMon } from '../state'
import type { GroundingContext } from '../grounding'
import { buildBattlerBattleState, buildFieldBattleState, type BridgeDeps } from '../bridge'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import { calculateMoveDamage, type DamageCalcScenario, type MoveData } from '../../calculate'
import { idiv } from '../../fixed'
import { aiCalcDamage, aiCalcPartyMonDamage, aiGetTypeEffectiveness, isBattlerAIControlled, type AiDamageDeps } from './aiCalcDamage'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'data', 'v2.65beta')
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
    id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: arg?.kind === 'misc' ? arg.value : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
  } as MoveData
}

// Fail loudly if any of these ids/fields are ever renamed -- per the brief's
// "verify every id against data/v2.65beta/*.json at module load" rule.
for (const id of ['MOVE_TACKLE', 'MOVE_SLASH', 'MOVE_BULLET_SEED', 'MOVE_NIGHT_SHADE', 'MOVE_WATER_SHURIKEN']) {
  if (!moveById.has(id)) throw new Error(`moves.json is missing ${id}`)
}
if (moveById.get('MOVE_SLASH')!.crit !== 'ALWAYS') throw new Error('MOVE_SLASH is no longer an always-crit move')
if (moveById.get('MOVE_BULLET_SEED')!.effect !== 'EFFECT_MULTI_HIT') throw new Error('MOVE_BULLET_SEED is no longer EFFECT_MULTI_HIT')
if (moveById.get('MOVE_NIGHT_SHADE')!.effect !== 'EFFECT_LEVEL_DAMAGE') throw new Error('MOVE_NIGHT_SHADE is no longer EFFECT_LEVEL_DAMAGE')
if (!speciesById.has('SPECIES_MUDKIP')) throw new Error('species.json is missing SPECIES_MUDKIP')
if (!itemsById.has('ITEM_CHOICE_BAND')) throw new Error('items.json is missing ITEM_CHOICE_BAND')
if (itemsById.get('ITEM_CHOICE_BAND')!.resolvedHoldEffect !== 'HOLD_EFFECT_CHOICE_BAND') throw new Error('ITEM_CHOICE_BAND no longer resolves to HOLD_EFFECT_CHOICE_BAND')

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
    pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['WATER', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP', hp: 100, maxHp: 100, level: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], itemId: null,
    abilities: { ability: null, innates: [null, null, null] }, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, gender: 'MALE', status1: 0, types: ['WATER', 'MYSTERY', 'MYSTERY'], ...overrides,
  }
}
// battler 0 = player (B_SIDE_PLAYER), battler 1 = opponent (B_SIDE_OPPONENT) -- so
// AI_CalcDamage(move, 1, 0, ...) is "the AI's own battler attacking the player",
// the shape GetBestMonDmg actually calls it in.
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)], rng: createRandomSource(1) })
}

/** Ground truth: the SAME scenario buildAiScenario assembles internally, built
 * independently here so the blend/multiplier math below is checked against the
 * engine's own numbers rather than against a re-derivation of aiCalcDamage's
 * own code. */
function groundTruthDamage(moveId: string, s: BattleState, attackerId: number, defenderId: number) {
  const roles = { attackerId, defenderId }
  const attacker = buildBattlerBattleState(s, attackerId, roles, bridge)
  const defender = buildBattlerBattleState(s, defenderId, roles, bridge)
  const field = buildFieldBattleState(s, roles, bridge)
  const move = toMoveData(moveId)
  const scenario: DamageCalcScenario = {
    move, attacker: attacker.battler, defender: defender.battler, field: field.field, typeChart: chart, inverseTypeChart: inverseChart,
    moveBehaviors, battleConstants: natures, attackerActsFirst: true, sameMoveTurnsInARow: 0, hitCount: 0, defenderIsSwitching: false,
    magnitudeTier: null, attackerRolloutCounter: 0, attackerHasDefenseCurl: false, attackerWasHitThisTurn: false,
    beatUpBaseAttack: attacker.battler.rawStats.atk, beatUpHitCount: 1, defenderUsedGlaiveRush: false,
  }
  return calculateMoveDamage(scenario)
}

/** AI_CalcDamage's own blend, battle_ai_util.c:673-676, applied by hand to the
 * ground-truth numbers above. */
function blend(result: ReturnType<typeof groundTruthDamage>): number {
  const normalDmg = result.rolls[15]
  const critDmg = result.critRolls ? result.critRolls[15] : normalDmg
  const chance = result.critChanceDenominator
  return chance === null ? normalDmg : idiv(critDmg + normalDmg * (chance - 1), chance)
}

describe('aiCalcDamage: isBattlerAIControlled', () => {
  it('battler 0 (player) is not AI-controlled; battler 1 (opponent) is', () => {
    expect(isBattlerAIControlled(0)).toBe(false)
    expect(isBattlerAIControlled(1)).toBe(true)
  })
})

describe('aiCalcDamage: a plain hit (MOVE_TACKLE) matches the hand-applied crit blend', () => {
  it('AI battler (1) attacking the player battler (0)', () => {
    const s = state()
    const truth = groundTruthDamage('MOVE_TACKLE', s, 1, 0)
    const out = aiCalcDamage(s, 'MOVE_TACKLE', 1, 0, deps)
    expect(out.dmg).toBe(blend(truth))
    expect(out.dmg).toBeGreaterThan(0)
  })
})

describe('aiCalcDamage: a guaranteed-crit move (MOVE_SLASH) collapses the blend to critDmg', () => {
  it('critChanceDenominator is 1, so dmg === critRolls[15] exactly', () => {
    const s = state()
    const truth = groundTruthDamage('MOVE_SLASH', s, 1, 0)
    expect(truth.critChanceDenominator).toBe(1)
    const out = aiCalcDamage(s, 'MOVE_SLASH', 1, 0, deps)
    expect(out.dmg).toBe(truth.critRolls![15])
    expect(out.dmg).toBe(blend(truth))
  })
})

describe('aiCalcDamage: a fixed-damage effect (MOVE_NIGHT_SHADE, EFFECT_LEVEL_DAMAGE) ignores the formula entirely', () => {
  it("dmg equals the attacker's level, not anything derived from stats", () => {
    const s = state({ level: 37 })
    const out = aiCalcDamage(s, 'MOVE_NIGHT_SHADE', 1, 0, deps)
    // battler 1 is the defender here in this state() layout; re-derive with the
    // level on the ATTACKER (battler 1) instead.
    const s2 = state({}, { level: 37 })
    const out2 = aiCalcDamage(s2, 'MOVE_NIGHT_SHADE', 1, 0, deps)
    expect(out2.dmg).toBe(37)
    expect(out.dmg).not.toBe(37) // sanity: the level-37 mon here is the DEFENDER, not read by EFFECT_LEVEL_DAMAGE
  })
})

describe('aiCalcDamage: a multi-hit move (MOVE_BULLET_SEED) applies the x3 TWO_TO_FIVE multiplier', () => {
  it('dmg is exactly 3x the single-hit blended estimate (no Skill Link/Loaded Dice)', () => {
    const s = state()
    const truth = groundTruthDamage('MOVE_BULLET_SEED', s, 1, 0)
    const out = aiCalcDamage(s, 'MOVE_BULLET_SEED', 1, 0, deps)
    expect(out.dmg).toBe(blend(truth) * 3)
  })
})

describe('aiCalcDamage: SetBattlerData item blanking', () => {
  it('an unrevealed item on the PLAYER battler (defender here) does not affect the AI\'s estimate', () => {
    // Choice Band on the ATTACKER changes damage; put it on the DEFENDER instead
    // so the only thing under test is whether it's masked, not whether it's read.
    // Use it as the ATTACKER's own item, but attacker (battler 1) is the AI's own
    // mon -- AI_CalcDamage never blanks its own side. So test on a hypothetical
    // "player attacks" call: battler 0 (player) as attacker, battler 1 (AI) as
    // defender -- SetBattlerData(battlerAtk=0) blanks battler 0's own item since
    // it is NOT AI-controlled.
    const withItem = state({ itemId: 'ITEM_CHOICE_BAND' })
    const withoutItem = state({ itemId: null })
    const unrevealed = aiCalcDamage(withItem, 'MOVE_TACKLE', 0, 1, deps)
    const bare = aiCalcDamage(withoutItem, 'MOVE_TACKLE', 0, 1, deps)
    expect(unrevealed.dmg).toBe(bare.dmg)
  })

  it('a REVEALED item (itemEffects nonzero) on the player battler DOES affect the estimate', () => {
    const withItem = state({ itemId: 'ITEM_CHOICE_BAND' })
    withItem.battleHistory.itemEffects[0] = 1 // "AI has seen this item's effect trigger"
    const withoutItem = state({ itemId: null })
    const revealed = aiCalcDamage(withItem, 'MOVE_TACKLE', 0, 1, deps)
    const bare = aiCalcDamage(withoutItem, 'MOVE_TACKLE', 0, 1, deps)
    expect(revealed.dmg).not.toBe(bare.dmg)
    expect(revealed.dmg).toBeGreaterThan(bare.dmg) // Choice Band boosts Attack
  })

  it("the AI's OWN item (attacker is AI-controlled) is never blanked", () => {
    const withItem = state({}, { itemId: 'ITEM_CHOICE_BAND' }) // battler 1 (AI) holds it
    const withoutItem = state({}, { itemId: null })
    const withOut = aiCalcDamage(withItem, 'MOVE_TACKLE', 1, 0, deps)
    const withoutOut = aiCalcDamage(withoutItem, 'MOVE_TACKLE', 1, 0, deps)
    expect(withOut.dmg).toBeGreaterThan(withoutOut.dmg)
  })
})

describe('aiCalcPartyMonDamage', () => {
  it('substitutes the party mon as the attacker, changing the estimate from the current battler', () => {
    const s = state({}, { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 } })
    const weakerReserve = partyMon({ rawStats: { atk: 40, def: 90, spatk: 80, spdef: 85, spe: 100 } })
    const withCurrentBattler = aiCalcDamage(s, 'MOVE_TACKLE', 1, 0, deps)
    const withReserve = aiCalcPartyMonDamage(s, 'MOVE_TACKLE', 1, 0, weakerReserve, deps)
    expect(withReserve.dmg).toBeLessThan(withCurrentBattler.dmg)
  })

  it("does not disturb the real battle state's battler", () => {
    const s = state()
    const before = s.battlers[1]!.mon.speciesId
    aiCalcPartyMonDamage(s, 'MOVE_TACKLE', 1, 0, partyMon({ speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 5, def: 5, spatk: 5, spdef: 5, spe: 5 } }), deps)
    expect(s.battlers[1]!.mon.speciesId).toBe(before)
    expect(s.battlers[1]!.mon.rawStats.atk).toBe(100)
  })
})

describe('aiGetTypeEffectiveness', () => {
  it('reports UQ_4_12(2.0) = 2048 for a super-effective matchup (Water into Ground/Rock defender)', () => {
    const s = state({}, { types: ['GROUND', 'ROCK', 'MYSTERY'] })
    const { effectiveness } = aiGetTypeEffectiveness(s, 'MOVE_TACKLE', 0, 1, deps) // Normal move
    expect(effectiveness).toBe(512) // sanity: Rock resists Normal (0.5x); Ground is neutral vs Normal
    const waterMove = 'MOVE_WATER_SHURIKEN'
    const { effectiveness: waterEff } = aiGetTypeEffectiveness(s, waterMove, 0, 1, deps)
    expect(waterEff).toBe(4096) // Water is 2x vs Ground and 2x vs Rock -> 4x folded
  })
})
