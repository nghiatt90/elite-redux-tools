import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { loadAbilities, loadItems, loadMeta, loadMoves, loadSpecies, loadTypeChart } from './data'
import type { Ability, Item, Meta, Move, Species, TypeChart } from './types'

interface GameData {
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

type State =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: GameData }

const GameDataStateContext = createContext<State>({ status: 'loading' })

export function GameDataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    Promise.all([
      loadSpecies(),
      loadMoves(),
      loadAbilities(),
      loadItems(),
      loadTypeChart(),
      loadMeta(),
    ])
      .then(([species, moves, abilities, items, typeChart, meta]) => {
        if (cancelled) return
        setState({
          status: 'ready',
          data: {
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
  }, [])

  return (
    <GameDataStateContext.Provider value={state}>{children}</GameDataStateContext.Provider>
  )
}

export function useGameDataState() {
  return useContext(GameDataStateContext)
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

