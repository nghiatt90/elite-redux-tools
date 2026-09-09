import { NavLink, Outlet } from 'react-router'

const TABS = [
  { to: '/randomizer/pid', label: 'PID Finder' },
  { to: '/randomizer/species', label: 'Species Finder' },
]

/** Shared layout for the two randomizer tools -- same nav entry, a tab switcher
 * between them, and (via Outlet) each tool's own page underneath. */
export default function RandomizerLayout() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex gap-1 border-b px-4 pt-2 shrink-0" style={{ borderColor: 'var(--color-border)' }}>
        {TABS.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className="rounded-t-md px-3 py-1.5 text-sm border border-b-0"
            style={({ isActive }) => ({
              background: isActive ? 'var(--color-bg-elevated)' : 'transparent',
              borderColor: isActive ? 'var(--color-border)' : 'transparent',
              fontWeight: isActive ? 600 : 400,
              color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
            })}
          >
            {label}
          </NavLink>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  )
}
