import { useMemo } from 'react'
import TypeChip from '../../components/TypeChip'
import { calculateMoveDamage, type DamageCalcScenario } from '../../engine/calculate'
import { calcKoChances, guaranteedKoHits, minimumPossibleKoHits } from '../../engine/kochance'
import { useMoveDisplayName } from '../../lib/GameDataContext'
import type { BattlerConfig, BuildContext, FieldConfig } from './scenario'
import { buildScenario } from './scenario'
import type { Move } from '../../lib/types'

interface Props {
  title: string
  attacker: BattlerConfig
  defender: BattlerConfig
  field: FieldConfig
  ctx: BuildContext & { movesById: Map<string, Move>; typeChart: import('../../engine/typeEffectiveness').TypeChart; moveBehaviors: import('../../lib/types').MoveBehaviorsFile }
}

function formatRange(rolls: number[], maxHp: number): string {
  const min = rolls[0]
  const max = rolls[rolls.length - 1]
  const minPct = ((min / maxHp) * 100).toFixed(1)
  const maxPct = ((max / maxHp) * 100).toFixed(1)
  if (min === max) return `${min} (${minPct}%)`
  return `${min}–${max} (${minPct}–${maxPct}%)`
}

function koSummary(rolls: number[], maxHp: number): string {
  const entries = calcKoChances(rolls, maxHp)
  const guaranteed = guaranteedKoHits(entries)
  if (guaranteed) return `guaranteed ${guaranteed}HKO`
  const min = minimumPossibleKoHits(entries)
  if (!min) return 'never KOes within 9 hits'
  const entry = entries.find((e) => e.hits === min)!
  return `${min}HKO (${(entry.probability * 100).toFixed(1)}%)`
}

function MoveRow({ moveId, scenario }: { moveId: string; scenario: DamageCalcScenario }) {
  const moveName = useMoveDisplayName(moveId)
  const result = useMemo(() => calculateMoveDamage(scenario), [scenario])
  const maxHp = scenario.defender.condition.maxHp

  if (result.isImmune) {
    return (
      <tr className="border-b" style={{ borderColor: 'var(--color-border)' }}>
        <td className="py-1.5 pr-2">{moveName}</td>
        <td className="py-1.5 pr-2">
          <TypeChip type={result.effectiveMoveType} />
        </td>
        <td className="py-1.5 pr-2 italic" style={{ color: 'var(--color-text-muted)' }} colSpan={2}>
          No effect (immune)
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-b align-top" style={{ borderColor: 'var(--color-border)' }}>
      <td className="py-1.5 pr-2 whitespace-nowrap">{moveName}</td>
      <td className="py-1.5 pr-2">
        <TypeChip type={result.effectiveMoveType} />
      </td>
      <td className="py-1.5 pr-2 tabular-nums whitespace-nowrap">{formatRange(result.rolls, maxHp)}</td>
      <td className="py-1.5 pr-2 tabular-nums whitespace-nowrap">
        {koSummary(result.rolls, maxHp)}
        {result.critChanceDenominator && (
          <span className="block text-xs" style={{ color: 'var(--color-text-muted)' }}>
            crit (1/{result.critChanceDenominator}): {formatRange(result.critRolls!, maxHp)}
          </span>
        )}
        {result.unmodelled.length > 0 && (
          <span className="block text-xs" style={{ color: 'var(--color-danger)' }} title={result.unmodelled.join('\n')}>
            ⚠ {result.unmodelled.length} ability/effect{result.unmodelled.length > 1 ? 's' : ''} not modelled
          </span>
        )}
      </td>
    </tr>
  )
}

export default function ResultsTable({ title, attacker, defender, field, ctx }: Props) {
  const moveIds = attacker.moveIds.filter((m): m is string => m !== null)

  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>
        {title}
      </h2>
      {moveIds.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Select at least one move above to see damage.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border" style={{ borderColor: 'var(--color-border)' }}>
          <table className="w-full text-xs min-w-[480px]">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
                <th className="py-1.5 px-2 font-medium">Move</th>
                <th className="py-1.5 px-2 font-medium">Type</th>
                <th className="py-1.5 px-2 font-medium">Damage</th>
                <th className="py-1.5 px-2 font-medium">KO chance</th>
              </tr>
            </thead>
            <tbody>
              {moveIds.map((moveId) => (
                <MoveRow key={moveId} moveId={moveId} scenario={buildScenario(attacker, defender, moveId, field, ctx)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
