import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  DEFAULT_DATA_VERSION,
  getDataVersion,
  loadAbilities,
  loadItems,
  loadMeta,
  loadMoves,
  loadSpecies,
  loadSpriteOverrides,
  loadTypeChart,
  setDataVersion,
  setSpriteOverrides,
  type DataVersion,
} from './data'
import type { Ability, Item, Meta, Move, Species, TypeChart } from './types'

export interface GameData {
  version: DataVersion
  species: Species[]
  speciesById: Map<string, Species>
  moves: Move[]
  movesById: Map<string, Move>
  abilities: Ability[]
  abilitiesById: Map<string, Ability>
  items: Item[]
  itemsById: Map<string, Item>
  typeChart: TypeChart
  meta: Meta
}

export type State =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: GameData }

interface GameDataVersionContextValue {
  version: DataVersion
  setVersion: (v: DataVersion) => void
}

const GameDataStateContext = createContext<State>({ status: 'loading' })
const GameDataVersionContext = createContext<GameDataVersionContextValue>({
  version: DEFAULT_DATA_VERSION,
  setVersion: () => {},
})

export function GameDataProvider({ children }: { children: ReactNode }) {
  const [version, setVersionState] = useState<DataVersion>(() => getDataVersion())
  const [state, setState] = useState<State>({ status: 'loading' })

  const setVersion = useCallback((newVersion: DataVersion) => {
    setDataVersion(newVersion)
    if (typeof window !== 'undefined' && window.location?.search) {
      const params = new URLSearchParams(window.location.search)
      if (params.has('v')) {
        params.set('v', newVersion)
        const query = params.toString()
        const newUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
        window.history.replaceState(null, '', newUrl)
      }
    }
    setVersionState(newVersion)
  }, [])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    Promise.all([
      loadSpecies(version),
      loadMoves(version),
      loadAbilities(version),
      loadItems(version),
      loadTypeChart(version),
      loadMeta(version),
      loadSpriteOverrides(version),
    ])
      .then(([species, moves, abilities, items, typeChart, meta, overrides]) => {
        if (cancelled) return
        setSpriteOverrides(version, overrides)
        setState({
          status: 'ready',
          data: {
            version,
            species,
            speciesById: new Map(species.map((s) => [s.id, s])),
            moves,
            movesById: new Map(moves.map((m) => [m.id, m])),
            abilities,
            abilitiesById: new Map(abilities.map((a) => [a.id, a])),
            items,
            itemsById: new Map(items.map((i) => [i.id, i])),
            typeChart,
            meta,
          },
        })
      })
      .catch((error: Error) => {
        if (!cancelled) setState({ status: 'error', error })
      })
    return () => {
      cancelled = true
    }
  }, [version])

  const versionValue = useMemo(() => ({ version, setVersion }), [version, setVersion])

  return (
    <GameDataVersionContext.Provider value={versionValue}>
      <GameDataStateContext.Provider value={state}>
        {children}
      </GameDataStateContext.Provider>
    </GameDataVersionContext.Provider>
  )
}

export function useGameDataState() {
  return useContext(GameDataStateContext)
}

export function useGameDataVersion() {
  return useContext(GameDataVersionContext)
}

/** Only valid to call from inside a subtree that has already checked status === 'ready'. */
export function useGameData(): GameData {
  const state = useGameDataState()
  if (state.status !== 'ready') {
    throw new Error('useGameData() called before game data finished loading')
  }
  return state.data
}

export function useMoveDisplayName(id: string | undefined): string {
  const { movesById } = useGameData()
  if (!id) return ''
  return movesById.get(id)?.name ?? id
}

export function useAbilityDisplayName(id: string | undefined): string {
  const { abilitiesById } = useGameData()
  if (!id) return ''
  return abilitiesById.get(id)?.name ?? id
}
