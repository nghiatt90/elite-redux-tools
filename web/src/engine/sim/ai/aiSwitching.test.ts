// GetMostSuitableMonToSwitchInto and its own callers, ported in
// aiSwitching.ts. Every id/effect this file asserts on is verified against
// data/v2.65beta/*.json at module load (the brief's "verify every id" rule).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { createRandomSource } from '../rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from '../state'
import { PARTY_SIZE } from '../constants'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import type { ChosenAction, TurnOrderMoveView } from '../turnOrder'
import type { DamageResolver, TurnLoopDeps } from '../turn'
import { executeTurn } from '../turn'
import { aiGetTypeEffectiveness, type AiDamageDeps } from './aiCalcDamage'
import { createAiOpponentReplacement, getMostSuitableMonToSwitchInto } from './aiSwitching'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'data', 'v2.65beta')
const read = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = read<Array<Record<string, any>>>('moves.json')
const moveById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = read<Array<Record<string, any>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const rawItems = read<Array<Record<string, any>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const abilityIds = new Set(read<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const natures = read<any>('natures.json')
const moveBehaviors = read<any>('moveBehaviors.json').behaviors
const chart = read<Record<string, Record<string, number>>>('types.json')
const inverseChart = read<Record<string, Record<string, number>>>('typesInverse.json')

function norm(s: Record<string, any>): [string, string] {
  const t = (s.types as string[]).map((x) => x.replace('TYPE_', ''))
  return [t[0] ?? 'MYSTERY', t[1] ?? t[0] ?? 'MYSTERY']
}

function requireSpecies(id: string): string {
  if (!speciesById.has(id)) throw new Error(`species.json has no ${id}`)
  return id
}
function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}
function toMoveData(id: string): MoveData {
  const move = moveById.get(id)
  if (!move) throw new Error(`moves.json is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: arg?.kind === 'misc' ? arg.value : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
  } as MoveData
}

// --- verified fixture ids -------------------------------------------------
const CATERPIE = requireSpecies('SPECIES_CATERPIE') // pure Bug -- the wraparound test's defender
const LARVESTA = requireSpecies('SPECIES_LARVESTA') // Bug/Fire
const CHARIZARD = requireSpecies('SPECIES_CHARIZARD') // Fire/Flying
const MUDKIP = requireSpecies('SPECIES_MUDKIP')
const TRUANT = requireAbility('ABILITY_TRUANT')
if (norm(speciesById.get(CATERPIE)!).join('/') !== 'BUG/BUG') throw new Error('SPECIES_CATERPIE is no longer pure Bug')
if (norm(speciesById.get(LARVESTA)!).join('/') !== 'BUG/FIRE') throw new Error('SPECIES_LARVESTA is no longer Bug/Fire')
if (norm(speciesById.get(CHARIZARD)!).join('/') !== 'FIRE/FLYING') throw new Error('SPECIES_CHARIZARD is no longer Fire/Flying')
for (const id of ['MOVE_BATON_PASS', 'MOVE_TACKLE', 'MOVE_EMBER', 'MOVE_PROTECT', 'MOVE_FLY']) {
  if (!moveById.has(id)) throw new Error(`moves.json is missing ${id}`)
}
if (moveById.get('MOVE_PROTECT')!.effect !== 'EFFECT_PROTECT') throw new Error('MOVE_PROTECT is no longer EFFECT_PROTECT')
if (moveById.get('MOVE_FLY')!.effect !== 'EFFECT_SEMI_INVULNERABLE') throw new Error('MOVE_FLY is no longer EFFECT_SEMI_INVULNERABLE')
if (moveById.get('MOVE_EMBER')!.type !== 'TYPE_FIRE') throw new Error('MOVE_EMBER is no longer Fire-type')

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
const deps: AiDamageDeps = { ...bridge, moveData: (id) => (moveById.has(id) ? toMoveData(id) : undefined), typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: natures }

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: MUDKIP, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['WATER', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: MUDKIP, hp: 100, maxHp: 100, level: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], itemId: null,
    abilities: { ability: null, innates: [null, null, null] }, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, gender: 'MALE', status1: 0, types: ['WATER', 'MYSTERY', 'MYSTERY'], ...overrides,
  }
}
function battle(
  specs: { spe: number; hp?: number; abilities?: SimBattleMon['abilities']; types?: SimBattleMon['types']; moves?: SimBattleMon['moves'] }[],
  playerParty: SimPartyMon[],
  opponentParty: SimPartyMon[],
  rng: RandomSource = createRandomSource(1),
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe },
          hp: s.hp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          types: s.types ?? ['WATER', 'MYSTERY', 'MYSTERY'],
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
        }),
        0,
      ),
    ),
    rng,
    playerParty,
    opponentParty,
  })
}
function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

describe('getMostSuitableMonToSwitchInto: Baton Pass', () => {
  it('aliveCount === 2 skips the Random()%3 gate and goes straight to the rejection loop', () => {
    // Opponent party: slot 0 active (fainted), slots 1 and 2 alive -- aliveCount=2.
    // Only slot 2 has Baton Pass, so `bits` has exactly one bit (slot 2).
    const state = battle(
      [{ spe: 50, hp: 0 }, { spe: 200, hp: 100 }],
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 0 }), partyMon({ hp: 50, moves: ['MOVE_TACKLE', null, null, null] }), partyMon({ hp: 60, moves: ['MOVE_BATON_PASS', null, null, null] })],
      scripted(2), // rejection loop's single draw: 2 % 6 = 2, lands on slot 2 immediately.
    )
    const { partyIndex } = getMostSuitableMonToSwitchInto(state, 1, deps)
    expect(partyIndex).toBe(2)
  })

  it('aliveCount > 2: a Random()%3 !== 0 draw skips Baton Pass entirely, falling through', () => {
    const state = battle(
      [{ spe: 50, hp: 0 }, { spe: 200, hp: 100 }],
      [partyMon({ hp: 100 })],
      [
        partyMon({ hp: 0 }),
        partyMon({ hp: 40, moves: ['MOVE_BATON_PASS', null, null, null] }),
        partyMon({ hp: 40 }),
        partyMon({ hp: 40 }),
      ], // aliveCount = 3
      scripted(1), // Random()%3 = 1 !== 0 -- Baton Pass is skipped, no rejection-loop draw happens.
    )
    const { partyIndex } = getMostSuitableMonToSwitchInto(state, 1, deps)
    expect(partyIndex).not.toBe(1) // did NOT pick the Baton Pass mon via this step
  })

  it('aliveCount > 2: a Random()%3 === 0 draw enables Baton Pass, then the rejection loop draws until it lands on a Baton Pass slot', () => {
    const state = battle(
      [{ spe: 50, hp: 0 }, { spe: 200, hp: 100 }],
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 0 }), partyMon({ hp: 40 }), partyMon({ hp: 40 }), partyMon({ hp: 40, moves: ['MOVE_BATON_PASS', null, null, null] })],
      scripted(0, 5, 1, 3), // 0%3===0 enables it; rejection loop: 5(miss),1(miss),3(hit, bit 3 set)
    )
    const { partyIndex } = getMostSuitableMonToSwitchInto(state, 1, deps)
    expect(partyIndex).toBe(3)
  })
})

describe('getMostSuitableMonToSwitchInto: Offensive step, the u32 wraparound', () => {
  // Real species (verified above): CATERPIE is pure Bug. LARVESTA is Bug/Fire
  // (real multiplier vs pure Bug: BUG-vs-BUG=1.0, FIRE-vs-BUG=2.0 -> 2.0x,
  // UQ wrapped: 1024*1024*2048 = 2147483648, no overflow). CHARIZARD is
  // Fire/Flying (real multiplier vs pure Bug: FIRE-vs-BUG=2.0,
  // FLYING-vs-BUG=2.0 -> 4.0x, the TRUE better pick) but UQ wrapped:
  // 1024*2048*2048 = 4294967296 = exactly 2**32, wrapping to 0.
  it('a genuinely weaker offensive typing (Larvesta) wins over a genuinely stronger one (Charizard) because the stronger one wraps to 0', () => {
    // Battler 0 is the PLAYER's active mon -- this is the "opposingBattler" the
    // Offensive step reads FROM THE AI'S OWN PERSPECTIVE (aiBattlerId=1), so its
    // types (not anything in the AI's own party roster) are what CATERPIE's
    // Bug/Bug typing has to sit on.
    const state = battle(
      [{ spe: 200, hp: 100, types: ['BUG', 'BUG', 'MYSTERY'] }, { spe: 50, hp: 0 }],
      [partyMon({ hp: 100, speciesId: CATERPIE, types: ['BUG', 'BUG', 'MYSTERY'] })],
      [
        partyMon({ hp: 0 }), // the fainted active mon -- species irrelevant here
        partyMon({ hp: 40, speciesId: LARVESTA, types: ['BUG', 'FIRE', 'MYSTERY'], moves: ['MOVE_EMBER', null, null, null] }),
        partyMon({ hp: 40, speciesId: CHARIZARD, types: ['FIRE', 'FLYING', 'MYSTERY'], moves: ['MOVE_EMBER', null, null, null] }),
      ],
      scripted(), // Baton Pass finds nothing (bits=0), so no draw is even attempted.
    )
    // Sanity: unwrapped, Charizard really is the stronger offensive typing here.
    const larvestaEff = aiGetTypeEffectiveness(state, 'MOVE_EMBER', 1, 0, deps).effectiveness
    expect(larvestaEff).toBe(2048) // Fire is 2x vs pure Bug
    const { partyIndex } = getMostSuitableMonToSwitchInto(state, 1, deps)
    expect(partyIndex).toBe(1) // Larvesta (the WRAPAROUND-favoured, objectively weaker, pick)
  })
})

describe('getMostSuitableMonToSwitchInto: order of precedence', () => {
  it('Baton Pass beats Offensive', () => {
    const state = battle(
      [{ spe: 200, hp: 100 }, { spe: 50, hp: 0 }],
      [partyMon({ hp: 100 })],
      [
        partyMon({ hp: 0, speciesId: CATERPIE, types: ['BUG', 'BUG', 'MYSTERY'] }),
        partyMon({ hp: 40, speciesId: CHARIZARD, types: ['FIRE', 'FLYING', 'MYSTERY'], moves: ['MOVE_EMBER', null, null, null] }), // strong offensive pick
        partyMon({ hp: 40, moves: ['MOVE_BATON_PASS', null, null, null] }), // aliveCount=2 -> Baton Pass fires unconditionally
      ],
      scripted(2),
    )
    const { partyIndex } = getMostSuitableMonToSwitchInto(state, 1, deps)
    expect(partyIndex).toBe(2) // the Baton Pass slot, not the offensive pick at slot 1
  })

  it('Offensive beats Dmg', () => {
    const state = battle(
      [{ spe: 200, hp: 100, types: ['BUG', 'BUG', 'MYSTERY'] }, { spe: 50, hp: 0 }],
      [partyMon({ hp: 100, speciesId: CATERPIE, types: ['BUG', 'BUG', 'MYSTERY'] })],
      [
        partyMon({ hp: 0 }),
        partyMon({ hp: 40, rawStats: { atk: 500, def: 90, spatk: 80, spdef: 85, spe: 100 } }), // huge raw damage, but neutral typing
        // LARVESTA (Bug/Fire), not Charizard: against a mono-Bug defender only 2
        // of the 4 possible multiplies fire (defType2===defType1), giving
        // 1024*1024*2048 = 2147483648 -- comfortably under 2**32, a REAL (not
        // wrapped-to-0) super-effective result, unlike the Charizard case this
        // file's own wraparound test relies on.
        partyMon({ hp: 40, speciesId: LARVESTA, types: ['BUG', 'FIRE', 'MYSTERY'], moves: ['MOVE_EMBER', null, null, null] }),
      ],
      scripted(),
    )
    const { partyIndex } = getMostSuitableMonToSwitchInto(state, 1, deps)
    expect(partyIndex).toBe(2) // the offensive typing pick, even though slot 1 would hit harder
  })

  it('Dmg beats the PARTY_SIZE fallback', () => {
    const state = battle(
      [{ spe: 200, hp: 100 }, { spe: 50, hp: 0 }],
      [partyMon({ hp: 100 })],
      [
        partyMon({ hp: 0 }),
        partyMon({ hp: 40, rawStats: { atk: 10, def: 90, spatk: 80, spdef: 85, spe: 100 } }), // weak
        partyMon({ hp: 40, rawStats: { atk: 300, def: 90, spatk: 80, spdef: 85, spe: 100 } }), // strong -- Dmg picks this one
      ],
      scripted(),
    )
    const { partyIndex } = getMostSuitableMonToSwitchInto(state, 1, deps)
    expect(partyIndex).toBe(2)
  })
})

describe('getMostSuitableMonToSwitchInto: the Truant exclusion', () => {
  it('a Truant reserve is excluded when the opponent can just Protect through the free turn', () => {
    // IsTruantMonVulnerable reads the OPPOSING BATTLER's own current moves
    // (battler 0's `mon.moves`, not the player's party roster) -- see
    // aiSwitching.ts's own doc.
    const state = battle(
      [{ spe: 200, hp: 100, moves: ['MOVE_PROTECT', null, null, null] }, { spe: 50, hp: 0 }],
      [partyMon({ hp: 100 })],
      [
        partyMon({ hp: 0 }),
        partyMon({ hp: 40, abilities: { ability: TRUANT, innates: [null, null, null] } }), // excluded
        partyMon({ hp: 40 }), // the only valid candidate left
      ],
      scripted(),
    )
    const { partyIndex } = getMostSuitableMonToSwitchInto(state, 1, deps)
    expect(partyIndex).toBe(2) // NOT the Truant slot (1), even though nothing else distinguishes them
  })

  it('a Truant reserve is NOT excluded when the opponent has no Protect/semi-invulnerable move', () => {
    const state = battle(
      [{ spe: 200, hp: 100 }, { spe: 50, hp: 0 }],
      [partyMon({ hp: 100, moves: ['MOVE_TACKLE', null, null, null] })],
      [partyMon({ hp: 0 }), partyMon({ hp: 40, abilities: { ability: TRUANT, innates: [null, null, null] } }), partyMon({ hp: 5 })],
      scripted(),
    )
    const { partyIndex } = getMostSuitableMonToSwitchInto(state, 1, deps)
    // Dmg step: both slot 1 (Truant, now eligible) and slot 2 are equal stats/moves,
    // but slot 2 has less HP -- doesn't matter for Dmg, which reads raw stats only.
    // Both would tie; whichever is reached is fine, the assertion is just that the
    // Truant slot is REACHABLE at all here (not permanently invalid).
    expect(partyIndex).not.toBe(PARTY_SIZE)
  })
})

describe('getMostSuitableMonToSwitchInto: the fallback when every step returns PARTY_SIZE', () => {
  it('returns PARTY_SIZE when there is no live, valid reserve at all', () => {
    const state = battle([{ spe: 200, hp: 100 }, { spe: 50, hp: 0 }], [partyMon({ hp: 100 })], [partyMon({ hp: 0 })], scripted())
    const { partyIndex } = getMostSuitableMonToSwitchInto(state, 1, deps)
    expect(partyIndex).toBe(PARTY_SIZE)
  })
})

describe('createAiOpponentReplacement: the caller-level fallback (OpponentHandleChoosePokemon)', () => {
  it('when GetMostSuitableMonToSwitchInto returns PARTY_SIZE, picks the first live non-active party slot', () => {
    const state = battle(
      [{ spe: 200, hp: 100 }, { spe: 50, hp: 0 }],
      [partyMon({ hp: 100 })],
      // Every candidate has identical neutral typing and identical stats (0 raw
      // stat difference => Dmg never picks a winner either -- GetBestMonDmg's
      // own `bestDmg < dmg` is a strict inequality, so a true tie never updates
      // bestMonId away from PARTY_SIZE), forcing the whole chain to PARTY_SIZE
      // and exercising the caller's own fallback loop.
      [partyMon({ hp: 0 }), partyMon({ hp: 0 }), partyMon({ hp: 30 }), partyMon({ hp: 30 })],
      scripted(),
    )
    const rep = createAiOpponentReplacement(deps)
    const gaps: string[] = []
    const chosen = rep.chooseReplacement(state, 1, gaps)
    expect(chosen).toBe(2) // slot 1 is dead (hp 0), slot 2 is the first live non-active slot
  })

  it('throws when asked to choose for a player (non-opponent) battler', () => {
    const state = battle([{ spe: 200, hp: 100 }, { spe: 50, hp: 0 }], [partyMon({ hp: 0 }), partyMon({ hp: 40 })], [partyMon({ hp: 100 })], scripted())
    const rep = createAiOpponentReplacement(deps)
    expect(() => rep.chooseReplacement(state, 0, [])).toThrow(/not on the opponent side/)
  })

  it("pushes the decision's own gap lines (e.g. a Choice-Band-style bridge gap) into the caller's unmodelled array", () => {
    // Any AI_CalcDamage/AI_GetTypeEffectiveness call made while REACHING this
    // decision reports bridge.ts's own BATCH1_GAPS (e.g. statStages) through
    // this path -- so a Dmg-step decision (which calls AI_CalcPartyMonDamage,
    // which calls AI_CalcDamage) always carries at least those gap lines.
    const state = battle(
      [{ spe: 200, hp: 100 }, { spe: 50, hp: 0 }],
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 0 }), partyMon({ hp: 40, rawStats: { atk: 10, def: 90, spatk: 80, spdef: 85, spe: 100 } }), partyMon({ hp: 40, rawStats: { atk: 300, def: 90, spatk: 80, spdef: 85, spe: 100 } })],
      scripted(),
    )
    const rep = createAiOpponentReplacement(deps)
    const gaps: string[] = []
    rep.chooseReplacement(state, 1, gaps)
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.some((g) => g.includes('statStages'))).toBe(true)
  })
})

describe('end-to-end: an opponent fainting mid-battle is replaced by the AI\'s own choice through executeTurn', () => {
  function moveView(overrides: Partial<TurnOrderMoveView> = {}): TurnOrderMoveView {
    return {
      id: 'MOVE_TACKLE', priority: 0, effect: null, isStatus: false, resolvedType: 'NORMAL', power: 40, flags: {}, split: 'PHYSICAL',
      hasStrongJawBoostFlag: false, isKeenEdge: false, naturalGiftPriority: 0, isGrassyTerrainAffected: false, myceliumMightAffected: false,
      ...overrides,
    }
  }
  function useMove(target: number, m: TurnOrderMoveView = moveView()): ChosenAction {
    return { action: 'USE_MOVE', moveToBeUsed: m, chosenMove: m, target }
  }
  function lethalToTarget(amount: number): DamageResolver {
    return { resolve: () => ({ targetDamage: amount, attackerDamage: null, unmodelled: [] }) }
  }

  it('the AI-controlled opponent battler is replaced by GetBestMonDmg\'s own pick (Baton Pass/Offensive both inapplicable here)', () => {
    const state = battle(
      [{ spe: 200, hp: 100 }, { spe: 50, hp: 5 }],
      [partyMon({ hp: 100 })],
      [partyMon({ hp: 5 }), partyMon({ hp: 10, rawStats: { atk: 10, def: 90, spatk: 80, spdef: 85, spe: 100 } }), partyMon({ hp: 60, rawStats: { atk: 300, def: 90, spatk: 80, spdef: 85, spe: 100 } })],
    )
    const replacement = createAiOpponentReplacement(deps)
    const turnDeps: TurnLoopDeps = { turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, grounding, damage: lethalToTarget(999), statStageRatios: natures.statStageRatios, dataContext, replacement }
    const out = executeTurn(state, [useMove(1), null], turnDeps)

    expect(out.outcome).toBe(null) // opponent still has a live reserve
    expect(state.battlers[1]!.partyIndex).toBe(2) // the higher-Attack reserve, via GetBestMonDmg
    expect(state.battlers[1]!.mon.hp).toBe(60)

    // The Dmg step's own AI_CalcPartyMonDamage calls report bridge.ts's own
    // gaps (e.g. statStages) -- and executeTurn's own replacementUnmodelled
    // is exactly the array createAiOpponentReplacement pushed them into, via
    // applyEndOfTurnReplacements' shared `unmodelled` parameter (switchIn.ts).
    // This is the fix for the reviewed gap: an AI-decision gap line now
    // reaches executeTurn's own output, not just the switch's own effects.
    expect(out.replacementUnmodelled.length).toBeGreaterThan(0)
    expect(out.replacementUnmodelled.some((g) => g.includes('statStages'))).toBe(true)
  })
})
