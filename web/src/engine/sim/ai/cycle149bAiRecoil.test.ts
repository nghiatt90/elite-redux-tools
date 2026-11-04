// Cycle 149b: the AI's GetRecoilFraction reads the move's customBehavior, exactly as
// the game's codegen writes it into gBattleMoves[].effect.
//
// BattleMovesGenerator.kt:44 emits `effect = CUSTOM_BEHAVIORS[move.customBehavior]`
// when the move has a custom behavior, and MoveRecoilGenerator.kt:10-20 builds
// GetRecoilFraction from MOVE_BEHAVIORS[effect].attack.recoilFraction. Flare Blitz and
// Volt Tackle both carry an inline customBehavior with a recoilFraction and a null
// declared effect, so an effect-only lookup reads them as recoil-free.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { createRandomSource } from '../rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from '../state'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import { type AiDamageDeps } from './aiCalcDamage'
import { aiCheckBadMove } from './aiCheckBadMove'
import { getMoveDamageResult, getRecoilFraction, MOVE_POWER_BEST, MOVE_POWER_WEAK } from './aiScorers'

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

// MoveData.customBehavior is `unknown` on calculate.ts's interface; the snapshot holds
// the MoveBehaviorEntry shape the sim's getRecoilFraction takes. toMoveData copies it
// through unchanged, matching aiCheckBadMove.test.ts's own fixture.
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
    pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['WATER', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)], rng })
}
function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}
function partyMon(overrides: Partial<SimBattleMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP', hp: 100, maxHp: 100, level: 50, moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0], itemId: null, abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, nature: 'NATURE_HARDY', hiddenPowerType: null, speedDown: false,
    gender: 'MALE', status1: 0, types: ['NORMAL', 'MYSTERY', 'MYSTERY'], ...overrides,
  }
}
/** Same as `state`, plus one live reserve on the defender's side, so
 * `countUsablePartyMons(state, 1)` is 1 -- ShouldUseRecoilMove's first gate. */
function stateWithDefenderParty(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)],
    rng,
    opponentParty: [partyMon({ hp: 100 }), partyMon({ hp: 100 })],
  })
}
function check(s: BattleState, moveId: string, score = 100) {
  return aiCheckBadMove(s, 0, 1, moveId, score, deps)
}

// `customBehavior` is `unknown` in MoveData but a plain JSON object here.
const flareBlitzCustom = moveById.get('MOVE_FLARE_BLITZ')!.customBehavior
const voltTackleCustom = moveById.get('MOVE_VOLT_TACKLE')!.customBehavior
if (!flareBlitzCustom || !voltTackleCustom) throw new Error('Flare Blitz/Volt Tackle lost their customBehavior')

describe('cycle 149b - the AI recoil lookup takes customBehavior first', () => {
  it('Flare Blitz and Volt Tackle report their custom recoil fractions; Tackle has none', () => {
    // MoveList.textproto: Flare Blitz custom_behavior.attack.recoil_fraction = 3 ("33% recoil"),
    // Volt Tackle = 4 ("25% recoil"). The declared `effect` on both is null.
    expect(flareBlitzCustom.attack.recoilFraction).toBe(3)
    expect(voltTackleCustom.attack.recoilFraction).toBe(4)
    expect(getRecoilFraction('EFFECT_HIT', moveBehaviors, flareBlitzCustom)).toBe(3)
    expect(getRecoilFraction('EFFECT_HIT', moveBehaviors, voltTackleCustom)).toBe(4)
    // Negative control: a null effect with no custom behavior is not a recoil move.
    expect(getRecoilFraction(null, moveBehaviors, undefined)).toBe(0)
    // A declared recoil effect still resolves through moveBehaviors when there is no custom behavior.
    expect(getRecoilFraction('EFFECT_RECOIL_33', moveBehaviors, null)).toBe(3)
  })

  it('WhichMoveBetter (through getMoveDamageResult) disfavours Flare Blitz over an equal-damage non-recoil move, unless the attacker has Rock Head', () => {
    // battle_ai_util.c:776-783: `if (GetRecoilFraction(gBattleMoves[move1].effect) &&
    // (!GetRecoilFraction(gBattleMoves[move2].effect) && gBattleMoves[move2].effect != EFFECT_RECHARGE)) return 1;`
    // gBattleMoves[Flare Blitz].effect is its custom behavior, so GetRecoilFraction != 0.
    // The defender is at 5 HP (ceiling = 5 + 20% of 5 = 5), so both moves cap to equal
    // damage and WhichMoveBetter is reached. rng 1 makes the C's `Random() & 1` tie-break
    // (`:827`) keep slot 0 when WhichMoveBetter returns "no preference" (2).
    const moves = { moves: ['MOVE_FLARE_BLITZ', 'MOVE_TACKLE', null, null] as SimBattleMon['moves'], pp: [10, 35, 0, 0] as SimBattleMon['pp'] }

    const plain = state(moves, { hp: 5, maxHp: 100 }, scripted(1))
    expect(getMoveDamageResult(plain, 0, 1, 'MOVE_FLARE_BLITZ', 0, deps).result).toBe(MOVE_POWER_WEAK)

    // Rock Head (battle_ai_util.c:775: `!BattlerHasAbility(sBattler_AI, ABILITY_ROCK_HEAD, FALSE)`)
    // skips the recoil comparison entirely, so WhichMoveBetter returns 2 and slot 0 wins the tie.
    const rockHead = state(
      { ...moves, abilities: { ability: 'ABILITY_ROCK_HEAD', innates: [null, null, null] } },
      { hp: 5, maxHp: 100 },
      scripted(1),
    )
    expect(getMoveDamageResult(rockHead, 0, 1, 'MOVE_FLARE_BLITZ', 0, deps).result).toBe(MOVE_POWER_BEST)
  })

  it('the check-bad-move recoil tail penalises Flare Blitz by -10 (battle_ai_main.c:2151-2156) and Magic Guard suppresses it', () => {
    // hp=1 guarantees max(1, damage/3) >= 1 >= attacker HP; the target is at full 100 HP,
    // so ShouldUseRecoilMove (battle_ai_util.c:2199-2205) takes the "will faint and not win"
    // FALSE branch and AI_CheckBadMove subtracts 10.
    const moves = { moves: ['MOVE_FLARE_BLITZ', null, null, null] as SimBattleMon['moves'], pp: [10, 0, 0, 0] as SimBattleMon['pp'] }
    expect(check(stateWithDefenderParty({ ...moves, hp: 1, maxHp: 300 }), 'MOVE_FLARE_BLITZ').score).toBe(90)

    // IsMagicGuardProtected(battlerAtk) (:2153) short-circuits before ShouldUseRecoilMove.
    const magicGuard = stateWithDefenderParty(
      { ...moves, hp: 1, maxHp: 300, abilities: { ability: 'ABILITY_MAGIC_GUARD', innates: [null, null, null] } },
      {},
    )
    expect(check(magicGuard, 'MOVE_FLARE_BLITZ').score).toBe(100)
  })
})
