// Shared move-shape conversion, used by anything that hands a lib/types.ts Move to
// the engine. Extracted out of features/damageCalc/scenario.ts (which owns the
// UI-facing BattlerConfig/FieldConfig shapes) so lib/matchupReport.ts -- a headless
// module with no business being downstream of a feature -- can build MoveData
// without duplicating this logic. features/damageCalc/scenario.ts re-exports these
// rather than redefining them, so its own behavior is unchanged.

import type { MoveData } from '../engine/calculate'
import type { Move } from './types'

export function bareType(t: string): string {
  return t.replace('TYPE_', '')
}

export function toMoveData(move: Move): MoveData {
  return {
    id: move.id,
    power: move.power,
    type: move.type ? bareType(move.type) : null,
    type2: move.type2 ? bareType(move.type2) : null,
    split: move.split,
    effectChance: move.effectChance,
    splitFlag: move.splitFlag,
    effect: move.effect,
    customBehavior: move.customBehavior,
    crit: move.crit,
    hitsAir: move.hitsAir,
    flags: move.flags,
    priority: move.priority,
    changeTypeHoldEffect: move.effect === 'EFFECT_CHANGE_TYPE_ON_ITEM' && move.argument?.kind === 'other' ? move.argument.value : null,
    miscEffect: move.effect === 'EFFECT_MISC_HIT' && move.argument?.kind === 'misc' ? move.argument.misc : null,
    multiHitArgument: move.effect === 'EFFECT_DOUBLE_HIT' && move.argument?.kind === 'int' ? move.argument.value : null,
  }
}
