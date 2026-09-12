import { useMemo, useState } from 'react'
import BattlerPanel from '../features/damageCalc/BattlerPanel'
import { buildBattlerState, defaultBattlerConfig, toMoveData } from '../features/damageCalc/scenario'
import MatchupReportView from '../features/matchupReport/MatchupReportView'
import TrainerPicker from '../features/matchupReport/TrainerPicker'
import { useMatchupReportData } from '../features/matchupReport/useMatchupReportData'
import { buildMatchupReport, type TrainerTier } from '../lib/matchupReport'
import { useGameData } from '../lib/GameDataContext'
import type { Trainer } from '../lib/types'
import '../engine/abilities/impl/index' // populates the ability registry

const TIER_OPTIONS: { id: TrainerTier; label: string }[] = [
  { id: 'ace', label: 'Ace' },
  { id: 'elite', label: 'Elite' },
  { id: 'hell', label: 'Hell' },
]

export default function TrainerMatchup() {
  const gameData = useGameData()
  const reportData = useMatchupReportData()
  const [playerConfig, setPlayerConfig] = useState(() => defaultBattlerConfig('SPECIES_GARCHOMP'))
  const [trainer, setTrainer] = useState<Trainer | null>(null)
  const [tier, setTier] = useState<TrainerTier>('ace')
  // battle_main.c:1819-1827: the enemy party's level is the player's OWN highest
  // party member's level, not anything this tool can read from a save file -- so
  // it's an explicit input, not derived or defaulted to the configured mon's own
  // level (which may not be the party's highest).
  const [playerHighestLevel, setPlayerHighestLevel] = useState(100)

  // useMemo (like every other hook) must run in the same order on every render --
  // routes/DamageCalculator.tsx's own status gate below calls no hook after it, and
  // this one needs to match: computed unconditionally, branching INSIDE the memo
  // instead, rather than after the two early returns that used to sit above it. The
  // first render always takes the 'loading' branch (reportData starts loading, see
  // useMatchupReportData.ts); when the fetch resolves, a naive post-gate useMemo
  // would be a hook that didn't exist on the previous render, and React throws.
  const report = useMemo(() => {
    if (reportData.status !== 'ready' || !trainer) return null
    const ctx = {
      speciesById: gameData.speciesById,
      itemsById: gameData.itemsById,
      movesById: gameData.movesById,
      typeChart: gameData.typeChart,
      inverseTypeChart: gameData.inverseTypeChart,
      moveBehaviors: reportData.data.moveBehaviors.behaviors as unknown as import('../engine/basePower').MoveBehaviors,
      natures: reportData.data.natures,
    }
    const battler = buildBattlerState(playerConfig, ctx)
    const moves = playerConfig.moveIds.filter((id): id is string => id !== null).map((id) => toMoveData(ctx.movesById.get(id)!))
    return buildMatchupReport({
      player: { speciesId: playerConfig.speciesId, battler, moves },
      trainer,
      tier,
      playerHighestLevel,
      ctx,
    })
  }, [playerConfig, trainer, tier, playerHighestLevel, gameData, reportData])

  if (reportData.status === 'loading') {
    return <div className="p-4">Loading trainer data…</div>
  }
  if (reportData.status === 'error') {
    return (
      <div className="p-4" style={{ color: 'var(--color-danger)' }}>
        Failed to load: {reportData.error.message}
      </div>
    )
  }

  const ctx = {
    speciesById: gameData.speciesById,
    itemsById: gameData.itemsById,
    movesById: gameData.movesById,
    typeChart: gameData.typeChart,
    inverseTypeChart: gameData.inverseTypeChart,
    moveBehaviors: reportData.data.moveBehaviors.behaviors as unknown as import('../engine/basePower').MoveBehaviors,
    natures: reportData.data.natures,
  }

  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-4">
      <div className="max-w-2xl text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Turn-one matchup report: pick your Pokemon and a real trainer, and see exact speed tiers plus a two-way damage matrix.
        Not a build recommender -- the results below list what this deliberately does not model before showing any numbers.
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BattlerPanel title="Your Pokemon" config={playerConfig} onChange={setPlayerConfig} natures={ctx.natures} abilityHooks={reportData.data.abilityHooks} />

        <div className="flex flex-col gap-3 p-3 rounded-md border" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}>
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            Trainer
          </h2>
          <TrainerPicker trainers={reportData.data.trainers} value={trainer} onChange={setTrainer} />

          <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Party tier
            <select
              className="mt-0.5 rounded-md border px-2 py-1 text-sm w-full"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
              value={tier}
              onChange={(e) => setTier(e.target.value as TrainerTier)}
            >
              {TIER_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Your highest party level
            <input
              type="number"
              min={1}
              max={ctx.natures.maxLevel}
              className="mt-0.5 rounded-md border px-2 py-1 text-sm w-full"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
              value={playerHighestLevel}
              onChange={(e) => setPlayerHighestLevel(Math.max(1, Math.min(ctx.natures.maxLevel, Number(e.target.value) || 1)))}
            />
          </label>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            This sets the enemy party's level: every one of the trainer's Pokemon is generated at your own party's highest level,
            not a level stored per trainer.
          </p>
          {playerHighestLevel < playerConfig.level && (
            <p className="text-xs" style={{ color: 'var(--color-danger)' }}>
              Your Pokemon above is level {playerConfig.level}, higher than the {playerHighestLevel} you entered here -- that's not
              a real save state (this can't be your highest party member if something else in your party is higher-level).
            </p>
          )}
        </div>
      </div>

      {report ? (
        <MatchupReportView report={report} />
      ) : (
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Pick a trainer above to see the matchup.
        </p>
      )}
    </div>
  )
}
