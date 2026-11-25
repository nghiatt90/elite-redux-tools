/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20gb: the support role's own-boost KO-risk gate (cycle s20g) used to
// count two kinds of opponent move that CANNOT connect with us, because both
// turns it predicts are turns on which WE use a status move (the boost, then
// Baton Pass):
//  - EFFECT_SUCKER_PUNCH fails outright when the target's chosen move has split
//    SPLIT_STATUS (VARIOUS_SUCKER_PUNCH_CHECK, src/battle_script_commands.c:
//    7213-7219; BattleScript_EffectSuckerPunch, data/battle_scripts_1.s:2336-2340);
//  - EFFECT_FAKE_OUT fails outside the attacker's first turn
//    (Cmd_jumpifnotfirstturn, src/battle_script_commands.c:9439-9446;
//    BattleScript_EffectFakeOut, data/battle_scripts_1.s:5932-5934), and
//    `gVolatileStructs[].isFirstTurn` is 2 on switch-in and decremented by
//    TurnValuesCleanUp, so it is 1 on the opening turn and 0 afterwards.
// The fixtures below drive REAL turns through stepTurn, so isFirstTurn is never
// set by hand: fixture 2 plays a turn to get the opponent off its first turn,
// fixture 3 stays on the live first turn. Damage is read from the sim's own
// `aiDamageRolls` and the multiset mirrors damageResolver.ts `resolve`
// (:299-316): the crit is drawn with probability 1/critChanceDenominator (null =
// never, 1 = always), then one of the 16 rolls; a multi-hit move uses the summed
// totalRolls/totalCritRolls. Every KO fraction below is hand-derived from
// `attackRange` in its comment.
import { describe, expect, it } from 'vitest'

import { calcKoChances } from '../kochance'
import type { AiDamageRolls } from './ai/aiCalcDamage'
import { aiDamageRolls } from './ai/aiCalcDamage'
import { DEFAULT_STAT_STAGE, PARTY_SIZE, STAT_SPATK } from './constants'
import { buildPlayerParty } from './driver/buildParty'
import type { PlayerMonSpec } from './driver/buildParty'
import { legalChoices } from './driver/expectimax'
import type { PlayerChoice } from './driver/expectimax'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { predictAi } from './driver/policyInputs'
import type { RoleMemory, RoleName, RoleParams } from './driver/rolePolicy'
import { chooseRoleAction } from './driver/rolePolicy'
import type { BattleSession } from './driver/session'
import { aiDamageDepsFor, beginTurn, createSession, stepTurn } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState } from './state'

const data = loadSimData()

const mon = (species: string, moves: string[], overrides: Partial<TrainerMonData> = {}): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
  ...overrides,
})

const parties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })

const opponent = (mons: TrainerMonData[], overrides: Partial<TrainerData> = {}): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  noSwitching: true,
  parties: parties(mons),
  ...overrides,
})

function session(
  playerMons: PlayerMonSpec[],
  foeMons: TrainerMonData[],
  overrides: Partial<TrainerData> = {},
  seed = 1,
): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty(playerMons, 50, data),
    opponentTrainer: opponent(foeMons, overrides),
    rng: createRandomSource(seed),
  })
}

/** Writes a patch on both copies of a party slot (the active battler's mon and
 * the party mon), the shape a fixture needs for HP/stat/status overrides. */
function patchMon(state: BattleState, side: 0 | 1, partyIndex: number, patch: Record<string, unknown>): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

const memory = (): RoleMemory => ({ turn: 0, lastMove: null })

const moveId = (choice: PlayerChoice): string | null =>
  choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null

/** One turn exactly as `playPolicyBattle` runs it: beginTurn, the policy, the
 * switch-slot write, stepTurn. */
function playTurn(s: BattleSession, role: RoleName, params: RoleParams, mem: RoleMemory): PlayerChoice {
  beginTurn(s)
  const choice = chooseRoleAction(s, role, params, mem)
  s.state.battlers[0]!.monToSwitchIntoId = choice.switchTo ?? PARTY_SIZE
  stepTurn(s, choice.action)
  return choice
}

/** The support under test: a boost move, Baton Pass, a damaging fallback and a
 * live bench slot to pass into. */
const supportTeam = (moves: string[], species = 'SPECIES_SNORLAX'): PlayerMonSpec[] => [
  { species, level: 50, moves },
  { species: 'SPECIES_SNORLAX', level: 50, moves: ['MOVE_TACKLE'] },
]
// Calm Mind = EFFECT_CALM_MIND -> Sp. Atk/Sp. Def +1 (battle_scripts_1.s:6739-6763);
// Baton Pass = EFFECT_BATON_PASS; Body Slam = EFFECT_PARALYZE_HIT, 85 BP.
const CALM_MIND_TEAM = ['MOVE_CALM_MIND', 'MOVE_BATON_PASS', 'MOVE_BODY_SLAM']

