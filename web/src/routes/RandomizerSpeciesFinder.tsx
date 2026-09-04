import { useMemo } from 'react'
import { useSearchParams } from 'react-router'
import AbilityLockPicker from '../features/randomizer/AbilityLockPicker'
import { buildIdByNum } from '../features/randomizer/numToId'
import RandomizerControls from '../features/randomizer/RandomizerControls'
import ResultsView from '../features/randomizer/ResultsView'
import { useRandomizerWorker } from '../features/randomizer/useRandomizerWorker'
import {
  acceptOptionsFromParams,
  acceptOptionsToParams,
  lockedAbilitiesFromParams,
  lockedAbilitiesToParams,
  modesFromParams,
  modesToParams,
} from '../features/randomizer/urlState'
import { displayName } from '../lib/displayName'
import { useGameData } from '../lib/GameDataContext'
import { formatHex } from '../lib/hex'

const SAMPLE_SIZE = 40

export default function RandomizerSpeciesFinder() {
  const { abilities, speciesById } = useGameData()
  const [searchParams, setSearchParams] = useSearchParams()
  const { ready, searching, progress, error, speciesResult, runSpeciesSearch, cancel } = useRandomizerWorker()

  const lockedAbilityIds = lockedAbilitiesFromParams(searchParams)
  const acceptOptions = acceptOptionsFromParams(searchParams)
  const modes = modesFromParams(searchParams)
  const fullyEvolvedOnly = searchParams.get('fullyEvolved') !== '0'
  const idByNum = useMemo(() => buildIdByNum(abilities), [abilities])

  const canSearch = ready && lockedAbilityIds.length > 0

  function update(mutate: (params: URLSearchParams) => URLSearchParams) {
    setSearchParams(mutate(new URLSearchParams(searchParams)))
  }

  function handleSearch() {
    if (!canSearch) return
    runSpeciesSearch({ lockedAbilityIds, acceptOptions, modes, fullyEvolvedOnly, sampleSize: SAMPLE_SIZE })
  }

  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-4 max-w-3xl mx-auto">
      <div>
        <h1 className="text-lg font-semibold">Species Finder</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          Lock up to 4 target abilities/innates and find which species can roll them --
          species unknown, so this scans a random sample ({SAMPLE_SIZE} at a time) and
          reports an <strong>estimated</strong> total, not an exact one (exhausting even the
          fully-evolved set is on the order of tens of billions of candidates).
        </p>
      </div>

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

      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={fullyEvolvedOnly}
          onChange={(e) =>
            update((p) => {
              if (e.target.checked) p.delete('fullyEvolved')
              else p.set('fullyEvolved', '0')
              return p
            })
          }
        />
        Fully evolved only
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canSearch || searching}
          onClick={handleSearch}
          className="self-start rounded-md border px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}
        >
          {searching ? 'Scanning…' : 'Search'}
        </button>
        {searching && (
          <button
            type="button"
            onClick={cancel}
            className="text-xs rounded-md border px-2 py-1"
            style={{ borderColor: 'var(--color-border)' }}
          >
            Cancel
          </button>
        )}
        {searching && progress && (
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            scanned {progress.scanned}/{progress.totalToScan} species
          </span>
        )}
      </div>

      {!ready && <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading search worker…</p>}
      {error && <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{error}</p>}

      {speciesResult && (
        <>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            scanned {speciesResult.sampledCount} of {speciesResult.populationSize.toLocaleString()} species
          </p>

          {speciesResult.trivialSpecies.length > 0 && (
            <div className="rounded-md border p-3 text-sm" style={{ borderColor: 'var(--color-border)' }}>
              {speciesResult.trivialSpecies.length} sampled species always match, for every PID (a fixed slot
              already covers every locked condition):{' '}
              {speciesResult.trivialSpecies
                .map((t) => speciesById.get(t.speciesId)?.name ?? t.speciesId)
                .join(', ')}
            </div>
          )}

          <ResultsView
            total={speciesResult.estimatedTotal}
            exact={false}
            bySlotCost={speciesResult.bySlotCost}
            promoted={speciesResult.promoted.map((m) => ({
              key: `${m.speciesId}-${formatHex(m.pid)}`,
              pid: m.pid,
              abilityNum: m.abilityNum,
              slotCost: m.slotCost,
              resultAbilities: m.resultAbilities.map((n) => idByNum[n]),
              speciesName: speciesById.get(m.speciesId) && displayName(speciesById.get(m.speciesId)!, speciesById),
            }))}
            sample={speciesResult.sample.map((m) => ({
              key: `${m.speciesId}-${formatHex(m.pid)}`,
              pid: m.pid,
              abilityNum: m.abilityNum,
              slotCost: m.slotCost,
              resultAbilities: m.resultAbilities.map((n) => idByNum[n]),
              speciesName: speciesById.get(m.speciesId) && displayName(speciesById.get(m.speciesId)!, speciesById),
            }))}
          />
        </>
      )}
    </div>
  )
}
