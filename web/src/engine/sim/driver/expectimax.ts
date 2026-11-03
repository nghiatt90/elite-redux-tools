// Expectimax player policy.
//
// The opponent's AI decides from the state at the START of a turn, before it sees the
// player's choice, so its action distribution does not depend on what the player does.
// That lets one set of sampled opponent actions be shared by every candidate player action
// (common random numbers: the same sampled action AND the same generator seed per sample),
// which both cuts the cost and removes most of the noise between candidates.
//
//   value(state, depth) = max over player choices of  mean over samples of  value(next, depth - 1)
//
// Leaves are scored by `evaluateState`. A player choice is a move (mega-evolving whenever the
// game allows it) or a voluntary switch to a live party member.

import { chooseAiAction } from '../ai/chooseAiAction'
import { getMostSuitableMonToSwitchInto } from '../ai/aiSwitching'
import {
  CHOICE_HOLD_EFFECTS,
  PARTY_SIZE,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_COUNTER,
  STATUS1_TOXIC_POISON,
  getCounter,
  hasFlag,
} from '../constants'
import { createRandomSource } from '../rng'
import { battlerHasSimAbility } from '../statBuffs'
import type { BattleState } from '../state'
import type { ChosenAction } from '../turnOrder'
import { aiDamageDepsFor, buildMoveAction, cloneSession, beginTurn, createSession, firstLiveReplacement, holdEffectOfBattler, stepTurn, type BattleSession } from './session'
import type { SimDataBundle } from './loadSimData'

export interface ExpectimaxOptions {
  /** Plies of lookahead. 1 = score the position after one turn. */
  depth: number
  /** Sampled (opponent action, generator seed) pairs at the root. */
  samples: number
  /** Samples used at plies below the root. */
  innerSamples: number
  /** A switch must beat the best move by at least this much to be chosen. */
  switchMargin: number
  /** Add the status1 residual/tempo term to the leaf score (see `statusScore`). Off by default. */
  statusTerms?: boolean
}

export const DEFAULT_EXPECTIMAX: ExpectimaxOptions = { depth: 1, samples: 6, innerSamples: 2, switchMargin: 0.05 }

export interface PlayerChoice {
  action: ChosenAction
  /** Party slot for a voluntary switch. */
  switchTo?: number
}

function hpFraction(hp: number, maxHp: number): number {
  return maxHp > 0 ? hp / maxHp : 0
}

function sideScore(state: BattleState, side: 0 | 1): { hp: number; alive: number; stages: number } {
  const active = state.battlers[side]
  const party = state.sides[side].party
  let hp = 0
  let alive = 0
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (!mon || mon.speciesId === null) continue
    const isActive = active !== null && active !== undefined && active.partyIndex === i
    const curHp = isActive ? active.mon.hp : mon.hp
    const maxHp = isActive ? active.mon.maxHp : mon.maxHp
    hp += hpFraction(curHp, maxHp)
    if (curHp > 0) alive++
  }
  let stages = 0
  if (active && active.mon.hp > 0) {
    // atk, def, spatk, spdef, speed (indices 1..5 of the 8 stat stages) relative to the neutral 6
    for (let s = 1; s <= 5; s++) stages += Math.max(-6, Math.min(6, (active.mon.statStages[s] ?? 6) - 6))
  }
  return { hp, alive, stages }
}

/** Static score of a position from the player's side: higher is better for the player.
 * `options.statusTerms` opts into the status1 residual/tempo term; when falsy the
 * result is exactly `positionScore` (or the terminal +-100), as before. */
export function evaluateState(state: BattleState, options?: ExpectimaxOptions): number {
  if (state.battleOutcome === 'WON') return 100
  if (state.battleOutcome === 'LOST') return -100
  return positionScore(state) + (options?.statusTerms ? statusScore(state) : 0)
}

// ---------------------------------------------------------------------------
// status1 term
//
// `positionScore` only knows HP, alive count and stat stages, so Spore,
// Will-O-Wisp and Thunder Wave score as free actions. `statusScore` values the
// residual damage and the actions/tempo a status costs, in the same
// HP-fraction units as `positionScore`, so the two add.
//
// The weights are expected HP-fraction-equivalents lost over a short horizon.
// STATUS_HORIZON_TURNS, ACTION_VALUE and PARALYSIS_SPEED_VALUE are MODEL
// CHOICES, not constants in the C; each individual damage fraction and the
// conditions below are transcribed from the cited C lines.
// ---------------------------------------------------------------------------

