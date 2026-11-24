/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 944: infrastructure for the solver-v2 role policies (Step 2.0a).
// Everything here exercises NEW pure helpers; the only production behaviour this
// file touches is aiCalcDamage.ts's additive `masked` parameter, whose default
// keeps every existing AI caller byte-identical.
//
// Two fixtures below deviate from the brief's prose because the pinned
// data/v2.65beta snapshot disagrees with it (see REPORT.md):
//  - MOVE_GROWL is a 60-power SPECIAL attack here (`EFFECT_ATTACK_DOWN_HIT`),
//    not a status move, so the no-progress fixtures use MOVE_CELEBRATE
//    (`EFFECT_DO_NOTHING`, power 0).
//  - The stall fixture uses MOVE_NIGHTMARE on an awake target: EFFECT_NIGHTMARE's
//    pre-hit gate fails before ppreduce (hitScripts.ts, BattleScript_EffectNightmare),
//    so the move never deals damage and never spends PP, which is what lets a
//    battle loop run to a turn cap instead of ending in a faint.
import { describe, expect, it } from 'vitest'

import { STATUS3_PERISH_SONG } from './constants'
import { aiCalcDamage, aiDamageRolls } from './ai/aiCalcDamage'
import type { PlayerMonSpec } from './driver/buildParty'
import { buildPlayerParty } from './driver/buildParty'
import { legalChoices, playExpectimaxBattle } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { guaranteedKo, ourDamageRange, pivotMoves, possibleKo, predictAi } from './driver/policyInputs'
import { playPolicyBattle } from './driver/policyBattle'
import { aiDamageDepsFor, createSession } from './driver/session'
import type { BattleSession } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState } from './state'

const data = loadSimData()

const mon = (species: string, moves: string[]): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
})

const parties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })

const opponent = (mons: TrainerMonData[], overrides: Partial<TrainerData> = {}): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  noSwitching: true,
  parties: parties(mons),
  ...overrides,
})

function session(playerMons: PlayerMonSpec[], foeMons: TrainerMonData[], overrides: Partial<TrainerData> = {}): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons, overrides),
    rng: createRandomSource(1),
  })
}

