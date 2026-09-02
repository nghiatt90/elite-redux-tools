import { BrowserRouter, Route, Routes } from 'react-router'
import { GameDataProvider, useGameDataState } from './lib/GameDataContext'
import ThemeToggle from './lib/ThemeToggle'
import PokedexDetail from './routes/PokedexDetail'
import PokedexList from './routes/PokedexList'

function Header() {
  const state = useGameDataState()
  const meta = state.status === 'ready' ? state.data.meta : undefined

  return (
    <header
      className="flex items-center justify-between border-b px-4 py-2 shrink-0"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="font-semibold shrink-0">Elite Redux Pokedex</span>
        {meta && (
          <span
            className="text-xs truncate hidden sm:inline"
            style={{ color: 'var(--color-text-muted)' }}
            title={`Data generated ${meta.generatedAt}`}
          >
            {meta.gameVersion} · data as of {meta.generatedAt.slice(0, 10)}
          </span>
        )}
      </div>
      <ThemeToggle />
    </header>
  )
}

function Footer() {
  const state = useGameDataState()
  const meta = state.status === 'ready' ? state.data.meta : undefined
  const sha = meta?.sources['er-config']?.sha.slice(0, 7)

  return (
    <footer
      className="shrink-0 border-t px-4 py-1.5 text-xs flex items-center justify-between gap-2"
      style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
    >
      <span>
        Unofficial fan tool for{' '}
        <a href="https://eliteredux.net" target="_blank" rel="noreferrer" className="underline">
          Elite Redux
        </a>
        , not affiliated with its developers.
      </span>
      {sha && <span className="shrink-0 hidden sm:inline">data @ {sha}</span>}
    </footer>
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
          <Footer />
        </div>
      </GameDataProvider>
    </BrowserRouter>
  )
}
