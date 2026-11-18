/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3r (dbl-4b2 first slice): the partner-target damage gate and
// ability loop of AI_DoubleBattle, battle_ai_main.c:2303-2398.
//
// C lines checked:
//   AI_DoubleBattle prologue locals   battle_ai_main.c:2216-2228
//     (`moveType` :2227-2228, `partnerProtecting` :2221,
//      `atkPartnerHoldEffect` :2220)
//   partner-target damage gate        battle_ai_main.c:2304-2305
//   partner ability loop              battle_ai_main.c:2306-2395
//   partner-target branch tail        battle_ai_main.c:2484
//   GetAbilityAtIndex                 src/pokemon.c:6414 (via isSuppressed)
//   IsSuppressed                      src/battle_util.c:9254-9269
//   GetMoveDamageResult               battle_ai_util.c:794-850
//   CanIndexMoveFaintTarget           battle_ai_util.c:1340-1347
//   BattlerStatCanRise                battle_ai_util.c:1293-1303
//   DoesBattlerIgnoreAbilityChecks    battle_ai_util.c:1046-1051
//   HasMoveWithSplit / HasMoveWithType battle_ai_util.c:1371-1391
//   IsStatLoweringEffect              battle_ai_util.c:1605-1629 (the port
//     calls aiCheckBadMove's narrower IsStatLoweringMoveEffect, :1096-1116;
//     see REPORT.md uncertainty 1)
//
// LAYOUT. Doubles, so battlers 0/2 are the player side (the AI's foes) and 1/3
// the opponent side. The AI is battler 3 and its ally (the scored target) is
// battler 1: the ally then has the LOWER id, which is the only way
// GetAllyChosenMove returns a move at all (`partnerBattler > sBattler_AI` ->
// MOVE_NONE). `battlerDef` is therefore always 1 (the partner).
//
// OUTER GATE. Every fixture below needs `GetMoveDamageResult(move)` to read
// MOVE_POWER_WEAK. Two real routes do that at aiScorers.ts:250: a move with
// `power` 0 (a status move), or a move whose effect is in
// sDiscouragedPowerfulMoveEffects. Most cases use a STATUS move of the tested
// type (Thunder Wave/Electric, Soak/Water, Will-O-Wisp/Fire, Leech Seed/Grass,
// Screech/normal), spelled out per case. Justified/Rattled need a DAMAGING
// move (the C gates them on !IS_MOVE_STATUS), and no released DARK/GHOST/BUG
// move has a discouraged effect, so those two cases put a real DARK move
// (Bite) behind a synthetic EFFECT_SUPERPOWER overlay -- the same
// synthetic-deps precedent cycle3d3qDoubleBattle.test.ts uses for
// EFFECT_ALWAYS_CRIT -- which makes the gate return WEAK before the damage
// scan (and before the tie-break draw).
//
// RNG: AI_DoubleBattle itself draws nothing. Every fixture here returns
// MOVE_POWER_WEAK before getMoveDamageResult's WhichMoveBetter tie-break loop,
// and the partner branch calls no turn-order helper, so `state.rng` is never
// sampled -- asserted by its own test.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from './state'
import type { SimItemData } from './dataContext'
import { MAX_STAT_STAGE, STAT_SPEED, STATUS3_GASTRO_ACID } from './constants'
import { AI_FLAG_HP_AWARE } from './ai/aiFlags'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiDoubleBattle } from './ai/aiDoubleBattle'

const data = loadSimData()

const trainer = data.trainersById.get('TRAINER_SAWYER_1')!

const SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

function playerParty(): SimPartyMon[] {
  return buildPlayerParty(SPECS, 50, data)
}

function opponentParty(): SimPartyMon[] {
  return buildOpponentParty(trainer, 'elite', 50, data)
}

/** Doubles (BATTLE_TYPE_DOUBLE set) with the four standard battler slots: 0/2
 * player, 1/3 opponent. Built through the production layout path. */
function doublesState(): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng: createRandomSource(1) },
  )
}

interface FixtureOptions {
  aiMoves: Slot4<string | null>
  partnerMoves?: Slot4<string | null>
  partnerChosen?: number
  partnerAbility?: string | null
  partnerInnates?: [string | null, string | null, string | null]
}

/** Doubles state with the AI at battler 3 and its ally at battler 1. Every
 * battler starts at full HP with no status, no item and plain Blaze abilities
 * so the ability loop is decided only by the fields each test sets. */
