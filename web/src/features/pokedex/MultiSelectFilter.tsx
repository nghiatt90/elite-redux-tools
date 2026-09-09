import { useId, useMemo, useState } from 'react'

export interface MultiSelectOption {
  id: string
  name: string
}

interface Props {
  label: string
  placeholder: string
  options: MultiSelectOption[]
  selected: string[]
  onChange: (ids: string[]) => void
  /** Stops further selections without hiding `options`, which is also what resolves a
   * selected id to its display name -- blanking the list to lock the input turned every
   * chip into a raw `ABILITY_*` id. */
  disabled?: boolean
}

/** Text input + native <datalist>, no extra dependency. Picking a suggestion (or
 * typing out a full valid name by hand) fills the input with an exact option name --
 * both land the same way here: on every keystroke, an exact case-insensitive match
 * against an unselected option commits it (appended to `selected`) and clears the
 * input, so a selection reads as a removable chip rather than sitting in the text box.
 */
export default function MultiSelectFilter({
  label,
  placeholder,
  options,
  selected,
  onChange,
  disabled = false,
}: Props) {
  const [text, setText] = useState('')
  const listId = useId()

  const byLowerName = useMemo(() => new Map(options.map((o) => [o.name.toLowerCase(), o])), [options])
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options])

  function handleChange(value: string) {
    const match = byLowerName.get(value.trim().toLowerCase())
    if (match && !selected.includes(match.id)) {
      onChange([...selected, match.id])
      setText('')
      return
    }
    setText(value)
  }

  function remove(id: string) {
    onChange(selected.filter((s) => s !== id))
  }

  return (
    <section>
      <h2 className="font-semibold mb-1.5">{label}</h2>
      <input
        list={listId}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-md border px-2 py-1 text-xs disabled:opacity-60"
        style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
      />
      <datalist id={listId}>
        {!disabled &&
          options
            .filter((o) => !selected.includes(o.id))
            .map((o) => <option key={o.id} value={o.name} />)}
      </datalist>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {selected.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => remove(id)}
              className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
            >
              {byId.get(id)?.name ?? id}
              <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
