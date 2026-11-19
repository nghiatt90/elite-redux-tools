/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 6a (dbl-6a): start-of-battle absent-battler rule (battle_main.c:3327-3330)
// for a double battle with fewer than two usable player mons, plus the Juan stage-2
// chain test when only one player mon survived stage 1.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadBossTrainerIds } from './driver/bossSet'
import { buildBattleState } from './driver/battleFormat'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { carryParty, firstLiveSlot } from './driver/carryParty'
import { buildChains, type TagBattle, type TrainerChain } from './driver/chains'
import { playExpectimaxBattle, type ExpectimaxOptions } from './driver/expectimax'
import { fightSpecFor } from './driver/fightSpec'
import { FIGHTS } from './driver/fights'
import { loadSimData } from './driver/loadSimData'
import { defaultPlayerPolicy, runBattle } from './driver/runBattle'
import { createSession, stepTurn } from './driver/session'
import { defaultSet, scoreChain, type Team } from './driver/solver'
import { createRandomSource } from './rng'
import type { SimPartyMon } from './state'

const data = loadSimData()

const fastExpectimax: ExpectimaxOptions = {
  depth: 1,
  samples: 2,
  innerSamples: 1,
  switchMargin: 0.05,
  statusTerms: true,
}

const team: Team = [
  defaultSet(data, 'SPECIES_SWAMPERT', 50, new Set()),
  defaultSet(data, 'SPECIES_TYRANITAR', 50, new Set()),
  defaultSet(data, 'SPECIES_METAGROSS', 50, new Set()),
  defaultSet(data, 'SPECIES_SALAMENCE', 50, new Set()),
]

const juan5 = data.trainersById.get('TRAINER_JUAN_5')!
const wallace5 = data.trainersById.get('TRAINER_WALLACE_5')!

function mon(hp: number): SimPartyMon {
  const base = buildPlayerParty([{ species: 'SPECIES_MUDKIP', moves: ['MOVE_TACKLE'] }], 50, data)[0]!
  return { ...base, hp: hp > 0 ? hp : 0, maxHp: base.maxHp }
}

function emptySlot(): SimPartyMon {
  return { ...mon(0), speciesId: null }
}

const encounters = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../data/v2.65beta/encounters.json'),
    'utf8',
  ),
) as { trainerChains: TrainerChain[]; tagBattles: TagBattle[] }

const bossIds = loadBossTrainerIds()
const deferredIds = new Set(FIGHTS.filter((row) => row.deferred).flatMap((row) => row.trainerIds))
const v1Ids = new Set(bossIds.filter((id) => !deferredIds.has(id)))
const v1Chains = buildChains(encounters.trainerChains, encounters.tagBattles, v1Ids)

