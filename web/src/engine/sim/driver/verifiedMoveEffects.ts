export const VERIFIED_MOVE_EFFECTS: Map<string, string> = new Map<string, string>()

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
