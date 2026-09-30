// IsSuppressed (battle_util.c:9254-9261) as the AI's ability helpers see it:
// Gastro Acid / Neutralizing Gas suppress every non-unsuppressable ability, the
// Ability Shield exempts both that branch and the Mold Breaker branch, and
// Embargo cancels the shield. Every id below is checked against
// data/v2.65beta/*.json at module load.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { createRandomSource } from '../rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import { STATUS3_EMBARGO, STATUS3_GASTRO_ACID } from '../constants'
import type { BattleState, SimBattleMon } from '../state'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import type { AiDamageDeps } from './aiCalcDamage'
import { aiCheckBadMove } from './aiCheckBadMove'
import { isSuppressed, UNSUPPRESSABLE_ABILITIES } from './aiAbilityHelpers'
import { aiCheckViability } from './aiCheckViability'

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
const hooks = read<Record<string, { bitfields?: Record<string, unknown> }>>('abilityHooks.json')

const VOLT_ABSORB = 'ABILITY_VOLT_ABSORB'
const CONTRARY = 'ABILITY_CONTRARY'
const CLUELESS = 'ABILITY_CLUELESS'
const SERENE_GRACE = 'ABILITY_SERENE_GRACE'
const STRONG_FOUNDATION = 'ABILITY_STRONG_FOUNDATION'
const SUCTION_CUPS = 'ABILITY_SUCTION_CUPS'

// Fail loudly if the snapshot ever renames or reclassifies any of these.
for (const id of [VOLT_ABSORB, CONTRARY, CLUELESS, SERENE_GRACE, STRONG_FOUNDATION, SUCTION_CUPS]) {
  if (!hooks[id]) throw new Error(`abilityHooks.json is missing ${id}`)
}
const isBreakable = (id: string) => !!hooks[id]?.bitfields?.breakable
const isUnsuppressable = (id: string) => !!hooks[id]?.bitfields?.unsuppressable
if (!isBreakable(VOLT_ABSORB) || !isBreakable(CONTRARY) || !isBreakable(SUCTION_CUPS)) throw new Error('Volt Absorb / Contrary / Suction Cups are no longer breakable')
if (isBreakable(STRONG_FOUNDATION)) throw new Error('Strong Foundation became breakable')
for (const id of [VOLT_ABSORB, CONTRARY, SERENE_GRACE, STRONG_FOUNDATION, SUCTION_CUPS]) {
  if (isUnsuppressable(id)) throw new Error(`${id} became unsuppressable`)
}
if (!isUnsuppressable(CLUELESS)) throw new Error('Clueless is no longer unsuppressable')
for (const [id, effect] of [['MOVE_THUNDERBOLT', undefined], ['MOVE_BELLY_DRUM', 'EFFECT_BELLY_DRUM'], ['MOVE_TRICK_ROOM', 'EFFECT_TRICK_ROOM'], ['MOVE_TACKLE', undefined], ['MOVE_ROAR', 'EFFECT_ROAR']] as const) {
  const m = moveById.get(id)
  if (!m) throw new Error(`moves.json is missing ${id}`)
  if (effect && m.effect !== effect) throw new Error(`${id} is no longer ${effect}`)
}
if (itemsById.get('ITEM_ABILITY_SHIELD')?.resolvedHoldEffect !== 'HOLD_EFFECT_ABILITY_SHIELD') throw new Error('ITEM_ABILITY_SHIELD no longer resolves to HOLD_EFFECT_ABILITY_SHIELD')
if (moveById.get('MOVE_THUNDERBOLT')?.type !== 'TYPE_ELECTRIC') throw new Error('Thunderbolt is no longer Electric')

