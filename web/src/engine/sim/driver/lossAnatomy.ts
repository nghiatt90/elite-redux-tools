// Loss anatomy (docs/battle-sim/solver-v2-plan.md Step 2.2, decision 9c).
//
// `BattleSummary` is the small record `playExpectimaxBattle` returns alongside
// `{outcome, turns, finalScore}`: what happened to the player's side, not why the
// policy scored any leaf the way it did. `lossAnatomy` folds the summaries of many
// games into the histogram a not-reliably-`won` unit's report prints. Pure and
// headless: no session, no RNG, no React.

/** What a single game's summary records.
 *
 * `firstFaintTurn` is the 1-based turn number (the loop counter `turns` in
 * `playExpectimaxBattle`) after whose step the player's first mon was down; null
 * when none fainted. `faintedSlots` are the player party slots (indices into
 * `sides[0].party`) that were down at the end of the battle. `endSlot` is the party
 * slot of the player's active battler at the end (`battlers[0].partyIndex`).
 * `opponentRemaining` counts the opponent mons still alive at the end. */
export interface BattleSummary {
  firstFaintTurn: number | null
  faintedSlots: number[]
  endSlot: number
  opponentRemaining: number
}

/** The aggregate of many games' summaries, over the games whose outcome is not
 * `'WON'` only. `games` counts every input; `losses` the non-WON ones. In the
 * `firstFaintHistogram`, a loss whose `firstFaintTurn` is null is counted under
 * key `0`. `meanOpponentRemainingInLosses` is null when there are no losses. */
export interface LossAnatomy {
  games: number
  losses: number
  firstFaintHistogram: Record<number, number>
  endSlotCounts: Record<number, number>
  meanOpponentRemainingInLosses: number | null
}

/** Aggregate the summaries of `results` into a loss anatomy. WON games are counted
 * by `games` only; their summary never enters the histogram or the mean. */
export function lossAnatomy(
  results: Array<{ outcome: string; summary: BattleSummary }>,
): LossAnatomy {
  const firstFaintHistogram: Record<number, number> = {}
  const endSlotCounts: Record<number, number> = {}
  let losses = 0
  let opponentRemainingSum = 0
  for (const { outcome, summary } of results) {
    if (outcome === 'WON') continue
    losses++
    const faintKey = summary.firstFaintTurn ?? 0
    firstFaintHistogram[faintKey] = (firstFaintHistogram[faintKey] ?? 0) + 1
    endSlotCounts[summary.endSlot] = (endSlotCounts[summary.endSlot] ?? 0) + 1
    opponentRemainingSum += summary.opponentRemaining
  }
  return {
    games: results.length,
    losses,
    firstFaintHistogram,
    endSlotCounts,
    meanOpponentRemainingInLosses: losses === 0 ? null : opponentRemainingSum / losses,
  }
}