/** The sim's equiprobable damage multiset for one move, the shape calcKoChances
 * takes. Mirrors damageResolver.ts `resolve` (:299-316) -- see the file header. */
function koMultiset(range: AiDamageRolls): number[] {
  if (range.isImmune) return [0]
  const nonRolls = range.totalRolls ?? range.rolls
  const critRolls = range.totalRolls ? range.totalCritRolls : range.critRolls
  const non = range.isForcedMinRoll ? [nonRolls[0]!] : nonRolls
  const crit = critRolls === null ? null : range.isForcedMinRoll ? [critRolls[0]!] : critRolls
  const denominator = range.critChanceDenominator
  if (denominator === null || crit === null) return [...non]
  if (denominator === 1) return [...crit]
  const multiset: number[] = []
  for (let i = 0; i < denominator - 1; i++) multiset.push(...non)
  multiset.push(...crit)
  return multiset
}

function koChance(range: AiDamageRolls, hp: number): number {
  if (hp <= 0) return 1
  return calcKoChances(koMultiset(range), hp, 1)[0]?.probability ?? 0
}

function attackRange(s: BattleSession, moveId: string): AiDamageRolls {
  return aiDamageRolls(s.state, moveId, 1, 0, aiDamageDepsFor(data, s.state, s.inverseBattle))!
}

/** P(two independent hits, each drawn from `first`/`second`, total `hp`). */
function twoHitChance(first: AiDamageRolls, second: AiDamageRolls, hp: number): number {
  const a = koMultiset(first)
  const b = koMultiset(second)
  let total = 0
  for (const hit1 of a) total += hit1 >= hp ? 1 : koChanceMultiset(b, hp - hit1)
  return total / a.length
}

function koChanceMultiset(multiset: number[], hp: number): number {
  if (hp <= 0) return 1
  return calcKoChances(multiset, hp, 1)[0]?.probability ?? 0
}

