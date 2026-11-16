/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ibci: Cmd_attackcanceler's GET_MOVE_TYPE
// (battle_script_commands.c:1046-1056) is GetMoveTypeInternal's answer with its own
// type2 write applied:
//
//   GET_MOVE_TYPE(gCurrentMove, moveType);
//   if (gBattleMoves[gCurrentMove].type2 && !gBattleStruct->dynamicMoveType) {
//       CalculateMoveDamageAndEffectiveness(..., &moveType, &typeEffectiveness);
//       gBattleStruct->dynamicMoveType = moveType | 0x80;
//   }
//
// DoMoveDamageCalc keeps the type2 type only when its damage is strictly higher
// (battle_util.c:7769-7785). Both later readers -- GetParentalBondType at :1084
// and AtkCanceller_UnableToUseMove's CANCELLER_POWDER_STATUS at
// battle_util.c:3468-3480 (it runs at :1068, after the write) -- therefore see
// the type2 pick, not the declared or -ate type. calculate.ts's hit plan
// (GetParentalBondType's input) needed the same winner.
//
// Numbers are hand-derived from the type chart in data/v2.65beta/types.json and
// written next to each case. The fixed RNG is 1: every accuracy check hits
// (1 % 100 is below every accuracy in play) and every crit roll misses
// (1 % 24 !== 0).
import { describe, expect, it } from 'vitest'

import { STATUS2_POWDER, WEATHER_HAIL_TEMPORARY, WEATHER_SUN_TEMPORARY, hasFlag } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import { buildBattlerBattleState, buildFieldBattleState, type BridgeDeps } from './bridge'
import { calculateMoveDamage, type DamageCalcScenario } from '../calculate'
import type { BattleState, RandomSource } from './state'
import type { ChosenAction } from './turnOrder'
import type { DamageResolution, DamageResolveContext, DamageResolver } from './turn'
import { ProtectType, isBattlerProtected } from './turn'

const data = loadSimData()

function fixedRng(value = 1): RandomSource {
  return { random16: () => value }
}

function foeMon(species: string, ability = 'ABILITY_NONE', moves = ['MOVE_TACKLE']): TrainerMonData {
  return {
    species,
    item: 'ITEM_NONE',
    nature: 'NATURE_HARDY',
    ability,
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    moves,
    ironPill: false,
    hiddenPowerType: 'TYPE_NORMAL',
  }
}

function trainer(mons: TrainerMonData[]): TrainerData {
  return {
    ...data.trainersById.get('TRAINER_SAWYER_1')!,
    noSwitching: true,
    parties: { ace: mons, elite: mons, hell: mons },
  }
}

interface PlayerSpec {
  species: string
  ability: string | null
  moves: string[]
  innates?: [string | null, string | null, string | null]
}

/** Level-50 player vs a same-level foe (the driver derives the opponent's level
 * from the player's highest level). Player innates are cleared unless supplied,
 * so no unrelated entry ability perturbs the ability scans. */
function session(player: PlayerSpec, foe: TrainerMonData): BattleSession {
  const party = buildPlayerParty(
    [{ species: player.species, level: 50, moves: player.moves }],
    50,
    data,
  )
  party[0]!.abilities = { ability: player.ability, innates: player.innates ?? [null, null, null] }
  return createSession({ data, playerParty: party, opponentTrainer: trainer([foe]), rng: fixedRng(1) })
}

/** Wraps the real resolver and records every turn-loop `resolve` call. The turn
 * loop passes `hitIndex` only when it is running a per-hit sequence
 * (multiHitCounter > 0), so `[0, 1]` means Parental Bond granted a second hit. */
function recording(inner: DamageResolver): { resolver: DamageResolver; hitIndexes: Array<number | undefined> } {
  const hitIndexes: Array<number | undefined> = []
  const resolver: DamageResolver = {
    resolve(state: BattleState, attackerId: number, targetId: number, action: ChosenAction, context?: DamageResolveContext): DamageResolution {
      hitIndexes.push(context?.hitIndex)
      return inner.resolve(state, attackerId, targetId, action, context)
    },
    typeEffectiveness: inner.typeEffectiveness?.bind(inner),
    moveType: inner.moveType?.bind(inner),
    confusionSelfHit: inner.confusionSelfHit?.bind(inner),
  }
  return { resolver, hitIndexes }
}

function play(s: BattleSession, moveId: string): { hitIndexes: Array<number | undefined>; outcome: ReturnType<typeof stepTurn>['outcome'] } {
  const { resolver, hitIndexes } = recording(s.turnDeps.damage)
  s.turnDeps.damage = resolver
  const outcome = stepTurn(s, buildMoveAction(s.state, data, 0, moveId), null).outcome
  return { hitIndexes, outcome }
}

