// Starting PP and PP refills for every mon in the built game.
//
// GetBoxMonData always reports MON_DATA_PP_BONUSES = 255 (pokemon.c:1487-1488)
// and SetBoxMonData ignores writes to it (pokemon.c:1853), so every move slot's
// bonus is 3. CalculatePPWithBonus (pokemon.c:2260-2263) turns that into
// basePP + ((basePP * 20 * bonus) / 100), integer division: 0->0, 1->1, 5->8,
// 10->16, 15->24, 20->32.
//
// The player is the exception in Hell mode only. CalculatePPWithBonusPlayer
// (pokemon.c:2239-2258) returns 2 for sleep-inflicting moves and Rest/Sleep
// Talk and base PP for everything else while isHellMode() (pokemon.c:6432).
// The custom in-game partner is a second exception: FillPartnerParty writes
// plain base PP (battle_tower.c:2450-2453).

const PP_BONUS_LEVEL = 3
const HELL_MODE_REDUCED_PP_FOR_SLEEPING_MOVES = 2
const HELL_MODE_SLEEP_EFFECTS: ReadonlySet<string> = new Set([
  'EFFECT_SLEEP_HIT',
  'EFFECT_SLEEP',
  'EFFECT_SNORE',
  'EFFECT_REST',
  'EFFECT_SLEEP_TALK',
])

/** CalculatePPWithBonus (pokemon.c:2260-2263): base PP plus the always-3 bonus. */
export function calculatePpWithBonus(basePp: number): number {
  return basePp + Math.floor((basePp * 20 * PP_BONUS_LEVEL) / 100)
}

/**
 * CalculatePPWithBonusPlayer (pokemon.c:2239-2258): in Hell mode a sleep move
 * (and Rest/Sleep Talk) gets 2 PP and every other move base PP; otherwise the
 * same bonus-3 maximum as the foe.
 */
export function calculatePlayerPpWithBonus(
  basePp: number,
  moveEffect: string | null | undefined,
  hellMode: boolean,
): number {
  if (!hellMode) return calculatePpWithBonus(basePp)
  if (moveEffect !== null && moveEffect !== undefined && HELL_MODE_SLEEP_EFFECTS.has(moveEffect)) {
    return HELL_MODE_REDUCED_PP_FOR_SLEEPING_MOVES
  }
  return basePp
}
