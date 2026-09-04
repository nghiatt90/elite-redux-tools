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
  /** Extrapolated from observed density across the sample -- not exact. Null if
   * every scanned species came back empty (nothing to extrapolate from). */
  estimatedTotal: number | null
  populationSize: number
  sampledCount: number
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
