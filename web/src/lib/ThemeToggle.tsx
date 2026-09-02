import { useState } from 'react'
import { applyTheme, getInitialTheme, type Theme } from './theme'

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    setTheme(next)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="rounded-md border px-2 py-1 text-sm"
      style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  )
}
