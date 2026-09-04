import { useId, useMemo, useState } from 'react'
import { displayName } from '../../lib/displayName'
import { useGameData } from '../../lib/GameDataContext'

/** Single-species text+datalist picker, same interaction pattern as
 * MultiSelectFilter: type or pick a suggestion, an exact case-insensitive name match
 * commits it. */
export default function SpeciesPicker({
  selectedId,
  onChange,
}: {
  selectedId: string | null
  onChange: (id: string) => void
}) {
  const { species, speciesById } = useGameData()
  const listId = useId()
  const selected = selectedId ? speciesById.get(selectedId) : undefined
  const [text, setText] = useState(selected ? displayName(selected, speciesById) : '')

  const byLowerName = useMemo(
    () => new Map(species.map((s) => [displayName(s, speciesById).toLowerCase(), s])),
    [species, speciesById],
  )

  function handleChange(value: string) {
    setText(value)
    const match = byLowerName.get(value.trim().toLowerCase())
    if (match) onChange(match.id)
  }

  return (
    <div>
      <h2 className="font-semibold mb-1.5">Species</h2>
      <input
        list={listId}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Type a species name…"
        className="w-full rounded-md border px-2 py-1 text-xs"
        style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
      />
      <datalist id={listId}>
        {species.map((s) => (
          <option key={s.id} value={displayName(s, speciesById)} />
        ))}
      </datalist>
    </div>
  )
}