function partnerFixture(opts: FixtureOptions): { state: BattleState; deps: AiDamageDeps } {
  const state = doublesState()
  for (const battler of state.battlers) {
    if (!battler) continue
    battler.mon.hp = battler.mon.maxHp
    battler.mon.status1 = 0
    battler.mon.status2 = 0
    battler.statuses3 = 0
    battler.statuses4 = 0
    battler.mon.itemId = null
    battler.mon.abilities = { ability: 'ABILITY_BLAZE', innates: [null, null, null] }
    battler.mon.types = ['NORMAL', 'MYSTERY', 'MYSTERY']
  }

  const ai = state.battlers[3]!.mon
  ai.moves = opts.aiMoves
  ai.pp = [35, 35, 35, 35]
  ai.types = ['WATER', 'MYSTERY', 'MYSTERY'] // grounded, no Levitate/Air Balloon

  const partner = state.battlers[1]!
  partner.mon.moves = opts.partnerMoves ?? [null, null, null, null]
  partner.mon.pp = [35, 35, 35, 35]
  partner.mon.abilities = { ability: opts.partnerAbility ?? 'ABILITY_BLAZE', innates: opts.partnerInnates ?? [null, null, null] }
  state.chosenMovePositions[1] = opts.partnerChosen ?? 0

  return { state, deps: aiDamageDepsFor(data, state) }
}

/** `AI_DoubleBattle(AI=3, battlerDef=1 the ally, move, score)` with score 100. */
function scoreAgainstPartner(state: BattleState, deps: AiDamageDeps, moveId: string) {
  return aiDoubleBattle(state, 3, 1, moveId, 0, 100, deps)
}

/** A deps whose move table reports a discouraged effect for `moveId`. That is
 * one of the two real routes to MOVE_POWER_WEAK (aiScorers.ts:250) and the only
 * one available to a DAMAGING move, which Justified/Rattled require. */
function withDiscouragedEffect(deps: AiDamageDeps, moveId: string): AiDamageDeps {
  const real = deps.moveData
  return {
    ...deps,
    moveData: (id) => {
      const move = real(id)
      if (id !== moveId || !move) return move
      return { ...move, effect: 'EFFECT_SUPERPOWER' }
    },
  }
}

const SYNTH_MEGA_PARAM = 'ITEM_SYNTHETIC_MEGA_STONE_PARAM'
/** An item whose `holdEffectStrength` equals HOLD_EFFECT_MEGA_STONE's numeric id.
 * No real item lands on it (every real Mega Stone carries no
 * `holdEffectStrength` at all, so AI_DATA->holdEffects reads its param as 0). */
function withMegaStoneParamItem(deps: AiDamageDeps): AiDamageDeps {
  const param = deps.holdEffectIds['HOLD_EFFECT_MEGA_STONE']!
  const item: SimItemData = { id: SYNTH_MEGA_PARAM, resolvedHoldEffect: null, holdEffectStrength: param, holdEffectType: null, naturalGift: null }
  return { ...deps, dataContext: { ...deps.dataContext, item: (id) => (id === SYNTH_MEGA_PARAM ? item : deps.dataContext.item(id)) } }
}

function setStatStage(state: BattleState, battlerId: number, stat: number, stage: number): void {
  state.battlers[battlerId]!.mon.statStages[stat] = stage
}

function clearHpAware(state: BattleState): void {
  state.aiFlags &= ~AI_FLAG_HP_AWARE
}

/** Records every draw in order; `overrun` trips if more values are asked for
 * than supplied. */
function scriptedRng(values: number[]): RandomSource & { calls: number; overrun: boolean } {
  let index = 0
  const rng = {
    calls: 0,
    overrun: false,
    random16: () => {
      rng.calls++
      if (index >= values.length) rng.overrun = true
      return values[index++] ?? 0
    },
  }
  return rng
}

const DBL43_NOTE = 'AI_DoubleBattle: partner-target attack-effect switch (battle_ai_main.c:2401-2483) not ported'

