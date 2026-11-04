// Difficulty gates for the PLAYER's innates and the strict level-cap table.
//
// Both are transcribed from the C at the pinned SHA:
//   - include/constants/pokemon_config.h:21-31 (thresholds)
//   - src/pokemon.c:6235 CanDisableInnates and :6237-6262 getInnateDisableLevel
//   - src/battle_util.c:8799-8802 GetInnateInSlot (the player-only gate)
//   - src/pokemon.c:4633-4668 GetLevelCap (levelCapsStrict)

export type InnateTier = 'ace' | 'elite' | 'hell'

// Elite mode and Hell mode thresholds for innate slots 0, 1 and 2.
const ELITE_THRESHOLDS: readonly [number, number, number] = [1, 17, 24]
const HELL_THRESHOLDS: readonly [number, number, number] = [10, 17, 24]

// GetLevelCap's `levelCapsStrict`, indexed by highest badge (9 = game clear / League).
const LEVEL_CAPS_STRICT: readonly number[] = [16, 23, 36, 45, 50, 55, 60, 70, 80, 100]

/** Which innate slots a player mon has at `level`.
 * `CanDisableInnates` (src/pokemon.c:6235) is false below DIFFICULTY_ELITE, so
 * 'ace' never gates; at Elite and above the slot is active when the level meets
 * its own threshold. */
export function innateSlotsFor(level: number, tier: InnateTier): [boolean, boolean, boolean] {
  if (tier === 'ace') return [true, true, true]
  const thresholds = tier === 'elite' ? ELITE_THRESHOLDS : HELL_THRESHOLDS
  return [level >= thresholds[0], level >= thresholds[1], level >= thresholds[2]]
}

/** GetInnateInSlot (src/battle_util.c:8799-8802): a player mon below a slot's
 * disable level gets ABILITY_NONE there. Slots already empty stay empty. */
export function gateInnates(
  innates: [string | null, string | null, string | null],
  level: number,
  tier: InnateTier,
): [string | null, string | null, string | null] {
  const slots = innateSlotsFor(level, tier)
  return [slots[0] ? innates[0] : null, slots[1] ? innates[1] : null, slots[2] ? innates[2] : null]
}

/** GetLevelCap's strict table (src/pokemon.c:4661), indexed by highest badge
 * (0..8, where 9 is game clear / League). */
export function levelCapFor(badges: number): number {
  if (!Number.isInteger(badges) || badges < 0 || badges > 9) {
    throw new RangeError(`levelCapFor: badges must be an integer 0..9, got ${badges}`)
  }
  return LEVEL_CAPS_STRICT[badges]!
}