describe('cycle s20gb - a move that cannot hit a status user is not KO risk', () => {
  it('1. a predicted Sucker Punch that would KO us still lets us boost and pass', () => {
    const s = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_SUCKER_PUNCH'])])
    patchMon(s.state, 0, 0, { hp: 37 })
    // Fast enough that check 2's speed clause holds (50 -> 200 raw Speed).
    patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: 200 } })
    const sp = attackRange(s, 'MOVE_SUCKER_PUNCH')
    expect(sp.rolls).toEqual([32, 32, 33, 33, 33, 34, 34, 34, 35, 35, 36, 36, 36, 37, 37, 38])
    expect(sp.critRolls).toEqual([71, 72, 73, 73, 74, 75, 76, 77, 78, 78, 79, 80, 81, 82, 83, 84])
    expect(sp.critChanceDenominator).toBe(24)
    // 23 non-crit copies of each roll + one crit row = 384 equiprobable values.
    // At 37 HP the two 37s (2 x 23 = 46), the 38 (23) and the whole crit row
    // (16) reach it: 85/384 = 22.14% >= 15%.
    expect(koMultiset(sp)).toHaveLength(384)
    expect(koChance(sp, 37)).toBeCloseTo(85 / 384, 12)
    expect(koChance(sp, 37)).toBeGreaterThanOrEqual(0.15)
    // The AI predicts Sucker Punch on every sample, so before this cycle check
    // 1's predicted-move loop refused the boost at 22.14%.
    expect(
      predictAi(s, 3, 0).every((sample) => sample.action?.chosenMove?.id === 'MOVE_SUCKER_PUNCH'),
    ).toBe(true)

    const choice = playTurn(s, 'support', { targetStage: 1 }, memory())
    expect(moveId(choice)).toBe('MOVE_CALM_MIND')
    // Sucker Punch really failed -- VARIOUS_SUCKER_PUNCH_CHECK sees our status
    // move -- so our HP only moved by Snorlax's end-of-turn Self-Sufficient heal
    // of trunc(235 / 16) = 14 (endTurn.ts:1183-1195, abilities.cc:4041-4054):
    // 37 + 14 = 51, while the AI's lastMove records the attempt.
    expect(s.state.battlers[1]!.lastMove).toBe('MOVE_SUCKER_PUNCH')
    expect(s.state.battlers[1]!.mon.hp).toBe(s.state.battlers[1]!.mon.maxHp)
    expect(s.state.battlers[0]!.mon.hp).toBe(51)
    expect(s.state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    // One Calm Mind reaches { targetStage: 1 }, so the next policy turn hands off.
    expect(moveId(playTurn(s, 'support', { targetStage: 1 }, memory()))).toBe('MOVE_BATON_PASS')
    expect(s.state.battlers[0]!.partyIndex).toBe(1)
  })

  it('1b. control: the same HP against a priority move that CAN hit a status user is refused', () => {
    // If the helper skipped every priority move (rather than only the two that
    // fail against a status user), this fixture would boost.
    const s = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BULLET_PUNCH'])])
    patchMon(s.state, 0, 0, { hp: 37 })
    patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: 200 } })
    const bp = attackRange(s, 'MOVE_BULLET_PUNCH')
    expect(bp.rolls).toEqual([24, 24, 25, 25, 25, 26, 26, 26, 26, 27, 27, 27, 28, 28, 28, 29])
    expect(bp.critRolls).toEqual([55, 55, 56, 57, 57, 58, 59, 59, 60, 61, 61, 62, 63, 63, 64, 65])
    expect(bp.critChanceDenominator).toBe(8)
    // Check 1 passes: no non-crit roll reaches 37, and 16 of the 16 crit values
    // do, 16/128 = 12.5% < 15%. Check 2 then refuses: a priority-1 move blocks
    // branch (a) (we never outspeed it with a priority-0 Baton Pass), and two
    // Bullet Punches reach 37 + 14 = 51 with (215 of the 256 non-crit roll
    // pairs, 84.0%) x (7/8)^2 plus any crit (1 - (7/8)^2 = 23.4%) = 87.74%.
    expect(koChance(bp, 37)).toBeCloseTo(16 / 128, 12)
    expect(koChance(bp, 37)).toBeLessThan(0.15)
    expect(twoHitChance(bp, bp, 37 + 14)).toBeGreaterThan(0.15)
    expect(moveId(playTurn(s, 'support', { targetStage: 1 }, memory()))).not.toBe('MOVE_CALM_MIND')
  })

  it('2. Fake Out after the opponent\'s first turn does not block branch (a)', () => {
    const s = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM', 'MOVE_FAKE_OUT'])])
    patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: 200 } })
    // One REAL turn with our own Body Slam: isFirstTurn is 1 at battle start
    // (TurnValuesCleanUp, src/battle_main.c:3406) and 0 after it, and nobody
    // fainted. This is the only way the fixture reaches the turn-2 branch.
    beginTurn(s)
    const ours = legalChoices(s).find((choice) => moveId(choice) === 'MOVE_BODY_SLAM')
    expect(ours).toBeDefined()
    s.state.battlers[0]!.monToSwitchIntoId = PARTY_SIZE
    stepTurn(s, ours!.action)
    expect(s.state.battlers[1]!.volatiles.isFirstTurn).toBe(0)
    expect(s.state.battlers[0]!.mon.hp).toBeGreaterThan(0)
    expect(s.state.battlers[1]!.mon.hp).toBeGreaterThan(0)
    expect(s.state.battlers[0]!.lastMove).toBe('MOVE_BODY_SLAM')

    patchMon(s.state, 0, 0, { hp: 65, status1: 0 })
    // Body Slam onto our level-50 Snorlax: 39..46 non-crit, 86..102 crit, 1/24.
    // At 65 HP only the crit row reaches it: 16/384 = 4.17% < 15%, so check 1
    // passes on both loops -- Fake Out's 18..22 non-crit / 42..50 crit roll can
    // never reach 65 (0%). The AI predicts Body Slam on every sample.
    const bs = attackRange(s, 'MOVE_BODY_SLAM')
    expect(bs.rolls).toEqual([39, 39, 40, 40, 40, 41, 41, 42, 42, 43, 43, 44, 44, 45, 45, 46])
    expect(bs.critRolls).toEqual([86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 102])
    expect(koChance(bs, 65)).toBeCloseTo(16 / 384, 12)
    expect(koChance(attackRange(s, 'MOVE_FAKE_OUT'), 65)).toBe(0)
    expect(predictAi(s, 3, 0).every((sample) => sample.action?.chosenMove?.id === 'MOVE_BODY_SLAM')).toBe(true)
    // Branch (a) holds only because Fake Out is no longer counted: with 200
    // Speed the Baton Pass outspeeds every turn-2 Body Slam sample and there is
    // no other priority move. Branch (b) alone would refuse: the probe's
    // hpAfter is 65 + 14 = 79 (Snorlax's Self-Sufficient heal), and two Body
    // Slams reach it unless both are the 39 (2 of the 16 roll slots), i.e.
    // 1 - (23/24)^2 * (2/16)^2 = 98.57% >= 15%.
    expect(twoHitChance(bs, bs, 65 + 14)).toBeCloseTo(1 - (23 / 24) ** 2 * (2 / 16) ** 2, 12)
    expect(twoHitChance(bs, bs, 65 + 14)).toBeGreaterThan(0.15)
    expect(moveId(playTurn(s, 'support', {}, memory()))).toBe('MOVE_CALM_MIND')
  })

  it('2b. control: the same turn-2 position with Bullet Punch in the slot is refused', () => {
    // Bullet Punch replaces Fake Out and nothing else changes: check 1 still
    // passes (1/128 = 0.78% at 65 HP), but a real priority-1 move blocks branch
    // (a), so branch (b)'s 98.57% two-Body-Slam clause refuses the boost.
    const s = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BODY_SLAM', 'MOVE_BULLET_PUNCH'])])
    patchMon(s.state, 0, 0, { rawStats: { ...s.state.battlers[0]!.mon.rawStats, spe: 200 } })
    beginTurn(s)
    const ours = legalChoices(s).find((choice) => moveId(choice) === 'MOVE_BODY_SLAM')
    expect(ours).toBeDefined()
    s.state.battlers[0]!.monToSwitchIntoId = PARTY_SIZE
    stepTurn(s, ours!.action)
    expect(s.state.battlers[1]!.volatiles.isFirstTurn).toBe(0)
    patchMon(s.state, 0, 0, { hp: 65, status1: 0 })
    const bp = attackRange(s, 'MOVE_BULLET_PUNCH')
    expect(koChance(bp, 65)).toBeCloseTo(1 / 128, 12)
    expect(koChance(bp, 65)).toBeLessThan(0.15)
    const bs = attackRange(s, 'MOVE_BODY_SLAM')
    expect(twoHitChance(bs, bs, 65 + 14)).toBeGreaterThan(0.15)
    expect(moveId(playTurn(s, 'support', {}, memory()))).not.toBe('MOVE_CALM_MIND')
  })

  it('3. the same Fake Out on the opponent\'s FIRST turn still refuses when it KOes at >= 15%', () => {
    const s = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_FAKE_OUT'])])
    patchMon(s.state, 0, 0, { hp: 20 })
    const fo = attackRange(s, 'MOVE_FAKE_OUT')
    expect(fo.rolls).toEqual([18, 18, 19, 19, 19, 19, 20, 20, 20, 20, 20, 21, 21, 21, 21, 22])
    expect(fo.critRolls).toEqual([42, 43, 43, 44, 44, 45, 45, 46, 46, 47, 47, 48, 48, 49, 49, 50])
    expect(fo.critChanceDenominator).toBe(24)
    // At 20 HP the five 20s, four 21s and one 22 are 10 non-crit slots x 23 =
    // 230 copies, plus the whole crit row (16): 246/384 = 64.06% >= 15%.
    expect(koChance(fo, 20)).toBeCloseTo(246 / 384, 12)
    expect(koChance(fo, 20)).toBeGreaterThanOrEqual(0.15)
    // Still the live first turn, so Fake Out really can connect: isFirstTurn is
    // 1 here (2 on switch-in, 1 after the battle-start TurnValuesCleanUp).
    expect(s.state.battlers[1]!.volatiles.isFirstTurn).toBe(1)
    expect(
      predictAi(s, 3, 0).every((sample) => sample.action?.chosenMove?.id === 'MOVE_FAKE_OUT'),
    ).toBe(true)
    expect(moveId(playTurn(s, 'support', {}, memory()))).not.toBe('MOVE_CALM_MIND')
  })

  it('3b. control: a real priority move at the same HP is refused on the first turn too', () => {
    // Bullet Punch is 40 BP as well but unaffected by the helper: if the helper
    // returned true for Fake Out regardless of isFirstTurn (or skipped all
    // priority moves) this fixture would boost at 20 HP and fail.
    const s = session(supportTeam(CALM_MIND_TEAM), [mon('SPECIES_MACHAMP', ['MOVE_BULLET_PUNCH'])])
    patchMon(s.state, 0, 0, { hp: 20 })
    const bp = attackRange(s, 'MOVE_BULLET_PUNCH')
    expect(koChance(bp, 20)).toBe(1)
    expect(moveId(playTurn(s, 'support', {}, memory()))).not.toBe('MOVE_CALM_MIND')
  })
})