describe('partner-target damage gate (:2304) and baseline', () => {
  it('an ordinary partner ability never scores: -30 and the dbl-4b3 gap note', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_THUNDER_WAVE', null, null, null] })
    const result = scoreAgainstPartner(state, deps, 'MOVE_THUNDER_WAVE')
    expect(result.score).toBe(70)
    expect(result.unmodelled).toContain(DBL43_NOTE)
  })

  it('draws no rng', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_THUNDER_WAVE', null, null, null],
      partnerAbility: 'ABILITY_MOTOR_DRIVE',
    })
    const rng = scriptedRng([])
    state.rng = rng
    expect(scoreAgainstPartner(state, deps, 'MOVE_THUNDER_WAVE').score).toBe(101)
    expect(rng.calls).toBe(0)
  })
})

describe('Volt Absorb / Earth Eater / Water Absorb / Dry Skin (:2309-2314, :2324-2329)', () => {
  it('Volt Absorb: -10 without AI_FLAG_HP_AWARE, falls through to -30 with it', () => {
    const without = partnerFixture({ aiMoves: ['MOVE_THUNDER_WAVE', null, null, null], partnerAbility: 'ABILITY_VOLT_ABSORB' })
    clearHpAware(without.state)
    expect(scoreAgainstPartner(without.state, without.deps, 'MOVE_THUNDER_WAVE').score).toBe(90)

    const withFlag = partnerFixture({ aiMoves: ['MOVE_THUNDER_WAVE', null, null, null], partnerAbility: 'ABILITY_VOLT_ABSORB' })
    expect(withFlag.state.aiFlags & AI_FLAG_HP_AWARE).toBe(AI_FLAG_HP_AWARE)
    expect(scoreAgainstPartner(withFlag.state, withFlag.deps, 'MOVE_THUNDER_WAVE').score).toBe(70)
  })

  it('Earth Eater: -10 without AI_FLAG_HP_AWARE on a Ground move', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_SAND_ATTACK', null, null, null], partnerAbility: 'ABILITY_EARTH_EATER' })
    clearHpAware(state)
    expect(scoreAgainstPartner(state, deps, 'MOVE_SAND_ATTACK').score).toBe(90)
  })

  it('Water Absorb and Dry Skin: -10 without AI_FLAG_HP_AWARE on a Water move', () => {
    for (const ability of ['ABILITY_WATER_ABSORB', 'ABILITY_DRY_SKIN']) {
      const { state, deps } = partnerFixture({ aiMoves: ['MOVE_SOAK', null, null, null], partnerAbility: ability })
      clearHpAware(state)
      expect(scoreAgainstPartner(state, deps, 'MOVE_SOAK').score).toBe(90)
    }
  })
})

describe('Motor Drive (:2315-2319)', () => {
  it('+1 for an Electric move while Speed can rise; -30 at MAX_STAT_STAGE', () => {
    const rise = partnerFixture({ aiMoves: ['MOVE_THUNDER_WAVE', null, null, null], partnerAbility: 'ABILITY_MOTOR_DRIVE' })
    expect(scoreAgainstPartner(rise.state, rise.deps, 'MOVE_THUNDER_WAVE').score).toBe(101)

    const maxed = partnerFixture({ aiMoves: ['MOVE_THUNDER_WAVE', null, null, null], partnerAbility: 'ABILITY_MOTOR_DRIVE' })
    setStatStage(maxed.state, 1, STAT_SPEED, MAX_STAT_STAGE)
    expect(scoreAgainstPartner(maxed.state, maxed.deps, 'MOVE_THUNDER_WAVE').score).toBe(70)
  })

  it('-30 for a non-Electric move', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_SCREECH', null, null, null], partnerAbility: 'ABILITY_MOTOR_DRIVE' })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SCREECH').score).toBe(70)
  })
})

describe('Lightning Rod (:2320-2323)', () => {
  it('+1 for an Electric move when the partner is special and Sp. Atk can rise', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_THUNDER_WAVE', null, null, null],
      partnerMoves: ['MOVE_SURF', null, null, null],
      partnerAbility: 'ABILITY_LIGHTNING_ROD',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_THUNDER_WAVE').score).toBe(101)
  })

  it('-30 when the partner has only physical moves', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_THUNDER_WAVE', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
      partnerAbility: 'ABILITY_LIGHTNING_ROD',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_THUNDER_WAVE').score).toBe(70)
  })
})