function playerOutcome(outcome: ReturnType<typeof stepTurn>['outcome']) {
  const action = outcome.actions.find((a) => a.battlerId === 0 && a.action === 'USE_MOVE')
  if (!action) throw new Error('the player action is missing from the turn outcome')
  return action
}

// ---------------------------------------------------------------------------
// Item 1a: Ice Cold Hunter (abilities.cc:8061, ctx.moveType === 'ICE' && HAIL)
// sees Weather Ball's weather type. GetMoveTypeInternal's move-ID switch
// (battle_main.c:5113-5122) makes Weather Ball Ice in hail.
// ---------------------------------------------------------------------------

describe('cycle 150ibci (1a) - Weather Ball resolves ICE before GetParentalBondType', () => {
  it('hail: Ice Cold Hunter gets the second hit (hit count 2)', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_ICE_COLD_HUNTER', moves: ['MOVE_WEATHER_BALL'] },
      foeMon('SPECIES_SNORLAX'),
    )
    s.state.field.weather = WEATHER_HAIL_TEMPORARY
    // Weather Ball is declared NORMAL; in hail GetMoveTypeInternal returns ICE
    // (battle_main.c:5113-5122), which is what Cmd_attackcanceler hands :1084's
    // GetParentalBondType. Ice Cold Hunter matches ICE + HAIL, and
    // GetParentalBondCount raises multiHitCounter to 2.
    const { hitIndexes } = play(s, 'MOVE_WEATHER_BALL')
    expect(hitIndexes).toEqual([0, 1])
  })

  it('negative: no weather leaves Weather Ball NORMAL, so no second hit', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_ICE_COLD_HUNTER', moves: ['MOVE_WEATHER_BALL'] },
      foeMon('SPECIES_SNORLAX'),
    )
    // GetMoveTypeInternal's Weather Ball case breaks with no weather, so the
    // declared NORMAL survives; Ice Cold Hunter's ICE check fails.
    const { hitIndexes } = play(s, 'MOVE_WEATHER_BALL')
    expect(hitIndexes).toEqual([undefined])
  })

  it('negative: Ice Cold Hunter with a non-Ice move in hail stays one hit', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_ICE_COLD_HUNTER', moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_SNORLAX'),
    )
    s.state.field.weather = WEATHER_HAIL_TEMPORARY
    // Tackle is NORMAL with no type2 and no -ate ability, so moveType is NORMAL.
    const { hitIndexes } = play(s, 'MOVE_TACKLE')
    expect(hitIndexes).toEqual([undefined])
  })
})

// ---------------------------------------------------------------------------
// Item 1b: the type2 winner is what its readers see.
//
// Flying Press (FIGHTING/FLYING) vs Parasect (BUG/GRASS):
//   Fighting: 0.5 (Bug) * 1 (Grass) = 0.5x
//   Flying:   2 (Bug) * 2 (Grass)   = 4x      -> FLYING wins
// Raging Moth needs FIRE (abilities.cc:5838), so no second hit.
//
// Scorched Earth (FIRE/GROUND) vs Parasect (BUG/GRASS):
//   Fire:   2 (Bug) * 2 (Grass)     = 4x
//   Ground: 0.5 (Bug) * 0.5 (Grass) = 0.25x   -> FIRE wins -> Raging Moth's
//                                                DUAL_WIELD -> 2 hits
// vs Heatran (FIRE/STEEL):
//   Fire:   0.5 (Fire) * 2 (Steel)  = 1x
//   Ground: 2 (Fire) * 2 (Steel)    = 4x      -> GROUND wins -> 1 hit
// The attacker is Water-type Mudkip, so neither candidate gets STAB.
// ---------------------------------------------------------------------------

describe('cycle 150ibci (1b) - a type2 move hands its winner to GetParentalBondType', () => {
  it('Flying Press: FLYING beats FIGHTING, which Raging Moth does not read -> one hit', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_RAGING_MOTH', moves: ['MOVE_FLYING_PRESS'] },
      foeMon('SPECIES_PARASECT'),
    )
    const { hitIndexes } = play(s, 'MOVE_FLYING_PRESS')
    expect(hitIndexes).toEqual([undefined])
  })

  it('Scorched Earth: FIRE wins on Parasect -> Raging Moth fires -> two hits', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_RAGING_MOTH', moves: ['MOVE_SCORCHED_EARTH'] },
      foeMon('SPECIES_PARASECT'),
    )
    const { hitIndexes } = play(s, 'MOVE_SCORCHED_EARTH')
    expect(hitIndexes).toEqual([0, 1])
  })

  it('Scorched Earth: GROUND wins on Heatran -> Raging Moth stays quiet -> one hit', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_RAGING_MOTH', moves: ['MOVE_SCORCHED_EARTH'] },
      foeMon('SPECIES_HEATRAN'),
    )
    const { hitIndexes } = play(s, 'MOVE_SCORCHED_EARTH')
    expect(hitIndexes).toEqual([undefined])
  })
})

