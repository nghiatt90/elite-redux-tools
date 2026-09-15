import { MAGNITUDE_OPTIONS, TERRAIN_OPTIONS, WEATHER_OPTIONS, type FieldConfig } from './scenario'

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
        <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <input type="checkbox" checked={field.attackerActsFirst} onChange={(e) => onChange({ ...field, attackerActsFirst: e.target.checked })} />
          Attacker acts first
        </label>
        <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <input type="checkbox" checked={field.defenderIsSwitching} onChange={(e) => onChange({ ...field, defenderIsSwitching: e.target.checked })} />
          Defender is switching out {/* Pursuit */}
        </label>
      </div>
      <SideScreens label="Attacker's side" side={field.attackerSide} onChange={(s) => onChange({ ...field, attackerSide: s })} />
      <SideScreens label="Defender's side" side={field.defenderSide} onChange={(s) => onChange({ ...field, defenderSide: s })} />
      <div className="flex flex-wrap gap-3 items-center">
        <label className="text-xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          Same move used in a row
          <input
            type="number"
            min={0}
            max={10}
            className="w-16 rounded-md border px-2 py-1 text-sm"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
            value={field.sameMoveTurnsInARow}
            onChange={(e) => onChange({ ...field, sameMoveTurnsInARow: Number(e.target.value) })}
          />
          {/* Echoed Voice, Metronome (item), Rhythmic */}
        </label>
        <label className="text-xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          Multi-hit count (variable moves only)
          <input
            type="range"
            min={2}
            max={5}
            className="w-24"
            value={field.hitCount}
            onChange={(e) => onChange({ ...field, hitCount: Number(e.target.value) })}
          />
          <span>{field.hitCount}</span>
        </label>
        <label className="text-xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          Magnitude tier
          <select
            className="rounded-md border px-2 py-1 text-sm"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
            value={field.magnitudeTier ?? ''}
            onChange={(e) => onChange({ ...field, magnitudeTier: (e.target.value ? Number(e.target.value) : null) as FieldConfig['magnitudeTier'] })}
          >
            <option value="">(unset)</option>
            {MAGNITUDE_OPTIONS.map((m) => (
              <option key={m.tier} value={m.tier}>
                Magnitude {m.tier} ({m.power} power, {m.chance}%)
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          Rollout/Ice Ball counter
          <input
            type="range"
            min={0}
            max={3}
            className="w-24"
            value={field.attackerRolloutCounter}
            onChange={(e) => onChange({ ...field, attackerRolloutCounter: Number(e.target.value) as FieldConfig['attackerRolloutCounter'] })}
          />
          <span>{field.attackerRolloutCounter}</span>
        </label>
        <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <input type="checkbox" checked={field.attackerWasHitThisTurn} onChange={(e) => onChange({ ...field, attackerWasHitThisTurn: e.target.checked })} />
          Attacker was hit this turn {/* Focus Punch, Self-Destruct */}
        </label>
        <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <input type="checkbox" checked={field.defenderUsedGlaiveRush} onChange={(e) => onChange({ ...field, defenderUsedGlaiveRush: e.target.checked })} />
          Defender used Glaive Rush this turn
        </label>
        <label className="text-xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          Beat Up: hits
          <input
            type="range"
            min={1}
            max={6}
            className="w-16"
            value={field.beatUpHitCount}
            onChange={(e) => onChange({ ...field, beatUpHitCount: Number(e.target.value) })}
          />
          <span>{field.beatUpHitCount}</span>
        </label>
        <label className="text-xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          Beat Up: representative base Atk
          <input
            type="number"
            min={5}
            max={200}
            className="w-16 rounded-md border px-2 py-1 text-sm"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
            value={field.beatUpBaseAttack}
            onChange={(e) => onChange({ ...field, beatUpBaseAttack: Number(e.target.value) })}
          />
          {/* one party member's base Attack stands in for the whole roster -- see DamageContext.beatUpBaseAttack's own doc */}
        </label>
      </div>
    </div>
  )
}