describe('Reservoir / Storm Drain (:2325-2329)', () => {
  it('+1 for a Water move when the partner is special and Sp. Atk can rise', () => {
    for (const ability of ['ABILITY_RESERVOIR', 'ABILITY_STORM_DRAIN']) {
      const { state, deps } = partnerFixture({
        aiMoves: ['MOVE_SOAK', null, null, null],
        partnerMoves: ['MOVE_SURF', null, null, null],
        partnerAbility: ability,
      })
      expect(scoreAgainstPartner(state, deps, 'MOVE_SOAK').score).toBe(101)
    }
  })
})

describe('Water Compaction (:2330-2334)', () => {
  it('+1 for a Water move with a WEAK result; the -10 fall-through for anything else', () => {
    const water = partnerFixture({ aiMoves: ['MOVE_SOAK', null, null, null], partnerAbility: 'ABILITY_WATER_COMPACTION' })
    expect(scoreAgainstPartner(water.state, water.deps, 'MOVE_SOAK').score).toBe(101)

    const other = partnerFixture({ aiMoves: ['MOVE_THUNDER_WAVE', null, null, null], partnerAbility: 'ABILITY_WATER_COMPACTION' })
    expect(scoreAgainstPartner(other.state, other.deps, 'MOVE_THUNDER_WAVE').score).toBe(90)
  })
})

describe('Flash Fire (:2335-2341)', () => {
  function flashFireFixture() {
    return partnerFixture({
      aiMoves: ['MOVE_WILL_O_WISP', null, null, null],
      partnerMoves: ['MOVE_FLAMETHROWER', null, null, null],
      partnerAbility: 'ABILITY_FLASH_FIRE',
    })
  }

  it('+1 for a Fire move when the partner has a Fire move and its flashFire flag is clear', () => {
    const { state, deps } = flashFireFixture()
    expect(scoreAgainstPartner(state, deps, 'MOVE_WILL_O_WISP').score).toBe(101)
  })

  it('-30 when the partner already has the flashFire flag', () => {
    const { state, deps } = flashFireFixture()
    state.battlers[1]!.volatiles.flashFire = true
    expect(scoreAgainstPartner(state, deps, 'MOVE_WILL_O_WISP').score).toBe(70)
  })

  it('-30 when the partner holds an item whose holdEffects param is HOLD_EFFECT_MEGA_STONE', () => {
    const { state, deps } = flashFireFixture()
    state.battlers[1]!.mon.itemId = SYNTH_MEGA_PARAM
    expect(scoreAgainstPartner(state, withMegaStoneParamItem(deps), 'MOVE_WILL_O_WISP').score).toBe(70)
  })
})

describe('Sap Sipper (:2342-2346)', () => {
  it('+1 for a Grass move when the partner is physical and Attack can rise', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_LEECH_SEED', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
      partnerAbility: 'ABILITY_SAP_SIPPER',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_LEECH_SEED').score).toBe(101)
  })
})

describe('Justified / Rattled (:2347-2358)', () => {
  it('Justified: +1 for a damaging Dark move; the faint check can never fail because Justified absorbs Dark', () => {
    const mk = () =>
      partnerFixture({
        aiMoves: ['MOVE_BITE', null, null, null],
        partnerMoves: ['MOVE_TACKLE', null, null, null],
        partnerAbility: 'ABILITY_JUSTIFIED',
      })

    const safe = mk()
    safe.state.battlers[1]!.mon.maxHp = 1000
    safe.state.battlers[1]!.mon.hp = 1000
    expect(scoreAgainstPartner(safe.state, withDiscouragedEffect(safe.deps, 'MOVE_BITE'), 'MOVE_BITE').score).toBe(101)

    // ER's Justified is an onAbsorb ability (`src/abilities.cc:2177`,
    // abilities/impl/25-absorb.ts:49): a Dark move deals 0 to the holder, so
    // CanIndexMoveFaintTarget is false even at 1 HP and the C's `!` never trips.
    const lowHp = mk()
    lowHp.state.battlers[1]!.mon.hp = 1
    expect(scoreAgainstPartner(lowHp.state, withDiscouragedEffect(lowHp.deps, 'MOVE_BITE'), 'MOVE_BITE').score).toBe(101)
  })

  it('Rattled: +1 for a damaging Dark move that cannot faint the partner; -30 when it can', () => {
    const mk = () =>
      partnerFixture({
        aiMoves: ['MOVE_BITE', null, null, null],
        partnerAbility: 'ABILITY_RATTLED',
      })

    const safe = mk()
    safe.state.battlers[1]!.mon.maxHp = 1000
    safe.state.battlers[1]!.mon.hp = 1000
    expect(scoreAgainstPartner(safe.state, withDiscouragedEffect(safe.deps, 'MOVE_BITE'), 'MOVE_BITE').score).toBe(101)

    const faint = mk()
    faint.state.battlers[1]!.mon.hp = 1 // CanIndexMoveFaintTarget is now true
    expect(scoreAgainstPartner(faint.state, withDiscouragedEffect(faint.deps, 'MOVE_BITE'), 'MOVE_BITE').score).toBe(70)
  })
})

