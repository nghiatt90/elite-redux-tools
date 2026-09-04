// Batch AN: Normalize and Superconductor. Both read the SAME per-battler
// gBattleStruct->ateBoost[battler] flag in their onOffensiveMultiplier (Normalize:
// "moveType==NORMAL && ateBoost", src/abilities.cc:1558-1568; Superconductor:
// "moveType==NORMAL && ateBoost", src/abilities.cc:8187-8196, despite converting
// TO Electric itself) -- a real but rare multi-ability-slot combo (this ROM hack
// allows main+2 innate slots), since NEITHER ability's own onMoveType conversion
// satisfies its own onOffensiveMultiplier condition alone: Normalize's onMoveType
// doesn't set ateBoost at all, and Superconductor's own conversion (Steel->Electric)
// leaves the resolved type as Electric, not Normal. The bonus only fires when this
// battler holds BOTH abilities (or Normalize alongside another ability that sets
// ateBoost while ending on Normal) -- resolveEffectiveMoveType (dispatchCalc.ts)
// already threads ateBoost through its onMoveType dispatch loop generically.
//
// In practice this combo is UNREACHABLE with the abilities that exist today: both
// the C (GetMoveTypeInternal's `ON_ABILITY(..., if (newType) return newType - 1;)`)
// and this port's resolveEffectiveMoveType stop at the FIRST ability whose onMoveType
// hook actually changes the type -- only that one ability's ateBoost value survives.
// No ability sets ateBoost=TRUE while its own conversion lands on TYPE_NORMAL (every
// "-ate" ability converts Normal->something-else; Superconductor converts
// Steel->Electric; Normalize converts anything->Normal but never sets ateBoost
// itself). So each hook is still ported faithfully (matching the C bit-for-bit,
// same as e.g. the foesMinRoll/Bad Luck precedent elsewhere in this codebase), but
// the onOffensiveMultiplier bonus on both abilities is dead code with today's
// roster -- verified at the hook level in the test file, not end-to-end.
//
// Normalize's onMoveType is an UNCONDITIONAL "->NORMAL" (no CHECK at all, unlike
// every "-ate" ability's CHECK(moveType==TYPE_NORMAL) in the ATE_ABILITY macro) --
// this was previously deferred (see 16-type-effectiveness.ts's now-stale comment)
// on the belief that resolveEffectiveMoveType only handled the OPPOSITE direction,
// but the dispatcher has no such restriction: it just checks whether the hook
// changed ctx.moveType from the input, regardless of what the input was.
//
// Normalize's onTypeEffectiveness (immunity-breaking, like Corrupted Mind/Angel's
// Wrath in 16-type-effectiveness.ts) is NOT wired into calculate.ts's
// type-effectiveness fold yet (same "correct now, wired later" status as that whole
// file), but the port is faithful regardless.

import { MUL } from '../macros'
import { uq } from '../../fixed'
import type { AbilityImpl } from '../types'

export const NORMALIZE_SUPERCONDUCTOR_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_NORMALIZE',
    src: 'src/abilities.cc:1558',
    onMoveType: (ctx) => {
      ctx.moveType = 'NORMAL'
    },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'NORMAL' && ctx.ateBoost) MUL(ctx, 1.1)
    },
    onTypeEffectiveness: (ctx) => {
      if (ctx.moveType !== 'NORMAL') return
      if (ctx.modifier !== 0 && ctx.modifier < uq(1.0)) ctx.modifier = uq(1.0)
    },
  },
  {
    id: 'ABILITY_SUPERCONDUCTOR',
    src: 'src/abilities.cc:8187',
    onMoveType: (ctx) => {
      if (ctx.moveType !== 'STEEL') return
      ctx.moveType = 'ELECTRIC'
      ctx.ateBoost = true
    },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'NORMAL' && ctx.ateBoost) MUL(ctx, 1.1)
    },
  },
]
