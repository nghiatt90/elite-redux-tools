/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle d3-2: `carryParty`, the end-of-battle carry-over for a no-heal chain.
//
// Hand-derived from the C at the pinned SHA:
//   - src/battle_main.c:4818-4852 -- end-of-battle order: TryRestoreStolenItems (:4827),
//     UndoMegaEvolution/UndoFormChange per slot (:4829-4831), CalculateMonStats per
//     non-empty slot (:4845-4852)
//   - src/battle_util.c:8478-8498 -- TryRestoreStolenItems; B_RESTORE_ALL_ITEMS is TRUE
//     (include/constants/battle_config.h:189), so every held item returns to the one
//     captured at battle start (src/battle_main.c:2781)
//   - src/pokemon.c:1010-1043 -- CalculateMonStatsMaster: PP restore and the HP rule
//   - src/battle_controller_player.c:3821,3823 -- MON_DATA_STATUS / MON_DATA_HP come from
//     the live battle mon
//   - src/battle_controllers.c:607-675 -- IsValidForBattle / SetBattlePartyIds: the next
//     lead is the first slot with a species and HP != 0
import { describe, expect, it } from 'vitest'
import { STATUS1_BURN, STATUS1_POISON } from './constants'
import type { BattleState, SimPartyMon } from './state'
import { createRandomSource } from './rng'
import { buildPlayerParty, type PlayerMonSpec } from './driver/buildParty'
import { carryParty, firstLiveSlot } from './driver/carryParty'
import { loadSimData } from './driver/loadSimData'
import { defaultPlayerPolicy } from './driver/runBattle'
import { cloneParty, createSession, stepTurn } from './driver/session'

const data = loadSimData()

// Same two fights d3-1 uses: TRAINER_MAY_ROUTE_103_TORCHIC (Mudkip then Goomy) and
// TRAINER_WATTSON_1, whose elite lead is Tapu Koko with Life Orb and three attacks.
const WEAK_FIGHT = 'TRAINER_MAY_ROUTE_103_TORCHIC'
const STRONG_FIGHT = 'TRAINER_WATTSON_1'

const GARCHOMP: PlayerMonSpec = {
  species: 'SPECIES_GARCHOMP',
  level: 50,
  nature: 'NATURE_JOLLY',
  evs: { atk: 252, spe: 252, hp: 4 },
  moves: ['MOVE_DRAGON_CLAW', 'MOVE_EARTHQUAKE', 'MOVE_POISON_JAB', 'MOVE_SWORDS_DANCE'],
}

const BLISSEY: PlayerMonSpec = {
  species: 'SPECIES_BLISSEY',
  level: 50,
  nature: 'NATURE_BOLD',
  evs: { hp: 252, def: 252, spdef: 4 },
  moves: ['MOVE_SEISMIC_TOSS', 'MOVE_SOFT_BOILED', 'MOVE_TOXIC', 'MOVE_THUNDER_WAVE'],
}

const MAGIKARP: PlayerMonSpec = {
  species: 'SPECIES_MAGIKARP',
  level: 50,
  nature: 'NATURE_HARDY',
  moves: ['MOVE_TACKLE'],
}

const trainer = (id: string) => data.trainersById.get(id)!

/** Runs a real battle to its end (or `maxTurns`) and returns the live end state, so
 * `sides[0].party` and `battlers[0]` are exactly what the harness produced. */
function fight(
  party: SimPartyMon[],
  trainerId: string,
  seed: number,
  maxTurns = 60,
  leadIndex?: number,
): BattleState {
  const session = createSession({
    data,
    playerParty: party,
    opponentTrainer: trainer(trainerId),
    rng: createRandomSource(seed),
    leadIndex,
  })
  let turns = 0
  while (!session.state.battleOutcome && turns < maxTurns) {
    turns++
    stepTurn(session, defaultPlayerPolicy(session.state, data, session.turnDeps.damage))
  }
  return session.state
}