describe('Contrary / Contempt / Defiant / Competitive (:2359-2374)', () => {
  it('Contrary: +2 for a stat-lowering effect', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_SCREECH', null, null, null], partnerAbility: 'ABILITY_CONTRARY' })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SCREECH').score).toBe(102)
  })

  it('Defiant: +1 when Attack can rise', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_SCREECH', null, null, null], partnerAbility: 'ABILITY_DEFIANT' })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SCREECH').score).toBe(101)
  })

  it('Competitive: +1 when Sp. Atk can rise', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_SCREECH', null, null, null], partnerAbility: 'ABILITY_COMPETITIVE' })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SCREECH').score).toBe(101)
  })

  it('Contempt follows the Defiant arm', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_SCREECH', null, null, null], partnerAbility: 'ABILITY_CONTEMPT' })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SCREECH').score).toBe(101)
  })
})

describe('gates (:2306)', () => {
  it('partner chose Protect: the ability loop is skipped', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_THUNDER_WAVE', null, null, null],
      partnerMoves: ['MOVE_PROTECT', null, null, null],
      partnerChosen: 0,
      partnerAbility: 'ABILITY_VOLT_ABSORB',
    })
    clearHpAware(state)
    const result = scoreAgainstPartner(state, deps, 'MOVE_THUNDER_WAVE')
    expect(result.score).toBe(70)
    expect(result.unmodelled).toContain(DBL43_NOTE)
  })

  it('a move whose own data target is BOTH skips the ability loop', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_COTTON_SPORE', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
      partnerAbility: 'ABILITY_SAP_SIPPER',
    })
    expect(data.moveData('MOVE_COTTON_SPORE')?.target).toBe('BOTH')
    expect(scoreAgainstPartner(state, deps, 'MOVE_COTTON_SPORE').score).toBe(70)
  })

  it('Mold Breaker (deps.grounding.attackerHasMoldBreaker) skips the loop via DoesBattlerIgnoreAbilityChecks', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_THUNDER_WAVE', null, null, null], partnerAbility: 'ABILITY_VOLT_ABSORB' })
    clearHpAware(state)
    const moldBreakerDeps: AiDamageDeps = { ...deps, grounding: { ...deps.grounding, attackerHasMoldBreaker: true } }
    expect(scoreAgainstPartner(state, moldBreakerDeps, 'MOVE_THUNDER_WAVE').score).toBe(70)
  })

  it('a Gastro Acid-suppressed partner ability slot is skipped', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_THUNDER_WAVE', null, null, null], partnerAbility: 'ABILITY_VOLT_ABSORB' })
    clearHpAware(state)
    state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID
    expect(scoreAgainstPartner(state, deps, 'MOVE_THUNDER_WAVE').score).toBe(70)
  })
})

describe('slot order', () => {
  it('an innate slot is read like the main slot', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_THUNDER_WAVE', null, null, null],
      partnerAbility: 'ABILITY_BLAZE',
      partnerInnates: ['ABILITY_MOTOR_DRIVE', null, null],
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_THUNDER_WAVE').score).toBe(101)
  })

  it('the first matching slot returns: Contrary (ability) wins over Motor Drive (innate)', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_EERIE_IMPULSE', null, null, null],
      partnerAbility: 'ABILITY_CONTRARY',
      partnerInnates: ['ABILITY_MOTOR_DRIVE', null, null],
    })
    // Eerie Impulse is ELECTRIC and lowers Sp. Atk (EFFECT_SPECIAL_ATTACK_DOWN_2),
    // so both slots match; Contrary is slot 0 and returns +2 before Motor Drive's +1.
    expect(scoreAgainstPartner(state, deps, 'MOVE_EERIE_IMPULSE').score).toBe(102)
  })
})
