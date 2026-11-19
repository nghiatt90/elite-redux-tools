// Which kind of battle a session is, and how its 6-slot side parties are laid out.
//
// The roster rules are the game's own, not a sim convention:
//   - flags come from battle_main.c:1757-1762 / :1910-1913 for a single trainer and
//     battle_tower.c:1627-1628 / :1645-1647 for the two-opponent and partner formats;
//   - the starting gBattlerPartyIndexes come from battle_controllers.c:160-171 (partner)
//     and SetBattlePartyIds (:615-675) otherwise.
//
// This module only assembles turn-zero state. It runs no turn, marks no battler absent
// and resolves no replacement -- those are dbl-2b/dbl-2c.

import { battleAiSetupFlags } from '../ai/aiFlags'
import {
  BATTLE_TYPE_DOUBLE,
  BATTLE_TYPE_INGAME_PARTNER,
  BATTLE_TYPE_MULTI,
  BATTLE_TYPE_TRAINER,
  BATTLE_TYPE_TWO_OPPONENTS,
  PARTY_SIZE,
} from '../constants'
import { createBattleState, createBattlerState } from '../create'
import { gateInnates, type InnateTier } from '../innateGate'
import type { BattleState, BattlerState, RandomSource, SimBattleMon, SimPartyMon } from '../state'
import type { SimDataBundle, TrainerData } from './loadSimData'

export interface BattleFormat {
  /** 1 or 2 trainers. Two opponents is the `TWO_OPPONENTS` format. */
  opponents: TrainerData[]
  /** In-game partner (the M3 fights). Data only: the partner's mons arrive in
   * `BuildBattleStateOptions.partnerParty`, built by the caller. */
  partner?: TrainerData
  /** Defaults to `opponents[0].forcedDouble`. */
  forcedDouble?: boolean
}

export interface BuildBattleStateOptions {
  data: SimDataBundle
  tier: InnateTier
  playerParty: SimPartyMon[]
  opponentParties: SimPartyMon[][]
  partnerParty?: SimPartyMon[]
  /** The player's chosen lead party slot; only singles uses it today. */
  leadIndex?: number
  rng: RandomSource
}

/**
 * `gBattleTypeFlags` for the format.
 *
 * Single trainer, battle_main.c:1757-1762 then :1910-1913: `isDoubleBattle` needs a
 * save option or `gTrainers[].doubleBattle`, but the `else` branch ORs
 * `gTrainers[].doubleBattle` back in, so a forced-double trainer is
 * `TRAINER | DOUBLE` whatever the player's usable-mon count; a non-forced single
 * trainer adds nothing (the pre-change value). `doubleBattleMode` is a save option the
 * sim does not model.
 *
 * Two opponents: `TRAINER | DOUBLE | TWO_OPPONENTS` (battle_tower.c:1627-1628).
 * With a partner: the same plus `MULTI | INGAME_PARTNER` (battle_tower.c:1645-1647).
 *
 * BATTLE_TYPE_TRAINER is load-bearing beyond "trainer battle":
 * CanBattlerBeForceSwitched needs it for Emergency Exit / Wimp Out
 * (abilities.cc:2608-2615, called at :2622) and Restraining Order (:8579-8597); the
 * sim ports those gates in moveEnd.ts (:3249-3267 and :3019-3036). Red Card does NOT
 * read it: its hold effect schedules unconditionally (battle_util.c:6130-6141) and
 * its script tests only Rooted / Suction Cups / Commander
 * (data/battle_scripts_1.s:11320-11335). See docs/battle-sim/session-battle-type-flags.md.
 */
export function battleTypeFlagsFor(format: BattleFormat): number {
  const first = format.opponents[0]
  if (!first) throw new Error('battleTypeFlagsFor: at least one opponent trainer is required')
  const forcedDouble = format.forcedDouble ?? first.forcedDouble

  const battleTypeFlags = BATTLE_TYPE_TRAINER
  if (format.partner) {
    return battleTypeFlags | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS | BATTLE_TYPE_MULTI | BATTLE_TYPE_INGAME_PARTNER
  }
  if (format.opponents.length === 2) {
    return battleTypeFlags | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS
  }
  if (forcedDouble) return battleTypeFlags | BATTLE_TYPE_DOUBLE
  return battleTypeFlags
}

