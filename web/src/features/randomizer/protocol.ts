// Message protocol between the randomizer UI (main thread) and its Web Worker
// (randomizer.worker.ts). Both tools (PID Finder, Species Finder) share one worker.
import type { AcceptSetOptions, MatchResult, RandomizerResults, SearchModes } from '../../lib/randomizer'
import type { Ability, Species } from '../../lib/types'

export interface InitRequest {
  type: 'init'
  abilities: Ability[]
  species: Species[]
  abilitiesCount: number
}

export interface PidSearchRequest {
  type: 'pidSearch'
  requestId: number
  speciesId: string
  lockedAbilityIds: string[] // up to 4 AbilityEnum ids, order doesn't matter
  acceptOptions: AcceptSetOptions
  modes: SearchModes
}

export interface SpeciesSearchRequest {
  type: 'speciesSearch'
  requestId: number
  lockedAbilityIds: string[]
  acceptOptions: AcceptSetOptions
  modes: SearchModes
  fullyEvolvedOnly: boolean
  sampleSize: number
}

export interface CancelRequest {
  type: 'cancel'
  requestId: number
}

export type WorkerRequest = InitRequest | PidSearchRequest | SpeciesSearchRequest | CancelRequest

export interface ReadyMessage {
  type: 'ready'
}

export interface ProgressMessage {
  type: 'progress'
  requestId: number
  scanned: number
  totalToScan: number
}

export interface PidResultMessage {
  type: 'pidResult'
  requestId: number
  results: RandomizerResults
}

export interface SpeciesMatch extends MatchResult {
  speciesId: string
}

export interface SpeciesResultMessage {
  type: 'speciesResult'
  requestId: number
  /** Null when nothing matched at all (nothing to report or extrapolate from). */
  estimatedTotal: number | null
  /** True when the search was complete: every species, every PID. The join path
   * reaches this for most queries; the per-species fallback never does. */
  exact: boolean
  /** Which search answered this. 'join' covers every species at once; 'scan' is the
   * per-species fallback over a random sample of species. */
  method: 'join' | 'scan'
  /** Fraction of the searched space actually walked -- of the seed space for 'join',
   * of the species list for 'scan'. 1 when exact. */
  coverage: number
  populationSize: number
  sampledCount: number
  /** How many distinct species produced at least one match. */
  matchedSpecies: number
  bySlotCost: [number, number][]
  promoted: SpeciesMatch[]
  sample: SpeciesMatch[]
  trivialSpecies: { speciesId: string; abilityNum: number }[]
}

export interface ErrorMessage {
  type: 'error'
  requestId?: number
  message: string
}

export type WorkerMessage = ReadyMessage | ProgressMessage | PidResultMessage | SpeciesResultMessage | ErrorMessage
