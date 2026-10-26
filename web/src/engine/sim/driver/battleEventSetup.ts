// Helper to filter and setup battle events from encounters.json data.

import type { EncounterBattleEvent } from './loadSimData'

export interface EventsForFightResult extends Array<EncounterBattleEvent> {
  events: EncounterBattleEvent[]
  skippedGuards: string[]
}

const DEFEATED_GUARD_RE = /^!defeated\(([^)]+)\)$/

/**
 * Filters registered battle events for mapName based on defeated trainers.
 * Rows whose guard is null or `!defeated(TRAINER_X)` with X not in defeated are included.
 * Any other guard expression is skipped and recorded in skippedGuards.
 */
export function eventsForFight(
  encounters: { battleEvents?: EncounterBattleEvent[] } | readonly EncounterBattleEvent[],
  mapName: string,
  defeated: ReadonlySet<string>,
): EventsForFightResult {
  const rows: readonly EncounterBattleEvent[] = Array.isArray(encounters)
    ? (encounters as readonly EncounterBattleEvent[])
    : ((encounters as { battleEvents?: EncounterBattleEvent[] }).battleEvents ?? [])

  const events: EncounterBattleEvent[] = []
  const skippedGuards: string[] = []

  for (const row of rows) {
    if (row.map !== mapName) continue

    if (row.guard === null) {
      events.push(row)
    } else {
      const match = DEFEATED_GUARD_RE.exec(row.guard)
      if (match) {
        const trainerId = match[1]!
        if (!defeated.has(trainerId)) {
          events.push(row)
        }
      } else {
        skippedGuards.push(row.guard)
      }
    }
  }

  const result = [...events] as EventsForFightResult
  result.events = events
  result.skippedGuards = skippedGuards
  return result
}