describe('cycle 6a: absent battler at double battle start (battle_main.c:3327-3330)', () => {
  it('1. buildBattleState with ONE live player mon + 5 empty slots marks battler 2 absent (1 << 2)', () => {
    const playerParty: SimPartyMon[] = [
      mon(20),
      emptySlot(),
      emptySlot(),
      emptySlot(),
      emptySlot(),
      emptySlot(),
    ]
    const state = buildBattleState(
      { opponents: [juan5, wallace5] },
      {
        data,
        tier: 'elite',
        playerParty,
        opponentParties: [
          buildOpponentParty(juan5, 'elite', 50, data),
          buildOpponentParty(wallace5, 'elite', 50, data),
        ],
        rng: createRandomSource(1),
      },
    )

    // battle_main.c:3327-3330: battler 2 has SPECIES_NONE (slot 1 from battle_controllers.c:663-667),
    // so gAbsentBattlerFlags |= gBitTable[2] (1 << 2 === 4).
    expect(state.absentBattlerFlags).toBe(1 << 2)
    expect(state.battlers[2]).toBeNull()
    expect(state.battlersCount).toBe(4)

    // Battlers 0, 1, 3 are live; TWO_OPPONENTS forces battler 1 to slot 0 and battler 3 to slot 3
    // (battle_controllers.c:672-673).
    expect(state.battlers[0]).not.toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(20)
    expect(state.battlers[0]!.partyIndex).toBe(0)

    expect(state.battlers[1]).not.toBeNull()
    expect(state.battlers[1]!.mon.hp).toBeGreaterThan(0)
    expect(state.battlers[1]!.partyIndex).toBe(0)

    expect(state.battlers[3]).not.toBeNull()
    expect(state.battlers[3]!.mon.hp).toBeGreaterThan(0)
    expect(state.battlers[3]!.partyIndex).toBe(3)
  })

  it('2. negative: the same call with TWO live player mons has absentBattlerFlags === 0', () => {
    const playerParty: SimPartyMon[] = [
      mon(20),
      mon(25),
      emptySlot(),
      emptySlot(),
      emptySlot(),
      emptySlot(),
    ]
    const state = buildBattleState(
      { opponents: [juan5, wallace5] },
      {
        data,
        tier: 'elite',
        playerParty,
        opponentParties: [
          buildOpponentParty(juan5, 'elite', 50, data),
          buildOpponentParty(wallace5, 'elite', 50, data),
        ],
        rng: createRandomSource(1),
      },
    )

    expect(state.absentBattlerFlags).toBe(0)
    expect(state.battlers[2]).not.toBeNull()
    expect(state.battlers[2]!.mon.hp).toBe(25)
    expect(state.battlers[2]!.partyIndex).toBe(1)
  })

  it('3. negative: zero valid player mons throws; one valid opponent mon throws /opponent side has 1 valid mon/', () => {
    expect(() =>
      buildBattleState(
        { opponents: [juan5, wallace5] },
        {
          data,
          tier: 'elite',
          playerParty: [mon(0), emptySlot()],
          opponentParties: [
            buildOpponentParty(juan5, 'elite', 50, data),
            buildOpponentParty(wallace5, 'elite', 50, data),
          ],
          rng: createRandomSource(1),
        },
      ),
    ).toThrow(/player side has 0 valid mon/)

    expect(() =>
      buildBattleState(
        { opponents: [juan5, wallace5] },
        {
          data,
          tier: 'elite',
          playerParty: [mon(20), mon(20)],
          opponentParties: [[mon(20)], [mon(0)]],
          rng: createRandomSource(1),
        },
      ),
    ).toThrow(/opponent side has 1 valid mon/)
  })

  it('4. createSession + stepTurn and runBattle on Juan stage 2 with 1-mon player party reach WON/LOST and battler 2 never acts', () => {
    const spec = fightSpecFor(data, 'TRAINER_JUAN_5')
    const oneMonParty = buildPlayerParty([defaultSet(data, 'SPECIES_SWAMPERT', 50, new Set())], 50, data)

    // Verify createSession + stepTurn directly:
    const session = createSession({
      data,
      ...spec,
      playerParty: oneMonParty,
      rng: createRandomSource(7),
    })
    expect(session.state.absentBattlerFlags & (1 << 2)).toBe(1 << 2)
    expect(session.state.battlers[2]).toBeNull()

    const action0 = defaultPlayerPolicy(session.state, data, session.turnDeps.damage, 0)
    const step = stepTurn(session, action0, undefined, { 2: null })
    const b2Action = step.outcome.actions.find((a) => a.battlerId === 2)
    expect(b2Action?.chosenMoveId ?? null).toBeNull()
    expect(b2Action?.targetId ?? null).toBeNull()
    expect(b2Action?.targetDamage ?? null).toBeNull()
    expect(session.state.absentBattlerFlags & (1 << 2)).toBe(1 << 2)
    expect(session.state.battlers[2]).toBeNull()

    // Full battle via runBattle: policy must only be queried for battler 0 (never battler 2,
    // which would happen if the absent bit were not set), and battler 2 never executes a move or gets targeted.
    const policyQueriedBattlers: number[] = []
    const result = runBattle({
      data,
      ...spec,
      playerParty: oneMonParty,
      rng: createRandomSource(7),
      playerPolicy: (st, _unmodelled, battlerId) => {
        policyQueriedBattlers.push(battlerId)
        return defaultPlayerPolicy(st, data, undefined, battlerId)
      },
    })

    expect(['WON', 'LOST']).toContain(result.outcome)
    expect(result.turns).toBeGreaterThan(0)
    expect(policyQueriedBattlers).not.toContain(2)
    expect(policyQueriedBattlers.every((id) => id === 0)).toBe(true)
    for (const turnEntry of result.log) {
      const a2 = turnEntry.actions.find((a) => a.battlerId === 2)
      expect(a2?.moveId ?? null).toBeNull()
      expect(a2?.targetId ?? null).toBeNull()
      expect(a2?.damage ?? null).toBeNull()
      expect(turnEntry.actions.some((a) => a.targetId === 2)).toBe(false)
    }
  })

  it('5. Juan chain stage 2 runs with a 1-survivor carried party and starts at the carried HP (not full)', () => {
    const juanChain = v1Chains.find((c) => c.id === 'SootopolisCity_Gym_1F_EventScript_Juan')!
    expect(juanChain).toBeDefined()
    expect(juanChain.stages).toHaveLength(2)

    const startParty = buildPlayerParty(team, 50, data)
    const fullHpSlot2 = startParty[2]!.maxHp
    const carriedHpSlot2 = Math.floor(fullHpSlot2 / 2)
    expect(carriedHpSlot2).toBeGreaterThan(0)
    expect(carriedHpSlot2).toBeLessThan(fullHpSlot2)

    // Build a stage-1 end state where only slot 2 (Metagross) survived at carriedHpSlot2,
    // while slots 0, 1, 3 fainted (hp: 0).
    const endPartyStage1 = startParty.map((m, idx) => ({
      ...m,
      hp: idx === 2 ? carriedHpSlot2 : 0,
    }))
    const carried = carryParty(startParty, endPartyStage1)
    expect(carried.filter((m) => m.hp > 0)).toHaveLength(1)
    expect(firstLiveSlot(carried)).toBe(2)
    expect(carried[2]!.hp).toBe(carriedHpSlot2)

    // Verify start-of-fight HP for stage 2 equals the carried HP (not fullHpSlot2).
    // Note: slots 0, 1, 3 are fainted mons (speciesId !== null, hp === 0), so SetBattlePartyIds
    // assigns battler 0 -> slot 2 (first live) and battler 2 -> slot 0 (fallback when i-2 != 0,
    // battle_controllers.c:666-667). Since slot 0 has a real species with hp === 0, battler 2
    // is built with hp === 0 and marked absent per battle_main.c:3327-3330.
    const specStage2 = fightSpecFor(data, 'TRAINER_JUAN_5', { juanStage: 2 })
    const sessionStage2 = createSession({
      data,
      ...specStage2,
      playerParty: carried,
      leadIndex: firstLiveSlot(carried),
      rng: createRandomSource(1002),
    })
    expect(sessionStage2.state.battlers[0]!.partyIndex).toBe(2)
    expect(sessionStage2.state.battlers[0]!.mon.hp).toBe(carriedHpSlot2)
    expect(sessionStage2.state.battlers[0]!.mon.hp).not.toBe(fullHpSlot2)
    expect(sessionStage2.state.absentBattlerFlags).toBe(1 << 2)
    expect(sessionStage2.state.battlers[2]?.mon.hp ?? 0).toBe(0)

    // Run stage 2 through playExpectimaxBattle with the carried 1-survivor party
    const stage2Res = playExpectimaxBattle({
      data,
      playerParty: carried,
      opponentTrainer: specStage2.opponentTrainer,
      tier: 'elite',
      seed: 1002,
      expectimax: fastExpectimax,
      battleEvents: specStage2.battleEvents,
      leadIndex: firstLiveSlot(carried),
      format: specStage2.format,
      inverseBattle: specStage2.inverseBattle,
      startFieldEffects: specStage2.startFieldEffects,
    })
    expect(['WON', 'LOST']).toContain(stage2Res.outcome)
    expect(stage2Res.turns).toBeGreaterThan(0)

    // And scoreChain on the Juan chain with a 1-mon team (which wins stage 1 when overlevelled
    // and enters stage 2 with 1 live mon) completes both stages without throwing.
    const soloSweepTeam: Team = [defaultSet(data, 'SPECIES_RAYQUAZA', 100, new Set())]
    const fitness = scoreChain(data, juanChain, 'elite', soloSweepTeam, 1, fastExpectimax, 0)
    expect(fitness.games).toBe(1)
  })
})
