/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 151f: the Soul Linker branch of the drain script.
//
// C source at the pinned SHA (pipeline/.upstream/eliteredux-source):
// - BattleScript_EffectAbsorb (:3269-3292) -> BattleScript_AbsorbHeal (:3286-3292):
//     manipulatedamage DMG_TO_HP_FROM_MOVE
//     call BattleScript_AbsorbLeech
//   and Dream Eater reaches the same script through BattleScript_EffectAbsorb (:3567).
// - BattleScript_AbsorbLeech (:3293-3297): call BattleScript_AbsorbLeech_Test; tryfaintmon
//   BS_ATTACKER; tryfaintmon BS_TARGET; return.
// - BattleScript_AbsorbLeech_Test (:3298-3306):
//     orword gHitMarker, HITMARKER_IGNORE_SUBSTITUTE | HITMARKER_IGNORE_DISGUISE
//     jumpifability BS_TARGET, ABILITY_LIQUID_OOZE, BattleScript_AbsorbLiquidOoze   (:3300)
//     jumpifhealingblocked BS_ATTACKER, BattleScript_Return                        (:3301)
//     jumpifstatus BS_ATTACKER, STATUS1_BLEED, BattleScript_Return                 (:3302)
//     jumpifabsent BS_TARGET, BattleScript_AbsorbLeech_SkipSoulLinker              (:3303)
//     jumpifability BS_ATTACKER, ABILITY_SOUL_LINKER, BattleScript_AbsorbSoulLinker (:3304)
//     jumpifability BS_TARGET, ABILITY_SOUL_LINKER, BattleScript_AbsorbSoulLinker  (:3305)
//   -> BattleScript_AbsorbLeech_SkipSoulLinker: setbyte; goto BattleScript_AbsorbUpdateHp
//      (heal the attacker).
// - BattleScript_AbsorbSoulLinker (:3309-3317): call BattleScript_AbsorbUpdateHp (attacker
//   heals), then `healthbarupdate BS_TARGET; datahpupdate BS_TARGET` with the same still
//   NEGATIVE gBattleMoveDamage (Cmd_datahpupdate, battle_script_commands.c:1908-1911: hp goes
//   up, clamped to maxHP), so the TARGET heals the identical amount. Big Root / Absorbant are
//   not re-applied: the C reuses the value stored by manipulatedamage
//   (battle_script_commands.c:9398-9411, GetDrainedBigRootHp battle_util.c:2369-2377).
// - The branch ends with `manipulatedamage DMG_CHANGE_SIGN` (:3317), flipping that spent negative
//   heal back to +drainHp. MOVEEND_ABILITIES (case 5, battle_script_commands.c:4527-4531) then
//   runs the holder's Soul Linker hook, BattleScript_AttackerSoulLinker (:11467-11472), which
//   applies exactly that stored +drainHp to BS_ATTACKER. So whoever holds the ability, the
//   attacker's drain heal is followed by an equal (unclamped) hit at move end: with no max HP
//   clamp involved the attacker's net change is zero, and the target keeps the drain heal.
//   The plain heal path (`goto BattleScript_AbsorbUpdateHp`, :3304-3305) has no flip, so
//   gBattleMoveDamage stays negative and the hook deals nothing when neither side has the
//   ability; the Liquid Ooze path (:3318-3324) flips once and keeps +drainHp.
// - manipulatedamage DMG_TO_HP_FROM_MOVE already zeroes the drain when CanBattlerHeal is false,
//   and AbsorbLeech_Test's jumpifhealingblocked (:3301) / jumpifstatus BLEED (:3302) return
//   before the heal, so a blocked or bleeding attacker never reaches either heal.
//
// The move-effect unit is EFFECT_ABSORB with argument 0, so drainHp = floor(hpDealt / 2),
// raised to 1 when that is 0 (GetDrainedBigRootHp returns -1 for a zero argument).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { STATUS1_BLEED, STATUS1_SLEEP, STATUS3_HEAL_BLOCK } from './constants'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle150hbbEncoreTarget.test.ts.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<Record<string, unknown>>('types.json')
const inverseTypeChart = snapshot<Record<string, unknown>>('typesInverse.json')
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
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  level?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status1?: number
  status2?: number
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource = scriptedRng([0]),
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {},
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 300,
          maxHp: s.maxHp ?? 300,
          level: s.level ?? 50,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
    ...opts,
  })
}

