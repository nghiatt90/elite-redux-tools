// Fight chains with no heal between stages (docs/battle-sim/chains-plan.md
// decisions 1 and Step 3). Pure: the caller supplies the boss-id set, so this
// module never reaches for node:fs and stays drivable from a Web Worker.
// Structural copies of `lib/types` rows, kept local because `engine/` must not
// import from `lib/`, `features/` or `routes/` (see web/src/engine/layering.test.ts).
export interface TrainerChain {
  map: string
  script: string
  trainers: string[] // 2+ distinct ids, reachable together in one playthrough
  healFree: boolean // FLAG_SYS_DISABLE_AUTOHEAL bracketed every member but the first
}

export interface TagBattle {
  map: string
  script: string
  trainers: [string, string] // starttagbattle's own two ids, in call order
  guard: string | null
}

export interface FightSpec {
  trainerIds: string[]
  format: 'single' | 'tag'
}

export interface ChainSpec {
  id: string
  stages: FightSpec[]
  evidence: 'script'
}

const JUAN_STAGE_1: readonly string[] = ['TRAINER_JUAN_1', 'TRAINER_WALLACE']
const JUAN_STAGE_2: readonly string[] = ['TRAINER_JUAN_5', 'TRAINER_WALLACE_5']

/** Same trainer ids, same order (encounters.py records starttagbattle's own pair). */
function hasTagBattle(
  tagBattles: readonly TagBattle[],
  pair: readonly string[],
  scriptSuffix?: string,
): boolean {
  return tagBattles.some(
    (row) =>
      row.trainers.length === pair.length &&
      row.trainers.every((id, index) => id === pair[index]) &&
      (scriptSuffix === undefined || row.script.endsWith(scriptSuffix)),
  )
}

/**
 * `trainerChains` gives the singles chains: a `healFree` row is a no-heal chain,
 * but only when every member is an allowed (boss) trainer id, so the caller can
 * drop deferred fights by narrowing the set. Stage order is the entry's own
 * `trainers` order, which is the script's trainerbattle call order
 * (pipeline/src/erdata/encounters.py:980-1004 `_find_chains`).
 *
 * Juan is not data-derived: encounters.py records his two stages as separate
 * unlinked `tagBattles` rows with no heal field (`:219-223`), and the stage-2
 * pair is also reused by the rematch script. The hand table below is guarded so
 * a data regeneration that drops either row fails here rather than silently
 * shortening the chain. SootopolisCity_Gym_1F/scripts.pory:
 *   :275 special(HealPlayerParty)
 *   :276 setflag(FLAG_SYS_DISABLE_AUTOHEAL)
 *   :278 starttagbattle(TRAINER_JUAN_1, TRAINER_WALLACE, ..., Juan_Battle_2)
 *   :279 clearflag(FLAG_SYS_DISABLE_AUTOHEAL)
 *   :286-290 Juan_Battle_2 starts TRAINER_JUAN_5, TRAINER_WALLACE_5
 */
export function buildChains(
  trainerChains: readonly TrainerChain[],
  tagBattles: readonly TagBattle[],
  allowedTrainerIds: ReadonlySet<string>,
): ChainSpec[] {
  if (!hasTagBattle(tagBattles, JUAN_STAGE_1)) {
    throw new Error(`encounters.json tagBattles lost the Juan row ${JUAN_STAGE_1.join(',')}`)
  }
  if (!hasTagBattle(tagBattles, JUAN_STAGE_2, '_Juan_Battle_2')) {
    throw new Error(`encounters.json tagBattles lost the Juan row ${JUAN_STAGE_2.join(',')}`)
  }

  const derived = trainerChains
    .filter((entry) => entry.healFree && entry.trainers.every((id) => allowedTrainerIds.has(id)))
    .map(
      (entry): ChainSpec => ({
        id: entry.script,
        stages: entry.trainers.map((id) => ({ trainerIds: [id], format: 'single' })),
        evidence: 'script',
      }),
    )

  const juan: ChainSpec = {
    id: 'SootopolisCity_Gym_1F_EventScript_Juan',
    stages: [
      { trainerIds: [...JUAN_STAGE_1], format: 'tag' },
      { trainerIds: [...JUAN_STAGE_2], format: 'tag' },
    ],
    evidence: 'script',
  }

  return [...derived, juan]
}
