/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import './driver/session'
import { describe, expect, it } from 'vitest'

import {
  BATTLE_TYPE_TRAINER,
  STATUS2_CURSED,
  STATUS3_ROOTED,
  STATUS4_COMMANDED,
  hasFlag,
  setFlag,
} from './constants'
import { createBattleState, createBattlerState } from './create'
import { loadSimData } from './driver/loadSimData'
import { dispatchMoveEndAttackerAbilities, dispatchMoveEndDefenderAbilities } from './moveEnd'
import { forceRandomSwitch } from './moveEffects'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { drainQueuedSwitches, executeTurn, type DamageResolver, type TurnLoopDeps } from './turn'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const GROUNDING = simData.grounding
const RATIOS = simData.statStageRatios

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as
    | { types: string[]; abilities: (string | null)[]; innates: (string | null)[] }
    | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: {
      ability: s.abilities[0] ?? null,
      innates: [s.innates[0] ?? null, s.innates[1] ?? null, s.innates[2] ?? null],
    },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function ability(id: string): SimBattleMon['abilities'] {
  return { ability: id, innates: [null, null, null] }
}

function partyMon(speciesId: string | null, hp: number): SimPartyMon {
  return {
    speciesId,
    hp,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: noAbility,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
  }
}

interface CountingRng extends RandomSource {
  calls: number
}

function countingRng(): CountingRng {
  const rng: CountingRng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return 0
    },
  }
  return rng
}

function scriptedRng(rolls: number[]): CountingRng {
  const rng: CountingRng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return rolls[rng.calls - 1] ?? 0
    },
  }
  return rng
}

function battle(
  a: SimBattleMon,
  b: SimBattleMon = monFor('SPECIES_MUDKIP', { abilities: noAbility }),
  rngSource: RandomSource = { random16: () => 0 },
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {},
): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng: rngSource,
    ...opts,
  })
}

const DUMMY_DAMAGE = { resolve: () => ({ targetDamage: 0, attackerDamage: null, unmodelled: [] }) }