// ---------------------------------------------------------------------------
// Item 1c: CANCELLER_POWDER_STATUS (:3468-3480) runs after the type2 write, so
// it reads the same winner.
// ---------------------------------------------------------------------------

describe('cycle 150ibci (1c) - a powdered attacker is cancelled by the type2 pick', () => {
  it('FIRE wins (Scorched Earth vs Parasect): cancelled, attacker pays maxHp / 4', () => {
    // The foe's Powder Burst entry move (PORTED_ENTRY_MOVE_MAP, MOVE_POWDER) is the
    // builder path that sets STATUS2_POWDER on the player at battle start -- no
    // hand-written status here.
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_NONE', moves: ['MOVE_SCORCHED_EARTH'] },
      foeMon('SPECIES_PARASECT', 'ABILITY_POWDER_BURST'),
    )
    expect(hasFlag(s.state.battlers[0]!.mon.status2, STATUS2_POWDER)).toBe(true)
    const act = playerOutcome(play(s, 'MOVE_SCORCHED_EARTH').outcome)
    // battle_util.c:3473-3474: gBattleMoveDamage = maxHP / 4 (no Magic Guard).
    expect(act.cancelledBy).toBe('POWDER_STATUS')
    expect(act.targetDamage).toBeNull()
    expect(act.attackerDamage).toBe(Math.trunc(s.state.battlers[0]!.mon.maxHp / 4))
  })

  it('GROUND wins (Scorched Earth vs Heatran): not FIRE, so the move goes through', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_NONE', moves: ['MOVE_SCORCHED_EARTH'] },
      foeMon('SPECIES_HEATRAN', 'ABILITY_POWDER_BURST'),
    )
    expect(hasFlag(s.state.battlers[0]!.mon.status2, STATUS2_POWDER)).toBe(true)
    const act = playerOutcome(play(s, 'MOVE_SCORCHED_EARTH').outcome)
    expect(act.cancelledBy).toBeNull()
    expect(act.targetDamage).not.toBeNull()
    expect(act.targetDamage!).toBeGreaterThan(0)
  })

  it('Weather Ball in sun resolves FIRE and is cancelled while powdered', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_NONE', moves: ['MOVE_WEATHER_BALL'] },
      foeMon('SPECIES_SNORLAX', 'ABILITY_POWDER_BURST'),
    )
    s.state.field.weather = WEATHER_SUN_TEMPORARY
    expect(hasFlag(s.state.battlers[0]!.mon.status2, STATUS2_POWDER)).toBe(true)
    // GetMoveTypeInternal (:5113-5122) makes Weather Ball Fire in sun.
    const act = playerOutcome(play(s, 'MOVE_WEATHER_BALL').outcome)
    expect(act.cancelledBy).toBe('POWDER_STATUS')
  })
})

// ---------------------------------------------------------------------------
// Item 2: IsBattlerProtected's Pinnacle Blade branch (battle_util.c:6574,6597).
// No real type2 move can change the IsKeenEdge answer: the only type-based grant
// is Chestnut Axe's GRASS check (abilities.cc:11709-11712), and none of the five
// type2 moves (Aura Wheel, Flying Press, Muddy Water, Saber Slashes, Scorched
// Earth) has GRASS as its second type or as an -ate-able Normal primary. Saber
// Slashes is statically sliceBased anyway. The differing-answer path is
// therefore exercised with a resolver double, as REPORT.md explains.
// ---------------------------------------------------------------------------