function toMoveData(id: string): MoveData {
  const move = moveById.get(id)
  if (!move) throw new Error(`snapshot is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: move.type ? String(move.type).replace('TYPE_', '') : null, type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, hitsAir: move.hitsAir === 'DOESNT_HIT_AIR' ? undefined : move.hitsAir, flags: move.flags ?? {}, priority: move.priority,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? (arg.value as string) : null,
    miscEffect: arg?.kind === 'misc' ? (arg.value as string) : null, multiHitArgument: arg?.kind === 'int' ? (arg.value as number) : null,
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
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)], rng: createRandomSource(1) })
}
/** A live reserve mon on the defender's side, so EFFECT_ROAR reaches its ability check. */
function stateWithDefenderParty(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}): BattleState {
  const reserve = { ...mon(), abilities: { ability: null, innates: [null, null, null] as [null, null, null] } }
  return createBattleState({
    battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)],
    rng: createRandomSource(1),
    opponentParty: [reserve, reserve] as any,
  })
}
const ability = (id: string): SimBattleMon['abilities'] => ({ ability: id, innates: [null, null, null] })
const ATK = 0
const DEF = 1
const gastroAcid = (s: BattleState, battler: number) => void (s.battlers[battler]!.statuses3 |= STATUS3_GASTRO_ACID)
const embargo = (s: BattleState, battler: number) => void (s.battlers[battler]!.statuses3 |= STATUS3_EMBARGO)
const neutralizingGas = (s: BattleState) => void (s.field.timers.neutralizingGas = true)
const suppressed = (s: BattleState, battler: number, id: string, checkMoldBreaker: boolean, moldBreaker: boolean) =>
  isSuppressed(s, s.battlers[battler]!, id, checkMoldBreaker, moldBreaker, deps)
const mbDeps: AiDamageDeps = { ...deps, grounding: { ...grounding, attackerHasMoldBreaker: true } }
const bad = (s: BattleState, moveId: string, d: AiDamageDeps = deps) => aiCheckBadMove(s, ATK, DEF, moveId, 100, d).score
const viability = (s: BattleState, moveId: string, d: AiDamageDeps = deps) => aiCheckViability(s, ATK, DEF, moveId, 100, d, 0).score
const SLOW = { rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 10 } }
const statDownHit = rawMoves.find((m) => m.effect === 'EFFECT_SPECIAL_ATTACK_DOWN_HIT' && m.power > 0)?.id as string
if (!statDownHit) throw new Error('no EFFECT_SPECIAL_ATTACK_DOWN_HIT move in the snapshot')

describe('UNSUPPRESSABLE_ABILITIES', () => {
  it('matches every abilityHooks.json ability whose bitfields.unsuppressable is set (32 on this snapshot)', () => {
    const expected = Object.entries(hooks)
      .filter(([, h]) => !!h.bitfields?.unsuppressable)
      .map(([id]) => id)
      .sort()
    expect(expected).toHaveLength(32)
    expect([...UNSUPPRESSABLE_ABILITIES].sort()).toEqual(expected)
  })
})

describe('isSuppressed -- battle_util.c:9254-9261', () => {
  it('is false with no Mold Breaker, no Gastro Acid and no Neutralizing Gas', () => {
    expect(suppressed(state(), DEF, VOLT_ABSORB, true, false)).toBe(false)
  })

  it('Mold Breaker branch: suppresses a breakable ability only when checkMoldBreaker is TRUE', () => {
    const s = state()
    expect(suppressed(s, DEF, VOLT_ABSORB, true, true)).toBe(true)
    expect(suppressed(s, DEF, VOLT_ABSORB, false, true)).toBe(false)
  })

  it('Mold Breaker branch: does not suppress an ability that is not breakable', () => {
    expect(suppressed(state(), DEF, STRONG_FOUNDATION, true, true)).toBe(false)
  })

  it('Gastro Acid branch: suppresses that battler only, for either checkMoldBreaker value, with no Mold Breaker involved', () => {
    const s = state()
    gastroAcid(s, DEF)
    expect(suppressed(s, DEF, VOLT_ABSORB, true, false)).toBe(true)
    expect(suppressed(s, DEF, VOLT_ABSORB, false, false)).toBe(true)
    expect(suppressed(s, DEF, STRONG_FOUNDATION, false, false)).toBe(true)
    expect(suppressed(s, ATK, VOLT_ABSORB, false, false)).toBe(false)
  })

  it('Neutralizing Gas branch: suppresses every battler on the field', () => {
    const s = state()
    neutralizingGas(s)
    expect(suppressed(s, ATK, CONTRARY, false, false)).toBe(true)
    expect(suppressed(s, DEF, VOLT_ABSORB, true, false)).toBe(true)
  })

  it('an unsuppressable ability survives both Gastro Acid and Neutralizing Gas', () => {
    const ga = state()
    gastroAcid(ga, DEF)
    expect(suppressed(ga, DEF, CLUELESS, false, false)).toBe(false)
    const ng = state()
    neutralizingGas(ng)
    expect(suppressed(ng, DEF, CLUELESS, false, false)).toBe(false)
    expect(suppressed(ng, DEF, VOLT_ABSORB, false, false)).toBe(true)
  })

  it('Ability Shield blocks the Gastro Acid, Neutralizing Gas and Mold Breaker branches', () => {
    const ga = state({}, { itemId: 'ITEM_ABILITY_SHIELD' })
    gastroAcid(ga, DEF)
    expect(suppressed(ga, DEF, VOLT_ABSORB, false, false)).toBe(false)
    const ng = state({}, { itemId: 'ITEM_ABILITY_SHIELD' })
    neutralizingGas(ng)
    expect(suppressed(ng, DEF, VOLT_ABSORB, false, false)).toBe(false)
    const mb = state({}, { itemId: 'ITEM_ABILITY_SHIELD' })
    expect(suppressed(mb, DEF, VOLT_ABSORB, true, true)).toBe(false)
  })

  it('Embargo cancels the Ability Shield, so suppression applies again', () => {
    const ga = state({}, { itemId: 'ITEM_ABILITY_SHIELD' })
    gastroAcid(ga, DEF)
    embargo(ga, DEF)
    expect(suppressed(ga, DEF, VOLT_ABSORB, false, false)).toBe(true)
    const mb = state({}, { itemId: 'ITEM_ABILITY_SHIELD' })
    embargo(mb, DEF)
    expect(suppressed(mb, DEF, VOLT_ABSORB, true, true)).toBe(true)
  })

  it('a different item does not shield', () => {
    const s = state({}, { itemId: 'ITEM_ORAN_BERRY' })
    gastroAcid(s, DEF)
    expect(suppressed(s, DEF, VOLT_ABSORB, false, false)).toBe(true)
  })
})

describe('AI scoring under Gastro Acid / Neutralizing Gas', () => {
  // Volt Absorb is also read by the damage engine's immunity path, which has no
  // Gastro Acid / Neutralizing Gas wiring (out of scope here), so these use
  // EFFECT_ROAR + Suction Cups, whose only reader is the AI helper under test.
  it('baseline: a Suction Cups defender makes the AI penalise Roar (-10), an abilityless one does not', () => {
    expect(bad(stateWithDefenderParty({}, { abilities: ability(SUCTION_CUPS) }), 'MOVE_ROAR')).toBe(90)
    expect(bad(stateWithDefenderParty({}, {}), 'MOVE_ROAR')).toBe(100)
  })

  it('a defender whose Suction Cups is suppressed by Neutralizing Gas is no longer penalised', () => {
    const s = stateWithDefenderParty({}, { abilities: ability(SUCTION_CUPS) })
    neutralizingGas(s)
    expect(bad(s, 'MOVE_ROAR')).toBe(100)
  })

  it('a defender whose Suction Cups is suppressed by Gastro Acid is no longer penalised', () => {
    const s = stateWithDefenderParty({}, { abilities: ability(SUCTION_CUPS) })
    gastroAcid(s, DEF)
    expect(bad(s, 'MOVE_ROAR')).toBe(100)
  })

  it('Gastro Acid on the ATTACKER does not suppress the defender', () => {
    const s = stateWithDefenderParty({}, { abilities: ability(SUCTION_CUPS) })
    gastroAcid(s, ATK)
    expect(bad(s, 'MOVE_ROAR')).toBe(90)
  })

  it('a defender holding an Ability Shield keeps Suction Cups under Neutralizing Gas and Gastro Acid', () => {
    const ng = stateWithDefenderParty({}, { abilities: ability(SUCTION_CUPS), itemId: 'ITEM_ABILITY_SHIELD' })
    neutralizingGas(ng)
    expect(bad(ng, 'MOVE_ROAR')).toBe(90)
    const ga = stateWithDefenderParty({}, { abilities: ability(SUCTION_CUPS), itemId: 'ITEM_ABILITY_SHIELD' })
    gastroAcid(ga, DEF)
    expect(bad(ga, 'MOVE_ROAR')).toBe(90)
  })

  it('Embargo on the shield holder lets Gastro Acid suppress Suction Cups again', () => {
    const s = stateWithDefenderParty({}, { abilities: ability(SUCTION_CUPS), itemId: 'ITEM_ABILITY_SHIELD' })
    gastroAcid(s, DEF)
    embargo(s, DEF)
    expect(bad(s, 'MOVE_ROAR')).toBe(100)
  })

  it('the AI battler own Contrary (a selfAbility read) stops counting under Gastro Acid and Neutralizing Gas', () => {
    expect(bad(state({ abilities: ability(CONTRARY) }, {}), 'MOVE_BELLY_DRUM')).toBe(90)
    const ga = state({ abilities: ability(CONTRARY) }, {})
    gastroAcid(ga, ATK)
    expect(bad(ga, 'MOVE_BELLY_DRUM')).toBe(100)
    const ng = state({ abilities: ability(CONTRARY) }, {})
    neutralizingGas(ng)
    expect(bad(ng, 'MOVE_BELLY_DRUM')).toBe(100)
  })

  it('the AI battler own Contrary keeps counting when it holds an Ability Shield', () => {
    const s = state({ abilities: ability(CONTRARY), itemId: 'ITEM_ABILITY_SHIELD' }, {})
    gastroAcid(s, ATK)
    expect(bad(s, 'MOVE_BELLY_DRUM')).toBe(90)
  })

  it('an unsuppressable ability (Clueless, an isAbilityOnField read) survives Gastro Acid and Neutralizing Gas', () => {
    const without = bad(state(SLOW, {}), 'MOVE_TRICK_ROOM')
    const withClueless = bad(state(SLOW, { abilities: ability(CLUELESS) }), 'MOVE_TRICK_ROOM')
    expect(withClueless).toBe(without - 10)
    const ga = state(SLOW, { abilities: ability(CLUELESS) })
    gastroAcid(ga, DEF)
    expect(bad(ga, 'MOVE_TRICK_ROOM')).toBe(withClueless)
    const ng = state(SLOW, { abilities: ability(CLUELESS) })
    neutralizingGas(ng)
    expect(bad(ng, 'MOVE_TRICK_ROOM')).toBe(withClueless)
  })

  it('a suppressible ability on the field (isAbilityOnField) stops counting under Neutralizing Gas', () => {
    // No Neutralizing Gas: Damp is on the field, so Explosion is penalised; with it, Damp is gone.
    const damp = 'ABILITY_DAMP'
    if (!hooks[damp] || isUnsuppressable(damp)) throw new Error('Damp is missing or unsuppressable')
    const withDamp = bad(state({}, { abilities: ability(damp) }), 'MOVE_EXPLOSION')
    const noDamp = bad(state({}, {}), 'MOVE_EXPLOSION')
    expect(withDamp).toBeLessThan(noDamp)
    const ng = state({}, { abilities: ability(damp) })
    neutralizingGas(ng)
    expect(bad(ng, 'MOVE_EXPLOSION')).toBe(noDamp)
  })
})

describe('AI_CheckViability under Gastro Acid', () => {
  it('the attacker own Serene Grace (a selfAbility read) stops counting under Gastro Acid', () => {
    const noGrace = viability(state({ abilities: ability(STRONG_FOUNDATION) }, {}), statDownHit)
    const withGrace = viability(state({ abilities: ability(SERENE_GRACE) }, {}), statDownHit)
    expect(withGrace).toBe(noGrace + 2)
    const ga = state({ abilities: ability(SERENE_GRACE) }, {})
    gastroAcid(ga, ATK)
    expect(viability(ga, statDownHit)).toBe(noGrace)
  })

  it('the defender own Contrary is read with checkMoldBreaker TRUE (defAbility): Mold Breaker, Gastro Acid and Neutralizing Gas all suppress it', () => {
    const grace = (): BattleState => state({ abilities: ability(SERENE_GRACE) }, { abilities: ability(CONTRARY) })
    const plain = viability(grace(), statDownHit)
    const mold = viability(grace(), statDownHit, mbDeps)
    expect(mold).toBe(plain + 2)
    const ga = grace()
    gastroAcid(ga, DEF)
    expect(viability(ga, statDownHit)).toBe(plain + 2)
    // Neutralizing Gas is field-wide, so the attacker's Serene Grace needs a shield to survive it.
    const ng = state({ abilities: ability(SERENE_GRACE), itemId: 'ITEM_ABILITY_SHIELD' }, { abilities: ability(CONTRARY) })
    neutralizingGas(ng)
    expect(viability(ng, statDownHit)).toBe(plain + 2)
    const bothShielded = state({ abilities: ability(SERENE_GRACE), itemId: 'ITEM_ABILITY_SHIELD' }, { abilities: ability(CONTRARY), itemId: 'ITEM_ABILITY_SHIELD' })
    neutralizingGas(bothShielded)
    expect(viability(bothShielded, statDownHit)).toBe(plain)
    const unshielded = grace()
    neutralizingGas(unshielded)
    expect(viability(unshielded, statDownHit)).toBe(plain)
  })
})
