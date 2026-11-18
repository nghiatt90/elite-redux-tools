// Solver and CLI level cap resolution, evolution gating warnings, and fight reporting.

import type { SimDataBundle } from './loadSimData'
import { FIGHTS, levelCapForTrainer } from './fights'
import { highestBadgeRange } from './progression'

interface EvolutionEdge {
  parent: string
  level: number
}

const inverseGraphCache = new WeakMap<object, Map<string, EvolutionEdge[]>>()

function getInverseGraph(data: { speciesById?: Map<string, any> }): Map<string, EvolutionEdge[]> {
  let graph = inverseGraphCache.get(data)
  if (!graph) {
    graph = new Map<string, EvolutionEdge[]>()
    if (data.speciesById) {
      for (const [id, species] of data.speciesById.entries()) {
        const evolutions = species?.evolutions as Array<{ to?: string; level?: number }> | undefined
        if (Array.isArray(evolutions)) {
          for (const evo of evolutions) {
            if (evo && typeof evo.to === 'string') {
              const list = graph.get(evo.to)
              const edge: EvolutionEdge = {
                parent: id,
                level: typeof evo.level === 'number' && Number.isFinite(evo.level) ? evo.level : 0,
              }
              if (list) {
                list.push(edge)
              } else {
                graph.set(evo.to, [edge])
              }
            }
          }
        }
      }
    }
    inverseGraphCache.set(data, graph)
  }
  return graph
}

/**
 * The largest evolution level along the chain that leads to `speciesId`.
 * Base species (no parent) has level 0.
 */
export function evolveLevel(data: SimDataBundle, speciesId: string): number {
  const graph = getInverseGraph(data)
  const visited = new Set<string>()

  function walk(current: string): number {
    if (visited.has(current)) {
      return 0
    }
    visited.add(current)
    const parents = graph.get(current)
    if (!parents || parents.length === 0) {
      visited.delete(current)
      return 0
    }
    let max = 0
    for (const edge of parents) {
      const parentMax = walk(edge.parent)
      const pathMax = Math.max(edge.level, parentMax)
      if (pathMax > max) {
        max = pathMax
      }
    }
    visited.delete(current)
    return max
  }

  return walk(speciesId)
}

/**
 * Returns warnings for species whose evolveLevel exceeds the cap.
 * Design decision 5: warning only, never rejects.
 */
export function evolutionWarnings(
  data: SimDataBundle,
  speciesIds: string[],
  cap: number,
): string[] {
  const warnings: string[] = []
  for (const species of speciesIds) {
    const needed = evolveLevel(data, species)
    if (needed > cap) {
      warnings.push(`${species} needs level ${needed}, cap is ${cap}`)
    }
  }
  return warnings
}

const PLAYER_OBSERVED_EVIDENCE = 'player-observed (Yoshi), not in the scripts at pin bdebcbbf'

/**
 * Derives the evidence label: 'player-observed (Yoshi), not in the scripts at pin bdebcbbf'
 * if the evidence string contains that literal, else 'script'.
 */
export function evidenceLabel(evidence: string): string {
  return evidence.includes(PLAYER_OBSERVED_EVIDENCE)
    ? PLAYER_OBSERVED_EVIDENCE
    : 'script'
}

export type ResolvedSolverLevel =
  | { kind: 'noRow'; level: number }
  | { kind: 'refused'; message: string }
  | {
      kind: 'capped'
      level: number
      cap: number
      badges: number
      label: string
      ignoreCapUsed: boolean
    }

/**
 * Resolves the player level and cap for a fight.
 */
export function resolveSolverLevel(
  trainerId: string,
  levelArg: number | undefined,
  ignoreCap: boolean,
): ResolvedSolverLevel {
  const result = levelCapForTrainer(trainerId)
  if (!result) {
    return { kind: 'noRow', level: levelArg ?? 50 }
  }
  if ('awaiting' in result) {
    return {
      kind: 'refused',
      message: `refused: ${trainerId} is in fights.ts row ${result.row.fightId} (${result.awaiting}); no level cap is trusted for it`,
    }
  }

  const { cap, row, evidence } = result
  const badges = highestBadgeRange(row).min
  const label = evidenceLabel(evidence)

  if (levelArg === undefined) {
    return {
      kind: 'capped',
      level: cap,
      cap,
      badges,
      label,
      ignoreCapUsed: false,
    }
  }

  if (levelArg <= cap) {
    return {
      kind: 'capped',
      level: levelArg,
      cap,
      badges,
      label,
      ignoreCapUsed: false,
    }
  }

  if (ignoreCap) {
    return {
      kind: 'capped',
      level: levelArg,
      cap,
      badges,
      label,
      ignoreCapUsed: true,
    }
  }

  throw new Error(
    `level ${levelArg} exceeds the level cap ${cap}; pass --ignore-cap to bypass`,
  )
}

/**
 * Report lines for every FIGHTS row with excluded or deferred.
 * One line per trainer id.
 */
export function unrunRows(): string[] {
  const lines: string[] = []
  for (const row of FIGHTS) {
    if (row.excluded !== undefined) {
      for (const trainerId of row.trainerIds) {
        lines.push(`${trainerId}: ${row.excluded}`)
      }
    } else if (row.deferred) {
      for (const trainerId of row.trainerIds) {
        lines.push(`${trainerId}: deferred (v1 scope)`)
      }
    }
  }
  return lines
}
