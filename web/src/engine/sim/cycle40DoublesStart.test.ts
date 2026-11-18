/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 40 (dbl-2c): four-lead battle start, partner innate gating, and replacement re-entry.
//
//   (1) gatePlayerInnates is GetInnateInSlot's PLAYER-only gate (battle_util.c:8799-8802):
//       level 10 at elite keeps slot 0 only (thresholds [1, 17, 24]), the same at hell
//       ([10, 17, 24]), and ace never gates.
//   (2) The in-game partner's mons are built with isPlayer == FALSE
//       (battle_controller_player_partner.c:678-680), so they start UNGATED whatever the
//       tier; only the later recompute path (changeBattlerForm) gates a partner by side
//       (battle_util.c:8807-8815, formChange.ts:325-334).
//   (3) TryDoEventsBeforeFirstTurn (battle_main.c:3359-3383) resolves all four leads'
//       switch-in abilities through RecalculateMoveOrder, fastest to slowest, and the
//       dead-battler skip at :3363-3366 does not drop another lead.
//   (4) A mid-battle replacement runs only the incoming mon's switch-in abilities
//       (CheckAndSetSwitchInAbility, battle_util.c:3929-3943): the leads do not re-fire.

import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  BATTLE_TYPE_TRAINER,
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPDEF,
  STATUS_FIELD_TRICK_ROOM,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_NONE,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
} from './constants'
import { battleAiSetupFlags } from './ai/aiFlags'
import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState, gatePlayerInnates, toBattleMon } from './driver/battleFormat'
import { cloneParty, createSession, firstLiveReplacement, groundingFor } from './driver/session'
import { changeBattlerForm } from './formChange'
import { applyBattleStartPass, type BattleStartDeps } from './switchInAbility'
import { applyEndOfTurnReplacements } from './switchIn'
import type { HazardDeps } from './hazards'
import { syncPartyHp } from './outcome'
import { createRandomSource } from './rng'
import { NEUTRAL_TURN_ORDER_CONTEXT, type TurnOrderContext } from './turnOrder'
import type { BattleState, SimPartyMon } from './state'

const data = loadSimData()

const SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_STONE_EDGE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_METEOR_MASH'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_EARTHQUAKE'] },
]

const trainer = data.trainersById.get('TRAINER_SAWYER_1')!
const secondTrainer = data.trainersById.get('TRAINER_ROXANNE_1')!
const partnerTrainer = data.trainersById.get('TRAINER_STEVEN_MOSSDEEP')!

/** The rng closure is not part of the state comparison (see cycle38's own helper). */
const strip = (state: BattleState) => JSON.parse(JSON.stringify(state, (k, v) => (k === 'rng' ? undefined : v)))

function opponentParty(): SimPartyMon[] {
  return buildOpponentParty(trainer, 'elite', 50, data)
}

/** A plain forced-double state: battlers 0/1 player leads, 1/3 opponent leads. */
function fourLeadState(): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: buildPlayerParty(SPECS, 50, data), opponentParties: [opponentParty()], rng: createRandomSource(1) },
  )
}

/** Overwrite a lead's speed and ability so the switch-in effect and its order are hand-readable. */
function setLead(state: BattleState, battlerId: number, spe: number, ability: string | null): void {
  const battler = state.battlers[battlerId]!
  battler.mon.rawStats = { ...battler.mon.rawStats, spe }
  battler.mon.abilities = { ability, innates: [null, null, null] }
  battler.mon.itemId = null
  battler.mon.speedDown = false
  battler.mon.status1 = 0
}

function startDeps(state: BattleState, overrides: Partial<BattleStartDeps> = {}): BattleStartDeps {
  return {
    grounding: groundingFor(data, state),
    dataContext: data.dataContext,
    statStageRatios: data.statStageRatios,
    ...overrides,
  }
}

function hazardDeps(state: BattleState): HazardDeps {
  return { dataContext: data.dataContext, grounding: groundingFor(data, state) }
}