const LOOP_DEPS: TurnLoopDeps = {
  turnOrder: simData.turnOrder,
  grounding: GROUNDING,
  damage: DUMMY_DAMAGE,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
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

function turnDeps(amount: number): TurnLoopDeps {
  return { ...LOOP_DEPS, damage: fixedDamage(amount) }
}

function move(id: string) {
  const m = DATA_CONTEXT.move(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return m
}

function useMove(target: number, moveId: string): ChosenAction {
  const moveData = move(moveId)
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

/** Battler 1's ability takes the hit; attacker 0 is the move user. */
function defenderHit(
  state: BattleState,
  moveId: string,
  targetDamage: number,
  deps: TurnLoopDeps = LOOP_DEPS,
  unmodelled: string[] = [],
  fainted: number[] = [],
  hpDealt: number = targetDamage,
) {
  return dispatchMoveEndDefenderAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: DATA_CONTEXT.move(moveId),
    targetDamage,
    hpDealt,
    deps,
    unmodelled,
    fainted,
  })
}

/** Defender-side holder with `abilityId` on battler 1. */
function holderBattle(
  abilityId: string,
  attackerOverrides: Partial<SimBattleMon> = {},
  rng: RandomSource = { random16: () => 0 },
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {},
) {
  return battle(
    monFor('SPECIES_MUDKIP', { abilities: noAbility, ...attackerOverrides }),
    monFor('SPECIES_MUDKIP', { abilities: ability(abilityId) }),
    rng,
    opts,
  )
}

const liveParty = (): SimPartyMon[] => [
  partyMon('SPECIES_MUDKIP', 100),
  partyMon('SPECIES_MUDKIP', 100),
  partyMon('SPECIES_MUDKIP', 100),
]

/** Holder (battler 1) at 40/100 after a 60-damage hit: above half before, below after. */
function crossedBattle(abilityId: string, rng: RandomSource, drops: Partial<SimBattleMon> = {}) {
  const state = holderBattle(abilityId, {}, rng, { opponentParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER })
  state.battlers[1]!.mon.hp = 40
  Object.assign(state.battlers[1]!.mon, drops)
  return state
}

// ---------------------------------------------------------------------------
// Item 1: Patchwork onDisguise unmodelled note & onDefender path
// ---------------------------------------------------------------------------
describe('Cycle 145b - Patchwork (src/abilities.cc:8636-8655)', () => {
  const PATCHWORK_GAP_NOTE = 'move-end ABILITY_PATCHWORK onDisguise hook (pipeline/.upstream/eliteredux-source/src/abilities.cc:8638-8644) is not modelled yet'

  it('a Patchwork holder hit once by a damaging move pushes the unmodelled note and does not curse the attacker', () => {
    // onDisguise (:8638-8644) is the only in-play writer of SetOncePerTurnAbilityCounter.
    // Without the writer hooked, onDefender (:8646) reads counter 0 (triggeringBattler -1),
    // failing CHECK(triggeringBattler == attacker).
    const state = holderBattle('ABILITY_PATCHWORK')
    const unmodelled: string[] = []
    const result = defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, unmodelled)

    expect(unmodelled).toContain(PATCHWORK_GAP_NOTE)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(result.statusApplied).toBeNull()
  })

  it('the unmodelled note is pushed once, not twice, across two hits sharing one unmodelled array', () => {
    const state = holderBattle('ABILITY_PATCHWORK')
    const unmodelled: string[] = []
    defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, unmodelled)
    defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, unmodelled)

    const matches = unmodelled.filter((m) => m === PATCHWORK_GAP_NOTE)
    expect(matches).toHaveLength(1)
  })

  it('the existing counter-set path still curses (counter set by hand simulating onDisguise write)', () => {
    const state = holderBattle('ABILITY_PATCHWORK')
    // in C, onDisguise (:8641) writes gBattlerAttacker + 1; for attacker 0 that is 1.
    // In the sim Disguise busting has no damage hook, so tests set it directly.
    state.battlers[1]!.turn.turnAbilityTriggers[0] = 1
    const unmodelled: string[] = []
    const result = defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, unmodelled)

    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(result.statusApplied).toEqual({ battlerId: 0, status: 'CURSE' })
    expect(state.battlers[1]!.turn.turnAbilityTriggers[0]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Item 2: Wimp Out / Emergency Exit vs forced-switch (RED_CARD) scripts
// ---------------------------------------------------------------------------
describe('Cycle 145b - Wimp Out / Emergency Exit / Hollow Ice Zone vs Roar / RED_CARD', () => {
  it('Wimp Out holder rooted crosses half HP: switches out anyway (BattleScript_EmergencyExit has no STATUS3_ROOTED gate)', () => {
    // BattleScript_EmergencyExit (data/battle_scripts_1.s:9479-9500) has NO jumpifstatus3 STATUS3_ROOTED,
    // unlike BattleScript_RedCardActivates_AfterPrintString (:11326).
    const rng = scriptedRng([0 /* rejected: current index 0 */, 1 /* accepted */])
    const state = crossedBattle('ABILITY_WIMP_OUT', rng)
    state.battlers[1]!.statuses3 = setFlag(state.battlers[1]!.statuses3, STATUS3_ROOTED)

    defenderHit(state, 'MOVE_TACKLE', 60, LOOP_DEPS, [], [], 60)
    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_WIMP_OUT', setAbilityState: false, switchingBattler: 1, sourceBattler: 1, script: 'EMERGENCY_EXIT' },
    ])

    drainQueuedSwitches(state, turnDeps(60), [])
    expect(state.battlers[1]!.partyIndex).toBe(1)
    expect(state.queuedSwitches).toEqual([])
  })

  it('negative twin: Chuckster holder queued switch of a rooted attacker is blocked by Ingrain (battle_scripts_1.s:11326)', () => {
    // BattleScript_ChucksterActivates (:11310-11313) jumps to BattleScript_RedCardActivates_AfterPrintString
    // which runs `jumpifstatus3 BS_TARGET, STATUS3_ROOTED, BattleScript_RedCardIngrain` (:11326).
    const rng = scriptedRng([0, 1])
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_CHUCKSTER') }),
      rng,
      {
        playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)],
        opponentParty: liveParty(),
        battleTypeFlags: BATTLE_TYPE_TRAINER,
      },
    )
    state.battlers[0]!.statuses3 = setFlag(state.battlers[0]!.statuses3, STATUS3_ROOTED)

    defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, [])
    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_CHUCKSTER', setAbilityState: false, switchingBattler: 0, sourceBattler: 1 },
    ])

    drainQueuedSwitches(state, turnDeps(10), [])
    // Attacker 0 remains in battle; switch was blocked by Ingrain.
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(state.queuedSwitches).toEqual([])
  })

  it('Suction Cups on the Wimp Out holder switches out anyway (BattleScript_EmergencyExit has no Suction Cups gate)', () => {
    // BattleScript_EmergencyExit (data/battle_scripts_1.s:9479-9500) has NO jumpifabilityflag ABILITY_SUCTION_CUPS.
    const rng = scriptedRng([0, 1])
    const state = holderBattle('ABILITY_WIMP_OUT', {}, rng, { opponentParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER })
    state.battlers[1]!.mon.hp = 40
    // Holder carries both Wimp Out and Suction Cups in an innate slot.
    state.battlers[1]!.mon.abilities = { ability: 'ABILITY_WIMP_OUT', innates: ['ABILITY_SUCTION_CUPS', null, null] }

    defenderHit(state, 'MOVE_TACKLE', 60, LOOP_DEPS, [], [], 60)
    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_WIMP_OUT', setAbilityState: false, switchingBattler: 1, sourceBattler: 1, script: 'EMERGENCY_EXIT' },
    ])

    drainQueuedSwitches(state, turnDeps(60), [])
    expect(state.battlers[1]!.partyIndex).toBe(1)
  })

  it('negative twin on RED_CARD path: Suction Cups on the target blocks (battle_scripts_1.s:11327)', () => {
    // BattleScript_RedCardActivates_AfterPrintString (:11327) checks jumpifabilityflag BS_TARGET, ABILITY_SUCTION_CUPS.
    const rng = scriptedRng([0, 1])
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_SUCTION_CUPS') }),
      monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_CHUCKSTER') }),
      rng,
      {
        playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)],
        opponentParty: liveParty(),
        battleTypeFlags: BATTLE_TYPE_TRAINER,
      },
    )

    defenderHit(state, 'MOVE_TACKLE', 10, LOOP_DEPS, [])
    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_CHUCKSTER', setAbilityState: false, switchingBattler: 0, sourceBattler: 1 },
    ])

    drainQueuedSwitches(state, turnDeps(10), [])
    // Attacker 0 remains in battle; switch was blocked by Suction Cups.
    expect(state.battlers[0]!.partyIndex).toBe(0)
  })

  it('Emergency Exit with STATUS4_COMMANDED on the holder: no switch (CanBattlerSwitch, battle_script_commands.c:5066)', () => {
    // CanBattlerSwitch (battle_script_commands.c:5066): `if (gStatuses4[battlerId] & STATUS4_COMMANDED) return FALSE;`
    // At schedule time, CanBattlerBeForceSwitched (abilities.cc:2610, 2622) calls CanBattlerSwitch,
    // so a commanded holder does not schedule.
    const rng = scriptedRng([0, 1])
    const state = crossedBattle('ABILITY_EMERGENCY_EXIT', rng)
    state.battlers[1]!.statuses4 = setFlag(state.battlers[1]!.statuses4, STATUS4_COMMANDED)

    defenderHit(state, 'MOVE_TACKLE', 60, LOOP_DEPS, [], [], 60)
    expect(state.queuedSwitches).toEqual([])

    // Furthermore, if an entry had been scheduled and the holder became commanded before drain,
    // the drain's FILTER(CanBattlerSwitch(switching)) (battle_util.c:812) drops the switch.
    state.queuedSwitches.push({
      ability: 'ABILITY_EMERGENCY_EXIT',
      setAbilityState: false,
      switchingBattler: 1,
      sourceBattler: 1,
      script: 'EMERGENCY_EXIT',
    })
    drainQueuedSwitches(state, turnDeps(60), [])
    // Switch was filtered out by CanBattlerSwitch; holder remains at partyIndex 0.
    expect(state.battlers[1]!.partyIndex).toBe(0)
    expect(state.queuedSwitches).toEqual([])
  })

  it('Hollow Ice Zone entry is queued with script: EMERGENCY_EXIT and ignores Ingrain on the switching attacker', () => {
    // Hollow Ice Zone (src/abilities.cc:12188-12194) queues BattleScript_EmergencyExitPopupNoPause
    // with switchingBattler = sourceBattler = battler (the attacker).
    // The drain runs the EMERGENCY_EXIT path without Ingrain blocks.
    const rng = scriptedRng([0, 1])
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: ability('ABILITY_HOLLOW_ICE_ZONE') }),
      monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      rng,
      {
        playerParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)],
        opponentParty: liveParty(),
        battleTypeFlags: BATTLE_TYPE_TRAINER,
      },
    )
    state.battlers[0]!.statuses3 = setFlag(state.battlers[0]!.statuses3, STATUS3_ROOTED)

    dispatchMoveEndAttackerAbilities({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_ICE_BEAM',
      moveData: DATA_CONTEXT.move('MOVE_ICE_BEAM'),
      targetDamage: 20,
      hpDealt: 20,
      deps: LOOP_DEPS,
      unmodelled: [],
      fainted: [],
    })

    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_HOLLOW_ICE_ZONE', setAbilityState: false, switchingBattler: 0, sourceBattler: 0, script: 'EMERGENCY_EXIT' },
    ])

    drainQueuedSwitches(state, turnDeps(20), [])
    // Attacker 0 switches out despite being rooted.
    expect(state.battlers[0]!.partyIndex).toBe(1)
  })

  it('Roar against an Ingrain target still returns BLOCKED with no rng draw (regression guard for extracted helper)', () => {
    // BattleScript_Roar (data/battle_scripts_1.s:3762): jumpifstatus3 BS_TARGET, STATUS3_ROOTED.
    // forceRandomSwitch (moveEffects.ts:10915-10918) returns 'BLOCKED' before drawing any random number.
    const rng = countingRng()
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: noAbility, moves: ['MOVE_ROAR', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { abilities: noAbility }),
      rng,
      {
        playerParty: [partyMon('SPECIES_MUDKIP', 100)],
        opponentParty: [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)],
      },
    )
    state.battlers[1]!.statuses3 = setFlag(state.battlers[1]!.statuses3, STATUS3_ROOTED)

    const result = forceRandomSwitch(state, 0, 1, LOOP_DEPS, [])
    expect(result).toBe('BLOCKED')
    expect(rng.calls).toBe(0)

    // In a full turn, Roar fails to switch the rooted target.
    executeTurn(state, [useMove(1, 'MOVE_ROAR'), null], turnDeps(0))
    expect(state.battlers[1]!.partyIndex).toBe(0)
  })
})
