// Fight specification resolver: converts encounters.json rows for a given trainer
// into the format, inverseBattle, battleEvents and startFieldEffects inputs required
// by createSession and runBattle.

import type { BattleFormat } from './battleFormat'
import { isInverseBattleTrainer, type EncounterTagBattle, type SimDataBundle, type TrainerData } from './loadSimData'

export interface FightSpec {
  opponentTrainer: TrainerData
  format: BattleFormat
  inverseBattle: boolean
  battleEvents: Array<{ event: string; data0: number | null; data1: number | null }>
  startFieldEffects: Array<{ effectType: string; fieldId: string }>
  skipped: string[]
}

const JUAN_STAGE_1_SCRIPT = 'SootopolisCity_Gym_1F_EventScript_Juan'
const JUAN_STAGE_2_SCRIPT = 'SootopolisCity_Gym_1F_EventScript_Juan_Battle_2'

interface MultiFightConfig {
  opponentIds: [string, string]
  partnerIds: string[]
  defaultPartnerId: string
  script: string
}

const MULTI_FIGHTS: Record<string, MultiFightConfig> = {
  // MeteorFalls_1F_1R/scripts.pory:193,202,211,220,229,238
  TRAINER_COURTNEY_METEOR_FALLS: {
    opponentIds: ['TRAINER_COURTNEY_METEOR_FALLS', 'TRAINER_GRUNT_METEOR_FALLS'],
    partnerIds: [
      'MAY_TREECKO_METEOR_FALLS',
      'MAY_TORCHIC_METEOR_FALLS',
      'MAY_MUDKIP_METEOR_FALLS',
      'BRENDAN_TREECKO_METEOR_FALLS',
      'BRENDAN_TORCHIC_METEOR_FALLS',
      'BRENDAN_MUDKIP_METEOR_FALLS',
    ],
    defaultPartnerId: 'MAY_TORCHIC_METEOR_FALLS',
    script: 'MeteorFalls_1F_1R_EventScript_MayBattleTorchic',
  },
  // MossdeepCity_SpaceCenter_2F/scripts.pory:274
  TRAINER_MAXIE_MOSSDEEP: {
    opponentIds: ['TRAINER_MAXIE_MOSSDEEP', 'TRAINER_COURTNEY_MOSSDEEP'],
    partnerIds: ['TRAINER_STEVEN_MOSSDEEP'],
    defaultPartnerId: 'TRAINER_STEVEN_MOSSDEEP',
    script: 'MossdeepCity_SpaceCenter_2F_EventScript_DoStevenMultiBattle',
  },
}

/**
 * Resolves the FightSpec for a given trainer from the encounters data.
 *
 * - Format: resolved from MULTI_FIGHTS for the two multi_2_vs_2 fights, or from
 *   tagBattles for Juan stage 1/2; defaults to single-opponent.
 * - Inverse battle: resolved via isInverseBattleTrainer (FLAG_SYS_INVERSE_BATTLE).
 * - Start field effects: unguarded fieldEffects rows (e.g. Tate & Liza Trick Room).
 * - Battle events: script-matched Tense Battle events for Tate & Liza 1 and Juan stage 1.
 * - Skipped: records any matching row that was not applied ("<kind>:<script>:<guard>").
 */
