/// <reference lib="webworker" />
// Runs both PID Finder and Species Finder off the main thread -- a real search can be
// tens of millions of candidate generations/verifications (see randomizer.ts), and
// Species Finder repeats that per sampled species. See protocol.ts for the message
// shapes exchanged with the UI.
import {
  buildAbilityGroups,
  buildCondition,
  buildSpeciesEntry,
  contextFromGroups,
  searchSpecies,
  type AbilityGroups,
  type MatchResult,
  type RandomizerContext,
  type SpeciesEntry,
} from '../../lib/randomizer'
import type { Species } from '../../lib/types'
import type {
  PidSearchRequest,
  SpeciesResultMessage,
  SpeciesSearchRequest,
  WorkerMessage,
  WorkerRequest,
} from './protocol'

let groups: AbilityGroups | null = null
let ctx: RandomizerContext | null = null
let speciesList: Species[] = []
let speciesEntries = new Map<string, SpeciesEntry>()

let cancelledRequestId: number | null = null

function post(message: WorkerMessage): void {
  postMessage(message)
}

function entryFor(species: Species): SpeciesEntry {
  let entry = speciesEntries.get(species.id)
  if (!entry) {
    entry = buildSpeciesEntry(species, groups!)
    speciesEntries.set(species.id, entry)
  }
  return entry
}

function handleInit(msg: Extract<WorkerRequest, { type: 'init' }>): void {
  groups = buildAbilityGroups(msg.abilities, msg.abilitiesCount)
  ctx = contextFromGroups(groups)
  speciesList = msg.species
  speciesEntries = new Map()
  post({ type: 'ready' })
}

function handlePidSearch(msg: PidSearchRequest): void {
  if (!groups || !ctx) return
  const species = speciesList.find((s) => s.id === msg.speciesId)
  if (!species) {
    post({ type: 'error', requestId: msg.requestId, message: `unknown species ${msg.speciesId}` })
    return
  }
  const entry = entryFor(species)
  const conditions = msg.lockedAbilityIds
    .map((id) => groups!.numById.get(id))
    .filter((n): n is number => n !== undefined)
    .map((num) => buildCondition(num, groups!, msg.acceptOptions))

  const results = searchSpecies(entry, conditions, ctx, msg.modes)
  post({ type: 'pidResult', requestId: msg.requestId, results })
}

// Fisher-Yates partial shuffle -- picks `count` distinct random indices without
// materializing a full shuffled copy of a potentially 1900-entry array.
function sampleIndices(populationSize: number, count: number): number[] {
  const indices = Array.from({ length: populationSize }, (_, i) => i)
  const n = Math.min(count, populationSize)
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (populationSize - i))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return indices.slice(0, n)
}

function handleSpeciesSearch(msg: SpeciesSearchRequest): void {
  if (!groups || !ctx) return
  const conditions = msg.lockedAbilityIds
    .map((id) => groups!.numById.get(id))
    .filter((n): n is number => n !== undefined)
    .map((num) => buildCondition(num, groups!, msg.acceptOptions))

  const population = msg.fullyEvolvedOnly ? speciesList.filter((s) => s.evolutions.length === 0) : speciesList
  const indices = sampleIndices(population.length, msg.sampleSize)

  let totalAcrossSample = 0
  let speciesWithAnyMatch = 0
  const bySlotCost = new Map<number, number>()
  const pooled: { match: MatchResult; speciesId: string }[] = []
  const trivialSpecies: { speciesId: string; abilityNum: number }[] = []

  for (let i = 0; i < indices.length; i++) {
    if (cancelledRequestId === msg.requestId) return
    const species = population[indices[i]]
    const entry = entryFor(species)
    const result = searchSpecies(entry, conditions, ctx, msg.modes)

    if (result.kind === 'trivial-all-match') {
      trivialSpecies.push({ speciesId: species.id, abilityNum: result.abilityNum })
    } else if (result.total > 0) {
      speciesWithAnyMatch++
      totalAcrossSample += result.total
      for (const [cost, count] of result.bySlotCost) {
        bySlotCost.set(cost, (bySlotCost.get(cost) ?? 0) + count)
      }
      for (const m of result.promoted) pooled.push({ match: m, speciesId: species.id })
      for (const m of result.sample) pooled.push({ match: m, speciesId: species.id })
    }

    if (i % 5 === 0 || i === indices.length - 1) {
      post({ type: 'progress', requestId: msg.requestId, scanned: i + 1, totalToScan: indices.length })
    }
  }

  // Global promoted: re-rank the pooled per-species promoted/sample entries by slot
  // cost. Global sample: a fresh reservoir pass over the pool -- each pooled entry is
  // itself already a genuine match, just not perfectly uniformly drawn from the full
  // population (Species Finder is an estimate, not an exact search, by design).
  pooled.sort((a, b) => a.match.slotCost - b.match.slotCost || a.match.pid - b.match.pid)
  const promoted = pooled.slice(0, 20)

  const reservoirSize = 1000
  const sample: typeof pooled = []
  let seen = 0
  for (const item of pooled) {
    seen++
    if (sample.length < reservoirSize) sample.push(item)
    else {
      const j = Math.floor(Math.random() * seen)
      if (j < reservoirSize) sample[j] = item
    }
  }

  const estimatedTotal =
    speciesWithAnyMatch === 0
      ? null
      : Math.round((totalAcrossSample / indices.length) * population.length)

  const msgOut: SpeciesResultMessage = {
    type: 'speciesResult',
    requestId: msg.requestId,
    estimatedTotal,
    populationSize: population.length,
    sampledCount: indices.length,
    bySlotCost: [...bySlotCost.entries()],
    promoted: promoted.map(({ match, speciesId }) => ({ ...match, speciesId })),
    sample: sample.map(({ match, speciesId }) => ({ ...match, speciesId })),
    trivialSpecies,
  }
  post(msgOut)
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'init':
        handleInit(msg)
        break
      case 'pidSearch':
        handlePidSearch(msg)
        break
      case 'speciesSearch':
        handleSpeciesSearch(msg)
        break
      case 'cancel':
        cancelledRequestId = msg.requestId
        break
    }
  } catch (err) {
    post({
      type: 'error',
      requestId: 'requestId' in msg ? msg.requestId : undefined,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
