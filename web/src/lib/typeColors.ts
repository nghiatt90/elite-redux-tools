// ER's 20 types (18 standard + Mystery + Stellar), keyed the same way types.json is:
// bare uppercase name, no TYPE_ prefix. Colours are the well-established Pokemon type
// palette; Mystery and Stellar aren't standardized anywhere, so these are original.
export const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  NORMAL: { bg: '#A8A878', fg: '#1a1a15' },
  FIGHTING: { bg: '#C03028', fg: '#ffffff' },
  FLYING: { bg: '#A890F0', fg: '#1a1a15' },
  POISON: { bg: '#A040A0', fg: '#ffffff' },
  GROUND: { bg: '#E0C068', fg: '#1a1a15' },
  ROCK: { bg: '#B8A038', fg: '#ffffff' },
  BUG: { bg: '#A8B820', fg: '#1a1a15' },
  GHOST: { bg: '#705898', fg: '#ffffff' },
  STEEL: { bg: '#B8B8D0', fg: '#1a1a15' },
  MYSTERY: { bg: '#6b6b6b', fg: '#ffffff' },
  FIRE: { bg: '#F08030', fg: '#1a1a15' },
  WATER: { bg: '#6890F0', fg: '#ffffff' },
  GRASS: { bg: '#78C850', fg: '#1a1a15' },
  ELECTRIC: { bg: '#F8D030', fg: '#1a1a15' },
  PSYCHIC: { bg: '#F85888', fg: '#ffffff' },
  ICE: { bg: '#98D8D8', fg: '#1a1a15' },
  DRAGON: { bg: '#7038F8', fg: '#ffffff' },
  DARK: { bg: '#705848', fg: '#ffffff' },
  FAIRY: { bg: '#EE99AC', fg: '#1a1a15' },
  STELLAR: { bg: '#a884e0', fg: '#ffffff' },
}

export function typeColor(type: string) {
  return TYPE_COLORS[type] ?? { bg: '#888888', fg: '#ffffff' }
}
