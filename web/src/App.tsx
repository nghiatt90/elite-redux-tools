import { BrowserRouter, Route, Routes } from 'react-router'
import { GameDataProvider, useGameDataState } from './lib/GameDataContext'
import PokedexDetail from './routes/PokedexDetail'
import PokedexList from './routes/PokedexList'

function AppRoutes() {
  const state = useGameDataState()

  if (state.status === 'loading') {
    return <div className="p-4">Loading Pokedex data…</div>
  }
  if (state.status === 'error') {
    return <div className="p-4 text-red-600">Failed to load data: {state.error.message}</div>
  }

  return (
    <Routes>
      <Route path="/" element={<PokedexList />} />
      <Route path="/pokemon/:id" element={<PokedexDetail />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <GameDataProvider>
        <AppRoutes />
      </GameDataProvider>
    </BrowserRouter>
  )
}
