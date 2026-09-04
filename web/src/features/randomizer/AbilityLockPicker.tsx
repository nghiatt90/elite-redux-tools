import { useMemo } from 'react'
import MultiSelectFilter from '../pokedex/MultiSelectFilter'
import type { Ability } from '../../lib/types'

const MAX_LOCKED = 4

/** Up to 4 locked target abilities -- order doesn't matter, so this is just a capped
 * MultiSelectFilter over every ability by name (not per-species; the target you're
 * searching for, not a species trait to filter by). */
export default function AbilityLockPicker({
  abilities,
  selected,
  onChange,
}: {
  abilities: Ability[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const options = useMemo(() => abilities.map((a) => ({ id: a.id, name: a.name })), [abilities])
  const atMax = selected.length >= MAX_LOCKED

  return (
    <MultiSelectFilter
      label={`Locked abilities (${selected.length}/${MAX_LOCKED})`}
      placeholder={atMax ? `Max ${MAX_LOCKED} locked` : 'Type an ability or innate name…'}
      options={options}
      disabled={atMax}
      selected={selected}
      onChange={(ids) => onChange(ids.slice(0, MAX_LOCKED))}
    />
  )
}