/** Model horizon: how many end-of-turn ticks / actions the term looks ahead. MODEL CHOICE. */
const STATUS_HORIZON_TURNS = 3
/** HP-fraction-equivalent value of one lost action. MODEL CHOICE. */
const ACTION_VALUE = 0.25
/** Burn's Attack halving (`statBase /= 2`, battle_util.c:7135) is worth half of one
 * action's damage output. Only the active mon pays it: the halving applies to a
 * mon's own move, so charging a reserve mon would value damage it is not
 * dealing; it also vanishes when the mon switches out. MODEL CHOICE flat weight. */
const BURN_ATTACK_HALF_VALUE = ACTION_VALUE / 2
/** Paralysis halves Speed (battle_main.c:4185-4186, `speed /= 2` when
 * `B_PARALYSIS_SPEED >= GEN_7` and not Quick Feet). Value of that lost speed is
 * a MODEL CHOICE flat weight; the /2 itself is the C's. */
const PARALYSIS_SPEED_VALUE = 0.25
/** CANCELLER_FROZEN (battle_util.c:3249-3260): `if (Random() % 5)` keeps the mon
 * frozen, the else branch thaws it, so one attempt thaws with probability 1/5. */
const FREEZE_THAW_CHANCE = 1 / 5

/** End-of-turn chip for one status, as an HP fraction over the horizon.
 * `divisor` is the C's `maxHP / 16` (burn/frostbite/bleed) or `/ 8` (poison);
 * the C's `if (gBattleMoveDamage == 0) gBattleMoveDamage = 1` floor is kept. */
function statusChipFraction(maxHp: number, divisor: number): number {
  if (maxHp <= 0) return 0
  const perTurn = Math.max(1, Math.trunc(maxHp / divisor))
  return (perTurn / maxHp) * STATUS_HORIZON_TURNS
}

/** Toxic: `gBattleMoveDamage = maxHP / 16; ... = (status1 & STATUS1_TOXIC_COUNTER) * gBattleMoveDamage >> 8`
 * (battle_util.c:2538-2540). The C increments the counter first, capped at 15
 * (`!= STATUS1_TOXIC_TURN(15)`, :2532-2533), so the horizon's ticks are
 * current+1 .. current+3, each capped. The field itself is counter << 8, which
 * is why the multiply-then-shift leaves counter * (maxHP / 16). */
function statusToxicFraction(maxHp: number, status1: number): number {
  if (maxHp <= 0) return 0
  const current = getCounter(status1, STATUS1_TOXIC_COUNTER)
  const perTick = Math.max(1, Math.trunc(maxHp / 16))
  let damage = 0
  for (let tick = 1; tick <= STATUS_HORIZON_TURNS; tick++) {
    const counter = Math.min(15, current + tick)
    damage += ((counter << 8) * perTick) >> 8 // gBattleMoveDamage, :2540
  }
  return damage / maxHp
}

/** The HP-fraction-equivalent cost of `mon`'s status1. `isActive` gates the
 * tempo terms (sleep/paralysis/freeze/burn's Attack drop): a benched mon only
 * acts after a switch-in, so those terms are deliberately 0 for it (there is no
 * C rule charging a reserve mon for them). A fainted mon contributes 0.
 *
 * Not modelled here: Magic Guard / TakesNoBurnDamage (`IsMagicGuardProtected`,
 * `takesNoBurnDamage`) and Poison Heal. Both need the battler's ability slots,
 * which this function does not take; see REPORT.md. */