describe('cycle 150ibci (2) - Pinnacle Blade reads the type2 pick through IsKeenEdge', () => {
  function protectCheck(effectiveMoveType: string): ProtectType {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_PINNACLE_BLADE', moves: ['MOVE_FLYING_PRESS'] },
      foeMon('SPECIES_PARASECT', 'ABILITY_CHESTNUT_AXE'),
    )
    s.state.battlers[1]!.round.protectMove = 'MOVE_PROTECT'
    const deps = {
      ...s.turnDeps,
      damage: {
        ...s.turnDeps.damage,
        // The type2 pick the C would have written into dynamicMoveType.
        typeEffectiveness: () => ({ effectiveness: 4, effectiveMoveType, unmodelled: [] }),
        // GetMoveTypeInternal's answer, which the pre-fix code passed: GRASS
        // would make the target's Chestnut Axe grant MOVE_FLAG_KEEN_EDGE.
        moveType: () => ({ moveType: 'GRASS', unmodelled: [] }),
      } satisfies DamageResolver,
    }
    return isBattlerProtected(s.state, 0, 1, 'MOVE_FLYING_PRESS', false, deps, [])
  }

  it('a type2 pick that is not GRASS leaves IsKeenEdge false -> the protect blocks', () => {
    // isKeenEdgeMove scans the TARGET's slots (the C passes its own battlerId at
    // :6597, a documented quirk), so Chestnut Axe is on the protector; FLYING is
    // not GRASS and Flying Press has no static slice flag -> no evasion.
    expect(protectCheck('TYPE_FLYING')).toBe(ProtectType.PROTECT_BLOCK)
  })

  it('control: the GetMoveTypeInternal answer GRASS would grant IsKeenEdge -> PROTECT_NONE', () => {
    // Passing the pre-fix answer (GRASS) makes the target's Chestnut Axe grant the
    // flag, so evadesProtect skips the block and the function returns PROTECT_NONE.
    expect(protectCheck('TYPE_GRASS')).toBe(ProtectType.PROTECT_NONE)
  })
})

// ---------------------------------------------------------------------------
// Item 3: calculate.ts's hit plan must see the type2 winner too.
// ---------------------------------------------------------------------------

/** Builds the calculator's scenario from a real session's battle state, the same
 * bridge the simulator uses (bridge.ts). Keeps this file's numbers tied to the
 * real species data instead of hand-written stat blocks. */
function calcScenario(s: BattleSession, moveId: string): DamageCalcScenario {
  const roles = { attackerId: 0, defenderId: 1 }
  const bridgeDeps: BridgeDeps = {
    grounding: s.turnDeps.grounding,
    turnOrder: s.data.turnOrder,
    statStageRatios: s.data.statStageRatios,
    dataContext: s.data.dataContext,
    inverseBattle: false,
  }
  const move = s.data.moveData(moveId)
  if (!move) throw new Error(`data has no ${moveId}`)
  const attacker = buildBattlerBattleState(s.state, 0, roles, bridgeDeps).battler
  const defender = buildBattlerBattleState(s.state, 1, roles, bridgeDeps).battler
  const field = buildFieldBattleState(s.state, roles, bridgeDeps).field
  return {
    move,
    attacker,
    defender,
    field,
    typeChart: s.data.typeChart,
    inverseTypeChart: s.data.inverseTypeChart,
    moveBehaviors: s.data.moveBehaviors,
    battleConstants: s.data.battleConstants,
    attackerActsFirst: true,
    sameMoveTurnsInARow: 0,
    hitCount: 0,
    defenderIsSwitching: false,
    magnitudeTier: null,
    attackerRolloutCounter: 0,
    attackerHasDefenseCurl: false,
    attackerWasHitThisTurn: false,
    beatUpBaseAttack: attacker.rawStats.atk,
    beatUpHitCount: 1,
    defenderUsedGlaiveRush: false,
  }
}

describe('cycle 150ibci (3) - calculateMoveDamage hit plan reads the type2 winner', () => {
  it('Scorched Earth vs Parasect: FIRE wins (4x vs 0.25x) -> Raging Moth -> two-hit plan', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_RAGING_MOTH', moves: ['MOVE_SCORCHED_EARTH'] },
      foeMon('SPECIES_PARASECT'),
    )
    expect(calculateMoveDamage(calcScenario(s, 'MOVE_SCORCHED_EARTH')).hitCount).toBe(2)
  })

  it('Scorched Earth vs Heatran: GROUND wins (4x vs 1x) -> one-hit plan', () => {
    const s = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_RAGING_MOTH', moves: ['MOVE_SCORCHED_EARTH'] },
      foeMon('SPECIES_HEATRAN'),
    )
    // The discriminating case: GetMoveTypeInternal alone answers FIRE (the declared
    // type), which would make Raging Moth fire and the plan two hits. Only the type2
    // winner handed to GetParentalBondType (battle_script_commands.c:1084) is GROUND.
    expect(calculateMoveDamage(calcScenario(s, 'MOVE_SCORCHED_EARTH')).hitCount).toBeNull()
  })
})
