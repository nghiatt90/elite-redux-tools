/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ibcd3: per-family sweep of every C consumer of DoesMoveMatchFlag
// (src/abilities.cc:358-386). The rule being pinned here is the one the inventory
// already encodes: a flag predicate is not a port until its consumers read the
// predicate (which falls through to the user's onModifyMoveFlags slots) instead of
// the static moves.json bit. Each family below gets one forced scenario in which a
// move WITHOUT the static flag is turned into that flag by an innate grant, plus a
// control run without the granting ability.
//
// C at the pinned SHA:
// - DoesMoveMatchFlag (src/abilities.cc:358-386): the static flag wins outright;
//   otherwise it scans the move USER's slots via onModifyMoveFlags. The `moveType`
//   argument belongs to the caller (IsIronFist/IsStriker/IsMegaLauncher/IsSound pass
//   the literal TYPE_NORMAL dummy, battle_util.c:9245-9381; IsKeenEdge passes the real
//   type). The sim predicates and dispatchCalc.isIronFistBoosted port those wrappers.
// - Brawling Wyvern :7603-7610 grants PUNCH on Dragon moves; Junshi Sanda :7613-7622
//   swaps PUNCH<->KICK; Mixed Martial Arts :9898-9905 grants PUNCH+KICK on Normal
//   moves; Gunman :9535-9540 grants MEGA_LAUNCHER on status moves; Festivities
//   :10194-10203 swaps DANCE<->SOUND; Reverbate :10657-10662 grants SOUND on Normal
//   moves; Taekkyeon :10666-10671 grants DANCE on non-status moves; Backstreet Boy
//   :11570-11583 swaps KICK<->DANCE; Chestnut Axe :11709-11712 grants KEEN_EDGE on
//   Grass moves; Musical Notes :11988-11992 grants SOUND on status moves.
//
// Every number below is hand-derived from the C line cited at the assertion.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import { DEFAULT_STAT_STAGE, STAT_SPDEF, STATUS1_BLEED, hasFlag } from './constants'
import {
  MOVE_FLAG_CONSUMERS_WIRED,
  PORTED_MODIFY_MOVE_FLAGS_ABILITIES,
  extractModifyMoveFlagsAbilities,
  type MoveFlagFamily,
} from './driver/abilityHookInventory'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')

/**
 * The type strings are bare (`NORMAL`, `GRASS`, ...) exactly as driver/loadSimData.ts:188
 * builds them, because the onModifyMoveFlags grants compare the declared/resolved type
 * (`ctx.moveType === 'NORMAL'`, `resolvedType === 'GRASS'`).
 */
function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type ? String(m.type).replace('TYPE_', '') : null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
    target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'],
    argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    pp: m.pp as number,
  }
}

// These scenarios only consult moves and the (empty) item table.
function speciesData(_id: string): SimSpeciesData | undefined {
  return undefined
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
  species: speciesData,
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

interface Spec {
  hp?: number
  maxHp?: number
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  status1?: number
}

function battlerSpec(id: number, s: Spec) {
  return createBattlerState(
    id,
    mon({
      rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: id === 0 ? 100 : 50 },
      hp: s.hp ?? 100,
      maxHp: s.maxHp ?? 100,
      abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
      moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
      pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
      status1: s.status1 ?? 0,
    }),
    0,
  )
}

function battle(specs: Spec[], rng: RandomSource): BattleState {
  return createBattleState({ battlers: specs.map((s, i) => battlerSpec(i, s)), rng })
}

/** Every draw is 1: below any accuracy check (`1 >= acc` never true for acc >= 2),
 * above 0 for the `% 2 !== 0` rolls the bleed hook takes. */
function fixedRng(value: number): RandomSource {
  return { random16: () => value }
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

function fixedDamage(amount: number): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function testDeps(damage: DamageResolver = fixedDamage(20), replacement?: ReplacementDeps): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    replacement,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]

