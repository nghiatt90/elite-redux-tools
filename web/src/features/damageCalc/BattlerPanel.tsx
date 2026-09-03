import { useMemo, useState } from 'react'
import SpeciesSprite from '../pokedex/SpeciesSprite'
import { buildSearchIndex, searchSpecies } from '../pokedex/search'
import { isStandaloneForm, displayName } from '../../lib/displayName'
import { useAbilityDisplayName, useGameData } from '../../lib/GameDataContext'
import type { BattleStatKey } from '../../engine/types'
import { SEMI_INVULNERABLE_OPTIONS, STATUS_OPTIONS, type BattlerConfig } from './scenario'
import type { AbilityHooks, BattleConstants } from '../../lib/types'

const BATTLE_STATS: { key: BattleStatKey; label: string }[] = [
  { key: 'atk', label: 'Atk' },
  { key: 'def', label: 'Def' },
  { key: 'spatk', label: 'SpA' },
  { key: 'spdef', label: 'SpD' },
  { key: 'spe', label: 'Spe' },
]

interface Props {
  side: 'Attacker' | 'Defender'
  config: BattlerConfig
  onChange: (next: BattlerConfig) => void
  natures: BattleConstants
  abilityHooks: AbilityHooks
}

function AbilityBadge({ abilityId, abilityHooks }: { abilityId: string | null; abilityHooks: AbilityHooks }) {
  const name = useAbilityDisplayName(abilityId ?? undefined)
  if (!abilityId) return null
  const hook = abilityHooks[abilityId]
  const unmodelled = hook?.damageRelevant // presence in the registry is checked at calc time; this is just a heads-up
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
      style={{ borderColor: 'var(--color-border)', color: unmodelled ? 'var(--color-text)' : 'var(--color-text-muted)' }}
      title={unmodelled ? 'This ability affects damage -- check the results for a coverage warning if it is not yet ported.' : undefined}
    >
      {name}
    </span>
  )
}

function MoveSelect({ value, onChange, options, movesById }: { value: string | null; onChange: (v: string | null) => void; options: string[]; movesById: Map<string, import('../../lib/types').Move> }) {
  return (
    <select
      className="rounded-md border px-2 py-1 text-sm w-full"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">(no move)</option>
      {options.map((id) => (
        <option key={id} value={id}>
          {movesById.get(id)?.name ?? id}
        </option>
      ))}
    </select>
  )
}

