export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'er-tools-theme'

// Dark is the default look regardless of system preference (see index.css) -- a
// stored choice always wins, but a first visit starts dark.
export function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // localStorage unavailable (private mode, etc.) -- fall through to default
  }
  return 'dark'
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // best-effort persistence only
  }
}