function slots(
  ability: string | null,
  innates: [string | null, string | null, string | null] = [null, null, null],
): SimBattleMon['abilities'] {
  return { ability, innates }
}

const stage = (s: BattleState, id: number, stat: number, fallback = DEFAULT_STAT_STAGE) =>
  s.battlers[id]?.mon.statStages[stat] ?? fallback

interface AttackCall {
  moveId: string
  movePower: number | undefined
  ability: string | null | undefined
  target: number
}

/** Records each resolver call, including the queued extra attack's movePower/ability. */
function recordingDeps(calls: AttackCall[]): TurnLoopDeps {
  const resolver: DamageResolver = {
    resolve: (state, _attackerId, targetId, action) => {
      calls.push({
        moveId: action.moveToBeUsed?.id ?? 'NONE',
        movePower: state.currentExtraAttack?.movePower,
        ability: state.currentExtraAttack?.ability,
        target: targetId,
      })
      return { targetDamage: 20, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }
    },
  }
  return testDeps(resolver)
}

// ---------------------------------------------------------------------------
// PUNCH -- Vitality Strike (src/abilities.cc:8545-8556) reads IsIronFistBoosted
// (battle_util.c:9375 -> MOVE_FLAG_PUNCH). Junshi Sanda (:7613-7622) grants PUNCH
// when the move has FLAG_STRIKER_BOOST, so Mega Kick (kickBased, not punchBased)
// reaches the heal only with the innate.
// ---------------------------------------------------------------------------

