import { BrowserRouter, Route, Routes } from 'react-router'
import { GameDataProvider, useGameDataState } from './lib/GameDataContext'
import ThemeToggle from './lib/ThemeToggle'
import PokedexDetail from './routes/PokedexDetail'
import PokedexList from './routes/PokedexList'

function Header() {
  return (
    <header
      className="flex items-center justify-between border-b px-4 py-2 shrink-0"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <span className="font-semibold">Elite Redux Pokedex</span>
      <ThemeToggle />
    </header>
  )
}

function AppRoutes() {
  const state = useGameDataState()

  if (state.status === 'loading') {
    return <div className="p-4">Loading Pokedex data…</div>
  }
  if (state.status === 'error') {
    return (
      <div className="p-4" style={{ color: 'var(--color-danger)' }}>
        Failed to load data: {state.error.message}
      </div>
    )
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
        <div
          className="h-screen flex flex-col"
          style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}
        >
          <Header />
          <div className="flex-1 min-h-0">
            <AppRoutes />
          </div>
        </div>
      </GameDataProvider>
    </BrowserRouter>
  )
}
