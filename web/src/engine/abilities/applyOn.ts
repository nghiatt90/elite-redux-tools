// AbilityApplyOn, include/abilities.hh:143-152 -- a real bitflag enum, not a plain
// discriminated set of options. Replicated as numeric constants (not a string union)
// so IsApplyOnFlagAppropriate's bitwise checks can be ported literally rather than
// re-derived from guessed semantics.
//
//   APPLY_ON_SELF      = 0
//   APPLY_IGNORE_SELF  = 1 << 2 = 4
//   APPLY_ON_ALLY      = 1 << 0 = 1
//   APPLY_ON_ALLY_ONLY = APPLY_ON_ALLY | APPLY_IGNORE_SELF        = 5
//   APPLY_ON_FOE_OR_SELF = 1 << 1 = 2
//   APPLY_ON_FOE       = APPLY_ON_FOE_OR_SELF | APPLY_IGNORE_SELF = 6
//   APPLY_ON_ANY       = APPLY_ON_ALLY | APPLY_ON_FOE_OR_SELF     = 3
//   APPLY_ON_OTHER     = APPLY_ON_ANY | APPLY_IGNORE_SELF         = 7

export const APPLY_ON_SELF = 0
export const APPLY_IGNORE_SELF = 1 << 2
export const APPLY_ON_ALLY = 1 << 0
export const APPLY_ON_ALLY_ONLY = APPLY_ON_ALLY | APPLY_IGNORE_SELF
export const APPLY_ON_FOE_OR_SELF = 1 << 1
export const APPLY_ON_FOE = APPLY_ON_FOE_OR_SELF | APPLY_IGNORE_SELF
export const APPLY_ON_ANY = APPLY_ON_ALLY | APPLY_ON_FOE_OR_SELF
export const APPLY_ON_OTHER = APPLY_ON_ANY | APPLY_IGNORE_SELF

/**
 * IsApplyOnFlagAppropriate, src/abilities.cc:176-184, ported bit-for-bit. `isSelf`:
 * the ability's own battler is the context battler (the move's user, for offensive
 * hooks). `isAlly`: same side, not self (never true in this v1 singles engine, but
 * kept so the bit logic reads the same as the C's `GetBattlerSide(...) ==
 * GetBattlerSide(...)` branch).
 */
export function isApplyOnFlagAppropriate(isSelf: boolean, isAlly: boolean, flag: number = APPLY_ON_SELF): boolean {
  if (flag === APPLY_ON_SELF) return isSelf
  if (isSelf) return (flag & APPLY_IGNORE_SELF) === 0
  if (isAlly) return (flag & APPLY_ON_ALLY) !== 0
  return (flag & APPLY_ON_FOE) !== 0
}

/**
 * IsTargettedApplyOnFlagAppropriate, src/abilities.cc:169-175 -- the
 * attacker/target-relative variant used by onCritFor, onAfterTypeEffectivenessFor,
 * and onChooseDefensiveStatFor. `APPLY_ON_ATTACKER`/`APPLY_ON_TARGET`/
 * `APPLY_ON_ATTACKER_OR_TARGET` are a SEPARATE enum (AbilityApplyOnWithTarget) from
 * plain AbilityApplyOn, represented here as string literals since they don't share
 * the bitflag arithmetic above.
 */
export type TargetedApplyOn = 'APPLY_ON_ATTACKER_OR_TARGET' | 'APPLY_ON_ATTACKER' | 'APPLY_ON_TARGET' | number

export function isTargettedApplyOnFlagAppropriate(
  sourceIsAttacker: boolean,
  sourceIsTarget: boolean,
  isSelf: boolean,
  isAlly: boolean,
  flag: TargetedApplyOn = APPLY_ON_SELF,
): boolean {
  if (flag === 'APPLY_ON_ATTACKER_OR_TARGET') return sourceIsAttacker || sourceIsTarget
  if (flag === 'APPLY_ON_ATTACKER') return sourceIsAttacker
  if (flag === 'APPLY_ON_TARGET') return sourceIsTarget
  return isApplyOnFlagAppropriate(isSelf, isAlly, flag)
}