describe('cycle 150ibcd3 - PUNCH consumers read the ability-granted flag', () => {
  it('Vitality Strike heals floor(hpDealt/10) on a kick move made Punch by Junshi Sanda', () => {
    // C :8550-8555: gBattleMoveDamage = -gHpDealt / 10, bumped to -1 when zero.
    // hpDealt = 20 -> 20 / 10 = 2 HP; the attacker runs 50/100 so the heal is visible.
    const s = battle(
      [
        { hp: 50, maxHp: 100, abilities: slots('ABILITY_VITALITY_STRIKE', ['ABILITY_JUNSHI_SANDA', null, null]), moves: slot('MOVE_MEGA_KICK'), pp: [5, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_MEGA_KICK')), null], testDeps())
    expect(s.battlers[0]!.mon.hp).toBe(52)
  })

  it('negative: without Junshi Sanda the same Mega Kick is not Punch, so nothing heals', () => {
    // The static kick flag alone never answers MOVE_FLAG_PUNCH.
    const s = battle(
      [
        { hp: 50, maxHp: 100, abilities: slots('ABILITY_VITALITY_STRIKE'), moves: slot('MOVE_MEGA_KICK'), pp: [5, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_MEGA_KICK')), null], testDeps())
    expect(s.battlers[0]!.mon.hp).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// KICK -- Sharp Talons (src/abilities.cc:11345-11353) reads IsStrikerBoosted
// (battle_util.c:9377 -> MOVE_FLAG_KICK). Mixed Martial Arts (:9898-9905) grants
// KICK on Normal moves, so Tackle (no static kick flag) can bleed only with it.
// ---------------------------------------------------------------------------

describe('cycle 150ibcd3 - KICK consumers read the ability-granted flag', () => {
  it('Sharp Talons bleeds on a Normal move made Kick by Mixed Martial Arts', () => {
    // C :11348-11352: DoesMoveMatchFlag(KICK), CanBleed(target), 50% roll
    // (random16() % 2; the RNG is pinned to 1 so 1 % 2 !== 0), then MOVE_EFFECT_BLEED.
    const s = battle(
      [
        { abilities: slots('ABILITY_SHARP_TALONS', ['ABILITY_MIXED_MARTIAL_ARTS', null, null]), moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], testDeps())
    expect(hasFlag(s.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(true)
  })

  it('negative: without Mixed Martial Arts Tackle is not Kick, so no bleed bit', () => {
    const s = battle(
      [
        { abilities: slots('ABILITY_SHARP_TALONS'), moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], testDeps())
    expect(hasFlag(s.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SOUND -- Grass Flute (src/abilities.cc:10070-10078) reads IsSoundMove
// (battle_util.c:9379 -> MOVE_FLAG_SOUND). Reverbate (:10657-10662) grants SOUND on
// Normal moves, so Tackle can inflict Fear only with the innate.
// ---------------------------------------------------------------------------

describe('cycle 150ibcd3 - SOUND consumers read the ability-granted flag', () => {
  it('Grass Flute inflicts Fear on a Normal move made Sound by Reverbate', () => {
    // C :10073-10077: IsSoundMove, no roll; applyFearEffect sets gVolatileStructs.fear.
    const s = battle(
      [
        { abilities: slots('ABILITY_GRASS_FLUTE', ['ABILITY_REVERBATE', null, null]), moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], testDeps())
    expect(s.battlers[1]!.volatiles.fear).toBe(true)
  })

  it('negative: without Reverbate Tackle is not Sound, so no Fear', () => {
    const s = battle(
      [
        { abilities: slots('ABILITY_GRASS_FLUTE'), moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], testDeps())
    expect(s.battlers[1]!.volatiles.fear).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DANCE -- Two Step (src/abilities.cc:6600-6607) reads IsDance
// (battle_util.c:9245 -> MOVE_FLAG_DANCE). Taekkyeon (:10666-10671) grants DANCE on
// non-status moves, so Tackle queues Revelation Dance only with the innate.
// ---------------------------------------------------------------------------

describe('cycle 150ibcd3 - DANCE consumers read the ability-granted flag', () => {
  it('Two Step queues Revelation Dance at 50 BP on a Tackle made Dance by Taekkyeon', () => {
    // C :6602-6607: IsDance -> UseAttackerFollowUpMove(..., MOVE_REVELATION_DANCE, 50).
    const calls: AttackCall[] = []
    const s = battle(
      [
        { abilities: slots('ABILITY_TWO_STEP', ['ABILITY_TAEKKYEON', null, null]), moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], recordingDeps(calls))
    expect(calls.map((c) => c.moveId)).toEqual(['MOVE_TACKLE', 'MOVE_REVELATION_DANCE'])
    expect(calls[1]).toEqual({ moveId: 'MOVE_REVELATION_DANCE', movePower: 50, ability: 'ABILITY_TWO_STEP', target: 1 })
  })

  it('negative: without Taekkyeon Tackle is not a dance, so no follow-up', () => {
    const calls: AttackCall[] = []
    const s = battle(
      [
        { abilities: slots('ABILITY_TWO_STEP'), moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], recordingDeps(calls))
    expect(calls.map((c) => c.moveId)).toEqual(['MOVE_TACKLE'])
  })
})

// ---------------------------------------------------------------------------
// KEEN EDGE -- Sinister Claws (src/abilities.cc:12415-12429) reads IsKeenEdge
// (battle_util.c:9381 -> MOVE_FLAG_KEEN_EDGE with the REAL move type). Chestnut Axe
// (:11709-11712) grants KEEN_EDGE on Grass moves, so Leafage (no static slice flag)
// drops SpD only with the innate.
// ---------------------------------------------------------------------------

describe('cycle 150ibcd3 - KEEN_EDGE consumers read the ability-granted flag', () => {
  it('Sinister Claws drops the target SpD by 1 on Leafage made Keen Edge by Chestnut Axe', () => {
    // C :12418/:12424-12428: IsKeenEdge + StatLowerableOrMirrorArmor(SPDEF), then
    // AbilityStatusEffect(MOVE_EFFECT_SP_DEF_MINUS_1) -- one stage.
    const s = battle(
      [
        { abilities: slots('ABILITY_SINISTER_CLAWS', ['ABILITY_CHESTNUT_AXE', null, null]), moves: slot('MOVE_LEAFAGE'), pp: [20, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_LEAFAGE')), null], testDeps())
    expect(stage(s, 1, STAT_SPDEF)).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('negative: without Chestnut Axe Leafage is not Keen Edge, so SpD is unchanged', () => {
    const s = battle(
      [
        { abilities: slots('ABILITY_SINISTER_CLAWS'), moves: slot('MOVE_LEAFAGE'), pp: [20, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_LEAFAGE')), null], testDeps())
    expect(stage(s, 1, STAT_SPDEF)).toBe(DEFAULT_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// MEGA LAUNCHER -- Pyro Shells (src/abilities.cc:5006-5013) reads
// IsMegaLauncherBoosted (battle_util.c:9373 -> MOVE_FLAG_MEGA_LAUNCHER). Gunman
// (:9535-9540) grants it on status moves, so Screech (no static bullet flag) queues
// Outburst only with the innate.
// ---------------------------------------------------------------------------

describe('cycle 150ibcd3 - MEGA LAUNCHER consumers read the ability-granted flag', () => {
  it('Pyro Shells queues Outburst at 50 BP on a status move made Mega Launcher by Gunman', () => {
    // C :5008-5013: IsMegaLauncherBoosted -> UseAttackerFollowUpMove(..., MOVE_OUTBURST, 50).
    // The fixed resolver returns 20 even for the status move, so MoveEnd's noEffect
    // bit is clear (the same forced-harness convention cycle92FollowUps.test.ts uses).
    const calls: AttackCall[] = []
    const s = battle(
      [
        { abilities: slots('ABILITY_PYRO_SHELLS', ['ABILITY_GUNMAN', null, null]), moves: slot('MOVE_SCREECH'), pp: [40, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_SCREECH')), null], recordingDeps(calls))
    expect(calls.filter((c) => c.moveId === 'MOVE_OUTBURST')).toEqual([
      { moveId: 'MOVE_OUTBURST', movePower: 50, ability: 'ABILITY_PYRO_SHELLS', target: 1 },
    ])
  })

  it('negative: without Gunman the same status move is not Mega Launcher, so no Outburst', () => {
    const calls: AttackCall[] = []
    const s = battle(
      [
        { abilities: slots('ABILITY_PYRO_SHELLS'), moves: slot('MOVE_SCREECH'), pp: [40, 0, 0, 0] },
        {},
      ],
      fixedRng(1),
    )
    executeTurn(s, [useMove(1, move('MOVE_SCREECH')), null], recordingDeps(calls))
    expect(calls.filter((c) => c.moveId === 'MOVE_OUTBURST')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Inventory: every onModifyMoveFlags pair is ported because all six families are
// wired, and deleting a family's returning-true branch drops its granting ability.
// ---------------------------------------------------------------------------

const statusEffectsSource = readFileSync(new URL('statusEffects.ts', import.meta.url), 'utf8')
const moveEndSource = readFileSync(new URL('moveEnd.ts', import.meta.url), 'utf8')
const moveTargetFlagsSource = readFileSync(new URL('moveTargetFlags.ts', import.meta.url), 'utf8')

/** Deletes exactly one source line; the result is not a program, which is fine for text extractors. */
function dropLineContaining(source: string, needle: string): string {
  const lines = source.split('\n')
  const kept = lines.filter((line) => !line.includes(needle))
  expect(kept.length, `expected exactly one line containing ${needle}`).toBe(lines.length - 1)
  return kept.join('\n')
}

/**
 * Removes the block whose header contains `marker` (from the marker through its matching `}`).
 * Copied from cycle150iInventory.test.ts: the source need not stay a valid program.
 */
function removeBranch(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  const open = source.indexOf('{', start)
  if (open === -1) throw new Error(`no block after ${marker}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(0, start) + source.slice(i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${marker}`)
}

const ALL_TEN = [
  'ABILITY_BACKSTREET_BOY',
  'ABILITY_BRAWLING_WYVERN',
  'ABILITY_CHESTNUT_AXE',
  'ABILITY_FESTIVITIES',
  'ABILITY_GUNMAN',
  'ABILITY_JUNSHI_SANDA',
  'ABILITY_MIXED_MARTIAL_ARTS',
  'ABILITY_MUSICAL_NOTES',
  'ABILITY_REVERBATE',
  'ABILITY_TAEKKYEON',
]

describe('cycle 150ibcd3 - inventory: all six families wired, all ten pairs ported', () => {
  it('MOVE_FLAG_CONSUMERS_WIRED lists all six swept families', () => {
    expect(MOVE_FLAG_CONSUMERS_WIRED).toEqual(['punch', 'kick', 'sound', 'dance', 'keenEdge', 'megaLauncher'])
  })

  it('extractModifyMoveFlagsAbilities() equals the pinned ported set and holds exactly the ten hooks', () => {
    const extracted = extractModifyMoveFlagsAbilities()
    expect(extracted).toEqual(PORTED_MODIFY_MOVE_FLAGS_ABILITIES)
    expect([...extracted].sort()).toEqual(ALL_TEN)
  })

  const mutations: { family: MoveFlagFamily; ability: string; mutate: () => Set<string> }[] = [
    {
      family: 'punch',
      ability: 'ABILITY_BRAWLING_WYVERN',
      mutate: () => extractModifyMoveFlagsAbilities({ statusEffects: removeBranch(statusEffectsSource, "battlerHasSimAbility(state, attacker, 'ABILITY_BRAWLING_WYVERN'") }),
    },
    {
      family: 'kick',
      ability: 'ABILITY_BACKSTREET_BOY',
      mutate: () => extractModifyMoveFlagsAbilities({ statusEffects: removeBranch(statusEffectsSource, "battlerHasSimAbility(state, attacker, 'ABILITY_BACKSTREET_BOY'") }),
    },
    {
      family: 'sound',
      ability: 'ABILITY_MUSICAL_NOTES',
      mutate: () => extractModifyMoveFlagsAbilities({ statusEffects: removeBranch(statusEffectsSource, "battlerHasSimAbility(state, attacker, 'ABILITY_MUSICAL_NOTES'") }),
    },
    {
      family: 'dance',
      ability: 'ABILITY_TAEKKYEON',
      mutate: () => extractModifyMoveFlagsAbilities({ moveEnd: removeBranch(moveEndSource, "battlerHasSimAbility(state, battler, 'ABILITY_TAEKKYEON'") }),
    },
    {
      family: 'keenEdge',
      ability: 'ABILITY_CHESTNUT_AXE',
      mutate: () => extractModifyMoveFlagsAbilities({ statusEffects: removeBranch(statusEffectsSource, "battlerHasSimAbility(state, attacker, 'ABILITY_CHESTNUT_AXE'") }),
    },
    {
      family: 'megaLauncher',
      ability: 'ABILITY_GUNMAN',
      // isMegaLauncherBoostedMove's grant is a single `return ... &&` line, not a block, so
      // removeBranch would run past the function; the line-drop is the equivalent mutation.
      mutate: () => extractModifyMoveFlagsAbilities({ moveTargetFlags: dropLineContaining(moveTargetFlagsSource, "'ABILITY_GUNMAN'") }),
    },
  ]

  for (const { family, ability, mutate } of mutations) {
    it(`${family}: deleting the granting branch drops ${ability}`, () => {
      // Control: the branch is present and the hook ports for this family.
      expect(extractModifyMoveFlagsAbilities().has(ability), `control: ${ability} ported`).toBe(true)
      const dropped = mutate()
      expect(dropped.has(ability), `mutated: ${ability} no longer ported`).toBe(false)
    })
  }
})
