// The ability lookup table. Populated by `impl/*.ts` batch modules (Task 10) via
// `registerAbilities`; empty until the first batch lands, at which point
// coverage.ts's gate starts holding it accountable against abilityHooks.json.

import type { AbilityEntry } from './types'

const registry = new Map<string, AbilityEntry>()

/** Registers one or more ability entries (ports or explicit UNMODELLED markers).
 * Throws on a duplicate id -- a silent overwrite would hide which batch actually
 * owns an ability, which matters when abilityHooks.json's sourceLine needs cross-
 * checking against a specific port. */
export function registerAbilities(entries: AbilityEntry[]): void {
  for (const entry of entries) {
    if (registry.has(entry.id)) {
      throw new Error(`ability ${entry.id} registered twice -- check for a duplicate entry across impl/*.ts batches`)
    }
    registry.set(entry.id, entry)
  }
}

export function lookupAbility(id: string): AbilityEntry | undefined {
  return registry.get(id)
}

export function allRegisteredAbilities(): AbilityEntry[] {
  return [...registry.values()]
}

/** Test-only: clears the registry so each test file's imports don't accumulate
 * across the whole suite. Not exported from the package's public surface. */
export function _resetRegistryForTests(): void {
  registry.clear()
}