export default function BattlerPanel({ side, config, onChange, natures, abilityHooks }: Props) {
  const { species, speciesById, movesById, items } = useGameData()
  const [speciesQuery, setSpeciesQuery] = useState('')

  const baseSpecies = useMemo(() => species.filter((s) => !s.isForm || isStandaloneForm(s, speciesById)), [species, speciesById])
  const searchIndex = useMemo(() => buildSearchIndex(baseSpecies, species), [baseSpecies, species])
  const speciesResults = useMemo(() => searchSpecies(searchIndex, speciesQuery).slice(0, 12), [searchIndex, speciesQuery])

  const currentSpecies = speciesById.get(config.speciesId)
  const learnsetMoveIds = useMemo(() => {
    if (!currentSpecies) return []
    const ids = new Set<string>([...currentSpecies.learnset.levelUp.flatMap((e) => e.moves), ...currentSpecies.learnset.tutor])
    return [...ids].sort((a, b) => (movesById.get(a)?.name ?? a).localeCompare(movesById.get(b)?.name ?? b))
  }, [currentSpecies, movesById])

  function set<K extends keyof BattlerConfig>(key: K, value: BattlerConfig[K]) {
    onChange({ ...config, [key]: value })
  }

  const totalEv = Object.values(config.evs).reduce((a, b) => a + b, 0)

  return (
    <div className="flex flex-col gap-3 p-3 rounded-md border" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}>
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        {side}
      </h2>

      <div className="flex items-center gap-3">
        {currentSpecies && <SpeciesSprite speciesId={currentSpecies.id} />}
        <div className="flex-1 min-w-0">
          <input
            className="rounded-md border px-2 py-1 text-sm w-full"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
            placeholder="Search Pokemon..."
            value={speciesQuery}
            onChange={(e) => setSpeciesQuery(e.target.value)}
          />
          {speciesQuery && (
            <div className="mt-1 max-h-40 overflow-y-auto rounded-md border" style={{ borderColor: 'var(--color-border)' }}>
              {speciesResults.map((s) => (
                <button
                  key={s.id}
                  className="block w-full text-left px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)]"
                  onClick={() => {
                    set('speciesId', s.id)
                    set('abilityIndex', 0)
                    setSpeciesQuery('')
                  }}
                >
                  {displayName(s, speciesById)}
                </button>
              ))}
            </div>
          )}
          {currentSpecies && <div className="text-sm font-medium mt-1">{displayName(currentSpecies, speciesById)}</div>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Level
          <input
            type="number"
            min={1}
            max={natures.maxLevel}
            className="mt-0.5 rounded-md border px-2 py-1 text-sm w-full"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
            value={config.level}
            onChange={(e) => set('level', Math.max(1, Math.min(natures.maxLevel, Number(e.target.value) || 1)))}
          />
        </label>
        <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Nature
          <select
            className="mt-0.5 rounded-md border px-2 py-1 text-sm w-full"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
            value={config.nature}
            onChange={(e) => set('nature', e.target.value)}
          >
            {Object.keys(natures.natureStatTable)
              .sort()
              .map((n) => (
                <option key={n} value={n}>
                  {n.replace('NATURE_', '')}
                </option>
              ))}
          </select>
        </label>
      </div>

      {currentSpecies && currentSpecies.abilities.length > 0 && (
        <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Ability
          <select
            className="mt-0.5 rounded-md border px-2 py-1 text-sm w-full"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
            value={config.abilityIndex}
            onChange={(e) => set('abilityIndex', Number(e.target.value))}
          >
            {currentSpecies.abilities.map((a, i) => (
              <option key={a} value={i}>
                {a.replace('ABILITY_', '').replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
      )}

      {currentSpecies && currentSpecies.innates.length > 0 && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Innates:
          </span>
          {currentSpecies.innates.map((id) => (
            <AbilityBadge key={id} abilityId={id} abilityHooks={abilityHooks} />
          ))}
        </div>
      )}

      <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Item
        <select
          className="mt-0.5 rounded-md border px-2 py-1 text-sm w-full"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
          value={config.itemId ?? ''}
          onChange={(e) => set('itemId', e.target.value || null)}
        >
          <option value="">(no item)</option>
          {items
            .filter((i) => i.grouping !== 'POCKET_TM_HM' && i.grouping !== 'POCKET_KEY_ITEMS')
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
        </select>
      </label>

      <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Status
        <select
          className="mt-0.5 rounded-md border px-2 py-1 text-sm w-full"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
          value={config.status ?? ''}
          onChange={(e) => set('status', e.target.value || null)}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.id ?? 'none'} value={s.id ?? ''}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Semi-invulnerable {/* only matters as the defender -- harmless to set on the attacker */}
        <select
          className="mt-0.5 rounded-md border px-2 py-1 text-sm w-full"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
          value={config.semiInvulnerable}
          onChange={(e) => set('semiInvulnerable', e.target.value as BattlerConfig['semiInvulnerable'])}
        >
          {SEMI_INVULNERABLE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Current HP: {config.hpPercent}%
        <input
          type="range"
          min={1}
          max={100}
          className="w-full"
          value={config.hpPercent}
          onChange={(e) => set('hpPercent', Number(e.target.value))}
        />
      </label>

      <div>
        <div className="text-xs mb-1 flex justify-between" style={{ color: 'var(--color-text-muted)' }}>
          <span>EVs</span>
          <span className={totalEv > natures.maxEvTotal ? 'font-semibold' : ''} style={{ color: totalEv > natures.maxEvTotal ? 'var(--color-danger)' : undefined }}>
            {totalEv}/{natures.maxEvTotal}
          </span>
        </div>
        <div className="grid grid-cols-5 gap-1">
          {BATTLE_STATS.map(({ key, label }) => (
            <label key={key} className="text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
              {label}
              <input
                type="number"
                min={0}
                max={natures.maxEvPerStat}
                step={4}
                className="mt-0.5 rounded-md border px-1 py-0.5 text-xs w-full text-center"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
                value={config.evs[key]}
                onChange={(e) => set('evs', { ...config.evs, [key]: Math.max(0, Math.min(natures.maxEvPerStat, Number(e.target.value) || 0)) })}
              />
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
          Stat stages
        </div>
        <div className="grid grid-cols-5 gap-1">
          {BATTLE_STATS.map(({ key, label }) => (
            <div key={key} className="flex flex-col items-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {label}
              <div className="flex items-center gap-0.5">
                <button
                  className="w-5 h-5 rounded border text-xs"
                  style={{ borderColor: 'var(--color-border)' }}
                  onClick={() => set('statStages', { ...config.statStages, [key]: Math.max(-6, config.statStages[key] - 1) })}
                >
                  −
                </button>
                <span className="w-5 text-center tabular-nums" style={{ color: 'var(--color-text)' }}>
                  {config.statStages[key] > 0 ? `+${config.statStages[key]}` : config.statStages[key]}
                </span>
                <button
                  className="w-5 h-5 rounded border text-xs"
                  style={{ borderColor: 'var(--color-border)' }}
                  onClick={() => set('statStages', { ...config.statStages, [key]: Math.min(6, config.statStages[key] + 1) })}
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
          Moves
        </div>
        <div className="grid grid-cols-2 gap-1">
          {[0, 1, 2, 3].map((slot) => (
            <MoveSelect
              key={slot}
              value={config.moveIds[slot]}
              onChange={(v) => {
                const next = [...config.moveIds]
                next[slot] = v
                set('moveIds', next)
              }}
              options={learnsetMoveIds}
              movesById={movesById}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
