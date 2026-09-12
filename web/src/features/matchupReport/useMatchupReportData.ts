import { useEffect, useState } from 'react'
import { loadAbilityHooks, loadMoveBehaviors, loadNatures, loadTrainers } from '../../lib/data'
import type { AbilityHooks, BattleConstants, MoveBehaviorsFile, Trainer } from '../../lib/types'

export interface MatchupReportData {
  trainers: Trainer[]
  moveBehaviors: MoveBehaviorsFile
  natures: BattleConstants
  abilityHooks: AbilityHooks
}

type State = { status: 'loading' } | { status: 'error'; error: Error } | { status: 'ready'; data: MatchupReportData }

// Same "fetch once, cache at module scope" shape as damageCalc/useDamageCalcData.ts --
// trainers.json is 4.23MB (343KB gzipped), only this route needs it, so it stays out of
// GameDataContext's app-wide eager load.
let cachedPromise: Promise<MatchupReportData> | null = null

function loadMatchupReportData(): Promise<MatchupReportData> {
  if (!cachedPromise) {
    cachedPromise = Promise.all([loadTrainers(), loadMoveBehaviors(), loadNatures(), loadAbilityHooks()]).then(([trainers, moveBehaviors, natures, abilityHooks]) => ({
      trainers,
      moveBehaviors,
      natures,
      abilityHooks,
    }))
  }
  return cachedPromise
}

export function useMatchupReportData(): State {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    loadMatchupReportData().then(
      (data) => {
        if (!cancelled) setState({ status: 'ready', data })
      },
      (error: Error) => {
        if (!cancelled) setState({ status: 'error', error })
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