describe('cycle d3-2: carryParty', () => {
  it('carries the live battler HP into the next fight instead of healing', () => {
    const start = buildPlayerParty([MAGIKARP, GARCHOMP], 50, data)
    const state = fight(start, WEAK_FIGHT, 3)
    const active = state.battlers[0]!
    expect(state.battleOutcome).toBe('WON')
    expect(active.partyIndex).toBe(1)
    // Mudkip KOs the Magikarp lead, then Garchomp finishes the fight at 36/184.
    // Both numbers come from the harness, not from hand-edited fields.
    expect(active.mon.hp).toBeGreaterThan(0)
    expect(active.mon.hp).toBeLessThan(active.mon.maxHp)
    const carried = carryParty(start, state.sides[0].party, active)
    // battle_controller_player.c:3823 writes the battle mon's hp to the party slot.
    expect(carried[1]!.hp).toBe(active.mon.hp)
    expect(carried[1]!.hp).toBeLessThan(carried[1]!.maxHp)
    // A heal-between party would start the slot at full HP.
    expect(carried[1]!.hp).not.toBe(start[1]!.hp)
  })

  it('keeps a fainted slot fainted and skips it as the next lead', () => {
    const start = buildPlayerParty([MAGIKARP, GARCHOMP], 50, data)
    const state = fight(start, WEAK_FIGHT, 3)
    expect(state.sides[0].party[0]!.hp).toBe(0)
    const carried = carryParty(start, state.sides[0].party, state.battlers[0]!)
    // pokemon.c:1040-1041: currentHP == 0 and oldMaxHP != 0 returns without a write,
    // so the slot stays at 0.
    expect(carried[0]!.hp).toBe(0)
    // IsValidForBattle (battle_controllers.c:607-613) rejects an HP-0 slot;
    // SetBattlePartyIds (:615-675) sends out the first valid one.
    expect(firstLiveSlot(carried)).toBe(1)
    const wiped = cloneParty(carried)
    for (const mon of wiped) mon.hp = 0
    expect(firstLiveSlot(wiped)).toBe(-1)
  })

  it('restores PP to the pre-battle value', () => {
    const start = buildPlayerParty([MAGIKARP, GARCHOMP], 50, data)
    const state = fight(start, WEAK_FIGHT, 3)
    const active = state.battlers[0]!
    expect(active.partyIndex).toBe(1)
    // The lead spent PP during the fight (the sim deducts it in Cmd_ppreduce).
    const spent = active.mon.pp.some((pp, i) => pp < start[1]!.pp[i]!)
    expect(spent).toBe(true)
    const carried = carryParty(start, state.sides[0].party, active)
    // pokemon.c:1013-1019 restores every move's base PP; the sim models neither PP
    // bonuses nor PP Ups, so base PP is exactly startParty's tuple.
    expect(carried[1]!.pp).toEqual(start[1]!.pp)
  })

  it('carries status1 from the live battler and from endParty for a benched slot', () => {
    const start = buildPlayerParty([GARCHOMP, BLISSEY], 50, data)
    const state = fight(start, WEAK_FIGHT, 11)
    const active = state.battlers[0]!
    expect(state.battleOutcome).toBe('WON')
    expect(active.partyIndex).toBe(0)
    // The sim writes status1 back to the party slot only on switch-out
    // (turn.ts:1848-1859); a mon still on the field keeps it on the battler
    // (battle_controller_player.c:3821). Set it there by hand and leave the party
    // slot at 0, which is exactly the reachable end-of-fight shape.
    active.mon.status1 = STATUS1_POISON
    const end = cloneParty(state.sides[0].party)
    expect(end[0]!.status1).toBe(0)
    // A reserve's status1 does reach the party slot on switch-out (turn.ts:1853).
    // Blissey never leaves the bench here, so stand in for a switch-out by hand.
    end[1]!.status1 = STATUS1_BURN
    const carried = carryParty(start, end, active)
    expect(carried[0]!.status1).toBe(STATUS1_POISON)
    expect(carried[1]!.status1).toBe(STATUS1_BURN)
    expect(start[0]!.status1).toBe(0)
  })

  it('restores a consumed held item to the pre-battle item', () => {
    const start = buildPlayerParty([{ ...GARCHOMP, item: 'ITEM_SITRUS_BERRY' }], 50, data)
    const end = cloneParty(start)
    // A consumed berry / Focus Sash is ITEM_NONE on the party slot; the sim writes
    // the battler's item back on switch-out (turn.ts:1859). Hand-built: no
    // scripted fight here eats a berry.
    end[0]!.itemId = null
    expect(start[0]!.itemId).toBe('ITEM_SITRUS_BERRY')
    const carried = carryParty(start, end)
    // B_RESTORE_ALL_ITEMS is TRUE (battle_config.h:189), so TryRestoreStolenItems
    // (battle_util.c:8478-8498) puts back itemStolen[i].originalItem -- the item
    // captured at battle start (battle_main.c:2781) -- and the berry is back.
    expect(end[0]!.itemId).toBeNull()
    expect(carried[0]!.itemId).toBe('ITEM_SITRUS_BERRY')
  })

  it('reverts a form change and carries HP across the max-HP delta', () => {
    const start = buildPlayerParty([GARCHOMP], 50, data)
    const M0 = start[0]!.maxHp
    const M1 = M0 + 40
    const H = M0 - 20
    const mega = data.speciesById.get('SPECIES_GARCHOMP_MEGA_REDUX')!
    const end = cloneParty(start)
    // Mirrors the writes formChange.ts:356-363 makes to the party slot on a form
    // change (speciesId, types, abilities, rawStats, maxHp, hp; the HP write there
    // is already the delta-adjusted value). Hand-built because a real session reverts
    // Megas in-battle at battle end (turn.ts:5420, battle_main.c:4830), so no real
    // endParty hands carryParty an un-reverted slot.
    end[0]!.speciesId = mega.id
    end[0]!.types = mega.types.map((t: string) => t.replace('TYPE_', '')) as [string, string, string]
    end[0]!.abilities = {
      ability: mega.abilities[0] ?? null,
      innates: [mega.innates[0] ?? null, mega.innates[1] ?? null, mega.innates[2] ?? null],
    }
    end[0]!.rawStats = { ...end[0]!.rawStats, atk: end[0]!.rawStats.atk + 10 }
    end[0]!.maxHp = M1
    end[0]!.hp = H
    const carried = carryParty(start, end)
    // pokemon.c:1035-1039: currentHP += newMaxHP - oldMaxHP, floored at 1.
    expect(H + M0 - M1).toBeGreaterThan(0)
    expect(carried[0]!.hp).toBe(H + M0 - M1)
    // UndoMegaEvolution (battle_util.c:8187-8215) ran before CalculateMonStats, so the
    // identity fields are the pre-battle ones (formChange.ts:864-905 writes them into
    // the party slot on revert; taking startParty's values is the same result).
    expect(carried[0]!.speciesId).toBe(start[0]!.speciesId)
    expect(carried[0]!.types).toEqual(start[0]!.types)
    expect(carried[0]!.abilities).toEqual(start[0]!.abilities)
    expect(carried[0]!.rawStats).toEqual(start[0]!.rawStats)
    expect(carried[0]!.maxHp).toBe(M0)

    // A sum <= 0 becomes 1 (pokemon.c:1038).
    const floored = cloneParty(start)
    floored[0]!.maxHp = M0 + 100
    floored[0]!.hp = 10
    expect(10 + M0 - (M0 + 100)).toBeLessThanOrEqual(0)
    expect(carryParty(start, floored)[0]!.hp).toBe(1)

    // A fainted reverted mon stays at 0 (:1040-1041 returns without a write).
    const fainted = cloneParty(start)
    fainted[0]!.maxHp = M1
    fainted[0]!.hp = 0
    expect(carryParty(start, fainted)[0]!.hp).toBe(0)
  })

  it('applies the Shedinja HP rule to the reverted species', () => {
    const start = buildPlayerParty(
      [{ species: 'SPECIES_SHEDINJA', level: 50, moves: ['MOVE_TACKLE'] }],
      50,
      data,
    )
    expect(start[0]!.maxHp).toBe(1)
    const alive = cloneParty(start)
    alive[0]!.hp = 1
    // pokemon.c:1027-1029: species == SPECIES_SHEDINJA and currentHP != 0 -> 1.
    expect(carryParty(start, alive)[0]!.hp).toBe(1)
    const fainted = cloneParty(start)
    fainted[0]!.hp = 0
    // :1030-1031: else return, leaving the 0 in place.
    expect(carryParty(start, fainted)[0]!.hp).toBe(0)
  })

  it('leaves a never-active slot exactly as it started', () => {
    const start = buildPlayerParty([GARCHOMP, BLISSEY], 50, data)
    const state = fight(start, WEAK_FIGHT, 11)
    expect(state.battleOutcome).toBe('WON')
    expect(state.battlers[0]!.partyIndex).toBe(0)
    const carried = carryParty(start, state.sides[0].party, state.battlers[0]!)
    expect(carried[1]).toEqual(start[1])
  })

  it('carries ungated innates so the next session gates them exactly once', () => {
    const start = buildPlayerParty(
      [{ species: 'SPECIES_VENUSAUR', level: 9, moves: ['MOVE_TACKLE'] }],
      9,
      data,
    )
    const raw = start[0]!.abilities.innates
    expect(raw.filter((a) => a !== null)).toHaveLength(3)
    const stage1 = createSession({
      data,
      playerParty: start,
      opponentTrainer: trainer(WEAK_FIGHT),
      rng: createRandomSource(5),
    })
    // GetInnateInSlot (battle_util.c:8799-8802) via gateInnates: elite thresholds are
    // 1/17/24, so a level-9 mon keeps innate slot 0 only.
    const gated: [string | null, string | null, string | null] = [raw[0], null, null]
    expect(stage1.state.sides[0].party[0]!.abilities.innates).toEqual(gated)
    const carried = carryParty(start, stage1.state.sides[0].party, stage1.state.battlers[0]!)
    // The result must not keep the session's gated copy: createSession gates its own
    // clone (session.ts:266-268), so carrying gated innates would gate them twice.
    expect(carried[0]!.abilities).toEqual(start[0]!.abilities)
    const stage2 = createSession({
      data,
      playerParty: carried,
      opponentTrainer: trainer(WEAK_FIGHT),
      rng: createRandomSource(5),
    })
    expect(stage2.state.sides[0].party[0]!.abilities.innates).toEqual(gated)
  })

  it('starts a stage-2 fight damaged from a carried party, full from a fresh one', () => {
    const start = buildPlayerParty([MAGIKARP, GARCHOMP], 50, data)
    const state1 = fight(start, WEAK_FIGHT, 3)
    const active1 = state1.battlers[0]!
    expect(state1.battleOutcome).toBe('WON')
    const carried = carryParty(start, state1.sides[0].party, active1)
    const lead = firstLiveSlot(carried)
    expect(lead).toBe(1)
    const carriedHp = carried[lead]!.hp
    expect(carriedHp).toBe(active1.mon.hp)
    expect(carriedHp).toBeGreaterThan(0)
    const stage2Carried = createSession({
      data,
      playerParty: carried,
      opponentTrainer: trainer(STRONG_FIGHT),
      rng: createRandomSource(7),
      leadIndex: lead,
    })
    const stage2Healed = createSession({
      data,
      playerParty: start,
      opponentTrainer: trainer(STRONG_FIGHT),
      rng: createRandomSource(7),
      leadIndex: lead,
    })
    // Garchomp enters at its carried 36/184 instead of a fresh 184/184. If carryParty
    // returned startParty unchanged these two would be equal.
    expect(stage2Carried.state.battlers[0]!.mon.hp).toBe(carriedHp)
    expect(stage2Healed.state.battlers[0]!.mon.hp).toBe(start[lead]!.maxHp)
    expect(stage2Carried.state.battlers[0]!.mon.hp).not.toBe(
      stage2Healed.state.battlers[0]!.mon.hp,
    )
  })

  it('does not mutate its inputs and rejects mismatched party lengths', () => {
    const start = buildPlayerParty([GARCHOMP, BLISSEY], 50, data)
    const state = fight(start, WEAK_FIGHT, 11)
    expect(state.battleOutcome).toBe('WON')
    const end = state.sides[0].party
    const startBefore = JSON.stringify(start)
    const endBefore = JSON.stringify(end)
    const carried = carryParty(start, end, state.battlers[0]!)
    expect(JSON.stringify(start)).toBe(startBefore)
    expect(JSON.stringify(end)).toBe(endBefore)
    // A fresh deep copy: mutating the result cannot reach either input.
    const first = carried[0]!
    first.hp = 7
    first.moves[0] = 'MOVE_SPLASH'
    first.abilities.innates[0] = null
    expect(JSON.stringify(start)).toBe(startBefore)
    expect(JSON.stringify(end)).toBe(endBefore)
    expect(() => carryParty(start, end.slice(1))).toThrow()
  })
})