export function statusMonValue(mon: { status1: number; hp: number; maxHp: number }, isActive: boolean): number {
  if (mon.hp <= 0 || mon.maxHp <= 0) return 0
  const { status1 } = mon
  let value = 0
  if (hasFlag(status1, STATUS1_BURN)) {
    // ENDTURN_BURN, battle_util.c:2573-2582: maxHP / 16 (B_BURN_DAMAGE >= GEN_7), min 1.
    value += statusChipFraction(mon.maxHp, 16)
    // `statBase /= 2` for a burned physical attacker, battle_util.c:7135.
    if (isActive) value += BURN_ATTACK_HALF_VALUE
  }
  if (hasFlag(status1, STATUS1_POISON)) {
    // ENDTURN_POISON, battle_util.c:2492-2511 (the non-Poison-Heal branch): maxHP / 8.
    value += statusChipFraction(mon.maxHp, 8)
  }
  if (hasFlag(status1, STATUS1_TOXIC_POISON)) {
    // ENDTURN_BAD_POISON, battle_util.c:2516-2544.
    value += statusToxicFraction(mon.maxHp, status1)
  }
  if (hasFlag(status1, STATUS1_FROSTBITE)) {
    // ENDTURN_FROSTBITE, battle_util.c:2584-2596: maxHP / 16 with B_BURN_DAMAGE >= GEN_7.
    value += statusChipFraction(mon.maxHp, 16)
  }
  if (hasFlag(status1, STATUS1_BLEED)) {
    // ENDTURN_BLEED, battle_util.c:2598-2606: BLEED_DAMAGE(maxHP) = maxHP / 16
    // (include/constants/battle.h:142), min 1.
    value += statusChipFraction(mon.maxHp, 16)
  }
  if (isActive && hasFlag(status1, STATUS1_PARALYSIS)) {
    // CANCELLER_PARALYSED, battle_util.c:3404: `(Random() % 4) == 0` cancels the
    // action, so 25% of this mon's actions are lost, plus the halved Speed above.
    value += 0.25 * STATUS_HORIZON_TURNS * ACTION_VALUE + PARALYSIS_SPEED_VALUE
  }
  if (isActive && hasFlag(status1, STATUS1_SLEEP)) {
    // CANCELLER_ASLEEP, battle_util.c:3209-3240: each move attempt subtracts 1
    // (2 with Early Bird) and the mon wakes when the counter would drop below
    // that, so `counter` action attempts are lost, capped by the horizon.
    const counter = getCounter(status1, STATUS1_SLEEP)
    value += Math.min(counter, STATUS_HORIZON_TURNS) * ACTION_VALUE
  }
  if (isActive && hasFlag(status1, STATUS1_FREEZE)) {
    // CANCELLER_FROZEN, battle_util.c:3249-3260: each attempt thaws 1/5 of the
    // time, so each horizon turn is lost with probability 1 - 1/5.
    value += STATUS_HORIZON_TURNS * ACTION_VALUE * (1 - FREEZE_THAW_CHANCE)
  }
  return value
}

/** Sum of `statusMonValue` over one side's living mons, reading the active
 * battler's copy for the active slot and the party copy for the rest -- the
 * same split `sideScore` uses, because status1 persists across switches. */
function sideStatusScore(state: BattleState, side: 0 | 1): number {
  const active = state.battlers[side]
  const party = state.sides[side].party
  let total = 0
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (!mon || mon.speciesId === null) continue
    const isActive = active !== null && active !== undefined && active.partyIndex === i
    const cur = isActive ? active.mon : mon
    if (cur.hp <= 0) continue
    total += statusMonValue({ status1: cur.status1, hp: cur.hp, maxHp: cur.maxHp }, isActive)
  }
  return total
}

/** Status burden from the player's side: higher is better for the player (the
 * foe's burden minus the player's), the same orientation as `positionScore`. */
export function statusScore(state: BattleState): number {
  return sideStatusScore(state, 1) - sideStatusScore(state, 0)
}

/** The material and boost balance, ignoring whether the battle is already decided. */
export function positionScore(state: BattleState): number {
  const me = sideScore(state, 0)
  const them = sideScore(state, 1)
  return me.hp - them.hp + 0.3 * (me.alive - them.alive) + 0.04 * (me.stages - them.stages)
}