/**
 * The trainer record whose party `battlerId` fields (docs/battle-sim/doubles-plan.md
 * "Per-battler trainer lookup"): battler 1 is `opponents[0]`; battler 3 is
 * `opponents[1]`, or `opponents[0]` when one trainer fields both flanks (a forced
 * double); battler 2 is the in-game partner; battler 0 is the player, who has no
 * trainer record here.
 *
 * This is a ROSTER lookup only. AI flags do NOT come from it: BattleAI_SetupFlags
 * reads `gTrainers[gTrainerBattleOpponent_A].aiFlags` for every AI battler
 * (battle_ai_main.c:147) and ORs the DOUBLE_BATTLE bit on (:152-154), so
 * `chooseAiAction` keeps using the single battle-wide row (`deps.trainer`).
 */
export function trainerForBattler(format: BattleFormat, battlerId: number): TrainerData {
  switch (battlerId) {
    case 1: {
      const first = format.opponents[0]
      if (!first) throw new Error('trainerForBattler: the format has no opponent trainer')
      return first
    }
    case 3: {
      const first = format.opponents[0]
      if (!first) throw new Error('trainerForBattler: the format has no opponent trainer')
      // TWO_OPPONENTS puts trainer B on the right flank; a forced double keeps
      // both flanks on the one trainer.
      return format.opponents[1] ?? first
    }
    case 2:
      if (!format.partner) {
        throw new Error('trainerForBattler: battler 2 has no partner in this format')
      }
      return format.partner
    case 0:
      throw new Error('trainerForBattler: battler 0 is the player, who has no trainer record')
    default:
      throw new Error(`trainerForBattler: battler ${battlerId} is not a battler in these formats`)
  }
}

/** An empty party slot -- the C's `SPECIES_NONE` entry. `hasLiveReserve` and every
 * other reserve scan treat `speciesId === null` as "no mon here". */