describe('(1) gatePlayerInnates is the player-only innate gate (battle_util.c:8799-8802)', () => {
  const monAt = (level: number): SimPartyMon => buildPlayerParty([{ species: 'SPECIES_TYRANITAR', level, moves: [] }], level, data)[0]!

  it('elite level 10 keeps slot 0 only; hell level 10 is the same; ace gates nothing', () => {
    // innateGate.ts:13 -- elite thresholds [1, 17, 24]; hell [10, 17, 24].
    // Tyranitar's species innates are ['ABILITY_IMPENETRABLE', 'ABILITY_JUGGERNAUT', 'ABILITY_SAND_STREAM'].
    const elite = monAt(10)
    gatePlayerInnates([elite], 'elite')
    expect(elite.abilities.innates).toEqual(['ABILITY_IMPENETRABLE', null, null])

    const hell = monAt(10)
    gatePlayerInnates([hell], 'hell')
    expect(hell.abilities.innates).toEqual(['ABILITY_IMPENETRABLE', null, null])

    // Negative that separates hell from elite: at level 9 hell's slot-0 threshold (10)
    // is not met, while elite's slot-0 threshold (1) would be.
    const hellNine = monAt(9)
    gatePlayerInnates([hellNine], 'hell')
    expect(hellNine.abilities.innates).toEqual([null, null, null])

    const ace = monAt(10)
    gatePlayerInnates([ace], 'ace')
    expect(ace.abilities.innates).toEqual(['ABILITY_IMPENETRABLE', 'ABILITY_JUGGERNAUT', 'ABILITY_SAND_STREAM'])
  })
})

/** A partner format with everyone at level 10. The state tier is elite, so any later
 * recompute would gate a level-10 mon down to slot 0. */
function partnerStateAtTen(): { state: BattleState; own: SimPartyMon[]; partner: SimPartyMon[] } {
  const own = buildPlayerParty(SPECS.map((spec) => ({ ...spec, level: 10 })), 10, data)
  // The caller gates ONLY the player's own mons (battleFormat.ts's header).
  gatePlayerInnates(own, 'elite')
  const partner = buildOpponentParty(partnerTrainer, 'ace', 10, data)
  const state = buildBattleState(
    { opponents: [secondTrainer, trainer], partner: partnerTrainer },
    {
      data,
      tier: 'elite',
      playerParty: own,
      opponentParties: [buildOpponentParty(secondTrainer, 'elite', 50, data), opponentParty()],
      partnerParty: partner,
      rng: createRandomSource(1),
    },
  )
  return { state, own, partner }
}

describe('(2) the partner starts ungated (battle_controller_player_partner.c:678-680)', () => {
  it('own mons are gated, the partner mons keep all three innates', () => {
    const { state } = partnerStateAtTen()
    // FillPartnerParty (battle_tower.c:2394-2399): own mons in slots 0..2, partner in 3..5.
    for (let i = 0; i < 3; i++) {
      const ownMon = state.sides[0].party[i]!
      expect(ownMon.abilities.innates[0]).not.toBeNull()
      expect(ownMon.abilities.innates[1]).toBeNull()
      expect(ownMon.abilities.innates[2]).toBeNull()
    }
    for (let i = 3; i < 6; i++) {
      const partnerMon = state.sides[0].party[i]!
      expect(partnerMon.abilities.innates[0]).not.toBeNull()
      expect(partnerMon.abilities.innates[1]).not.toBeNull()
      expect(partnerMon.abilities.innates[2]).not.toBeNull()
    }
    // Battler 2 is the partner's lead and starts from slot 3.
    expect(state.battlers[2]!.partyIndex).toBe(3)
    expect(state.battlers[2]!.mon.abilities.innates[0]).not.toBeNull()
    expect(state.battlers[2]!.mon.abilities.innates[1]).not.toBeNull()
    expect(state.battlers[2]!.mon.abilities.innates[2]).not.toBeNull()
  })

  it('negative: the same partner mon passed through gatePlayerInnates IS gated', () => {
    const { partner } = partnerStateAtTen()
    const copy = cloneParty([partner[0]!])[0]!
    gatePlayerInnates([copy], 'elite')
    expect(copy.abilities.innates[0]).not.toBeNull()
    expect(copy.abilities.innates[1]).toBeNull()
    expect(copy.abilities.innates[2]).toBeNull()
  })
})