export function legalChoices(session: BattleSession): PlayerChoice[] {
  const { state, data } = session
  const battler = state.battlers[0]
  if (!battler || battler.mon.hp === 0) return []
  const choices: PlayerChoice[] = []
  // An Assault/Tactical Vest holder cannot select a status move (battle_util.c:1571-1578, the player-selection
  // check, and battle_util.c:1651-1653 for the shared filter); MOVE_ME_FIRST is exempt. Both read the hold effect
  // with GetBattlerHoldEffect(battler, TRUE) (battle_util.c:1418), so Klutz/Embargo leave the menu untouched.
  const vestHoldEffect = holdEffectOfBattler(state, 0, data.dataContext)
  const vestBlocksStatus = vestHoldEffect === 'HOLD_EFFECT_ASSAULT_VEST' || vestHoldEffect === 'HOLD_EFFECT_TACTICAL_VEST'
  // TrySetCantSelectMoveBattleScript's choice branch (battle_util.c:1565-1571): a Choice Band/Scarf/Specs
  // holder whose choicedMove is set may only select that move. Both the hold effect and the lock are read
  // exactly as the C reads them: GetBattlerHoldEffect(battler, TRUE) (Klutz/Embargo negate) and
  // gBattleStruct->choicedMove (0/0xFFFF == null). This is a selection-time filter only -- the turn loop,
  // like the C, does not re-validate a move that was already chosen.
  const holdsChoiceItem = vestHoldEffect !== null && CHOICE_HOLD_EFFECTS.includes(vestHoldEffect)
  // TrySetCantSelectMoveBattleScript's "Sage Power and Gorilla Tactics" block (battle_util.c:1585-1596):
  // Discipline, Gorilla Tactics and Sage Power all lock the holder to the recorded choicedMove. All three
  // use BATTLER_HAS_ABILITY (checkMoldBreaker=TRUE); the battler's own ability cannot be mold-broken by
  // itself, so attackerHasMoldBreaker is false. Selection-time filter only, like the Choice branch above.
  const abilityLocksMove =
    battlerHasSimAbility(state, battler, 'ABILITY_DISCIPLINE', true, 0, false, data.dataContext) ||
    battlerHasSimAbility(state, battler, 'ABILITY_GORILLA_TACTICS', true, 0, false, data.dataContext) ||
    battlerHasSimAbility(state, battler, 'ABILITY_SAGE_POWER', true, 0, false, data.dataContext)
  for (let i = 0; i < battler.mon.moves.length; i++) {
    const moveId = battler.mon.moves[i]
    if (moveId && battler.mon.pp[i] > 0) {
      if (vestBlocksStatus && moveId !== 'MOVE_ME_FIRST' && data.dataContext.move(moveId)?.split === 'STATUS') continue
      if (holdsChoiceItem && battler.choicedMove !== null && battler.choicedMove !== moveId) continue
      if (abilityLocksMove && battler.choicedMove !== null && battler.choicedMove !== moveId) continue
      const action = buildMoveAction(state, data, 0, moveId)
      choices.push({ action })
    }
  }
  if (choices.length === 0) choices.push({ action: buildMoveAction(state, data, 0, 'MOVE_STRUGGLE') })

  const party = state.sides[0].party
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (mon && mon.speciesId !== null && mon.hp > 0 && i !== battler.partyIndex) {
      choices.push({ action: { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }, switchTo: i })
    }
  }
  return choices
}

function applyChoice(session: BattleSession, choice: PlayerChoice): void {
  const battler = session.state.battlers[0]
  if (battler) battler.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
}

interface OpponentSample {
  action: ChosenAction | null
  seed: number
}

function sampleOpponent(session: BattleSession, count: number, seedBase: number): OpponentSample[] {
  const samples: OpponentSample[] = []
  for (let k = 0; k < count; k++) {
    const seed = (seedBase + k * 0x9e3779b1) >>> 0
    const probe = cloneSession(session, seed)
    const opp = probe.state.battlers[1]
    const action = opp && opp.mon.hp > 0 ? chooseAiAction(probe.state, 1, probe.chooseAiDeps).action : null
    samples.push({ action, seed })
  }
  return samples
}

function value(session: BattleSession, depth: number, options: ExpectimaxOptions, seedBase: number): number {
  if (session.state.battleOutcome || depth === 0) return evaluateState(session.state, options)
  const choices = legalChoices(session)
  if (choices.length === 0) return evaluateState(session.state, options)
  const samples = sampleOpponent(session, options.innerSamples, seedBase)
  let best = -Infinity
  for (const choice of choices) {
    const v = meanOver(session, choice, samples, depth, options)
    if (v > best) best = v
  }
  return best
}