function scriptedRng(values: number[] = [0]): RandomSource & { calls: number } {
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
    resolvedType: moveData.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : 'NORMAL',
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

function testDeps(
  damage: DamageResolver = fixedDamage(20),
  grounding: GroundingContext = GROUNDING,
  dataContext: SimDataContext = DATA_CONTEXT,
): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const hasAbility = (
  ability: string | null,
  innates: [string | null, string | null, string | null] = [null, null, null],
): SimBattleMon['abilities'] => ({ ability, innates })

/** Runs one drain move: battler 0 attacks battler 1 with `moveId` for a fixed 40 damage. */
function runDrain(specs: BattlerSpec[], moveId = 'MOVE_GIGA_DRAIN', damage = 40) {
  const state = battle(specs, scriptedRng([0]))
  const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(damage)))
  return { state, out }
}

describe('Cycle 151f - Soul Linker on the drain script (BattleScript_AbsorbSoulLinker)', () => {
  it('1: a Soul Linker attacker heals drainHp, the target heals it too, and the move-end hook takes it back', () => {
    // Giga Drain is EFFECT_ABSORB with argument 0. The fixed resolver deals 40, so
    // hpDealt = 40; drainHp = floor(40 / 2) = 20 (no Big Root / Absorbant).
    // Order: attacker heals 100 -> 120 (AbsorbUpdateHp), the target heals
    // 200 -> 160 (the hit) -> 180 (AbsorbSoulLinker), then DMG_CHANGE_SIGN (:3317) leaves
    // +20 in gBattleMoveDamage and BattleScript_AttackerSoulLinker (:11467-11472) takes it
    // back off the attacker at MOVEEND_ABILITIES: 120 -> 100. maxHp 320 clamps nothing.
    const { state, out } = runDrain([
      { hp: 100, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') },
      { hp: 200, maxHp: 320 },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(180)
    // Item 8: the old "not modelled" note named ABILITY_SOUL_LINKER; it must be gone.
    expect(out.actions[0]!.unmodelled.some((note) => note.includes('ABILITY_SOUL_LINKER'))).toBe(false)
  })

  it('2: Soul Linker on the target only produces the same two heals and the same move-end hit', () => {
    // BattleScript_AbsorbLeech_Test has one jump per side (:3304-3305), both landing on
    // BattleScript_AbsorbSoulLinker. The target's holder is the second jump; its move-end half
    // (ON_EITHER, src/abilities.cc:4273-4285) then applies gBattleMoveDamage -- still +20 -- to
    // BS_ATTACKER (:11467-11472), so the attacker ends back at 100 and the target keeps 180.
    const { state, out } = runDrain([
      { hp: 100, maxHp: 320 },
      { hp: 200, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(180)
    expect(out.actions[0]!.unmodelled.some((note) => note.includes('ABILITY_SOUL_LINKER'))).toBe(false)
  })

  it('3: with no Soul Linker only the attacker heals', () => {
    // Negative: both jumpifability (:3304-3305) fail, so BattleScript_AbsorbLeech_SkipSoulLinker
    // runs AbsorbUpdateHp for the attacker alone. The target stays at 200 - 40 = 160.
    const { state } = runDrain([
      { hp: 100, maxHp: 320 },
      { hp: 200, maxHp: 320 },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(120)
    expect(state.battlers[1]!.mon.hp).toBe(160)
  })

  it('4: a Liquid Ooze target that also holds Soul Linker drains into the attacker, no target heal', () => {
    // jumpifability BS_TARGET, ABILITY_LIQUID_OOZE (:3300) is checked BEFORE the Soul Linker
    // jumps (:3304-3305), so the Ooze branch wins even though the target also has Soul Linker
    // as an innate (BattlerHasAbility scans all four slots, battle_util.c:9305-9313).
    // BattleScript_AbsorbLiquidOoze (:3318-3324): DMG_CHANGE_SIGN, then AbsorbUpdateHp damages
    // BS_ATTACKER -- 100 -> 80. Because that flip is not undone, gBattleMoveDamage is +20 at
    // MOVEEND_ABILITIES and the target's Soul Linker (the onDefender half, src/abilities.cc:4273-4285,
    // requires the opponent to lack it) takes another 20 off the attacker: 80 -> 60. The target took
    // only the hit: 200 -> 160, and nothing heals it.
    const { state } = runDrain([
      { hp: 100, maxHp: 320 },
      { hp: 200, maxHp: 320, abilities: hasAbility('ABILITY_LIQUID_OOZE', ['ABILITY_SOUL_LINKER', null, null]) },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(60)
    expect(state.battlers[1]!.mon.hp).toBe(160)
  })

  it('5a: a bleeding attacker heals nothing and the target heals nothing', () => {
    // manipulatedamage DMG_TO_HP_FROM_MOVE zeroes the drain when CanBattlerHeal fails
    // (battle_script_commands.c:9399-9402), and jumpifstatus STATUS1_BLEED (:3302) returns
    // before AbsorbUpdateHp. No drain from the move, and the stored 0 makes the move-end Soul
    // Linker hook a no-op. The end-turn bleed tick then deals -max(1, trunc(320 / 16)) = -20:
    // 100 -> 80.
    const { state } = runDrain([
      { hp: 100, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER'), status1: STATUS1_BLEED },
      { hp: 200, maxHp: 320 },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(state.battlers[1]!.mon.hp).toBe(160)
    expect(state.battlers[1]!.mon.hp).toBeLessThan(180)
  })

  it('5b: a heal-blocked attacker heals nothing and the target heals nothing', () => {
    // jumpifhealingblocked BS_ATTACKER (:3301) returns before the heal; CanBattlerHeal reads
    // STATUS3_HEAL_BLOCK first (battle_util.c:8979-8980), and DMG_TO_HP_FROM_MOVE has already
    // zeroed gBattleMoveDamage (:9399-9402), so the move-end Soul Linker hook applies nothing.
    // No end-turn effect for heal block, so the attacker stays at 100 and the target at
    // 200 - 40 = 160.
    const state = battle(
      [
        { hp: 100, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') },
        { hp: 200, maxHp: 320 },
      ],
      scriptedRng([0]),
    )
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    executeTurn(state, [useMove(1, move('MOVE_GIGA_DRAIN')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(160)
  })

  it('6: a target fainted by the hit (jumpifabsent) is not healed back and nothing crashes', () => {
    // Target 30 HP takes 40, so hpDealt = 30 and drainHp = 15. jumpifabsent BS_TARGET (:3303;
    // VARIOUS_JUMP_IF_ABSENT -> !IsBattlerAlive, battle_script_commands.c:6769-6772) skips the
    // Soul Linker branch: the plain heal leaves gBattleMoveDamage negative, and the move-end hook
    // is skipped anyway because ShouldApplyOnHitEffect(opponent) requires the target alive
    // (battle_util.c:4060-4062). The attacker keeps the heal: 100 -> 115; the target stays at 0.
    const { state, out } = runDrain([
      { hp: 100, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') },
      { hp: 30, maxHp: 320 },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(115)
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(out.actions[0]!.fainted).toContain(1)
  })

  it('7: Dream Eater (BattleScript_EffectDreamEater -> BattleScript_EffectAbsorb) shares the branch', () => {
    // :3567: a sleeping target jumps to BattleScript_EffectAbsorb, so the drain + Soul Linker
    // path is identical. EFFECT_DREAM_EATER also has argument 0: drainHp = floor(40 / 2) = 20,
    // so the same numbers as case 1 apply: attacker 100 -> 120 -> 100, target 200 -> 180.
    const { state, out } = runDrain(
      [
        { hp: 100, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') },
        { hp: 200, maxHp: 320, status1: STATUS1_SLEEP },
      ],
      'MOVE_DREAM_EATER',
    )
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(180)
    expect(out.actions[0]!.unmodelled.some((note) => note.includes('ABILITY_SOUL_LINKER'))).toBe(false)
  })

  it('8: no drain outcome carries the old "BattleScript_AbsorbSoulLinker ... is not modelled" note', () => {
    // Before this cycle the branch ended in `unmodelled.push(...)`, naming both the script and the
    // ability. With the branch ported, neither the ability id nor the script name may appear in the
    // note stream, whichever side holds the ability.
    const sides: BattlerSpec[][] = [
      [{ hp: 100, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') }, { hp: 200, maxHp: 320 }],
      [{ hp: 100, maxHp: 320 }, { hp: 200, maxHp: 320, abilities: hasAbility('ABILITY_SOUL_LINKER') }],
    ]
    for (const specs of sides) {
      const { out } = runDrain(specs)
      const notes = out.actions[0]!.unmodelled
      expect(notes.some((note) => note.includes('ABILITY_SOUL_LINKER'))).toBe(false)
      expect(notes.some((note) => note.includes('BattleScript_AbsorbSoulLinker'))).toBe(false)
      expect(notes.some((note) => note.includes('not modelled'))).toBe(false)
    }
  })
})
