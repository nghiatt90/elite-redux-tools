import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router'
import { GameDataProvider, useGameDataState } from './lib/GameDataContext'
import ThemeToggle from './lib/ThemeToggle'
import PokedexDetail from './routes/PokedexDetail'
import PokedexShell from './routes/PokedexShell'
import RandomizerLayout from './routes/RandomizerLayout'
import RandomizerPidFinder from './routes/RandomizerPidFinder'
import RandomizerSpeciesFinder from './routes/RandomizerSpeciesFinder'
import UnderConstruction from './routes/UnderConstruction'

const NAV_LINKS = [
  { to: '/', label: 'Pokedex' },
  { to: '/randomizer', label: 'Randomizer' },
  { to: '/team-builder', label: 'Team Builder' },
  { to: '/damage-calculator', label: 'Damage Calculator' },
]

function Nav({ className = '' }: { className?: string }) {
  return (
    <nav className={`flex items-center gap-1 ${className}`}>
      {NAV_LINKS.map(({ to, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className="rounded-md px-2 py-1 text-sm whitespace-nowrap"
          style={({ isActive }) => ({
            background: isActive ? 'var(--color-bg-hover)' : undefined,
            color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
            fontWeight: isActive ? 600 : 400,
          })}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  )
}

function Header() {
  const state = useGameDataState()
  const meta = state.status === 'ready' ? state.data.meta : undefined

  return (
    <header className="border-b shrink-0" style={{ borderColor: 'var(--color-border)' }}>
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <div className="flex items-center gap-4 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0 shrink-0">
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
          {/* Desktop/tablet: nav sits inline next to the title. Below sm it moves to
              its own row (below) instead -- three labels plus the title and toggle
              don't fit on one line at phone widths without wrapping mid-word. */}
          <Nav className="hidden sm:flex" />
        </div>
        <ThemeToggle />
      </div>
      <Nav className="sm:hidden px-4 pb-2 overflow-x-auto" />
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
      {/* PokedexShell is a persistent layout, not a page -- it stays mounted (list
          scroll position, filters, search all preserved) while /pokemon/:id renders
          PokedexDetail into its <Outlet/> as a split-pane detail column (desktop) or
          a full-screen view (mobile/tablet); see PokedexShell.tsx. */}
      <Route path="/" element={<PokedexShell />}>
        <Route path="pokemon/:id" element={<PokedexDetail />} />
      </Route>
      <Route path="/randomizer" element={<RandomizerLayout />}>
        <Route index element={<Navigate to="pid" replace />} />
        <Route path="pid" element={<RandomizerPidFinder />} />
        <Route path="species" element={<RandomizerSpeciesFinder />} />
      </Route>
      <Route path="/team-builder" element={<UnderConstruction title="Team Builder" />} />
      <Route path="/damage-calculator" element={<UnderConstruction title="Damage Calculator" />} />
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