export function fightSpecFor(
  data: SimDataBundle,
  trainerId: string,
  options?: { juanStage?: 1 | 2; partnerId?: string },
): FightSpec {
  const trainer = data.trainersById.get(trainerId)
  if (!trainer) {
    throw new Error(`fightSpecFor: unknown trainer ${trainerId}`)
  }

  const skipped: string[] = []

  let format: BattleFormat
  let opponentTrainer: TrainerData
  let chosenTagBattle: EncounterTagBattle | undefined = undefined

  const multiFight = MULTI_FIGHTS[trainerId]
  if (multiFight) {
    const partnerId = options?.partnerId ?? multiFight.defaultPartnerId
    if (!multiFight.partnerIds.includes(partnerId)) {
      throw new Error(`fightSpecFor: ${partnerId} is not a partner of ${trainerId}`)
    }
    const opponents = multiFight.opponentIds.map((id) => {
      const t = data.trainersById.get(id)
      if (!t) throw new Error(`fightSpecFor: unknown trainer ${id}`)
      return t
    })
    const partner = data.trainersById.get(partnerId)
    if (!partner) {
      throw new Error(`fightSpecFor: unknown trainer ${partnerId}`)
    }
    format = { opponents, partner }
    opponentTrainer = opponents[0]!
  } else {
    // (a) Tag battle resolution (Juan stage 1 / stage 2)
    let targetJuanScript: string | null = null
    if (options?.juanStage === 1) {
      targetJuanScript = JUAN_STAGE_1_SCRIPT
    } else if (options?.juanStage === 2) {
      targetJuanScript = JUAN_STAGE_2_SCRIPT
    } else if (trainerId === 'TRAINER_JUAN_1') {
      targetJuanScript = JUAN_STAGE_1_SCRIPT
    } else if (trainerId === 'TRAINER_JUAN_5') {
      targetJuanScript = JUAN_STAGE_2_SCRIPT
    }

    const matchingTagBattles = (data.tagBattles ?? []).filter((r) => r.trainers[0] === trainerId)

    for (const row of matchingTagBattles) {
      const isTarget = targetJuanScript
        ? row.script === targetJuanScript
        : row.script === JUAN_STAGE_1_SCRIPT || row.script === JUAN_STAGE_2_SCRIPT

      if (isTarget && !chosenTagBattle) {
        chosenTagBattle = row
      } else {
        skipped.push(`tagBattle:${row.script}:${row.guard ?? 'null'}`)
      }
    }

    if (chosenTagBattle) {
      const opponents = chosenTagBattle.trainers.map((id) => {
        const t = data.trainersById.get(id)
        if (!t) throw new Error(`fightSpecFor: unknown trainer ${id} in tag battle ${chosenTagBattle!.script}`)
        return t
      })
      format = { opponents }
      opponentTrainer = opponents[0]!
    } else {
      format = { opponents: [trainer] }
      opponentTrainer = trainer
    }
  }

  // (b) Inverse battle
  const inverseBattle = isInverseBattleTrainer(data, trainerId)

  // (c) Start field effects
  const startFieldEffects: Array<{ effectType: string; fieldId: string }> = []
  const fieldRows = (data.fieldEffects ?? []).filter((r) => r.trainers.includes(trainerId))
  for (const row of fieldRows) {
    if (row.guard === null) {
      startFieldEffects.push({ effectType: row.effectType, fieldId: row.fieldId })
    } else {
      skipped.push(`fieldEffect:${row.script}:${row.guard}`)
    }
  }

  // (d) Battle events
  const battleEvents: Array<{ event: string; data0: number | null; data1: number | null }> = []
  let eventFilter: { map: string; script: string } | null = null

  if (trainerId === 'TRAINER_TATE_AND_LIZA_1') {
    eventFilter = {
      map: 'MossdeepCity_Gym',
      script: 'MossdeepCity_Gym_EventScript_TateAndLiza',
    }
  } else if (trainerId === 'TRAINER_JUAN_1' && chosenTagBattle?.script === JUAN_STAGE_1_SCRIPT) {
    eventFilter = {
      map: 'SootopolisCity_Gym_1F',
      script: JUAN_STAGE_1_SCRIPT,
    }
  }

  if (eventFilter) {
    const matching = (data.battleEvents ?? []).filter(
      (row) =>
        row.map === eventFilter!.map &&
        row.script === eventFilter!.script &&
        row.event === 'BATTLE_EVENT_TENSE_BATTLE',
    )
    for (const row of matching) {
      battleEvents.push({
        event: row.event,
        data0: row.data0,
        data1: row.data1,
      })
    }
  }

  return {
    opponentTrainer,
    format,
    inverseBattle,
    battleEvents,
    startFieldEffects,
    skipped,
  }
}