function meanOver(
  session: BattleSession,
  choice: PlayerChoice,
  samples: OpponentSample[],
  depth: number,
  options: ExpectimaxOptions,
): number {
  let sum = 0
  for (const sample of samples) {
    const next = cloneSession(session, sample.seed)
    applyChoice(next, choice)
    stepTurn(next, choice.action, sample.action)
    sum += value(next, depth - 1, options, sample.seed ^ 0x85ebca6b)
  }
  return sum / samples.length
}

/** Picks the player's action for the coming turn; also sets the switch slot on the real state. */
export function chooseExpectimaxAction(
  session: BattleSession,
  options: ExpectimaxOptions,
  seed: number,
): PlayerChoice | null {
  const choices = legalChoices(session)
  if (choices.length === 0) return null
  if (choices.length === 1) return choices[0]

  const samples = sampleOpponent(session, options.samples, seed)
  let bestMove: { choice: PlayerChoice; v: number } | null = null
  let bestSwitch: { choice: PlayerChoice; v: number } | null = null
  for (const choice of choices) {
    const v = meanOver(session, choice, samples, options.depth, options)
    const slot = choice.switchTo === undefined ? 'move' : 'switch'
    if (slot === 'move') {
      if (!bestMove || v > bestMove.v) bestMove = { choice, v }
    } else if (!bestSwitch || v > bestSwitch.v) {
      bestSwitch = { choice, v }
    }
  }
  if (bestSwitch && (!bestMove || bestSwitch.v > bestMove.v + options.switchMargin)) return bestSwitch.choice
  return bestMove ? bestMove.choice : bestSwitch ? bestSwitch.choice : null
}

/** After a faint the player's replacement comes from the game's own "most suitable mon" heuristic. */
export function createHeuristicPlayerReplacement(data: SimDataBundle): (state: BattleState) => number {
  return (state) => {
    const deps = aiDamageDepsFor(data, state)
    const battler = state.battlers[0]
    if (!battler) return PARTY_SIZE
    const saved = battler.monToSwitchIntoId
    battler.monToSwitchIntoId = PARTY_SIZE
    const result = getMostSuitableMonToSwitchInto(state, 0, deps)
    battler.monToSwitchIntoId = saved
    return result.partyIndex === PARTY_SIZE ? firstLiveReplacement(state) : result.partyIndex
  }
}

export interface ExpectimaxBattleOptions {
  data: SimDataBundle
  playerParty: import('../state').SimPartyMon[]
  opponentTrainer: import('./loadSimData').TrainerData
  tier?: 'ace' | 'elite' | 'hell'
  seed: number
  maxTurns?: number
  expectimax?: ExpectimaxOptions
  battleEvents?: Array<{ event: string; data0: number | null; data1: number | null }>
}

export interface ExpectimaxBattleResult {
  outcome: 'WON' | 'LOST' | 'DREW' | 'MAX_TURNS'
  turns: number
  /** positionScore at the end of the battle. */
  finalScore: number
}

/** Plays one battle with the expectimax policy on the player's side. */
export function playExpectimaxBattle(options: ExpectimaxBattleOptions): ExpectimaxBattleResult {
  const maxTurns = options.maxTurns ?? 60
  const expectimax = options.expectimax ?? DEFAULT_EXPECTIMAX
  const session = createSession({
    data: options.data,
    playerParty: options.playerParty,
    opponentTrainer: options.opponentTrainer,
    tier: options.tier,
    rng: createRandomSource(options.seed),
    playerReplacement: createHeuristicPlayerReplacement(options.data),
    battleEvents: options.battleEvents,
  })
  let turns = 0
  while (!session.state.battleOutcome && turns < maxTurns) {
    turns++
    beginTurn(session)
    const choice = chooseExpectimaxAction(session, expectimax, (options.seed * 31 + turns) >>> 0)
    if (choice) applyChoice(session, choice)
    stepTurn(session, choice ? choice.action : null)
  }
  return { outcome: session.state.battleOutcome ?? 'MAX_TURNS', turns, finalScore: positionScore(session.state) }
}

/** Fraction of `games` seeded battles the player wins. */
export function expectimaxWinRate(options: Omit<ExpectimaxBattleOptions, 'seed'>, games: number, baseSeed: number): number {
  let wins = 0
  for (let g = 0; g < games; g++) {
    if (playExpectimaxBattle({ ...options, seed: baseSeed + g }).outcome === 'WON') wins++
  }
  return wins / games
}