describe('(3) a later recompute gates the partner by battler side (battle_util.c:8807-8815)', () => {
  it('changeBattlerForm on battler 2 (side player) gates the new form', () => {
    const { state } = partnerStateAtTen()
    changeBattlerForm(state, 2, 'SPECIES_MINIOR_CORE_BLUE', data.dataContext)
    expect(state.battlers[2]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_BLUE')
    // Minior Core Blue's innates are ['ABILITY_SHIELDS_DOWN', 'ABILITY_EQUINOX', 'ABILITY_FRISK'];
    // level 10 at elite keeps slot 0 only.
    expect(state.battlers[2]!.mon.abilities.innates).toEqual(['ABILITY_SHIELDS_DOWN', null, null])
  })

  it('the same call on an opponent battler keeps all three', () => {
    const { state } = partnerStateAtTen()
    changeBattlerForm(state, 1, 'SPECIES_MINIOR_CORE_BLUE', data.dataContext)
    expect(state.battlers[1]!.mon.abilities.innates).toEqual([
      'ABILITY_SHIELDS_DOWN',
      'ABILITY_EQUINOX',
      'ABILITY_FRISK',
    ])
  })
})

describe('(4) four leads start in speed / Trick Room order (battle_main.c:3359-3383)', () => {
  it('no Trick Room: fastest first, so the slowest lead resolves last', () => {
    // Speeds 100/90/80/70 on battlers 1/2/3/0. RecalculateMoveOrder pulls the fastest
    // remaining battler into each slot (:3361), so the order is [1, 2, 3, 0] and the
    // LAST ability to resolve is battler 0's Drizzle: the resolution order is visible
    // through the final weather, and the array itself carries the full order.
    const state = fourLeadState()
    setLead(state, 0, 70, 'ABILITY_DRIZZLE')
    setLead(state, 1, 100, 'ABILITY_DROUGHT')
    setLead(state, 2, 90, 'ABILITY_SAND_STREAM')
    setLead(state, 3, 80, 'ABILITY_SNOW_WARNING')

    const unmodelled: string[] = []
    const order = applyBattleStartPass(state, startDeps(state), unmodelled)

    expect(order.battlerByTurnOrder).toEqual([1, 2, 3, 0])
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(unmodelled).toEqual([])
    // The other setters ran earlier and were overwritten (proves the pass did not stop
    // after the first lead): the last one is Drizzle, not Snow Warning or Sand Stream.
    expect(state.field.weather).not.toBe(WEATHER_HAIL_TEMPORARY)
    expect(state.field.weather).not.toBe(WEATHER_SANDSTORM_TEMPORARY)
  })

  it('Trick Room: slowest first, so the fastest lead resolves last', () => {
    // IsTrickRoomActive complements the low u16 of speed (turnOrder.ts:543,
    // battle_main.c:4323-4325), so the same speeds give [0, 3, 2, 1] and the last
    // ability to resolve is battler 1's Drought.
    const state = fourLeadState()
    setLead(state, 0, 70, 'ABILITY_DRIZZLE')
    setLead(state, 1, 100, 'ABILITY_DROUGHT')
    setLead(state, 2, 90, 'ABILITY_SAND_STREAM')
    setLead(state, 3, 80, 'ABILITY_SNOW_WARNING')
    state.field.statuses |= STATUS_FIELD_TRICK_ROOM
    const trickRoom: TurnOrderContext = { ...NEUTRAL_TURN_ORDER_CONTEXT, isTrickRoomActive: true }

    const unmodelled: string[] = []
    const order = applyBattleStartPass(state, startDeps(state, { turnOrder: trickRoom }), unmodelled)

    expect(order.battlerByTurnOrder).toEqual([0, 3, 2, 1])
    expect(state.field.weather).toBe(WEATHER_SUN_TEMPORARY)
    expect(unmodelled).toEqual([])
  })

  it('a dead lead is skipped without consuming another lead\'s slot (:3363-3366)', () => {
    // Battler 1 is the fastest (100) and therefore the first slot; it is dead. The C
    // advances the counter and continues, so battlers 2, 3 and 0 still resolve once each.
    // Distinct self-stat raises (Atk / Def / SpDef) prove every surviving lead fired;
    // battler 1's Drizzle must not set rain.
    const state = fourLeadState()
    setLead(state, 0, 70, 'ABILITY_INTREPID_SWORD')
    setLead(state, 1, 100, 'ABILITY_DRIZZLE')
    setLead(state, 2, 90, 'ABILITY_DAUNTLESS_SHIELD')
    setLead(state, 3, 80, 'ABILITY_HEADSTRONG')
    state.battlers[1]!.mon.hp = 0
    syncPartyHp(state, 1)

    const unmodelled: string[] = []
    const order = applyBattleStartPass(state, startDeps(state), unmodelled)

    expect(order.battlerByTurnOrder).toEqual([1, 2, 3, 0])
    expect(state.field.weather).toBe(WEATHER_NONE)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[2]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[3]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(unmodelled).toEqual([])
  })
})

describe('(5) a replacement fires only its own switch-in ability (battle_util.c:3929-3943)', () => {
  it('battler 2\'s replacement resolves, battlers 0 and 1 do not re-fire', () => {
    const state = fourLeadState()
    // Leads: battler 0 Intrepid Sword (Atk +1), battler 1 Dauntless Shield (Def +1).
    // A second run of either would push the stage to +2.
    setLead(state, 0, 100, 'ABILITY_INTREPID_SWORD')
    setLead(state, 1, 90, 'ABILITY_DAUNTLESS_SHIELD')
    setLead(state, 2, 80, null)
    setLead(state, 3, 70, null)
    // The incoming mon in battler 2's first live reserve slot (party slot 2; battlers 0
    // and 2 started from slots 0 and 1).
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(state.battlers[2]!.partyIndex).toBe(1)
    state.sides[0].party[2]!.abilities = { ability: 'ABILITY_DRIZZLE', innates: [null, null, null] }
    state.sides[0].party[2]!.itemId = null

    const unmodelled: string[] = []
    applyBattleStartPass(state, startDeps(state), unmodelled)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.field.weather).toBe(WEATHER_NONE)

    // Faint battler 2 and run the end-of-turn replacement.
    state.battlers[2]!.mon.hp = 0
    syncPartyHp(state, 2)
    applyEndOfTurnReplacements(
      state,
      { chooseReplacement: (s, battlerId) => firstLiveReplacement(s, battlerId) },
      hazardDeps(state),
      unmodelled,
    )

    // The incoming mon's Drizzle fired ...
    expect(state.battlers[2]!.partyIndex).toBe(2)
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    // ... and the leads' abilities were not re-run: their stat stages are still +1.
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
  })
})

