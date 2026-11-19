import { FIGHTS, type FightRow } from './fights'

/**
 * The v1 tuning units this measurement harness can sample today: single-format rows that are
 * neither chained, excluded, deferred nor awaiting a route. Doubles, tags, `multi_2_vs_2` and
 * chains need formats or scorers the sampler does not have (decision 12 counts them anyway).
 */
export function supportedSingleUnits(): FightRow[] {
  return FIGHTS.filter(
    (row) =>
      row.format === 'single' &&
      row.chainId === undefined &&
      row.excluded === undefined &&
      row.deferred !== true &&
      row.awaitingRoute !== true,
  )
}
