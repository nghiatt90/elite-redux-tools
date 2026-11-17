// GetMoveTargetCount, src/battle_util.c:6761-6781 -- the number of battlers a move
// is currently aimed at, which CalcFinalDmg reads for its x0.75 multi-target term
// (battle_util.c:7498).
//
// Pure and headless: the caller resolves the move's target FLAG first, via the same
// GetBattlerBattleMoveTargetFlags path the sim already has
// (sim/moveTargetFlags.ts:56), and supplies each battler's alive flag. This module
// deliberately does not read battle state (wiring it into the sim is a later cycle).

/** The bare MoveTargetEnum spellings `getBattlerBattleMoveTargetFlags` returns --
 * see web/src/engine/sim/moveTargetFlags.ts and moves.json's own `target` field.
 * MOVE_TARGET_ALLY, MOVE_TARGET_USER_OR_ALLY and MOVE_TARGET_ALL_BATTLERS are real
 * flag values there too, but GetMoveTargetCount has no case for them and so hits
 * its `default: return 0` -- a plain `string` parameter keeps that faithful. */
export interface MoveTargetCountInput {
  moveId: string
  /** GetBattlerBattleMoveTargetFlags(move, battlerAtk), as a bare MoveTargetEnum
   * name ('BOTH', 'FOES_AND_ALLY', 'OPPONENTS_FIELD', 'DEPENDS', 'SELECTED',
   * 'RANDOM', 'USER_OR_SELECTED', 'USER', ...). */
  targetFlag: string
  atkAlive: boolean
  defAlive: boolean
  /** IsBattlerAlive(BATTLE_PARTNER(battlerDef)) -- the defender's partner. */
  defPartnerAlive: boolean
  /** IsBattlerAlive(BATTLE_PARTNER(battlerAtk)) -- the attacker's partner. */
  atkPartnerAlive: boolean
}

/**
 * GetMoveTargetCount, src/battle_util.c:6761-6781:
 *
 *     int flags = GetBattlerBattleMoveTargetFlags(move, battlerAtk);
 *     if (move == MOVE_SPARKLING_ARIA && flags == MOVE_TARGET_FOES_AND_ALLY) flags = MOVE_TARGET_BOTH;
 *     switch (flags) {
 *         case MOVE_TARGET_BOTH:            return IsBattlerAlive(battlerDef) + IsBattlerAlive(BATTLE_PARTNER(battlerDef));
 *         case MOVE_TARGET_FOES_AND_ALLY:   return IsBattlerAlive(battlerDef) + IsBattlerAlive(BATTLE_PARTNER(battlerDef))
 *                                                  + IsBattlerAlive(BATTLE_PARTNER(battlerAtk));
 *         case MOVE_TARGET_OPPONENTS_FIELD: return 1;
 *         case MOVE_TARGET_DEPENDS:
 *         case MOVE_TARGET_SELECTED:
 *         case MOVE_TARGET_RANDOM:
 *         case MOVE_TARGET_USER_OR_SELECTED: return IsBattlerAlive(battlerDef);
 *         case MOVE_TARGET_USER:             return IsBattlerAlive(battlerAtk);
 *         default:                           return 0;
 *     }
 *
 * IsBattlerAlive is a 0/1 int, so the BOTH arithmetic is the plain sum of two
 * flags -- the same as `Number()` coercions here.
 */
export function getMoveTargetCount(input: MoveTargetCountInput): number {
  const alive = (b: boolean) => (b ? 1 : 0)
  let flags = input.targetFlag
  if (input.moveId === 'MOVE_SPARKLING_ARIA' && flags === 'FOES_AND_ALLY') flags = 'BOTH'
  switch (flags) {
    case 'BOTH':
      return alive(input.defAlive) + alive(input.defPartnerAlive)
    case 'FOES_AND_ALLY':
      return alive(input.defAlive) + alive(input.defPartnerAlive) + alive(input.atkPartnerAlive)
    case 'OPPONENTS_FIELD':
      return 1
    case 'DEPENDS':
    case 'SELECTED':
    case 'RANDOM':
    case 'USER_OR_SELECTED':
      return alive(input.defAlive)
    case 'USER':
      return alive(input.atkAlive)
    default:
      return 0
  }
}
