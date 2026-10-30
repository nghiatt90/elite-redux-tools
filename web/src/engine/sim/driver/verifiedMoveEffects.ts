const CYCLE114 = 'web/src/engine/sim/cycle114StatusEffects.test.ts'

export const VERIFIED_MOVE_EFFECTS: Map<string, string> = new Map<string, string>(
  [
    'EFFECT_REST',
    'EFFECT_ROOST',
    'EFFECT_RESTORE_HP',
    'EFFECT_HEALING_WISH',
    'EFFECT_SUBSTITUTE',
    'EFFECT_SPEED_UP_2',
    'EFFECT_ATTACK_UP_2',
    'EFFECT_SPECIAL_ATTACK_UP_2',
    'EFFECT_DEFENSE_UP_2',
    'EFFECT_BULK_UP',
    'EFFECT_CALM_MIND',
    'EFFECT_DRAGON_DANCE',
  ].map((effect): [string, string] => [effect, CYCLE114]),
)

interface GateView {
  power?: number | null
  effect?: string | null
}

export function isGatedMove(move: GateView): boolean {
  return !move.power || move.power <= 1
}

export function isEligibleMove(move: GateView): boolean {
  return !isGatedMove(move) || VERIFIED_MOVE_EFFECTS.has(move.effect ?? 'NONE')
}
