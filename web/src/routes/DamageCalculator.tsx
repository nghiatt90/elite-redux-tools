import { useState } from 'react'
import BattlerPanel from '../features/damageCalc/BattlerPanel'
import FieldBar from '../features/damageCalc/FieldBar'
import ResultsTable from '../features/damageCalc/ResultsTable'
import { useDamageCalcData } from '../features/damageCalc/useDamageCalcData'
import { defaultBattlerConfig, defaultFieldConfig } from '../features/damageCalc/scenario'
import { useGameData } from '../lib/GameDataContext'
import '../engine/abilities/impl/index' // populates the ability registry

export default function DamageCalculator() {
  const gameData = useGameData()
  const calcData = useDamageCalcData()
  const [attacker, setAttacker] = useState(() => defaultBattlerConfig('SPECIES_GARCHOMP'))
  const [defender, setDefender] = useState(() => defaultBattlerConfig('SPECIES_SKARMORY'))
  const [field, setField] = useState(defaultFieldConfig)

  if (calcData.status === 'loading') {
    return <div className="p-4">Loading damage calculator data…</div>
  }
  if (calcData.status === 'error') {
    return (
      <div className="p-4" style={{ color: 'var(--color-danger)' }}>
        Failed to load: {calcData.error.message}
      </div>
    )
  }

  const ctx = {
    speciesById: gameData.speciesById,
    itemsById: gameData.itemsById,
    movesById: gameData.movesById,
    typeChart: gameData.typeChart,
    moveBehaviors: calcData.data.moveBehaviors,
    natures: calcData.data.natures,
  }

  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-4">
      <div className="max-w-2xl text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Singles damage calculator, ported directly from Elite Redux's own battle code
        (not the buggy in-battle preview). Ability coverage is a work in progress --
        results flag any selected ability that isn't modelled yet rather than
        silently ignoring it.
      </div>

      <FieldBar field={field} onChange={setField} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BattlerPanel side="Attacker" config={attacker} onChange={setAttacker} natures={calcData.data.natures} abilityHooks={calcData.data.abilityHooks} />
        <BattlerPanel side="Defender" config={defender} onChange={setDefender} natures={calcData.data.natures} abilityHooks={calcData.data.abilityHooks} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ResultsTable title="Attacker → Defender" attacker={attacker} defender={defender} field={field} ctx={ctx} />
        <ResultsTable
          title="Defender → Attacker"
          attacker={defender}
          defender={attacker}
          field={{ ...field, attackerSide: field.defenderSide, defenderSide: field.attackerSide }}
          ctx={ctx}
        />
      </div>
    </div>
  )
}
