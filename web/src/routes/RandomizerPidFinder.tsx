import { useMemo } from 'react'
import { useSearchParams } from 'react-router'
import AbilityLockPicker from '../features/randomizer/AbilityLockPicker'
import { buildIdByNum } from '../features/randomizer/numToId'
import RandomizerControls from '../features/randomizer/RandomizerControls'
import ResultsView from '../features/randomizer/ResultsView'
import SpeciesPicker from '../features/randomizer/SpeciesPicker'
import { useRandomizerWorker } from '../features/randomizer/useRandomizerWorker'
import {
  acceptOptionsFromParams,
  acceptOptionsToParams,
  lockedAbilitiesFromParams,
  lockedAbilitiesToParams,
  modesFromParams,
  modesToParams,
} from '../features/randomizer/urlState'
import { useGameData } from '../lib/GameDataContext'
import { formatHex } from '../lib/hex'

export default function RandomizerPidFinder() {
  const { abilities, speciesById } = useGameData()
  const [searchParams, setSearchParams] = useSearchParams()
  const { ready, searching, error, pidResult, runPidSearch } = useRandomizerWorker()

  const speciesId = searchParams.get('species')
  const lockedAbilityIds = lockedAbilitiesFromParams(searchParams)
  const acceptOptions = acceptOptionsFromParams(searchParams)
  const modes = modesFromParams(searchParams)
  const idByNum = useMemo(() => buildIdByNum(abilities), [abilities])

  const species = speciesId ? speciesById.get(speciesId) : undefined
  const canSearch = ready && !!species && lockedAbilityIds.length > 0

  function update(mutate: (params: URLSearchParams) => URLSearchParams) {
    setSearchParams(mutate(new URLSearchParams(searchParams)))
  }

  function handleSpeciesChange(id: string) {
    update((p) => {
      p.set('species', id)
      return p
    })
  }

  function handleSearch() {
    if (!canSearch || !species) return
    runPidSearch({ speciesId: species.id, lockedAbilityIds, acceptOptions, modes })
  }

  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-4 max-w-3xl mx-auto">
      <div>
        <h1 className="text-lg font-semibold">PID Finder</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          Fix a species, lock up to 4 target abilities/innates, and find every PID that
          produces them under the ability/innate randomizer. Exact -- a full pass over
          every candidate PID, not a sample.
        </p>
      </div>

      <SpeciesPicker selectedId={speciesId} onChange={handleSpeciesChange} />

      <AbilityLockPicker
        abilities={abilities}
        selected={lockedAbilityIds}
        onChange={(ids) => update((p) => lockedAbilitiesToParams(ids, p))}
      />

      <RandomizerControls
        acceptOptions={acceptOptions}
        onAcceptOptionsChange={(o) => update((p) => acceptOptionsToParams(o, p))}
        modes={modes}
        onModesChange={(m) => update((p) => modesToParams(m, p))}
      />

      <button
        type="button"
        disabled={!canSearch || searching}
        onClick={handleSearch}
        className="self-start rounded-md border px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}
      >
        {searching ? 'Searching…' : 'Search'}
      </button>

      {!ready && <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading search worker…</p>}
      {error && <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{error}</p>}

      {pidResult?.kind === 'trivial-all-match' && species && (
        <div className="rounded-md border p-3 text-sm" style={{ borderColor: 'var(--color-border)' }}>
          Every PID matches: ability slot {pidResult.abilityNum + 1} on {species.name} already satisfies every
          locked condition without any randomization involved (a banned source, or randomization is off for
          that slot).
        </div>
      )}

      {pidResult?.kind === 'complete' && species && (
        <ResultsView
          total={pidResult.total}
          exact
          bySlotCost={[...pidResult.bySlotCost.entries()]}
          promoted={pidResult.promoted.map((m) => ({
            key: formatHex(m.pid),
            pid: m.pid,
            abilityNum: m.abilityNum,
            slotCost: m.slotCost,
            resultAbilities: m.resultAbilities.map((n) => idByNum[n]),
          }))}
          sample={pidResult.sample.map((m) => ({
            key: formatHex(m.pid),
            pid: m.pid,
            abilityNum: m.abilityNum,
            slotCost: m.slotCost,
            resultAbilities: m.resultAbilities.map((n) => idByNum[n]),
          }))}
        />
      )}
    </div>
  )
}
