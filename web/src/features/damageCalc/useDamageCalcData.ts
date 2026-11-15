import { useEffect, useState } from 'react'
import {
  getDataVersion,
  loadAbilityHooks,
  loadMoveBehaviors,
  loadNatures,
  type DataVersion,
} from '../../lib/data'
import type { AbilityHooks, BattleConstants, MoveBehaviorsFile } from '../../lib/types'

export interface DamageCalcData {
  moveBehaviors: MoveBehaviorsFile
  natures: BattleConstants
  abilityHooks: AbilityHooks
}

type State = { status: 'loading' } | { status: 'error'; error: Error } | { status: 'ready'; data: DamageCalcData }

// Cached at module scope per data version -- these three files (~600KB combined,
// mostly abilityHooks.json's per-ability source text) are only ever needed by this
// one route, so they're kept out of GameDataContext's app-wide eager load. Cached
// by version so navigating away from and back to the calculator doesn't re-fetch,
// and switching version loads that version's files.
const cachedPromises = new Map<DataVersion, Promise<DamageCalcData>>()

export function loadDamageCalcData(version: DataVersion = getDataVersion()): Promise<DamageCalcData> {
  let p = cachedPromises.get(version)
  if (!p) {
    p = Promise.all([
      loadMoveBehaviors(version),
      loadNatures(version),
      loadAbilityHooks(version),
    ]).then(
      ([moveBehaviors, natures, abilityHooks]) => ({
        moveBehaviors,
        natures,
        abilityHooks,
      }),
      (err) => {
        cachedPromises.delete(version)
        throw err
      },
    )
    cachedPromises.set(version, p)
  }
  return p
}

export function useDamageCalcData(): State {
  const [state, setState] = useState<State>({ status: 'loading' })
  const version = getDataVersion()

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    loadDamageCalcData(version).then(
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
  }, [version])

  return state
}