function emptyPartySlot(): SimPartyMon {
  return {
    speciesId: null,
    hp: 0,
    maxHp: 0,
    level: 0,
    moves: [null, null, null, null],
    pp: [0, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'GENDERLESS',
    status1: 0,
    types: ['MYSTERY', 'MYSTERY', 'MYSTERY'],
  }
}

/** `IsValidForBattle` (battle_controllers.c:607-613) reduced to the two fields the
 * sim models: a real species and positive HP. Eggs cannot occur in these fights. */
function isValidSlot(slot: SimPartyMon | undefined): slot is SimPartyMon {
  return slot !== undefined && slot.speciesId !== null && slot.hp > 0
}

function padTo(party: SimPartyMon[], size: number): SimPartyMon[] {
  const result = party.slice(0, size)
  while (result.length < size) result.push(emptyPartySlot())
  return result
}

/** The 6-slot side rosters. In singles the caller's party is passed through
 * untouched so the state is bit-identical to the pre-change createSession. */
function layoutRosters(
  format: BattleFormat,
  options: BuildBattleStateOptions,
  flags: number,
): { playerRoster: SimPartyMon[]; opponentRoster: SimPartyMon[] } {
  if ((flags & BATTLE_TYPE_DOUBLE) === 0) {
    return { playerRoster: options.playerParty, opponentRoster: options.opponentParties[0]! }
  }
  if (format.partner) {
    // FillPartnerParty (battle_tower.c:2394-2399) zeroes gPlayerParty[3..5] and puts
    // the partner's three mons there; the player's own chosen mons stay in 0..2.
    const own = padTo(options.playerParty.slice(0, 3), 3)
    const partner = padTo((options.partnerParty ?? []).slice(0, 3), 3)
    const playerRoster = [...own, ...partner]
    return { playerRoster, opponentRoster: twoTrainerRoster(options.opponentParties) }
  }
  if (format.opponents.length === 2) {
    // CreateNPCTrainerParty writes trainer A at gEnemyParty[0] and trainer B at
    // gEnemyParty[3] (battle_main.c:613-615); each gets at most MULTI_PARTY_SIZE = 3
    // mons under TWO_OPPONENTS (battle_main.c:1778-1782).
    return { playerRoster: padTo(options.playerParty, PARTY_SIZE), opponentRoster: twoTrainerRoster(options.opponentParties) }
  }
  return { playerRoster: padTo(options.playerParty, PARTY_SIZE), opponentRoster: padTo(options.opponentParties[0]!, PARTY_SIZE) }
}

/** Trainer A in slots 0-2, trainer B in slots 3-5. */
function twoTrainerRoster(parties: SimPartyMon[][]): SimPartyMon[] {
  return [...padTo(parties[0] ?? [], 3), ...padTo(parties[1] ?? [], 3)]
}

/**
 * `gBattlerPartyIndexes[]` at battle start.
 *
 * Partner formats: battlers 0 and 1 start from slot 0 and battlers 2 and 3 from slot 3
 * (battle_controllers.c:160-171). The `BATTLE_TWO_VS_ONE_OPPONENT` branch at :162-166 is
 * a two-vs-one fight this game does not run, so it is omitted.
 *
 * Otherwise this is SetBattlePartyIds (battle_controllers.c:615-675), which MULTI skips:
 *   - battlers 0 and 1 take the first valid slot of their own side's party (:625-642);
 *   - battlers 2 and 3 take the first valid slot that is not their flank-mate's
 *     (break paths at :648-660), and when none exists fall back to slot 1/0 (:663-667). The fallback
 *     assignment is INSIDE the j loop, so it runs on every j that does not break and a
 *     later `break` overwrites it -- ported as written.
 *   - TWO_OPPONENTS then forces battler 1 to slot 0 and battler 3 to slot 3 (:672-673).
 */
export function startingPartyIndexes(
  format: BattleFormat,
  playerRoster: SimPartyMon[],
  opponentRoster: SimPartyMon[],
  battlersCount: number,
): number[] {
  const flags = battleTypeFlagsFor(format)
  if (flags & (BATTLE_TYPE_MULTI | BATTLE_TYPE_INGAME_PARTNER)) return [0, 0, 3, 3]

  const indexes = [0, 0, 0, 0]
  for (let i = 0; i < battlersCount; i++) {
    const party = (i & 1) === 0 ? playerRoster : opponentRoster
    for (let j = 0; j < PARTY_SIZE; j++) {
      if (i < 2) {
        if (isValidSlot(party[j])) {
          indexes[i] = j
          break
        }
      } else {
        if (isValidSlot(party[j]) && indexes[i - 2] !== j) {
          indexes[i] = j
          break
        }
        // No valid mons were found. Add the empty slot. (battle_controllers.c:663-667)
        indexes[i] = indexes[i - 2] === 0 ? 1 : 0
      }
    }
  }
  if (flags & BATTLE_TYPE_TWO_OPPONENTS) {
    indexes[1] = 0
    indexes[3] = 3
  }
  return indexes
}

/** A double battle starts two battlers per side; an invalid player slot is marked
 * absent per battle_main.c:3327-3330, so the player side needs at least 1 valid mon
 * while the opponent side needs 2. */
function assertTwoValidPerSide(playerRoster: SimPartyMon[], opponentRoster: SimPartyMon[]): void {
  const playerValid = playerRoster.filter((slot) => isValidSlot(slot)).length
  const opponentValid = opponentRoster.filter((slot) => isValidSlot(slot)).length
  if (playerValid < 1) {
    throw new Error(`buildBattleState: the player side has ${playerValid} valid mon(s); a double battle needs at least 1`)
  }
  if (opponentValid < 2) {
    throw new Error(`buildBattleState: the opponent side has ${opponentValid} valid mon(s); a double battle needs at least 2`)
  }
}

/** `struct BattlePokemon` from a party record -- the active copy Cmd_switchindataupdate
 * memcpys onto the field (battle_script_commands.c:5008-5037). */
export function toBattleMon(incoming: SimPartyMon): SimBattleMon {
  return {
    speciesId: incoming.speciesId as string,
    rawStats: incoming.rawStats,
    moves: incoming.moves,
    pp: incoming.pp,
    hp: incoming.hp,
    maxHp: incoming.maxHp,
    itemId: incoming.itemId,
    statStages: [],
    types: incoming.types,
    level: incoming.level,
    nature: incoming.nature,
    hiddenPowerType: incoming.hiddenPowerType,
    speedDown: incoming.speedDown,
    abilities: incoming.abilities,
    abilityNum: incoming.abilityNum,
    gender: incoming.gender,
    status1: incoming.status1,
    status2: 0,
    evs: incoming.evs,
  }
}

/**
 * GetInnateInSlot's player-only gate (battle_util.c:8799-8802): only the player's
 * OWN mons are gated by level and difficulty. The in-game partner's mons are built
 * with `isPlayer == FALSE` (battle_controller_player_partner.c:678-680), so they
 * start with all three innates whatever the tier. Call this with `playerParty`
 * only -- never with `partnerParty`.
 */
export function gatePlayerInnates(playerParty: SimPartyMon[], tier: InnateTier): void {
  for (const mon of playerParty) {
    mon.abilities.innates = gateInnates(mon.abilities.innates, mon.level, tier)
  }
}

/**
 * Assembles the turn-zero BattleState for `format` from already-built parties. The
 * caller owns party construction (`buildOpponentParty`, `buildPlayerParty`) and the
 * player's own innate gate (through `gatePlayerInnates`, which must not be applied to
 * `partnerParty`: the partner starts ungated, battle_controller_player_partner.c:678-680);
 * this function only computes the format's flags, lays the parties into the 6-slot
 * rosters, derives `gBattlerPartyIndexes[]`, and builds the starting battlers.
 */
export function buildBattleState(format: BattleFormat, options: BuildBattleStateOptions): BattleState {
  if (format.opponents.length < 1 || format.opponents.length > 2) {
    throw new Error(`buildBattleState: a battle has 1 or 2 opponent trainers, got ${format.opponents.length}`)
  }
  if (options.opponentParties.length !== format.opponents.length) {
    throw new Error(`buildBattleState: ${format.opponents.length} opponent trainer(s) need ${format.opponents.length} opponent part(ies), got ${options.opponentParties.length}`)
  }
  if (format.partner && format.opponents.length !== 2) {
    throw new Error('buildBattleState: an in-game partner needs a two-opponent fight')
  }
  if (format.partner && !options.partnerParty) {
    throw new Error('buildBattleState: a partner format needs partnerParty')
  }

  const flags = battleTypeFlagsFor(format)
  const double = (flags & BATTLE_TYPE_DOUBLE) !== 0
  const { playerRoster, opponentRoster } = layoutRosters(format, options, flags)
  if (double) assertTwoValidPerSide(playerRoster, opponentRoster)

  const battlersCount = double ? 4 : 2
  const indexes = double
    ? startingPartyIndexes(format, playerRoster, opponentRoster, battlersCount)
    : [0, 0, 0, 0]
  // createSession's explicit lead: in singles, battler 0 starts from this party slot
  // rather than the first live one (and keeps the pre-change default slot 0 even when
  // the lead is fainted -- the battle-start sequence replaces it, session.ts:259-264).
  // In doubles, SetBattlePartyIds (battle_controllers.c:615-675) already chose both
  // player leads and their fallback slots; overriding indexes[0] alone would break the
  // `gBattlerPartyIndexes[i - 2]` dependency for battler 2 (:648, :664).
  if (!double && options.leadIndex !== undefined) indexes[0] = options.leadIndex

  const battlers: (BattlerState | null)[] = []
  let absentBattlerFlags = 0
  for (let id = 0; id < battlersCount; id++) {
    const roster = (id & 1) === 0 ? playerRoster : opponentRoster
    const partyIndex = indexes[id]!
    const entry = roster[partyIndex]
    // battle_main.c:3327-3330: mark invalid mons (species == SPECIES_NONE or hp == 0)
    // as absent when starting a double battle. A fainted entry (hp 0) in singles is
    // allowed and NOT marked absent: singles keeps createSession's default lead even
    // when it is fainted, and the battle-start sequence replaces it (session.ts:259-264).
    if (!entry || entry.speciesId === null) {
      battlers.push(null)
      if (double) absentBattlerFlags |= 1 << id
      continue
    }
    if (double && entry.hp === 0) {
      absentBattlerFlags |= 1 << id
    }
    battlers.push(createBattlerState(id, toBattleMon(entry), partyIndex))
  }

  const state = createBattleState({
    battlers,
    playerParty: playerRoster,
    opponentParty: opponentRoster,
    battleTypeFlags: flags,
    aiFlags: battleAiSetupFlags(format.opponents[0]!, 0),
    tier: options.tier,
    rng: options.rng,
  })
  if (double) {
    state.battlersCount = battlersCount
    state.absentBattlerFlags = absentBattlerFlags
  }
  return state
}