/** Writes a patch on both copies of a party slot (the active battler's mon and
 * the party mon), the shape a test needs for item/hp/stat overrides. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const oneSnorlax = (moves: string[]): PlayerMonSpec[] => [{ species: 'SPECIES_SNORLAX', level: 50, moves }]

describe('cycle 944 - ourDamageRange vs the AI number', () => {
  it('returns all 16 rolls, ascending, bracketing the AI blended number', () => {
    const s = session(oneSnorlax(['MOVE_BODY_SLAM']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    const deps = aiDamageDepsFor(s.data, s.state)
    const range = ourDamageRange(s, 'MOVE_BODY_SLAM', 0, 1)!
    expect(range.rolls).toHaveLength(16)
    for (let i = 1; i < range.rolls.length; i++) {
      expect(range.rolls[i]!).toBeGreaterThanOrEqual(range.rolls[i - 1]!)
    }
    const ai = aiCalcDamage(s.state, 'MOVE_BODY_SLAM', 0, 1, deps)
    // AI_CalcDamage blends the max roll with the crit roll:
    // idiv(critDmg + normalDmg * (critChance - 1), critChance), so the answer
    // sits between rolls[15] and critRolls[15].
    expect(range.rolls[15]!).toBeLessThanOrEqual(ai.dmg)
    if (range.critRolls) expect(ai.dmg).toBeLessThanOrEqual(range.critRolls[15]!)
    else expect(ai.dmg).toBe(range.rolls[15]!)
    // A power-0 status move is null (move.power gate), not a zero-damage result.
    expect(ourDamageRange(s, 'MOVE_CELEBRATE', 0, 1)).toBeNull()
    expect(aiDamageRolls(s.state, 'MOVE_NOT_A_MOVE', 0, 1, deps)).toBeNull()
  })

  it('differs from aiCalcDamage when our held item boosts the move (AI masks it)', () => {
    const s = session(oneSnorlax(['MOVE_BODY_SLAM']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    const deps = aiDamageDepsFor(s.data, s.state)
    const plainRange = ourDamageRange(s, 'MOVE_BODY_SLAM', 0, 1)!
    const plainAi = aiCalcDamage(s.state, 'MOVE_BODY_SLAM', 0, 1, deps).dmg
    // itemEffects[0] === 0 means the AI has never observed our item, so
    // maskBattlerMonForAi blanks the Choice Band for its own estimate.
    expect(s.state.battleHistory.itemEffects[0]).toBe(0)
    patchMon(s.state, 0, 0, { itemId: 'ITEM_CHOICE_BAND' })
    const bandRange = ourDamageRange(s, 'MOVE_BODY_SLAM', 0, 1)!
    const bandAi = aiCalcDamage(s.state, 'MOVE_BODY_SLAM', 0, 1, deps).dmg
    const ratio = bandRange.rolls[15]! / plainRange.rolls[15]!
    expect(ratio).toBeGreaterThan(1.4)
    expect(ratio).toBeLessThan(1.6)
    // The AI's own number is the item-less one: the band is still concealed.
    expect(bandAi).toBe(plainAi)
  })
})

describe('cycle 944 - KO helpers', () => {
  it('guaranteedKo needs the worst roll; possibleKo needs the best', () => {
    const s = session(oneSnorlax(['MOVE_BODY_SLAM']), [mon('SPECIES_SNORLAX', ['MOVE_CELEBRATE'])])
    const range = ourDamageRange(s, 'MOVE_BODY_SLAM', 0, 1)!
    expect(range.rolls[0]!).toBeLessThan(range.rolls[15]!)
    expect(guaranteedKo(range, range.rolls[0]!)).toBe(true)
    expect(guaranteedKo(range, range.rolls[15]!)).toBe(false)
    expect(possibleKo(range, range.rolls[15]!)).toBe(true)
    expect(guaranteedKo(range, range.rolls[15]! + 1)).toBe(false)
    expect(possibleKo(range, range.rolls[15]! + 1)).toBe(false)
  })
})

describe('cycle 944 - predictAi', () => {
  it('samples n actions and never advances the real session', () => {
    const s = session(oneSnorlax(['MOVE_TACKLE']), [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])])
    const twin = session(oneSnorlax(['MOVE_TACKLE']), [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])])
    const { rng, ...rest } = s.state
    void rng
    const before = structuredClone(rest)

    const predictions = predictAi(s, 3, 12345)
    expect(predictions).toHaveLength(3)
    expect(predictions.map((p) => p.seed)).toEqual([
      12345,
      (12345 + 0x9e3779b1) >>> 0,
      (12345 + 2 * 0x9e3779b1) >>> 0,
    ])
    for (const p of predictions) expect(p.action?.action).toBe('USE_MOVE')

    const { rng: rngAfter, ...restAfter } = s.state
    void rngAfter
    expect(structuredClone(restAfter)).toEqual(before)
    // The real generator is untouched: it draws the same stream as an identical
    // session that never called predictAi.
    for (let i = 0; i < 5; i++) {
      expect(s.state.rng.random16()).toBe(twin.state.rng.random16())
    }
  })

  it('resolves the switch slot when the AI is forced out (Perish Song)', () => {
    const s = session(
      oneSnorlax(['MOVE_TACKLE']),
      [mon('SPECIES_MACHAMP', ['MOVE_TACKLE']), mon('SPECIES_SNORLAX', ['MOVE_TACKLE'])],
      { noSwitching: false },
    )
    // ShouldSwitchIfPerishSong (aiShouldSwitch.ts): deterministic, no RNG, and
    // reached before getMostSuitableMonToSwitchInto, so the AI must switch.
    s.state.battlers[1]!.statuses3 |= STATUS3_PERISH_SONG
    s.state.battlers[1]!.volatiles.perishSongTimer = 0
    const [prediction] = predictAi(s, 1, 7)
    expect(prediction!.action?.action).toBe('SWITCH')
    expect(prediction!.switchSlot).toBe(1)

    // Negative case: a fixture that does not force a switch reports no slot.
    const quiet = session(oneSnorlax(['MOVE_TACKLE']), [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])], {
      noSwitching: false,
    })
    const [quietPrediction] = predictAi(quiet, 1, 7)
    expect(quietPrediction!.action?.action).toBe('USE_MOVE')
    expect(quietPrediction!.switchSlot).toBeNull()
  })
})

describe('cycle 944 - pivotMoves', () => {
  it('lists exactly the 12 pivot moves in the pinned snapshot', () => {
    expect(pivotMoves(data)).toEqual([
      'MOVE_BATON_PASS',
      'MOVE_CHILLY_RECEPTION',
      'MOVE_FLIP_TURN',
      'MOVE_FLUTTERING_LEAF',
      'MOVE_PARTING_SHOT',
      'MOVE_SAFE_PASSAGE',
      'MOVE_SEPTIC_SWITCH',
      'MOVE_SHED_TAIL',
      'MOVE_TAKE_FLIGHT',
      'MOVE_TELEPORT',
      'MOVE_U_TURN',
      'MOVE_VOLT_SWITCH',
    ])
  })
})

describe('cycle 944 - playPolicyBattle', () => {
  /** The first legal move choice; MOVE_NIGHTMARE against an awake target fails
   * before ppreduce, so this stalls without spending PP or dealing damage. */
  const stallPolicy = (s: BattleSession) =>
    legalChoices(s).find((c) => c.action.action === 'USE_MOVE') ?? null

  const stallOptions = () => ({
    data,
    playerParty: buildPlayerParty(oneSnorlax(['MOVE_NIGHTMARE']), 50, data),
    opponentTrainer: opponent([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])]),
    seed: 5,
  })

  it('a stalling policy runs to the 200-turn default cap', () => {
    const result = playPolicyBattle({ ...stallOptions(), policy: stallPolicy })
    expect(result.outcome).toBe('MAX_TURNS')
    expect(result.turns).toBe(200)
    expect(result.capped).toBe(true)
    expect(result.trace).toEqual([]) // the loop itself pushes nothing
  })

  it('honours an explicit maxTurns', () => {
    const result = playPolicyBattle({ ...stallOptions(), policy: stallPolicy, maxTurns: 5 })
    expect(result.turns).toBe(5)
    expect(result.capped).toBe(true)
  })

  it('an attacking policy wins against a trivial 1-HP foe', () => {
    const result = playPolicyBattle({
      data,
      playerParty: buildPlayerParty(oneSnorlax(['MOVE_TACKLE']), 50, data),
      opponentTrainer: opponent([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])]),
      seed: 9,
      policy: (s, turn) => {
        if (turn === 1) patchMon(s.state, 1, 0, { hp: 1 })
        return legalChoices(s).find((c) => c.action.action === 'USE_MOVE') ?? null
      },
    })
    expect(result.outcome).toBe('WON')
    expect(result.capped).toBe(false)
    expect(result.turns).toBeLessThan(200)
  })

  it('a USE_MOVE choice carrying switchTo performs the pivot switch', () => {
    const result = playPolicyBattle({
      data,
      playerParty: buildPlayerParty(
        [
          { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_U_TURN'] },
          { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
        ],
        50,
        data,
      ),
      opponentTrainer: opponent([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])]),
      seed: 3,
      maxTurns: 1,
      policy: (s, turn) => {
        // Keep the foe alive so the U-turn pivot branch (sumHpDealt > 0, foe
        // still alive, live reserve) actually runs.
        if (turn === 1) patchMon(s.state, 1, 0, { hp: 9999, maxHp: 9999 })
        const choice = legalChoices(s).find(
          (c) => c.action.action === 'USE_MOVE' && c.action.chosenMove?.id === 'MOVE_U_TURN',
        )
        return choice ? { ...choice, switchTo: 1 } : null
      },
    })
    expect(result.session.state.battlers[0]!.partyIndex).toBe(1)
  })
})

describe('cycle 944 - expectimax defaults are untouched', () => {
  const stallOptions = () => ({
    data,
    playerParty: buildPlayerParty(oneSnorlax(['MOVE_NIGHTMARE']), 50, data),
    opponentTrainer: opponent([mon('SPECIES_MACHAMP', ['MOVE_CELEBRATE'])]),
    seed: 11,
  })

  it('accepts maxTurns: 200 without changing its 60 default', () => {
    const capped = playExpectimaxBattle({ ...stallOptions(), maxTurns: 200 })
    expect(capped.turns).toBe(200)
    expect(capped.outcome).toBe('MAX_TURNS')
    const defaulted = playExpectimaxBattle(stallOptions())
    expect(defaulted.turns).toBe(60)
    expect(defaulted.outcome).toBe('MAX_TURNS')
  })
})
