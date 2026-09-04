import type { AcceptSetOptions, SearchModes } from '../../lib/randomizer'

function Toggle({
  label,
  checked,
  onChange,
  title,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  title?: string
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs cursor-pointer" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

/** Shared toggles for both tools: which randomizer modes are active (mirrors the
 * save's two independent flags), and which accept-set expansions apply to every
 * locked ability. Compound expansion and curated groups default on. */
export default function RandomizerControls({
  acceptOptions,
  onAcceptOptionsChange,
  modes,
  onModesChange,
}: {
  acceptOptions: AcceptSetOptions
  onAcceptOptionsChange: (o: AcceptSetOptions) => void
  modes: SearchModes
  onModesChange: (m: SearchModes) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--color-text-muted)' }}>
          Randomizer modes
        </h3>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Toggle
            label="Ability Randomized Mode"
            checked={modes.abilityRandomized}
            onChange={(v) => onModesChange({ ...modes, abilityRandomized: v })}
            title="abilityRandomizedMode -- when off, the active ability is never randomized"
          />
          <Toggle
            label="Innate Randomized Mode"
            checked={modes.innateRandomized}
            onChange={(v) => onModesChange({ ...modes, innateRandomized: v })}
            title="innaterandomizedMode -- when off, innates are never randomized"
          />
        </div>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--color-text-muted)' }}>
          A locked ability also matches…
        </h3>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Toggle
            label="Compounds containing it"
            checked={acceptOptions.compounds}
            onChange={(v) => onAcceptOptionsChange({ ...acceptOptions, compounds: v })}
            title='e.g. locking Chlorophyll also matches "Big Leaves" (a compound that includes it)'
          />
          <Toggle
            label="Exact equivalents"
            checked={acceptOptions.exactGroups}
            onChange={(v) => onAcceptOptionsChange({ ...acceptOptions, exactGroups: v })}
            title="abilities with an identical description, e.g. Filter/Solid Rock/Prism Armor/…"
          />
          <Toggle
            label="Curated near-equivalents"
            checked={acceptOptions.curatedGroups}
            onChange={(v) => onAcceptOptionsChange({ ...acceptOptions, curatedGroups: v })}
            title="hand-curated near-equivalents, e.g. Mold Breaker/Teravolt/Turboblaze"
          />
        </div>
      </div>
    </div>
  )
}