describe('(6) singles is unchanged', () => {
  it('buildBattleState still produces the pre-change createBattleState literal', () => {
    const playerParty = buildPlayerParty(SPECS, 50, data)
    const opp = opponentParty()
    const expected = createBattleState({
      battlers: [
        createBattlerState(0, toBattleMon(playerParty[0]!), 0),
        createBattlerState(1, toBattleMon(opp[0]!), 0),
      ],
      playerParty,
      opponentParty: opp,
      battleTypeFlags: BATTLE_TYPE_TRAINER,
      aiFlags: battleAiSetupFlags(trainer, 0),
      tier: 'elite',
      rng: createRandomSource(1),
    })
    const actual = buildBattleState(
      { opponents: [trainer] },
      { data, tier: 'elite', playerParty, opponentParties: [opp], rng: createRandomSource(1) },
    )
    expect(strip(actual)).toEqual(strip(expected))
    expect(actual.battlersCount).toBe(2)
  })

  it('createSession still gates a level-10 player party exactly like gatePlayerInnates', () => {
    const party = buildPlayerParty(SPECS.map((spec) => ({ ...spec, level: 10 })), 10, data)
    const expected = cloneParty(party)
    gatePlayerInnates(expected, 'elite')
    const session = createSession({ data, playerParty: party, opponentTrainer: trainer, rng: createRandomSource(1) })
    expect(session.state.sides[0].party.map((mon) => mon.abilities.innates)).toEqual(
      expected.map((mon) => mon.abilities.innates),
    )
  })
})
