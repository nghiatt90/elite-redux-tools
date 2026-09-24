// BattleAI_SetupFlags, src/battle_ai_main.c:131-155 -- the trainer-battle path
// only. The full function's first six branches (RECORDED, SAFARI, ROAMER,
// FIRST_BATTLE, FACTORY, the FRONTIER/EREADER_TRAINER/TRAINER_HILL/SECRET_BASE
// group, TWO_OPPONENTS) select aiFlags for battle types none of the 40 fights
// this tool targets can ever be -- same precedent as aiSwitching.ts's
// BATTLE_TYPE_ARENA early return and GetAIPartyIndexes' doubles/multi throw.
// Every trainer battle this sim runs falls through to the final `else`,
// `AI_THINKING_STRUCT->aiFlags = gTrainers[gTrainerBattleOpponent_A].aiFlags`.
//
// `gTrainers[].aiFlags` itself is not stored in trainers.json (it is a C
// literal the Kotlin codegen builds, TrainerPartyGenerator.kt:180-194) but its
// composition rule is fixed and public: an always-on base set, plus four bits
// gated on the trainer's own JSON booleans. `trainerAiFlags` reproduces that
// rule directly over a trainers.json row rather than re-deriving `aiFlags`
// from a C literal this tool never parses.
//
// The "check smart wild AI" branch (:150) and the save-file
// `gSaveBlock2Ptr->doubleBattleMode` half of the AI_FLAG_DOUBLE_BATTLE OR
// (:152-154) do not apply to a trainer battle: `IsWildMonSmart` is gated on
// `!(gBattleTypeFlags & BATTLE_TYPE_TRAINER)` in the C, which is always false
// here, and this tool never sets a save-file double-battle toggle. Ported as
// omitted rather than as a false-valued input, matching the project's own
// distinction (CLAUDE.md) between a modelled default and a mechanic that does
// not apply.

/** include/constants/battle_ai.h:42-61. Only the bits this trainer-derived AI
 * can ever carry are named; ROAMING/SAFARI/FIRST_BATTLE (bits 29-31) are
 * BattleAI_SetupFlags' OWN alternative-branch flags, never OR'd into the
 * trainer path, and are omitted for that reason. */
export const AI_FLAG_CHECK_BAD_MOVE = 1 << 0
export const AI_FLAG_TRY_TO_FAINT = 1 << 1
export const AI_FLAG_CHECK_VIABILITY = 1 << 2
export const AI_FLAG_SETUP_FIRST_TURN = 1 << 3
export const AI_FLAG_RISKY = 1 << 4
export const AI_FLAG_PREFER_STRONGEST_MOVE = 1 << 5
export const AI_FLAG_PREFER_BATON_PASS = 1 << 6
export const AI_FLAG_DOUBLE_BATTLE = 1 << 7
export const AI_FLAG_HP_AWARE = 1 << 8
export const AI_FLAG_NEGATE_UNAWARE = 1 << 9
export const AI_FLAG_WILL_SUICIDE = 1 << 10
export const AI_FLAG_HELP_PARTNER = 1 << 11
export const AI_FLAG_PREFER_STATUS_MOVES = 1 << 12
export const AI_FLAG_STALL = 1 << 13
export const AI_FLAG_SCREENER = 1 << 14
export const AI_FLAG_SMART_SWITCHING = 1 << 15
export const AI_FLAG_CHECK_FOE = 1 << 16
export const AI_FLAG_DISABLE_SWITCHING = 1 << 17

/** include/constants/battle.h:49, 15 -- read here only to reproduce
 * BattleAI_SetupFlags' own AI_FLAG_DOUBLE_BATTLE OR at :152. */
const BATTLE_TYPE_DOUBLE = 1 << 0
const BATTLE_TYPE_TWO_OPPONENTS = 1 << 15

/** The trainers.json fields TrainerPartyGenerator.kt:180-194 reads to build
 * `gTrainers[].aiFlags`. `forcedDouble` is read only by `battleAiSetupFlags`'s
 * own AI_FLAG_DOUBLE_BATTLE OR, not by `trainerAiFlags` itself -- the codegen
 * never adds AI_FLAG_DOUBLE_BATTLE to the STORED aiFlags literal; that OR
 * happens at battle start, in BattleAI_SetupFlags, every time. */
export interface TrainerAiRow {
  risky: boolean
  preferStall: boolean
  preferStatus: boolean
  noSwitching: boolean
  forcedDouble: boolean
}

/**
 * TrainerPartyGenerator.kt:180-194's `flags` list, reproduced as arithmetic
 * over the same four booleans instead of over a C token list. The always-on
 * set matches every entry in `addAll(listOf(...))` there.
 */
export function trainerAiFlags(trainer: TrainerAiRow): number {
  let flags =
    AI_FLAG_CHECK_BAD_MOVE |
    AI_FLAG_TRY_TO_FAINT |
    AI_FLAG_CHECK_VIABILITY |
    AI_FLAG_CHECK_FOE |
    AI_FLAG_SMART_SWITCHING |
    AI_FLAG_HP_AWARE |
    AI_FLAG_WILL_SUICIDE
  if (trainer.risky) flags |= AI_FLAG_RISKY
  if (trainer.preferStall) flags |= AI_FLAG_STALL
  if (trainer.preferStatus) flags |= AI_FLAG_PREFER_STATUS_MOVES
  if (trainer.noSwitching) flags |= AI_FLAG_DISABLE_SWITCHING
  return flags >>> 0
}

/**
 * BattleAI_SetupFlags, battle_ai_main.c:131-155 -- the trainer-battle `else`
 * branch (:147) plus its own AI_FLAG_DOUBLE_BATTLE OR (:152-154), restricted
 * to the battleTypeFlags-and-trainer-record half of that OR (the
 * `gSaveBlock2Ptr->doubleBattleMode` half does not apply -- see this module's
 * header). `battleTypeFlags` is `state.battleTypeFlags`
 * (BattleState.battleTypeFlags, `gBattleTypeFlags`).
 */
export function battleAiSetupFlags(trainer: TrainerAiRow, battleTypeFlags: number): number {
  let flags = trainerAiFlags(trainer)
  if ((battleTypeFlags & (BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS)) !== 0 || trainer.forcedDouble) {
    flags |= AI_FLAG_DOUBLE_BATTLE
  }
  return flags >>> 0
}
