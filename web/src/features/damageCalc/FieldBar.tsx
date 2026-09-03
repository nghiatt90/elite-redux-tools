import { TERRAIN_OPTIONS, WEATHER_OPTIONS, type FieldConfig } from './scenario'

interface Props {
  field: FieldConfig
  onChange: (next: FieldConfig) => void
}

function SideScreens({ label, side, onChange }: { label: string; side: FieldConfig['attackerSide']; onChange: (next: FieldConfig['attackerSide']) => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {label}:
      </span>
      {(['reflect', 'lightScreen', 'auroraVeil', 'luckyChant'] as const).map((key) => (
        <label key={key} className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={side[key]} onChange={(e) => onChange({ ...side, [key]: e.target.checked })} />
          {key === 'reflect' ? 'Reflect' : key === 'lightScreen' ? 'Light Screen' : key === 'auroraVeil' ? 'Aurora Veil' : 'Lucky Chant'}
        </label>
      ))}
    </div>
  )
}

export default function FieldBar({ field, onChange }: Props) {
  return (
    <div className="flex flex-col gap-2 p-3 rounded-md border" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}>
      <div className="flex flex-wrap gap-3 items-center">
        <label className="text-xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          Weather
          <select
            className="rounded-md border px-2 py-1 text-sm"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
            value={field.weather}
            onChange={(e) => onChange({ ...field, weather: e.target.value as FieldConfig['weather'] })}
          >
            {WEATHER_OPTIONS.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          Terrain
          <select
            className="rounded-md border px-2 py-1 text-sm"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
            value={field.terrain ?? ''}
            onChange={(e) => onChange({ ...field, terrain: e.target.value || null })}
          >
            {TERRAIN_OPTIONS.map((t) => (
              <option key={t.id ?? 'none'} value={t.id ?? ''}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <input type="checkbox" checked={field.gravity} onChange={(e) => onChange({ ...field, gravity: e.target.checked })} />
          Gravity
        </label>
      </div>
      <SideScreens label="Attacker's side" side={field.attackerSide} onChange={(s) => onChange({ ...field, attackerSide: s })} />
      <SideScreens label="Defender's side" side={field.defenderSide} onChange={(s) => onChange({ ...field, defenderSide: s })} />
    </div>
  )
}
