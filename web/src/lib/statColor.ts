/** Base stat color bucket: <60 / 60-99 / 100-120 / 120+. */
export function statColor(value: number): string {
  if (value < 60) return 'var(--stat-low)'
  if (value < 100) return 'var(--stat-mid)'
  if (value <= 120) return 'var(--stat-high)'
  return 'var(--stat-veryhigh)'
}
