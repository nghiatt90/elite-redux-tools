import { useEffect, useState } from 'react'
import { loadAbilityHooks, loadMoveBehaviors, loadNatures } from '../../lib/data'
import type { AbilityHooks, BattleConstants, MoveBehaviorsFile } from '../../lib/types'

export interface DamageCalcData {
  moveBehaviors: MoveBehaviorsFile
  natures: BattleConstants
  abilityHooks: AbilityHooks
}

type State = { status: 'loading' } | { status: 'error'; error: Error } | { status: 'ready'; data: DamageCalcData }

// Fetched once and cached at module scope -- these three files (~600KB combined,
// mostly abilityHooks.json's per-ability source text) are only ever needed by this
// one route, so they're kept out of GameDataContext's app-wide eager load. Cached
// here (not per-component-instance) so navigating away from and back to the
// calculator doesn't re-fetch.
let cachedPromise: Promise<DamageCalcData> | null = null

function loadDamageCalcData(): Promise<DamageCalcData> {
  if (!cachedPromise) {
    cachedPromise = Promise.all([loadMoveBehaviors(), loadNatures(), loadAbilityHooks()]).then(([moveBehaviors, natures, abilityHooks]) => ({
      moveBehaviors,
      natures,
      abilityHooks,
    }))
  }
  return cachedPromise
}

export function useDamageCalcData(): State {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    loadDamageCalcData().then(
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
